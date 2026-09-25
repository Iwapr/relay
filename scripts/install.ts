import { managementHelp } from './management-help.ts';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces, userInfo } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_CODEX_VERSION } from '../packages/provider-codex/src/protocol.ts';
import { codexExecutable, validateCodexExecutable } from './codex-executable.ts';
import { selectLanAddress } from './lan-address.ts';
import { isPrivateIPv4 } from '../apps/gateway/src/config.ts';
import { installOptions } from './install-options.ts';
import { serviceLocation } from './service-utils.ts';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = join(root, '.runtime');
const options = installOptions(process.argv.slice(2));
const env = { ...process.env, PATH: `${join(root, 'node_modules/node/bin')}:${process.env.PATH ?? ''}` };
async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} 执行失败（${code}）`)),
    );
  });
}
async function main() {
  if (process.getuid?.() === 0) throw new Error('请使用普通 Linux 用户安装。');
  for (const name of ['agent.json', 'gateway.json']) {
    try {
      await access(join(runtime, name));
    } catch {
      continue;
    }
    throw new Error('发现已有或部分初始化配置；保留原文件，请使用 ./relay status，或检查 .runtime 后重试。');
  }
  if (!options.foreground) {
    for (const component of ['agent', 'gateway'] as const) {
      try {
        await access(serviceLocation(component).path);
      } catch {
        continue;
      }
      throw new Error('已有同名用户服务，请从原项目管理；新部署可使用 --foreground，避免覆盖其他实例。');
    }
  }
  if (!(await stat(options.root ?? homedir())).isDirectory())
    throw new Error('项目根目录必须是已存在的目录。');
  let host: string;
  try {
    host = selectLanAddress(options.host);
  } catch (error) {
    if (options.host || options.yes || !process.stdin.isTTY) throw error;
    const addresses = [
      ...new Set(
        Object.values(networkInterfaces()).flatMap((entries) =>
          (entries ?? [])
            .filter((e) => e.family === 'IPv4' && !e.internal && isPrivateIPv4(e.address))
            .map((e) => e.address),
        ),
      ),
    ];
    if (!addresses.length) throw error;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('检测到多个局域网地址，请选择要使用的网卡：');
      addresses.forEach((address, index) => console.log(`  ${index + 1}. ${address}`));
      const selected = await prompt.question('输入序号：');
      const candidate = /^\d+$/.test(selected) ? addresses[Number(selected) - 1] : undefined;
      if (!candidate) throw new Error('无效选择，请重新运行安装器。');
      host = selectLanAddress(candidate);
    } finally {
      prompt.close();
    }
  }
  const canBind = (port: number) =>
    new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
  let port = options.port ?? 4080;
  while (!(await canBind(port))) {
    if (options.port || port >= 4100) throw new Error('监听地址或端口不可用，请通过 --host / --port 指定。');
    port++;
  }
  console.log(`局域网入口：http://${host}:${port}`);
  let codex: string;
  if (options.codex) codex = await validateCodexExecutable(options.codex);
  else {
    try {
      codex = await validateCodexExecutable(await codexExecutable());
    } catch {
      const prefix = join(runtime, 'tools/codex');
      codex = join(prefix, 'node_modules/.bin/codex');
      try {
        await validateCodexExecutable(codex);
      } catch {
        console.log(`正在安装官方 Codex CLI ${SUPPORTED_CODEX_VERSION}（仅当前项目使用）…`);
        await mkdir(prefix, { recursive: true, mode: 0o700 });
        await run('npm', [
          'install',
          '--prefix',
          prefix,
          '--no-audit',
          '--no-fund',
          '--save-exact',
          '--registry',
          'https://registry.npmjs.org',
          `@openai/codex@${SUPPORTED_CODEX_VERSION}`,
        ]);
        await validateCodexExecutable(codex);
      }
    }
  }
  console.log('正在构建工作台…');
  await run('npm', ['run', 'build']);
  await run(process.execPath, [
    '--import',
    'tsx',
    'scripts/setup.ts',
    '--host',
    host,
    '--port',
    String(port),
    '--root',
    options.root ?? homedir(),
    '--codex',
    codex,
  ]);
  let systemd = !options.foreground;
  if (systemd) {
    try {
      await exec('systemctl', ['--user', 'show-environment']);
    } catch {
      systemd = false;
    }
  }
  await writeFile(join(runtime, 'install-mode'), systemd ? 'systemd\n' : 'foreground\n', { mode: 0o600 });
  if (systemd) {
    for (const component of ['agent', 'gateway']) {
      await run(process.execPath, [
        '--import',
        'tsx',
        'scripts/install-service.ts',
        '--component',
        component,
        '--config',
        join(runtime, `${component}.json`),
        '--node',
        process.execPath,
        '--apply',
        '--start',
      ]);
      if (component === 'agent') {
        const config = JSON.parse(await readFile(join(runtime, 'agent.json'), 'utf8'));
        let ready = false;
        for (let attempt = 0; attempt < 100 && !ready; attempt++) {
          ready = await new Promise<boolean>((resolve) => {
            const socket = connect(config.socketPath);
            socket.once('connect', () => {
              socket.destroy();
              resolve(true);
            });
            socket.once('error', () => resolve(false));
          });
          if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!ready) throw new Error('Agent 未就绪，请用 ./relay logs 查看日志。');
      }
    }
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt++) {
      try {
        ready = (await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) })).ok;
      } catch {}
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!ready) throw new Error('Gateway 未就绪，请用 ./relay logs 查看日志。');
  }
  console.log(
    `\n${systemd ? 'Relay 已在后台启动。' : '安装完成。运行 ./relay start 前台启动，保持终端开启。'}\n访问地址：http://${host}:${port}\n登录账号：owner\n查看随机密码：./relay info\n首次使用：右上角菜单 → 账号管理 → 添加账号并授权。`,
  );
  console.log('\n' + managementHelp(systemd ? 'systemd' : 'foreground'));
  if (systemd) {
    let linger = false;
    try {
      linger =
        (
          await exec('loginctl', ['show-user', String(process.getuid!()), '-p', 'Linger', '--value'])
        ).stdout.trim() === 'yes';
    } catch {}
    if (!linger)
      console.log(
        `\n若要退出登录后继续运行并随系统启动，请执行：\nsudo loginctl enable-linger ${userInfo().username}\n（这是系统账户设置，需要管理员权限。）`,
      );
  }
}
main().catch((error) => {
  console.error(
    `安装未完成：${error.message}\n已有配置和日志保留在 .runtime，请修复原因后按 docs/quickstart.md 恢复。`,
  );
  process.exitCode = 1;
});
