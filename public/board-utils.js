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

  function fitWithin(width, height, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      scale,
    };
  }

  return {
    createRenderScheduler,
    createRevisionGate,
    createObjectIndex,
    createTextBatcher,
    createTrailingThrottle,
    fitWithin,
    transformFromView,
    viewFromTransform,
  };
});
