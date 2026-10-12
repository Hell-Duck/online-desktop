const DEFAULTS = {
  roomBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  historyBytes: 8 * 1024 * 1024,
  historyCount: 200,
  maxRooms: 4,
};

const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200;

function applyEntry(objects, entry, direction) {
  if (entry.kind === 'clear') return direction === 'inverse' ? entry.removed.slice() : [];
  const next = objects.slice();
  if (entry.kind === 'erase') {
    for (const patch of entry.patches) {
      const eraser = direction === 'inverse' ? patch.before : patch.after;
      const object = { ...next[patch.index] };
      if (eraser === undefined) delete object.eraser;
      else object.eraser = eraser;
      next[patch.index] = object;
    }
    return next;
  }
  const value = direction === 'inverse' ? entry.before : entry.after;
  if (entry.kind === 'add') {
    if (direction === 'inverse') next.splice(entry.index, 1);
    else next.splice(entry.index, 0, value);
  } else if (entry.kind === 'remove') {
    if (direction === 'inverse') next.splice(entry.index, 0, value);
    else next.splice(entry.index, 1);
  } else if (entry.kind !== 'sheet') {
    next[entry.index] = entry.kind === 'patch' ? { ...next[entry.index], ...value } : value;
  }
  return next;
}

class BoardSceneStore {
  constructor(limits = {}) {
    this.limits = { ...DEFAULTS, ...limits };
    this.assetAllowed = limits.assetAllowed || (() => true);
    this.rooms = new Map();
  }

  _room(name) {
    if (typeof name !== 'string' || !name || name.length > 200) return null;
    if (!this.rooms.has(name)) {
      if (this.rooms.size >= this.limits.maxRooms) return null;
      this.rooms.set(name, {
        version: 0, objects: [], sheet: 'white', undo: [], redo: [],
        sceneSize: bytesOf([]) + bytesOf('white'), historySize: 0, commandResults: new Map(),
      });
    }
    return this.rooms.get(name);
  }

  join(name) {
    const state = this._room(name);
    return state ? { version: state.version } : { rejected: 'quota' };
  }

  snapshot(name) {
    const state = this._room(name);
    return state ? { version: state.version, objects: clone(state.objects), sheet: state.sheet } : { rejected: 'quota' };
  }

  version(name) { return this.rooms.get(name)?.version ?? null; }

