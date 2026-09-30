import { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  ArrowUp,
  X,
  Check,
  Star,
  Upload,
} from 'lucide-react';
import { api, base, save, saved, type Workspace } from './api';
import { useFileTransfers } from './file-transfers';
import './file-transfers.css';
import { FileOperation, type FileAction } from './FileOperation';
import { useFileWatch } from './use-file-watch';
interface Entry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
}
interface Listing {
  entries: Entry[];
  nextCursor: string | null;
  path: string;
}
interface FileBrowserProps {
  connection: string;
  workspace?: Workspace;
  selected: string;
  onOpen: (path: string) => void;
  onFolder: () => void;
  revision: number;
}
export function FileBrowser(props: FileBrowserProps) {
  return <WorkspaceFiles key={`${props.connection}:${props.workspace?.id ?? ''}`} {...props} />;
}
function WorkspaceFiles({ connection, workspace, selected, onOpen, onFolder, revision }: FileBrowserProps) {
  const directoryKey = `${connection}:workspace:${workspace?.id ?? ''}:directory`;
  const [directory, setDirectory] = useState(() => saved(directoryKey, '')),
    [listing, setListing] = useState<Listing>({ entries: [], nextCursor: null, path: '' }),
    [error, setError] = useState(''),
    [hidden, setHidden] = useState(false),
    [refresh, setRefresh] = useState(0),
    [changes, setChanges] = useState<any>(null),
    [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<'transfer' | 'new' | null>(null);
  const [managing, setManaging] = useState(false);
  const [operation, setOperation] = useState<FileAction | null>(null);
  const panel = useRef<HTMLElement>(null);
  useFileWatch(panel, connection, workspace?.id, 'directory', directory, () => setRefresh((r) => r + 1));
  const toggle = (path: string) =>
    setChecked((old) => {
      const next = new Set(old);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const transfer = useFileTransfers(connection, workspace?.id, () => setRefresh((r) => r + 1));
  useEffect(() => {
    setChecked(new Set());
  }, [directory]);
  const request = useRef(0);
  const changesRequest = useRef(0);
  useEffect(
    () => () => {
      changesRequest.current++;
    },
    [],
  );
  useEffect(() => {
    if (!workspace) return;
    const version = ++request.current;
    const controller = new AbortController();
    setLoading(true);
    setListing((current) =>
      current.path === directory ? current : { entries: [], nextCursor: null, path: directory },
    );
    setError('');
    void api<Listing>(
      base(connection) +
        `/workspaces/${workspace.id}/tree?` +
        new URLSearchParams({ path: directory, hidden: String(hidden) }),
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (request.current === version && !controller.signal.aborted) {
          setListing(data);
          save(directoryKey, data.path);
          setError('');
        }
      })
      .catch((e) => {
        if (request.current === version && !controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (request.current === version && !controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      request.current++;
    };
  }, [connection, workspace?.id, directory, hidden, revision, refresh]);
  const loadMore = async () => {
    if (!workspace || !listing.nextCursor || loading) return;
    const version = request.current;
    setLoading(true);
    try {
      const data = await api<Listing>(
        base(connection) +
          `/workspaces/${workspace.id}/tree?` +
          new URLSearchParams({ path: directory, hidden: String(hidden), cursor: listing.nextCursor }),
      );
      if (request.current === version)
        setListing((old) => ({ ...data, entries: [...old.entries, ...data.entries] }));
    } catch (e) {
      if (request.current === version) setError((e as Error).message);
    } finally {
      if (request.current === version) setLoading(false);
    }
  };
  return (
    <aside ref={panel} className="file-panel">
      <div className="panel-heading">
        <span>项目文件</span>
        <div className="actions">
          <button aria-label="打开远程文件夹" onClick={onFolder}>
            <FolderOpen size={16} />
          </button>
          <button aria-label="刷新文件列表" onClick={() => setRefresh((r) => r + 1)}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      {workspace && (
        <div className="file-transfer-tools">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label="选择上传文件"
            onChange={(e) => {
              void transfer.upload(Array.from(e.currentTarget.files ?? []), directory);
              e.currentTarget.value = '';
            }}
          />
          <input
            ref={(node) => {
              folderInput.current = node;
              node?.setAttribute('webkitdirectory', '');
            }}
            type="file"
            multiple
            hidden
            aria-label="选择上传文件夹"
            onChange={(e) => {
              void transfer.upload(Array.from(e.currentTarget.files ?? []), directory);
              e.currentTarget.value = '';
            }}
          />
          <div className="file-main-tools">
            <button
              aria-expanded={menu === 'transfer'}
              onClick={() => setMenu(menu === 'transfer' ? null : 'transfer')}
            >
              传输
            </button>
            <button aria-expanded={menu === 'new'} onClick={() => setMenu(menu === 'new' ? null : 'new')}>
              新建
            </button>
            <button
              aria-pressed={managing}
              onClick={() => {
                setManaging(!managing);
                setChecked(new Set());
                setMenu(null);
              }}
            >
              {managing ? '取消管理' : '管理'}
            </button>
          </div>
          {menu === 'new' && (
            <div className="file-selection-tools">
              <button onClick={() => setOperation('file')}>新建文件</button>
              <button onClick={() => setOperation('directory')}>新建文件夹</button>
            </div>
          )}
          {menu === 'transfer' && (
            <div className="file-selection-tools">
              <button disabled={transfer.busy} onClick={() => fileInput.current?.click()}>
                <Upload size={14} />
                上传文件
              </button>
              <button disabled={transfer.busy} onClick={() => folderInput.current?.click()}>
                <FolderPlus size={14} />
                上传文件夹
              </button>
              <button onClick={() => setManaging(true)}>选择下载文件</button>
              <button
                disabled={transfer.busy || !checked.size}
                onClick={() => {
                  const paths = [...checked];
                  const entry = listing.entries.find((e) => e.path === paths[0]);
                  void transfer.download(paths, paths.length > 1 || entry?.type === 'directory');
                }}
              >
                下载所选 ({checked.size})
              </button>
              {checked.size > 0 && <button onClick={() => setChecked(new Set())}>清空</button>}
            </div>
          )}
          {managing && (
            <div className="file-selection-tools">
              <label>
                <input
                  type="checkbox"
                  aria-label="选择已加载的全部文件"
                  checked={listing.entries.length > 0 && listing.entries.every((e) => checked.has(e.path))}
                  onChange={(e) =>
                    setChecked(e.target.checked ? new Set(listing.entries.map((e) => e.path)) : new Set())
                  }
                />
                全选
              </label>
              <span>已选 {checked.size} 项</span>
            </div>
          )}
          {transfer.status && (
            <div className="file-transfer-status" role="status">
              {transfer.status}
            </div>
          )}
          {transfer.ready && (
            <a href={transfer.ready.url} download={transfer.ready.name}>
              未开始下载？点击保存文件
            </a>
          )}
          {transfer.progress !== null && (
            <progress aria-label="上传进度" max={100} value={transfer.progress} />
          )}
          {transfer.busy && <button onClick={transfer.cancel}>取消传输</button>}
          {transfer.failures.length > 0 && (
            <div className="file-transfer-errors" role="alert">
              {transfer.failures.map((f, i) => (
                <p key={i}>{f}</p>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="tree-options">
        <span className="truncate" title={workspace ? `${workspace.canonicalRoot}/${directory}` : undefined}>
          {workspace ? directory || workspace.canonicalRoot.split('/').pop() || '/' : '尚未打开项目'}
        </span>
        <label>
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          隐藏文件
        </label>
      </div>
      {directory && (
        <button
          className="file-entry"
          onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}
        >
          <ArrowUp size={15} />
          上一级<span className="subtle truncate">{directory}</span>
        </button>
      )}
      <div className="file-list">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {error && directory && (
          <button className="more" onClick={() => setDirectory('')}>
            返回项目根目录
          </button>
        )}
        {loading && !listing.entries.length && <p className="subtle">正在读取目录…</p>}
        {listing.entries.map((entry) => (
          <div className="file-transfer-row" key={entry.path}>
            {managing && (
              <label className="file-check">
                <input
                  type="checkbox"
                  aria-label={`选择 ${entry.name}`}
                  checked={checked.has(entry.path)}
                  onChange={(e) =>
                    setChecked((old) => {
                      const next = new Set(old);
                      if (e.target.checked) next.add(entry.path);
                      else next.delete(entry.path);
                      return next;
                    })
                  }
                />
              </label>
            )}
            <button
              className={'file-entry ' + (selected === entry.path ? 'selected' : '')}
              onClick={() =>
                entry.type === 'directory'
                  ? setDirectory(entry.path)
                  : managing
                    ? toggle(entry.path)
                    : onOpen(entry.path)
              }
            >
              {entry.type === 'directory' ? <Folder size={16} /> : <FileText size={16} />}
              <span className="truncate">{entry.name}</span>
              {entry.type === 'directory' && <ChevronRight size={13} />}
            </button>
          </div>
        ))}
        {listing.nextCursor && (
          <button className="more" disabled={loading} onClick={() => void loadMore()}>
            加载更多
          </button>
        )}
        {!workspace && (
          <button className="open-project" onClick={onFolder}>
            <FolderOpen size={20} />
            打开远程文件夹
          </button>
        )}
      </div>
      {workspace && managing && (
        <div className="file-management-actions" aria-label="文件管理操作">
          <button disabled={checked.size !== 1} onClick={() => setOperation('rename')}>
            重命名
          </button>
          <button disabled={!checked.size} onClick={() => setOperation('move')}>
            移动
          </button>
          <button disabled={!checked.size} onClick={() => setOperation('copy')}>
            复制
          </button>
          <button className="danger" disabled={!checked.size} onClick={() => setOperation('delete')}>
            删除
          </button>
        </div>
      )}
      {workspace && operation && (
        <FileOperation
          connection={connection}
          workspace={workspace.id}
          action={operation}
          paths={operation === 'file' || operation === 'directory' ? [] : [...checked]}
          directory={directory}
          onClose={() => setOperation(null)}
          onDone={(paths) => {
            setChecked((old) => new Set([...old].filter((p) => !paths.includes(p))));
            setRefresh((r) => r + 1);
          }}
        />
      )}
      {workspace && (
        <div className="changes-panel">
          <button
            className="changes-heading"
            onClick={() => {
              const version = ++changesRequest.current;
              if (changes) setChanges(null);
              else
                void api(base(connection) + `/workspaces/${workspace.id}/changes`)
                  .then((data) => {
                    if (changesRequest.current === version) setChanges(data);
                  })
                  .catch((e) => {
                    if (changesRequest.current === version) setError(e.message);
                  });
            }}
          >
            {changes ? <ChevronDown size={14} /> : <ChevronRight size={14} />}修改记录
          </button>
          {changes && (
            <div className="changes-body">
              <p>{changes.notice}</p>
              <pre>
                {changes.status ||
                  (changes.observed ?? changes.entries)?.map((e: any) => String(e.path ?? e)).join('\n') ||
                  '没有记录到变更'}
              </pre>
              {changes.diff && (
                <details>
                  <summary>查看差异</summary>
                  <pre>{changes.diff}</pre>
                </details>
              )}
              {changes.stagedDiff && (
                <details>
                  <summary>暂存区差异</summary>
                  <pre>{changes.stagedDiff}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}
      <div className="file-footer">
        <span className="status-dot" />
        远端文件 · 按需读取
      </div>
    </aside>
  );
}
interface FolderPickerProps {
  connection: string;
  currentWorkspace?: Workspace;
  recent: Workspace[];
  onClose: () => void;
  onSelect: (w: Workspace) => void;
}
export function FolderPicker(props: FolderPickerProps) {
  return (
    <ConnectionFolderPicker key={`${props.connection}:${props.currentWorkspace?.id ?? ''}`} {...props} />
  );
}
function ConnectionFolderPicker({
  connection,
  currentWorkspace,
  recent,
  onClose,
  onSelect,
}: FolderPickerProps) {
  const [roots, setRoots] = useState<{ canonicalRoot: string }[]>([]),
    [path, setPath] = useState(''),
    [listing, setListing] = useState<Listing | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [folderName, setFolderName] = useState(''),
    [loading, setLoading] = useState(true),
    [favorites, setFavorites] = useState<string[]>(() => saved(connection + ':favorites', []));
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const browse = async (p: string, cursor?: string) => {
    const version = ++request.current;
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    setLoading(true);
    if (!cursor) {
      setPath(p);
      setListing(null);
    }
    try {
      setError('');
      const result = await api<Listing>(
        base(connection) +
          '/fs/directories?' +
          new URLSearchParams({ path: p, ...(cursor ? { cursor } : {}) }),
        undefined,
        pending.signal,
      );
      if (!mounted.current || version !== request.current || pending.signal.aborted) return;
      setPath(result.path);
      setListing((old) =>
        cursor ? { ...result, entries: [...(old?.entries ?? []), ...result.entries] } : result,
      );
    } catch (e) {
      if (mounted.current && version === request.current && !pending.signal.aborted)
        setError((e as Error).message);
    } finally {
      if (mounted.current && version === request.current && !pending.signal.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    const version = request.current;
    const pending = new AbortController();
    void api(base(connection) + '/fs/roots', undefined, pending.signal)
      .then((result) => {
        if (pending.signal.aborted) return;
        setRoots(result.roots);
        if (version !== request.current) return;
        const initial =
          currentWorkspace?.canonicalRoot ||
          saved(connection + ':last-folder', '') ||
          result.roots[0]?.canonicalRoot;
        if (initial) void browse(initial);
        else {
          setLoading(false);
          setError('此连接没有可浏览的目录。');
        }
      })
      .catch((e) => {
        if (!pending.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      mounted.current = false;
      request.current++;
      pending.abort();
      controller.current?.abort();
    };
  }, []);
  const open = async () => {
    setBusy(true);
    try {
      const result = await api(base(connection) + '/workspaces/open', { path });
      if (!mounted.current) return;
      save(connection + ':last-folder', result.workspace.canonicalRoot);
      onSelect(result.workspace);
      onClose();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const createProject = async () => {
    if (busy || loading || !listing || listing.path !== path) return;
    setBusy(true);
    setError('');
    let createdPath: string | undefined;
    try {
      const result = await api<{ path: string }>(base(connection) + '/fs/directories', {
        parent: listing.path,
        name: folderName.trim(),
      });
      createdPath = result.path;
      if (!mounted.current) return;
      setCreating(false);
      setFolderName('');
      const opened = await api(base(connection) + '/workspaces/open', { path: createdPath });
      if (!mounted.current) return;
      save(connection + ':last-folder', opened.workspace.canonicalRoot);
      onSelect(opened.workspace);
      onClose();
    } catch (e) {
      if (!mounted.current) return;
      if (createdPath) await browse(createdPath);
      if (mounted.current) setError((createdPath ? '文件夹已创建，但打开失败：' : '') + (e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal folder-modal" role="dialog" aria-modal="true" aria-labelledby="folder-title">
        <div className="modal-title">
          <div>
            <h2 id="folder-title">打开远程文件夹</h2>
            <p>选择此 Linux 用户有权访问的项目</p>
          </div>
          <button aria-label="关闭" disabled={busy} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="folder-roots">
          {roots.map((r) => (
            <button key={r.canonicalRoot} disabled={busy} onClick={() => void browse(r.canonicalRoot)}>
              <Folder size={14} />
              {r.canonicalRoot}
            </button>
          ))}
        </div>
        <form
          className="path-form"
          onSubmit={(e) => {
            e.preventDefault();
            void browse(path);
          }}
        >
          <input
            aria-label="远程目录路径"
            value={path}
            disabled={busy}
            onChange={(e) => {
              request.current++;
              controller.current?.abort();
              setPath(e.target.value);
              setListing(null);
              setError('');
              setLoading(false);
            }}
          />
          <button type="submit" disabled={busy || !path}>
            前往
          </button>
          <button
            type="button"
            aria-label="收藏目录"
            disabled={busy || !path}
            onClick={() => {
              const f = favorites.includes(path) ? favorites.filter((p) => p !== path) : [...favorites, path];
              setFavorites(f);
              save(connection + ':favorites', f);
            }}
          >
            <Star size={16} fill={favorites.includes(path) ? 'currentColor' : 'none'} />
          </button>
        </form>
        <div className="folder-create">
          <button
            type="button"
            disabled={busy || loading || !listing || listing.path !== path}
            aria-expanded={creating}
            onClick={() => {
              setCreating(!creating);
              setError('');
            }}
          >
            <FolderPlus size={16} />
            新建项目文件夹
          </button>
          {creating && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void createProject();
              }}
            >
              <small>创建位置：{listing?.path ?? path}</small>
              <label htmlFor="new-project-folder">项目文件夹名称</label>
              <input
                id="new-project-folder"
                autoFocus
                value={folderName}
                disabled={busy}
                placeholder="例如 my-project"
                maxLength={255}
                onChange={(e) => setFolderName(e.target.value)}
              />
              <button
                type="submit"
                className="primary"
                disabled={
                  busy ||
                  loading ||
                  !listing ||
                  listing.path !== path ||
                  !folderName.trim() ||
                  /[\\/\x00-\x1f\x7f]/.test(folderName) ||
                  ['.', '..'].includes(folderName.trim())
                }
              >
                {busy ? '正在创建并打开…' : '创建并打开'}
              </button>
            </form>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="folder-shortcuts">
          {[...new Set([...favorites, ...recent.map((w) => w.canonicalRoot)])].slice(0, 6).map((p) => (
            <button key={p} disabled={busy} onClick={() => void browse(p)}>
              {p}
            </button>
          ))}
        </div>
        <div className="folder-list" aria-busy={loading}>
          <button
            disabled={busy || !path}
            onClick={() => void browse(path.split('/').slice(0, -1).join('/') || '/')}
          >
            <ArrowUp size={16} />
            上一级
          </button>
          {loading && <p className="subtle">正在读取目录…</p>}
          {listing?.entries.map((e) => (
            <button key={e.path} disabled={busy} onClick={() => void browse(e.path)}>
              <Folder size={17} />
              {e.name}
              <ChevronRight size={15} />
            </button>
          ))}
          {listing?.nextCursor && (
            <button disabled={busy || loading} onClick={() => void browse(listing.path, listing.nextCursor!)}>
              加载更多
            </button>
          )}
        </div>
        <div className="modal-footer">
          <button disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || loading || !listing || listing.path !== path}
            onClick={() => void open()}
          >
            <Check size={16} />
            {busy ? '正在打开…' : '打开文件夹'}
          </button>
        </div>
      </section>
    </div>
  );
}
