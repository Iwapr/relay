import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../../packages/contracts/src/index.ts';

interface Session {
  workspace: string;
  process: ChildProcessWithoutNullStreams;
  output: string;
  offset: number;
  touched: number;
  exitCode: number | null;
}

/** Bounded PTYs, scoped to this agent/account and the originating workspace. */
export class Terminals {
  private sessions = new Map<string, Session>();
  private timer = setInterval(() => {
    for (const [id, session] of this.sessions) if (Date.now() - session.touched > 5 * 60_000) this.remove(id);
  }, 30_000).unref();

  open(workspace: string, cwd: string, cols: number, rows: number) {
    if (this.sessions.size >= 8)
      throw new AppError('terminal_limit', '终端数量已达上限，请先关闭已有终端。', 409);
    const shell = userInfo().shell || '/bin/bash';
    const process = spawn(
      'python3',
      [fileURLToPath(new URL('./terminal-pty.py', import.meta.url)), shell, cwd, String(cols), String(rows)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    process.stdout.setEncoding('utf8');
    const session: Session = {
      workspace,
      process,
      output: '',
      offset: 0,
      touched: Date.now(),
      exitCode: null,
    };
    const id = randomUUID();
    this.sessions.set(id, session);
    const append = (data: string) => {
      session.output += data;
      const excess = session.output.length - 256 * 1024;
      if (excess > 0) {
        session.output = session.output.slice(excess);
        session.offset += excess;
      }
    };
    process.stdout.on('data', append);
    process.on('close', (code) => {
      session.exitCode = code ?? 1;
    });
    process.on('error', (error) => {
      append(`\r\n${error.message}\r\n`);
      session.exitCode = 1;
    });
    process.stdin.on('error', () => {});
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', append);
    return { id };
  }

  private get(workspace: string, id: string) {
    const session = this.sessions.get(id);
    if (!session || session.workspace !== workspace)
      throw new AppError('not_found', '终端已关闭或已过期，请重新打开。', 404);
    session.touched = Date.now();
    return session;
  }

  read(workspace: string, id: string, cursor: number) {
    const s = this.get(workspace, id);
    return {
      data: s.output.slice(Math.max(0, cursor - s.offset)),
      cursor: s.offset + s.output.length,
      truncated: cursor < s.offset,
      exitCode: s.exitCode,
    };
  }

  write(workspace: string, id: string, data: string) {
    const s = this.get(workspace, id);
    if (s.exitCode !== null) throw new AppError('terminal_exited', '终端进程已退出。', 409);
    if (s.process.stdin.writableLength > 64 * 1024)
      throw new AppError('terminal_busy', '终端输入过快，请稍后重试。', 429);
    s.process.stdin.write(JSON.stringify({ type: 'input', data }) + '\n');
  }

  resize(workspace: string, id: string, cols: number, rows: number) {
    const s = this.get(workspace, id);
    if (s.exitCode === null) s.process.stdin.write(JSON.stringify({ type: 'resize', cols, rows }) + '\n');
  }

  close(workspace: string, id: string) {
    this.get(workspace, id);
    this.remove(id);
  }

  private remove(id: string) {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    if (s?.exitCode === null) s.process.kill();
  }

  dispose() {
    clearInterval(this.timer);
    for (const id of this.sessions.keys()) this.remove(id);
  }
}
