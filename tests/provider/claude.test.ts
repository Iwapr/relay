import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../packages/provider-claude/src/index.ts';
import { claudeExecutable } from '../helpers/claude-process.ts';
import { until } from '../helpers/mock-provider.ts';
import type { ProviderEvent } from '../../packages/provider-core/src/index.ts';

async function fixture(authorized = true) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-claude-test-'));
  const home = join(directory, 'home');
  await mkdir(join(home, '.claude'), { recursive: true });
  const executable = await claudeExecutable(directory);
  if (authorized) await writeFile(join(home, '.claude', 'fixture-auth'), 'authorized');
  const adapter = new ClaudeAdapter({ cwd: directory, home, executable });
  const events: ProviderEvent[] = [];
  adapter.subscribeEvents((e) => events.push(e));
  const options = { cwd: directory, model: 'default', permissionMode: 'workspace-write' as const };
  const lines = async (file: string) =>
    (await readFile(join(home, '.claude', file), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  return {
    directory,
    home,
    executable,
    adapter,
    events,
    options,
    lines,
    close: async () => {
      await adapter.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Claude OAuth uses the official isolated CLI and rejects stale codes and cancelled flows', async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.adapter.getAccount()).authenticated, false);
    assert.deepEqual(await f.adapter.listModels(), []);
    const [a, b] = await Promise.all([f.adapter.beginLogin(), f.adapter.beginLogin()]);
    assert.deepEqual(a, b);
    assert.equal(a.codeRequired, true);
    assert.equal(new URL(a.verificationUrl).hostname, 'claude.com');
    await assert.rejects(f.adapter.completeLogin('TEST-CODE', 'stale'));
    await f.adapter.cancelLogin();
    await assert.rejects(f.adapter.completeLogin('TEST-CODE', a.loginId));
    assert.equal((await f.adapter.getAccount()).authenticated, false);
    const c = await f.adapter.beginLogin();
    await f.adapter.completeLogin('TEST-CODE', c.loginId);
    await until(() => f.events.some((e) => e.type === 'account.updated' && e.payload.success === true));
    assert.equal((await f.adapter.getAccount()).authMode, 'claude-code');
    assert.equal((await f.adapter.getAccount()).planType, 'max');
  } finally {
    await f.close();
  }
});

test('Claude streams once, handles tools and images, and lists models without submitting a prompt', async () => {
  const f = await fixture();
  try {
    const models = await f.adapter.listModels();
    assert.deepEqual(
      models.map((m) => m.id),
      ['default', 'sonnet'],
    );
    assert.deepEqual(models[0].reasoningEfforts, ['low', 'high']);
    assert.ok(!(await f.lines('requests.jsonl')).some((m) => m.type === 'user'));
    const session = await f.adapter.createSession(f.options);
    const ref = await f.adapter.startRun({
      ...f.options,
      sessionId: session.id,
      text: 'hello',
      reasoningEffort: 'high',
      images: [{ url: 'data:image/png;base64,aGVsbG8=' }],
    });
    await until(() => f.events.some((e) => e.type === 'run.completed'));
    assert.equal(
      f.events
        .filter((e) => e.type === 'message.delta')
        .map((e) => e.payload.delta)
        .join(''),
      'Claude hello',
    );
    assert.equal(f.events.find((e) => e.type === 'tool.completed')?.payload.text, 'file contents');
    assert.ok(f.events.every((e) => e.turnId === ref.turnId));
    const sent = (await f.lines('requests.jsonl')).find((m) => m.type === 'user');
    assert.deepEqual(sent.message.content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
    const args = (await f.lines('launches.jsonl')).find((a: string[]) => a.includes('--session-id'));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
    assert.equal(args[args.indexOf('--effort') + 1], 'high');
    assert.equal(await f.adapter.getQuota(), null);
  } finally {
    await f.close();
  }
});

for (const kind of ['approve', 'question'])
  test('Claude round-trips ' + kind + ' and validates generations', async () => {
    const f = await fixture();
    try {
      const session = await f.adapter.createSession(f.options);
      await f.adapter.startRun({ ...f.options, sessionId: session.id, text: kind });
      await until(() => f.events.some((e) => e.type === 'interaction.required'));
      assert.equal(
        f.events.find((e) => e.type === 'interaction.required')?.payload.kind,
        kind === 'question' ? 'input' : 'approval',
      );
      await assert.rejects(
        f.adapter.answerInteraction({ requestId: 'approval', generation: 'old', decision: 'accept' }),
      );
      await f.adapter.answerInteraction({
        requestId: 'approval',
        generation: f.adapter.generation,
        ...(kind === 'question' ? { answers: { '0': ['方案一'] } } : { decision: 'accept' as const }),
      });
      await until(() => f.events.some((e) => e.type === 'run.completed'));
      const response = JSON.parse(String(f.events.find((e) => e.type === 'message.delta')?.payload.delta));
      assert.equal(response.behavior, 'allow');
      if (kind === 'question') assert.equal(response.updatedInput.answers['选择方案'], '方案一');
    } finally {
      await f.close();
    }
  });

for (const mode of ['read-only', 'full-access'] as const)
  test('Claude maps ' + mode + ' and resumes a known session', async () => {
    const f = await fixture();
    try {
      const id = '12345678-1234-1234-1234-123456789abc';
      await f.adapter.resumeSession({ id });
      await f.adapter.startRun({ ...f.options, sessionId: id, text: 'hello', permissionMode: mode });
      await until(() => f.events.some((e) => e.type === 'run.completed'));
      const args = (await f.lines('launches.jsonl')).find((a: string[]) => a.includes('--resume'));
      assert.equal(args[args.indexOf('--resume') + 1], id);
      assert.equal(
        args[args.indexOf('--permission-mode') + 1],
        mode === 'read-only' ? 'plan' : 'bypassPermissions',
      );
      assert.equal(args.includes('--allow-dangerously-skip-permissions'), mode === 'full-access');
    } finally {
      await f.close();
    }
  });

for (const text of ['wait', 'crash', 'deny'])
  test('Claude handles ' + text + ' without replay or raw error disclosure', async () => {
    const f = await fixture();
    try {
      const session = await f.adapter.createSession(f.options);
      const ref = await f.adapter.startRun({ ...f.options, sessionId: session.id, text });
      if (text === 'wait') await f.adapter.interruptRun(ref);
      await until(() => f.events.some((e) => e.type === 'run.completed' || e.type === 'run.failed'));
      const terminal = f.events.filter((e) => e.type === 'run.completed' || e.type === 'run.failed');
      assert.equal(terminal.length, 1);
      assert.equal(
        terminal[0].payload.state,
        text === 'wait' ? 'cancelled' : text === 'crash' ? 'uncertain' : 'failed',
      );
      assert.doesNotMatch(JSON.stringify(f.events), /private token/);
      assert.equal((await f.lines('requests.jsonl')).filter((m) => m.type === 'user').length, 1);
    } finally {
      await f.close();
    }
  });

test('Claude child cannot inherit host API credentials or OAuth tokens', async () => {
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const before = keys.map((k) => process.env[k]);
  keys.forEach((k) => (process.env[k] = 'host-secret'));
  const f = await fixture();
  try {
    assert.equal((await f.adapter.getAccount()).authenticated, true);
  } finally {
    await f.close();
    keys.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    });
  }
});
