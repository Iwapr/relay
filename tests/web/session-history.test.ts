import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionHistory } from '../../apps/web/src/session-history.ts';
import type { Snapshot } from '../../apps/web/src/api.ts';

const snapshot = {
  workspaces: [
    { id: 'w', canonicalRoot: '/project' },
    { id: 'other', canonicalRoot: '/other' },
  ],
  conversations: [
    {
      id: 'local',
      workspaceId: 'w',
      providerId: 'codex',
      providerSessionId: null,
      title: '本地对话',
      createdAt: '2026-01-02',
    },
    {
      id: 'linked',
      workspaceId: 'w',
      providerId: 'codex',
      providerSessionId: 'thread',
      title: '自定义标题',
      titleCustomized: true,
      createdAt: '2026-01-01',
    },
    {
      id: 'elsewhere',
      workspaceId: 'other',
      providerId: 'codex',
      title: '其他项目',
      createdAt: '2026-01-01',
    },
    { id: 'kimi', workspaceId: 'w', providerId: 'kimi', title: 'Kimi 对话', createdAt: '2026-01-01' },
  ],
  runs: [],
} as unknown as Snapshot;

test('unified history includes local-only conversations and deduplicates linked native sessions with custom titles', () => {
  const rows = sessionHistory(
    [{ id: 'thread', title: '原生标题', cwd: '/project', updatedAt: '2026-01-03' }],
    snapshot,
    'codex',
    'w',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, '自定义标题');
  assert.equal(rows[0].conversation?.id, 'linked');
  assert.equal(rows[1].conversation?.id, 'local');
});

test('local history remains available without native results, scopes projects and isolates providers', () => {
  assert.equal(sessionHistory([], snapshot, 'codex').length, 3);
  assert.equal(sessionHistory([], snapshot, 'codex', 'w').length, 2);
  assert.deepEqual(
    sessionHistory([], snapshot, 'kimi', 'w').map((row) => row.conversation?.id),
    ['kimi'],
  );
});
