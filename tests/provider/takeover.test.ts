import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeWriter, type WriterOwner } from '../../packages/provider-codex/src/takeover.ts';

async function fixture(names = ['target', 'second'], codex = true) {
  const home = await mkdtemp(join(tmpdir(), 'relay-takeover-'));
  const directory = join(home, 'thread-writer-locks');
  await mkdir(directory, { mode: 0o700 });
  const executable = join(home, codex ? 'codex' : 'unrelated');
  await copyFile(await realpath('/usr/bin/python3'), executable);
  const script = `import fcntl,os,sys,time
files=[]
for name in sys.argv[2:]:
 f=open(os.path.join(sys.argv[1],name+'.lock'),'w');fcntl.flock(f,fcntl.LOCK_EX);files.append(f)
print('ready',flush=True)
for line in sys.stdin:
 if line.strip()=='add':
  f=open(os.path.join(sys.argv[1],'new.lock'),'w');fcntl.flock(f,fcntl.LOCK_EX);files.append(f);print('added',flush=True)
`;
  const child = spawn(executable, ['-I', '-S', '-u', '-c', script, directory, ...names]);
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  return {
    home,
    directory,
    child,
    exited,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('confirmed multi-session takeover stops only the verified owner and preserves lock files', async () => {
  const f = await fixture(),
    unrelated = await fixture(['unrelated']);
  try {
    const plan = (await nativeWriter(f.home, 'target')) as WriterOwner;
    assert.deepEqual(plan.sessions, ['second', 'target']);
    assert.equal(f.child.exitCode, null);
    assert.deepEqual(await nativeWriter(f.home, 'target', plan.fingerprint), { stopped: true });
    await f.exited;
    assert.equal(unrelated.child.signalCode, null);
    assert.ok((await stat(join(f.directory, 'target.lock'))).isFile());
    await assert.rejects(nativeWriter(f.home, 'target', plan.fingerprint), /已不再被占用/);
  } finally {
    await f.close();
    await unrelated.close();
  }
});

test('changed affected sessions and forged fingerprint never signal the process', async () => {
  const f = await fixture();
  try {
    const plan = (await nativeWriter(f.home, 'target')) as WriterOwner;
    await assert.rejects(nativeWriter(f.home, 'target', 'wrong'), /已改变/);
    f.child.stdin.write('add\n');
    await once(f.child.stdout, 'data');
    await assert.rejects(nativeWriter(f.home, 'target', plan.fingerprint), /已改变/);
    assert.equal(f.child.signalCode, null);
  } finally {
    await f.close();
  }
});

test('non-Codex holders, path traversal, and symlink locks are refused', async () => {
  const f = await fixture(['target'], false);
  try {
    await assert.rejects(nativeWriter(f.home, 'target'), /不是可验证的 Codex/);
    await assert.rejects(nativeWriter(f.home, '../target'), /无效/);
    await symlink(join(f.directory, 'target.lock'), join(f.directory, 'alias.lock'));
    await assert.rejects(nativeWriter(f.home, 'alias'), /无法验证会话锁文件/);
    await writeFile(join(f.directory, 'unheld.lock'), '');
    await assert.rejects(nativeWriter(f.home, 'unheld'), /已不再被占用/);
    assert.equal(f.child.signalCode, null);
  } finally {
    await f.close();
  }
});
