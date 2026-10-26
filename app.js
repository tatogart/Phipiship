'use strict';

/* =========================================================
   PhipiShip — браузерный растровый редактор
   ========================================================= */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const TOOL_NAMES = {
  move: 'Перемещение', crop: 'Кадрирование', brush: 'Кисть', eraser: 'Ластик',
  fill: 'Заливка', picker: 'Пипетка', text: 'Текст', line: 'Линия',
  rect: 'Прямоугольник', ellipse: 'Эллипс', hand: 'Рука', zoom: 'Масштаб',
};
const TOOL_HINTS = {
  move: 'Перетащите, чтобы сдвинуть активный слой. Стрелки — сдвиг на 1 px (Shift — на 10 px).',
  picker: 'Клик — основной цвет, Alt+клик — фоновый.',
  hand: 'Перетащите, чтобы прокрутить холст. Колесо мыши — масштаб.',
  zoom: 'Клик — приблизить, Alt+клик — отдалить.',
};
const TOOL_KEYS = {
  v: 'move', c: 'crop', b: 'brush', e: 'eraser', g: 'fill', i: 'picker',
  t: 'text', l: 'line', u: 'rect', o: 'ellipse', h: 'hand', z: 'zoom',
};
const TOOL_CURSORS = {
  move: 'move', crop: 'crosshair', brush: 'none', eraser: 'none', fill: 'crosshair',
  picker: 'crosshair', text: 'text', line: 'crosshair', rect: 'crosshair',
  ellipse: 'crosshair', hand: 'grab', zoom: 'zoom-in',
};
const PALETTE = [
  '#000000', '#3a3a3a', '#7a7a7a', '#b5b5b5', '#ffffff', '#5b3a29', '#a0522d', '#d2a679', '#f5deb3', '#fff4e0',
  '#e53935', '#fb8c00', '#fdd835', '#7cb342', '#43a047', '#00897b', '#039be5', '#3949ab', '#8e24aa', '#d81b60',
  '#ff8a80', '#ffd180', '#ffff8d', '#ccff90', '#a7ffeb', '#80d8ff', '#82b1ff', '#b388ff', '#ff80ab', '#7c5cff',
];

const state = {
  w: 1200, h: 800,
  layers: [],
  active: 0,
  tool: 'brush',
  primary: '#000000',
  secondary: '#ffffff',
  size: 12,
  opacity: 1,
  tolerance: 32,
  shapeFill: false,
  font: 'system-ui, sans-serif',
  fontSize: 48,
  fontBold: false,
  zoom: 1, panX: 0, panY: 0,
  dirty: false,
};

let nextLayerId = 1;
const viewport = $('#viewport');
const stage = $('#stage');
const view = $('#view');
const vctx = view.getContext('2d', { willReadFrequently: true });
const temp = document.createElement('canvas');      // предпросмотр мазка / фигуры
const tctx = temp.getContext('2d');
const scratch = document.createElement('canvas');   // слой + предпросмотр
const sctx = scratch.getContext('2d');

const brushCursor = document.createElement('div');
brushCursor.className = 'brush-cursor';
viewport.appendChild(brushCursor);

/* ---------------- Утилиты ---------------- */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

let msgTimer = 0;
function status(msg) {
  const el = $('#statusMsg');
  el.textContent = msg;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (el.textContent = ''), 3500);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать изображение')); };
    img.src = url;
  });
}

/* ---------------- Слои ---------------- */

function createLayer(name, fill) {
  const canvas = makeCanvas(state.w, state.h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, state.w, state.h);
  }
  return { id: nextLayerId++, name, canvas, ctx, visible: true, opacity: 1, blend: 'source-over', dx: 0, dy: 0 };
}

const activeLayer = () => state.layers[state.active];

function resizeAux() {
  for (const c of [view, temp, scratch]) {
    c.width = state.w;
    c.height = state.h;
  }
  $('#statusSize').textContent = `${state.w} × ${state.h} px`;
}

function newDocument(w, h, bg) {
  state.w = w;
  state.h = h;
  resizeAux();
  state.layers = [createLayer('Фон', bg === 'transparent' ? null : bg)];
  state.active = 0;
  history.undo.length = 0;
  history.redo.length = 0;
  state.dirty = false;
  cancelCrop();
  updateHistoryButtons();
  renderLayers();
  fitView();
  render();
}

/* ---------------- История ---------------- */

const history = { undo: [], redo: [] };

function historyLimit() {
  const bytes = state.w * state.h * 4 * Math.max(1, state.layers.length);
  return clamp(Math.floor(400e6 / bytes), 5, 50);
}

function snapshot() {
  return {
    w: state.w,
    h: state.h,
    active: state.active,
    layers: state.layers.map((L) => ({
      id: L.id, name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend,
      data: L.ctx.getImageData(0, 0, state.w, state.h),
    })),
  };
}

function restore(s) {
  state.w = s.w;
  state.h = s.h;
  resizeAux();
  state.layers = s.layers.map((o) => {
    const L = createLayer(o.name);
    Object.assign(L, { id: o.id, visible: o.visible, opacity: o.opacity, blend: o.blend });
    L.ctx.putImageData(o.data, 0, 0);
    return L;
  });
  state.active = clamp(s.active, 0, state.layers.length - 1);
  renderLayers();
  render();
}

function pushHistory() {
  history.undo.push(snapshot());
  const limit = historyLimit();
  while (history.undo.length > limit) history.undo.shift();
  history.redo.length = 0;
  state.dirty = true;
  updateHistoryButtons();
}

function undo() {
  if (!history.undo.length) return;
  const prevSize = [state.w, state.h];
  history.redo.push(snapshot());
  restore(history.undo.pop());
  if (prevSize[0] !== state.w || prevSize[1] !== state.h) fitView();
  updateHistoryButtons();
}

function redo() {
  if (!history.redo.length) return;
  const prevSize = [state.w, state.h];
  history.undo.push(snapshot());
  restore(history.redo.pop());
  if (prevSize[0] !== state.w || prevSize[1] !== state.h) fitView();
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('#undoBtn').disabled = !history.undo.length;
  $('#redoBtn').disabled = !history.redo.length;
}

/* ---------------- Отрисовка ---------------- */

const stroke = { preview: false, alpha: 1, op: 'source-over' };
let crop = null; // {x, y, w, h}

function render() {
  vctx.globalAlpha = 1;
  vctx.globalCompositeOperation = 'source-over';
  vctx.clearRect(0, 0, state.w, state.h);

  state.layers.forEach((L, i) => {
    if (!L.visible) return;
    let src = L.canvas;
    if (i === state.active && stroke.preview) {
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, state.w, state.h);
      sctx.drawImage(L.canvas, 0, 0);
      sctx.globalAlpha = stroke.alpha;
      sctx.globalCompositeOperation = stroke.op;
      sctx.drawImage(temp, 0, 0);
      src = scratch;
    }
    vctx.globalAlpha = L.opacity;
    vctx.globalCompositeOperation = L.blend;
    vctx.drawImage(src, L.dx, L.dy);
  });
  vctx.globalAlpha = 1;
  vctx.globalCompositeOperation = 'source-over';

  if (crop) drawCropOverlay();
}

