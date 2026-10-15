import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
  access,
  readdir,
  readlink,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const providerPackages = [
  '@openai/codex',
  '@anthropic-ai/claude-code',
  '@moonshot-ai/kimi-code',
  '@factory/droid-sdk',
  'droid',
  '@deepseek-ai/dsh',
];
type Runner = (command: string, args: string[], cwd: string) => Promise<void>;
const sourceFiles = [
  'apps',
  'packages',
  'generated',
  'scripts',
  'tests',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'playwright.config.ts',
];

async function sourceDigest(root: string) {
  const hash = createHash('sha256');
  async function visit(path: string) {
    const entries = await readdir(join(root, path), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'dist', '__pycache__'].includes(entry.name)) continue;
      const name = join(path, entry.name);
      hash.update(name + '\0');
      if (entry.isDirectory()) await visit(name);
      else
        hash.update(
          entry.isSymbolicLink() ? await readlink(join(root, name)) : await readFile(join(root, name)),
        );
    }
  }
  for (const name of sourceFiles) {
    hash.update(name + '\0');
    if (name.includes('.')) hash.update(await readFile(join(root, name)));
    else await visit(name);
  }
  return hash.digest('hex');
}
export function runUpdateCommand(
  command: string,
  args: string[],
  cwd: string,
  logPath?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const log = logPath ? createWriteStream(logPath, { flags: 'a', mode: 0o600 }) : undefined;
    log?.write(`\n$ ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, {
      cwd,
      stdio: log ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, PATH: `${join(cwd, 'node_modules/.bin')}:${process.env.PATH ?? ''}` },
    });
    log?.once('error', (error) => {
      child.kill('SIGTERM');
      reject(error);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      log?.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      log?.write(chunk);
    });
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code) => {
      const finish = () => {
        const error =
          spawnError ?? (code === 0 ? undefined : new Error(`${command} ${args.join(' ')} 退出：${code}`));
        if (error)
          reject(new Error(`${error.message}${logPath ? `；完整输出：${logPath}` : ''}`, { cause: error }));
        else resolve();
      };
      if (log) log.end(finish);
      else finish();
    });
  });
}
const run: Runner = runUpdateCommand;

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

export async function requireStopped(root: string) {
  const path = join(root, '.runtime/agent.json');
  if (!(await exists(path))) return;
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!config.socketPath) return;
  await new Promise<void>((resolve, reject) => {
    const socket = connect(config.socketPath);
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      reject(
        new Error(
          '请先停止当前配置对应的 Relay：独立服务用 ./relay stop，共享部署停止 relay@用户，前台模式按 Ctrl+C',
        ),
      );
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('无法确认 Agent 已停止，未更新依赖'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')) resolve();
      else reject(error);
    });
  });
}

/** Stage dependencies and validate before replacing a stopped source installation.
 * Published relay@user releases have their own immutable dependency snapshots.
 */
export async function updateProviders(root: string, runner: Runner = run, checkOnly = false, shared = false) {
  // Shared services execute immutable releases, not this source tree.
  // The administrator's shared update command checks those services before activation.
  if (!checkOnly && !shared) await requireStopped(root);
  const runtime = join(root, '.runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const lock = join(runtime, 'provider-update.lock');
  await mkdir(lock).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error('另一个客户端更新正在运行；若上次异常退出，请检查 .runtime/provider-update.lock');
    throw error;
  });
  let staging: string | undefined;
  let preserveRecovery = false;
  let activated = false;
  try {
    if (runner === run) {
      const logPath = join(runtime, `provider-update-${new Date().toISOString().replaceAll(':', '-')}.log`);
      console.log(`本次更新日志：${logPath}`);
      runner = (command, args, cwd) => runUpdateCommand(command, args, cwd, logPath);
    }
    const originalDigest = await sourceDigest(root);
    staging = await mkdtemp(join(runtime, 'provider-update-'));
    for (const name of sourceFiles) await cp(join(root, name), join(staging, name), { recursive: true });
    console.log('正在获取官方客户端最新稳定版，并在临时目录验证…');
    await runner(
      'npm',
      [
        'install',
        '--save-exact',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org',
        ...providerPackages.map((name) => `${name}@latest`),
      ],
      staging,
    );
    await runner(process.execPath, ['--import', 'tsx', 'scripts/validate-providers.ts'], staging);
    if (shared) {
      const destination = join(staging, '.runtime/shared-providers');
      await runner(
        process.execPath,
        ['--import', 'tsx', 'scripts/install-gemini.ts', '--destination', destination],
        staging,
      );
      await runner(join(destination, 'agy'), ['--version'], staging);
    }
    await runner('npm', ['run', 'build'], staging);
    await runner('npm', ['exec', '--', 'tsx', '--test', 'tests/provider/*.test.ts'], staging);
    if (checkOnly) {
      console.log('最新客户端验证通过；仅检查，未替换当前安装或重启服务。');
      return;
    }
    // Ensure a source instance was not started while downloading/building.
    if (!shared) await requireStopped(root);
    if ((await sourceDigest(root)) !== originalDigest)
      throw new Error('验证期间源码发生变化，未替换安装；保存修改后重新运行 ./relay update');
    const replacements = ['node_modules', 'package.json', 'package-lock.json', 'apps/web/dist'];
    if (shared) replacements.push('.runtime/shared-providers');
    const configPath = join(root, '.runtime/agent.json');
    if (!shared && (await exists(configPath))) {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.codexExecutable = join(root, 'node_modules/.bin/codex');
      await mkdir(join(staging, '.runtime'), { recursive: true });
      await writeFile(join(staging, '.runtime/agent.json'), JSON.stringify(config, null, 2) + '\n', {
        mode: 0o600,
      });
      replacements.push('.runtime/agent.json');
    }
    const backup = join(staging, 'previous');
    const moved: { name: string; saved: boolean; installed: boolean }[] = [];
    try {
      for (const name of replacements) {
        const entry = { name, saved: false, installed: false };
        moved.push(entry);
        await mkdir(resolve(backup, name, '..'), { recursive: true });
        if (await exists(join(root, name))) {
          await rename(join(root, name), join(backup, name));
          entry.saved = true;
        }
        await mkdir(resolve(root, name, '..'), { recursive: true });
        await rename(join(staging, name), join(root, name));
        entry.installed = true;
      }
    } catch (error) {
      try {
        for (const entry of moved.reverse()) {
          if (entry.installed) await rm(join(root, entry.name), { recursive: true, force: true });
          if (entry.saved) await rename(join(backup, entry.name), join(root, entry.name));
        }
      } catch (recoveryError) {
        preserveRecovery = true;
        throw new AggregateError([error, recoveryError], `替换失败，恢复文件保留在 ${backup}`);
      }
      throw error;
    }
    activated = true;
    console.log('Codex、Claude、Kimi、Droid 和 DeepSeek 已更新并通过验证。');
    if (shared) {
      console.log('Antigravity 已暂存为共享版本，等待管理员统一发布；各用户凭据未修改。');
      return;
    }
    // Antigravity is distributed by Google, outside npm. Use its official updater.
    const config = (await exists(configPath)) ? JSON.parse(await readFile(configPath, 'utf8')) : {};
    const geminiPaths = new Set<string>([
      ...(config.antigravityExecutable ? [config.antigravityExecutable] : []),
      join(root, '.runtime/antigravity/agy'),
      join(homedir(), '.local/bin/agy'),
    ]);
    let updatedGemini = false;
    for (const gemini of geminiPaths) {
      if (!(await exists(gemini))) continue;
      console.log(`正在通过官方更新器更新 Antigravity：${gemini}`);
      await runner(gemini, ['update'], root);
      updatedGemini = true;
    }
    if (!updatedGemini) console.log('未找到已安装的 Antigravity，跳过；首次安装用 npm run install:gemini。');
    console.log(
      '更新完成。独立服务运行 ./relay start；共享部署在任务结束后重启 relay@用户，以发布并加载新版。',
    );
  } catch (error) {
    const state = preserveRecovery
      ? '更新失败，自动恢复未完成。'
      : activated
        ? 'npm 客户端已更新，但后续更新未完成。'
        : '更新失败，未安装新版客户端；原有客户端保持不变。';
    throw new Error(`${state}\n${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    if (staging && !preserveRecovery) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await updateProviders(
    resolve(import.meta.dirname, '..'),
    run,
    process.argv.includes('--check'),
    process.argv.includes('--shared'),
  );
