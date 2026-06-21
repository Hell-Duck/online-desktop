const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // 100MB — для картинок в base64

app.use(express.static(path.join(__dirname, 'public')));

// Общая история операций на комнату (единый стек для всех участников)
const MAX_HISTORY = 200;
const roomHistory = new Map(); // room -> { undo: [], redo: [] }
const getHistory = (room) => {
  let h = roomHistory.get(room);
  if (!h) { h = { undo: [], redo: [] }; roomHistory.set(room, h); }
  return h;
};

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', (room) => {
    if (!room) return;
    currentRoom = room;
    socket.join(room);

    // Запросить актуальное состояние доски у уже находящегося в комнате участника,
    // чтобы новый участник увидел то, что уже нарисовано (на сервере холст не храним).
    const peers = [...(io.sockets.adapter.rooms.get(room) || [])].filter((id) => id !== socket.id);
    if (peers.length > 0) {
      io.to(peers[0]).emit('request-state', socket.id);
    }

    const count = io.sockets.adapter.rooms.get(room)?.size || 1;
    io.to(room).emit('peers', count);
  });

  // Участник прислал снимок состояния -> переслать новичку
  socket.on('send-state', ({ to, state }) => {
    io.to(to).emit('load-state', state);
  });

  // Новая операция от участника: пишем в общую историю и применяем у остальных (отправитель уже применил локально)
  socket.on('op', (op) => {
    if (!currentRoom || !op) return;
    const h = getHistory(currentRoom);
    h.undo.push(op);
    if (h.undo.length > MAX_HISTORY) h.undo.shift();
    h.redo.length = 0; // новое действие обнуляет возможность redo
    socket.to(currentRoom).emit('op:apply', { op, dir: 'forward' });
  });

  // Отмена: берём последнюю операцию из общего стека и применяем обратную у ВСЕХ
  socket.on('undo', () => {
    if (!currentRoom) return;
    const h = getHistory(currentRoom);
    const op = h.undo.pop();
    if (!op) return;
    h.redo.push(op);
    io.to(currentRoom).emit('op:apply', { op, dir: 'inverse' });
  });

  // Повтор: возвращаем операцию из redo и применяем прямую у ВСЕХ
  socket.on('redo', () => {
    if (!currentRoom) return;
    const h = getHistory(currentRoom);
    const op = h.redo.pop();
    if (!op) return;
    h.undo.push(op);
    io.to(currentRoom).emit('op:apply', { op, dir: 'forward' });
  });

  // Вид листа — вне истории, просто транслируем
  socket.on('sheet:set', (data) => {
    if (currentRoom) socket.to(currentRoom).emit('sheet:set', data);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
    io.to(currentRoom).emit('peers', count);
    if (count === 0) roomHistory.delete(currentRoom); // комната опустела — забываем историю
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Online-доска запущена: http://localhost:${PORT}`);
});
