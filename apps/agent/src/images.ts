import {
  constants,
  mkdirSync,
  lstatSync,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  AppError,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  imageUploadInput,
  requestId,
  type ImageAttachment,
} from '../../../packages/contracts/src/index.ts';
import type { Store } from './store.ts';

interface StoredImage extends ImageAttachment {
  workspaceId: string;
  hash: string;
  createdAt: number;
  used: boolean;
}

function dimensions(bytes: Buffer, mime: string) {
  if (
    mime === 'image/png' &&
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  )
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 8)
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      offset += size;
    }
  }
  throw new AppError('invalid_image', '图片内容无效，请重新选择 PNG、JPEG 或 WebP 图片。');
}

export class ImageStore {
  private directory: string;
  constructor(
    private store: Store,
    stateDirectory: string,
  ) {
    this.directory = join(stateDirectory, 'images');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.directory);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.mode & 0o077)
      throw new Error('Image storage must be a private directory owned by the Agent user');
  }
  private bytes(id: string) {
    requestId.parse(id);
    const fd = openSync(join(this.directory, id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size > MAX_IMAGE_BYTES)
        throw new AppError('invalid_image', '图片文件已改变，请重新上传。', 409);
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private require(workspaceId: string, id: string) {
    requestId.parse(id);
    const image = this.store.require<StoredImage>('image', id);
    if (image.workspaceId !== workspaceId)
      throw new AppError('permission_denied', '图片不属于当前项目。', 403);
    return image;
  }
  private summary(image: StoredImage): ImageAttachment {
    const { id, name, mimeType, size, width, height } = image;
    return { id, name, mimeType, size, width, height };
  }
  upload(workspaceId: string, body: unknown) {
    const input = imageUploadInput.parse(body);
    const [prefix, encoded] = input.dataUrl.split(',');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== encoded)
      throw new AppError('invalid_image', '图片无效或过大，请裁剪后重试。', 400);
    const mimeType = prefix.includes('image/png') ? 'image/png' : 'image/jpeg';
    const [width, height] = dimensions(bytes, mimeType);
    if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000)
      throw new AppError('invalid_image', '图片尺寸过大，请裁剪后重试。');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const old = this.store.get<StoredImage>('image', input.clientRequestId);
    if (old) {
      if (old.workspaceId !== workspaceId || old.hash !== hash || old.name !== input.name)
        throw new AppError('run_conflict', '图片上传标识已用于其他内容。', 409);
      return this.summary(old);
    }
    // Only abandoned uploads expire; images attached to conversations remain available.
    const images = this.store.list<StoredImage>('image');
    let storedBytes = 0;
    for (const image of images) {
      if (!image.used && image.createdAt < Date.now() - 86400000) {
        try {
          unlinkSync(join(this.directory, requestId.parse(image.id)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.store.remove('image', image.id);
      } else storedBytes += image.size;
    }
    if (storedBytes + bytes.length > 512 * 1024 * 1024)
      throw new AppError('image_storage_full', '图片存储空间已满，请联系管理员清理。', 409);
    const image: StoredImage = {
      id: input.clientRequestId,
      name: input.name,
      mimeType,
      size: bytes.length,
      width,
      height,
      hash,
      workspaceId,
      used: false,
      createdAt: Date.now(),
    };
    try {
      writeFileSync(join(this.directory, image.id), bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !this.bytes(image.id).equals(bytes))
        throw error;
    }
    this.store.put('image', image.id, image);
    return this.summary(image);
  }
  attach(workspaceId: string, ids: string[]) {
    if (ids.length > MAX_IMAGES || new Set(ids).size !== ids.length)
      throw new AppError('invalid_request', '每条消息最多 4 张图片，不能重复添加。');
    const images = ids.map((id) => this.require(workspaceId, id));
    for (const image of images) this.store.put('image', image.id, { ...image, used: true });
    return images.map((image) => this.summary(image));
  }
  read(workspaceId: string, id: string) {
    const image = this.require(workspaceId, id);
    const bytes = this.bytes(id);
    if (createHash('sha256').update(bytes).digest('hex') !== image.hash)
      throw new AppError('invalid_image', '图片内容已改变，请重新上传。', 409);
    return { image: this.summary(image), bytes };
  }
  inputs(workspaceId: string, images: ImageAttachment[] = []) {
    return images.map((image) => {
      const stored = this.read(workspaceId, image.id);
      return { url: `data:${stored.image.mimeType};base64,${stored.bytes.toString('base64')}` };
    });
  }
}
