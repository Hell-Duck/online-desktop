const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createBoardServer } = require('../server-app');
const { createSnapshotReceiver } = require('../lib/snapshot-stream');

const tinyPng = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('HTTP image upload returns a reusable asset URL and rejects oversized images', async (t) => {
  const app = createBoardServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const joined = connect(base, { transports: ['websocket'] });
  t.after(() => joined.disconnect());
  await once(joined, 'connect');
  joined.emit('join', { room: 'assets-room' });
  await once(joined, 'peers');
  const uploaded = await fetch(`${base}/board-assets?room=assets-room`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: tinyPng,
  });
  assert.equal(uploaded.status, 201);
  const asset = await uploaded.json();
  assert.match(asset.url, /^\/board-assets\/[a-f0-9]{64}$/);
  const retrieved = await fetch(base + asset.url);
  assert.equal(retrieved.status, 200);
  assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()), tinyPng);

  const missing = await joined.timeout(2000).emitWithAck('scene:command', {
    kind: 'add', commandId: 'bad-image', expectedVersion: 0,
    obj: { id: 'missing', type: 'image', src: '/board-assets/' + 'b'.repeat(64) },
  });
  assert.equal(missing.rejected, 'invalid');

  const huge = await fetch(`${base}/board-assets?room=assets-room`, {
    method: 'POST', headers: { 'content-type': 'image/png' },
    body: Buffer.concat([tinyPng, Buffer.alloc(2 * 1024 * 1024)]),
  });
  assert.equal(huge.status, 413);
  assert.deepEqual(await huge.json(), { error: 'too_large' });
});

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

test('versioned commands have one ordered result and reject crossed edits', async (t) => {
  const app = createBoardServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const first = connect(url, { transports: ['websocket'] });
  const second = connect(url, { transports: ['websocket'] });
  t.after(async () => { first.disconnect(); second.disconnect(); await app.close(); });
  await Promise.all([once(first, 'connect'), once(second, 'connect')]);
  first.emit('join', { room: 'canonical' });
  await once(first, 'peers');
  const both = once(first, 'peers');
  second.emit('join', { room: 'canonical' });
  assert.equal(await both, 2);
  const cmd = { kind: 'add', commandId: 'cmd-1', expectedVersion: 0,
    obj: { type: 'rect', id: 'rect-1', left: 1 } };
  const broadcast = once(second, 'scene:change');
  assert.equal((await first.timeout(2000).emitWithAck('scene:command', cmd)).version, 1);
  assert.equal((await broadcast).version, 1);
  const conflict = await second.timeout(2000).emitWithAck('scene:command', {
    ...cmd, commandId: 'cmd-2', obj: { ...cmd.obj, id: 'rect-2' },
  });
  assert.deepEqual(conflict, { rejected: 'stale', version: 1 });
  assert.deepEqual(await first.timeout(2000).emitWithAck('scene:command', cmd), { version: 1 });
  assert.deepEqual(app.scene.snapshot('canonical').objects, [cmd.obj]);
});

test('server streams the canonical room in acknowledged bounded chunks', async (t) => {
  const app = createBoardServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const socket = connect(`http://127.0.0.1:${app.server.address().port}`, { transports: ['websocket'] });
  t.after(async () => { socket.disconnect(); await app.close(); });
  await once(socket, 'connect');
  socket.emit('join', { room: 'streamed' });
  await once(socket, 'peers');
  const objects = Array.from({ length: 6 }, (_, index) =>
    ({ id: `large-${index}`, type: 'rect', label: 'x'.repeat(120000) }));
  for (let index = 0; index < objects.length; index++) {
    assert.equal((await socket.timeout(2000).emitWithAck('scene:command', {
      kind: 'add', commandId: `one-${index}`, expectedVersion: index, obj: objects[index],
    })).version, index + 1);
  }
  const receiver = createSnapshotReceiver();
  const packets = [];
  socket.on('scene:chunk', (packet, ack) => { packets.push(packet); ack(receiver.accept(packet)); });
  const ready = once(socket, 'scene:ready');
  socket.emit('scene:sync');
  assert.equal((await ready).version, objects.length);
  assert.ok(packets.length > 2);
  assert.ok(packets.every((packet) => Buffer.byteLength(JSON.stringify(packet)) <= 256 * 1024));
  assert.deepEqual(receiver.result().objects, objects);
});

