/** Run as the destination ordinary user, from a shared read-only release. */
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { userInfo, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../apps/gateway/src/auth.ts';
import { AgentConfigSchema } from '../apps/agent/src/config.ts';
import { gatewayConfigSchema } from '../apps/gateway/src/config.ts';
const [portText, host, tailscaleHost] = process.argv.slice(2);
const port = Number(portText);
const setupOptions = z
  .object({
    sharedProjects: z.boolean().optional(),
    trustedProxyIps: gatewayConfigSchema.shape.trustedProxyIps.optional(),
  })
  .strict()
  .parse(JSON.parse(process.env.RELAY_SETUP_OPTIONS ?? '{}'));
const { uid, username } = userInfo();
if (uid === 0) throw new Error('Run as the destination ordinary user');
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = join(homedir(), '.local/share/relay-instance');
process.umask(0o077);
await mkdir(directory, { recursive: true, mode: 0o700 });
const st = await lstat(directory);
if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || st.mode & 0o077)
  throw new Error('Instance directory must be private and owned by the current user');
const marker = join(directory, 'instance.json');
const desired = { username, uid, port, host, tailscaleHost, release: resolve(root), ...setupOptions };
try {
  const previous = JSON.parse(await readFile(marker, 'utf8'));
  if (JSON.stringify(previous) !== JSON.stringify(desired))
    throw new Error('Existing instance differs; refusing overwrite');
  console.log(`${username}: existing instance retained`);
  process.exit(0);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const token = randomBytes(32).toString('base64url');
const password = randomBytes(24).toString('base64url');
const agent = AgentConfigSchema.parse({
  stateDir: join(directory, 'agent'),
  socketPath: join(directory, 'run/agent.sock'),
  tokenFile: join(directory, 'agent.token'),
  roots: [homedir(), ...(setupOptions.sharedProjects ? ['/srv/projects'] : [])],
  ...(setupOptions.sharedProjects
    ? {
        sharedLockDirectory: '/var/lib/relay/shared-workspace-locks',
        taskUmask: '0002',
      }
    : {}),
  sensitivePaths: [directory],
  codexExecutable: join(root, 'codex/codex'),
  maxProviders: 4,
  maxPreviewBytes: 50 * 1024 * 1024,
});
const gateway = gatewayConfigSchema.parse({
  publicOrigin: `http://${host}:${port}`,
  host,
  port,
  allowLanHttp: true,
  tailscaleHost,
  secureCookies: false,
  cookieNamespace: username,
  ...(setupOptions.trustedProxyIps ? { trustedProxyIps: setupOptions.trustedProxyIps } : {}),
  stateDir: join(directory, 'gateway'),
  staticDir: join(root, 'apps/web/dist'),
  owner: { id: 'owner', username, passwordHash: await hashPassword(password) },
  profiles: [
    {
      id: 'local',
      ownerId: 'owner',
      label: `本机 · ${username}`,
      tokenFile: agent.tokenFile,
      expectedIdentity: { uid, username, home: homedir() },
      transport: { kind: 'unix', socketPath: agent.socketPath },
    },
  ],
});
const files = {
  'agent.token': token + '\n',
  'agent.json': JSON.stringify(agent, null, 2),
  'gateway.json': JSON.stringify(gateway, null, 2),
  'login.txt': `局域网：http://${host}:${port}\nTailscale：http://${tailscaleHost}:${port}\n账号：${username}\n密码：${password}\n`,
};
// Reject all preexisting files before writing any credentials; never rotate them implicitly.
for (const name of Object.keys(files)) {
  try {
    await lstat(join(directory, name));
    throw new Error('Partial instance exists; inspect before retrying');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
for (const [name, value] of Object.entries(files))
  await writeFile(join(directory, name), value, { mode: 0o600, flag: 'wx' });
await writeFile(marker, JSON.stringify(desired), { mode: 0o600, flag: 'wx' });
console.log(`${username}: created; credentials in ${directory}/login.txt (not printed)`);
