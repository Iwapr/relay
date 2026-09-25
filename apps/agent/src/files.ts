import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, chmod, lstat, open, rm, readdir } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../../packages/secure-fs/helper.py', import.meta.url));
export class FileServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 403,
  ) {
    super(message);
  }
}
export interface DirectoryIdentity {
  dev: string;
  ino: string;
}
export interface WorkspaceDirectory {
  canonicalRoot: string;
  directoryIdentity: DirectoryIdentity;
  ancestors: DirectoryIdentity[];
  readable: boolean;
  writable: boolean;
  shared: boolean;
  ownerUid: number;
  mode: number;
}
export interface FileServiceOptions {
  roots: string[];
  previewRoots?: string[];
  privateDirectory: string;
  sensitivePaths?: string[];
  maxPreviewBytes?: number;
  maxSnapshotBytes?: number;
  snapshotTtlMs?: number;
}
export interface ListingOptions {
  path?: string;
  cursor?: string;
  limit?: number;
  hidden?: boolean;
}
export interface FileEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  modifiedAt: number;
}
export interface DirectoryListing {
  entries: FileEntry[];
  nextCursor: string | null;
  total: number;
  path: string;
}
export interface FileMetadata {
  path: string;
  version: string;
  etag: string;
  size: number;
  mime: string;
  modifiedAt: number;
  expiresAt: number;
  preview: 'pdf' | 'image' | 'markdown' | 'text' | 'download';
}
interface Snapshot {
  filename: string;
  binding: string;
  meta: FileMetadata;
}

export function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
export function validateRelative(value: string, allowEmpty = true): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value) ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.isAbsolute(value) ||
    /%(?:2e|2f|5c|00|25)/i.test(value) ||
    (value && value.split('/').some((p) => !p || p === '.' || p === '..'))
  ) {
    throw new FileServiceError('path_outside_workspace', 'Invalid relative path');
  }
  return value;
}
function absolute(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.includes('\0') ||
    value.includes('\\') ||
    /%(?:2e|2f|5c|00|25)/i.test(value) ||
    value.split('/').some((p) => p === '.' || p === '..')
  ) {
    throw new FileServiceError('path_outside_workspace', 'Invalid absolute path');
  }
  return path.normalize(value).replace(/\/$/, '') || '/';
}

export async function secureFs<T>(request: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [helper], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    const chunks: Buffer[] = [];
    let length = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new FileServiceError('filesystem_unavailable', 'Filesystem operation timed out', 503));
    }, 30_000);
    child.stdout.on('data', (data: Buffer) => {
      length += data.length;
      if (length > 4 * 1024 * 1024) {
        child.kill('SIGKILL');
        reject(new FileServiceError('filesystem_unavailable', 'Filesystem response exceeded limit', 503));
      } else chunks.push(data);
    });
    child.stderr.resume(); // Do not forward potentially sensitive native errors.
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error('helper failed');
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!response.ok)
          throw new FileServiceError(response.error.code, response.error.message, response.error.statusCode);
        resolve(response.result as T);
      } catch (error) {
        reject(
          error instanceof FileServiceError
            ? error
            : new FileServiceError('filesystem_unavailable', 'Secure filesystem helper is unavailable', 503),
        );
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

function media(filename: string): Pick<FileMetadata, 'mime' | 'preview'> {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.pdf') return { mime: 'application/pdf', preview: 'pdf' };
  const images: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
  };
  if (images[extension]) return { mime: images[extension], preview: 'image' };
  if (['.md', '.markdown', '.mdx'].includes(extension))
    return { mime: 'text/plain; charset=utf-8', preview: 'markdown' };
  if (
    [
      '.txt',
      '.tex',
      '.bib',
      '.json',
      '.yaml',
      '.yml',
      '.toml',
      '.xml',
      '.html',
      '.htm',
      '.svg',
      '.js',
      '.jsx',
      '.ts',
      '.tsx',
      '.css',
      '.py',
      '.rs',
      '.go',
      '.c',
      '.h',
      '.cpp',
      '.sh',
      '.sql',
      '.csv',
      '.log',
      '.ini',
      '.conf',
    ].includes(extension) ||
    ['Dockerfile', 'Makefile', 'LICENSE', 'README', 'AGENTS.md'].includes(path.basename(filename))
  )
    return { mime: 'text/plain; charset=utf-8', preview: 'text' };
  return { mime: 'application/octet-stream', preview: 'download' };
}

