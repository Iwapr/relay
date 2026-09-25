import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, readdir, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Interaction, Run } from '../../packages/contracts/src/index.ts';
import { buildAgent } from '../../apps/agent/src/server.ts';
import type { AgentConfig } from '../../apps/agent/src/config.ts';
import { MockProvider, barrier, until } from '../helpers/mock-provider.ts';

async function fixture(configure?: (provider: MockProvider) => void) {
  const base = await mkdtemp(path.join(tmpdir(), 'workbench-agent-'));
  const project = path.join(base, 'project');
  const stateDir = path.join(base, 'private');
  await mkdir(path.join(project, 'child'), { recursive: true });
  await mkdir(stateDir, { mode: 0o700 });
  const token = randomUUID() + randomUUID();
  const tokenFile = path.join(stateDir, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const config: AgentConfig = {
    stateDir,
    socketPath: path.join(stateDir, 'agent.sock'),
    tokenFile,
    roots: [base],
    sensitivePaths: [path.join(project, 'gateway-secrets')],
    taskUmask: '0022',
    codexExecutable: '/unused-fixture-only',
    maxProviders: 4,
    maxPreviewBytes: 1024 * 1024,
    allowRoot: false,
  };
  const providers: MockProvider[] = [];
  const factory = (cwd: string) => {
    const p = new MockProvider(cwd);
    configure?.(p);
    providers.push(p);
    return p;
  };
  const agent = await buildAgent(config, factory);
  const headers = { authorization: `Bearer ${token}` };
  const workspace = await agent.manager.openWorkspace(project);
  const conversation = agent.manager.createConversation(workspace.id, 'Fixture');
  const input = (text = 'Fixture task') => ({
    clientRequestId: randomUUID(),
    text,
    model: 'fixture-model',
    reasoningEffort: 'medium',
    permissionMode: 'workspace-write' as const,
  });
  const submit = (text?: string) => agent.manager.submit(conversation.id, input(text));
  const run = (id: string) => agent.store.require<Run>('run', id);
  const provider = () => providers.find((p) => p.cwd === project);
  let closed = false;
  return {
    base,
    project,
    stateDir,
    config,
    factory,
    providers,
    agent,
    headers,
    workspace,
    conversation,
    input,
    submit,
    run,
    provider,
    closeAgent: async () => {
      if (!closed) {
        await agent.app.close();
        closed = true;
      }
    },
    close: async () => {
      if (!closed) await agent.app.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('Agent enforces token, identity and durable submission idempotency', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.agent.app.inject({ url: '/identity' })).statusCode, 401);
    assert.equal(
      (await f.agent.app.inject({ url: '/identity', headers: { authorization: 'Bearer invalid' } }))
        .statusCode,
      401,
    );
    const identity = (await f.agent.app.inject({ url: '/identity', headers: f.headers })).json();
    assert.equal(identity.uid, process.getuid?.());
    assert.equal(identity.agentId, f.agent.identity.agentId);
    await f.agent.manager.openWorkspace(f.project);
    const body = f.input();
    const url = `/conversations/${f.conversation.id}/runs`;
    const [first, repeated] = await Promise.all([
      f.agent.app.inject({ method: 'POST', url, headers: f.headers, payload: body }),
      f.agent.app.inject({ method: 'POST', url, headers: f.headers, payload: body }),
    ]);
    assert.equal(first.statusCode, 200);
    assert.equal(repeated.statusCode, 200);
    const id = first.json().run.id;
    assert.equal(repeated.json().run.id, id);
    const conflict = await f.agent.app.inject({
      method: 'POST',
      url,
      headers: f.headers,
      payload: { ...body, text: 'Different payload' },
    });
    assert.equal(conflict.statusCode, 409);
    await until(() => f.run(id).state === 'running');
    assert.equal(f.provider()!.starts.length, 1);
    f.provider()!.complete();
    assert.equal(f.run(id).state, 'completed');
    const hidden = await f.agent.app.inject({
      url: `/workspaces/${f.workspace.id}/file?path=${encodeURIComponent('../private/token')}`,
      headers: f.headers,
    });
    assert.equal(hidden.statusCode, 403);
    assert.ok(!hidden.body.includes(f.headers.authorization));
    await mkdir(path.join(f.project, 'gateway-secrets'));
    await writeFile(path.join(f.project, 'gateway-secrets', 'login.txt'), 'WEBSITE-PASSWORD');
    const secret = await f.agent.app.inject({
      url: `/workspaces/${f.workspace.id}/file?path=gateway-secrets%2Flogin.txt`,
      headers: f.headers,
    });
    assert.equal(secret.statusCode, 403);
    assert.doesNotMatch(secret.body, /WEBSITE-PASSWORD/);
    const hiddenTree = await f.agent.app.inject({
      url: `/workspaces/${f.workspace.id}/tree?hidden=true`,
      headers: f.headers,
    });
    assert.ok(!hiddenTree.json().entries.some((entry: { name: string }) => entry.name === 'gateway-secrets'));
  } finally {
    await f.close();
  }
});

