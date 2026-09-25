import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgent } from '../../apps/agent/src/server.ts';
import { AgentConfigSchema } from '../../apps/agent/src/config.ts';
import { isAllowedAgentRoute } from '../../packages/contracts/src/agent-routes.ts';
import { AgentTransport } from '../../packages/transport-ssh/src/index.ts';
import { MockProvider, until } from '../helpers/mock-provider.ts';
import type { NativeSessionHistory } from '../../packages/provider-core/src/index.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'relay-accounts-test-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  const originalHome = join(directory, 'original-codex');
  await mkdir(originalHome, { mode: 0o700 });
  const project = join(directory, 'project');
  await mkdir(project, { mode: 0o700 });
  const config = AgentConfigSchema.parse({
    stateDir: join(directory, 'private'),
    socketPath: join(directory, 'agent.sock'),
    tokenFile,
    roots: [directory],
    codexExecutable: '/fixture',
    codexHome: originalHome,
  });
  const providers: Array<{ provider: MockProvider; home: string | undefined; authHome?: string }> = [];
  const sharedHistory = new Map<string, NativeSessionHistory>();
  class SharedProvider extends MockProvider {
    override readonly nativeSessions = sharedHistory;
    override persistNativeHistory = true;
  }
  const factory = (cwd: string, home?: string, authHome?: string) => {
    const provider = new SharedProvider(cwd);
    provider.account.identifier = authHome?.includes('/accounts/')
      ? 'second@example.test'
      : 'original@example.test';
    providers.push({ provider, home, authHome });
    return provider;
  };
  let agent = await buildAgent(config, factory);
  const headers = { authorization: 'Bearer ' + 'a'.repeat(64) };
  const call = (url: string, payload?: object) =>
    agent.app.inject({ url, method: payload ? 'POST' : 'GET', headers, payload });
  const json = async (url: string, payload?: object) => {
    const response = await call(url, payload);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  return {
    directory,
    project,
    config,
    providers,
    call,
    json,
    get agent() {
      return agent;
    },
    restart: async () => {
      await agent.app.close();
      agent = await buildAgent(config, factory);
    },
    close: async () => {
      await agent.app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('accounts share execution homes and isolate authorization and tasks, persist selection targets, and preserve running work', async () => {
  const f = await fixture();
  try {
    const original = await f.json('/providers/codex/account');
    assert.equal(original.identifier, 'original@example.test');
    const { workspace: w1 } = await f.json('/workspaces/open', { path: f.project });
    const c1 = f.agent.manager.createConversation(w1.id, 'Original task');
    const r1 = await f.agent.manager.submit(c1.id, {
      clientRequestId: randomUUID(),
      text: 'Keep running',
      model: 'fixture-model',
      permissionMode: 'workspace-write',
    });
    await until(() => f.providers.some(({ provider }) => provider.starts.length > 0));
    const { account } = await f.json('/providers/codex/accounts', { label: '工作账号' });
    const prefix = '/accounts/' + account.id;
    await f.json(prefix + '/connect', {});
    const child = await f.json(prefix + '/snapshot');
    assert.notEqual(child.identity.agentId, f.agent.identity.agentId);
    assert.deepEqual(child.conversations, []);
    assert.deepEqual(child.runs, []);
    assert.equal((await f.json(prefix + '/providers/codex/account')).identifier, 'second@example.test');
    assert.equal((await f.call(prefix + '/conversations/' + c1.id)).statusCode, 404);
    assert.equal((await f.json('/snapshot')).runs[0].state, 'running');
    assert.notEqual(
      (await f.call(prefix + '/workspaces/open', { path: f.config.codexHome })).statusCode,
      200,
    );
    const { workspace: w2 } = await f.json(prefix + '/workspaces/open', { path: f.project });
    assert.notEqual(w1.id, w2.id);
    assert.equal(child.identity.codexHome, f.config.codexHome);
    assert.ok(f.providers.some((p) => p.authHome?.includes(account.id)));
    // Neither account can browse the other account's credential/state directories.
    assert.notEqual((await f.call('/workspaces/open', { path: child.identity.codexHome })).statusCode, 200);
    assert.notEqual((await f.call(prefix + '/workspaces/open', { path: f.config.stateDir })).statusCode, 200);
    const list = await f.json('/providers/codex/accounts');
    assert.equal(list.accounts[1].account.identifier, 'second@example.test');
    const running = f.providers.find(({ provider }) => provider.starts.length)?.provider;
    running!.complete();
    await until(() => f.agent.manager.snapshot().runs[0].state === 'completed');
    await f.restart();
    assert.equal((await f.json('/providers/codex/accounts')).accounts[1].id, account.id);
    const restored = await f.json(prefix + '/snapshot');
    assert.equal(restored.identity.agentId, child.identity.agentId);
    assert.equal(restored.workspaces[0].id, w2.id);
    assert.equal((await f.json('/snapshot')).runs[0].id, r1.id);
  } finally {
    await f.close();
  }
});

test('accounts continue one native thread and retain the submitting account on each Relay run', async () => {
  const f = await fixture();
  try {
    const { workspace } = await f.json('/workspaces/open', { path: f.project });
    const { conversation } = await f.json('/workspaces/' + workspace.id + '/conversations', {
      title: 'Shared',
    });
    const { run: first } = await f.json('/conversations/' + conversation.id + '/runs', {
      clientRequestId: randomUUID(),
      text: 'First account',
      model: 'fixture-model',
      permissionMode: 'read-only',
    });
    const original = await until(() => f.providers.find((p) => p.provider.starts.length)?.provider);
    original.complete();
    await until(() => f.agent.manager.snapshot().runs[0].state === 'completed');
    const nativeId = f.agent.manager.conversation(conversation.id).providerSessionId;
    const { account } = await f.json('/providers/codex/accounts', { label: 'Second account' });
    const prefix = '/accounts/' + account.id;
    const listed = await f.json(prefix + '/providers/codex/sessions');
    assert.ok(listed.sessions.some((s: { id: string }) => s.id === nativeId));
    const imported = await f.json(prefix + '/providers/codex/sessions/import', { threadId: nativeId });
    assert.equal(imported.conversation.providerSessionId, nativeId);
    const { run: second } = await f.json(prefix + '/conversations/' + imported.conversation.id + '/runs', {
      clientRequestId: randomUUID(),
      text: 'Second account',
      model: 'fixture-model',
      permissionMode: 'read-only',
    });
    const selected = await until(
      () => f.providers.find((p) => p.authHome && p.provider.starts.length)?.provider,
    );
    assert.equal(selected.starts[0].sessionId, nativeId);
    selected.complete();
    const history = await f.agent.manager.nativeHistory(conversation.id);
    // The view combines local Relay runs with foreign native turns, avoiding duplicates.
    assert.deepEqual(
      history?.turns.map((t) => t.userText),
      ['Second account'],
    );
    assert.deepEqual(
      (await original.readNativeSession(nativeId!)).turns.map((t) => t.userText),
      ['First account', 'Second account'],
    );
    assert.equal(first.accountProfile, 'default');
    assert.equal(second.accountProfile, account.id);
    assert.equal(second.accountLabel, 'Second account');
  } finally {
    await f.close();
  }
});

test('account contexts share directory leases, including overlapping project paths', async () => {
  const f = await fixture();
  try {
    const { workspace } = await f.json('/workspaces/open', { path: f.project });
    const lease = await f.agent.manager.locks.acquire(
      f.agent.manager.workspace(workspace.id).directoryInfo,
      'original-account',
    );
    try {
      const { account } = await f.json('/providers/codex/accounts', { label: 'Second' });
      const prefix = '/accounts/' + account.id;
      const { workspace: other } = await f.json(prefix + '/workspaces/open', { path: f.project });
      const { conversation } = await f.json(prefix + '/workspaces/' + other.id + '/conversations', {
        title: 'Conflict',
      });
      const response = await f.call(prefix + '/conversations/' + conversation.id + '/runs', {
        clientRequestId: randomUUID(),
        text: 'Cannot edit concurrently',
        model: 'fixture-model',
        permissionMode: 'workspace-write',
      });
      assert.equal(response.statusCode, 200, response.body);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal((await f.json(prefix + '/snapshot')).runs[0].state, 'queued');
      assert.equal(
        f.providers
          .filter(({ authHome }) => authHome?.includes('/accounts/'))
          .flatMap(({ provider }) => provider.starts).length,
        0,
      );
      await lease.release();
      await until(() =>
        f.providers.find(
          ({ authHome, provider }) => authHome?.includes('/accounts/') && provider.starts.length,
        ),
      );
      assert.equal((await f.json('/status')).activeRuns, 1);
      f.providers
        .find(({ authHome, provider }) => authHome?.includes('/accounts/') && provider.starts.length)!
        .provider.complete();
    } finally {
      await lease.release();
    }
  } finally {
    await f.close();
  }
});

test('account routing rejects unknown, nested and encoded account paths and caps creation', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.agent.app.inject({ url: '/providers/codex/accounts' })).statusCode, 401);
    assert.equal(
      (await f.call('/providers/codex/accounts', { label: ' ', codexHome: '/tmp' })).statusCode,
      400,
    );
    const id = randomUUID();
    assert.equal((await f.call('/accounts/' + id + '/snapshot')).statusCode, 404);
    assert.equal(isAllowedAgentRoute('GET', '/accounts/' + id + '/snapshot'), true);
    assert.equal(isAllowedAgentRoute('POST', '/accounts/' + id + '/connect'), true);
    assert.equal(isAllowedAgentRoute('POST', '/accounts/' + id + '/providers/codex/accounts'), false);
    assert.equal(isAllowedAgentRoute('GET', '/accounts/' + id + '/accounts/' + id + '/snapshot'), false);
    const results = await Promise.all(
      Array.from({ length: 9 }, (_, i) => f.call('/providers/codex/accounts', { label: 'Account ' + i })),
    );
    assert.equal(results.filter((r) => r.statusCode === 200).length, 8);
    assert.equal(results.filter((r) => r.statusCode === 409).length, 1);
  } finally {
    await f.close();
  }
});