/** Inspect the immutable snapshot, including bytes beyond the first chunk. */
async function snapshotMedia(
  relative: string,
  filename: string,
): Promise<Pick<FileMetadata, 'mime' | 'preview'>> {
  const known = media(relative);
  if (known.preview !== 'download') return known;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of createReadStream(filename)) {
    let text: string;
    try {
      text = decoder.decode(chunk, { stream: true });
    } catch {
      return known;
    }
    // Permit common text whitespace, but reject binary control characters.
    if (/[\x00-\x08\x0e-\x1f\x7f]/.test(text)) return known;
  }
  try {
    decoder.decode();
  } catch {
    return known;
  }
  return { mime: 'text/plain; charset=utf-8', preview: 'text' };
}

/** A single RFC 9110 byte range; multiple ranges are deliberately rejected. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0)
    throw new FileServiceError('range_not_satisfiable', 'Requested range is not satisfiable', 416);
  const first = match[1] ? Number(match[1]) : undefined;
  const second = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (second !== undefined && !Number.isSafeInteger(second))
  )
    throw new FileServiceError('range_not_satisfiable', 'Requested range is not satisfiable', 416);
  const start = first === undefined ? Math.max(0, size - (second ?? 0)) : first;
  const end = first === undefined || second === undefined ? size - 1 : Math.min(second, size - 1);
  if (start >= size || start > end)
    throw new FileServiceError('range_not_satisfiable', 'Requested range is not satisfiable', 416);
  return { start, end };
}

export class FileService {
  private allowed: WorkspaceDirectory[] = [];
  private snapshots = new Map<string, Snapshot>();
  private readonly previewAllowed: WorkspaceDirectory[] = [];
  private readonly snapshotDirectory: string;
  private readonly sensitivePaths: string[];
  private readonly maxPreviewBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly snapshotTtlMs: number;
  private constructor(private readonly options: FileServiceOptions) {
    this.snapshotDirectory = path.join(absolute(options.privateDirectory), 'previews');
    this.sensitivePaths = [
      options.privateDirectory,
      path.join(homedir(), '.ssh'),
      path.join(homedir(), '.codex'),
      path.join(homedir(), '.local/share/keyrings'),
      path.join(homedir(), '.password-store'),
      path.join(homedir(), '.config/gcloud'),
      path.join(homedir(), '.config/code-server'),
      path.join(homedir(), '.local/share/code-server'),
      path.join(homedir(), '.config/remote-workbench'),
      path.join(homedir(), '.local/share/remote-workbench'),
      path.join(homedir(), '.local/state/remote-workbench'),
      ...(options.sensitivePaths ?? []),
    ].map(absolute);
    this.maxPreviewBytes = options.maxPreviewBytes ?? 64 * 1024 * 1024;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 256 * 1024 * 1024;
    this.snapshotTtlMs = options.snapshotTtlMs ?? 15 * 60_000;
  }
  static async create(options: FileServiceOptions): Promise<FileService> {
    if (!options.roots.length) throw new Error('At least one allowed root is required');
    const service = new FileService(options);
    await mkdir(service.snapshotDirectory, { recursive: true, mode: 0o700 });
    const privateInfo = await lstat(options.privateDirectory);
    const cacheInfo = await lstat(service.snapshotDirectory);
    if (
      !privateInfo.isDirectory() ||
      privateInfo.isSymbolicLink() ||
      privateInfo.uid !== process.getuid?.() ||
      (privateInfo.mode & 0o077) !== 0 ||
      !cacheInfo.isDirectory() ||
      cacheInfo.isSymbolicLink()
    )
      throw new Error('File service private directory must be owned by this user and mode 0700');
    await chmod(service.snapshotDirectory, 0o700);
    // Expired snapshots are never revived across Agent generations.
    for (const item of await readdir(service.snapshotDirectory))
      if (/^[a-f0-9-]{36}\.snapshot$/.test(item))
        await rm(path.join(service.snapshotDirectory, item), { force: true });
    for (const root of options.roots)
      service.allowed.push(await service.call<WorkspaceDirectory>('root', { canonicalRoot: absolute(root) }));
    for (const root of options.previewRoots ?? [])
      service.previewAllowed.push(
        await service.call<WorkspaceDirectory>('root', { canonicalRoot: absolute(root) }),
      );
    return service;
  }
  roots(): WorkspaceDirectory[] {
    return this.allowed.map((root) => ({ ...root }));
  }
  /** Lexical filter for observational events; reads still use fd validation. */
  isVisible(workspace: WorkspaceDirectory, relativePath: string): boolean {
    try {
      const relative = validateRelative(relativePath);
      const blocked = new Set([
        '.ssh',
        '.codex',
        '.git',
        '.gnupg',
        '.aws',
        '.azure',
        '.kube',
        '.git-credentials',
        '.netrc',
        '.npmrc',
        '.pypirc',
        'id_rsa',
        'id_dsa',
        'id_ecdsa',
        'id_ed25519',
      ]);
      if (
        relative.split('/').some((name) => blocked.has(name) || name === '.env' || name.startsWith('.env.'))
      )
        return false;
      const full = path.join(workspace.canonicalRoot, relative);
      return !this.sensitivePaths.some((secret) => within(full, secret));
    } catch {
      return false;
    }
  }
  private call<T>(
    operation: string,
    root: Pick<WorkspaceDirectory, 'canonicalRoot'> & Partial<WorkspaceDirectory>,
    extra: Record<string, unknown> = {},
  ): Promise<T> {
    return secureFs<T>({ operation, root, sensitivePaths: this.sensitivePaths, ...extra });
  }
  async validate(workspace: WorkspaceDirectory): Promise<WorkspaceDirectory> {
    const allowed = this.allowed.find((root) => within(workspace.canonicalRoot, root.canonicalRoot));
    if (!allowed) throw new FileServiceError('path_outside_workspace', 'Path is outside the allowed roots');
    await this.call('validate', allowed);
    return this.call('validate', workspace);
  }
  async transfer<T>(
    workspace: WorkspaceDirectory,
    operation: 'upload' | 'download',
    input: Record<string, unknown>,
  ): Promise<T> {
    await this.validate(workspace);
    return this.call<T>('transfer-' + operation, workspace, input);
  }
  async checkpoint<T>(
    workspace: WorkspaceDirectory,
    operation: 'capture' | 'preview' | 'restore',
    input: Record<string, unknown>,
  ): Promise<T> {
    await this.validate(workspace);
    return this.call<T>('checkpoint-' + operation, workspace, {
      ...input,
      checkpointDirectory: path.join(this.options.privateDirectory, 'checkpoints'),
    });
  }
  async openWorkspace(absolutePath: string): Promise<WorkspaceDirectory> {
    const normalized = absolute(absolutePath);
    const allowed = this.allowed.find((root) => within(normalized, root.canonicalRoot));
    if (!allowed) throw new FileServiceError('path_outside_workspace', 'Path is outside the allowed roots');
    await this.call('validate', allowed);
    return this.call<WorkspaceDirectory>('root', { canonicalRoot: normalized });
  }
  /** Picker entries use absolute paths; workspace tree entries stay relative. */
  async createDirectory(parent: string, name: string): Promise<{ path: string }> {
    const normalized = absolute(parent);
    if (!name.trim() || name !== name.trim() || name.includes('/') || /[\x00-\x1f\x7f]/.test(name))
      throw new FileServiceError('invalid_request', '请输入有效的文件夹名称，不能包含路径分隔符。', 400);
    validateRelative(name, false);
    const allowed = this.allowed.find((root) => within(normalized, root.canonicalRoot));
    if (!allowed) throw new FileServiceError('path_outside_workspace', 'Path is outside the allowed roots');
    return this.call('mkdir', allowed, { path: path.relative(allowed.canonicalRoot, normalized), name });
  }
  async listDirectories(
    absolutePath?: string,
    options: Omit<ListingOptions, 'path'> = {},
  ): Promise<DirectoryListing> {
    const directory = await this.openWorkspace(absolutePath ?? this.allowed[0].canonicalRoot);
    const listing = await this.listEntries(directory, options, true);
    return {
      ...listing,
      path: directory.canonicalRoot,
      entries: listing.entries.map((entry) => ({
        ...entry,
        path: path.join(directory.canonicalRoot, entry.path),
      })),
    };
  }
  async tree(workspace: WorkspaceDirectory, options: ListingOptions = {}): Promise<DirectoryListing> {
    return this.listEntries(workspace, options, false);
  }
  private async listEntries(
    workspace: WorkspaceDirectory,
    options: ListingOptions,
    directoriesOnly: boolean,
  ): Promise<DirectoryListing> {
    await this.validate(workspace);
    const relative = validateRelative(options.path ?? '');
    const offset = options.cursor === undefined ? 0 : Number(options.cursor);
    const limit = options.limit ?? 100;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new FileServiceError('invalid_request', 'Invalid directory pagination', 400);
    const result = await this.call<{
      entries: Omit<FileEntry, 'path'>[];
      nextOffset: number | null;
      total: number;
    }>('list', workspace, {
      path: relative,
      offset,
      limit,
      hidden: options.hidden ?? false,
      directoriesOnly,
    });
    return {
      entries: result.entries.map((entry) => ({
        ...entry,
        path: relative ? `${relative}/${entry.name}` : entry.name,
      })),
      nextCursor: result.nextOffset === null ? null : String(result.nextOffset),
      total: result.total,
      path: relative,
    };
  }
  private binding(workspace: WorkspaceDirectory, relative: string): string {
    return `${workspace.directoryIdentity.dev}:${workspace.directoryIdentity.ino}:${relative}`;
  }
  private async cleanup(required = 0): Promise<void> {
    let total = [...this.snapshots.values()].reduce((sum, snapshot) => sum + snapshot.meta.size, 0);
    for (const [version, snapshot] of this.snapshots) {
      if (snapshot.meta.expiresAt <= Date.now() || total + required > this.maxSnapshotBytes) {
        await rm(snapshot.filename, { force: true });
        this.snapshots.delete(version);
        total -= snapshot.meta.size;
      }
    }
  }
  /** Absolute previews use allowed directory identities, without opening a new project. */
  private async previewTarget(workspace: WorkspaceDirectory, requested: string) {
    await this.validate(workspace);
    if (!path.isAbsolute(requested)) return { workspace, relative: validateRelative(requested, false) };
    const normalized = absolute(requested);
    // Keep in-project absolute and relative links bound to the same snapshot.
    if (within(normalized, workspace.canonicalRoot))
      return {
        workspace,
        relative: validateRelative(path.relative(workspace.canonicalRoot, normalized), false),
      };
    const allowed = [...this.allowed, ...this.previewAllowed].find((root) =>
      within(normalized, root.canonicalRoot),
    );
    if (!allowed) throw new FileServiceError('path_outside_workspace', '文件不在此连接允许预览的目录范围内');
    await this.call('validate', allowed);
    return {
      workspace: allowed,
      relative: validateRelative(path.relative(allowed.canonicalRoot, normalized), false),
    };
  }
  async metadata(workspace: WorkspaceDirectory, requested: string): Promise<FileMetadata> {
    const target = await this.previewTarget(workspace, requested);
    return this.snapshotMetadata(target.workspace, target.relative);
  }
  private async snapshotMetadata(workspace: WorkspaceDirectory, relative: string): Promise<FileMetadata> {
    const filename = path.join(this.snapshotDirectory, `${randomUUID()}.snapshot`);
    await this.cleanup();
    const copied = await this.call<{ size: number; sha256: string; modifiedAt: number }>(
      'snapshot',
      workspace,
      {
        path: relative,
        snapshotPath: filename,
        maxBytes: Math.min(this.maxPreviewBytes, this.maxSnapshotBytes),
      },
    );
    const binding = this.binding(workspace, relative);
    const version = createHash('sha256').update(binding).update('\0').update(copied.sha256).digest('hex');
    const existing = this.snapshots.get(version);
    if (existing) {
      await rm(filename, { force: true });
      return existing.meta;
    }
    await this.cleanup(copied.size);
    const meta: FileMetadata = {
      path: relative,
      version,
      etag: `"${version}"`,
      size: copied.size,
      modifiedAt: copied.modifiedAt,
      expiresAt: Date.now() + this.snapshotTtlMs,
      ...(await snapshotMedia(relative, filename)),
    };
    this.snapshots.set(version, { filename, binding, meta });
    return meta;
  }
  async file(
    workspace: WorkspaceDirectory,
    relativePath: string,
    options: { version?: string; range?: string } = {},
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer; meta: FileMetadata }> {
    const target = await this.previewTarget(workspace, relativePath);
    workspace = target.workspace;
    const relative = target.relative;
    const meta = options.version
      ? this.snapshots.get(options.version)?.meta
      : await this.snapshotMetadata(workspace, relative);
    const snapshot = meta ? this.snapshots.get(meta.version) : undefined;
    if (
      !snapshot ||
      snapshot.binding !== this.binding(workspace, relative) ||
      snapshot.meta.expiresAt <= Date.now()
    )
      throw new FileServiceError(
        'file_changed',
        'Preview version expired; request a fresh file version',
        409,
      );
    const headers: Record<string, string> = {
      'Content-Type': snapshot.meta.mime,
      'Accept-Ranges': 'bytes',
      ETag: snapshot.meta.etag,
      'X-File-Version': snapshot.meta.version,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `${snapshot.meta.preview === 'download' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(relative)).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
    };
    let range;
    try {
      range = byteRange(options.range, snapshot.meta.size);
    } catch (error) {
      if (error instanceof FileServiceError && error.statusCode === 416)
        return {
          statusCode: 416,
          headers: { ...headers, 'Content-Range': `bytes */${snapshot.meta.size}`, 'Content-Length': '0' },
          body: Buffer.alloc(0),
          meta: snapshot.meta,
        };
      throw error;
    }
    // PDF.js fetches many small ranges: read only the requested snapshot bytes.
    const body = Buffer.alloc(range ? range.end - range.start + 1 : snapshot.meta.size);
    const descriptor = await open(snapshot.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      let offset = 0;
      while (offset < body.length) {
        const { bytesRead } = await descriptor.read(
          body,
          offset,
          body.length - offset,
          (range?.start ?? 0) + offset,
        );
        if (!bytesRead)
          throw new FileServiceError(
            'file_changed',
            'Preview snapshot is unavailable; request a fresh version',
            409,
          );
        offset += bytesRead;
      }
    } finally {
      await descriptor.close();
    }
    headers['Content-Length'] = String(body.length);
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${snapshot.meta.size}`;
    return { statusCode: range ? 206 : 200, headers, body, meta: snapshot.meta };
  }
  async manage(
    workspace: WorkspaceDirectory,
    input: { action: string; path?: string; target?: string },
  ): Promise<{ path: string }> {
    await this.validate(workspace);
    if (
      !['file', 'directory', 'rename', 'move', 'copy', 'delete'].includes(input.action) ||
      (!['file', 'directory'].includes(input.action) && !input.path) ||
      (input.action !== 'delete' && !input.target)
    )
      throw new FileServiceError('invalid_request', '缺少文件操作路径', 400);
    if (input.path !== undefined) validateRelative(input.path, false);
    if (input.target !== undefined) validateRelative(input.target, false);
    return this.call('manage', workspace, input);
  }
  async changes(workspace: WorkspaceDirectory): Promise<{
    git: boolean;
    status?: string;
    diff: string;
    stagedDiff?: string;
    truncated?: boolean;
    notice: string;
    entries?: unknown[];
  }> {
    await this.validate(workspace);
    return this.call('git', workspace);
  }
  async close(): Promise<void> {
    for (const snapshot of this.snapshots.values()) await rm(snapshot.filename, { force: true });
    this.snapshots.clear();
  }
}
