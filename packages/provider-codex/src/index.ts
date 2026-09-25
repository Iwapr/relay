import type { CodexAuthBroker } from './auth.ts';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeWriter, type WriterOwner } from './takeover.ts';
import type {
  AIProviderAdapter,
  AccountState,
  ModelInfo,
  QuotaState,
  ProviderEvent,
  CreateSessionInput,
  StartRunInput,
  ProviderSessionRef,
  ProviderRunRef,
  InteractionAnswer,
  NativeSessionSummary,
  NativeSessionHistory,
} from '../../provider-core/src/index.ts';
import { AppError, type PermissionMode } from '../../contracts/src/index.ts';
import type { InitializeResponse } from '../../../generated/codex/InitializeResponse.ts';
import type { ServerRequest } from '../../../generated/codex/ServerRequest.ts';
import type { ServerNotification } from '../../../generated/codex/ServerNotification.ts';
import type { GetAccountResponse } from '../../../generated/codex/v2/GetAccountResponse.ts';
import type { ModelListResponse } from '../../../generated/codex/v2/ModelListResponse.ts';
import type { ConfigReadResponse } from '../../../generated/codex/v2/ConfigReadResponse.ts';
import type { GetAccountRateLimitsResponse } from '../../../generated/codex/v2/GetAccountRateLimitsResponse.ts';
import type { RateLimitSnapshot } from '../../../generated/codex/v2/RateLimitSnapshot.ts';
import type { ThreadStartResponse } from '../../../generated/codex/v2/ThreadStartResponse.ts';
import type { ThreadStartParams } from '../../../generated/codex/v2/ThreadStartParams.ts';
import type { ThreadHistoryMode } from '../../../generated/codex/v2/ThreadHistoryMode.ts';
import type { ThreadReadResponse } from '../../../generated/codex/v2/ThreadReadResponse.ts';
import type { ThreadListResponse } from '../../../generated/codex/v2/ThreadListResponse.ts';
import type { Thread } from '../../../generated/codex/v2/Thread.ts';
import type { ThreadSettings } from '../../../generated/codex/v2/ThreadSettings.ts';
import type { ThreadTurnsListResponse } from '../../../generated/codex/v2/ThreadTurnsListResponse.ts';
import type { TurnStartResponse } from '../../../generated/codex/v2/TurnStartResponse.ts';
import type { LoginAccountResponse } from '../../../generated/codex/v2/LoginAccountResponse.ts';
import type { SandboxPolicy } from '../../../generated/codex/v2/SandboxPolicy.ts';
import type { ReasoningEffort } from '../../../generated/codex/ReasoningEffort.ts';
import { CodexRpc, validateSchema, redactError, redactText } from './protocol.ts';

