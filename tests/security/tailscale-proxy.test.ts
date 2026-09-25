import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatewayConfigSchema,
  gatewayListenerConfigs,
  type GatewayConfig,
} from '../../apps/gateway/src/config.ts';
import { buildGateway } from '../../apps/gateway/src/server.ts';
import { hashPassword } from '../../apps/gateway/src/auth.ts';

const password = 'test-only-tailscale-proxy-password';
const passwordHash = await hashPassword(password);
const proxyOrigin = 'https://remote.example:14080';
const directOrigin = 'http://100.90.10.20:4080';
const proxyHost = new URL(proxyOrigin).host;
const directHost = new URL(directOrigin).host;
const config: GatewayConfig = {
  stateDir: '/tmp/test-only-tailscale-proxy',
  publicOrigin: 'http://192.168.10.20:4080',
  host: '192.168.10.20',
  port: 4080,
  allowLanHttp: true,
  secureCookies: false,
  tailscaleHost: '100.90.10.20',
  tailscaleProxyOrigin: proxyOrigin,
  owner: { id: 'owner', username: 'owner', passwordHash },
  profiles: [],
};

test('Tailscale proxy configuration requires a canonical HTTPS origin and a Tailscale listener', () => {
  for (const tailscaleProxyOrigin of [proxyOrigin, 'https://remote.example']) {
    assert.equal(gatewayConfigSchema.safeParse({ ...config, tailscaleProxyOrigin }).success, true);
    assert.equal(
      gatewayConfigSchema.safeParse({
        ...config,
        tailscaleProxyOrigin,
        tailscaleHost: undefined,
        host: '100.90.10.20',
        publicOrigin: directOrigin,
        allowLanHttp: false,
        allowTailscaleHttp: true,
      }).success,
      true,
    );
  }
  for (const tailscaleProxyOrigin of [
    '',
    'not-a-url',
    'https://',
    'http://remote.example:14080',
    'ftp://remote.example:14080',
    'remote.example:14080',
    'https://remote.example:14080/',
    'https://remote.example:14080/workbench',
    'https://remote.example:14080?query=value',
    'https://remote.example:14080#fragment',
    'https://user:password@remote.example:14080',
    'https://user@remote.example:14080',
    'https://REMOTE.example:14080',
    'https://remote.example:443',
    'https://remote.example:014080',
    ' https://remote.example:14080',
    'https://remote.example:14080\n',
    `https://${directHost}`,
  ])
    assert.equal(
      gatewayConfigSchema.safeParse({ ...config, tailscaleProxyOrigin }).success,
      false,
      tailscaleProxyOrigin,
    );

  assert.equal(
    gatewayConfigSchema.safeParse({ ...config, tailscaleHost: undefined }).success,
    false,
    'a LAN listener alone must not enable a Tailscale proxy origin',
  );
  assert.equal(
    gatewayConfigSchema.safeParse({
      ...config,
      tailscaleHost: undefined,
      host: '127.0.0.1',
      publicOrigin: 'http://127.0.0.1:4080',
      allowLanHttp: false,
    }).success,
    false,
    'a loopback listener alone must not enable a Tailscale proxy origin',
  );
});

test('a proxy origin cannot collide with either primary or additional Tailscale listener', () => {
  const dualTailscaleConfig: GatewayConfig = {
    ...config,
    host: '100.90.10.21',
    publicOrigin: 'http://100.90.10.21:4080',
    allowLanHttp: false,
    allowTailscaleHttp: true,
    tailscaleHost: '100.90.10.20',
  };
  assert.equal(gatewayConfigSchema.safeParse(dualTailscaleConfig).success, true);
  assert.deepEqual(
    gatewayListenerConfigs(dualTailscaleConfig).map((listener) => listener.publicOrigin),
    ['http://100.90.10.21:4080', directOrigin],
  );
  for (const tailscaleProxyOrigin of ['https://100.90.10.21:4080', 'https://100.90.10.20:4080'])
    assert.equal(
      gatewayConfigSchema.safeParse({ ...dualTailscaleConfig, tailscaleProxyOrigin }).success,
      false,
      tailscaleProxyOrigin,
    );
});