test('write tasks queue across sessions and overlapping directories while unrelated roots can run', async () => {
  const f = await fixture();
  try {
    const first = await f.submit('First');
    await until(() => f.run(first.id).state === 'running');
    const otherConversation = f.agent.manager.createConversation(f.workspace.id, 'Second');
    const second = await f.agent.manager.submit(otherConversation.id, f.input('Second'));
    assert.equal(f.run(second.id).state, 'queued');
    const childWorkspace = await f.agent.manager.openWorkspace(path.join(f.project, 'child'));
    const childConversation = f.agent.manager.createConversation(childWorkspace.id, 'Child');
    const child = await f.agent.manager.submit(childConversation.id, f.input('Child'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(f.run(child.id).state, 'queued');
    await mkdir(path.join(f.base, 'other'));
    const unrelatedWorkspace = await f.agent.manager.openWorkspace(path.join(f.base, 'other'));
    const unrelatedConversation = f.agent.manager.createConversation(unrelatedWorkspace.id, 'Other');
    const unrelated = await f.agent.manager.submit(unrelatedConversation.id, f.input('Other'));
    await until(() => f.run(unrelated.id).state === 'running');
    f.providers.find((p) => p.cwd === path.join(f.base, 'other'))!.complete();
    f.provider()!.complete();
    const next = await until(() => [second, child].find((run) => f.run(run.id).state === 'running'));
    f.providers
      .find((p) => p.cwd === (next.id === child.id ? path.join(f.project, 'child') : f.project))!
      .complete();
    const last = next.id === second.id ? child : second;
    await until(() => f.run(last.id).state === 'running');
    f.providers
      .find((p) => p.cwd === (last.id === child.id ? path.join(f.project, 'child') : f.project))!
      .complete();
  } finally {
    await f.close();
  }
});

test('cancel remains cancelling until provider confirmation and duplicate requests dispatch once', async () => {
  const f = await fixture();
  try {
    const first = await f.submit();
    await until(() => f.run(first.id).state === 'running');
    const id = randomUUID();
    await f.agent.manager.cancel(first.id, id);
    await f.agent.manager.cancel(first.id, id);
    assert.equal(f.run(first.id).state, 'cancelling');
    assert.equal(f.provider()!.interrupts.length, 1);
    f.provider()!.complete('cancelled');
    assert.equal(f.run(first.id).state, 'cancelled');
  } finally {
    await f.close();
  }
});

test('queued cancellation and cancellation during session startup never submit a native turn', async () => {
  const gate = barrier();
  const f = await fixture((p) => {
    p.sessionBarrier = gate.promise;
  });
  try {
    const first = await f.submit();
    await until(() => f.run(first.id).state === 'starting');
    await until(() => f.provider());
    const queued = await f.submit('Never run queued task');
    await f.agent.manager.cancel(queued.id, randomUUID());
    await f.agent.manager.cancel(first.id, randomUUID());
    gate.release();
    await until(() => f.run(first.id).state === 'cancelled');
    assert.equal(f.run(queued.id).state, 'cancelled');
    assert.equal(f.provider()!.starts.length, 0);
  } finally {
    gate.release();
    await f.close();
  }
});

test('approvals are idempotent, old-turn events cannot complete a newer turn, and resolved events clear pending prompts', async () => {
  const f = await fixture();
  try {
    const first = await f.submit();
    await until(() => f.run(first.id).state === 'running');
    const provider = f.provider()!;
    const oldRef = provider.refs[0];
    provider.emit('interaction.required', { requestId: 1, kind: 'approval' });
    const interaction = f.agent.manager.snapshot().interactions[0];
    assert.equal(f.run(first.id).state, 'waiting_approval');
    const input = { clientRequestId: randomUUID(), decision: 'decline' as const };
    await Promise.all([
      f.agent.manager.answer(interaction.id, input),
      f.agent.manager.answer(interaction.id, input),
    ]);
    assert.equal(provider.answers.length, 1);
    provider.emit('interaction.required', { requestId: 2, kind: 'input' });
    provider.emit('interaction.resolved', { requestId: 2 });
    assert.equal(f.agent.manager.snapshot().interactions.length, 0);
    provider.complete();
    const second = await f.submit('Next turn');
    await until(() => f.run(second.id).state === 'running');
    provider.complete('completed', oldRef);
    assert.equal(f.run(second.id).state, 'running');
    provider.complete();
    assert.equal(f.run(second.id).state, 'completed');
  } finally {
    await f.close();
  }
});

test('legacy project flags do not block execution and are removed on restart without reopening', async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof buildAgent>> | undefined;
  try {
    const opened = await f.agent.app.inject({
      method: 'POST',
      url: '/workspaces/open',
      headers: f.headers,
      payload: { path: f.project, trusted: false },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    assert.equal(opened.json().workspace.id, f.workspace.id);
    assert.equal('trusted' in opened.json().workspace, false);
    // Reproduce an existing database from a release that required confirmation.
    f.agent.store.put('workspace', f.workspace.id, { ...f.workspace, trusted: false });
    await f.closeAgent();
    restarted = await buildAgent(f.config, f.factory);
    const workspace = restarted.manager.workspace(f.workspace.id);
    assert.equal('trusted' in workspace, false);
    assert.equal(workspace.directoryIdentity, f.workspace.directoryIdentity);
    assert.equal(restarted.manager.conversation(f.conversation.id).workspaceId, f.workspace.id);
    const result = await restarted.manager.reply(f.conversation.id, f.input());
    await until(() => restarted!.store.require<Run>('run', result.runId).state === 'running');
    f.provider()!.complete();
    assert.equal(restarted.store.require<Run>('run', result.runId).state, 'completed');
    // Removing the project flag must not remove the write-permission check.
    restarted.store.put('workspace', workspace.id, { ...workspace, writable: false });
    await assert.rejects(restarted.manager.submit(f.conversation.id, f.input()), {
      code: 'permission_denied',
    });
  } finally {
    await restarted?.app.close();
    await f.close();
  }
});

test('Agent restart expires approvals, preserves events and does not repeat uncertain execution', async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof buildAgent>> | undefined;
  try {
    const run = await f.submit();
    await until(() => f.run(run.id).state === 'running');
    f.provider()!.emit('interaction.required', { requestId: 99, kind: 'approval' });
    const interaction = f.agent.manager.snapshot().interactions[0];
    const seq = f.agent.store.sequence();
    await f.closeAgent();
    restarted = await buildAgent(f.config, f.factory);
    assert.equal(restarted.identity.agentId, f.agent.identity.agentId);
    assert.equal(restarted.store.require<Run>('run', run.id).state, 'interrupted');
    assert.equal(restarted.store.require<Interaction>('interaction', interaction.id).status, 'expired');
    await assert.rejects(
      restarted.manager.answer(interaction.id, { clientRequestId: randomUUID(), decision: 'accept' }),
      { code: 'stale_interaction' },
    );
    assert.ok(restarted.store.sequence() > seq);
    assert.ok(restarted.store.replay(seq).some((event) => event.type === 'run.state_changed'));
    const next = await restarted.manager.submit(f.conversation.id, f.input('Must not silently run'));
    await until(() => restarted!.store.require<Run>('run', next.id).state === 'uncertain');
    assert.equal(
      f.providers.reduce((count, provider) => count + provider.starts.length, 0),
      1,
    );
  } finally {
    await restarted?.app.close();
    await f.close();
  }
});

test('native start acknowledgement loss preserves an uncertainty lease', async () => {
  const f = await fixture((p) => {
    p.startError = new Error('Transport lost after turn/start');
  });
  try {
    const run = await f.submit();
    await until(() => f.run(run.id).state === 'uncertain');
    await until(() => !f.agent.manager.snapshot().runs.some((r) => r.state === 'running'));
    assert.equal(f.provider()!.starts.length, 1);
    await until(() => f.run(run.id).state === 'uncertain');
    assert.ok((await readdir(path.join(f.stateDir, 'locks'))).some((name) => name.endsWith('.lease')));
    const next = await f.submit('Do not duplicate');
    await until(() => f.run(next.id).state === 'uncertain');
    assert.equal(f.provider()!.starts.length, 1);
  } finally {
    await f.close();
  }
});

test('SSE reconnect replays persisted events and observer disconnect does not cancel work', async () => {
  const f = await fixture();
  const subscriptions: AbortController[] = [];
  try {
    await f.agent.app.listen({ host: '127.0.0.1', port: 0 });
    const address = f.agent.app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const controller = new AbortController();
    subscriptions.push(controller);
    const response = await fetch(`${base}/events?afterSeq=0`, {
      headers: f.headers,
      signal: controller.signal,
    });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const chunk = await response.body!.getReader().read();
    assert.match(new TextDecoder().decode(chunk.value), /workspace.opened/);
    controller.abort();
    const run = await f.submit();
    await until(() => f.run(run.id).state === 'running');
    const seq = f.agent.store.sequence();
    f.provider()!.emit('message.delta', { itemId: 'reply', delta: 'Persist after disconnect' });
    f.provider()!.complete();
    const reconnect = new AbortController();
    subscriptions.push(reconnect);
    const resumed = await fetch(`${base}/events?afterSeq=${seq}`, {
      headers: f.headers,
      signal: reconnect.signal,
    });
    const replayed = await resumed.body!.getReader().read();
    const text = new TextDecoder().decode(replayed.value);
    assert.match(text, /Persist after disconnect/);
    assert.match(text, /run.completed/);
    assert.equal(f.run(run.id).state, 'completed');
    assert.equal(f.provider()!.interrupts.length, 0);
    const mismatch = await f.agent.app.inject({
      url: '/events?agentId=wrong&afterSeq=0',
      headers: f.headers,
    });
    assert.equal(mismatch.statusCode, 409);
  } finally {
    for (const subscription of subscriptions) subscription.abort();
    await f.close();
  }
});

test('replaced workspace identity is rejected immediately before provider execution', async () => {
  const f = await fixture();
  try {
    await rename(f.project, f.project + '-original');
    await mkdir(f.project);
    const run = await f.submit();
    await until(() => f.run(run.id).state === 'failed');
    assert.equal(f.providers.length, 0);
  } finally {
    await f.close();
  }
});

test('read-only tasks in a non-writable directory still hold a lease before any approval escalation', async () => {
  const f = await fixture();
  try {
    await chmod(f.project, 0o500);
    const workspace = await f.agent.manager.openWorkspace(f.project);
    // Reopening the same inode refreshes its actual permission metadata.
    assert.equal(workspace.directoryInfo.writable, false);
    const run = await f.agent.manager.submit(f.conversation.id, {
      ...f.input(),
      permissionMode: 'read-only',
    });
    await until(() => f.run(run.id).state === 'running');
    assert.equal(
      (await readdir(path.join(f.stateDir, 'locks'))).some((name) => name.endsWith('.lease')),
      true,
    );
    f.provider()!.complete();
  } finally {
    await chmod(f.project, 0o755);
    await f.close();
  }
});

test('non-Git observed changes persist and opened ignored PDF paths receive dedicated watches', async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof buildAgent>> | undefined;
  try {
    await mkdir(path.join(f.project, '.cache'));
    await mkdir(path.join(f.project, '.aws'));
    await writeFile(path.join(f.project, '.cache', 'paper.pdf'), '%PDF-old');
    await f.agent.app.inject({
      method: 'POST',
      url: '/workspaces/open',
      headers: f.headers,
      payload: { path: f.project },
    });
    const metadata = await f.agent.app.inject({
      url: `/workspaces/${f.workspace.id}/metadata?path=.cache%2Fpaper.pdf`,
      headers: f.headers,
    });
    assert.equal(metadata.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await writeFile(path.join(f.project, '.cache', 'paper.pdf'), '%PDF-new');
    await writeFile(path.join(f.project, 'notes.txt'), 'Observed notes');
    await writeFile(path.join(f.project, '.aws', 'credentials'), 'NEVER DISPLAY');
    await writeFile(path.join(f.project, '.env'), 'NEVER DISPLAY ENV');
    await until(() =>
      f.agent.store.list<{ path: string }>('fileChange').some((change) => change.path === '.cache/paper.pdf'),
    );
    await until(() =>
      f.agent.store.list<{ path: string }>('fileChange').some((change) => change.path === 'notes.txt'),
    );
    const response = await f.agent.app.inject({
      url: `/workspaces/${f.workspace.id}/changes`,
      headers: f.headers,
    });
    assert.equal(response.json().git, false);
    assert.ok(
      response.json().observed.some((change: { path: string }) => change.path === '.cache/paper.pdf'),
    );
    assert.doesNotMatch(response.body, /credentials|NEVER DISPLAY|\.env/);
    await f.closeAgent();
    restarted = await buildAgent(f.config, f.factory);
    const retained = await restarted.app.inject({
      url: `/workspaces/${f.workspace.id}/changes`,
      headers: f.headers,
    });
    assert.ok(retained.json().observed.some((change: { path: string }) => change.path === 'notes.txt'));
  } finally {
    await restarted?.app.close();
    await f.close();
  }
});

test('retained replay boundary requires a fresh snapshot without discarding submission receipts', async () => {
  const f = await fixture();
  try {
    const input = f.input();
    const run = await f.agent.manager.submit(f.conversation.id, input);
    await until(() => f.run(run.id).state === 'running');
    f.provider()!.complete();
    for (let i = 0; i < 10; i++) f.agent.store.emit('provider.warning', { message: `retention-${i}` });
    f.agent.store.prune({ events: 3, messages: 1, changes: 1 });
    assert.equal(f.agent.store.replay(0).length, 3);
    assert.ok(f.agent.store.replayFloor() > 0);
    const rejected = await f.agent.app.inject({ url: '/events?afterSeq=0', headers: f.headers });
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().error.code, 'snapshot_required');
    assert.equal((await f.agent.manager.submit(f.conversation.id, input)).id, run.id);
    assert.equal(f.provider()!.starts.length, 1);
  } finally {
    await f.close();
  }
});

test('effective and rerouted models are recorded while requested settings remain immutable', async () => {
  const f = await fixture();
  try {
    const first = await f.submit();
    await until(() => f.run(first.id).state === 'running');
    const provider = f.provider()!,
      firstRef = provider.refs[0];
    provider.emit('run.settings', { model: 'effective-model', reasoningEffort: 'high' });
    assert.equal(f.run(first.id).model, 'effective-model');
    assert.equal(f.run(first.id).reasoningEffort, 'high');
    assert.equal(f.run(first.id).requestedModel, 'fixture-model');
    assert.equal(f.run(first.id).requestedReasoningEffort, 'medium');
    provider.emit('provider.warning', {
      fromModel: 'effective-model',
      toModel: 'rerouted-model',
      message: 'Model rerouted',
    });
    assert.equal(f.run(first.id).model, 'rerouted-model');
    provider.complete();
    await new Promise((resolve) => setTimeout(resolve, 40));
    provider.emit('run.settings', { model: 'effective-model', reasoningEffort: 'high' }, firstRef);
    assert.equal(f.run(first.id).model, 'rerouted-model');
    const second = await f.submit('New turn');
    await until(() => f.run(second.id).state === 'running');
    provider.emit('run.settings', { model: 'old-turn-setting', reasoningEffort: 'low' }, firstRef);
    assert.equal(f.run(second.id).model, 'fixture-model');
    provider.complete();
  } finally {
    await f.close();
  }
});

test('a dead idle provider is replaced only for an explicit new run and its old generation is ignored', async () => {
  const f = await fixture();
  try {
    const first = await f.submit();
    await until(() => f.run(first.id).state === 'running');
    const old = f.provider()!;
    old.complete();
    await new Promise((resolve) => setTimeout(resolve, 40));
    old.emit('provider.warning', { interrupted: true, message: 'Fixture process exited' });
    assert.equal(f.run(first.id).state, 'completed');
    assert.equal(f.providers.length, 1);
    const second = await f.submit('Explicit next request');
    await until(() => f.run(second.id).state === 'running');
    assert.equal(f.providers.length, 2);
    const replacement = f.providers[1];
    old.emit('provider.warning', { interrupted: true, message: 'Late dead generation warning' });
    old.complete('interrupted');
    assert.equal(f.run(second.id).state, 'running');
    replacement.complete();
    assert.equal(f.run(second.id).state, 'completed');
    assert.equal(old.starts.length, 1);
    assert.equal(replacement.starts.length, 1);
  } finally {
    await f.close();
  }
});

test('large streaming output stores bounded text and linear delta events without uncapping on completion', async () => {
  const f = await fixture();
  try {
    const run = await f.submit();
    await until(() => f.run(run.id).state === 'running');
    const provider = f.provider()!,
      startSeq = f.agent.store.sequence();
    provider.emit('tool.started', { itemId: 'large-output', command: 'fixture-print' });
    for (let i = 0; i < 1024; i++)
      provider.emit('tool.output', { itemId: 'large-output', delta: 'x'.repeat(1024) });
    provider.emit('tool.completed', {
      itemId: 'large-output',
      aggregatedOutput: 'x'.repeat(1024 * 1024),
      details: { nested: { untrusted: 'y'.repeat(1024 * 1024) } },
    });
    const message = f.agent.manager
      .snapshot()
      .messages.find((message) => message.id === `${run.id}:large-output`)!;
    assert.equal(Buffer.byteLength(message.text), 256 * 1024);
    assert.equal(message.payload.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(message.payload)) < 40 * 1024);
    const events = f.agent.store.replay(startSeq, 2000);
    const storedBytes = Buffer.byteLength(JSON.stringify(events));
    assert.ok(storedBytes < 850 * 1024, `Output events used ${storedBytes} bytes`);
    assert.equal(
      events.filter((event) => event.type === 'provider.warning' && event.payload.truncated).length,
      1,
    );
    const deltas = events.filter((event) => event.type === 'tool.output');
    assert.ok(deltas.length <= 257);
    assert.ok(
      deltas.every(
        (event) => event.payload.message === undefined && event.payload.messageDelta !== undefined,
      ),
    );
    assert.equal(
      f.agent.manager.snapshot().messages.find((message) => message.id === `${run.id}:large-output`)!.payload
        .command,
      'fixture-print',
    );
    provider.complete();
  } finally {
    await f.close();
  }
});

