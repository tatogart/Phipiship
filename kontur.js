'use strict';

/* =========================================================
   Контур — векторный редактор (PhipiShip Флот)
   Формат .kontur: JSON { format: "kontur", version, app, width, height,
     background, objects: [{ type, …геометрия, fill, stroke, sw, opacity }] }
   ========================================================= */

const SVGNS = 'http://www.w3.org/2000/svg';
const KONTUR_VERSION = 1;
const SIZE_LIMIT = 8000;

const TOOL_NAMES = {
  select: 'Выбор', rect: 'Прямоугольник', ellipse: 'Эллипс', star: 'Звезда',
  line: 'Линия', pen: 'Карандаш', text: 'Текст', hand: 'Рука',
};
const TOOL_HINTS = {
  select: 'Клик — выбрать, тяните — двигать, за маркеры — менять размер (Shift — пропорционально). Стрелки — сдвиг.',
  rect: 'Протяните мышью. Shift — квадрат. Просто клик — фигура стандартного размера.',
  ellipse: 'Протяните мышью. Shift — круг. Просто клик — фигура стандартного размера.',
  star: 'Протяните мышью. Количество лучей — на панели справа.',
  line: 'Протяните мышью. Shift — шаг 45°.',
  pen: 'Рисуйте от руки — линия станет плавной векторной кривой.',
  text: 'Кликните, где должен начинаться текст.',
  hand: 'Перетащите, чтобы прокрутить холст. Колесо мыши — масштаб.',
};
const TOOL_KEYS = { v: 'select', r: 'rect', o: 'ellipse', s: 'star', l: 'line', p: 'pen', t: 'text', h: 'hand' };
const TOOL_CURSORS = {
  select: 'default', rect: 'crosshair', ellipse: 'crosshair', star: 'crosshair',
  line: 'crosshair', pen: 'crosshair', text: 'text', hand: 'grab',
};
const TYPE_NAMES = {
  rect: 'Прямоугольник', ellipse: 'Эллипс', star: 'Звезда', line: 'Линия',
  path: 'Кривая', text: 'Текст', image: 'Картинка',
};
const FONTS = ['system-ui, sans-serif', 'Georgia, serif', 'ui-monospace, monospace', "Impact, 'Arial Black', sans-serif"];

const state = {
  w: 1000, h: 700,
  bg: '#ffffff',
  objects: [],
  selected: null,   // id
  tool: 'select',
  dirty: false,
  docName: 'kontur',
};
const defaults = {
  fill: '#ff7a59', stroke: '#12253d', sw: 3, opacity: 1, rx: 0, points: 5,
  fontSize: 64, font: FONTS[0], bold: true,
};
let nextId = 1;

const viewport = $('#viewport');
const stage = $('#stage');
const svg = $('#doc');
const gObjs = $('#objs');
const gUI = $('#ui');

const vw = createView(viewport, stage, () => ({ w: state.w, h: state.h }), () => renderUI());

/* ---------------- Геометрия ---------------- */

const sel = () => state.objects.find((o) => o.id === state.selected) || null;
const clone = (o) => JSON.parse(JSON.stringify(o));
const r2 = (v) => Math.round(v * 100) / 100;

function starPoints(o) {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2, n = clamp(Math.round(o.points || 5), 3, 40);
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const k = i % 2 ? 0.45 : 1;
    pts.push(`${r2(cx + Math.cos(a) * (o.w / 2) * k)},${r2(cy + Math.sin(a) * (o.h / 2) * k)}`);
  }
  return pts.join(' ');
}

