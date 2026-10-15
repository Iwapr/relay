import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendTextAttachments,
  decodeTextFile,
  splitTextAttachments,
} from '../../apps/web/src/text-attachments.ts';

test('text attachments preserve large JSONP, whitespace, names and escaped characters', () => {
  const text =
    '  Request.JSONP.request_0(' + JSON.stringify({ text: '中文\\u1234\n```'.repeat(100000) }) + ');\n';
  assert.equal(decodeTextFile(Buffer.from(text)), text);
  const sent = appendTextAttachments('分析文件', [
    { id: '1', name: '引号".json', size: Buffer.byteLength(text), text },
  ]);
  assert.deepEqual(splitTextAttachments(sent), {
    text: '分析文件',
    files: [{ name: '引号\".json', content: text }],
  });
  assert.deepEqual(JSON.parse(sent.slice(sent.indexOf('\n[') + 1)), [{ name: '引号".json', content: text }]);
});
test('text decoding supports BOM and refuses binary or invalid encoding without replacement', () => {
  assert.equal(decodeTextFile(Buffer.from('\ufeff中文', 'utf16le')), '中文');
  assert.equal(decodeTextFile(Buffer.from('\ufeff中文')), '中文');
  assert.equal(decodeTextFile(new Uint8Array()), '');
  assert.throws(() => decodeTextFile(Buffer.from([0xff, 0x00, 0x89])));
  assert.throws(() => decodeTextFile(Buffer.from('%PDF-1.7\n')));
  assert.throws(() => decodeTextFile(Buffer.from('abc\0def')));
});

test('attachment-only messages remain collapsible after server whitespace normalization', () => {
  const file = { id: '1', name: 'a.json', size: 2, text: '{}' };
  assert.deepEqual(splitTextAttachments(appendTextAttachments('', [file]).trim()), {
    text: '',
    files: [{ name: 'a.json', content: '{}' }],
  });
});