test('rollback restores files and branches before the turn; preserves original history and is idempotent', async () => {
  const f = await fixture((p) => {
    p.persistNativeHistory = true;
  });
  try {
    const filename = path.join(f.project, 'work.txt');
    await writeFile(filename, 'initial');
    const first = await f.submit('keep this context');
    await until(() => f.run(first.id).state === 'running');
    f.provider()!.complete();
    await until(() => f.run(first.id).restorePoint?.state === 'ready' && f.provider()!.releases.length === 1);
    const second = await f.submit('undo this change');
    await until(() => f.run(second.id).state === 'running');
    await writeFile(filename, 'task modified');
    await writeFile(path.join(f.project, 'new.txt'), 'new task file');
    f.provider()!.complete();
    await until(
      () => f.run(second.id).restorePoint?.state === 'ready' && f.provider()!.releases.length === 2,
    );
    await assert.rejects(f.agent.manager.previewRollback(first.id), { code: 'rollback_unavailable' });
    const plan = await f.agent.manager.previewRollback(second.id);
    assert.equal(plan.files.length, 2);
    const input = { clientRequestId: randomUUID(), token: plan.token };
    const restored = await f.agent.manager.rollback(second.id, input);
    assert.equal(await readFile(filename, 'utf8'), 'initial');
    await assert.rejects(readFile(path.join(f.project, 'new.txt')), { code: 'ENOENT' });
    assert.notEqual(restored.conversation.id, f.conversation.id);
    const originalId = f.agent.manager.conversation(f.conversation.id).providerSessionId!;
    assert.equal((await f.provider()!.readNativeSession(originalId)).turns.length, 2);
    assert.equal(
      (await f.provider()!.readNativeSession(restored.conversation.providerSessionId!)).turns.length,
      1,
    );
    assert.deepEqual(await f.agent.manager.rollback(second.id, input), restored);
    assert.equal(f.run(second.id).restorePoint?.state, 'restored');
    assert.equal(f.agent.store.get('restoreBlocked', f.workspace.id), undefined);
  } finally {
    await f.close();
  }
});

