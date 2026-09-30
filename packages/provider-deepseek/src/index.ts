import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { AppError } from '../../contracts/src/index.ts';
import type {
  AIProviderAdapter,
  AccountState,
  CreateSessionInput,
  ModelInfo,
  ProviderEvent,
  ProviderRunRef,
  ProviderSessionRef,
  StartRunInput,
  QuotaState,
} from '../../provider-core/src/index.ts';
import { officialRequest, readKey } from './credentials.ts';

export const DEEPSEEK_HARNESS_VERSION = '0.2.0-rc.2';
export const deepseekExecutable = () =>
  join(homedir(), '.local/share/relay/deepseek', DEEPSEEK_HARNESS_VERSION, 'node_modules/.bin/dsh');
type Json = Record<string, any>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function deepseekError(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/AUTH|401|403|MISSING_CREDENTIAL|INVALID_CREDENTIAL/i.test(text))
    return 'DeepSeek API Key 无效或已失效，请在账号管理中重新配置';
  if (/QUOTA|402|balance|insufficient/i.test(text)) return 'DeepSeek API 余额不足，请充值后重试';
  if (/RATE_LIMIT|429/i.test(text)) return 'DeepSeek API 请求过于频繁，请稍后重试';
  if (/max.tokens/i.test(text)) return '本轮达到输出上限，请检查已有结果后继续';
  if (/CONTEXT_WINDOW/i.test(text)) return 'DeepSeek 上下文超限，请新建会话或缩短输入';
  if (/ENOENT/.test(text)) return 'DeepSeek Harness 未安装，请运行 npm run install:deepseek';
  if (/UNKNOWN_MODEL|UNSUPPORTED_REASONING|unknown.model/i.test(text))
    return 'DeepSeek 模型或推理强度不可用，请刷新后选择';
  if (/timeout|超时/i.test(text)) return 'DeepSeek 请求超时，请检查网络及已有任务结果';
  return 'DeepSeek Harness 未完成任务，请检查工具结果、API 余额及网络';
}

