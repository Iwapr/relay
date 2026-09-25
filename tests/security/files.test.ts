import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  symlink,
  link,
  rename,
  rm,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { FileService, FileServiceError, byteRange } from '../../apps/agent/src/files.ts';

const exec = promisify(execFile);
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'workbench-fs-'));
  const root = path.join(base, 'allowed');
  const project = path.join(root, '项目 空格');
  const privateDirectory = path.join(base, 'private');
  await mkdir(project, { recursive: true });
  await mkdir(privateDirectory, { mode: 0o700 });
  const service = await FileService.create({
    roots: [root],
    privateDirectory,
    sensitivePaths: [path.join(root, 'secrets')],
    maxPreviewBytes: 1024 * 1024,
  });
  const workspace = await service.openWorkspace(project);
  return {
    base,
    root,
    project,
    privateDirectory,
    service,
    workspace,
    close: async () => {
      await service.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('text content previews regardless of extension while binary content remains downloadable', async () => {
  const f = await fixture();
  try {
    const text = '\ufeff中文内容\tpreview\r\n<script>alert(1)</script>\n';
    for (const name of ['notes', 'module.mjs', 'settings.cfg', '.gitignore', 'notes.custom']) {
      await writeFile(path.join(f.project, name), text);
      const meta = await f.service.metadata(f.workspace, name);
      assert.equal(meta.preview, 'text', name);
      const file = await f.service.file(f.workspace, name, { version: meta.version });
      assert.equal(file.headers['Content-Type'], 'text/plain; charset=utf-8');
      assert.match(file.headers['Content-Disposition'], /^inline;/);
      assert.equal(file.body.toString(), text);
    }
    for (const [name, content] of [
      ['empty', Buffer.alloc(0)],
      ['chunk-boundary', Buffer.from('a'.repeat(65535) + '中文')],
    ] as const) {
      await writeFile(path.join(f.project, name), content);
      assert.equal((await f.service.metadata(f.workspace, name)).preview, 'text', name);
    }
    for (const content of [
      Buffer.from([0, 1, 2]),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from([0xe4, 0xb8]),
      Buffer.concat([Buffer.alloc(65536, 'a'), Buffer.from([0])]),
    ]) {
      await writeFile(path.join(f.project, 'binary.dat'), content);
      const file = await f.service.file(f.workspace, 'binary.dat');
      assert.equal(file.meta.preview, 'download');
      assert.match(file.headers['Content-Disposition'], /^attachment;/);
      assert.deepEqual(file.body, content);
    }
    for (const [name, preview] of [
      ['readme.md', 'markdown'],
      ['photo.png', 'image'],
      ['paper.pdf', 'pdf'],
    ] as const) {
      await writeFile(path.join(f.project, name), 'existing format');
      assert.equal((await f.service.metadata(f.workspace, name)).preview, preview);
    }
  } finally {
    await f.close();
  }
});

test('Chinese paths, pagination and private paths obey one enforced boundary', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.project, '中文 文件.md'), '# 安全');
    await writeFile(path.join(f.project, 'second.txt'), 'second');
    await mkdir(path.join(f.project, '.ssh'));
    await writeFile(path.join(f.project, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    await mkdir(path.join(f.project, '.codex'));
    await writeFile(path.join(f.project, '.codex', 'auth.json'), 'TOKEN');
    for (const name of ['.env', '.env.local', '.env.example', 'id_rsa'])
      await writeFile(path.join(f.project, name), 'ENV SECRET');
    await mkdir(path.join(f.root, 'secrets'));
    await writeFile(path.join(f.root, 'secrets', 'token'), 'CUSTOM TOKEN');
    const listing = await f.service.tree(f.workspace, { limit: 1, hidden: true });
    assert.equal(listing.entries.length, 1);
    assert.equal(listing.total, 2);
    assert.equal(listing.nextCursor, '1');
    assert.equal((await f.service.tree(f.workspace, { cursor: '1', limit: 1 })).nextCursor, null);
    assert.equal((await f.service.file(f.workspace, '中文 文件.md')).body.toString(), '# 安全');
    for (const name of [
      '../secrets/token',
      '../../private/token',
      '.ssh/id_ed25519',
      '.codex/auth.json',
      '.env',
      '.env.local',
      '.env.example',
      'id_rsa',
      '%2e%2e/secrets/token',
      '%252e%252e/secrets/token',
      '/etc/passwd',
      'a\0b',
      'x/../second.txt',
      'x\\..\\secret',
    ]) {
      await assert.rejects(
        f.service.file(f.workspace, name),
        (error) => error instanceof FileServiceError && [403, 409].includes(error.statusCode),
        name,
      );
    }
    await assert.rejects(f.service.openWorkspace(path.join(f.root, 'secrets')));
    await mkdir(f.root + '-outside');
    await assert.rejects(f.service.openWorkspace(f.root + '-outside'), { code: 'path_outside_workspace' });
  } finally {
    await f.close();
  }
});

