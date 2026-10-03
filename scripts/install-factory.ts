import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { FACTORY_VERSION, factoryExecutable } from '../packages/provider-factory/src/index.ts';
const prefix = join(homedir(), '.local/share/relay/factory', FACTORY_VERSION);
mkdirSync(prefix, { recursive: true, mode: 0o700 });
const result = spawnSync(
  'npm',
  [
    'install',
    '--registry=https://registry.npmjs.org',
    '--prefix',
    prefix,
    '--save-exact',
    `droid@${FACTORY_VERSION}`,
  ],
  { stdio: 'inherit' },
);
if (result.error || result.status !== 0) throw new Error('Factory Droid 安装失败，请检查 npm 与网络');
const check = spawnSync(factoryExecutable(), ['--version'], { encoding: 'utf8', timeout: 15000 });
if (check.error || check.status !== 0 || !check.stdout.includes(FACTORY_VERSION))
  throw new Error('Factory Droid 可执行文件验证失败，请检查系统架构与安装日志');
console.log(`Factory 官方 Droid ${FACTORY_VERSION} 已安装：${factoryExecutable()}`);
