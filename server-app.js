const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { RoomStateStore } = require('./lib/room-state');

const TEXT_FIELDS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'underline', 'linethrough',
  'overline', 'fill', 'textAlign', 'lineHeight', 'charSpacing',
];

function normalizeTextSnapshot(input, id) {
  if (!input || typeof input !== 'object' || typeof id !== 'string' || !id || id.length > 200 ||
      typeof input.text !== 'string' || input.text.length > 100000 ||
      (input.styles != null && (typeof input.styles !== 'object' || Array.isArray(input.styles)))) return null;
  const result = { id, text: input.text, styles: input.styles || {} };
  for (const field of TEXT_FIELDS) {
    const value = input[field];
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) result[field] = value;
    else return null;
  }
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(result), 'utf8'); } catch { return null; }
  return bytes <= 1024 * 1024 ? result : null;
}

function createBoardServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 20 * 1024 * 1024 });
  const rooms = new RoomStateStore();
  const textHeads = new Map();
  const roomTextHeads = (room) => {
    if (!textHeads.has(room)) textHeads.set(room, new Map());
    return textHeads.get(room);
  };
  function updateTextHeads(room, op, dir = 'forward') {
    const heads = roomTextHeads(room);
    const remember = (snapshot) => {
      const id = snapshot?.id;
      const normalized = normalizeTextSnapshot(snapshot, id);
      if (normalized) heads.set(id, normalized);
    };
    if (op.kind === 'text' || op.kind === 'modify') {
      remember(dir === 'forward' ? op.after : op.before);
    } else if (op.kind === 'add') {
      if (dir === 'forward') remember(op.obj); else heads.delete(op.obj?.id);
    } else if (op.kind === 'remove') {
      if (dir === 'forward') heads.delete(op.obj?.id); else remember(op.obj);
    } else if (op.kind === 'batch') {
      for (const item of Array.isArray(op.items) ? op.items : []) {
        remember(dir === 'forward' ? item?.after : item?.before);
      }
    } else if (op.kind === 'clear') {
      const objects = Array.isArray(op.objs) ? op.objs : [];
      if (dir === 'forward') for (const obj of objects) heads.delete(obj?.id);
      else for (const obj of objects) remember(obj);
    }
  }

  app.use(express.static(path.join(__dirname, 'public')));

  io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('join', (request) => {
      const room = typeof request === 'string' ? request : request?.room;
      if (!room) return;
      currentRoom = room;
      socket.join(room);
      if (request && typeof request === 'object') rooms.ensureView(room, request.initialView);

      const peers = [...(io.sockets.adapter.rooms.get(room) || [])].filter((id) => id !== socket.id);
      if (peers.length > 0) io.to(peers[0]).emit('request-state', socket.id);

      const count = io.sockets.adapter.rooms.get(room)?.size || 1;
      io.to(room).emit('peers', count);
      const view = rooms.getView(room);
      if (view) socket.emit('view:set', view);
    });

    socket.on('send-state', ({ to, state } = {}) => {
      if (to && state) io.to(to).emit('load-state', state);
    });

    socket.on('op', (op) => {
      if (!currentRoom || !op || typeof op !== 'object') return;
      if (op.kind === 'text') {
        const id = op.id;
        const after = normalizeTextSnapshot(op.after, id);
        const proposedBefore = normalizeTextSnapshot(op.before, id);
        if (!after || !proposedBefore) return;
        const heads = roomTextHeads(currentRoom);
        const normalized = { kind: 'text', id, before: heads.get(id) || proposedBefore, after };
        heads.set(id, after);
        rooms.pushOperation(currentRoom, normalized);
        io.to(currentRoom).emit('op:apply', { op: normalized, dir: 'forward' });
        return;
      }
      if ((op.kind === 'batch' && !Array.isArray(op.items)) ||
          (op.kind === 'clear' && !Array.isArray(op.objs)) ||
          (['add', 'remove'].includes(op.kind) && (!op.obj || typeof op.obj !== 'object')) ||
          (op.kind === 'modify' && (!op.before || typeof op.before !== 'object' ||
            !op.after || typeof op.after !== 'object')) ||
          !['add', 'remove', 'modify', 'batch', 'clear'].includes(op.kind)) return;
      updateTextHeads(currentRoom, op);
      rooms.pushOperation(currentRoom, op);
      socket.to(currentRoom).emit('op:apply', { op, dir: 'forward' });
    });

    socket.on('text:preview', (message) => {
      if (!currentRoom || !message || typeof message !== 'object' ||
          typeof message.id !== 'string' || !message.id || message.id.length > 200 ||
          !Number.isSafeInteger(message.revision) || message.revision < 1 ||
          !message.snapshot || typeof message.snapshot !== 'object') return;
      const snapshot = normalizeTextSnapshot(message.snapshot, message.id);
      if (!snapshot) return;
      socket.to(currentRoom).emit('text:preview', {
        from: socket.id,
        id: message.id,
        revision: message.revision,
        snapshot,
      });
    });

    socket.on('undo', () => {
      if (!currentRoom) return;
      const op = rooms.undo(currentRoom);
      if (op) {
        updateTextHeads(currentRoom, op, 'inverse');
        io.to(currentRoom).emit('op:apply', { op, dir: 'inverse' });
      }
    });

    socket.on('redo', () => {
      if (!currentRoom) return;
      const op = rooms.redo(currentRoom);
      if (op) {
        updateTextHeads(currentRoom, op, 'forward');
        io.to(currentRoom).emit('op:apply', { op, dir: 'forward' });
      }
    });

    socket.on('view:set', (data) => {
      if (!currentRoom) return;
      const view = rooms.updateView(currentRoom, data);
      if (view) socket.to(currentRoom).emit('view:set', view);
    });

    socket.on('sheet:set', (data) => {
      if (currentRoom) socket.to(currentRoom).emit('sheet:set', data);
    });

    socket.on('cursor', (data) => {
      if (currentRoom && data && typeof data === 'object') {
        socket.to(currentRoom).emit('cursor', { from: socket.id, ...data });
      }
    });

    socket.on('disconnect', () => {
      if (!currentRoom) return;
      socket.to(currentRoom).emit('text:preview:end', { from: socket.id });
      io.to(currentRoom).emit('cursor', { from: socket.id, visible: false });
      const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      io.to(currentRoom).emit('peers', count);
      if (count === 0) {
        rooms.delete(currentRoom);
        textHeads.delete(currentRoom);
      }
    });
  });

  async function close() {
    await new Promise((resolve) => io.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }

  return { app, close, io, rooms, server };
}

module.exports = { createBoardServer };
