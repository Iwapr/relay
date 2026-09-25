import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installOptions } from '../../scripts/install-options.ts';
import { SUPPORTED_CODEX_VERSION } from '../../packages/provider-codex/src/protocol.ts';
import { unitText } from '../../scripts/service-utils.ts';
const exec = promisify(execFile);

test('installer options reject ambiguous paths and ports without weakening host validation', () => {
  assert.deepEqual(
    installOptions(['--yes', '--foreground', '--host', '127.0.0.1', '--port', '4089', '--root', '/projects']),
    { yes: true, foreground: true, host: '127.0.0.1', port: 4089, root: '/projects' },
  );
  for (const args of [
    ['--port', '0'],
    ['--port', '65536'],
    ['--port', '1e4'],
    ['--root', 'relative'],
    ['--codex', 'codex'],
    ['--host'],
    ['--wat'],
  ])
    assert.throws(() => installOptions(args));
  assert.match(
    unitText('agent', '/private/agent.json', '/private/node/bin/node'),
    /Environment="PATH=\/private\/node\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin"/,
  );
});

test('fresh foreground install uses supplied CLI, protects credentials, and repeated install preserves them', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'relay-easy-install-'));
  try {
    // A disposable source tree: stub only the build command, never the setup or installer.
    for (const name of ['scripts', 'packages', 'apps/gateway/src', 'apps/agent/src'])
      await cp(resolve(name), join(temporary, name), { recursive: true });
    await mkdir(join(temporary, 'apps/web/dist'), { recursive: true });
    await symlink(resolve('node_modules'), join(temporary, 'node_modules'));
    await cp('install.sh', join(temporary, 'install.sh'));
    await writeFile(
      join(temporary, 'package.json'),
      JSON.stringify({ type: 'module', scripts: { build: 'node -e "process.exit(0)"' } }),
    );
    const fake = join(temporary, 'fixture-codex');
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' 'codex-cli ${SUPPORTED_CODEX_VERSION}'\n`, {
      mode: 0o700,
    });
    const args = [
      '--import',
      'tsx',
      'scripts/install.ts',
      '--foreground',
      '--yes',
      '--host',
      '127.0.0.1',
      '--codex',
      fake,
      '--root',
      temporary,
    ];
    const { stdout } = await exec(process.execPath, args, { cwd: temporary, timeout: 30000 });
    assert.match(stdout, /安装完成/);
    assert.match(stdout, /账号管理/);
    const configPath = join(temporary, '.runtime/gateway.json');
    const before = await readFile(configPath, 'utf8');
    const config = JSON.parse(before);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.tailscaleHost, undefined);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const login = await readFile(join(temporary, '.runtime/login.txt'), 'utf8');
    const password = login.match(/密码：([^\n]+)/)![1];
    assert(!stdout.includes(password), 'installer must not print the generated secret automatically');
    assert.equal((await readFile(join(temporary, '.runtime/install-mode'), 'utf8')).trim(), 'foreground');
    const repeated = await exec('bash', ['install.sh'], { cwd: temporary });
    assert.match(repeated.stdout, /已初始化/);
    assert.equal(await readFile(configPath, 'utf8'), before);
    assert.equal(await readFile(join(temporary, '.runtime/login.txt'), 'utf8'), login);
    const info = await exec(process.execPath, ['--import', 'tsx', 'scripts/control.ts', 'info'], {
      cwd: temporary,
    });
    assert(info.stdout.includes(password));
    const fakeHome = join(temporary, 'other-home');
    const unitDirectory = join(fakeHome, '.config/systemd/user');
    await mkdir(unitDirectory, { recursive: true });
    const unrelatedUnit = join(unitDirectory, 'remote-workbench-agent.service');
    await writeFile(unrelatedUnit, '[Service]\nDescription=Unrelated deployment\n');
    await assert.rejects(
      exec(process.execPath, ['--import', 'tsx', 'scripts/control.ts', 'service'], {
        cwd: temporary,
        env: { ...process.env, HOME: fakeHome },
      }),
      /同名服务属于其他部署/,
    );
    assert.equal(await readFile(unrelatedUnit, 'utf8'), '[Service]\nDescription=Unrelated deployment\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
