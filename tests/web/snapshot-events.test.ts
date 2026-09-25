import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvent } from '../../apps/web/src/snapshot-events.ts';
import { mergeHistoryMessages } from '../../apps/web/src/history-messages.ts';
import type { Message, Snapshot, WorkbenchEvent } from '../../apps/web/src/api.ts';

const message: Message = {
  id: 'reply',
  runId: 'run',
  conversationId: 'conversation',
  workspaceId: 'workspace',
  kind: 'assistant',
  text: '正在回答',
  payload: {},
  createdAt: '2026-09-23T00:00:00Z',
};
const snapshot = (): Snapshot => ({
  identity: { agentId: 'agent' } as Snapshot['identity'],
  seq: 1,
  workspaces: [],
  conversations: [],
  runs: [],
  interactions: [],
  messages: [message],
});
const event = (seq: number, type: string, payload: WorkbenchEvent['payload']): WorkbenchEvent => ({
  agentId: 'agent',
  seq,
  version: 1,
  type,
  payload,
  createdAt: message.createdAt,
});

test('output truncation notices do not corrupt the timeline and streaming continues', () => {
  const original = snapshot();
  const warned = mergeEvent(
    original,
    event(2, 'provider.warning', {
      message: '单条输出或工具详情超过显示上限，已截断；完整输出请在远端检查',
      itemId: 'tool',
      truncated: true,
    }),
  );
  // The old merger inserted the warning string as an object without createdAt,
  // causing the chat timeline sort to throw during rendering.
  assert.doesNotThrow(() => mergeHistoryMessages([], warned.messages));
  assert.equal(warned.messages, original.messages);
  assert.equal(warned.seq, 2);
  const streamed = mergeEvent(
    warned,
    event(3, 'message.delta', {
      messageDelta: { ...message, delta: '，继续输出' },
    }),
  );
  assert.equal(streamed.messages[0].text, '正在回答，继续输出');
  const completed = mergeEvent(
    streamed,
    event(4, 'message.completed', {
      message: { ...message, text: '回答完成' },
    }),
  );
  assert.equal(mergeHistoryMessages([], completed.messages)[0].text, '回答完成');
  assert.equal(completed.messages.length, 1);
  assert.equal(original.messages[0].text, '正在回答');
});

test('tool records are still merged and stale or foreign events are ignored', () => {
  const original = snapshot();
  const update = event(2, 'tool.completed', {
    message: { ...message, id: 'tool', kind: 'tool', text: 'command output' },
  });
  const next = mergeEvent(original, update);
  assert.equal(next.messages.length, 2);
  assert.equal(next.messages[1].eventSeq, 2);
  assert.equal(mergeEvent(next, update), next);
  assert.equal(mergeEvent(original, { ...update, agentId: 'other' }), original);
});
