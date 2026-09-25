import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { gatewayConfigSchema } from '../apps/gateway/src/config.ts';
import { AgentConfigSchema } from '../apps/agent/src/config.ts';
export const run = promisify(execFile);
export const marker = '# Managed by Remote Workbench install-service.ts; no other services are modified.';
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export type Component = 'agent' | 'gateway';
export function serviceArgs(args: string[]): {
  component: Component;
  configPath: string;
  nodePath: string;
  apply: boolean;
  start: boolean;
  allowInterruption: boolean;
} {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--apply', '--start', '--allow-interruption'].includes(key)) {
      flags.add(key);
      continue;
    }
    if (!['--component', '--config', '--node'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error(
        'Usage: --component agent|gateway --config /absolute/config.json --node /absolute/node24 [--apply] [--start] [--allow-interruption]',
      );
    values.set(key, args[++i]);
  }
  const component = values.get('--component');
  const configPath = values.get('--config');
  const nodePath = values.get('--node');
  if (
    !['agent', 'gateway'].includes(component ?? '') ||
    !configPath ||
    !nodePath ||
    !isAbsolute(configPath) ||
    !isAbsolute(nodePath)
  )
    throw new Error('Explicit component, absolute config path and absolute Node 24 path are required.');
  return {
    component: component as Component,
    configPath,
    nodePath,
    apply: flags.has('--apply'),
    start: flags.has('--start'),
    allowInterruption: flags.has('--allow-interruption'),
  };
}
export function quoteUnit(value: string): string {
  if (/[\x00\r\n]/.test(value)) throw new Error('Service paths cannot contain control characters.');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
}
/** WorkingDirectory does not unquote or unescape strings like ExecStart and Environment do. */
export function workingDirectoryValue(value: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('The working directory must be an absolute path without control characters.');
  const escaped = value.replaceAll('%', '%%');
  // A final backslash continues the unit-file line; final spaces are stripped by its INI parser.
  // A trailing slash preserves both characters and refers to the same directory.
  return /[\\ ]$/.test(escaped) ? escaped + '/' : escaped;
}
export function unitText(component: Component, configPath: string, nodePath: string): string {
  return `${marker}\n[Unit]\nDescription=Remote Workbench ${component === 'agent' ? 'Workspace Agent' : 'Gateway'}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${workingDirectoryValue(repo)}\nEnvironment=${quoteUnit(`${component === 'agent' ? 'AGENT' : 'GATEWAY'}_CONFIG=${configPath}`)}\nEnvironment=${quoteUnit(`PATH=${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`)}\nExecStart=${quoteUnit(nodePath.replaceAll('$', () => '$$'))} --import tsx ${quoteUnit(join(repo, 'apps', component, 'src/main.ts').replaceAll('$', () => '$$'))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\nKillMode=mixed\nUMask=0077\nNoNewPrivileges=false\n\n[Install]\nWantedBy=default.target\n`;
}
export function serviceLocation(component: Component) {
  return {
    name: `remote-workbench-${component}.service`,
    path: join(homedir(), '.config/systemd/user', `remote-workbench-${component}.service`),
  };
}
export async function validateInstall(component: Component, configPath: string, nodePath: string) {
  if (process.getuid?.() === 0)
    throw new Error('Run as the intended ordinary Linux user, not root. No sudo is performed.');
  const st = await lstat(configPath);
  if (!st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())
    throw new Error('The service configuration must be an owned regular file with mode 0600 or 0400.');
  const data = JSON.parse(await readFile(configPath, 'utf8'));
  if (component === 'agent') AgentConfigSchema.parse(data);
  else gatewayConfigSchema.parse(data);
  const { stdout } = await run(nodePath, ['--version']);
  if (!/^v24\./.test(stdout)) throw new Error('The configured runtime must be Node.js 24 LTS.');
  await run('systemctl', ['--user', 'show-environment']);
  return data as Record<string, unknown>;
}

/** Atomic and idempotent; only units bearing our marker may be replaced. */
export async function writeManagedUnit(path: string, text: string): Promise<boolean> {
  const { mkdir, writeFile, rename, unlink } = await import('node:fs/promises');
  const old = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  if (old && !old.startsWith(marker)) throw new Error(`Refusing to overwrite an unmanaged unit: ${path}`);
  if (old === text) return false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + `.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return true;
}
