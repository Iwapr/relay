import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { instanceConfigs, startInstance } from '../../scripts/serve-instance.ts';

const run = promisify(execFile);
test('template release publication and migration checks', async () => {
  await run('python3', ['tests/integration/relay_service_test.py']);
});

test('systemd accepts the relay template with its privileged build hook', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-unit-'));
  try {
    const unit = (await readFile('deploy/systemd/relay@.service', 'utf8')).replaceAll(
      '/usr/local/libexec/relay-service',
      '/usr/bin/python3',
    );
    const path = join(dir, 'relay@.service');
    await writeFile(path, unit);
    await run('systemd-analyze', ['verify', path]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('combined service preserves private configuration, rejects a duplicate, and releases listeners', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-run-'));
  const socketPath = join(dir, 'agent/control.sock');
  const tokenFile = join(dir, 'agent/token');
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const descriptor = join(dir, 'instance.json');
  const agentPath = join(dir, 'agent.json');
  const gatewayPath = join(dir, 'gateway.json');
  const agent = {
    stateDir: join(dir, 'agent'),
    socketPath,
    tokenFile,
    roots: [dir],
    codexExecutable: '/old/codex',
  };
  const gateway = {
    publicOrigin: origin,
    stateDir: join(dir, 'gateway'),
    host: '127.0.0.1',
    port,
    secureCookies: false,
    owner: {
      id: 'owner',
      username: 'owner',
      passwordHash: `scrypt$32768$8$1$${'a'.repeat(32)}$${'b'.repeat(128)}`,
    },
    profiles: [],
  };
  let instance: Awaited<ReturnType<typeof startInstance>> | undefined;
  try {
    await mkdir(join(dir, 'apps/web/dist'), { recursive: true });
    await mkdir(join(dir, 'agent'), { mode: 0o700 });
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    await writeFile(join(dir, 'apps/web/dist/index.html'), 'published frontend');
    await writeFile(agentPath, JSON.stringify(agent), { mode: 0o600 });
    await writeFile(gatewayPath, JSON.stringify(gateway), { mode: 0o600 });
    await writeFile(
      descriptor,
      JSON.stringify({ user: userInfo().username, agentConfig: agentPath, gatewayConfig: gatewayPath }),
    );
    const config = await instanceConfigs(descriptor, dir);
    assert.equal(config.agent.codexExecutable, join(dir, 'codex/codex'));
    assert.equal(config.gateway.staticDir, join(dir, 'apps/web/dist'));
    instance = await startInstance(descriptor, dir);
    assert.equal((await fetch(origin + '/health')).status, 200);
    assert.equal(await (await fetch(origin)).text(), 'published frontend');
    await assert.rejects(startInstance(descriptor, dir), /already using this instance/);
    assert.equal((await fetch(origin + '/health')).status, 200);
    assert.deepEqual(JSON.parse(await readFile(agentPath, 'utf8')), agent);
    assert.deepEqual(JSON.parse(await readFile(gatewayPath, 'utf8')), gateway);
    await instance.close();
    instance = undefined;
    // A failed Gateway startup must close the Agent as well.
    await new Promise<void>((resolve) => reserve.listen(port, '127.0.0.1', resolve));
    await assert.rejects(startInstance(descriptor, dir), /EADDRINUSE/);
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    instance = await startInstance(descriptor, dir);
    assert.equal((await fetch(origin + '/health')).status, 200);
  } finally {
    await instance?.close();
    reserve.close();
    await rm(dir, { recursive: true, force: true });
  }
});
