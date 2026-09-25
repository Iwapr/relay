import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { watch } from 'chokidar';
import {
  AppError,
  answerInput,
  cancelInput,
  runInput,
  IMAGE_UPLOAD_BODY_LIMIT,
  type AgentIdentity,
  type WorkbenchEvent,
} from '../../../packages/contracts/src/index.ts';
import { Store } from './store.ts';
import { FileService } from './files.ts';
import { LockManager } from './locks.ts';
import { Transfers, uploadInput } from './transfers.ts';
import { Manager, type ProviderFactory, type StoredWorkspace } from './manager.ts';
import type { AgentConfig } from './config.ts';
import type { AccountState } from '../../../packages/provider-core/src/index.ts';
import { Terminals } from './terminals.ts';
import { registerAccounts } from './accounts.ts';

export async function buildAgent(
  config: AgentConfig,
  factory?: ProviderFactory,
  options: {
    accountChild?: boolean;
    lockDirectory?: string;
    onAccount?: (account: AccountState) => void;
  } = {},
) {
  if (process.getuid?.() === 0 && !config.allowRoot) throw new Error('Agent 不允许以 root 运行');
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDir, 0o700);
  const agentIdPath = join(config.stateDir, 'identity');
  if (!existsSync(agentIdPath)) writeFileSync(agentIdPath, randomUUID(), { mode: 0o600, flag: 'wx' });
  const agentId = readFileSync(agentIdPath, 'utf8').trim();
  const identity: AgentIdentity = {
    agentId,
    protocolVersion: 1,
    version: '0.1.0',
    uid: process.getuid!(),
    username: userInfo().username,
    home: homedir(),
    codexHome: config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    machineId: createHash('sha256').update(readFileSync('/etc/machine-id')).digest('hex'),
  };
  const token = readFileSync(config.tokenFile, 'utf8').trim();
  if (token.length < 32) throw new Error('Agent token 至少需要 32 字符');
  const store = new Store(config.stateDir, agentId);
  const files = await FileService.create({
    roots: config.roots,
    previewRoots: config.previewRoots ?? ['/tmp'],
    privateDirectory: config.stateDir,
    sensitivePaths: [
      identity.codexHome,
      ...(config.kimiHome ? [config.kimiHome] : []),
      join(identity.home, '.kimi-code'),
      ...(config.claudeHome ? [config.claudeHome] : []),
      join(config.stateDir, 'claude'),
      join(identity.home, '.claude'),
      join(identity.home, '.claude.json'),
      join(identity.home, '.gemini'),
      ...(config.authHome ? [config.authHome] : []),
      join(identity.home, '.ssh'),
      join(identity.home, '.config/remote-workbench'),
      join(identity.home, '.local/share/remote-workbench'),
      config.tokenFile,
      ...(config.sensitivePaths ?? []),
    ],
    maxPreviewBytes: config.maxPreviewBytes,
  });
  const locks = await LockManager.create({
    privateDirectory: options.lockDirectory ?? config.stateDir,
    machineId: identity.machineId,
    sharedLockDirectory: config.sharedLockDirectory,
  });
  const manager = new Manager(store, files, locks, identity, config, factory);
  const transfers = await Transfers.open(config.stateDir, files);
  const terminals = new Terminals();
  let accounts: ReturnType<typeof registerAccounts> | undefined;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const watchers = new Map<string, ReturnType<typeof watch>>();
  const previewWatchers = new Map<string, ReturnType<typeof watch>>();
  const streams = new Set<() => void>();
  const watcherTimers = new Set<ReturnType<typeof setTimeout>>();
  const recordChanges = (w: StoredWorkspace, paths: string[]) => {
    const visible = paths.filter((p) => files.isVisible(w.directoryInfo, p));
    if (!visible.length) return;
    store.transaction(() => {
      for (const p of visible) {
        const id = `${w.id}:${p}`;
        store.put('fileChange', id, {
          id,
          workspaceId: w.id,
          path: p,
          observedAt: new Date().toISOString(),
          source: 'filesystem-watcher',
        });
      }
      store.emit('files.changed', { paths: visible }, { workspaceId: w.id });
    });
  };
  const previewWatch = async (w: StoredWorkspace, p: string) => {
    if (!files.isVisible(w.directoryInfo, p)) return;
    const key = `${w.id}:${p}`;
    if (previewWatchers.has(key)) return;
    // Separate watches deliberately bypass the tree dependency/depth exclusions.
    if (previewWatchers.size >= 32) {
      const oldest = previewWatchers.entries().next().value;
      if (oldest) {
        previewWatchers.delete(oldest[0]);
        await oldest[1].close();
      }
    }
    const watcher = watch(join(w.canonicalRoot, p), {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    watcher.on('all', () => recordChanges(w, [p]));
    watcher.on('error', () => {});
    previewWatchers.set(key, watcher);
  };
  const watchWorkspace = (w: StoredWorkspace) => {
    if (watchers.has(w.id)) return;
    const watcher = watch(w.canonicalRoot, {
      ignoreInitial: true,
      depth: 5,
      followSymlinks: false,
      ignored: (path) => {
        const p = relative(w.canonicalRoot, path);
        return (
          (p !== '' && !files.isVisible(w.directoryInfo, p)) ||
          /(^|\/)(node_modules|\.cache|\.runtime)(\/|$)/.test(path)
        );
      },
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    let changed = new Set<string>(),
      timer: ReturnType<typeof setTimeout> | undefined;
    watcher.on('all', (_event, path) => {
      const p = relative(w.canonicalRoot, path);
      if (!p || p.startsWith('..') || !files.isVisible(w.directoryInfo, p)) return;
      changed.add(p);
      if (changed.size > 500) changed = new Set([...changed].slice(-500));
      if (timer) {
        clearTimeout(timer);
        watcherTimers.delete(timer);
      }
      timer = setTimeout(() => {
        watcherTimers.delete(timer!);
        recordChanges(w, [...changed]);
        changed.clear();
      }, 600);
      watcherTimers.add(timer);
    });
    watcher.on('error', () =>
      store.emit('provider.warning', { message: '文件监听失败，请手动刷新文件列表' }, { workspaceId: w.id }),
    );
    watchers.set(w.id, watcher);
  };
  for (const w of store.list<StoredWorkspace>('workspace')) watchWorkspace(w);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const received = req.headers.authorization ?? '',
      expected = `Bearer ${token}`;
    if (
      Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(expected))
    )
      throw new AppError('auth_required', '无效的 Agent 控制令牌', 401);
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as Error & { code?: string; statusCode?: number };
    if (e instanceof ZodError)
      return reply.code(400).send({ error: { code: 'invalid_request', message: '请求参数无效' } });
    const status = e.statusCode ?? 500;
    reply.code(status).send({
      error: {
        code: e.code ?? 'internal_error',
        message: status >= 500 ? 'Agent 操作失败，请检查远端服务诊断' : e.message,
      },
    });
  });
  const params = (req: { params: unknown }) => req.params as Record<string, string>;
  const query = (req: { query: unknown }) => req.query as Record<string, string | undefined>;
  const pagination = (q: Record<string, string | undefined>) => ({
    cursor: q.cursor,
    limit: q.limit ? Math.min(200, Math.max(1, Number(q.limit) || 100)) : 100,
    hidden: q.hidden === 'true',
  });
  app.get('/identity', async () => identity);
  app.get('/status', async () => ({
    status: 'online',
    identity,
    activeRuns:
      manager
        .snapshot()
        .runs.filter(
          (r) => !['completed', 'failed', 'cancelled', 'interrupted', 'uncertain'].includes(r.state),
        ).length + (accounts?.activeRuns() ?? 0),
    diagnostics: {
      agent: 'online',
      codexExecutable: config.codexExecutable,
      environmentProfile: '远端用户环境',
      taskUmask: config.taskUmask,
      sharedLocks: !!config.sharedLockDirectory,
    },
  }));
  app.get('/fs/roots', async () => ({ roots: await files.roots() }));
  app.get('/fs/directories', async (req) => {
    const q = query(req);
    return files.listDirectories(q.path, pagination(q));
  });
  app.post('/fs/directories', async (req) => {
    const body = z
      .object({ parent: z.string().min(1).max(4096), name: z.string().min(1).max(255) })
      .strict()
      .parse(req.body);
    return files.createDirectory(body.parent, body.name);
  });
  app.get('/workspaces', async () => ({ workspaces: store.list<StoredWorkspace>('workspace') }));
  app.post('/workspaces/open', async (req) => {
    const body = z
      // Accept the obsolete flag from older clients, but it has no effect.
      .object({ path: z.string().min(1).max(4096), trusted: z.boolean().optional() })
      .strict()
      .parse(req.body);
    const workspace = await manager.openWorkspace(body.path);
    watchWorkspace(workspace);
    return { workspace };
  });
  const terminalSize = z
    .object({
      cols: z.number().int().min(2).max(500),
      rows: z.number().int().min(1).max(300),
    })
    .strict();
  app.post('/workspaces/:w/terminals', async (req) => {
    const { cols, rows } = terminalSize.parse(req.body);
    const workspace = manager.workspace(params(req).w);
    // Revalidate the project before launching a shell in it.
    await files.openWorkspace(workspace.canonicalRoot);
    return terminals.open(workspace.id, workspace.canonicalRoot, cols, rows);
  });
  app.get('/workspaces/:w/terminals/:id', async (req) => {
    const cursor = z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(query(req).cursor ?? 0);
    return terminals.read(params(req).w, params(req).id, cursor);
  });
  app.post('/workspaces/:w/terminals/:id/input', async (req) => {
    const { data } = z
      .object({ data: z.string().min(1).max(16384) })
      .strict()
      .parse(req.body);
    terminals.write(params(req).w, params(req).id, data);
    return { ok: true };
  });
  app.post('/workspaces/:w/terminals/:id/resize', async (req) => {
    const { cols, rows } = terminalSize.parse(req.body);
    terminals.resize(params(req).w, params(req).id, cols, rows);
    return { ok: true };
  });
  app.post('/workspaces/:w/terminals/:id/close', async (req) => {
    terminals.close(params(req).w, params(req).id);
    return { ok: true };
  });
  app.get('/workspaces/:w/tree', async (req) => {
    const q = query(req);
    return files.tree(manager.workspace(params(req).w).directoryInfo, { path: q.path, ...pagination(q) });
  });
  app.post('/workspaces/:w/files/manage', async (req) => {
    const input = z
      .object({
        action: z.enum(['file', 'directory', 'rename', 'move', 'copy', 'delete']),
        path: z.string().min(1).max(4096).optional(),
        target: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .parse(req.body);
    const w = manager.workspace(params(req).w);
    const result = await manager.withIdleWorkspace(w.id, () => files.manage(w.directoryInfo, input));
    recordChanges(
      w,
      [input.path, input.target].filter((p): p is string => !!p),
    );
    return result;
  });
  app.post('/workspaces/:w/uploads', { bodyLimit: IMAGE_UPLOAD_BODY_LIMIT }, async (req) => {
    const w = manager.workspace(params(req).w);
    const input = uploadInput.parse(req.body);
    const result = await transfers.upload(
      w.id,
      w.directoryInfo,
      input,
      (action) => manager.withIdleWorkspace(w.id, action),
      config.taskUmask,
    );
    if (input.action === 'finish') recordChanges(w, [(result as { path: string }).path]);
    return result;
  });
  app.post('/workspaces/:w/downloads', async (req) => {
    const input = z
      .object({ paths: z.array(z.string().max(4096)).min(1).max(1000), archive: z.boolean() })
      .strict()
      .parse(req.body);
    const w = manager.workspace(params(req).w);
    return transfers.prepare(w.id, w.directoryInfo, input.paths, input.archive);
  });
  app.get('/workspaces/:w/downloads/:id', async (req, reply) => {
    const w = manager.workspace(params(req).w);
    await files.validate(w.directoryInfo);
    const result = await transfers.read(w.id, params(req).id);
    return reply
      .header('Content-Type', result.archive ? 'application/zip' : 'application/octet-stream')
      .header('Content-Length', result.size)
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(result.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
      )
      .header('Cache-Control', 'no-store, private')
      .send(result.stream);
  });
  app.get('/workspaces/:w/metadata', async (req) => {
    const q = query(req),
      w = manager.workspace(params(req).w),
      meta = await files.metadata(w.directoryInfo, q.path ?? '');
    await previewWatch(w, q.path ?? '');
    return meta;
  });
  app.get('/workspaces/:w/file', async (req, reply) => {
    const q = query(req),
      w = manager.workspace(params(req).w);
    const result = await files.file(w.directoryInfo, q.path ?? '', {
      version: q.version,
      range: req.headers.range,
    });
    if (q.path) await previewWatch(w, q.path);
    for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
    return reply.code(result.statusCode).send(result.body);
  });
  app.get('/workspaces/:w/changes', async (req) => {
    const w = manager.workspace(params(req).w),
      changes = await files.changes(w.directoryInfo);
    return {
      ...changes,
      observed: store
        .list<{ workspaceId: string; path: string; observedAt: string }>('fileChange')
        .filter((entry) => entry.workspaceId === w.id && files.isVisible(w.directoryInfo, entry.path))
        .slice(-200)
        .reverse(),
    };
  });
  app.post('/workspaces/:w/conversations', async (req) => {
    const body = z
      .object({ title: z.string().max(200).default('新对话') })
      .strict()
      .parse(req.body);
    return { conversation: manager.createConversation(params(req).w, body.title) };
  });
  app.post('/conversations/:id/title', async (req) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(200) })
      .strict()
      .parse(req.body);
    return { conversation: manager.renameConversation(params(req).id, body.title) };
  });
  app.post('/workspaces/:w/images', { bodyLimit: IMAGE_UPLOAD_BODY_LIMIT }, async (req) => {
    const workspace = manager.workspace(params(req).w);
    await files.validate(workspace.directoryInfo);
    return { image: manager.images.upload(workspace.id, req.body) };
  });
  app.get('/workspaces/:w/images/:id', async (req, reply) => {
    const workspace = manager.workspace(params(req).w);
    await files.validate(workspace.directoryInfo);
    const result = manager.images.read(workspace.id, params(req).id);
    return reply
      .header('Content-Type', result.image.mimeType)
      .header('Content-Length', result.bytes.length)
      .header('Content-Disposition', 'inline')
      .send(result.bytes);
  });
  app.get('/workspaces/:w/conversations', async (req) => {
    manager.workspace(params(req).w);
    return { conversations: manager.snapshot().conversations.filter((c) => c.workspaceId === params(req).w) };
  });
  app.get('/workspaces/:w/native-sessions', async (req) => {
    const input = z
      .object({
        cursor: z.string().max(4096).optional(),
        scope: z.enum(['workspace', 'all']).default('workspace'),
      })
      .parse(req.query);
    return manager.nativeSessions(params(req).w, input.cursor, input.scope);
  });
  app.post('/workspaces/:w/native-sessions/import', async (req) => {
    const input = z
      .object({
        threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
        scope: z.enum(['workspace', 'all']).default('workspace'),
      })
      .strict()
      .parse(req.body);
    if (input.scope === 'all') return manager.importDiscoveredNativeSession(input.threadId, params(req).w);
    const conversation = await manager.importNativeSession(params(req).w, input.threadId);
    return { conversation, workspace: manager.workspace(conversation.workspaceId) };
  });
  app.get('/providers/codex/sessions', async (req) => {
    const input = z.object({ cursor: z.string().max(4096).optional() }).parse(req.query);
    return manager.nativeSessions(undefined, input.cursor, 'all');
  });
  app.post('/providers/codex/sessions/import', async (req) => {
    const input = z
      .object({ threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/) })
      .strict()
      .parse(req.body);
    return manager.importDiscoveredNativeSession(input.threadId);
  });
  app.get('/conversations/:id', async (req) => {
    const id = params(req).id,
      c = manager.conversation(id),
      q = query(req);
    if (q.view === 'page') {
      const input = z
        .object({
          limit: z.coerce.number().int().min(1).max(40).default(6),
          before: z.string().max(100).optional(),
        })
        .parse(q);
      return manager.conversationPage(id, input.limit, input.before);
    }
    let nativeHistory;
    let nativeHistoryError: string | undefined;
    const nativeLimit =
      q.view === 'native' ? z.coerce.number().int().min(1).max(100).default(6).parse(q.limit) : 100;
    try {
      nativeHistory = await manager.nativeHistory(id, nativeLimit);
    } catch (error) {
      nativeHistoryError =
        error instanceof AppError
          ? error.message
          : '暂时无法读取原生 Codex 记录，请稍后刷新；已有工作台记录仍可查看。';
    }
    if (q.view === 'native')
      return {
        conversation: c,
        takeoverAvailable: await manager.takeoverAvailable(id),
        ...(nativeHistory ? { nativeHistory } : {}),
        ...(nativeHistoryError ? { nativeHistoryError } : {}),
      };
    return {
      conversation: c,
      takeoverAvailable: await manager.takeoverAvailable(id),
      ...(nativeHistory ? { nativeHistory } : {}),
      ...(nativeHistoryError ? { nativeHistoryError } : {}),
      runs: manager.snapshot().runs.filter((r) => r.conversationId === id),
      messages: store.list<{ conversationId: string }>('message').filter((m) => m.conversationId === id),
      events: store.history(id, Number(q.afterSeq) || 0, Math.min(Number(q.limit) || 500, 1000)),
    };
  });
  app.post('/conversations/:id/runs', async (req) => ({
    run: await manager.submit(params(req).id, runInput.parse(req.body)),
  }));
  app.post('/conversations/:id/takeover/preview', async (req) => {
    z.object({}).strict().parse(req.body);
    return manager.previewTakeover(params(req).id);
  });
  app.post('/conversations/:id/takeover', async (req) =>
    manager.takeover(
      params(req).id,
      z
        .object({
          token: z.string().uuid(),
          clientRequestId: z.string().uuid(),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.post('/conversations/:id/reply', async (req) =>
    manager.reply(params(req).id, runInput.parse(req.body)),
  );
  app.post('/runs/:id/cancel', async (req) => ({
    run: await manager.cancel(params(req).id, cancelInput.parse(req.body).clientRequestId),
  }));
  app.post('/runs/:id/rollback/preview', async (req) => manager.previewRollback(params(req).id));
  app.post('/runs/:id/rollback', async (req) =>
    manager.rollback(
      params(req).id,
      z
        .object({
          clientRequestId: z.string().uuid(),
          token: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.post('/conversations/:id/fork', async (req) => {
    const input = z
      .object({ turnId: z.string().min(1).max(200), model: z.string().min(1).max(200) })
      .strict()
      .parse(req.body);
    return manager.forkConversation(params(req).id, input.turnId, input.model);
  });
  app.post('/interactions/:id/answer', async (req) => ({
    interaction: await manager.answer(params(req).id, answerInput.parse(req.body)),
  }));
  app.get('/providers', async () => {
    try {
      const p = await manager.provider();
      await manager.accountReader.read('account');
      return {
        providers: [
          {
            id: config.provider ?? 'codex',
            name:
              config.provider === 'claude' ? 'Claude' : config.provider === 'kimi' ? 'Kimi Code' : 'Codex',
            capabilities: p.capabilities(),
          },
        ],
      };
    } catch {
      return { providers: [], error: '模型服务尚未就绪；文件浏览仍可使用' };
    }
  });
  const providerPath = '/providers/' + (config.provider ?? 'codex');
  app.get(providerPath + '/account', async () => {
    const account = await manager.accountReader.read('account');
    store.put('accountState', 'current', account);
    options.onAccount?.(account);
    return account;
  });
  app.get(providerPath + '/models', async () => ({ models: await manager.accountReader.read('models') }));
  app.get(providerPath + '/quota', async () => ({ quota: await manager.accountReader.read('quota') }));
  app.post(providerPath + '/login', async () => manager.login());
  app.post(providerPath + '/login/cancel', async () => manager.cancelLogin());
  if (config.provider === 'claude')
    app.post(providerPath + '/login/code', async (req) => {
      const input = z
        .object({
          code: z
            .string()
            .trim()
            .min(1)
            .max(4096)
            .regex(/^[^\r\n]+$/),
          loginId: z.uuid(),
        })
        .strict()
        .parse(req.body);
      return manager.completeLogin(input.code, input.loginId);
    });
  if (!options.accountChild) accounts = registerAccounts(app, config, store, token, factory);
  app.get('/snapshot', async (req) => manager.snapshot(query(req).view !== 'summary'));
  app.get('/events', async (req, reply) => {
    const q = query(req),
      last = String(req.headers['last-event-id'] ?? '');
    const [lastAgent, lastSeq] = last.split(':');
    if ((q.agentId && q.agentId !== agentId) || (lastAgent && lastAgent !== agentId))
      throw new AppError('snapshot_required', 'Agent 身份已变化，请重新同步', 409);
    let seq = Number(lastSeq ?? q.afterSeq ?? 0);
    if (!Number.isSafeInteger(seq) || seq < store.replayFloor() || seq > store.sequence())
      throw new AppError('snapshot_required', '事件位置无效或已过保留期限，请重新同步', 409);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: WorkbenchEvent) => {
      if (event.seq <= seq) return;
      seq = event.seq;
      const writable = reply.raw.write(`id: ${agentId}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      if (!writable && reply.raw.writableLength > 1024 * 1024) reply.raw.destroy();
    };
    // Synchronous catch-up + subscription leaves no event gap in this process.
    while (true) {
      const batch = store.replay(seq);
      for (const event of batch) send(event);
      if (batch.length < 1000) break;
    }
    store.events.on('event', send);
    const ping = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
    const close = () => {
      clearInterval(ping);
      store.events.off('event', send);
      streams.delete(close);
      if (!reply.raw.destroyed) reply.raw.end();
    };
    streams.add(close);
    req.raw.on('close', close);
  });
  const retention = setInterval(() => store.prune(), 60_000);
  retention.unref();
  app.addHook('preClose', async () => {
    for (const close of streams) close();
  });
  app.addHook('onClose', async () => {
    clearInterval(retention);
    terminals.dispose();
    await Promise.all([...watchers.values(), ...previewWatchers.values()].map((w) => w.close()));
    for (const timer of watcherTimers) clearTimeout(timer);
    watcherTimers.clear();
    await manager.close();
    await transfers.close();
    store.prune();
    store.close();
  });
  return { app, manager, store, identity, files };
}
