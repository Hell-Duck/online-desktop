(function exposeBoardUtils(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BoardUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBoardUtils() {
  function transformFromView(view, width, height) {
    const zoom = view.zoom;
    return [
      zoom,
      0,
      0,
      zoom,
      width / 2 - zoom * view.centerX,
      height / 2 - zoom * view.centerY,
    ];
  }

  function viewFromTransform(vpt, width, height) {
    const zoom = vpt[0];
    return {
      centerX: (width / 2 - vpt[4]) / zoom,
      centerY: (height / 2 - vpt[5]) / zoom,
      zoom,
    };
  }

  function createTrailingThrottle(fn, intervalMs, timers = {}) {
    const now = timers.now || (() => Date.now());
    const setTimer = timers.setTimeout || ((cb, ms) => setTimeout(cb, ms));
    const clearTimer = timers.clearTimeout || ((id) => clearTimeout(id));
    let lastCall = -Infinity;
    let timerId = null;
    let lastArgs = null;

    function invoke() {
      if (!lastArgs) return;
      const args = lastArgs;
      lastArgs = null;
      timerId = null;
      lastCall = now();
      fn(...args);
    }

    function throttled(...args) {
      lastArgs = args;
      const remaining = intervalMs - (now() - lastCall);
      if (remaining <= 0) {
        if (timerId !== null) clearTimer(timerId);
        invoke();
      } else if (timerId === null) {
        timerId = setTimer(invoke, remaining);
      }
    }

    throttled.flush = () => {
      if (timerId !== null) clearTimer(timerId);
      invoke();
    };
    throttled.cancel = () => {
      if (timerId !== null) clearTimer(timerId);
      timerId = null;
      lastArgs = null;
    };
    return throttled;
  }

  function createRenderScheduler(render, raf = (fn) => requestAnimationFrame(fn)) {
    let pending = false;
    return function scheduleRender() {
      if (pending) return;
      pending = true;
      raf(() => {
        pending = false;
        render();
      });
    };
  }

  function createRevisionGate(apply) {
    let latestRevision = -1;
    return function accept(view) {
      if (!view || !Number.isFinite(view.revision) || view.revision <= latestRevision) return false;
      latestRevision = view.revision;
      apply(view);
      return true;
    };
  }

  function createObjectIndex() {
    const objects = new Map();
    return {
      get: (id) => objects.get(id),
      set(object) {
        if (object?.id) objects.set(object.id, object);
        return object;
      },
      delete: (id) => objects.delete(id),
      clear: () => objects.clear(),
      rebuild(items) {
        objects.clear();
        for (const object of items || []) {
          if (object?.id) objects.set(object.id, object);
        }
      },
    };
  }

  function createTextBatcher(send, delayMs, timers = {}) {
    const setTimer = timers.setTimeout || ((cb, ms) => setTimeout(cb, ms));
    const clearTimer = timers.clearTimeout || ((id) => clearTimeout(id));
    const pending = new Map();

    function flush(id) {
      const item = pending.get(id);
      if (!item) return false;
      clearTimer(item.timerId);
      pending.delete(id);
      send({ kind: 'modify', before: item.before, after: item.after });
      return true;
    }

    function change(id, before, after) {
      if (!id) return;
      const item = pending.get(id);
      if (item) {
        clearTimer(item.timerId);
        item.after = after;
        item.timerId = setTimer(() => flush(id), delayMs);
      } else {
        pending.set(id, {
          before,
          after,
          timerId: setTimer(() => flush(id), delayMs),
        });
      }
    }

    function flushAll() {
      for (const id of [...pending.keys()]) flush(id);
    }

    return { change, flush, flushAll };
  }

  function createTextSessionSync(channels, intervalMs, timers = {}) {
    const sessions = new Map();
    const revisions = new Map();

    function createSession(id, before) {
      const sendPreview = createTrailingThrottle((snapshot) => {
        const revision = (revisions.get(id) || 0) + 1;
        revisions.set(id, revision);
        channels.preview({ id, revision, snapshot });
      }, intervalMs, timers);
      const session = { before, after: before, sendPreview };
      sessions.set(id, session);
      return session;
    }

    function change(id, before, after) {
      if (!id || !after) return false;
      const session = sessions.get(id) || createSession(id, before);
      session.after = after;
      session.sendPreview(after);
      return true;
    }

    function finish(id) {
      const session = sessions.get(id);
      if (!session) return false;
      session.sendPreview.flush();
      session.sendPreview.cancel();
      sessions.delete(id);
      channels.commit({ kind: 'text', id, before: session.before, after: session.after });
      return true;
    }

    function finishAll() {
      for (const id of [...sessions.keys()]) finish(id);
    }

    function cancel(id) {
      const session = sessions.get(id);
      if (!session) return false;
      session.sendPreview.cancel();
      sessions.delete(id);
      return true;
    }

    function cancelAll() {
      for (const id of [...sessions.keys()]) cancel(id);
    }

    return { cancel, cancelAll, change, finish, finishAll, has: (id) => sessions.has(id) };
  }

  function createTextPreviewGate(apply) {
    const latest = new Map();
    return function accept(message) {
      if (!message || !message.from || !message.id ||
          !Number.isFinite(message.revision) || !message.snapshot) return false;
      const key = `${message.from}:${message.id}`;
      if (message.revision <= (latest.get(key) || 0)) return false;
      latest.set(key, message.revision);
      apply(message);
      return true;
    };
  }

  function applyTextSnapshot(target, snapshot) {
    if (!target || !snapshot) return null;
    const values = { text: typeof snapshot.text === 'string' ? snapshot.text : '', styles: snapshot.styles || {} };
    const fields = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'underline', 'linethrough',
      'overline', 'fill', 'textAlign', 'lineHeight', 'charSpacing',
    ];
    fields.forEach((field) => { if (snapshot[field] !== undefined) values[field] = snapshot[field]; });
    target.set(values);
    if (typeof target.initDimensions === 'function') target.initDimensions();
    if (typeof target.setCoords === 'function') target.setCoords();
    return target;
  }

  function fitWithin(width, height, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      scale,
    };
  }

  function replaceCanvasObjectPreservingStack(canvas, existing, replacement) {
    if (!existing) {
      canvas.add(replacement);
      return;
    }
    const stackIndex = canvas.getObjects().indexOf(existing);
    canvas.remove(existing);
    if (stackIndex >= 0 && typeof canvas.insertAt === 'function') {
      canvas.insertAt(replacement, stackIndex, false);
    } else {
      canvas.add(replacement);
    }
  }

  return {
    applyTextSnapshot,
    createRenderScheduler,
    createRevisionGate,
    createObjectIndex,
    createTextBatcher,
    createTextPreviewGate,
    createTextSessionSync,
    createTrailingThrottle,
    fitWithin,
    replaceCanvasObjectPreservingStack,
    transformFromView,
    viewFromTransform,
  };
});
