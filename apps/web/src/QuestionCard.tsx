import { useRef, useState } from 'react';
import { CircleHelp, CheckCircle2 } from 'lucide-react';
import { requestId, save, saved } from './api';
import type { AsyncQuestion } from '../../../packages/provider-core/src/index.ts';
import './question-card.css';

export function QuestionCard({
  questions,
  storageKey,
  disabled,
  onReply,
}: {
  questions: AsyncQuestion[];
  storageKey: string;
  disabled: boolean;
  onReply: (text: string, id: string) => Promise<{ delivery: string }>;
}) {
  const [answers, setAnswers] = useState<string[]>(() => saved(storageKey + ':answers', []));
  const [sent, setSent] = useState(() => saved(storageKey + ':sent', ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ text: string; id: string } | null>(saved(storageKey + ':request', null));
  const choose = (index: number, value: string) => {
    const next = [...answers];
    next[index] = value;
    setAnswers(next);
    save(storageKey + ':answers', next);
  };
  async function submit() {
    if (busy || disabled || questions.some((_, i) => !answers[i]?.trim())) return;
    const text =
      '回答你提出的问题：\n\n' +
      questions.map((q, i) => `问题：${q.title}\n回答：${answers[i].trim()}`).join('\n\n');
    if (request.current?.text !== text) request.current = { text, id: requestId() };
    save(storageKey + ':request', request.current);
    setBusy(true);
    setError('');
    try {
      const result = await onReply(text, request.current.id);
      const label = result.delivery === 'steered' ? '回答已发送到当前任务' : '回答已作为新消息提交';
      setSent(label);
      save(storageKey + ':sent', label);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="question-card" aria-label="回答 Codex 的问题">
      <div className="question-card-heading">
        <CircleHelp size={18} />
        <strong>需要你的回答</strong>
      </div>
      {questions.map((question, index) => (
        <fieldset key={index} disabled={disabled || busy || !!sent}>
          <legend>{question.title}</legend>
          <div className="question-options">
            {question.options?.map((option, i) => (
              <button
                key={i}
                type="button"
                aria-pressed={answers[index] === option}
                className={answers[index] === option ? 'selected' : ''}
                onClick={() => choose(index, option)}
              >
                {option}
              </button>
            ))}
          </div>
          <textarea
            aria-label={`自定义回答：${question.title}`}
            placeholder="选择上面的选项，或输入自己的回答"
            value={answers[index] ?? ''}
            onChange={(event) => choose(index, event.target.value)}
            rows={2}
          />
        </fieldset>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {sent ? (
        <p className="question-sent" role="status">
          <CheckCircle2 size={16} />
          {sent}
        </p>
      ) : (
        <button
          className="primary"
          disabled={disabled || busy || questions.some((_, i) => !answers[i]?.trim())}
          onClick={() => void submit()}
        >
          {busy ? '正在提交…' : '提交回答'}
        </button>
      )}
    </div>
  );
}
