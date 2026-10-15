import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

/** Resolve the installed package, including native and JavaScript CLI distributions. */
export function packageRuntime(name: string, command: string) {
  const manifest = require.resolve(`${name}/package.json`);
  const pkg = require(manifest);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[command];
  if (!bin) throw new Error(`${name} does not provide ${command}`);
  return { executable: resolve(dirname(manifest), bin), version: String(pkg.version) };
}

export function optionalPackageRuntime(name: string, command: string) {
  try {
    return packageRuntime(name, command);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    return undefined;
  }
}
