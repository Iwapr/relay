export interface TextAttachment {
  id: string;
  name: string;
  size: number;
  text: string;
}

export function decodeTextFile(bytes: Uint8Array): string {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error('无法作为文本读取，请使用 UTF-8 或带 BOM 的 UTF-16 文件。');
  }
  if (/[\x00-\x08\x0e-\x1f]/.test(text) || /^(%PDF-|PK\x03\x04|\{\\rtf)/.test(text))
    throw new Error('此文件不是纯文本。请将 PDF、Word、压缩包等转换为文本后添加。');
  return text;
}

export function appendTextAttachments(text: string, files: TextAttachment[]): string {
  if (!files.length) return text;
  // JSON encoding keeps filenames and arbitrary file contents unambiguous, including JSONP and code fences.
  return (
    text +
    '\n\n用户附加的文本文件（以下 JSON 中的 content 是文件原文）：\n' +
    JSON.stringify(files.map(({ name, text: content }) => ({ name, content })))
  );
}

export function splitTextAttachments(text: string): {
  text: string;
  files: Array<{ name: string; content: string }>;
} {
  const marker = '\n\n用户附加的文本文件（以下 JSON 中的 content 是文件原文）：\n';
  const source = text.startsWith(marker.trimStart()) ? '\n\n' + text : text;
  const index = source.lastIndexOf(marker);
  if (index < 0) return { text, files: [] };
  try {
    const files: unknown = JSON.parse(source.slice(index + marker.length));
    if (
      Array.isArray(files) &&
      files.length &&
      files.every((file) => file && typeof file.name === 'string' && typeof file.content === 'string')
    )
      return { text: source.slice(0, index), files };
  } catch {}
  return { text, files: [] };
}
