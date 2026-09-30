import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgent } from '../../apps/agent/src/server.ts';
import { AgentConfigSchema } from '../../apps/agent/src/config.ts';
import { deepseekExecutable, deepseekApiResponse } from '../helpers/deepseek-process.ts';
import { isAllowedAgentRoute } from '../../packages/contracts/src/agent-routes.ts';

test('DeepSeek account proxy isolates credentials, enforces full access, resumes, queues, cancels and protects key mutations', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) =>
    deepseekApiResponse(url, (init.headers as Record<string, string>).Authorization),
  );
  const root = await mkdtemp(join(tmpdir(), 'relay-deepseek-agent-'));
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
    deepseekExecutable: await deepseekExecutable(root),
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
    for (let i = 0; i < 240; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('Timed out');
  };
  try {
    const { account: a } = await json('/providers/codex/accounts', {
      label: 'DeepSeek One',
      provider: 'deepseek',
    });
    const { account: b } = await json('/providers/codex/accounts', {
      label: 'DeepSeek Two',
      provider: 'deepseek',
    });
    const prefix = '/accounts/' + a.id,
      other = '/accounts/' + b.id;
    assert.equal((await json(prefix + '/providers/deepseek/account')).authenticated, false);
    assert.equal(
      (await call(prefix + '/providers/deepseek/credentials', { apiKey: 'invalid-secret' })).statusCode,
      401,
    );
    await json(prefix + '/providers/deepseek/credentials', { apiKey: 'test-deepseek-one' });
    assert.equal((await json(prefix + '/providers/deepseek/account')).authMode, 'deepseek-api-key');
    assert.equal((await json(other + '/providers/deepseek/account')).authenticated, false);
    assert.equal((await json(prefix + '/providers/deepseek/models')).models.length, 2);
    assert.equal(
      (await json(prefix + '/providers/deepseek/quota')).quota.credits.balance_infos[0].total_balance,
      '12.34',
    );
    assert.equal((await call(prefix + '/providers/deepseek/credentials')).statusCode, 404);
    assert.equal((await call(prefix + '/providers/codex/account')).statusCode, 404);
    const keyPath = join(config.stateDir, 'accounts', a.id, 'deepseek', 'relay-credential.json');
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    assert.ok(!(await call('/providers/codex/accounts')).body.includes('test-deepseek-one'));
    const { workspace } = await json(prefix + '/workspaces/open', { path: project });
    assert.notEqual(
      (await call(prefix + '/workspaces/open', { path: join(config.stateDir, 'accounts', b.id, 'deepseek') }))
        .statusCode,
      200,
    );
    const { conversation } = await json(prefix + '/workspaces/' + workspace.id + '/conversations', {
      title: 'DeepSeek task',
    });
    const input = (text: string) => ({
      clientRequestId: randomUUID(),
      text,
      model: 'deepseek-flash',
      permissionMode: 'full-access',
    });
    const url = prefix + '/conversations/' + conversation.id + '/runs';
    assert.equal((await call(url, { ...input('unsafe'), permissionMode: 'read-only' })).statusCode, 400);
    const { run: first } = await json(url, input('hello'));
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some(
        (r: any) => r.id === first.id && r.state === 'completed' && r.restorePoint?.state === 'ready',
      ),
    );
    const snapshot = await json(prefix + '/snapshot');
    assert.equal(snapshot.runs[0].accountProfile, a.id);
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
      await readFile(join(config.stateDir, 'accounts', a.id, 'deepseek', 'fixture-sessions'), 'utf8')
    )
      .trim()
      .split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], lines[1]);
    const { run: active } = await json(url, input('wait'));
    await wait(async () =>
      (await json(prefix + '/snapshot')).runs.some((r: any) => r.id === active.id && r.state === 'running'),
    );
    assert.equal(
      (await call(prefix + '/providers/deepseek/credentials', { apiKey: 'test-deepseek-new' })).statusCode,
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
      const response = await call(prefix + '/providers/deepseek/credentials', { apiKey: '' });
      assert.ok([200, 409].includes(response.statusCode), response.body);
      return response.statusCode === 200;
    });
    assert.equal((await json(prefix + '/providers/deepseek/account')).authenticated, false);
    assert.equal((await json(other + '/providers/deepseek/account')).authenticated, false);
  } finally {
    await agent.app.close();
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(isAllowedAgentRoute('POST', '/providers/deepseek/credentials'), true);
  assert.equal(isAllowedAgentRoute('GET', '/providers/deepseek/credentials'), false);
  assert.equal(isAllowedAgentRoute('POST', '/providers/deepseek/login'), false);
});
