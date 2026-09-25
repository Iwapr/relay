import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('render failures preserve streamed text and provide a page recovery screen', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
        import { createRoot } from 'react-dom/client';
        import { useState } from 'react';
        import { Markdown } from './apps/web/src/Markdown';
        import { RenderBoundary } from './apps/web/src/RenderBoundary';
        function Broken() { throw new Error('fixture page failure'); }
        function Fixture() {
          const [text, setText] = useState('initial reply');
          const [broken, setBroken] = useState(false);
          return <RenderBoundary>
            <button onClick={() => setText('broken reply')}>Break reply</button>
            <button onClick={() => setText('latest reply <script>literal</script>')}>Continue stream</button>
            <button onClick={() => setBroken(true)}>Break page</button>
            {broken ? <Broken /> : <><Markdown text={text} /><Markdown text="healthy reply" /></>}
          </RenderBoundary>;
        }
        createRoot(document.getElementById('root')!).render(<Fixture />);
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'simulate-render-failure',
        setup(builder) {
          builder.onLoad({ filter: /[/\\]MarkdownContent\.tsx$/ }, () => ({
            loader: 'tsx',
            contents: `export function Markdown({text}) {
            if (text === 'broken reply') throw new Error('fixture markdown failure');
            return <p>{text}</p>;
          }`,
          }));
        },
      },
    ],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByText('initial reply', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Break reply', exact: true }).click();
    await page.getByText('排版暂时不可用，已显示原文').waitFor();
    assert.equal(await page.getByText('broken reply', { exact: true }).count(), 1);
    assert.equal(await page.getByText('healthy reply', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Continue stream' }).click();
    await page.getByText('latest reply <script>literal</script>', { exact: true }).waitFor();
    assert.equal(await page.locator('.markdown-content script').count(), 0);
    await page.getByRole('button', { name: 'Break page', exact: true }).click();
    await page.getByRole('button', { name: '重新加载页面' }).waitFor();
    assert.ok(errors.some((error) => error.includes('[Relay] 页面渲染失败')));
  } finally {
    await browser.close();
  }
});
