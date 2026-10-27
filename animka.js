'use strict';

/* =========================================================
   Анимка — покадровая анимация (PhipiShip Флот)
   Формат .animka: JSON { format: "animka", version, app, width, height,
     fps, loop, background, onion: {prev, next, alpha}, frames: [{ png }] }
   ========================================================= */

const TOOL_NAMES = {
  brush: 'Кисть', eraser: 'Ластик', fill: 'Заливка', picker: 'Пипетка',
  line: 'Линия', rect: 'Прямоугольник', ellipse: 'Эллипс', hand: 'Рука',
};
const TOOL_HINTS = {
  picker: 'Клик — основной цвет, Alt+клик — второй.',
  hand: 'Перетащите, чтобы прокрутить холст. Колесо мыши — масштаб.',
};
const TOOL_KEYS = { b: 'brush', e: 'eraser', g: 'fill', i: 'picker', l: 'line', u: 'rect', o: 'ellipse', h: 'hand' };
const TOOL_CURSORS = {
  brush: 'none', eraser: 'none', fill: 'crosshair', picker: 'crosshair',
  line: 'crosshair', rect: 'crosshair', ellipse: 'crosshair', hand: 'grab',
};
const ANIMKA_VERSION = 1;
const SIZE_LIMIT = 4000;
const MAX_FRAMES = 500;

const state = {
  w: 800, h: 600,
  frames: [],        // [{ id, canvas, ctx }]
  cur: 0,
  fps: 8,
  loop: true,
  bg: '#ffffff',     // null — прозрачный
  onionPrev: true,
  onionNext: false,
  onionAlpha: 0.3,
  tool: 'brush',
  primary: '#1d1d1f',
  secondary: '#ffffff',
  size: 6,
  opacity: 1,
  tolerance: 32,
  shapeFill: false,
  playing: false,
  playIndex: 0,
  dirty: false,
  docName: 'animka',
};

let nextFrameId = 1;
const viewport = $('#viewport');
const stage = $('#stage');
const view = $('#view');
const vctx = view.getContext('2d', { willReadFrequently: true });
const temp = makeCanvas(1, 1);
const tctx = temp.getContext('2d');
const scratch = makeCanvas(1, 1);
const sctx = scratch.getContext('2d');
const stroke = { preview: false, alpha: 1, op: 'source-over' };

const brushCursor = document.createElement('div');
brushCursor.className = 'brush-cursor';
viewport.appendChild(brushCursor);

const vw = createView(viewport, stage, () => ({ w: state.w, h: state.h }), (v) => {
  view.style.imageRendering = v.zoom >= 2 ? 'pixelated' : 'auto';
  updateBrushCursorSize();
});

/* ---------------- Кадры ---------------- */

