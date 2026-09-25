import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import yaml from 'highlight.js/lib/languages/yaml';
import latex from 'highlight.js/lib/languages/latex';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import sql from 'highlight.js/lib/languages/sql';
import ini from 'highlight.js/lib/languages/ini';
import './code-preview.css';

for (const [name, grammar] of Object.entries({
  javascript,
  typescript,
  python,
  bash,
  json,
  xml,
  css,
  yaml,
  latex,
  c,
  cpp,
  rust,
  go,
  sql,
  ini,
}))
  hljs.registerLanguage(name, grammar);
const extensions: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  pyw: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  jsonc: 'json',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  css: 'css',
  scss: 'css',
  yaml: 'yaml',
  yml: 'yaml',
  tex: 'latex',
  sty: 'latex',
  cls: 'latex',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  rs: 'rust',
  go: 'go',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
};
const labels: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  bash: 'Shell',
  json: 'JSON',
  xml: 'HTML / XML',
  css: 'CSS',
  yaml: 'YAML',
  latex: 'LaTeX',
  c: 'C',
  cpp: 'C++',
  rust: 'Rust',
  go: 'Go',
  sql: 'SQL',
  ini: '配置文件',
};
export interface CodePreviewProps {
  text: string;
  path: string;
}

/** Source is never inserted as HTML; only highlight.js's escaped, span-only output is. */
export function CodePreview({ text, path }: CodePreviewProps) {
  const extension = path.split('/').at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
  const language = extensions[extension];
  const large = text.length > 200_000;
  const highlighted = useMemo(() => {
    if (!language || large) return null;
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [text, language, large]);
  return (
    <div className="source-preview">
      <div className="source-toolbar">
        <span>{language ? labels[language] : '纯文本'}</span>
        <span>{large ? '文件较大，按纯文本显示' : '只读'}</span>
      </div>
      <pre className="code-preview source-code" tabIndex={0} aria-label={`${path} 源代码（只读）`}>
        {highlighted === null ? (
          <code>{text}</code>
        ) : (
          <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
        )}
      </pre>
    </div>
  );
}
