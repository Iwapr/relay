import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FileServiceError, validateRelative, type FileService, type WorkspaceDirectory } from './files.ts';

const MiB = 1024 * 1024;
const lifetime = 30 * 60_000;
export const uploadInput = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      path: z.string().min(1).max(4096),
      size: z
        .number()
        .int()
        .min(0)
        .max(100 * MiB),
    })
    .strict(),
  z
    .object({
      action: z.literal('chunk'),
      id: z.string().uuid(),
      offset: z.number().int().min(0),
      data: z.string().max(262144),
    })
    .strict(),
  z.object({ action: z.literal('finish'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('cancel'), id: z.string().uuid() }).strict(),
]);
interface Upload {
  workspace: string;
  path: string;
  size: number;
  offset: number;
  expires: number;
  busy: boolean;
  filename: string;
}
interface Download {
  workspace: string;
  filename: string;
  name: string;
  size: number;
  expires: number;
  archive: boolean;
  delivered: boolean;
}
export class Transfers {
  private uploads = new Map<string, Upload>();
  private downloads = new Map<string, Download>();
  private preparing = false;
  private timer: ReturnType<typeof setInterval>;
  private constructor(
    private directory: string,
    private files: FileService,
  ) {
    this.timer = setInterval(() => void this.prune().catch(() => {}), 60_000);
    this.timer.unref();
  }
  static async open(stateDir: string, files: FileService) {
    const directory = path.join(stateDir, 'transfers');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await fd.stat();
      if (info.uid !== process.getuid?.() || info.mode & 0o077)
        throw new Error('Transfer directory must be private');
    } finally {
      await fd.close();
    }
    for (const name of await readdir(directory)) {
      if (/^[a-f0-9-]{36}\.(upload|download)$/.test(name))
        await rm(path.join(directory, name), { force: true });
    }
    return new Transfers(directory, files);
  }
  private async prune() {
    for (const [id, item] of this.uploads)
      if (!item.busy && item.expires < Date.now()) {
        this.uploads.delete(id);
        await rm(item.filename, { force: true });
      }
    for (const [id, item] of this.downloads)
      if (item.expires < Date.now()) {
        this.downloads.delete(id);
        await rm(item.filename, { force: true });
      }
  }
  async upload(
    workspaceId: string,
    workspace: WorkspaceDirectory,
    input: z.infer<typeof uploadInput>,
    commit: <T>(action: () => Promise<T>) => Promise<T>,
    umask: string,
  ) {
    await this.files.validate(workspace);
    if (input.action === 'start') {
      validateRelative(input.path, false);
      if (!this.files.isVisible(workspace, input.path))
        throw new FileServiceError('permission_denied', '不能上传到受保护路径');
      if (
        this.uploads.size >= 16 ||
        [...this.uploads.values()].reduce((sum, u) => sum + u.size, 0) + input.size > 512 * MiB
      )
        throw new FileServiceError('transfer_limit', '待上传内容已达上限，请完成或取消其他上传', 413);
      const id = randomUUID(),
        filename = path.join(this.directory, id + '.upload');
      const item: Upload = {
        workspace: workspaceId,
        path: input.path,
        size: input.size,
        offset: 0,
        expires: Date.now() + lifetime,
        busy: true,
        filename,
      };
      this.uploads.set(id, item);
      try {
        const fd = await open(filename, 'wx', 0o600);
        await fd.close();
      } catch (e) {
        this.uploads.delete(id);
        throw e;
      } finally {
        item.busy = false;
      }
      return { id, offset: 0 };
    }
    const item = this.uploads.get(input.id);
    if (!item || item.workspace !== workspaceId || item.expires < Date.now())
      throw new FileServiceError('not_found', '上传已过期，请重新上传', 404);
    if (item.busy) throw new FileServiceError('transfer_busy', '上传处理中，请稍后重试', 409);
    item.busy = true;
    try {
      item.expires = Date.now() + lifetime;
      if (input.action === 'chunk') {
        const bytes = Buffer.from(input.data, 'base64');
        if (
          !bytes.length ||
          bytes.toString('base64') !== input.data ||
          input.offset !== item.offset ||
          item.offset + bytes.length > item.size
        )
          throw new FileServiceError('invalid_chunk', '上传数据或位置不正确，请重新上传', 409);
        const fd = await open(item.filename, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
        try {
          await fd.writeFile(bytes);
        } finally {
          await fd.close();
        }
        item.offset += bytes.length;
        return { id: input.id, offset: item.offset };
      }
      if (input.action === 'finish') {
        if (item.offset !== item.size)
          throw new FileServiceError('upload_incomplete', '文件尚未上传完整', 409);
        const result = await commit(() =>
          this.files.transfer(workspace, 'upload', {
            path: item.path,
            source: item.filename,
            size: item.size,
            umask,
          }),
        );
        this.uploads.delete(input.id);
        await rm(item.filename, { force: true });
        return result;
      }
      this.uploads.delete(input.id);
      await rm(item.filename, { force: true });
      return { cancelled: true };
    } finally {
      item.busy = false;
    }
  }
  async prepare(workspaceId: string, workspace: WorkspaceDirectory, paths: string[], archive: boolean) {
    paths.forEach((p) => validateRelative(p, archive));
    if (!archive && paths.length !== 1)
      throw new FileServiceError('invalid_request', '多个文件需要打包下载', 400);
    if (this.preparing) throw new FileServiceError('transfer_busy', '已有下载正在准备，请稍后重试', 409);
    this.preparing = true;
    const id = randomUUID(),
      filename = path.join(this.directory, id + '.download');
    try {
      await this.prune();
      while (
        this.downloads.size >= 4 ||
        [...this.downloads.values()].reduce((sum, d) => sum + d.size, 0) > 256 * MiB
      ) {
        const oldest = [...this.downloads].find(([, item]) => item.delivered);
        if (!oldest)
          throw new FileServiceError('transfer_limit', '待下载文件已达上限，请先完成其他下载或稍后重试', 413);
        this.downloads.delete(oldest[0]);
        await rm(oldest[1].filename, { force: true });
      }
      const result = await this.files.transfer<{ size: number; skipped: number }>(workspace, 'download', {
        paths: [...new Set(paths)],
        archive,
        output: filename,
        maxBytes: 256 * MiB,
      });
      const name =
        (paths.length === 1 ? path.basename(paths[0] || workspace.canonicalRoot) : '所选文件') +
        (archive ? '.zip' : '');
      this.downloads.set(id, {
        workspace: workspaceId,
        filename,
        name,
        size: result.size,
        archive,
        delivered: false,
        expires: Date.now() + 5 * 60_000,
      });
      return { id, name, size: result.size, skipped: result.skipped };
    } catch (e) {
      await rm(filename, { force: true });
      throw e;
    } finally {
      this.preparing = false;
    }
  }
  async read(workspaceId: string, id: string) {
    const item = this.downloads.get(id);
    if (!item || item.workspace !== workspaceId || item.expires < Date.now())
      throw new FileServiceError('not_found', '下载已过期，请重新下载', 404);
    const fd = await open(item.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stream = fd.createReadStream();
    stream.once('end', () => {
      item.delivered = true;
    });
    return { ...item, stream };
  }
  async close() {
    clearInterval(this.timer);
    for (const item of [...this.uploads.values(), ...this.downloads.values()])
      await rm(item.filename, { force: true });
    this.uploads.clear();
    this.downloads.clear();
  }
}
