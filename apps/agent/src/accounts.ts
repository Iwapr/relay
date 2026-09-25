import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError, IMAGE_UPLOAD_BODY_LIMIT, terminalStates } from '../../../packages/contracts/src/index.ts';
import { isAllowedAgentRoute } from '../../../packages/contracts/src/agent-routes.ts';
import type { AccountState } from '../../../packages/provider-core/src/index.ts';
import { AgentTransport } from '../../../packages/transport-ssh/src/index.ts';
import type { AgentConfig } from './config.ts';
import type { ProviderFactory } from './manager.ts';
import type { Store } from './store.ts';
import { migrateHistory } from '../../../packages/provider-codex/src/migrate-history.ts';
import { buildAgent } from './server.ts';

interface AccountProfile {
  id: string;
  label: string;
  provider?: string;
  account?: AccountState;
}

/** Each account owns its authorization and task store; native history uses one shared Codex home. The owner session
 * stays at the gateway; account selection is explicit in every request URL. */
export function registerAccounts(
  app: FastifyInstance,
  config: AgentConfig,
  store: Store,
  token: string,
  factory?: ProviderFactory,
) {
  const children = new Map<string, Promise<Awaited<ReturnType<typeof buildAgent>>>>();
  const running = new Map<string, Awaited<ReturnType<typeof buildAgent>>>();
  const transports = new Map<string, AgentTransport>();
  let socketDirectory: Promise<string> | undefined;
  let closing = false;
  const deleting = new Set<string>();
  const mutations = new Map<string, number>();
  const home = (id: string) => join(config.stateDir, 'accounts', id, 'codex');
  const supported = (profile: AccountProfile) =>
    profile.provider === undefined ||
    profile.provider === 'codex' ||
    profile.provider === 'kimi' ||
    profile.provider === 'claude';
  const child = (profile: AccountProfile) => {
    if (!supported(profile)) throw new AppError('unsupported_feature', '此账号的提供方已不再支持', 404);
    if (closing) throw new AppError('agent_unavailable', 'Agent 正在停止', 503);
    let pending = children.get(profile.id);
    if (pending) return pending;
    pending = (async () => {
      const socketDir = await (socketDirectory ??= mkdtemp(join(tmpdir(), 'relay-accounts-')));
      const directory = join(config.stateDir, 'accounts', profile.id);
      await mkdir(home(profile.id), { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const kimi = profile.provider === 'kimi';
      const claude = profile.provider === 'claude';
      const codex = !kimi && !claude;
      const claudeHome = join(directory, 'claude');
      if (claude) await mkdir(claudeHome, { recursive: true, mode: 0o700 });
      const kimiHome = join(directory, 'kimi');
      if (kimi) await mkdir(kimiHome, { recursive: true, mode: 0o700 });
      const childConfig: AgentConfig = {
        ...config,
        codexHome: config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
        provider: claude ? 'claude' : kimi ? 'kimi' : 'codex',
        claudeHome: claude ? claudeHome : undefined,
        kimiHome: kimi ? kimiHome : undefined,
        authHome: codex ? home(profile.id) : undefined,
        accountLabel: profile.label,
        stateDir: join(directory, 'state'),
        socketPath: join(socketDir, profile.id + '.sock'),
        sensitivePaths: [
          ...(config.sensitivePaths ?? []),
          config.stateDir,
          config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
        ],
      };
      if (codex) await migrateHistory(home(profile.id), childConfig.codexHome!);
      const agent = await buildAgent(childConfig, codex ? factory : undefined, {
        accountChild: true,
        lockDirectory: config.stateDir,
        onAccount: (account) => {
          store.put('codexAccount', profile.id, { ...profile, account });
        },
      });
      try {
        await agent.app.listen({ path: childConfig.socketPath });
        await chmod(childConfig.socketPath, 0o600);
        running.set(profile.id, agent);
        transports.set(
          profile.id,
          new AgentTransport({ kind: 'unix', socketPath: childConfig.socketPath }, socketDir),
        );
        return agent;
      } catch (error) {
        await agent.app.close();
        throw error;
      }
    })();
    children.set(profile.id, pending);
    pending.catch(() => children.delete(profile.id));
    return pending;
  };
  app.get('/providers/codex/accounts', async () => ({
    accounts: [
      {
        id: 'default',
        provider: 'codex',
        label: '跟随 Codex',
        account: store.get<AccountState>('accountState', 'current'),
      },
      ...store.list<AccountProfile>('codexAccount').filter(supported),
    ],
  }));
  app.post('/providers/codex/accounts', async (request) => {
    const { label, provider } = z
      .object({
        label: z.string().trim().min(1).max(60),
        provider: z.enum(['codex', 'kimi', 'claude']).default('codex'),
      })
      .strict()
      .parse(request.body);
    if (
      store.list<AccountProfile>('codexAccount').filter((p) => (p.provider ?? 'codex') === provider).length >=
      8
    )
      throw new AppError(
        'account_limit',
        `最多添加 8 个 ${provider === 'claude' ? 'Claude' : provider === 'kimi' ? 'Kimi Code' : 'ChatGPT'} 账号`,
        409,
      );
    const profile: AccountProfile = { id: randomUUID(), label, provider };
    // Persist before yielding, so concurrent requests respect the limit. Login can
    // be retried in this profile without creating or copying any credentials.
    store.put('codexAccount', profile.id, profile);
    return { account: profile };
  });
  app.post<{ Params: { id: string } }>('/providers/codex/accounts/:id/delete', async (request) => {
    z.object({}).strict().parse(request.body);
    const id = z.uuid().parse(request.params.id);
    if (closing || deleting.has(id) || (mutations.get(id) ?? 0) > 0)
      throw new AppError('run_conflict', '账号正在处理请求，请稍后重试', 409);
    const profile = store.require<AccountProfile>('codexAccount', id);
    deleting.add(id);
    try {
      const agent = await child(profile);
      agent.manager.assertAccountDeletable();
      await agent.app.close(); // also cancels pending device authorization and closes SSE readers
      await transports.get(id)?.close();
      children.delete(id);
      running.delete(id);
      transports.delete(id);
      await rm(join(config.stateDir, 'accounts', id), { recursive: true, force: true });
      store.remove('codexAccount', id);
      mutations.delete(id);
      return { ok: true };
    } finally {
      deleting.delete(id);
    }
  });
  app.route<{ Params: { id: string; '*': string } }>({
    method: ['GET', 'POST'],
    url: '/accounts/:id/*',
    bodyLimit: IMAGE_UPLOAD_BODY_LIMIT,
    handler: async (request, reply) => {
      const { id } = request.params;
      const suffix = '/' + request.params['*'];
      const canonical = '/accounts/' + id + suffix;
      if (request.url.split('?')[0] !== canonical || !isAllowedAgentRoute(request.method, canonical))
        throw new AppError('unsupported_feature', '此账号接口不可用', 404);
      if (deleting.has(id)) throw new AppError('run_conflict', '此账号正在删除', 409);
      const profile = store.require<AccountProfile>('codexAccount', id);
      if (request.method === 'POST') {
        mutations.set(id, (mutations.get(id) ?? 0) + 1);
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          mutations.set(id, Math.max(0, (mutations.get(id) ?? 1) - 1));
        };
        reply.raw.once('finish', finish);
        reply.raw.once('close', finish);
      }
      await child(profile);
      const transport = transports.get(id)!;
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const connect = suffix === '/connect';
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      for (const name of ['accept', 'range', 'if-range', 'if-none-match', 'last-event-id']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const body = connect || request.body === undefined ? undefined : JSON.stringify(request.body);
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      const controller = new AbortController();
      reply.raw.once('close', () => controller.abort());
      const response = await transport.request({
        method: connect ? 'GET' : request.method,
        path: (connect ? '/identity' : suffix) + query,
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
        'content-disposition',
      ]) {
        const value = response.headers[name];
        if (value !== undefined) reply.header(name, value);
      }
      return reply.send(response);
    },
  });
  // SSE streams must be closed before Fastify waits for in-flight proxy requests.
  app.addHook('preClose', async () => {
    closing = true;
    await Promise.all(
      [...children.values()].map(async (pending) => {
        const agent = await pending.catch(() => null);
        if (agent) await agent.app.close();
      }),
    );
    await Promise.all([...transports.values()].map((transport) => transport.close()));
    if (socketDirectory) await rm(await socketDirectory, { recursive: true, force: true });
  });
  return {
    activeRuns: () =>
      [...running.values()].reduce(
        (total, agent) =>
          total + agent.manager.snapshot().runs.filter((run) => !terminalStates.includes(run.state)).length,
        0,
      ),
  };
}
