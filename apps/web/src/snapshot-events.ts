import type { Snapshot, WorkbenchEvent } from './api';

export function mergeEvent(snapshot: Snapshot, event: WorkbenchEvent): Snapshot {
  if (event.agentId !== snapshot.identity.agentId || event.seq <= snapshot.seq) return snapshot;
  const next = { ...snapshot, seq: event.seq },
    p = event.payload as any;
  const upsert = (list: any[], value: any) => {
    const i = list.findIndex((x) => x.id === value.id);
    return i < 0 ? [...list, value] : list.map((x, j) => (i === j ? value : x));
  };
  if (p.workspace) next.workspaces = upsert(next.workspaces, p.workspace);
  if (p.conversation) next.conversations = upsert(next.conversations, p.conversation);
  if (p.run) next.runs = upsert(next.runs, p.run);
  // provider.warning also uses `message`, but contains a notice string rather
  // than a chat record. Never insert that string into the message collection.
  if (p.message && typeof p.message === 'object' && !Array.isArray(p.message))
    next.messages = upsert(next.messages, { ...p.message, eventSeq: event.seq });
  if (p.messageDelta) {
    const d = p.messageDelta,
      old = next.messages.find((m) => m.id === d.id);
    next.messages = upsert(next.messages, {
      ...old,
      ...d,
      text: (old?.text ?? '') + String(d.delta ?? ''),
      payload: { ...old?.payload, ...d.payload },
      eventSeq: event.seq,
      ...(!old || old.pendingDeltas
        ? { pendingDeltas: [...(old?.pendingDeltas ?? []), { seq: event.seq, text: String(d.delta ?? '') }] }
        : {}),
    });
  }
  if (p.interaction)
    next.interactions = upsert(next.interactions, p.interaction).filter((i) => i.status === 'pending');
  return next;
}
