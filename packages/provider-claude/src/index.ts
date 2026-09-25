import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { AppError } from '../../contracts/src/index.ts';
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

export const CLAUDE_VERSION = '2.1.280';
const require = createRequire(import.meta.url);
type Json = Record<string, any>;
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Drives the official Claude Code CLI. OAuth storage and renewal belong to the CLI. */
export class ClaudeAdapter implements AIProviderAdapter {
  readonly id = 'claude';
  readonly generation = randomUUID();
  readonly disposeAfterRun = true;
  private closed = false;
  private failed = false;
  private child?: ChildProcessWithoutNullStreams;
  private children = new Set<ChildProcessWithoutNullStreams>();
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: ProviderEvent) => void>();
  private permissions = new Map<string, Json>();
  private current?: ProviderRunRef;
  private session?: { id: string; resume: boolean };
  private initializing?: Promise<Json>;
  private models?: ModelInfo[];
  private probe?: ClaudeAdapter;
  private account?: Promise<AccountState>;
  private messageId = randomUUID();
  private streamed = new Set<string>();
  private cancelled = false;
  private login?: Promise<{
    verificationUrl: string;
    userCode: string;
    loginId: string;
    codeRequired: boolean;
  }>;
  private loginChild?: ChildProcessWithoutNullStreams;
  private loginId?: string;
  private loginSubmitted = false;
  private loginRevision = 0;
  private finishLogin?: (success: boolean) => void;
  constructor(private options: { cwd: string; home: string; executable?: string; taskUmask?: string }) {}

  capabilities() {
    return {
      sessions: true,
      resume: true,
      models: true,
      reasoning: true,
      quota: false,
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
  private async prepare() {
    await mkdir(join(this.options.home, '.claude'), { recursive: true, mode: 0o700 });
    if (this.closed) throw new AppError('agent_unavailable', 'Claude 进程已关闭', 503);
  }
  private launch(args: string[], cwd = this.options.cwd) {
    if (this.closed) throw new AppError('agent_unavailable', 'Claude 进程已关闭', 503);
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|KIMI_|MOONSHOT_|OPENAI_)/.test(key)
      )
        delete env[key];
    env.HOME = this.options.home;
    env.XDG_CONFIG_HOME = join(this.options.home, '.config');
    env.CLAUDE_CONFIG_DIR = join(this.options.home, '.claude');
    env.DISABLE_AUTOUPDATER = '1';
    env.BROWSER = '/bin/true';
    const executable =
      this.options.executable ??
      join(dirname(require.resolve('@anthropic-ai/claude-code/package.json')), 'bin/claude.exe');
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        'umask "$1"; shift; exec "$@"',
        'relay-claude',
        this.options.taskUmask ?? '0022',
        executable,
        ...args,
      ],
      { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.children.add(child);
    // Retain leaders until close: background descendants may outlive the CLI.
    child.stdin.on('error', () => {});
    return child;
  }
  private async stop(child: ChildProcessWithoutNullStreams) {
    if (!child.pid) return;
    const pid = child.pid;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
        resolve();
      };
      const timer = setTimeout(finish, 1000);
      if (child.exitCode !== null || child.signalCode !== null) return finish();
      child.once('exit', finish);
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        finish();
      }
    });
    this.children.delete(child);
  }
  private async status(): Promise<Json> {
    await this.prepare();
    const child = this.launch(['auth', 'status'], this.options.home);
    try {
      return await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => {
          reject(new AppError('agent_unavailable', 'Claude 登录状态查询超时', 504));
          void this.stop(child);
        }, 20_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          output += chunk;
          if (output.length > 1024 * 1024) {
            reject(new Error('Claude 状态响应过大'));
            void this.stop(child);
          }
        });
        child.stderr.resume();
        child.once('error', () => {
          clearTimeout(timer);
          reject(new AppError('agent_unavailable', '无法启动 Claude CLI', 503));
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          try {
            const data = JSON.parse(output);
            if (![0, 1].includes(code ?? -1) || typeof data.loggedIn !== 'boolean') throw new Error();
            resolve(data);
          } catch {
            reject(new AppError('agent_unavailable', 'Claude 登录状态查询失败', 503));
          }
        });
      });
    } finally {
      await this.stop(child);
    }
  }
  getAccount(): Promise<AccountState> {
    return (this.account ??= this.status().then((s) => {
      const authenticated =
        s.loggedIn === true && s.authMethod === 'claude.ai' && s.apiProvider === 'firstParty';
      return {
        authenticated,
        authMode: authenticated ? 'claude-code' : null,
        identifier: authenticated ? (s.email ?? null) : null,
        planType: authenticated ? (s.subscriptionType ?? null) : null,
        requiresOpenaiAuth: false,
      };
    }));
  }
  private send(message: Json) {
    this.child?.stdin.write(JSON.stringify(message) + '\n');
  }
  private request(request: Json): Promise<Json> {
    if (this.closed || this.failed)
      return Promise.reject(new AppError('agent_unavailable', 'Claude 进程已关闭', 503));
    return new Promise((resolve, reject) => {
      const request_id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new AppError('agent_unavailable', 'Claude 控制请求超时', 504));
        void this.stop(this.child!);
      }, 60_000);
      this.pending.set(request_id, { resolve, reject, timer });
      this.send({ type: 'control_request', request_id, request });
    });
  }
  private fail() {
    if (this.failed) return;
    this.failed = true;
    const error = new AppError('agent_unavailable', 'Claude 进程连接已断开，请重试', 503);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (!this.closed && this.current) this.finish('uncertain', 'Claude 进程退出，任务结果待核实');
  }
  private ready(input?: StartRunInput): Promise<Json> {
    return (this.initializing ??= (async () => {
      await this.prepare();
      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-prompt-tool',
        'stdio',
        '--setting-sources',
        '',
        '--strict-mcp-config',
      ];
      if (input) {
        args.push(
          this.session?.resume ? '--resume' : '--session-id',
          input.sessionId,
          '--model',
          input.model,
          '--permission-mode',
          input.permissionMode === 'read-only'
            ? 'plan'
            : input.permissionMode === 'full-access'
              ? 'bypassPermissions'
              : 'default',
        );
        if (input.permissionMode === 'full-access') args.push('--allow-dangerously-skip-permissions');
        if (input.reasoningEffort) args.push('--effort', input.reasoningEffort);
      }
      const child = (this.child = this.launch(args));
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 16 * 1024 * 1024) {
          this.fail();
          void this.stop(child);
          return;
        }
        for (let offset; (offset = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, offset);
          buffer = buffer.slice(offset + 1);
          if (!line.trim()) continue;
          try {
            this.receive(JSON.parse(line));
          } catch {
            this.fail();
            void this.stop(child);
            return;
          }
        }
      });
      child.stderr.resume();
      child.stdin.on('error', () => this.fail());
      child.on('error', () => this.fail());
      child.on('exit', () => this.fail());
      return this.request({ subtype: 'initialize' });
    })());
  }
  async listModels(): Promise<ModelInfo[]> {
    if (this.models) return this.models;
    if (!(await this.getAccount()).authenticated) return [];
    const probe = (this.probe = new ClaudeAdapter(this.options));
    try {
      const result = await probe.ready();
      return (this.models = (result.models ?? []).map((m: Json) => ({
        id: m.value,
        displayName: m.displayName ?? m.value,
        description: m.description ?? '',
        isDefault: m.value === 'default',
        supportsImages: true,
        reasoningEfforts: m.supportedEffortLevels ?? [],
        defaultReasoningEffort: null,
      })));
    } finally {
      await probe.close();
      if (this.probe === probe) this.probe = undefined;
    }
  }
  async getQuota() {
    return null;
  }
  async createSession(input: CreateSessionInput): Promise<ProviderSessionRef> {
    this.session = { id: randomUUID(), resume: false };
    return { id: this.session.id, model: input.model };
  }
  async resumeSession(ref: ProviderSessionRef): Promise<ProviderSessionRef> {
    if (!/^[a-f0-9-]{36}$/i.test(ref.id)) throw new AppError('invalid_request', 'Claude 会话标识无效', 400);
    this.session = { id: ref.id, resume: true };
    return ref;
  }
  async startRun(input: StartRunInput): Promise<ProviderRunRef> {
    if (this.current) throw new AppError('run_conflict', 'Claude 已有活动任务', 409);
    if (this.session?.id !== input.sessionId)
      throw new AppError('invalid_request', 'Claude 会话尚未打开', 400);
    const content: Json[] = [{ type: 'text', text: input.text }];
    for (const image of input.images ?? []) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image.url);
      if (!match) throw new AppError('invalid_request', 'Claude 图片格式无效', 400);
      content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
    }
    try {
      await this.ready(input);
    } catch (e) {
      Object.assign(e as Error, { executionNotStarted: true });
      throw e;
    }
    const ref = (this.current = { sessionId: input.sessionId, turnId: randomUUID() });
    this.cancelled = false;
    this.streamed.clear();
    this.messageId = randomUUID();
    this.emit('run.started');
    this.send({
      type: 'user',
      session_id: input.sessionId,
      uuid: ref.turnId,
      parent_tool_use_id: null,
      message: { role: 'user', content },
    });
    return ref;
  }
  private finish(state: string, error?: string) {
    if (!this.current) return;
    const ref = this.current;
    this.current = undefined;
    this.permissions.clear();
    this.emit(error ? 'run.failed' : 'run.completed', { state, ...(error ? { error } : {}) }, ref);
  }
  private receive(m: Json) {
    if (m.type === 'control_response') {
      const p = this.pending.get(m.response?.request_id);
      if (!p) return;
      this.pending.delete(m.response.request_id);
      clearTimeout(p.timer);
      if (m.response.subtype === 'error')
        p.reject(new AppError('provider_error', 'Claude 拒绝控制请求，请检查 CLI 版本和登录状态', 502));
      else p.resolve(m.response.response ?? {});
      return;
    }
    if (m.type === 'control_request') {
      if (m.request?.subtype !== 'can_use_tool' || !this.current) {
        this.send({
          type: 'control_response',
          response: { subtype: 'error', request_id: m.request_id, error: 'Unsupported request' },
        });
        return;
      }
      const r = m.request;
      this.permissions.set(m.request_id, r);
      const question = r.tool_name === 'AskUserQuestion';
      this.emit('interaction.required', {
        requestId: m.request_id,
        kind: question ? 'input' : 'approval',
        reason: question ? 'Claude 需要补充信息' : 'Claude 请求执行 ' + r.tool_name,
        ...(question
          ? {
              questions: (r.input?.questions ?? []).map((q: Json, i: number) => ({
                id: String(i),
                question: q.question,
                options: q.options,
                multiSelect: q.multiSelect,
              })),
            }
          : { command: JSON.stringify(r.input ?? {}) }),
        cwd: this.options.cwd,
      });
      return;
    }
    if (m.type === 'control_cancel_request') {
      if (this.permissions.delete(m.request_id))
        this.emit('interaction.resolved', { requestId: m.request_id });
      return;
    }
    if (!this.current || m.parent_tool_use_id) return;
    if (m.session_id && m.session_id !== this.current.sessionId) return;
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e?.type === 'message_start') this.messageId = e.message?.id ?? randomUUID();
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        this.streamed.add(this.messageId);
        this.emit('message.delta', { itemId: this.messageId, delta: e.delta.text });
      }
    } else if (m.type === 'assistant') {
      const id = m.message?.id ?? this.messageId;
      if (m.error) {
        this.finish('failed', 'Claude 请求失败，请检查订阅登录、可用模型和额度后重试');
        return;
      }
      for (const block of m.message?.content ?? []) {
        if (block.type === 'text' && !this.streamed.has(id))
          this.emit('message.delta', { itemId: id, delta: block.text });
        if (block.type === 'tool_use')
          this.emit('tool.started', {
            itemId: block.id,
            title: block.name,
            name: block.name,
            arguments: block.input,
          });
      }
    } else if (m.type === 'user') {
      for (const block of m.message?.content ?? [])
        if (block.type === 'tool_result') {
          const text =
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? [])
                  .filter((c: Json) => c.type === 'text')
                  .map((c: Json) => c.text)
                  .join('\n');
          this.emit('tool.completed', {
            itemId: block.tool_use_id,
            text,
            status: block.is_error ? 'failed' : 'completed',
          });
        }
    } else if (m.type === 'result') {
      if (this.cancelled) this.finish('cancelled');
      else if (m.is_error || m.subtype !== 'success')
        this.finish('failed', 'Claude 未能完成任务，请检查订阅、额度或任务限制后重试');
      else this.finish('completed');
    }
  }
  async answerInteraction(input: InteractionAnswer) {
    const key = String(input.requestId),
      r = this.permissions.get(key);
    if (!r || input.generation !== this.generation)
      throw new AppError('stale_interaction', '此 Claude 请求已失效', 409);
    const allow = input.decision === 'accept' || !!input.answers;
    const updatedInput = { ...r.input };
    if (input.answers) {
      if (r.tool_name !== 'AskUserQuestion')
        throw new AppError('invalid_request', '此请求不接受文字答案', 400);
      updatedInput.answers = Object.fromEntries(
        (r.input.questions ?? []).map((q: Json, i: number) => [
          q.question,
          (input.answers?.[String(i)] ?? []).join(', '),
        ]),
      );
    }
    this.send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: key,
        response: allow
          ? { behavior: 'allow', updatedInput }
          : {
              behavior: 'deny',
              message: '用户拒绝了本次操作',
              ...(input.decision === 'cancel' ? { interrupt: true } : {}),
            },
      },
    });
    this.permissions.delete(key);
    this.emit('interaction.resolved', { requestId: key });
  }
  async interruptRun(ref: ProviderRunRef) {
    if (this.current?.turnId !== ref.turnId) return;
    this.cancelled = true;
    for (const id of [...this.permissions.keys()])
      await this.answerInteraction({ requestId: id, generation: this.generation, decision: 'cancel' });
    await this.request({ subtype: 'interrupt' });
    // The control acknowledgement cancels the active turn; retain process ownership
    // until manager disposal has also terminated any descendant commands.
    this.finish('cancelled');
  }
  async beginLogin() {
    if (this.login) return this.login;
    const revision = this.loginRevision;
    await this.prepare();
    if (revision !== this.loginRevision) throw new AppError('auth_required', 'Claude 登录已取消', 401);
    if (this.login) return this.login;
    const child = (this.loginChild = this.launch(['auth', 'login', '--claudeai'], this.options.home));
    const loginId = (this.loginId = randomUUID());
    this.loginSubmitted = false;
    this.login = new Promise((resolve, reject) => {
      let output = '',
        settled = false,
        finished = false;
      const timer = setTimeout(() => {
        finish(false);
        void this.stop(child);
      }, 30_000);
      const expiry = setTimeout(() => {
        finish(false);
        void this.stop(child);
      }, 10 * 60_000);
      const finish = (this.finishLogin = (success) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(expiry);
        if (!settled) {
          settled = true;
          reject(new AppError('auth_required', 'Claude 登录未完成，请重新发起登录', 401));
        }
        this.login = undefined;
        this.loginChild = undefined;
        this.loginId = undefined;
        this.finishLogin = undefined;
        this.account = undefined;
        this.models = undefined;
        this.emit('account.updated', { loginCompleted: true, success });
        void this.stop(child);
      });
      const read = (chunk: string) => {
        output = (output + chunk).slice(-32_768);
        const url = /https:\/\/[^\s\x1b]+/.exec(output)?.[0];
        if (settled || !url || !output.includes('Paste code')) return;
        try {
          const parsed = new URL(url);
          if (
            !['claude.com', 'claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(
              parsed.hostname,
            ) ||
            parsed.protocol !== 'https:'
          )
            throw new Error();
          settled = true;
          clearTimeout(timer);
          resolve({ verificationUrl: url, userCode: '', loginId, codeRequired: true });
        } catch {
          finish(false);
          void this.stop(child);
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
    });
    return this.login;
  }
  async completeLogin(code: string, loginId: string) {
    if (!this.loginChild || this.loginId !== loginId || this.loginSubmitted)
      throw new AppError('stale_interaction', 'Claude 登录请求已失效，请重新登录', 409);
    if (!code.trim() || /[\r\n]/.test(code) || code.length > 4096)
      throw new AppError('invalid_request', '授权码格式无效', 400);
    this.loginSubmitted = true;
    this.loginChild.stdin.write(code.trim() + '\n');
  }
  async cancelLogin() {
    this.loginRevision++;
    const child = this.loginChild,
      finish = this.finishLogin;
    if (child) await this.stop(child);
    finish?.(false);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.cancelLogin();
    await this.probe?.close();
    this.fail();
    await Promise.all([...this.children].map((child) => this.stop(child)));
    this.listeners.clear();
  }
}
