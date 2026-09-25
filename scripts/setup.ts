import { selectLanAddress } from './lan-address.ts';
import { mkdir, writeFile, readFile, chmod, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../apps/gateway/src/auth.ts';
import { codexExecutable as resolveCodexExecutable, validateCodexExecutable } from './codex-executable.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = join(root, '.runtime');
const args = process.argv.slice(2);
let allowed = homedir(),
  port = 4080;
let explicitCodex: string | undefined;
let explicitHost: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') allowed = resolve(args[++i]);
  else if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--host' && args[i + 1]) explicitHost = args[++i];
  else if (args[i] === '--codex' && args[i + 1]) explicitCodex = args[++i];
  else
    throw new Error(
      '使用 npm run setup -- [--root /项目允许根目录] [--port 4080] [--host 局域网IP] [--codex /绝对路径/codex]',
    );
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须在1024–65535');
if (!(await stat(allowed)).isDirectory()) throw new Error('允许根目录不存在');
await mkdir(runtime, { recursive: true, mode: 0o700 });
await chmod(runtime, 0o700);
try {
  await stat(join(runtime, 'gateway.json'));
  const agentPath = join(runtime, 'agent.json');
  const existing = JSON.parse(await readFile(agentPath, 'utf8'));
  const sensitive = Array.isArray(existing.sensitivePaths) ? existing.sensitivePaths : [];
  let changed = false;
  if (explicitCodex) {
    existing.codexExecutable = await validateCodexExecutable(
      await resolveCodexExecutable({ explicit: explicitCodex }),
    );
    changed = true;
  }
  if (!sensitive.includes(runtime)) {
    existing.sensitivePaths = [...sensitive, runtime];
    changed = true;
    console.log('已补充安全配置：文件预览禁止访问整个 .runtime。');
  }
  if (changed) {
    await writeFile(agentPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
    await chmod(agentPath, 0o600);
    console.log('Agent 配置已更新，请重启 Agent 使其生效。');
  }
  console.log('本地配置已存在；未覆盖账号、令牌、允许根目录或状态。运行 npm run build && npm run dev');
  process.exit(0);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const host = selectLanAddress(explicitHost);
const codexExecutable = await validateCodexExecutable(
  await resolveCodexExecutable({ explicit: explicitCodex }),
);
const token = randomBytes(32).toString('base64url'),
  password = randomBytes(18).toString('base64url');
const username = userInfo().username,
  uid = process.getuid!();
const agent = {
  stateDir: join(runtime, 'agent'),
  socketPath: join(runtime, 'run', 'agent.sock'),
  tokenFile: join(runtime, 'agent.token'),
  roots: [allowed],
  sensitivePaths: [runtime],
  codexExecutable,
  maxProviders: 4,
  maxPreviewBytes: 50 * 1024 * 1024,
  allowRoot: false,
};
const gateway = {
  publicOrigin: `http://${host}:${port}`,
  host,
  allowLanHttp: host !== '127.0.0.1',
  port,
  stateDir: join(runtime, 'gateway'),
  owner: { id: 'owner', username: 'owner', passwordHash: await hashPassword(password) },
  secureCookies: false,
  staticDir: join(root, 'apps/web/dist'),
  profiles: [
    {
      id: 'local',
      ownerId: 'owner',
      label: '本机工作空间',
      tokenFile: agent.tokenFile,
      expectedIdentity: { uid, username, home: homedir() },
      transport: { kind: 'unix', socketPath: agent.socketPath },
    },
  ],
};
await writeFile(agent.tokenFile, token + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(join(runtime, 'agent.json'), JSON.stringify(agent, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
await writeFile(join(runtime, 'gateway.json'), JSON.stringify(gateway, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
await writeFile(
  join(runtime, 'login.txt'),
  `地址：http://${host}:${port}\n账号：owner\n密码：${password}\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log(
  `本地配置已生成，允许根目录：${allowed}\n账号与随机密码保存在 .runtime/login.txt（权限0600）。\n运行 npm run build && npm run dev，然后访问 http://${host}:${port}\n默认仅供可信局域网使用；远程访问可在右上角菜单 → 远程管理启用。`,
);
