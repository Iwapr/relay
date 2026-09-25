import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { Ajv, type ValidateFunction } from 'ajv';
import { AppError } from '../../contracts/src/index.ts';
import type { ClientRequest } from '../../../generated/codex/ClientRequest.ts';

export const SUPPORTED_CODEX_VERSION = '0.154.0-alpha.6.2';
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: false });
const validators = new Map<string, ValidateFunction>();
export function validateSchema<T>(name: string, value: unknown): asserts value is T {
  let validator = validators.get(name);
  if (!validator) {
    const schema = JSON.parse(
      readFileSync(new URL(`../../../generated/codex-json/${name}.json`, import.meta.url), 'utf8'),
    );
    validator = ajv.compile(schema);
    validators.set(name, validator);
  }
  if (!validator(value))
    throw new Error(`Codex protocol mismatch: ${name} ${ajv.errorsText(validator.errors)}`);
}
export type RpcObject = Record<string, unknown>;
interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export class CodexRpc {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private dead = false;
  private stopping = false;
  private shutdownError?: Error;
  version: string | null = null;
  constructor(
    private options: {
      cwd: string;
      executable: string;
      codexHome?: string;
      isolatedAuth?: boolean;
      isolatedState?: boolean;
      args?: string[];
      timeoutMs?: number;
      taskUmask?: '0022' | '0002';
    },
    private onMessage: (message: RpcObject) => void,
    private onExit: (error: Error) => void,
  ) {}
  async open(): Promise<void> {
    const { stdout } = await promisify(execFile)(this.options.executable, ['--version'], { timeout: 10000 });
    this.version = stdout.trim();
    if (this.version !== `codex-cli ${SUPPORTED_CODEX_VERSION}`)
      throw new Error(
        `Codex version ${this.version} is not validated; expected codex-cli ${SUPPORTED_CODEX_VERSION}. Regenerate schemas and run contract tests before upgrading.`,
      );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(this.options.codexHome ? { CODEX_HOME: this.options.codexHome } : {}),
    };
    if (this.options.isolatedState) delete env.CODEX_SQLITE_HOME;
    if (this.options.isolatedAuth) {
      delete env.CODEX_ACCESS_TOKEN;
      delete env.CODEX_API_KEY;
      delete env.OPENAI_API_KEY;
    }
    this.child = spawn(
      'python3',
      [
        '-I',
        '-S',
        '-c',
        'import os,sys; os.umask(int(sys.argv[1],8)); os.execvp(sys.argv[2],sys.argv[2:])',
        this.options.taskUmask ?? '0022',
        this.options.executable,
        'app-server',
        ...(this.options.args ?? []),
      ],
      { cwd: this.options.cwd, stdio: ['pipe', 'pipe', 'pipe'], env },
    );
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    this.child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        this.fail(new Error('Codex protocol frame exceeds 16 MiB'));
        this.child?.kill('SIGTERM');
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail(new Error('Malformed Codex protocol output'));
          this.child?.kill('SIGTERM');
          return;
        }
      }
    });
    // Drain diagnostics separately. Never forward raw stderr, which can contain credentials.
    this.child.stderr.resume();
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.once('exit', (code, signal) =>
      this.fail(new Error(`Codex exited (${code ?? signal ?? 'unknown'})`)),
    );
  }
  private receive(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RPC envelope');
    const message = value as RpcObject;
    if ('method' in message) {
      if (typeof message.method !== 'string') throw new Error('Invalid method');
      this.onMessage(message);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ('error' in message) {
      const err = message.error as { code?: number; message?: string };
      if (
        pending.method === 'thread/resume' &&
        /in use|already.*(?:running|active writer)|locked|another.*(?:process|app|client)|lease.*(?:held|owner)/i.test(
          err?.message ?? '',
        )
      ) {
        pending.reject(
          new AppError(
            'SESSION_IN_USE',
            '此对话正在其他窗口中使用。请在原窗口结束，或点击“在此接管”并确认中断。',
            409,
          ),
        );
        return;
      }
      pending.reject(
        new Error(
          `Codex RPC ${pending.method} ${err?.code ?? 'error'}: ${redactError(err?.message ?? 'Request failed')}`,
        ),
      );
    } else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new Error('Codex response omitted result/error'));
  }
  async request<M extends ClientRequest['method'], T>(
    method: M,
    params: Extract<ClientRequest, { method: M }>['params'],
    schema: string,
  ): Promise<T> {
    const id = this.nextId++;
    const message = { method, id, params };
    validateSchema('ClientRequest', message);
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError(
            'uncertain_operation',
            `Codex request timed out: ${method}; its outcome may be uncertain`,
            409,
          ),
        );
      }, this.options.timeoutMs ?? 45000);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
    validateSchema<T>(schema, result);
    return result;
  }
  send(message: RpcObject): void {
    if (this.dead || !this.child || this.child.stdin.destroyed)
      throw new Error('Codex process is unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private fail(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    error = this.shutdownError ?? error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.onExit(error);
  }
  async close(reason?: Error): Promise<void> {
    this.stopping = true;
    this.shutdownError = reason;
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const child = this.child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.fail(new Error('Codex process closed'));
  }
}
export function redactText(message: string): string {
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|access_token)=)[^&\s]+/gi, '$1[redacted]');
}
export function redactError(message: string): string {
  return redactText(message).slice(0, 2000);
}