test('account SSE replays only its events and closes cleanly when the owner service shuts down', async () => {
  const f = await fixture();
  let transport: AgentTransport | undefined;
  try {
    await f.agent.app.listen({ path: f.config.socketPath });
    const { account } = await f.json('/providers/codex/accounts', { label: 'Events' });
    const prefix = '/accounts/' + account.id;
    const empty = await f.json(prefix + '/snapshot');
    const { workspace } = await f.json(prefix + '/workspaces/open', { path: f.project });
    transport = new AgentTransport({ kind: 'unix', socketPath: f.config.socketPath }, f.directory);
    const response = await transport.request({
      method: 'GET',
      path: prefix + '/events?afterSeq=0&agentId=' + empty.identity.agentId,
      headers: { authorization: 'Bearer ' + 'a'.repeat(64) },
    });
    assert.equal(response.statusCode, 200);
    const chunk = await new Promise<string>((resolve, reject) => {
      response.once('data', (data) => resolve(data.toString()));
      response.once('error', reject);
    });
    assert.ok(chunk.includes(workspace.id));
    assert.ok(chunk.includes(empty.identity.agentId));
    assert.ok(!chunk.includes(f.agent.identity.agentId));
    const ended = new Promise<void>((resolve) => response.once('end', resolve));
    response.resume();
    await f.agent.app.close();
    await ended;
  } finally {
    await transport?.close();
    await f.close();
  }
});

