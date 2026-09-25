import { useEffect, useRef, useState } from 'react';
import { Check, Folder, FolderPlus, Search, X } from 'lucide-react';
import { api, base, isActive, saved, type Run, type Workspace } from './api';
import './project-picker.css';

export function ProjectPicker({
  connection,
  accountConnections,
  projects,
  currentId,
  runs,
  online,
  onSelect,
  onAdd,
  onClose,
}: {
  connection: string;
  accountConnections: string[];
  projects: Workspace[];
  currentId: string;
  runs: Run[];
  online: boolean;
  onSelect: (workspace: Workspace) => void | Promise<void>;
  onAdd: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [shared, setShared] = useState<Workspace[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const accountKey = JSON.stringify(accountConnections);
  useEffect(() => {
    const abort = new AbortController();
    let revision = 0;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      const request = ++revision;
      const results = await Promise.allSettled(
        (JSON.parse(accountKey) as string[]).map((id) =>
          api<{ workspaces: Workspace[] }>(base(id) + '/workspaces', undefined, abort.signal),
        ),
      );
      if (abort.signal.aborted || request !== revision) return;
      setShared(results.flatMap((result) => (result.status === 'fulfilled' ? result.value.workspaces : [])));
      setError(
        results.some((result) => result.status === 'rejected') ? '部分项目未能加载，请重新打开重试' : '',
      );
    };
    void refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      abort.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [accountKey]);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const visits = saved<Record<string, number>>(connection + ':project-visits', {});
  const filtered = [
    ...new Map([...shared, ...projects].map((project) => [project.canonicalRoot, project])).values(),
  ]
    .filter((project) => project.canonicalRoot.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => (visits[b.id] ?? Date.parse(b.createdAt)) - (visits[a.id] ?? Date.parse(a.createdAt)));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector('input')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? []),
      ];
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="modal project-picker"
        role="dialog"
        aria-modal="true"
        aria-label="切换项目"
        ref={dialog}
      >
        <div className="modal-title">
          <h2>切换项目</h2>
          <button aria-label="关闭项目选择" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label className="project-search">
          <Search size={16} />
          <input
            aria-label="搜索项目"
            placeholder="搜索项目名称或路径"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p className="project-picker-hint">最近使用的项目</p>
        <ul className="project-picker-list" aria-label="项目列表">
          {filtered.map((project) => (
            <li key={project.id}>
              <button
                aria-current={project.id === currentId ? 'true' : undefined}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onSelect(project);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Folder size={18} />
                <span className="project-picker-name">
                  <strong>{project.canonicalRoot.split('/').pop() || project.canonicalRoot}</strong>
                  <small title={project.canonicalRoot}>{project.canonicalRoot}</small>
                </span>
                {runs.some((run) => run.workspaceId === project.id && isActive(run.state)) && (
                  <span className="project-running" aria-label="有任务正在运行" title="有任务正在运行" />
                )}
                {project.id === currentId && <Check size={18} aria-label="当前项目" />}
              </button>
            </li>
          ))}
        </ul>
        {!filtered.length && (
          <p className="project-picker-empty">{query.trim() ? '没有匹配的项目' : '还没有打开过项目'}</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="project-picker-add" disabled={!online || busy} onClick={onAdd}>
          <FolderPlus size={18} />
          打开新项目…
        </button>
      </div>
    </div>
  );
}