function drawCropOverlay() {
  const { x, y, w, h } = crop;
  vctx.save();
  vctx.fillStyle = 'rgba(0,0,0,.55)';
  vctx.beginPath();
  vctx.rect(0, 0, state.w, state.h);
  vctx.rect(x, y, w, h);
  vctx.fill('evenodd');
  const lw = 1 / state.zoom;
  vctx.lineWidth = lw;
  vctx.strokeStyle = '#fff';
  vctx.setLineDash([6 * lw, 4 * lw]);
  vctx.strokeRect(x, y, w, h);
  vctx.setLineDash([]);
  vctx.strokeStyle = 'rgba(255,255,255,.35)';
  vctx.beginPath();
  for (let k = 1; k < 3; k++) {
    vctx.moveTo(x + (w * k) / 3, y);
    vctx.lineTo(x + (w * k) / 3, y + h);
    vctx.moveTo(x, y + (h * k) / 3);
    vctx.lineTo(x + w, y + (h * k) / 3);
  }
  vctx.stroke();
  vctx.restore();
}

/** Сведённое изображение без служебных оверлеев. */
function composite(bg) {
  const c = makeCanvas(state.w, state.h);
  const ctx = c.getContext('2d');
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  for (const L of state.layers) {
    if (!L.visible) continue;
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = L.blend;
    ctx.drawImage(L.canvas, 0, 0);
  }
  return c;
}

/* ---------------- Панель слоёв ---------------- */

function renderLayers() {
  const ul = $('#layers');
  ul.innerHTML = '';
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const L = state.layers[i];
    const li = document.createElement('li');
    li.className = (i === state.active ? 'active ' : '') + (L.visible ? '' : 'hidden-layer');

    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.title = L.visible ? 'Скрыть' : 'Показать';
    eye.textContent = L.visible ? '👁' : '·';
    eye.onclick = (e) => {
      e.stopPropagation();
      pushHistory();
      L.visible = !L.visible;
      renderLayers();
      render();
    };

    const thumb = makeCanvas(88, 64);
    thumb.dataset.layer = L.id;

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = L.name;
    name.ondblclick = (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.value = L.name;
      name.replaceChildren(input);
      input.focus();
      input.select();
      const done = (save) => {
        if (save && input.value.trim() && input.value !== L.name) {
          pushHistory();
          L.name = input.value.trim();
        }
        renderLayers();
      };
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') done(true);
        if (ev.key === 'Escape') done(false);
        ev.stopPropagation();
      };
      input.onblur = () => done(true);
    };

    li.append(eye, thumb, name);
    li.onclick = () => {
      state.active = i;
      renderLayers();
    };
    ul.appendChild(li);
  }
  const L = activeLayer();
  $('#blendMode').value = L.blend;
  $('#layerOpacity').value = Math.round(L.opacity * 100);
  $('#layerOpacityOut').textContent = Math.round(L.opacity * 100) + '%';
  updateThumbs();
}

function updateThumbs() {
  for (const t of $$('#layers canvas')) {
    const L = state.layers.find((l) => l.id === Number(t.dataset.layer));
    if (!L) continue;
    const ctx = t.getContext('2d');
    ctx.clearRect(0, 0, t.width, t.height);
    const k = Math.min(t.width / state.w, t.height / state.h);
    const w = state.w * k, h = state.h * k;
    ctx.drawImage(L.canvas, (t.width - w) / 2, (t.height - h) / 2, w, h);
  }
}

$('#blendMode').addEventListener('change', (e) => {
  pushHistory();
  activeLayer().blend = e.target.value;
  render();
});
$('#layerOpacity').addEventListener('pointerdown', () => pushHistory());
$('#layerOpacity').addEventListener('input', (e) => {
  activeLayer().opacity = e.target.value / 100;
  $('#layerOpacityOut').textContent = e.target.value + '%';
  render();
});

/* ---------------- Вид / масштаб ---------------- */

function applyTransform() {
  stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  view.style.imageRendering = state.zoom >= 2 ? 'pixelated' : 'auto';
  $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
  updateBrushCursorSize();
}

function fitView() {
  const r = viewport.getBoundingClientRect();
  state.zoom = Math.min(1, (r.width - 48) / state.w, (r.height - 48) / state.h);
  if (!(state.zoom > 0)) state.zoom = 1;
  state.panX = (r.width - state.w * state.zoom) / 2;
  state.panY = (r.height - state.h * state.zoom) / 2;
  applyTransform();
  if (crop) render();
}

function zoomAt(factor, cx, cy) {
  const r = viewport.getBoundingClientRect();
  if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
  const nz = clamp(state.zoom * factor, 0.05, 32);
  state.panX = cx - ((cx - state.panX) * nz) / state.zoom;
  state.panY = cy - ((cy - state.panY) * nz) / state.zoom;
  state.zoom = nz;
  applyTransform();
  if (crop) render();
}

function setZoom(z) {
  zoomAt(z / state.zoom);
}

viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

window.addEventListener('resize', () => applyTransform());

/* ---------------- Курсор кисти ---------------- */

function updateBrushCursorSize() {
  const d = Math.max(4, state.size * state.zoom);
  brushCursor.style.width = brushCursor.style.height = d + 'px';
}

function updateCursor() {
  const t = spaceDown ? 'hand' : state.tool;
  viewport.dataset.cursor = drag && drag.type === 'pan' ? 'grabbing' : TOOL_CURSORS[t];
  if (t !== 'brush' && t !== 'eraser') brushCursor.style.display = 'none';
}

/* ---------------- Инструменты ---------------- */

function setTool(tool) {
  if (state.tool === 'crop' && tool !== 'crop') cancelCrop();
  state.tool = tool;
  for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  $('#optToolName').textContent = TOOL_NAMES[tool];
  for (const el of $$('.optionsbar [data-for]')) {
    el.hidden = !el.dataset.for.split(' ').includes(tool);
  }
  $('#toolHint').textContent = TOOL_HINTS[tool] || '';
  updateCursor();
}

for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));

function bindRange(id, out, fmt, apply) {
  const input = $(id);
  const o = $(out);
  const sync = () => {
    apply(Number(input.value));
    o.textContent = fmt(input.value);
  };
  input.addEventListener('input', sync);
  sync();
  return (v) => { input.value = v; sync(); };
}

