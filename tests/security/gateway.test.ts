import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildGateway } from '../../apps/gateway/src/server.ts';
import { hashPassword, verifyPassword } from '../../apps/gateway/src/auth.ts';
import { gatewayConfigSchema, type GatewayConfig } from '../../apps/gateway/src/config.ts';
import { AgentTransport, sshArguments } from '../../packages/transport-ssh/src/index.ts';

const origin = 'http://127.0.0.1:4380';
const password = 'correct horse battery staple';
const passwordHash = await hashPassword(password);
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-gateway-test-'));
  const socket = join(dir, 'a.sock');
  const token = 'a'.repeat(64);
  const tokenFile = join(dir, 'agent-token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  let identity = {
    agentId: 'agent-a',
    machineId: 'machine-a',
    protocolVersion: 1,
    version: '0.1.0',
    uid: 1001,
    username: 'alice',
    home: '/home/alice',
    codexHome: '/home/alice/.codex',
  };
  const requests: {
    path: string;
    authorization: string | undefined;
    cookie: string | undefined;
    range: string | undefined;
    body: string;
    method: string | undefined;
    lastEventId: string | undefined;
  }[] = [];
  const remote = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({
      path: req.url!,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      range: req.headers.range,
      body,
      method: req.method,
      lastEventId: req.headers['last-event-id'] as string | undefined,
    });
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === '/identity') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(identity));
      return;
    }
    if (req.url?.includes('/file')) {
      res.writeHead(206, {
        'content-type': 'application/pdf',
        'content-range': 'bytes 0-3/100',
        'accept-ranges': 'bytes',
        etag: '"v1"',
        'set-cookie': 'remote_secret=do-not-forward',
      });
      res.end('%PDF');
      return;
    }
    if (req.url?.startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url.includes('live=1')) res.write('id: agent-a:9\ndata: {}\n\n');
      else res.end('id: agent-a:9\nevent: message.delta\ndata: {"seq":9}\n\n');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => remote.listen(socket, resolve));
  const config: GatewayConfig = {
    publicOrigin: origin,
    stateDir: join(dir, 'state'),
    secureCookies: false,
    owner: { id: 'owner', username: 'owner', passwordHash },
    profiles: [
      {
        id: 'office',
        ownerId: 'owner',
        label: 'Office · alice',
        tokenFile,
        expectedIdentity: { uid: 1001, username: 'alice', home: '/home/alice' },
        transport: { kind: 'unix', socketPath: socket },
      },
      {
        id: 'other-user',
        ownerId: 'another-owner',
        label: 'Private',
        tokenFile,
        expectedIdentity: { uid: 1001, username: 'alice', home: '/home/alice' },
        transport: { kind: 'unix', socketPath: socket },
      },
    ],
  };
  let app = await buildGateway(config);
  async function login(headers: Record<string, string> = { origin }) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload: { username: 'owner', password },
    });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.cookies[0].name + '=' + response.cookies[0].value;
    return { cookie, csrf: response.json().csrfToken as string };
  }
  return {
    dir,
    config,
    requests,
    remote,
    get app() {
      return app;
    },
    login,
    changeIdentity: (patch: Partial<typeof identity>) => {
      identity = { ...identity, ...patch };
    },
    restart: async () => {
      await app.close();
      app = await buildGateway(config);
    },
    close: async () => {
      await app.close();
      remote.closeAllConnections();
      await new Promise<void>((resolve) => remote.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('passwords use salted scrypt with constant-time verification', async () => {
  assert.notEqual(await hashPassword(password), passwordHash);
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword('wrong password', passwordHash), false);
  await assert.rejects(hashPassword('short'));
});

test('login requires same Origin; cookies and persisted sessions remain private; logout revokes', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/login', payload: { username: 'owner', password } }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { origin: 'https://evil.example' },
          payload: { username: 'owner', password },
        })
      ).statusCode,
      403,
    );
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin },
      payload: { username: 'owner', password },
    });
    assert.match(String(login.headers['set-cookie']), /HttpOnly/);
    assert.match(String(login.headers['set-cookie']), /SameSite=Strict/);
    const { cookie, csrf } = await f.login();
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/me' })).statusCode, 401);
    const me = await f.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().csrfToken, csrf);
    assert.match(String(me.headers['cache-control']), /no-store/);
    const db = new DatabaseSync(join(f.dir, 'state', 'gateway.sqlite'), { readOnly: true });
    const stored = JSON.stringify(db.prepare('SELECT * FROM sessions').all());
    db.close();
    assert(!stored.includes(cookie.split('=')[1]));
    await f.restart();
    assert.equal(
      (await f.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/logout', headers: { origin, cookie } })).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/logout',
          headers: { origin, cookie, 'x-csrf-token': csrf },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

test('login rate limit is persisted across restart', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/login',
            headers: { origin },
            payload: { username: 'owner', password: 'incorrect' },
          })
        ).statusCode,
        401,
      );
    await f.restart();
    const blocked = await f.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin },
      payload: { username: 'owner', password },
    });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 895);
    assert.ok(Number(blocked.headers['retry-after']) <= 900);
  } finally {
    await f.close();
  }
});

