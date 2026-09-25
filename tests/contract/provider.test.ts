import test from 'node:test';
import assert from 'node:assert/strict';
import type { AIProviderAdapter, ProviderEvent } from '../../packages/provider-core/src/index.ts';
import { MockProvider } from '../helpers/mock-provider.ts';

test('a second provider implements session, events, approval, input and cancellation contracts without Codex fields', async () => {
  const provider: AIProviderAdapter = new MockProvider('/fixture');
  const mock = provider as MockProvider;
  const events: ProviderEvent[] = [];
  const unsubscribe = provider.subscribeEvents((event) => events.push(event));
  const settings = { cwd: '/fixture', model: 'fixture-model', permissionMode: 'workspace-write' as const };
  assert.equal(provider.id, 'contract-mock');
  assert.equal(provider.capabilities().attachments, false);
  const session = await provider.createSession(settings);
  assert.equal((await provider.resumeSession(session, settings)).id, session.id);
  const run = await provider.startRun({
    ...settings,
    sessionId: session.id,
    text: 'Fixture request',
    reasoningEffort: 'medium',
  });
  mock.emit('message.delta', { itemId: 'reply', delta: 'Hello' });
  mock.emit('interaction.required', { requestId: 7, kind: 'approval', command: 'fixture' });
  await provider.answerInteraction({ requestId: 7, generation: provider.generation, decision: 'decline' });
  mock.emit('interaction.required', { requestId: 8, kind: 'input', questions: [{ id: 'color' }] });
  await provider.answerInteraction({
    requestId: 8,
    generation: provider.generation,
    answers: { color: ['blue'] },
  });
  await provider.interruptRun(run);
  assert.equal(events.at(-1)?.type, 'interaction.required'); // interrupt is not confirmation
  mock.complete('cancelled');
  assert.equal(events.at(-1)?.payload.state, 'cancelled');
  assert.ok(
    events.every(
      (event) =>
        event.generation === provider.generation &&
        event.sessionId === session.id &&
        event.turnId === run.turnId,
    ),
  );
  assert.equal(await provider.getQuota(), null);
  unsubscribe();
  mock.emit('message.delta', { delta: 'unobserved' });
  assert.equal(events.length, 5);
  await provider.close();
});
