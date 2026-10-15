import { useEffect, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import { requestId, saved } from './api';
import { decodeTextFile, type TextAttachment } from './text-attachments';

interface Draft extends TextAttachment {
  loading?: boolean;
  error?: string;
}
export function useTextAttachments(key: string, onError: (message: string) => void) {
  const [items, setItems] = useState<Draft[]>([]);
  const current = useRef<Draft[]>([]);
  const generation = useRef(0);
  const viewKey = useRef(key);
  viewKey.current = key;
  const update = (next: Draft[]) => {
    current.current = next;
    setItems(next);
    const storageKey = 'relay:' + key + ':text-files';
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next.filter((item) => !item.loading && !item.error)));
    } catch {
      sessionStorage.removeItem(storageKey);
      onError('附件已添加，但浏览器草稿空间不足；刷新页面会丢失这些附件，请先发送。');
    }
  };
  useEffect(() => {
    const restored = saved<Draft[]>(key + ':text-files', []);
    current.current = Array.isArray(restored) ? restored : [];
    setItems(current.current);
    return () => {
      generation.current++;
    };
  }, [key]);
  const clear = () => {
    generation.current++;
    update([]);
  };
  const remove = (id: string) => update(current.current.filter((item) => item.id !== id));
  const add = (files: File[]) => {
    const ownGeneration = generation.current;
    const targetKey = key;
    const drafts = files.map((file) => ({
      id: requestId(),
      name: file.name,
      size: file.size,
      text: '',
      loading: true,
    }));
    update([...current.current, ...drafts]);
    files.forEach((file, index) => {
      void (async () => {
        let result: Partial<Draft>;
        try {
          result = { text: decodeTextFile(new Uint8Array(await file.arrayBuffer())), loading: false };
        } catch (error) {
          result = { error: (error as Error).message, loading: false };
        }
        if (generation.current !== ownGeneration || viewKey.current !== targetKey) return;
        if (!current.current.some((item) => item.id === drafts[index].id)) return;
        update(current.current.map((item) => (item.id === drafts[index].id ? { ...item, ...result } : item)));
      })();
    });
  };
  return { items, add, remove, clear, pending: items.some((item) => item.loading || item.error) };
}

export function TextDrafts({
  items,
  disabled,
  onRemove,
}: {
  items: Draft[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="text-attachments" aria-label="待发送文件">
      {items.map((item) => (
        <div className="text-attachment" key={item.id}>
          <FileText size={16} />
          <span>
            {item.name}{' '}
            <small>
              {new Intl.NumberFormat().format(item.size)} 字节{item.loading ? ' · 正在读取…' : ''}
            </small>
          </span>
          <button disabled={disabled} aria-label={'移除文件：' + item.name} onClick={() => onRemove(item.id)}>
            <X size={14} />
          </button>
          {item.error && <small role="alert">{item.error}</small>}
        </div>
      ))}
    </div>
  );
}
