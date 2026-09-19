# Shared Viewport and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Синхронизировать масштаб и положение доски у всех участников, уменьшить постепенное падение производительности и добавить постоянно видимую палитру с кнопками undo/redo.

**Architecture:** Сервер хранит лёгкое состояние комнаты: историю операций и последний нормализованный вид `{ centerX, centerY, zoom, revision }`. Чистые функции расчёта вида, ограничения частоты, текстового объединения и оценки истории выносятся в тестируемые модули; `client.js` связывает их с Fabric.js и DOM, сохраняя текущий протокол операций.

**Tech Stack:** Node.js 18+, Express 5, Socket.IO 4, Fabric.js 5.3, встроенный `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-18-shared-viewport-performance-design.md`

## Global Constraints

- Масштаб ограничен диапазоном `0.15–5`.
- Серверная история ограничена 200 операциями и 25 МБ на комнату.
- Частота передачи общего вида — не более 20 сообщений в секунду с обязательной отправкой последнего состояния.
- Текстовые изменения объединяются в окно 150 мс и сбрасываются при выходе из редактирования.
- Изображения с любой стороной больше 2048 px уменьшаются до 2048 px пропорционально.
- Основная доска не переносится в базу данных и исчезает после опустошения комнаты, как сейчас.
- Дополнительные требования пользователя: постоянно видимая палитра справа снизу, произвольный цвет, кнопки «Отменить» и «Повторить».

---

### Task 1: Тестовый каркас и серверное состояние комнаты

**Files:**
- Create: `lib/room-state.js`
- Create: `test/room-state.test.js`
- Modify: `package.json`
- Modify: `server.js`

**Interfaces:**
- Produces: `normalizeView(input)`, `RoomStateStore`, `MAX_HISTORY_COUNT`, `MAX_HISTORY_BYTES`.
- `RoomStateStore.join(room)` возвращает `{ view }`.
- `RoomStateStore.updateView(room, input)` возвращает нормализованный вид с новой ревизией либо `null`.
- `RoomStateStore.pushOperation(room, op)` возвращает `true`, если операция вошла в историю.
- `RoomStateStore.undo(room)` и `redo(room)` возвращают операцию либо `null`.

- [ ] **Step 1: Добавить команды тестирования**

Изменить `package.json`:

```json
"scripts": {
  "start": "node server.js",
  "test": "node --test",
  "test:load": "node test/load-scenario.js"
}
```

- [ ] **Step 2: Написать падающие тесты нормализации вида**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeView } = require('../lib/room-state');

test('normalizeView clamps zoom and rejects non-finite coordinates', () => {
  assert.deepEqual(normalizeView({ centerX: 10, centerY: -4, zoom: 99 }), {
    centerX: 10, centerY: -4, zoom: 5
  });
  assert.equal(normalizeView({ centerX: Infinity, centerY: 0, zoom: 1 }), null);
});
```

- [ ] **Step 3: Запустить тест и подтвердить RED**

Run: `npm test -- --test-name-pattern="normalizeView"`

Expected: FAIL, потому что `lib/room-state.js` ещё не существует.

- [ ] **Step 4: Реализовать минимальную нормализацию**

```js
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 5;

