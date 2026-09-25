import type { RemoteManager } from './remote-access.ts';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { AgentTransport, readPrivateFile } from '../../../packages/transport-ssh/src/index.ts';
import {
  AppError,
  PROTOCOL_VERSION,
  IMAGE_UPLOAD_BODY_LIMIT,
  type AgentIdentity,
} from '../../../packages/contracts/src/index.ts';
import { GatewayAuth, verifyPassword, type PrincipalSession } from './auth.ts';
import { loginClientIp } from './login-ip.ts';
import { gatewayConfigSchema, type GatewayConfig, type ConnectionProfile } from './config.ts';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

const identitySchema = z.object({
  agentId: z.string().min(1),
  protocolVersion: z.number().int(),
  version: z.string(),
  uid: z.number().int().nonnegative(),
  username: z.string(),
  home: z.string(),
  codexHome: z.string(),
  machineId: z.string().min(1),
});
import { isAllowedAgentRoute } from '../../../packages/contracts/src/agent-routes.ts';
export { isAllowedAgentRoute } from '../../../packages/contracts/src/agent-routes.ts';
async function readIdentity(response: IncomingMessage): Promise<AgentIdentity> {
  if (response.statusCode !== 200) {
    response.resume();
    throw new AppError(
      response.statusCode === 401 ? 'auth_failed' : 'connection_offline',
      'Agent identity could not be verified.',
      503,
    );
  }
  let size = 0;
  const chunks: Buffer[] = [];
  const timeout = setTimeout(() => response.destroy(new Error('Identity response timed out')), 10_000);
  timeout.unref();
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > 65536) {
        response.destroy();
        throw new AppError('identity_mismatch', 'Invalid Agent identity.', 502);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('connection_offline', 'The Agent identity response was interrupted.', 503);
  } finally {
    clearTimeout(timeout);
  }
  try {
    return identitySchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
  } catch {
    throw new AppError('identity_mismatch', 'Invalid Agent identity.', 502);
  }
}

