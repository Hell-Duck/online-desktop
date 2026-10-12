const test = require('node:test');
const assert = require('node:assert/strict');
const { BoardSceneStore } = require('../lib/board-scene');

const rect = (id, left = 0) => ({ id, type: 'rect', left, top: 0, width: 20, height: 20 });
const command = (commandId, expectedVersion, kind, fields = {}) => ({ commandId, expectedVersion, kind, ...fields });

test('server orders edits, rejects stale versions and deduplicates retries', () => {
  const store = new BoardSceneStore();
  const a = store.apply('lesson', command('a', 0, 'add', { obj: rect('r') }));
  assert.equal(a.version, 1);
  assert.deepEqual(store.apply('lesson', command('a', 0, 'add', { obj: rect('r') })), { version: a.version });
  assert.deepEqual(store.apply('lesson', command('b', 0, 'add', { obj: rect('s') })), { rejected: 'stale', version: 1 });
  assert.equal(store.apply('lesson', command('b', 1, 'add', { obj: rect('s') })).version, 2);
  assert.deepEqual(store.snapshot('lesson').objects, [rect('r'), rect('s')]);
});

test('patch, remove, clear, undo and redo all advance one canonical version', () => {
  const store = new BoardSceneStore();
  store.apply('lesson', command('a', 0, 'add', { obj: rect('r') }));
  assert.equal(store.apply('lesson', command('b', 1, 'patch', { id: 'r', changes: { left: 30 } })).version, 2);
  assert.equal(store.snapshot('lesson').objects[0].left, 30);
  assert.equal(store.undo('lesson', 'c', 2).version, 3);
  assert.equal(store.snapshot('lesson').objects[0].left, 0);
  assert.equal(store.redo('lesson', 'd', 3).version, 4);
  assert.equal(store.snapshot('lesson').objects[0].left, 30);
  store.apply('lesson', command('e', 4, 'remove', { id: 'r' }));
  assert.deepEqual(store.snapshot('lesson').objects, []);
  store.undo('lesson', 'f', 5);
  assert.equal(store.snapshot('lesson').objects[0].left, 30);
  store.apply('lesson', command('g', 6, 'clear'));
  assert.deepEqual(store.snapshot('lesson').objects, []);
  store.undo('lesson', 'h', 7);
  assert.equal(store.snapshot('lesson').objects.length, 1);
});

test('invalid, over-budget, and fifth rooms cannot change accepted scene', () => {
  const store = new BoardSceneStore({ roomBytes: 250, totalBytes: 900, historyBytes: 100, maxRooms: 4 });
  const bad = store.apply('a', command('bad', 0, 'add', { obj: { id: 'image', type: 'image', src: 'data:image/png;base64,xxx' } }));
  assert.equal(bad.rejected, 'invalid');
  assert.equal(store.snapshot('a').version, 0);
  const oversized = store.apply('a', command('large', 0, 'add', { obj: { ...rect('big'), label: 'x'.repeat(400) } }));
  assert.equal(oversized.rejected, 'quota');
  assert.equal(store.snapshot('a').objects.length, 0);
  for (const room of ['a', 'b', 'c', 'd']) assert.equal(store.join(room).version, 0);
  assert.deepEqual(store.join('e'), { rejected: 'quota' });
});

test('small changes on a large scene keep multiple undo steps within a small history budget', () => {
  const store = new BoardSceneStore({ roomBytes: 100000, totalBytes: 200000, historyBytes: 8000 });
  let version = 0;
  for (let i = 0; i < 80; i += 1) {
    version = store.apply('lesson', command(`add-${i}`, version, 'add', {
      obj: { ...rect(`r-${i}`), label: 'x'.repeat(400) },
    })).version;
  }
  for (let i = 0; i < 10; i += 1) {
    version = store.apply('lesson', command(`move-${i}`, version, 'patch', {
      id: 'r-0', changes: { left: i + 1 },
    })).version;
  }
  assert.ok(store.getStats('lesson').undoCount >= 10);
  for (let i = 0; i < 10; i += 1) version = store.undo('lesson', `undo-${i}`, version).version;
  assert.equal(store.snapshot('lesson').objects[0].left, 0);
});

test('eraser appends one bounded path per target atomically without copying image bytes', () => {
  const store = new BoardSceneStore();
  const src = '/board-assets/' + 'a'.repeat(64);
  store.apply('room', command('image', 0, 'add', { obj: { id: 'img', type: 'image', src } }));
  const path = { type: 'path', path: [['M', 1, 2], ['L', 3, 4]] };
  const delta = { id: 'img', baseCount: 0, eraser: { type: 'eraser', objects: [path] } };
  const accepted = store.apply('room', command('erase', 1, 'erase', { targets: [delta] }));
  assert.equal(accepted.version, 2);
  assert.equal(JSON.stringify(accepted).includes('data:image'), false);
  assert.deepEqual(store.snapshot('room').objects[0].eraser.objects, [path]);
  assert.equal(store.apply('room', command('bad', 2, 'erase', { targets: [delta] })).rejected, 'invalid');
  assert.equal(store.snapshot('room').version, 2);
  store.undo('room', 'undo-erase', 2);
  assert.equal(store.snapshot('room').objects[0].eraser, undefined);
  store.redo('room', 'redo-erase', 3);
  assert.deepEqual(store.snapshot('room').objects[0].eraser.objects, [path]);
});

test('overlarge eraser stroke is rejected without partial changes', () => {
  const store = new BoardSceneStore();
  store.apply('room', command('a', 0, 'add', { obj: rect('r') }));
  assert.equal(store.apply('room', command('b', 1, 'erase', { targets: [{ id: 'r', baseCount: 0,
    eraser: { objects: [{ path: 'x'.repeat(300000) }] },
  }] })).rejected, 'quota');
  assert.equal(store.snapshot('room').version, 1);
  assert.equal(store.snapshot('room').objects[0].eraser, undefined);
});

test('incremental scene byte count matches serialized scene through edits and history', () => {
  const store = new BoardSceneStore();
  const size = (value) => Buffer.byteLength(JSON.stringify(value));
  const check = () => {
    const snapshot = store.snapshot('room');
    assert.equal(store.getStats('room').sceneBytes, size(snapshot.objects) + size(snapshot.sheet));
  };
  check();
  let v = 0;
  for (let i = 0; i < 70; i++) {
    v = store.apply('room', command(`add-${i}`, v, 'add', { obj: rect(`r-${i}`) })).version;
    check();
  }
  v = store.apply('room', command('patch', v, 'patch', { id: 'r-3', changes: { left: 90 } })).version; check();
  v = store.apply('room', command('text', v, 'text', { id: 'r-4', text: 'строка', styles: {} })).version; check();
  v = store.apply('room', command('remove', v, 'remove', { id: 'r-2' })).version; check();
  v = store.apply('room', command('sheet', v, 'sheet', { type: 'grid' })).version; check();
  v = store.apply('room', command('clear', v, 'clear')).version; check();
  v = store.undo('room', 'undo', v).version; check();
  store.redo('room', 'redo', v); check();
});