test('folder picker returns navigable absolute directories and paginates without regular files', async () => {
  const f = await fixture();
  try {
    const sibling = path.join(f.root, '第二个 项目');
    const child = path.join(f.project, '章节 一');
    const grandchild = path.join(child, '子目录');
    await mkdir(grandchild, { recursive: true });
    await mkdir(sibling);
    await mkdir(path.join(f.root, 'secrets'));
    await mkdir(path.join(f.root, '.ssh'));
    await symlink(f.base, path.join(f.root, 'shortcut'));
    await writeFile(path.join(f.root, 'README.md'), 'regular file');
    await writeFile(path.join(f.project, 'document.md'), '# Document');

    const first = await f.service.listDirectories(undefined, { limit: 1, hidden: true });
    assert.equal(first.path, f.root);
    assert.equal(first.total, 2);
    assert.equal(first.nextCursor, '1');
    const second = await f.service.listDirectories(f.root, {
      limit: 1,
      cursor: first.nextCursor,
      hidden: true,
    });
    assert.equal(second.nextCursor, null);
    assert.equal(second.total, 2);
    const entries = [...first.entries, ...second.entries];
    assert.deepEqual(new Set(entries.map((entry) => entry.path)), new Set([f.project, sibling]));
    for (const entry of entries) {
      assert.equal(entry.type, 'directory');
      assert.equal(path.isAbsolute(entry.path), true);
      assert.equal((await f.service.listDirectories(entry.path)).path, entry.path);
    }
    const project = await f.service.listDirectories(f.project);
    assert.deepEqual(
      project.entries.map((entry) => entry.path),
      [child],
    );
    const nested = await f.service.listDirectories(project.entries[0].path);
    assert.deepEqual(
      nested.entries.map((entry) => entry.path),
      [grandchild],
    );
    assert.equal((await f.service.openWorkspace(nested.entries[0].path)).canonicalRoot, grandchild);

    const tree = await f.service.tree(f.workspace);
    assert.deepEqual(new Set(tree.entries.map((entry) => entry.path)), new Set(['章节 一', 'document.md']));
    assert.equal((await f.service.file(f.workspace, 'document.md')).body.toString(), '# Document');
    await assert.rejects(f.service.listDirectories('章节 一'), { code: 'path_outside_workspace' });
    await assert.rejects(f.service.listDirectories(f.base), { code: 'path_outside_workspace' });
    await assert.rejects(f.service.listDirectories(path.join(f.root, 'secrets')), {
      code: 'permission_denied',
    });
  } finally {
    await f.close();
  }
});

test('symlinks, hard links, FIFOs and replaced directory identities are refused', async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.base, 'outside.txt');
    await writeFile(outside, 'CREDENTIAL');
    await symlink(outside, path.join(f.project, 'link.txt'));
    await link(outside, path.join(f.project, 'hard.txt'));
    await exec('mkfifo', [path.join(f.project, 'pipe')]);
    for (const name of ['link.txt', 'hard.txt', 'pipe'])
      await assert.rejects(f.service.file(f.workspace, name), { code: 'permission_denied' });
    await rename(f.project, f.project + '-old');
    await mkdir(f.project);
    await writeFile(path.join(f.project, 'new.txt'), 'REPLACEMENT');
    await assert.rejects(f.service.file(f.workspace, 'new.txt'), { code: 'file_changed' });
  } finally {
    await f.close();
  }
});

