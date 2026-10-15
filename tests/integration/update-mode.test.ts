import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedUpdateCommand } from '../../scripts/update-mode.ts';

test('update automatically targets all shared users, with sudo only when needed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-update-mode-'));
  try {
    const root = join(dir, 'source');
    const config = join(dir, 'source.json');
    await mkdir(root);
    assert.equal(await sharedUpdateCommand(root, [], config, 1000), null);
    await writeFile(config, JSON.stringify({ source: root }));
    assert.deepEqual(await sharedUpdateCommand(root, [], config, 1000), {
      program: 'sudo',
      args: ['python3', join(root, 'scripts/relay-service.py'), 'update'],
    });
    assert.deepEqual(await sharedUpdateCommand(root, ['--check'], config, 0), {
      program: 'python3',
      args: [join(root, 'scripts/relay-service.py'), 'update', '--check'],
    });
    const alias = join(dir, 'alias');
    await symlink(root, alias);
    assert.equal((await sharedUpdateCommand(alias, [], config, 1000))?.program, 'sudo');
    assert.equal(await sharedUpdateCommand(dir, [], config, 1000), null);
    await writeFile(config, 'broken registration');
    await assert.rejects(sharedUpdateCommand(root, [], config, 1000));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
