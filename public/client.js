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
const SIDEBAR_W = 52; // ширина левой панели инструментов

function start(room) {
  lobby.style.display = 'none';
  toolbar.style.display = 'flex';
  document.getElementById('sidebar').style.display = 'flex';
  document.getElementById('roomLabel').textContent = room;

  const socket = io();
  socket.emit('join', room);

  const canvasEl = document.getElementById('board');
  const canvas = new fabric.Canvas('board', { backgroundColor: '#ffffff' });
  window.boardCanvas = canvas; // ссылка для отладки/тестов

  function resize() {
    canvas.setWidth(window.innerWidth - SIDEBAR_W);
    canvas.setHeight(window.innerHeight - 52);
    canvas.calcOffset();
  }
  // canvas-обёртка: ниже тулбара и правее боковой панели
  canvasEl.parentElement.style.marginTop = '52px';
  canvasEl.parentElement.style.marginLeft = SIDEBAR_W + 'px';
  resize();
  window.addEventListener('resize', resize);

  let applyingRemote = false; // подавляет повторную трансляцию при применении чужих изменений
  let currentTool = 'select';
  let currentColor = document.getElementById('color').value;
  let currentSheet = 'white'; // вид листа: white | ruled | grid
  const widths = { pen: 3, eraser: 20, shape: 2 }; // толщина по категориям инструментов
  let internalClipboard = null; // скопированные объекты доски (Ctrl+C/Ctrl+V)
  let leaving = false; // осознанный выход — не показывать предупреждение о закрытии
  // печатаем в поле ввода тулбара (чтобы Delete/Ctrl+Z/пробел там не трогали доску)
  const isTypingInField = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  };
  const CLIP_MARKER = 'ONLINE_DESKTOP_OBJECTS'; // метка в системном буфере: «последним копировали доску»

  /* --- Синхронизация и ОБЩАЯ история (единый стек на сервере) --- */
  const serialize = (obj) => obj.toObject();
  const stateCache = {};       // id -> последнее известное состояние объекта (для before при изменении)
  const byId = (id) => canvas.getObjects().find((o) => o.id === id);
  const cacheObj = (obj) => { if (obj && obj.id) stateCache[obj.id] = serialize(obj); };

  // applyingRemote через счётчик — корректно при нескольких асинхронных enliven подряд (batch/clear)
  let remoteDepth = 0;
  const beginRemote = () => { remoteDepth++; applyingRemote = true; };
  const endRemote = () => { remoteDepth = Math.max(0, remoteDepth - 1); applyingRemote = remoteDepth > 0; };

  // Отправить операцию: сервер запишет её в общую историю и применит у остальных участников
  const sendOp = (op) => socket.emit('op', op);

  // --- Локальные изменения превращаем в операции для общей истории ---
  canvas.on('object:added', (e) => {
    const obj = e.target;
    if (!obj.id) obj.id = uid();
    if (applyingRemote) return;
    cacheObj(obj);
    sendOp({ kind: 'add', obj: serialize(obj) });
  });
  canvas.on('object:modified', (e) => {
    if (applyingRemote) return;
    const obj = e.target;
    const before = stateCache[obj.id];
    cacheObj(obj);
    sendOp({ kind: 'modify', before, after: serialize(obj) });
  });
  canvas.on('text:changed', (e) => {
    if (applyingRemote) return;
    const obj = e.target;
    const before = stateCache[obj.id];
    cacheObj(obj);
    sendOp({ kind: 'modify', before, after: serialize(obj) });
  });
  canvas.on('object:removed', (e) => {
    if (applyingRemote) return;
    if (e.target && e.target.id) {
      const obj = stateCache[e.target.id] || serialize(e.target);
      sendOp({ kind: 'remove', obj });
      delete stateCache[e.target.id];
    }
  });
  // Ластик стёр части объектов -> одна операция batch (один откат вернёт весь штрих)
  canvas.on('erasing:end', (e) => {
    if (applyingRemote || !e || !e.targets) return;
    const items = [];
    e.targets.forEach((obj) => {
      if (!obj.id) return;
      const before = stateCache[obj.id];
      cacheObj(obj);
      items.push({ before, after: serialize(obj) });
    });
    if (items.length) sendOp({ kind: 'batch', items });
  });

  /* --- Применение операций (чужие правки, undo, redo — всё от сервера) --- */
  function upsertLocal(json) {
    beginRemote();
    const ex = byId(json.id);
    if (ex) canvas.remove(ex);
    fabric.util.enlivenObjects([json], ([o]) => {
      o.id = json.id;
      o.erasable = !(currentTool === 'eraser-soft' && o.type === 'image'); // защита картинок в мягком режиме
      o.selectable = currentTool === 'select';
      canvas.add(o);
      cacheObj(o);
      canvas.requestRenderAll();
      endRemote();
    });
  }
  function removeLocal(id) {
    beginRemote();
    const o = byId(id);
    if (o) canvas.remove(o);
    delete stateCache[id];
    endRemote();
  }
  function clearLocal() {
    beginRemote();
    canvas.clear();
    applySheet(currentSheet);
    canvas.renderAll();
    endRemote();
  }
  function applyOp(op, dir) {
    if (op.kind === 'add') {
      if (dir === 'forward') upsertLocal(op.obj); else removeLocal(op.obj.id);
    } else if (op.kind === 'remove') {
      if (dir === 'forward') removeLocal(op.obj.id); else upsertLocal(op.obj);
    } else if (op.kind === 'modify') {
      const json = dir === 'forward' ? op.after : op.before;
      if (json) upsertLocal(json);
    } else if (op.kind === 'batch') {
      op.items.forEach((i) => { const j = dir === 'forward' ? i.after : i.before; if (j) upsertLocal(j); });
    } else if (op.kind === 'clear') {
      if (dir === 'forward') clearLocal();
      else (op.objs || []).forEach((j) => upsertLocal(j));
    }
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }
  socket.on('op:apply', ({ op, dir }) => applyOp(op, dir));

  // Изменить выделенные объекты (applyFn для каждого) и отправить операции.
  // Для группы фиксируем абсолютные координаты, чтобы не разослать относительные (как при вставке).
  function modifySelected(applyFn) {
    const active = canvas.getActiveObject();
    if (!active) return false;
    let targets, wasSelection = false;
    if (active.type === 'activeSelection') {
      targets = active.getObjects().slice();
      canvas.discardActiveObject(); // фиксируем абсолютные координаты детей
      wasSelection = true;
    } else {
      targets = [active];
    }
    let changed = false;
    targets.forEach((o) => {
      const before = stateCache[o.id];
      if (applyFn(o) === false) return; // объект не подходит — пропустить
      changed = true;
      o.setCoords();
      cacheObj(o);
      sendOp({ kind: 'modify', before, after: serialize(o) });
    });
    if (wasSelection) canvas.setActiveObject(new fabric.ActiveSelection(targets, { canvas }));
    canvas.requestRenderAll();
    return changed;
  }

  // Синхронизация состояния при входе нового участника (объекты + вид листа)
  socket.on('request-state', (newId) => {
    socket.emit('send-state', { to: newId, state: { objects: canvas.toJSON(['id']), sheet: currentSheet } });
  });
  socket.on('load-state', (state) => {
    beginRemote();
    canvas.loadFromJSON(state.objects, () => {
      if (state.sheet) applySheet(state.sheet);
      canvas.renderAll();
      endRemote();
    });
  });
  socket.on('sheet:set', ({ type }) => applySheet(type)); // чужой сменил вид листа

  socket.on('peers', (n) => { document.getElementById('peerCount').textContent = n; });

  /* ---------- Инструменты ---------- */
  // Кисти: карандаш и пиксельный ластик (EraserBrush стирает части объектов, а не объект целиком)
  const penBrush = new fabric.PencilBrush(canvas);
  const eraserBrush = fabric.EraserBrush ? new fabric.EraserBrush(canvas) : null;
  if (!eraserBrush) console.warn('EraserBrush недоступен в этой сборке Fabric.js');

  const toolButtons = document.querySelectorAll('button[data-tool]'); // инструменты теперь в боковой панели
  const isEraserTool = (t) => t === 'eraser' || t === 'eraser-soft';
  // К какой категории толщины относится инструмент (null — толщина неприменима)
  const widthCategory = (t) => t === 'pen' ? 'pen' : isEraserTool(t) ? 'eraser' : (t === 'rect' || t === 'circle' || t === 'line') ? 'shape' : null;

  // В «мягком» режиме (eraser-soft) помечаем картинки erasable:false — ластик их пропускает
  function refreshErasable() {
    const protectImages = currentTool === 'eraser-soft';
    canvas.forEachObject((o) => { o.erasable = !(protectImages && o.type === 'image'); });
  }
  // У объекта есть толщина обводки? (текст/картинка — нет)
  const hasStroke = (o) => o && o.type !== 'i-text' && o.type !== 'text' && o.type !== 'image';
  // Подстроить ползунок толщины: под выделенный объект (в режиме выделения) либо под активный инструмент
  function updateThicknessUI() {
    const wrap = document.getElementById('thicknessWrap');
    const slider = document.getElementById('thickness');
    const valEl = document.getElementById('thicknessVal');
    const active = canvas.getActiveObject();
    if (currentTool === 'select' && active) {
      const o = active.type === 'activeSelection' ? active.getObjects().find(hasStroke) : (hasStroke(active) ? active : null);
      if (o) {
        wrap.classList.remove('disabled');
        slider.value = o.strokeWidth || 1;
        valEl.textContent = o.strokeWidth || 1;
        return;
      }
    }
    const cat = widthCategory(currentTool);
    wrap.classList.toggle('disabled', !cat); // для select без объекта/pan/text/картинки — неактивно
    if (cat) { slider.value = widths[cat]; valEl.textContent = widths[cat]; }
  }
  function setTool(tool) {
    if (isEraserTool(tool) && !eraserBrush) return; // нет ластика в сборке — игнорируем
    currentTool = tool;
    toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    canvas.isDrawingMode = tool === 'pen' || isEraserTool(tool);
    canvas.selection = tool === 'select';
    canvas.defaultCursor = tool === 'pan' ? 'grab' : (tool === 'select' ? 'default' : 'crosshair');
    canvas.forEachObject((o) => (o.selectable = tool === 'select'));
    if (tool === 'pen') {
      canvas.freeDrawingBrush = penBrush;
      penBrush.color = currentColor;
      penBrush.width = widths.pen;
    } else if (isEraserTool(tool)) {
      canvas.freeDrawingBrush = eraserBrush;
      eraserBrush.width = widths.eraser;
      refreshErasable(); // обновляем защиту картинок под выбранный режим ластика
    }
    updateThicknessUI();
  }

  // Ползунок толщины: если выделен объект — меняем его обводку; иначе — толщину для будущих штрихов/фигур
  document.getElementById('thickness').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    document.getElementById('thicknessVal').textContent = v;
    const active = canvas.getActiveObject();
    if (currentTool === 'select' && active) {
      modifySelected((o) => { if (!hasStroke(o)) return false; o.set('strokeWidth', v); });
      return;
    }
    const cat = widthCategory(currentTool);
    if (!cat) return;
    widths[cat] = v;
    if (cat === 'pen') penBrush.width = v;
    else if (cat === 'eraser') eraserBrush.width = v;
    // для фигур толщина применяется при создании (widths.shape)
  });

  /* --- Контекстное меню текста: применяется к выделенному фрагменту, иначе ко всему объекту --- */
  const isText = (o) => !!o && (o.type === 'i-text' || o.type === 'text');
  // активный диапазон выделения внутри редактируемого текста (или null)
  const liveRange = (o) => (o.isEditing && o.selectionStart !== o.selectionEnd) ? { start: o.selectionStart, end: o.selectionEnd } : null;
  let pendingRange = null; // диапазон, запомненный до потери фокуса (клик в «Размер»/цвет)
  // эффективный диапазон: живой важнее запомненного
  const effRange = (o) => liveRange(o) || (pendingRange && pendingRange.id === o.id ? pendingRange : null);

  // удалить посимвольное переопределение свойства (чтобы значение объекта применилось единообразно)
  function clearCharStyleProp(o, prop) {
    if (!o.styles) return;
    for (const line in o.styles) for (const ch in o.styles[line]) delete o.styles[line][ch][prop];
  }
  // во всём диапазоне эффективное значение свойства равно value?
  function rangeAllEquals(o, prop, value, r) {
    const styles = o.getSelectionStyles(r.start, r.end);
    return styles.length > 0 && styles.every((s) => (s[prop] !== undefined ? s[prop] : o[prop]) === value);
  }
  // запомнить текущий диапазон перед уходом фокуса
  function captureRange() {
    const o = canvas.getActiveObject();
    const r = isText(o) ? liveRange(o) : null;
    pendingRange = r ? { id: o.id, start: r.start, end: r.end } : null;
  }

  // применить значение свойства к диапазону (посимвольно) или ко всему объекту; разослать и в историю
  function applyTextProp(prop, value, range) {
    const o = canvas.getActiveObject();
    if (!isText(o)) return;
    const before = stateCache[o.id];
    if (range) o.setSelectionStyles({ [prop]: value }, range.start, range.end);
    else { o.set(prop, value); clearCharStyleProp(o, prop); }
    o.initDimensions();
    o.setCoords();
    canvas.requestRenderAll();
    cacheObj(o);
    sendOp({ kind: 'modify', before, after: serialize(o) });
    updateTextMenu();
  }
  // переключить свойство (Ж/К/Ч): кнопки сохраняют выделение -> используем только живой диапазон
  function toggleTextProp(prop, onVal, offVal) {
    const o = canvas.getActiveObject();
    if (!isText(o)) return;
    const r = liveRange(o);
    const isOn = r ? rangeAllEquals(o, prop, onVal, r) : (o[prop] === onVal);
    applyTextProp(prop, isOn ? offVal : onVal, r);
  }

  function updateTextMenu() {
    const o = canvas.getActiveObject();
    const show = isText(o);
    document.getElementById('textToolbar').style.display = show ? 'flex' : 'none';
    if (!show) return;
    const r = liveRange(o);
    const on = (prop, onVal) => r ? rangeAllEquals(o, prop, onVal, r) : (o[prop] === onVal);
    let size = o.fontSize;
    if (r) { const s = o.getSelectionStyles(r.start, r.end); if (s[0] && s[0].fontSize !== undefined) size = s[0].fontSize; }
    document.getElementById('fontSize').value = Math.round(size || 22);
    document.getElementById('boldBtn').classList.toggle('active', on('fontWeight', 'bold'));
    document.getElementById('italicBtn').classList.toggle('active', on('fontStyle', 'italic'));
    document.getElementById('underlineBtn').classList.toggle('active', on('underline', true));
  }

  // «Размер» и выбор цвета забирают фокус у текста — запоминаем диапазон по mousedown
  document.getElementById('fontSize').addEventListener('mousedown', captureRange);
  document.getElementById('color').addEventListener('mousedown', captureRange);
  document.getElementById('fontSize').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    const o = canvas.getActiveObject();
    if (v && isText(o)) applyTextProp('fontSize', v, effRange(o)); // размер: живой или запомненный диапазон
  });
  // Ж/К/Ч не теряют выделение (preventDefault), поэтому диапазон остаётся «живым»
  ['boldBtn', 'italicBtn', 'underlineBtn'].forEach((id) => {
    document.getElementById(id).addEventListener('mousedown', (e) => e.preventDefault());
  });
  document.getElementById('boldBtn').onclick = () => toggleTextProp('fontWeight', 'bold', 'normal');
  document.getElementById('italicBtn').onclick = () => toggleTextProp('fontStyle', 'italic', 'normal');
  document.getElementById('underlineBtn').onclick = () => toggleTextProp('underline', true, false);

  // Обновляем меню/толщину при смене выделения и при работе с текстом
  ['selection:created', 'selection:updated', 'selection:cleared'].forEach((ev) => {
    canvas.on(ev, () => { pendingRange = null; updateThicknessUI(); updateTextMenu(); });
  });
  ['text:selection:changed', 'text:editing:entered', 'text:editing:exited'].forEach((ev) => canvas.on(ev, updateTextMenu));
  toolButtons.forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  document.getElementById('color').addEventListener('input', (e) => {
    currentColor = e.target.value;
    if (canvas.isDrawingMode) canvas.freeDrawingBrush.color = currentColor;
    const active = canvas.getActiveObject();
    if (!active) return;
    if (isText(active)) {
      applyTextProp('fill', currentColor, effRange(active)); // цвет текста — фрагмент или весь
    } else {
      modifySelected((o) => { if (o.type === 'image') return false; o.set('stroke', currentColor); });
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
    renderCursors(); // пересчитать положение чужих курсоров под новый масштаб
  });

  // Пробел временно включает «руку» (как в графических редакторах)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTypingInField()) {
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
    renderCursors();
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
    // карандаш и ластики рисуются самим Fabric (isDrawingMode), мышью фигуры тут не строим
    if (currentTool === 'select' || currentTool === 'pen' || isEraserTool(currentTool)) return;
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
    const common = { left: p.x, top: p.y, stroke: currentColor, strokeWidth: widths.shape, fill: 'transparent', id: uid() };
    if (currentTool === 'rect') draft = new fabric.Rect({ ...common, width: 0, height: 0 });
    else if (currentTool === 'circle') draft = new fabric.Ellipse({ ...common, rx: 0, ry: 0 });
    else if (currentTool === 'line') draft = new fabric.Line([p.x, p.y, p.x, p.y], { stroke: currentColor, strokeWidth: widths.shape, id: uid() });
    if (draft) { beginRemote(); canvas.add(draft); endRemote(); } // не транслируем пустую заготовку
  });

  canvas.on('mouse:move', (opt) => {
    if (isPanning) {
      const vpt = canvas.viewportTransform;
      vpt[4] += opt.e.clientX - lastPosX;
      vpt[5] += opt.e.clientY - lastPosY;
      lastPosX = opt.e.clientX;
      lastPosY = opt.e.clientY;
      canvas.requestRenderAll();
      renderCursors(); // курсоры других смещаются вместе с полотном
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
    cacheObj(draft);
    sendOp({ kind: 'add', obj: serialize(draft) }); // готовая фигура -> операция add
    draft = null;
    setTool('select');
  });

  /* --- Картинки --- */
  // Добавить картинку из dataURL (base64), центром в точке point (сцена). По умолчанию — центр экрана.
  function addImage(dataURL, point) {
    fabric.Image.fromURL(dataURL, (img) => {
      const scale = Math.min(1, 400 / img.width);
      img.set({ scaleX: scale, scaleY: scale, id: uid(), erasable: currentTool !== 'eraser-soft' });
      const p = point || viewportCenterScene();
      img.setPositionByOrigin(new fabric.Point(p.x, p.y), 'center', 'center');
      img.setCoords();
      canvas.add(img); // object:added транслирует картинку (base64) остальным
      canvas.setActiveObject(img);
      canvas.requestRenderAll();
    });
  }

  function readFileAsImage(file, point) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => addImage(ev.target.result, point);
    reader.readAsDataURL(file);
  }

  const imageInput = document.getElementById('imageInput');
  document.getElementById('imageBtn').onclick = () => imageInput.click();
  imageInput.onchange = (e) => {
    readFileAsImage(e.target.files[0]);
    imageInput.value = '';
  };

  // Отслеживаем позицию курсора в экранных координатах (для вставки под мышку)
  let lastClient = null;
  window.addEventListener('mousemove', (e) => { lastClient = { x: e.clientX, y: e.clientY }; });

  // Экран -> координаты сцены с учётом сдвига/зума. null, если курсор вне области доски.
  function clientToScene(clientX, clientY) {
    const rect = canvas.upperCanvasEl.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const inv = fabric.util.invertTransform(canvas.viewportTransform);
    return fabric.util.transformPoint(new fabric.Point(x, y), inv);
  }
  // Центр видимой области в координатах сцены
  function viewportCenterScene() {
    const inv = fabric.util.invertTransform(canvas.viewportTransform);
    return fabric.util.transformPoint(new fabric.Point(canvas.getWidth() / 2, canvas.getHeight() / 2), inv);
  }

  // Вставить скопированные объекты доски с центром в точке point (сцена)
  function pasteInternal(point) {
    if (!internalClipboard) return;
    internalClipboard.clone((clone) => {
      canvas.discardActiveObject();
      const p = point || viewportCenterScene();
      clone.setPositionByOrigin(new fabric.Point(p.x, p.y), 'center', 'center'); // центр вставки = курсор/центр экрана
      if (clone.type === 'activeSelection') {
        // Группа: у детей координаты относительны центру группы. Чтобы не разослать/не запомнить
        // относительные координаты, сначала добавляем молча, фиксируем абсолютные координаты
        // снятием выделения, и только потом транслируем и пишем историю.
        clone.canvas = canvas;
        const kids = clone.getObjects();
        beginRemote();
        kids.forEach((o) => { o.id = uid(); canvas.add(o); });
        canvas.setActiveObject(clone);
        canvas.discardActiveObject(); // <- здесь дети получают абсолютные left/top
        endRemote();
        kids.forEach((o) => {
          o.setCoords();
          cacheObj(o);
          sendOp({ kind: 'add', obj: serialize(o) }); // теперь координаты верные
        });
        canvas.setActiveObject(new fabric.ActiveSelection(kids, { canvas })); // вернём групповое выделение
      } else {
        clone.id = uid();
        canvas.add(clone); // одиночный: object:added сам отправит операцию add
        canvas.setActiveObject(clone);
      }
      canvas.requestRenderAll();
    }, ['id', 'eraser']);
  }

  // Ctrl+V. Приоритет — последнему копированию: если в буфере наша метка, значит копировали объекты доски.
  window.addEventListener('paste', (e) => {
    // не перехватываем вставку, если редактируется текст на доске
    const active = canvas.getActiveObject();
    if (active && active.isEditing) return;

    const cd = e.clipboardData || window.clipboardData;
    const text = cd ? cd.getData('text/plain') : '';

    // последним копировали объекты доски -> вставляем их под курсор (или в центр экрана)
    if (text && text.indexOf(CLIP_MARKER) === 0 && internalClipboard) {
      e.preventDefault();
      pasteInternal(lastClient ? clientToScene(lastClient.x, lastClient.y) : null);
      return;
    }
    // иначе — картинка из системного буфера (скриншот и т.п.)
    const items = cd?.items || [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        readFileAsImage(item.getAsFile(), lastClient ? clientToScene(lastClient.x, lastClient.y) : null);
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
    if (isTypingInField()) return; // печатаем в поле тулбара — не трогаем доску
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const ao = canvas.getActiveObject();
      if (ao && !ao.isEditing) { e.preventDefault(); deleteActive(); }
    }
    const ao = canvas.getActiveObject();
    if (ao && ao.isEditing) return; // в режиме текста отдаём отмену браузеру
    // Ctrl+Z — отмена; Ctrl+Shift+Z или Ctrl+Y — повтор. Сравниваем по e.code (любая раскладка).
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
      e.preventDefault();
      socket.emit('undo'); // отмена в общей истории на сервере
    } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) {
      e.preventDefault();
      socket.emit('redo'); // повтор
    }
  });

  // Копирование объектов доски: помечаем системный буфер, чтобы вставка знала — последним копировали доску.
  // Событие 'copy' срабатывает на Ctrl+C при любой раскладке и при копировании через меню.
  window.addEventListener('copy', (e) => {
    const ao = canvas.getActiveObject();
    if (!ao || ao.isEditing || !e.clipboardData) return; // нет выделения / печатаем текст — обычное копирование
    ao.clone((cloned) => { internalClipboard = cloned; }, ['id', 'eraser']);
    e.clipboardData.setData('text/plain', CLIP_MARKER); // метка перетирает прошлое содержимое буфера
    e.preventDefault();
  });
  document.getElementById('clearBtn').onclick = () => {
    const objs = canvas.getObjects().map((o) => serialize(o));
    if (!objs.length) return;
    if (!confirm('Очистить доску у всех участников?')) return;
    beginRemote();                  // молча убираем объекты, чтобы не сыпать remove-операциями
    canvas.clear();
    applySheet(currentSheet);       // объекты убираем, вид листа сохраняем
    canvas.renderAll();
    endRemote();
    sendOp({ kind: 'clear', objs }); // одна операция clear (её можно отменить)
  };

  // Защита от случайного закрытия/перезагрузки: встроенный диалог браузера, если на доске что-то есть
  window.addEventListener('beforeunload', (e) => {
    if (!leaving && canvas.getObjects().length > 0) {
      e.preventDefault();
      e.returnValue = ''; // современные браузеры показывают свой стандартный текст
    }
  });

  // Выход из комнаты: отключаемся и возвращаемся на экран входа (без ?room в адресе)
  document.getElementById('exitBtn').onclick = () => {
    if (!confirm('Выйти из комнаты? Несохранённая доска будет потеряна.')) return;
    leaving = true;               // осознанный выход — без двойного предупреждения beforeunload
    socket.disconnect();          // второй участник увидит уменьшение числа участников
    window.location = location.pathname; // перезагрузка на лобби — полностью сбрасывает состояние
  };

  // Сохранить всю исписанную область доски в PNG (2× разрешение, с фоном листа)
  document.getElementById('saveBtn').onclick = () => {
    const objs = canvas.getObjects();
    if (!objs.length) { alert('Доска пустая — нечего сохранять.'); return; }

    const savedVpt = canvas.viewportTransform;
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]); // считаем в координатах сцены, зум 1

    // границы всего нарисованного
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    objs.forEach((o) => {
      const r = o.getBoundingRect(true); // абсолютные координаты
      minX = Math.min(minX, r.left); minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.left + r.width); maxY = Math.max(maxY, r.top + r.height);
    });
    const pad = 24; // поля вокруг содержимого
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const contentW = maxX - minX, contentH = maxY - minY;

    // Браузер ограничивает размер canvas. Подбираем множитель так, чтобы PNG влезал в лимиты:
    // желаемое 2×, но не больше MAX_DIM по стороне и MAX_AREA по площади.
    const MAX_DIM = 8192, MAX_AREA = 8192 * 8192;
    let mult = Math.min(2, MAX_DIM / contentW, MAX_DIM / contentH, Math.sqrt(MAX_AREA / (contentW * contentH)));
    if (!isFinite(mult) || mult <= 0) mult = 1;

    const dataURL = canvas.toDataURL({ format: 'png', multiplier: mult, left: minX, top: minY, width: contentW, height: contentH });

    canvas.setViewportTransform(savedVpt); // вернуть прежний вид
    canvas.requestRenderAll();

    if (!dataURL || dataURL.length < 100) { // подстраховка, если браузер всё же не справился
      alert('Не удалось сохранить: область слишком большая. Сдвиньте объекты ближе друг к другу.');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = `board-${stamp}.png`;
    a.click();
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

  /* --- Курсор для другого участника --- */
  let sharingCursor = false;
  let lastCursorSent = 0;
  const remoteCursors = {}; // from -> { x, y, visible, el }
  const cursorLayer = document.getElementById('cursorLayer');
  cursorLayer.style.display = 'block';

  function cursorEl(from) {
    let c = remoteCursors[from];
    if (!c) c = remoteCursors[from] = { x: null, y: null, visible: false, el: null, ptr: null, edge: null };
    if (!c.el) {
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      const ptr = document.createElement('span'); // указатель (когда курсор на экране)
      ptr.className = 'cur-ptr';
      ptr.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L4 19 L9 14 L12 21 L15 20 L12 13 L19 13 Z" fill="#e11d48" stroke="#fff" stroke-width="1.5"/></svg>';
      const edge = document.createElement('span'); // маркер у края (когда курсор за экраном), стрелка вправо по умолчанию
      edge.className = 'cur-edge';
      edge.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="11" fill="#e11d48" stroke="#fff" stroke-width="2"/><path d="M11 9 L19 14 L11 19 Z" fill="#fff"/></svg>';
      el.appendChild(ptr); el.appendChild(edge);
      cursorLayer.appendChild(el);
      c.el = el; c.ptr = ptr; c.edge = edge;
    }
    return c;
  }
  function placeCursor(c) {
    if (!c.el) return;
    if (!(c.visible && c.x != null)) { c.el.style.display = 'none'; return; }
    const vpt = canvas.viewportTransform; // сцена -> экран (без вращения)
    const W = cursorLayer.clientWidth, H = cursorLayer.clientHeight;
    const sx = vpt[0] * c.x + vpt[4], sy = vpt[3] * c.y + vpt[5];
    c.el.style.display = 'block';
    if (sx >= 0 && sx <= W && sy >= 0 && sy <= H) {
      // курсор в видимой области — обычный указатель
      c.el.style.left = sx + 'px';
      c.el.style.top = sy + 'px';
      c.el.style.transform = 'translate(-3px, -2px)';
      c.ptr.style.display = 'block'; c.edge.style.display = 'none';
    } else {
      // курсор за экраном — маркер у края, повёрнутый в сторону курсора
      const cx = W / 2, cy = H / 2, margin = 20;
      const dx = sx - cx, dy = sy - cy;
      const scale = Math.min((W / 2 - margin) / Math.max(Math.abs(dx), 1e-6), (H / 2 - margin) / Math.max(Math.abs(dy), 1e-6));
      c.el.style.left = (cx + dx * scale) + 'px';
      c.el.style.top = (cy + dy * scale) + 'px';
      c.el.style.transform = 'translate(-50%, -50%)';
      c.edge.style.transform = 'rotate(' + (Math.atan2(dy, dx) * 180 / Math.PI) + 'deg)';
      c.ptr.style.display = 'none'; c.edge.style.display = 'block';
    }
  }
  function renderCursors() { Object.keys(remoteCursors).forEach((k) => placeCursor(remoteCursors[k])); }

  socket.on('cursor', (d) => {
    const c = cursorEl(d.from);
    if (d.visible) { c.x = d.x; c.y = d.y; c.visible = true; } else { c.visible = false; }
    placeCursor(c);
  });

  const sendCursor = (x, y, visible) => socket.emit('cursor', visible ? { x, y, visible: true } : { visible: false });

  window.addEventListener('mousemove', (e) => {
    if (!sharingCursor) return;
    const now = Date.now();
    if (now - lastCursorSent < 40) return; // не чаще ~25 раз/сек
    const p = clientToScene(e.clientX, e.clientY);
    if (!p) return; // курсор над тулбаром/вне доски — не обновляем
    lastCursorSent = now;
    sendCursor(p.x, p.y, true);
  });
  // мышь ушла за пределы окна сайта или вкладка скрыта -> курсор у других исчезает
  document.addEventListener('mouseleave', () => { if (sharingCursor) sendCursor(0, 0, false); });
  document.addEventListener('visibilitychange', () => { if (sharingCursor && document.hidden) sendCursor(0, 0, false); });

  document.getElementById('cursorBtn').onclick = () => {
    sharingCursor = !sharingCursor;
    document.getElementById('cursorBtn').classList.toggle('active', sharingCursor);
    if (!sharingCursor) sendCursor(0, 0, false); // выключили показ — спрятать у других
  };
  document.getElementById('findBtn').onclick = () => {
    const list = Object.keys(remoteCursors).map((k) => remoteCursors[k]).filter((c) => c.x != null);
    const target = list.find((c) => c.visible) || list[0];
    if (!target) { alert('Курсор другого участника не виден. Попросите его включить показ курсора (кнопка 👁 Курсор).'); return; }
    const zoom = canvas.getZoom();
    const vpt = canvas.viewportTransform.slice();
    vpt[4] = canvas.getWidth() / 2 - zoom * target.x;
    vpt[5] = canvas.getHeight() / 2 - zoom * target.y;
    canvas.setViewportTransform(vpt);
    canvas.requestRenderAll();
    renderCursors();
  };

  applySheet('white');
  setTool('select');
}
