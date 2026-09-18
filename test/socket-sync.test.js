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
