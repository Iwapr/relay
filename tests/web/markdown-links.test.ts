import test from 'node:test';
import assert from 'node:assert/strict';
import { localFilePath } from '../../apps/web/src/markdown-links.ts';

test('relative and absolute file links resolve from the correct directory', () => {
  assert.equal(localFilePath('', '/work/项目/图 片.png', '/work/项目'), '图 片.png');
  assert.equal(localFilePath('docs/guide.md', '/work/项目/README.md', '/work/项目'), 'README.md');
  assert.equal(localFilePath('docs/guide.md', '../figure.png', '/work/项目'), 'figure.png');
  assert.equal(localFilePath('', 'docs/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md'), 'docs/中文 文件.md');
  assert.equal(localFilePath('', '/work/项目/main.ts:12:3', '/work/项目'), 'main.ts');
  assert.equal(localFilePath('', 'README.md#介绍'), 'README.md');
  assert.equal(localFilePath('', 'paper.pdf?page=2'), 'paper.pdf');
  assert.equal(localFilePath('', '/file.txt', '/'), 'file.txt');
});

test('outside paths stay local and cannot masquerade as in-project files', () => {
  assert.equal(localFilePath('', '/tmp/screenshot.png', '/work/project'), '/tmp/screenshot.png');
  assert.equal(
    localFilePath('', '/work/project-other/file.png', '/work/project'),
    '/work/project-other/file.png',
  );
  assert.equal(localFilePath('', '/work/project/../secret', '/work/project'), '/work/secret');
  assert.equal(localFilePath('', '../secret'), '../secret');
  assert.equal(localFilePath('', '%2Ftmp%2Fscreenshot.png', '/work/project'), '/tmp/screenshot.png');
});

test('external URLs and in-document anchors retain their own handling', () => {
  for (const url of [
    'https://example.com/a.png',
    '//example.com/a.png',
    'mailto:a@example.com',
    '#section',
    'javascript:alert(1)',
    '',
  ]) {
    assert.equal(localFilePath('', url), null);
  }
});
