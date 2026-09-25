import { spawn } from 'node:child_process';
import { readFile, mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
const root = fileURLToPath(new URL('..', import.meta.url));
const agentConfig = process.env.AGENT_CONFIG ?? join(root, '.runtime/agent.json');
const gatewayConfig = process.env.GATEWAY_CONFIG ?? join(root, '.runtime/gateway.json');
const config = JSON.parse(
  await readFile(agentConfig, 'utf8').catch(() => {
    throw new Error('请先运行 npm run setup');
  }),
);
const children: ReturnType<typeof spawn>[] = [];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const p of children) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1000).unref();
}
const launch = (component: string, env: NodeJS.ProcessEnv) => {
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, `apps/${component}/src/main.ts`)], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  children.push(child);
  child.on('error', () => close(1));
  child.on('exit', (code) => {
    if (!closing) close(code ?? 1);
  });
  return child;
};
launch('agent', { AGENT_CONFIG: agentConfig });
let ready = false;
for (let tries = 0; tries < 100 && !closing; tries++) {
  ready = await new Promise<boolean>((resolve) => {
    const s = connect(config.socketPath);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
  if (ready) break;
  await new Promise((r) => setTimeout(r, 100));
}
if (!ready) {
  close(1);
  throw new Error('Agent 未成功启动，请检查诊断');
}
launch('gateway', { GATEWAY_CONFIG: gatewayConfig });
console.log('本地工作台已启动。开发进程退出会停止服务；常驻部署请使用独立 systemd 用户服务。');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => close());
