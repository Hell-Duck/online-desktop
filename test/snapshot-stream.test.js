const test = require('node:test');
const assert = require('node:assert/strict');
const { streamSnapshot, createSnapshotReceiver } = require('../lib/snapshot-stream');

test('large snapshots travel in bounded acknowledged chunks', async () => {
  const source = { version: 12, sheet: 'white', objects: Array.from({ length: 50 }, (_, i) =>
    ({ id: `o${i}`, type: 'rect', label: 'Ж'.repeat(500) })) };
  const receiver = createSnapshotReceiver();
  const packets = [];
  await streamSnapshot(source, async (packet) => {
    packets.push(packet);
    return receiver.accept(packet);
  }, 2048);
  assert.ok(packets.length > 2);
  assert.ok(packets.every((packet) => Buffer.byteLength(JSON.stringify(packet)) <= 2048));
  assert.deepEqual(receiver.result(), source);
});

test('receiver discards interrupted session and rejects out of order packets', async () => {
  const receiver = createSnapshotReceiver();
  const first = [];
  await assert.rejects(streamSnapshot({ version: 1, objects: [{ label: 'x'.repeat(5000) }] },
    async (packet) => { first.push(packet); if (packet.index === 1) return false; return receiver.accept(packet); }, 512));
  assert.equal(receiver.result(), null);
  const second = [];
  await streamSnapshot({ version: 2, objects: [] }, async (packet) => {
    second.push(packet); return receiver.accept(packet);
  }, 512);
  assert.deepEqual(receiver.result(), { version: 2, objects: [] });
  assert.equal(receiver.accept(first[0]), false);
});

test('emoji remain intact when split near a UTF-16 boundary', async () => {
  const source = { version: 3, objects: [{ text: '🙂'.repeat(1000) }] };
  const receiver = createSnapshotReceiver();
  await streamSnapshot(source, async (packet) => receiver.accept(JSON.parse(JSON.stringify(packet))), 333);
  assert.deepEqual(receiver.result(), source);
});

test('quotes and backslashes cannot expand a packet over its wire limit', async () => {
  const source = { version: 4, objects: [{ text: '\\"'.repeat(8000) }] };
  const receiver = createSnapshotReceiver();
  const packets = [];
  await streamSnapshot(source, async (packet) => {
    packets.push(packet);
    return receiver.accept(packet);
  }, 1024);
  assert.ok(packets.every((packet) => Buffer.byteLength(JSON.stringify(packet)) <= 1024));
  assert.deepEqual(receiver.result(), source);
});