const setSize = bindRange('#size', '#sizeOut', (v) => v, (v) => { state.size = v; updateBrushCursorSize(); });
bindRange('#opacity', '#opacityOut', (v) => v + '%', (v) => (state.opacity = v / 100));
bindRange('#tolerance', '#toleranceOut', (v) => v, (v) => (state.tolerance = v));
$('#shapeFill').addEventListener('change', (e) => (state.shapeFill = e.target.checked));
$('#font').addEventListener('change', (e) => (state.font = e.target.value));
$('#fontSize').addEventListener('input', (e) => (state.fontSize = clamp(Number(e.target.value) || 48, 4, 999)));
$('#fontBold').addEventListener('change', (e) => (state.fontBold = e.target.checked));

/* ---------------- Цвета ---------------- */

function setPrimary(c) {
  state.primary = c;
  $('#primarySwatch').style.background = c;
  $('#primaryInput').value = c;
}
function setSecondary(c) {
  state.secondary = c;
  $('#secondarySwatch').style.background = c;
  $('#secondaryInput').value = c;
}
$('#primarySwatch').onclick = () => $('#primaryInput').click();
$('#secondarySwatch').onclick = () => $('#secondaryInput').click();
$('#primaryInput').oninput = (e) => setPrimary(e.target.value);
$('#secondaryInput').oninput = (e) => setSecondary(e.target.value);
const swapColors = () => { const p = state.primary; setPrimary(state.secondary); setSecondary(p); };
const resetColors = () => { setPrimary('#000000'); setSecondary('#ffffff'); };
$('#swapColors').onclick = swapColors;
$('#resetColors').onclick = resetColors;

for (const c of PALETTE) {
  const b = document.createElement('button');
  b.style.background = c;
  b.title = c + ' (клик — основной, правый клик — фоновый)';
  b.onclick = () => setPrimary(c);
  b.oncontextmenu = (e) => { e.preventDefault(); setSecondary(c); };
  $('#palette').appendChild(b);
}

/* ---------------- Указатель ---------------- */

let drag = null;
let spaceDown = false;

function docPoint(e) {
  const r = view.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * state.w) / r.width,
    y: ((e.clientY - r.top) * state.h) / r.height,
  };
}

function ensureEditable() {
  const L = activeLayer();
  if (!L.visible) {
    status('Активный слой скрыт — включите его видимость.');
    return false;
  }
  return true;
}

function setupStrokeCtx(ctx) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = state.size;
  ctx.strokeStyle = state.primary;
  ctx.fillStyle = state.primary;
}

viewport.addEventListener('pointerdown', (e) => {
  if (drag) return;
  const tool = spaceDown ? 'hand' : state.tool;

  if (e.button === 1 || tool === 'hand') {
    e.preventDefault();
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, px: state.panX, py: state.panY };
    viewport.setPointerCapture(e.pointerId);
    updateCursor();
    return;
  }
  if (e.button !== 0) return;
  const p = docPoint(e);

  switch (tool) {
    case 'brush':
    case 'eraser': {
      if (!ensureEditable()) return;
      pushHistory();
      tctx.clearRect(0, 0, state.w, state.h);
      setupStrokeCtx(tctx);
      tctx.strokeStyle = tctx.fillStyle = tool === 'eraser' ? '#000' : state.primary;
      tctx.beginPath();
      tctx.arc(p.x, p.y, state.size / 2, 0, Math.PI * 2);
      tctx.fill();
      Object.assign(stroke, { preview: true, alpha: state.opacity, op: tool === 'eraser' ? 'destination-out' : 'source-over' });
      drag = { type: 'paint', last: p };
      render();
      break;
    }
    case 'line':
    case 'rect':
    case 'ellipse':
      if (!ensureEditable()) return;
      Object.assign(stroke, { preview: true, alpha: state.opacity, op: 'source-over' });
      drag = { type: 'shape', shape: tool, start: p };
      break;
    case 'fill':
      if (!ensureEditable()) return;
      if (p.x < 0 || p.y < 0 || p.x >= state.w || p.y >= state.h) return;
      pushHistory();
      floodFill(activeLayer(), Math.floor(p.x), Math.floor(p.y), state.primary, state.tolerance, state.opacity);
      render();
      updateThumbs();
      return;
    case 'picker':
      pickColor(p, e.altKey);
      drag = { type: 'pick', alt: e.altKey };
      break;
    case 'text':
      if (!ensureEditable()) return;
      placeText(p);
      return;
    case 'move':
      if (!ensureEditable()) return;
      pushHistory();
      drag = { type: 'move', start: p };
      break;
    case 'crop':
      crop = { x: clamp(p.x, 0, state.w), y: clamp(p.y, 0, state.h), w: 0, h: 0 };
      drag = { type: 'crop', start: { x: crop.x, y: crop.y } };
      break;
    case 'zoom': {
      const r = viewport.getBoundingClientRect();
      zoomAt(e.altKey ? 1 / 1.5 : 1.5, e.clientX - r.left, e.clientY - r.top);
      return;
    }
  }
  if (drag) viewport.setPointerCapture(e.pointerId);
});

viewport.addEventListener('pointermove', (e) => {
  const p = docPoint(e);
  const inside = p.x >= 0 && p.y >= 0 && p.x < state.w && p.y < state.h;
  $('#statusCoords').textContent = inside ? `X: ${Math.floor(p.x)}  Y: ${Math.floor(p.y)}` : '—';

  const tool = spaceDown ? 'hand' : state.tool;
  if (tool === 'brush' || tool === 'eraser') {
    const r = viewport.getBoundingClientRect();
    brushCursor.style.display = 'block';
    brushCursor.style.left = e.clientX - r.left + 'px';
    brushCursor.style.top = e.clientY - r.top + 'px';
  }

  if (!drag) return;
  switch (drag.type) {
    case 'pan':
      state.panX = drag.px + (e.clientX - drag.sx);
      state.panY = drag.py + (e.clientY - drag.sy);
      applyTransform();
      break;
    case 'paint': {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      tctx.beginPath();
      tctx.moveTo(drag.last.x, drag.last.y);
      for (const ev of events.length ? events : [e]) {
        const q = docPoint(ev);
        tctx.lineTo(q.x, q.y);
        drag.last = q;
      }
      tctx.stroke();
      render();
      break;
    }
    case 'shape':
      tctx.clearRect(0, 0, state.w, state.h);
      drawShape(tctx, drag.shape, drag.start, p, e.shiftKey);
      render();
      break;
    case 'move': {
      const L = activeLayer();
      L.dx = Math.round(p.x - drag.start.x);
      L.dy = Math.round(p.y - drag.start.y);
      render();
      break;
    }
    case 'crop': {
      const x2 = clamp(p.x, 0, state.w), y2 = clamp(p.y, 0, state.h);
      crop = {
        x: Math.min(drag.start.x, x2), y: Math.min(drag.start.y, y2),
        w: Math.abs(x2 - drag.start.x), h: Math.abs(y2 - drag.start.y),
      };
      render();
      break;
    }
    case 'pick':
      pickColor(p, drag.alt);
      break;
  }
});

