import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readConfig } from './config.ts';
import { buildAgent } from './server.ts';
const config = readConfig();
await mkdir(dirname(config.socketPath), { recursive: true, mode: 0o700 });
await chmod(dirname(config.socketPath), 0o700);
// A stale socket is removed only if an active agent cannot answer it.
try {
  const st = await lstat(config.socketPath);
  if (!st.isSocket()) throw new Error('socket 路径已存在且不是 socket');
  const { connect } = await import('node:net');
  const live = await new Promise<boolean>((resolve) => {
    const s = connect(config.socketPath);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
  if (live) throw new Error('Agent 已在运行');
  await unlink(config.socketPath);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const { app } = await buildAgent(config);
await app.listen({ path: config.socketPath });
await chmod(config.socketPath, 0o600);
console.log('Remote Workbench Agent ready (private Unix socket)');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
