import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FileService } from '../../apps/agent/src/files.ts';
import { LockManager } from '../../apps/agent/src/locks.ts';

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'workbench-lock-'));
  const project = path.join(base, 'project');
  const privateDirectory = path.join(base, 'private');
  await mkdir(path.join(project, 'child'), { recursive: true });
  await mkdir(path.join(base, 'other'));
  await mkdir(privateDirectory, { mode: 0o700 });
  const files = await FileService.create({ roots: [base], privateDirectory });
  return {
    base,
    project,
    privateDirectory,
    files,
    workspace: await files.openWorkspace(project),
    close: async () => {
      await files.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('separate lock managers serialize aliases and ancestor/descendant workspaces', async () => {
  const f = await fixture();
  const a = await LockManager.create({ privateDirectory: f.privateDirectory, machineId: 'same-host' });
  const b = await LockManager.create({ privateDirectory: f.privateDirectory, machineId: 'same-host' });
  try {
    const first = await a.acquire(f.workspace, 'run-a');
    await assert.rejects(b.acquire(f.workspace, 'run-b'), { code: 'run_conflict' });
    await assert.rejects(b.acquire(await f.files.openWorkspace(path.join(f.project, 'child')), 'run-child'), {
      code: 'run_conflict',
    });
    const unrelated = await b.acquire(await f.files.openWorkspace(path.join(f.base, 'other')), 'run-other');
    await unrelated.release();
    await first.release();
    const next = await b.acquire(f.workspace, 'run-next');
    await next.release();
    const child = await a.acquire(
      await f.files.openWorkspace(path.join(f.project, 'child')),
      'run-child-first',
    );
    await assert.rejects(b.acquire(f.workspace, 'run-parent'), { code: 'run_conflict' });
    await child.release();
  } finally {
    await a.close();
    await b.close();
    await f.close();
  }
});

test('shared directory requires administrator configured lock service directory', async () => {
  const f = await fixture();
  await chmod(f.base, 0o755);
  await chmod(f.project, 0o2770);
  const workspace = await f.files.openWorkspace(f.project);
  const local = await LockManager.create({ privateDirectory: f.privateDirectory, machineId: 'host' });
  try {
    assert.equal(workspace.shared, true);
    await assert.rejects(local.acquire(workspace, 'unsafe'), { code: 'shared_lock_required' });
    const shared = path.join(f.base, 'shared-locks');
    await mkdir(shared);
    await chmod(shared, 0o2770);
    const a = await LockManager.create({
      privateDirectory: f.privateDirectory,
      machineId: 'host',
      sharedLockDirectory: shared,
    });
    const b = await LockManager.create({
      privateDirectory: f.privateDirectory,
      machineId: 'host',
      sharedLockDirectory: shared,
    });
    const lease = await a.acquire(workspace, 'one');
    await assert.rejects(b.acquire(workspace, 'two'), { code: 'run_conflict' });
    await lease.release();
    const next = await b.acquire(workspace, 'two');
    await next.release();
    await a.close();
    await b.close();
  } finally {
    await local.close();
    await f.close();
  }
});

test('0755 projects with shared files require cross-user locks unless protected by a private ancestor', async () => {
  const f = await fixture();
  const local = await LockManager.create({ privateDirectory: f.privateDirectory, machineId: 'host' });
  try {
    await chmod(f.base, 0o755);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(f.project, 'shared.tex'), 'shared project file', { mode: 0o664 });
    await chmod(path.join(f.project, 'shared.tex'), 0o664);
    await chmod(f.project, 0o755);
    const exposed = await f.files.openWorkspace(f.project);
    assert.equal(exposed.shared, true);
    await assert.rejects(local.acquire(exposed, 'missing-shared-lock'), { code: 'shared_lock_required' });
    await chmod(f.base, 0o700);
    const privateWorkspace = await f.files.openWorkspace(f.project);
    assert.equal(privateWorkspace.shared, false);
    const lease = await local.acquire(privateWorkspace, 'private-ancestor');
    await lease.release();
  } finally {
    await local.close();
    await f.close();
  }
});

test('unconfirmed execution leaves durable lease across manager restart', async () => {
  const f = await fixture();
  const a = await LockManager.create({ privateDirectory: f.privateDirectory, machineId: 'host' });
  try {
    const lease = await a.acquire(f.workspace, 'uncertain');
    await lease.release({ uncertain: true });
    const restarted = await LockManager.create({ privateDirectory: f.privateDirectory, machineId: 'host' });
    await assert.rejects(restarted.acquire(f.workspace, 'must-not-repeat'), { code: 'uncertain_operation' });
    // Explicit operator recovery only after external execution was verified.
    await rm(lease.record);
    const next = await restarted.acquire(f.workspace, 'verified-safe');
    await next.release();
    await restarted.close();
  } finally {
    await a.close();
    await f.close();
  }
});
