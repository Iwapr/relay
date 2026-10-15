import test from 'node:test';
import assert from 'node:assert/strict';
import { LoadSessionResponseSchema } from '@factory/droid-sdk/node';
import { compatibleFactoryMessage } from '../../packages/provider-factory/src/transport.ts';

function response(apiProvider: unknown) {
  return {
    jsonrpc: '2.0',
    type: 'response',
    id: 'load',
    factoryApiVersion: '1.0.0',
    factoryProtocolVersion: '1.245.0',
    result: {
      cwd: '/project',
      settings: { modelId: 'opus', reasoningEffort: 'max', interactionMode: 'auto', autonomyLevel: 'high' },
      session: {
        messages: [
          {
            id: 'assistant',
            role: 'assistant',
            createdAt: 1,
            updatedAt: 1,
            modelId: 'claude-opus-5-5',
            apiProvider,
            content: [{ type: 'text', text: 'Keep this history' }],
          },
        ],
      },
    },
  };
}

test('Factory accepts newer CLI route metadata without discarding history or changing model', () => {
  const original = response('azure_anthropic');
  assert.equal(LoadSessionResponseSchema.safeParse(original).success, false);
  const normalized = JSON.parse(compatibleFactoryMessage(JSON.stringify(original)));
  assert.equal(LoadSessionResponseSchema.safeParse(normalized).success, true);
  const expected = structuredClone(original);
  delete (expected.result.session.messages[0] as any).apiProvider;
  assert.deepEqual(normalized, expected);
  assert.equal(original.result.session.messages[0].apiProvider, 'azure_anthropic');
});

test('Factory preserves known routes, rejects malformed metadata, and leaves outbound requests untouched', () => {
  for (const route of ['anthropic', 'fireworks', 'openai', 123, null]) {
    const raw = JSON.stringify(response(route));
    assert.equal(compatibleFactoryMessage(raw), raw);
    if (typeof route !== 'string')
      assert.equal(LoadSessionResponseSchema.safeParse(JSON.parse(raw)).success, false);
  }
  const request = JSON.stringify({ ...response('azure_anthropic'), type: 'request' });
  assert.equal(compatibleFactoryMessage(request), request);
  assert.equal(compatibleFactoryMessage('invalid-json'), 'invalid-json');
  assert.equal(compatibleFactoryMessage('null'), 'null');
});

test('Factory handles new-message route metadata but preserves tool content verbatim', () => {
  const message = response('azure_anthropic').result.session.messages[0];
  const notification = {
    type: 'notification',
    method: 'droid.session_notification',
    params: {
      notification: { type: 'create_message', message },
    },
  };
  const result = JSON.parse(compatibleFactoryMessage(JSON.stringify(notification)));
  assert.equal(result.params.notification.message.apiProvider, undefined);
  assert.deepEqual(result.params.notification.message.content, message.content);
  const tool = JSON.stringify({
    type: 'notification',
    method: 'droid.session_notification',
    params: {
      notification: { type: 'tool_result', content: { apiProvider: 'azure_anthropic' } },
    },
  });
  assert.equal(compatibleFactoryMessage(tool), tool);
});