viewport.addEventListener('pointerleave', () => {
  brushCursor.style.display = 'none';
  $('#statusCoords').textContent = '—';
});

function endDrag() {
  if (!drag) return;
  switch (drag.type) {
    case 'paint':
      commitTemp();
      break;
    case 'shape':
      pushHistory();
      commitTemp();
      break;
    case 'move': {
      const L = activeLayer();
      if (L.dx || L.dy) {
        bakeOffset(L, L.dx, L.dy);
      } else {
        history.undo.pop();
        updateHistoryButtons();
      }
      L.dx = L.dy = 0;
      render();
      updateThumbs();
      break;
    }
    case 'crop':
      if (crop && (crop.w < 2 || crop.h < 2)) cancelCrop();
      break;
  }
  drag = null;
  updateCursor();
}

viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

function commitTemp() {
  const L = activeLayer();
  L.ctx.save();
  L.ctx.globalAlpha = stroke.alpha;
  L.ctx.globalCompositeOperation = stroke.op;
  L.ctx.drawImage(temp, 0, 0);
  L.ctx.restore();
  stroke.preview = false;
  tctx.clearRect(0, 0, state.w, state.h);
  render();
  updateThumbs();
}

function bakeOffset(L, dx, dy) {
  const copy = makeCanvas(state.w, state.h);
  copy.getContext('2d').drawImage(L.canvas, 0, 0);
  L.ctx.clearRect(0, 0, state.w, state.h);
  L.ctx.drawImage(copy, dx, dy);
}

function drawShape(ctx, shape, a, b, constrain) {
  setupStrokeCtx(ctx);
  let dx = b.x - a.x, dy = b.y - a.y;
  if (constrain) {
    if (shape === 'line') {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      dx = Math.cos(ang) * len;
      dy = Math.sin(ang) * len;
    } else {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * s;
      dy = Math.sign(dy || 1) * s;
    }
  }
  ctx.beginPath();
  if (shape === 'line') {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x + dx, a.y + dy);
    ctx.stroke();
    return;
  }
  if (shape === 'rect') {
    ctx.lineJoin = 'miter';
    ctx.rect(a.x, a.y, dx, dy);
  } else {
    ctx.ellipse(a.x + dx / 2, a.y + dy / 2, Math.abs(dx / 2), Math.abs(dy / 2), 0, 0, Math.PI * 2);
  }
  if (state.shapeFill) ctx.fill();
  else ctx.stroke();
}

function pickColor(p, toSecondary) {
  const x = Math.floor(p.x), y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return;
  const saved = crop;
  crop = null;
  render();
  const [r, g, b, a] = vctx.getImageData(x, y, 1, 1).data;
  crop = saved;
  if (saved) render();
  if (a === 0) return;
  const hex = rgbToHex(r, g, b);
  if (toSecondary) setSecondary(hex);
  else setPrimary(hex);
}

function placeText(p) {
  openModal({
    title: 'Текст',
    fields: [{ key: 'text', label: 'Текст', type: 'textarea', value: '' }],
    okText: 'Добавить',
    onOk: ({ text }) => {
      if (!text.trim()) return;
      pushHistory();
      const L = activeLayer();
      const ctx = L.ctx;
      ctx.save();
      ctx.globalAlpha = state.opacity;
      ctx.fillStyle = state.primary;
      ctx.textBaseline = 'top';
      ctx.font = `${state.fontBold ? 'bold ' : ''}${state.fontSize}px ${state.font}`;
      text.split('\n').forEach((line, i) => ctx.fillText(line, p.x, p.y + i * state.fontSize * 1.2));
      ctx.restore();
      render();
      updateThumbs();
    },
  });
}

/* ---------------- Заливка ---------------- */

function floodFill(L, x, y, hex, tol, opacity) {
  const w = state.w, h = state.h;
  const img = L.ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const i0 = (y * w + x) * 4;
  const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], ta = d[i0 + 3];
  const [fr, fg, fb] = hexToRgb(hex);
  const fa = opacity;
  const seen = new Uint8Array(w * h);

  const match = (idx) => {
    const p = idx * 4;
    return Math.abs(d[p] - tr) <= tol && Math.abs(d[p + 1] - tg) <= tol &&
           Math.abs(d[p + 2] - tb) <= tol && Math.abs(d[p + 3] - ta) <= tol;
  };
  const paint = (idx) => {
    const p = idx * 4;
    const da = d[p + 3] / 255;
    const oa = fa + da * (1 - fa);
    if (oa <= 0) return;
    d[p] = (fr * fa + d[p] * da * (1 - fa)) / oa;
    d[p + 1] = (fg * fa + d[p + 1] * da * (1 - fa)) / oa;
    d[p + 2] = (fb * fa + d[p + 2] * da * (1 - fa)) / oa;
    d[p + 3] = oa * 255;
  };

  const stack = [y * w + x];
  while (stack.length) {
    let idx = stack.pop();
    if (seen[idx]) continue;
    let px = idx % w;
    const py = (idx - px) / w;
    while (px > 0 && !seen[idx - 1] && match(idx - 1)) { idx--; px--; }
    let up = false, down = false;
    while (px < w && !seen[idx] && match(idx)) {
      seen[idx] = 1;
      paint(idx);
      if (py > 0) {
        const u = idx - w;
        if (!seen[u] && match(u)) { if (!up) { stack.push(u); up = true; } } else up = false;
      }
      if (py < h - 1) {
        const dn = idx + w;
        if (!seen[dn] && match(dn)) { if (!down) { stack.push(dn); down = true; } } else down = false;
      }
      idx++;
      px++;
    }
  }
  L.ctx.putImageData(img, 0, 0);
}

/* ---------------- Кадрирование ---------------- */

function cancelCrop() {
  if (!crop) return;
  crop = null;
  render();
}

function applyCrop() {
  if (!crop || crop.w < 1 || crop.h < 1) return;
  const x = Math.round(crop.x), y = Math.round(crop.y);
  const w = Math.max(1, Math.round(crop.w)), h = Math.max(1, Math.round(crop.h));
  crop = null;
  pushHistory();
  transformDocument(w, h, (ctx, L) => ctx.drawImage(L.canvas, -x, -y));
  status(`Кадрировано до ${w} × ${h}`);
}

$('#cropApply').onclick = applyCrop;
$('#cropCancel').onclick = cancelCrop;

/* ---------------- Операции с документом ---------------- */

/** Пересоздаёт все слои под новый размер; draw рисует старый слой в новый контекст. */
function transformDocument(w, h, draw) {
  const oldLayers = state.layers;
  state.w = w;
  state.h = h;
  resizeAux();
  state.layers = oldLayers.map((old) => {
    const L = createLayer(old.name);
    Object.assign(L, { id: old.id, visible: old.visible, opacity: old.opacity, blend: old.blend });
    L.ctx.save();
    draw(L.ctx, old);
    L.ctx.restore();
    return L;
  });
  renderLayers();
  fitView();
  render();
}

