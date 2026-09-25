import { useRef, useState, type ReactNode } from 'react';
import { Copy, Check } from 'lucide-react';
import './code-block.css';

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Try LAN HTTP fallback. */
    }
  }
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const focused = document.activeElement as HTMLElement | null;
  const input = document.createElement('textarea');
  input.value = text;
  input.style.cssText = 'position:fixed;left:-9999px;top:0;';
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('复制失败，请手动选择代码复制');
  } finally {
    input.remove();
    focused?.focus({ preventScroll: true });
    selection?.removeAllRanges();
    ranges.forEach((range) => selection?.addRange(range));
  }
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');
  const current = pre.current?.textContent ?? '';
  const done = copied !== null && copied === current;
  return (
    <div className="markdown-code-block">
      <button
        type="button"
        className="code-copy"
        aria-label="复制代码"
        title="复制代码"
        onClick={async () => {
          const text = pre.current?.textContent ?? '';
          setError('');
          try {
            await copyText(text);
            setCopied(text);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {done ? <Check size={12} /> : <Copy size={12} />}
        {done ? '已复制' : '复制'}
      </button>
      <pre ref={pre}>{children}</pre>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
