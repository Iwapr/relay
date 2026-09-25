import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileServiceError, secureFs, type WorkspaceDirectory } from './files.ts';

const helper = fileURLToPath(new URL('../../../packages/secure-fs/lock.py', import.meta.url));
export interface LockOptions {
  privateDirectory: string;
  machineId: string;
  sharedLockDirectory?: string;
}
export interface WriteLease {
  readonly runId: string;
  readonly record: string;
  /** Set uncertain when external execution has not been confirmed to stop. */
  release(options?: { uncertain?: boolean }): Promise<void>;
}

/** Host-local advisory leases. Browser and SSH lifecycle never own these. */
export class LockManager {
  private active = new Set<WriteLease>();
  private constructor(
    private options: LockOptions,
    private directory: string,
  ) {}
  static async create(options: LockOptions): Promise<LockManager> {
    if (!options.machineId) throw new Error('Verified machine identity is required for workspace locks');
    const directory = options.sharedLockDirectory ?? path.join(options.privateDirectory, 'locks');
    if (!path.isAbsolute(directory)) throw new Error('Lock directory must be absolute');
    if (!options.sharedLockDirectory) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Lock directory must be a real directory');
    if (options.sharedLockDirectory) {
      if ((info.mode & 0o007) !== 0 || (info.mode & 0o070) !== 0o070 || (info.mode & 0o2000) === 0)
        throw new Error('Shared lock directory must be administrator provisioned with mode 2770');
      if (!(process.getgroups?.() ?? []).includes(info.gid) && process.getgid?.() !== info.gid)
        throw new Error('Agent must belong to the shared lock directory group');
    } else if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error('Private lock directory must be owned by this user and mode 0700');
    return new LockManager(options, directory);
  }
  async acquire(
    workspace: WorkspaceDirectory,
    runId: string,
    options: { requireWritable?: boolean } = {},
  ): Promise<WriteLease> {
    const verified = await secureFs<WorkspaceDirectory>({ operation: 'validate', root: workspace });
    if (options.requireWritable !== false && !verified.writable)
      throw new FileServiceError('permission_denied', 'Workspace is not writable');
    if (verified.shared && !this.options.sharedLockDirectory)
      throw new FileServiceError(
        'shared_lock_required',
        'Shared workspace writes require an administrator configured cross-user lock directory',
        409,
      );
    return new Promise<WriteLease>((resolve, reject) => {
      const child = spawn('/usr/bin/python3', [helper], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      });
      let output = '';
      let settled = false;
      const timer = setTimeout(() => {
        child.kill();
        reject(new FileServiceError('lock_unavailable', 'Workspace lock timed out', 503));
      }, 10_000);
      const fail = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new FileServiceError('lock_unavailable', 'Workspace lock helper failed', 503));
        }
      };
      child.once('error', fail);
      child.once('exit', fail);
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.stdout.on('data', (data: Buffer) => {
        if (settled) return;
        output += data.toString('utf8');
        if (output.length > 65536) {
          child.kill();
          fail();
          return;
        }
        const index = output.indexOf('\n');
        if (index < 0) return;
        clearTimeout(timer);
        try {
          const result = JSON.parse(output.slice(0, index));
          settled = true;
          if (!result.ok) {
            child.stdin.end();
            reject(new FileServiceError(result.error.code, result.error.message, result.error.statusCode));
            return;
          }
          let released = false;
          const lease: WriteLease = {
            runId,
            record: path.join(this.directory, result.lease),
            release: async (options = {}) => {
              if (released) return;
              released = true;
              this.active.delete(lease);
              await finish(child, options.uncertain ?? false);
            },
          };
          this.active.add(lease);
          resolve(lease);
        } catch {
          child.kill();
          settled = false;
          fail();
        }
      });
      child.stdin.write(
        JSON.stringify({
          directory: this.directory,
          shared: Boolean(this.options.sharedLockDirectory),
          machineId: this.options.machineId,
          workspace: verified,
          runId,
        }) + '\n',
      );
    });
  }
  /** Agent shutdown cannot prove descendants have stopped, so retain markers. */
  async close(): Promise<void> {
    await Promise.all([...this.active].map((lease) => lease.release({ uncertain: true })));
  }
}

async function finish(child: ChildProcessWithoutNullStreams, uncertain: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.end(JSON.stringify({ release: true, uncertain }) + '\n');
  });
}