function transformLayer(L, draw) {
  const copy = makeCanvas(state.w, state.h);
  copy.getContext('2d').drawImage(L.canvas, 0, 0);
  L.ctx.save();
  L.ctx.clearRect(0, 0, state.w, state.h);
  draw(L.ctx, copy);
  L.ctx.restore();
}

/** Попиксельный фильтр для активного слоя. */
function pixelFilter(fn) {
  if (!ensureEditable()) return;
  pushHistory();
  const L = activeLayer();
  const img = L.ctx.getImageData(0, 0, state.w, state.h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) fn(d, i);
  L.ctx.putImageData(img, 0, 0);
  render();
  updateThumbs();
}

function addImageLayer(img, name) {
  pushHistory();
  const L = createLayer(name || 'Изображение');
  const k = Math.min(1, state.w / img.width, state.h / img.height);
  const w = img.width * k, h = img.height * k;
  L.ctx.drawImage(img, (state.w - w) / 2, (state.h - h) / 2, w, h);
  state.layers.splice(state.active + 1, 0, L);
  state.active++;
  renderLayers();
  render();
}

/* ---------------- Фильтры с параметрами ---------------- */

function boxBlurChannel(src, dst, w, h, r, horizontal) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4;
  const win = r * 2 + 1;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + clamp(k, 0, len - 1) * step + c];
      for (let i = 0; i < len; i++) {
        dst[base + i * step + c] = sum / win;
        sum += src[base + Math.min(i + r + 1, len - 1) * step + c] - src[base + Math.max(i - r, 0) * step + c];
      }
    }
  }
}

function blurData(data, w, h, r) {
  // Премультипликация, чтобы прозрачные пиксели не «пачкали» края.
  const a = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const al = data[i + 3] / 255;
    a[i] = data[i] * al; a[i + 1] = data[i + 1] * al; a[i + 2] = data[i + 2] * al; a[i + 3] = data[i + 3];
  }
  const b = new Float32Array(data.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurChannel(a, b, w, h, r, true);
    boxBlurChannel(b, a, w, h, r, false);
  }
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < out.length; i += 4) {
    const al = a[i + 3] / 255;
    out[i + 3] = a[i + 3];
    if (al > 0) { out[i] = a[i] / al; out[i + 1] = a[i + 1] / al; out[i + 2] = a[i + 2] / al; }
  }
  return out;
}

const ADJUSTMENTS = {
  brightness: {
    title: 'Яркость / Контраст',
    fields: [
      { key: 'b', label: 'Яркость', min: -100, max: 100, value: 0 },
      { key: 'c', label: 'Контраст', min: -100, max: 100, value: 0 },
    ],
    apply(s, d, w, h, { b, c }) {
      const bb = b * 2.55;
      const f = (259 * (c * 2.55 + 255)) / (255 * (259 - c * 2.55));
      for (let i = 0; i < s.length; i += 4) {
        d[i] = f * (s[i] + bb - 128) + 128;
        d[i + 1] = f * (s[i + 1] + bb - 128) + 128;
        d[i + 2] = f * (s[i + 2] + bb - 128) + 128;
        d[i + 3] = s[i + 3];
      }
    },
  },
  hueSat: {
    title: 'Тон / Насыщенность',
    fields: [
      { key: 'hue', label: 'Цветовой тон', min: -180, max: 180, value: 0 },
      { key: 'sat', label: 'Насыщенность', min: -100, max: 100, value: 0 },
      { key: 'light', label: 'Яркость', min: -100, max: 100, value: 0 },
    ],
    apply(s, d, w, h, { hue, sat, light }) {
      const a = (hue * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
      // Матрица поворота тона (как у CSS hue-rotate).
      const m = [
        0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
        0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
        0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
      ];
      const sf = 1 + sat / 100;
      const lf = light * 2.55;
      for (let i = 0; i < s.length; i += 4) {
        const r = s[i], g = s[i + 1], b = s[i + 2];
        let nr = m[0] * r + m[1] * g + m[2] * b;
        let ng = m[3] * r + m[4] * g + m[5] * b;
        let nb = m[6] * r + m[7] * g + m[8] * b;
        const gray = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
        d[i] = gray + (nr - gray) * sf + lf;
        d[i + 1] = gray + (ng - gray) * sf + lf;
        d[i + 2] = gray + (nb - gray) * sf + lf;
        d[i + 3] = s[i + 3];
      }
    },
  },
  blur: {
    title: 'Размытие',
    fields: [{ key: 'r', label: 'Радиус, px', min: 0, max: 50, value: 4 }],
    apply(s, d, w, h, { r }) {
      if (r === 0) { d.set(s); return; }
      d.set(blurData(s, w, h, Math.round(r)));
    },
  },
  sharpen: {
    title: 'Резкость',
    fields: [{ key: 'amt', label: 'Сила', min: 0, max: 300, value: 80 }],
    apply(s, d, w, h, { amt }) {
      const blurred = blurData(s, w, h, 1);
      const k = amt / 100;
      for (let i = 0; i < s.length; i += 4) {
        d[i] = s[i] + (s[i] - blurred[i]) * k;
        d[i + 1] = s[i + 1] + (s[i + 1] - blurred[i + 1]) * k;
        d[i + 2] = s[i + 2] + (s[i + 2] - blurred[i + 2]) * k;
        d[i + 3] = s[i + 3];
      }
    },
  },
  noise: {
    title: 'Шум',
    fields: [
      { key: 'amt', label: 'Сила', min: 0, max: 100, value: 20 },
      { key: 'mono', label: 'Монохромный', type: 'checkbox', value: true },
    ],
    apply(s, d, w, h, { amt, mono }) {
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * amt * 2.55;
      for (let i = 0; i < s.length; i += 4) {
        const n = rnd();
        d[i] = s[i] + n;
        d[i + 1] = s[i + 1] + (mono ? n : rnd());
        d[i + 2] = s[i + 2] + (mono ? n : rnd());
        d[i + 3] = s[i + 3];
      }
    },
  },
  pixelate: {
    title: 'Пикселизация',
    fields: [{ key: 'size', label: 'Размер клетки', min: 2, max: 100, value: 10 }],
    apply(s, d, w, h, { size }) {
      for (let by = 0; by < h; by += size) {
        for (let bx = 0; bx < w; bx += size) {
          let r = 0, g = 0, b = 0, a = 0, n = 0;
          const ex = Math.min(bx + size, w), ey = Math.min(by + size, h);
          for (let y = by; y < ey; y++) {
            for (let x = bx; x < ex; x++) {
              const i = (y * w + x) * 4;
              const al = s[i + 3];
              r += s[i] * al; g += s[i + 1] * al; b += s[i + 2] * al; a += al; n++;
            }
          }
          const R = a ? r / a : 0, G = a ? g / a : 0, B = a ? b / a : 0, A = a / n;
          for (let y = by; y < ey; y++) {
            for (let x = bx; x < ex; x++) {
              const i = (y * w + x) * 4;
              d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = A;
            }
          }
        }
      }
    },
  },
  threshold: {
    title: 'Порог',
    fields: [{ key: 't', label: 'Порог', min: 0, max: 255, value: 128 }],
    apply(s, d, w, h, { t }) {
      for (let i = 0; i < s.length; i += 4) {
        const v = 0.2126 * s[i] + 0.7152 * s[i + 1] + 0.0722 * s[i + 2] >= t ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = s[i + 3];
      }
    },
  },
};

function openAdjustment(key) {
  if (!ensureEditable()) return;
  const def = ADJUSTMENTS[key];
  const L = activeLayer();
  const w = state.w, h = state.h;
  const original = L.ctx.getImageData(0, 0, w, h);
  pushHistory();
  let frame = 0;
  const preview = (values) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const out = new ImageData(w, h);
      def.apply(original.data, out.data, w, h, values);
      L.ctx.putImageData(out, 0, 0);
      render();
    });
  };
  openModal({
    title: def.title,
    fields: def.fields.map((f) => ({ type: 'range', ...f })),
    onInput: preview,
    onOk: (values) => {
      cancelAnimationFrame(frame);
      const out = new ImageData(w, h);
      def.apply(original.data, out.data, w, h, values);
      L.ctx.putImageData(out, 0, 0);
      render();
      updateThumbs();
    },
    onCancel: () => {
      cancelAnimationFrame(frame);
      L.ctx.putImageData(original, 0, 0);
      history.undo.pop();
      updateHistoryButtons();
      render();
    },
    initialPreview: true,
  });
}

