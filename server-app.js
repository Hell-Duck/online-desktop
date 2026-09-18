const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { RoomStateStore } = require('./lib/room-state');

function createBoardServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 20 * 1024 * 1024 });
  const rooms = new RoomStateStore();

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
      rooms.pushOperation(currentRoom, op);
      socket.to(currentRoom).emit('op:apply', { op, dir: 'forward' });
    });

    socket.on('undo', () => {
      if (!currentRoom) return;
      const op = rooms.undo(currentRoom);
      if (op) io.to(currentRoom).emit('op:apply', { op, dir: 'inverse' });
    });

    socket.on('redo', () => {
      if (!currentRoom) return;
      const op = rooms.redo(currentRoom);
      if (op) io.to(currentRoom).emit('op:apply', { op, dir: 'forward' });
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
      io.to(currentRoom).emit('cursor', { from: socket.id, visible: false });
      const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      io.to(currentRoom).emit('peers', count);
      if (count === 0) rooms.delete(currentRoom);
    });
  });

  async function close() {
    await new Promise((resolve) => io.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }

  return { app, close, io, rooms, server };
}

module.exports = { createBoardServer };
