import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import {
  quoteUnit,
  repo,
  serviceArgs,
  unitText,
  workingDirectoryValue,
  writeManagedUnit,
} from '../../scripts/service-utils.ts';

test('user service installation is atomic, idempotent and refuses unrelated service files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-install-test-'));
  try {
    const path = join(dir, 'remote-workbench-agent.service');
    const text = unitText('agent', '/home/alice/private config.json', '/opt/node24/bin/node');
    assert.equal(await writeManagedUnit(path, text), true);
    assert.equal(await readFile(path, 'utf8'), text);
    const before = await stat(path);
    assert.equal(before.mode & 0o777, 0o600);
    assert.equal(await writeManagedUnit(path, text), false);
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    await writeFile(path, '[Service]\nDescription=Existing code-server\n');
    await assert.rejects(writeManagedUnit(path, text), /unmanaged/);
    assert.match(await readFile(path, 'utf8'), /Existing code-server/);
    assert.match(text, /WorkingDirectory=/);
    assert.match(text, /Environment="AGENT_CONFIG=\/home\/alice\/private config.json"/);
    assert(!text.includes('User=root'));
    assert.throws(() => quoteUnit('/home/alice\nExecStart=evil'));
    assert.throws(() => serviceArgs(['--component', 'agent', '--config', 'relative', '--node', '/node']));
    assert.equal(
      serviceArgs(['--component', 'gateway', '--config', '/private/config.json', '--node', '/node']).apply,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('systemd accepts generated units and preserves working directory characters', async (t) => {
  const run = promisify(execFile);
  try {
    await run('systemd-analyze', ['--version']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('systemd-analyze is not installed');
      return;
    }
    throw error;
  }
  const dir = await mkdtemp(join(tmpdir(), 'relay-systemd-test-'));
  try {
    const runtimeDir = join(dir, 'runtime');
    await mkdir(runtimeDir, { mode: 0o700 });
    const configPath = join(dir, 'private config %p \\ "quoted" $literal.json');
    for (const component of ['agent', 'gateway'] as const) {
      const generated = unitText(component, configPath, process.execPath);
      for (const [index, workingDirectory] of [
        repo,
        join(dir, 'space %p \\ "quote" $literal'),
        join(dir, 'trailing backslash\\'),
        join(dir, 'trailing space '),
      ].entries()) {
        const path = join(dir, `${component}-${index}.service`);
        // Verify the original generated unit, then exercise the field serializer's edge cases.
        const text =
          index === 0
            ? generated
            : generated.replace(
                /^WorkingDirectory=.*$/m,
                () => `WorkingDirectory=${workingDirectoryValue(workingDirectory)}`,
              );
        await writeFile(path, text);
        const { stdout, stderr } = await run(
          'systemd-analyze',
          ['--user', '--generators=no', 'verify', path],
          {
            env: {
              PATH: process.env.PATH,
              LANG: 'C',
              LC_ALL: 'C',
              XDG_RUNTIME_DIR: runtimeDir,
              SYSTEMD_LOG_LEVEL: 'debug',
            },
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        // The parser dump, rather than a generated-string comparison, checks the actual value.
        assert.equal(
          stdout
            .split('\n')
            .find((line) => line.includes('WorkingDirectory:'))
            ?.trimStart(),
          `WorkingDirectory: ${workingDirectory}`,
        );
        assert(
          stdout.includes(`${component === 'agent' ? 'AGENT' : 'GATEWAY'}_CONFIG=${configPath}`),
          'quoted Environment must still preserve the exact configuration path',
        );
        assert.doesNotMatch(stderr, /Invalid syntax|Unknown (?:key|escape)|Failed to resolve/);
      }
    }
    assert.throws(() => workingDirectoryValue('relative'), /absolute/);
    assert.throws(() => workingDirectoryValue('/tmp/line\nExecStart=evil'), /control/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQLite backup preserves committed WAL data and refuses to overwrite an existing backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-backup-test-'));
  const source = join(dir, 'live.sqlite');
  const destination = join(dir, 'backup.sqlite');
  const db = new DatabaseSync(source);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE verification(value TEXT); INSERT INTO verification VALUES('committed-in-WAL');",
    );
    const run = promisify(execFile);
    await run(process.execPath, ['--import', 'tsx', 'scripts/backup-database.ts', source, destination]);
    const copy = new DatabaseSync(destination, { readOnly: true });
    assert.equal(copy.prepare('SELECT value FROM verification').get()!.value, 'committed-in-WAL');
    copy.close();
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    await assert.rejects(
      run(process.execPath, ['--import', 'tsx', 'scripts/backup-database.ts', source, destination]),
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
