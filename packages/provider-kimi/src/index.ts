import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { AppError } from '../../contracts/src/index.ts';
import { readKimiQuota, unavailableQuota } from './quota.ts';
import type {
  AIProviderAdapter,
  AccountState,
  CreateSessionInput,
  InteractionAnswer,
  ModelInfo,
  ProviderEvent,
  ProviderRunRef,
  ProviderSessionRef,
  StartRunInput,
} from '../../provider-core/src/index.ts';

class KimiRpcError extends AppError {}

const require = createRequire(import.meta.url);
export const KIMI_VERSION = '2.0.2';
type Json = Record<string, any>;
type Pending = {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

/** Official Kimi Code CLI, isolated by account. Relay never reads OAuth credentials. */
export class KimiAdapter implements AIProviderAdapter {
  readonly id = 'kimi';
  readonly generation = randomUUID();
  readonly disposeAfterRun = true;
  private process?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private closed = false;
  private failed = false;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(event: ProviderEvent) => void>();
  private permissions = new Map<string | number, Json>();
  private current?: ProviderRunRef;
  private messageId = randomUUID();
  private models?: ModelInfo[];
  private loginRevision = 0;
  private loginProcess?: ChildProcessWithoutNullStreams;
  private login?: Promise<{ verificationUrl: string; userCode: string; loginId: string }>;
  private cancelLoginWait?: () => void;
  private quotaRequest?: Promise<import('../../provider-core/src/index.ts').QuotaState>;
  private quotaAbort?: AbortController;
  constructor(private options: { cwd: string; home: string; executable?: string; taskUmask?: string }) {}

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
  private emit(type: string, payload: Json = {}, ref = this.current) {
    for (const handler of this.listeners) handler({ type, generation: this.generation, ...ref, payload });
  }
  private launch(args: string[]) {
    const env = { ...process.env };
    // A host's temporary model/key/endpoint overrides must not cross account boundaries.
    for (const key of Object.keys(env))
      if (/^(KIMI_|MOONSHOT_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
    env.KIMI_CODE_HOME = this.options.home;
    env.KIMI_DISABLE_TELEMETRY = '1';
    env.BROWSER = '/bin/true';
    const executable = this.options.executable ?? process.execPath;
    const cli = this.options.executable
      ? []
      : [join(dirname(require.resolve('@moonshot-ai/kimi-code/package.json')), 'dist/main.mjs')];
    // Apply the configured umask to the child only, just as for Codex execution.
    return spawn(
      '/bin/sh',
      [
        '-c',
        'umask "$1"; shift; exec "$@"',
        'relay-kimi',
        this.options.taskUmask ?? '0022',
        executable,
        ...cli,
        ...args,
      ],
      {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      },
    );
  }
  private async stop(child?: ChildProcessWithoutNullStreams) {
    if (!child?.pid) return;
    const pid = child.pid;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        // Terminate descendants too, even when the CLI leader already exited.
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
        resolve();
      };
      const timer = setTimeout(finish, 1500);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      child.once('exit', finish);
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        finish();
      }
    });
  }
  private async ready() {
    if (this.closed || this.failed) throw new AppError('agent_unavailable', 'Kimi 进程已关闭', 503);
    return (this.starting ??= (async () => {
      await mkdir(this.options.home, { recursive: true, mode: 0o700 });
      if (this.closed) throw new Error('Kimi 进程已关闭');
      const child = (this.process = this.launch(['acp']));
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 16 * 1024 * 1024) {
          this.fail();
          this.stop(child);
          return;
        }
        let offset: number;
        while ((offset = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, offset);
          buffer = buffer.slice(offset + 1);
          if (!line.trim()) continue;
          try {
            this.receive(JSON.parse(line));
          } catch {
            this.fail();
            this.stop(child);
            return;
          }
        }
      });
      // CLI diagnostics may contain prompts or credentials. Never relay raw stderr.
      child.stderr.resume();
      child.stdin.on('error', () => this.fail());
      child.on('error', () => this.fail());
      child.on('exit', () => this.fail());
      const result = await this.rpc('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'relay', version: '0.1.0' },
        clientCapabilities: {},
      });
      if (result.protocolVersion !== 1 || !result.agentCapabilities?.loadSession)
        throw new AppError('unsupported_feature', 'Kimi ACP 协议不兼容，请使用 Kimi Code CLI 2.0.2', 409);
    })());
  }
  private fail() {
    if (this.failed) return;
    this.failed = true;
    const error = new AppError('agent_unavailable', 'Kimi 进程连接已断开，请检查 CLI 安装后重试', 503);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closed) {
      if (this.current)
        this.emit('run.failed', { state: 'uncertain', error: 'Kimi 进程退出，任务结果待核实' });
      this.emit('provider.warning', { message: error.message, interrupted: true });
    }
  }
  private send(value: Json) {
    this.process?.stdin.write(JSON.stringify(value) + '\n');
  }
  private rpc(method: string, params: Json, timeout = 60_000): Promise<any> {
    if (this.closed || this.failed)
      return Promise.reject(new AppError('agent_unavailable', 'Kimi 进程已关闭', 503));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new AppError('agent_unavailable', 'Kimi 请求超时：' + method, 504));
          }, timeout)
        : undefined;
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  private receive(message: Json) {
    if (message.method) {
      if (message.method === 'session/update') {
        if (message.params?.sessionId !== this.current?.sessionId) return;
        const u = message.params.update;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text')
          this.emit('message.delta', { itemId: this.messageId, delta: u.content.text });
        if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
          this.messageId = randomUUID();
          const text = (u.content ?? [])
            .map((c: Json) => c.content?.text ?? c.text ?? '')
            .filter(Boolean)
            .join('\n');
          this.emit(u.status === 'completed' || u.status === 'failed' ? 'tool.completed' : 'tool.started', {
            itemId: u.toolCallId,
            title: u.title,
            name: u.title,
            status: u.status,
            ...(text ? { text } : {}),
            ...(u.rawInput ? { arguments: u.rawInput } : {}),
          });
        }
      } else if (message.method === 'session/request_permission' && message.id !== undefined) {
        if (!this.current || message.params?.sessionId !== this.current.sessionId) {
          this.send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
          return;
        }
        const p = message.params;
        this.permissions.set(message.id, p);
        const question = p.options?.some((o: Json) => /^q\d+_opt_/.test(o.optionId));
        this.emit('interaction.required', {
          requestId: message.id,
          kind: question ? 'input' : 'approval',
          reason: p.toolCall?.title ?? 'Kimi 请求执行工具',
          ...(question
            ? {
                choiceOnly: true,
                questions: [
                  {
                    id: 'choice',
                    question: p.toolCall?.title ?? '请选择',
                    options: p.options
                      .filter((o: Json) => o.kind === 'allow_once')
                      .map((o: Json) => ({ label: o.name })),
                  },
                ],
              }
            : { command: JSON.stringify(p.toolCall?.rawInput ?? p.toolCall?.content ?? {}) }),
          cwd: this.options.cwd,
        });
      } else if (message.id !== undefined) {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not supported' },
        });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(
        new KimiRpcError(
          message.error.code === -32000 ? 'auth_required' : 'provider_error',
          message.error.code === -32000
            ? pending.method === 'authenticate'
              ? '请先登录此 Kimi Code 账号'
              : 'Kimi 拒绝了本次请求：请检查登录状态及 Kimi Code 权益、额度；网页账号已登录不代表此模型可用。'
            : 'Kimi 请求失败，请检查账号权益、模型或重新登录',
          message.error.code === -32000 ? 401 : 502,
        ),
      );
    else pending.resolve(message.result);
  }
  async getAccount(): Promise<AccountState> {
    await this.ready();
    let authenticated = false;
    try {
      await this.rpc('authenticate', { methodId: 'login' });
      authenticated = true;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'auth_required') throw error;
    }
    return {
      authenticated,
      authMode: authenticated ? 'kimi-code' : null,
      identifier: null,
      planType: null,
      requiresOpenaiAuth: false,
    };
  }
  async listModels(): Promise<ModelInfo[]> {
    if (this.models) return this.models;
    if (!(await this.getAccount()).authenticated) return [];
    const session = await this.rpc('session/new', { cwd: this.options.cwd, mcpServers: [] });
    try {
      const picker = session.configOptions?.find((o: Json) => o.id === 'model');
      const rows: ModelInfo[] = [];
      for (const m of picker?.options ?? []) {
        if (typeof m.value !== 'string') continue;
        const result = await this.rpc('session/set_config_option', {
          sessionId: session.sessionId,
          configId: 'model',
          value: m.value,
        });
        const thinking = result.configOptions?.find((o: Json) => o.id === 'thinking');
        rows.push({
          id: m.value,
          displayName: m.name ?? m.value,
          description: m.description ?? '',
          isDefault: m.value === picker.currentValue,
          supportsImages: true,
          reasoningEfforts: (thinking?.options ?? []).map((o: Json) => o.value),
          defaultReasoningEffort: thinking?.currentValue ?? null,
        });
      }
      return (this.models = rows);
    } finally {
      await this.rpc('session/delete', { sessionId: session.sessionId });
    }
  }
  async getQuota() {
    if (this.closed) return unavailableQuota('Kimi 连接已关闭，请刷新后重试。');
    return (this.quotaRequest ??= this.queryQuota().finally(() => {
      this.quotaRequest = undefined;
    }));
  }
  private async queryQuota() {
    const controller = (this.quotaAbort = new AbortController());
    const timer = setTimeout(() => controller.abort(), 20_000);
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      await mkdir(this.options.home, { recursive: true, mode: 0o700 });
      if (this.closed || controller.signal.aborted) throw new Error('Closed');
      child = this.launch(['web', '--host', '127.0.0.1', '--port', '0', '--no-open', '--log-level', 'error']);
      return await readKimiQuota(child, controller.signal);
    } catch {
      return unavailableQuota('Kimi 额度暂时查询失败，请稍后刷新；也可在 Kimi Code 控制台查看。');
    } finally {
      clearTimeout(timer);
      await this.stop(child);
      if (this.quotaAbort === controller) this.quotaAbort = undefined;
    }
  }
  private async configure(sessionId: string, input: CreateSessionInput) {
    await this.rpc('session/set_mode', {
      sessionId,
      modeId:
        input.permissionMode === 'read-only'
          ? 'plan'
          : input.permissionMode === 'full-access'
            ? 'yolo'
            : 'default',
    });
    await this.rpc('session/set_config_option', { sessionId, configId: 'model', value: input.model });
  }
  async createSession(input: CreateSessionInput) {
    await this.ready();
    const session = await this.rpc('session/new', { cwd: input.cwd, mcpServers: [] });
    await this.configure(session.sessionId, input);
    return { id: session.sessionId, model: input.model };
  }
  async resumeSession(ref: ProviderSessionRef, input: CreateSessionInput) {
    await this.ready();
    await this.rpc('session/load', { sessionId: ref.id, cwd: input.cwd, mcpServers: [] });
    await this.configure(ref.id, input);
    return ref;
  }
  async startRun(input: StartRunInput): Promise<ProviderRunRef> {
    await this.ready();
    if (this.current) throw new AppError('run_conflict', 'Kimi 已有活动任务', 409);
    if (input.reasoningEffort)
      await this.rpc('session/set_config_option', {
        sessionId: input.sessionId,
        configId: 'thinking',
        value: input.reasoningEffort,
      }).catch((error: Error) => {
        Object.assign(error, { executionNotStarted: true });
        throw error;
      });
    const prompt: Json[] = [{ type: 'text', text: input.text }];
    for (const image of input.images ?? []) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image.url);
      if (!match) throw new AppError('invalid_request', 'Kimi 图片格式无效', 400);
      prompt.push({ type: 'image', mimeType: match[1], data: match[2] });
    }
    const ref = (this.current = { sessionId: input.sessionId, turnId: randomUUID() });
    this.messageId = randomUUID();
    this.emit('run.started');
    void this.rpc('session/prompt', { sessionId: input.sessionId, prompt }, 0)
      .then(
        (result) =>
          this.emit(
            'run.completed',
            { state: result.stopReason === 'cancelled' ? 'cancelled' : 'completed' },
            ref,
          ),
        (error: Error) =>
          this.emit(
            'run.failed',
            { state: error instanceof KimiRpcError ? 'failed' : 'uncertain', error: error.message },
            ref,
          ),
      )
      .finally(() => {
        this.current = undefined;
        this.permissions.clear();
      });
    return ref;
  }
  async interruptRun(ref: ProviderRunRef) {
    if (this.current?.turnId !== ref.turnId) return;
    for (const id of this.permissions.keys())
      this.send({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
    this.permissions.clear();
    this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: ref.sessionId } });
  }
  async answerInteraction(input: InteractionAnswer) {
    const p = this.permissions.get(input.requestId);
    if (input.generation !== this.generation || !p)
      throw new AppError('stale_interaction', '此 Kimi 请求已失效', 409);
    const option = input.answers
      ? p.options.find((o: Json) => o.kind === 'allow_once' && o.name === input.answers?.choice?.[0])
      : p.options.find((o: Json) => o.kind === (input.decision === 'accept' ? 'allow_once' : 'reject_once'));
    if (input.answers && !option) throw new AppError('invalid_request', '请选择 Kimi 提供的选项', 400);
    this.send({
      jsonrpc: '2.0',
      id: input.requestId,
      result: {
        outcome:
          input.decision === 'cancel' || !option
            ? { outcome: 'cancelled' }
            : { outcome: 'selected', optionId: option.optionId },
      },
    });
    this.permissions.delete(input.requestId);
    this.emit('interaction.resolved', { requestId: input.requestId });
  }
  async releaseSession(id: string) {
    if (this.process && !this.closed) await this.rpc('session/close', { sessionId: id });
  }
  async beginLogin() {
    if (this.closed) throw new Error('Kimi 进程已关闭');
    if (this.login) return this.login;
    const revision = this.loginRevision;
    await mkdir(this.options.home, { recursive: true, mode: 0o700 });
    if (this.closed || revision !== this.loginRevision)
      throw new AppError('auth_required', 'Kimi 登录已取消', 401);
    // Recheck after the filesystem await: concurrent login requests share one flow.
    if (this.login) return this.login;
    const child = (this.loginProcess = this.launch(['login', '--region', 'mainland-cn']));
    this.login = new Promise((resolve, reject) => {
      let output = '',
        settled = false,
        finished = false;
      const timer = setTimeout(() => {
        finish(false);
        this.stop(child);
      }, 30_000);
      const expiry = setTimeout(() => {
        finish(false);
        this.stop(child);
      }, 15 * 60_000);
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(expiry);
        if (!settled) {
          settled = true;
          reject(new AppError('auth_required', 'Kimi 登录未完成，请重新发起登录', 401));
        }
        this.login = undefined;
        this.loginProcess = undefined;
        this.cancelLoginWait = undefined;
        this.models = undefined;
        this.emit('account.updated', { loginCompleted: true, success });
      };
      this.cancelLoginWait = () => finish(false);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        output = (output + chunk).slice(-16_384);
        const url = /Opening browser for Kimi device login: (https:\/\/[^\s]+)/.exec(output)?.[1];
        const code = /enter code: ([A-Za-z0-9-]+)/.exec(output)?.[1];
        if (!settled && url && code) {
          const parsed = new URL(url);
          if (
            parsed.hostname !== 'auth.kimi.com' &&
            parsed.hostname !== 'www.kimi.com' &&
            parsed.hostname !== 'kimi.com'
          ) {
            finish(false);
            this.stop(child);
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({ verificationUrl: url, userCode: code, loginId: randomUUID() });
        }
      });
      child.stdout.resume();
      child.stdin.on('error', () => finish(false));
      child.on('error', () => finish(false));
      child.on('exit', (code) => finish(code === 0));
    });
    return this.login;
  }
  async cancelLogin() {
    this.loginRevision++;
    const child = this.loginProcess;
    const finish = this.cancelLoginWait;
    await this.stop(child);
    finish?.();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.quotaAbort?.abort();
    await this.quotaRequest;
    await this.cancelLogin();
    this.fail();
    await this.stop(this.process);
    this.listeners.clear();
  }
}
