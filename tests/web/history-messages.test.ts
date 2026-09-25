import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistoryMessages } from '../../apps/web/src/history-messages.ts';
import type { Message } from '../../apps/web/src/api.ts';
const message = (text: string, eventSeq: number): Message => ({
  id: 'm',
  runId: 'r',
  workspaceId: 'w',
  conversationId: 'c',
  kind: 'assistant',
  createdAt: '2026-09-21T00:00:00Z',
  payload: {},
  text,
  eventSeq,
});
test('history hydrates streamed messages without losing their prefix or duplicating replayed deltas', () => {
  const live = {
    ...message(' world!', 12),
    pendingDeltas: [
      { seq: 10, text: ' world' },
      { seq: 12, text: '!' },
    ],
  };
  assert.equal(mergeHistoryMessages([message('Hello world', 11)], [live])[0].text, 'Hello world!');
  assert.equal(mergeHistoryMessages([message('Hello', 9)], [live])[0].text, 'Hello world!');
  assert.equal(mergeHistoryMessages([message('Hello world!', 13)], [live])[0].text, 'Hello world!');
});
test('late history cannot replace newer completed content and stale live state cannot replace history', () => {
  assert.equal(mergeHistoryMessages([message('old', 9)], [message('complete', 12)])[0].text, 'complete');
  assert.equal(mergeHistoryMessages([message('complete', 13)], [message('old', 12)])[0].text, 'complete');
});
