import { RunUsageSchema } from '../../../packages/contracts/src/index.ts';
import { FactoryAdapter, FACTORY_VERSION } from '../../../packages/provider-factory/src/index.ts';
import { writeFactoryKey } from '../../../packages/provider-factory/src/credentials.ts';
import { DeepSeekAdapter, DEEPSEEK_HARNESS_VERSION } from '../../../packages/provider-deepseek/src/index.ts';
import { writeKey } from '../../../packages/provider-deepseek/src/credentials.ts';
import {
  readGeminiSettings,
  writeGeminiSettings,
  type GeminiSettings,
} from '../../../packages/provider-gemini/src/settings.ts';
import { GeminiAdapter, ANTIGRAVITY_VERSION } from '../../../packages/provider-gemini/src/index.ts';
import { randomUUID } from 'node:crypto';
import { join, normalize, isAbsolute, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import {
  AppError,
  terminalStates,
  type AgentIdentity,
  type Conversation,
  type Interaction,
  type Run,
  type RunState,
  type Workspace,
} from '../../../packages/contracts/src/index.ts';
import type {
  AIProviderAdapter,
  ProviderEvent,
  NativeSessionSummary,
  NativeSessionHistory,
} from '../../../packages/provider-core/src/index.ts';
import { CodexAuthBroker } from '../../../packages/provider-codex/src/auth.ts';
import { ClaudeAdapter, CLAUDE_VERSION } from '../../../packages/provider-claude/src/index.ts';
import { KimiAdapter, KIMI_VERSION } from '../../../packages/provider-kimi/src/index.ts';
import { CodexAdapter } from '../../../packages/provider-codex/src/index.ts';
import { SUPPORTED_CODEX_VERSION } from '../../../packages/provider-codex/src/protocol.ts';
import { Store } from './store.ts';
import { FileService, type WorkspaceDirectory } from './files.ts';
import { LockManager } from './locks.ts';
import type { AgentConfig } from './config.ts';
import { ImageStore } from './images.ts';
import { AccountReader } from './account-reader.ts';
import { questionSignature } from '../../../packages/provider-core/src/questions.ts';

export type StoredWorkspace = Workspace & { directoryInfo: WorkspaceDirectory };
export type ProviderFactory = (cwd: string, codexHome?: string, authHome?: string) => AIProviderAdapter;
interface Checkpoint {
  filesOnly?: boolean;
  before: string;
  after?: string;
  previousTurnId: string | null;
}
interface RestorePreview {
  token: string;
  files: Array<{ path: string; action: 'remove' | 'restore' | 'recreate' }>;
}
export interface Message {
  id: string;
  runId: string;
  conversationId: string;
  workspaceId: string;
  kind: string;
  text: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
const MAX_MESSAGE_BYTES = 256 * 1024;
function boundedText(text: string, maxBytes: number) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const decoder = new StringDecoder('utf8');
  return { text: decoder.write(Buffer.from(text).subarray(0, Math.max(0, maxBytes))), truncated: true };
}
/** Tool summaries are display data, not approval requests or executable input. */
function boundedToolPayload(input: Record<string, unknown>) {
  let remaining = 32 * 1024,
    nodes = 0,
    truncated = false;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 1000 || depth > 6) {
      truncated = true;
      return '[details truncated]';
    }
    if (typeof value === 'string') {
      const bounded = boundedText(value, Math.max(0, Math.min(8192, remaining)));
      remaining -= Buffer.byteLength(bounded.text);
      truncated ||= bounded.truncated;
      return bounded.text;
    }
    if (Array.isArray(value)) {
      if (value.length > 100) truncated = true;
      return value.slice(0, 100).map((item) => visit(item, depth + 1));
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length > 50) truncated = true;
      return Object.fromEntries(
        entries.slice(0, 50).map(([key, item]) => [key.slice(0, 256), visit(item, depth + 1)]),
      );
    }
    return value;
  };
  const summary = Object.fromEntries(
    Object.entries(input).filter(([key]) => !['text', 'delta', 'output', 'aggregatedOutput'].includes(key)),
  );
  return { payload: visit(summary, 0) as Record<string, unknown>, truncated };
}
export class Manager {
  readonly images: ImageStore;
  readonly accountReader: AccountReader;
  private providers = new Map<string, { adapter: AIProviderAdapter; used: number }>();
  private active = new Map<
    string,
    { runId: string; release: (options?: { uncertain?: boolean }) => Promise<void> | void }
  >();
  private starting = new Set<string>();
  private maintenance = new Set<string>();
  private maintenanceTasks = new Set<Promise<void>>();
  private finishing = new Map<string, Promise<void>>();
  private retiring = new Map<string, Promise<void>>();
  private sessionReleases = new Map<string, string>();
  private executing = new Set<Promise<void>>();
  private reroutedModels = new Map<string, string>();
  private timer: ReturnType<typeof setInterval>;
  private closing = false;
  private loginPending = false;
  private settingsUpdating = false;
  private takeoverPlans = new Map<
    string,
    {
      token: string;
      expires: number;
      threadId: string;
      fingerprint: string;
      sessions: string[];
    }
  >();
  private authBroker?: CodexAuthBroker;
  constructor(
    readonly store: Store,
    readonly files: FileService,
    readonly locks: LockManager,
    readonly identity: AgentIdentity,
    readonly config: AgentConfig,
    private factory: ProviderFactory = (cwd) =>
      config.provider === 'factory'
        ? new FactoryAdapter({
            cwd,
            home: config.factoryHome ?? join(config.stateDir, 'factory'),
            executable: config.factoryExecutable,
            taskUmask: config.taskUmask,
          })
        : config.provider === 'deepseek'
          ? new DeepSeekAdapter({
              cwd,
              home: config.deepseekHome ?? join(config.stateDir, 'deepseek'),
              executable: config.deepseekExecutable,
              taskUmask: config.taskUmask,
            })
          : config.provider === 'antigravity'
            ? new GeminiAdapter({
                cwd,
                home: config.antigravityHome ?? join(config.stateDir, 'antigravity'),
                executable: config.antigravityExecutable,
                taskUmask: config.taskUmask,
              })
            : config.provider === 'claude'
              ? new ClaudeAdapter({
                  cwd,
                  home: config.claudeHome ?? join(config.stateDir, 'claude'),
                  executable: config.claudeExecutable,
                  taskUmask: config.taskUmask,
                })
              : config.provider === 'kimi'
                ? new KimiAdapter({
                    cwd,
                    home: config.kimiHome!,
                    executable: config.kimiExecutable,
                    taskUmask: config.taskUmask,
                  })
                : new CodexAdapter({
                    cwd,
                    executable: config.codexExecutable,
                    taskUmask: config.taskUmask,
                    codexHome: identity.codexHome,
                    credentialStore: config.codexHome ? 'file' : undefined,
                    authBroker: this.authBroker,
                  }),
    private readonly observeRun?: (workspace: StoredWorkspace, run: Run) => Promise<void>,
  ) {
    if (config.authHome && (!config.provider || config.provider === 'codex'))
      this.authBroker = new CodexAuthBroker({ home: config.authHome, executable: config.codexExecutable });
    this.accountReader = new AccountReader(() =>
      this.factory(config.stateDir, identity.codexHome, config.authHome),
    );
    this.images = new ImageStore(store, config.stateDir);
    store.transaction(() => {
      // Older releases stored a per-project execution gate. Retire it without
      // changing project IDs, directory identities, or their conversations.
      for (const workspace of store.list<StoredWorkspace & { trusted?: boolean }>('workspace')) {
        if (!Object.hasOwn(workspace, 'trusted')) continue;
        delete workspace.trusted;
        store.put('workspace', workspace.id, workspace);
        store.emit('workspace.opened', { workspace }, { workspaceId: workspace.id });
      }
      for (const run of store.list<Run>('run')) {
        if (run.restorePoint?.state === 'preparing') {
          run.restorePoint = { state: 'unavailable', reason: 'Agent 重启前未完成文件恢复点，不能安全回滚' };
          store.put('run', run.id, run);
        }
      }
      for (const run of store.list<Run>('run'))
        if (!terminalStates.includes(run.state))
          this.state(
            run,
            run.state === 'starting' ? 'uncertain' : 'interrupted',
            'Agent 已重新启动；未自动重复执行。请检查文件与原生会话。',
          );
      for (const interaction of store.list<Interaction>('interaction'))
        if (interaction.status === 'pending') {
          interaction.status = 'expired';
          store.put('interaction', interaction.id, interaction);
        }
    });
    this.timer = setInterval(() => {
      void this.drain();
    }, 1500);
    this.timer.unref();
  }
  workspace(id: string) {
    return this.store.require<StoredWorkspace>('workspace', id);
  }
  conversation(id: string) {
    return this.store.require<Conversation>('conversation', id);
  }
  async openWorkspace(path: string) {
    const directoryInfo = await this.files.openWorkspace(path);
    const key = JSON.stringify(directoryInfo.directoryIdentity);
    let workspace = this.store
      .list<StoredWorkspace>('workspace')
      .find((w) => w.directoryIdentity === key && w.canonicalRoot === directoryInfo.canonicalRoot);
    if (!workspace)
      workspace = {
        id: randomUUID(),
        agentId: this.identity.agentId,
        canonicalRoot: directoryInfo.canonicalRoot,
        directoryIdentity: key,
        directoryInfo,
        writable: directoryInfo.writable,
        createdAt: new Date().toISOString(),
      };
    else
      workspace = {
        ...workspace,
        directoryInfo,
        writable: directoryInfo.writable,
      };
    this.store.transaction(() => {
      this.store.put('workspace', workspace!.id, workspace);
      this.store.emit('workspace.opened', { workspace: workspace! }, { workspaceId: workspace!.id });
    });
    return workspace;
  }
  createConversation(workspaceId: string, title: string) {
    this.workspace(workspaceId);
    const conversation: Conversation = {
      id: randomUUID(),
      workspaceId,
      title: title || '新对话',
      providerId: this.config.provider ?? 'codex',
      providerSessionId: null,
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.store.put('conversation', conversation.id, conversation);
      this.store.emit(
        'conversation.created',
        { conversation },
        { workspaceId, conversationId: conversation.id },
      );
    });
    return conversation;
  }
  renameConversation(id: string, title: string) {
    const conversation = { ...this.conversation(id), title, titleCustomized: true };
    this.store.transaction(() => {
      this.store.put('conversation', id, conversation);
      this.store.emit(
        'conversation.updated',
        { conversation },
        { workspaceId: conversation.workspaceId, conversationId: id },
      );
    });
    return conversation;
  }
  private async nativeProvider(workspaceId: string) {
    const workspace = this.workspace(workspaceId);
    await this.files.validate(workspace.directoryInfo);
    const adapter = await this.provider(workspaceId);
    if (!adapter.listNativeSessions || (!adapter.readNativeSession && !adapter.readNativeSessionMetadata))
      throw new AppError('unsupported_feature', '当前 Codex 版本不支持共享会话', 409);
    return { workspace, adapter };
  }
  private nativeSummary(
    workspace: Pick<WorkspaceDirectory, 'canonicalRoot'>,
    session: NativeSessionSummary,
  ): NativeSessionSummary {
    if (
      !/^[a-zA-Z0-9_-]{1,200}$/.test(session.id) ||
      !isAbsolute(session.cwd) ||
      normalize(session.cwd) !== workspace.canonicalRoot
    )
      throw new AppError('permission_denied', '此 Codex 会话不属于当前项目', 403);
    return {
      id: session.id,
      title:
        this.store
          .list<Conversation>('conversation')
          .find(
            (c) =>
              c.providerSessionId === session.id &&
              c.titleCustomized &&
              this.workspace(c.workspaceId).canonicalRoot === workspace.canonicalRoot,
          )?.title ??
        (session.title.slice(0, 200) || 'Codex 会话'),
      cwd: workspace.canonicalRoot,
      updatedAt: session.updatedAt,
      ...(session.model ? { model: session.model.slice(0, 200) } : {}),
      ...(session.source ? { source: session.source.slice(0, 80) } : {}),
      ...(session.status ? { status: session.status.slice(0, 80) } : {}),
    };
  }
  private async nativeDiscoveryProvider(workspaceId?: string) {
    if (workspaceId) return (await this.nativeProvider(workspaceId)).adapter;
    const adapter = await this.provider();
    if (!adapter.listNativeSessions || !adapter.readNativeSessionMetadata)
      throw new AppError('unsupported_feature', '当前 Codex 版本不支持共享会话', 409);
    return adapter;
  }
  private async nativeDirectory(cwd: string) {
    const directoryInfo = await this.files.openWorkspace(cwd);
    const known = this.store
      .list<StoredWorkspace>('workspace')
      .filter((workspace) => workspace.canonicalRoot === directoryInfo.canonicalRoot);
    const key = JSON.stringify(directoryInfo.directoryIdentity);
    const existing = known.find((workspace) => workspace.directoryIdentity === key);
    if (known.length && !existing)
      throw new AppError('workspace_replaced', '会话原来的项目目录已被替换，请重新选择并确认项目', 409);
    if (existing) await this.files.validate(existing.directoryInfo);
    return { directoryInfo, existing };
  }
  async nativeSessions(
    workspaceId: string | undefined,
    cursor?: string,
    scope: 'workspace' | 'all' = 'workspace',
  ) {
    if (scope === 'all') {
      const adapter = await this.nativeDiscoveryProvider(workspaceId);
      const result = await adapter.listNativeSessions!(cursor, 'all');
      const directories = new Map<string, Awaited<ReturnType<Manager['nativeDirectory']>> | null>();
      const sessions: NativeSessionSummary[] = [];
      for (const session of result.sessions.slice(0, 100)) {
        // A native index can contain deleted, private, or disallowed project paths.
        // Validate them before exposing even a title, and amortize checks per directory.
        if (!directories.has(session.cwd)) {
          try {
            directories.set(session.cwd, await this.nativeDirectory(session.cwd));
          } catch {
            directories.set(session.cwd, null);
          }
        }
        const directory = directories.get(session.cwd);
        if (!directory) continue;
        sessions.push(this.nativeSummary(directory.directoryInfo, session));
      }
      return { sessions, nextCursor: result.nextCursor };
    }
    if (!workspaceId) throw new AppError('invalid_request', '请选择项目', 400);
    const { workspace, adapter } = await this.nativeProvider(workspaceId);
    const result = await adapter.listNativeSessions!(cursor);
    const sessions: NativeSessionSummary[] = [];
    for (const session of result.sessions.slice(0, 100)) {
      // Recheck provider results at the Agent boundary; no other project's titles leak.
      if (!isAbsolute(session.cwd) || normalize(session.cwd) !== workspace.canonicalRoot) continue;
      sessions.push(this.nativeSummary(workspace, session));
    }
    return { sessions, nextCursor: result.nextCursor };
  }
  async importDiscoveredNativeSession(threadId: string, workspaceId?: string) {
    const adapter = await this.nativeDiscoveryProvider(workspaceId);
    if (!adapter.readNativeSessionMetadata)
      throw new AppError('unsupported_feature', '当前 Codex 版本不支持跨项目共享会话', 409);
    const metadata = await adapter.readNativeSessionMetadata(threadId);
    if (metadata.id !== threadId) throw new AppError('permission_denied', 'Codex 会话标识不匹配', 403);
    const { directoryInfo, existing } = await this.nativeDirectory(metadata.cwd);
    this.nativeSummary(directoryInfo, metadata);
    const workspace = existing ?? (await this.openWorkspace(directoryInfo.canonicalRoot));
    const conversation = await this.importNativeSession(workspace.id, threadId);
    return { workspace, conversation };
  }
  async importNativeSession(workspaceId: string, threadId: string) {
    const { workspace, adapter } = await this.nativeProvider(workspaceId);
    const thread = adapter.readNativeSessionMetadata
      ? await adapter.readNativeSessionMetadata(threadId)
      : await adapter.readNativeSession!(threadId);
    if (thread.id !== threadId) throw new AppError('permission_denied', 'Codex 会话标识不匹配', 403);
    const summary = this.nativeSummary(workspace, thread);
    // A single durable mapping, even if two browser requests arrive together.
    return this.store.transaction(() => {
      const existing = this.store
        .list<Conversation>('conversation')
        .find(
          (c) =>
            c.workspaceId === workspaceId &&
            c.providerId === (this.config.provider ?? 'codex') &&
            c.providerSessionId === threadId,
        );
      if (existing) return existing;
      const conversation: Conversation = {
        id: randomUUID(),
        workspaceId,
        title: summary.title,
        providerId: this.config.provider ?? 'codex',
        providerSessionId: threadId,
        createdAt: new Date().toISOString(),
      };
      this.store.put('conversation', conversation.id, conversation);
      this.store.emit(
        'conversation.created',
        { conversation },
        { workspaceId, conversationId: conversation.id },
      );
      return conversation;
    });
  }
  async nativeHistory(conversationId: string, limit = 100): Promise<NativeSessionHistory | undefined> {
    const conversation = this.conversation(conversationId);
    if (!conversation.providerSessionId || conversation.providerId !== 'codex') return undefined;
    const { workspace, adapter } = await this.nativeProvider(conversation.workspaceId);
    const history = await adapter.readNativeSession!(conversation.providerSessionId, { limit });
    if (history.id !== conversation.providerSessionId)
      throw new AppError('permission_denied', 'Codex 会话标识不匹配', 403);
    const summary = this.nativeSummary(workspace, history);
    const localTurns = new Set(
      this.store
        .list<Run>('run')
        .filter((r) => r.conversationId === conversationId && r.providerTurnId)
        .map((r) => r.providerTurnId),
    );
    let truncated = history.truncated === true || history.turns.length > 100;
    let remaining = 1024 * 1024;
    const bounded = (text: string) => {
      const result = boundedText(text, Math.min(MAX_MESSAGE_BYTES, Math.max(0, remaining)));
      remaining -= Buffer.byteLength(result.text);
      truncated ||= result.truncated;
      return result.text;
    };
    // Older Relay versions discarded agentMessage.questions. Recover them from native history.
    for (const turn of history.turns.slice(-100)) {
      if (!localTurns.has(turn.id)) continue;
      const run = this.store
        .list<Run>('run')
        .find((r) => r.conversationId === conversationId && r.providerTurnId === turn.id);
      if (!run) continue;
      const matched = new Set<string>();
      for (const item of turn.messages.slice(-100)) {
        if (!item.questions?.length) continue;
        const signature = questionSignature(item.text, item.questions);
        // Persisted Codex history regenerates item-N IDs. Match visible content
        // to live records first, retaining their chronology and question reply key.
        const candidates = this.store
          .list<Message>('message')
          .filter(
            (m) =>
              m.runId === run.id &&
              m.kind === 'assistant' &&
              !matched.has(m.id) &&
              m.text.trim() === item.text.trim() &&
              (!Array.isArray(m.payload.questions) ||
                !m.payload.questions.length ||
                questionSignature(m.text, m.payload.questions) === signature),
          )
          .sort((a, b) => Number(!!b.payload.itemId) - Number(!!a.payload.itemId));
        const old = candidates[0];
        // Avoid collisions when an item-N ID now belongs to a different native message.
        const proposedId = `${run.id}:${item.id}`;
        const id =
          old?.id ??
          (this.store.get('message', proposedId) ? `${run.id}:history-${randomUUID()}` : proposedId);
        matched.add(id);
        if (Array.isArray(old?.payload.questions) && old.payload.questions.length) continue;
        const message: Message = {
          id,
          runId: run.id,
          conversationId,
          workspaceId: workspace.id,
          kind: 'assistant',
          text: old?.text ?? bounded(item.text),
          createdAt: old?.createdAt ?? run.createdAt,
          payload: {
            ...old?.payload,
            questions: item.questions.slice(0, 10).map((q) => ({
              title: bounded(q.title),
              options: q.options?.slice(0, 20).map(bounded) ?? null,
            })),
          },
        };
        this.store.put('message', id, message);
        this.store.emit(
          'message.completed',
          { message },
          { workspaceId: workspace.id, conversationId, runId: run.id },
        );
      }
    }
    const turns = history.turns
      .slice(-100)
      .filter((turn) => !localTurns.has(turn.id))
      .map((turn) => {
        if (turn.messages.length > 100) truncated = true;
        return {
          id: turn.id,
          state: turn.state,
          userText: bounded(turn.userText),
          ...(turn.createdAt ? { createdAt: turn.createdAt } : {}),
          messages: turn.messages.slice(0, 100).map((message) => ({
            id: message.id,
            kind: message.kind,
            text: bounded(message.text),
            ...(message.questions?.length
              ? {
                  questions: message.questions.slice(0, 10).map((q) => ({
                    title: bounded(q.title),
                    options: q.options?.slice(0, 20).map(bounded) ?? null,
                  })),
                }
              : {}),
          })),
        };
      });
    return { ...summary, turns, truncated, hasOlderTurns: history.hasOlderTurns };
  }
  async provider(workspaceId?: string) {
    const key = workspaceId ?? 'account';
    await this.retiring.get(key);
    if (this.closing) throw new AppError('agent_unavailable', 'Agent 正在停止，请稍后重试', 503);
    let entry = this.providers.get(key);
    if (entry) {
      entry.used = Date.now();
      return entry.adapter;
    }
    if (this.providers.size >= this.config.maxProviders) {
      const idle = [...this.providers]
        .filter(
          ([id]) =>
            id !== 'account' && !this.active.has(id) && !this.starting.has(id) && !this.maintenance.has(id),
        )
        .sort((a, b) => a[1].used - b[1].used)[0];
      if (!idle) throw new AppError('run_conflict', '已达到 Codex 进程上限，请等待任务完成', 409);
      this.providers.delete(idle[0]);
      await idle[1].adapter.close();
      if (this.closing) throw new AppError('agent_unavailable', 'Agent 正在停止，请稍后重试', 503);
    }
    const adapter = this.factory(
      workspaceId ? this.workspace(workspaceId).canonicalRoot : this.config.stateDir,
      this.identity.codexHome,
      this.config.authHome,
    );
    entry = { adapter, used: Date.now() };
    this.providers.set(key, entry);
    adapter.subscribeEvents((event) => this.onProviderEvent(workspaceId, event));
    return adapter;
  }
  async submit(
    conversationId: string,
    input: {
      clientRequestId: string;
      text: string;
      model: string;
      reasoningEffort?: string | null;
      permissionMode: Run['permissionMode'];
      imageIds?: string[];
    },
  ) {
    if (this.config.provider === 'deepseek' && input.permissionMode !== 'full-access')
      throw new AppError('unsupported_feature', 'DeepSeek（测试）仅支持完全访问，不能选择其他权限模式', 400);
    if (this.settingsUpdating) throw new AppError('run_conflict', '正在保存账号配置，请稍后发送', 409);
    const conversation = this.conversation(conversationId),
      workspace = this.workspace(conversation.workspaceId);
    // Idempotency is durable and checked before account/network probes.
    const prior = this.store.receipt(
      input.clientRequestId,
      { operation: 'run', conversationId, ...input },
      () => {
        if (this.maintenance.has(workspace.id) || this.store.get('restoreBlocked', workspace.id))
          throw new AppError('run_conflict', '项目正在恢复或恢复结果需要人工检查', 409);
        if (this.loginPending) throw new AppError('run_conflict', '账号登录正在进行，请稍后重试', 409);
        if (input.permissionMode !== 'read-only' && !workspace.writable)
          throw new AppError('permission_denied', '当前 Linux 用户没有项目写权限', 403);
        const now = new Date().toISOString();
        const run: Run = {
          accountLabel: this.config.accountLabel ?? '跟随 Codex',
          accountProfile:
            (this.config.factoryHome ??
            this.config.deepseekHome ??
            this.config.antigravityHome ??
            this.config.claudeHome ??
            this.config.kimiHome ??
            this.config.authHome)
              ? basename(
                  dirname(
                    (this.config.factoryHome ??
                      this.config.deepseekHome ??
                      this.config.antigravityHome ??
                      this.config.claudeHome ??
                      this.config.kimiHome ??
                      this.config.authHome)!,
                  ),
                )
              : 'default',
          id: randomUUID(),
          workspaceId: workspace.id,
          conversationId,
          state: 'queued',
          text: input.text || '请查看这些图片。',
          ...(input.imageIds?.length ? { images: this.images.attach(workspace.id, input.imageIds) } : {}),
          model: input.model,
          reasoningEffort: input.reasoningEffort ?? null,
          requestedModel: input.model,
          requestedReasoningEffort: input.reasoningEffort ?? null,
          permissionMode: input.permissionMode,
          providerTurnId: null,
          createdAt: now,
          updatedAt: now,
          error: null,
        };
        this.store.put('run', run.id, run);
        this.store.emit('run.queued', { run }, { workspaceId: workspace.id, conversationId, runId: run.id });
        return run;
      },
    );
    void this.drain();
    return this.store.require<Run>('run', prior.id);
  }
  private state(run: Run, state: RunState, error?: string) {
    run.state = state;
    run.updatedAt = new Date().toISOString();
    run.error = error ?? null;
    this.store.put('run', run.id, run);
    this.store.emit(
      'run.state_changed',
      { run },
      { workspaceId: run.workspaceId, conversationId: run.conversationId, runId: run.id },
    );
  }
  async reply(conversationId: string, input: Parameters<Manager['submit']>[1]) {
    const conversation = this.conversation(conversationId);
    const workspace = this.workspace(conversation.workspaceId);
    const fingerprint = JSON.stringify({ conversationId, ...input });
    const prior = this.store.get<{ fingerprint: string; result?: { runId: string; delivery: string } }>(
      'questionReply',
      input.clientRequestId,
    );
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new AppError('run_conflict', '请求标识已被使用', 409);
      if (prior.result) return prior.result;
      throw new AppError(
        'uncertain_operation',
        '这条回答的提交结果尚未确认，请检查对话；不会自动重复发送',
        409,
      );
    }
    const entry = this.active.get(workspace.id);
    const active = entry && this.store.get<Run>('run', entry.runId);
    if (
      !active ||
      active.conversationId !== conversationId ||
      (['antigravity', 'deepseek', 'factory'].includes(this.config.provider ?? '') &&
        !this.providers.get(workspace.id)?.adapter.steerRun)
    ) {
      const run = await this.submit(conversationId, input);
      const result = { runId: run.id, delivery: 'queued' };
      this.store.put('questionReply', input.clientRequestId, { fingerprint, result });
      return result;
    }
    if (input.imageIds?.length)
      throw new AppError('unsupported_feature', '请通过输入框发送图片，图片消息会作为新一轮任务排队。', 409);
    if (!active.providerTurnId || active.state !== 'running' || !conversation.providerSessionId)
      throw new AppError('run_conflict', '任务正在启动、停止或等待其他确认，请稍后重试', 409);
    const adapter = this.providers.get(workspace.id)?.adapter;
    if (!adapter?.steerRun) throw new AppError('unsupported_feature', '当前提供方不支持执行中回答', 409);
    this.store.put('questionReply', input.clientRequestId, { fingerprint });
    // Reserve before sending: a lost acknowledgement must not cause a duplicate steer.
    try {
      await adapter.steerRun(
        { sessionId: conversation.providerSessionId, turnId: active.providerTurnId },
        input.text,
        input.clientRequestId,
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'run_conflict')
        this.store.remove('questionReply', input.clientRequestId);
      throw error;
    }
    const result = { runId: active.id, delivery: 'steered' };
    const message: Message = {
      id: `reply:${input.clientRequestId}`,
      runId: active.id,
      conversationId,
      workspaceId: workspace.id,
      kind: 'user',
      text: input.text,
      payload: {},
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.store.put('questionReply', input.clientRequestId, { fingerprint, result });
      this.store.put('message', message.id, message);
      this.store.emit(
        'message.completed',
        { message },
        { workspaceId: workspace.id, conversationId, runId: active.id },
      );
    });
    return result;
  }
  private async takeoverSessions(adapter: AIProviderAdapter, ids: string[]) {
    const read = adapter.readSessionOwnerMetadata ?? adapter.readNativeSessionMetadata;
    if (!read || !ids.length || ids.length > 100)
      throw new AppError('takeover_failed', '无法完整核对受影响的会话，不能接管。', 409);
    const sessions: NativeSessionSummary[] = [];
    for (const id of ids) {
      const metadata = await read.call(adapter, id);
      if (metadata.id !== id) throw new AppError('permission_denied', '会话标识不匹配', 403);
      const directory = await this.nativeDirectory(metadata.cwd);
      sessions.push(this.nativeSummary(directory.directoryInfo, metadata));
    }
    return sessions;
  }
  async takeoverAvailable(conversationId: string): Promise<boolean> {
    const conversation = this.conversation(conversationId);
    const workspaceId = conversation.workspaceId;
    const idle = () =>
      !this.closing &&
      !this.loginPending &&
      !this.maintenance.has(workspaceId) &&
      !this.active.has(workspaceId) &&
      !this.starting.has(workspaceId) &&
      !this.finishing.has(workspaceId) &&
      !this.retiring.has(workspaceId) &&
      !this.store.get('restoreBlocked', workspaceId) &&
      !this.store
        .list<Run>('run')
        .some((r) => r.workspaceId === workspaceId && !terminalStates.includes(r.state));
    if (!conversation.providerSessionId || !idle()) return false;
    try {
      const { adapter, workspace } = await this.nativeProvider(workspaceId);
      if (!workspace.writable || !adapter.inspectSessionOwner || !adapter.stopSessionOwner) return false;
      const owner = await adapter.inspectSessionOwner(conversation.providerSessionId);
      // This is a read-only hint, not a takeover plan. Preview and confirmation
      // still revalidate the process and every affected session before stopping it.
      return idle() && owner.sessions.includes(conversation.providerSessionId);
    } catch {
      // Free, unsupported or unverifiable ownership must never advertise takeover.
      return false;
    }
  }
  async previewTakeover(conversationId: string) {
    const conversation = this.conversation(conversationId);
    return this.withIdleWorkspace(conversation.workspaceId, async () => {
      const { adapter, workspace } = await this.nativeProvider(conversation.workspaceId);
      const id = conversation.providerSessionId;
      if (!id || !adapter.inspectSessionOwner || !adapter.stopSessionOwner)
        throw new AppError('unsupported_feature', '当前会话不支持接管。', 409);
      const owner = await adapter.inspectSessionOwner(id);
      const sessions = await this.takeoverSessions(adapter, owner.sessions);
      const target = sessions.find((s) => s.id === id);
      if (!target) throw new AppError('takeover_failed', '占用信息已变化，请重试。', 409);
      this.nativeSummary(workspace, target);
      for (const [key, value] of this.takeoverPlans)
        if (value.expires < Date.now()) this.takeoverPlans.delete(key);
      if (this.takeoverPlans.size >= 100) this.takeoverPlans.clear();
      const token = randomUUID();
      this.takeoverPlans.set(conversationId, {
        token,
        threadId: id,
        fingerprint: owner.fingerprint,
        sessions: owner.sessions,
        expires: Date.now() + 120000,
      });
      return { token, sessions };
    });
  }
  async takeover(conversationId: string, input: { token: string; clientRequestId: string; confirmed: true }) {
    const conversation = this.conversation(conversationId);
    const fingerprint = JSON.stringify({ conversationId, ...input });
    const prior = this.store.get<{ fingerprint: string; completed?: boolean }>(
      'takeover',
      input.clientRequestId,
    );
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new AppError('run_conflict', '请求标识已被使用', 409);
      if (prior.completed) return { released: true };
      throw new AppError('uncertain_operation', '此接管已有执行记录，请刷新后检查，不会重复中断。', 409);
    }
    return this.withIdleWorkspace(conversation.workspaceId, async () => {
      const plan = this.takeoverPlans.get(conversationId);
      if (
        !plan ||
        plan.token !== input.token ||
        plan.expires < Date.now() ||
        plan.threadId !== conversation.providerSessionId
      )
        throw new AppError('takeover_failed', '接管确认已失效，请重新点击接管并确认。', 409);
      this.takeoverPlans.delete(conversationId);
      const { adapter, workspace } = await this.nativeProvider(conversation.workspaceId);
      if (!adapter.stopSessionOwner || !adapter.inspectSessionOwner)
        throw new AppError('unsupported_feature', '当前会话不支持接管。', 409);
      const sessions = await this.takeoverSessions(adapter, plan.sessions);
      this.nativeSummary(
        workspace,
        sessions.find((s) => s.id === plan.threadId)!,
      );
      const current = await adapter.inspectSessionOwner(plan.threadId);
      if (current.fingerprint !== plan.fingerprint)
        throw new AppError('takeover_failed', '受影响的会话或占用进程已变化，请重新确认。', 409);
      this.store.put('takeover', input.clientRequestId, { fingerprint });
      await adapter.stopSessionOwner(plan.threadId, plan.fingerprint);
      this.store.put('takeover', input.clientRequestId, { fingerprint, completed: true });
      this.store.emit(
        'conversation.released',
        { conversationId },
        { workspaceId: workspace.id, conversationId },
      );
      return { released: true };
    });
  }
  async withIdleWorkspace<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const workspace = this.workspace(workspaceId);
    if (!workspace.writable) throw new AppError('permission_denied', '当前 Linux 用户没有项目写权限', 403);
    if (
      this.closing ||
      this.loginPending ||
      this.maintenance.has(workspaceId) ||
      this.active.has(workspaceId) ||
      this.starting.has(workspaceId) ||
      this.finishing.has(workspaceId) ||
      this.retiring.has(workspaceId) ||
      this.store.get('restoreBlocked', workspaceId) ||
      this.store
        .list<Run>('run')
        .some((r) => r.workspaceId === workspaceId && !terminalStates.includes(r.state))
    )
      throw new AppError('run_conflict', '请等待项目任务结束；若上次恢复中断，请先检查恢复日志', 409);
    this.maintenance.add(workspaceId);
    const operation = (async () => {
      const lease = await this.locks.acquire(workspace.directoryInfo, randomUUID());
      try {
        return await action();
      } finally {
        await lease.release({ uncertain: !!this.store.get('restoreBlocked', workspaceId) });
      }
    })();
    const tracked = operation.then(
      () => {},
      () => {},
    );
    this.executing.add(tracked);
    this.maintenanceTasks.add(tracked);
    try {
      return await operation;
    } finally {
      this.executing.delete(tracked);
      this.maintenanceTasks.delete(tracked);
      this.maintenance.delete(workspaceId);
      if (!this.closing) void this.drain();
    }
  }
  private rollbackTarget(runId: string) {
    const run = this.store.require<Run>('run', runId);
    const latest = this.store
      .list<Run>('run')
      .filter((r) => r.workspaceId === run.workspaceId)
      .at(-1);
    const checkpoint = this.store.get<Checkpoint>('checkpoint', runId);
    if (
      latest?.id !== run.id ||
      run.restorePoint?.state !== 'ready' ||
      !checkpoint?.after ||
      !run.providerTurnId
    )
      throw new AppError(
        'rollback_unavailable',
        '只能回滚项目最近一轮且具有完整文件恢复点的任务；旧记录不能补建恢复点',
        409,
      );
    return {
      run,
      checkpoint,
      workspace: this.workspace(run.workspaceId),
      conversation: this.conversation(run.conversationId),
    };
  }
  async previewRollback(runId: string) {
    const target = this.rollbackTarget(runId);
    return this.withIdleWorkspace(target.workspace.id, async () => {
      const { checkpoint, workspace } = this.rollbackTarget(runId);
      return this.files.checkpoint<RestorePreview>(workspace.directoryInfo, 'preview', { ...checkpoint });
    });
  }
  async rollback(runId: string, input: { clientRequestId: string; token: string }) {
    const fingerprint = JSON.stringify({ runId, token: input.token });
    const prior = this.store.get<{ fingerprint: string; conversation?: Conversation }>(
      'restoreOperation',
      input.clientRequestId,
    );
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new AppError('run_conflict', '请求标识已被使用', 409);
      if (prior.conversation) return { conversation: prior.conversation };
      throw new AppError('run_conflict', '该恢复已有执行记录，请检查文件和恢复日志，不会重复执行', 409);
    }
    const target = this.rollbackTarget(runId);
    return this.withIdleWorkspace(target.workspace.id, async () => {
      const { run, checkpoint, workspace, conversation } = this.rollbackTarget(runId);
      await this.files.checkpoint(workspace.directoryInfo, 'preview', { ...checkpoint }).then((plan: any) => {
        if (plan.token !== input.token)
          throw new AppError('rollback_conflict', '恢复计划已失效，请重新预览', 409);
      });
      const adapter = await this.provider(workspace.id);
      let branchId: string | undefined;
      let ownedSource = false;
      let applying = false;
      try {
        if (!checkpoint.filesOnly) {
          if (!conversation.providerSessionId || !adapter.readNativeSession || !adapter.forkSession)
            throw new AppError('unsupported_feature', '当前提供方不支持安全恢复对话', 409);
          const options = {
            cwd: workspace.canonicalRoot,
            model: run.model,
            permissionMode: 'read-only' as const,
          };
          // Hold the source's native writer lease too; an IDE-owned thread must refuse rollback.
          await adapter.resumeSession({ id: conversation.providerSessionId }, options);
          ownedSource = true;
          const history = await adapter.readNativeSession(conversation.providerSessionId);
          if (
            history.turns.at(-1)?.id !== run.providerTurnId ||
            history.turns.some((t) => t.state === 'running' || t.state === 'unknown')
          )
            throw new AppError('rollback_conflict', '原生对话已发生变化，请刷新后检查', 409);
          this.store.put('restoreOperation', input.clientRequestId, { fingerprint, state: 'preparing' });
          const branch = checkpoint.previousTurnId
            ? await adapter.forkSession(conversation.providerSessionId, checkpoint.previousTurnId, options)
            : await adapter.createSession(options);
          branchId = branch.id;
        } else {
          this.store.put('restoreOperation', input.clientRequestId, { fingerprint, state: 'preparing' });
        }
        this.store.put('restoreBlocked', workspace.id, {
          operationId: input.clientRequestId,
          runId,
          branchId,
        });
        applying = true;
        await this.files.checkpoint(workspace.directoryInfo, 'restore', {
          ...checkpoint,
          token: input.token,
          operationId: input.clientRequestId,
        });
        let restored!: Conversation;
        this.store.transaction(() => {
          restored = {
            ...conversation,
            id: randomUUID(),
            title: `${conversation.title} · ${checkpoint.filesOnly ? '文件已恢复' : '回滚前'}`,
            providerSessionId: branchId ?? null,
            createdAt: new Date().toISOString(),
          };
          this.store.put('conversation', restored.id, restored);
          this.store.emit(
            'conversation.created',
            { conversation: restored },
            { workspaceId: workspace.id, conversationId: restored.id },
          );
          run.restorePoint = {
            state: 'restored',
            ...(checkpoint.filesOnly ? { scope: 'files' as const } : {}),
          };
          this.state(run, run.state);
          this.store.put('restoreOperation', input.clientRequestId, {
            fingerprint,
            conversation: restored,
            state: 'completed',
          });
          this.store.remove('restoreBlocked', workspace.id);
        });
        return { conversation: restored };
      } catch (error) {
        if (applying && (error as { code?: string }).code === 'rollback_conflict')
          this.store.remove('restoreBlocked', workspace.id);
        throw error;
      } finally {
        if (ownedSource && branchId) {
          try {
            await adapter.releaseSession?.(conversation.providerSessionId!);
          } catch {
            /* Process disposal also releases ownership. */
          }
        }
        if (ownedSource || branchId) {
          this.sessionReleases.set(workspace.id, branchId ?? conversation.providerSessionId!);
          await this.releaseFinishedSession(workspace.id);
        }
      }
    });
  }
  async forkConversation(conversationId: string, turnId: string, model: string) {
    const source = this.conversation(conversationId);
    return this.withIdleWorkspace(source.workspaceId, async () => {
      const adapter = await this.provider(source.workspaceId);
      if (!source.providerSessionId || !adapter.readNativeSession || !adapter.forkSession)
        throw new AppError('unsupported_feature', '当前对话不支持分支', 409);
      const history = await adapter.readNativeSession(source.providerSessionId);
      const turn = history.turns.find((t) => t.id === turnId);
      if (!turn || turn.state === 'running' || turn.state === 'unknown')
        throw new AppError('run_conflict', '请选择已结束的一轮', 409);
      const branch = await adapter.forkSession(source.providerSessionId, turnId, {
        cwd: this.workspace(source.workspaceId).canonicalRoot,
        model,
        permissionMode: 'read-only',
      });
      try {
        const conversation: Conversation = {
          ...source,
          id: randomUUID(),
          title: `${source.title} · 分支`,
          providerSessionId: branch.id,
          createdAt: new Date().toISOString(),
        };
        this.store.put('conversation', conversation.id, conversation);
        this.store.emit(
          'conversation.created',
          { conversation },
          { workspaceId: source.workspaceId, conversationId: conversation.id },
        );
        return { conversation };
      } finally {
        this.sessionReleases.set(source.workspaceId, branch.id);
        await this.releaseFinishedSession(source.workspaceId);
      }
    });
  }
  private async drain() {
    if (this.closing) return;
    const queued = this.store.list<Run>('run').filter((r) => r.state === 'queued');
    for (const run of queued) {
      if (
        this.active.has(run.workspaceId) ||
        this.starting.has(run.workspaceId) ||
        this.finishing.has(run.workspaceId) ||
        this.retiring.has(run.workspaceId) ||
        this.maintenance.has(run.workspaceId) ||
        this.store.get('restoreBlocked', run.workspaceId)
      )
        continue;
      this.starting.add(run.workspaceId);
      const task = this.execute(run).finally(async () => {
        this.starting.delete(run.workspaceId);
        try {
          await this.releaseFinishedSession(run.workspaceId);
          if (!this.closing && this.store.get<Run>('run', run.id)?.state !== 'queued') void this.drain();
        } finally {
          this.executing.delete(task);
        }
      });
      this.executing.add(task);
      void task.catch(() => {});
    }
  }
  private async execute(run: Run) {
    let release: ((options?: { uncertain?: boolean }) => void | Promise<void>) | undefined;
    let dispatched = false;
    try {
      const workspace = this.workspace(run.workspaceId);
      // Revalidate directory identity immediately before dispatch.
      const current = await this.files.openWorkspace(workspace.canonicalRoot);
      if (JSON.stringify(current.directoryIdentity) !== workspace.directoryIdentity)
        throw new AppError('file_changed', '项目目录已被替换，请重新打开', 409);
      if (this.closing) return;
      // Even read-only sessions can request an explicit escalation approval.
      // Hold the same exclusive lease throughout; readonly roots need no W_OK.
      const lock = await this.locks.acquire(workspace.directoryInfo, run.id, {
        requireWritable: run.permissionMode !== 'read-only',
      });
      release = (options) => lock.release(options);
      if (this.store.require<Run>('run', run.id).state !== 'queued') {
        await release();
        return;
      }
      if (this.closing) {
        await release();
        return;
      }
      this.active.set(run.workspaceId, { runId: run.id, release });
      this.store.transaction(() => this.state(run, 'starting'));
      await this.observeRun?.(workspace, run);
      if (await this.cancelBeforeDispatch(run)) return;
      // History browsing may have started this idle process before an external login change.
      // Only replace disposable execution providers, before the new task obtains a session.
      const previous = this.providers.get(run.workspaceId);
      if (previous?.adapter.disposeAfterRun) {
        this.providers.delete(run.workspaceId);
        await previous.adapter.close();
      }
      const adapter = await this.provider(run.workspaceId);
      const account = await adapter.getAccount();
      if (this.config.provider === 'factory') {
        if (!account.authenticated || account.authMode !== 'factory-api-key')
          throw new AppError('auth_required', '请先配置 Factory API Key', 401);
      } else if (this.config.provider === 'deepseek') {
        if (!account.authenticated || account.authMode !== 'deepseek-api-key')
          throw new AppError('auth_required', '请先配置 DeepSeek API Key', 401);
      } else if (this.config.provider === 'antigravity') {
        if (!account.authenticated || account.authMode !== 'google-antigravity')
          throw new AppError('auth_required', '请先登录 Gemini（测试）的 Google 账号', 401);
      } else if (this.config.provider === 'claude') {
        if (!account.authenticated || account.authMode !== 'claude-code')
          throw new AppError('auth_required', '请先登录此 Claude 订阅账号', 401);
      } else if (this.config.provider === 'kimi') {
        if (!account.authenticated || account.authMode !== 'kimi-code')
          throw new AppError('auth_required', '请先登录此 Kimi Code 账号', 401);
      } else if (account.authMode !== 'chatgpt' || !account.authenticated || !account.requiresOpenaiAuth)
        throw new AppError('auth_required', '需要此 Linux 用户的官方 ChatGPT 登录；不会回退到 API Key', 401);
      const models = await adapter.listModels(),
        model = models.find((m) => m.id === run.model);
      if (!model) throw new AppError('unsupported_feature', '所选模型当前不可用');
      if (run.reasoningEffort && !model.reasoningEfforts.includes(run.reasoningEffort))
        throw new AppError('unsupported_feature', '模型不支持所选推理强度');
      // Kimi and Droid can continue through other billing pools after one window is exhausted.
      // Their official harnesses enforce entitlements; quota lookup must not delay or block a prompt.
      const quota = ['kimi', 'factory'].includes(this.config.provider ?? '')
        ? null
        : await adapter.getQuota();
      if (
        quota &&
        !quota.stale &&
        quota.windows.some(
          (w) =>
            w.usedPercent !== null &&
            w.usedPercent >= 100 &&
            (w.resetsAt === null || w.resetsAt > Date.now() / 1000),
        )
      )
        throw new AppError('quota_unavailable', '订阅额度已耗尽，请等待重置', 409);
      if (await this.cancelBeforeDispatch(run)) return;
      const conversation = this.conversation(run.conversationId);
      const options = { cwd: workspace.canonicalRoot, model: run.model, permissionMode: run.permissionMode };
      const hadSession = !!conversation.providerSessionId;
      const session = conversation.providerSessionId
        ? await adapter.resumeSession({ id: conversation.providerSessionId }, options)
        : await adapter.createSession(options);
      conversation.providerSessionId = session.id;
      this.store.put('conversation', conversation.id, conversation);
      this.store.put('providerSession', session.id, {
        id: session.id,
        providerId: this.config.provider ?? 'codex',
        conversationId: conversation.id,
        account,
        version:
          this.config.provider === 'factory'
            ? FACTORY_VERSION
            : this.config.provider === 'deepseek'
              ? DEEPSEEK_HARNESS_VERSION
              : this.config.provider === 'antigravity'
                ? ANTIGRAVITY_VERSION
                : this.config.provider === 'claude'
                  ? CLAUDE_VERSION
                  : this.config.provider === 'kimi'
                    ? KIMI_VERSION
                    : SUPPORTED_CODEX_VERSION,
        createdAt: new Date().toISOString(),
      });
      if (await this.cancelBeforeDispatch(run)) return;
      try {
        const filesOnly = ['antigravity', 'deepseek', 'factory'].includes(this.config.provider ?? '');
        if (!filesOnly && !adapter.forkSession) throw new Error('此提供方暂不支持文件回滚');
        if (!filesOnly && hadSession && !adapter.readNativeSession)
          throw new Error('提供方不支持读取原生历史');
        const history =
          !filesOnly && hadSession && adapter.readNativeSession
            ? await adapter.readNativeSession(session.id)
            : null;
        // Newly created sessions may not yet have a persisted history.
        const checkpoint: Checkpoint = {
          before: randomUUID(),
          ...(filesOnly ? { filesOnly: true } : {}),
          previousTurnId: history?.turns.at(-1)?.id ?? null,
        };
        if (history?.truncated) throw new Error('对话记录不完整，不能建立恢复点');
        await this.files.checkpoint(workspace.directoryInfo, 'capture', { id: checkpoint.before });
        this.store.put('checkpoint', run.id, checkpoint);
        run.restorePoint = { state: 'preparing', ...(filesOnly ? { scope: 'files' as const } : {}) };
      } catch (error) {
        run.restorePoint = { state: 'unavailable', reason: (error as Error).message };
      }
      // Preserve a cancellation that arrived while capturing files.
      const prepared = this.store.require<Run>('run', run.id);
      prepared.restorePoint = run.restorePoint;
      this.store.put('run', run.id, prepared);
      if (await this.cancelBeforeDispatch(prepared)) return;
      const imageInputs = this.images.inputs(workspace.id, run.images);
      dispatched = true;
      const ref = await adapter.startRun({
        ...options,
        sessionId: session.id,
        text: run.text,
        ...(imageInputs.length ? { images: imageInputs } : {}),
        reasoningEffort:
          this.config.provider === 'factory'
            ? (run.reasoningEffort ?? model.defaultReasoningEffort)
            : run.reasoningEffort,
      });
      const latest = this.store.require<Run>('run', run.id);
      latest.providerTurnId = ref.turnId;
      this.store.transaction(() => {
        this.store.put('run', latest.id, latest);
        if (latest.state === 'starting') this.state(latest, 'running');
      });
      if (latest.state === 'cancelling') await adapter.interruptRun(ref);
    } catch (error) {
      const e = error as Error & { code?: string; executionNotStarted?: boolean };
      if (e.code === 'run_conflict' && !this.active.has(run.workspaceId)) {
        return;
      }
      const current = this.store.require<Run>('run', run.id);
      if (!terminalStates.includes(current.state))
        this.store.transaction(() =>
          this.state(
            current,
            e.code === 'uncertain_operation' || (dispatched && !e.executionNotStarted)
              ? 'uncertain'
              : 'failed',
            e.message,
          ),
        );
      const uncertain = current.state === 'uncertain' || current.state === 'interrupted';
      await this.finish(run.workspaceId, uncertain);
      if (release && !this.active.has(run.workspaceId)) await release({ uncertain });
    }
  }
  private async cancelBeforeDispatch(run: Run) {
    const current = this.store.require<Run>('run', run.id);
    if (!this.closing && current.state !== 'cancelling' && current.state !== 'cancelled') return false;
    if (!terminalStates.includes(current.state))
      this.store.transaction(() => this.state(current, this.closing ? 'interrupted' : 'cancelled'));
    await this.finish(run.workspaceId);
    return true;
  }
  private finish(workspaceId: string, uncertain = false): Promise<void> {
    const pending = this.finishing.get(workspaceId);
    if (pending) return pending;
    const entry = this.active.get(workspaceId);
    if (!entry) return Promise.resolve();
    this.active.delete(workspaceId);
    const finishing = Promise.resolve()
      .then(async () => {
        const checkpoint = this.store.get<Checkpoint>('checkpoint', entry.runId);
        if (checkpoint) {
          let restorePoint: Run['restorePoint'];
          try {
            if (uncertain) throw new Error('任务结束状态未确认，不能安全回滚');
            if (!this.store.require<Run>('run', entry.runId).providerTurnId)
              throw new Error('任务没有已确认的原生对话轮次，无需回滚');
            const after = randomUUID();
            await this.files.checkpoint(this.workspace(workspaceId).directoryInfo, 'capture', { id: after });
            this.store.put('checkpoint', entry.runId, { ...checkpoint, after });
            restorePoint = { state: 'ready', ...(checkpoint.filesOnly ? { scope: 'files' as const } : {}) };
          } catch (error) {
            restorePoint = { state: 'unavailable', reason: (error as Error).message };
          }
          const latest = this.store.require<Run>('run', entry.runId);
          latest.restorePoint = restorePoint;
          this.store.put('run', latest.id, latest);
          this.store.emit(
            'run.state_changed',
            { run: latest },
            { workspaceId, runId: latest.id, conversationId: latest.conversationId },
          );
        }
        await entry.release({ uncertain });
        const run = this.store.get<Run>('run', entry.runId);
        const session = run ? this.conversation(run.conversationId).providerSessionId : null;
        if (session) this.sessionReleases.set(workspaceId, session);
        await this.releaseFinishedSession(workspaceId);
      })
      .finally(() => {
        this.finishing.delete(workspaceId);
        if (!this.closing) void this.drain();
      });
    this.finishing.set(workspaceId, finishing);
    return finishing;
  }
  private async releaseFinishedSession(workspaceId: string) {
    if (this.closing || this.active.has(workspaceId) || this.starting.has(workspaceId)) return;
    const existing = this.retiring.get(workspaceId);
    if (existing) return existing;
    const session = this.sessionReleases.get(workspaceId);
    if (!session) return;
    this.sessionReleases.delete(workspaceId);
    const entry = this.providers.get(workspaceId);
    if (!entry) return;
    if (entry.adapter.disposeAfterRun) this.providers.delete(workspaceId);
    // A very short turn can finish before startRun verifies its effective policy.
    // Wait until execute.finally clears `starting` before unloading that process.
    const retiring = Promise.resolve()
      .then(async () => {
        try {
          await entry.adapter.releaseSession?.(session);
        } catch {
          // Closing a process is the final release for providers with native thread ownership.
        } finally {
          if (entry.adapter.disposeAfterRun) await entry.adapter.close();
        }
      })
      .catch(() => {
        this.store.emit(
          'provider.warning',
          { message: '会话释放未能确认，请刷新后查看 Codex 会话状态' },
          { workspaceId },
        );
      })
      .finally(() => {
        this.retiring.delete(workspaceId);
      });
    this.retiring.set(workspaceId, retiring);
    await retiring;
  }
  private onProviderEvent(workspaceId: string | undefined, event: ProviderEvent) {
    const active = workspaceId ? this.active.get(workspaceId) : undefined;
    let run = active ? this.store.get<Run>('run', active.runId) : undefined;
    const providerKey = workspaceId ?? 'account';
    if (this.providers.get(providerKey)?.adapter.generation !== event.generation) return;
    if (event.type === 'account.updated') {
      this.accountReader.invalidate();
      if (event.payload.loginCompleted) this.loginPending = false;
    }
    if (event.type === 'provider.warning' && event.payload.interrupted === true) {
      const dead = this.providers.get(providerKey);
      this.providers.delete(providerKey);
      if (!workspaceId) this.loginPending = false;
      // A later explicit request may create a new generation. Never retry or
      // resume the failed turn; its durable uncertainty lease remains in force.
      if (dead) void dead.adapter.close().catch(() => {});
    }
    if (run && event.sessionId) {
      const conversation = this.conversation(run.conversationId);
      if (conversation.providerSessionId && conversation.providerSessionId !== event.sessionId)
        run = undefined;
    }
    if (run && event.turnId) {
      if (run.providerTurnId && run.providerTurnId !== event.turnId) run = undefined;
      else if (
        !run.providerTurnId &&
        this.store
          .list<Run>('run')
          .some(
            (old) =>
              old.id !== run!.id &&
              old.workspaceId === run!.workspaceId &&
              old.providerTurnId === event.turnId,
          )
      )
        run = undefined;
    }
    const settingsEvent =
      event.type === 'run.settings' ||
      (event.type === 'provider.warning' && typeof event.payload.toModel === 'string');
    // A short native turn can complete before its effective-settings RPC returns.
    // Such metadata may update only its exact persisted turn, never a newer run.
    if (!run && settingsEvent && workspaceId && event.turnId && event.sessionId)
      run = this.store
        .list<Run>('run')
        .find(
          (candidate) =>
            candidate.workspaceId === workspaceId &&
            candidate.providerTurnId === event.turnId &&
            this.conversation(candidate.conversationId).providerSessionId === event.sessionId,
        );
    const ids = { workspaceId, conversationId: run?.conversationId, runId: run?.id };
    this.store.transaction(() => {
      if (run) {
        if (event.type === 'usage.updated') {
          const parsed = RunUsageSchema.safeParse(event.payload.usage);
          if (parsed.success) {
            run.usage = parsed.data;
            this.store.put('run', run.id, run);
            this.store.emit('usage.updated', { run }, ids);
          }
          return;
        }
        if (event.type === 'context.updated') {
          const usage = event.payload.tokenUsage as
            | {
                total?: { totalTokens?: number };
                last?: { totalTokens?: number };
                modelContextWindow?: number | null;
              }
            | undefined;
          if (
            usage &&
            typeof usage.total?.totalTokens === 'number' &&
            typeof usage.last?.totalTokens === 'number'
          ) {
            run.contextUsage = {
              totalTokens: usage.total.totalTokens,
              contextTokens: usage.last.totalTokens,
              contextWindow: typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : null,
              updatedAt: new Date().toISOString(),
            };
            this.store.put('run', run.id, run);
            this.store.emit('context.updated', { run }, ids);
          }
          return;
        }
        if (settingsEvent) {
          run.requestedModel ??= run.model;
          if (run.requestedReasoningEffort === undefined) run.requestedReasoningEffort = run.reasoningEffort;
          const model = event.type === 'run.settings' ? event.payload.model : event.payload.toModel;
          if (typeof model === 'string' && model.length > 0 && model.length <= 200) {
            if (event.type === 'provider.warning') {
              this.reroutedModels.set(run.id, model);
              if (this.reroutedModels.size > 1000)
                this.reroutedModels.delete(this.reroutedModels.keys().next().value!);
            }
            // Rerouting describes the actual model for this turn; a later thread
            // settings response may still contain the originally requested model.
            run.model = this.reroutedModels.get(run.id) ?? model;
          }
          if (event.payload.reasoningEffort === null || typeof event.payload.reasoningEffort === 'string')
            run.reasoningEffort = event.payload.reasoningEffort as string | null;
          run.updatedAt = new Date().toISOString();
          this.store.put('run', run.id, run);
          this.store.emit(event.type, { ...event.payload, run }, ids);
          return;
        }
        if (event.type === 'run.started' && run.state === 'starting') this.state(run, 'running');
        if (event.turnId) {
          run.providerTurnId = event.turnId;
          this.store.put('run', run.id, run);
        }
        if (event.type === 'interaction.required') {
          const p = event.payload;
          const interaction: Interaction = {
            id: randomUUID(),
            workspaceId: run.workspaceId,
            conversationId: run.conversationId,
            runId: run.id,
            generation: event.generation,
            providerRequestId: p.requestId as string | number,
            kind: p.kind === 'input' ? 'input' : 'approval',
            status: 'pending',
            payload: p,
            createdAt: new Date().toISOString(),
          };
          this.store.put('interaction', interaction.id, interaction);
          this.state(run, interaction.kind === 'input' ? 'waiting_input' : 'waiting_approval');
          this.store.emit('interaction.required', { interaction }, ids);
          return;
        }
        if (event.type === 'interaction.resolved') {
          for (const interaction of this.store.list<Interaction>('interaction'))
            if (
              interaction.runId === run.id &&
              interaction.status === 'pending' &&
              interaction.generation === event.generation &&
              interaction.providerRequestId === event.payload.requestId
            ) {
              interaction.status = 'resolved';
              this.store.put('interaction', interaction.id, interaction);
              this.store.emit('interaction.resolved', { interaction }, ids);
            }
          if (run.state === 'waiting_approval' || run.state === 'waiting_input') this.state(run, 'running');
          return;
        }
        if (
          event.type === 'message.delta' ||
          event.type === 'message.completed' ||
          event.type.startsWith('tool.')
        ) {
          const itemId = String(event.payload.itemId ?? 'message'),
            id = `${run.id}:${itemId}`;
          const old = this.store.get<Message>('message', id);
          const incremental = event.type === 'message.delta' || event.type === 'tool.output';
          // Once an item's text cap is reached, discard subsequent chunks before
          // another database write. Completion may still update bounded metadata.
          if (incremental && old?.payload.outputTruncated === true) return;
          let text = old?.text ?? '',
            delta = '',
            outputTruncated = old?.payload.outputTruncated === true;
          if (incremental) {
            const appended = boundedText(
              String(event.payload.delta ?? event.payload.output ?? ''),
              MAX_MESSAGE_BYTES - Buffer.byteLength(text),
            );
            delta = appended.text;
            text += delta;
            outputTruncated ||= appended.truncated;
          } else if (!outputTruncated) {
            const full =
              event.payload.text ??
              event.payload.output ??
              (event.type === 'tool.completed' ? event.payload.aggregatedOutput : undefined);
            if (full !== undefined) {
              const bounded = boundedText(String(full), MAX_MESSAGE_BYTES);
              text = bounded.text;
              outputTruncated = bounded.truncated;
            }
          }
          const details = boundedToolPayload({ ...old?.payload, ...event.payload });
          const truncated = outputTruncated || details.truncated || old?.payload.truncated === true;
          const payload = {
            ...details.payload,
            ...(truncated ? { truncated: true } : {}),
            ...(outputTruncated ? { outputTruncated: true } : {}),
          };
          const message: Message = {
            id,
            runId: run.id,
            conversationId: run.conversationId,
            workspaceId: run.workspaceId,
            kind: event.type.startsWith('tool.') ? 'tool' : 'assistant',
            text,
            payload,
            createdAt: old?.createdAt ?? new Date().toISOString(),
          };
          this.store.put('message', id, message);
          if (incremental) {
            const { text: _, ...metadata } = message;
            this.store.emit(event.type, { messageDelta: { ...metadata, delta } }, ids);
          } else this.store.emit(event.type, { message }, ids);
          if (truncated && old?.payload.truncated !== true)
            this.store.emit(
              'provider.warning',
              {
                message: '单条输出或工具详情超过显示上限，已截断；完整输出请在远端检查',
                itemId,
                truncated: true,
              },
              ids,
            );
          return;
        }
        if (event.type === 'run.completed' || event.type === 'run.failed') {
          const s = event.payload.state;
          const state: RunState =
            s === 'cancelled'
              ? 'cancelled'
              : s === 'interrupted'
                ? 'interrupted'
                : s === 'uncertain'
                  ? 'uncertain'
                  : event.type === 'run.failed' || s === 'failed'
                    ? 'failed'
                    : 'completed';
          this.state(run, state, event.payload.error ? String(event.payload.error) : undefined);
          for (const i of this.store.list<Interaction>('interaction'))
            if (i.runId === run.id && i.status === 'pending') {
              i.status = 'expired';
              this.store.put('interaction', i.id, i);
              this.store.emit('interaction.resolved', { interaction: i }, ids);
            }
          queueMicrotask(() => {
            void this.finish(run!.workspaceId, state === 'uncertain' || state === 'interrupted');
          });
        }
      }
      this.store.emit(event.type, event.payload, ids);
    });
  }
  async cancel(id: string, clientRequestId: string) {
    let dispatch = false;
    const result = this.store.receipt(clientRequestId, { operation: 'cancel', id }, () => {
      const run = this.store.require<Run>('run', id);
      if (terminalStates.includes(run.state)) return { run, dispatch: false };
      const queued = run.state === 'queued';
      this.state(run, queued ? 'cancelled' : 'cancelling');
      dispatch = !queued;
      return { run, dispatch: !queued };
    });
    const run = this.store.require<Run>('run', id);
    if (dispatch && run.state === 'cancelling' && run.providerTurnId) {
      const conversation = this.conversation(run.conversationId);
      try {
        await (
          await this.provider(run.workspaceId)
        ).interruptRun({ sessionId: conversation.providerSessionId!, turnId: run.providerTurnId });
      } catch (e) {
        throw new AppError('uncertain_operation', '取消请求未得到确认，请查看任务状态', 409);
      }
    }
    return this.store.require<Run>('run', id);
  }
  async answer(
    id: string,
    input: {
      clientRequestId: string;
      decision?: 'accept' | 'decline' | 'cancel';
      answers?: Record<string, string[]>;
    },
  ) {
    const interaction = this.store.require<Interaction>('interaction', id);
    const adapter = this.providers.get(interaction.workspaceId)?.adapter;
    let dispatch = false;
    const result = this.store.receipt(input.clientRequestId, { operation: 'answer', id, ...input }, () => {
      if (interaction.status === 'resolved') return interaction;
      if (interaction.status !== 'pending' || !adapter || adapter.generation !== interaction.generation)
        throw new AppError('stale_interaction', '此确认请求已经失效', 409);
      if (interaction.kind === 'approval' && !input.decision)
        throw new AppError('invalid_request', '缺少审批决定');
      if (interaction.kind === 'input' && !input.answers && input.decision !== 'cancel')
        throw new AppError('invalid_request', '缺少问题回答');
      interaction.status = 'resolved';
      this.store.put('interaction', id, interaction);
      this.store.emit(
        'interaction.resolved',
        { interaction },
        {
          workspaceId: interaction.workspaceId,
          conversationId: interaction.conversationId,
          runId: interaction.runId,
        },
      );
      dispatch = true;
      return interaction;
    });
    if (dispatch) {
      try {
        await adapter!.answerInteraction({
          requestId: interaction.providerRequestId,
          generation: interaction.generation,
          ...input,
        });
        const run = this.store.require<Run>('run', interaction.runId);
        if (run.state === 'waiting_input' || run.state === 'waiting_approval')
          this.store.transaction(() => this.state(run, 'running'));
      } catch (e) {
        const run = this.store.require<Run>('run', interaction.runId);
        this.store.transaction(() =>
          this.state(run, 'uncertain', '审批提交结果不确定，请检查原任务；不会自动重新提交'),
        );
        throw e;
      }
    }
    return result;
  }
  async completeLogin(code: string, loginId: string) {
    if (!this.loginPending) throw new AppError('stale_interaction', '登录请求已失效', 409);
    const adapter = await this.provider();
    if (!adapter.completeLogin) throw new AppError('unsupported_feature', '此提供方不接受授权码', 404);
    await adapter.completeLogin(code, loginId);
    return { ok: true };
  }
  async cancelLogin() {
    const adapter = await this.provider();
    if (!adapter.cancelLogin) throw new AppError('unsupported_feature', '此版本不支持取消登录');
    await adapter.cancelLogin();
    this.loginPending = false;
    this.accountReader.invalidate();
    return { ok: true };
  }
  assertAccountDeletable(message = '此账号有活动任务或正在处理会话，请等待结束后删除') {
    if (
      this.maintenance.size ||
      this.active.size ||
      this.starting.size ||
      this.finishing.size ||
      this.retiring.size ||
      this.executing.size ||
      this.store.list<Run>('run').some((r) => !terminalStates.includes(r.state))
    )
      throw new AppError('run_conflict', message, 409);
  }
  async setFactoryKey(apiKey: string) {
    if (this.config.provider !== 'factory')
      throw new AppError('unsupported_feature', '当前账号不是 Factory Droid', 404);
    if (this.settingsUpdating || this.loginPending)
      throw new AppError('run_conflict', '账号正在处理请求，请稍后重试', 409);
    this.assertAccountDeletable('账号仍有活动任务，请等待结束后修改密钥');
    this.settingsUpdating = true;
    try {
      await writeFactoryKey(this.config.factoryHome ?? join(this.config.stateDir, 'factory'), apiKey);
      this.accountReader.invalidate();
      return { ok: true };
    } finally {
      this.settingsUpdating = false;
    }
  }
  async setDeepSeekKey(apiKey: string) {
    if (this.config.provider !== 'deepseek')
      throw new AppError('unsupported_feature', '当前账号不是 DeepSeek', 404);
    if (this.settingsUpdating || this.loginPending)
      throw new AppError('run_conflict', '账号正在处理请求，请稍后重试', 409);
    this.assertAccountDeletable('账号仍有活动任务，请等待结束后修改密钥');
    this.settingsUpdating = true;
    try {
      await writeKey(this.config.deepseekHome ?? join(this.config.stateDir, 'deepseek'), apiKey);
      this.accountReader.invalidate();
      return { ok: true };
    } finally {
      this.settingsUpdating = false;
    }
  }
  async geminiSettings(input?: Pick<GeminiSettings, 'revision' | 'allowedCommands' | 'deniedCommands'>) {
    if (this.config.provider !== 'antigravity')
      throw new AppError('unsupported_feature', '当前账号不是 Gemini', 404);
    const home = this.config.antigravityHome ?? join(this.config.stateDir, 'antigravity');
    if (!input) return readGeminiSettings(home);
    if (this.settingsUpdating || this.loginPending)
      throw new AppError('run_conflict', '账号正在处理请求，请稍后保存', 409);
    this.assertAccountDeletable('账号仍在执行任务或保存恢复点，请稍后修改权限');
    this.settingsUpdating = true;
    try {
      return await writeGeminiSettings(home, input);
    } finally {
      this.settingsUpdating = false;
    }
  }
  async login() {
    if (this.settingsUpdating) throw new AppError('run_conflict', '正在保存账号权限，请稍后登录', 409);
    if (this.loginPending) {
      const adapter = await this.provider();
      return adapter.beginLogin!();
    }
    if (this.maintenance.size || this.store.list<Run>('run').some((r) => !terminalStates.includes(r.state)))
      throw new AppError('run_conflict', '存在活动任务或登录流程，不能更换账号', 409);
    const adapter = await this.provider();
    if (!adapter.beginLogin) throw new AppError('unsupported_feature', '此版本不支持设备码登录');
    this.loginPending = true;
    this.accountReader.invalidate();
    try {
      return await adapter.beginLogin();
    } catch (e) {
      this.loginPending = false;
      throw e;
    }
  }
  conversationPage(conversationId: string, limit: number, before?: string) {
    const conversation = this.conversation(conversationId);
    const all = this.store.conversationObjects<Run>('run', conversationId);
    const end = before ? all.findIndex((run) => run.id === before) : all.length;
    if (end < 0) throw new AppError('invalid_request', '会话分页位置无效', 400);
    const start = Math.max(0, end - limit);
    const page = all.slice(start, end);
    const pageIds = new Set(page.map((run) => run.id));
    // A long queue must not push the currently executing round's prefix off the first page.
    const runs = before
      ? page
      : all.filter((run) => pageIds.has(run.id) || !terminalStates.includes(run.state));
    const ids = new Set(runs.map((run) => run.id));
    return {
      conversation,
      runs,
      messages: this.store
        .conversationObjects<Message>('message', conversationId)
        .filter((m) => ids.has(m.runId)),
      nextBefore: start > 0 ? page[0].id : null,
      seq: this.store.sequence(),
    };
  }
  snapshot(includeMessages = true) {
    return {
      identity: this.identity,
      seq: this.store.sequence(),
      workspaces: this.store.list<StoredWorkspace>('workspace'),
      conversations: this.store.list<Conversation>('conversation'),
      runs: this.store.list<Run>('run').slice(-500),
      interactions: this.store.list<Interaction>('interaction').filter((i) => i.status === 'pending'),
      messages: includeMessages ? this.store.list<Message>('message').slice(-1000) : [],
    };
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.accountReader.close();
    await Promise.allSettled([...this.maintenanceTasks]);
    await Promise.allSettled([...this.retiring.values()]);
    await Promise.allSettled([...this.providers.values()].map((p) => p.adapter.close()));
    await Promise.allSettled([...this.executing]);
    for (const id of this.active.keys()) await this.finish(id, true);
    await Promise.allSettled([...this.finishing.values()]);
    await this.authBroker?.close();
    await this.locks.close();
    await this.files.close();
  }
}