test('rollback refuses later edits and changed native history; ordinary fork does not touch files', async () => {
  const f = await fixture((p) => {
    p.persistNativeHistory = true;
  });
  try {
    const filename = path.join(f.project, 'work.txt');
    await writeFile(filename, 'initial');
    const run = await f.submit();
    await until(() => f.run(run.id).state === 'running');
    await assert.rejects(f.agent.manager.forkConversation(f.conversation.id, 'turn', 'fixture-model'), {
      code: 'run_conflict',
    });
    await writeFile(filename, 'task');
    f.provider()!.complete();
    await until(() => f.run(run.id).restorePoint?.state === 'ready' && f.provider()!.releases.length === 1);
    const plan = await f.agent.manager.previewRollback(run.id);
    await writeFile(filename, 'later edit');
    await assert.rejects(
      f.agent.manager.rollback(run.id, { clientRequestId: randomUUID(), token: plan.token }),
      /又被修改/,
    );
    assert.equal(await readFile(filename, 'utf8'), 'later edit');
    const branch = await f.agent.manager.forkConversation(
      f.conversation.id,
      f.run(run.id).providerTurnId!,
      'fixture-model',
    );
    assert.notEqual(
      branch.conversation.providerSessionId,
      f.agent.manager.conversation(f.conversation.id).providerSessionId,
    );
    assert.equal(await readFile(filename, 'utf8'), 'later edit');
    await writeFile(filename, 'task');
    const original = f
      .provider()!
      .nativeSessions.get(f.agent.manager.conversation(f.conversation.id).providerSessionId!)!;
    original.turns.push({ id: 'external', state: 'completed', userText: 'IDE continued', messages: [] });
    await assert.rejects(
      f.agent.manager.rollback(run.id, { clientRequestId: randomUUID(), token: plan.token }),
      /原生对话已发生变化/,
    );
    assert.equal(await readFile(filename, 'utf8'), 'task');
  } finally {
    await f.close();
  }
});