/** Плавная кривая через точки (квадратичные сплайны по серединам отрезков). */
function pathD(pts) {
  if (!pts.length) return '';
  let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  if (pts.length === 1) return d + ' l0.01 0';
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${r2(pts[i][0])} ${r2(pts[i][1])} ${r2(mx)} ${r2(my)}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${r2(last[0])} ${r2(last[1])}`;
}

/** Упрощение линии от руки: выкидываем точки, лежащие почти на прямой. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Переносит объект из рамки a {x,y,w,h} в рамку b {x1,y1,x2,y2} (x2 < x1 — отражение). */
function mapObject(o, a, b) {
  const sx = (b.x2 - b.x1) / (a.w || 1), sy = (b.y2 - b.y1) / (a.h || 1);
  const mx = (x) => b.x1 + (x - a.x) * sx, my = (y) => b.y1 + (y - a.y) * sy;
  switch (o.type) {
    case 'rect': case 'ellipse': case 'star': case 'image': {
      const xa = mx(o.x), xb = mx(o.x + o.w), ya = my(o.y), yb = my(o.y + o.h);
      o.x = Math.min(xa, xb); o.y = Math.min(ya, yb);
      o.w = Math.max(1, Math.abs(xb - xa)); o.h = Math.max(1, Math.abs(yb - ya));
      break;
    }
    case 'line':
      o.x1 = mx(o.x1); o.y1 = my(o.y1); o.x2 = mx(o.x2); o.y2 = my(o.y2);
      break;
    case 'path':
      o.pts = o.pts.map(([x, y]) => [mx(x), my(y)]);
      break;
    case 'text':
      o.x = Math.min(b.x1, b.x2) + (o.x - a.x) * Math.abs(sx);
      o.y = Math.min(b.y1, b.y2) + (o.y - a.y) * Math.abs(sy);
      o.fontSize = clamp(o.fontSize * Math.abs(sy), 4, 2000);
      break;
  }
}

function translateObject(o, dx, dy) {
  if (o.type === 'line') { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
  else if (o.type === 'path') o.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
  else { o.x += dx; o.y += dy; }
}

/* ---------------- SVG-элементы ---------------- */

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  return el;
}

function paintAttrs(o, noFill) {
  return {
    fill: noFill ? 'none' : (o.fill || 'none'),
    stroke: o.stroke || 'none',
    'stroke-width': o.stroke ? o.sw : undefined,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    opacity: o.opacity < 1 ? o.opacity : undefined,
  };
}

/** Чистый SVG-элемент объекта (для экспорта и для холста). */
function shapeEl(o) {
  switch (o.type) {
    case 'rect':
      return svgEl('rect', { x: r2(o.x), y: r2(o.y), width: r2(o.w), height: r2(o.h), rx: o.rx || undefined, ...paintAttrs(o) });
    case 'ellipse':
      return svgEl('ellipse', { cx: r2(o.x + o.w / 2), cy: r2(o.y + o.h / 2), rx: r2(o.w / 2), ry: r2(o.h / 2), ...paintAttrs(o) });
    case 'star':
      return svgEl('polygon', { points: starPoints(o), ...paintAttrs(o) });
    case 'line':
      return svgEl('line', { x1: r2(o.x1), y1: r2(o.y1), x2: r2(o.x2), y2: r2(o.y2), ...paintAttrs(o, true) });
    case 'path':
      return svgEl('path', { d: pathD(o.pts), ...paintAttrs(o) });
    case 'image':
      return svgEl('image', {
        x: r2(o.x), y: r2(o.y), width: r2(o.w), height: r2(o.h), href: o.href,
        preserveAspectRatio: 'none', opacity: o.opacity < 1 ? o.opacity : undefined,
      });
    case 'text': {
      const t = svgEl('text', {
        x: r2(o.x), y: r2(o.y), 'font-size': r2(o.fontSize), 'font-family': o.font,
        'font-weight': o.bold ? 700 : 400, 'dominant-baseline': 'hanging', ...paintAttrs(o),
      });
      t.setAttribute('paint-order', 'stroke');
      String(o.text).split('\n').forEach((line, i) => {
        const span = svgEl('tspan', { x: r2(o.x), dy: i ? '1.2em' : undefined });
        span.textContent = line || ' ';
        t.appendChild(span);
      });
      return t;
    }
  }
  return svgEl('g', {});
}

const elById = new Map();

function render() {
  gObjs.replaceChildren();
  elById.clear();
  for (const o of state.objects) {
    const g = svgEl('g', { 'data-id': o.id });
    const vis = shapeEl(o);
    g.appendChild(vis);
    gObjs.appendChild(g);
    // Тонкие линии и текст трудно поймать мышью — добавляем невидимую зону.
    if (o.type === 'line' || (o.type === 'path' && !o.fill)) {
      const hit = vis.cloneNode(true);
      hit.setAttribute('class', 'hit');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('fill', 'none');
      hit.setAttribute('stroke-width', Math.max(o.sw || 0, 14 / vw.zoom));
      hit.removeAttribute('opacity');
      g.appendChild(hit);
    } else if (o.type === 'text') {
      const bb = vis.getBBox();
      g.insertBefore(svgEl('rect', { x: bb.x, y: bb.y, width: bb.width, height: bb.height, fill: 'transparent' }), vis);
    }
    elById.set(o.id, vis);
  }
  renderUI();
  renderObjectList();
}

function bboxOf(o) {
  const el = elById.get(o.id);
  if (!el) return { x: 0, y: 0, w: 0, h: 0 };
  const b = el.getBBox();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function renderUI() {
  gUI.replaceChildren();
  const o = sel();
  if (!o) return;
  const z = vw.zoom;
  const hs = 9 / z;
  const common = { 'vector-effect': 'non-scaling-stroke', 'stroke-width': 1.5 };
  if (o.type === 'line') {
    gUI.appendChild(svgEl('line', { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, stroke: '#3fd0c9', 'stroke-dasharray': `${4 / z} ${4 / z}`, ...common, 'pointer-events': 'none' }));
    for (const [hname, x, y] of [['p1', o.x1, o.y1], ['p2', o.x2, o.y2]]) {
      gUI.appendChild(svgEl('circle', { cx: x, cy: y, r: hs / 1.6, fill: '#fff', stroke: '#3fd0c9', 'data-handle': hname, style: 'cursor: crosshair', ...common }));
    }
    return;
  }
  const b = bboxOf(o);
  const pad = 4 / z;
  gUI.appendChild(svgEl('rect', {
    x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2,
    fill: 'none', stroke: '#3fd0c9', 'stroke-dasharray': `${5 / z} ${4 / z}`, 'pointer-events': 'none', ...common,
  }));
  const pos = {
    nw: [b.x, b.y], n: [b.x + b.w / 2, b.y], ne: [b.x + b.w, b.y], e: [b.x + b.w, b.y + b.h / 2],
    se: [b.x + b.w, b.y + b.h], s: [b.x + b.w / 2, b.y + b.h], sw: [b.x, b.y + b.h], w: [b.x, b.y + b.h / 2],
  };
  const cursors = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' };
  for (const hname of HANDLES) {
    const [x, y] = pos[hname];
    gUI.appendChild(svgEl('rect', {
      x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, rx: 2 / z, fill: '#fff', stroke: '#3fd0c9',
      'data-handle': hname, style: `cursor: ${cursors[hname]}-resize`, ...common,
    }));
  }
}

/* ---------------- Список объектов ---------------- */

function objectLabel(o) {
  if (o.type === 'text') return 'Текст: ' + String(o.text).split('\n')[0].slice(0, 24);
  return TYPE_NAMES[o.type] || o.type;
}

function renderObjectList() {
  const ul = $('#objects');
  ul.innerHTML = '';
  if (!state.objects.length) {
    ul.innerHTML = '<li style="cursor:default;color:var(--muted)">Пусто — нарисуйте что-нибудь</li>';
    return;
  }
  for (let i = state.objects.length - 1; i >= 0; i--) {
    const o = state.objects[i];
    const li = document.createElement('li');
    li.className = o.id === state.selected ? 'active' : '';
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = o.type === 'image' ? '#888' : (o.fill || 'transparent');
    sw.style.borderColor = o.stroke || 'var(--border)';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = objectLabel(o);
    li.append(sw, nm);
    li.onclick = () => select(o.id);
    ul.appendChild(li);
  }
}

/* ---------------- История ---------------- */

const hist = { undo: [], redo: [] };

const snap = () => JSON.stringify({ w: state.w, h: state.h, bg: state.bg, objects: state.objects, selected: state.selected });

function pushHistory() {
  hist.undo.push(snap());
  if (hist.undo.length > 120) hist.undo.shift();
  hist.redo.length = 0;
  state.dirty = true;
  updateHistoryButtons();
}

function restoreSnap(s) {
  const d = JSON.parse(s);
  const resized = d.w !== state.w || d.h !== state.h;
  Object.assign(state, { w: d.w, h: d.h, bg: d.bg, objects: d.objects, selected: d.selected });
  applyDocSize();
  if (resized) vw.fit();
  render();
  syncProps();
}

function undo() {
  if (!hist.undo.length) return;
  hist.redo.push(snap());
  restoreSnap(hist.undo.pop());
  updateHistoryButtons();
}

function redo() {
  if (!hist.redo.length) return;
  hist.undo.push(snap());
  restoreSnap(hist.redo.pop());
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('#undoBtn').disabled = !hist.undo.length;
  $('#redoBtn').disabled = !hist.redo.length;
}

/* ---------------- Документ ---------------- */

function applyDocSize() {
  svg.setAttribute('width', state.w);
  svg.setAttribute('height', state.h);
  svg.setAttribute('viewBox', `0 0 ${state.w} ${state.h}`);
  const bg = $('#docBg');
  bg.setAttribute('width', state.w);
  bg.setAttribute('height', state.h);
  bg.setAttribute('fill', state.bg || 'none');
  $('#statusSize').textContent = `${state.w} × ${state.h} px`;
}

function newDocument(w, h, bg) {
  Object.assign(state, { w, h, bg, objects: [], selected: null, dirty: false });
  hist.undo.length = 0;
  hist.redo.length = 0;
  updateHistoryButtons();
  applyDocSize();
  vw.fit();
  render();
  syncProps();
}

function select(id) {
  state.selected = id;
  renderUI();
  renderObjectList();
  syncProps();
}

/* ---------------- Свойства ---------------- */

let editing = false;

function syncProps() {
  const o = sel();
  const t = o || defaults;
  $('#propsTitle').textContent = o ? objectLabel(o) : 'Новые фигуры';
  $('#propsHint').hidden = !!o;
  const kind = o ? o.type : state.tool;
  for (const el of $$('#props [data-only]')) {
    const only = el.dataset.only;
    el.hidden = only === 'sel' ? !o : only !== kind;
  }
  const isImage = o && o.type === 'image';
  for (const id of ['#pFillOn', '#pFill', '#pStrokeOn', '#pStroke', '#pStrokeW']) $(id).closest('.row').hidden = isImage;
  $('#pFillOn').checked = !!t.fill;
  $('#pFill').value = t.fill || defaults.fill;
  $('#pStrokeOn').checked = !!t.stroke;
  $('#pStroke').value = t.stroke || defaults.stroke;
  $('#pStrokeW').value = t.sw ?? defaults.sw;
  $('#pOpacity').value = Math.round((t.opacity ?? 1) * 100);
  $('#pRadius').value = t.rx ?? 0;
  $('#pPoints').value = t.points ?? defaults.points;
  $('#pFontSize').value = Math.round(t.fontSize ?? defaults.fontSize);
  $('#pBold').checked = t.bold ?? defaults.bold;
  $('#pFont').value = t.font || defaults.font;
  $('#pText').value = o && o.type === 'text' ? o.text : '';
  if (o) {
    const b = o.type === 'line' ? { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) } : bboxOf(o);
    $('#pX').value = Math.round(b.x);
    $('#pY').value = Math.round(b.y);
    $('#pW').value = Math.round(b.w);
    $('#pH').value = Math.round(b.h);
  }
}

function editProp(fn) {
  const o = sel();
  if (o) {
    if (!editing) { pushHistory(); editing = true; }
    fn(o);
    render();
  } else {
    fn(defaults);
  }
}

function bindProp(id, ev, fn) {
  const el = $(id);
  el.addEventListener(ev, () => editProp((t) => fn(t, el)));
  el.addEventListener('change', () => { editing = false; syncProps(); });
}

bindProp('#pFillOn', 'change', (t, el) => { t.fill = el.checked ? $('#pFill').value : null; });
bindProp('#pFill', 'input', (t, el) => { t.fill = el.value; $('#pFillOn').checked = true; });
bindProp('#pStrokeOn', 'change', (t, el) => { t.stroke = el.checked ? $('#pStroke').value : null; });
bindProp('#pStroke', 'input', (t, el) => { t.stroke = el.value; $('#pStrokeOn').checked = true; });
bindProp('#pStrokeW', 'input', (t, el) => { t.sw = clamp(Number(el.value) || 0, 0, 200); });
bindProp('#pOpacity', 'input', (t, el) => { t.opacity = clamp(el.value / 100, 0, 1); });
bindProp('#pRadius', 'input', (t, el) => { t.rx = clamp(Number(el.value) || 0, 0, 1000); });
bindProp('#pPoints', 'input', (t, el) => { t.points = clamp(Math.round(Number(el.value)) || 5, 3, 40); });
bindProp('#pFontSize', 'input', (t, el) => { t.fontSize = clamp(Number(el.value) || 12, 4, 2000); });
bindProp('#pBold', 'change', (t, el) => { t.bold = el.checked; });
bindProp('#pFont', 'change', (t, el) => { t.font = el.value; });
bindProp('#pText', 'input', (t, el) => { if (t.type === 'text') t.text = el.value || ' '; });
for (const id of ['#pX', '#pY', '#pW', '#pH']) {
  bindProp(id, 'input', (o) => {
    if (o === defaults) return;
    const b = o.type === 'line'
      ? { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1) || 1, h: Math.abs(o.y2 - o.y1) || 1 }
      : bboxOf(o);
    const x = Number($('#pX').value), y = Number($('#pY').value);
    const w = Math.max(1, Number($('#pW').value)), h = Math.max(1, Number($('#pH').value));
    mapObject(o, b, { x1: x, y1: y, x2: x + w, y2: y + h });
  });
}

/* ---------------- Указатель ---------------- */

let drag = null;
let spaceDown = false;

function docPoint(e) {
  const r = svg.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * state.w) / r.width, y: ((e.clientY - r.top) * state.h) / r.height };
}

function updateCursor() {
  const t = spaceDown ? 'hand' : state.tool;
  viewport.dataset.cursor = drag && drag.type === 'pan' ? 'grabbing' : TOOL_CURSORS[t];
}

function setTool(tool) {
  state.tool = tool;
  for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  $('#optToolName').textContent = TOOL_NAMES[tool];
  $('#toolHint').textContent = TOOL_HINTS[tool] || '';
  updateCursor();
  syncProps();
}

function newObject(type, extra) {
  const o = {
    id: nextId++, type,
    fill: defaults.fill, stroke: defaults.stroke, sw: defaults.sw, opacity: defaults.opacity, ...extra,
  };
  if (type === 'rect') o.rx = defaults.rx;
  if (type === 'star') o.points = defaults.points;
  if (type === 'line' || type === 'path') {
    o.fill = null;
    o.stroke = defaults.stroke || defaults.fill || '#000000';
    o.sw = Math.max(1, defaults.sw);
  }
  if (type === 'text') Object.assign(o, { fontSize: defaults.fontSize, font: defaults.font, bold: defaults.bold });
  return o;
}

function finishCreate(o) {
  state.selected = o.id;
  render();
  syncProps();
}

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
  const p = docPoint(e);

  if (tool === 'select') {
    const handle = e.target.closest && e.target.closest('[data-handle]');
    const o = sel();
    if (handle && o) {
      pushHistory();
      drag = { type: 'resize', handle: handle.dataset.handle, bb: bboxOf(o), orig: clone(o), start: p, moved: false };
    } else {
      const g = e.target.closest && e.target.closest('#objs [data-id]');
      if (g) {
        select(Number(g.dataset.id));
        pushHistory();
        drag = { type: 'move', orig: clone(sel()), start: p, moved: false };
      } else {
        select(null);
        return;
      }
    }
  } else if (tool === 'rect' || tool === 'ellipse' || tool === 'star') {
    pushHistory();
    const o = newObject(tool, { x: p.x, y: p.y, w: 0, h: 0 });
    state.objects.push(o);
    drag = { type: 'create', o, start: p };
    finishCreate(o);
  } else if (tool === 'line') {
    pushHistory();
    const o = newObject('line', { x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    state.objects.push(o);
    drag = { type: 'line', o, start: p };
    finishCreate(o);
  } else if (tool === 'pen') {
    pushHistory();
    const o = newObject('path', { pts: [[p.x, p.y]] });
    state.objects.push(o);
    drag = { type: 'pen', o };
    finishCreate(o);
  } else if (tool === 'text') {
    openModal({
      title: 'Текст',
      fields: [{ key: 'text', label: 'Текст', type: 'textarea', value: '' }],
      okText: 'Добавить',
      onOk: ({ text }) => {
        if (!text.trim()) return;
        pushHistory();
        const o = newObject('text', { x: p.x, y: p.y, text });
        state.objects.push(o);
        finishCreate(o);
        setTool('select');
      },
    });
    return;
  }
  if (drag) viewport.setPointerCapture(e.pointerId);
});

viewport.addEventListener('pointermove', (e) => {
  const p = docPoint(e);
  const inside = p.x >= 0 && p.y >= 0 && p.x < state.w && p.y < state.h;
  $('#statusCoords').textContent = inside ? `X: ${Math.round(p.x)}  Y: ${Math.round(p.y)}` : '—';
  if (!drag || vw.pinching()) return;
  switch (drag.type) {
    case 'pan':
      vw.panX = drag.px + (e.clientX - drag.sx);
      vw.panY = drag.py + (e.clientY - drag.sy);
      vw.apply();
      break;
    case 'move': {
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const o = sel();
      const fresh = clone(drag.orig);
      translateObject(fresh, dx, dy);
      Object.assign(o, fresh);
      drag.moved = drag.moved || Math.hypot(dx, dy) > 0;
      render();
      break;
    }
    case 'resize': {
      const o = sel();
      const fresh = clone(drag.orig);
      if (drag.handle === 'p1' || drag.handle === 'p2') {
        const k = drag.handle === 'p1' ? ['x1', 'y1'] : ['x2', 'y2'];
        fresh[k[0]] = p.x;
        fresh[k[1]] = p.y;
      } else {
        const b = drag.bb, hd = drag.handle;
        let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
        if (hd.includes('w')) x1 = p.x;
        if (hd.includes('e')) x2 = p.x;
        if (hd.includes('n')) y1 = p.y;
        if (hd.includes('s')) y2 = p.y;
        if ((e.shiftKey || o.type === 'text') && hd.length === 2 && b.w && b.h) {
          // Пропорционально — по большему из смещений.
          const k = Math.max(Math.abs(x2 - x1) / b.w, Math.abs(y2 - y1) / b.h);
          const sxn = Math.sign(x2 - x1) || 1, syn = Math.sign(y2 - y1) || 1;
          if (hd.includes('w')) x1 = x2 - sxn * b.w * k; else x2 = x1 + sxn * b.w * k;
          if (hd.includes('n')) y1 = y2 - syn * b.h * k; else y2 = y1 + syn * b.h * k;
        }
        if (o.type === 'text' && hd.length === 1) break; // текст тянем только за углы
        mapObject(fresh, b, { x1, y1, x2, y2 });
      }
      Object.assign(o, fresh);
      drag.moved = true;
      render();
      break;
    }
    case 'create': {
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (e.shiftKey) {
        const s = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * s;
        dy = Math.sign(dy || 1) * s;
      }
      Object.assign(drag.o, {
        x: Math.min(drag.start.x, drag.start.x + dx), y: Math.min(drag.start.y, drag.start.y + dy),
        w: Math.abs(dx), h: Math.abs(dy),
      });
      render();
      break;
    }
    case 'line': {
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (e.shiftKey) {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        dx = Math.cos(ang) * len;
        dy = Math.sin(ang) * len;
      }
      drag.o.x2 = drag.start.x + dx;
      drag.o.y2 = drag.start.y + dy;
      render();
      break;
    }
    case 'pen': {
      const pts = drag.o.pts;
      const last = pts[pts.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) >= 1.5 / vw.zoom) {
        pts.push([p.x, p.y]);
        render();
      }
      break;
    }
  }
});

function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if ((d.type === 'move' || d.type === 'resize') && !d.moved) {
    hist.undo.pop();
    updateHistoryButtons();
  }
  if (d.type === 'create' && (d.o.w < 3 || d.o.h < 3)) {
    // Просто клик — фигура стандартного размера.
    Object.assign(d.o, { x: d.start.x - 60, y: d.start.y - 60, w: 120, h: 120 });
  }
  if (d.type === 'line' && Math.hypot(d.o.x2 - d.o.x1, d.o.y2 - d.o.y1) < 2) {
    state.objects.pop();
    state.selected = null;
    hist.undo.pop();
    updateHistoryButtons();
  }
  if (d.type === 'pen') {
    if (d.o.pts.length < 2) {
      state.objects.pop();
      state.selected = null;
      hist.undo.pop();
      updateHistoryButtons();
    } else {
      d.o.pts = simplify(d.o.pts, 0.8 / vw.zoom).map(([x, y]) => [r2(x), r2(y)]);
    }
  }
  render();
  syncProps();
  updateCursor();
}
viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);
viewport.addEventListener('pointerleave', () => { $('#statusCoords').textContent = '—'; });

/* ---------------- Экспорт ---------------- */

function toSVGString({ background = true } = {}) {
  const root = svgEl('svg', { xmlns: SVGNS, width: state.w, height: state.h, viewBox: `0 0 ${state.w} ${state.h}` });
  if (background && state.bg) root.appendChild(svgEl('rect', { width: state.w, height: state.h, fill: state.bg }));
  for (const o of state.objects) root.appendChild(shapeEl(o));
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root);
}

async function rasterize(scale = 1, background = true) {
  const blob = new Blob([toSVGString({ background })], { type: 'image/svg+xml' });
  const img = await loadImage(blob);
  const c = makeCanvas(Math.max(1, Math.round(state.w * scale)), Math.max(1, Math.round(state.h * scale)));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/* ---------------- Файлы ---------------- */

function serialize() {
  return {
    format: 'kontur', version: KONTUR_VERSION, app: 'Контур',
    width: state.w, height: state.h, background: state.bg,
    objects: state.objects.map(({ id, ...rest }) => rest),
  };
}

async function saveKontur() {
  const name = state.docName + '.kontur';
  const blob = new Blob([JSON.stringify(serialize())], { type: 'application/octet-stream' });
  Fleet.download(blob, name);
  state.dirty = false;
  status(`⚓ Сохранено: ${name} (${state.objects.length} объект.)`);
  try { Fleet.addRecent(name, 'kontur', blob, Fleet.thumbOf(await rasterize(Math.min(1, 480 / Math.max(state.w, state.h))))); } catch (_) { /* без превью */ }
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const color = (v) => (typeof v === 'string' && COLOR_RE.test(v) ? v : null);

/** Проверка и очистка объекта из файла: только известные поля и типы. */
function sanitizeObject(src) {
  if (!src || !TYPE_NAMES[src.type]) return null;
  const o = {
    id: nextId++, type: src.type, fill: color(src.fill), stroke: color(src.stroke),
    sw: clamp(num(src.sw, 1), 0, 200), opacity: clamp(num(src.opacity, 1), 0, 1),
  };
  switch (src.type) {
    case 'rect': case 'ellipse': case 'star': case 'image':
      Object.assign(o, { x: num(src.x), y: num(src.y), w: Math.max(1, num(src.w, 1)), h: Math.max(1, num(src.h, 1)) });
      if (src.type === 'rect') o.rx = clamp(num(src.rx), 0, 1000);
      if (src.type === 'star') o.points = clamp(Math.round(num(src.points, 5)), 3, 40);
      if (src.type === 'image') {
        if (typeof src.href !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(src.href)) return null;
        o.href = src.href;
      }
      break;
    case 'line':
      Object.assign(o, { x1: num(src.x1), y1: num(src.y1), x2: num(src.x2), y2: num(src.y2) });
      break;
    case 'path':
      if (!Array.isArray(src.pts) || src.pts.length < 2) return null;
      o.pts = src.pts.slice(0, 20000).map((p) => [num(p && p[0]), num(p && p[1])]);
      break;
    case 'text':
      Object.assign(o, {
        x: num(src.x), y: num(src.y), text: String(src.text ?? '').slice(0, 5000) || ' ',
        fontSize: clamp(num(src.fontSize, 32), 4, 2000), font: FONTS.includes(src.font) ? src.font : FONTS[0], bold: !!src.bold,
      });
      break;
  }
  return o;
}

async function openKontur(file) {
  let doc;
  try { doc = JSON.parse(await file.text()); } catch (_) { throw new Error('Файл .kontur повреждён'); }
  if (!doc || doc.format !== 'kontur' || !Array.isArray(doc.objects)) throw new Error('Это не файл Контура (.kontur)');
  if (doc.version > KONTUR_VERSION) throw new Error('Файл создан более новой версией Контура — обновите страницу');
  const w = Math.round(doc.width), h = Math.round(doc.height);
  if (!(w >= 1 && h >= 1 && w <= SIZE_LIMIT && h <= SIZE_LIMIT)) throw new Error('Недопустимый размер документа');
  if (!confirmDiscard()) return;
  newDocument(w, h, color(doc.background));
  state.objects = doc.objects.map(sanitizeObject).filter(Boolean);
  state.docName = Fleet.baseName(file.name) || 'kontur';
  render();
  status(`⚓ Открыт ${file.name}: ${state.objects.length} объект.`);
  try { Fleet.addRecent(file.name, 'kontur', file, Fleet.thumbOf(await rasterize(Math.min(1, 480 / Math.max(w, h))))); } catch (_) { /* без превью */ }
}

function confirmDiscard() {
  return !state.dirty || confirm('Несохранённые изменения будут потеряны. Продолжить?');
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Не удалось прочитать файл'));
    fr.readAsDataURL(file);
  });
}

async function placeImage(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { status('Поддерживаются PNG, JPG, GIF и WebP.'); return; }
  const href = await readDataUrl(file);
  const img = await loadImage(href);
  const k = Math.min(1, (state.w * 0.8) / img.width, (state.h * 0.8) / img.height);
  const w = img.width * k, h = img.height * k;
  pushHistory();
  const o = { id: nextId++, type: 'image', x: (state.w - w) / 2, y: (state.h - h) / 2, w, h, href, fill: null, stroke: null, sw: 0, opacity: 1 };
  state.objects.push(o);
  setTool('select');
  finishCreate(o);
}

async function openFile(file) {
  try {
    const app = Fleet.appForFile(file.name, file.type);
    if (app && app.id === 'kontur') return await openKontur(file);
    if (app && app.id === 'photo' && Fleet.extOf(file.name) !== 'photik') return await placeImage(file);
    if (app) {
      if (confirmDiscard()) await Fleet.openIn(file, app.id);
      return;
    }
    status(`Не знаю такой формат: ${file.name}`);
  } catch (err) {
    status(err.message);
  }
}

/* ---------------- Действия ---------------- */

function reorder(fn) {
  const o = sel();
  if (!o) return;
  const i = state.objects.indexOf(o);
  const j = clamp(fn(i, state.objects.length), 0, state.objects.length - 1);
  if (i === j) return;
  pushHistory();
  state.objects.splice(i, 1);
  state.objects.splice(j, 0, o);
  render();
}

function flipSelected(horizontal) {
  const o = sel();
  if (!o) return;
  pushHistory();
  const b = o.type === 'line'
    ? { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1) || 1, h: Math.abs(o.y2 - o.y1) || 1 }
    : bboxOf(o);
  mapObject(o, b, horizontal
    ? { x1: b.x + b.w, y1: b.y, x2: b.x, y2: b.y + b.h }
    : { x1: b.x, y1: b.y + b.h, x2: b.x + b.w, y2: b.y });
  render();
}

const actions = {
  new() {
    openModal({
      title: 'Новый документ',
      fields: [
        { key: 'preset', label: 'Шаблон', type: 'select', value: '', options: [
          ['', '— свой размер —'], ['1000x700', 'Обычный 1000×700'], ['512x512', 'Логотип 512×512'],
          ['1920x1080', 'Full HD 1920×1080'], ['1080x1080', 'Квадрат 1080×1080'], ['1200x630', 'Обложка ссылки 1200×630'],
        ] },
        { key: 'w', label: 'Ширина', value: state.w, min: 1, max: SIZE_LIMIT, suffix: 'px' },
        { key: 'h', label: 'Высота', value: state.h, min: 1, max: SIZE_LIMIT, suffix: 'px' },
        { key: 'bg', label: 'Фон', type: 'select', value: '#ffffff', options: [['#ffffff', 'Белый'], ['transparent', 'Прозрачный'], ['#12253d', 'Тёмно-синий']] },
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
        newDocument(clamp(Math.round(w) || 1, 1, SIZE_LIMIT), clamp(Math.round(h) || 1, 1, SIZE_LIMIT), bg === 'transparent' ? null : bg);
        state.docName = 'kontur';
      },
    });
  },
  open: () => $('#fileOpen').click(),
  placeImage: () => $('#fileImage').click(),
  save: saveKontur,
  harbor: () => { location.href = 'index.html'; },
  exportSvg() {
    Fleet.download(new Blob([toSVGString()], { type: 'image/svg+xml' }), state.docName + '.svg');
    status('SVG сохранён — его открывают браузеры и любые векторные редакторы');
  },
  exportPng() {
    openModal({
      title: 'Экспорт PNG',
      fields: [{ key: 'scale', label: 'Масштаб', type: 'select', value: '1', options: [['1', '1× (как есть)'], ['2', '2× (чётче)'], ['4', '4×'], ['0.5', '0.5×']] }],
      okText: 'Сохранить',
      onOk: async ({ scale }) => {
        const c = await rasterize(Number(scale));
        c.toBlob((b) => Fleet.download(b, state.docName + '.png'), 'image/png');
      },
    });
  },
  async toPhoto() {
    if (!confirmDiscard()) return;
    const layers = [];
    if (state.bg) {
      const bg = makeCanvas(state.w, state.h);
      const ctx = bg.getContext('2d');
      ctx.fillStyle = state.bg;
      ctx.fillRect(0, 0, state.w, state.h);
      layers.push({ name: 'Фон', canvas: bg });
    }
    layers.push({ name: 'Контур', canvas: await rasterize(1, false) });
    await Fleet.openIn(new File([Fleet.makePhotik(state.w, state.h, layers)], state.docName + '.photik'), 'photo');
  },
  undo, redo,
  duplicate() {
    const o = sel();
    if (!o) return;
    pushHistory();
    const c = clone(o);
    c.id = nextId++;
    translateObject(c, 20, 20);
    state.objects.splice(state.objects.indexOf(o) + 1, 0, c);
    state.selected = c.id;
    render();
    syncProps();
  },
  remove() {
    const o = sel();
    if (!o) return;
    pushHistory();
    state.objects.splice(state.objects.indexOf(o), 1);
    state.selected = null;
    render();
    syncProps();
  },
  deselect: () => select(null),
  toFront: () => reorder((i, n) => n - 1),
  forward: () => reorder((i) => i + 1),
  backward: () => reorder((i) => i - 1),
  toBack: () => reorder(() => 0),
  flipH: () => flipSelected(true),
  flipV: () => flipSelected(false),
  zoomIn: () => vw.zoomAt(1.25),
  zoomOut: () => vw.zoomAt(1 / 1.25),
  fit: () => vw.fit(),
  shortcuts() {
    const rows = [
      ['V', 'Выбор'], ['R / O / S', 'Прямоугольник / Эллипс / Звезда'], ['L / P / T', 'Линия / Карандаш / Текст'],
      ['H / Пробел', 'Рука'], ['Shift', 'Квадрат, круг, шаг 45°, пропорции'], ['Стрелки', 'Сдвиг на 1 px (Shift — 10 px)'],
      ['Ctrl+D', 'Дублировать'], ['Del', 'Удалить'], ['[ / ]', 'Назад / вперёд'], ['Shift+[ / Shift+]', 'На задний / передний план'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Отменить / повторить'], ['Ctrl+S', 'Сохранить .kontur'],
    ];
    openModal({ title: 'Горячие клавиши', html: '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>', cancel: false });
  },
  about() {
    openModal({
      title: 'Контур',
      html: `<p><b>Контур</b> — векторный редактор из набора PhipiShip Флот. Фигуры, линии, кривые от руки и текст
        можно увеличивать сколько угодно — они остаются чёткими.</p>
        <p>Проект хранится в формате <b>.kontur</b>, а для других программ есть экспорт в SVG и PNG.</p>`,
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
Fleet.mountSwitcher('kontur');

for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));

buildPalette($('#palette'),
  (c) => { editProp((t) => { t.fill = c; }); editing = false; syncProps(); },
  (c) => { editProp((t) => { t.stroke = c; }); editing = false; syncProps(); });

$('#fileOpen').accept = Fleet.ACCEPT_ALL;
$('#fileOpen').addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('#fileImage').addEventListener('change', (e) => {
  if (e.target.files[0]) placeImage(e.target.files[0]).catch((err) => status(err.message));
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
  // Ctrl+S работает даже в полях ввода.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey) {
    e.preventDefault();
    if (e.target.isContentEditable || e.target.matches('input, textarea')) e.target.blur();
    runAction('save');
    return;
  }
  if (e.target.matches('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod) {
    const map = {
      z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'save', o: 'open', d: 'duplicate',
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
  if (e.key === 'Escape') { select(null); closeMenus(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); runAction('remove'); return; }
  if (e.code === 'BracketRight') { runAction(e.shiftKey ? 'toFront' : 'forward'); return; }
  if (e.code === 'BracketLeft') { runAction(e.shiftKey ? 'toBack' : 'backward'); return; }
  if (e.key.startsWith('Arrow') && sel()) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    pushHistory();
    translateObject(sel(),
      e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
      e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
    render();
    syncProps();
    return;
  }
  if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; updateCursor(); }
});

/* ---------------- Старт ---------------- */

setTool('select');
newDocument(state.w, state.h, '#ffffff');
Fleet.takeHandoff().then((file) => { if (file) openFile(file); });