function createFrame() {
  const canvas = makeCanvas(state.w, state.h);
  return { id: nextFrameId++, canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
}

const curFrame = () => state.frames[state.cur];

function newAnimation(w, h, bg) {
  state.w = w;
  state.h = h;
  for (const c of [view, temp, scratch]) { c.width = w; c.height = h; }
  state.bg = bg;
  state.frames = [createFrame()];
  state.cur = 0;
  hist.undo.length = 0;
  hist.redo.length = 0;
  state.dirty = false;
  stopPlay();
  syncBgControls();
  $('#statusSize').textContent = `${w} × ${h} px`;
  updateHistoryButtons();
  renderTimeline();
  vw.fit();
  render();
}

/* ---------------- История ----------------
   px — пиксели одного кадра до изменения; st — порядок кадров. */

const hist = { undo: [], redo: [] };
const HIST_LIMIT = 60;

function pushPixels(frame = curFrame()) {
  hist.undo.push({ type: 'px', frame, data: frame.ctx.getImageData(0, 0, state.w, state.h) });
  afterPush();
}

function pushStructure() {
  hist.undo.push({ type: 'st', frames: state.frames.slice(), cur: state.cur });
  afterPush();
}

function afterPush() {
  while (hist.undo.length > HIST_LIMIT) hist.undo.shift();
  hist.redo.length = 0;
  state.dirty = true;
  updateHistoryButtons();
}

/** Применяет запись истории и возвращает обратную к ней. */
function applyEntry(e) {
  if (e.type === 'px') {
    const inv = { type: 'px', frame: e.frame, data: e.frame.ctx.getImageData(0, 0, state.w, state.h) };
    e.frame.ctx.putImageData(e.data, 0, 0);
    const i = state.frames.indexOf(e.frame);
    if (i >= 0) state.cur = i;
    return inv;
  }
  const inv = { type: 'st', frames: state.frames.slice(), cur: state.cur };
  state.frames = e.frames.slice();
  state.cur = clamp(e.cur, 0, state.frames.length - 1);
  return inv;
}

function undo() {
  const e = hist.undo.pop();
  if (!e) return;
  stopPlay();
  hist.redo.push(applyEntry(e));
  afterHistory();
}

function redo() {
  const e = hist.redo.pop();
  if (!e) return;
  stopPlay();
  hist.undo.push(applyEntry(e));
  afterHistory();
}

function afterHistory() {
  updateHistoryButtons();
  renderTimeline();
  render();
}

function updateHistoryButtons() {
  $('#undoBtn').disabled = !hist.undo.length;
  $('#redoBtn').disabled = !hist.redo.length;
}

/* ---------------- Отрисовка ---------------- */

function drawTinted(frame, color, alpha) {
  sctx.globalAlpha = 1;
  sctx.globalCompositeOperation = 'source-over';
  sctx.clearRect(0, 0, state.w, state.h);
  sctx.drawImage(frame.canvas, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = color;
  sctx.fillRect(0, 0, state.w, state.h);
  sctx.globalCompositeOperation = 'source-over';
  vctx.globalAlpha = alpha;
  vctx.drawImage(scratch, 0, 0);
  vctx.globalAlpha = 1;
}

function render() {
  vctx.globalAlpha = 1;
  vctx.globalCompositeOperation = 'source-over';
  vctx.clearRect(0, 0, state.w, state.h);
  if (state.bg) {
    vctx.fillStyle = state.bg;
    vctx.fillRect(0, 0, state.w, state.h);
  }
  if (state.playing) {
    vctx.drawImage(state.frames[state.playIndex].canvas, 0, 0);
    return;
  }
  const i = state.cur;
  if (state.onionPrev && i > 0) drawTinted(state.frames[i - 1], '#ff4d6d', state.onionAlpha);
  if (state.onionNext && i < state.frames.length - 1) drawTinted(state.frames[i + 1], '#2fbf71', state.onionAlpha * 0.8);

  const f = curFrame();
  if (stroke.preview) {
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, state.w, state.h);
    sctx.drawImage(f.canvas, 0, 0);
    sctx.globalAlpha = stroke.alpha;
    sctx.globalCompositeOperation = stroke.op;
    sctx.drawImage(temp, 0, 0);
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = 'source-over';
    vctx.drawImage(scratch, 0, 0);
  } else {
    vctx.drawImage(f.canvas, 0, 0);
  }
}

/** Кадр, сведённый с фоном, — для экспорта. */
function flatFrame(frame, bg = state.bg) {
  const c = makeCanvas(state.w, state.h);
  const ctx = c.getContext('2d');
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, state.w, state.h);
  }
  ctx.drawImage(frame.canvas, 0, 0);
  return c;
}

/* ---------------- Таймлайн ---------------- */