test('unknown native execution cannot be forked or authorize a file rollback', async () => {
  const f = await fixture((p) => {
    p.persistNativeHistory = true;
  });
  try {
    const file = path.join(f.project, 'work.txt');
    await writeFile(file, 'before');
    const run = await f.submit();
    await until(() => f.run(run.id).state === 'running');
    await writeFile(file, 'after');
    f.provider()!.complete();
    await until(() => f.run(run.id).restorePoint?.state === 'ready' && f.provider()!.releases.length === 1);
    const plan = await f.agent.manager.previewRollback(run.id);
    const provider = f.provider()!;
    const sessionId = f.agent.manager.conversation(f.conversation.id).providerSessionId!;
    const turnId = f.run(run.id).providerTurnId!;
    const history = provider.nativeSessions.get(sessionId)!;
    history.turns.find((turn) => turn.id === turnId)!.state = 'unknown';
    const sessionsBefore = [...provider.nativeSessions.keys()];
    await assert.rejects(f.agent.manager.forkConversation(f.conversation.id, turnId, 'fixture-model'), {
      code: 'run_conflict',
    });
    const operationId = randomUUID();
    await assert.rejects(
      f.agent.manager.rollback(run.id, { clientRequestId: operationId, token: plan.token }),
      { code: 'rollback_conflict' },
    );
    assert.equal(await readFile(file, 'utf8'), 'after');
    assert.deepEqual([...provider.nativeSessions.keys()], sessionsBefore);
    assert.equal(f.agent.store.get('restoreOperation', operationId), undefined);
    assert.equal(f.agent.store.get('restoreBlocked', f.workspace.id), undefined);
    assert.equal(f.run(run.id).restorePoint?.state, 'ready');
  } finally {
    await f.close();
  }
});

test('rollback holds the native source writer lease and refuses an IDE-owned source without changing files', async () => {
  const f = await fixture((p) => {
    p.persistNativeHistory = true;
  });
  try {
    const file = path.join(f.project, 'work.txt');
    await writeFile(file, 'before');
    const run = await f.submit();
    await until(() => f.run(run.id).state === 'running');
    await writeFile(file, 'after');
    f.provider()!.complete();
    await until(() => f.run(run.id).restorePoint?.state === 'ready' && f.provider()!.releases.length === 1);
    const plan = await f.agent.manager.previewRollback(run.id);
    f.provider()!.resumeSession = async () => {
      throw new Error('native session already has an active writer');
    };
    await assert.rejects(
      f.agent.manager.rollback(run.id, { clientRequestId: randomUUID(), token: plan.token }),
      /active writer/,
    );
    assert.equal(await readFile(file, 'utf8'), 'after');
    assert.equal(f.agent.store.get('restoreBlocked', f.workspace.id), undefined);
  } finally {
    await f.close();
  }
});

