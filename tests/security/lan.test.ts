import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayConfigSchema, isPrivateIPv4 } from '../../apps/gateway/src/config.ts';
import { buildGateway } from '../../apps/gateway/src/server.ts';
import { hashPassword } from '../../apps/gateway/src/auth.ts';
const password = 'test-only-lan-password';
const passwordHash = await hashPassword(password);
const config = {
  stateDir: '/tmp/test-only-lan',
  publicOrigin: 'http://192.168.10.20:4080',
  host: '192.168.10.20',
  port: 4080,
  allowLanHttp: true,
  secureCookies: false,
  owner: { id: 'owner', username: 'owner', passwordHash },
  profiles: [],
};

test('LAN mode admits only literal RFC1918 IPv4 addresses with explicit matching configuration', () => {
  for (const address of ['192.168.10.20', '172.16.1.2', '172.31.255.254', '192.168.10.20']) {
    assert.equal(isPrivateIPv4(address), true);
    assert.equal(
      gatewayConfigSchema.safeParse({ ...config, host: address, publicOrigin: `http://${address}:4080` })
        .success,
      true,
    );
  }
  for (const address of [
    '0.0.0.0',
    '::',
    '127.0.0.1',
    '100.64.0.10',
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.0.1',
    '192.168.1.999',
    '10.1.1.2.example',
    '10.1.1.2\n',
  ])
    assert.equal(isPrivateIPv4(address), false, address);
  const rejected = [
    { allowLanHttp: false },
    { secureCookies: true },
    { host: '127.0.0.1' },
    { host: '0.0.0.0' },
    { host: '8.8.8.8', publicOrigin: 'http://8.8.8.8:4080' },
    { publicOrigin: 'http://192.168.10.21:4080' },
    { publicOrigin: 'http://192.168.10.20:4081' },
    { publicOrigin: 'https://192.168.10.20:4080' },
    { publicOrigin: 'http://router.example:4080' },
    { publicOrigin: 'http://192.168.10.20:4080/path' },
  ];
  for (const patch of rejected)
    assert.equal(
      gatewayConfigSchema.safeParse({ ...config, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
});

test('LAN login and authenticated requests preserve exact Host, Origin, CSRF and HttpOnly protection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-lan-test-'));
  const app = await buildGateway({ ...config, stateDir: dir });
  const host = new URL(config.publicOrigin).host;
  const headers = { host, origin: config.publicOrigin };
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/health', headers: { host } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { host } })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example:4080' } }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { host, origin: 'http://192.168.10.21:4080' },
          payload: { username: 'owner', password },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload: { username: 'owner', password },
    });
    assert.equal(login.statusCode, 200);
    assert.match(String(login.headers['set-cookie']), /HttpOnly/);
    assert.match(String(login.headers['set-cookie']), /SameSite=Strict/);
    assert.doesNotMatch(String(login.headers['set-cookie']), /; Secure/);
    const cookie = login.cookies[0].name + '=' + login.cookies[0].value;
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/me', headers: { host, cookie } })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/logout', headers: { ...headers, cookie }, payload: {} }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/logout',
          headers: { ...headers, cookie, 'x-csrf-token': login.json().csrfToken },
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/me', headers: { host, cookie } })).statusCode,
      401,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