function renderTimeline() {
  const box = $('#frames');
  box.innerHTML = '';
  const k = 72 / state.h;
  state.frames.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'frame' + (i === state.cur ? ' active' : '');
    el.dataset.index = i;
    const c = makeCanvas(Math.max(1, Math.round(state.w * k)), 72);
    c.dataset.frame = f.id;
    el.appendChild(c);
    el.appendChild(document.createTextNode(String(i + 1)));
    el.addEventListener('click', () => selectFrame(i));
    box.appendChild(el);
  });
  const add = document.createElement('button');
  add.className = 'frame-add';
  add.title = 'Новый кадр (N)';
  add.textContent = '＋';
  add.dataset.action = 'addFrame';
  box.appendChild(add);
  updateThumbs();
  updateFrameInfo();
  const active = box.querySelector('.frame.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateThumbs(only) {
  for (const c of $$('#frames canvas')) {
    const f = state.frames.find((x) => x.id === Number(c.dataset.frame));
    if (!f || (only && f !== only)) continue;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (state.bg) {
      ctx.fillStyle = state.bg;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(f.canvas, 0, 0, c.width, c.height);
  }
}

function updateFrameInfo() {
  $('#frameInfo').textContent = `${state.cur + 1} / ${state.frames.length}`;
  const secs = state.frames.length / state.fps;
  $('#durationInfo').textContent = `${secs.toFixed(secs < 10 ? 2 : 1)} с при ${state.fps} к/с`;
}

function selectFrame(i) {
  stopPlay();
  state.cur = clamp(i, 0, state.frames.length - 1);
  for (const el of $$('#frames .frame')) el.classList.toggle('active', Number(el.dataset.index) === state.cur);
  const active = $('#frames .frame.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateFrameInfo();
  render();
}

/* ---------------- Проигрывание ---------------- */

let playTimer = 0;

function play() {
  if (state.frames.length < 2) { status('Добавьте хотя бы два кадра, чтобы что-то задвигалось.'); return; }
  state.playing = true;
  state.playIndex = state.cur;
  $('#playBtn').textContent = '■ Стоп';
  let last = performance.now();
  const tick = (now) => {
    if (!state.playing) return;
    if (now - last >= 1000 / state.fps) {
      last = now;
      let n = state.playIndex + 1;
      if (n >= state.frames.length) {
        if (!state.loop) { stopPlay(); return; }
        n = 0;
      }
      state.playIndex = n;
      for (const el of $$('#frames .frame')) el.classList.toggle('playing', Number(el.dataset.index) === n);
      render();
    }
    playTimer = requestAnimationFrame(tick);
  };
  render();
  playTimer = requestAnimationFrame(tick);
}

function stopPlay() {
  if (!state.playing) return;
  state.playing = false;
  cancelAnimationFrame(playTimer);
  $('#playBtn').textContent = '▶ Играть';
  for (const el of $$('#frames .frame')) el.classList.remove('playing');
  render();
}

/* ---------------- Инструменты ---------------- */

function setTool(tool) {
  state.tool = tool;
  for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  $('#optToolName').textContent = TOOL_NAMES[tool];
  for (const el of $$('.optionsbar [data-for]')) el.hidden = !el.dataset.for.split(' ').includes(tool);
  $('#toolHint').textContent = TOOL_HINTS[tool] || '';
  updateCursor();
}

function updateBrushCursorSize() {
  const d = Math.max(4, state.size * vw.zoom);
  brushCursor.style.width = brushCursor.style.height = d + 'px';
}

let drag = null;
let spaceDown = false;

function updateCursor() {
  const t = spaceDown ? 'hand' : state.tool;
  viewport.dataset.cursor = drag && drag.type === 'pan' ? 'grabbing' : TOOL_CURSORS[t];
  if (t !== 'brush' && t !== 'eraser') brushCursor.style.display = 'none';
}

function setPrimary(c) {
  state.primary = c;
  $('#primarySwatch').style.background = c;
  $('#primaryInput').value = c;
  brushCursor.style.setProperty('--brush-color', c);
}

function setSecondary(c) {
  state.secondary = c;
  $('#secondarySwatch').style.background = c;
  $('#secondaryInput').value = c;
}

function docPoint(e) {
  const r = view.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * state.w) / r.width, y: ((e.clientY - r.top) * state.h) / r.height };
}

function setupStrokeCtx(ctx) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = state.size;
  ctx.strokeStyle = state.primary;
  ctx.fillStyle = state.primary;
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
  if (shape === 'rect') ctx.rect(a.x, a.y, dx, dy);
  else ctx.ellipse(a.x + dx / 2, a.y + dy / 2, Math.abs(dx / 2), Math.abs(dy / 2), 0, 0, Math.PI * 2);
  if (state.shapeFill) ctx.fill();
  else ctx.stroke();
}

function commitTemp() {
  const f = curFrame();
  f.ctx.save();
  f.ctx.globalAlpha = stroke.alpha;
  f.ctx.globalCompositeOperation = stroke.op;
  f.ctx.drawImage(temp, 0, 0);
  f.ctx.restore();
  stroke.preview = false;
  tctx.clearRect(0, 0, state.w, state.h);
  render();
  updateThumbs(f);
}

function floodFill(frame, x, y, hex, tol, opacity) {
  const w = state.w, h = state.h;
  const img = frame.ctx.getImageData(0, 0, w, h);
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
  frame.ctx.putImageData(img, 0, 0);
}

function pickColor(p, toSecondary) {
  const x = Math.floor(p.x), y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return;
  const [r, g, b, a] = vctx.getImageData(x, y, 1, 1).data;
  if (a === 0) return;
  (toSecondary ? setSecondary : setPrimary)(rgbToHex(r, g, b));
}

vw.onPinchStart = () => {
  if (drag && drag.type === 'paint') {
    hist.undo.pop();
    updateHistoryButtons();
  }
  drag = null;
  stroke.preview = false;
  tctx.clearRect(0, 0, state.w, state.h);
  render();
};

