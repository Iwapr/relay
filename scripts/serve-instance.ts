/** Both components of one relay@user instance, running as that ordinary user. */
import { chmod, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AgentConfigSchema } from '../apps/agent/src/config.ts';
import { buildAgent } from '../apps/agent/src/server.ts';
import { gatewayConfigSchema } from '../apps/gateway/src/config.ts';
import { startGateway } from '../apps/gateway/src/listeners.ts';

const instanceSchema = z
  .object({
    user: z.string(),
    agentConfig: z.string().startsWith('/'),
    gatewayConfig: z.string().startsWith('/'),
    tailscaleProxyOrigin: z.string().optional(),
  })
  .strict();

async function privateConfig(path: string) {
  const st = await lstat(path);
  if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    throw new Error(`Configuration must be a private file owned by the service user: ${path}`);
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function instanceConfigs(descriptor: string, release: string) {
  const instance = instanceSchema.parse(JSON.parse(await readFile(descriptor, 'utf8')));
  if (process.getuid?.() === 0 || instance.user !== userInfo().username)
    throw new Error('Run this instance as its configured ordinary Linux user');
  const agent = AgentConfigSchema.parse({
    ...(await privateConfig(instance.agentConfig)),
    codexExecutable: join(release, 'codex/codex'),
  });
  const gateway = gatewayConfigSchema.parse({
    ...(await privateConfig(instance.gatewayConfig)),
    staticDir: join(release, 'apps/web/dist'),
    ...(instance.tailscaleProxyOrigin ? { tailscaleProxyOrigin: instance.tailscaleProxyOrigin } : {}),
  });
  return {
    agent,
    gateway,
    gatewayConfigPath: instance.tailscaleProxyOrigin ? undefined : instance.gatewayConfig,
  };
}

export async function startInstance(descriptor: string, release: string) {
  process.umask(0o077);
  const { agent, gateway, gatewayConfigPath } = await instanceConfigs(descriptor, release);
  await mkdir(dirname(agent.socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(agent.socketPath), 0o700);
  // Check before constructing the Agent: recovery must not touch another live instance's DB.
  try {
    const st = await lstat(agent.socketPath);
    if (!st.isSocket()) throw new Error('Agent socket path is occupied by a non-socket file');
    const live = await new Promise<boolean>((resolve, reject) => {
      const socket = connect(agent.socketPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') resolve(false);
        else reject(e);
      });
    });
    if (live) throw new Error('An Agent is already using this instance; stop its old service first');
    await unlink(agent.socketPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const { app } = await buildAgent(agent);
  let frontend: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    await app.listen({ path: agent.socketPath });
    await chmod(agent.socketPath, 0o600);
    frontend = await startGateway(gateway, gatewayConfigPath);
  } catch (e) {
    await app.close();
    throw e;
  }
  let closing: Promise<void> | undefined;
  return {
    addresses: frontend.addresses,
    close: () =>
      (closing ??= (async () => {
        const results = await Promise.allSettled([frontend!.close(), app.close()]);
        const failure = results.find((r) => r.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })()),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const descriptor = process.env.RELAY_INSTANCE;
  if (!descriptor) throw new Error('RELAY_INSTANCE is required');
  const release = resolve(dirname(process.argv[1]), '..');
  if (process.argv.includes('--check')) {
    await instanceConfigs(descriptor, release);
    console.log('Relay instance configuration verified');
  } else {
    const instance = await startInstance(descriptor, release);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        if (stopping) return;
        stopping = true;
        void instance.close().then(
          () => process.exit(0),
          (e) => {
            console.error(e);
            process.exit(1);
          },
        );
      });
    console.log(`Relay ready for ${userInfo().username}: ${instance.addresses.join(', ')}`);
    if (process.env.NOTIFY_SOCKET) {
      try {
        await promisify(execFile)('/usr/bin/systemd-notify', ['--ready', '--status=Agent and Gateway ready']);
      } catch (e) {
        await instance.close();
        throw e;
      }
    }
  }
}
