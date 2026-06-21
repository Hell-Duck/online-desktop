/* ---------- Утилиты ---------- */
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// Включаем поле id в сериализацию объектов Fabric, чтобы сопоставлять их между клиентами
fabric.Object.prototype.toObject = (function (orig) {
  return function (props) {
    // 'eraser' нужен, чтобы стёртые части объекта корректно передавались другому участнику
    return orig.call(this, ['id', 'eraser'].concat(props || []));
  };
})(fabric.Object.prototype.toObject);

/* ---------- Лобби: вход в комнату ---------- */
const lobby = document.getElementById('lobby');
const toolbar = document.getElementById('toolbar');
const roomInput = document.getElementById('roomInput');

function enterRoom(room) {
  // обрезаем пробелы по краям (часто прилипают при копировании), регистр сохраняем
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
  window.boardCanvas = canvas; // ссылка для отладки/тестов

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
  let currentSheet = 'white'; // вид листа: white | ruled | grid

  /* --- Трансляция локальных изменений --- */
  const serialize = (obj) => obj.toObject();

  /* --- История для отмены (Ctrl+Z) --- */
  const history = [];          // стек обратимых операций
  const stateCache = {};       // id -> последнее известное состояние объекта (для diff при изменении)
  const MAX_HISTORY = 60;
  const byId = (id) => canvas.getObjects().find((o) => o.id === id);
  const cacheObj = (obj) => { if (obj && obj.id) stateCache[obj.id] = serialize(obj); };
  function pushHist(entry) {
    history.push(entry);
    if (history.length > MAX_HISTORY) history.shift();
  }

  canvas.on('object:added', (e) => {
    const obj = e.target;
    if (!obj.id) obj.id = uid();
    if (applyingRemote) return;
    socket.emit('object:added', serialize(obj));
    cacheObj(obj);
    pushHist({ kind: 'add', id: obj.id });
  });
  canvas.on('object:modified', (e) => {
    if (applyingRemote) return;
    const obj = e.target;
    pushHist({ kind: 'modify', id: obj.id, before: stateCache[obj.id] }); // before — состояние до изменения
    socket.emit('object:modified', serialize(obj));
    cacheObj(obj);
  });
  canvas.on('text:changed', (e) => {
    if (applyingRemote) return;
    socket.emit('object:modified', serialize(e.target));
    cacheObj(e.target); // в историю не пишем (иначе откат по каждой букве)
  });
  canvas.on('object:removed', (e) => {
    if (applyingRemote) return;
    if (e.target && e.target.id) {
      pushHist({ kind: 'remove', json: serialize(e.target) }); // чтобы откат вернул объект
      socket.emit('object:removed', { id: e.target.id });
      delete stateCache[e.target.id];
    }
  });
  // Ластик стёр части объектов -> разослать обновлённые объекты (с маской eraser) остальным
  canvas.on('erasing:end', (e) => {
    if (applyingRemote || !e || !e.targets) return;
    const ops = [];
    e.targets.forEach((obj) => {
      if (!obj.id) return;
      ops.push({ id: obj.id, before: stateCache[obj.id] });
      socket.emit('object:modified', serialize(obj));
      cacheObj(obj);
    });
    if (ops.length) pushHist({ kind: 'batch', ops }); // один Ctrl+Z отменит весь штрих ластика
  });

  /* --- Применение отмены --- */
  // Восстановить объект в заданном (предыдущем) состоянии и разослать остальным
  function restoreObject(json) {
    applyingRemote = true;
    const ex = byId(json.id);
    if (ex) canvas.remove(ex);
    fabric.util.enlivenObjects([json], ([o]) => {
      o.id = json.id;
      o.selectable = currentTool === 'select';
      canvas.add(o);
      cacheObj(o);
      canvas.requestRenderAll();
      applyingRemote = false;
    });
    socket.emit('object:modified', json); // у второго участника применится через upsert
  }
  function removeById(id) {
    const o = byId(id);
    if (o) { applyingRemote = true; canvas.remove(o); applyingRemote = false; }
    delete stateCache[id];
    socket.emit('object:removed', { id });
  }
  function undo() {
    const entry = history.pop();
    if (!entry) return;
    if (entry.kind === 'add') {
      removeById(entry.id);                       // откат добавления = удалить
    } else if (entry.kind === 'remove') {
      if (entry.json) restoreObject(entry.json);  // откат удаления = вернуть
    } else if (entry.kind === 'modify') {
      if (entry.before) restoreObject(entry.before); // откат изменения = вернуть прошлое состояние
      else removeById(entry.id);                  // before нет => объект был новым
    } else if (entry.kind === 'batch') {
      entry.ops.forEach((op) => { if (op.before) restoreObject(op.before); });
    }
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }

  /* --- Применение удалённых изменений --- */
  function upsert(json) {
    applyingRemote = true;
    const existing = canvas.getObjects().find((o) => o.id === json.id);
    if (existing) canvas.remove(existing);
    fabric.util.enlivenObjects([json], ([obj]) => {
      obj.id = json.id;
      canvas.add(obj);
      cacheObj(obj); // запоминаем состояние чужого объекта для возможной отмены его перемещения
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
    applyingRemote = true; canvas.clear(); applySheet(currentSheet); canvas.renderAll(); applyingRemote = false;
  });

  // Синхронизация состояния при входе нового участника (объекты + вид листа)
  socket.on('request-state', (newId) => {
    socket.emit('send-state', { to: newId, state: { objects: canvas.toJSON(['id']), sheet: currentSheet } });
  });
  socket.on('load-state', (state) => {
    applyingRemote = true;
    canvas.loadFromJSON(state.objects, () => {
      if (state.sheet) applySheet(state.sheet);
      canvas.renderAll();
      applyingRemote = false;
    });
  });
  socket.on('sheet:set', ({ type }) => applySheet(type)); // чужой сменил вид листа

  socket.on('peers', (n) => { document.getElementById('peerCount').textContent = n; });

  /* ---------- Инструменты ---------- */
  // Кисти: карандаш и пиксельный ластик (EraserBrush стирает части объектов, а не объект целиком)
  const penBrush = new fabric.PencilBrush(canvas);
  const eraserBrush = fabric.EraserBrush ? new fabric.EraserBrush(canvas) : null;
  if (!eraserBrush) console.warn('EraserBrush недоступен в этой сборке Fabric.js');

  const toolButtons = toolbar.querySelectorAll('button[data-tool]');
  function setTool(tool) {
    if (tool === 'eraser' && !eraserBrush) return; // нет ластика в сборке — игнорируем
    currentTool = tool;
    toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    canvas.isDrawingMode = tool === 'pen' || tool === 'eraser';
    canvas.selection = tool === 'select';
    canvas.defaultCursor = tool === 'pan' ? 'grab' : (tool === 'select' ? 'default' : 'crosshair');
    canvas.forEachObject((o) => (o.selectable = tool === 'select'));
    if (tool === 'pen') {
      canvas.freeDrawingBrush = penBrush;
      penBrush.color = currentColor;
      penBrush.width = 3;
    } else if (tool === 'eraser') {
      canvas.freeDrawingBrush = eraserBrush;
      eraserBrush.width = 20;
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

  /* --- Навигация: перемещение полотна и масштаб (локально, не синхронизируется) --- */
  let isPanning = false, lastPosX = 0, lastPosY = 0, spaceDown = false;
  const isPanMode = () => currentTool === 'pan' || spaceDown;

  // Зум колесом мыши к точке курсора
  canvas.on('mouse:wheel', (opt) => {
    let zoom = canvas.getZoom() * Math.pow(0.999, opt.e.deltaY);
    zoom = Math.min(5, Math.max(0.15, zoom)); // ограничиваем масштаб
    canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
    opt.e.preventDefault();
    opt.e.stopPropagation();
  });

  // Пробел временно включает «руку» (как в графических редакторах)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !(document.activeElement && document.activeElement.isContentEditable)) {
      const ao = canvas.getActiveObject();
      if (ao && ao.isEditing) return; // печатаем пробел в тексте
      spaceDown = true;
      canvas.defaultCursor = 'grab';
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceDown = false; canvas.defaultCursor = currentTool === 'select' ? 'default' : 'crosshair'; }
  });

  // Сброс вида: масштаб 1, позиция в начало
  document.getElementById('resetViewBtn').onclick = () => {
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.requestRenderAll();
  };

  /* --- Рисование фигур мышью --- */
  let draft = null, startX = 0, startY = 0;

  canvas.on('mouse:down', (opt) => {
    // перемещение полотна (инструмент «рука» или зажатый пробел)
    if (isPanMode()) {
      isPanning = true;
      canvas.selection = false;
      canvas.setCursor('grabbing');
      lastPosX = opt.e.clientX;
      lastPosY = opt.e.clientY;
      return;
    }
    // карандаш и ластик рисуются самим Fabric (isDrawingMode), мышью фигуры тут не строим
    if (currentTool === 'select' || currentTool === 'pen' || currentTool === 'eraser') return;
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
    if (isPanning) {
      const vpt = canvas.viewportTransform;
      vpt[4] += opt.e.clientX - lastPosX;
      vpt[5] += opt.e.clientY - lastPosY;
      lastPosX = opt.e.clientX;
      lastPosY = opt.e.clientY;
      canvas.requestRenderAll();
      return;
    }
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
    if (isPanning) {
      isPanning = false;
      canvas.selection = currentTool === 'select';
      canvas.setCursor(isPanMode() ? 'grab' : 'default');
      return;
    }
    if (!draft) return;
    draft.setCoords();
    socket.emit('object:added', serialize(draft)); // теперь транслируем готовую фигуру
    cacheObj(draft);
    pushHist({ kind: 'add', id: draft.id }); // фигуру тоже можно отменить
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
    // Ctrl+Z / Cmd+Z — отмена (не перехватываем при редактировании текста)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      const ao = canvas.getActiveObject();
      if (ao && ao.isEditing) return; // пусть браузер отменяет ввод в тексте
      e.preventDefault();
      undo();
    }
  });
  document.getElementById('clearBtn').onclick = () => {
    if (!confirm('Очистить доску у всех участников?')) return;
    canvas.clear();
    applySheet(currentSheet); // очищаем объекты, но вид листа сохраняем
    canvas.renderAll();
    socket.emit('canvas:cleared');
  };

  /* --- Вид листа (белый / линейка / клетка) --- */
  // Фон рисуется паттерном; backgroundVpt=true по умолчанию => линии двигаются и масштабируются вместе с полотном
  function makeSheetTile(type) {
    const size = 32;
    const t = document.createElement('canvas');
    t.width = size; t.height = size;
    const ctx = t.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#cfd8e3';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (type === 'grid') {
      ctx.moveTo(0.5, 0); ctx.lineTo(0.5, size);   // вертикаль
      ctx.moveTo(0, 0.5); ctx.lineTo(size, 0.5);   // горизонталь
    } else if (type === 'ruled') {
      ctx.moveTo(0, 0.5); ctx.lineTo(size, 0.5);   // только горизонтали
    }
    ctx.stroke();
    return t;
  }
  function applySheet(type) {
    currentSheet = type;
    const sel = document.getElementById('sheet');
    if (sel.value !== type) sel.value = type;
    if (type === 'white') {
      canvas.setBackgroundColor('#ffffff', () => canvas.requestRenderAll());
    } else {
      const pattern = new fabric.Pattern({ source: makeSheetTile(type), repeat: 'repeat' });
      canvas.setBackgroundColor(pattern, () => canvas.requestRenderAll());
    }
  }
  document.getElementById('sheet').addEventListener('change', (e) => {
    applySheet(e.target.value);
    socket.emit('sheet:set', { type: currentSheet }); // синхронизируем вид со вторым участником
  });

  applySheet('white');
  setTool('select');
}
