const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // 100MB — для картинок в base64

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', (room) => {
    if (!room) return;
    currentRoom = room;
    socket.join(room);

    // Запросить актуальное состояние доски у уже находящегося в комнате участника,
    // чтобы новый участник увидел то, что уже нарисовано (на сервере ничего не храним).
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

  // Транслировать любое изменение доски всем в комнате, кроме отправителя
  ['object:added', 'object:modified', 'object:removed', 'canvas:cleared', 'sheet:set'].forEach((ev) => {
    socket.on(ev, (data) => {
      if (currentRoom) socket.to(currentRoom).emit(ev, data);
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const count = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
      io.to(currentRoom).emit('peers', count);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Online-доска запущена: http://localhost:${PORT}`);
});
