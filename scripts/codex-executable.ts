import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_CODEX_VERSION } from '../packages/provider-codex/src/protocol.ts';

/** Prefer the deployed executable; never silently use an older global CLI. */
export async function codexExecutable(options: { explicit?: string; configured?: boolean } = {}) {
  const explicit = options.explicit ?? process.env.WORKBENCH_CODEX_EXECUTABLE;
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('Codex 可执行文件必须使用绝对路径');
    return explicit;
  }
  if (options.configured) {
    try {
      const config = JSON.parse(await readFile(new URL('../.runtime/agent.json', import.meta.url), 'utf8'));
      if (typeof config.codexExecutable === 'string' && config.codexExecutable) return config.codexExecutable;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const local = fileURLToPath(new URL(`../.runtime/codex/${SUPPORTED_CODEX_VERSION}/codex`, import.meta.url));
  try {
    await access(local, constants.X_OK);
    return local;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const { stdout } = await promisify(execFile)('/usr/bin/env', ['sh', '-c', 'command -v codex']);
  return stdout.trim();
}

export async function validateCodexExecutable(executable: string) {
  const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 10000 });
  if (stdout.trim() !== `codex-cli ${SUPPORTED_CODEX_VERSION}`)
    throw new Error(
      `Codex 版本不匹配：需要 ${SUPPORTED_CODEX_VERSION}，实际 ${stdout.trim()}。使用 --codex /绝对路径/codex 指定已验证版本。`,
    );
  return executable;
}
