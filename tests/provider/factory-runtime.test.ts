import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runFactory, factoryError } from '../../packages/provider-factory/src/runtime.ts';
import { writeFactoryKey, readFactoryKey } from '../../packages/provider-factory/src/credentials.ts';
import type * as sdk from '@factory/droid-sdk/node';
type Driver = Pick<typeof sdk, 'createSession' | 'resumeSession' | 'listModels'>;

test('Factory maps permission modes, offered outcomes, indexed questions and images; closes and resumes the original session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ['read-only', 'workspace-write', 'full-access'] as const) {
    const sessionFile = join(root, mode + '.json');
    await writeFile(sessionFile, JSON.stringify({ cwd: root }));
    const questions: any[] = [],
      outcomes: string[] = [];
    let closed = 0,
      handler: any,
      wrongCwd = false;
    const id = randomUUID();
    const session = {
      id,
      get cwd() {
        return wrongCwd ? '/wrong' : root;
      },
      settings: { modelId: 'opus' },
      updateSettings: async () => {},
      close: async () => {
        closed++;
      },
      async *stream(_text: string, options: any) {
        assert.deepEqual(options.images, [{ type: 'base64', mediaType: 'image/png', data: 'YQ==' }]);
        for (const allowed of [true, false])
          outcomes.push(
            await handler.permissionHandler({
              toolUses: [{ toolUse: { name: 'Execute', input: {} }, details: { type: 'exec' } }],
              options: [{ value: 'cancel' }, ...(allowed ? [{ value: 'proceed_once' }] : [])],
            }),
          );
        const answers = await handler.askUserHandler({
          toolCallId: 'tool',
          questions: [
            { index: 7, topic: 'colors', question: 'Colors?', options: ['red', 'blue'], multiSelect: true },
          ],
        });
        assert.deepEqual(answers, { answers: [{ index: 7, question: 'Colors?', answer: 'red, blue' }] });
        yield { type: 'tool_call', toolUseId: 'tool', name: 'Read', input: { file: 'test.txt' } };
        yield { type: 'tool_progress', toolUseId: 'tool', content: 'working' };
        yield { type: 'tool_result', toolUseId: 'tool', content: 'done', isError: false };
        yield {
          type: 'result',
          success: true,
          tokenUsage: { inputTokens: 10, outputTokens: 5, factoryCredits: 1.25 },
        };
      },
    };
    const driver = {
      createSession: async (options: any) => {
        handler = options;
        assert.equal(options.interactionMode, mode === 'read-only' ? 'spec' : 'auto');
        assert.equal(options.autonomyLevel, mode === 'full-access' ? 'high' : 'off');
        return session;
      },
      resumeSession: async (nativeId: string, options: any) => {
        assert.equal(nativeId, id);
        handler = options;
        return session;
      },
    } as unknown as Driver;
    const request = {
      operation: 'run' as const,
      apiKey: 'key',
      executable: '/fixture',
      cwd: root,
      sessionFile,
      model: 'opus',
      permissionMode: mode,
      text: 'hello',
      images: [{ url: 'data:image/png;base64,YQ==' }],
    };
    const events: string[] = [];
    const bridge = {
      signal: new AbortController().signal,
      emit: (type: string) => {
        events.push(type);
      },
      ask: async (requestId: string, payload: any) => {
        questions.push(payload);
        return {
          requestId,
          generation: '',
          ...(payload.kind === 'approval'
            ? { decision: 'accept' as const }
            : { answers: { '7': ['red', 'blue'] } }),
        };
      },
    };
    assert.deepEqual(await runFactory(request, bridge, driver), { state: 'completed' });
    assert.deepEqual(outcomes, ['proceed_once', 'cancel']);
    assert.equal(closed, 1);
    assert.ok(events.includes('usage.updated'));
    assert.equal(JSON.parse(await readFile(sessionFile, 'utf8')).nativeId, id);
    assert.deepEqual(
      events.filter((e) => e.startsWith('tool.')),
      ['tool.started', 'tool.output', 'tool.completed'],
    );
    assert.equal(questions.filter((q) => q.kind === 'approval').length, mode === 'full-access' ? 1 : 2);
    assert.equal(questions.at(-1).questions[0].multiSelect, true);
    await runFactory(request, bridge, driver);
    assert.equal(closed, 2);
    wrongCwd = true;
    await assert.rejects(runFactory(request, bridge, driver), /workspace mismatch/);
    assert.equal(closed, 3);
    wrongCwd = false;
    (session.settings as any).availableAutonomyLevels = mode === 'full-access' ? ['off'] : ['high'];
    await assert.rejects(runFactory(request, bridge, driver), /permission policy/);
    assert.equal(closed, 4);
  }
});

test('Factory keys save without Public API access, reject malformed input and never disclose secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-keys-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Public API gateway returns 403');
  });
  await writeFactoryKey(root, 'original-key');
  for (const malformed of ['private key', 'private\nkey', 'private\x00key', 'x'.repeat(4097)]) {
    await assert.rejects(writeFactoryKey(root, malformed), (e) => !String(e).includes(malformed));
    assert.equal(await readFactoryKey(root), 'original-key');
  }
  await writeFactoryKey(root, '  new-key  ');
  assert.equal(await readFactoryKey(root), 'new-key');
  await writeFactoryKey(root, '');
  assert.equal(await readFactoryKey(root), null);
  assert.equal(fetch.mock.callCount(), 0);
  for (const value of [new Error('private-key'), { message: 'private-key' }, undefined])
    assert.ok(!factoryError(value).includes('private-key'));
  assert.match(factoryError(new Error('HTTP 403 Forbidden')), /不能单独证明/);
});