test('brief disconnect keeps scene and peer count; expired room releases assets', async (t) => {
  const app = createBoardServer({ roomGraceMs: 100 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const first = connect(url, { transports: ['websocket'] });
  const second = connect(url, { transports: ['websocket'], autoConnect: false });
  t.after(async () => { first.disconnect(); second.disconnect(); await app.close(); });
  await once(first, 'connect');
  first.emit('join', { room: 'ephemeral' });
  assert.equal(await once(first, 'peers'), 1);
  assert.equal((await first.timeout(2000).emitWithAck('scene:command', {
    kind: 'add', commandId: 'a', expectedVersion: 0,
    obj: { id: 'x', type: 'rect' },
  })).version, 1);
  first.disconnect();
  second.connect();
  await once(second, 'connect');
  second.emit('join', { room: 'ephemeral' });
  assert.equal(await once(second, 'peers'), 1);
  const receiver = createSnapshotReceiver();
  second.on('scene:chunk', (packet, ack) => ack(receiver.accept(packet)));
  const ready = once(second, 'scene:ready');
  second.emit('scene:sync');
  assert.equal((await ready).version, 1);
  assert.equal(receiver.result().objects[0].id, 'x');
  second.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(app.scene.rooms.has('ephemeral'), false);
});

test('one socket cannot leave orphaned rooms by repeatedly joining new names', async (t) => {
  const app = createBoardServer({ roomGraceMs: 20 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const socket = connect(`http://127.0.0.1:${app.server.address().port}`, { transports: ['websocket'] });
  t.after(async () => { socket.disconnect(); await app.close(); });
  await once(socket, 'connect');
  socket.emit('join', { room: 'first' });
  await once(socket, 'peers');
  const error = once(socket, 'scene:error');
  socket.emit('join', { room: 'second' });
  assert.equal((await error).reason, 'invalid');
  assert.equal(app.scene.rooms.has('second'), false);
  socket.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.scene.rooms.has('first'), false);
});

test('two participants share view, operations, undo, and redo', async (t) => {
  const app = createBoardServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const first = connect(url, { transports: ['websocket'] });
  const second = connect(url, { transports: ['websocket'] });

  t.after(async () => {
    first.disconnect();
    second.disconnect();
    await app.close();
  });

  await Promise.all([once(first, 'connect'), once(second, 'connect')]);
  first.emit('join', {
    room: 'integration-room',
    initialView: { centerX: 10, centerY: 20, zoom: 1 },
  });
  await once(first, 'view:set');
  second.emit('join', {
    room: 'integration-room',
    initialView: { centerX: 999, centerY: 999, zoom: 3 },
  });
  const joinedView = await once(second, 'view:set');
  assert.deepEqual(joinedView, { centerX: 10, centerY: 20, zoom: 1, revision: 1 });

  const sharedViewPromise = once(first, 'view:set');
  second.emit('view:set', { centerX: 40, centerY: -5, zoom: 2 });
  assert.deepEqual(await sharedViewPromise, {
    centerX: 40, centerY: -5, zoom: 2, revision: 2,
  });

  const op = { kind: 'add', commandId: 'a', expectedVersion: 0,
    obj: { id: 'shape-1', type: 'rect' } };
  const applyPromise = once(second, 'scene:change');
  assert.equal((await first.timeout(2000).emitWithAck('scene:command', op)).version, 1);
  assert.deepEqual(await applyPromise, { version: 1, operation: op, direction: 'forward' });

  const undoPromise = once(second, 'scene:change');
  assert.equal((await first.timeout(2000).emitWithAck('scene:command', {
    kind: 'undo', commandId: 'b', expectedVersion: 1,
  })).version, 2);
  assert.equal((await undoPromise).direction, 'inverse');
  assert.deepEqual(app.scene.snapshot('integration-room').objects, []);

  const redoPromise = once(first, 'scene:change');
  assert.equal((await second.timeout(2000).emitWithAck('scene:command', {
    kind: 'redo', commandId: 'c', expectedVersion: 2,
  })).version, 3);
  assert.equal((await redoPromise).version, 3);
  assert.deepEqual(app.scene.snapshot('integration-room').objects, [op.obj]);
});

test('text previews are relayed without history and final text is undoable', async (t) => {
  const app = createBoardServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const first = connect(url, { transports: ['websocket'] });
  const second = connect(url, { transports: ['websocket'] });

  t.after(async () => {
    first.disconnect();
    second.disconnect();
    await app.close();
  });

  await Promise.all([once(first, 'connect'), once(second, 'connect')]);
  first.emit('join', { room: 'text-room', initialView: { centerX: 0, centerY: 0, zoom: 1 } });
  await once(first, 'view:set');
  second.emit('join', { room: 'text-room', initialView: { centerX: 0, centerY: 0, zoom: 1 } });
  await once(second, 'view:set');

  const previewPromise = once(second, 'text:preview');
  first.emit('text:preview', {
    id: 'text-1', revision: 1, snapshot: { id: 'text-1', text: 'привет' },
  });
  const preview = await previewPromise;
  assert.equal(preview.id, 'text-1');
  assert.equal(preview.revision, 1);
  assert.equal(preview.snapshot.text, 'привет');
  assert.equal(typeof preview.from, 'string');
  assert.equal(app.scene.getStats('text-room').undoCount, 0);

  const added = once(second, 'scene:change');
  assert.equal((await first.timeout(2000).emitWithAck('scene:command', {
    kind: 'add', commandId: 'a', expectedVersion: 0,
    obj: { id: 'text-1', type: 'i-text', text: '', styles: {} },
  })).version, 1);
  await added;
  const commitPromise = once(second, 'scene:change');
  const op = { kind: 'text', commandId: 'b', expectedVersion: 1,
    id: 'text-1', text: 'привет', styles: {}, fields: { fill: '#22c55e' } };
  assert.equal((await first.timeout(2000).emitWithAck('scene:command', op)).version, 2);
  assert.equal((await commitPromise).operation.text, 'привет');
  assert.equal(app.scene.getStats('text-room').undoCount, 2);
  assert.equal(app.scene.snapshot('text-room').objects[0].fill, '#22c55e');
});

test('invalid or oversized text previews are rejected', async (t) => {
  const app = createBoardServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const first = connect(url, { transports: ['websocket'] });
  const second = connect(url, { transports: ['websocket'] });
  t.after(async () => { first.disconnect(); second.disconnect(); await app.close(); });
  await Promise.all([once(first, 'connect'), once(second, 'connect')]);
  first.emit('join', { room: 'validation-room', initialView: { centerX: 0, centerY: 0, zoom: 1 } });
  await once(first, 'view:set');
  second.emit('join', { room: 'validation-room', initialView: { centerX: 0, centerY: 0, zoom: 1 } });
  await once(second, 'view:set');

  let received = 0;
  second.on('text:preview', () => { received += 1; });
  first.emit('text:preview', { id: 'x', revision: 1.5, snapshot: { text: 'bad', styles: {} } });
  first.emit('text:preview', { id: 'x', revision: 2, snapshot: { text: 'x'.repeat(100001), styles: {} } });
  first.emit('text:preview', { id: 'x', revision: 3, snapshot: { text: 42, styles: {} } });
  assert.equal((await first.timeout(2000).emitWithAck('scene:command', {
    kind: 'batch', commandId: 'invalid', expectedVersion: 0, items: {},
  })).rejected, 'invalid');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received, 0);

  const valid = once(second, 'text:preview');
  first.emit('text:preview', { id: 'x', revision: 4, snapshot: { text: 'still alive', styles: {} } });
  assert.equal((await valid).snapshot.text, 'still alive');
});

test('crossed text commits are serialized identically for both participants', async (t) => {
  const app = createBoardServer();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const first = connect(url, { transports: ['websocket'] });
  const second = connect(url, { transports: ['websocket'] });
  t.after(async () => { first.disconnect(); second.disconnect(); await app.close(); });
  await Promise.all([once(first, 'connect'), once(second, 'connect')]);
  first.emit('join', { room: 'crossed-room', initialView: { centerX: 0, centerY: 0, zoom: 1 } });
  await once(first, 'view:set');
  second.emit('join', { room: 'crossed-room', initialView: { centerX: 0, centerY: 0, zoom: 1 } });
  await once(second, 'view:set');

  await first.timeout(2000).emitWithAck('scene:command', { kind: 'add', commandId: 'add',
    expectedVersion: 0, obj: { id: 'text-1', type: 'i-text', text: '', styles: {} } });
  const text = (id, version, value) => ({ kind: 'text', commandId: id,
    expectedVersion: version, id: 'text-1', text: value, styles: {} });
  const [a, b] = await Promise.all([
    first.timeout(2000).emitWithAck('scene:command', text('a', 1, 'A')),
    second.timeout(2000).emitWithAck('scene:command', text('b', 1, 'B')),
  ]);
  assert.deepEqual([a, b].filter((result) => result.rejected).map((result) => result.rejected), ['stale']);
  assert.equal(app.scene.snapshot('crossed-room').version, 2);
  const retry = a.rejected ? text('a-retry', 2, 'A') : text('b-retry', 2, 'B');
  assert.equal((await (a.rejected ? first : second).timeout(2000)
    .emitWithAck('scene:command', retry)).version, 3);
  assert.equal(app.scene.snapshot('crossed-room').objects[0].text, retry.text);
  assert.equal(app.scene.getStats('crossed-room').undoCount, 3);
});