export async function buildGateway(input: GatewayConfig, remote?: RemoteManager) {
  const config = gatewayConfigSchema.parse(input);
  const auth = new GatewayAuth(config);
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: false, requestTimeout: 30_000 });
  const accessPolicy = (origin: string, secure: boolean) => ({
    origin,
    host: new URL(origin).host,
    cookieName:
      (secure ? '__Host-relay_session' : 'relay_session') +
      (config.cookieNamespace ? '_' + config.cookieNamespace : ''),
    cookieOptions: {
      httpOnly: true,
      secure,
      sameSite: 'strict' as const,
      path: '/',
      maxAge: config.sessionTtlSeconds,
    },
  });
  const directAccess = accessPolicy(config.publicOrigin, config.secureCookies);
  const proxyAccess = () => {
    const origin = remote ? remote.current().tailscaleProxyOrigin : config.tailscaleProxyOrigin;
    return config.allowTailscaleHttp && origin ? accessPolicy(origin, true) : undefined;
  };
  // Only an explicitly configured Host selects HTTPS policy; forwarded headers are not trusted.
  const requestAccess = (request: FastifyRequest) => {
    const proxy = proxyAccess();
    return proxy && request.headers.host === proxy.host ? proxy : directAccess;
  };
  const sessions = new WeakMap<FastifyRequest, PrincipalSession>();
  const transports = new Map<string, AgentTransport>();
  const status = new Map<string, string>();
  const active = new Map<string, Set<AbortController>>();
  await app.register(cookie);

  app.addHook('onRequest', async (request, reply) => {
    const access = requestAccess(request);
    if ((config.allowLanHttp || config.allowTailscaleHttp) && request.headers.host !== access.host)
      throw new AppError('permission_denied', 'Use the configured address for this workbench listener.', 403);
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    if (access.cookieOptions.secure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store, private').header('Pragma', 'no-cache');
    const pathname = request.url.split('?')[0];
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation && request.headers.origin !== access.origin)
      throw new AppError('permission_denied', 'The request must originate from this workbench.', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site')
      throw new AppError('permission_denied', 'Cross-site requests are not allowed.', 403);
    if (pathname === '/api/login' && request.method === 'POST') return;
    const session = auth.getSession(request.cookies[access.cookieName]);
    if (!session) throw new AppError('auth_required', 'Please sign in to the workbench.', 401);
    sessions.set(request, session);
    if (mutation && request.headers['x-csrf-token'] !== session.csrfToken)
      throw new AppError('permission_denied', 'The CSRF token is missing or invalid.', 403);
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof AppError;
    const validation = error instanceof z.ZodError;
    const frameworkStatus = (error as { statusCode?: number }).statusCode;
    const statusCode = known
      ? error.statusCode
      : validation
        ? 400
        : frameworkStatus && [400, 413, 415].includes(frameworkStatus)
          ? frameworkStatus
          : 500;
    reply.code(statusCode).send({
      error: {
        code: known
          ? error.code
          : validation
            ? 'invalid_request'
            : statusCode < 500
              ? 'invalid_request'
              : 'internal_error',
        message: known
          ? error.message
          : validation
            ? 'The request has invalid fields.'
            : statusCode < 500
              ? 'Malformed or unsupported request.'
              : 'The request could not be completed.',
        requestId: request.id,
      },
    });
  });
  const localManagement = () => {
    if (config.allowTailscaleHttp || config.secureCookies)
      throw new AppError('permission_denied', '请通过办公室局域网或服务器本机入口管理远程配置。', 403);
    if (!remote)
      throw new AppError('permission_denied', '此部署未启用网页远程配置，请联系服务器管理员。', 403);
    return remote;
  };
  app.get('/api/remote-access', async () => {
    if (!remote)
      return {
        manageable: false,
        enabled: Boolean(config.tailscaleHost),
        localOrigin: config.publicOrigin,
        reason: '此部署未启用网页远程配置，请联系服务器管理员。',
        tailscale: { state: 'unavailable', message: '由外部配置管理。' },
      };
    const result = await remote.status();
    if (config.allowTailscaleHttp || config.secureCookies)
      return { ...result, manageable: false, reason: '请通过办公室局域网或服务器本机入口管理远程配置。' };
    return result;
  });
  app.post('/api/remote-access', async (request) => localManagement().configure(request.body));
  app.post('/api/remote-access/guide', async (request) => localManagement().guide(request.body));
  app.get('/health', async () => ({ ok: true, service: 'remote-workbench-gateway' }));
  app.post('/api/login', async (request, reply) => {
    const { cookieName, cookieOptions } = requestAccess(request);
    const ip = loginClientIp(
      request.ip,
      request.headers['x-forwarded-for'],
      (remote?.current() ?? config).trustedProxyIps,
    );
    const attempt = auth.beginLogin(ip);
    if ('retryAfter' in attempt) {
      reply.header('Retry-After', String(attempt.retryAfter));
      throw new AppError('rate_limited', 'Too many sign-in attempts. Try again later.', 429);
    }
    let failed = false;
    try {
      const parsed = z
        .object({ username: z.string().max(100), password: z.string().min(1).max(1024) })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) {
        failed = true;
        throw parsed.error;
      }
      const { username, password } = parsed.data;
      const matches = await verifyPassword(password, config.owner.passwordHash);
      failed = !matches || username !== config.owner.username;
      if (failed) throw new AppError('auth_required', 'Incorrect username or password.', 401);
    } finally {
      auth.finishLogin(attempt, failed);
    }
    const old = request.cookies[cookieName];
    auth.revoke(old);
    if (old) {
      for (const controller of active.get(old) ?? []) controller.abort();
      active.delete(old);
    }
    const { token, session } = auth.createSession();
    reply.setCookie(cookieName, token, cookieOptions);
    return { user: { id: session.ownerId, username: session.username }, csrfToken: session.csrfToken };
  });
  app.get('/api/me', async (request) => {
    const session = sessions.get(request)!;
    return { user: { id: session.ownerId, username: session.username }, csrfToken: session.csrfToken };
  });
  app.post('/api/logout', async (request, reply) => {
    const { cookieName, cookieOptions } = requestAccess(request);
    const token = request.cookies[cookieName];
    auth.revoke(token);
    if (token) {
      for (const controller of active.get(token) ?? []) controller.abort();
      active.delete(token);
    }
    reply.clearCookie(cookieName, { ...cookieOptions, maxAge: 0 });
    return { ok: true };
  });
  function owned(request: FastifyRequest, id: string): ConnectionProfile {
    const profile = config.profiles.find((p) => p.id === id && p.ownerId === sessions.get(request)!.ownerId);
    if (!profile)
      throw new AppError('permission_denied', 'This connection is not available to this account.', 403);
    return profile;
  }
  function summary(profile: ConnectionProfile) {
    return {
      id: profile.id,
      label: profile.label,
      username: profile.expectedIdentity.username,
      status: status.get(profile.id) ?? 'offline',
    };
  }
  app.get('/api/connections', async (request) => ({
    connections: config.profiles.filter((p) => p.ownerId === sessions.get(request)!.ownerId).map(summary),
  }));
  app.post('/api/connections', async (request) => {
    const { profileId } = z.object({ profileId: z.string() }).strict().parse(request.body);
    return { connection: summary(owned(request, profileId)) };
  });
  async function verified(profile: ConnectionProfile) {
    let transport = transports.get(profile.id);
    if (!transport) {
      transport = new AgentTransport(profile.transport, join(config.stateDir, 'tunnels'));
      transports.set(profile.id, transport);
    }
    status.set(profile.id, 'connecting');
    try {
      const token = (await readPrivateFile(profile.tokenFile)).trim();
      if (!/^[A-Za-z0-9_-]{32,512}$/.test(token))
        throw new AppError('invalid_configuration', 'Agent control token is not configured correctly.', 500);
      const identity = await readIdentity(
        await transport.request({
          method: 'GET',
          path: '/identity',
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      const expected = profile.expectedIdentity;
      if (
        identity.protocolVersion !== PROTOCOL_VERSION ||
        identity.uid !== expected.uid ||
        identity.username !== expected.username ||
        identity.home !== expected.home ||
        (expected.agentId && identity.agentId !== expected.agentId) ||
        (expected.machineId && identity.machineId !== expected.machineId) ||
        !auth.pinIdentity(profile.id, identity.agentId, identity.machineId)
      )
        throw new AppError(
          'identity_mismatch',
          'Remote identity differs from this connection’s verified identity. Administrator verification is required.',
          409,
        );
      status.set(profile.id, 'online');
      return { transport, token, identity };
    } catch (error) {
      status.set(
        profile.id,
        error instanceof AppError && ['identity_mismatch', 'auth_failed'].includes(error.code)
          ? error.code
          : 'offline',
      );
      throw error;
    }
  }
  app.post<{ Params: { c: string } }>('/api/connections/:c/connect', async (request) => {
    const { identity } = await verified(owned(request, request.params.c));
    return { status: 'online', identity };
  });
  app.route<{ Params: { c: string; '*': string } }>({
    method: ['GET', 'POST'],
    url: '/api/connections/:c/*',
    bodyLimit: IMAGE_UPLOAD_BODY_LIMIT,
    handler: async (request, reply) => {
      const profile = owned(request, request.params.c);
      // Fastify decodes path parameters. Requiring the original canonical path avoids double-decoding and encoded separators.
      const suffix = '/' + request.params['*'];
      const canonical = `/api/connections/${profile.id}${suffix}`;
      if (request.url.split('?')[0] !== canonical || !isAllowedAgentRoute(request.method, suffix))
        throw new AppError('unsupported_feature', 'This Agent route is not available.', 404);
      const upstream = await verified(profile);
      if (suffix === '/identity') return upstream.identity;
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const headers: Record<string, string> = {
        authorization: `Bearer ${upstream.token}`,
        accept: typeof request.headers.accept === 'string' ? request.headers.accept : 'application/json',
      };
      for (const name of ['range', 'if-range', 'if-none-match', 'last-event-id']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const body = request.body === undefined ? undefined : JSON.stringify(request.body);
      if (body && !/^\/workspaces\/[^/]+\/images$/.test(suffix) && Buffer.byteLength(body) > 1048576)
        throw new AppError('request_too_large', '请求内容过大。', 413);
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      const controller = new AbortController();
      const sessionToken = request.cookies[requestAccess(request).cookieName]!;
      let controllers = active.get(sessionToken);
      if (!controllers) {
        controllers = new Set();
        active.set(sessionToken, controllers);
      }
      controllers.add(controller);
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(1, sessions.get(request)!.expiresAt - Date.now()),
      );
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        controller.abort();
        controllers?.delete(controller);
        if (controllers?.size === 0) active.delete(sessionToken);
      };
      reply.raw.once('close', cleanup);
      try {
        const response = await upstream.transport.request({
          method: request.method,
          path: suffix + query,
          headers,
          body,
          signal: controller.signal,
        });
        reply.code(response.statusCode ?? 502);
        for (const name of [
          'content-type',
          'content-length',
          'content-range',
          'accept-ranges',
          'etag',
          'last-modified',
          'retry-after',
          'content-disposition',
        ]) {
          const value = response.headers[name];
          if (value !== undefined) reply.header(name, value);
        }
        if (suffix.endsWith('/file')) {
          const mime = String(response.headers['content-type'] ?? '')
            .split(';')[0]
            .trim()
            .toLowerCase();
          if (
            [
              'text/html',
              'application/xhtml+xml',
              'image/svg+xml',
              'text/javascript',
              'application/javascript',
            ].includes(mime)
          ) {
            reply.header('Content-Type', 'text/plain; charset=utf-8');
            reply.header('Content-Disposition', 'attachment');
          }
        }
        reply.header('Cache-Control', 'no-store, private').header('X-Accel-Buffering', 'no');
        return reply.send(response);
      } catch (error) {
        cleanup();
        status.set(profile.id, 'offline');
        throw error;
      }
    },
  });
  if (config.staticDir) {
    await app.register(fastifyStatic, { root: config.staticDir, cacheControl: false, index: 'index.html' });
  }
  app.setNotFoundHandler((request, reply) => {
    if (!config.staticDir || request.url.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method))
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'Route not found.', requestId: request.id } });
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });
  app.addHook('preClose', async () => {
    for (const cs of active.values()) for (const c of cs) c.abort();
  });
  app.addHook('onClose', async () => {
    await Promise.all([...transports.values()].map((t) => t.close()));
    auth.close();
  });
  return app;
}
