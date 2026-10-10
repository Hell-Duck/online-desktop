const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { ImageAssetStore } = require('../lib/image-assets');

const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

async function makeStore(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'board-assets-test-'));
  const store = new ImageAssetStore({
    root, totalBytes: 64, roomBytes: 48, fileBytes: 32, reserveBytes: 100,
    statfs: async () => ({ bavail: 1000, bsize: 1 }), ...options,
  });
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return store;
}

test('an image is stored once and repeated upload does not consume a second quota', async (t) => {
  const store = await makeStore(t);
  const a = await store.put('lesson', png, 'image/png');
  const b = await store.put('lesson', png, 'image/png');
  assert.deepEqual(a, b);
  assert.match(a.url, /^\/board-assets\/[a-f0-9]{64}$/);
  assert.deepEqual(await store.get('lesson', a.id), { bytes: png, contentType: 'image/png' });
  assert.equal(store.stats().totalBytes, png.length);
});

test('bad bytes, oversized files, room quota, total quota, and disk reserve refuse atomically', async (t) => {
  const store = await makeStore(t, { totalBytes: 60, roomBytes: 45, fileBytes: 40 });
  await assert.rejects(store.put('a', Buffer.from('not a png'), 'image/png'), /invalid/);
  await assert.rejects(store.put('a', Buffer.concat([png, Buffer.alloc(15)]), 'image/png'), /too_large/);
  await store.put('a', png, 'image/png');
  await assert.rejects(store.put('a', jpeg, 'image/jpeg'), /quota/);
  assert.equal(store.stats().totalBytes, png.length);
  await assert.rejects(store.put('a', png, 'image/gif'), /invalid/);
  await assert.rejects(store.get('a', '../outside'), /invalid/);

  const lowDisk = await makeStore(t, { statfs: async () => ({ bavail: 100, bsize: 1 }) });
  await assert.rejects(lowDisk.put('a', png, 'image/png'), /quota/);
  assert.equal(lowDisk.stats().totalBytes, 0);
});

test('room cleanup removes its assets and does not delete another room copy', async (t) => {
  const store = await makeStore(t);
  const a = await store.put('a', png, 'image/png');
  await store.put('b', png, 'image/png');
  await store.releaseRoom('a');
  assert.equal(await store.get('a', a.id), null);
  assert.ok(await store.get('b', a.id));
  await store.releaseRoom('b');
  assert.equal(store.stats().totalBytes, 0);
});
