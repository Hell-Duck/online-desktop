const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createBoardServer } = require('../server-app');
const { createSnapshotReceiver } = require('../lib/snapshot-stream');

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

test('many image erasures, undo, rejection and rejoin retain one canonical scene', async (t) => {
  const app = createBoardServer({ roomGraceMs: 300 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const first = connect(url, { transports: ['websocket'] });
  let second = connect(url, { transports: ['websocket'] });
  t.after(async () => { first.disconnect(); second.disconnect(); await app.close(); });
  await Promise.all([once(first, 'connect'), once(second, 'connect')]);
  first.emit('join', { room: 'stress' });
  await once(first, 'peers');
  const both = once(first, 'peers');
  second.emit('join', { room: 'stress' });
  assert.equal(await both, 2);

  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const assetResponse = await fetch(`${url}/board-assets?room=stress`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: png,
  });
  const asset = await assetResponse.json();
  assert.equal(assetResponse.status, 201);
  let version = 0, maxCommandBytes = 0;
  const send = async (kind, fields = {}) => {
    const cmd = { commandId: `cmd-${version}-${kind}`, expectedVersion: version, kind, ...fields };
    const answer = await first.timeout(4000).emitWithAck('scene:command', cmd);
    if (!answer.rejected) {
      version = answer.version;
      maxCommandBytes = Math.max(maxCommandBytes, Buffer.byteLength(JSON.stringify(cmd)));
    }
    return answer;
  };
  for (let i = 0; i < 35; i++) {
    assert.equal((await send('add', { obj: { id: `image-${i}`, type: 'image', src: asset.url,
      left: i, top: 0 } })).version, i + 1);
  }
  for (let stroke = 0; stroke < 15; stroke++) {
    const targets = Array.from({ length: 35 }, (_, i) => ({
      id: `image-${i}`, baseCount: stroke,
      eraser: { type: 'eraser', objects: [{ type: 'path', path: [['M', 0, stroke],
        ['L', 900, stroke]], strokeWidth: 20 }] },
    }));
    assert.equal((await send('erase', { targets })).version, 36 + stroke);
  }
  const beforeRejected = app.scene.snapshot('stress');
  const oversized = await send('erase', { targets: [{ id: 'image-0', baseCount: 15,
    eraser: { objects: [{ path: 'x'.repeat(300000) }] } }] });
  assert.equal(oversized.rejected, 'quota');
  assert.deepEqual(app.scene.snapshot('stress'), beforeRejected);
  assert.equal((await send('undo')).version, 51);
  assert.equal(app.scene.snapshot('stress').objects[0].eraser.objects.length, 14);
  assert.equal((await send('redo')).version, 52);
  assert.equal(app.scene.snapshot('stress').objects[0].eraser.objects.length, 15);

  second.disconnect();
  second = connect(url, { transports: ['websocket'] });
  await once(second, 'connect');
  second.emit('join', { room: 'stress' });
  await once(second, 'peers');
  const receiver = createSnapshotReceiver();
  const packets = [];
  second.on('scene:chunk', (packet, ack) => { packets.push(packet); ack(receiver.accept(packet)); });
  const ready = once(second, 'scene:ready');
  second.emit('scene:sync');
  assert.equal((await ready).version, version);
  assert.deepEqual(receiver.result(), app.scene.snapshot('stress'));
  assert.ok(packets.every((packet) => Buffer.byteLength(JSON.stringify(packet)) <= 256 * 1024));
  assert.ok(maxCommandBytes < 256 * 1024);
  assert.equal(app.assets.stats().assetCount, 1);
  assert.equal(app.scene.getStats('stress').undoCount > 0, true);
  t.diagnostic(JSON.stringify({
    version, maxCommandBytes, snapshotPackets: packets.length,
    sceneBytes: app.scene.getStats('stress').sceneBytes,
    historyBytes: app.scene.getStats('stress').historyBytes,
    assetBytes: app.assets.stats().totalBytes,
    rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    socketWriteQueue: app.io.sockets.sockets.get(first.id)?.conn.writeBuffer?.length ?? 0,
  }));
});
