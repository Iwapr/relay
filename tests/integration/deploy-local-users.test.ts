import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const script = 'scripts/deploy-local-users.sh';
const valid = [
  '--lan',
  '192.168.10.20',
  '--tailscale',
  '100.64.0.10',
  '--release',
  '/opt/relay-test-release',
  '--codex-dir',
  '/example/codex-runtime',
  '--instance',
  'user1:4081',
];
const run = (args: string[]) => spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 5000 });

test('legacy deployment requires explicit configuration and supports a mutation-free parameter check', () => {
  assert.equal(run(['--help']).status, 0);
  assert.notEqual(run([]).status, 0);
  const checked = run([...valid, '--instance', 'user2:4082', '--check']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /Arguments valid/);
});

test('legacy deployment rejects unsafe users, ports, paths and network addresses before provisioning', () => {
  for (const [flag, value] of [
    ['--lan', '0.0.0.0'],
    ['--lan', '8.8.8.8'],
    ['--lan', '127.0.0.1'],
    ['--tailscale', '192.168.10.21'],
    ['--release', '/opt'],
    ['--release', '/opt/../tmp/release'],
    ['--codex-dir', 'relative'],
    ['--instance', 'root:4081'],
    ['--instance', 'user1:80'],
    ['--instance', 'user1:65536'],
    ['--instance', 'user1:04081'],
    ['--instance', '-bad:4081'],
  ]) {
    const args = [...valid];
    args[args.indexOf(flag) + 1] = value;
    assert.notEqual(run([...args, '--check']).status, 0, `${flag} ${value}`);
  }
  assert.notEqual(run([...valid, '--instance', 'user1:4082', '--check']).status, 0);
  assert.notEqual(run([...valid, '--instance', 'user2:4081', '--check']).status, 0);
  assert.notEqual(run([...valid, '--lan', '--check']).status, 0);
});
