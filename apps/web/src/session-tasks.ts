import { isActive, type Snapshot, type Run, type Conversation } from './api';

/** Use the first submitted message for legacy conversations with a default title. */
export function conversationTitle(conversation: Conversation, runs: Run[]) {
  if (conversation.title !== '新对话' || conversation.titleCustomized) return conversation.title;
  const first = runs
    .filter((run) => run.conversationId === conversation.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return first?.text.slice(0, 80) || '新对话';
}

/** A session is one card; its currently active round takes precedence over queued/later rounds. */
export function sessionTasks(snapshot: Snapshot | null) {
  if (!snapshot) return [];
  const byConversation = new Map<string, Run[]>();
  for (const run of snapshot.runs) {
    const runs = byConversation.get(run.conversationId) ?? [];
    runs.push(run);
    byConversation.set(run.conversationId, runs);
  }
  return snapshot.conversations
    .map((conversation) => {
      const runs = (byConversation.get(conversation.id) ?? []).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      const latest = runs.at(-1);
      const pending = snapshot.interactions.filter(
        (i) => i.conversationId === conversation.id && i.status === 'pending',
      );
      const active = runs.filter((r) => isActive(r.state));
      const statusRun =
        active.find((r) => pending.some((i) => i.runId === r.id)) ??
        active.find((r) => r.state !== 'queued') ??
        active[0] ??
        latest;
      const updatedAt = runs.reduce(
        (time, run) => (run.updatedAt > time ? run.updatedAt : time),
        conversation.createdAt,
      );
      return {
        conversation,
        latest,
        statusRun,
        pending,
        active: active.length > 0,
        updatedAt,
        title: conversationTitle(conversation, runs),
        project: snapshot.workspaces.find((w) => w.id === conversation.workspaceId)?.canonicalRoot,
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt));
}