test('connection authority, CSRF and fixed business routes prevent arbitrary forwarding', async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await f.login();
    const list = await f.app.inject({ method: 'GET', url: '/api/connections', headers: { cookie } });
    assert.deepEqual(
      list.json().connections.map((c: { id: string }) => c.id),
      ['office'],
    );
    assert(!list.body.includes('agent-token'));
    assert(!list.body.includes(f.dir));
    const privateRequest = await f.app.inject({
      method: 'GET',
      url: '/api/connections/other-user/identity',
      headers: { cookie },
    });
    assert.equal(privateRequest.statusCode, 403);
    assert.equal(f.requests.length, 0);
    for (const suffix of [
      'v2/thread/start',
      'http://evil.test',
      'workspaces/%2e%2e/file',
      'workspaces/id%2fother/file',
    ]) {
      const r = await f.app.inject({
        method: 'GET',
        url: '/api/connections/office/' + suffix,
        headers: { cookie },
      });
      assert.equal(r.statusCode, 404, r.body);
    }
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/connections/office/connect',
          headers: { origin, cookie },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/connections',
          headers: { origin, cookie, 'x-csrf-token': csrf },
          payload: { profileId: 'office', url: 'http://evil.test' },
        })
      ).statusCode,
      400,
    );
    const connected = await f.app.inject({
      method: 'POST',
      url: '/api/connections/office/connect',
      headers: { origin, cookie, 'x-csrf-token': csrf },
    });
    assert.equal(connected.statusCode, 200, connected.body);
  } finally {
    await f.close();
  }
});

test('actual and durable Agent identity checks block replacements and other users', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login();
    const url = '/api/connections/office/identity';
    assert.equal((await f.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode, 200);
    f.changeIdentity({ uid: 1002 });
    assert.equal(
      (await f.app.inject({ method: 'GET', url, headers: { cookie } })).json().error.code,
      'identity_mismatch',
    );
    f.changeIdentity({ uid: 1001, agentId: 'replacement' });
    await f.restart();
    assert.equal(
      (await f.app.inject({ method: 'GET', url, headers: { cookie } })).json().error.code,
      'identity_mismatch',
    );
    assert.equal(f.requests.filter((r) => r.path !== '/identity').length, 0);
  } finally {
    await f.close();
  }
});

test('PDF Range and SSE stream pass through without browser cookies or remote secret headers', async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await f.login();
    const file = await f.app.inject({
      method: 'GET',
      url: '/api/connections/office/workspaces/workspace-a/file?path=paper.pdf',
      headers: { cookie, range: 'bytes=0-3', authorization: 'Bearer evil' },
    });
    assert.equal(file.statusCode, 206, file.body);
    assert.equal(file.body, '%PDF');
    assert.equal(file.headers['content-range'], 'bytes 0-3/100');
    assert.equal(file.headers['set-cookie'], undefined);
    assert.equal(file.headers['x-accel-buffering'], 'no');
    assert.match(String(file.headers['cache-control']), /no-store/);
    const received = f.requests.at(-1)!;
    assert.equal(received.range, 'bytes=0-3');
    assert.equal(received.cookie, undefined);
    assert.equal(received.authorization, 'Bearer ' + 'a'.repeat(64));
    const stream = await f.app.inject({
      method: 'GET',
      url: '/api/connections/office/events?afterSeq=8&agentId=agent-a',
      headers: { cookie, 'last-event-id': 'agent-a:8' },
    });
    assert.match(stream.body, /id: agent-a:9/);
    assert.equal(f.requests.at(-1)!.lastEventId, 'agent-a:8');
    const task = { clientRequestId: 'request-1', text: 'private task' };
    const run = await f.app.inject({
      method: 'POST',
      url: '/api/connections/office/conversations/conversation-a/runs',
      headers: { origin, cookie, 'x-csrf-token': csrf },
      payload: task,
    });
    assert.equal(run.statusCode, 200);
    assert.deepEqual(JSON.parse(f.requests.at(-1)!.body), task);
    await f.restart();
    assert(f.remote.listening, 'Agent process outlives Gateway close');
  } finally {
    await f.close();
  }
});

