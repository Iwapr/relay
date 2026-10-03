import { factoryQuota } from './quota.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  QuotaState,
} from '../../provider-core/src/index.ts';
import { readFactoryKey } from './credentials.ts';
import type { FactoryRequest } from './runtime.ts';

export const FACTORY_VERSION = '0.232.0';
export const factoryExecutable = () =>
  join(homedir(), '.local/share/relay/factory', FACTORY_VERSION, 'node_modules/.bin/droid');
type Json = Record<string, any>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export class FactoryAdapter implements AIProviderAdapter {
  readonly id = 'factory';
  readonly generation = randomUUID();
  readonly disposeAfterRun = true;
  private listeners = new Set<(event: ProviderEvent) => void>();
  private children = new Set<ChildProcess>();
  private current?: ProviderRunRef;
  private session?: string;
  private closed = false;
  private cancelled = false;
  private execution?: Promise<void>;
  private tasks = new Set<Promise<unknown>>();
  private interactions = new Map<string, { child: ChildProcess; kind: string }>();
  private pendingTools = new Set<string>();
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
  private emit(type: string, payload: Json) {
    for (const listener of this.listeners)
      listener({ type, generation: this.generation, ...this.current, payload });
  }
  async getAccount(): Promise<AccountState> {
    const key = await readFactoryKey(this.options.home);
    return {
      authenticated: !!key,
      authMode: key ? 'factory-api-key' : null,
      identifier: null,
      planType: null,
      requiresOpenaiAuth: false,
    };
  }
  async listModels(): Promise<ModelInfo[]> {
    const key = await readFactoryKey(this.options.home);
    if (!key) return [];
    const result = await this.launch({
      operation: 'models',
      cwd: this.options.home,
      apiKey: key,
      executable: this.options.executable ?? factoryExecutable(),
    });
    if (!Array.isArray(result.models))
      throw new AppError('agent_unavailable', result.error ?? 'Droid 模型列表不可用', 503);
    return result.models;
  }
  async getQuota(): Promise<QuotaState> {
    return factoryQuota(this.options.home);
  }

  private file(id: string) {
    if (!uuid.test(id)) throw new Error('Factory 会话标识无效');
    return join(this.options.home, 'relay-sessions', id + '.json');
  }
  private check(input: CreateSessionInput) {
    if (resolve(input.cwd) !== resolve(this.options.cwd)) throw new Error('Factory 项目目录不匹配');
  }
  async createSession(input: CreateSessionInput) {
    this.check(input);
    const id = randomUUID();
    await mkdir(join(this.options.home, 'relay-sessions'), { recursive: true, mode: 0o700 });
    await writeFile(this.file(id), JSON.stringify({ cwd: resolve(input.cwd) }), { mode: 0o600 });
    this.session = id;
    return { id };
  }
  async resumeSession(ref: ProviderSessionRef, input: CreateSessionInput) {
    this.check(input);
    const record = JSON.parse(await readFile(this.file(ref.id), 'utf8'));
    if (record.cwd !== resolve(input.cwd) || (record.nativeId !== undefined && !uuid.test(record.nativeId)))
      throw new Error('Factory 会话不属于当前项目或记录无效');
    this.session = ref.id;
    return ref;
  }
  async startRun(input: StartRunInput) {
    this.check(input);
    if (this.closed || this.current || this.session !== input.sessionId)
      throw new Error('Factory 会话尚未就绪');
    const key = await readFactoryKey(this.options.home);
    if (!key) throw new AppError('auth_required', '请先配置 Factory API Key', 401);
    const ref = (this.current = { sessionId: input.sessionId, turnId: randomUUID() });
    this.execution = new Promise<void>((r) => setImmediate(r)).then(async () => {
      let result: Json;
      try {
        this.emit('run.started', {});
        result =
          this.cancelled || this.closed
            ? { state: 'cancelled' }
            : await this.launch({
                operation: 'run',
                apiKey: key,
                executable: this.options.executable ?? factoryExecutable(),
                cwd: input.cwd,
                sessionFile: this.file(input.sessionId),
                model: input.model,
                reasoningEffort: input.reasoningEffort,
                permissionMode: input.permissionMode,
                text: input.text,
                images: input.images,
              });
      } catch {
        result = { state: 'failed', error: 'Droid 运行进程异常，请检查安装和任务结果' };
      }
      if (this.cancelled || this.closed) result = { state: 'cancelled' };
      for (const itemId of this.pendingTools)
        this.emit('tool.completed', {
          itemId,
          status: 'failed',
          text: result.state === 'cancelled' ? '任务已取消' : '工具未返回结果',
        });
      this.interactions.clear();
      this.emit(result.state === 'failed' ? 'run.failed' : 'run.completed', result);
    });
    return ref;
  }
  private async launch(request: FactoryRequest): Promise<Json> {
    if (this.closed || this.cancelled) throw new Error('Factory 进程已关闭');
    await mkdir(this.options.home, { recursive: true, mode: 0o700 });
    if (this.closed || this.cancelled) throw new Error('Factory 进程已关闭');
    const env = { ...process.env };
    for (const name of Object.keys(env))
      if (
        /^(FACTORY_|DROID_|ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|GEMINI_|GOOGLE_|DEEPSEEK_|DSH_)/.test(name) ||
        ['NODE_OPTIONS', 'NODE_PATH'].includes(name)
      )
        delete env[name];
    Object.assign(env, {
      HOME: this.options.home,
      FACTORY_HOME_OVERRIDE: this.options.home,
      XDG_CONFIG_HOME: join(this.options.home, '.config'),
      XDG_CACHE_HOME: join(this.options.home, '.cache'),
      XDG_DATA_HOME: join(this.options.home, '.local/share'),
      RELAY_FACTORY_UMASK: this.options.taskUmask ?? '0022',
      PATH: process.execPath.slice(0, process.execPath.lastIndexOf('/')) + delimiter + (env.PATH ?? ''),
    });
    const child = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./worker.ts', import.meta.url))],
      { cwd: request.cwd, env, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    this.children.add(child);
    child.stderr?.resume();
    const task = new Promise<Json>((resolve) => {
      let result: Json | undefined,
        settled = false;
      let hard: NodeJS.Timeout | undefined;
      const kill = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
      };
      const startup = setTimeout(() => {
        result = { state: 'failed', error: 'Droid 启动或模型查询超时，请检查安装和网络' };
        kill();
      }, 60000);
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startup);
        clearTimeout(hard);
        kill();
        this.children.delete(child);
        resolve(result ?? { state: 'failed', error: 'Droid 运行进程意外退出，请检查安装、账号和网络' });
      };
      child.on('error', done);
      child.on('close', done);
      child.on('message', (message: any) => {
        if (message.type === 'result') {
          result = message.result;
          clearTimeout(startup);
          // SDK close has completed. Bound worker/plugin shutdown before releasing the workspace.
          hard = setTimeout(kill, 2000);
          return;
        }
        if (message.type !== 'event' || request.operation !== 'run') return;
        const { event, payload } = message;
        if (event === 'ready' || event === 'interaction.required') clearTimeout(startup);
        if (event === 'ready') return;
        if (event === 'interaction.required')
          this.interactions.set(String(payload.requestId), { child, kind: payload.kind });
        if (event === 'tool.started') this.pendingTools.add(String(payload.itemId));
        if (event === 'tool.completed') this.pendingTools.delete(String(payload.itemId));
        this.emit(event, payload);
      });
      child.send({ type: 'start', request }, (error) => {
        if (error) {
          kill();
        }
      });
    });
    this.tasks.add(task);
    try {
      return await task;
    } finally {
      this.tasks.delete(task);
    }
  }
  async answerInteraction(input: InteractionAnswer) {
    const id = String(input.requestId),
      pending = this.interactions.get(id);
    if (input.generation !== this.generation || !pending || !pending.child.connected)
      throw new AppError('stale_interaction', '此 Droid 请求已失效', 409);
    if (pending.kind === 'approval' && input.answers)
      throw new AppError('invalid_request', '工具审批不接受文字答案', 400);
    await new Promise<void>((resolve, reject) =>
      pending.child.send({ type: 'answer', answer: input }, (error) =>
        error ? reject(new AppError('stale_interaction', 'Droid 请求已失效', 409)) : resolve(),
      ),
    );
    this.interactions.delete(id);
    this.emit('interaction.resolved', { requestId: id });
  }
  private async stop() {
    const children = [...this.children];
    const timers = children.map((child) => {
      if (child.connected) child.send({ type: 'cancel' }, () => {});
      return setTimeout(() => {
        if (child.pid)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
      }, 5000);
    });
    try {
      await Promise.all([...this.tasks]);
    } finally {
      timers.forEach(clearTimeout);
    }
  }
  async interruptRun(ref: ProviderRunRef) {
    if (ref.turnId !== this.current?.turnId) return;
    this.cancelled = true;
    await this.stop();
    await this.execution;
  }
  async close() {
    this.closed = true;
    this.cancelled = true;
    await this.stop();
    await this.execution;
    this.listeners.clear();
  }
}
