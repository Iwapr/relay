import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../../contracts/src/index.ts';

export interface UnixTransport {
  kind: 'unix';
  socketPath: string;
}
export interface SshTransport {
  kind: 'ssh';
  host: string;
  port: number;
  user: string;
  identityFile: string;
  knownHostsFile: string;
  remoteSocketPath: string;
}
export type TransportConfig = UnixTransport | SshTransport;
export interface UpstreamRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export async function readPrivateFile(path: string): Promise<string> {
  const st = await lstat(path);
  if (!st.isFile() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) {
    throw new AppError(
      'invalid_configuration',
      'Secret files must be owned by the service user with mode 0600 or 0400.',
      500,
    );
  }
  return readFile(path, 'utf8');
}

export function sshArguments(config: SshTransport, localSocket: string): string[] {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(config.host) ||
    !/^[a-z_][a-z0-9_-]*\$?$/.test(config.user) ||
    config.user === 'root'
  ) {
    throw new AppError(
      'invalid_configuration',
      'SSH requires a controlled hostname and a non-root Linux user.',
      500,
    );
  }
  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    ![config.identityFile, config.knownHostsFile, config.remoteSocketPath, localSocket].every(
      (p) => isAbsolute(p) && !/[\x00-\x20:]/.test(p),
    )
  ) {
    throw new AppError('invalid_configuration', 'Invalid SSH port or forwarding path.', 500);
  }
  return [
    '-N',
    '-T',
    '-F',
    '/dev/null',
    '-a',
    '-x',
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'IdentityAgent=none',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${config.knownHostsFile}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=20',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StreamLocalBindMask=0177',
    '-o',
    'StreamLocalBindUnlink=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-i',
    config.identityFile,
    '-p',
    String(config.port),
    '-l',
    config.user,
    '-L',
    `${localSocket}:${config.remoteSocketPath}`,
    config.host,
  ];
}

/** One owned tunnel per connection; shutting this down only closes forwarding. */
export class AgentTransport {
  private child?: ChildProcess;
  private tunnelDir?: string;
  private socketPath?: string;
  private connecting?: Promise<string>;
  private closed = false;
  constructor(
    private readonly config: TransportConfig,
    private readonly runtimeDir: string,
  ) {}
  private async establish(): Promise<string> {
    if (this.closed) throw new AppError('connection_offline', 'Transport is closed.', 503);
    if (this.config.kind === 'unix') {
      if (!isAbsolute(this.config.socketPath))
        throw new AppError('invalid_configuration', 'Agent socket must be absolute.', 500);
      return this.config.socketPath;
    }
    const config = this.config;
    await readPrivateFile(config.identityFile);
    const known = await lstat(config.knownHostsFile);
    if (!known.isFile() || (known.mode & 0o022) !== 0)
      throw new AppError(
        'invalid_configuration',
        'Known-hosts file must be a regular file and not group/world writable.',
        500,
      );
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.runtimeDir, 'ssh-'));
    this.tunnelDir = directory;
    await chmod(directory, 0o700);
    const socket = join(directory, 'a.sock');
    let failure = 'SSH could not establish a verified forwarding connection.';
    const child = spawn('/usr/bin/ssh', sshArguments(config, socket), {
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/' },
    });
    this.child = child;
    // Never log arbitrary SSH diagnostics or persist output. Only classify fixed errors.
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text))
        failure = 'SSH host key is untrusted or has changed; verify it through a trusted channel.';
      else if (/permission denied/i.test(text)) failure = 'SSH key authentication failed.';
    });
    child.on('error', () => {
      failure = 'OpenSSH could not be started.';
    });
    child.once('exit', () => {
      if (this.child === child) {
        this.child = undefined;
        this.socketPath = undefined;
      }
      void rm(directory, { recursive: true, force: true });
    });
    for (let i = 0; i < 120; i++) {
      if (this.closed || child.exitCode !== null || child.signalCode !== null) break;
      const ready = await lstat(socket).then(
        (s) => s.isSocket(),
        () => false,
      );
      if (ready) {
        await chmod(socket, 0o600);
        this.socketPath = socket;
        return socket;
      }
      await delay(100);
    }
    child.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
    throw new AppError('connection_offline', failure, 503);
  }
  async endpoint(): Promise<string> {
    if (this.socketPath) return this.socketPath;
    if (!this.connecting)
      this.connecting = this.establish().finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  async request(input: UpstreamRequest): Promise<IncomingMessage> {
    const socketPath = await this.endpoint();
    if (!input.path.startsWith('/') || input.path.startsWith('//') || /[\r\n\x00]/.test(input.path))
      throw new AppError('invalid_request', 'Invalid upstream path.', 400);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { socketPath, path: input.path, method: input.method, headers: input.headers, signal: input.signal },
        (response) => {
          // SSE is deliberately unbounded after response headers; heartbeats keep transport alive.
          req.setTimeout(0);
          resolve(response);
        },
      );
      req.setTimeout(20_000, () => req.destroy(new Error('Upstream response timed out')));
      req.once('error', () =>
        reject(
          new AppError(
            'connection_offline',
            'The remote Agent is unavailable; running tasks may still be active.',
            503,
          ),
        ),
      );
      req.end(input.body);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), delay(1500)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    if (this.tunnelDir) await rm(this.tunnelDir, { recursive: true, force: true });
    this.socketPath = undefined;
  }
}
