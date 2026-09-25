import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { MAX_IMAGE_BYTES, MAX_IMAGES, type ImageAttachment } from '../../../packages/contracts/src/index.ts';
import { api, base, requestId, save, saved } from './api';
import './image-attachments.css';

export const imageUrl = (connection: string, workspace: string, id: string) =>
  '/api' + base(connection) + `/workspaces/${encodeURIComponent(workspace)}/images/${encodeURIComponent(id)}`;

interface DraftImage {
  id: string;
  name: string;
  preview: string;
  image?: ImageAttachment;
  error?: string;
}

async function prepareImage(file: File, preview: string) {
  const image = new Image();
  image.src = preview;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000)
    throw new Error('图片尺寸过大，请裁剪后添加。');
  const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法读取图片，请换一张图片重试。');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  let url = canvas.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.92);
  const fits = () => ((url.length - url.indexOf(',') - 1) * 3) / 4 <= MAX_IMAGE_BYTES;
  if (fits()) return url;
  // Screenshots keep lossless PNG when possible; larger images get a white JPEG background.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const quality of [0.9, 0.8, 0.65, 0.5]) {
    url = canvas.toDataURL('image/jpeg', quality);
    if (fits()) return url;
  }
  throw new Error('图片仍然过大，请裁剪需要查看的部分后添加。');
}

export function useImageAttachments(
  key: string,
  connection: string,
  workspace: string | undefined,
  onError: (message: string) => void,
) {
  const [items, setItems] = useState<DraftImage[]>([]);
  const current = useRef<DraftImage[]>([]);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const viewKey = useRef(key);
  viewKey.current = key;
  const update = (next: DraftImage[]) => {
    current.current = next;
    setItems(next);
    save(
      key + ':images',
      next.flatMap((item) => (item.image ? [item.image] : [])),
    );
  };
  useEffect(() => {
    const images = saved<ImageAttachment[]>(key + ':images', []);
    const next =
      Array.isArray(images) && workspace
        ? images.slice(0, MAX_IMAGES).map((image) => ({
            id: image.id,
            name: image.name,
            preview: imageUrl(connection, workspace, image.id),
            image,
          }))
        : [];
    current.current = next;
    setItems(next);
    return () => {
      generation.current++;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      for (const item of current.current)
        if (item.preview.startsWith('blob:')) URL.revokeObjectURL(item.preview);
      current.current = [];
    };
  }, [key, connection, workspace]);
  const remove = (id: string) => {
    const item = current.current.find((item) => item.id === id);
    if (item?.preview.startsWith('blob:')) URL.revokeObjectURL(item.preview);
    update(current.current.filter((item) => item.id !== id));
  };
  const clear = () => {
    generation.current++;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    for (const item of current.current)
      if (item.preview.startsWith('blob:')) URL.revokeObjectURL(item.preview);
    update([]);
  };
  const add = async (files: File[]) => {
    if (!workspace) return;
    const ownGeneration = generation.current;
    const targetKey = key;
    for (const file of files) {
      if (current.current.length >= MAX_IMAGES) {
        onError('每条消息最多添加 4 张图片。');
        break;
      }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        onError('请选择 PNG、JPEG 或 WebP 图片。');
        continue;
      }
      if (file.size > 20 * 1024 * 1024) {
        onError('原图超过 20 MiB，请裁剪后添加。');
        continue;
      }
      const item: DraftImage = {
        id: requestId(),
        name: file.name.slice(0, 200) || '截图.png',
        preview: URL.createObjectURL(file),
      };
      update([...current.current, item]);
      const controller = new AbortController();
      controllers.current.add(controller);
      void (async () => {
        try {
          const dataUrl = await prepareImage(file, item.preview);
          if (
            ownGeneration !== generation.current ||
            viewKey.current !== targetKey ||
            !current.current.some((image) => image.id === item.id)
          )
            return;
          const result = await api<{ image: ImageAttachment }>(
            base(connection) + `/workspaces/${workspace}/images`,
            {
              clientRequestId: item.id,
              name: item.name,
              dataUrl,
            },
            controller.signal,
          );
          if (ownGeneration !== generation.current || viewKey.current !== targetKey) return;
          update(
            current.current.map((image) =>
              image.id === item.id ? { ...image, image: result.image } : image,
            ),
          );
        } catch (error) {
          if (
            ownGeneration === generation.current &&
            viewKey.current === targetKey &&
            !controller.signal.aborted
          )
            update(
              current.current.map((image) =>
                image.id === item.id
                  ? { ...image, error: (error as Error).message || '图片处理失败，请移除后重试。' }
                  : image,
              ),
            );
        } finally {
          controllers.current.delete(controller);
        }
      })();
    }
  };
  return {
    items,
    add,
    remove,
    clear,
    ids: items.flatMap((item) => (item.image ? [item.image.id] : [])),
    pending: items.some((item) => !item.image),
  };
}

export function ImageDrafts({
  items,
  disabled,
  onRemove,
}: {
  items: DraftImage[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  return items.length ? (
    <div className="image-attachments" aria-label="待发送图片">
      {items.map((item) => (
        <div className="image-attachment" key={item.id}>
          <img src={item.preview} alt={item.name} />
          <button disabled={disabled} aria-label={`移除图片：${item.name}`} onClick={() => onRemove(item.id)}>
            <X size={13} />
          </button>
          <span>{item.name}</span>
          <small role={item.error ? 'alert' : 'status'}>
            {item.error || (item.image ? '已就绪' : '正在准备图片…')}
          </small>
        </div>
      ))}
    </div>
  ) : null;
}

export function MessageImages({
  images,
  connection,
  workspace,
}: {
  images?: ImageAttachment[];
  connection: string;
  workspace: string;
}) {
  return images?.length ? (
    <div className="message-images" aria-label="已发送图片">
      {images.map((image) => (
        <a
          href={imageUrl(connection, workspace, image.id)}
          target="_blank"
          rel="noopener noreferrer"
          key={image.id}
          title="打开完整图片"
        >
          <img loading="lazy" src={imageUrl(connection, workspace, image.id)} alt={image.name} />
        </a>
      ))}
    </div>
  ) : null;
}
