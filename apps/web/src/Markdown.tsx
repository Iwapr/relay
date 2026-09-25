import { lazy, Suspense, useEffect, useReducer, useRef, type ComponentProps } from 'react';
import { RenderBoundary } from './RenderBoundary';
const Content = lazy(() => import('./MarkdownContent').then((m) => ({ default: m.Markdown })));
export function Markdown(props: ComponentProps<(typeof import('./MarkdownContent'))['Markdown']>) {
  const container = useRef<HTMLDivElement>(null);
  const displayed = useRef(props.text);
  const frozen = useRef(false);
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  const hasSelection = () => {
    if (typeof window === 'undefined') return false;
    const selection = window.getSelection();
    return (
      !!container.current &&
      !!selection &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      selection.getRangeAt(0).intersectsNode(container.current)
    );
  };
  // A text-node update can collapse a browser selection even without remounting.
  // Keep this message still while selected; resume with the latest text on release.
  if (!hasSelection()) {
    displayed.current = props.text;
    frozen.current = false;
  } else frozen.current = displayed.current !== props.text;
  useEffect(() => {
    const changed = () => {
      if (frozen.current && !hasSelection()) refresh();
    };
    document.addEventListener('selectionchange', changed);
    return () => document.removeEventListener('selectionchange', changed);
  }, []);
  return (
    <div ref={container} className="markdown-content">
      <RenderBoundary
        fallback={
          <div>
            <small className="muted" role="status">
              排版暂时不可用，已显示原文
            </small>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{displayed.current}</div>
          </div>
        }
      >
        <Suspense fallback={<span className="muted">正在排版…</span>}>
          <Content {...props} text={displayed.current} />
        </Suspense>
      </RenderBoundary>
    </div>
  );
}