viewport.addEventListener('pointerdown', (e) => {
  if (drag || vw.pinching() || vw.touches.size > 1) return;
  const tool = spaceDown ? 'hand' : state.tool;
  if (e.button === 1 || tool === 'hand') {
    e.preventDefault();
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, px: vw.panX, py: vw.panY };
    viewport.setPointerCapture(e.pointerId);
    updateCursor();
    return;
  }
  if (e.button !== 0) return;
  stopPlay();
  const p = docPoint(e);
  switch (tool) {
    case 'brush':
    case 'eraser':
      pushPixels();
      tctx.clearRect(0, 0, state.w, state.h);
      setupStrokeCtx(tctx);
      if (tool === 'eraser') tctx.strokeStyle = tctx.fillStyle = '#000';
      tctx.beginPath();
      tctx.arc(p.x, p.y, state.size / 2, 0, Math.PI * 2);
      tctx.fill();
      Object.assign(stroke, { preview: true, alpha: state.opacity, op: tool === 'eraser' ? 'destination-out' : 'source-over' });
      drag = { type: 'paint', last: p };
      render();
      break;
    case 'line':
    case 'rect':
    case 'ellipse':
      Object.assign(stroke, { preview: true, alpha: state.opacity, op: 'source-over' });
      drag = { type: 'shape', shape: tool, start: p };
      break;
    case 'fill':
      if (p.x < 0 || p.y < 0 || p.x >= state.w || p.y >= state.h) return;
      pushPixels();
      floodFill(curFrame(), Math.floor(p.x), Math.floor(p.y), state.primary, state.tolerance, state.opacity);
      render();
      updateThumbs(curFrame());
      return;
    case 'picker':
      pickColor(p, e.altKey);
      return;
  }
  if (drag) viewport.setPointerCapture(e.pointerId);
});

