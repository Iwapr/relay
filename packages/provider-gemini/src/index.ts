import { geminiHistory } from './history.ts';
import { ensureGeminiSettings, settingsPath } from './settings.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
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
  NativeSessionHistory,
} from '../../provider-core/src/index.ts';

export const ANTIGRAVITY_VERSION = '1.2.13';
type Json = Record<string, any>;
type Challenge = { verificationUrl: string; userCode: string; loginId: string; codeRequired: boolean };
const permissionDenied =
  /soft.den(?:ied|ying)|permission.{0,80}(denied|required)|requires? approval|not allowed|cannot obtain approval/i;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const unavailable = (message: string) => new AppError('agent_unavailable', message, 503);

const quotaCache = new Map<string, { at: number; value: QuotaState }>();
export function classifyGeminiError(text: string): string {
  if (permissionDenied.test(text))
    return 'Gemini 操作需要审批，已被后台模式拒绝；请查看受限工具卡片或账号权限设置';
  if (/quota|resource.exhausted|rate.limit|too many requests|\b429\b/i.test(text))
    return 'Gemini 订阅额度不足或请求过于频繁，请查看账号额度并等待恢复';
  if (/authentication|unauthenticated|invalid.grant|token.expired|sign.in|\b401\b/i.test(text))
    return 'Google 授权失效，请重新登录此 Gemini 账号';
  if (
    /unsupported.model|unknown.model|invalid.model|model.+(not found|not available|not recognized)/i.test(
      text,
    )
  )
    return '所选 Gemini 模型或推理强度当前不可用，请刷新模型列表后选择';
  if (/sandbox|namespace|operation not permitted/i.test(text))
    return 'Antigravity 终端沙箱无法执行此操作，请检查工具结果和主机沙箱支持';
  if (/timeout|timed.out|deadline.exceeded/i.test(text))
    return 'Gemini 请求超时，已有操作可能已执行，请检查结果后再决定是否重试';
  if (/network|connection|dns|ENOTFOUND|ECONN|proxy|tls|certificate/i.test(text))
    return '无法连接 Google 服务，请检查服务器网络、代理或证书';
  return 'Gemini 未完成任务，请查看工具结果；也可检查 Google 登录、额度和网络';
}

