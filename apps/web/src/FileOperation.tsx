import { useEffect, useRef, useState } from 'react';
import { api, base } from './api';
export type FileAction = 'file' | 'directory' | 'rename' | 'move' | 'copy' | 'delete';
export const actionLabels: Record<FileAction, string> = {
  file: '新建文件',
  directory: '新建文件夹',
  rename: '重命名',
  move: '移动到',
  copy: '复制到',
  delete: '删除',
};
export function FileOperation({
  connection,
  workspace,
  action,
  paths,
  directory,
  onClose,
  onDone,
}: {
  connection: string;
  workspace: string;
  action: FileAction;
  paths: string[];
  directory: string;
  onClose: () => void;
  onDone: (paths: string[]) => void;
}) {
  const [name, setName] = useState(action === 'rename' ? (paths[0]?.split('/').pop() ?? '') : '');
  const [target, setTarget] = useState(directory);
  const [folders, setFolders] = useState<{ name: string; path: string }[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const picker = action === 'move' || action === 'copy';
  const named = action === 'file' || action === 'directory' || action === 'rename';
  const endpoint = base(connection) + `/workspaces/${workspace}`;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    if (!picker) return;
    const controller = new AbortController();
    setFolders([]);
    setLoading(true);
    setError('');
    setCursor(null);
    api(
      endpoint + '/tree?' + new URLSearchParams({ path: target, hidden: 'true' }),
      undefined,
      controller.signal,
    )
      .then((data) => {
        setFolders(data.entries.filter((e: any) => e.type === 'directory'));
        setCursor(data.nextCursor);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [target]);
  const more = async () => {
    setLoading(true);
    try {
      const data = await api(
        endpoint + '/tree?' + new URLSearchParams({ path: target, hidden: 'true', cursor: cursor! }),
      );
      setFolders((old) => [...old, ...data.entries.filter((e: any) => e.type === 'directory')]);
      setCursor(data.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const completed: string[] = [];
    try {
      for (const path of named && action !== 'rename' ? [''] : paths) {
        const parent = action === 'rename' ? path.split('/').slice(0, -1).join('/') : target;
        const dest = [parent, named ? name.trim() : path.split('/').pop()].filter(Boolean).join('/');
        await api(endpoint + '/files/manage', {
          action,
          ...(path ? { path } : {}),
          ...(action === 'delete' ? {} : { target: dest }),
        });
        completed.push(path);
      }
      onDone(completed);
      onClose();
    } catch (e) {
      onDone(completed);
      setError(
        `操作未全部完成${completed.length ? `，已完成 ${completed.length} 项` : ''}：${(e as Error).message}。请关闭后检查列表。`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal file-operation"
        role="dialog"
        aria-modal="true"
        aria-label={actionLabels[action]}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onClose();
          if (e.key === 'Tab') {
            const controls = Array.from(
              dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
            );
            const first = controls[0],
              last = controls.at(-1);
            if (
              e.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog.current)
            ) {
              e.preventDefault();
              last?.focus();
            } else if (
              !e.shiftKey &&
              (document.activeElement === last || document.activeElement === dialog.current)
            ) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2>{actionLabels[action]}</h2>
        <p className="file-operation-path">
          {picker ? '目标位置：' : '当前位置：'}
          {target || '项目根目录'}
        </p>
        {action === 'delete' && <p>确认删除所选 {paths.length} 项及文件夹中的全部内容？此操作无法撤销。</p>}
        {paths.length > 0 && (
          <div className="file-operation-path">
            {paths.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        )}
        {named && (
          <label>
            名称
            <input
              aria-label="名称"
              value={name}
              disabled={busy}
              maxLength={255}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {picker && (
          <div className="file-destination-list" aria-busy={loading}>
            <button
              disabled={busy || loading || !target}
              onClick={() => setTarget(target.split('/').slice(0, -1).join('/'))}
            >
              上一级
            </button>
            <button disabled={busy || loading || !target} onClick={() => setTarget('')}>
              项目根目录
            </button>
            {folders.map((folder) => (
              <button
                key={folder.path}
                disabled={
                  busy || loading || paths.some((p) => folder.path === p || folder.path.startsWith(p + '/'))
                }
                onClick={() => setTarget(folder.path)}
              >
                📁 {folder.name}
              </button>
            ))}
            {loading && <p>正在读取目录…</p>}
            {cursor && (
              <button disabled={busy || loading} onClick={() => void more()}>
                加载更多
              </button>
            )}
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className={action === 'delete' ? 'danger' : 'primary'}
            disabled={
              busy ||
              loading ||
              !!error ||
              (named && (!name.trim() || /[/\\\x00-\x1f]/.test(name) || ['.', '..'].includes(name.trim())))
            }
            onClick={() => void submit()}
          >
            {busy
              ? '正在处理…'
              : picker
                ? actionLabels[action] + '这里'
                : action === 'delete'
                  ? '确认删除'
                  : '确认'}
          </button>
        </div>
      </section>
    </div>
  );
}
