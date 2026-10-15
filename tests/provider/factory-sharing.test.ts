import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { FactoryAdapter } from '../../packages/provider-factory/src/index.ts';
import { writeFactoryKey } from '../../packages/provider-factory/src/credentials.ts';
import { migrateFactoryHistory } from '../../packages/provider-factory/src/migrate-history.ts';
import { sessionHistory, sessionSummary } from '../../packages/provider-factory/src/history.ts';
import { factoryFixtureExecutable } from '../helpers/factory-process.ts';
import { until } from '../helpers/mock-provider.ts';
import { Store } from '../../apps/agent/src/store.ts';

test('Droid resumes the same native session with another account key and shares durable, deduplicated turns', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'droid-sharing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'),
    sessionHome = join(root, 'shared');
  await mkdir(cwd);
  const executable = await factoryFixtureExecutable(root);
  await writeFile(
    executable,
    (await readFile(executable, 'utf8')).replace(
      'const home=process.env.HOME;',
      `const home=process.env.HOME;\nfs.appendFileSync(path.join(home,'keys'),crypto.createHash('sha256').update(process.env.FACTORY_API_KEY).digest('hex')+'\\n');`,
    ),
  );
  let id = '';
  const turns: string[] = [];
  for (const account of ['a', 'b']) {
    const home = join(root, account);
    await writeFactoryKey(home, 'fk-' + account);
    const adapter = new FactoryAdapter({ cwd, home, sessionHome, executable });
    t.after(() => adapter.close());
    const options = { cwd, model: 'fixture-opus', permissionMode: 'workspace-write' as const };
    if (!id) id = (await adapter.createSession(options)).id;
    else {
      assert.equal((await adapter.listNativeSessions(undefined, 'all')).sessions[0].id, id);
      assert.equal((await adapter.readNativeSession(id)).turns[0].userText, 'first');
      await adapter.resumeSession({ id }, options);
    }
    let done = false;
    adapter.subscribeEvents((e) => {
      if (e.type === 'run.completed') done = true;
      if (e.type === 'run.failed') assert.fail(JSON.stringify(e.payload));
    });
    const run = await adapter.startRun({
      ...options,
      sessionId: id,
      text: account === 'a' ? 'first' : 'second',
    });
    turns.push(run.turnId);
    await until(() => done);
    await adapter.close();
  }
  const history = await sessionHistory(sessionHome, id);
  assert.deepEqual(
    history.turns.map((t) => t.id),
    turns,
  );
  assert.deepEqual(
    history.turns.map((t) => t.messages[0].text),
    ['Droid first', 'Droid second'],
  );
  const nativeIds = (await readFile(join(sessionHome, 'fixture-sessions'), 'utf8')).trim().split('\n');
  assert.equal(nativeIds.length, 2);
  assert.equal(nativeIds[0], nativeIds[1]);
  assert.deepEqual(
    (await readFile(join(sessionHome, 'keys'), 'utf8')).trim().split('\n'),
    ['a', 'b'].map((a) =>
      createHash('sha256')
        .update('fk-' + a)
        .digest('hex'),
    ),
  );
  await assert.rejects(stat(join(sessionHome, 'relay-credential.json')), { code: 'ENOENT' });
  assert.equal((await sessionHistory(sessionHome, id, 1)).hasOlderTurns, true);
  await assert.rejects(sessionSummary(sessionHome, '../a/relay-credential'));
});

test('Droid migration preserves native IDs and old Relay turns, excludes credentials, and never overwrites continued history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'droid-migrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'old'),
    target = join(root, 'shared'),
    id = randomUUID(),
    native = randomUUID(),
    turn = randomUUID();
  await mkdir(join(source, 'relay-sessions'), { recursive: true });
  await mkdir(join(source, '.factory', 'sessions', '-project'), { recursive: true });
  await writeFile(
    join(source, 'relay-sessions', id + '.json'),
    JSON.stringify({ cwd: '/project', nativeId: native }),
  );
  const nativeFile = join('.factory', 'sessions', '-project', native + '.jsonl');
  await writeFile(join(source, nativeFile), 'original');
  await writeFactoryKey(source, 'fk-do-not-copy');
  const store = new Store(join(root, 'state'), 'test');
  store.put('conversation', 'c', { id: 'c', providerId: 'factory', providerSessionId: id });
  store.put('run', 'r', {
    id: 'r',
    conversationId: 'c',
    providerTurnId: turn,
    text: 'old prompt',
    state: 'completed',
    createdAt: '2026-01-01T00:00:00Z',
  });
  store.put('message', 'm', {
    id: 'm',
    runId: 'r',
    kind: 'assistant',
    text: 'old reply',
    payload: { itemId: 'native-message' },
  });
  store.db.close();
  await migrateFactoryHistory(source, target, join(root, 'state', 'agent.sqlite'));
  assert.equal((await sessionHistory(target, id)).turns[0].messages[0].text, 'old reply');
  assert.equal(
    JSON.parse(await readFile(join(target, 'relay-sessions', id + '.json'), 'utf8')).nativeId,
    native,
  );
  await assert.rejects(stat(join(target, 'relay-credential.json')), { code: 'ENOENT' });
  await writeFile(join(target, nativeFile), 'continued');
  await migrateFactoryHistory(source, target, join(root, 'state', 'agent.sqlite'));
  assert.equal(await readFile(join(target, nativeFile), 'utf8'), 'continued');
  assert.equal(await readFile(join(source, nativeFile), 'utf8'), 'original');
  const other = join(root, 'conflict');
  await mkdir(join(other, '.factory', 'sessions', '-project'), { recursive: true });
  await writeFile(join(other, nativeFile), 'different');
  await assert.rejects(migrateFactoryHistory(other, target), /冲突/);
});
