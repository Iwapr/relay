import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTitle, sessionTasks } from '../../apps/web/src/session-tasks.ts';
import type { Snapshot, Run } from '../../apps/web/src/api.ts';
const conversation = (id: string) => ({
  id,
  workspaceId: 'w',
  title: '新对话',
  providerId: 'codex',
  providerSessionId: null,
  createdAt: '2026-01-01T00:00:00Z',
});
const run = (id: string, conversationId: string, state: Run['state'], date: string): Run => ({
  id,
  conversationId,
  workspaceId: 'w',
  state,
  text: id,
  model: 'm',
  reasoningEffort: null,
  permissionMode: 'read-only',
  providerTurnId: null,
  error: null,
  createdAt: date,
  updatedAt: date,
});
const snapshot = (runs: Run[]) =>
  ({
    conversations: [conversation('one'), conversation('two'), conversation('empty')],
    runs,
    interactions: [],
    workspaces: [],
    messages: [],
  }) as unknown as Snapshot;

test('task center groups rounds into sessions and retains empty sessions', () => {
  const result = sessionTasks(
    snapshot([
      run('first', 'one', 'completed', '2026-01-02'),
      run('second', 'one', 'completed', '2026-01-03'),
    ]),
  );
  assert.equal(result.length, 3);
  assert.equal(result[0].conversation.id, 'one');
  assert.equal(result[0].title, 'first');
  assert.equal(result[0].latest?.id, 'second');
  assert.equal(result.find((s) => s.conversation.id === 'empty')?.statusRun, undefined);
});

test('pending approval is visible over queued rounds, and active sessions sort before completed sessions', () => {
  const data = snapshot([
    run('waiting', 'one', 'waiting_approval', '2026-01-02'),
    run('queued', 'one', 'queued', '2026-01-03'),
    run('done', 'two', 'completed', '2026-01-04'),
  ]);
  data.interactions = [
    {
      id: 'approval',
      workspaceId: 'w',
      conversationId: 'one',
      runId: 'waiting',
      generation: 'g',
      providerRequestId: 'request',
      kind: 'approval',
      status: 'pending',
      payload: {},
      createdAt: '2026-01-02',
    },
  ];
  const result = sessionTasks(data);
  assert.equal(result[0].conversation.id, 'one');
  assert.equal(result[0].statusRun?.id, 'waiting');
  assert.equal(result[0].pending.length, 1);
  assert.equal(result[1].statusRun?.state, 'completed');
  assert.equal(sessionTasks(null).length, 0);
});

test('conversation titles use the earliest matching message and preserve custom titles', () => {
  const data = snapshot([
    run('unrelated', 'two', 'completed', '2026-01-01'),
    run('later', 'one', 'completed', '2026-01-03'),
    run('first', 'one', 'completed', '2026-01-02'),
  ]);
  const item = data.conversations[0];
  assert.equal(conversationTitle(item, data.runs), 'first');
  assert.equal(conversationTitle({ ...item, titleCustomized: true }, data.runs), '新对话');
  assert.equal(conversationTitle({ ...item, title: '保留标题' }, data.runs), '保留标题');
  assert.equal(conversationTitle(item, []), '新对话');
});
