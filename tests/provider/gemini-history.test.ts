import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { GeminiAdapter } from '../../packages/provider-gemini/src/index.ts';
import { geminiExecutable } from '../helpers/gemini-process.ts';
import { until } from '../helpers/mock-provider.ts';
import type { ProviderEvent } from '../../packages/provider-core/src/index.ts';
test('Gemini native discovery preserves aliases, excludes subagents, resumes without replaying opaque history and refuses busy sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-gemini-history-'));
  const dir = join(home, '.gemini', 'antigravity-cli');
  await mkdir(dir, { recursive: true });
  await mkdir(join(home, 'relay-sessions'));
  const db = new DatabaseSync(join(dir, 'conversation_summaries.db'));
  db.exec(
    'CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,workspace_uris TEXT,last_modified_time TEXT,status TEXT,not_fully_idle INTEGER,parent_conversation_id TEXT,nesting_depth INTEGER)',
  );
  const add = (id: string, cwd: string, busy = 0, parent = '') =>
    db
      .prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?,?,?)')
      .run(
        id,
        'Native task',
        JSON.stringify([pathToFileURL(cwd).href]),
        new Date().toISOString(),
        'CASCADE_RUN_STATUS_IDLE',
        busy,
        parent,
        0,
      );
  const native = randomUUID(),
    alias = randomUUID(),
    busy = randomUUID(),
    external = randomUUID();
  add(native, home);
  add(busy, home, 1);
  add(external, '/other-project');
  add(randomUUID(), home, 0, native);
  await writeFile(join(home, 'relay-sessions', alias + '.json'), JSON.stringify({ nativeId: native }));
  const executable = await geminiExecutable(home),
    adapter = new GeminiAdapter({ cwd: home, home, executable });
  try {
    const local = await adapter.listNativeSessions();
    assert.equal(local.sessions.length, 2);
    assert.ok(local.sessions.some((s) => s.id === alias));
    assert.equal((await adapter.listNativeSessions(undefined, 'all')).sessions.length, 3);
    assert.equal((await adapter.readNativeSession(alias)).truncated, true);
    await assert.rejects(adapter.resumeSession({ id: busy }), /另一进程/);
    await assert.rejects(adapter.resumeSession({ id: randomUUID() }), /新建会话/);
    const events: ProviderEvent[] = [];
    adapter.subscribeEvents((e) => events.push(e));
    await adapter.resumeSession({ id: alias });
    await adapter.startRun({
      sessionId: alias,
      cwd: home,
      model: 'gemini-3.1-pro-high',
      text: 'hello',
      permissionMode: 'workspace-write',
    });
    await until(() => events.some((e) => e.type === 'run.completed'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_summaries').get()?.n, 4);
  } finally {
    await adapter.close();
    db.close();
    await rm(home, { recursive: true, force: true });
  }
});
