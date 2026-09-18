const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_HISTORY_BYTES,
  RoomStateStore,
  normalizeView,
} = require('../lib/room-state');

test('normalizeView clamps zoom and rejects malformed values', () => {
  assert.deepEqual(normalizeView({ centerX: 10, centerY: -4, zoom: 99 }), {
    centerX: 10,
    centerY: -4,
    zoom: 5,
  });
  assert.deepEqual(normalizeView({ centerX: 0, centerY: 0, zoom: 0.01 }), {
    centerX: 0,
    centerY: 0,
    zoom: 0.15,
  });
  assert.equal(normalizeView({ centerX: Infinity, centerY: 0, zoom: 1 }), null);
  assert.equal(normalizeView({ centerX: 0, centerY: '0', zoom: 1 }), null);
});

test('room view revisions increase and invalid updates are ignored', () => {
  const store = new RoomStateStore();
  const first = store.updateView('room', { centerX: 1, centerY: 2, zoom: 1 });
  const invalid = store.updateView('room', { centerX: NaN, centerY: 2, zoom: 1 });
  const second = store.updateView('room', { centerX: 3, centerY: 4, zoom: 2 });

  assert.deepEqual(first, { centerX: 1, centerY: 2, zoom: 1, revision: 1 });
  assert.equal(invalid, null);
  assert.deepEqual(second, { centerX: 3, centerY: 4, zoom: 2, revision: 2 });
  assert.deepEqual(store.getView('room'), second);
});

test('ensureView creates the initial view without replacing an existing room view', () => {
  const store = new RoomStateStore();
  const initial = store.ensureView('room', { centerX: 100, centerY: 50, zoom: 1 });
  const retained = store.ensureView('room', { centerX: 999, centerY: 999, zoom: 3 });

  assert.deepEqual(initial, { centerX: 100, centerY: 50, zoom: 1, revision: 1 });
  assert.deepEqual(retained, initial);
});

test('history is bounded by count and keeps undo and redo consistent', () => {
  const store = new RoomStateStore({ maxHistoryCount: 3, maxHistoryBytes: 10_000 });
  for (let i = 0; i < 4; i += 1) store.pushOperation('room', { kind: 'add', id: i });

  assert.equal(store.getStats('room').undoCount, 3);
  assert.deepEqual(store.undo('room'), { kind: 'add', id: 3 });
  assert.deepEqual(store.redo('room'), { kind: 'add', id: 3 });

  store.undo('room');
  store.pushOperation('room', { kind: 'add', id: 9 });
  assert.equal(store.redo('room'), null);
});

test('history evicts old operations to stay within its byte budget', () => {
  const store = new RoomStateStore({ maxHistoryCount: 200, maxHistoryBytes: 240 });
  for (let i = 0; i < 10; i += 1) {
    store.pushOperation('room', { kind: 'add', id: i, payload: 'x'.repeat(70) });
  }

  const stats = store.getStats('room');
  assert.ok(stats.historyBytes <= 240);
  assert.ok(stats.undoCount < 10);
});

test('an operation larger than the room budget is applied but not retained', () => {
  const store = new RoomStateStore({ maxHistoryCount: 200, maxHistoryBytes: 100 });
  const kept = store.pushOperation('room', { kind: 'add', payload: 'x'.repeat(200) });

  assert.equal(kept, false);
  assert.equal(store.undo('room'), null);
  assert.equal(store.getStats('room').historyBytes, 0);
});

test('deleting a room clears its view and history', () => {
  const store = new RoomStateStore();
  store.updateView('room', { centerX: 1, centerY: 2, zoom: 1 });
  store.pushOperation('room', { kind: 'add', id: 1 });

  store.delete('room');

  assert.equal(store.getView('room'), null);
  assert.deepEqual(store.getStats('room'), {
    undoCount: 0,
    redoCount: 0,
    historyBytes: 0,
    maxHistoryBytes: MAX_HISTORY_BYTES,
  });
});
