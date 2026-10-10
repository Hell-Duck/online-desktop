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

  async function encodeImageWithinLimit(source, mimeType, maxBytes, createCanvas) {
    if (!['image/png', 'image/jpeg'].includes(mimeType)) throw new Error('invalid image type');
    const initial = fitWithin(source.naturalWidth, source.naturalHeight, 2048);
    let width = Math.max(1, initial.width);
    let height = Math.max(1, initial.height);
    while (true) {
      const canvas = createCanvas();
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(source, 0, 0, width, height);
      const blob = await new Promise((resolve, reject) => canvas.toBlob(
        (result) => result ? resolve(result) : reject(new Error('image encoding failed')),
        mimeType, mimeType === 'image/jpeg' ? 0.85 : undefined,
      ));
      if (blob.size <= maxBytes) return blob;
      if (width === 1 && height === 1) throw new Error('too_large');
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
    }
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

  function createSnapshotReceiver() {
    let session = null, parts = [], completed = null, lastSession = null;
    const old = new Set();
    const abandon = (id) => { if (id) { old.add(id); if (old.size > 16) old.delete(old.values().next().value); } };
    return {
      accept(packet) {
        if (!packet || typeof packet.session !== 'string') return false;
        if (packet.abort) {
          if (packet.session === session) { abandon(session); session = null; parts = []; completed = null; }
          return true;
        }
        if (old.has(packet.session) || packet.session === lastSession) return false;
        if (packet.index === 0 && packet.session !== session) {
          abandon(session); session = packet.session; parts = []; completed = null;
        }
        if (session !== packet.session || packet.index !== parts.length ||
            !Number.isSafeInteger(packet.total) || packet.total < 1 || packet.total > 100000 ||
            typeof packet.data !== 'string') return false;
        parts.push(packet.data);
        if (parts.length === packet.total) {
          try {
            const parsed = JSON.parse(parts.join(''));
            if (parsed.version !== packet.version) throw Error('version');
            completed = parsed; abandon(lastSession); lastSession = session; session = null; parts = [];
          } catch { abandon(session); session = null; parts = []; return false; }
        }
        return true;
      },
      result() { return completed; },
      reset() { abandon(session); session = null; parts = []; completed = null; },
    };
  }

  function objectChanges(before, after) {
    const result = {};
    Object.keys(after).forEach((key) => {
      if (key === 'id' || key === 'type' || key === 'src' || key === 'eraser') return;
      if (JSON.stringify(before?.[key]) !== JSON.stringify(after[key])) result[key] = after[key];
    });
    return result;
  }

  function eraserDelta(before, after) {
    const prior = before?.eraser?.objects || [];
    const current = after?.eraser?.objects || [];
    if (current.length <= prior.length) return null;
    return { baseCount: prior.length, eraser: { ...after.eraser, objects: current.slice(prior.length) } };
  }

  return {
    applyTextSnapshot,
    createRenderScheduler,
    createSnapshotReceiver,
    createRevisionGate,
    createObjectIndex,
    createTextBatcher,
    createTextPreviewGate,
    createTextSessionSync,
    encodeImageWithinLimit,
    eraserDelta,
    objectChanges,
    createTrailingThrottle,
    fitWithin,
    replaceCanvasObjectPreservingStack,
    transformFromView,
    viewFromTransform,
  };
});
