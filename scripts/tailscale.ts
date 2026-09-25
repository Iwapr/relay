/** Add a Tailscale listener to the existing local development Gateway. */
import { execFile } from 'node:child_process';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gatewayConfigSchema, isTailscaleIPv4 } from '../apps/gateway/src/config.ts';

const runtime = fileURLToPath(new URL('../.runtime', import.meta.url));
const configPath = join(runtime, 'gateway.json');
if (process.argv.length !== 2) throw new Error('使用 npm run tailscale，无需传入地址。');
const config = gatewayConfigSchema.parse(
  JSON.parse(
    await readFile(configPath, 'utf8').catch(() => {
      throw new Error('请先运行 npm run setup');
    }),
  ),
);
if (config.secureCookies !== false || new URL(config.publicOrigin).protocol !== 'http:')
  throw new Error('此命令只增加本地HTTP开发配置的监听；HTTPS生产配置请继续使用反向代理。');

const { stdout } = await promisify(execFile)('tailscale', ['ip', '-4'], {
  timeout: 10_000,
  maxBuffer: 16_384,
  encoding: 'utf8',
}).catch(() => {
  throw new Error('无法读取Tailscale IPv4地址；请确认Tailscale已安装、已登录并连接。');
});
const assigned = new Set(
  Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => entry.address),
  ),
);
const candidates = [
  ...new Set(
    stdout
      .trim()
      .split(/\s+/)
      .filter((address) => isTailscaleIPv4(address) && assigned.has(address)),
  ),
];
if (candidates.length !== 1)
  throw new Error('未找到唯一且已分配给本机网卡的Tailscale IPv4地址；请检查Tailscale连接。');
const next = gatewayConfigSchema.parse({ ...config, tailscaleHost: candidates[0] });
const tailscaleOrigin = new URL(`http://${next.tailscaleHost}:${next.port}`).origin;
const temporary = `${configPath}.${process.pid}.tmp`;
try {
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, configPath);
} finally {
  await unlink(temporary).catch(() => {});
}

const loginPath = join(runtime, 'login.txt');
try {
  const login = await readFile(loginPath, 'utf8');
  const newline = login.includes('\r\n') ? '\r\n' : '\n';
  const previous = login.replace(/^Tailscale地址：[^\r\n]*(?:\r?\n|$)/gm, '');
  await writeFile(
    loginPath,
    previous + (previous.endsWith('\n') ? '' : newline) + `Tailscale地址：${tailscaleOrigin}${newline}`,
    { mode: 0o600 },
  );
  await chmod(loginPath, 0o600);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
console.log(
  `Tailscale访问已配置：${tailscaleOrigin}\n原访问地址：${new URL(next.publicOrigin).origin}\n重启开发服务后两个地址同时生效；在已连接Tailscale的设备上使用上方HTTP地址登录。\n网站账号、密码和Agent配置保持原值，未修改Tailscale系统配置。`,
);