test('question replies steer once while running and start a new full-access turn when idle', async () => {
  const f = await fixture();
  try {
    const run = await f.submit();
    await until(() => f.run(run.id).state === 'running');
    const answer = f.input('Answer B');
    const result = await f.agent.manager.reply(f.conversation.id, answer);
    assert.equal(result.delivery, 'steered');
    assert.equal(result.runId, run.id);
    assert.deepEqual(await f.agent.manager.reply(f.conversation.id, answer), result);
    assert.equal(f.provider()!.steers.length, 1);
    await assert.rejects(f.agent.manager.reply(f.conversation.id, { ...answer, text: 'different' }), {
      code: 'run_conflict',
    });
    f.provider()!.complete();
    await until(() => f.run(run.id).state === 'completed');
    const next = await f.agent.manager.reply(f.conversation.id, {
      ...f.input('Later answer'),
      permissionMode: 'full-access',
    });
    assert.equal(next.delivery, 'queued');
    await until(() => f.run(next.runId).state === 'running');
    assert.equal(f.run(next.runId).permissionMode, 'full-access');
    f.provider()!.complete();
    await until(() => f.run(next.runId).state === 'completed');
  } finally {
    await f.close();
  }
});

test('takeover requires a fresh explicit confirmation, lists all sessions, and never repeats a stop', async () => {
  let stops = 0;
  let owner = 'owner-1';
  const f = await fixture((p) => {
    for (const id of ['native-target', 'native-other'])
      p.nativeSessions.set(id, {
        id,
        title: id,
        cwd: p.cwd,
        updatedAt: new Date().toISOString(),
        turns: [],
      });
    Object.assign(p, {
      inspectSessionOwner: async () => ({ fingerprint: owner, sessions: ['native-target', 'native-other'] }),
      stopSessionOwner: async () => {
        stops++;
      },
    });
  });
  try {
    const c = await f.agent.manager.importNativeSession(f.workspace.id, 'native-target');
    const url = `/conversations/${c.id}/takeover`;
    const post = (suffix: string, payload: object) =>
      f.agent.app.inject({ method: 'POST', url: url + suffix, headers: f.headers, payload });
    const plan = (await post('/preview', {})).json();
    assert.equal(plan.sessions.length, 2);
    assert.equal(stops, 0);
    const input = { token: plan.token, clientRequestId: randomUUID(), confirmed: true as const };
    assert.equal((await post('', { ...input, confirmed: false })).statusCode, 400);
    assert.equal((await post('', { ...input, token: randomUUID() })).statusCode, 409);
    owner = 'replacement';
    assert.equal((await post('', input)).statusCode, 409);
    assert.equal(stops, 0);
    const current = (await post('/preview', {})).json();
    const confirmed = { ...input, token: current.token, clientRequestId: randomUUID() };
    assert.equal((await post('', confirmed)).statusCode, 200);
    assert.equal((await post('', confirmed)).statusCode, 200);
    assert.equal(stops, 1);
    assert.equal((await post('', { ...confirmed, clientRequestId: randomUUID() })).statusCode, 409);
    assert.equal(stops, 1);
    const run = await f.agent.manager.submit(c.id, f.input());
    await until(() => f.run(run.id).state === 'running');
    assert.equal((await post('/preview', {})).statusCode, 409);
    f.provider()!.complete();
  } finally {
    await f.close();
  }
});

test('takeover blocks inaccessible affected sessions and an uncertain stop cannot be replayed', async () => {
  let stops = 0,
    inaccessible = true;
  const f = await fixture((p) => {
    p.nativeSessions.set('native-target', {
      id: 'native-target',
      title: 'Target',
      cwd: p.cwd,
      updatedAt: new Date().toISOString(),
      turns: [],
    });
    p.nativeSessions.set('native-other', {
      id: 'native-other',
      title: 'Hidden',
      cwd: '/etc',
      updatedAt: new Date().toISOString(),
      turns: [],
    });
    Object.assign(p, {
      inspectSessionOwner: async () => ({
        fingerprint: 'owner',
        sessions: inaccessible ? ['native-target', 'native-other'] : ['native-target'],
      }),
      stopSessionOwner: async () => {
        stops++;
        throw new Error('stop acknowledgement lost');
      },
    });
  });
  try {
    const c = await f.agent.manager.importNativeSession(f.workspace.id, 'native-target');
    await assert.rejects(f.agent.manager.previewTakeover(c.id));
    assert.equal(stops, 0);
    inaccessible = false;
    const plan = await f.agent.manager.previewTakeover(c.id);
    const input = { token: plan.token, clientRequestId: randomUUID(), confirmed: true as const };
    await assert.rejects(f.agent.manager.takeover(c.id, input), /acknowledgement lost/);
    await assert.rejects(f.agent.manager.takeover(c.id, input), /不会重复中断/);
    assert.equal(stops, 1);
  } finally {
    await f.close();
  }
});