function normalizeView(input) {
  if (!input || !Number.isFinite(input.centerX) ||
      !Number.isFinite(input.centerY) || !Number.isFinite(input.zoom)) return null;
  return {
    centerX: input.centerX,
    centerY: input.centerY,
    zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, input.zoom))
  };
}
```

- [ ] **Step 5: Написать падающие тесты истории и ревизий**

Проверить монотонную ревизию, last-write-wins, очистку комнаты, лимит 200 элементов, лимит 25 МБ, исключение одной слишком крупной операции из истории и сохранение redo/undo.

```js
test('room view revision increases and empty room is removed', () => {
  const store = new RoomStateStore();
  const first = store.updateView('a', { centerX: 1, centerY: 2, zoom: 1 });
  const second = store.updateView('a', { centerX: 3, centerY: 4, zoom: 2 });
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  store.delete('a');
  assert.equal(store.getView('a'), null);
});
```

- [ ] **Step 6: Реализовать `RoomStateStore` и перевести `server.js` на него**

В `server.js` заменить отдельный `roomHistory` на хранилище. Добавить события:

```js
socket.on('view:set', (input) => {
  if (!currentRoom) return;
  const view = rooms.updateView(currentRoom, input);
  if (view) socket.to(currentRoom).emit('view:set', view);
});
```

После `join` отправлять подключившемуся `view:set`, если вид комнаты существует. При `disconnect` последнего участника вызывать `rooms.delete(currentRoom)`. Установить `maxHttpBufferSize: 20 * 1024 * 1024`.

- [ ] **Step 7: Запустить серверные тесты и весь набор**

Run: `npm test`

Expected: PASS без предупреждений.

- [ ] **Step 8: Зафиксировать изменения**

```bash
git add package.json server.js lib/room-state.js test/room-state.test.js
git commit -m "feat: manage bounded room state and shared view"
```

### Task 2: Чистые клиентские функции общего вида и ограничения частоты

**Files:**
- Create: `public/board-utils.js`
- Create: `test/board-utils.test.js`
- Modify: `public/index.html`

**Interfaces:**
- Produces browser global and CommonJS export `BoardUtils`.
- `viewFromTransform(vpt, width, height)` возвращает `{ centerX, centerY, zoom }`.
- `transformFromView(view, width, height)` возвращает шестичленную матрицу Fabric.js.
- `createTrailingThrottle(fn, intervalMs, timers?)` возвращает функцию с методами `flush()` и `cancel()`.
- `createRenderScheduler(render, raf?)` объединяет запросы до одного вызова за кадр.

- [ ] **Step 1: Написать падающие тесты преобразования вида**

```js
test('same shared center works for different viewport sizes', () => {
  const view = { centerX: 100, centerY: 50, zoom: 2 };
  const small = transformFromView(view, 800, 600);
  const large = transformFromView(view, 1600, 900);
  assert.deepEqual(viewFromTransform(small, 800, 600), view);
  assert.deepEqual(viewFromTransform(large, 1600, 900), view);
});
```

- [ ] **Step 2: Запустить тест и подтвердить RED**

Run: `node --test test/board-utils.test.js`

Expected: FAIL из-за отсутствующего модуля.

- [ ] **Step 3: Реализовать преобразования**

```js
function transformFromView(view, width, height) {
  const z = view.zoom;
  return [z, 0, 0, z, width / 2 - z * view.centerX, height / 2 - z * view.centerY];
}