test('deleting a named account removes private data, preserves shared history and refuses active tasks', async () => {
  const f = await fixture();
  try {
    const shared = join(f.config.codexHome!, 'keep.txt');
    await writeFile(shared, 'shared history');
    const { account } = await f.json('/providers/codex/accounts', { label: 'Delete me' });
    const prefix = '/accounts/' + account.id;
    const endpoint = '/providers/codex/accounts/' + account.id + '/delete';
    assert.ok(isAllowedAgentRoute('POST', endpoint));
    assert.equal(isAllowedAgentRoute('POST', prefix + endpoint), false);
    const { workspace } = await f.json(prefix + '/workspaces/open', { path: f.project });
    const { conversation } = await f.json(prefix + '/workspaces/' + workspace.id + '/conversations', {
      title: 'Active',
    });
    const { run } = await f.json(prefix + '/conversations/' + conversation.id + '/runs', {
      clientRequestId: randomUUID(),
      text: 'wait',
      model: 'fixture-model',
      permissionMode: 'read-only',
    });
    await until(() => f.providers.some((p) => p.provider.starts.length > 0));
    assert.equal((await f.call(endpoint, {})).statusCode, 409);
    assert.ok((await f.json('/providers/codex/accounts')).accounts.some((a: any) => a.id === account.id));
    const provider = f.providers.find((p) => p.provider.starts.length > 0)!.provider;
    provider.complete('completed', provider.refs[0]);
    for (let n = 0; n < 100; n++) {
      const response = await f.call(endpoint, {});
      if (response.statusCode === 200) break;
      assert.equal(response.statusCode, 409, response.body);
      assert.ok(n < 99);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal((await f.call(prefix + '/snapshot')).statusCode, 404);
    assert.equal((await f.call(endpoint, {})).statusCode, 404);
    await assert.rejects(stat(join(f.config.stateDir, 'accounts', account.id)), { code: 'ENOENT' });
    assert.ok(await stat(shared));
    await f.restart();
    assert.equal((await f.json('/providers/codex/accounts')).accounts.length, 1);
    assert.notEqual((await f.call('/providers/codex/accounts/default/delete', {})).statusCode, 200);
    assert.equal((await f.json('/providers/codex/account')).identifier, 'original@example.test');
  } finally {
    await f.close();
  }
});

test('retired provider profiles stay stored but cannot appear or launch as Codex', async () => {
  const f = await fixture();
  const id = randomUUID();
  const profile = { id, label: 'Retired account', provider: 'gemini' };
  try {
    f.agent.store.put('codexAccount', id, profile);
    const { accounts } = await f.json('/providers/codex/accounts');
    assert.equal(
      accounts.some((account: { id: string }) => account.id === id),
      false,
    );
    assert.equal((await f.call(`/accounts/${id}/snapshot`)).statusCode, 404);
    assert.equal((await f.call(`/accounts/${id}/providers/codex/login`, {})).statusCode, 404);
    assert.equal(f.providers.length, 0);
    assert.deepEqual(f.agent.store.get('codexAccount', id), profile);
    assert.notEqual(
      (await f.call('/providers/codex/accounts', { label: 'Removed', provider: 'gemini' })).statusCode,
      200,
    );
    assert.equal(isAllowedAgentRoute('POST', `/accounts/${id}/providers/gemini/login`), false);
    await f.restart();
    assert.equal(
      (await f.json('/providers/codex/accounts')).accounts.some((a: { id: string }) => a.id === id),
      false,
    );
    assert.deepEqual(f.agent.store.get('codexAccount', id), profile);
  } finally {
    await f.close();
  }
});

test('account-scoped uploads and downloads forward binary files without sharing transfer IDs', async () => {
  const f = await fixture();
  try {
    const { account } = await f.json('/providers/codex/accounts', { label: 'Transfers' });
    const prefix = `/accounts/${account.id}`;
    const { workspace } = await f.json(prefix + '/workspaces/open', { path: f.project });
    const endpoint = prefix + `/workspaces/${workspace.id}`;
    const bytes = Buffer.alloc(192 * 1024, 137);
    const { id } = await f.json(endpoint + '/uploads', {
      action: 'start',
      path: 'account.bin',
      size: bytes.length,
    });
    await f.json(endpoint + '/uploads', { action: 'chunk', id, offset: 0, data: bytes.toString('base64') });
    await f.json(endpoint + '/uploads', { action: 'finish', id });
    const download = await f.json(endpoint + '/downloads', { paths: ['account.bin'], archive: false });
    const response = await f.call(endpoint + '/downloads/' + download.id);
    assert.equal(response.statusCode, 200, response.body.slice(0, 100));
    assert.deepEqual(response.rawPayload, bytes);
    const { workspace: root } = await f.json('/workspaces/open', { path: f.project });
    assert.equal((await f.call(`/workspaces/${root.id}/downloads/${download.id}`)).statusCode, 404);
  } finally {
    await f.close();
  }
});