const notificationSchemas: Record<string, string> = {
  'turn/started': 'TurnStartedNotification',
  'turn/completed': 'TurnCompletedNotification',
  'item/started': 'ItemStartedNotification',
  'item/completed': 'ItemCompletedNotification',
  'item/agentMessage/delta': 'AgentMessageDeltaNotification',
  'item/commandExecution/outputDelta': 'CommandExecutionOutputDeltaNotification',
  'item/fileChange/outputDelta': 'FileChangeOutputDeltaNotification',
  'turn/diff/updated': 'TurnDiffUpdatedNotification',
  'account/updated': 'AccountUpdatedNotification',
  'account/login/completed': 'AccountLoginCompletedNotification',
  'account/rateLimits/updated': 'AccountRateLimitsUpdatedNotification',
  'serverRequest/resolved': 'ServerRequestResolvedNotification',
  'thread/tokenUsage/updated': 'ThreadTokenUsageUpdatedNotification',
  'model/rerouted': 'ModelReroutedNotification',
  error: 'ErrorNotification',
  'thread/settings/updated': 'ThreadSettingsUpdatedNotification',
};
const interactionMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
]);
const privateKey = /token|secret|password|authorization|api.?key/i;
/** Display data may contain text chosen by the model; redact structured credential fields. */
function display(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(display);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, privateKey.test(key) ? '[redacted]' : display(val)]),
    );
  return value;
}
function requestKey(id: string | number): string {
  return `${typeof id}:${id}`;
}
export function sandboxPolicy(mode: PermissionMode, cwd: string): SandboxPolicy {
  if (mode === 'full-access') return { type: 'dangerFullAccess' };
  return mode === 'read-only'
    ? { type: 'readOnly', networkAccess: false }
    : {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
}
export function normalizeQuota(
  buckets: Record<string, RateLimitSnapshot>,
  now = new Date().toISOString(),
): QuotaState {
  return {
    windows: Object.entries(buckets).flatMap(([scope, bucket]) =>
      (['primary', 'secondary'] as const).flatMap((name) => {
        const window = bucket[name];
        return window
          ? [
              {
                name: `${bucket.limitName || scope} · ${name}`,
                scope: bucket.limitId || scope,
                usedPercent: window.usedPercent,
                windowDurationMins: window.windowDurationMins,
                resetsAt: window.resetsAt,
              },
            ]
          : [];
      }),
    ),
    credits: Object.fromEntries(
      Object.entries(buckets)
        .filter(([, bucket]) => bucket.credits !== null)
        .map(([scope, bucket]) => [scope, bucket.credits]),
    ),
    updatedAt: now,
    stale: false,
  };
}

export class CodexAdapter implements AIProviderAdapter {
  readonly id = 'codex';
  readonly disposeAfterRun = true;
  readonly generation = randomUUID();
  private rpc: CodexRpc;
  private authAccountId?: string;
  private authenticating?: Promise<void>;
  private unsubscribeAuth?: () => void;
  private ready?: Promise<void>;
  private listeners = new Set<(event: ProviderEvent) => void>();
  private sessions = new Map<string, CreateSessionInput>();
  private active = new Map<string, string>();
  private expectedPolicies = new Map<string, PermissionMode>();
  private pendingTurnPolicies = new Map<string, { settings?: ThreadSettings; error?: Error }>();
  private cancelled = new Set<string>();
  private terminalTurns = new Set<string>();
  private interactions = new Map<string, ServerRequest>();
  private resolved = new Set<string>();
  private items = new Map<string, unknown>();
  private buckets: Record<string, RateLimitSnapshot> = {};
  private quota: QuotaState | null = null;
  private login?: Promise<{ verificationUrl: string; userCode: string; loginId: string }>;
  private identity?: InitializeResponse;
  constructor(
    private options: {
      cwd: string;
      executable?: string;
      timeoutMs?: number;
      taskUmask?: '0022' | '0002';
      codexHome?: string;
      credentialStore?: 'file';
      authBroker?: CodexAuthBroker;
    },
  ) {
    this.rpc = new CodexRpc(
      {
        cwd: options.cwd,
        codexHome: options.codexHome,
        isolatedAuth: !!options.authBroker || options.credentialStore === 'file',
        executable: options.executable ?? 'codex',
        timeoutMs: options.timeoutMs,
        taskUmask: options.taskUmask,
        args: [
          ...(options.authBroker
            ? [
                '-c',
                'cli_auth_credentials_store="ephemeral"',
                '-c',
                'chatgpt_base_url="https://chatgpt.com/backend-api"',
              ]
            : options.credentialStore
              ? ['-c', 'cli_auth_credentials_store="file"']
              : []),
          '-c',
          'model_reasoning_effort="medium"',
          '-c',
          'features.memories=false',
          '-c',
          'memories.generate_memories=false',
          '-c',
          'memories.use_memories=false',
          '-c',
          'sandbox_workspace_write.writable_roots=[]',
        ],
      },
      (message) => this.receive(message),
      (error) => {
        for (const [sessionId, turnId] of this.active)
          this.emit('run.failed', { state: 'interrupted', error: error.message }, sessionId, turnId);
        this.active.clear();
        this.interactions.clear();
        this.emit('provider.warning', { message: error.message, interrupted: true });
      },
    );
  }
  capabilities() {
    return {
      sessions: true,
      resume: true,
      models: true,
      reasoning: true,
      quota: true,
      approvals: true,
      userInput: true,
      cancel: true,
      attachments: true,
    };
  }
  subscribeEvents(handler: (event: ProviderEvent) => void) {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
  private emit(type: string, payload: Record<string, unknown>, sessionId?: string, turnId?: string): void {
    const event = { type, payload, sessionId, turnId, generation: this.generation };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* An observer cannot break the provider stream. */
      }
    }
  }
  private async connect(): Promise<void> {
    this.ready ??= (async () => {
      if (process.getuid?.() === 0)
        throw new AppError('CODEX_ROOT_FORBIDDEN', 'Codex must run as an ordinary Linux user', 403);
      this.options.cwd = await realpath(this.options.cwd);
      await this.rpc.open();
      this.identity = await this.rpc.request(
        'initialize',
        {
          clientInfo: { name: 'remote_workbench', title: 'Remote Workbench', version: '0.1.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
        'v1/InitializeResponse',
      );
      this.rpc.send({ method: 'initialized' });
      this.unsubscribeAuth = this.options.authBroker?.subscribe((message) => {
        if (
          message.method === 'account/login/completed' &&
          (message.params as { success?: boolean })?.success &&
          !this.active.size
        )
          this.authAccountId = undefined;
        this.receive(message);
      });
    })();
    return this.ready;
  }
  async diagnostics() {
    await this.connect();
    return { version: this.rpc.version, generation: this.generation, ...this.identity };
  }
  async getAccount(): Promise<AccountState> {
    await this.connect();
    const result = this.options.authBroker
      ? await this.options.authBroker.account()
      : await this.rpc.request<'account/read', GetAccountResponse>(
          'account/read',
          { refreshToken: false },
          'v2/GetAccountResponse',
        );
    return {
      authenticated: result.account !== null,
      authMode: result.account?.type ?? null,
      identifier: result.account?.type === 'chatgpt' ? result.account.email : null,
      planType: result.account?.type === 'chatgpt' ? result.account.planType : null,
      requiresOpenaiAuth: result.requiresOpenaiAuth,
    };
  }
  private async authenticate() {
    if (!this.options.authBroker || this.authAccountId) return;
    this.authenticating ??= (async () => {
      const tokens = await this.options.authBroker!.tokens(false, this.authAccountId);
      const result = await this.rpc.request<'account/login/start', LoginAccountResponse>(
        'account/login/start',
        { type: 'chatgptAuthTokens', ...tokens },
        'v2/LoginAccountResponse',
      );
      if (result.type !== 'chatgptAuthTokens')
        throw new AppError('CHATGPT_LOGIN_REQUIRED', 'Codex 未接受所选账号的进程内授权。', 409);
      this.authAccountId = tokens.chatgptAccountId;
    })().finally(() => {
      this.authenticating = undefined;
    });
    await this.authenticating;
  }
  private async guard(cwd: string, modelId: string): Promise<Record<string, boolean | string>> {
    await this.connect();
    if ((await realpath(cwd)) !== this.options.cwd)
      throw new AppError('WORKSPACE_MISMATCH', 'A Codex process is bound to one canonical workspace', 403);
    await this.authenticate();
    const account = await this.getAccount();
    if (!account.authenticated || account.authMode !== 'chatgpt' || !account.requiresOpenaiAuth)
      throw new AppError(
        'CHATGPT_LOGIN_REQUIRED',
        'This workbench requires official Codex ChatGPT authentication; API key and third-party provider modes are blocked',
        409,
      );
    const { config } = await this.rpc.request<'config/read', ConfigReadResponse>(
      'config/read',
      { includeLayers: false, cwd: this.options.cwd },
      'v2/ConfigReadResponse',
    );
    if (config.model_provider && config.model_provider !== 'openai')
      throw new AppError(
        'PROVIDER_NOT_SUPPORTED',
        'The effective Codex model provider is not OpenAI. Existing configuration was left unchanged.',
        409,
      );
    const providers = config.model_providers as Record<string, unknown> | null;
    if (
      (config.forced_login_method && config.forced_login_method !== 'chatgpt') ||
      config.openai_base_url ||
      (config.chatgpt_base_url &&
        !['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/'].includes(
          String(config.chatgpt_base_url),
        )) ||
      providers?.openai ||
      process.env.OPENAI_BASE_URL ||
      process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY
    )
      throw new AppError(
        'PROVIDER_OVERRIDE_BLOCKED',
        'An API key or custom OpenAI provider override is configured; use a dedicated ChatGPT-authenticated Codex environment.',
        409,
      );
    const selected = (await this.listModels()).find((model) => model.id === modelId);
    if (!selected)
      throw new AppError(
        'MODEL_UNAVAILABLE',
        'The selected model is no longer available for this account',
        409,
      );
    const overrides: Record<string, boolean | string> = {
      web_search: 'disabled',
      'features.apps': false,
      'features.multi_agent': false,
      'features.memories': false,
      'memories.generate_memories': false,
      'memories.use_memories': false,
      'features.plugins': false,
      'features.hooks': false,
      'features.plugin_hooks': false,
      'features.browser_use': false,
      'features.computer_use': false,
      'sandbox_workspace_write.network_access': false,
      'sandbox_workspace_write.exclude_tmpdir_env_var': true,
      'sandbox_workspace_write.exclude_slash_tmp': true,
    };
    if (selected.defaultReasoningEffort) overrides.model_reasoning_effort = selected.defaultReasoningEffort;
    // Unsupported external tools are disabled for this thread only; never rewrite the user's config.
    for (const key of ['mcp_servers']) {
      const configured = config[key];
      if (configured && typeof configured === 'object' && !Array.isArray(configured))
        for (const name of Object.keys(configured)) {
          if (!/^[A-Za-z0-9_-]+$/.test(name))
            throw new AppError(
              'UNSUPPORTED_MCP_CONFIG',
              'An MCP server name cannot be safely disabled by this pinned Codex adapter; disable it in a dedicated Codex environment',
              409,
            );
          overrides[`${key}.${name}.enabled`] = false;
        }
    }
    return overrides;
  }
  async listModels(): Promise<ModelInfo[]> {
    await this.connect();
    if (this.options.authBroker && (await this.getAccount()).authenticated) await this.authenticate();
    const results: ModelInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await this.rpc.request(
        'model/list',
        { limit: 100, cursor, includeHidden: false },
        'v2/ModelListResponse',
      );
      for (const model of page.data)
        if (!model.hidden)
          results.push({
            id: model.model,
            displayName: model.displayName,
            description: model.description,
            isDefault: model.isDefault,
            reasoningEfforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
            defaultReasoningEffort: model.defaultReasoningEffort,
            supportsImages: model.inputModalities.includes('image'),
          });
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Codex model pagination returned a repeated cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...new Map(results.map((model) => [model.id, model])).values()];
  }
  async getQuota(): Promise<QuotaState | null> {
    await this.connect();
    try {
      await this.authenticate();
      const result = await this.rpc.request<'account/rateLimits/read', GetAccountRateLimitsResponse>(
        'account/rateLimits/read',
        undefined,
        'v2/GetAccountRateLimitsResponse',
      );
      this.buckets = (result.rateLimitsByLimitId as Record<string, RateLimitSnapshot>) ?? {
        [result.rateLimits.limitId ?? 'codex']: result.rateLimits,
      };
      this.quota = normalizeQuota(this.buckets);
    } catch (error) {
      this.quota = {
        ...(this.quota ?? { windows: [], credits: null, updatedAt: new Date().toISOString() }),
        stale: true,
        unavailableReason: redactError((error as Error).message),
      };
    }
    return this.quota;
  }
  async beginLogin(): Promise<{ verificationUrl: string; userCode: string; loginId: string }> {
    await this.connect();
    if (this.active.size)
      throw new AppError('LOGIN_DURING_RUN', 'Login cannot change while a task is active', 409);
    this.login ??= (async () => {
      const current = await this.getAccount();
      if (current.authenticated)
        throw new AppError(
          'ACCOUNT_ALREADY_LOGGED_IN',
          'Codex already has an account; manage account switching using the official local Codex CLI',
          409,
        );
      const result = this.options.authBroker
        ? await this.options.authBroker.login()
        : await this.rpc.request<'account/login/start', LoginAccountResponse>(
            'account/login/start',
            { type: 'chatgptDeviceCode' },
            'v2/LoginAccountResponse',
          );
      if (result.type !== 'chatgptDeviceCode')
        throw new AppError(
          'DEVICE_LOGIN_UNAVAILABLE',
          'Device-code login is unavailable; run codex login --device-auth on the remote machine',
          409,
        );
      const verification = new URL(result.verificationUrl);
      if (
        verification.protocol !== 'https:' ||
        !['auth.openai.com', 'chatgpt.com'].includes(verification.hostname) ||
        verification.username ||
        verification.password
      )
        throw new AppError(
          'LOGIN_URL_UNSUPPORTED',
          'Codex returned an unrecognized device authorization URL; use the official local login flow',
          409,
        );
      return { verificationUrl: result.verificationUrl, userCode: result.userCode, loginId: result.loginId };
    })().catch((error) => {
      this.login = undefined;
      throw error;
    });
    return this.login;
  }
  async cancelLogin(): Promise<void> {
    if (!this.login) return;
    const challenge = await this.login;
    if (this.options.authBroker) await this.options.authBroker.cancel(challenge.loginId);
    else
      await this.rpc.request(
        'account/login/cancel',
        { loginId: challenge.loginId },
        'v2/CancelLoginAccountResponse',
      );
    this.login = undefined;
  }
  private async verifySession(
    result: ThreadStartResponse,
    input: CreateSessionInput,
  ): Promise<ProviderSessionRef> {
    const sandbox = result.sandbox;
    if (
      result.modelProvider !== 'openai' ||
      result.thread.modelProvider !== 'openai' ||
      (await realpath(result.cwd)) !== this.options.cwd ||
      (await realpath(result.thread.cwd)) !== this.options.cwd ||
      result.approvalPolicy !== (input.permissionMode === 'full-access' ? 'never' : 'on-request') ||
      result.approvalsReviewer !== 'user'
    )
      throw new AppError(
        'UNSAFE_EFFECTIVE_POLICY',
        'Codex returned an unexpected provider, directory, or approval policy',
        409,
      );
    const correct =
      input.permissionMode === 'full-access'
        ? sandbox.type === 'dangerFullAccess'
        : input.permissionMode === 'read-only'
          ? sandbox.type === 'readOnly' && !sandbox.networkAccess
          : sandbox.type === 'workspaceWrite' &&
            !sandbox.networkAccess &&
            sandbox.excludeSlashTmp &&
            sandbox.excludeTmpdirEnvVar &&
            sandbox.writableRoots.every((root) => root === this.options.cwd);
    if (!correct)
      throw new AppError(
        'UNSAFE_EFFECTIVE_SANDBOX',
        `The effective Codex sandbox does not match the selected permission mode: ${JSON.stringify(sandbox)}`,
        409,
      );
    this.sessions.set(result.thread.id, { ...input, cwd: this.options.cwd });
    return { id: result.thread.id, model: result.model };
  }
  async createSession(input: CreateSessionInput): Promise<ProviderSessionRef> {
    const config = await this.guard(input.cwd, input.model);
    // This field is present in the pinned CLI's --experimental protocol. Its
    // non-ephemeral default is paginated, whose live history APIs are incomplete.
    const params = {
      cwd: this.options.cwd,
      model: input.model,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      config,
      ephemeral: false,
      historyMode: 'legacy',
    } satisfies ThreadStartParams & { historyMode: ThreadHistoryMode };
    const result = await this.rpc.request<'thread/start', ThreadStartResponse>(
      'thread/start',
      params,
      'v2/ThreadStartResponse',
    );
    if (result.thread.historyMode !== 'legacy')
      throw new AppError(
        'unsupported_feature',
        'Codex did not create the requested legacy history format',
        409,
      );
    const session = await this.verifySession(result, { ...input, permissionMode: 'read-only' });
    this.sessions.set(session.id, { ...input, cwd: this.options.cwd });
    return session;
  }
  async forkSession(id: string, lastTurnId: string, input: CreateSessionInput): Promise<ProviderSessionRef> {
    const config = await this.guard(input.cwd, input.model);
    const existing = await this.rpc.request<'thread/read', ThreadReadResponse>(
      'thread/read',
      { threadId: id, includeTurns: false },
      'v2/ThreadReadResponse',
    );
    await this.verifyNativeThread(existing.thread);
    const result = await this.rpc.request<'thread/fork', ThreadStartResponse>(
      'thread/fork',
      {
        threadId: id,
        lastTurnId,
        cwd: this.options.cwd,
        model: input.model,
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        config,
        ephemeral: false,
        excludeTurns: true,
      },
      'v2/ThreadForkResponse',
    );
    return this.verifySession(result, { ...input, permissionMode: 'read-only' });
  }
  async inspectSessionOwner(id: string) {
    await this.readNativeSession(id);
    return (await nativeWriter(
      this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      id,
    )) as WriterOwner;
  }
  async stopSessionOwner(id: string, fingerprint: string) {
    await this.readNativeSession(id);
    await nativeWriter(
      this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      id,
      fingerprint,
    );
  }
  async resumeSession(ref: ProviderSessionRef, input: CreateSessionInput): Promise<ProviderSessionRef> {
    const config = await this.guard(input.cwd, input.model);
    // A loaded thread is already resumed; Codex deliberately ignores resume overrides for it.
    // The next turn always supplies and verifies its own explicit policy.
    if (this.sessions.has(ref.id)) return { id: ref.id, model: input.model };
    const existing = await this.rpc.request<'thread/read', ThreadReadResponse>(
      'thread/read',
      { threadId: ref.id, includeTurns: false },
      'v2/ThreadReadResponse',
    );
    await this.verifyNativeThread(existing.thread);
    this.expectedPolicies.set(ref.id, 'read-only');
    const result = await this.rpc.request<'thread/resume', ThreadStartResponse>(
      'thread/resume',
      {
        threadId: ref.id,
        cwd: this.options.cwd,
        model: input.model,
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        config,
        excludeTurns: true,
      },
      'v2/ThreadResumeResponse',
    );
    const session = await this.verifySession(result, { ...input, permissionMode: 'read-only' });
    this.sessions.set(session.id, { ...input, cwd: this.options.cwd });
    return session;
  }
  async startRun(input: StartRunInput): Promise<ProviderRunRef> {
    if (this.active.has(input.sessionId))
      throw new AppError('SESSION_BUSY', 'The native session already has an active turn', 409);
    if (!this.sessions.has(input.sessionId))
      throw new AppError('SESSION_NOT_RESUMED', 'Resume the owned session before starting a turn', 409);
    await this.guard(input.cwd, input.model);
    const model = (await this.listModels()).find((model) => model.id === input.model);
    if (!model)
      throw new AppError(
        'MODEL_UNAVAILABLE',
        'The selected model is no longer available for this account',
        409,
      );
    if (input.reasoningEffort && !model.reasoningEfforts.includes(input.reasoningEffort))
      throw new AppError(
        'REASONING_UNSUPPORTED',
        'The model does not support the selected reasoning effort',
        400,
      );
    if (input.images?.length && !model.supportsImages)
      throw new AppError('MODEL_IMAGE_UNSUPPORTED', '所选模型不支持图片，请切换支持图片的模型。', 400);
    if (
      input.images?.some((image) => !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.url))
    )
      throw new AppError('invalid_image', '只支持已上传的图片。', 400);
    if (
      this.quota &&
      !this.quota.stale &&
      this.quota.windows.some(
        (window) =>
          window.scope === 'codex' &&
          window.usedPercent !== null &&
          window.usedPercent >= 100 &&
          (window.resetsAt === null || window.resetsAt * 1000 > Date.now()),
      )
    )
      throw new AppError(
        'QUOTA_EXHAUSTED',
        'The subscription quota is exhausted; check the account quota before starting another task',
        409,
      );
    // A settings notification has no turn ID. Accept only this thread's notifications
    // received after dispatch, and never reuse a previous turn's verified policy.
    const policy: { settings?: ThreadSettings; error?: Error } = {};
    this.expectedPolicies.set(input.sessionId, input.permissionMode);
    this.pendingTurnPolicies.set(input.sessionId, policy);
    let result: TurnStartResponse;
    try {
      result = await this.rpc.request<'turn/start', TurnStartResponse>(
        'turn/start',
        {
          threadId: input.sessionId,
          input: [
            { type: 'text', text: input.text, text_elements: [] },
            ...(input.images ?? []).map((image) => ({
              type: 'image' as const,
              url: image.url,
              detail: 'original' as const,
            })),
          ],
          model: input.model,
          effort: input.reasoningEffort as ReasoningEffort | undefined,
          cwd: this.options.cwd,
          sandboxPolicy: sandboxPolicy(input.permissionMode, this.options.cwd),
          approvalPolicy: input.permissionMode === 'full-access' ? 'never' : 'on-request',
          approvalsReviewer: 'user',
        },
        'v2/TurnStartResponse',
      );
    } catch (error) {
      this.pendingTurnPolicies.delete(input.sessionId);
      const uncertain = new AppError(
        'uncertain_operation',
        `Codex turn/start outcome could not be confirmed: ${(error as Error).message}`,
        409,
      );
      // Do not let the Agent release its directory lock while an unconfirmed turn keeps running.
      await this.rpc.close(uncertain);
      this.emit('provider.warning', { message: uncertain.message, interrupted: true });
      throw uncertain;
    }
    if (result.turn.status === 'inProgress' && !this.terminalTurns.has(result.turn.id))
      this.active.set(input.sessionId, result.turn.id);
    try {
      if (policy.error) throw policy.error;
      if (policy.settings) {
        // receive() has validated the schema and exact effective policy. Some
        // versions cannot rejoin an active thread even with excludeTurns:true.
        this.emit(
          'run.settings',
          {
            model: policy.settings.model,
            reasoningEffort: policy.settings.effort,
            permissionMode: input.permissionMode,
            sandbox: policy.settings.sandboxPolicy,
          },
          input.sessionId,
          result.turn.id,
        );
      } else {
        // Fail closed if no fresh settings were observed and rejoining cannot
        // independently verify the effective policy.
        const effective = await this.rpc.request<'thread/resume', ThreadStartResponse>(
          'thread/resume',
          { threadId: input.sessionId, excludeTurns: true },
          'v2/ThreadResumeResponse',
        );
        await this.verifySession(effective, input);
        if (policy.error) throw policy.error;
        this.emit(
          'run.settings',
          {
            model: effective.model,
            reasoningEffort: effective.reasoningEffort,
            permissionMode: input.permissionMode,
            sandbox: effective.sandbox,
          },
          input.sessionId,
          result.turn.id,
        );
      }
    } catch (error) {
      await this.rpc.close(
        new AppError('uncertain_operation', 'The effective turn policy could not be verified', 409),
      );
      this.emit(
        'run.failed',
        {
          state: 'uncertain',
          error: `Could not verify the effective turn policy: ${(error as Error).message}`,
        },
        input.sessionId,
        result.turn.id,
      );
      this.emit('provider.warning', {
        message: 'The effective turn policy could not be verified; process stopped',
        interrupted: true,
      });
      throw new AppError(
        'uncertain_operation',
        'The effective turn policy could not be verified; the Codex process was stopped',
        409,
      );
    } finally {
      this.pendingTurnPolicies.delete(input.sessionId);
    }
    return { sessionId: input.sessionId, turnId: result.turn.id };
  }
  async steerRun(ref: ProviderRunRef, text: string, clientRequestId: string): Promise<void> {
    if (!this.sessions.has(ref.sessionId) || this.active.get(ref.sessionId) !== ref.turnId)
      throw new AppError('run_conflict', '这一轮已结束，请刷新后作为新消息回复', 409);
    const result = await this.rpc.request<'turn/steer', { turnId: string }>(
      'turn/steer',
      {
        threadId: ref.sessionId,
        expectedTurnId: ref.turnId,
        clientUserMessageId: clientRequestId,
        input: [{ type: 'text', text, text_elements: [] }],
      },
      'v2/TurnSteerResponse',
    );
    if (result.turnId !== ref.turnId)
      throw new AppError('uncertain_operation', '回答对应的轮次未能确认', 409);
  }
  async interruptRun(ref: ProviderRunRef): Promise<void> {
    await this.connect();
    this.cancelled.add(ref.turnId);
    try {
      await this.rpc.request(
        'turn/interrupt',
        { threadId: ref.sessionId, turnId: ref.turnId },
        'v2/TurnInterruptResponse',
      );
    } catch (error) {
      this.cancelled.delete(ref.turnId);
      throw error;
    }
  }
  async readSession(id: string): Promise<unknown> {
    await this.connect();
    const result = await this.rpc.request<'thread/read', ThreadReadResponse>(
      'thread/read',
      { threadId: id, includeTurns: true },
      'v2/ThreadReadResponse',
    );
    await this.verifyNativeThread(result.thread);
    return result.thread;
  }
  private async verifyNativeThread(
    thread: Thread,
    scope: 'workspace' | 'all' = 'workspace',
    includeSubagents = false,
  ): Promise<string> {
    const cwd = await realpath(thread.cwd);
    if (
      (scope === 'workspace' && cwd !== this.options.cwd) ||
      thread.modelProvider !== 'openai' ||
      (!includeSubagents &&
        (thread.parentThreadId || (typeof thread.source === 'object' && 'subAgent' in thread.source)))
    )
      throw new AppError(
        'SESSION_WORKSPACE_MISMATCH',
        'Native thread belongs to another workspace, provider, or a subagent',
        403,
      );
    return cwd;
  }
  private nativeSummary(thread: Thread, cwd = this.options.cwd): NativeSessionSummary {
    return {
      id: thread.id,
      title: redactText(thread.name || thread.preview || 'Codex conversation').slice(0, 300),
      cwd,
      updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
      ...(thread.model ? { model: thread.model } : {}),
      source:
        thread.parentThreadId || (typeof thread.source === 'object' && 'subAgent' in thread.source)
          ? 'subagent'
          : typeof thread.source === 'string'
            ? thread.source
            : 'custom',
      status: thread.status.type,
    };
  }
  async listNativeSessions(
    cursor?: string,
    scope: 'workspace' | 'all' = 'workspace',
  ): Promise<{
    sessions: NativeSessionSummary[];
    nextCursor: string | null;
  }> {
    const page = await this.listSessions(cursor, scope);
    const sessions: NativeSessionSummary[] = [];
    for (const thread of page.data) {
      try {
        const cwd = await this.verifyNativeThread(thread, scope);
        sessions.push(this.nativeSummary(thread, cwd));
      } catch {
        // The Agent checks allowed roots before exposing global discovery results.
      }
    }
    return { sessions, nextCursor: page.nextCursor };
  }
  async readNativeSessionMetadata(id: string): Promise<NativeSessionSummary> {
    return this.readMetadata(id, false);
  }
  async readSessionOwnerMetadata(id: string): Promise<NativeSessionSummary> {
    return this.readMetadata(id, true);
  }
  private async readMetadata(id: string, includeSubagents: boolean): Promise<NativeSessionSummary> {
    await this.connect();
    const { thread } = await this.rpc.request<'thread/read', ThreadReadResponse>(
      'thread/read',
      { threadId: id, includeTurns: false },
      'v2/ThreadReadResponse',
    );
    const cwd = await this.verifyNativeThread(thread, 'all', includeSubagents);
    return this.nativeSummary(thread, cwd);
  }
  async readNativeSession(id: string, options: { limit?: number } = {}): Promise<NativeSessionHistory> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)));
    await this.connect();
    const { thread } = await this.rpc.request<'thread/read', ThreadReadResponse>(
      'thread/read',
      { threadId: id, includeTurns: false },
      'v2/ThreadReadResponse',
    );
    await this.verifyNativeThread(thread);
    const turns: NativeSessionHistory['turns'] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    let remaining = 256 * 1024;
    let truncated = false;
    const boundedText = (text: string): string => {
      const clean = redactText(text);
      const length = Math.min(clean.length, remaining, 32 * 1024);
      if (length < clean.length) truncated = true;
      remaining -= length;
      return clean.slice(0, length);
    };
    do {
      const page: ThreadTurnsListResponse = await this.rpc.request(
        'thread/turns/list',
        {
          threadId: id,
          limit: Math.min(20, limit - turns.length),
          cursor,
          sortDirection: 'desc',
          itemsView: 'full',
        },
        'v2/ThreadTurnsListResponse',
      );
      for (const turn of page.data) {
        if (turns.length === limit || remaining === 0) {
          truncated = true;
          break;
        }
        const messages: NativeSessionHistory['turns'][number]['messages'] = [];
        const userTexts: string[] = [];
        for (const item of turn.items) {
          if (remaining === 0) {
            truncated = true;
            break;
          }
          if (item.type === 'userMessage') {
            for (const content of item.content)
              if (content.type === 'text')
                userTexts.push(boundedText(`${userTexts.length ? '\n' : ''}${content.text}`));
          } else if (item.type === 'agentMessage' || item.type === 'plan') {
            messages.push({
              id: item.id,
              kind: 'assistant',
              text: boundedText(item.text),
              ...(item.type === 'agentMessage' && item.questions?.length
                ? {
                    questions: item.questions.slice(0, 10).map((q) => ({
                      title: boundedText(q.title),
                      options: q.options?.slice(0, 20).map(boundedText) ?? null,
                    })),
                  }
                : {}),
            });
          } else if (item.type === 'commandExecution') {
            messages.push({
              id: item.id,
              kind: 'tool',
              text: boundedText(`${item.command}\n${item.aggregatedOutput ?? ''}`),
            });
          } else if (item.type === 'fileChange') {
            messages.push({
              id: item.id,
              kind: 'tool',
              text: boundedText(item.changes.map((change) => `${change.path}\n${change.diff}`).join('\n')),
            });
          } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
            messages.push({ id: item.id, kind: 'tool', text: boundedText(`${item.tool}: ${item.status}`) });
          }
          // Reasoning, hidden context, plugin arguments and credentials are not transcript messages.
        }
        turns.push({
          id: turn.id,
          // A different app-server can reconstruct an unfinished persisted turn
          // as interrupted. Without an end timestamp it cannot prove that the
          // client owning this unloaded thread has actually stopped.
          state:
            thread.status.type === 'notLoaded' && turn.status === 'interrupted' && turn.completedAt === null
              ? 'unknown'
              : turn.status === 'inProgress'
                ? 'running'
                : turn.status,
          userText: userTexts.join(''),
          messages,
          ...(turn.startedAt === null ? {} : { createdAt: new Date(turn.startedAt * 1000).toISOString() }),
        });
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Codex history pagination returned a repeated cursor');
      if (cursor) seen.add(cursor);
    } while (cursor && turns.length < limit && remaining > 0);
    return {
      ...this.nativeSummary(thread),
      turns: turns.reverse(),
      hasOlderTurns: cursor !== null,
      truncated: truncated || cursor !== null,
    };
  }
  async releaseSession(id: string): Promise<void> {
    if (this.active.has(id))
      throw new AppError('SESSION_BUSY', 'Wait for the native turn to finish before releasing it', 409);
    if (!this.sessions.has(id)) return;
    await this.rpc.request('thread/unsubscribe', { threadId: id }, 'v2/ThreadUnsubscribeResponse');
    this.sessions.delete(id);
    this.expectedPolicies.delete(id);
    // Callers closing the adapter after a turn also release app-server's delayed unload lease.
  }
  /** Internal discovery only; the Agent decides which native IDs it owns and may expose. */
  async listSessions(cursor?: string, scope: 'workspace' | 'all' = 'workspace'): Promise<ThreadListResponse> {
    await this.connect();
    return this.rpc.request(
      'thread/list',
      {
        ...(scope === 'workspace' ? { cwd: this.options.cwd } : {}),
        modelProviders: ['openai'],
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
        sortKey: 'updated_at',
        limit: 50,
        cursor,
      },
      'v2/ThreadListResponse',
    );
  }
  async answerInteraction(input: InteractionAnswer): Promise<void> {
    if (input.generation !== this.generation)
      throw new AppError(
        'APPROVAL_EXPIRED',
        'This request belongs to an expired Codex process generation',
        409,
      );
    const key = requestKey(input.requestId);
    if (this.resolved.has(key)) return;
    const request = this.interactions.get(key);
    if (!request) throw new AppError('APPROVAL_EXPIRED', 'This approval is no longer pending', 409);
    let result: unknown;
    let schema: string;
    if (request.method === 'item/tool/requestUserInput') {
      if (input.decision === 'cancel') {
        this.rpc.send({ id: request.id, error: { code: -32000, message: 'User cancelled input' } });
        this.interactions.delete(key);
        this.resolved.add(key);
        await this.interruptRun({ sessionId: request.params.threadId, turnId: request.params.turnId });
        return;
      }
      const questions = request.params.questions;
      if (
        !input.answers ||
        questions.some((question) => !input.answers?.[question.id]?.length) ||
        Object.keys(input.answers).some((id) => !questions.some((question) => question.id === id))
      )
        throw new AppError('ANSWERS_REQUIRED', 'Supply answers to each requested question', 400);
      result = {
        answers: Object.fromEntries(Object.entries(input.answers).map(([id, answers]) => [id, { answers }])),
      };
      schema = 'ToolRequestUserInputResponse';
    } else if (request.method === 'item/permissions/requestApproval') {
      if (!input.decision) throw new AppError('DECISION_REQUIRED', 'Choose accept, decline, or cancel', 400);
      result = {
        permissions:
          input.decision === 'accept'
            ? Object.fromEntries(
                Object.entries(request.params.permissions).filter(([, value]) => value !== null),
              )
            : {},
        scope: 'turn',
      };
      schema = 'PermissionsRequestApprovalResponse';
    } else {
      if (!input.decision) throw new AppError('DECISION_REQUIRED', 'Choose accept, decline, or cancel', 400);
      result = { decision: input.decision };
      schema =
        request.method === 'item/fileChange/requestApproval'
          ? 'FileChangeRequestApprovalResponse'
          : 'CommandExecutionRequestApprovalResponse';
    }
    validateSchema(schema, result);
    this.rpc.send({ id: request.id, result });
    this.interactions.delete(key);
    this.resolved.add(key);
    const params = request.params as { threadId: string; turnId: string };
    this.emit('interaction.resolved', { requestId: input.requestId }, params.threadId, params.turnId);
    if (request.method === 'item/permissions/requestApproval' && input.decision === 'cancel')
      await this.interruptRun({ sessionId: params.threadId, turnId: params.turnId });
  }
  private rejectThreadPolicy(threadId: string, error: Error): void {
    const pending = this.pendingTurnPolicies.get(threadId);
    // Keep failure sticky across later safe notifications in the same batch.
    if (pending) {
      pending.error = error;
      pending.settings = undefined;
    }
    const turnId = this.active.get(threadId);
    void this.rpc.close(new AppError('uncertain_operation', error.message, 409)).then(() => {
      this.emit('run.failed', { state: 'uncertain', error: error.message }, threadId, turnId);
      this.emit('provider.warning', { message: error.message, interrupted: true }, threadId);
    });
  }
  private receive(message: Record<string, unknown>): void {
    if ('id' in message) {
      const id = message.id;
      if (typeof id !== 'number' && typeof id !== 'string') return;
      if (message.method === 'account/chatgptAuthTokens/refresh' && this.options.authBroker) {
        void (async () => {
          try {
            validateSchema<ServerRequest>('ServerRequest', message);
            const params = message.params as { previousAccountId?: string | null };
            if (
              !this.authAccountId ||
              (params.previousAccountId && params.previousAccountId !== this.authAccountId)
            )
              throw new Error('Account mismatch');
            const result = await this.options.authBroker!.tokens(true, this.authAccountId);
            this.rpc.send({ id, result });
          } catch {
            try {
              this.rpc.send({
                id,
                error: { code: -32000, message: 'Selected account authorization requires login' },
              });
            } catch {}
          }
        })();
        return;
      }
      try {
        if (!interactionMethods.has(String(message.method)))
          throw new Error('Unsupported server request; no permission granted');
        validateSchema<ServerRequest>('ServerRequest', message);
        const request = message as ServerRequest;
        if (
          request.method === 'item/tool/requestUserInput' &&
          request.params.questions.some((question) => question.isSecret)
        )
          throw new Error('Secret user input is unsupported; use the official local tool');
        const params = request.params as { threadId: string; turnId: string; itemId: string };
        if (!this.sessions.has(params.threadId))
          throw new Error('Approval does not belong to an owned active session');
        this.interactions.set(requestKey(id), request);
        const kind = message.method === 'item/tool/requestUserInput' ? 'input' : 'approval';
        this.emit(
          'interaction.required',
          {
            ...(display(request.params) as Record<string, unknown>),
            requestId: id,
            kind,
            method: message.method,
            item: display(this.items.get(params.itemId)),
            allowedDecisions: kind === 'approval' ? ['accept', 'decline', 'cancel'] : ['cancel'],
          },
          params.threadId,
          params.turnId,
        );
      } catch (error) {
        this.rpc.send({
          id,
          error: { code: -32601, message: 'Unsupported or invalid request; refused by Remote Workbench' },
        });
        this.emit('provider.warning', { message: (error as Error).message, method: message.method });
      }
      return;
    }
    const method = String(message.method);
    const schema = notificationSchemas[method];
    if (!schema) return;
    try {
      validateSchema(`v2/${schema}`, message.params);
    } catch (error) {
      if (method === 'thread/settings/updated') {
        const threadId = (message.params as { threadId?: unknown } | undefined)?.threadId;
        if (typeof threadId === 'string' && this.sessions.has(threadId))
          this.rejectThreadPolicy(threadId, new Error('Codex reported invalid effective thread settings'));
      }
      this.emit('provider.warning', { message: (error as Error).message, method });
      return;
    }
    const event = message as ServerNotification;
    switch (event.method) {
      case 'thread/settings/updated': {
        const settings = event.params.threadSettings;
        const expected = this.expectedPolicies.get(event.params.threadId);
        const pendingPolicy = this.pendingTurnPolicies.get(event.params.threadId);
        const policy = settings.sandboxPolicy;
        const safe =
          settings.modelProvider === 'openai' &&
          settings.cwd === this.options.cwd &&
          settings.approvalPolicy === (expected === 'full-access' ? 'never' : 'on-request') &&
          settings.approvalsReviewer === 'user' &&
          (expected === 'full-access'
            ? policy.type === 'dangerFullAccess'
            : expected === 'workspace-write'
              ? policy.type === 'workspaceWrite' &&
                !policy.networkAccess &&
                policy.excludeSlashTmp &&
                policy.excludeTmpdirEnvVar &&
                policy.writableRoots.every((root) => root === this.options.cwd)
              : policy.type === 'readOnly' && !policy.networkAccess);
        if (!safe) {
          const error = `Unsafe effective turn policy: ${JSON.stringify(policy)}`;
          this.rejectThreadPolicy(event.params.threadId, new AppError('UNSAFE_EFFECTIVE_POLICY', error, 409));
        } else {
          if (pendingPolicy && !pendingPolicy.error) pendingPolicy.settings = settings;
          this.emit(
            'run.settings',
            {
              model: settings.model,
              reasoningEffort: settings.effort,
              permissionMode: expected ?? 'read-only',
              sandbox: policy,
            },
            event.params.threadId,
          );
        }
        break;
      }
      case 'turn/started':
        this.active.set(event.params.threadId, event.params.turn.id);
        this.emit('run.started', { state: 'running' }, event.params.threadId, event.params.turn.id);
        break;
      case 'turn/completed': {
        const { threadId, turn } = event.params;
        this.active.delete(threadId);
        this.terminalTurns.add(turn.id);
        if (this.terminalTurns.size > 1000)
          this.terminalTurns.delete(this.terminalTurns.values().next().value!);
        for (const [key, request] of this.interactions)
          if ('turnId' in request.params && request.params.turnId === turn.id) this.interactions.delete(key);
        const state =
          turn.status === 'failed'
            ? 'failed'
            : turn.status === 'interrupted'
              ? this.cancelled.has(turn.id)
                ? 'cancelled'
                : 'interrupted'
              : 'completed';
        this.cancelled.delete(turn.id);
        this.emit('run.completed', { state, error: turn.error?.message ?? null }, threadId, turn.id);
        break;
      }
      case 'item/agentMessage/delta':
        this.emit(
          'message.delta',
          { itemId: event.params.itemId, delta: event.params.delta },
          event.params.threadId,
          event.params.turnId,
        );
        break;
      case 'item/started':
      case 'item/completed': {
        const { threadId, turnId, item } = event.params;
        if (
          event.method === 'item/started' &&
          (item.type === 'commandExecution' || item.type === 'fileChange')
        )
          this.items.set(item.id, item);
        if (event.method === 'item/completed') this.items.delete(item.id);
        if (item.type === 'agentMessage') {
          if (event.method === 'item/completed' || item.questions?.length)
            this.emit(
              'message.completed',
              {
                itemId: item.id,
                text: item.text,
                questions: display(item.questions),
                delivery: item.delivery,
              },
              threadId,
              turnId,
            );
        } else if (item.type !== 'userMessage' && item.type !== 'reasoning')
          this.emit(
            event.method === 'item/started' ? 'tool.started' : 'tool.completed',
            { ...item, itemId: item.id },
            threadId,
            turnId,
          );
        if (item.type === 'fileChange' && event.method === 'item/completed')
          this.emit(
            'files.changed',
            { itemId: item.id, changes: item.changes, status: item.status },
            threadId,
            turnId,
          );
        break;
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        this.emit(
          'tool.output',
          { itemId: event.params.itemId, delta: event.params.delta },
          event.params.threadId,
          event.params.turnId,
        );
        break;
      case 'turn/diff/updated':
        this.emit('files.changed', { diff: event.params.diff }, event.params.threadId, event.params.turnId);
        break;
      case 'serverRequest/resolved': {
        const key = requestKey(event.params.requestId);
        this.interactions.delete(key);
        this.resolved.add(key);
        this.emit('interaction.resolved', { requestId: event.params.requestId }, event.params.threadId);
        break;
      }
      case 'account/updated':
        this.quota = null;
        this.buckets = {};
        this.emit('account.updated', { ...event.params });
        break;
      case 'account/login/completed':
        this.login = undefined;
        this.emit('account.updated', {
          loginCompleted: true,
          success: event.params.success,
          error: event.params.error,
        });
        break;
      case 'account/rateLimits/updated':
        this.buckets[event.params.rateLimits.limitId ?? 'codex'] = event.params.rateLimits;
        this.quota = normalizeQuota(this.buckets);
        this.emit('quota.updated', { ...this.quota });
        break;
      case 'thread/tokenUsage/updated':
        this.emit(
          'context.updated',
          { tokenUsage: event.params.tokenUsage },
          event.params.threadId,
          event.params.turnId,
        );
        break;
      case 'model/rerouted':
        this.emit(
          'provider.warning',
          { ...event.params, message: 'Codex changed the effective model' },
          event.params.threadId,
          event.params.turnId,
        );
        break;
      case 'error':
        this.emit(
          'provider.warning',
          { message: redactError(event.params.error.message), willRetry: event.params.willRetry },
          event.params.threadId,
          event.params.turnId,
        );
        break;
    }
  }
  async close(): Promise<void> {
    this.unsubscribeAuth?.();
    await this.rpc.close();
    this.interactions.clear();
    this.active.clear();
  }
}