function viewFromTransform(vpt, width, height) {
  const zoom = vpt[0];
  return {
    centerX: (width / 2 - vpt[4]) / zoom,
    centerY: (height / 2 - vpt[5]) / zoom,
    zoom
  };
}
```

- [ ] **Step 4: Написать падающий тест trailing throttle**

Проверить немедленный первый вызов, отсутствие более 20 вызовов/сек и обязательную передачу последнего аргумента после окончания серии.

- [ ] **Step 5: Реализовать throttle и планировщик отрисовки**

Throttle хранит `lastArgs`, один таймер и время последнего вызова. `flush()` немедленно отправляет накопленное значение, `cancel()` удаляет таймер. Планировщик хранит один `frameId` и вызывает `render` один раз за кадр.

- [ ] **Step 6: Подключить утилиты перед `client.js`**

```html
<script src="/board-utils.js"></script>
<script src="/client.js"></script>
```

- [ ] **Step 7: Запустить тесты и зафиксировать изменения**

Run: `npm test`

```bash
git add public/board-utils.js public/index.html test/board-utils.test.js
git commit -m "test: add shared viewport client primitives"
```

### Task 3: Интеграция полностью общего вида

**Files:**
- Modify: `public/client.js`
- Modify: `test/board-utils.test.js`

**Interfaces:**
- Consumes: `BoardUtils.viewFromTransform`, `transformFromView`, `createTrailingThrottle`, `createRenderScheduler`.
- Socket events: client emits `view:set`; server emits `view:set` with `revision`.

- [ ] **Step 1: Добавить падающий тест контроллера ревизий**

Добавить в `board-utils.js` фабрику `createRevisionGate(apply)` и проверить, что ревизии `4`, затем `3` применяют только состояние `4`.

```js
test('revision gate ignores stale shared views', () => {
  const applied = [];
  const accept = createRevisionGate((view) => applied.push(view.revision));
  assert.equal(accept({ revision: 4 }), true);
  assert.equal(accept({ revision: 3 }), false);
  assert.deepEqual(applied, [4]);
});
```

- [ ] **Step 2: Реализовать gate и подтвердить GREEN**

Run: `node --test test/board-utils.test.js`

- [ ] **Step 3: Подключить общий вид к Fabric.js**

В `client.js` создать `emitView` через throttle 50 мс. После локального wheel/pan/reset рассчитывать центр из текущей матрицы и вызывать `emitView(view)`. После `mouse:up` в режиме pan вызывать `emitView.flush()`.

Обработчик сервера:

```js
const acceptRemoteView = BoardUtils.createRevisionGate((view) => {
  canvas.setViewportTransform(BoardUtils.transformFromView(view, canvas.getWidth(), canvas.getHeight()));
  scheduleRender();
  renderCursors();
  updateZoomLabel(view.zoom);
});
socket.on('view:set', acceptRemoteView);
```

Полученное состояние не вызывает `emitView`. `resize()` запоминает нормализованный текущий вид до смены размеров и восстанавливает его после.

- [ ] **Step 4: Сделать кнопку «Вид» общей**

Установить вид `{ centerX: 0, centerY: 0, zoom: 1 }`, применить локально и отправить на сервер. Обновить индикатор масштаба.

- [ ] **Step 5: Проверить два размера окна вручную**

Запустить `npm start`, открыть одну комнату в двух окнах 800×600 и 1400×900. Проверить zoom, pan, reset, вход третьего окна и отсутствие обратного эха.

- [ ] **Step 6: Запустить тесты и зафиксировать изменения**

Run: `npm test`

```bash
git add public/client.js public/board-utils.js test/board-utils.test.js
git commit -m "feat: synchronize room viewport"
```

### Task 4: Оптимизация объектов, текста, изображений и истории клиента

**Files:**
- Modify: `public/board-utils.js`
- Modify: `public/client.js`
- Modify: `test/board-utils.test.js`

**Interfaces:**
- Produces: `createObjectIndex()`, `createTextBatcher(send, delayMs, timers?)`, `fitWithin(width, height, maxSide)`.
- Object index exposes `get`, `set`, `delete`, `clear`, `rebuild`.
- Text batcher exposes `change(id, before, after)`, `flush(id)`, `flushAll()`.

- [ ] **Step 1: Написать падающие тесты индекса и текстового batcher**

Проверить замену объекта с тем же ID, очистку/перестроение, объединение трёх изменений текста в одну операцию с первым `before` и последним `after`, а также немедленный `flush`.

- [ ] **Step 2: Реализовать индекс и batcher**

Индекс инкапсулирует `Map`. Batcher хранит по ID `{ before, after, timer }`, не заменяет первый `before`, обновляет последний `after` и вызывает `send({ kind: 'modify', before, after })` через 150 мс.

- [ ] **Step 3: Заменить линейный поиск и дублирующую сериализацию**

В `client.js` заменить `byId` на индекс. Функция `cacheObj` принимает уже сериализованный JSON и не вызывает `toObject()` второй раз. Все add/remove/upsert/load/clear обновляют индекс и кэш симметрично.

- [ ] **Step 4: Объединить отрисовки**

Создать `scheduleRender`. Убрать повторные `requestRenderAll()` из внутренних веток `applyOp`; пакет и восстановление clear завершаются одним вызовом. Не менять визуальный порядок объектов.

- [ ] **Step 5: Перевести ввод текста на batcher**

`text:changed` передаёт изменения batcher, а `text:editing:exited` вызывает `flush(obj.id)`. Перед undo/redo, clear, выходом и unload вызывается `flushAll()`.

- [ ] **Step 6: Написать и реализовать тест размера изображения**

```js
test('fitWithin preserves ratio and does not enlarge small images', () => {
  assert.deepEqual(fitWithin(4000, 2000, 2048), { width: 2048, height: 1024, scale: 0.512 });
  assert.deepEqual(fitWithin(800, 600, 2048), { width: 800, height: 600, scale: 1 });
});
```

Перед `FileReader`/Fabric создать `Image`, рассчитать размер, отрисовать слишком крупный исходник во временный canvas и выбрать PNG при наличии прозрачности, иначе JPEG 0.88. Ошибку декодирования показать через `alert`.

- [ ] **Step 7: Настроить карандаш и финальную передачу курсора**

Установить `penBrush.decimate = 1.5`. Сохранить текущую частоту курсора, но реализовать её через trailing throttle, чтобы последнее положение серии не терялось.

- [ ] **Step 8: Запустить тесты и зафиксировать изменения**

Run: `npm test`

```bash
git add public/client.js public/board-utils.js test/board-utils.test.js
git commit -m "perf: reduce board serialization and rendering work"
```

### Task 5: Постоянная палитра, undo/redo и визуальный рефреш

**Files:**
- Modify: `public/index.html`
- Modify: `public/client.js`
- Create: `test/ui-contract.test.js`

**Interfaces:**
- DOM IDs: `undoBtn`, `redoBtn`, `colorPalette`, `customColor`, `zoomLabel`.
- Цветовые образцы имеют `data-color="#rrggbb"` и доступный `aria-label`.

- [ ] **Step 1: Написать падающий контрактный тест HTML**

Тест читает `public/index.html` и проверяет уникальное наличие пяти ID, минимум восьми `data-color`, подписи кнопок и подключение `board-utils.js` перед `client.js`.

- [ ] **Step 2: Добавить кнопки истории и индикатор масштаба**

В верхней панели разместить `↶ Отменить`, `↷ Повторить`, `100%`. Обработчики кнопок сначала сбрасывают текстовый batcher, затем отправляют `undo` или `redo`. Клавиатурные сочетания используют те же функции, включая `Ctrl+Shift+Z` для повтора.

- [ ] **Step 3: Добавить постоянную палитру**

Создать фиксированную справа снизу панель с цветами:

`#111827`, `#ffffff`, `#ef4444`, `#f97316`, `#eab308`, `#22c55e`, `#06b6d4`, `#2563eb`, `#7c3aed`, `#ec4899`.

