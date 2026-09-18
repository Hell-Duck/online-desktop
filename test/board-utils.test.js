const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRenderScheduler,
  createRevisionGate,
  createObjectIndex,
  createTextBatcher,
  createTrailingThrottle,
  fitWithin,
  transformFromView,
  viewFromTransform,
} = require('../public/board-utils');

function createFakeClock() {
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
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= now);
      due.sort((a, b) => a[1].due - b[1].due);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

test('shared scene center survives different viewport sizes', () => {
  const view = { centerX: 100, centerY: 50, zoom: 2 };
  const small = transformFromView(view, 800, 600);
  const large = transformFromView(view, 1600, 900);

  assert.deepEqual(small, [2, 0, 0, 2, 200, 200]);
  assert.deepEqual(large, [2, 0, 0, 2, 600, 350]);
  assert.deepEqual(viewFromTransform(small, 800, 600), view);
  assert.deepEqual(viewFromTransform(large, 1600, 900), view);
});

test('trailing throttle sends first and final values without flooding', () => {
  const clock = createFakeClock();
  const received = [];
  const send = createTrailingThrottle((value) => received.push(value), 50, clock);

  send('first');
  clock.advance(10);
  send('middle');
  clock.advance(10);
  send('last');

  assert.deepEqual(received, ['first']);
  clock.advance(30);
  assert.deepEqual(received, ['first', 'last']);
});

test('trailing throttle can flush and cancel pending values', () => {
  const clock = createFakeClock();
  const received = [];
  const send = createTrailingThrottle((value) => received.push(value), 50, clock);

  send(1);
  send(2);
  send.flush();
  send(3);
  send.cancel();
  clock.advance(100);

  assert.deepEqual(received, [1, 2]);
});

test('render scheduler combines requests into one animation frame', () => {
  const frames = [];
  let renders = 0;
  const schedule = createRenderScheduler(() => { renders += 1; }, (fn) => {
    frames.push(fn);
    return frames.length;
  });

  schedule();
  schedule();
  schedule();
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(renders, 1);
  schedule();
  assert.equal(frames.length, 1);
});

test('revision gate ignores stale shared views', () => {
  const applied = [];
  const accept = createRevisionGate((view) => applied.push(view.revision));

  assert.equal(accept({ revision: 4 }), true);
  assert.equal(accept({ revision: 3 }), false);
  assert.equal(accept({ revision: 5 }), true);
  assert.deepEqual(applied, [4, 5]);
});

test('object index replaces, removes, clears, and rebuilds objects by id', () => {
  const index = createObjectIndex();
  const first = { id: 'a', value: 1 };
  const replacement = { id: 'a', value: 2 };
  const second = { id: 'b', value: 3 };

  index.set(first);
  index.set(replacement);
  assert.equal(index.get('a'), replacement);
  index.rebuild([replacement, second, { value: 4 }]);
  assert.equal(index.get('b'), second);
  index.delete('a');
  assert.equal(index.get('a'), undefined);
  index.clear();
  assert.equal(index.get('b'), undefined);
});

test('text batcher retains first before state and latest after state', () => {
  const clock = createFakeClock();
  const sent = [];
  const batch = createTextBatcher((op) => sent.push(op), 150, clock);

  batch.change('text-1', { id: 'text-1', text: '' }, { id: 'text-1', text: 'a' });
  clock.advance(50);
  batch.change('text-1', { id: 'text-1', text: 'a' }, { id: 'text-1', text: 'ab' });
  clock.advance(149);
  assert.deepEqual(sent, []);
  clock.advance(1);

  assert.deepEqual(sent, [{
    kind: 'modify',
    before: { id: 'text-1', text: '' },
    after: { id: 'text-1', text: 'ab' },
  }]);
});

test('text batcher flushes one object or every pending object', () => {
  const clock = createFakeClock();
  const sent = [];
  const batch = createTextBatcher((op) => sent.push(op.after.text), 150, clock);
  batch.change('a', { id: 'a', text: '' }, { id: 'a', text: 'A' });
  batch.change('b', { id: 'b', text: '' }, { id: 'b', text: 'B' });

  batch.flush('a');
  assert.deepEqual(sent, ['A']);
  batch.flushAll();
  assert.deepEqual(sent, ['A', 'B']);
  clock.advance(200);
  assert.deepEqual(sent, ['A', 'B']);
});

test('fitWithin preserves ratio and never enlarges a small image', () => {
  assert.deepEqual(fitWithin(4000, 2000, 2048), {
    width: 2048,
    height: 1024,
    scale: 0.512,
  });
  assert.deepEqual(fitWithin(800, 600, 2048), {
    width: 800,
    height: 600,
    scale: 1,
  });
});
