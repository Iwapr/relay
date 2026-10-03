import type { NativeSessionSummary } from '../../../packages/provider-core/src/index.ts';
import type { Conversation, Snapshot, Workspace } from './api';
import { conversationTitle } from './session-tasks';

export interface SessionHistoryEntry extends NativeSessionSummary {
  conversation?: Conversation;
  workspace?: Workspace;
}

export function sessionHistory(
  native: NativeSessionSummary[],
  snapshot: Snapshot | null,
  provider: 'codex' | 'kimi' | 'claude' | 'antigravity' | 'deepseek' | 'factory',
  workspaceId?: string,
): SessionHistoryEntry[] {
  const rows = new Map<string, SessionHistoryEntry>(native.map((session) => [session.id, session]));
  for (const conversation of snapshot?.conversations ?? []) {
    if (conversation.providerId !== provider || (workspaceId && conversation.workspaceId !== workspaceId))
      continue;
    const workspace = snapshot?.workspaces.find((item) => item.id === conversation.workspaceId);
    if (!workspace) continue;
    const id = conversation.providerSessionId || `relay:${conversation.id}`;
    const original = rows.get(id);
    const runs = snapshot!.runs.filter((run) => run.conversationId === conversation.id);
    const updatedAt = runs.reduce(
      (latest, run) => (run.updatedAt > latest ? run.updatedAt : latest),
      conversation.createdAt,
    );
    rows.set(id, {
      ...original,
      id,
      title:
        conversation.titleCustomized || !original?.title
          ? conversationTitle(conversation, runs)
          : original.title,
      cwd: workspace.canonicalRoot,
      updatedAt: original && original.updatedAt > updatedAt ? original.updatedAt : updatedAt,
      conversation,
      workspace,
    });
  }
  return [...rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