test('takeover previews and confirms subagent impact without allowing normal imports', async () => {
  let stopped = 0;
  const f = await fixture((p) => {
    p.nativeSessions.set('native-target', {
      id: 'native-target',
      title: 'Target',
      cwd: p.cwd,
      updatedAt: new Date().toISOString(),
      turns: [],
    });
    const original = p.readNativeSessionMetadata.bind(p);
    Object.assign(p, {
      inspectSessionOwner: async () => ({
        fingerprint: 'owner-with-child',
        sessions: ['native-target', 'child'],
      }),
      readSessionOwnerMetadata: async (id: string) =>
        id === 'child'
          ? { id, title: 'Child task', cwd: p.cwd, source: 'subagent', updatedAt: new Date().toISOString() }
          : original(id),
      stopSessionOwner: async () => {
        stopped++;
      },
    });
  });
  try {
    const conversation = await f.agent.manager.importNativeSession(f.workspace.id, 'native-target');
    const preview = await f.agent.manager.previewTakeover(conversation.id);
    assert.equal(preview.sessions.length, 2);
    assert.equal(preview.sessions[1].source, 'subagent');
    assert.equal(stopped, 0);
    await assert.rejects(f.agent.manager.importNativeSession(f.workspace.id, 'child'));
    await f.agent.manager.takeover(conversation.id, {
      token: preview.token,
      confirmed: true,
      clientRequestId: randomUUID(),
    });
    assert.equal(stopped, 1);
  } finally {
    await f.close();
  }
});

test('images upload through authenticated routes, survive queueing and reach the provider without bloating events', async () => {
  const f = await fixture();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=';
  try {
    const payload = {
      clientRequestId: randomUUID(),
      name: '截图.png',
      dataUrl: 'data:image/png;base64,' + png,
    };
    const url = `/workspaces/${f.workspace.id}/images`;
    assert.equal((await f.agent.app.inject({ method: 'POST', url, payload })).statusCode, 401);
    const uploaded = await f.agent.app.inject({ method: 'POST', url, headers: f.headers, payload });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const image = uploaded.json().image;
    const read = await f.agent.app.inject({ url: url + '/' + image.id, headers: f.headers });
    assert.equal(read.headers['content-type'], 'image/png');
    assert.equal(read.headers['x-content-type-options'], 'nosniff');
    assert.equal(read.rawPayload.toString('base64'), png);
    const input = { ...f.input(), text: '', imageIds: [image.id] };
    const submitted = await f.agent.app.inject({
      method: 'POST',
      url: `/conversations/${f.conversation.id}/runs`,
      headers: f.headers,
      payload: input,
    });
    assert.equal(submitted.statusCode, 200);
    const run = submitted.json().run;
    assert.deepEqual(run.images, [image]);
    assert.ok(!JSON.stringify(run).includes(png));
    const repeated = await f.agent.app.inject({
      method: 'POST',
      url: `/conversations/${f.conversation.id}/runs`,
      headers: f.headers,
      payload: input,
    });
    assert.equal(repeated.statusCode, 200);
    const again = repeated.json().run;
    assert.equal(again.id, run.id);
    await until(() => f.run(run.id).state === 'running');
    assert.deepEqual(f.provider()!.starts.at(-1)?.images, [{ url: payload.dataUrl }]);
    assert.ok(!JSON.stringify(f.agent.store.replay(0)).includes(png));
    assert.equal(f.agent.manager.images.read(f.workspace.id, image.id).bytes.toString('base64'), png);
    const other = await f.agent.manager.openWorkspace(path.join(f.project, 'child'));
    assert.equal(
      (await f.agent.app.inject({ url: `/workspaces/${other.id}/images/${image.id}`, headers: f.headers }))
        .statusCode,
      403,
    );
    f.provider()!.complete();
  } finally {
    await f.close();
  }
});

test('takeover visibility requires verified external ownership and excludes Relay tasks', async () => {
  let occupied = false,
    inspections = 0,
    stops = 0;
  const f = await fixture((p) => {
    p.nativeSessions.set('owned-thread', {
      id: 'owned-thread',
      title: 'Owned',
      cwd: p.cwd,
      updatedAt: new Date().toISOString(),
      turns: [],
    });
    Object.assign(p, {
      inspectSessionOwner: async () => {
        inspections++;
        if (!occupied) throw new Error('No external writer');
        return { fingerprint: 'external', sessions: ['owned-thread'] };
      },
      stopSessionOwner: async () => {
        stops++;
      },
    });
  });
  try {
    assert.equal(await f.agent.manager.takeoverAvailable(f.conversation.id), false);
    assert.equal(inspections, 0);
    const c = await f.agent.manager.importNativeSession(f.workspace.id, 'owned-thread');
    const get = () => f.agent.app.inject({ url: `/conversations/${c.id}`, headers: f.headers });
    assert.equal((await get()).json().takeoverAvailable, false);
    occupied = true;
    assert.equal((await get()).json().takeoverAvailable, true);
    const run = await f.agent.manager.submit(c.id, f.input());
    await until(() => f.run(run.id).state === 'running');
    const before = inspections;
    assert.equal((await get()).json().takeoverAvailable, false);
    assert.equal(inspections, before);
    f.provider()!.complete();
    await until(() => f.run(run.id).state === 'completed');
    occupied = false;
    assert.equal((await get()).json().takeoverAvailable, false);
    assert.equal(stops, 0);
  } finally {
    await f.close();
  }
});

test('fresh execution follows external login after browsing, leaving the running task untouched', async () => {
  let login = 'first@example.test';
  const f = await fixture((p) => {
    p.disposeAfterRun = true;
    p.account = { ...p.account, identifier: login };
  });
  try {
    const browsing = await f.agent.manager.provider(f.workspace.id);
    assert.equal((await browsing.getAccount()).identifier, login);
    login = 'second@example.test';
    const first = await f.submit();
    await until(() => f.run(first.id).state === 'running');
    const execution = f.providers.find((p) => p.starts.length > 0)!;
    assert.notEqual(execution, browsing);
    assert.equal(execution.account.identifier, login);
    assert.equal((browsing as MockProvider).closes, 1);
    login = 'third@example.test';
    const response = await f.agent.app.inject({ url: '/providers/codex/account', headers: f.headers });
    assert.equal(response.json().identifier, login);
    assert.equal(execution.closes, 0);
    assert.equal(execution.account.identifier, 'second@example.test');
    const second = await f.submit();
    execution.complete();
    await until(() => f.run(second.id).state === 'running');
    const next = f.providers.find((p) => p !== execution && p.starts.length > 0)!;
    assert.equal(next.account.identifier, login);
    next.complete();
    await until(() => f.run(second.id).state === 'completed');
  } finally {
    await f.close();
  }
});

