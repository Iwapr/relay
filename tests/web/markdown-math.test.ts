import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { remarkLatex } from '../../apps/web/src/remarkLatex.ts';

function render(text: string) {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkMath, remarkLatex],
      rehypePlugins: [[rehypeKatex, { trust: false, strict: 'ignore' }]],
      skipHtml: true,
      children: text,
    }),
  );
}
const mathCount = (html: string) => (html.match(/class="katex"/g) ?? []).length;

test('all four math delimiters render, including adjacent Chinese text and multiline aligned equations', () => {
  const html = render(String.raw`内联\(x^2+\frac{1}{2}\)结束，$E=mc^2$。

\[
\begin{aligned}
a &= b+c \\
d &= \sqrt{2}
\end{aligned}
\]

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$`);
  assert.equal(mathCount(html), 4);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
  assert.ok(!html.includes('katex-error'));
  assert.ok(html.includes('内联'));
  assert.ok(html.includes('结束'));
});

test('backslash math is parsed inside lists, quotes, tables, and Markdown emphasis', () => {
  const html = render(String.raw`- \(a_1\)

> \[b^2\]

| 公式 |
| --- |
| \(c^3\) |

**\(d_4\)**`);
  assert.equal(mathCount(html), 4);
  assert.match(html, /<table>/);
  assert.match(html, /<strong><span class="katex">/);
});

test('literal code examples and escaped delimiters are not interpreted as math', () => {
  const code = String.raw`\(x\) \[y\] $z$`;
  const html = render(
    '`' + code + '`\n\n```latex\n' + code + '\n```\n\n    ' + code + '\n\n' + String.raw`\\(not math\\)`,
  );
  assert.equal(mathCount(html), 0);
  assert.ok(html.includes(code));
  assert.ok(html.includes('not math'));
});

test('link destinations, autolinks, dollar formulas and math code fences retain their meaning', () => {
  const html = render(
    String.raw`[document](https://example.com/a\(b\))

<https://example.com/\(x\)>

$\left[ x \right]$` + '\n\n```math\nx^2\n```',
  );
  assert.equal(mathCount(html), 2);
  assert.match(html, /href="https:\/\/example.com\/a\(b\)"/);
  assert.ok(html.includes('href="https://example.com/%5C(x%5C)"'));
});

test('streamed incomplete and invalid formulas retain visible text without breaking the reply', () => {
  for (const text of [String.raw`before \(\frac{1`, String.raw`before \[x^2`, String.raw`\(x\]`]) {
    const html = render(text);
    assert.equal(mathCount(html), 0);
    assert.ok(html.length > 0);
  }
  const html = render(String.raw`\(\frac{1}\) after`);
  assert.match(html, /katex-error/);
  assert.match(html, /after/);
  assert.equal(mathCount(render(String.raw`\(\frac{1}{2}\)`)), 1);
});

test('untrusted LaTeX cannot introduce executable links or remote images', () => {
  const html = render(String.raw`\(\href{javascript:alert(1)}{click}\)

\[\includegraphics{https://untrusted.invalid/track.png}\]`);
  assert.doesNotMatch(html, /<a\b|<img\b/);
});

test('multiline formulas preserve Markdown containers, CRLF, tabs and streamed prefixes', () => {
  const source = String.raw`> \[
> \begin{aligned}
> a &= b \\
> c &= d
> \end{aligned}
> \]

- \[
  x^2 + y^2
  \]`;
  for (const value of [source, source.replaceAll('\n', '\r\n')]) {
    const html = render(value);
    assert.equal(mathCount(html), 2);
    assert.doesNotMatch(html, /katex-error/);
  }
  const streamed = String.raw`答案是 \[\begin{aligned}x &= 1 \\ y &= 2\end{aligned}\]。`;
  for (let end = 0; end <= streamed.length; end++) assert.doesNotThrow(() => render(streamed.slice(0, end)));
  assert.equal(mathCount(render('\\[x\t+ y\\]')), 1);
});

test('display equations take precedence over setext headings, breaks, and blank paragraphs', () => {
  const formula = String.raw`\[
\boxed{\operatorname{char}_\Lambda(X_\infty)
=
p^{\sum_i\min(b,\mu_i)}\operatorname{char}_\Lambda(p^b X_\infty)}
\]`;
  for (const source of [
    formula,
    '> ' + formula.replaceAll('\n', '\n> '),
    '- ' + formula.replaceAll('\n', '\n  '),
  ]) {
    const html = render(source);
    assert.equal(mathCount(html), 1);
    assert.doesNotMatch(html, /<h[12]|katex-error/);
    assert.match(html, /\\boxed/);
  }
  assert.equal(
    mathCount(
      render(String.raw`\[
a

=

b
\]`),
    ),
    1,
  );
  assert.match(render('A title\n=\n\n---'), /<h1>A title<\/h1>/);
  assert.equal(mathCount(render('```latex\n' + formula + '\n```')), 0);
  for (let end = 0; end <= formula.length; end++) assert.doesNotThrow(() => render(formula.slice(0, end)));
  assert.equal(mathCount(render('> \\[\n> x\n\nOutside\n\\]')), 0);
  assert.equal(mathCount(render('前文\n' + formula + '\n后文')), 1);
});

test('KaTeX renderer and bundled stylesheet come from the same release', () => {
  const require = createRequire(import.meta.url);
  const renderer = createRequire(require.resolve('rehype-katex'));
  assert.equal(renderer('katex').version, require('katex').version);
});
