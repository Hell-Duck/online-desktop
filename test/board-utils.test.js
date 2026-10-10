const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyTextSnapshot,
  createRenderScheduler,
  createRevisionGate,
  createObjectIndex,
  createTextBatcher,
  createTextPreviewGate,
  createTextSessionSync,
  createSnapshotReceiver,
  encodeImageWithinLimit,
  eraserDelta,
  objectChanges,
  createTrailingThrottle,
  fitWithin,
  replaceCanvasObjectPreservingStack,
  transformFromView,
  viewFromTransform,
} = require('../public/board-utils');

test('compact object changes omit image data and eraser sends only newly added path', () => {
  const before = { id: 'a', type: 'image', src: '/board-assets/' + 'a'.repeat(64), left: 0,
    eraser: { objects: [{ path: [1] }] } };
  const after = { ...before, left: 20, eraser: { objects: [...before.eraser.objects, { path: [2] }] } };
  assert.deepEqual(objectChanges(before, after), { left: 20 });
  assert.deepEqual(eraserDelta(before, after), { baseCount: 1,
    eraser: { objects: [{ path: [2] }] } });
  const receiver = createSnapshotReceiver();
  assert.equal(receiver.accept({ session: 's', index: 0, total: 1, version: 1,
    data: JSON.stringify({ version: 1, objects: [after] }) }), true);
  assert.deepEqual(receiver.result().objects, [after]);
});

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

test('image encoding reduces dimensions until PNG fits without changing transparency format', async () => {
  const attempts = [];
  const source = { naturalWidth: 1200, naturalHeight: 600 };
  const encoded = await encodeImageWithinLimit(source, 'image/png', 20, () => ({
    getContext() { return { drawImage() {} }; },
    toBlob(callback, type) {
      attempts.push({ width: this.width, height: this.height, type });
      callback({ size: this.width > 600 ? 30 : 15, type });
    },
  }));
  assert.equal(encoded.size, 15);
  assert.deepEqual(attempts, [
    { width: 1200, height: 600, type: 'image/png' },
    { width: 600, height: 300, type: 'image/png' },
  ]);
});

test('replacing a synchronized object preserves its canvas layer', () => {
  const below = { id: 'circle' };
  const image = { id: 'image' };
  const above = { id: 'note' };
  const replacement = { id: 'circle' };
  const objects = [below, image, above];
  const canvas = {
    getObjects: () => objects,
    remove(object) { objects.splice(objects.indexOf(object), 1); },
    insertAt(object, index) { objects.splice(index, 0, object); },
    add(object) { objects.push(object); },
  };

  replaceCanvasObjectPreservingStack(canvas, below, replacement);

  assert.deepEqual(objects, [replacement, image, above]);
});

test('text session streams previews but commits one undoable operation', () => {
  const clock = createFakeClock();
  const previews = [];
  const commits = [];
  const sync = createTextSessionSync({
    preview: (message) => previews.push(message),
    commit: (operation) => commits.push(operation),
  }, 100, clock);

  sync.change('text-1', { id: 'text-1', text: '' }, { id: 'text-1', text: 'a' });
  clock.advance(20);
  sync.change('text-1', { id: 'text-1', text: 'a' }, { id: 'text-1', text: 'ab' });
  clock.advance(20);
  sync.change('text-1', { id: 'text-1', text: 'ab' }, { id: 'text-1', text: 'abc' });

  assert.deepEqual(previews.map((item) => item.snapshot.text), ['a']);
  clock.advance(60);
  assert.deepEqual(previews.map((item) => item.snapshot.text), ['a', 'abc']);
  assert.equal(commits.length, 0);

  assert.equal(sync.finish('text-1'), true);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], {
    kind: 'text',
    id: 'text-1',
    before: { id: 'text-1', text: '' },
    after: { id: 'text-1', text: 'abc' },
  });
});

test('text session can be cancelled when a competing final commit arrives', () => {
  const commits = [];
  const sync = createTextSessionSync({ preview() {}, commit: (op) => commits.push(op) }, 100);
  sync.change('text-1', { id: 'text-1', text: 'base' }, { id: 'text-1', text: 'draft' });

  assert.equal(sync.has('text-1'), true);
  assert.equal(sync.cancel('text-1'), true);
  assert.equal(sync.has('text-1'), false);
  assert.equal(sync.finish('text-1'), false);
  assert.deepEqual(commits, []);
});

test('all text sessions can be cancelled by a remote board clear', () => {
  const commits = [];
  const sync = createTextSessionSync({ preview() {}, commit: (op) => commits.push(op) }, 100);
  sync.change('a', { id: 'a', text: '' }, { id: 'a', text: 'A' });
  sync.change('b', { id: 'b', text: '' }, { id: 'b', text: 'B' });
  sync.cancelAll();
  sync.finishAll();
  assert.equal(sync.has('a'), false);
  assert.equal(sync.has('b'), false);
  assert.deepEqual(commits, []);
});

test('text session accepts formatting changes in the same final operation', () => {
  const commits = [];
  const sync = createTextSessionSync({ preview() {}, commit: (op) => commits.push(op) }, 100);
  const before = { id: 'text-1', text: 'a', styles: {} };
  sync.change('text-1', before, { id: 'text-1', text: 'ab', styles: {} });
  sync.change('text-1', before, {
    id: 'text-1', text: 'ab', styles: { 0: { 0: { fontWeight: 'bold' } } },
  });
  sync.finish('text-1');

  assert.deepEqual(commits[0].before, before);
  assert.equal(commits[0].after.styles[0][0].fontWeight, 'bold');
});

test('text preview revisions reject stale snapshots per participant and object', () => {
  const applied = [];
  const accept = createTextPreviewGate((message) => applied.push(message.snapshot.text));

  assert.equal(accept({ from: 'a', id: 'text-1', revision: 2, snapshot: { text: 'new' } }), true);
  assert.equal(accept({ from: 'a', id: 'text-1', revision: 1, snapshot: { text: 'old' } }), false);
  assert.equal(accept({ from: 'b', id: 'text-1', revision: 1, snapshot: { text: 'other' } }), true);
  assert.deepEqual(applied, ['new', 'other']);
});

test('text snapshots update an existing Fabric text object in place', () => {
  const target = {
    id: 'text-1', text: 'старый', styles: {}, dimensions: 0, coords: 0,
    set(values) { Object.assign(this, values); },
    initDimensions() { this.dimensions += 1; },
    setCoords() { this.coords += 1; },
  };
  const original = target;

  const result = applyTextSnapshot(target, {
    id: 'text-1', text: 'новый', styles: { 0: { 0: { fontWeight: 'bold' } } },
  });

  assert.equal(result, original);
  assert.equal(target.text, 'новый');
  assert.deepEqual(target.styles, { 0: { 0: { fontWeight: 'bold' } } });
  assert.equal(target.dimensions, 1);
  assert.equal(target.coords, 1);
});

test('text snapshots preserve non-string falsy-looking text safely', () => {
  const target = { set(values) { Object.assign(this, values); } };
  applyTextSnapshot(target, { text: '0', styles: null });
  assert.equal(target.text, '0');
  assert.deepEqual(target.styles, {});
});
