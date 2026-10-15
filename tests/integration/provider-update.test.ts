import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  providerPackages,
  requireStopped,
  updateProviders,
  runUpdateCommand,
} from '../../scripts/update-providers.ts';
import { validateCodexVersion } from '../../packages/provider-codex/src/protocol.ts';

async function source() {
  const root = await mkdtemp(join(tmpdir(), 'relay-update-test-'));
  for (const name of [
    'apps/web/dist',
    'packages',
    'generated',
    'scripts',
    'tests',
    'node_modules',
    '.runtime/antigravity',
    '.runtime',
  ])
    await mkdir(join(root, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'playwright.config.ts'])
    await writeFile(join(root, name), '{}');
  await writeFile(join(root, 'node_modules/marker'), 'old runtime');
  await writeFile(join(root, '.runtime/antigravity/agy'), 'fixture');
  await writeFile(join(root, 'apps/web/dist/index.html'), 'old frontend');
  await writeFile(
    join(root, '.runtime/agent.json'),
    JSON.stringify({ codexExecutable: '/old/codex', tokenFile: '/keep/token' }),
    { mode: 0o600 },
  );
  return root;
}

test('Codex permits newer releases while rejecting obsolete or invalid binaries', () => {
  for (const version of ['0.154.0-alpha.6.2', '0.160.0', '0.162.0-alpha.14', '1.0.0'])
    assert.doesNotThrow(() => validateCodexVersion(`codex-cli ${version}`));
  for (const version of ['codex-cli 0.133.0', 'claude 1.0.0', 'codex-cli unknown'])
    assert.throws(() => validateCodexVersion(version));
});

for (const failure of [
  'download',
  'validation',
  'build',
  'tests',
  'activation',
  'source-change',
  'none',
  'check',
]) {
  test(`provider update preserves old installation on ${failure}`, async () => {
    const root = await source();
    const calls: string[] = [];
    try {
      const runner = async (command: string, args: string[], cwd: string) => {
        const step =
          args[0] === 'install'
            ? 'download'
            : args.includes('scripts/validate-providers.ts')
              ? 'validation'
              : args.includes('build')
                ? 'build'
                : args.includes('--test')
                  ? 'tests'
                  : 'gemini';
        calls.push(step);
        if (step === failure) throw new Error(`fixture ${failure}`);
        if (step === 'download') {
          for (const pkg of providerPackages) assert(args.includes(`${pkg}@latest`));
          await mkdir(join(cwd, 'node_modules'));
          await writeFile(join(cwd, 'node_modules/marker'), 'new runtime');
          await writeFile(join(cwd, 'package.json'), '{"new":true}');
          await writeFile(join(cwd, 'package-lock.json'), '{"new":true}');
        }
        if (step === 'build') await writeFile(join(cwd, 'apps/web/dist/index.html'), 'new frontend');
        if (step === 'tests' && failure === 'activation') await rm(join(cwd, 'package-lock.json'));
        if (step === 'tests' && failure === 'source-change')
          await writeFile(join(root, 'apps/concurrent-edit.ts'), '// saved while updating');
      };
      if (failure === 'none' || failure === 'check') await updateProviders(root, runner, failure === 'check');
      else await assert.rejects(updateProviders(root, runner));
      const updated = failure === 'none';
      assert.equal(
        await readFile(join(root, 'node_modules/marker'), 'utf8'),
        updated ? 'new runtime' : 'old runtime',
      );
      assert.equal(
        await readFile(join(root, 'apps/web/dist/index.html'), 'utf8'),
        updated ? 'new frontend' : 'old frontend',
      );
      const config = JSON.parse(await readFile(join(root, '.runtime/agent.json'), 'utf8'));
      assert.equal(config.codexExecutable, updated ? join(root, 'node_modules/.bin/codex') : '/old/codex');
      assert.equal(config.tokenFile, '/keep/token');
      if (!updated) assert.equal(await readFile(join(root, 'package.json'), 'utf8'), '{}');
      await assert.rejects(access(join(root, '.runtime/provider-update.lock')));
      if (failure === 'check') assert.deepEqual(calls, ['download', 'validation', 'build', 'tests']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('updater rejects a live source Agent before modifying dependencies', async () => {
  const root = await source();
  const server = createServer((socket) => socket.end());
  try {
    const socketPath = join(root, '.runtime/agent.sock');
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await writeFile(join(root, '.runtime/agent.json'), JSON.stringify({ socketPath }));
    await assert.rejects(requireStopped(root), /请先停止/);
    assert.equal(await readFile(join(root, 'node_modules/marker'), 'utf8'), 'old runtime');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('failed update commands preserve stdout and stderr with the failure log path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-update-log-'));
  const logPath = join(root, 'update.log');
  try {
    await assert.rejects(
      runUpdateCommand(
        process.execPath,
        ['-e', "console.log('test stdout'); console.error('test failure details'); process.exitCode = 7"],
        root,
        logPath,
      ),
      (error: Error) => error.message.includes(logPath) && error.message.includes('7'),
    );
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /test stdout/);
    assert.match(log, /test failure details/);
    await assert.rejects(runUpdateCommand(join(root, 'missing-command'), [], root, logPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const failGoogle of [false, true]) {
  test(`shared update stages Google with npm clients and preserves private configuration (failure=${failGoogle})`, async () => {
    const root = await source();
    const original = await readFile(join(root, '.runtime/agent.json'), 'utf8');
    const server = createServer((socket) => socket.end());
    try {
      const socketPath = join(root, '.runtime/shared-live.sock');
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const config = JSON.stringify({ ...JSON.parse(original), socketPath });
      await writeFile(join(root, '.runtime/agent.json'), config);
      const runner = async (_command: string, args: string[], cwd: string) => {
        if (args[0] === 'install') {
          await mkdir(join(cwd, 'node_modules'));
          await writeFile(join(cwd, 'node_modules/marker'), 'new runtime');
        }
        if (args.includes('scripts/install-gemini.ts')) {
          if (failGoogle) throw new Error('Google download failed');
          const destination = args[args.indexOf('--destination') + 1]!;
          assert(destination.startsWith(cwd));
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, 'agy'), 'shared google');
        }
      };
      if (failGoogle)
        await assert.rejects(updateProviders(root, runner, false, true), /Google download failed/);
      else await updateProviders(root, runner, false, true);
      assert.equal(await readFile(join(root, '.runtime/agent.json'), 'utf8'), config);
      assert.equal(
        await readFile(join(root, 'node_modules/marker'), 'utf8'),
        failGoogle ? 'old runtime' : 'new runtime',
      );
      if (!failGoogle)
        assert.equal(await readFile(join(root, '.runtime/shared-providers/agy'), 'utf8'), 'shared google');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
