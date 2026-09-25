import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../contracts/src/index.ts';

export async function migrateHistory(source: string, target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'python3',
      ['-I', '-S', fileURLToPath(new URL('./migrate-history.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let result = '';
    child.stdout.on('data', (data) => {
      result += data.toString();
    });
    child.stderr.resume();
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        let message = '历史迁移未完成，原文件已保留。';
        try {
          message = JSON.parse(result).error ?? message;
        } catch {}
        reject(new AppError('history_migration_required', message, 409));
      }
    });
    child.stdin.end(JSON.stringify({ source, target }));
  });
}
