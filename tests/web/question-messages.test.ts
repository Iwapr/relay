import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateRecoveredQuestions } from '../../apps/web/src/question-messages.ts';
import { questionBody } from '../../packages/provider-core/src/questions.ts';
import type { Message } from '../../apps/web/src/api.ts';

const questions = [{ title: '请运行 `tailscale ip -4`', options: null }];
const message = (id: string, live = false, text = questions[0].title): Message => ({
  id,
  runId: 'run',
  conversationId: 'conversation',
  workspaceId: 'workspace',
  kind: 'assistant',
  text,
  createdAt: '2026-09-21T00:00:00Z',
  payload: { questions, ...(live ? { itemId: id } : {}) },
});
test('historical aliases disappear even when sorted before their live question', () => {
  const live = message('call-real', true);
  const context = { ...message('commentary', true, '准备检查配置'), payload: { itemId: 'commentary' } };
  assert.deepEqual(deduplicateRecoveredQuestions([message('item-3'), context, message('item-12'), live]), [
    context,
    live,
  ]);
  assert.deepEqual(
    deduplicateRecoveredQuestions([message('item-3'), message('item-12')]).map((m) => m.id),
    ['item-3'],
  );
});
test('different rounds, live repetitions, contextual explanations and changed options stay visible', () => {
  const messages = [
    message('a', true),
    message('b', true),
    { ...message('c'), runId: 'another' },
    message('d', false, '背景说明\n' + questions[0].title),
    { ...message('e'), payload: { questions: [{ title: questions[0].title, options: ['A'] }] } },
  ];
  assert.deepEqual(deduplicateRecoveredQuestions(messages), messages);
});
test('only verbatim question bodies are hidden, preserving surrounding prose', () => {
  assert.equal(questionBody(questions[0].title, questions), '');
  assert.equal(questionBody('背景说明\n' + questions[0].title, questions), '背景说明\n' + questions[0].title);
  assert.equal(questionBody('普通正文'), '普通正文');
  assert.equal(
    questionBody('第一问\n\n第二问', [
      { title: '第一问', options: null },
      { title: '第二问', options: null },
    ]),
    '',
  );
});