viewport.addEventListener('pointermove', (e) => {
  const p = docPoint(e);
  const inside = p.x >= 0 && p.y >= 0 && p.x < state.w && p.y < state.h;
  $('#statusCoords').textContent = inside ? `X: ${Math.floor(p.x)}  Y: ${Math.floor(p.y)}` : '—';
  const tool = spaceDown ? 'hand' : state.tool;
  if ((tool === 'brush' || tool === 'eraser') && e.pointerType !== 'touch') {
    const r = viewport.getBoundingClientRect();
    brushCursor.style.display = 'block';
    brushCursor.style.left = e.clientX - r.left + 'px';
    brushCursor.style.top = e.clientY - r.top + 'px';
  }
  if (!drag || vw.pinching()) return;
  switch (drag.type) {
    case 'pan':
      vw.panX = drag.px + (e.clientX - drag.sx);
      vw.panY = drag.py + (e.clientY - drag.sy);
      vw.apply();
      break;
    case 'paint': {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
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
  }
});

viewport.addEventListener('pointerleave', () => {
  brushCursor.style.display = 'none';
  $('#statusCoords').textContent = '—';
});

function endDrag() {
  if (!drag) return;
  if (drag.type === 'paint') commitTemp();
  if (drag.type === 'shape') {
    pushPixels();
    commitTemp();
  }
  drag = null;
  updateCursor();
}
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

/* ---------------- GIF ----------------
   Своя реализация: общая палитра медианным сечением + LZW. */

function medianCut(pixels, maxColors) {
  const box = (px) => {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (const v of px) {
      const r = v >> 16, g = (v >> 8) & 255, b = v & 255;
      if (r < rmin) rmin = r; if (r > rmax) rmax = r;
      if (g < gmin) gmin = g; if (g > gmax) gmax = g;
      if (b < bmin) bmin = b; if (b > bmax) bmax = b;
    }
    const ranges = [rmax - rmin, gmax - gmin, bmax - bmin];
    const ch = ranges.indexOf(Math.max(...ranges));
    return { px, ch, score: ranges[ch] * Math.sqrt(px.length) };
  };
  const boxes = [box(pixels)];
  while (boxes.length < maxColors) {
    let bi = -1, best = 0;
    boxes.forEach((b, i) => { if (b.px.length > 1 && b.score > best) { best = b.score; bi = i; } });
    if (bi < 0) break;
    const { px, ch } = boxes[bi];
    const shift = [16, 8, 0][ch];
    px.sort((a, b) => ((a >> shift) & 255) - ((b >> shift) & 255));
    const mid = px.length >> 1;
    boxes.splice(bi, 1, box(px.slice(0, mid)), box(px.slice(mid)));
  }
  return boxes.map(({ px }) => {
    let r = 0, g = 0, b = 0;
    for (const v of px) { r += v >> 16; g += (v >> 8) & 255; b += v & 255; }
    const n = px.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

function encodeGIF(images, w, h, delayCs, loop, transparent) {
  // Палитра по выборке пикселей всех кадров.
  const sample = [];
  const step = Math.max(1, Math.floor((images.length * w * h) / 60000));
  let k = 0;
  for (const img of images) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4, k++) {
      if (k % step || d[i + 3] < 128) continue;
      sample.push((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
  }
  const offset = transparent ? 1 : 0; // индекс 0 — прозрачный
  const colors = sample.length ? medianCut(sample, 256 - offset) : [[0, 0, 0]];
  const palette = new Uint8Array(768);
  colors.forEach(([r, g, b], i) => palette.set([r, g, b], (i + offset) * 3));

  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (cache[key] >= 0) return cache[key];
    let best = 0, bd = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const dd = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (dd < bd) { bd = dd; best = i; }
    }
    return (cache[key] = best + offset);
  };

  const out = [];
  const byte = (b) => out.push(b & 255);
  const word = (v) => { byte(v); byte(v >> 8); };
  const str = (s) => { for (const ch of s) byte(ch.charCodeAt(0)); };

  str('GIF89a');
  word(w); word(h);
  byte(0xf7); byte(0); byte(0);           // глобальная палитра 256 цветов
  for (const v of palette) byte(v);
  if (loop) {
    byte(0x21); byte(0xff); byte(11); str('NETSCAPE2.0');
    byte(3); byte(1); word(0); byte(0);   // бесконечный повтор
  }
  const indices = new Uint8Array(w * h);
  for (const img of images) {
    const d = img.data;
    for (let i = 0, p = 0; i < indices.length; i++, p += 4) {
      indices[i] = transparent && d[p + 3] < 128 ? 0 : nearest(d[p], d[p + 1], d[p + 2]);
    }
    // Управление кадром: задержка, прозрачность, способ смены кадра.
    byte(0x21); byte(0xf9); byte(4);
    byte(transparent ? (2 << 2) | 1 : 1 << 2);
    word(delayCs);
    byte(0); byte(0);
    byte(0x2c); word(0); word(0); word(w); word(h); byte(0);
    lzw(indices, 8, out);
  }
  byte(0x3b);
  return new Uint8Array(out);
}

function lzw(indices, minCodeSize, out) {
  out.push(minCodeSize);
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  let table = new Map();
  const bytes = [];
  let cur = 0, nbits = 0;
  const emit = (code) => {
    cur |= code << nbits;
    nbits += codeSize;
    while (nbits >= 8) { bytes.push(cur & 255); cur >>>= 8; nbits -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1;
      codeSize = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (nbits > 0) bytes.push(cur & 255);
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
}

/* ---------------- Файлы ---------------- */

function serialize() {
  return {
    format: 'animka',
    version: ANIMKA_VERSION,
    app: 'Анимка',
    width: state.w,
    height: state.h,
    fps: state.fps,
    loop: state.loop,
    background: state.bg,
    onion: { prev: state.onionPrev, next: state.onionNext, alpha: state.onionAlpha },
    frames: state.frames.map((f) => ({ png: f.canvas.toDataURL('image/png') })),
  };
}

function saveAnimka() {
  const name = state.docName + '.animka';
  const blob = new Blob([JSON.stringify(serialize())], { type: 'application/octet-stream' });
  Fleet.download(blob, name);
  Fleet.addRecent(name, 'animka', blob, Fleet.thumbOf(flatFrame(state.frames[0], state.bg || '#ffffff')));
  state.dirty = false;
  status(`⚓ Сохранено: ${name} (${state.frames.length} кадр.)`);
}

async function openAnimka(file) {
  let doc;
  try { doc = JSON.parse(await file.text()); } catch (_) { throw new Error('Файл .animka повреждён'); }
  if (!doc || doc.format !== 'animka' || !Array.isArray(doc.frames) || !doc.frames.length) {
    throw new Error('Это не файл Анимки (.animka)');
  }
  if (doc.version > ANIMKA_VERSION) throw new Error('Файл создан более новой версией Анимки — обновите страницу');
  const w = Math.round(doc.width), h = Math.round(doc.height);
  if (!(w >= 1 && h >= 1 && w <= SIZE_LIMIT && h <= SIZE_LIMIT)) throw new Error('Недопустимый размер кадра в файле');
  if (doc.frames.length > MAX_FRAMES) throw new Error(`Слишком много кадров (больше ${MAX_FRAMES})`);
  const images = await Promise.all(doc.frames.map((f) => {
    if (typeof f.png !== 'string' || !f.png.startsWith('data:image/png;base64,')) throw new Error('Повреждённый кадр в файле');
    return loadImage(f.png);
  }));
  if (!confirmDiscard()) return;
  const bg = typeof doc.background === 'string' && /^#[0-9a-f]{6}$/i.test(doc.background) ? doc.background : null;
  newAnimation(w, h, bg);
  state.frames = images.map((img) => {
    const f = createFrame();
    f.ctx.drawImage(img, 0, 0);
    return f;
  });
  state.fps = clamp(Math.round(doc.fps) || 8, 1, 60);
  state.loop = doc.loop !== false;
  if (doc.onion) {
    state.onionPrev = !!doc.onion.prev;
    state.onionNext = !!doc.onion.next;
    state.onionAlpha = clamp(Number(doc.onion.alpha) || 0.3, 0.1, 0.7);
  }
  state.docName = Fleet.baseName(file.name) || 'animka';
  syncControls();
  renderTimeline();
  render();
  Fleet.addRecent(file.name, 'animka', file, Fleet.thumbOf(flatFrame(state.frames[0], state.bg || '#ffffff')));
  status(`⚓ Открыт ${file.name}: ${state.frames.length} кадр.`);
}

function confirmDiscard() {
  return !state.dirty || confirm('Несохранённые изменения будут потеряны. Продолжить?');
}

async function openFile(file) {
  try {
    const app = Fleet.appForFile(file.name, file.type);
    if (app && app.id === 'animka') return await openAnimka(file);
    if (app && app.id === 'photo' && Fleet.extOf(file.name) !== 'photik') return await importImage(file);
    if (app) {
      if (confirmDiscard()) await Fleet.openIn(file, app.id);
      return;
    }
    status(`Не знаю такой формат: ${file.name}`);
  } catch (err) {
    status(err.message);
  }
}

async function importImage(file) {
  const img = await loadImage(file);
  if (state.frames.length >= MAX_FRAMES) { status('Достигнут предел кадров.'); return; }
  pushStructure();
  const f = createFrame();
  const k = Math.min(1, state.w / img.width, state.h / img.height);
  f.ctx.drawImage(img, (state.w - img.width * k) / 2, (state.h - img.height * k) / 2, img.width * k, img.height * k);
  state.frames.splice(state.cur + 1, 0, f);
  state.cur++;
  renderTimeline();
  render();
  status('Картинка добавлена новым кадром');
}

function syncBgControls() {
  $('#bgOn').checked = !!state.bg;
  if (state.bg) $('#bgColor').value = state.bg;
}

function syncControls() {
  $('#fps').value = state.fps;
  $('#loop').checked = state.loop;
  $('#onionPrev').checked = state.onionPrev;
  $('#onionNext').checked = state.onionNext;
  $('#onionAlpha').value = Math.round(state.onionAlpha * 100);
  syncBgControls();
  updateFrameInfo();
}

/* ---------------- Действия ---------------- */

const actions = {
  new() {
    openModal({
      title: 'Новая анимация',
      fields: [
        { key: 'preset', label: 'Шаблон', type: 'select', value: '', options: [
          ['', '— свой размер —'], ['800x600', 'Обычный 800×600'], ['1080x1080', 'Квадрат 1080×1080'],
          ['1080x1920', 'Сторис 1080×1920'], ['480x270', 'Маленький GIF 480×270'], ['64x64', 'Пиксель-арт 64×64'],
        ] },
        { key: 'w', label: 'Ширина', value: state.w, min: 1, max: SIZE_LIMIT, suffix: 'px' },
        { key: 'h', label: 'Высота', value: state.h, min: 1, max: SIZE_LIMIT, suffix: 'px' },
        { key: 'bg', label: 'Фон', type: 'select', value: '#ffffff', options: [['#ffffff', 'Белый'], ['transparent', 'Прозрачный'], ['#000000', 'Чёрный']] },
      ],
      onInput: (v, input, inputs) => {
        if (input === inputs.preset.input && v.preset) {
          const [w, h] = v.preset.split('x');
          inputs.w.input.value = w;
          inputs.h.input.value = h;
        }
      },
      okText: 'Создать',
      onOk: ({ w, h, bg }) => {
        if (!confirmDiscard()) return;
        newAnimation(clamp(Math.round(w) || 1, 1, SIZE_LIMIT), clamp(Math.round(h) || 1, 1, SIZE_LIMIT), bg === 'transparent' ? null : bg);
        state.docName = 'animka';
      },
    });
  },
  open: () => $('#fileOpen').click(),
  importFrame: () => $('#fileImport').click(),
  save: saveAnimka,
  harbor: () => { location.href = 'index.html'; },
  exportGif() {
    openModal({
      title: 'Экспорт GIF',
      fields: [
        { key: 'scale', label: 'Размер', type: 'select', value: '1', options: [['1', '100%'], ['0.5', '50%'], ['0.25', '25%'], ['2', '200%']] },
        { key: 'loop', label: 'Повторять бесконечно', type: 'checkbox', value: state.loop },
      ],
      okText: 'Сохранить GIF',
      onOk: ({ scale, loop }) => {
        status('Собираю GIF…');
        setTimeout(() => {
          const s = Number(scale);
          const w = Math.max(1, Math.round(state.w * s)), h = Math.max(1, Math.round(state.h * s));
          const c = makeCanvas(w, h);
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.imageSmoothingEnabled = s >= 1 ? s === 1 : true;
          const images = state.frames.map((f) => {
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(flatFrame(f), 0, 0, w, h);
            return ctx.getImageData(0, 0, w, h);
          });
          const bytes = encodeGIF(images, w, h, Math.max(2, Math.round(100 / state.fps)), loop, !state.bg);
          Fleet.download(new Blob([bytes], { type: 'image/gif' }), state.docName + '.gif');
          status(`🎞 GIF готов: ${state.frames.length} кадр., ${Math.round(bytes.length / 1024)} КБ`);
        }, 30);
      },
    });
  },
  exportSheet() {
    const n = state.frames.length;
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const c = makeCanvas(state.w * cols, state.h * rows);
    const ctx = c.getContext('2d');
    state.frames.forEach((f, i) => ctx.drawImage(flatFrame(f), (i % cols) * state.w, Math.floor(i / cols) * state.h));
    c.toBlob((b) => Fleet.download(b, `${state.docName}-sheet.png`), 'image/png');
    status(`Спрайт-лист ${cols}×${rows} сохранён`);
  },
  exportFrame() {
    flatFrame(curFrame()).toBlob((b) => Fleet.download(b, `${state.docName}-${state.cur + 1}.png`), 'image/png');
  },
  async toPhoto() {
    if (!confirmDiscard()) return;
    const layers = state.frames.map((f, i) => ({ name: `Кадр ${i + 1}`, canvas: f.canvas, visible: i === state.cur }));
    if (state.bg) layers.unshift({ name: 'Фон', canvas: flatFrame(createFrame(), state.bg) });
    const file = new File([Fleet.makePhotik(state.w, state.h, layers)], state.docName + '.photik');
    await Fleet.openIn(file, 'photo');
  },
  undo, redo,
  clearFrame() {
    pushPixels();
    curFrame().ctx.clearRect(0, 0, state.w, state.h);
    render();
    updateThumbs(curFrame());
  },
  addFrame() {
    if (state.frames.length >= MAX_FRAMES) { status('Достигнут предел кадров.'); return; }
    stopPlay();
    pushStructure();
    state.frames.splice(state.cur + 1, 0, createFrame());
    state.cur++;
    renderTimeline();
    render();
  },
  dupFrame() {
    if (state.frames.length >= MAX_FRAMES) { status('Достигнут предел кадров.'); return; }
    stopPlay();
    pushStructure();
    const f = createFrame();
    f.ctx.drawImage(curFrame().canvas, 0, 0);
    state.frames.splice(state.cur + 1, 0, f);
    state.cur++;
    renderTimeline();
    render();
  },
  delFrame() {
    if (state.frames.length < 2) { status('Нельзя удалить единственный кадр.'); return; }
    stopPlay();
    pushStructure();
    state.frames.splice(state.cur, 1);
    state.cur = Math.min(state.cur, state.frames.length - 1);
    renderTimeline();
    render();
  },
  moveLeft() {
    const i = state.cur;
    if (i <= 0) return;
    pushStructure();
    [state.frames[i - 1], state.frames[i]] = [state.frames[i], state.frames[i - 1]];
    state.cur--;
    renderTimeline();
    render();
  },
  moveRight() {
    const i = state.cur;
    if (i >= state.frames.length - 1) return;
    pushStructure();
    [state.frames[i + 1], state.frames[i]] = [state.frames[i], state.frames[i + 1]];
    state.cur++;
    renderTimeline();
    render();
  },
  prev: () => selectFrame(state.cur > 0 ? state.cur - 1 : state.frames.length - 1),
  next: () => selectFrame(state.cur < state.frames.length - 1 ? state.cur + 1 : 0),
  play: () => (state.playing ? stopPlay() : play()),
  toggleOnion() {
    state.onionPrev = !(state.onionPrev || state.onionNext);
    if (!state.onionPrev) state.onionNext = false;
    syncControls();
    render();
    status(state.onionPrev ? 'Калька включена' : 'Калька выключена');
  },
  zoomIn: () => vw.zoomAt(1.25),
  zoomOut: () => vw.zoomAt(1 / 1.25),
  fit: () => vw.fit(),
  shortcuts() {
    const rows = [
      ['B / E / G / I', 'Кисть / Ластик / Заливка / Пипетка'], ['L / U / O', 'Линия / Прямоугольник / Эллипс'],
      ['H / Пробел', 'Рука'], ['N', 'Новый кадр'], ['Ctrl+J', 'Дублировать кадр'], [', / .', 'Предыдущий / следующий кадр'],
      ['Enter', 'Играть / стоп'], ['K', 'Калька вкл/выкл'], ['[ / ]', 'Размер кисти'], ['X', 'Поменять цвета'],
      ['Del', 'Очистить кадр'], ['Ctrl+Z / Ctrl+Shift+Z', 'Отменить / повторить'], ['Ctrl+S', 'Сохранить .animka'],
    ];
    openModal({ title: 'Горячие клавиши', html: '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>', cancel: false });
  },
  about() {
    openModal({
      title: 'Анимка',
      html: `<p><b>Анимка</b> — покадровая анимация из набора PhipiShip Флот. Рисуйте кадр за кадром,
        включите кальку, чтобы видеть соседние кадры, и сохраните мультик в GIF.</p>
        <p>Проект хранится в формате <b>.animka</b> — его можно открыть из Гавани или любой программы флота.</p>`,
      cancel: false,
    });
  },
};

function runAction(name) {
  const fn = actions[name];
  if (fn) fn();
}

/* ---------------- Привязки ---------------- */

initModal();
initMenus(runAction);
initTooltips();
Fleet.initThemePicker();
Fleet.mountSwitcher('animka');

for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
const setSize = bindRange('#size', '#sizeOut', (v) => v, (v) => { state.size = v; updateBrushCursorSize(); });
bindRange('#opacity', '#opacityOut', (v) => v + '%', (v) => (state.opacity = v / 100));
bindRange('#tolerance', '#toleranceOut', (v) => v, (v) => (state.tolerance = v));
$('#shapeFill').addEventListener('change', (e) => (state.shapeFill = e.target.checked));

$('#primarySwatch').onclick = () => $('#primaryInput').click();
$('#secondarySwatch').onclick = () => $('#secondaryInput').click();
$('#primaryInput').oninput = (e) => setPrimary(e.target.value);
$('#secondaryInput').oninput = (e) => setSecondary(e.target.value);
$('#swapColors').onclick = () => { const p = state.primary; setPrimary(state.secondary); setSecondary(p); };
buildPalette($('#palette'), setPrimary, setSecondary);

$('#fps').addEventListener('input', (e) => {
  state.fps = clamp(Math.round(Number(e.target.value)) || 1, 1, 60);
  state.dirty = true;
  updateFrameInfo();
});
$('#loop').addEventListener('change', (e) => { state.loop = e.target.checked; state.dirty = true; });
$('#onionPrev').addEventListener('change', (e) => { state.onionPrev = e.target.checked; render(); });
$('#onionNext').addEventListener('change', (e) => { state.onionNext = e.target.checked; render(); });
$('#onionAlpha').addEventListener('input', (e) => { state.onionAlpha = e.target.value / 100; render(); });
const applyBg = () => {
  state.bg = $('#bgOn').checked ? $('#bgColor').value : null;
  state.dirty = true;
  updateThumbs();
  render();
};
$('#bgOn').addEventListener('change', applyBg);
$('#bgColor').addEventListener('input', () => { $('#bgOn').checked = true; applyBg(); });

$('#fileOpen').accept = Fleet.ACCEPT_ALL;
$('#fileOpen').addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('#fileImport').addEventListener('change', (e) => {
  if (e.target.files[0]) importImage(e.target.files[0]).catch((err) => status(err.message));
  e.target.value = '';
});

viewport.addEventListener('dragover', (e) => { e.preventDefault(); viewport.classList.add('dragover'); });
viewport.addEventListener('dragleave', () => viewport.classList.remove('dragover'));
viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  viewport.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });
window.addEventListener('resize', () => vw.apply());

window.addEventListener('keydown', (e) => {
  if (modalOpen()) {
    if (e.key === 'Escape') closeModal(false);
    return;
  }
  if (e.target.matches('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod) {
    const map = {
      z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'save', o: 'open', j: 'dupFrame',
      '0': 'fit', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut',
    };
    if (map[k]) { e.preventDefault(); runAction(map[k]); }
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; updateCursor(); }
    return;
  }
  if (e.key === 'Enter') { e.preventDefault(); runAction('play'); return; }
  if (e.key === 'Escape') { stopPlay(); closeMenus(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); runAction('clearFrame'); return; }
  if (e.key === ',' || e.key === 'ArrowLeft') { runAction('prev'); return; }
  if (e.key === '.' || e.key === 'ArrowRight') { runAction('next'); return; }
  if (e.key === '[') { setSize(clamp(state.size - Math.max(1, Math.round(state.size * 0.15)), 1, 120)); return; }
  if (e.key === ']') { setSize(clamp(state.size + Math.max(1, Math.round(state.size * 0.15)), 1, 120)); return; }
  if (k === 'n') { runAction('addFrame'); return; }
  if (k === 'k') { runAction('toggleOnion'); return; }
  if (k === 'x') { $('#swapColors').click(); return; }
  if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; updateCursor(); }
});

/* ---------------- Старт ---------------- */

setPrimary(state.primary);
setSecondary(state.secondary);
setTool('brush');
newAnimation(state.w, state.h, '#ffffff');
syncControls();
Fleet.takeHandoff().then((file) => { if (file) openFile(file); });
