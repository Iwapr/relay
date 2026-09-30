import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { FileText, Download, RefreshCw } from 'lucide-react';
import { ApiError, api, base, fileUrl, save, saved, type Metadata } from './api';
import { Markdown } from './Markdown';
import { HtmlPreview } from './HtmlPreview';
import { useFileWatch } from './use-file-watch';
const PdfView = lazy(() => import('./PdfView'));
const CodePreview = lazy(() => import('./CodePreview').then((m) => ({ default: m.CodePreview })));
export interface Reference {
  path: string;
  version: string;
  text: string;
  page?: number;
  line?: number;
}
export function Preview({
  connection,
  workspace,
  root,
  path,
  revision,
  onOpen,
}: {
  connection: string;
  workspace: string;
  root?: string;
  path: string;
  revision: number;
  onOpen: (path: string) => void;
}) {
  const [meta, setMeta] = useState<Metadata | null>(null),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [reload, setReload] = useState(0),
    [stale, setStale] = useState(false);
  const content = useRef<HTMLDivElement>(null),
    lastRevision = useRef(revision);
  const stateKey = connection + ':' + workspace + ':' + path;
  const panel = useRef<HTMLElement>(null);
  const [watchRevision, setWatchRevision] = useState(0);
  useFileWatch(panel, connection, workspace, 'file', path, () => setWatchRevision((r) => r + 1));
  const isHtml = meta?.preview === 'text' && /\.html?$/i.test(path);
  useEffect(() => {
    if (revision === lastRevision.current && !watchRevision) return;
    lastRevision.current = revision;
    if (!path || !meta) return;
    const abort = new AbortController();
    void api<Metadata>(
      base(connection) + `/workspaces/${workspace}/metadata?` + new URLSearchParams({ path }),
      undefined,
      abort.signal,
    )
      .then((latest) => {
        if (!abort.signal.aborted && latest.version !== meta.version) setStale(true);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [revision, watchRevision, path, meta?.version, connection, workspace]);
  useEffect(() => {
    if (!path) return;
    const abort = new AbortController();
    setLoading(true);
    setError('');
    setMeta(null);
    setStale(false);
    void api<Metadata>(
      base(connection) + `/workspaces/${workspace}/metadata?` + new URLSearchParams({ path }),
      undefined,
      abort.signal,
    )
      .then(async (m) => {
        let t = '';
        if (m.preview === 'text' || m.preview === 'markdown') {
          const res = await fetch(fileUrl(connection, workspace, path, m.version), {
            signal: abort.signal,
            cache: 'no-store',
          });
          if (!res.ok) throw new Error('文件版本已失效，请刷新');
          t = await res.text();
        }
        if (abort.signal.aborted) return;
        setMeta(m);
        setText(t);
        requestAnimationFrame(() => {
          if (content.current) content.current.scrollTop = saved(stateKey + ':scroll', 0);
        });
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(
            e instanceof ApiError && e.code === 'not_found'
              ? '文件不存在，可能已被移动或临时文件已被清理。'
              : e instanceof ApiError && e.code === 'permission_denied'
                ? '此文件不可读取：没有读取权限，或属于受保护的文件、链接。'
                : e instanceof ApiError && e.code === 'path_outside_workspace'
                  ? '文件路径无效，或不在此连接允许预览的目录范围内。'
                  : e.message,
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [connection, workspace, path, reload]);
  if (!path)
    return (
      <section ref={panel} className="preview-panel">
        <div className="panel-heading">
          <span>文档预览</span>
          <span className="subtle">你的远端工作空间</span>
        </div>
        <div className="empty-state document-empty">
          <div className="document-symbol">
            <FileText size={30} />
          </div>
          <h2>让想法与文档在一起</h2>
          <p>
            从文件列表打开 Markdown、PDF 或代码。
            <br />
            在对话中提出修改，让 Codex 在远端完成工作。
          </p>
          <div className="file-formats">
            <span>Markdown + 公式</span>
            <span>PDF</span>
            <span>代码</span>
          </div>
        </div>
      </section>
    );
  return (
    <section ref={panel} className="preview-panel">
      <div className="panel-heading">
        <span className="truncate">
          <FileText size={15} />
          {path}
        </span>
        <div className="actions">
          <button title="刷新文档" aria-label="刷新文档" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw size={16} />
          </button>
          {meta && (
            <a aria-label="下载文件" href={fileUrl(connection, workspace, path, meta.version)} download>
              <Download size={16} />
            </a>
          )}
        </div>
      </div>
      {stale && (
        <button className="version-banner" onClick={() => setReload((n) => n + 1)}>
          文件有新版本，点击刷新 · 保留阅读位置
        </button>
      )}
      <div
        ref={content}
        className={
          'preview-content ' + (meta?.preview === 'pdf' ? 'pdf-content' : isHtml ? 'html-content' : '')
        }
        onScroll={(e) => save(stateKey + ':scroll', e.currentTarget.scrollTop)}
      >
        {loading ? (
          <div className="empty-state">正在读取远端文件…</div>
        ) : error ? (
          <div className="error" role="alert">
            {error}
          </div>
        ) : meta?.preview === 'pdf' ? (
          <Suspense fallback={<div className="empty-state">正在加载 PDF 阅读器…</div>}>
            <PdfView
              key={meta.version}
              stateKey={stateKey}
              url={fileUrl(connection, workspace, path, meta.version)}
              onPage={() => {}}
            />
          </Suspense>
        ) : meta?.preview === 'markdown' ? (
          <article className="markdown document">
            <Markdown
              text={text}
              connection={connection}
              workspace={workspace}
              root={root}
              path={path}
              onOpen={onOpen}
            />
          </article>
        ) : meta?.preview === 'image' ? (
          <img
            className="image-preview"
            src={fileUrl(connection, workspace, path, meta.version)}
            alt={path}
          />
        ) : isHtml ? (
          <HtmlPreview key={stateKey} text={text} path={path} />
        ) : meta?.preview === 'text' ? (
          <Suspense
            fallback={
              <pre className="code-preview">
                <code>{text}</code>
              </pre>
            }
          >
            <CodePreview text={text} path={path} />
          </Suspense>
        ) : (
          <div className="empty-state">
            <FileText />
            <p>此文件需要下载后查看</p>
            <span>{meta?.size.toLocaleString()} bytes</span>
          </div>
        )}
      </div>
      <div className="preview-footer">
        <span>只读预览</span>
        <span>{meta ? `${(meta.size / 1024).toFixed(1)} KB · 版本 ${meta.version.slice(0, 8)}` : ''}</span>
      </div>
    </section>
  );
}
