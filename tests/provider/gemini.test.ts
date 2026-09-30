import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiAdapter } from '../../packages/provider-gemini/src/index.ts';
import { geminiExecutable } from '../helpers/gemini-process.ts';
import { until } from '../helpers/mock-provider.ts';
import type { ProviderEvent } from '../../packages/provider-core/src/index.ts';
async function fixture(authorized = true) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-gemini-test-'));
  const home = join(directory, 'home');
  await mkdir(home);
  const executable = await geminiExecutable(directory);
  if (authorized) await writeFile(join(home, 'fixture-auth'), 'authorized');
  const options = { cwd: directory, home, executable };
  const adapter = new GeminiAdapter(options);
  const events: ProviderEvent[] = [];
  adapter.subscribeEvents((e) => events.push(e));
  const input = { cwd: directory, model: 'gemini-3.1-pro-high', permissionMode: 'workspace-write' as const };
  return {
    directory,
    home,
    options,
    adapter,
    events,
    input,
    lines: async (name: string) =>
      (await readFile(join(home, name), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    close: async () => {
      await adapter.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test('Gemini discovers only Gemini models without a paid prompt and strips host credentials', async () => {
  const keys = ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'ANTIGRAVITY_LS_ADDRESS'];
  const previous = keys.map((k) => process.env[k]);
  keys.forEach((k) => (process.env[k] = 'host-secret'));
  const f = await fixture();
  try {
    assert.equal((await f.adapter.getAccount()).authMode, 'google-antigravity');
    const models = await f.adapter.listModels();
    assert.equal(models.length, 3);
    assert.ok(models.every((m) => !m.supportsImages && m.displayName.includes('测试')));
    assert.deepEqual(await f.lines('launches.jsonl'), [['models']]);
    assert.deepEqual(models[0].reasoningEfforts, ['low', 'high']);
    const quota = await f.adapter.getQuota();
    assert.deepEqual(
      quota?.windows.map((w) => w.usedPercent),
      [25, 50],
    );
    assert.equal(quota?.stale, false);
    assert.ok(quota?.windows.every((w) => w.scope === 'Gemini'));
    assert.equal(f.adapter.capabilities().approvals, false);
  } finally {
    await f.close();
    keys.forEach((k, i) => {
      if (previous[i] === undefined) delete process.env[k];
      else process.env[k] = previous[i];
    });
  }
});
test('Gemini browser code login uses private PTY, cancels stale codes, and persists official login', async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.adapter.getAccount()).authenticated, false);
    const [a, b] = await Promise.all([f.adapter.beginLogin(), f.adapter.beginLogin()]);
    assert.deepEqual(a, b);
    assert.equal(new URL(a.verificationUrl).hostname, 'accounts.google.com');
    await assert.rejects(f.adapter.completeLogin('TEST-CODE', 'stale'));
    await f.adapter.cancelLogin();
    await assert.rejects(f.adapter.completeLogin('TEST-CODE', a.loginId));
    const c = await f.adapter.beginLogin();
    await f.adapter.completeLogin('TEST-CODE', c.loginId);
    await until(
      () => f.events.some((e) => e.type === 'account.updated' && e.payload.success === true),
      10_000,
    );
    assert.equal((await f.adapter.getAccount()).authenticated, true);
    const other = new GeminiAdapter(f.options);
    try {
      assert.equal((await other.getAccount()).authenticated, true);
    } finally {
      await other.close();
    }
  } finally {
    await f.close();
  }
});
for (const mode of ['read-only', 'workspace-write', 'full-access'] as const)
  test('Gemini streams once and resumes native conversation in ' + mode, async () => {
    const f = await fixture();
    try {
      const session = await f.adapter.createSession(f.input);
      await f.adapter.startRun({ ...f.input, permissionMode: mode, sessionId: session.id, text: 'hello' });
      await until(() => f.events.some((e) => e.type === 'run.completed'));
      assert.equal(
        f.events
          .filter((e) => e.type === 'message.delta')
          .map((e) => e.payload.delta)
          .join(''),
        'Gemini hello',
      );
      assert.equal(f.events.find((e) => e.type === 'tool.completed')?.payload.text, 'tests passed');
      const args = (await f.lines('launches.jsonl'))[0];
      assert.equal(args[args.indexOf('--mode') + 1], mode === 'read-only' ? 'plan' : 'accept-edits');
      assert.equal(args.includes('--dangerously-skip-permissions'), mode === 'full-access');
      const mapping = JSON.parse(
        await readFile(join(f.home, 'relay-sessions', session.id + '.json'), 'utf8'),
      );
      const next = new GeminiAdapter(f.options);
      const events: ProviderEvent[] = [];
      next.subscribeEvents((e) => events.push(e));
      try {
        await next.resumeSession(session);
        await next.startRun({ ...f.input, sessionId: session.id, text: 'second' });
        await until(() => events.some((e) => e.type === 'run.completed'));
        const resume = (await f.lines('launches.jsonl')).at(-1);
        assert.equal(resume[resume.indexOf('--conversation') + 1], mapping.nativeId);
      } finally {
        await next.close();
      }
    } finally {
      await f.close();
    }
  });
