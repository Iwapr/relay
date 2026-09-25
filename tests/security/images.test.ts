import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../apps/agent/src/store.ts';
import { ImageStore } from '../../apps/agent/src/images.ts';
import { MAX_IMAGE_BYTES, runInput } from '../../packages/contracts/src/index.ts';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-images-'));
  const store = new Store(dir, 'test');
  const images = new ImageStore(store, dir);
  const input = (id = randomUUID()) => ({
    clientRequestId: id,
    name: '截图.png',
    dataUrl: 'data:image/png;base64,' + png,
  });
  return {
    dir,
    store,
    images,
    input,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('uploaded images are private, idempotent, workspace-bound, and sent as image data', () => {
  const f = fixture();
  try {
    const input = f.input();
    const image = f.images.upload('workspace', input);
    assert.deepEqual(f.images.upload('workspace', input), image);
    assert.equal(statSync(join(f.dir, 'images', image.id)).mode & 0o777, 0o600);
    assert.equal(image.width, 1);
    assert.equal(image.height, 1);
    assert.equal(f.images.read('workspace', image.id).bytes.toString('base64'), png);
    assert.throws(() => f.images.read('other', image.id), { code: 'permission_denied' });
    assert.throws(() => f.images.attach('other', [image.id]), { code: 'permission_denied' });
    assert.throws(() => f.images.upload('other', input), { code: 'run_conflict' });
    assert.throws(() => f.images.upload('workspace', { ...input, name: 'other.png' }), {
      code: 'run_conflict',
    });
    const refs = f.images.attach('workspace', [image.id]);
    assert.deepEqual(f.images.inputs('workspace', refs), [{ url: input.dataUrl }]);
    assert.ok(!JSON.stringify(refs).includes(png));
    assert.throws(() => f.images.attach('workspace', [image.id, image.id]));
    assert.throws(() =>
      f.images.attach(
        'workspace',
        Array.from({ length: 5 }, () => image.id),
      ),
    );
  } finally {
    f.close();
  }
});

test('image validation rejects active formats, forged content, oversize images, symlinks and changed files', () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.images.upload('w', {
        ...f.input(),
        dataUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'),
      }),
    );
    assert.throws(() =>
      f.images.upload('w', {
        ...f.input(),
        dataUrl: 'data:image/png;base64,' + Buffer.from('<script>1</script>').toString('base64'),
      }),
    );
    assert.throws(() => f.images.upload('w', { ...f.input(), dataUrl: 'https://example.com/tracking.png' }));
    const large = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    assert.throws(() =>
      f.images.upload('w', { ...f.input(), dataUrl: 'data:image/png;base64,' + large.toString('base64') }),
    );
    const enormous = Buffer.from(png, 'base64');
    enormous.writeUInt32BE(100000, 16);
    assert.throws(() =>
      f.images.upload('w', { ...f.input(), dataUrl: 'data:image/png;base64,' + enormous.toString('base64') }),
    );
    const id = randomUUID();
    symlinkSync('/etc/passwd', join(f.dir, 'images', id));
    assert.throws(() => f.images.upload('w', f.input(id)));
    assert.throws(() => f.images.read('w', '../../other'));
    const image = f.images.upload('w', f.input());
    writeFileSync(join(f.dir, 'images', image.id), 'changed');
    assert.throws(() => f.images.read('w', image.id), { code: 'invalid_image' });
  } finally {
    f.close();
  }
});

test('only abandoned uploads expire, while attached images and metadata survive reopening the store', () => {
  const f = fixture();
  try {
    const abandoned = f.images.upload('w', f.input());
    const attached = f.images.upload('w', f.input());
    f.images.attach('w', [attached.id]);
    for (const image of [abandoned, attached]) {
      const stored = f.store.get<Record<string, unknown>>('image', image.id)!;
      f.store.put('image', image.id, { ...stored, createdAt: 1 });
    }
    f.images.upload('w', f.input());
    assert.throws(() => f.images.read('w', abandoned.id), { code: 'not_found' });
    assert.equal(new ImageStore(f.store, f.dir).read('w', attached.id).bytes.toString('base64'), png);
    const input = { clientRequestId: randomUUID(), text: '', model: 'test' };
    assert.equal(runInput.safeParse(input).success, false);
    assert.equal(runInput.safeParse({ ...input, imageIds: [attached.id] }).success, true);
  } finally {
    f.close();
  }
});
