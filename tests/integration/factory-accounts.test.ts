import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgent } from '../../apps/agent/src/server.ts';
import { AgentConfigSchema } from '../../apps/agent/src/config.ts';
import { factoryFixtureExecutable } from '../helpers/factory-process.ts';
import { isAllowedAgentRoute } from '../../packages/contracts/src/agent-routes.ts';

test('Factory account proxy isolates credentials, supports approvals, resumes, queues, cancels and protects key mutations', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, 'https://api.factory.ai/api/billing/limits');
    return new Response('Forbidden', { status: 403 });
  });
  const root = await mkdtemp(join(tmpdir(), 'relay-factory-agent-'));
  const project = join(root, 'project');
  await mkdir(project);
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const config = AgentConfigSchema.parse({
    stateDir: join(root, 'private'),
    socketPath: join(root, 'agent.sock'),
    tokenFile,
    roots: [root],
    codexHome: join(root, 'codex'),
    factoryExecutable: await factoryFixtureExecutable(root),
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
    for (let i = 0; i < 600; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('Timed out');
  };
  try {
    const { account: a } = await json('/providers/codex/accounts', {
      label: 'Factory One',
      provider: 'factory',
    });
    const { account: b } = await json('/providers/codex/accounts', {
      label: 'Factory Two',
      provider: 'factory',
    });
    const prefix = '/accounts/' + a.id,
      other = '/accounts/' + b.id;
    assert.equal((await json(prefix + '/providers/factory/account')).authenticated, false);
    assert.equal(
      (await call(prefix + '/providers/factory/credentials', { apiKey: 'invalid secret' })).statusCode,
      400,
    );
    await json(prefix + '/providers/factory/credentials', { apiKey: 'test-factory-one' });
    assert.equal((await json(prefix + '/providers/factory/account')).authMode, 'factory-api-key');
    assert.equal((await json(other + '/providers/factory/account')).authenticated, false);
    assert.equal((await json(prefix + '/providers/factory/models')).models.length, 1);
    assert.equal((await json(prefix + '/providers/factory/quota')).quota.credits, null);
    assert.equal((await call(prefix + '/providers/factory/credentials')).statusCode, 404);
    assert.equal((await call(prefix + '/providers/codex/account')).statusCode, 404);
    const keyPath = join(config.stateDir, 'accounts', a.id, 'factory', 'relay-credential.json');
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    assert.ok(!(await call('/providers/codex/accounts')).body.includes('test-factory-one'));
    const { workspace } = await json(prefix + '/workspaces/open', { path: project });
    assert.notEqual(
      (await call(prefix + '/workspaces/open', { path: join(config.stateDir, 'accounts', b.id, 'factory') }))
        .statusCode,
      200,
    );
    const { conversation } = await json(prefix + '/workspaces/' + workspace.id + '/conversations', {
      title: 'Factory task',
    });
    const input = (text: string) => ({
      clientRequestId: randomUUID(),
      text,
      model: 'fixture-opus',
      permissionMode: 'full-access',
    });
    const url = prefix + '/conversations/' + conversation.id + '/runs';

    const { run: first } = await json(url, input('hello'));
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === first.id && r.state === 'completed' && r.restorePoint?.state === 'ready',
      ),
    );
    const snapshot = await json(prefix + '/snapshot');
    assert.equal(snapshot.runs[0].accountProfile, a.id);
    assert.equal(snapshot.runs[0].usage.factoryCredits, 12.5);
    assert.equal(snapshot.runs[0].usage.inputTokens, 1);
    assert.equal(snapshot.runs[0].restorePoint.scope, 'files');
    const originalSession = snapshot.conversations[0].providerSessionId;
    await agent.app.close();
    agent = await buildAgent(config);
    const { run: second } = await json(url, input('again'));
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === second.id && r.state === 'completed'),
    );
    assert.equal((await json(prefix + '/snapshot')).conversations[0].providerSessionId, originalSession);
    const lines = (
      await readFile(join(config.stateDir, 'accounts', a.id, 'factory', 'fixture-sessions'), 'utf8')
    )
      .trim()
      .split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], lines[1]);
    for (const text of ['approval', 'question']) {
      const { run } = await json(url, { ...input(text), permissionMode: 'workspace-write' });
      await wait(async () =>
        (await json(prefix + '/snapshot')).runs.some(
          (r: any) =>
            r.id === run.id && r.state === (text === 'approval' ? 'waiting_approval' : 'waiting_input'),
        ),
      );
      const snapshot = await json(prefix + '/snapshot');
      const interaction = snapshot.interactions.find(
        (i: any) => i.runId === run.id && i.status === 'pending',
      );
      assert.ok(interaction, JSON.stringify(snapshot.interactions));
      await json(prefix + '/interactions/' + interaction.id + '/answer', {
        clientRequestId: randomUUID(),
        ...(text === 'approval' ? { decision: 'accept' } : { answers: { '4': ['simple'] } }),
      });
      await wait(async () =>
        (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === run.id && r.state === 'completed'),
      );
    }
    const { run: active } = await json(url, input('wait'));
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === active.id && r.state === 'running'),
    );
    assert.equal(
      (await call(prefix + '/providers/factory/credentials', { apiKey: 'test-factory-new' })).statusCode,
      409,
    );
    const reply = await json(prefix + '/conversations/' + conversation.id + '/reply', input('queued'));
    assert.equal(reply.delivery, 'queued');
    await json(prefix + '/runs/' + active.id + '/cancel', { clientRequestId: randomUUID() });
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === reply.runId && r.state === 'completed',
      ),
    );
    await wait(async () => {
      const response = await call(prefix + '/providers/factory/credentials', { apiKey: '' });
      assert.ok([200, 409].includes(response.statusCode), response.body);
      return response.statusCode === 200;
    });
    assert.equal((await json(prefix + '/providers/factory/account')).authenticated, false);
    assert.equal((await json(other + '/providers/factory/account')).authenticated, false);
    assert.ok(fetch.mock.callCount() > 0);
  } finally {
    await agent.app.close();
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(isAllowedAgentRoute('POST', '/providers/factory/credentials'), true);
  assert.equal(isAllowedAgentRoute('GET', '/providers/factory/credentials'), false);
  assert.equal(isAllowedAgentRoute('POST', '/providers/factory/login'), false);
});
