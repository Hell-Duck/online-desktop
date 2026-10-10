const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { BoardSceneStore } = require('../lib/board-scene');
const { createRenderScheduler, createTrailingThrottle } = require('../public/board-utils');

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

const startedAt = performance.now();
const store = new BoardSceneStore();
let operationCount = 0;
let version = 0;
let maxCommandBytes = 0;

function push(kind, fields) {
  const command = { kind, ...fields, commandId: `load-${operationCount}`, expectedVersion: version };
  const bytes = Buffer.byteLength(JSON.stringify(command));
  const answer = store.apply('load-room', command);
  assert.equal(answer.rejected, undefined);
  version = answer.version;
  maxCommandBytes = Math.max(maxCommandBytes, bytes);
  operationCount += 1;
}

for (let i = 0; i < 600; i += 1) {
  push('add', { obj: { id: `path-${i}`, type: 'path', path: `M 0 0 Q ${i % 80} ${i % 50} 100 100` } });
}
for (let i = 0; i < 120; i += 1) {
  push('add', { obj: { id: `text-${i}`, type: 'i-text', text: '', styles: {} } });
  push('text', { id: `text-${i}`, text: 'x'.repeat(20), styles: {} });
}
for (let i = 0; i < 150; i += 1) {
  push('add', { obj: { id: `shape-${i}`, type: i % 2 ? 'rect' : 'ellipse', width: 120, height: 80 } });
}
for (let i = 0; i < 12; i += 1) {
  push('add', { obj: { id: `image-${i}`, type: 'image', src: '/board-assets/' + 'a'.repeat(64) } });
}
for (let i = 0; i < 24; i += 1) {
  push('erase', { targets: Array.from({ length: 12 }, (_, n) => ({
    id: `image-${n}`, baseCount: i,
    eraser: { type: 'eraser', objects: [{ type: 'path', path: [['M', 0, i], ['L', 1000, i]] }] },
  })) });
}

const clock = fakeClock();
let viewMessages = 0;
const sendView = createTrailingThrottle(() => { viewMessages += 1; }, 50, clock);
for (let i = 0; i < 1000; i += 1) {
  sendView({ centerX: i, centerY: -i, zoom: 1 + (i % 10) / 10 });
  clock.advance(5);
}
sendView.flush();

const frames = [];
let renderRequests = 0;
const scheduleRender = createRenderScheduler(() => { renderRequests += 1; }, (fn) => {
  frames.push(fn);
  return frames.length;
});
for (let i = 0; i < 1000; i += 1) scheduleRender();
frames.shift()();

const stats = store.getStats('load-room');
const result = {
  operationCount,
  historyBytes: stats.historyBytes,
  retainedHistory: stats.undoCount,
  sceneBytes: stats.sceneBytes,
  maxCommandBytes,
  heapUsedMiB: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)),
  inputViewEvents: 1000,
  viewMessages,
  inputRenderRequests: 1000,
  renderRequests,
  elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
};

assert.ok(result.historyBytes <= 8 * 1024 * 1024);
assert.ok(result.retainedHistory <= 200);
assert.ok(result.maxCommandBytes < 256 * 1024);
assert.ok(result.viewMessages <= 102);
assert.equal(result.renderRequests, 1);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
