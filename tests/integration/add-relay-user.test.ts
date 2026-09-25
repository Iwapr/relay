import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const run = promisify(execFile);

test('add-user administrator workflow validates ports and registers only the new instance', async () => {
  await run('python3', ['tests/integration/add_relay_user_test.py']);
});

test('new instance gets independent credentials, shared roots and proxy trust without copying Codex auth', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-new-user-'));
  try {
    const options = { sharedProjects: true, trustedProxyIps: ['100.64.0.20'] };
    const args = [
      '--import',
      'tsx',
      'scripts/setup-user-instance.ts',
      '4085',
      '192.168.10.20',
      '100.64.0.10',
    ];
    const env = { ...process.env, HOME: home, RELAY_SETUP_OPTIONS: JSON.stringify(options) };
    const result = await run(resolve('node_modules/node/bin/node'), args, { env });
    const directory = join(home, '.local/share/relay-instance');
    const read = async (name: string) => JSON.parse(await readFile(join(directory, name), 'utf8'));
    const agent = await read('agent.json');
    const gateway = await read('gateway.json');
    assert.deepEqual(agent.roots, [home, '/srv/projects']);
    assert.equal(agent.sharedLockDirectory, '/var/lib/relay/shared-workspace-locks');
    assert.equal(agent.taskUmask, '0002');
    assert.deepEqual(gateway.trustedProxyIps, options.trustedProxyIps);
    assert.equal(gateway.port, 4085);
    assert.equal(gateway.profiles[0].expectedIdentity.home, home);
    assert.equal(agent.codexHome, undefined);
    assert.equal(agent.authHome, undefined);
    await assert.rejects(stat(join(home, '.codex')), { code: 'ENOENT' });
    const token = await readFile(join(directory, 'agent.token'), 'utf8');
    const passwordFile = await readFile(join(directory, 'login.txt'), 'utf8');
    assert.ok(token.trim().length >= 32);
    assert.ok(!result.stdout.includes(token.trim()));
    assert.ok(!result.stdout.includes(passwordFile.split('密码：')[1].trim()));
    for (const name of ['agent.json', 'gateway.json', 'agent.token', 'login.txt'])
      assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
    await run(resolve('node_modules/node/bin/node'), args, { env });
    assert.equal(await readFile(join(directory, 'agent.token'), 'utf8'), token);
    assert.equal(await readFile(join(directory, 'login.txt'), 'utf8'), passwordFile);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