for (const text of ['denied', 'error', 'crash', 'malformed', 'wait'])
  test('Gemini handles ' + text + ' without replay or raw diagnostic disclosure', async () => {
    const f = await fixture();
    try {
      const session = await f.adapter.createSession(f.input);
      const ref = await f.adapter.startRun({ ...f.input, sessionId: session.id, text });
      if (text === 'wait') {
        await until(() => f.events.some((e) => e.type === 'run.started'));
        await f.adapter.interruptRun(ref);
      }
      await until(() => f.events.some((e) => e.type === 'run.completed' || e.type === 'run.failed'));
      const terminals = f.events.filter((e) => e.type === 'run.completed' || e.type === 'run.failed');
      assert.equal(terminals.length, 1);
      assert.equal(
        terminals[0].payload.state,
        text === 'wait' ? 'cancelled' : ['crash', 'malformed'].includes(text) ? 'uncertain' : 'failed',
      );
      assert.doesNotMatch(JSON.stringify(f.events), /private token/);
      if (text === 'denied') {
        const blocked = f.events.find((e) => e.type === 'tool.completed' && e.payload.name === 'run_command');
        assert.equal(blocked?.payload.status, 'failed');
        assert.match(String(blocked?.payload.text), /审批/);
        assert.match(String(terminals[0].payload.error), /受限工具卡片/);
      }
    } finally {
      await f.close();
    }
  });
test('Gemini rejects images and missing native sessions instead of silently starting over', async () => {
  const f = await fixture();
  try {
    const session = await f.adapter.createSession(f.input);
    await assert.rejects(
      f.adapter.startRun({
        ...f.input,
        sessionId: session.id,
        text: 'image',
        images: [{ url: 'data:image/png;base64,aA==' }],
      }),
      /图片/,
    );
    await assert.rejects(f.adapter.resumeSession(session), /新建会话/);
  } finally {
    await f.close();
  }
});

test('Gemini identifies missing CLI before starting the login PTY', async () => {
  const f = await fixture(false);
  const adapter = new GeminiAdapter({ ...f.options, executable: join(f.directory, 'missing-agy') });
  try {
    await assert.rejects(adapter.beginLogin(), /未找到可执行的 Antigravity CLI/);
  } finally {
    await adapter.close();
    await f.close();
  }
});

test('Gemini effort selects the matching model slug and records effective settings', async () => {
  const f = await fixture();
  try {
    const session = await f.adapter.createSession(f.input);
    await f.adapter.startRun({ ...f.input, sessionId: session.id, text: 'hello', reasoningEffort: 'low' });
    await until(() => f.events.some((e) => e.type === 'run.completed'));
    const args = (await f.lines('launches.jsonl')).find((a: string[]) => a.includes('--model'));
    assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.1-pro-low');
    assert.equal(args[args.indexOf('--effort') + 1], 'low');
    assert.equal(f.events.find((e) => e.type === 'run.settings')?.payload.model, 'gemini-3.1-pro-low');
    await assert.rejects(
      f.adapter.startRun({ ...f.input, sessionId: session.id, text: 'hello', reasoningEffort: 'medium' }),
      /不支持/,
    );
  } finally {
    await f.close();
  }
});