test('directory rename/symlink race never returns bytes from outside the root', async () => {
  const f = await fixture();
  const target = path.join(f.project, 'moving');
  const outside = path.join(f.base, 'outside');
  try {
    await mkdir(target);
    await mkdir(outside);
    await writeFile(path.join(target, 'data.txt'), 'SAFE');
    await writeFile(path.join(outside, 'data.txt'), 'SECRET');
    const racer = spawn(
      '/usr/bin/python3',
      [
        '-c',
        'import os,sys\np=sys.argv[1];s=sys.argv[2]\nwhile True:\n try:\n  os.rename(p,p+".saved");os.symlink(s,p);os.unlink(p);os.rename(p+".saved",p)\n except OSError: pass',
        target,
        outside,
      ],
      { stdio: 'ignore' },
    );
    try {
      for (let i = 0; i < 25; i++) {
        try {
          assert.equal((await f.service.file(f.workspace, 'moving/data.txt')).body.toString(), 'SAFE');
        } catch (error) {
          assert.ok(error instanceof FileServiceError);
        }
      }
    } finally {
      racer.kill('SIGKILL');
      await new Promise((resolve) => racer.once('close', resolve));
    }
  } finally {
    await f.close();
  }
});

test('PDF ranges are immutable across recompilation and invalid ranges are 416', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.project, 'paper.pdf');
    await writeFile(file, '%PDF-old-0123456789');
    const old = await f.service.metadata(f.workspace, 'paper.pdf');
    await writeFile(file, '%PDF-new-ABCDEFGHIJ');
    const first = await f.service.file(f.workspace, 'paper.pdf', {
      version: old.version,
      range: 'bytes=0-4',
    });
    const second = await f.service.file(f.workspace, 'paper.pdf', {
      version: old.version,
      range: 'bytes=5-',
    });
    assert.equal(first.statusCode, 206);
    assert.equal(Buffer.concat([first.body, second.body]).toString(), '%PDF-old-0123456789');
    assert.equal(first.headers['Content-Range'], `bytes 0-4/${old.size}`);
    assert.equal(first.headers.ETag, old.etag);
    const latest = await f.service.metadata(f.workspace, 'paper.pdf');
    assert.notEqual(old.version, latest.version);
    assert.equal(
      (
        await f.service.file(f.workspace, 'paper.pdf', { version: latest.version, range: 'bytes=-3' })
      ).body.toString(),
      'HIJ',
    );
    for (const range of ['bytes=999-', 'bytes=8-2', 'bytes=0-1,4-5', 'bytes=-0', 'items=0-2']) {
      const invalid = await f.service.file(f.workspace, 'paper.pdf', { version: old.version, range });
      assert.equal(invalid.statusCode, 416);
      assert.equal(invalid.headers['Content-Range'], `bytes */${old.size}`);
    }
    await writeFile(path.join(f.project, 'other.pdf'), 'OTHER');
    await assert.rejects(f.service.file(f.workspace, 'other.pdf', { version: old.version }), {
      code: 'file_changed',
    });
    await writeFile(path.join(f.project, 'evil.html'), '<script>alert(1)</script>');
    const html = await f.service.file(f.workspace, 'evil.html');
    assert.equal(html.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(html.headers['X-Content-Type-Options'], 'nosniff');
    await writeFile(path.join(f.project, 'large.pdf'), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(f.service.file(f.workspace, 'large.pdf'), { code: 'file_too_large' });
  } finally {
    await f.close();
  }
});

test('Git changes do not run hooks/textconv, disclose sensitive paths, or alter existing edits', async () => {
  const f = await fixture();
  const git = (...args: string[]) => exec('git', args, { cwd: f.project });
  try {
    await git('init', '-q');
    await git('config', 'user.email', 'tests@example.invalid');
    await git('config', 'user.name', 'Tests');
    await writeFile(path.join(f.project, 'paper.txt'), 'before\n');
    await mkdir(path.join(f.project, '.ssh'));
    await writeFile(path.join(f.project, '.ssh', 'key'), 'OLD SECRET\n');
    await writeFile(path.join(f.project, '.env'), 'OLD ENV SECRET\n');
    await git('add', '.');
    await git('commit', '-qm', 'baseline');
    await writeFile(path.join(f.project, 'paper.txt'), 'after\n');
    await writeFile(path.join(f.project, '.ssh', 'key'), 'NEW SECRET\n');
    await writeFile(path.join(f.project, '.env'), 'NEW ENV SECRET\n');
    await git('config', 'diff.external', 'touch SHOULD-NOT-EXIST');
    await git('config', 'core.fsmonitor', 'touch SHOULD-NOT-EXIST');
    const changes = await f.service.changes(f.workspace);
    assert.equal(changes.git, true);
    assert.match(changes.diff, /\+after/);
    assert.doesNotMatch(JSON.stringify(changes), /SECRET|\.ssh/);
    assert.equal((await f.service.file(f.workspace, 'paper.txt')).body.toString(), 'after\n');
    assert.ok(
      !(await f.service.tree(f.workspace)).entries.some((entry) => entry.name === 'SHOULD-NOT-EXIST'),
    );
    await assert.rejects(f.service.file(f.workspace, '.git/config'), { code: 'permission_denied' });
  } finally {
    await f.close();
  }
});

