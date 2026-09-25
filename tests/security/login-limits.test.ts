import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayAuth, hashPassword, type LoginAttempt } from '../../apps/gateway/src/auth.ts';
import { gatewayConfigSchema } from '../../apps/gateway/src/config.ts';
import { loginClientIp } from '../../apps/gateway/src/login-ip.ts';
import { buildGateway } from '../../apps/gateway/src/server.ts';

const password = 'login-limits-test-password';
const passwordHash = await hashPassword(password);
const origin = 'http://127.0.0.1:4380';
const config = (stateDir: string) =>
  gatewayConfigSchema.parse({
    stateDir,
    publicOrigin: origin,
    secureCookies: false,
    owner: { id: 'owner', username: 'owner', passwordHash },
    profiles: [],
  });
function admitted(value: ReturnType<GatewayAuth['beginLogin']>): LoginAttempt {
  assert.ok('id' in value, JSON.stringify(value));
  return value;
}

test('failure windows roll, success is not a failure, and blocks last 15 minutes from the tenth failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-login-window-'));
  const auth = new GatewayAuth(config(dir));
  const start = Date.now();
  try {
    for (let i = 0; i < 9; i++) auth.finishLogin(admitted(auth.beginLogin('192.0.2.1', start)), true, start);
    for (let i = 0; i < 12; i++)
      auth.finishLogin(admitted(auth.beginLogin('192.0.2.1', start)), false, start);
    const tenth = start + 14 * 60_000;
    auth.finishLogin(admitted(auth.beginLogin('192.0.2.1', tenth)), true, tenth);
    assert.deepEqual(auth.beginLogin('192.0.2.1', tenth + 1000), { retryAfter: 899 });
    auth.finishLogin(admitted(auth.beginLogin('192.0.2.2', tenth)), false, tenth);
    const sibling = new GatewayAuth(config(dir));
    try {
      assert.deepEqual(sibling.beginLogin('192.0.2.1', tenth + 60_000), { retryAfter: 840 });
      sibling.finishLogin(
        admitted(sibling.beginLogin('192.0.2.1', tenth + 15 * 60_000)),
        false,
        tenth + 15 * 60_000,
      );
    } finally {
      sibling.close();
    }
    const later = tenth + 31 * 60_000;
    for (let i = 0; i < 9; i++) auth.finishLogin(admitted(auth.beginLogin('192.0.2.3', later)), true, later);
    auth.finishLogin(admitted(auth.beginLogin('192.0.2.3', later + 15 * 60_000)), true, later + 15 * 60_000);
    auth.finishLogin(admitted(auth.beginLogin('192.0.2.3', later + 15 * 60_000)), false, later + 15 * 60_000);
  } finally {
    auth.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('global budget and in-flight reservations are shared between listeners and expire', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-login-concurrency-'));
  const auth = new GatewayAuth(config(dir)),
    sibling = new GatewayAuth(config(dir));
  const start = Date.now();
  try {
    const attempts = Array.from({ length: 10 }, () => admitted(auth.beginLogin('192.0.2.1', start)));
    assert.deepEqual(sibling.beginLogin('192.0.2.1', start), { retryAfter: 1 });
    auth.finishLogin(attempts[0], false, start);
    sibling.finishLogin(admitted(sibling.beginLogin('192.0.2.1', start)), false, start);
    for (const attempt of attempts.slice(1)) auth.finishLogin(attempt, true, start);
    for (let i = 11; i < 60; i++) {
      const attempt = admitted(sibling.beginLogin('192.0.2.2', start));
      sibling.finishLogin(attempt, false, start);
    }
    assert.deepEqual(auth.beginLogin('192.0.2.99', start + 1000), { retryAfter: 59 });
    admitted(auth.beginLogin('192.0.2.99', start + 60_000));
    // Abandoned reservations do not turn into failures or permanently exhaust slots.
    for (let i = 0; i < 10; i++) admitted(auth.beginLogin('192.0.2.4', start + 60_000));
    admitted(sibling.beginLogin('192.0.2.4', start + 120_000));
  } finally {
    auth.close();
    sibling.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('only the exact configured peer can supply a single canonical client IP', () => {
  const proxy = '100.80.1.2';
  assert.equal(loginClientIp(proxy, '192.0.2.1', []), proxy);
  assert.equal(loginClientIp('100.80.1.3', '192.0.2.1', [proxy]), '100.80.1.3');
  assert.equal(loginClientIp(proxy, '192.0.2.1', [proxy]), '192.0.2.1');
  assert.equal(loginClientIp('::ffff:100.80.1.2', '::ffff:192.0.2.1', [proxy]), '192.0.2.1');
  assert.equal(loginClientIp(proxy, '2001:0db8:0:0:0:0:0:1', [proxy]), '2001:db8::1');
  for (const value of [undefined, 'bad', '192.0.2.1, 192.0.2.2', ['192.0.2.1'], 'fe80::1%eth0'])
    assert.equal(loginClientIp(proxy, value, [proxy]), proxy);
  for (const trustedProxyIps of [['*'], ['100.64.0.0/10'], ['proxy.example'], [' 100.80.1.2']])
    assert.equal(
      gatewayConfigSchema.safeParse({ ...config('/tmp/example'), trustedProxyIps }).success,
      false,
    );
});

test('trusted proxy visitors get independent failure limits; direct spoofing cannot bypass a block or revoke a session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-login-http-'));
  const app = await buildGateway({ ...config(dir), trustedProxyIps: ['100.80.1.2'] });
  const login = (peer: string, forwarded: string, pass = 'wrong') =>
    app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress: peer,
      headers: { origin, 'x-forwarded-for': forwarded },
      payload: { username: 'owner', password: pass },
    });
  try {
    const session = await login('100.80.1.2', '192.0.2.1', password);
    assert.equal(session.statusCode, 200);
    for (let i = 0; i < 10; i++) assert.equal((await login('100.80.1.2', '192.0.2.1')).statusCode, 401);
    assert.equal((await login('100.80.1.2', '192.0.2.1', password)).statusCode, 429);
    assert.equal((await login('100.80.1.2', '192.0.2.2', password)).statusCode, 200);
    const cookie = `${session.cookies[0].name}=${session.cookies[0].value}`;
    assert.equal(
      (await app.inject({ url: '/api/me', headers: { cookie }, remoteAddress: '192.0.2.1' })).statusCode,
      200,
    );
    for (let i = 0; i < 10; i++) assert.equal((await login('192.0.2.3', `198.51.100.${i}`)).statusCode, 401);
    assert.equal((await login('192.0.2.3', '198.51.100.99', password)).statusCode, 429);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
