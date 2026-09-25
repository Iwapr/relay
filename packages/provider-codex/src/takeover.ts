import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../contracts/src/index.ts';

export interface WriterOwner {
  pid: number;
  sessions: string[];
  fingerprint: string;
}

export async function nativeWriter(
  home: string,
  threadId: string,
  fingerprint?: string,
): Promise<WriterOwner | { stopped: true }> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('python3', ['-I', '-S', fileURLToPath(new URL('./takeover.py', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let data = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AppError('takeover_failed', '接管结果尚未确认，请刷新会话后检查。', 409));
    }, 10000);
    child.stdout.on('data', (chunk: Buffer) => (data += chunk.toString()));
    child.stderr.resume();
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(data);
      else reject(new AppError('takeover_failed', '无法验证占用进程，请在原窗口释放会话。', 409));
    });
    child.stdin.end(
      JSON.stringify({ home, threadId, action: fingerprint ? 'stop' : 'preview', fingerprint }),
    );
  });
  const result = JSON.parse(output);
  if (result.error) throw new AppError('takeover_failed', result.error, 409);
  return result.result;
}
