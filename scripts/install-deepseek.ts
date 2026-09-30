import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEEPSEEK_HARNESS_VERSION, deepseekExecutable } from '../packages/provider-deepseek/src/index.ts';
const prefix = join(homedir(), '.local/share/relay/deepseek', DEEPSEEK_HARNESS_VERSION);
mkdirSync(prefix, { recursive: true, mode: 0o700 });
const result = spawnSync(
  'npm',
  ['install', '--prefix', prefix, '--save-exact', `@deepseek-ai/dsh@${DEEPSEEK_HARNESS_VERSION}`],
  { stdio: 'inherit' },
);
if (result.error || result.status !== 0) throw new Error('DeepSeek Harness 安装失败，请检查 npm 与网络');
console.log(`DeepSeek 官方 Harness ${DEEPSEEK_HARNESS_VERSION} 已安装：${deepseekExecutable()}`);
