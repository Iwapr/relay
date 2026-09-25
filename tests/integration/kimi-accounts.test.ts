import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgent } from '../../apps/agent/src/server.ts';
import { AgentConfigSchema } from '../../apps/agent/src/config.ts';
import { kimiExecutable } from '../helpers/kimi-process.ts';
import { isAllowedAgentRoute } from '../../packages/contracts/src/agent-routes.ts';

test('Kimi accounts isolate authorization and sessions, persist across restart, run, resume and cancel through account proxy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-kimi-accounts-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const project = join(directory, 'project');
  await mkdir(project, { mode: 0o700 });
  const executable = await kimiExecutable(directory);
  const config = AgentConfigSchema.parse({
    stateDir: join(directory, 'private'),
    socketPath: join(directory, 'agent.sock'),
    tokenFile,
    roots: [directory],
    codexHome: join(directory, 'codex'),
    kimiExecutable: executable,
  });
  let agent = await buildAgent(config);
  const call = (url: string, payload?: object) =>
    agent.app.inject({
      url,
      method: payload ? 'POST' : 'GET',
      payload,
      headers: { authorization: 'Bearer ' + 'a'.repeat(64) },
    });
  const json = async (url: string, payload?: object) => {
    const r = await call(url, payload);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const wait = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('Timed out');
  };
  try {
    const { account: a } = await json('/providers/codex/accounts', { label: 'Kimi One', provider: 'kimi' });
    const { account: b } = await json('/providers/codex/accounts', { label: 'Kimi Two', provider: 'kimi' });
    const prefix = '/accounts/' + a.id,
      other = '/accounts/' + b.id;
    assert.equal((await json(prefix + '/providers/kimi/account')).authenticated, false);
    assert.equal((await call(prefix + '/providers/codex/login', {})).statusCode, 404);
    assert.equal((await call('/providers/kimi/login', {})).statusCode, 404);
    const challenge = await json(prefix + '/providers/kimi/login', {});
    assert.equal(challenge.userCode, 'TEST-1234');
    await wait(async () => (await json(prefix + '/providers/kimi/account')).authenticated);
    assert.equal((await json(other + '/providers/kimi/account')).authenticated, false);
    assert.equal((await json(prefix + '/providers/kimi/quota')).quota.windows[0].usedPercent, 25);
    assert.equal((await json(other + '/providers/kimi/quota')).quota, null);
    assert.equal((await stat(join(config.stateDir, 'accounts', a.id, 'kimi'))).mode & 0o777, 0o700);
    const { workspace } = await json(prefix + '/workspaces/open', { path: project });
    assert.notEqual(
      (await call(prefix + '/workspaces/open', { path: join(config.stateDir, 'accounts', b.id, 'kimi') }))
        .statusCode,
      200,
    );
    const { conversation } = await json(prefix + '/workspaces/' + workspace.id + '/conversations', {
      title: 'Kimi task',
    });
    assert.equal(conversation.providerId, 'kimi');
    const submit = async (text: string) =>
      json(prefix + '/conversations/' + conversation.id + '/runs', {
        clientRequestId: randomUUID(),
        text,
        model: 'kimi-fixture',
        permissionMode: 'workspace-write',
      });
    const { run: denied } = await submit('access-denied');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === denied.id && r.state === 'failed'),
    );
    assert.match((await json(prefix + '/snapshot')).runs.find((r: any) => r.id === denied.id).error, /权益/);
    // An explicit denial must not strand the project lease: a subsequent turn succeeds.
    // A full subscription window must not preempt Kimi's Extra Usage fallback.
    await writeFile(
      join(config.stateDir, 'accounts', a.id, 'kimi', 'fixture-quota.json'),
      JSON.stringify({
        kind: 'ok',
        quota: {
          usages: { limit5h: { usedRatio: 1, resetAt: '2099-09-21T10:00:00Z' } },
          extraUsage: {
            balanceCents: 1234,
            totalCents: 2000,
            monthlyChargeLimitEnabled: false,
            monthlyChargeLimitCents: 0,
            monthlyUsedCents: 0,
            currency: 'CNY',
          },
        },
      }),
    );
    const { run } = await submit('hello');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === run.id && r.state === 'completed'),
    );
    assert.ok((await json(prefix + '/snapshot')).messages.some((m: any) => m.text.includes('Kimi default')));
    assert.equal((await json(other + '/snapshot')).conversations.length, 0);
    const { run: running } = await submit('wait');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === running.id && r.state === 'running'),
    );
    assert.equal((await call(prefix + '/providers/kimi/login', {})).statusCode, 409);
    assert.equal((await call('/providers/codex/accounts/' + a.id + '/delete', {})).statusCode, 409);
    await json(prefix + '/runs/' + running.id + '/cancel', { clientRequestId: randomUUID() });
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === running.id && r.state === 'cancelled',
      ),
    );
    await agent.app.close();
    agent = await buildAgent(config);
    assert.equal((await json(prefix + '/providers/kimi/account')).authenticated, true);
    assert.equal((await json(other + '/providers/kimi/account')).authenticated, false);
    const { run: resumed } = await submit('hello');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === resumed.id && r.state === 'completed',
      ),
    );
    const profiles = (await json('/providers/codex/accounts')).accounts;
    assert.equal(profiles.find((p: any) => p.id === a.id).provider, 'kimi');
    for (let i = 0; i < 6; i++)
      await json('/providers/codex/accounts', { label: 'Extra ' + i, provider: 'kimi' });
    assert.equal(
      (await call('/providers/codex/accounts', { label: 'Overflow', provider: 'kimi' })).statusCode,
      409,
    );
    assert.equal(
      (await json('/providers/codex/accounts', { label: 'ChatGPT remains available' })).account.provider,
      'codex',
    );
    // Delete only the selected Kimi home and task store, retaining the other account.
    await json(other + '/providers/kimi/login', {});
    await json('/providers/codex/accounts/' + b.id + '/delete', {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await call(other + '/snapshot')).statusCode, 404);
    await assert.rejects(stat(join(config.stateDir, 'accounts', b.id)), { code: 'ENOENT' });
    assert.equal((await json(prefix + '/providers/kimi/account')).authenticated, true);
  } finally {
    await agent.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway allowlist admits only supported Kimi account routes', () => {
  const id = randomUUID();
  for (const suffix of ['account', 'models', 'quota'])
    assert.ok(isAllowedAgentRoute('GET', `/accounts/${id}/providers/kimi/${suffix}`));
  assert.ok(isAllowedAgentRoute('POST', `/accounts/${id}/providers/kimi/login`));
  assert.ok(isAllowedAgentRoute('POST', `/accounts/${id}/providers/kimi/login/cancel`));
  assert.equal(isAllowedAgentRoute('GET', `/accounts/${id}/providers/kimi/credentials`), false);
  assert.equal(isAllowedAgentRoute('POST', `/accounts/${id}/providers/kimi/accounts`), false);
});
