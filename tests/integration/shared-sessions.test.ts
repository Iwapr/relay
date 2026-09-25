import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildAgent } from '../../apps/agent/src/server.ts';
import type { AgentConfig } from '../../apps/agent/src/config.ts';
import type { Conversation, Run } from '../../packages/contracts/src/index.ts';
import type { NativeSessionHistory } from '../../packages/provider-core/src/index.ts';
import { MockProvider, barrier, until } from '../helpers/mock-provider.ts';

async function fixture(configure?: (provider: MockProvider) => void) {
  const base = await mkdtemp(path.join(tmpdir(), 'relay-shared-session-'));
  const project = path.join(base, 'project');
  const other = path.join(base, 'other');
  const stateDir = path.join(base, 'private');
  await Promise.all([
    mkdir(path.join(project, 'child'), { recursive: true }),
    mkdir(other),
    mkdir(stateDir, { mode: 0o700 }),
  ]);
  const token = randomUUID() + randomUUID();
  const tokenFile = path.join(stateDir, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const config: AgentConfig = {
    stateDir,
    socketPath: path.join(stateDir, 'agent.sock'),
    tokenFile,
    roots: [base],
    taskUmask: '0022',
    codexExecutable: '/unused-fixture-only',
    maxProviders: 4,
    maxPreviewBytes: 1024 * 1024,
    allowRoot: false,
  };
  const nativeSessions = new Map<string, NativeSessionHistory>();
  const addSession = (cwd: string, title: string) => {
    const session: NativeSessionHistory = {
      id: randomUUID(),
      title,
      cwd,
      updatedAt: new Date().toISOString(),
      model: 'fixture-model',
      source: 'vscode',
      status: 'idle',
      turns: [
        {
          id: randomUUID(),
          state: 'completed',
          userText: 'Existing IDE fixture question',
          messages: [{ id: randomUUID(), kind: 'assistant', text: 'Existing IDE fixture answer' }],
        },
      ],
    };
    nativeSessions.set(session.id, session);
    return session;
  };
  const first = addSession(project, 'First IDE fixture session');
  const second = addSession(project, 'Second IDE fixture session');
  const foreign = addSession(other, 'Other workspace private fixture');
  const child = addSession(path.join(project, 'child'), 'Child workspace fixture');
  const privateSession = addSession(stateDir, 'Private state must stay hidden');
  const outsideSession = addSession(path.dirname(base), 'Outside root must stay hidden');
  const missingSession = addSession(path.join(base, 'deleted-project'), 'Deleted project must stay hidden');
  const providers: MockProvider[] = [];
  const factory = (cwd: string) => {
    const provider = new MockProvider(cwd);
    provider.nativeSessionPageSize = 1;
    for (const [id, session] of nativeSessions) provider.nativeSessions.set(id, session);
    configure?.(provider);
    providers.push(provider);
    return provider;
  };
  let agent = await buildAgent(config, factory);
  const workspace = await agent.manager.openWorkspace(project);
  const headers = { authorization: `Bearer ${token}` };
  const listUrl = `/workspaces/${workspace.id}/native-sessions`;
  const importSession = (threadId = first.id) =>
    agent.app.inject({ method: 'POST', url: listUrl + '/import', headers, payload: { threadId } });
  return {
    base,
    project,
    workspace,
    providers,
    nativeSessions,
    first,
    second,
    foreign,
    child,
    privateSession,
    outsideSession,
    missingSession,
    headers,
    listUrl,
    importSession,
    agent: () => agent,
    provider: () => providers.findLast((provider) => provider.cwd === project),
    run: (id: string) => agent.store.require<Run>('run', id),
    restart: async () => {
      await agent.app.close();
      agent = await buildAgent(config, factory);
    },
    close: async () => {
      await agent.app.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('global IDE discovery lists accessible projects without a selected workspace and safely imports original cwd', async () => {
  const f = await fixture();
  try {
    const globalUrl = '/providers/codex/sessions';
    assert.equal((await f.agent().app.inject({ url: globalUrl })).statusCode, 401);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = globalUrl + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
      const page = await f.agent().app.inject({
        url,
        headers: f.headers,
      });
      assert.equal(page.statusCode, 200, page.body);
      ids.push(...page.json().sessions.map((session: { id: string }) => session.id));
      for (const hidden of [f.privateSession, f.outsideSession, f.missingSession])
        assert.ok(!page.body.includes(hidden.title));
      cursor = page.json().nextCursor;
    } while (cursor);
    assert.deepEqual(ids, [f.first.id, f.second.id, f.foreign.id, f.child.id]);
    assert.equal(f.agent().store.list('workspace').length, 1, 'browsing must not open projects');

    const imported = await f.agent().app.inject({
      method: 'POST',
      url: globalUrl + '/import',
      headers: f.headers,
      payload: { threadId: f.foreign.id },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    const { workspace, conversation } = imported.json();
    assert.equal(workspace.canonicalRoot, f.foreign.cwd);
    assert.equal('trusted' in workspace, false);
    assert.equal(conversation.workspaceId, workspace.id);
    assert.equal(conversation.providerSessionId, f.foreign.id);
    assert.equal(f.agent().manager.workspace(f.workspace.id).id, f.workspace.id);
    await f.agent().manager.openWorkspace(f.foreign.cwd);
    const again = await f.agent().app.inject({
      method: 'POST',
      url: f.listUrl + '/import',
      headers: f.headers,
      payload: { threadId: f.foreign.id, scope: 'all' },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().conversation.id, conversation.id);
    assert.equal(again.json().workspace.id, workspace.id, 'import must preserve the project');
    assert.equal(
      f.providers.flatMap((provider) => provider.resumes).length,
      0,
      'reading never takes ownership',
    );
  } finally {
    await f.close();
  }
});

test('global imports still reject private paths, outside roots, missing and replaced project directories', async () => {
  const f = await fixture();
  try {
    for (const session of [f.privateSession, f.outsideSession, f.missingSession]) {
      const response = await f.agent().app.inject({
        method: 'POST',
        url: '/providers/codex/sessions/import',
        headers: f.headers,
        payload: { threadId: session.id },
      });
      assert.ok(response.statusCode >= 400, response.body);
      assert.ok(!response.body.includes(session.title));
    }
    await rename(f.project, f.project + '-old');
    await mkdir(f.project);
    const replaced = await f.agent().app.inject({
      method: 'POST',
      url: '/providers/codex/sessions/import',
      headers: f.headers,
      payload: { threadId: f.first.id },
    });
    assert.equal(replaced.statusCode, 409, replaced.body);
    assert.equal(f.agent().store.list('conversation').length, 0);
  } finally {
    await f.close();
  }
});

test('native session browsing paginates by exact workspace and import is idempotent and continued execution needs no project confirmation', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.agent().app.inject({ url: f.listUrl })).statusCode, 401);
    const firstPage = await f.agent().app.inject({ url: f.listUrl, headers: f.headers });
    assert.equal(firstPage.statusCode, 200, firstPage.body);
    assert.deepEqual(
      firstPage.json().sessions.map((session: { id: string }) => session.id),
      [f.first.id],
    );
    const cursor = firstPage.json().nextCursor;
    assert.equal(typeof cursor, 'string');
    const secondPage = await f.agent().app.inject({
      url: `${f.listUrl}?cursor=${encodeURIComponent(cursor)}`,
      headers: f.headers,
    });
    assert.equal(secondPage.statusCode, 200, secondPage.body);
    assert.deepEqual(
      secondPage.json().sessions.map((session: { id: string }) => session.id),
      [f.second.id],
    );
    assert.equal(secondPage.json().nextCursor, null);
    assert.deepEqual(f.provider()!.nativeListCalls, [undefined, cursor]);
    // Even a provider returning an unfiltered page cannot leak another project's titles.
    f.provider()!.listNativeSessions = async () => ({
      sessions: [f.foreign, f.child, f.first],
      nextCursor: null,
    });
    const mixedPage = await f.agent().app.inject({ url: f.listUrl, headers: f.headers });
    assert.equal(mixedPage.statusCode, 200, mixedPage.body);
    assert.deepEqual(
      mixedPage.json().sessions.map((session: { id: string }) => session.id),
      [f.first.id],
    );
    assert.ok(!mixedPage.body.includes(f.foreign.title));
    assert.ok(!mixedPage.body.includes(f.child.title));

    const [firstImport, repeatedImport] = await Promise.all([f.importSession(), f.importSession()]);
    assert.equal(firstImport.statusCode, 200, firstImport.body);
    assert.equal(repeatedImport.statusCode, 200, repeatedImport.body);
    const conversation = firstImport.json().conversation as Conversation;
    assert.equal(repeatedImport.json().conversation.id, conversation.id);
    assert.equal(conversation.providerSessionId, f.first.id);
    assert.equal(conversation.workspaceId, f.workspace.id);
    assert.equal(conversation.title, f.first.title);
    assert.equal(f.agent().store.list<Conversation>('conversation').length, 1);
    assert.equal('trusted' in f.agent().manager.workspace(f.workspace.id), false);
    const submitted = await f.agent().app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/runs`,
      headers: f.headers,
      payload: {
        clientRequestId: randomUUID(),
        text: 'Continue without a project confirmation',
        model: 'fixture-model',
        permissionMode: 'workspace-write',
      },
    });
    assert.equal(submitted.statusCode, 200, submitted.body);
    await until(() => f.run(submitted.json().run.id).state === 'running');
    assert.equal(f.provider()!.starts.length, 1);
    f.provider()!.complete();
    assert.equal(f.run(submitted.json().run.id).state, 'completed');
  } finally {
    await f.close();
  }
});

test('native session import rejects another workspace, descendants, missing threads and replaced directories', async () => {
  const f = await fixture();
  try {
    for (const session of [f.foreign, f.child]) {
      const response = await f.importSession(session.id);
      assert.equal(response.statusCode, 403, response.body);
      assert.ok(!response.body.includes(session.title));
    }
    const missing = await f.importSession(randomUUID());
    assert.ok(missing.statusCode >= 400);
    assert.equal(f.agent().store.list<Conversation>('conversation').length, 0);
    const invalid = await f.importSession('');
    assert.equal(invalid.statusCode, 400);
    await rename(f.project, f.project + '-old');
    await mkdir(f.project);
    const replacedList = await f.agent().app.inject({ url: f.listUrl, headers: f.headers });
    assert.ok(replacedList.statusCode >= 400, replacedList.body);
    const replacedImport = await f.importSession();
    assert.ok(replacedImport.statusCode >= 400, replacedImport.body);
    assert.equal(f.agent().store.list<Conversation>('conversation').length, 0);
  } finally {
    await f.close();
  }
});

test('imported sessions survive restart, refresh IDE history, resume the original thread and avoid duplicate local turns', async () => {
  const f = await fixture();
  try {
    const imported = await f.importSession();
    assert.equal(imported.statusCode, 200, imported.body);
    const conversation = imported.json().conversation as Conversation;
    await f.restart();
    assert.equal(f.agent().manager.conversation(conversation.id).providerSessionId, f.first.id);
    assert.equal((await f.importSession()).json().conversation.id, conversation.id);

    const detailUrl = `/conversations/${conversation.id}`;
    const detail = await f.agent().app.inject({ url: detailUrl, headers: f.headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().nativeHistory.id, f.first.id);
    assert.deepEqual(detail.json().nativeHistory.turns, f.first.turns);
    f.first.turns.push({
      id: randomUUID(),
      state: 'completed',
      userText: 'Later IDE fixture question',
      messages: [{ id: randomUUID(), kind: 'assistant', text: 'Later IDE fixture answer' }],
    });
    const refreshed = await f.agent().app.inject({ url: detailUrl, headers: f.headers });
    assert.equal(refreshed.json().nativeHistory.turns.length, 2);

    const submitted = await f.agent().app.inject({
      method: 'POST',
      url: `${detailUrl}/runs`,
      headers: f.headers,
      payload: {
        clientRequestId: randomUUID(),
        text: 'Continue the same thread from Relay',
        model: 'fixture-model',
        reasoningEffort: 'medium',
        permissionMode: 'workspace-write',
      },
    });
    assert.equal(submitted.statusCode, 200, submitted.body);
    const runId = submitted.json().run.id;
    await until(() => f.run(runId).state === 'running');
    const provider = f.provider()!;
    assert.deepEqual(provider.resumes, [{ id: f.first.id }]);
    assert.equal(provider.starts.length, 1);
    assert.equal(provider.starts[0].sessionId, f.first.id);
    provider.emit('message.completed', { itemId: 'relay-reply', text: 'Local Relay fixture answer' });
    const localTurnId = f.run(runId).providerTurnId!;
    f.first.turns.push({
      id: localTurnId,
      state: 'completed',
      userText: provider.starts[0].text,
      messages: [{ id: 'relay-reply', kind: 'assistant', text: 'Local Relay fixture answer' }],
    });
    provider.complete();
    await until(() => provider.releases.includes(f.first.id));
    const completed = await f.agent().app.inject({ url: detailUrl, headers: f.headers });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual(
      completed.json().nativeHistory.turns.map((turn: { id: string }) => turn.id),
      f.first.turns.slice(0, 2).map((turn) => turn.id),
    );
    assert.equal(completed.json().runs.filter((run: Run) => run.providerTurnId === localTurnId).length, 1);
    assert.equal(
      completed
        .json()
        .messages.filter((message: { text: string }) => message.text === 'Local Relay fixture answer').length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('observing an external turn preserves unknown, running and terminal states without taking ownership', async () => {
  const f = await fixture();
  try {
    const turn = f.first.turns[0];
    turn.state = 'unknown';
    f.first.status = 'notLoaded';
    const imported = await f.importSession();
    assert.equal(imported.statusCode, 200, imported.body);
    const conversation = imported.json().conversation as Conversation;
    const detailUrl = `/conversations/${conversation.id}`;
    for (const state of ['unknown', 'running', 'completed', 'interrupted'] as const) {
      turn.state = state;
      turn.messages[0].text = `External client state: ${state}`;
      const detail = await f.agent().app.inject({ url: detailUrl, headers: f.headers });
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(detail.json().nativeHistory.turns[0].state, state);
      assert.equal(detail.json().nativeHistory.turns[0].messages[0].text, turn.messages[0].text);
      assert.deepEqual(detail.json().runs, []);
    }
    for (const provider of f.providers) {
      assert.deepEqual(provider.resumes, []);
      assert.deepEqual(provider.starts, []);
      assert.deepEqual(provider.interrupts, []);
      assert.deepEqual(provider.releases, []);
    }
    assert.equal(f.agent().store.list<Run>('run').length, 0);
  } finally {
    await f.close();
  }
});

test('a native history read failure preserves the Relay conversation and reports a recoverable history error', async () => {
  const f = await fixture();
  try {
    const imported = await f.importSession();
    assert.equal(imported.statusCode, 200, imported.body);
    const conversation = imported.json().conversation as Conversation;
    f.provider()!.nativeHistoryError = new Error('Native history unavailable in fixture');
    const detail = await f.agent().app.inject({
      url: `/conversations/${conversation.id}`,
      headers: f.headers,
    });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().conversation.id, conversation.id);
    assert.ok(detail.json().nativeHistoryError);
    assert.equal(detail.json().runs.length, 0);
    assert.equal(f.agent().manager.conversation(conversation.id).providerSessionId, f.first.id);
    f.provider()!.nativeHistoryError = undefined;
    const recovered = await f.agent().app.inject({
      url: `/conversations/${conversation.id}`,
      headers: f.headers,
    });
    assert.equal(recovered.json().nativeHistory.id, f.first.id);
  } finally {
    await f.close();
  }
});

test('a fast completed turn waits for its start acknowledgement before releasing the native session and adapter', async () => {
  const acknowledged = barrier();
  let firstStart = true;
  const f = await fixture((provider) => {
    provider.disposeAfterRun = true;
    const start = provider.startRun.bind(provider);
    provider.startRun = async (input) => {
      const ref = await start(input);
      if (firstStart) {
        firstStart = false;
        provider.complete('completed', ref);
        await acknowledged.promise;
      }
      return ref;
    };
  });
  try {
    const imported = await f.importSession();
    assert.equal(imported.statusCode, 200, imported.body);
    const conversation = imported.json().conversation as Conversation;
    const input = (text: string) => ({
      clientRequestId: randomUUID(),
      text,
      model: 'fixture-model',
      permissionMode: 'workspace-write' as const,
    });
    const first = await f.agent().manager.submit(conversation.id, input('Fast native fixture turn'));
    await until(() => f.run(first.id).state === 'completed');
    const provider = f.provider()!;
    assert.equal(provider.closes, 0);
    assert.deepEqual(provider.releases, []);
    const second = await f.agent().manager.submit(conversation.id, input('Queued after native completion'));
    assert.equal(f.run(second.id).state, 'queued');
    acknowledged.release();
    await until(() => provider.closes === 1);
    assert.deepEqual(provider.releases, [f.first.id]);
    await until(() => f.run(second.id).state === 'running');
    assert.notEqual(f.provider(), provider);
    assert.deepEqual(f.provider()!.resumes, [{ id: f.first.id }]);
    f.provider()!.complete();
    await until(() => f.provider()!.releases.includes(f.first.id));
    assert.equal(f.run(first.id).state, 'completed');
    assert.equal(f.run(second.id).state, 'completed');
  } finally {
    acknowledged.release();
    await f.close();
  }
});

test('question recovery matches live content despite regenerated history IDs and never overwrites an unrelated item', async () => {
  const f = await fixture();
  try {
    const conversation = (await f.importSession()).json().conversation as Conversation;
    const run = await f.agent().manager.submit(conversation.id, {
      clientRequestId: randomUUID(),
      text: 'Question recovery',
      model: 'fixture-model',
      reasoningEffort: 'medium',
      permissionMode: 'read-only',
    });
    await until(() => f.run(run.id).state === 'running');
    const provider = f.provider()!;
    const questions = [{ title: 'Which IP?', options: null }];
    // Simulate an old live record that dropped structured questions.
    provider.emit('message.completed', { itemId: 'call-live', text: 'Which IP?' });
    provider.emit('message.completed', { itemId: 'item-3', text: 'Keep this explanation' });
    await until(() => !!f.agent().store.get('message', `${run.id}:call-live`));
    const turn = {
      id: f.run(run.id).providerTurnId!,
      state: 'running' as const,
      userText: 'Question recovery',
      messages: [{ id: 'item-3', kind: 'assistant' as const, text: 'Which IP?', questions }],
    };
    f.first.turns.push(turn);
    for (const id of ['item-3', 'item-12', 'item-27']) {
      turn.messages[0].id = id;
      await f.agent().manager.nativeHistory(conversation.id);
      const stored = f
        .agent()
        .store.list<import('../../apps/agent/src/manager.ts').Message>('message')
        .filter((m) => m.runId === run.id);
      assert.equal(stored.length, 2);
      assert.deepEqual(stored.find((m) => m.id.endsWith(':call-live'))!.payload.questions, questions);
      const explanation = stored.find((m) => m.id.endsWith(':item-3'))!;
      assert.equal(explanation.text, 'Keep this explanation');
      assert.equal(explanation.payload.questions, undefined);
    }
    // Recovery without any live record must also survive changing item IDs.
    turn.messages.push({
      id: 'history-only',
      kind: 'assistant',
      text: 'Second question',
      questions: [{ title: 'Second question', options: null }],
    });
    await f.agent().manager.nativeHistory(conversation.id);
    turn.messages[1].id = 'history-renumbered';
    await f.agent().manager.nativeHistory(conversation.id);
    assert.equal(
      f
        .agent()
        .store.list<import('../../apps/agent/src/manager.ts').Message>('message')
        .filter((m) => m.runId === run.id).length,
      3,
    );
    provider.complete();
  } finally {
    await f.close();
  }
});

test('custom Relay titles survive restart and appear in native listings without changing native history', async () => {
  const f = await fixture();
  try {
    const conversation = (await f.importSession()).json().conversation as Conversation;
    const url = `/conversations/${conversation.id}/title`;
    assert.equal(
      (await f.agent().app.inject({ method: 'POST', url, payload: { title: 'Private' } })).statusCode,
      401,
    );
    for (const title of ['', '   ', 'x'.repeat(201)]) {
      assert.equal(
        (await f.agent().app.inject({ method: 'POST', url, headers: f.headers, payload: { title } }))
          .statusCode,
        400,
      );
    }
    const result = await f
      .agent()
      .app.inject({ method: 'POST', url, headers: f.headers, payload: { title: '  我的审查记录  ' } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().conversation.title, '我的审查记录');
    await f.restart();
    assert.equal(f.agent().manager.conversation(conversation.id).title, '我的审查记录');
    const listed = await f.agent().app.inject({ url: f.listUrl, headers: f.headers });
    assert.equal(
      listed.json().sessions.find((s: { id: string }) => s.id === f.first.id).title,
      '我的审查记录',
    );
    assert.equal(f.first.title, 'First IDE fixture session');
  } finally {
    await f.close();
  }
});

test('summary snapshots omit messages and local history pages are bounded, complete and independent of native reads', async () => {
  const f = await fixture();
  try {
    const conversation = (await f.importSession()).json().conversation as Conversation;
    const runIds: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = randomUUID();
      runIds.push(id);
      f.agent().store.put('run', id, {
        id,
        conversationId: conversation.id,
        workspaceId: f.workspace.id,
        state: 'completed',
        text: 'Prompt ' + i,
        createdAt: new Date(1000 * i).toISOString(),
      });
      f.agent().store.put('message', 'm' + id, {
        id: 'm' + id,
        runId: id,
        conversationId: conversation.id,
        workspaceId: f.workspace.id,
        kind: 'assistant',
        text: 'x'.repeat(8000),
        payload: {},
        createdAt: new Date(1000 * i).toISOString(),
      });
    }
    const summary = await f.agent().app.inject({ url: '/snapshot?view=summary', headers: f.headers });
    assert.deepEqual(summary.json().messages, []);
    assert.equal(summary.json().runs.length, 15);
    f.provider()!.nativeHistoryError = new Error('Slow or unavailable Codex');
    let before: string | null = null;
    const seen: string[] = [];
    do {
      const response: { statusCode: number; body: string; json: () => any } = await f.agent().app.inject({
        url: `/conversations/${conversation.id}?view=page${before ? '&before=' + before : ''}`,
        headers: f.headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      const page: {
        runs: Run[];
        messages: unknown[];
        events?: unknown;
        nativeHistory?: unknown;
        nativeHistoryError?: string;
        seq: number;
        nextBefore: string | null;
      } = response.json();
      assert.ok(page.runs.length <= 6);
      assert.equal(page.messages.length, page.runs.length);
      assert.equal(page.events, undefined);
      assert.equal(page.nativeHistory, undefined);
      assert.equal(page.nativeHistoryError, undefined);
      assert.equal(typeof page.seq, 'number');
      seen.unshift(...page.runs.map((r: Run) => r.id));
      before = page.nextBefore;
    } while (before);
    assert.deepEqual(seen, runIds);
    const active = f.agent().store.require<Run>('run', runIds[0]);
    f.agent().store.put('run', active.id, { ...active, state: 'running' });
    const withActive = f.agent().manager.conversationPage(conversation.id, 6);
    assert.equal(withActive.runs.length, 7);
    assert.equal(withActive.runs[0].id, active.id);
    assert.ok(withActive.messages.some((message) => message.runId === active.id));
    assert.equal(withActive.nextBefore, runIds[9]);
    const invalid = await f
      .agent()
      .app.inject({ url: `/conversations/${conversation.id}?view=page&before=unknown`, headers: f.headers });
    assert.equal(invalid.statusCode, 400);
    const native = await f
      .agent()
      .app.inject({ url: `/conversations/${conversation.id}?view=native`, headers: f.headers });
    assert.ok(native.json().nativeHistoryError);
    assert.equal(native.json().messages, undefined);
    assert.equal(native.json().events, undefined);
  } finally {
    await f.close();
  }
});