  _change(name, command, kind) {
    const state = this._room(name);
    if (!state) return { rejected: 'quota' };
    if (!validId(command?.commandId) || !Number.isSafeInteger(command.expectedVersion) ||
        command.expectedVersion < 0) return { rejected: 'invalid', version: state.version };
    if (state.commandResults.has(command.commandId)) return state.commandResults.get(command.commandId);
    if (command.expectedVersion !== state.version) return { rejected: 'stale', version: state.version };
    try { if (bytesOf(command) > 256 * 1024) return { rejected: 'quota', version: state.version }; }
    catch { return { rejected: 'invalid', version: state.version }; }

    let next = state.objects.slice();
    let nextSheet = state.sheet;
    let changed;
    let entry;
    let sizeDelta = 0;
    if (kind === 'undo' || kind === 'redo') {
      const stack = kind === 'undo' ? state.undo : state.redo;
      if (!stack.length) return { rejected: 'empty', version: state.version };
      const entry = stack[stack.length - 1];
      next = applyEntry(next, entry, kind === 'undo' ? 'inverse' : 'forward');
      nextSheet = kind === 'undo' ? entry.beforeSheet : entry.afterSheet;
      changed = entry.operation;
    } else {
      if (!['add', 'patch', 'remove', 'clear', 'text', 'erase', 'sheet'].includes(kind)) {
        return { rejected: 'invalid', version: state.version };
      }
      try {
        if (kind === 'add') {
          if (!command.obj || !validId(command.obj.id) || next.some((o) => o.id === command.obj.id)) throw Error();
          const after = clone(command.obj);
          entry = { kind, index: next.length, before: null, after };
          sizeDelta = bytesOf(after) + (next.length ? 1 : 0);
          next.push(after);
        } else if (kind === 'clear') {
          entry = { kind, removed: next };
          sizeDelta = 2 - (state.sceneSize - bytesOf(state.sheet));
          next = [];
        } else if (kind === 'sheet') {
          if (!['white', 'ruled', 'grid'].includes(command.type)) throw Error();
          entry = { kind };
          nextSheet = command.type;
          sizeDelta = bytesOf(nextSheet) - bytesOf(state.sheet);
        } else if (kind === 'erase') {
          if (!Array.isArray(command.targets) || !command.targets.length || command.targets.length > 500) throw Error();
          const patches = [];
          const seen = new Set();
          for (const target of command.targets) {
            if (!validId(target?.id) || seen.has(target.id) ||
                !Number.isSafeInteger(target.baseCount) || target.baseCount < 0 ||
                !target.eraser || typeof target.eraser !== 'object' ||
                !Array.isArray(target.eraser.objects) || !target.eraser.objects.length) throw Error();
            seen.add(target.id);
            const index = next.findIndex((obj) => obj.id === target.id);
            if (index < 0) throw Error();
            const before = next[index].eraser;
            if ((before?.objects?.length || 0) !== target.baseCount) throw Error();
            const after = { ...clone(target.eraser), objects: [
              ...(before?.objects || []), ...clone(target.eraser.objects),
            ] };
            next[index] = { ...next[index], eraser: after };
            sizeDelta += bytesOf(next[index]) - bytesOf(state.objects[index]);
            patches.push({ index, before, after });
          }
          entry = { kind, patches };
        } else {
          if (!validId(command.id)) throw Error();
          const index = next.findIndex((o) => o.id === command.id);
          if (index < 0) throw Error();
          const before = next[index];
          if (kind === 'remove') {
            sizeDelta = -bytesOf(before) - (next.length > 1 ? 1 : 0);
            next.splice(index, 1);
          }
          else if (kind === 'patch') {
            const changes = command.changes;
            if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
                Object.keys(changes).some((key) =>
                  ['id', 'type', 'src', 'eraser', '__proto__', 'constructor', 'prototype'].includes(key))) throw Error();
            const previous = {};
            for (const key of Object.keys(changes)) previous[key] = before[key];
            next[index] = { ...next[index], ...clone(changes) };
            sizeDelta = bytesOf(next[index]) - bytesOf(before);
            entry = { kind, index, before: previous, after: clone(changes) };
          } else if (kind === 'text') {
            if (typeof command.text !== 'string' || command.text.length > 100000) throw Error();
            const fields = {};
            for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'underline',
              'linethrough', 'overline', 'fill', 'textAlign', 'lineHeight', 'charSpacing']) {
              if (command.fields?.[key] !== undefined) fields[key] = command.fields[key];
            }
            next[index] = { ...next[index], ...fields, text: command.text, styles: clone(command.styles || {}) };
            sizeDelta = bytesOf(next[index]) - bytesOf(before);
          }
          entry ||= { kind, index, before, after: kind === 'remove' ? null : next[index] };
        }
        const candidate = next[entry.index];
        if (candidate && JSON.stringify(candidate).includes('data:image')) throw Error();
        if (kind === 'erase' && entry.patches.some((patch) =>
          JSON.stringify(patch.after).includes('data:image'))) throw Error();
        if (candidate?.type === 'image' &&
            (typeof candidate.src !== 'string' || !/^\/board-assets\/[a-f0-9]{64}$/.test(candidate.src) ||
             !this.assetAllowed(name, candidate.src.slice('/board-assets/'.length)))) throw Error();
      } catch { return { rejected: 'invalid', version: state.version }; }
      changed = { kind, ...clone(command) };
    }

    if (kind !== 'undo' && kind !== 'redo') {
      entry.beforeSheet = state.sheet;
      entry.afterSheet = nextSheet;
      entry.operation = changed;
      entry.size = bytesOf(entry);
      if (entry.size > this.limits.historyBytes) return { rejected: 'quota', version: state.version };
    }
    const sceneSize = kind === 'undo' || kind === 'redo'
      ? bytesOf(next) + bytesOf(nextSheet) : state.sceneSize + sizeDelta;
    const otherRooms = [...this.rooms.values()].reduce((sum, room) =>
      sum + (room === state ? 0 : room.sceneSize + room.historySize), 0);
    const afterHistory = kind === 'undo' || kind === 'redo' ? state.historySize :
      Math.min(this.limits.historyBytes, state.undo.reduce((sum, item) => sum + item.size, 0) + entry.size);
    if (sceneSize + afterHistory > this.limits.roomBytes ||
        sceneSize + afterHistory + otherRooms > this.limits.totalBytes) {
      return { rejected: 'quota', version: state.version };
    }

    if (kind === 'undo' || kind === 'redo') {
      const source = kind === 'undo' ? state.undo : state.redo;
      const dest = kind === 'undo' ? state.redo : state.undo;
      dest.push(source.pop());
    } else {
      state.redo = [];
      state.undo.push(entry);
      let undoBytes = state.undo.reduce((sum, value) => sum + value.size, 0);
      while (state.undo.length > this.limits.historyCount || undoBytes > this.limits.historyBytes) {
        undoBytes -= state.undo.shift().size;
      }
    }
    state.objects = next;
    state.sheet = nextSheet;
    state.sceneSize = sceneSize;
    state.historySize = [...state.undo, ...state.redo].reduce((sum, entry) => sum + entry.size, 0);
    state.version += 1;
    const result = { version: state.version, operation: changed, direction: kind === 'undo' ? 'inverse' : 'forward' };
    state.commandResults.set(command.commandId, { version: result.version });
    if (state.commandResults.size > 500) state.commandResults.delete(state.commandResults.keys().next().value);
    return result;
  }

  apply(room, command) { return this._change(room, command, command?.kind); }
  undo(room, commandId, expectedVersion) { return this._change(room, { commandId, expectedVersion }, 'undo'); }
  redo(room, commandId, expectedVersion) { return this._change(room, { commandId, expectedVersion }, 'redo'); }
  getStats(room) {
    const state = this.rooms.get(room);
    return { undoCount: state?.undo.length || 0, redoCount: state?.redo.length || 0,
      historyBytes: state?.historySize || 0,
      sceneBytes: state?.sceneSize || 0 };
  }
  release(room) { this.rooms.delete(room); }
}

module.exports = { BoardSceneStore, DEFAULTS };
