/** Enable explicitly scoped LAN access for the existing local development Gateway. */
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { gatewayConfigSchema, isPrivateIPv4 } from '../apps/gateway/src/config.ts';
const runtime = fileURLToPath(new URL('../.runtime', import.meta.url));
const configPath = join(runtime, 'gateway.json');
const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === '--host'))
  throw new Error('使用 npm run lan -- [--host 当前电脑的局域网IPv4地址]');
const candidates = [
  ...new Set(
    Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? [])
        .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address))
        .map((entry) => entry.address),
    ),
  ),
];
const host = args[1] ?? (candidates.length === 1 ? candidates[0] : undefined);
if (!host || !candidates.includes(host))
  throw new Error(`请用 --host 选择当前网卡上的局域网地址：${candidates.join(', ') || '未发现私有IPv4地址'}`);
const config = gatewayConfigSchema.parse(
  JSON.parse(
    await readFile(configPath, 'utf8').catch(() => {
      throw new Error('请先运行 npm run setup');
    }),
  ),
);
if (config.secureCookies !== false || new URL(config.publicOrigin).protocol !== 'http:')
  throw new Error('此命令只切换本地开发配置；HTTPS生产配置请继续使用反向代理。');
const next = gatewayConfigSchema.parse({
  ...config,
  host,
  allowLanHttp: true,
  allowTailscaleHttp: false,
  publicOrigin: new URL(`http://${host}:${config.port}`).origin,
});
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
  await writeFile(loginPath, login.replace(/^地址：[^\r\n]*/m, `地址：${next.publicOrigin}`), {
    mode: 0o600,
  });
  await chmod(loginPath, 0o600);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
console.log(
  `局域网访问已配置：${next.publicOrigin}\n仅监听此网卡地址，网站账号、密码和Agent配置保持原值。\n重启开发服务后生效；同一局域网设备使用上方地址登录。\n这是可信局域网HTTP模式；公网访问继续使用HTTPS反代。`,
);
