import type { Message } from './api';
import { questionSignature } from '../../../packages/provider-core/src/questions.ts';

/** Suppress old history-recovery copies, retaining genuine repeated live messages. */
export function deduplicateRecoveredQuestions(messages: Message[]): Message[] {
  const key = (m: Message) => {
    const signature = m.kind === 'assistant' ? questionSignature(m.text, m.payload.questions) : undefined;
    return signature ? JSON.stringify([m.runId, signature]) : undefined;
  };
  const live = new Set(
    messages
      .filter((m) => m.payload.itemId)
      .map(key)
      .filter(Boolean),
  );
  const recovered = new Set<string>();
  return messages.filter((m) => {
    const signature = key(m);
    if (!signature || m.payload.itemId) return true;
    if (live.has(signature) || recovered.has(signature)) return false;
    recovered.add(signature);
    return true;
  });
}
