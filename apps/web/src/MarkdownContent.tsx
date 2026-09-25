import { createContext, useContext, createElement, isValidElement, type ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkLatex } from './remarkLatex';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import { fileUrl } from './api';
import { localFilePath } from './markdown-links';
import 'katex/dist/katex.min.css';
function fragment(href: string) {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}
function plain(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(plain).join('');
  if (isValidElement<{ children?: ReactNode }>(children)) return plain(children.props.children);
  return '';
}
function heading(level: number) {
  return ({ children }: { children?: ReactNode }) =>
    createElement(
      'h' + level,
      {
        id:
          'relay-heading-' +
          plain(children)
            .toLowerCase()
            .trim()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .replace(/\s+/g, '-'),
      },
      children,
    );
}
type MarkdownProps = {
  text: string;
  connection?: string;
  workspace?: string;
  path?: string;
  root?: string;
  onOpen?: (path: string) => void;
};
const MarkdownContext = createContext<Omit<MarkdownProps, 'text'>>({});
// Stable component types preserve DOM nodes and browser selection during polling/streaming.
const components: import('react-markdown').Components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  a: ({ href, children }) => {
    const { path = '', root, onOpen } = useContext(MarkdownContext);
    if (href?.startsWith('#'))
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            const parent = e.currentTarget.closest('.markdown');
            parent
              ?.querySelector('[id="' + CSS.escape('relay-heading-' + fragment(href)) + '"]')
              ?.scrollIntoView({ behavior: 'smooth' });
          }}
        >
          {children}
        </a>
      );
    const target = href ? localFilePath(path, href, root) : null;
    return target && onOpen ? (
      <button className="inline-link" onClick={() => onOpen(target)}>
        {children}
      </button>
    ) : (
      <a href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => {
    const { path = '', root, connection, workspace } = useContext(MarkdownContext);
    const target = typeof src === 'string' ? localFilePath(path, src, root) : null;
    return target && connection && workspace && !target.toLowerCase().endsWith('.svg') ? (
      <img loading="lazy" src={fileUrl(connection, workspace, target)} alt={alt ?? ''} />
    ) : (
      <span className="muted">[图片未自动加载：{alt || '外部资源'}]</span>
    );
  },
  pre: CodeBlock,
};
export function Markdown({ text, ...context }: MarkdownProps) {
  return (
    <MarkdownContext.Provider value={context}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkLatex]}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore' }], rehypeHighlight]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </MarkdownContext.Provider>
  );
}
