import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgent } from '../../apps/agent/src/server.ts';
import { AgentConfigSchema } from '../../apps/agent/src/config.ts';
import { claudeExecutable } from '../helpers/claude-process.ts';
import { isAllowedAgentRoute } from '../../packages/contracts/src/agent-routes.ts';

test('Claude accounts isolate authorization and sessions, persist across restart, run, resume and cancel through account proxy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-claude-accounts-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const project = join(directory, 'project');
  await mkdir(project, { mode: 0o700 });
  const executable = await claudeExecutable(directory);
  const config = AgentConfigSchema.parse({
    stateDir: join(directory, 'private'),
    socketPath: join(directory, 'agent.sock'),
    tokenFile,
    roots: [directory],
    codexHome: join(directory, 'codex'),
    claudeExecutable: executable,
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
    const { account: a } = await json('/providers/codex/accounts', {
      label: 'Claude One',
      provider: 'claude',
    });
    const { account: b } = await json('/providers/codex/accounts', {
      label: 'Claude Two',
      provider: 'claude',
    });
    const prefix = '/accounts/' + a.id,
      other = '/accounts/' + b.id;
    assert.equal((await json(prefix + '/providers/claude/account')).authenticated, false);
    assert.equal((await call(prefix + '/providers/codex/login', {})).statusCode, 404);
    assert.equal((await call('/providers/claude/login', {})).statusCode, 404);
    const challenge = await json(prefix + '/providers/claude/login', {});
    assert.equal(challenge.codeRequired, true);
    await json(prefix + '/providers/claude/login/code', { code: 'TEST-CODE', loginId: challenge.loginId });
    await wait(async () => (await json(prefix + '/providers/claude/account')).authenticated);
    assert.equal((await json(other + '/providers/claude/account')).authenticated, false);
    assert.equal((await json(prefix + '/providers/claude/quota')).quota, null);
    assert.equal((await json(other + '/providers/claude/quota')).quota, null);
    assert.equal((await stat(join(config.stateDir, 'accounts', a.id, 'claude'))).mode & 0o777, 0o700);
    const { workspace } = await json(prefix + '/workspaces/open', { path: project });
    assert.notEqual(
      (await call(prefix + '/workspaces/open', { path: join(config.stateDir, 'accounts', b.id, 'claude') }))
        .statusCode,
      200,
    );
    const { conversation } = await json(prefix + '/workspaces/' + workspace.id + '/conversations', {
      title: 'Claude task',
    });
    assert.equal(conversation.providerId, 'claude');
    const submit = async (text: string) =>
      json(prefix + '/conversations/' + conversation.id + '/runs', {
        clientRequestId: randomUUID(),
        text,
        model: 'default',
        permissionMode: 'workspace-write',
      });
    const { run: denied } = await submit('deny');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === denied.id && r.state === 'failed'),
    );
    assert.match((await json(prefix + '/snapshot')).runs.find((r: any) => r.id === denied.id).error, /订阅/);
    const { run } = await submit('hello');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === run.id && r.state === 'completed'),
    );
    assert.ok((await json(prefix + '/snapshot')).messages.some((m: any) => m.text.includes('Claude hello')));
    assert.equal((await json(other + '/snapshot')).conversations.length, 0);
    const { run: running } = await submit('wait');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === running.id && r.state === 'running'),
    );
    assert.equal((await call(prefix + '/providers/claude/login', {})).statusCode, 409);
    assert.equal((await call('/providers/codex/accounts/' + a.id + '/delete', {})).statusCode, 409);
    await json(prefix + '/runs/' + running.id + '/cancel', { clientRequestId: randomUUID() });
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === running.id && r.state === 'cancelled',
      ),
    );
    await agent.app.close();
    agent = await buildAgent(config);
    assert.equal((await json(prefix + '/providers/claude/account')).authenticated, true);
    assert.equal((await json(other + '/providers/claude/account')).authenticated, false);
    const { run: resumed } = await submit('hello');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === resumed.id && r.state === 'completed',
      ),
    );
    const profiles = (await json('/providers/codex/accounts')).accounts;
    assert.equal(profiles.find((p: any) => p.id === a.id).provider, 'claude');
    for (let i = 0; i < 6; i++)
      await json('/providers/codex/accounts', { label: 'Extra ' + i, provider: 'claude' });
    assert.equal(
      (await call('/providers/codex/accounts', { label: 'Overflow', provider: 'claude' })).statusCode,
      409,
    );
    assert.equal(
      (await json('/providers/codex/accounts', { label: 'ChatGPT remains available' })).account.provider,
      'codex',
    );
    // Delete only the selected Claude home and task store, retaining the other account.
    await json(other + '/providers/claude/login', {});
    await json('/providers/codex/accounts/' + b.id + '/delete', {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await call(other + '/snapshot')).statusCode, 404);
    await assert.rejects(stat(join(config.stateDir, 'accounts', b.id)), { code: 'ENOENT' });
    assert.equal((await json(prefix + '/providers/claude/account')).authenticated, true);
  } finally {
    await agent.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway allowlist admits only supported Claude account routes', () => {
  const id = randomUUID();
  for (const suffix of ['account', 'models', 'quota'])
    assert.ok(isAllowedAgentRoute('GET', `/accounts/${id}/providers/claude/${suffix}`));
  assert.ok(isAllowedAgentRoute('POST', `/accounts/${id}/providers/claude/login`));
  assert.ok(isAllowedAgentRoute('POST', `/accounts/${id}/providers/claude/login/cancel`));
  assert.ok(isAllowedAgentRoute('POST', `/accounts/${id}/providers/claude/login/code`));
  assert.equal(isAllowedAgentRoute('POST', `/accounts/${id}/providers/kimi/login/code`), false);
  assert.equal(isAllowedAgentRoute('GET', `/accounts/${id}/providers/claude/credentials`), false);
  assert.equal(isAllowedAgentRoute('POST', `/accounts/${id}/providers/claude/accounts`), false);
});