Добавить отдельный `input type="color"` для произвольного цвета. Выбранный образец имеет рамку/галочку. Выбор вызывает существующую логику применения цвета к инструменту или выделению.

- [ ] **Step 4: Умеренно обновить стили**

Сгруппировать связанные команды, унифицировать размеры и hover/focus/active-состояния, улучшить контраст и тени. Не добавлять зависимости и не менять расположение холста относительно панелей.

- [ ] **Step 5: Запустить тесты и проверить интерфейс вручную**

Run: `npm test`

Проверить палитру, произвольный цвет, выделенный объект/текст, обе кнопки истории, клавиатуру и индикатор масштаба в двух окнах.

- [ ] **Step 6: Зафиксировать изменения**

```bash
git add public/index.html public/client.js test/ui-contract.test.js
git commit -m "feat: add persistent palette and history controls"
```

### Task 6: Нагрузочное сравнение и финальная проверка

**Files:**
- Create: `test/load-scenario.js`
- Create: `docs/performance-results.md`
- Modify: `README.md` if it exists; otherwise create `README.md`

**Interfaces:**
- `test/load-scenario.js` создаёт повторяемый смешанный набор операций и печатает JSON с `operationCount`, `historyBytes`, `retainedHistory`, `renderRequests`, `elapsedMs`.

- [ ] **Step 1: Создать повторяемый смешанный сценарий**

Использовать фиксированный seed и операции: 600 штрихов, 120 текстовых серий по 20 символов, 150 фигур, 12 метаданных изображений, 1000 изменений вида. Для чистых функций измерить число принятых событий, размер удержанной истории и время обработки.

- [ ] **Step 2: Запустить полный набор проверок**

Run: `npm test`

Expected: все тесты PASS.

Run: `npm run test:load`

Expected: exit code 0, `historyBytes <= 26214400`, `retainedHistory <= 200`, throttled view events существенно меньше 1000.

- [ ] **Step 3: Проверить запуск сервера**

Run: `npm start`

Expected: вывод адреса без исключений. Отдельным Socket.IO-клиентом проверить join, op, undo, redo, view:set и очистку состояния после disconnect.

- [ ] **Step 4: Провести ручной сценарий двух клиентов**

Проверить все инструменты, текстовый ввод, крупное изображение, общий pan/zoom/reset, undo/redo кнопками и клавиатурой, постоянную палитру, вход третьего окна и 10-минутный ускоренный смешанный сценарий без нарастающего зависания.

- [ ] **Step 5: Записать фактические результаты**

В `docs/performance-results.md` указать окружение, точные команды, результаты до/после доступных метрик, ограничения синтетического теста и результат ручной проверки. Не заявлять улучшение, которое не подтверждено измерением.

- [ ] **Step 6: Обновить инструкцию запуска и зафиксировать изменения**

README должен содержать Node.js 18+, `npm install`, `npm start`, `npm test`, управление общим видом, палитрой и историей.

```bash
git add test/load-scenario.js docs/performance-results.md README.md
git commit -m "test: document board performance verification"
```

- [ ] **Step 7: Финальная проверка чистого состояния**

Run: `npm test && npm run test:load`

Run: `git status --short`

Expected: тесты PASS; рабочее дерево содержит только намеренно неотслеживаемые исходные файлы, если они не были добавлены в исходный архивный репозиторий.
