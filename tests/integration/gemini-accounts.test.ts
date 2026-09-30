import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgent } from '../../apps/agent/src/server.ts';
import { AgentConfigSchema } from '../../apps/agent/src/config.ts';
import { geminiExecutable } from '../helpers/gemini-process.ts';
import { isAllowedAgentRoute } from '../../packages/contracts/src/agent-routes.ts';

test('Gemini accounts isolate authorization and sessions, persist across restart, run, resume and cancel through account proxy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-antigravity-accounts-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const project = join(directory, 'project');
  await mkdir(project, { mode: 0o700 });
  const executable = await geminiExecutable(directory);
  const config = AgentConfigSchema.parse({
    stateDir: join(directory, 'private'),
    socketPath: join(directory, 'agent.sock'),
    tokenFile,
    roots: [directory],
    codexHome: join(directory, 'codex'),
    antigravityExecutable: executable,
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
      label: 'Gemini One',
      provider: 'antigravity',
    });
    const { account: b } = await json('/providers/codex/accounts', {
      label: 'Gemini Two',
      provider: 'antigravity',
    });
    const prefix = '/accounts/' + a.id,
      other = '/accounts/' + b.id;
    assert.equal((await json(prefix + '/providers/antigravity/account')).authenticated, false);
    assert.equal((await call(prefix + '/providers/codex/login', {})).statusCode, 404);
    assert.equal((await call('/providers/antigravity/login', {})).statusCode, 404);
    const challenge = await json(prefix + '/providers/antigravity/login', {});
    assert.equal(challenge.codeRequired, true);
    await json(prefix + '/providers/antigravity/login/code', {
      code: 'TEST-CODE',
      loginId: challenge.loginId,
    });
    await wait(async () => (await json(prefix + '/providers/antigravity/account')).authenticated);
    assert.equal((await json(other + '/providers/antigravity/account')).authenticated, false);
    assert.equal((await json(prefix + '/providers/antigravity/quota')).quota.windows.length, 2);
    assert.equal((await json(other + '/providers/antigravity/quota')).quota, null);
    assert.equal((await stat(join(config.stateDir, 'accounts', a.id, 'antigravity'))).mode & 0o777, 0o700);
    const { workspace } = await json(prefix + '/workspaces/open', { path: project });
    assert.notEqual(
      (
        await call(prefix + '/workspaces/open', {
          path: join(config.stateDir, 'accounts', b.id, 'antigravity'),
        })
      ).statusCode,
      200,
    );
    const { conversation } = await json(prefix + '/workspaces/' + workspace.id + '/conversations', {
      title: 'Gemini task',
    });
    assert.equal(conversation.providerId, 'antigravity');
    const submit = async (text: string) =>
      json(prefix + '/conversations/' + conversation.id + '/runs', {
        clientRequestId: randomUUID(),
        text,
        model: 'gemini-3.1-pro-high',
        permissionMode: 'workspace-write',
      });
    const { run: denied } = await submit('denied');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === denied.id && r.state === 'failed'),
    );
    assert.match((await json(prefix + '/snapshot')).runs.find((r: any) => r.id === denied.id).error, /审批/);
    const { run } = await submit('hello');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === run.id && r.state === 'completed'),
    );
    assert.ok((await json(prefix + '/snapshot')).messages.some((m: any) => m.text.includes('Gemini hello')));
    assert.equal((await json(other + '/snapshot')).conversations.length, 0);
    const settings = await json(prefix + '/providers/antigravity/settings');
    let changed: any;
    await wait(async () => {
      const r = await call(prefix + '/providers/antigravity/settings', {
        revision: settings.revision,
        allowedCommands: [...settings.allowedCommands, 'python -m pytest'],
        deniedCommands: ['git push'],
      });
      if (r.statusCode === 200) {
        changed = r.json();
        return true;
      }
      assert.equal(r.statusCode, 409, r.body);
      return false;
    });
    assert.ok(changed.allowedCommands.includes('python -m pytest'));
    assert.ok(
      !(await json(other + '/providers/antigravity/settings')).allowedCommands.includes('python -m pytest'),
    );
    const { run: edited } = await submit('edit');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === edited.id && r.restorePoint?.state === 'ready',
      ),
    );
    const editRecord = (await json(prefix + '/snapshot')).runs.find((r: any) => r.id === edited.id);
    assert.equal(editRecord.restorePoint.scope, 'files');
    assert.equal(await readFile(join(project, 'gemini-edited.txt'), 'utf8'), 'changed');
    await writeFile(join(project, 'gemini-edited.txt'), 'manual changes');
    assert.notEqual((await call(prefix + '/runs/' + edited.id + '/rollback/preview', {})).statusCode, 200);
    await writeFile(join(project, 'gemini-edited.txt'), 'changed');
    const plan = await json(prefix + '/runs/' + edited.id + '/rollback/preview', {});
    const restoreInput = { clientRequestId: randomUUID(), token: plan.token };
    const restored = await json(prefix + '/runs/' + edited.id + '/rollback', restoreInput);
    assert.equal(restored.conversation.providerSessionId, null);
    assert.equal(restored.conversation.providerId, 'antigravity');
    assert.notEqual(restored.conversation.id, conversation.id);
    await assert.rejects(stat(join(project, 'gemini-edited.txt')), { code: 'ENOENT' });
    assert.deepEqual(await json(prefix + '/runs/' + edited.id + '/rollback', restoreInput), restored);
    const { run: slow } = await submit('slow');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === slow.id && r.state === 'running'),
    );
    const replyInput = {
      clientRequestId: randomUUID(),
      text: 'answer',
      model: 'gemini-3.1-pro-high',
      permissionMode: 'workspace-write',
    };
    const reply = await json(prefix + '/conversations/' + conversation.id + '/reply', replyInput);
    assert.equal(reply.delivery, 'queued');
    assert.deepEqual(await json(prefix + '/conversations/' + conversation.id + '/reply', replyInput), reply);
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === reply.runId && r.state === 'completed',
      ),
    );
    const { run: running } = await submit('wait');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === running.id && r.state === 'running'),
    );
    assert.equal((await call(prefix + '/providers/antigravity/login', {})).statusCode, 409);
    assert.equal(
      (
        await call(prefix + '/providers/antigravity/settings', {
          revision: changed.revision,
          allowedCommands: changed.allowedCommands,
          deniedCommands: changed.deniedCommands,
        })
      ).statusCode,
      409,
    );
    assert.equal((await call('/providers/codex/accounts/' + a.id + '/delete', {})).statusCode, 409);
    await json(prefix + '/runs/' + running.id + '/cancel', { clientRequestId: randomUUID() });
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === running.id && r.state === 'cancelled',
      ),
    );
    await agent.app.close();
    agent = await buildAgent(config);
    assert.equal((await json(prefix + '/providers/antigravity/account')).authenticated, true);
    assert.equal((await json(other + '/providers/antigravity/account')).authenticated, false);
    const { run: resumed } = await submit('hello');
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === resumed.id && r.state === 'completed',
      ),
    );
    const profiles = (await json('/providers/codex/accounts')).accounts;
    assert.equal(profiles.find((p: any) => p.id === a.id).provider, 'antigravity');
    for (let i = 0; i < 6; i++)
      await json('/providers/codex/accounts', { label: 'Extra ' + i, provider: 'antigravity' });
    assert.equal(
      (await call('/providers/codex/accounts', { label: 'Overflow', provider: 'antigravity' })).statusCode,
      409,
    );
    assert.equal(
      (await json('/providers/codex/accounts', { label: 'ChatGPT remains available' })).account.provider,
      'codex',
    );
    // Delete only the selected Gemini home and task store, retaining the other account.
    await json(other + '/providers/antigravity/login', {});
    await json('/providers/codex/accounts/' + b.id + '/delete', {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await call(other + '/snapshot')).statusCode, 404);
    await assert.rejects(stat(join(config.stateDir, 'accounts', b.id)), { code: 'ENOENT' });
    assert.equal((await json(prefix + '/providers/antigravity/account')).authenticated, true);
  } finally {
    await agent.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway allowlist admits only supported Gemini account routes', () => {
  const id = randomUUID();
  for (const suffix of ['account', 'models', 'quota'])
    assert.ok(isAllowedAgentRoute('GET', `/accounts/${id}/providers/antigravity/${suffix}`));
  assert.ok(isAllowedAgentRoute('POST', `/accounts/${id}/providers/antigravity/login`));
  assert.ok(isAllowedAgentRoute('POST', `/accounts/${id}/providers/antigravity/login/cancel`));
  assert.ok(isAllowedAgentRoute('POST', `/accounts/${id}/providers/antigravity/login/code`));
  assert.equal(isAllowedAgentRoute('POST', `/accounts/${id}/providers/kimi/login/code`), false);
  assert.equal(isAllowedAgentRoute('GET', `/accounts/${id}/providers/antigravity/credentials`), false);
  assert.equal(isAllowedAgentRoute('POST', `/accounts/${id}/providers/antigravity/accounts`), false);
});