/* ---------------- Модальное окно ---------------- */

let modalHandlers = null;

function openModal({ title, fields = [], html, onInput, onOk, onCancel, okText = 'OK', cancel = true, initialPreview }) {
  $('#modalTitle').textContent = title;
  const body = $('#modalBody');
  body.innerHTML = html || '';
  const inputs = {};

  for (const f of fields) {
    const row = document.createElement('label');
    row.className = 'field';
    const lab = document.createElement('span');
    lab.textContent = f.label;
    row.appendChild(lab);
    let input, out;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [v, t] of f.options) input.add(new Option(t, v, false, v === f.value));
    } else if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 3;
      input.value = f.value;
      input.style.cssText = 'grid-column: span 2; resize: vertical; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px; font: inherit; color: inherit;';
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#modalForm').requestSubmit();
      });
    } else {
      input = document.createElement('input');
      input.type = f.type || 'number';
      if (f.type === 'checkbox') input.checked = !!f.value;
      else input.value = f.value;
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      if (f.step !== undefined) input.step = f.step;
    }
    row.appendChild(input);
    if (f.type === 'range') {
      out = document.createElement('output');
      out.textContent = f.value;
      row.appendChild(out);
    } else if (f.suffix) {
      out = document.createElement('span');
      out.textContent = f.suffix;
      row.appendChild(out);
    }
    inputs[f.key] = { input, out, f };
    body.appendChild(row);
  }

  const values = () => {
    const v = {};
    for (const [k, { input, f }] of Object.entries(inputs)) {
      if (f.type === 'checkbox') v[k] = input.checked;
      else if (f.type === 'select' || f.type === 'textarea') v[k] = input.value;
      else v[k] = Number(input.value);
    }
    return v;
  };

  for (const { input, out, f } of Object.values(inputs)) {
    input.addEventListener('input', () => {
      if (out && f.type === 'range') out.textContent = input.value;
      if (onInput) onInput(values(), input);
    });
  }

  $('#modalOk').textContent = okText;
  $('#modalCancel').hidden = !cancel;
  modalHandlers = { onOk: () => onOk && onOk(values()), onCancel, inputs };
  $('#modal').hidden = false;
  const first = body.querySelector('input, select, textarea');
  if (first) first.focus();
  else $('#modalOk').focus();
  if (initialPreview && onInput) onInput(values());
  return inputs;
}

function closeModal(ok) {
  if (!modalHandlers) return;
  const h = modalHandlers;
  modalHandlers = null;
  $('#modal').hidden = true;
  if (ok) h.onOk();
  else if (h.onCancel) h.onCancel();
}

$('#modalForm').addEventListener('submit', (e) => {
  e.preventDefault();
  closeModal(true);
});
$('#modalCancel').onclick = () => closeModal(false);
$('#modal').addEventListener('pointerdown', (e) => {
  if (e.target.id === 'modal') closeModal(false);
});

/* ---------------- Действия меню ---------------- */

const SIZE_LIMIT = 8000;

