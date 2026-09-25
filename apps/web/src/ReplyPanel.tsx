import type { ReactNode } from 'react';
import { CheckCircle2, CircleAlert, CircleHelp, Clock3, LoaderCircle, Square } from 'lucide-react';
import { stateName, type Run } from './api';
import './reply-panel.css';

export function ReplyPanel({
  providerName = 'Codex',
  state,
  model,
  shared = false,
  children,
}: {
  providerName?: string;
  state: Run['state'] | 'unknown';
  model?: string;
  shared?: boolean;
  children: ReactNode;
}) {
  const waiting = state === 'waiting_approval' || state === 'waiting_input';
  const spinning = state === 'starting' || state === 'running' || state === 'cancelling';
  const Icon = spinning
    ? LoaderCircle
    : waiting || state === 'unknown'
      ? CircleHelp
      : state === 'completed'
        ? CheckCircle2
        : state === 'failed' || state === 'interrupted' || state === 'uncertain'
          ? CircleAlert
          : state === 'queued'
            ? Clock3
            : Square;
  const label =
    state === 'unknown'
      ? '运行状态待确认'
      : shared && state === 'running'
        ? '另一端正在执行'
        : stateName[state];
  const hint =
    state === 'waiting_approval'
      ? '等待你确认操作后继续'
      : state === 'waiting_input'
        ? '等待你回答后继续'
        : state === 'queued'
          ? '已排队，等待前面的任务结束'
          : state === 'uncertain'
            ? '执行结果尚未确认，请检查记录和文件'
            : state === 'cancelling'
              ? '正在停止，等待执行端确认'
              : state === 'interrupted'
                ? '执行已中断，请检查已有输出'
                : state === 'unknown'
                  ? '暂时无法确认另一端的运行状态，记录会自动刷新'
                  : null;
  return (
    <section
      className={`reply-panel reply-${state}`}
      data-state={state}
      aria-label={`${providerName} 回复：${label}`}
    >
      <div className="run-label">
        <span className="codex-mark">✳</span>
        <strong>{providerName}</strong>
        <span className="reply-model">{shared ? '共享记录' : model}</span>
        <span className={`run-status ${state}`} role="status" aria-live="polite" aria-atomic="true">
          <Icon size={15} className={spinning ? 'spin' : undefined} />
          {label}
        </span>
      </div>
      {hint && <p className="reply-state-hint">{hint}</p>}
      {children}
    </section>
  );
}