test('SSH arguments enforce pinned host keys, no agent forwarding, no shell or remote process', () => {
  const config = {
    kind: 'ssh' as const,
    host: 'office.example',
    port: 22,
    user: 'alice',
    identityFile: '/private/id',
    knownHostsFile: '/private/known_hosts',
    remoteSocketPath: '/run/user/1001/relay/agent.sock',
  };
  const args = sshArguments(config, '/private/tunnel.sock');
  for (const value of [
    'StrictHostKeyChecking=yes',
    'ForwardAgent=no',
    'ExitOnForwardFailure=yes',
    'IdentityAgent=none',
    'StreamLocalBindMask=0177',
    '-N',
    '-T',
    '/private/tunnel.sock:/run/user/1001/relay/agent.sock',
  ])
    assert(args.includes(value));
  assert.equal(args.at(-1), 'office.example');
  assert(!args.includes('StrictHostKeyChecking=no'));
  assert.throws(() => sshArguments({ ...config, user: 'root' }, '/private/tunnel.sock'));
  assert.throws(() => sshArguments({ ...config, host: '-oProxyCommand=evil' }, '/private/tunnel.sock'));
  assert.throws(() =>
    sshArguments({ ...config, remoteSocketPath: '/tmp/foo:127.0.0.1:80' }, '/private/tunnel.sock'),
  );
});

test('public origins require HTTPS and insecure development is restricted to loopback', () => {
  const base = {
    stateDir: '/tmp/relay',
    owner: { id: 'owner', username: 'owner', passwordHash },
    profiles: [],
  };
  assert.equal(
    gatewayConfigSchema.safeParse({ ...base, publicOrigin: 'https://relay.example' }).success,
    true,
  );
  assert.equal(
    gatewayConfigSchema.safeParse({ ...base, publicOrigin: 'http://relay.example', secureCookies: false })
      .success,
    false,
  );
  assert.equal(
    gatewayConfigSchema.safeParse({ ...base, publicOrigin: 'https://relay.example', secureCookies: false })
      .success,
    false,
  );
  assert.equal(
    gatewayConfigSchema.safeParse({ ...base, publicOrigin: 'http://127.0.0.1:4380', secureCookies: false })
      .success,
    true,
  );
});

for (const proxyOrigin of [undefined, 'https://relay.example.com:14080'])
  test(`logout and Gateway shutdown close active SSE observers over ${proxyOrigin ? 'Tailscale HTTPS proxy' : 'loopback'} without terminating the remote service`, async () => {
    const f = await fixture();
    try {
      const headers: Record<string, string> = { origin };
      if (proxyOrigin) {
        Object.assign(f.config, {
          host: '100.90.10.20',
          port: 4080,
          publicOrigin: 'http://100.90.10.20:4080',
          allowTailscaleHttp: true,
          tailscaleProxyOrigin: proxyOrigin,
          cookieNamespace: 'proxy-sse',
        });
        await f.restart();
        headers.host = new URL(proxyOrigin).host;
        headers.origin = proxyOrigin;
      }
      const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
      const openStream = (cookie: string) =>
        new Promise<IncomingMessage>((resolve, reject) => {
          get(
            address + '/api/connections/office/events?live=1',
            {
              headers: { ...headers, cookie },
            },
            resolve,
          ).once('error', reject);
        });
      const { cookie, csrf } = await f.login(headers);
      if (proxyOrigin) assert.ok(cookie.startsWith('__Host-relay_session_proxy-sse='));
      const response = await openStream(cookie);
      assert.equal(response.statusCode, 200);
      const reader = Readable.toWeb(response).getReader();
      assert.equal((await reader.read()).done, false);
      const logout = await f.app.inject({
        method: 'POST',
        url: '/api/logout',
        headers: { ...headers, cookie, 'x-csrf-token': csrf },
      });
      assert.equal(logout.statusCode, 200, logout.body);
      assert.equal(logout.cookies[0].name, cookie.split('=')[0]);
      const terminated = await Promise.race([
        reader.read().then(
          (r) => r.done,
          () => true,
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1500)),
      ]);
      assert.equal(terminated, true);
      assert.equal(
        (await f.app.inject({ method: 'GET', url: '/api/me', headers: { ...headers, cookie } })).statusCode,
        401,
      );
      const second = await f.login(headers);
      const stream = await openStream(second.cookie);
      assert.equal(stream.statusCode, 200);
      const next = Readable.toWeb(stream).getReader();
      await next.read();
      const closed = await Promise.race([
        f.app.close().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1500)),
      ]);
      assert.equal(closed, true, 'Gateway shutdown must not hang on open SSE');
      assert.equal(f.remote.listening, true);
      await next.cancel().catch(() => {});
    } finally {
      await f.close();
    }
  });