/** Official Antigravity CLI only. No API-key fallback or private Google endpoints. */
export class GeminiAdapter implements AIProviderAdapter {
  readonly id = 'antigravity';
  readonly generation = randomUUID();
  readonly disposeAfterRun = true;
  private closed = false;
  private children = new Set<ChildProcessWithoutNullStreams>();
  private listeners = new Set<(event: ProviderEvent) => void>();
  private prepared?: Promise<void>;
  private discovery?: Promise<{ authenticated: boolean; models: ModelInfo[] }>;
  private session?: { id: string; nativeId?: string };
  private current?: ProviderRunRef;
  private child?: ChildProcessWithoutNullStreams;
  private cancelled = false;
  private login?: Promise<Challenge>;
  private loginChild?: ChildProcessWithoutNullStreams;
  private loginId?: string;
  private submitted = false;
  private loginWaiter?: { resolve: () => void; reject: (error: Error) => void };
  private loginRevision = 0;
  private finishLogin?: (success: boolean) => void;
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
  private emit(type: string, payload: Json = {}, ref = this.current) {
    for (const handler of this.listeners) handler({ type, generation: this.generation, ...ref, payload });
  }
  private prepare() {
    if (this.closed) throw unavailable('Gemini（测试）进程已关闭');
    return (this.prepared ??= (async () => {
      await ensureGeminiSettings(this.options.home);
      await mkdir(join(this.options.home, 'relay-sessions'), { recursive: true, mode: 0o700 });
      const settings = JSON.parse(readFileSync(settingsPath(this.options.home), 'utf8'));
      if (settings.modelProvider)
        throw unavailable('Gemini（测试）仅支持 Google 订阅登录，请移除 modelProvider 配置');
    })());
  }
  private executable() {
    if (this.options.executable) return this.options.executable;
    const bundled = fileURLToPath(new URL('../../../.runtime/antigravity/agy', import.meta.url));
    if (existsSync(bundled)) return bundled;
    const local = join(homedir(), '.local', 'bin', 'agy');
    return existsSync(local) ? local : 'agy';
  }
  private async checkLoginPrograms() {
    for (const [command, message] of [
      [
        this.executable(),
        '未找到可执行的 Antigravity CLI。请以运行 Relay 的 Linux 用户执行 npm run install:gemini',
      ],
      ['python3', '未找到 Python 3，无法启动 Google 登录窗口'],
    ]) {
      const candidates = command.includes('/')
        ? [command]
        : (process.env.PATH ?? '')
            .split(delimiter)
            .filter(Boolean)
            .map((directory) => join(directory, command));
      const results = await Promise.all(
        candidates.map((path) =>
          access(path, constants.X_OK).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (!results.some(Boolean)) throw unavailable(message);
    }
  }
  private launch(args: string[], cwd = this.options.cwd, login = false) {
    if (this.closed) throw unavailable('Gemini（测试）进程已关闭');
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^(GOOGLE_|GEMINI_|GCLOUD_|CLOUDSDK_|CLOUD_CODE_|ANTIGRAVITY_|AGY_|DBUS_|XDG_|ANTHROPIC_|CLAUDE_|OPENAI_)/.test(
          key,
        )
      )
        delete env[key];
    Object.assign(env, {
      HOME: this.options.home,
      XDG_CONFIG_HOME: join(this.options.home, '.config'),
      XDG_DATA_HOME: join(this.options.home, '.local', 'share'),
      XDG_CACHE_HOME: join(this.options.home, '.cache'),
      // Never attach to the desktop user's shared keyring. The CLI's own
      // headless credential fallback remains confined to this private home.
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(this.options.home, 'no-session-bus'),
      SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 2',
      BROWSER: '/bin/true',
    });
    const command = login
      ? ['python3', fileURLToPath(new URL('./login-pty.py', import.meta.url)), this.executable(), cwd]
      : [this.executable(), ...args];
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        'umask "$1"; shift; exec "$@"',
        'relay-antigravity',
        this.options.taskUmask ?? '0022',
        ...command,
      ],
      { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.children.add(child);
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
      const timer = setTimeout(finish, 1200);
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
  private async discover() {
    await this.prepare();
    const child = this.launch(['models'], this.options.home);
    try {
      return await new Promise<{ authenticated: boolean; models: ModelInfo[] }>((resolve, reject) => {
        let output = '',
          errors = '';
        const timer = setTimeout(() => {
          reject(unavailable('Gemini（测试）模型查询超时，请检查 Google 连接'));
          void this.stop(child);
        }, 30_000);
        const collect = (stderr: boolean) => (chunk: string) => {
          if (stderr) errors += chunk;
          else output += chunk;
          if (output.length + errors.length > 1024 * 1024) {
            reject(unavailable('Antigravity 模型响应过大'));
            void this.stop(child);
          }
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', collect(false));
        child.stderr.on('data', collect(true));
        child.once('error', () => {
          clearTimeout(timer);
          reject(unavailable('请先安装 Antigravity CLI：npm run install:gemini'));
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            if (/please sign in|authentication required|not signed in/i.test(output + errors))
              resolve({ authenticated: false, models: [] });
            else
              reject(
                unavailable(
                  code === 127
                    ? '请先安装 Antigravity CLI：npm run install:gemini'
                    : 'Antigravity 查询失败，请检查安装、登录和网络',
                ),
              );
            return;
          }
          const models: ModelInfo[] = [];
          for (const line of output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n')) {
            const match = /^\s*(gemini-[a-z0-9.-]+)\s+(.+?)\s*$/i.exec(line);
            if (match && !models.some((m) => m.id === match[1]))
              models.push({
                id: match[1],
                displayName: match[2] + '（测试）',
                description: 'Google 订阅 · Antigravity CLI（测试）',
                isDefault: models.length === 0,
                supportsImages: false,
                reasoningEfforts: [],
                defaultReasoningEffort: null,
              });
          }
          if (!models.length)
            reject(unavailable('未能读取可用 Gemini 模型，请检查账号权益或 Antigravity 版本'));
          else {
            for (const model of models) {
              const family = model.id.replace(/-(low|medium|high|max)$/, '');
              model.reasoningEfforts = ['low', 'medium', 'high', 'max'].filter((e) =>
                models.some((m) => m.id === family + '-' + e),
              );
              model.defaultReasoningEffort = /-(low|medium|high|max)$/.exec(model.id)?.[1] ?? null;
            }
            resolve({ authenticated: true, models });
          }
        });
      });
    } finally {
      await this.stop(child);
    }
  }
  private catalog() {
    return (this.discovery ??= this.discover());
  }
  async getAccount(): Promise<AccountState> {
    const { authenticated } = await this.catalog();
    return {
      authenticated,
      authMode: authenticated ? 'google-antigravity' : null,
      identifier: null,
      planType: null,
      requiresOpenaiAuth: false,
    };
  }
  async listModels() {
    return (await this.catalog()).models;
  }
  private async report(command: '/usage'): Promise<string> {
    await this.prepare();
    const child = this.launch(['-p', command], this.options.home);
    try {
      return await new Promise((resolve, reject) => {
        let output = '',
          errors = '';
        const timer = setTimeout(() => {
          reject(unavailable('Google 状态查询超时'));
          void this.stop(child);
        }, 30_000);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          output += chunk;
          if (output.length > 1024 * 1024) {
            reject(unavailable('Google 状态响应过大'));
            void this.stop(child);
          }
        });
        child.stderr.on('data', (chunk: string) => {
          errors = (errors + chunk).slice(-8192);
        });
        child.once('error', () => {
          clearTimeout(timer);
          reject(unavailable('无法启动 Antigravity'));
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(output);
          else reject(unavailable(classifyGeminiError(errors)));
        });
      });
    } finally {
      await this.stop(child);
    }
  }
  async getQuota(): Promise<QuotaState | null> {
    if (!(await this.getAccount()).authenticated) return null;
    const key = this.options.home;
    const previous = quotaCache.get(key);
    if (previous && Date.now() - previous.at < 60_000) return previous.value;
    try {
      const windows: QuotaState['windows'] = [];
      for (const line of (await this.report('/usage')).split('\n')) {
        const parts = line.trim().split('\t');
        if (parts.length !== 4 || !/^Gemini Models$/i.test(parts[0])) continue;
        const match = /^(\d+(?:\.\d+)?)%$/.exec(parts[2]);
        const remaining = match ? Number(match[1]) : NaN;
        const reset = Date.parse(parts[3]);
        if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100 || !Number.isFinite(reset))
          continue;
        const weekly = /Weekly/i.test(parts[1]),
          hourly = /Five Hour/i.test(parts[1]);
        if (!weekly && !hourly) continue;
        windows.push({
          name: weekly ? 'Gemini 每周额度' : 'Gemini 五小时额度',
          usedPercent: 100 - remaining,
          windowDurationMins: weekly ? 10080 : 300,
          resetsAt: reset / 1000,
          scope: 'Gemini',
        });
      }
      if (!windows.length) throw unavailable('Google 未返回可识别的额度数据');
      const value: QuotaState = { windows, updatedAt: new Date().toISOString(), stale: false, credits: null };
      quotaCache.set(key, { at: Date.now(), value });
      if (quotaCache.size > 128) quotaCache.delete(quotaCache.keys().next().value!);
      return value;
    } catch (e) {
      const reason = (e as Error).message;
      return previous
        ? { ...previous.value, stale: true, unavailableReason: reason }
        : {
            windows: [],
            updatedAt: new Date().toISOString(),
            stale: true,
            credits: null,
            unavailableReason: reason,
          };
    }
  }
  async createSession(input: CreateSessionInput): Promise<ProviderSessionRef> {
    await this.prepare();
    this.session = { id: randomUUID() };
    return { id: this.session.id, model: input.model };
  }
  async listNativeSessions(cursor?: string, scope: 'workspace' | 'all' = 'workspace') {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2000)
      throw new AppError('invalid_request', 'Gemini 历史分页无效', 400);
    const all = geminiHistory(this.options.home).filter((s) => scope === 'all' || s.cwd === this.options.cwd);
    return {
      sessions: all.slice(offset, offset + 100).map(({ nativeId, busy, ...s }) => s),
      nextCursor: offset + 100 < all.length ? String(offset + 100) : null,
    };
  }
  async readNativeSessionMetadata(id: string) {
    const entry = geminiHistory(this.options.home).find((s) => s.id === id);
    if (!entry) throw new AppError('not_found', '未找到此账号的 Gemini 原生会话', 404);
    const { nativeId, busy, ...summary } = entry;
    return summary;
  }
  async readNativeSession(id: string): Promise<NativeSessionHistory> {
    return { ...(await this.readNativeSessionMetadata(id)), turns: [], truncated: true };
  }
  async resumeSession(ref: ProviderSessionRef): Promise<ProviderSessionRef> {
    await this.prepare();
    if (!uuid.test(ref.id)) throw new AppError('invalid_request', 'Gemini 会话标识无效', 400);
    const entry = geminiHistory(this.options.home).find((s) => s.id === ref.id);
    if (entry?.busy)
      throw new AppError('run_conflict', '此 Gemini 会话仍在另一进程中执行，请结束后再接续', 409);
    let nativeId: string;
    try {
      nativeId = JSON.parse(
        readFileSync(join(this.options.home, 'relay-sessions', ref.id + '.json'), 'utf8'),
      ).nativeId;
    } catch {
      if (entry) nativeId = entry.nativeId;
      else
        throw new AppError(
          'unsupported_feature',
          'Gemini 原生会话尚未建立，请新建会话；不会自动重发旧任务',
          409,
        );
    }
    if (!uuid.test(nativeId)) throw unavailable('Gemini 原生会话记录无效');
    this.session = { id: ref.id, nativeId };
    return ref;
  }
  async startRun(input: StartRunInput): Promise<ProviderRunRef> {
    if (this.current) throw new AppError('run_conflict', 'Gemini 已有活动任务', 409);
    if (this.session?.id !== input.sessionId)
      throw new AppError('invalid_request', 'Gemini 会话尚未打开', 400);
    if (input.images?.length)
      throw new AppError('unsupported_feature', 'Gemini（测试）暂不支持图片输入', 400);
    if (!/^gemini-[a-z0-9.-]+$/i.test(input.model))
      throw new AppError('invalid_request', 'Gemini 模型标识无效', 400);
    await this.prepare();
    let effectiveModel = input.model;
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--model',
      input.model,
      '--disable-slash-commands',
      '--mode',
      input.permissionMode === 'read-only' ? 'plan' : 'accept-edits',
    ];
    if (input.reasoningEffort) {
      const models = await this.listModels();
      if (!models.find((m) => m.id === input.model)?.reasoningEfforts.includes(input.reasoningEffort))
        throw new AppError('unsupported_feature', '此 Gemini 模型不支持所选推理强度', 400);
      effectiveModel = input.model.replace(/-(low|medium|high|max)$/, '') + '-' + input.reasoningEffort;
      args[args.indexOf('--model') + 1] = effectiveModel;
      args.push('--effort', input.reasoningEffort);
    }
    if (this.session.nativeId) args.push('--conversation', this.session.nativeId);
    if (input.permissionMode === 'full-access') args.push('--dangerously-skip-permissions');
    else args.push('--sandbox');
    this.cancelled = false;
    const ref = (this.current = { sessionId: input.sessionId, turnId: randomUUID() });
    const child = (this.child = this.launch(args, input.cwd));
    let startupTimedOut = false;
    const startupTimer = setTimeout(() => {
      startupTimedOut = true;
      void this.stop(child);
    }, 60_000);
    let buffer = '',
      stderr = '',
      streamed = false,
      result: Json | undefined,
      invalid = false,
      denied = false;
    const tools = new Set<string>();
    const pendingTools = new Map<string, string>();
    const receive = (m: Json) => {
      if (m.event === 'init') {
        clearTimeout(startupTimer);
        const nativeId = m.conversation_id;
        if (!uuid.test(nativeId) || (this.session!.nativeId && this.session!.nativeId !== nativeId))
          throw new Error('session mismatch');
        this.session!.nativeId = nativeId;
        const path = join(this.options.home, 'relay-sessions', ref.sessionId + '.json');
        const temp = path + '.' + this.generation;
        writeFileSync(temp, JSON.stringify({ nativeId }), { mode: 0o600 });
        renameSync(temp, path);
      } else if (m.event === 'step_update') {
        const step = m.step_update ?? {};
        if (step.conversation_id && step.conversation_id !== this.session!.nativeId)
          throw new Error('session mismatch');
        const itemId = ref.turnId + ':' + step.step_index;
        if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
          streamed = true;
          this.emit('message.delta', { itemId, delta: step.text_delta });
        }
        if (step.step_type === 'tool') {
          const tool = step.tool_info ?? {};
          if (tool.error && permissionDenied.test(JSON.stringify(tool.error))) denied = true;
          if (!tools.has(itemId)) {
            tools.add(itemId);
            pendingTools.set(itemId, String(step.tool_name ?? tool.name ?? 'Antigravity 工具'));
            this.emit('tool.started', {
              itemId,
              name: step.tool_name ?? tool.name,
              title: step.tool_name ?? tool.name ?? 'Antigravity 工具',
              arguments: tool.parameters ?? {},
            });
          }
          if (step.state === 'DONE') {
            pendingTools.delete(itemId);
            this.emit('tool.completed', {
              itemId,
              text: typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output ?? ''),
              status: tool.error ? 'failed' : 'completed',
            });
          }
        }
      } else if (m.event === 'result') {
        if (result) throw new Error('duplicate result');
        result = m.result;
        if (!result || (result.conversation_id && result.conversation_id !== this.session!.nativeId))
          throw new Error('session mismatch');
        if (!streamed && typeof result.response === 'string')
          this.emit('message.delta', { itemId: ref.turnId + ':response', delta: result.response });
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (invalid || !this.current) return;
      buffer += chunk;
      try {
        if (buffer.length > 16 * 1024 * 1024) throw new Error('oversize');
        for (let i; (i = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (line.trim()) receive(JSON.parse(line));
        }
      } catch {
        invalid = true;
        void this.stop(child);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
      denied ||= permissionDenied.test(stderr);
    });
    child.once('error', () => {
      clearTimeout(startupTimer);
      this.finish('failed', '无法启动 Antigravity CLI，请检查安装');
    });
    child.once('close', async (code) => {
      clearTimeout(startupTimer);
      await this.stop(child);
      if (this.cancelled) return;
      if (!this.current) return;
      if (buffer.trim() && !invalid) {
        try {
          receive(JSON.parse(buffer));
        } catch {
          invalid = true;
        }
      }
      if (denied) {
        for (const [itemId, name] of pendingTools)
          this.emit('tool.completed', {
            itemId,
            name,
            title: name,
            status: 'failed',
            text: '此操作未完成：后台模式无法取得所需审批。请查看本工具的命令及账号允许规则。',
          });
        this.emit('tool.completed', {
          itemId: ref.turnId + ':permissions',
          title: '操作受限',
          text: 'Gemini（测试）有操作需要审批，后台模式已拒绝。请查看受限工具卡片中的命令；常用命令可加入账号允许规则。',
          status: 'failed',
        });
      }
      if (invalid || !result)
        this.finish(
          'uncertain',
          startupTimedOut
            ? 'Antigravity 启动超时，请检查网络和登录；不会自动重发任务'
            : stderr
              ? classifyGeminiError(stderr) + '；任务结果尚未确认，不会自动重发'
              : 'Antigravity 连接中断或协议异常，请核实任务结果；不会自动重发',
        );
      else if (result.status === 'CANCELED' || result.status === 'INTERRUPTED') this.finish('cancelled');
      else if (
        code === 0 &&
        (result.status === 'SUCCESS' ||
          (result.status === 'WAITING' && String(result.response ?? '').trim())) &&
        !denied &&
        this.session?.nativeId
      )
        this.finish('completed');
      else
        this.finish(
          'failed',
          denied
            ? 'Gemini 操作需要审批，已被后台模式拒绝；请查看受限工具卡片'
            : classifyGeminiError(String(result.error ?? '') + '\n' + stderr),
        );
    });
    this.emit('run.started');
    this.emit('run.settings', { model: effectiveModel, reasoningEffort: input.reasoningEffort ?? null });
    child.stdin.end(JSON.stringify({ event: 'user', message: { content: input.text } }) + '\n');
    return ref;
  }
  private finish(state: string, error?: string) {
    if (!this.current) return;
    const ref = this.current;
    this.current = undefined;
    this.emit(error ? 'run.failed' : 'run.completed', { state, ...(error ? { error } : {}) }, ref);
  }
  async interruptRun(ref: ProviderRunRef) {
    if (ref.turnId !== this.current?.turnId) return;
    this.cancelled = true;
    if (this.child) await this.stop(this.child);
    this.finish('cancelled');
  }
  async answerInteraction(_input: InteractionAnswer) {
    throw new AppError('unsupported_feature', 'Gemini（测试）后台模式不支持交互审批', 400);
  }
  async beginLogin(): Promise<Challenge> {
    if (this.login) return this.login;
    const revision = this.loginRevision;
    await this.prepare();
    await this.checkLoginPrograms();
    if (revision !== this.loginRevision) throw new AppError('auth_required', 'Google 登录已取消', 401);
    if (this.login) return this.login;
    const child = (this.loginChild = this.launch([], this.options.home, true));
    this.loginId = randomUUID();
    this.submitted = false;
    this.login = new Promise((resolve, reject) => {
      let output = '',
        selected = false,
        settled = false,
        finished = false,
        checking = false;
      const timer = setTimeout(() => finish(false), 30_000);
      const expiry = setTimeout(() => finish(false), 10 * 60_000);
      const poll = setInterval(() => {
        if (!this.submitted || checking || finished) return;
        checking = true;
        void this.discover()
          .then((s) => {
            if (s.authenticated) finish(true);
          })
          .catch(() => {})
          .finally(() => {
            checking = false;
          });
      }, 2500);
      const finish = (this.finishLogin = (success: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(expiry);
        clearInterval(poll);
        if (!settled)
          reject(
            new AppError(
              'auth_required',
              '未能开始 Google 登录，请检查 Antigravity CLI 安装和 Python 3',
              401,
            ),
          );
        this.login = undefined;
        this.loginChild = undefined;
        this.loginId = undefined;
        this.finishLogin = undefined;
        this.discovery = undefined;
        quotaCache.delete(this.options.home);
        void this.stop(child);
        this.emit('account.updated', { success, loginCompleted: true });
        const waiter = this.loginWaiter;
        this.loginWaiter = undefined;
        if (success) waiter?.resolve();
        else waiter?.reject(new AppError('auth_required', 'Google 授权未完成，请重新登录', 401));
      });
      child.stdout.setEncoding('utf8');
      child.stderr.resume();
      child.stdout.on('data', (chunk: string) => {
        output = (output + chunk).slice(-128 * 1024);
        if (
          this.submitted &&
          /token exchange failed|invalid (authorization )?code|authentication failed/i.test(chunk)
        ) {
          finish(false);
          return;
        }
        if (!selected && /Select login method:[\s\S]*Google OAuth/.test(output)) {
          selected = true;
          child.stdin.write(JSON.stringify({ type: 'input', data: '\r' }) + '\n');
        }
        // OSC-8 links carry the complete URL even when the TUI visually wraps it.
        const match = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\x00-\x20\x7f]+/.exec(output);
        if (!settled && match) {
          const url = new URL(match[0]);
          if (!url.searchParams.has('state') || !url.searchParams.has('code_challenge')) return;
          settled = true;
          clearTimeout(timer);
          resolve({ verificationUrl: url.href, userCode: '', loginId: this.loginId!, codeRequired: true });
        }
      });
      child.once('error', () => finish(false));
      child.once('exit', () => finish(false));
    });
    return this.login;
  }
  async completeLogin(code: string, loginId: string) {
    if (!this.loginChild || this.loginId !== loginId || this.submitted)
      throw new AppError('stale_interaction', 'Google 登录请求已失效，请重新登录', 409);
    if (!code.trim() || /[\x00-\x20\x7f]/.test(code.trim()) || code.length > 4096)
      throw new AppError('invalid_request', 'Google 授权码格式无效', 400);
    this.submitted = true;
    const child = this.loginChild;
    await new Promise<void>((resolve, reject) => {
      this.loginWaiter = { resolve, reject };
      child.stdin.write(JSON.stringify({ type: 'input', data: code.trim() + '\r' }) + '\n');
    });
  }
  async cancelLogin() {
    this.loginRevision++;
    const child = this.loginChild;
    const finish = this.finishLogin;
    if (child) await this.stop(child);
    finish?.(false);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.cancelLogin();
    await Promise.all([...this.children].map((child) => this.stop(child)));
    this.listeners.clear();
  }
}
