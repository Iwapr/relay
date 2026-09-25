import type { Message } from './api';

/** Reconcile the history snapshot with deltas that arrived while it was downloading. */
export function mergeHistoryMessages(history: Message[], live: Message[]): Message[] {
  const merged = new Map(history.map((m) => [m.id, m]));
  for (const message of live) {
    const prior = merged.get(message.id);
    if (!prior) {
      merged.set(message.id, message);
      continue;
    }
    if ((prior.eventSeq ?? 0) >= (message.eventSeq ?? 0)) continue;
    merged.set(
      message.id,
      message.pendingDeltas
        ? {
            ...message,
            text:
              prior.text +
              message.pendingDeltas
                .filter((delta) => delta.seq > (prior.eventSeq ?? 0))
                .map((delta) => delta.text)
                .join(''),
            pendingDeltas: undefined,
          }
        : message,
    );
  }
  return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
