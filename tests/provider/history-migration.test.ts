import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { migrateHistory } from '../../packages/provider-codex/src/migrate-history.ts';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-history-migration-'));
  const source = join(dir, 'old'),
    target = join(dir, 'shared');
  const path = 'sessions/2026/09/21/rollout-2026-09-21-thread-123.jsonl';
  await mkdir(join(source, 'sessions/2026/09/21'), { recursive: true });
  await mkdir(target);
  const rollout = JSON.stringify({ type: 'session_meta', payload: { id: 'thread-123' } }) + '\n';
  await writeFile(join(source, path), rollout);
  await writeFile(join(source, 'auth.json'), 'private old auth');
  await writeFile(join(source, 'state_5.sqlite'), 'private old index');
  await writeFile(join(target, 'auth.json'), 'VS Code auth');
  return { dir, source, target, path, rollout, close: () => rm(dir, { recursive: true, force: true }) };
}

test('history migration preserves IDs, credentials and originals; repeated migration preserves newer shared turns', async () => {
  const f = await fixture();
  try {
    await migrateHistory(f.source, f.target);
    assert.equal(await readFile(join(f.target, f.path), 'utf8'), f.rollout);
    assert.equal(await readFile(join(f.source, f.path), 'utf8'), f.rollout);
    assert.equal(await readFile(join(f.target, 'auth.json'), 'utf8'), 'VS Code auth');
    await assert.rejects(readFile(join(f.target, 'state_5.sqlite')), { code: 'ENOENT' });
    await writeFile(join(f.target, f.path), f.rollout + 'new shared turn\n');
    await migrateHistory(f.source, f.target);
    assert.equal(await readFile(join(f.target, f.path), 'utf8'), f.rollout + 'new shared turn\n');
    await writeFile(join(f.source, f.path), f.rollout + 'conflicting legacy turn\n');
    await assert.rejects(migrateHistory(f.source, f.target), /迁移/);
    assert.equal(await readFile(join(f.target, f.path), 'utf8'), f.rollout + 'new shared turn\n');
  } finally {
    await f.close();
  }
});

test('migration refuses occupied native sessions and symlink destinations', async () => {
  const f = await fixture();
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(join(f.source, 'thread-writer-locks'));
    holder = spawn(
      'python3',
      [
        '-I',
        '-S',
        '-c',
        'import fcntl,sys; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()',
        join(f.source, 'thread-writer-locks/thread-123.lock'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    await once(holder.stdout!, 'data');
    await assert.rejects(migrateHistory(f.source, f.target), /仍在运行/);
    holder.stdin!.end();
    await once(holder, 'exit');
    holder = undefined;
    await symlink(join(f.source, 'sessions'), join(f.target, 'sessions'));
    await assert.rejects(migrateHistory(f.source, f.target), /迁移/);
    assert.equal(await readFile(join(f.source, f.path), 'utf8'), f.rollout);
  } finally {
    holder?.kill();
    await f.close();
  }
});
