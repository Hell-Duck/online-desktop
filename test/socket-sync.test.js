const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createBoardServer } = require('../server-app');

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

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

  const op = { kind: 'add', obj: { id: 'shape-1', type: 'rect' } };
  const applyPromise = once(second, 'op:apply');
  first.emit('op', op);
  assert.deepEqual(await applyPromise, { op, dir: 'forward' });

  const undoPromise = once(second, 'op:apply');
  first.emit('undo');
  assert.deepEqual(await undoPromise, { op, dir: 'inverse' });

  const redoPromise = once(first, 'op:apply');
  second.emit('redo');
  assert.deepEqual(await redoPromise, { op, dir: 'forward' });
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
  assert.equal(app.rooms.getStats('text-room').undoCount, 0);

  const op = {
    kind: 'text', id: 'text-1',
    before: { id: 'text-1', text: '' },
    after: { id: 'text-1', text: 'привет' },
  };
  const commitPromise = once(second, 'op:apply');
  first.emit('op', op);
  assert.deepEqual(await commitPromise, {
    op: {
      ...op,
      before: { ...op.before, styles: {} },
      after: { ...op.after, styles: {} },
    },
    dir: 'forward',
  });
  assert.equal(app.rooms.getStats('text-room').undoCount, 1);
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
  first.emit('op', { kind: 'batch', items: {} });
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

  const collect = (socket) => new Promise((resolve) => {
    const values = [];
    socket.on('op:apply', (message) => {
      if (message.op.kind !== 'text') return;
      values.push(message.op);
      if (values.length === 2) resolve(values);
    });
  });
  const firstOps = collect(first);
  const secondOps = collect(second);
  const base = { id: 'text-1', text: '', styles: {} };
  first.emit('op', { kind: 'text', id: 'text-1', before: base, after: { ...base, text: 'A' } });
  second.emit('op', { kind: 'text', id: 'text-1', before: base, after: { ...base, text: 'B' } });

  const [seenByFirst, seenBySecond] = await Promise.all([firstOps, secondOps]);
  assert.deepEqual(seenByFirst, seenBySecond);
  assert.deepEqual(seenByFirst[1].before, seenByFirst[0].after);
  assert.equal(app.rooms.getStats('crossed-room').undoCount, 2);
});
