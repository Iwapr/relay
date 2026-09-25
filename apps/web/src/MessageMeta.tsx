/** IDE envelopes are presentation metadata; keep the original request available. */
export function splitIdeContext(text: string): { request: string; context?: string } {
  if (!/^# Context from my IDE setup:\s/m.test(text) || !text.startsWith('# Context from my IDE setup:'))
    return { request: text };
  const marker = /^##? My request:[ \t]*\r?\n/m.exec(text);
  if (!marker) return { request: text };
  const request = text.slice(marker.index + marker[0].length);
  if (!request.trim()) return { request: text };
  return { request, context: text.slice(0, marker.index).trimEnd() };
}

export function UserText({ text }: { text: string }) {
  const { request, context } = splitIdeContext(text);
  return (
    <>
      {request}
      {context && (
        <details className="message-context">
          <summary>IDE 附带上下文</summary>
          <pre>{context}</pre>
        </details>
      )}
    </>
  );
}

export function MessageTime({ value, label }: { value?: string; label: string }) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return <small className="message-time">时间未记录</small>;
  return (
    <time
      className="message-time"
      dateTime={date.toISOString()}
      title={`${label} · ${date.toLocaleString()}（本地时间）`}
    >
      {label} ·{' '}
      {date.toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })}
    </time>
  );
}