test('production Cookie is host-bound and Secure; expired persisted sessions are rejected', async () => {
  const f = await fixture();
  try {
    f.config.secureCookies = true;
    f.config.publicOrigin = 'https://workbench.example';
    await f.restart();
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'https://workbench.example' },
      payload: { username: 'owner', password },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(String(response.headers['set-cookie']), /^__Host-relay_session=/);
    assert.match(String(response.headers['set-cookie']), /; Secure/);
    assert.equal(response.cookies[0].path, '/');
    assert.equal(response.cookies[0].domain, undefined);
    const cookie = response.cookies[0].name + '=' + response.cookies[0].value;
    const db = new DatabaseSync(join(f.dir, 'state', 'gateway.sqlite'));
    db.prepare('UPDATE sessions SET expires_at=?').run(Date.now() - 1);
    db.close();
    assert.equal(
      (await f.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

test('per-instance cookie namespaces keep simultaneous browser logins distinct', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-multi-cookie-'));
  const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];
  try {
    const cookies = [];
    for (const username of ['user1', 'user2']) {
      const stateDir = join(dir, username);
      await mkdir(stateDir, { mode: 0o700 });
      const app = await buildGateway({
        publicOrigin: origin,
        stateDir,
        host: '127.0.0.1',
        port: 4380,
        secureCookies: false,
        cookieNamespace: username,
        owner: { id: 'owner', username, passwordHash },
        profiles: [],
      });
      apps.push(app);
      const reply = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { username, password },
      });
      assert.equal(reply.statusCode, 200);
      const cookie = String(reply.headers['set-cookie']).split(';')[0];
      assert.ok(cookie.startsWith(`relay_session_${username}=`));
      cookies.push(cookie);
    }
    for (const app of apps) {
      const response: { statusCode: number } = await app.inject({
        method: 'GET',
        url: '/api/connections',
        headers: { cookie: cookies.join('; ') },
      });
      assert.equal(response.statusCode, 200);
    }
  } finally {
    await Promise.all(apps.map((app) => app.close()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('owner cookie and CSRF protect account creation and account-scoped routes', async () => {
  const f = await fixture();
  try {
    const { cookie, csrf } = await f.login();
    const account = '00000000-0000-4000-8000-000000000001';
    const prefix = '/api/connections/office/accounts/' + account;
    assert.equal((await f.app.inject({ url: prefix + '/snapshot' })).statusCode, 401);
    assert.equal((await f.app.inject({ url: prefix + '/snapshot', headers: { cookie } })).statusCode, 200);
    assert.equal(
      (await f.app.inject({ url: prefix.replace('office', 'other-user') + '/snapshot', headers: { cookie } }))
        .statusCode,
      403,
    );
    const url = '/api/connections/office/providers/codex/accounts';
    assert.equal(
      (await f.app.inject({ url, method: 'POST', headers: { cookie, origin }, payload: { label: 'Second' } }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          url,
          method: 'POST',
          headers: { cookie, origin, 'x-csrf-token': csrf },
          payload: { label: 'Second' },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          url: prefix + '/providers/codex/login',
          method: 'POST',
          headers: { cookie, origin, 'x-csrf-token': csrf },
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal((await f.app.inject({ url: '/api/me', headers: { cookie } })).json().user.username, 'owner');
    assert.equal(
      (
        await f.app.inject({
          url: prefix + '/providers/codex/accounts',
          method: 'POST',
          headers: { cookie, origin, 'x-csrf-token': csrf },
          payload: {},
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});
