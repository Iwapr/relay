/** Installs only the official, reviewed CLI release; never alters shell profiles. */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { ANTIGRAVITY_VERSION } from '../packages/provider-gemini/src/index.ts';
const run = promisify(execFile);
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('此安装脚本目前支持 Linux x64；其他平台请使用官方安装器并配置 antigravityExecutable');
const url = `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.13-6662628811079680/linux-x64/cli_linux_x64.tar.gz`;
const expected =
  '7a10134a69c575dc11bdc721322344e9db3bf2c9d890f2d40ff0bffda93d39b6ef1c7c486f491d1ddf08b123deef375c7bbe46b62cd3fbc3cc956b1a3bd22956';
const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Antigravity 下载失败：${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha512').update(archive).digest('hex') !== expected)
  throw new Error('Antigravity 校验失败，未安装');
const staging = await mkdtemp(join(tmpdir(), 'relay-agy-install-'));
// Service releases exclude .runtime; keep the CLI outside versioned code.
const destination = join(homedir(), '.local', 'bin');
try {
  await writeFile(join(staging, 'release.tar.gz'), archive);
  await run('tar', ['-xzf', join(staging, 'release.tar.gz'), '-C', staging, 'antigravity']);
  await mkdir(destination, { recursive: true });
  // Staging on the target filesystem allows atomic replacement.
  const { readFile } = await import('node:fs/promises');
  const target = join(destination, 'agy.new');
  await writeFile(target, await readFile(join(staging, 'antigravity')), { mode: 0o755 });
  await chmod(target, 0o755);
  await rename(target, join(destination, 'agy'));
  console.log(`已安装 Antigravity CLI ${ANTIGRAVITY_VERSION}，SHA-512 校验通过。`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