test('workspace preview endpoints accept absolute temporary paths without creating workspaces', async () => {
  const f = await fixture();
  const temporary = await mkdtemp(path.join(tmpdir(), 'relay-absolute-preview-'));
  try {
    const filename = path.join(temporary, '临时文档.md');
    await writeFile(filename, '# Temporary');
    const prefix = `/workspaces/${f.workspace.id}`;
    const query = new URLSearchParams({ path: filename });
    assert.equal((await f.agent.app.inject({ url: `${prefix}/metadata?${query}` })).statusCode, 401);
    const response = await f.agent.app.inject({ url: `${prefix}/metadata?${query}`, headers: f.headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().preview, 'markdown');
    query.set('version', response.json().version);
    const download = await f.agent.app.inject({
      url: `${prefix}/file?${query}`,
      headers: { ...f.headers, range: 'bytes=0-2' },
    });
    assert.equal(download.statusCode, 206);
    assert.equal(download.body, '# T');
    assert.equal(
      (await f.agent.app.inject({ url: '/workspaces', headers: f.headers })).json().workspaces.length,
      1,
    );
    assert.equal(
      (
        await f.agent.app.inject({
          method: 'POST',
          url: '/workspaces/open',
          headers: f.headers,
          payload: { path: temporary },
        })
      ).statusCode,
      403,
    );
    await rm(filename);
    assert.equal(
      (await f.agent.app.inject({ url: `${prefix}/metadata?${query}`, headers: f.headers })).statusCode,
      404,
    );
  } finally {
    await f.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('file transfers require authentication, support chunks, and refuse commits during active tasks', async () => {
  const f = await fixture();
  try {
    const url = `/workspaces/${f.workspace.id}/uploads`;
    const post = (payload: Record<string, unknown>) =>
      f.agent.app.inject({ method: 'POST', url, headers: f.headers, payload });
    assert.equal(
      (
        await f.agent.app.inject({
          method: 'POST',
          url,
          payload: { action: 'start', path: 'upload.txt', size: 3 },
        })
      ).statusCode,
      401,
    );
    const start = await post({ action: 'start', path: 'upload.txt', size: 3 });
    assert.equal(start.statusCode, 200, start.body);
    const id = start.json().id;
    assert.equal((await post({ action: 'chunk', id, offset: 0, data: 'YWJj' })).statusCode, 200);
    const run = await f.submit();
    await until(() => f.run(run.id).state === 'running');
    assert.equal((await post({ action: 'finish', id })).statusCode, 409);
    f.provider()!.complete('completed');
    await until(() => f.run(run.id).state === 'completed');
    await until(() => f.run(run.id).restorePoint?.state === 'ready' && f.provider()!.releases.length === 1);
    const finish = await post({ action: 'finish', id });
    assert.equal(finish.statusCode, 200, finish.body);
    assert.equal(await readFile(path.join(f.project, 'upload.txt'), 'utf8'), 'abc');
    const download = await f.agent.app.inject({
      method: 'POST',
      url: `/workspaces/${f.workspace.id}/downloads`,
      headers: f.headers,
      payload: { paths: ['upload.txt'], archive: false },
    });
    assert.equal(download.statusCode, 200, download.body);
    const response = await f.agent.app.inject({
      method: 'GET',
      url: `/workspaces/${f.workspace.id}/downloads/${download.json().id}`,
      headers: f.headers,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'abc');
    assert.match(String(response.headers['content-disposition']), /attachment/);
  } finally {
    await f.close();
  }
});

test('Terminal runs a real PTY in the workspace, validates input and closes', async () => {
  const f = await fixture();
  const url = `/workspaces/${f.workspace.id}/terminals`;
  const post = (target: string, payload: Record<string, unknown>) =>
    f.agent.app.inject({ method: 'POST', url: target, headers: f.headers, payload });
  try {
    assert.equal(
      (await f.agent.app.inject({ method: 'POST', url, payload: { cols: 80, rows: 24 } })).statusCode,
      401,
    );
    assert.equal((await post(url, { cols: 0, rows: 24 })).statusCode, 400);
    const created = await post(url, { cols: 80, rows: 24 });
    assert.equal(created.statusCode, 200, created.body);
    const terminal = `${url}/${created.json().id}`;
    assert.equal((await post(`${terminal}/resize`, { cols: 93, rows: 31 })).statusCode, 200);
    assert.equal(
      (await post(`${terminal}/input`, { data: "printf '\\nPTY_RESULT:'; pwd; stty size\r" })).statusCode,
      200,
    );
    let output = '';
    await until(async () => {
      output = (await f.agent.app.inject({ url: terminal, headers: f.headers })).json().data;
      return output.includes(`PTY_RESULT:${f.project}`) && output.includes('31 93');
    });
    assert.equal(
      (
        await f.agent.app.inject({
          url: `/workspaces/wrong/terminals/${created.json().id}`,
          headers: f.headers,
        })
      ).statusCode,
      404,
    );
    const result = (await f.agent.app.inject({ url: terminal, headers: f.headers })).json();
    const next = (
      await f.agent.app.inject({ url: `${terminal}?cursor=${result.cursor}`, headers: f.headers })
    ).json();
    assert.equal(next.data, '');
    await post(`${terminal}/input`, { data: 'sleep 30\r' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await post(`${terminal}/input`, { data: '\x03' });
    await post(`${terminal}/input`, { data: "printf '\\nINTERRUPTED_OK\\n'\r" });
    await until(async () =>
      (await f.agent.app.inject({ url: terminal, headers: f.headers }))
        .json()
        .data.includes('\r\nINTERRUPTED_OK\r\n'),
    );
    assert.equal((await post(`${terminal}/close`, {})).statusCode, 200);
    assert.equal((await f.agent.app.inject({ url: terminal, headers: f.headers })).statusCode, 404);
  } finally {
    await f.close();
  }
});