const actions = {
  new() {
    openModal({
      title: 'Новый документ',
      fields: [
        { key: 'preset', label: 'Шаблон', type: 'select', value: '', options: [
          ['', '— свой размер —'], ['1920x1080', 'Full HD 1920×1080'], ['1080x1080', 'Квадрат 1080×1080'],
          ['1080x1920', 'Сторис 1080×1920'], ['1280x720', 'Превью видео 1280×720'], ['2480x3508', 'A4 300 dpi'],
        ] },
        { key: 'w', label: 'Ширина', value: state.w, min: 1, max: SIZE_LIMIT, suffix: 'px' },
        { key: 'h', label: 'Высота', value: state.h, min: 1, max: SIZE_LIMIT, suffix: 'px' },
        { key: 'bg', label: 'Фон', type: 'select', value: '#ffffff', options: [
          ['#ffffff', 'Белый'], ['transparent', 'Прозрачный'], ['secondary', 'Фоновый цвет'], ['#000000', 'Чёрный'],
        ] },
      ],
      onInput: (v, input) => {
        if (input === modalHandlers.inputs.preset.input && v.preset) {
          const [w, h] = v.preset.split('x');
          modalHandlers.inputs.w.input.value = w;
          modalHandlers.inputs.h.input.value = h;
        }
      },
      okText: 'Создать',
      onOk: ({ w, h, bg }) => {
        if (!confirmDiscard()) return;
        newDocument(clamp(Math.round(w) || 1, 1, SIZE_LIMIT), clamp(Math.round(h) || 1, 1, SIZE_LIMIT),
          bg === 'secondary' ? state.secondary : bg);
      },
    });
  },
  open() { $('#fileOpen').click(); },
  place() { $('#filePlace').click(); },
  savePng() {
    composite().toBlob((b) => download(b, 'phipiship.png'), 'image/png');
    state.dirty = false;
    status('Сохранено: phipiship.png');
  },
  saveJpg() {
    openModal({
      title: 'Экспорт JPG',
      fields: [{ key: 'q', label: 'Качество', type: 'range', min: 10, max: 100, value: 90 }],
      okText: 'Сохранить',
      onOk: ({ q }) => {
        composite(state.secondary).toBlob((b) => download(b, 'phipiship.jpg'), 'image/jpeg', q / 100);
        state.dirty = false;
        status('Прозрачные области залиты фоновым цветом.');
      },
    });
  },
  undo, redo,
  clearLayer() {
    pushHistory();
    activeLayer().ctx.clearRect(0, 0, state.w, state.h);
    render();
    updateThumbs();
  },
  fillLayer() {
    pushHistory();
    const ctx = activeLayer().ctx;
    ctx.save();
    ctx.globalAlpha = state.opacity;
    ctx.fillStyle = state.primary;
    ctx.fillRect(0, 0, state.w, state.h);
    ctx.restore();
    render();
    updateThumbs();
  },
  imageSize() {
    const ratio = state.w / state.h;
    openModal({
      title: 'Размер изображения',
      fields: [
        { key: 'w', label: 'Ширина', value: state.w, min: 1, max: SIZE_LIMIT, suffix: 'px' },
        { key: 'h', label: 'Высота', value: state.h, min: 1, max: SIZE_LIMIT, suffix: 'px' },
        { key: 'keep', label: 'Сохранять пропорции', type: 'checkbox', value: true },
      ],
      onInput: (v, input) => {
        if (!v.keep) return;
        const I = modalHandlers.inputs;
        if (input === I.w.input) I.h.input.value = Math.max(1, Math.round(v.w / ratio));
        if (input === I.h.input) I.w.input.value = Math.max(1, Math.round(v.h * ratio));
      },
      onOk: ({ w, h }) => {
        w = clamp(Math.round(w) || 1, 1, SIZE_LIMIT);
        h = clamp(Math.round(h) || 1, 1, SIZE_LIMIT);
        const ow = state.w, oh = state.h;
        pushHistory();
        transformDocument(w, h, (ctx, L) => {
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(L.canvas, 0, 0, ow, oh, 0, 0, w, h);
        });
      },
    });
  },
  canvasSize() {
    openModal({
      title: 'Размер холста',
      fields: [
        { key: 'w', label: 'Ширина', value: state.w, min: 1, max: SIZE_LIMIT, suffix: 'px' },
        { key: 'h', label: 'Высота', value: state.h, min: 1, max: SIZE_LIMIT, suffix: 'px' },
        { key: 'anchor', label: 'Привязка', type: 'select', value: 'c', options: [
          ['c', 'По центру'], ['tl', 'Слева сверху'], ['tr', 'Справа сверху'], ['bl', 'Слева снизу'], ['br', 'Справа снизу'],
        ] },
      ],
      onOk: ({ w, h, anchor }) => {
        w = clamp(Math.round(w) || 1, 1, SIZE_LIMIT);
        h = clamp(Math.round(h) || 1, 1, SIZE_LIMIT);
        const dw = w - state.w, dh = h - state.h;
        const ox = anchor === 'c' ? dw / 2 : anchor.includes('r') ? dw : 0;
        const oy = anchor === 'c' ? dh / 2 : anchor.includes('b') ? dh : 0;
        pushHistory();
        transformDocument(w, h, (ctx, L) => ctx.drawImage(L.canvas, Math.round(ox), Math.round(oy)));
      },
    });
  },
  rotCW() {
    pushHistory();
    const oh = state.h;
    transformDocument(state.h, state.w, (ctx, L) => {
      ctx.translate(oh, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(L.canvas, 0, 0);
    });
  },
  rotCCW() {
    pushHistory();
    const ow = state.w;
    transformDocument(state.h, state.w, (ctx, L) => {
      ctx.translate(0, ow);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(L.canvas, 0, 0);
    });
  },
  flipH() {
    pushHistory();
    for (const L of state.layers) transformLayer(L, (ctx, c) => { ctx.scale(-1, 1); ctx.drawImage(c, -state.w, 0); });
    render();
    updateThumbs();
  },
  flipV() {
    pushHistory();
    for (const L of state.layers) transformLayer(L, (ctx, c) => { ctx.scale(1, -1); ctx.drawImage(c, 0, -state.h); });
    render();
    updateThumbs();
  },
  flatten() {
    if (state.layers.length < 2) return;
    pushHistory();
    const c = composite();
    const L = createLayer('Фон');
    L.ctx.drawImage(c, 0, 0);
    state.layers = [L];
    state.active = 0;
    renderLayers();
    render();
  },
  layerNew() {
    pushHistory();
    state.layers.splice(state.active + 1, 0, createLayer(`Слой ${nextLayerId}`));
    state.active++;
    renderLayers();
    render();
  },
  layerDup() {
    pushHistory();
    const src = activeLayer();
    const L = createLayer(src.name + ' копия');
    Object.assign(L, { opacity: src.opacity, blend: src.blend, visible: src.visible });
    L.ctx.drawImage(src.canvas, 0, 0);
    state.layers.splice(state.active + 1, 0, L);
    state.active++;
    renderLayers();
    render();
  },
  layerDel() {
    if (state.layers.length < 2) { status('Нельзя удалить единственный слой.'); return; }
    pushHistory();
    state.layers.splice(state.active, 1);
    state.active = Math.max(0, state.active - 1);
    renderLayers();
    render();
  },
  layerUp() {
    const i = state.active;
    if (i >= state.layers.length - 1) return;
    pushHistory();
    [state.layers[i], state.layers[i + 1]] = [state.layers[i + 1], state.layers[i]];
    state.active++;
    renderLayers();
    render();
  },
  layerDown() {
    const i = state.active;
    if (i <= 0) return;
    pushHistory();
    [state.layers[i], state.layers[i - 1]] = [state.layers[i - 1], state.layers[i]];
    state.active--;
    renderLayers();
    render();
  },
  mergeDown() {
    const i = state.active;
    if (i <= 0) { status('Под этим слоем ничего нет.'); return; }
    pushHistory();
    const top = state.layers[i], below = state.layers[i - 1];
    if (top.visible) {
      below.ctx.save();
      below.ctx.globalAlpha = top.opacity;
      below.ctx.globalCompositeOperation = top.blend;
      below.ctx.drawImage(top.canvas, 0, 0);
      below.ctx.restore();
    }
    state.layers.splice(i, 1);
    state.active--;
    renderLayers();
    render();
  },
  flipLayerH() {
    pushHistory();
    transformLayer(activeLayer(), (ctx, c) => { ctx.scale(-1, 1); ctx.drawImage(c, -state.w, 0); });
    render();
    updateThumbs();
  },
  flipLayerV() {
    pushHistory();
    transformLayer(activeLayer(), (ctx, c) => { ctx.scale(1, -1); ctx.drawImage(c, 0, -state.h); });
    render();
    updateThumbs();
  },
  grayscale() {
    pixelFilter((d, i) => {
      const v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = v;
    });
  },
  invert() {
    pixelFilter((d, i) => { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; });
  },
  sepia() {
    pixelFilter((d, i) => {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      d[i] = 0.393 * r + 0.769 * g + 0.189 * b;
      d[i + 1] = 0.349 * r + 0.686 * g + 0.168 * b;
      d[i + 2] = 0.272 * r + 0.534 * g + 0.131 * b;
    });
  },
  brightness: () => openAdjustment('brightness'),
  hueSat: () => openAdjustment('hueSat'),
  blur: () => openAdjustment('blur'),
  sharpen: () => openAdjustment('sharpen'),
  noise: () => openAdjustment('noise'),
  pixelate: () => openAdjustment('pixelate'),
  threshold: () => openAdjustment('threshold'),
  zoomIn: () => zoomAt(1.25),
  zoomOut: () => zoomAt(1 / 1.25),
  fit: fitView,
  actual: () => setZoom(1),
  shortcuts() {
    const rows = [
      ['V / C', 'Перемещение / Кадрирование'], ['B / E', 'Кисть / Ластик'], ['G / I', 'Заливка / Пипетка'],
      ['T / L', 'Текст / Линия'], ['U / O', 'Прямоугольник / Эллипс'], ['H / Пробел', 'Рука'], ['Z', 'Масштаб'],
      ['[ / ]', 'Размер кисти −/+'], ['1…0', 'Непрозрачность 10…100%'], ['X / D', 'Поменять / сбросить цвета'],
      ['Shift', 'Ровные линии и пропорциональные фигуры'], ['Ctrl+Z / Ctrl+Shift+Z', 'Отменить / Повторить'],
      ['Ctrl+S', 'Сохранить PNG'], ['Ctrl+V', 'Вставить картинку как слой'], ['Колесо мыши', 'Масштаб'],
    ];
    openModal({
      title: 'Горячие клавиши',
      html: '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>',
      cancel: false,
    });
  },
  about() {
    openModal({
      title: 'О программе PhipiShip',
      html: `<p><b>PhipiShip</b> — бесплатный графический редактор, который работает прямо в браузере.
        Слои, кисти, фигуры, текст, заливка, фильтры и коррекция цвета.</p>
        <p>Все изображения обрабатываются локально на вашем устройстве и никуда не отправляются.</p>
        <p>Независимый проект с открытым исходным кодом (лицензия MIT). Не связан с другими
        производителями графических программ.</p>`,
      cancel: false,
    });
  },
};

function runAction(name) {
  const fn = actions[name];
  if (fn) fn();
}

/* ---------------- Меню ---------------- */

for (const menu of $$('.menu')) {
  menu.querySelector('.menu-title').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = menu.classList.contains('open');
    $$('.menu.open').forEach((m) => m.classList.remove('open'));
    if (!wasOpen) menu.classList.add('open');
  });
  menu.addEventListener('mouseenter', () => {
    if ($('.menu.open') && !menu.classList.contains('open')) {
      $$('.menu.open').forEach((m) => m.classList.remove('open'));
      menu.classList.add('open');
    }
  });
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  $$('.menu.open').forEach((m) => m.classList.remove('open'));
  if (btn) runAction(btn.dataset.action);
});

