import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatewayConfigSchema,
  gatewayListenerConfigs,
  isTailscaleIPv4,
  type GatewayConfig,
} from '../../apps/gateway/src/config.ts';
import { buildGateway } from '../../apps/gateway/src/server.ts';
import { startGateway } from '../../apps/gateway/src/listeners.ts';
import { hashPassword } from '../../apps/gateway/src/auth.ts';

const password = 'test-only-tailscale-password';
const passwordHash = await hashPassword(password);
const config: GatewayConfig = {
  stateDir: '/tmp/test-only-tailscale',
  publicOrigin: 'http://192.168.10.20:4080',
  host: '192.168.10.20',
  port: 4080,
  allowLanHttp: true,
  secureCookies: false,
  tailscaleHost: '100.90.10.20',
  owner: { id: 'owner', username: 'owner', passwordHash },
  profiles: [
    {
      id: 'local',
      ownerId: 'owner',
      label: 'Local fixture',
      tokenFile: '/tmp/test-only-tailscale/token',
      expectedIdentity: { uid: 1001, username: 'fixture', home: '/home/fixture' },
      transport: { kind: 'unix', socketPath: '/tmp/test-only-tailscale/agent.sock' },
    },
  ],
};

test('Tailscale HTTP accepts only literal 100.64/10 addresses with explicit matching configuration', () => {
  for (const host of ['100.64.0.0', '100.64.0.1', '100.90.10.20', '100.127.255.255']) {
    assert.equal(isTailscaleIPv4(host), true, host);
    assert.equal(
      gatewayConfigSchema.safeParse({
        ...config,
        host,
        publicOrigin: `http://${host}:4080`,
        allowLanHttp: false,
        allowTailscaleHttp: true,
        tailscaleHost: undefined,
      }).success,
      true,
      host,
    );
  }
  for (const host of [
    '100.63.255.255',
    '100.128.0.0',
    '99.100.1.1',
    '101.100.1.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '127.0.0.1',
    '0.0.0.0',
    '::',
    'fd7a:115c:a1e0::1',
    '100.64.0.256',
    '100.064.0.1',
    '100.64.0.1.example',
    '100.64.0.1\n',
  ])
    assert.equal(isTailscaleIPv4(host), false, host);

  const single = gatewayListenerConfigs(config)[1];
  for (const patch of [
    { allowTailscaleHttp: false },
    { allowLanHttp: true },
    { secureCookies: true },
    { host: '0.0.0.0' },
    { host: '8.8.8.8', publicOrigin: 'http://8.8.8.8:4080' },
    { publicOrigin: 'http://100.90.10.21:4080' },
    { publicOrigin: 'http://100.90.10.20:4081' },
    { publicOrigin: 'http://machine.example:4080' },
    { publicOrigin: 'https://100.90.10.20:4080' },
  ])
    assert.equal(
      gatewayConfigSchema.safeParse({ ...single, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
});

test('additional Tailscale listener keeps distinct origins and shares owner, profiles, and state', () => {
  const [lan, tailscale] = gatewayListenerConfigs(config);
  assert.equal(lan.host, config.host);
  assert.equal(lan.publicOrigin, config.publicOrigin);
  assert.equal(lan.allowLanHttp, true);
  assert.equal(lan.allowTailscaleHttp, false);
  assert.equal(tailscale.host, config.tailscaleHost);
  assert.equal(tailscale.publicOrigin, 'http://100.90.10.20:4080');
  assert.equal(tailscale.allowLanHttp, false);
  assert.equal(tailscale.allowTailscaleHttp, true);
  assert.equal(tailscale.tailscaleHost, undefined);
  assert.equal(tailscale.stateDir, lan.stateDir);
  assert.deepEqual(tailscale.owner, lan.owner);
  assert.deepEqual(tailscale.profiles, lan.profiles);
  assert.equal(gatewayListenerConfigs({ ...config, tailscaleHost: undefined }).length, 1);

  for (const tailscaleHost of ['0.0.0.0', '8.8.8.8', '100.128.0.1', '192.168.10.21', 'tail.example'])
    assert.equal(gatewayConfigSchema.safeParse({ ...config, tailscaleHost }).success, false, tailscaleHost);
  assert.equal(gatewayConfigSchema.safeParse({ ...tailscale, tailscaleHost: tailscale.host }).success, false);
  assert.equal(
    gatewayConfigSchema.safeParse({
      ...config,
      host: '127.0.0.1',
      allowLanHttp: false,
      secureCookies: true,
      publicOrigin: 'https://workbench.example',
    }).success,
    false,
  );
});

test('LAN and Tailscale listeners independently require their own Host, Origin, and CSRF token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-tailscale-test-'));
  const configs = gatewayListenerConfigs({ ...config, stateDir: dir });
  const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
  try {
    for (const listener of configs) apps.push(await buildGateway(listener));
    for (const [index, app] of apps.entries()) {
      const origin = configs[index].publicOrigin;
      const host = new URL(origin).host;
      const otherOrigin = configs[1 - index].publicOrigin;
      const otherHost = new URL(otherOrigin).host;
      const payload = { username: 'owner', password };
      assert.equal((await app.inject({ method: 'GET', url: '/health', headers: { host } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { host } })).statusCode, 401);
      for (const wrongHost of [otherHost, 'evil.example:4080'])
        assert.equal(
          (await app.inject({ method: 'GET', url: '/health', headers: { host: wrongHost } })).statusCode,
          403,
        );
      for (const wrongOrigin of [otherOrigin, 'http://evil.example:4080'])
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/login',
              headers: { host, origin: wrongOrigin },
              payload,
            })
          ).statusCode,
          403,
        );
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { host, origin },
        payload,
      });
      assert.equal(login.statusCode, 200, login.body);
      assert.match(String(login.headers['set-cookie']), /HttpOnly/);
      assert.match(String(login.headers['set-cookie']), /SameSite=Strict/);
      assert.doesNotMatch(String(login.headers['set-cookie']), /; Secure|; Domain=/);
      const cookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
      const csrfToken = login.json().csrfToken;
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: { host, cookie } });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().csrfToken, csrfToken);
      const connections = await app.inject({
        method: 'GET',
        url: '/api/connections',
        headers: { host, cookie },
      });
      assert.equal(connections.statusCode, 200);
      assert.equal(connections.json().connections[0].id, 'local');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/logout',
            headers: { host, origin, cookie },
            payload: {},
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/logout',
            headers: { host, origin, cookie, 'x-csrf-token': csrfToken },
            payload: {},
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: 'GET', url: '/api/me', headers: { host, cookie } })).statusCode,
        401,
      );
    }
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('gateway listener lifecycle releases its bound port when closed', async () => {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const dir = await mkdtemp(join(tmpdir(), 'relay-listener-test-'));
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    gateway = await startGateway({
      ...config,
      stateDir: dir,
      host: '127.0.0.1',
      port,
      publicOrigin: `http://127.0.0.1:${port}`,
      allowLanHttp: false,
      tailscaleHost: undefined,
      profiles: [],
    });
    assert.deepEqual(gateway.addresses, [`127.0.0.1:${port}`]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    await gateway.close();
    gateway = undefined;
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
  } finally {
    await gateway?.close();
    if (reservation.listening) await new Promise<void>((resolve) => reservation.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
