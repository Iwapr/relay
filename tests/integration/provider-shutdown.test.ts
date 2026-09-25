import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildAgent } from '../../apps/agent/src/server.ts';
import type { AgentConfig } from '../../apps/agent/src/config.ts';
import { MockProvider, barrier, until } from '../helpers/mock-provider.ts';

test('Agent shutdown during idle-provider eviction does not create or leak a replacement provider', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'relay-provider-shutdown-'));
  const firstPath = path.join(base, 'first');
  const secondPath = path.join(base, 'second');
  const stateDir = path.join(base, 'private');
  await Promise.all([mkdir(firstPath), mkdir(secondPath), mkdir(stateDir, { mode: 0o700 })]);
  const tokenFile = path.join(stateDir, 'token');
  await writeFile(tokenFile, randomUUID() + randomUUID(), { mode: 0o600 });
  const config: AgentConfig = {
    stateDir,
    socketPath: path.join(stateDir, 'agent.sock'),
    tokenFile,
    roots: [base],
    taskUmask: '0022',
    codexExecutable: '/unused-fixture-only',
    maxProviders: 1,
    maxPreviewBytes: 1024 * 1024,
    allowRoot: false,
  };
  const providers: MockProvider[] = [];
  let shutdownStarted = false;
  const creationsDuringShutdown: string[] = [];
  const agent = await buildAgent(config, (cwd) => {
    if (shutdownStarted) creationsDuringShutdown.push(cwd);
    const provider = new MockProvider(cwd);
    providers.push(provider);
    return provider;
  });
  const evictedProviderCanClose = barrier();
  const managerIsClosing = barrier();
  const closeManager = agent.manager.close.bind(agent.manager);
  agent.manager.close = () => {
    shutdownStarted = true;
    const closing = closeManager();
    managerIsClosing.release();
    return closing;
  };
  let shutdown: Promise<void> | undefined;
  try {
    const first = await agent.manager.openWorkspace(firstPath);
    const second = await agent.manager.openWorkspace(secondPath);
    const idle = (await agent.manager.provider(first.id)) as MockProvider;
    idle.close = async () => {
      idle.closes++;
      await evictedProviderCanClose.promise;
    };
    const conversation = agent.manager.createConversation(second.id, 'Shutdown race fixture');
    await agent.manager.submit(conversation.id, {
      clientRequestId: randomUUID(),
      text: 'Must never dispatch while shutdown is in progress',
      model: 'fixture-model',
      permissionMode: 'read-only',
    });
    await until(() => idle.closes === 1);
    shutdown = agent.app.close();
    await managerIsClosing.promise;
    // Let close() snapshot the provider pool while eviction still awaits A.close().
    await new Promise<void>((resolve) => setImmediate(resolve));
    evictedProviderCanClose.release();
    await shutdown;

    assert.deepEqual(creationsDuringShutdown, [], 'closing must prevent the replacement factory call');
    assert.equal(providers.length, 1, 'the queued workspace must not create another provider');
    assert.ok(
      providers.every((provider) => provider.closes > 0),
      'all created providers must be closed',
    );
    assert.ok(
      providers.every((provider) => provider.starts.length === 0),
      'no task may be dispatched',
    );
    await assert.rejects(agent.manager.provider(second.id), { code: 'agent_unavailable' });
  } finally {
    evictedProviderCanClose.release();
    await (shutdown ?? agent.app.close());
    await rm(base, { recursive: true, force: true });
  }
});