/* ---------------- Файлы ---------------- */

function confirmDiscard() {
  return !state.dirty || confirm('Несохранённые изменения будут потеряны. Продолжить?');
}

async function openFile(file) {
  try {
    const img = await loadImage(file);
    if (!confirmDiscard()) return;
    const w = Math.min(img.width, SIZE_LIMIT), h = Math.min(img.height, SIZE_LIMIT);
    newDocument(w, h, 'transparent');
    activeLayer().name = file.name.replace(/\.[^.]+$/, '') || 'Фон';
    activeLayer().ctx.drawImage(img, 0, 0, w, h);
    renderLayers();
    render();
  } catch (err) {
    status(err.message);
  }
}

async function placeFile(file) {
  try {
    addImageLayer(await loadImage(file), file.name.replace(/\.[^.]+$/, ''));
  } catch (err) {
    status(err.message);
  }
}

$('#fileOpen').addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('#filePlace').addEventListener('change', (e) => {
  if (e.target.files[0]) placeFile(e.target.files[0]);
  e.target.value = '';
});

viewport.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewport.classList.add('dragover');
});
viewport.addEventListener('dragleave', () => viewport.classList.remove('dragover'));
viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  viewport.classList.remove('dragover');
  for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) placeFile(f);
});

window.addEventListener('paste', (e) => {
  if (!$('#modal').hidden) return;
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) {
      placeFile(item.getAsFile());
      e.preventDefault();
      return;
    }
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});

/* ---------------- Клавиатура ---------------- */

window.addEventListener('keydown', (e) => {
  if (!$('#modal').hidden) {
    if (e.key === 'Escape') closeModal(false);
    return;
  }
  if (e.target.matches('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  if (mod) {
    const map = {
      z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'savePng', o: 'open', j: 'layerDup',
      e: 'mergeDown', i: 'invert', '0': 'fit', '1': 'actual', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut',
    };
    if (k === 'n' && e.shiftKey) { e.preventDefault(); runAction('layerNew'); return; }
    if (k === 'n' && e.altKey) { e.preventDefault(); runAction('new'); return; }
    if (map[k]) { e.preventDefault(); runAction(map[k]); }
    return;
  }

  if (e.code === 'Space') {
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; updateCursor(); }
    return;
  }
  if (e.key === 'Enter' && crop) { applyCrop(); return; }
  if (e.key === 'Escape') { cancelCrop(); $$('.menu.open').forEach((m) => m.classList.remove('open')); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); runAction('clearLayer'); return; }
  if (e.key === '[') { setSize(clamp(state.size - Math.max(1, Math.round(state.size * 0.15)), 1, 200)); return; }
  if (e.key === ']') { setSize(clamp(state.size + Math.max(1, Math.round(state.size * 0.15)), 1, 200)); return; }
  if (/^[0-9]$/.test(e.key)) {
    const v = e.key === '0' ? 100 : Number(e.key) * 10;
    $('#opacity').value = v;
    $('#opacity').dispatchEvent(new Event('input'));
    return;
  }
  if (state.tool === 'move' && e.key.startsWith('Arrow')) {
    e.preventDefault();
    if (!ensureEditable()) return;
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    pushHistory();
    bakeOffset(activeLayer(), dx, dy);
    render();
    updateThumbs();
    return;
  }
  if (k === 'x') { swapColors(); return; }
  if (k === 'd') { resetColors(); return; }
  if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceDown = false;
    updateCursor();
  }
});

/* ---------------- Старт ---------------- */

setPrimary(state.primary);
setSecondary(state.secondary);
setTool('brush');
newDocument(state.w, state.h, '#ffffff');