/** Official dsh ACP protocol. One owned process per run; durable native sessions survive shutdown. */
export class DeepSeekAdapter implements AIProviderAdapter {
  readonly id = 'deepseek';
  readonly generation = randomUUID();
  readonly disposeAfterRun = true;
  private listeners = new Set<(event: ProviderEvent) => void>();
  private child?: ChildProcessWithoutNullStreams;
  private execution?: Promise<void>;
  private patch?: string;
  private current?: ProviderRunRef;
  private session?: string;
  private closed = false;
  private finishing?: Promise<void>;
  private stopped?: Promise<void>;
  private cancelled = false;
  private modelRequest?: Promise<ModelInfo[]>;
  private pending = new Map<
    string,
    { resolve: (r: Json) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }
  >();
  private nativeId?: string;
  private prompting = false;
  private pendingTools = new Set<string>();
  constructor(private options: { cwd: string; home: string; executable?: string; taskUmask?: string }) {}
  capabilities() {
    return {
      sessions: true,
      resume: true,
      models: true,
      reasoning: true,
      quota: true,
      approvals: false,
      userInput: false,
      cancel: true,
      attachments: false,
    };
  }
  subscribeEvents(handler: (event: ProviderEvent) => void) {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
  private emit(type: string, payload: Json = {}) {
    for (const listener of this.listeners)
      listener({ type, generation: this.generation, ...this.current, payload });
  }
  async getAccount(): Promise<AccountState> {
    const key = await readKey(this.options.home);
    return {
      authenticated: !!key,
      authMode: key ? 'deepseek-api-key' : null,
      identifier: null,
      planType: key ? 'API 按量计费' : null,
      requiresOpenaiAuth: false,
    };
  }
  listModels(): Promise<ModelInfo[]> {
    return (this.modelRequest ??= (async () => {
      const key = await readKey(this.options.home);
      if (!key) return [];
      const result = await officialRequest(key, '/models');
      if (!Array.isArray(result.data)) throw new Error('DeepSeek 模型列表格式无效');
      return result.data
        .filter((m: Json) => typeof m.id === 'string' && m.id.startsWith('deepseek-'))
        .map((m: Json, i: number) => ({
          id: m.id,
          displayName: m.id + '（测试）',
          description: 'DeepSeek 官方 API · 官方 Harness',
          isDefault: i === 0,
          supportsImages: false,
          reasoningEfforts: ['off', 'low', 'high', 'max'],
          defaultReasoningEffort: null,
        }));
    })());
  }
  async getQuota(): Promise<QuotaState | null> {
    const key = await readKey(this.options.home);
    if (!key) return null;
    try {
      const balance = await officialRequest(key, '/user/balance');
      return { windows: [], updatedAt: new Date().toISOString(), stale: false, credits: balance };
    } catch {
      return {
        windows: [],
        updatedAt: new Date().toISOString(),
        stale: true,
        credits: null,
        unavailableReason: '暂时无法读取 DeepSeek API 余额',
      };
    }
  }
  private checkMode(input: CreateSessionInput) {
    if (input.permissionMode !== 'full-access')
      throw new AppError(
        'unsupported_feature',
        'DeepSeek（测试）仅支持完全访问，不能选择只读或审批模式',
        400,
      );
    if (resolve(input.cwd) !== resolve(this.options.cwd)) throw new Error('DeepSeek 项目目录不匹配');
  }
  private sessionFile(id: string) {
    if (!uuid.test(id)) throw new Error('DeepSeek 会话标识无效');
    return join(this.options.home, 'relay-sessions', id + '.json');
  }
  async createSession(input: CreateSessionInput): Promise<ProviderSessionRef> {
    this.checkMode(input);
    const id = randomUUID();
    await mkdir(join(this.options.home, 'relay-sessions'), { recursive: true, mode: 0o700 });
    await writeFile(this.sessionFile(id), JSON.stringify({ cwd: resolve(input.cwd) }), { mode: 0o600 });
    this.session = id;
    return { id };
  }
  async resumeSession(ref: ProviderSessionRef, input: CreateSessionInput) {
    this.checkMode(input);
    const record = JSON.parse(await readFile(this.sessionFile(ref.id), 'utf8'));
    if (record.cwd !== resolve(input.cwd)) throw new Error('DeepSeek 会话不属于当前项目');
    if (record.nativeId !== undefined && !uuid.test(record.nativeId))
      throw new Error('DeepSeek 原生会话标识无效');
    this.nativeId = record.nativeId;
    this.session = ref.id;
    return ref;
  }
  async startRun(input: StartRunInput): Promise<ProviderRunRef> {
    this.checkMode(input);
    if (this.closed || this.current || this.session !== input.sessionId)
      throw new Error('DeepSeek 会话尚未就绪');
    if (input.images?.length) throw new AppError('unsupported_feature', 'DeepSeek 当前接入暂不支持图片');
    const key = await readKey(this.options.home);
    if (!key) throw new AppError('auth_required', '请先配置 DeepSeek API Key', 401);
    const ref = { sessionId: input.sessionId, turnId: randomUUID() };
    this.current = ref;
    this.emit('run.started');
    // Defer protocol notifications until the manager has stored the returned turn identity.
    this.execution = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.execute(input, key))
      .catch((e) => this.finish('failed', deepseekError(e instanceof Error ? e.message : e)));
    return ref;
  }
  private async execute(input: StartRunInput, key: string) {
    if (this.closed || this.cancelled) return this.finish('cancelled');
    const patch = (this.patch = join(this.options.home, 'relay-acp-' + this.generation + '.patch.yml'));
    const temp = patch + '.' + this.generation;
    // Full harness tools and compaction; no unanswerable interactive question/plan tools or extra telemetry.
    await writeFile(
      temp,
      '- id: acp\n  config:\n    provider: deepseek-official\n    model: ' +
        JSON.stringify(input.model) +
        '\n- id: session-log-deepseek\n  disabled: true\n- id: plugin-package-inventory-deepseek\n  disabled: true\n- id: user-questions\n  disabled: true\n- id: plan-mode\n  disabled: true\n',
      { mode: 0o600 },
    );
    await rename(temp, patch);
    if (this.closed || this.cancelled) return this.finish('cancelled');
    const env = { ...process.env };
    for (const name of Object.keys(env))
      if (
        /^(DSH_|DEEPSEEK_|ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|GEMINI_|GOOGLE_)/.test(name) ||
        name === 'NODE_OPTIONS' ||
        name === 'NODE_PATH'
      )
        delete env[name];
    Object.assign(env, {
      DSH_HOME: this.options.home,
      DEEPSEEK_API_KEY: key,
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
      PATH: process.execPath.substring(0, process.execPath.lastIndexOf('/')) + delimiter + (env.PATH ?? ''),
    });
    const executable = this.options.executable ?? deepseekExecutable();
    await access(executable, 1);
    if (this.closed || this.cancelled) return this.finish('cancelled');
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        'umask "$1"; shift; exec "$@"',
        'relay-deepseek',
        this.options.taskUmask ?? '0022',
        executable,
        '--profile',
        'acp',
        '--patch',
        patch,
      ],
      { cwd: input.cwd, env, detached: true, stdio: 'pipe' },
    );
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 32 * 1024 * 1024) {
        void this.finish('failed', 'DeepSeek 输出超过协议限制');
        return;
      }
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          void this.finish('failed', 'DeepSeek Harness 返回了无效协议数据');
        }
      }
    });
    // Diagnostics can contain tool output or secrets; never forward raw stderr to the browser.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      this.rejectPending();
      void this.finish('failed', deepseekError(e.message));
    });
    child.on('close', () => {
      this.rejectPending();
      if (!this.finishing)
        void this.finish(
          this.cancelled ? 'cancelled' : 'failed',
          this.cancelled ? undefined : 'DeepSeek Harness 意外退出，请检查安装与任务结果',
        );
    });
    const initialized = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'relay', version: '0.2.0' },
    });
    if (initialized.agentInfo?.name !== 'deepseek-harness-acp' || initialized.protocolVersion !== 1)
      throw new Error('DeepSeek ACP 握手不匹配');
    if (this.cancelled || this.closed) return;
    const session = await this.request(this.nativeId ? 'session/resume' : 'session/new', {
      cwd: input.cwd,
      mcpServers: [],
      ...(this.nativeId ? { sessionId: this.nativeId } : {}),
    });
    if (!this.nativeId) {
      if (!uuid.test(session.sessionId)) throw new Error('DeepSeek 未返回有效会话');
      this.nativeId = session.sessionId;
      const file = this.sessionFile(input.sessionId),
        temp = file + '.' + this.generation;
      await writeFile(temp, JSON.stringify({ cwd: resolve(input.cwd), nativeId: this.nativeId }), {
        mode: 0o600,
      });
      await rename(temp, file);
    }
    if (this.cancelled || this.closed) return;
    // Values are opaque on ACP: select only a value advertised by this runtime.
    const model = session.configOptions?.find((o: Json) => o.id === 'model');
    const flatten = (options: Json[]): Json[] =>
      options.flatMap((o) => (o.options ? flatten(o.options) : [o]));
    const selected = flatten(model?.options ?? []).find((o) => {
      try {
        const route = JSON.parse(o.value);
        return route[0] === 'deepseek-official' && route[1] === input.model;
      } catch {
        return false;
      }
    });
    if (!selected) throw new Error('UNKNOWN_MODEL');
    const configured = await this.request('session/set_config_option', {
      sessionId: this.nativeId,
      configId: 'model',
      value: selected.value,
    });
    if (input.reasoningEffort) {
      const effort = configured.configOptions?.find((o: Json) => o.id === 'reasoning_effort');
      if (!flatten(effort?.options ?? []).some((o) => o.value === input.reasoningEffort))
        throw new Error('UNSUPPORTED_REASONING');
      await this.request('session/set_config_option', {
        sessionId: this.nativeId,
        configId: 'reasoning_effort',
        value: input.reasoningEffort,
      });
    }
    if (this.cancelled || this.closed) return;
    this.prompting = true;
    const result = await this.request(
      'session/prompt',
      { sessionId: this.nativeId, prompt: [{ type: 'text', text: input.text }] },
      0,
    );
    this.prompting = false;
    if (this.cancelled) return this.finish('cancelled');
    await this.finish(
      result.stopReason === 'end_turn' ? 'completed' : 'failed',
      result.stopReason === 'end_turn' ? undefined : deepseekError(result.stopReason),
    );
  }
  private request(method: string, params?: Json, timeout = 60000): Promise<Json> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error('DeepSeek ACP 请求超时'));
          }, timeout)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n',
      );
    });
  }
  private rejectPending() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('DeepSeek 进程已关闭'));
    }
    this.pending.clear();
  }
  private receive(frame: Json) {
    if (frame.id !== undefined && frame.method) {
      const option = frame.params?.options?.find((o: Json) => o.kind === 'allow_once');
      if (
        frame.method === 'session/request_permission' &&
        frame.params?.sessionId === this.nativeId &&
        option &&
        !this.cancelled
      ) {
        this.child?.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            result: { outcome: { outcome: 'selected', optionId: option.optionId } },
          }) + '\n',
        );
      } else
        this.child?.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32601, message: 'Unsupported request' },
          }) + '\n',
        );
      return;
    }
    if (frame.id !== undefined) {
      const item = this.pending.get(String(frame.id));
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(String(frame.id));
      if (frame.error) item.reject(new Error(JSON.stringify(frame.error)));
      else item.resolve(frame.result ?? {});
      return;
    }
    const p = frame.params;
    if (
      frame.method !== 'session/update' ||
      !this.prompting ||
      p?.sessionId !== this.nativeId ||
      this.finishing
    )
      return;
    const u = p.update;
    if (!u) return;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      this.emit('message.delta', {
        itemId: this.current!.turnId + ':' + (u.messageId ?? 'response'),
        delta: u.content.text,
      });
    } else if (u.sessionUpdate === 'tool_call') {
      this.pendingTools.add(u.toolCallId);
      this.emit('tool.started', {
        itemId: u.toolCallId,
        name: u.title,
        title: u.title,
        arguments: u.rawInput,
      });
    } else if (u.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(u.status)) {
      this.pendingTools.delete(u.toolCallId);
      const text = (u.content ?? [])
        .filter((b: Json) => b.type === 'content' && b.content?.type === 'text')
        .map((b: Json) => b.content.text)
        .join('\n');
      this.emit('tool.completed', { itemId: u.toolCallId, text, status: u.status });
    }
  }
  private stop() {
    return (this.stopped ??= (async () => {
      const child = this.child;
      if (!child) return;
      const kill = (signal: NodeJS.Signals) => {
        if (child.pid)
          try {
            process.kill(-child.pid, signal);
          } catch {}
      };
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
        if (!child.stdin.destroyed) {
          if (this.nativeId) {
            child.stdin.write(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/cancel',
                params: { sessionId: this.nativeId },
              }) + '\n',
            );
            void this.request('session/close', { sessionId: this.nativeId }, 1200)
              .catch(() => {})
              .finally(() => child.stdin.end());
          } else child.stdin.end();
        }
        const term = setTimeout(() => kill('SIGTERM'), 1500);
        const hard = setTimeout(() => kill('SIGKILL'), 3500);
        await exited;
        clearTimeout(term);
        clearTimeout(hard);
      }
      kill('SIGKILL'); // Reap remaining tool descendants before releasing the workspace lease.
      this.rejectPending();
    })());
  }
  private finish(state: 'completed' | 'failed' | 'cancelled', error?: string) {
    return (this.finishing ??= Promise.resolve().then(async () => {
      await this.stop();
      for (const itemId of this.pendingTools)
        this.emit('tool.completed', {
          itemId,
          text: state === 'cancelled' ? '任务已取消' : '工具未返回结果',
          status: 'failed',
        });
      if (this.current)
        this.emit(state === 'failed' ? 'run.failed' : 'run.completed', {
          state,
          ...(error ? { error } : {}),
        });
    }));
  }
  async interruptRun(ref: ProviderRunRef) {
    if (ref.turnId !== this.current?.turnId) return;
    this.cancelled = true;
    await this.finish('cancelled');
  }
  async answerInteraction() {
    throw new AppError('unsupported_feature', 'DeepSeek 当前仅支持完全访问，不提供交互审批');
  }
  async close() {
    this.closed = true;
    if (this.current) {
      this.cancelled = true;
      await this.finish('cancelled');
    } else await this.stop();
    await this.execution;
    if (this.patch) await rm(this.patch, { force: true }).catch(() => {});
    this.listeners.clear();
  }
}
