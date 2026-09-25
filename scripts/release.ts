import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const output = `artifacts/remote-workbench-${pkg.version}.tar.gz`;
await mkdir('artifacts', { recursive: true });
const files = [
  'examples',
  'apps',
  'packages',
  'generated',
  'deploy',
  'docs',
  'scripts',
  'install.sh',
  'relay',
  'tests',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'playwright.config.ts',
  'README.md',
  'plan.md',
  '.gitignore',
  '.prettierignore',
  '.prettierrc.json',
];
await exec('tar', ['--exclude=apps/web/dist', '--exclude=__pycache__', '-czf', output, ...files], {
  maxBuffer: 1024 * 1024,
});
const sha = createHash('sha256')
  .update(await readFile(output))
  .digest('hex');
await writeFile(output + '.sha256', `${sha}  ${output.split('/').at(-1)}\n`);
console.log(
  `发行源码包：${output}\nSHA-256：${sha}\n不包含本地凭据、项目内容、node_modules 或 .runtime。目标环境使用 Node24 执行 npm ci && npm run build。`,
);
