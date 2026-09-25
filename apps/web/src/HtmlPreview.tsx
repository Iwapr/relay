import { lazy, Suspense, useMemo, useState } from 'react';
import './html-preview.css';

const CodePreview = lazy(() => import('./CodePreview').then((m) => ({ default: m.CodePreview })));

export function HtmlPreview({ text, path }: { text: string; path: string }) {
  const [source, setSource] = useState(false);
  const document = useMemo(() => {
    const parsed = new DOMParser().parseFromString(text, 'text/html');
    // Keep the preview self-contained and prevent navigation out of the document.
    parsed.querySelectorAll('base, meta[http-equiv]').forEach((element) => element.remove());
    parsed.querySelectorAll('a, area').forEach((element) => element.removeAttribute('href'));
    const policy = parsed.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content =
      "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";
    parsed.head.prepend(policy);
    return '<!doctype html>' + parsed.documentElement.outerHTML;
  }, [text]);

  return (
    <div className="html-preview">
      <div className="html-preview-toolbar" role="group" aria-label="HTML 显示方式">
        <button aria-pressed={!source} onClick={() => setSource(false)}>
          页面预览
        </button>
        <button aria-pressed={source} onClick={() => setSource(true)}>
          源代码
        </button>
        <span>静态预览 · 不运行脚本或加载外部资源</span>
      </div>
      {source ? (
        <div className="html-preview-source">
          <Suspense fallback={<pre>{text}</pre>}>
            <CodePreview text={text} path={path} />
          </Suspense>
        </div>
      ) : (
        <iframe title={`${path} 页面预览`} sandbox="" referrerPolicy="no-referrer" srcDoc={document} />
      )}
    </div>
  );
}
