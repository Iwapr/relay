import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayConfigSchema, gatewayListenerConfigs } from '../../apps/gateway/src/config.ts';
import { createRemoteManager, relayGuide } from '../../apps/gateway/src/remote-access.ts';
import { buildGateway } from '../../apps/gateway/src/server.ts';
import { hashPassword } from '../../apps/gateway/src/auth.ts';
import { selectLanAddress } from '../../scripts/lan-address.ts';
const password = 'remote-management-fixture';
const passwordHash = await hashPassword(password);
const relay = {
  cloudIp: '203.0.113.10',
  domain: 'relay.example.com',
  port: 1443,
  cloudTailscaleIp: '100.64.0.2',
};
const detected = async () => ({ state: 'ready' as const, ip: '100.64.0.1', message: 'ready' });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-remote-'));
  const path = join(dir, 'gateway.json');
  const config = gatewayConfigSchema.parse({
    stateDir: join(dir, 'state'),
    host: '127.0.0.1',
    port: 4080,
    publicOrigin: 'http://127.0.0.1:4080',
    secureCookies: false,
    owner: { id: 'owner', username: 'owner', passwordHash },
    profiles: [],
  });
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return { dir, path, config };
}
test('remote configuration persists, restores after restart, and disables only overlay settings', async () => {
  const f = await fixture();
  try {
    let applied = f.config;
    const manager = createRemoteManager(
      f.config,
      f.path,
      async (next) => {
        applied = next;
      },
      detected,
    );
    const initialStatus = await manager.status();
    assert.equal(initialStatus.enabled, false);
    assert.equal(initialStatus.gatewayPort, f.config.port);
    const result = await manager.configure({ enabled: true, relay });
    assert.equal(result.proxyOrigin, 'https://relay.example.com:1443');
    assert.equal(applied.tailscaleHost, '100.64.0.1');
    assert.deepEqual(applied.trustedProxyIps, ['100.64.0.2']);
    const disk = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    const restored = createRemoteManager(gatewayConfigSchema.parse(disk), f.path, async () => {}, detected);
    assert.deepEqual((await restored.status()).relay, relay);
    await manager.configure({ enabled: false });
    assert.equal(manager.current().tailscaleHost, undefined);
    assert.equal(manager.current().tailscaleProxyOrigin, undefined);
    assert.deepEqual(manager.current().owner, f.config.owner);
    assert.equal(manager.current().publicOrigin, f.config.publicOrigin);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('failed binding, unavailable Tailscale, and external edits never commit a new config', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.path, 'utf8');
    const failed = createRemoteManager(
      f.config,
      f.path,
      async () => {
        throw new Error('EADDRINUSE');
      },
      detected,
    );
    await assert.rejects(failed.configure({ enabled: true }));
    assert.equal(await readFile(f.path, 'utf8'), before);
    assert.equal((await failed.status()).enabled, false);
    const offline = createRemoteManager(
      f.config,
      f.path,
      async () => assert.fail('must not apply'),
      async () => ({ state: 'unavailable', message: 'offline' }),
    );
    await assert.rejects(offline.configure({ enabled: true }));
    assert.equal(await readFile(f.path, 'utf8'), before);
    const calls: boolean[] = [];
    const raced = createRemoteManager(
      f.config,
      f.path,
      async (next) => {
        calls.push(Boolean(next.tailscaleHost));
        if (next.tailscaleHost) await writeFile(f.path, before + '\n');
      },
      detected,
    );
    await assert.rejects(raced.configure({ enabled: true }));
    assert.deepEqual(calls, [true, false]);
    assert.equal(raced.current().tailscaleHost, undefined);
    assert.equal(await readFile(f.path, 'utf8'), before + '\n');
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('management requires authentication, exact origin, CSRF and a local listener; proxy policy updates live', async () => {
  const f = await fixture();
  const manager = createRemoteManager(f.config, f.path, async () => {}, detected);
  const lan = await buildGateway(f.config, manager);
  let overlay: Awaited<ReturnType<typeof buildGateway>> | undefined;
  try {
    assert.equal((await lan.inject('/api/remote-access')).statusCode, 401);
    const login = await lan.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: f.config.publicOrigin },
      payload: { username: 'owner', password },
    });
    const headers = {
      origin: f.config.publicOrigin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      'x-csrf-token': login.json().csrfToken,
    };
    const post = (extra: Record<string, string>, payload: unknown) =>
      lan.inject({
        method: 'POST',
        url: '/api/remote-access',
        headers: { ...headers, ...extra },
        payload: JSON.stringify(payload),
      });
    assert.equal(
      (await post({ 'content-type': 'application/json', 'x-csrf-token': '' }, { enabled: true })).statusCode,
      403,
    );
    assert.equal(
      (await post({ 'content-type': 'application/json', origin: 'https://evil.example' }, { enabled: true }))
        .statusCode,
      403,
    );
    assert.equal(
      (await post({ 'content-type': 'application/json' }, { enabled: true, relay })).statusCode,
      200,
    );
    overlay = await buildGateway(gatewayListenerConfigs(manager.current())[1], manager);
    const proxyHeaders = { host: 'relay.example.com:1443', origin: 'https://relay.example.com:1443' };
    const remoteLogin = await overlay.inject({
      method: 'POST',
      url: '/api/login',
      headers: proxyHeaders,
      payload: { username: 'owner', password },
    });
    assert.equal(remoteLogin.statusCode, 200);
    assert.match(String(remoteLogin.headers['set-cookie']), /; Secure/);
    const remoteHeaders = {
      ...proxyHeaders,
      cookie: `${remoteLogin.cookies[0].name}=${remoteLogin.cookies[0].value}`,
      'x-csrf-token': remoteLogin.json().csrfToken,
    };
    assert.equal(
      (
        await overlay.inject({
          method: 'POST',
          url: '/api/remote-access',
          headers: remoteHeaders,
          payload: { enabled: false },
        })
      ).statusCode,
      403,
    );
    await manager.configure({ enabled: true, relay: { ...relay, domain: 'new.example.com' } });
    assert.equal(
      (await overlay.inject({ url: '/health', headers: { host: proxyHeaders.host } })).statusCode,
      403,
    );
    assert.equal(
      (await overlay.inject({ url: '/health', headers: { host: 'new.example.com:1443' } })).statusCode,
      200,
    );
    assert.equal((await lan.inject({ url: '/api/me', headers })).statusCode, 200);
  } finally {
    await overlay?.close();
    await lan.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('cloud guide validates untrusted values and preserves custom HTTPS port and streaming', () => {
  const guide = relayGuide(relay, '100.64.0.1', 4080);
  const code = guide.steps.map((s) => s.code ?? '').join('\n');
  assert.equal(guide.origin, 'https://relay.example.com:1443');
  assert.match(code, /proxy_pass http:\/\/100\.64\.0\.1:4080/);
  assert.match(code, /proxy_set_header Host \$http_host;/);
  assert.match(code, /proxy_buffering off;/);
  assert.match(code, /proxy_request_buffering off;/);
  assert.match(code, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(code, /certbot certonly --nginx --cert-name relay.example.com/);
  assert.match(code, /certbot renew --cert-name relay.example.com --dry-run/);
  assert.match(code, /ssl_certificate \/etc\/letsencrypt\/live\/relay.example.com\/fullchain.pem;/);
  assert.match(code, /listen 1443 ssl;/);
  assert.match(code, /<<'RELAY_NGINX'/);
  assert.match(code, /nginx -t && sudo systemctl reload nginx/);
  for (const patch of [
    { domain: 'x.com\n;evil' },
    { domain: '$(id).com' },
    { port: 0 },
    { port: 80 },
    { cloudIp: 'x;id' },
    { cloudTailscaleIp: '192.168.0.1' },
  ])
    assert.throws(() => relayGuide({ ...relay, ...patch }, '100.64.0.1', 4080));
});
test('first deployment selects an explicit private interface, never wildcard or public', () => {
  const entry = (address: string) => ({
    address,
    family: 'IPv4' as const,
    internal: false,
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: `${address}/24`,
  });
  const interfaces = { eth0: [entry('192.168.1.10')], tailscale0: [entry('100.64.0.1')] };
  assert.equal(selectLanAddress(undefined, interfaces), '192.168.1.10');
  assert.throws(() => selectLanAddress('0.0.0.0', interfaces));
  assert.throws(() => selectLanAddress(undefined, { ...interfaces, eth1: [entry('10.1.1.1')] }));
  assert.equal(selectLanAddress('127.0.0.1', {}), '127.0.0.1');
});
