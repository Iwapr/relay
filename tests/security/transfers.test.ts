import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileService } from '../../apps/agent/src/files.ts';
import { Transfers, uploadInput } from '../../apps/agent/src/transfers.ts';
const exec = promisify(execFile);
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'relay-transfer-'));
  const root = path.join(base, 'project'),
    state = path.join(base, 'private');
  await mkdir(root);
  await mkdir(state, { mode: 0o700 });
  const files = await FileService.create({ roots: [root], privateDirectory: state });
  const workspace = await files.openWorkspace(root);
  const transfers = await Transfers.open(state, files);
  const upload = (input: unknown, workspaceId = 'w') =>
    transfers.upload(workspaceId, workspace, uploadInput.parse(input), async (action) => action(), '0022');
  const send = async (name: string, data: Buffer) => {
    const { id } = (await upload({ action: 'start', path: name, size: data.length })) as { id: string };
    for (let offset = 0; offset < data.length; offset += 192 * 1024)
      await upload({
        action: 'chunk',
        id,
        offset,
        data: data.subarray(offset, offset + 192 * 1024).toString('base64'),
      });
    await upload({ action: 'finish', id });
  };
  return {
    root,
    state,
    files,
    workspace,
    transfers,
    upload,
    send,
    close: async () => {
      await transfers.close();
      await files.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('chunked binary uploads preserve folder paths, empty files, and never overwrite', async () => {
  const f = await fixture();
  try {
    const data = Buffer.alloc(700000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    await f.send('资料 空格/sub/文件.bin', data);
    assert.deepEqual(await readFile(path.join(f.root, '资料 空格/sub/文件.bin')), data);
    await f.send('empty.txt', Buffer.alloc(0));
    assert.equal((await readFile(path.join(f.root, 'empty.txt'))).length, 0);
    await assert.rejects(f.send('empty.txt', Buffer.from('overwrite')), /同名/);
    assert.equal((await readFile(path.join(f.root, 'empty.txt'))).length, 0);
    assert.ok(!(await readdir(f.root)).some((n) => n.startsWith('.relay-upload-')));
  } finally {
    await f.close();
  }
});

test('uploads reject traversal, secrets, symlink parents, foreign IDs and invalid offsets', async () => {
  const f = await fixture();
  try {
    for (const name of ['../outside', '/etc/x', '.ssh/key', '.env', 'a/%2e%2e/x'])
      await assert.rejects(f.send(name, Buffer.from('x')));
    await symlink(f.state, path.join(f.root, 'linked'));
    await assert.rejects(f.send('linked/x', Buffer.from('x')));
    const { id } = (await f.upload({ action: 'start', path: 'x', size: 2 })) as { id: string };
    await assert.rejects(f.upload({ action: 'finish', id }, 'other'), /过期/);
    await assert.rejects(f.upload({ action: 'finish', id }), /完整/);
    await assert.rejects(f.upload({ action: 'chunk', id, offset: 1, data: 'YQ==' }), /位置/);
    await f.upload({ action: 'cancel', id });
    await assert.rejects(f.upload({ action: 'finish', id }), /过期/);
    assert.equal(await readFile(path.join(f.root, 'x')).catch(() => null), null);
  } finally {
    await f.close();
  }
});

test('downloads preserve original bytes and ZIP hierarchy while excluding secrets and links', async () => {
  const f = await fixture();
  try {
    await f.send('资料/a.bin', Buffer.from([0, 255, 23]));
    await f.send('b.txt', Buffer.from('你好'));
    await mkdir(path.join(f.root, '资料/empty'));
    await writeFile(path.join(f.root, '资料/.env'), 'secret');
    await symlink('/etc/passwd', path.join(f.root, '资料/link'));
    await link(path.join(f.root, 'b.txt'), path.join(f.root, '资料/hardlink'));
    const zip = await f.transfers.prepare('w', f.workspace, ['资料', '资料/a.bin'], true);
    assert.equal(zip.skipped, 3);
    await assert.rejects(f.transfers.read('other', zip.id));
    const download = await f.transfers.read('w', zip.id);
    const chunks: Buffer[] = [];
    for await (const c of download.stream) chunks.push(c);
    const local = path.join(f.state, 'check.zip');
    await writeFile(local, Buffer.concat(chunks));
    const result = await exec('python3', [
      '-c',
      'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps(z.namelist())); assert z.read("资料/a.bin") == bytes([0,255,23])',
      local,
    ]);
    assert.deepEqual(JSON.parse(result.stdout), ['资料/', '资料/a.bin', '资料/empty/']);
    const single = await f.transfers.prepare('w', f.workspace, ['资料/a.bin'], false);
    const raw = await f.transfers.read('w', single.id);
    const bytes: Buffer[] = [];
    for await (const c of raw.stream) bytes.push(c);
    assert.deepEqual(Buffer.concat(bytes), Buffer.from([0, 255, 23]));
    await assert.rejects(f.transfers.prepare('w', f.workspace, ['资料/.env'], false));
    await assert.rejects(f.transfers.prepare('w', f.workspace, ['资料/link'], false));
  } finally {
    await f.close();
  }
});

test('download cache recycles completed copies and rejects oversized content without leftover files', async () => {
  const f = await fixture();
  try {
    await f.send('small.txt', Buffer.from('small'));
    for (let i = 0; i < 7; i++) {
      const ready = await f.transfers.prepare('w', f.workspace, ['small.txt'], false);
      const download = await f.transfers.read('w', ready.id);
      for await (const _ of download.stream) {
        /* drain the browser download */
      }
    }
    assert.ok((await readdir(path.join(f.state, 'transfers'))).length <= 4);
    const { open } = await import('node:fs/promises');
    const large = await open(path.join(f.root, 'large.bin'), 'wx');
    await large.truncate(256 * 1024 * 1024 + 1);
    await large.close();
    await assert.rejects(f.transfers.prepare('w', f.workspace, ['large.bin'], false), /256 MiB/);
    assert.ok((await readdir(path.join(f.state, 'transfers'))).length <= 4);
  } finally {
    await f.close();
  }
});
