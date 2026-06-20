/* ---------- Утилиты ---------- */
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// Включаем поле id в сериализацию объектов Fabric, чтобы сопоставлять их между клиентами
fabric.Object.prototype.toObject = (function (orig) {
  return function (props) {
    return orig.call(this, ['id'].concat(props || []));
  };
})(fabric.Object.prototype.toObject);

/* ---------- Лобби: вход в комнату ---------- */
const lobby = document.getElementById('lobby');
const toolbar = document.getElementById('toolbar');
const roomInput = document.getElementById('roomInput');

function enterRoom(room) {
  room = (room || '').trim();
  if (!room) return;
  const url = new URL(location.href);
  url.searchParams.set('room', room);
  history.replaceState(null, '', url);
  start(room);
}

document.getElementById('joinBtn').onclick = () => enterRoom(roomInput.value);
document.getElementById('createBtn').onclick = () => enterRoom(uid().slice(0, 6));
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterRoom(roomInput.value); });

// Если в ссылке уже есть ?room= — подставим в поле
const preRoom = new URL(location.href).searchParams.get('room');
if (preRoom) roomInput.value = preRoom;

/* ---------- Запуск доски ---------- */
function start(room) {
  lobby.style.display = 'none';
  toolbar.style.display = 'flex';
  document.getElementById('roomLabel').textContent = room;

  const socket = io();
  socket.emit('join', room);

  const canvasEl = document.getElementById('board');
  const canvas = new fabric.Canvas('board', { backgroundColor: '#ffffff' });

  function resize() {
    canvas.setWidth(window.innerWidth);
    canvas.setHeight(window.innerHeight - 52);
    canvas.calcOffset();
  }
  // canvas-обёртка ниже тулбара
  canvasEl.parentElement.style.marginTop = '52px';
  resize();
  window.addEventListener('resize', resize);

  let applyingRemote = false; // подавляет повторную трансляцию при применении чужих изменений
  let currentTool = 'select';
  let currentColor = document.getElementById('color').value;

  /* --- Трансляция локальных изменений --- */
  const serialize = (obj) => obj.toObject();

  canvas.on('object:added', (e) => {
    const obj = e.target;
    if (!obj.id) obj.id = uid();
    if (applyingRemote) return;
    socket.emit('object:added', serialize(obj));
  });
  canvas.on('object:modified', (e) => {
    if (applyingRemote) return;
    socket.emit('object:modified', serialize(e.target));
  });
  canvas.on('text:changed', (e) => {
    if (applyingRemote) return;
    socket.emit('object:modified', serialize(e.target));
  });
  canvas.on('object:removed', (e) => {
    if (applyingRemote) return;
    if (e.target && e.target.id) socket.emit('object:removed', { id: e.target.id });
  });

  /* --- Применение удалённых изменений --- */
  function upsert(json) {
    applyingRemote = true;
    const existing = canvas.getObjects().find((o) => o.id === json.id);
    if (existing) canvas.remove(existing);
    fabric.util.enlivenObjects([json], ([obj]) => {
      obj.id = json.id;
      canvas.add(obj);
      canvas.requestRenderAll();
      applyingRemote = false;
    });
  }

  socket.on('object:added', upsert);
  socket.on('object:modified', upsert);
  socket.on('object:removed', ({ id }) => {
    const obj = canvas.getObjects().find((o) => o.id === id);
    if (obj) { applyingRemote = true; canvas.remove(obj); applyingRemote = false; }
  });
  socket.on('canvas:cleared', () => {
    applyingRemote = true; canvas.clear(); canvas.backgroundColor = '#ffffff'; canvas.renderAll(); applyingRemote = false;
  });

  // Синхронизация состояния при входе нового участника
  socket.on('request-state', (newId) => {
    socket.emit('send-state', { to: newId, state: canvas.toJSON(['id']) });
  });
  socket.on('load-state', (state) => {
    applyingRemote = true;
    canvas.loadFromJSON(state, () => { canvas.renderAll(); applyingRemote = false; });
  });

  socket.on('peers', (n) => { document.getElementById('peerCount').textContent = n; });

  /* ---------- Инструменты ---------- */
  const toolButtons = toolbar.querySelectorAll('button[data-tool]');
  function setTool(tool) {
    currentTool = tool;
    toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    canvas.isDrawingMode = tool === 'pen';
    canvas.selection = tool === 'select';
    canvas.defaultCursor = tool === 'select' ? 'default' : 'crosshair';
    canvas.forEachObject((o) => (o.selectable = tool === 'select'));
    if (tool === 'pen') {
      canvas.freeDrawingBrush.color = currentColor;
      canvas.freeDrawingBrush.width = 3;
    }
  }
  toolButtons.forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  document.getElementById('color').addEventListener('input', (e) => {
    currentColor = e.target.value;
    if (canvas.isDrawingMode) canvas.freeDrawingBrush.color = currentColor;
    const active = canvas.getActiveObject();
    if (active) {
      if (active.type === 'i-text') active.set('fill', currentColor);
      else active.set('stroke', currentColor);
      canvas.requestRenderAll();
      socket.emit('object:modified', serialize(active));
    }
  });

  /* --- Рисование фигур мышью --- */
  let draft = null, startX = 0, startY = 0;

  canvas.on('mouse:down', (opt) => {
    if (currentTool === 'select' || currentTool === 'pen') return;
    const p = canvas.getPointer(opt.e);
    startX = p.x; startY = p.y;

    if (currentTool === 'text') {
      const t = new fabric.IText('Текст', { left: p.x, top: p.y, fill: currentColor, fontSize: 22, id: uid() });
      canvas.add(t);
      canvas.setActiveObject(t);
      t.enterEditing(); t.selectAll();
      setTool('select');
      return;
    }
    const common = { left: p.x, top: p.y, stroke: currentColor, strokeWidth: 2, fill: 'transparent', id: uid() };
    if (currentTool === 'rect') draft = new fabric.Rect({ ...common, width: 0, height: 0 });
    else if (currentTool === 'circle') draft = new fabric.Ellipse({ ...common, rx: 0, ry: 0 });
    else if (currentTool === 'line') draft = new fabric.Line([p.x, p.y, p.x, p.y], { stroke: currentColor, strokeWidth: 2, id: uid() });
    if (draft) { applyingRemote = true; canvas.add(draft); applyingRemote = false; } // не транслируем пустую заготовку
  });

  canvas.on('mouse:move', (opt) => {
    if (!draft) return;
    const p = canvas.getPointer(opt.e);
    if (currentTool === 'rect') {
      draft.set({ width: Math.abs(p.x - startX), height: Math.abs(p.y - startY), left: Math.min(p.x, startX), top: Math.min(p.y, startY) });
    } else if (currentTool === 'circle') {
      draft.set({ rx: Math.abs(p.x - startX) / 2, ry: Math.abs(p.y - startY) / 2, left: Math.min(p.x, startX), top: Math.min(p.y, startY) });
    } else if (currentTool === 'line') {
      draft.set({ x2: p.x, y2: p.y });
    }
    canvas.requestRenderAll();
  });

  canvas.on('mouse:up', () => {
    if (!draft) return;
    draft.setCoords();
    socket.emit('object:added', serialize(draft)); // теперь транслируем готовую фигуру
    draft = null;
    setTool('select');
  });

  /* --- Картинки --- */
  // Добавить картинку из dataURL (base64). pos — куда поставить (по умолчанию угол).
  function addImage(dataURL, pos) {
    fabric.Image.fromURL(dataURL, (img) => {
      const scale = Math.min(1, 400 / img.width);
      img.set({
        left: pos ? pos.x : 80,
        top: pos ? pos.y : 80,
        scaleX: scale, scaleY: scale, id: uid(),
      });
      canvas.add(img); // object:added транслирует картинку (base64) остальным
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
    });
  }

  function readFileAsImage(file, pos) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => addImage(ev.target.result, pos);
    reader.readAsDataURL(file);
  }

  const imageInput = document.getElementById('imageInput');
  document.getElementById('imageBtn').onclick = () => imageInput.click();
  imageInput.onchange = (e) => {
    readFileAsImage(e.target.files[0]);
    imageInput.value = '';
  };

  // Вставка картинки из буфера обмена (Ctrl+V)
  window.addEventListener('paste', (e) => {
    // не перехватываем вставку, если редактируется текст на доске
    const active = canvas.getActiveObject();
    if (active && active.isEditing) return;

    const items = (e.clipboardData || window.clipboardData)?.items || [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        readFileAsImage(item.getAsFile());
        return;
      }
    }
  });

  /* --- Удаление / очистка --- */
  function deleteActive() {
    canvas.getActiveObjects().forEach((o) => canvas.remove(o));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }
  document.getElementById('deleteBtn').onclick = deleteActive;
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && !(document.activeElement && document.activeElement.isContentEditable)) {
      const ao = canvas.getActiveObject();
      if (ao && !ao.isEditing) { e.preventDefault(); deleteActive(); }
    }
  });
  document.getElementById('clearBtn').onclick = () => {
    if (!confirm('Очистить доску у всех участников?')) return;
    canvas.clear();
    canvas.backgroundColor = '#ffffff';
    canvas.renderAll();
    socket.emit('canvas:cleared');
  };

  setTool('select');
}
