import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, base, ApiError } from './api';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

const keys = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['Home', '\x1b[H'],
  ['End', '\x1b[F'],
  ['/', '/'],
  ['-', '-'],
  ['|', '|'],
  ['~', '~'],
  ['_', '_'],
  ['中断 Ctrl+C', '\x03'],
] as const;

export function Terminal({
  connection,
  workspace,
  root,
  onClose,
}: {
  connection: string;
  workspace: string;
  root: string;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerm | null>(null);
  const send = useRef<(data: string) => void>(() => {});
  const ctrl = useRef(false);
  const [control, setControl] = useState(false);
  const [status, setStatus] = useState('正在连接…');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    let disposed = false;
    let id = '';
    let cursor = 0;
    let pollTimer: ReturnType<typeof setTimeout>;
    let resizeTimer: ReturnType<typeof setTimeout>;
    let queue = Promise.resolve();
    let failed = false;
    const endpoint = base(connection) + `/workspaces/${workspace}/terminals`;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      scrollback: 3000,
      theme: { background: '#10151e', foreground: '#e0e6ef', cursor: '#9bd5ff' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    terminal.current = term;
    const textarea = term.textarea;
    if (textarea) {
      textarea.setAttribute('aria-label', '终端输入');
      textarea.setAttribute('autocapitalize', 'off');
      textarea.setAttribute('autocomplete', 'off');
      textarea.setAttribute('autocorrect', 'off');
      textarea.spellcheck = false;
      textarea.inputMode = 'text';
    }
    fit.fit();
    term.focus();
    const screen = container.current!.closest<HTMLElement>('.terminal-screen')!;
    const siblings = [...screen.parentElement!.children].filter(
      (item): item is HTMLElement => item instanceof HTMLElement && item !== screen,
    );
    const inertBefore = siblings.map((item) => item.inert);
    siblings.forEach((item) => {
      item.inert = true;
    });
    const keepFocus = (event: FocusEvent) => {
      if (!screen.contains(event.target as Node)) term.focus();
    };
    document.addEventListener('focusin', keepFocus);
    const fail = (e: unknown) => {
      if (disposed) return;
      failed = true;
      setReady(false);
      setError((e as Error).message);
    };
    const post = (action: string, body: unknown) => {
      queue = queue
        .then(async () => {
          if (!disposed && id && !failed) await api(`${endpoint}/${id}/${action}`, body);
        })
        .catch(fail);
    };
    send.current = (data) => {
      if (!id || failed) return;
      if (ctrl.current && data.length === 1 && /[a-zA-Z@\[\]\\^_?]/.test(data)) {
        data = data === '?' ? '\x7f' : String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
        ctrl.current = false;
        setControl(false);
      }
      // Keep paste requests within the server's input limit, preserving order.
      for (let start = 0; start < data.length; start += 8192)
        post('input', { data: data.slice(start, start + 8192) });
    };
    const input = term.onData((data) => send.current(data));
    const resize = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed) return;
        fit.fit();
        post('resize', { cols: Math.min(500, term.cols), rows: Math.min(300, term.rows) });
      }, 100);
    });
    resize.observe(container.current!);
    const poll = async () => {
      try {
        const result = await api<{
          data: string;
          cursor: number;
          truncated: boolean;
          exitCode: number | null;
        }>(`${endpoint}/${id}?cursor=${cursor}`);
        if (disposed) return;
        if (result.truncated) term.write('\r\n[部分较早输出已省略]\r\n');
        if (result.data) await new Promise<void>((resolve) => term.write(result.data, resolve));
        cursor = result.cursor;
        if (disposed) return;
        if (result.exitCode !== null) {
          setReady(false);
          failed = true;
          setStatus(`进程已退出（${result.exitCode}）`);
          return;
        }
        setStatus('已连接');
      } catch (e) {
        if (disposed) return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          fail(e);
          return;
        }
        setStatus('连接中断，正在重试…');
      }
      if (!disposed) pollTimer = setTimeout(() => void poll(), 150);
    };
    void api<{ id: string }>(endpoint, { cols: Math.min(500, term.cols), rows: Math.min(300, term.rows) })
      .then((result) => {
        id = result.id;
        if (disposed) {
          void api(`${endpoint}/${id}/close`, {}).catch(() => {});
          return;
        }
        setReady(true);
        setStatus('已连接');
        post('resize', { cols: Math.min(500, term.cols), rows: Math.min(300, term.rows) });
        void poll();
      })
      .catch(fail);
    return () => {
      disposed = true;
      clearTimeout(pollTimer);
      clearTimeout(resizeTimer);
      resize.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = null;
      send.current = () => {};
      if (id) void api(`${endpoint}/${id}/close`, {}).catch(() => {});
      document.removeEventListener('focusin', keepFocus);
      siblings.forEach((item, index) => {
        item.inert = inertBefore[index];
      });
      previous?.focus();
    };
  }, [connection, workspace]);

  return (
    <section className="terminal-screen" role="dialog" aria-modal="true" aria-label="Terminal 终端">
      <header className="terminal-header">
        <div>
          <strong>Terminal</strong>
          <span title={root}>{root}</span>
        </div>
        <button onClick={onClose} title="关闭终端并结束 shell">
          关闭终端
        </button>
      </header>
      <div className="terminal-status" role="status">
        {error || status}
      </div>
      <div className="terminal-surface" ref={container} />
      <div className="terminal-keys" aria-label="终端快捷键">
        <button
          disabled={!ready}
          aria-pressed={control}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            ctrl.current = !ctrl.current;
            setControl(ctrl.current);
            terminal.current?.focus();
          }}
        >
          Ctrl
        </button>
        {keys.map(([label, value]) => (
          <button
            key={label}
            disabled={!ready}
            aria-label={label === '中断 Ctrl+C' ? '中断 Ctrl+C' : label}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              send.current(value);
              terminal.current?.focus();
            }}
          >
            {label === '中断 Ctrl+C' ? 'Ctrl+C' : label}
          </button>
        ))}
        <button
          disabled={!ready}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            send.current('\r');
            terminal.current?.focus();
          }}
        >
          Enter
        </button>
        <button onPointerDown={(e) => e.preventDefault()} onClick={() => terminal.current?.focus()}>
          键盘
        </button>
      </div>
    </section>
  );
}
