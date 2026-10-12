const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const { RoomStateStore } = require('./lib/room-state');
const { ImageAssetStore, LIMITS } = require('./lib/image-assets');
const { BoardSceneStore } = require('./lib/board-scene');
const { streamSnapshot } = require('./lib/snapshot-stream');

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

function createBoardServer({ roomGraceMs = 120000 } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1024 * 1024 });
  const rooms = new RoomStateStore();
  const cleanupTimers = new Map();
  const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'online-board-assets-'));
  const assets = new ImageAssetStore({ root: assetRoot });
  const scene = new BoardSceneStore({ assetAllowed: (room, id) => assets.has(room, id) });

  app.post('/board-assets', express.raw({ type: ['image/png', 'image/jpeg'], limit: LIMITS.fileBytes }),
    async (request, response) => {
      try {
        if (scene.version(request.query.room) === null) return response.status(400).json({ error: 'invalid' });
        const result = await assets.put(request.query.room, request.body, request.headers['content-type']);
        response.status(201).json(result);
      } catch (error) {
        const reason = error.message;
        response.status(reason === 'too_large' ? 413 : reason.startsWith('quota') ? 507 : 400)
          .json({ error: reason === 'too_large' ? 'too_large' : reason.startsWith('quota') ? 'quota' : 'invalid' });
      }
    });
  app.get('/board-assets/:id', async (request, response) => {
    try {
      const asset = await assets.getById(request.params.id);
      if (!asset) return response.sendStatus(404);
      response.type(asset.contentType).send(asset.bytes);
    } catch { response.sendStatus(404); }
  });
  app.use((error, _request, response, next) => {
    if (error.type === 'entity.too.large') return response.status(413).json({ error: 'too_large' });
    next(error);
  });
  app.use(express.static(path.join(__dirname, 'public')));

  io.on('connection', (socket) => {
    let currentRoom = null;
    let syncGeneration = 0;

    socket.on('join', (request) => {
      const room = typeof request === 'string' ? request : request?.room;
      if (!room) return;
      if (currentRoom && currentRoom !== room) {
        socket.emit('scene:error', { reason: 'invalid' });
        return;
      }
      if (scene.join(room).rejected) { socket.emit('scene:error', { reason: 'quota' }); return; }
      clearTimeout(cleanupTimers.get(room));
      cleanupTimers.delete(room);
      currentRoom = room;
      socket.join(room);
      if (request && typeof request === 'object') rooms.ensureView(room, request.initialView);

      const count = io.sockets.adapter.rooms.get(room)?.size || 1;
      io.to(room).emit('peers', count);
      const view = rooms.getView(room);
      if (view) socket.emit('view:set', view);
    });

    socket.on('scene:command', (command, ack) => {
      if (typeof ack !== 'function') return;
      if (!currentRoom) { ack({ rejected: 'offline' }); return; }
      const started = performance.now();
      const previousVersion = scene.version(currentRoom);
      const result = command?.kind === 'undo'
        ? scene.undo(currentRoom, command.commandId, command.expectedVersion)
        : command?.kind === 'redo'
          ? scene.redo(currentRoom, command.commandId, command.expectedVersion)
          : scene.apply(currentRoom, command);
      ack(result.rejected ? result : { version: result.version });
      if (!result.rejected && result.version > previousVersion) {
        socket.to(currentRoom).emit('scene:change', command.kind === 'undo' || command.kind === 'redo'
          ? { version: result.version, operation: { kind: 'resync' }, direction: result.direction }
          : result);
      }
      const duration = performance.now() - started;
      if (duration > 50 || result.rejected === 'quota') {
        console.info('board-command', { roomBytes: scene.getStats(currentRoom).sceneBytes,
          durationMs: Math.round(duration), result: result.rejected || 'accepted' });
      }
    });

    socket.on('scene:sync', async () => {
      if (!currentRoom) return;
      const generation = ++syncGeneration;
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = scene.snapshot(currentRoom);
        try {
          await streamSnapshot(snapshot, (packet) => new Promise((resolve) => {
            if (!socket.connected || syncGeneration !== generation) { resolve(false); return; }
            socket.timeout(3000).emit('scene:chunk', packet, (error, accepted) =>
              resolve(!error && accepted === true));
          }));
          if (syncGeneration !== generation || !socket.connected) return;
          if (scene.version(currentRoom) === snapshot.version) {
            socket.emit('scene:ready', { version: snapshot.version });
            return;
          }
        } catch { if (!socket.connected || syncGeneration !== generation) return; }
      }
      socket.emit('scene:error', { reason: 'busy' });
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

    socket.on('view:set', (data) => {
      if (!currentRoom) return;
      const view = rooms.updateView(currentRoom, data);
      if (view) socket.to(currentRoom).emit('view:set', view);
    });

    socket.on('cursor', (data) => {
      if (currentRoom && data && typeof data === 'object') {
        socket.to(currentRoom).emit('cursor', { from: socket.id, ...data });
      }
    });

    socket.on('disconnect', () => {
      ++syncGeneration;
      if (!currentRoom) return;
      socket.to(currentRoom).emit('text:preview:end', { from: socket.id });
      io.to(currentRoom).emit('cursor', { from: socket.id, visible: false });
      const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      io.to(currentRoom).emit('peers', count);
      if (count === 0) {
        const room = currentRoom;
        const timer = setTimeout(async () => {
          cleanupTimers.delete(room);
          if (io.sockets.adapter.rooms.get(room)?.size) return;
          rooms.delete(room);
          scene.release(room);
          await assets.releaseRoom(room);
        }, roomGraceMs);
        timer.unref?.();
        cleanupTimers.set(room, timer);
      }
    });
  });

  async function close() {
    for (const timer of cleanupTimers.values()) clearTimeout(timer);
    await new Promise((resolve) => io.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await assets.close();
    await fs.promises.rm(assetRoot, { recursive: true, force: true });
  }

  return { app, assets, close, io, rooms, scene, server };
}

module.exports = { createBoardServer };
