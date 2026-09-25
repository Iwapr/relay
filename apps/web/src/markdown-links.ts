/** Resolve Markdown file links without treating server paths as website routes. */
export function localFilePath(current: string, target: string, root?: string): string | null {
  if (!target || target.startsWith('#') || /^[a-z][a-z\d+.-]*:|^\/\//i.test(target)) return null;
  // Fragments and query strings are URL metadata, not part of the file name.
  let pathname = target.split(/[?#]/, 1)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Preserve malformed escapes so the preview can report the invalid path.
  }
  pathname = pathname.replace(/:\d+(?::\d+)?$/, '');
  const absolute = pathname.startsWith('/');
  const parts = absolute ? [] : current.split('/').slice(0, -1);
  for (const part of pathname.split('/')) {
    if (part === '..') {
      if (!parts.length) return target; // Keep invalid traversal visible to the preview validator.
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  const resolved = (absolute || current.startsWith('/') ? '/' : '') + parts.filter(Boolean).join('/');
  const prefix = root?.replace(/\/+$/, '') + '/';
  return root && resolved.startsWith(prefix) ? resolved.slice(prefix.length) : resolved;
}
