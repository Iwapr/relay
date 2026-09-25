import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marker, serviceLocation, unitText, run } from './service-utils.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = join(root, '.runtime');
const units = ['remote-workbench-agent.service', 'remote-workbench-gateway.service'];
const command = process.argv[2] ?? 'status';
function foreground(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, PATH: `${join(root, 'node_modules/node/bin')}:${process.env.PATH ?? ''}` },
    });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.once('error', reject);
    child.once('exit', (code) => {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      code === 0 || code === null ? resolve() : reject(new Error(`命令退出：${code}`));
    });
  });
}
async function managedServices() {
  let installed = 0;
  for (const component of ['agent', 'gateway'] as const) {
    let text: string;
    try {
      text = await readFile(serviceLocation(component).path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const expected = unitText(component, join(runtime, `${component}.json`), process.execPath);
    const configLine = expected
      .split('\n')
      .find((line) => line.startsWith('Environment=') && line.includes('_CONFIG='));
    if (!text.startsWith(marker) || !configLine || !text.split('\n').includes(configLine))
      throw new Error('同名服务属于其他部署，请使用该部署的管理方式，避免操作错误实例。');
    installed++;
  }
  if (installed === 1) throw new Error('后台服务安装不完整；使用 ./relay service 补全。');
  return installed === 2;
}
async function main() {
  if (!['start', 'stop', 'restart', 'status', 'logs', 'info', 'service'].includes(command))
    throw new Error('用法：./relay start|stop|restart|status|logs|info|service');
  const config = JSON.parse(
    await readFile(join(runtime, 'gateway.json'), 'utf8').catch(() => {
      throw new Error('请先运行 ./install.sh');
    }),
  );
  if (command === 'info') {
    console.log(await readFile(join(runtime, 'login.txt'), 'utf8'));
    return;
  }
  if (command === 'service') {
    // Refuse units for another project before the install helper can replace them.
    try {
      await managedServices();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('安装不完整')) throw error;
    }
    for (const component of ['agent', 'gateway'])
      await foreground(process.execPath, [
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
    await writeFile(join(runtime, 'install-mode'), 'systemd\n', { mode: 0o600 });
    console.log('后台服务已安装。使用 ./relay status 查看状态。');
    return;
  }
  const mode = await readFile(join(runtime, 'install-mode'), 'utf8').catch(() => '');
  const managed = mode.trim() === 'foreground' ? false : await managedServices();
  if (!managed) {
    if (command === 'start') {
      await foreground(process.execPath, ['--import', 'tsx', 'scripts/dev.ts']);
      return;
    }
    if (command === 'status') {
      try {
        const response = await fetch(`${config.publicOrigin}/health`, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error();
        console.log(`Relay 正在运行：${config.publicOrigin}`);
      } catch {
        console.log('Relay 尚未运行。使用 ./relay start 启动。');
      }
      return;
    }
    throw new Error(
      '当前为前台模式：在运行窗口按 Ctrl+C 停止；./relay start 启动。安装后台服务使用 ./relay service。',
    );
  }
  if (command === 'logs') {
    await foreground('journalctl', ['--user', '-u', units[0], '-u', units[1], '-n', '80', '-f']);
    return;
  }
  if (command === 'status') {
    await foreground('systemctl', ['--user', 'status', ...units, '--no-pager']);
    return;
  }
  if (command === 'stop' || command === 'restart')
    await run('systemctl', ['--user', 'stop', units[1], units[0]]);
  if (command === 'start' || command === 'restart') {
    await run('systemctl', ['--user', 'start', units[0]]);
    await run('systemctl', ['--user', 'start', units[1]]);
    console.log(`服务已启动：${config.publicOrigin}`);
  } else console.log('服务已停止。');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