test('proxy configuration preserves direct listeners and only enables the proxy on Tailscale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-tailscale-proxy-listeners-'));
  const listeners = gatewayListenerConfigs({ ...config, stateDir: dir });
  const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
  try {
    const [lan, tailscale] = listeners;
    assert.equal(listeners.length, 2);
    assert.equal(lan.host, config.host);
    assert.equal(lan.publicOrigin, config.publicOrigin);
    assert.equal(lan.allowLanHttp, true);
    assert.equal(lan.allowTailscaleHttp, false);
    assert.equal(tailscale.host, config.tailscaleHost);
    assert.equal(tailscale.publicOrigin, directOrigin);
    assert.equal(tailscale.allowLanHttp, false);
    assert.equal(tailscale.allowTailscaleHttp, true);
    assert.equal(tailscale.tailscaleProxyOrigin, proxyOrigin);
    assert.equal(tailscale.secureCookies, false);
    assert.equal(tailscale.stateDir, lan.stateDir);

    for (const listener of listeners) apps.push(await buildGateway(listener));
    for (const [index, app] of apps.entries()) {
      const host = new URL(listeners[index].publicOrigin).host;
      const direct = await app.inject({ method: 'GET', url: '/health', headers: { host } });
      assert.equal(direct.statusCode, 200);
      assert.equal(direct.headers['strict-transport-security'], undefined);
      const proxy = await app.inject({ method: 'GET', url: '/health', headers: { host: proxyHost } });
      assert.equal(proxy.statusCode, index === 0 ? 403 : 200);
      if (index === 1) assert.match(String(proxy.headers['strict-transport-security']), /max-age=\d+/);
      const otherHost = new URL(listeners[1 - index].publicOrigin).host;
      assert.equal(
        (await app.inject({ method: 'GET', url: '/health', headers: { host: otherHost } })).statusCode,
        403,
      );
    }
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Tailscale proxy requires a matching Host and Origin regardless of forwarding headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-tailscale-proxy-origin-'));
  const app = await buildGateway(gatewayListenerConfigs({ ...config, stateDir: dir })[1]);
  try {
    const forwarded = {
      'x-forwarded-host': proxyHost,
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '14080',
      forwarded: `host="${proxyHost}";proto=https`,
    };
    for (const host of ['evil.example:14080', 'remote.example', 'remote.example:4080']) {
      const result = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { host, ...forwarded },
      });
      assert.equal(result.statusCode, 403, host);
      assert.equal(result.json().error.code, 'permission_denied');
    }
    for (const [host, origins] of [
      [proxyHost, [undefined, directOrigin, 'http://remote.example:14080', 'https://evil.example:14080']],
      [directHost, [undefined, proxyOrigin, 'http://evil.example:4080']],
    ] as const) {
      for (const origin of origins) {
        const result = await app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { host, ...(origin ? { origin } : {}), ...forwarded },
          payload: { username: 'owner', password },
        });
        assert.equal(result.statusCode, 403, `${host}, Origin: ${origin}`);
        assert.equal(result.json().error.code, 'permission_denied');
      }
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const cookieNamespace of [undefined, 'proxy_test']) {
  test(`Tailscale proxy and direct sessions retain their own cookies, CSRF, and logout (${cookieNamespace ?? 'default'})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-tailscale-proxy-auth-'));
    const app = await buildGateway(gatewayListenerConfigs({ ...config, stateDir: dir, cookieNamespace })[1]);
    try {
      const suffix = cookieNamespace ? `_${cookieNamespace}` : '';
      const sessions: { host: string; origin: string; cookie: string; csrfToken: string; name: string }[] =
        [];
      for (const [origin, name, secure] of [
        [proxyOrigin, `__Host-relay_session${suffix}`, true],
        [directOrigin, `relay_session${suffix}`, false],
      ] as const) {
        const host = new URL(origin).host;
        assert.equal(
          (await app.inject({ method: 'GET', url: '/api/me', headers: { host } })).statusCode,
          401,
        );
        const login = await app.inject({
          method: 'POST',
          url: '/api/login',
          headers: {
            host,
            origin,
            'x-forwarded-host': 'evil.example',
            'x-forwarded-proto': secure ? 'http' : 'https',
          },
          payload: { username: 'owner', password },
        });
        assert.equal(login.statusCode, 200, login.body);
        assert.equal(login.cookies[0].name, name);
        const setCookie = String(login.headers['set-cookie']);
        assert.match(setCookie, /; HttpOnly/);
        assert.match(setCookie, /; SameSite=Strict/);
        assert.match(setCookie, /; Path=\//);
        assert.doesNotMatch(setCookie, /; Domain=/);
        if (secure) {
          assert.match(setCookie, /; Secure/);
          assert.match(String(login.headers['strict-transport-security']), /max-age=\d+/);
        } else {
          assert.doesNotMatch(setCookie, /; Secure/);
          assert.equal(login.headers['strict-transport-security'], undefined);
        }
        const cookie = `${name}=${login.cookies[0].value}`;
        const csrfToken = login.json().csrfToken;
        const me = await app.inject({ method: 'GET', url: '/api/me', headers: { host, cookie } });
        assert.equal(me.statusCode, 200, me.body);
        assert.equal(me.json().csrfToken, csrfToken);
        assert.equal(me.json().user.username, 'owner');
        sessions.push({ host, origin, cookie, csrfToken, name });
      }
      for (const [index, session] of sessions.entries()) {
        const { host, origin, cookie, csrfToken, name } = session;
        assert.equal(
          (
            await app.inject({
              method: 'GET',
              url: '/api/me',
              headers: { host, cookie: sessions[1 - index].cookie },
            })
          ).statusCode,
          401,
          'the other access mode must not select the wrong cookie name',
        );
        for (const badHeaders of [
          { host, origin, cookie },
          { host, origin, cookie, 'x-csrf-token': 'invalid-token' },
          { host, cookie, 'x-csrf-token': csrfToken },
          { host, origin: sessions[1 - index].origin, cookie, 'x-csrf-token': csrfToken },
        ]) {
          const denied = await app.inject({
            method: 'POST',
            url: '/api/logout',
            headers: badHeaders,
            payload: {},
          });
          assert.equal(denied.statusCode, 403, denied.body);
          assert.equal(denied.json().error.code, 'permission_denied');
        }
        const logout = await app.inject({
          method: 'POST',
          url: '/api/logout',
          headers: { host, origin, cookie, 'x-csrf-token': csrfToken },
          payload: {},
        });
        assert.equal(logout.statusCode, 200, logout.body);
        assert.equal(logout.cookies[0].name, name);
        const clearedCookie = String(logout.headers['set-cookie']);
        assert.match(clearedCookie, /; Max-Age=0/);
        assert.match(clearedCookie, /; HttpOnly/);
        assert.match(clearedCookie, /; SameSite=Strict/);
        assert.match(clearedCookie, /; Path=\//);
        assert.doesNotMatch(clearedCookie, /; Domain=/);
        if (origin === proxyOrigin) assert.match(clearedCookie, /; Secure/);
        else assert.doesNotMatch(clearedCookie, /; Secure/);
        assert.equal(
          (await app.inject({ method: 'GET', url: '/api/me', headers: { host, cookie } })).statusCode,
          401,
        );
      }
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('a Tailscale listener without proxy opt-in rejects the public hostname', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-tailscale-no-proxy-'));
  const app = await buildGateway(
    gatewayListenerConfigs({ ...config, stateDir: dir, tailscaleProxyOrigin: undefined })[1],
  );
  try {
    assert.equal(
      (await app.inject({ method: 'GET', url: '/health', headers: { host: directHost } })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/health',
          headers: { host: proxyHost, 'x-forwarded-host': directHost, 'x-forwarded-proto': 'https' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
