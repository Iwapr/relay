import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, base, requestId } from './api';

interface Plan {
  token: string;
  sessions: Array<{ id: string; title: string; cwd: string; source?: string }>;
}

export function Takeover({
  connection,
  conversationId,
  disabled,
  onReleased,
}: {
  connection: string;
  conversationId: string;
  disabled: boolean;
  onReleased: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!plan) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) setPlan(null);
      if (event.key !== 'Tab') return;
      const buttons = Array.from(
        dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
      );
      if (!buttons.length) {
        event.preventDefault();
        return;
      }
      const first = buttons[0],
        last = buttons.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      button.current?.focus();
    };
  }, [plan]);
  async function preview() {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      const result = await api<Plan>(
        base(connection) + `/conversations/${conversationId}/takeover/preview`,
        {},
      );
      if (alive.current) setPlan(result);
    } catch (error) {
      if (alive.current) setMessage((error as Error).message);
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!plan || busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api(base(connection) + `/conversations/${conversationId}/takeover`, {
        token: plan.token,
        clientRequestId: requestId(),
        confirmed: true,
      });
      if (alive.current) {
        setMessage('原占用进程已结束，可以在此继续发送消息。');
        onReleased();
      }
    } catch (error) {
      if (alive.current) setMessage((error as Error).message);
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setPlan(null);
        setBusy(false);
      }
    }
  }
  return (
    <>
      <div className="takeover-control">
        <button ref={button} disabled={disabled || busy} onClick={() => void preview()}>
          {busy ? '正在处理接管…' : '在此接管'}
        </button>
        <span role="status">{message || '会话被其他窗口占用时，可确认中断后在这里继续。'}</span>
      </div>
      {plan &&
        createPortal(
          <div className="rollback-backdrop">
            <section
              ref={dialog}
              className="rollback-dialog takeover-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="takeover-title"
              aria-describedby="takeover-warning"
            >
              <h3 id="takeover-title">确认中断并在此接管？</h3>
              <p id="takeover-warning">
                将结束占用此会话的 Codex 进程。以下 {plan.sessions.length}{' '}
                个对话都会受到影响，正在生成的回复和任务会被中断，不会自动续跑。
              </p>
              <ul>
                {plan.sessions.map((session) => (
                  <li key={session.id}>
                    <strong>{session.title || '未命名对话'}</strong>
                    {session.source === 'subagent' && <small>子代理会话（也会被中断）</small>}
                    <span>{session.cwd}</span>
                    <small>{session.id}</small>
                  </li>
                ))}
              </ul>
              <p>
                已保存的历史和文件修改会保留；尚未保存的输出可能丢失，已经启动的外部命令可能仍在运行。接管后请先检查执行结果，再继续发送。
              </p>
              <p>浏览器或 VS Code 窗口本身不会关闭。请勿同时在原窗口继续发送，以免再次占用。</p>
              <div className="rollback-buttons">
                <button disabled={busy} onClick={() => setPlan(null)}>
                  取消
                </button>
                <button disabled={busy || disabled} onClick={() => void confirm()}>
                  {busy ? '正在中断…' : `确认中断 ${plan.sessions.length} 个对话并接管`}
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