test('non-Git workspace remains usable and zero-size range is rejected', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.changes(f.workspace)).git, false);
    assert.throws(() => byteRange('bytes=0-', 0), { statusCode: 416 });
  } finally {
    await f.close();
  }
});

test('checkpoints restore modified, deleted, new and binary files, while retaining unrelated later files', async () => {
  const f = await fixture();
  try {
    const file = (name: string) => path.join(f.project, name);
    await writeFile(file('changed.txt'), 'original');
    await mkdir(file('old/sub'), { recursive: true });
    await chmod(file('old'), 0o755);
    await chmod(file('old/sub'), 0o755);
    await writeFile(file('old/sub/deleted.bin'), Buffer.from([0, 255, 17]));
    await f.service.checkpoint(f.workspace, 'capture', { id: 'before' });
    await writeFile(file('changed.txt'), 'task change');
    await rm(file('old'), { recursive: true });
    await mkdir(file('new/sub'), { recursive: true });
    await writeFile(file('new/sub/new.txt'), 'new');
    await f.service.checkpoint(f.workspace, 'capture', { id: 'after' });
    await writeFile(file('unrelated.txt'), 'later work');
    const preview = await f.service.checkpoint<{ token: string; files: unknown[] }>(f.workspace, 'preview', {
      before: 'before',
      after: 'after',
    });
    assert.equal(preview.files.length, 7);
    await f.service.checkpoint(f.workspace, 'restore', {
      before: 'before',
      after: 'after',
      token: preview.token,
      operationId: 'restore-once',
    });
    assert.equal(await readFile(file('changed.txt'), 'utf8'), 'original');
    assert.deepEqual(await readFile(file('old/sub/deleted.bin')), Buffer.from([0, 255, 17]));
    assert.equal(await readFile(file('unrelated.txt'), 'utf8'), 'later work');
    assert.equal((await stat(file('old/sub'))).mode & 0o777, 0o755);
    await assert.rejects(readFile(file('new/sub/new.txt')), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('checkpoint restore refuses later file edits, replaced parents and protected changes without overwriting work', async () => {
  const f = await fixture();
  try {
    const file = (name: string) => path.join(f.project, name);
    await mkdir(file('dir'));
    await writeFile(file('dir/a.txt'), 'before');
    await writeFile(file('.env'), 'secret before');
    await f.service.checkpoint(f.workspace, 'capture', { id: 'before' });
    await writeFile(file('dir/a.txt'), 'after');
    await f.service.checkpoint(f.workspace, 'capture', { id: 'after' });
    const plan = await f.service.checkpoint<{ token: string }>(f.workspace, 'preview', {
      before: 'before',
      after: 'after',
    });
    await writeFile(file('dir/a.txt'), 'later user edit');
    await assert.rejects(
      f.service.checkpoint(f.workspace, 'restore', {
        before: 'before',
        after: 'after',
        token: plan.token,
        operationId: 'conflict',
      }),
      /又被修改/,
    );
    assert.equal(await readFile(file('dir/a.txt'), 'utf8'), 'later user edit');
    await writeFile(file('dir/a.txt'), 'after');
    await rename(file('dir'), file('moved'));
    await mkdir(file('dir'));
    await writeFile(file('dir/a.txt'), 'after');
    await assert.rejects(
      f.service.checkpoint(f.workspace, 'preview', { before: 'before', after: 'after' }),
      /目录已被替换/,
    );
    await writeFile(file('.env'), 'secret changed');
    await f.service.checkpoint(f.workspace, 'capture', { id: 'protected-after' });
    await assert.rejects(
      f.service.checkpoint(f.workspace, 'preview', { before: 'before', after: 'protected-after' }),
      /受保护文件/,
    );
  } finally {
    await f.close();
  }
});

test('failed file restoration compensates earlier writes and keeps a durable recovery journal', async () => {
  const f = await fixture();
  try {
    for (const name of ['a.txt', 'b.txt']) await writeFile(path.join(f.project, name), `before ${name}`);
    await f.service.checkpoint(f.workspace, 'capture', { id: 'before' });
    for (const name of ['a.txt', 'b.txt']) await writeFile(path.join(f.project, name), `after ${name}`);
    await f.service.checkpoint(f.workspace, 'capture', { id: 'after' });
    const plan = await f.service.checkpoint<{ token: string }>(f.workspace, 'preview', {
      before: 'before',
      after: 'after',
    });
    const directory = path.join(f.privateDirectory, 'checkpoints');
    const manifest = JSON.parse(await readFile(path.join(directory, 'before.json'), 'utf8'));
    await writeFile(path.join(directory, `${manifest.entries['b.txt'].hash}.blob`), 'corrupted backup');
    await assert.rejects(
      f.service.checkpoint(f.workspace, 'restore', {
        before: 'before',
        after: 'after',
        token: plan.token,
        operationId: 'partial-failure',
      }),
      /回滚中止/,
    );
    for (const name of ['a.txt', 'b.txt'])
      assert.equal(await readFile(path.join(f.project, name), 'utf8'), `after ${name}`);
    const journal = JSON.parse(await readFile(path.join(directory, 'restore-partial-failure.json'), 'utf8'));
    assert.equal(journal.state, 'compensated');
    assert.deepEqual(journal.applied, ['a.txt']);
    await assert.rejects(
      f.service.checkpoint(f.workspace, 'restore', {
        before: 'before',
        after: 'after',
        token: plan.token,
        operationId: 'partial-failure',
      }),
      /已有执行记录/,
    );
  } finally {
    await f.close();
  }
});

test('a shared namespace lists project names but cannot open or preview an inaccessible project', async () => {
  const f = await fixture();
  const restricted = path.join(f.root, 'another-project');
  try {
    await mkdir(restricted);
    await writeFile(path.join(restricted, 'private.txt'), 'not accessible');
    await chmod(restricted, 0o000);
    const namespace = await f.service.openWorkspace(f.root);
    const listing = await f.service.tree(namespace);
    assert.ok(listing.entries.some((entry) => entry.name === 'another-project'));
    await assert.rejects(f.service.openWorkspace(restricted), { code: 'permission_denied' });
    await assert.rejects(f.service.tree(namespace, { path: 'another-project' }), {
      code: 'permission_denied',
    });
    await assert.rejects(f.service.file(namespace, 'another-project/private.txt'), {
      code: 'permission_denied',
    });
  } finally {
    await chmod(restricted, 0o700).catch(() => {});
    await f.close();
  }
});

test('new project directories reject collisions, traversal, sensitive locations and symlink parents', async () => {
  const f = await fixture();
  try {
    const created = await f.service.createDirectory(f.project, '新项目 demo');
    assert.equal(created.path, path.join(f.project, '新项目 demo'));
    assert.ok((await stat(created.path)).isDirectory());
    assert.equal((await f.service.openWorkspace(created.path)).canonicalRoot, created.path);
    await assert.rejects(f.service.createDirectory(f.project, '新项目 demo'), { code: 'already_exists' });
    await writeFile(path.join(f.project, 'existing'), 'keep');
    await assert.rejects(f.service.createDirectory(f.project, 'existing'), { code: 'already_exists' });
    assert.equal(await readFile(path.join(f.project, 'existing'), 'utf8'), 'keep');
    for (const name of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'line\nbreak', ' '.repeat(3)])
      await assert.rejects(f.service.createDirectory(f.project, name));
    await assert.rejects(f.service.createDirectory(f.base, 'outside'));
    await assert.rejects(f.service.createDirectory(f.project, '.ssh'));
    await assert.rejects(f.service.createDirectory(f.root, 'secrets'));
    await symlink(f.project, path.join(f.root, 'alias'));
    await assert.rejects(f.service.createDirectory(path.join(f.root, 'alias'), 'via-link'));
    await assert.rejects(stat(path.join(f.project, 'via-link')), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('absolute previews can read extra preview roots without granting project access', async () => {
  const f = await fixture();
  const temporary = path.join(f.base, 'temporary');
  await mkdir(temporary);
  const service = await FileService.create({
    roots: [f.root],
    previewRoots: [temporary],
    privateDirectory: f.privateDirectory,
    sensitivePaths: [path.join(f.root, 'secrets')],
  });
  try {
    const file = path.join(temporary, '中文 图.png');
    await writeFile(file, 'image-fixture');
    const metadata = await service.metadata(f.workspace, file);
    assert.equal(metadata.preview, 'image');
    const content = await service.file(f.workspace, file, { version: metadata.version, range: 'bytes=0-4' });
    assert.equal(content.statusCode, 206);
    assert.equal(content.body.toString(), 'image');
    assert.equal(content.headers['Content-Range'], 'bytes 0-4/13');
    assert.deepEqual(
      service.roots().map((r) => r.canonicalRoot),
      [f.root],
    );
    await assert.rejects(service.openWorkspace(temporary));
    await assert.rejects(service.tree(f.workspace, { path: temporary }));
    const inProject = path.join(f.project, 'notes.md');
    await writeFile(inProject, '# Hello');
    const local = await service.metadata(f.workspace, 'notes.md');
    assert.equal(
      (await service.file(f.workspace, inProject, { version: local.version })).body.toString(),
      '# Hello',
    );
    await writeFile(path.join(temporary, 'other.png'), 'other');
    await assert.rejects(
      service.file(f.workspace, path.join(temporary, 'other.png'), { version: metadata.version }),
    );
    await mkdir(path.join(f.root, 'other-project'));
    const other = path.join(f.root, 'other-project', 'notes.md');
    await writeFile(other, '# Another project');
    assert.equal((await service.file(f.workspace, other)).body.toString(), '# Another project');
    await writeFile(path.join(f.base, 'outside.txt'), 'outside');
    await writeFile(path.join(temporary, '.env'), 'secret');
    await writeFile(path.join(temporary, 'no-access.txt'), 'denied', { mode: 0o000 });
    await symlink(file, path.join(temporary, 'link.png'));
    await mkdir(path.join(f.root, 'secrets'));
    await writeFile(path.join(f.root, 'secrets', 'token'), 'secret');
    for (const denied of [
      path.join(f.base, 'outside.txt'),
      path.join(temporary, '.env'),
      path.join(temporary, 'no-access.txt'),
      path.join(temporary, 'link.png'),
      path.join(f.root, 'secrets', 'token'),
      temporary + '/../outside.txt',
      temporary + '/%2e%2e/outside.txt',
      temporary + '/missing.png',
    ])
      await assert.rejects(service.metadata(f.workspace, denied), denied);
    await rm(file);
    await assert.rejects(
      service.metadata(f.workspace, file),
      (error: FileServiceError) => error.code === 'not_found',
    );
  } finally {
    await service.close();
    await f.close();
  }
});

test('workspace management creates, renames, copies, moves and deletes without overwriting or following links', async () => {
  const f = await fixture();
  const manage = (action: string, source?: string, target?: string) =>
    f.service.manage(f.workspace, { action, path: source, target });
  try {
    await manage('directory', undefined, 'folder');
    await manage('file', undefined, 'folder/a.txt');
    await writeFile(path.join(f.project, 'folder/a.txt'), 'hello');
    await manage('rename', 'folder/a.txt', 'folder/b.txt');
    await manage('copy', 'folder', 'copied');
    assert.equal(await readFile(path.join(f.project, 'copied/b.txt'), 'utf8'), 'hello');
    await assert.rejects(manage('move', 'folder/b.txt', 'copied/b.txt'), /同名/);
    await assert.rejects(manage('copy', 'folder', 'folder/nested'), /自身/);
    await assert.rejects(manage('file', undefined, '../escape'));
    await assert.rejects(manage('file', undefined, '.env'));
    await assert.rejects(manage('move'));
    await symlink('/etc', path.join(f.project, 'linked'));
    await assert.rejects(manage('copy', 'linked', 'unsafe'));
    await writeFile(path.join(f.project, 'folder/.env'), 'secret');
    await assert.rejects(manage('delete', 'folder'));
    assert.equal(await readFile(path.join(f.project, 'folder/b.txt'), 'utf8'), 'hello');
    await manage('move', 'copied/b.txt', 'moved.txt');
    await manage('delete', 'copied');
    await manage('delete', 'moved.txt');
    await assert.rejects(stat(path.join(f.project, 'moved.txt')));
  } finally {
    await f.close();
  }
});
