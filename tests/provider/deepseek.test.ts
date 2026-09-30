import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeepSeekAdapter } from '../../packages/provider-deepseek/src/index.ts';
import { writeKey } from '../../packages/provider-deepseek/src/credentials.ts';
import { deepseekExecutable, deepseekApiResponse } from '../helpers/deepseek-process.ts';
import { until } from '../helpers/mock-provider.ts';
import type { ProviderEvent } from '../../packages/provider-core/src/index.ts';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'relay-deepseek-'));
  const home = join(directory, 'home');
  await mkdir(home);
  await writeFile(join(home, 'relay-credential.json'), JSON.stringify({ apiKey: 'test-deepseek-one' }), {
    mode: 0o600,
  });
  const options = { cwd: directory, home, executable: await deepseekExecutable(directory) };
  const adapter = new DeepSeekAdapter(options),
    events: ProviderEvent[] = [];
  adapter.subscribeEvents((e) => events.push(e));
  const input = { cwd: directory, model: 'deepseek-flash', permissionMode: 'full-access' as const };
  return {
    directory,
    home,
    options,
    adapter,
    events,
    input,
    close: async () => {
      await adapter.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test('DeepSeek validates keys without replacing a good credential on failure; discovers official models and balance', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) =>
    deepseekApiResponse(url, (init.headers as Record<string, string>).Authorization),
  );
  const f = await fixture();
  try {
    await assert.rejects(writeKey(f.home, 'invalid-secret'), /无效/);
    assert.equal(
      JSON.parse(await readFile(join(f.home, 'relay-credential.json'), 'utf8')).apiKey,
      'test-deepseek-one',
    );
    await writeKey(f.home, 'test-deepseek-two');
    assert.equal((await stat(join(f.home, 'relay-credential.json'))).mode & 0o777, 0o600);
    assert.equal((await f.adapter.getAccount()).authMode, 'deepseek-api-key');
    assert.equal((await f.adapter.listModels()).length, 2);
    assert.equal((await f.adapter.getQuota())?.stale, false);
    await writeKey(f.home, '');
    assert.equal((await f.adapter.getAccount()).authenticated, false);
  } finally {
    await f.close();
  }
});
test('DeepSeek consumes session-scoped ACP events, excludes child text, persists session identity across restart', async () => {
  const f = await fixture();
  try {
    const session = await f.adapter.createSession(f.input);
    await f.adapter.startRun({ ...f.input, sessionId: session.id, text: 'hello' });
    await until(() => f.events.some((e) => e.type === 'run.completed'));
    assert.equal(
      f.events
        .filter((e) => e.type === 'message.delta')
        .map((e) => e.payload.delta)
        .join(''),
      'DeepSeek hello',
    );
    assert.equal(f.events.filter((e) => e.type === 'tool.completed').length, 1);
    await f.adapter.close();
    const next = new DeepSeekAdapter(f.options);
    try {
      await next.resumeSession(session, f.input);
      const events: ProviderEvent[] = [];
      next.subscribeEvents((e) => events.push(e));
      await next.startRun({ ...f.input, sessionId: session.id, text: 'again' });
      await until(() => events.some((e) => e.type === 'run.completed'));
    } finally {
      await next.close();
    }
    const sessions = (await readFile(join(f.home, 'fixture-sessions'), 'utf8')).trim().split('\n');
    const mapped = JSON.parse(
      await readFile(join(f.home, 'relay-sessions', session.id + '.json'), 'utf8'),
    ).nativeId;
    assert.deepEqual(sessions, [mapped, mapped]);
    await assert.rejects(
      new DeepSeekAdapter({ ...f.options, cwd: '/tmp' }).resumeSession(session, { ...f.input, cwd: '/tmp' }),
      /不属于/,
    );
  } finally {
    await f.close();
  }
});
test('DeepSeek rejects misleading permission modes and cancels by terminating its owned runtime', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.adapter.createSession({ ...f.input, permissionMode: 'read-only' }),
      /仅支持完全访问/,
    );
    const s = await f.adapter.createSession(f.input);
    const ref = await f.adapter.startRun({ ...f.input, sessionId: s.id, text: 'wait' });
    await new Promise((r) => setTimeout(r, 100));
    await f.adapter.interruptRun(ref);
    assert.equal(f.events.at(-1)?.payload.state, 'cancelled');
    assert.equal(f.events.filter((e) => e.type === 'run.completed').length, 1);
  } finally {
    await f.close();
  }
});
for (const text of ['error', 'crash'])
  test('DeepSeek reports ' + text + ' once without exposing raw diagnostic secrets', async () => {
    const f = await fixture();
    try {
      const s = await f.adapter.createSession(f.input);
      await f.adapter.startRun({ ...f.input, sessionId: s.id, text });
      await until(() => f.events.some((e) => e.type === 'run.failed'));
      assert.equal(f.events.filter((e) => e.type === 'run.failed').length, 1);
      assert.ok(!JSON.stringify(f.events).includes('secret-must-not-leak'));
    } finally {
      await f.close();
    }
  });
