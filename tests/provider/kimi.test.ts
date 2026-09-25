import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KimiAdapter } from '../../packages/provider-kimi/src/index.ts';
import { kimiExecutable } from '../helpers/kimi-process.ts';
import { until } from '../helpers/mock-provider.ts';
import type { ProviderEvent } from '../../packages/provider-core/src/index.ts';

async function fixture(authorized = true) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-kimi-test-'));
  const home = join(directory, 'home');
  await mkdir(home);
  const executable = await kimiExecutable(directory);
  if (authorized) await writeFile(join(home, 'fixture-auth'), 'authorized');
  const adapter = new KimiAdapter({ cwd: directory, home, executable });
  const events: ProviderEvent[] = [];
  adapter.subscribeEvents((e) => events.push(e));
  const options = { cwd: directory, model: 'kimi-fixture', permissionMode: 'workspace-write' as const };
  return {
    directory,
    home,
    adapter,
    events,
    options,
    requests: async () =>
      (await readFile(join(home, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    close: async () => {
      await adapter.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Kimi login is isolated, shares an in-progress device flow, and refreshes authentication', async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.adapter.getAccount()).authenticated, false);
    assert.deepEqual(await f.adapter.listModels(), []);
    const [a, b] = await Promise.all([f.adapter.beginLogin(), f.adapter.beginLogin()]);
    assert.deepEqual(a, b);
    assert.equal(a.userCode, 'TEST-1234');
    await until(() => f.events.some((e) => e.type === 'account.updated' && e.payload.success === true));
    assert.equal((await f.adapter.getAccount()).authMode, 'kimi-code');
    assert.equal((await f.adapter.getAccount()).requiresOpenaiAuth, false);
    assert.equal((await f.adapter.listModels()).length, 2);
  } finally {
    await f.close();
  }
});

test('Kimi maps discovered models, streaming, images and permission modes to ACP without prompting during discovery', async () => {
  const f = await fixture();
  try {
    const models = await f.adapter.listModels();
    assert.deepEqual(
      models.map((m) => m.id),
      ['kimi-fixture', 'kimi-second'],
    );
    assert.deepEqual(models[0].reasoningEfforts, ['on', 'off']);
    assert.equal((await f.requests()).filter((r) => r.method === 'session/prompt').length, 0);
    assert.ok((await f.requests()).some((r) => r.method === 'session/delete'));
    const session = await f.adapter.createSession(f.options);
    const ref = await f.adapter.startRun({
      ...f.options,
      sessionId: session.id,
      text: 'hello',
      reasoningEffort: 'off',
      images: [{ url: 'data:image/png;base64,aGVsbG8=' }],
    });
    await until(() => f.events.some((e) => e.type === 'run.completed'));
    assert.equal(
      f.events
        .filter((e) => e.type === 'message.delta')
        .map((e) => e.payload.delta)
        .join(''),
      '你好 Kimi default',
    );
    assert.equal(f.events.find((e) => e.type === 'tool.completed')?.payload.text, 'file contents');
    assert.ok(f.events.every((e) => e.turnId === ref.turnId));
    const sent = (await f.requests()).find((r) => r.method === 'session/prompt');
    assert.deepEqual(sent.params.prompt[1], { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
    await f.adapter.resumeSession(session, { ...f.options, permissionMode: 'read-only' });
    await f.adapter.resumeSession(session, { ...f.options, permissionMode: 'full-access' });
    assert.deepEqual(
      (await f.requests()).filter((r) => r.method === 'session/set_mode').map((r) => r.params.modeId),
      ['default', 'plan', 'yolo'],
    );
    assert.equal((await f.adapter.getQuota()).windows[0].usedPercent, 25);
  } finally {
    await f.close();
  }
});

for (const kind of ['approve', 'question'])
  test('Kimi round-trips ' + kind + ' with stale-generation protection', async () => {
    const f = await fixture();
    try {
      const session = await f.adapter.createSession(f.options);
      await f.adapter.startRun({ ...f.options, sessionId: session.id, text: kind });
      await until(() => f.events.some((e) => e.type === 'interaction.required'));
      const event = f.events.find((e) => e.type === 'interaction.required')!;
      assert.equal(event.payload.kind, kind === 'question' ? 'input' : 'approval');
      await assert.rejects(
        f.adapter.answerInteraction({ requestId: 'approval', generation: 'stale', decision: 'accept' }),
      );
      await f.adapter.answerInteraction({
        requestId: 'approval',
        generation: f.adapter.generation,
        ...(kind === 'question' ? { answers: { choice: ['方案一'] } } : { decision: 'accept' as const }),
      });
      await until(() => f.events.some((e) => e.type === 'run.completed'));
      assert.equal(
        f.events.find((e) => e.type === 'message.delta')?.payload.delta,
        kind === 'question' ? 'q0_opt_0' : 'allow',
      );
    } finally {
      await f.close();
    }
  });

test('Kimi cancels an active prompt and marks process loss uncertain without replay', async () => {
  const f = await fixture();
  try {
    const session = await f.adapter.createSession(f.options);
    const ref = await f.adapter.startRun({ ...f.options, sessionId: session.id, text: 'wait' });
    await f.adapter.interruptRun(ref);
    await until(() => f.events.some((e) => e.type === 'run.completed'));
    assert.equal(f.events.find((e) => e.type === 'run.completed')?.payload.state, 'cancelled');
    await f.adapter.startRun({ ...f.options, sessionId: session.id, text: 'crash' });
    await until(() => f.events.some((e) => e.type === 'run.failed'));
    assert.equal(f.events.find((e) => e.type === 'run.failed')?.payload.state, 'uncertain');
    assert.equal((await f.requests()).filter((r) => r.method === 'session/prompt').length, 2);
  } finally {
    await f.close();
  }
});

test('cancelled Kimi device login cannot authorize later', async () => {
  const f = await fixture(false);
  try {
    await f.adapter.beginLogin();
    await f.adapter.cancelLogin();
    assert.equal((await f.adapter.getAccount()).authenticated, false);
    assert.ok(f.events.some((e) => e.type === 'account.updated' && e.payload.success === false));
    const again = await f.adapter.beginLogin();
    assert.equal(again.userCode, 'TEST-1234');
  } finally {
    await f.close();
  }
});

test('cancelling before the Kimi home is ready prevents a late login process', async () => {
  const f = await fixture(false);
  try {
    const pending = f.adapter.beginLogin();
    const rejected = assert.rejects(pending, /登录已取消/);
    await f.adapter.cancelLogin();
    await rejected;
    assert.equal((await f.adapter.getAccount()).authenticated, false);
  } finally {
    await f.close();
  }
});

test('Kimi quotas remain account-isolated, refresh values and never retain failed-query balances', async () => {
  const a = await fixture(),
    b = await fixture(false);
  try {
    const [qa, qb] = await Promise.all([a.adapter.getQuota(), b.adapter.getQuota()]);
    assert.equal(a.adapter.capabilities().quota, true);
    assert.equal(qa.windows[0].usedPercent, 25);
    assert.equal(qa.extraUsage?.balanceCents, 1234);
    assert.equal(qb.stale, true);
    assert.deepEqual(qb.windows, []);
    assert.equal(qb.extraUsage, undefined);
    assert.match(qb.unavailableReason!, /重新登录/);
    await writeFile(
      join(a.home, 'fixture-quota.json'),
      JSON.stringify({
        kind: 'ok',
        quota: {
          usages: { limit7d: { usedRatio: 1.1 }, monthCode: { usedRatio: 0, resetAt: 'invalid' } },
          extraUsage: null,
        },
      }),
    );
    const refreshed = await a.adapter.getQuota();
    assert.deepEqual(
      refreshed.windows.map((w) => w.usedPercent),
      [100, 0],
    );
    assert.equal(refreshed.windows[1].resetsAt, null);
    assert.equal(refreshed.extraUsage, undefined);
    await writeFile(
      join(a.home, 'fixture-quota.json'),
      JSON.stringify({ kind: 'error', status: 503, message: 'secret must not appear' }),
    );
    const failed = await a.adapter.getQuota();
    assert.equal(failed.stale, true);
    assert.deepEqual(failed.windows, []);
    assert.doesNotMatch(JSON.stringify(failed), /secret/);
    await writeFile(
      join(a.home, 'fixture-quota.json'),
      JSON.stringify({ kind: 'ok', quota: { usages: { limit5h: { usedRatio: 'bad' } }, extraUsage: null } }),
    );
    assert.equal((await a.adapter.getQuota()).stale, true);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test('closing Kimi during quota startup cancels the query without resurrecting a process', async () => {
  const f = await fixture();
  try {
    const pending = f.adapter.getQuota();
    await f.adapter.close();
    assert.equal((await pending).stale, true);
    assert.equal((await f.adapter.getQuota()).stale, true);
  } finally {
    await f.close();
  }
});

test('closing Kimi aborts an in-flight quota HTTP request and stops its authenticated local server', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.home, 'fixture-quota-hang'), '');
    const pending = f.adapter.getQuota();
    let pid = 0;
    for (let i = 0; i < 200 && !pid; i++) {
      pid = Number(await readFile(join(f.home, 'fixture-quota-pid'), 'utf8').catch(() => '0'));
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(pid > 0, 'quota request reached the local server');
    await f.adapter.close();
    assert.equal((await pending).stale, true);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await f.close();
  }
});
