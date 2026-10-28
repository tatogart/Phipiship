'use strict';

/* =========================================================
   Свет — коррекция фотографий без порчи оригинала (PhipiShip Флот)
   Формат .svet: JSON { format: "svet", version, app, current,
     photos: [{ name, image: "data:image/…", settings, rot, flip }] }
   Оригинал не меняется: хранятся только настройки, картинка
   пересчитывается при показе и экспорте.
   ========================================================= */

const SVET_VERSION = 1;
const PREVIEW_MAX = 1600;
const MAX_PHOTOS = 60;

const SLIDERS = [
  { group: 'Свет' },
  { key: 'exposure', label: 'Экспозиция', min: -3, max: 3, step: 0.05, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2) },
  { key: 'contrast', label: 'Контраст', min: -100, max: 100 },
  { key: 'highlights', label: 'Светлые', min: -100, max: 100 },
  { key: 'shadows', label: 'Тени', min: -100, max: 100 },
  { group: 'Цвет' },
  { key: 'temp', label: 'Температура', min: -100, max: 100, track: 'linear-gradient(90deg,#4c8dff,#e9e9e9,#ffb347)' },
  { key: 'tint', label: 'Оттенок', min: -100, max: 100, track: 'linear-gradient(90deg,#3ecf6e,#e9e9e9,#e05cd9)' },
  { key: 'vibrance', label: 'Красочность', min: -100, max: 100 },
  { key: 'saturation', label: 'Насыщенность', min: -100, max: 100 },
  { key: 'bw', label: 'Чёрно-белое', type: 'check' },
  { group: 'Эффекты' },
  { key: 'vignette', label: 'Виньетка', min: -100, max: 100 },
  { key: 'grain', label: 'Зерно', min: 0, max: 100 },
];
const DEFAULTS = Object.fromEntries(SLIDERS.filter((s) => s.key).map((s) => [s.key, s.type === 'check' ? false : 0]));

const PRESETS = [
  { name: 'Оригинал', icon: '○', s: {} },
  { name: 'Ярче', icon: '☀', s: { exposure: 0.35, shadows: 30, vibrance: 25 } },
  { name: 'Тёплый закат', icon: '🌅', s: { temp: 45, tint: 8, vibrance: 30, contrast: 10, vignette: -25 } },
  { name: 'Холодное утро', icon: '❄', s: { temp: -40, exposure: 0.15, highlights: -20, saturation: -10 } },
  { name: 'Драма', icon: '⚡', s: { contrast: 45, highlights: -40, shadows: -20, vibrance: 20, vignette: -45 } },
  { name: 'Ретро плёнка', icon: '🎞', s: { temp: 20, contrast: -15, saturation: -25, grain: 35, vignette: -30, shadows: 20 } },
  { name: 'Ч/Б классика', icon: '◑', s: { bw: true, contrast: 30, grain: 15 } },
  { name: 'Ч/Б мягкое', icon: '◐', s: { bw: true, contrast: -20, shadows: 30, exposure: 0.1 } },
  { name: 'Сочные цвета', icon: '🍓', s: { vibrance: 55, saturation: 15, contrast: 15 } },
  { name: 'Нуар', icon: '🎩', s: { bw: true, contrast: 70, highlights: -30, shadows: -40, vignette: -60, grain: 25 } },
];

const state = {
  photos: [],     // [{ id, name, src (dataURL), img, base (canvas), settings, rot, flip }]
  cur: -1,
  compare: false,
  split: 0.5,
  dirty: false,
  docName: 'svet',
};
let nextId = 1;
let clipSettings = null;

const viewport = $('#viewport');
const stage = $('#stage');
const view = $('#view');
const vctx = view.getContext('2d');
const vw = createView(viewport, stage, () => ({ w: view.width || 1, h: view.height || 1 }));
const photo = () => state.photos[state.cur] || null;

/* ---------------- Обработка пикселей ---------------- */

function buildLut(s) {
  const lut = new Uint8ClampedArray(256);
  const ev = 2 ** s.exposure, c = 1 + s.contrast / 100, hl = s.highlights / 100, sh = s.shadows / 100;
  for (let v = 0; v < 256; v++) {
    let x = (v / 255) * ev;
    x = (x - 0.5) * c + 0.5;
    const wH = clamp((x - 0.5) * 2, 0, 1) ** 2;
    const wS = clamp((0.5 - x) * 2, 0, 1) ** 2;
    x += hl * 0.35 * wH + sh * 0.35 * wS;
    lut[v] = clamp(x, 0, 1) * 255;
  }
  return lut;
}

/** Обрабатывает пиксели src → dst по настройкам s. */
function process(src, dst, w, h, s) {
  const lut = buildLut(s);
  const t = s.temp / 100, ti = s.tint / 100;
  const wr = 1 + t * 0.22, wg = 1 - ti * 0.18, wb = 1 - t * 0.22;
  const sat = 1 + s.saturation / 100, vib = s.vibrance / 100;
  const vig = s.vignette / 100, grain = s.grain / 100;
  const cx = w / 2, cy = h / 2;
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let y = 0, p = 0; y < h; y++) {
    const dy = (y - cy) / cy;
    for (let x = 0; x < w; x++, p += 4) {
      let r = lut[clamp(Math.round(src[p] * wr), 0, 255)];
      let g = lut[clamp(Math.round(src[p + 1] * wg), 0, 255)];
      let b = lut[clamp(Math.round(src[p + 2] * wb), 0, 255)];
      const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (s.bw) {
        r = g = b = gray;
      } else if (sat !== 1 || vib) {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const f = sat + vib * (1 - (mx - mn) / 255);
        r = gray + (r - gray) * f;
        g = gray + (g - gray) * f;
        b = gray + (b - gray) * f;
      }
      if (vig) {
        const dx = (x - cx) / cx;
        const d = (dx * dx + dy * dy) / 2;
        const k = 1 + vig * 0.9 * d * d * 2;
        r *= k; g *= k; b *= k;
      }
      if (grain) {
        const n = rnd() * grain * 70;
        r += n; g += n; b += n;
      }
      dst[p] = r; dst[p + 1] = g; dst[p + 2] = b; dst[p + 3] = src[p + 3];
    }
  }
}

/** Картинка с поворотом и отражением, уменьшенная до maxSide (0 — полный размер). */
function geometry(ph, maxSide) {
  const iw = ph.img.naturalWidth, ih = ph.img.naturalHeight;
  const k = maxSide ? Math.min(1, maxSide / Math.max(iw, ih)) : 1;
  const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
  const swap = ph.rot % 180 !== 0;
  const c = makeCanvas(swap ? h : w, swap ? w : h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((ph.rot * Math.PI) / 180);
  if (ph.flip) ctx.scale(-1, 1);
  ctx.drawImage(ph.img, -w / 2, -h / 2, w, h);
  return c;
}

function rendered(ph, maxSide) {
  const g = geometry(ph, maxSide);
  const ctx = g.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, g.width, g.height);
  const out = new ImageData(g.width, g.height);
  process(img.data, out.data, g.width, g.height, ph.settings);
  ctx.putImageData(out, 0, 0);
  return g;
}

/* ---------------- Показ ---------------- */

let base = null;      // превью с геометрией, без обработки
let processed = null; // обработанное превью
let frame = 0;

function rebuildBase() {
  const ph = photo();
  base = ph ? geometry(ph, PREVIEW_MAX) : null;
  if (base && (view.width !== base.width || view.height !== base.height)) {
    view.width = base.width;
    view.height = base.height;
    vw.fit();
  }
}

function schedule() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(renderNow);
}

function renderNow() {
  const ph = photo();
  $('#empty').hidden = !!ph;
  stage.hidden = !ph;
  if (!ph || !base) { drawHisto(null); return; }
  const bctx = base.getContext('2d', { willReadFrequently: true });
  const src = bctx.getImageData(0, 0, base.width, base.height);
  const out = new ImageData(base.width, base.height);
  process(src.data, out.data, base.width, base.height, ph.settings);
  processed = out;
  vctx.putImageData(out, 0, 0);
  if (state.compare) {
    const sx = Math.round(view.width * state.split);
    vctx.putImageData(src, 0, 0, 0, 0, sx, view.height);
    vctx.fillStyle = '#fff';
    vctx.fillRect(sx - 1, 0, 2, view.height);
    vctx.font = `bold ${Math.max(12, view.width / 50)}px system-ui, sans-serif`;
    vctx.shadowColor = 'rgba(0,0,0,.6)';
    vctx.shadowBlur = 6;
    vctx.fillText('ДО', 14, view.height - 16);
    vctx.fillText('ПОСЛЕ', view.width - vctx.measureText('ПОСЛЕ').width - 14, view.height - 16);
    vctx.shadowBlur = 0;
  }
  drawHisto(out);
  updateThumb(ph);
}

function drawHisto(img) {
  const c = $('#histo');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!img) return;
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const d = img.data;
  for (let i = 0; i < d.length; i += 16) {
    bins[0][d[i]]++;
    bins[1][d[i + 1]]++;
    bins[2][d[i + 2]]++;
  }
  let max = 1;
  for (const b of bins) for (let i = 2; i < 254; i++) max = Math.max(max, b[i]);
  ctx.globalCompositeOperation = 'lighter';
  ['rgba(255,70,70,.75)', 'rgba(70,220,90,.75)', 'rgba(80,130,255,.75)'].forEach((col, k) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, c.height);
    for (let i = 0; i < 256; i++) ctx.lineTo(i, c.height - Math.min(1, bins[k][i] / max) * (c.height - 2));
    ctx.lineTo(255, c.height);
    ctx.fill();
  });
  ctx.globalCompositeOperation = 'source-over';
}

let thumbTimer = 0;
function updateThumb(ph) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const c = $(`#frames canvas[data-id="${ph.id}"]`);
    if (!c || !processed) return;
    const k = 72 / view.height;
    c.width = Math.max(1, Math.round(view.width * k));
    c.height = 72;
    const tmp = makeCanvas(view.width, view.height);
    tmp.getContext('2d').putImageData(processed, 0, 0);
    c.getContext('2d').drawImage(tmp, 0, 0, c.width, c.height);
  }, 250);
}

/* ---------------- Лента и панель ---------------- */

function renderStrip() {
  const box = $('#frames');
  box.innerHTML = '';
  state.photos.forEach((ph, i) => {
    const el = document.createElement('div');
    el.className = 'frame' + (i === state.cur ? ' active' : '');
    const c = makeCanvas(96, 72);
    c.dataset.id = ph.id;
    const k = 72 / ph.img.naturalHeight;
    c.width = Math.max(1, Math.round(ph.img.naturalWidth * k));
    c.getContext('2d').drawImage(ph.img, 0, 0, c.width, c.height);
    el.appendChild(c);
    el.appendChild(document.createTextNode(ph.name.length > 14 ? ph.name.slice(0, 13) + '…' : ph.name));
    el.title = ph.name;
    el.onclick = () => selectPhoto(i);
    box.appendChild(el);
  });
  const add = document.createElement('button');
  add.className = 'frame-add';
  add.textContent = '＋';
  add.title = 'Добавить фото';
  add.dataset.action = 'open';
  box.appendChild(add);
}

function selectPhoto(i) {
  state.cur = clamp(i, -1, state.photos.length - 1);
  const ph = photo();
  $('#photoName').textContent = ph ? ph.name : 'Нет фото';
  $('#photoInfo').textContent = ph ? `${ph.img.naturalWidth} × ${ph.img.naturalHeight} px · фото ${state.cur + 1} из ${state.photos.length}` : '';
  $('#statusSize').textContent = ph ? `${ph.img.naturalWidth} × ${ph.img.naturalHeight} px` : '';
  for (const [k, el] of Object.entries($$('#frames .frame'))) el.classList.toggle('active', Number(k) === state.cur);
  rebuildBase();
  syncSliders();
  schedule();
  // После смены фото лента подсвечивает текущее и все превью пересчитываются для старых фото.
  const active = $('#frames .frame.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const sliderEls = {};

function buildSliders() {
  const box = $('#sliders');
  for (const s of SLIDERS) {
    if (s.group) {
      const h = document.createElement('h3');
      h.className = 'slider-group';
      h.textContent = s.group;
      box.appendChild(h);
      continue;
    }
    const row = document.createElement('label');
    row.className = 'slider-row';
    const name = document.createElement('span');
    name.textContent = s.label;
    const out = document.createElement('output');
    const input = document.createElement('input');
    if (s.type === 'check') {
      input.type = 'checkbox';
      row.classList.add('check');
      row.append(input, name);
    } else {
      input.type = 'range';
      input.min = s.min;
      input.max = s.max;
      input.step = s.step || 1;
      if (s.track) input.style.setProperty('--track', s.track);
      row.title = 'Двойной клик — сбросить';
      row.append(name, out, input);
      row.addEventListener('dblclick', () => setSetting(s.key, 0, true));
    }
    input.addEventListener('pointerdown', beginEdit);
    input.addEventListener('keydown', beginEdit);
    input.addEventListener('input', () => setSetting(s.key, s.type === 'check' ? input.checked : Number(input.value)));
    input.addEventListener('change', () => { editing = false; });
    sliderEls[s.key] = { input, out, s };
    box.appendChild(row);
  }
}

function syncSliders() {
  const ph = photo();
  const st = ph ? ph.settings : DEFAULTS;
  for (const { input, out, s } of Object.values(sliderEls)) {
    input.disabled = !ph;
    if (s.type === 'check') { input.checked = !!st[s.key]; continue; }
    input.value = st[s.key];
    out.textContent = s.fmt ? s.fmt(st[s.key]) : (st[s.key] > 0 ? '+' : '') + st[s.key];
    out.classList.toggle('changed', st[s.key] !== 0);
  }
}

/* ---------------- История ---------------- */

const hist = { undo: [], redo: [] };
let editing = false;
const photoSnap = (ph) => ({ id: ph.id, settings: { ...ph.settings }, rot: ph.rot, flip: ph.flip });

function pushHistory(ph = photo()) {
  if (!ph) return;
  hist.undo.push(photoSnap(ph));
  if (hist.undo.length > 100) hist.undo.shift();
  hist.redo.length = 0;
  state.dirty = true;
  updateHistoryButtons();
}

function beginEdit() {
  if (!editing && photo()) { pushHistory(); editing = true; }
}

function applySnap(snap, stackTo) {
  const i = state.photos.findIndex((p) => p.id === snap.id);
  if (i < 0) return;
  const ph = state.photos[i];
  stackTo.push(photoSnap(ph));
  const geo = ph.rot !== snap.rot || ph.flip !== snap.flip;
  Object.assign(ph, { settings: { ...snap.settings }, rot: snap.rot, flip: snap.flip });
  if (i !== state.cur) selectPhoto(i);
  else {
    if (geo) rebuildBase();
    syncSliders();
    schedule();
  }
}

function undo() {
  const s = hist.undo.pop();
  if (s) applySnap(s, hist.redo);
  updateHistoryButtons();
}

function redo() {
  const s = hist.redo.pop();
  if (s) applySnap(s, hist.undo);
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('#undoBtn').disabled = !hist.undo.length;
  $('#redoBtn').disabled = !hist.redo.length;
}

function setSetting(key, value, withHistory) {
  const ph = photo();
  if (!ph) return;
  if (withHistory) pushHistory();
  ph.settings[key] = value;
  state.dirty = true;
  syncSliders();
  schedule();
}

/* ---------------- Пресеты ---------------- */

function userPresets() {
  try { return JSON.parse(localStorage.getItem('svet-presets') || '[]'); } catch (_) { return []; }
}

function renderPresets() {
  const bar = $('#presets');
  bar.innerHTML = '';
  for (const p of [...PRESETS, ...userPresets().map((u) => ({ ...u, icon: '★', mine: true }))]) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.title = p.name + (p.mine ? ' (мой пресет, правый клик — удалить)' : '');
    b.innerHTML = `<span>${p.icon}</span><small>${esc(p.name)}</small>`;
    b.onclick = () => {
      const ph = photo();
      if (!ph) return;
      pushHistory();
      ph.settings = { ...DEFAULTS, ...p.s };
      syncSliders();
      schedule();
      status(`Пресет «${p.name}»`);
    };
    if (p.mine) {
      b.oncontextmenu = (e) => {
        e.preventDefault();
        if (!confirm(`Удалить пресет «${p.name}»?`)) return;
        const list = userPresets().filter((u) => u.name !== p.name);
        try { localStorage.setItem('svet-presets', JSON.stringify(list)); } catch (_) { /* приватный режим */ }
        renderPresets();
      };
    }
    bar.appendChild(b);
  }
}

/* ---------------- Файлы ---------------- */

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Не удалось прочитать файл'));
    fr.readAsDataURL(file);
  });
}

async function addPhoto(src, name, extra = {}) {
  if (state.photos.length >= MAX_PHOTOS) throw new Error(`В ленте не больше ${MAX_PHOTOS} фото`);
  const img = await loadImage(src);
  const ph = { id: nextId++, name, src, img, settings: { ...DEFAULTS, ...(extra.settings || {}) }, rot: extra.rot || 0, flip: !!extra.flip };
  state.photos.push(ph);
  return ph;
}

function cleanSettings(s) {
  const out = { ...DEFAULTS };
  if (!s || typeof s !== 'object') return out;
  for (const sl of SLIDERS) {
    if (!sl.key || !(sl.key in s)) continue;
    out[sl.key] = sl.type === 'check' ? !!s[sl.key] : clamp(Number(s[sl.key]) || 0, sl.min, sl.max);
  }
  return out;
}

async function openSvet(file) {
  let doc;
  try { doc = JSON.parse(await file.text()); } catch (_) { throw new Error('Файл .svet повреждён'); }
  if (!doc || doc.format !== 'svet' || !Array.isArray(doc.photos)) throw new Error('Это не файл Света (.svet)');
  if (doc.version > SVET_VERSION) throw new Error('Файл создан более новой версией Света — обновите страницу');
  if (!confirmDiscard()) return;
  state.photos = [];
  hist.undo.length = hist.redo.length = 0;
  for (const p of doc.photos.slice(0, MAX_PHOTOS)) {
    if (typeof p.image !== 'string' || !/^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/.test(p.image)) continue;
    await addPhoto(p.image, String(p.name || 'Фото').slice(0, 80), {
      settings: cleanSettings(p.settings), rot: [0, 90, 180, 270].includes(p.rot) ? p.rot : 0, flip: !!p.flip,
    });
  }
  state.docName = Fleet.baseName(file.name) || 'svet';
  state.dirty = false;
  updateHistoryButtons();
  renderStrip();
  selectPhoto(clamp(Math.round(doc.current) || 0, 0, state.photos.length - 1));
  if (photo()) Fleet.addRecent(file.name, 'svet', file, Fleet.thumbOf(rendered(state.photos[0], 400)));
  status(`⚓ Открыт ${file.name}: ${state.photos.length} фото`);
}

async function saveSvet() {
  if (!state.photos.length) { status('Добавьте хотя бы одно фото.'); return; }
  const doc = {
    format: 'svet', version: SVET_VERSION, app: 'Свет', current: state.cur,
    photos: state.photos.map((p) => ({ name: p.name, image: p.src, settings: p.settings, rot: p.rot, flip: p.flip })),
  };
  const name = state.docName + '.svet';
  const blob = new Blob([JSON.stringify(doc)], { type: 'application/octet-stream' });
  Fleet.download(blob, name);
  Fleet.addRecent(name, 'svet', blob, Fleet.thumbOf(rendered(photo(), 400)));
  state.dirty = false;
  status(`⚓ Сохранено: ${name}`);
}

function confirmDiscard() {
  return !state.dirty || confirm('Несохранённые изменения будут потеряны. Продолжить?');
}

async function openFiles(files) {
  const before = state.photos.length;
  for (const file of files) {
    try {
      const ext = Fleet.extOf(file.name);
      if (ext === 'svet') { await openSvet(file); return; }
      const app = Fleet.appForFile(file.name, file.type);
      if (app && app.id === 'photo' && ext !== 'photik') {
        await addPhoto(await readDataUrl(file), Fleet.baseName(file.name) || 'Фото');
        state.dirty = true;
        continue;
      }
      if (app) {
        if (confirmDiscard()) await Fleet.openIn(file, app.id);
        return;
      }
      status(`Не знаю такой формат: ${file.name}`);
    } catch (err) {
      status(err.message);
    }
  }
  if (state.photos.length > before) {
    renderStrip();
    selectPhoto(before);
    status(`Добавлено фото: ${state.photos.length - before}`);
  }
}

function exportPhoto(ph, type, quality) {
  return new Promise((resolve) => {
    const c = rendered(ph, 0);
    c.toBlob((b) => {
      Fleet.download(b, `${ph.name}-svet.${type === 'image/png' ? 'png' : 'jpg'}`);
      resolve();
    }, type, quality);
  });
}

/* ---------------- Действия ---------------- */

function needPhoto() {
  if (!photo()) { status('Сначала добавьте фото.'); return false; }
  return true;
}

const actions = {
  open: () => $('#fileOpen').click(),
  save: saveSvet,
  exportJpg() {
    if (!needPhoto()) return;
    openModal({
      title: 'Экспорт JPG',
      fields: [{ key: 'q', label: 'Качество', type: 'range', min: 40, max: 100, value: 92 }],
      okText: 'Сохранить',
      onOk: ({ q }) => { status('Готовлю файл в полном размере…'); setTimeout(() => exportPhoto(photo(), 'image/jpeg', q / 100), 20); },
    });
  },
  exportPng() { if (needPhoto()) exportPhoto(photo(), 'image/png'); },
  async exportAll() {
    if (!needPhoto()) return;
    for (const [i, ph] of state.photos.entries()) {
      status(`Экспорт ${i + 1} из ${state.photos.length}…`);
      await exportPhoto(ph, 'image/jpeg', 0.92);
    }
    status(`Готово: ${state.photos.length} фото`);
  },
  async toPhoto() {
    if (!needPhoto() || !confirmDiscard()) return;
    const ph = photo();
    const orig = geometry(ph, 0);
    const res = rendered(ph, 0);
    const file = new File([Fleet.makePhotik(res.width, res.height, [
      { name: 'Оригинал', canvas: orig, visible: false },
      { name: 'Свет', canvas: res },
    ])], ph.name + '.photik');
    await Fleet.openIn(file, 'photo');
  },
  harbor: () => { location.href = 'index.html'; },
  undo, redo,
  reset() {
    const ph = photo();
    if (!ph) return;
    pushHistory();
    ph.settings = { ...DEFAULTS };
    syncSliders();
    schedule();
  },
  copySettings() {
    if (!needPhoto()) return;
    clipSettings = { ...photo().settings };
    status('Настройки скопированы');
  },
  pasteSettings() {
    if (!needPhoto() || !clipSettings) return;
    pushHistory();
    photo().settings = { ...clipSettings };
    syncSliders();
    schedule();
  },
  applyAll() {
    if (!needPhoto()) return;
    const s = photo().settings;
    for (const ph of state.photos) {
      if (ph === photo()) continue;
      pushHistory(ph);
      ph.settings = { ...s };
    }
    state.dirty = true;
    status(`Настройки применены ко всем ${state.photos.length} фото`);
    // Обновим превью в ленте.
    const keep = state.cur;
    state.photos.forEach((ph, i) => {
      if (i === keep) return;
      const c = $(`#frames canvas[data-id="${ph.id}"]`);
      if (c) c.getContext('2d').drawImage(rendered(ph, 200), 0, 0, c.width, c.height);
    });
  },
  removePhoto() {
    if (!needPhoto()) return;
    state.photos.splice(state.cur, 1);
    state.dirty = true;
    renderStrip();
    selectPhoto(Math.min(state.cur, state.photos.length - 1));
  },
  rotL() { if (!needPhoto()) return; pushHistory(); photo().rot = (photo().rot + 270) % 360; rebuildBase(); schedule(); },
  rotR() { if (!needPhoto()) return; pushHistory(); photo().rot = (photo().rot + 90) % 360; rebuildBase(); schedule(); },
  flip() { if (!needPhoto()) return; pushHistory(); photo().flip = !photo().flip; rebuildBase(); schedule(); },
  compare() {
    state.compare = !state.compare;
    $('#compareBtn').classList.toggle('primary', state.compare);
    viewport.dataset.cursor = state.compare ? 'ew' : '';
    schedule();
    if (state.compare) status('Тяните по фото, чтобы двигать границу «до / после»');
  },
  savePreset() {
    if (!needPhoto()) return;
    openModal({
      title: 'Мой пресет',
      fields: [{ key: 'name', label: 'Название', type: 'text', value: 'Мой стиль' }],
      okText: 'Сохранить',
      onOk: ({ name }) => {
        name = String(name).trim().slice(0, 30) || 'Мой стиль';
        const list = userPresets().filter((u) => u.name !== name);
        list.push({ name, s: { ...photo().settings } });
        try { localStorage.setItem('svet-presets', JSON.stringify(list)); } catch (_) { status('Браузер не дал сохранить пресет.'); }
        renderPresets();
        status(`Пресет «${name}» сохранён`);
      },
    });
  },
  zoomIn: () => vw.zoomAt(1.25),
  zoomOut: () => vw.zoomAt(1 / 1.25),
  fit: () => vw.fit(),
  prevPhoto: () => { if (state.photos.length) selectPhoto((state.cur - 1 + state.photos.length) % state.photos.length); },
  nextPhoto: () => { if (state.photos.length) selectPhoto((state.cur + 1) % state.photos.length); },
  shortcuts() {
    const rows = [
      ['← / →', 'Предыдущее / следующее фото'], ['[ / ]', 'Повернуть влево / вправо'], ['\\', 'Сравнить «до / после»'],
      ['Двойной клик по ползунку', 'Сбросить его'], ['Ctrl+Shift+C / V', 'Копировать / вставить настройки'],
      ['Ctrl+E', 'Экспорт JPG'], ['Ctrl+Z / Ctrl+Shift+Z', 'Отменить / повторить'], ['Ctrl+S', 'Сохранить .svet'],
    ];
    openModal({ title: 'Горячие клавиши', html: '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>', cancel: false });
  },
  about() {
    openModal({
      title: 'Свет',
      html: `<p><b>Свет</b> — коррекция фотографий из набора PhipiShip Флот. Двигайте ползунки света и цвета,
        пробуйте пресеты и сравнивайте «до / после». Оригинал никогда не портится — в проекте хранятся только настройки.</p>
        <p>Проект с лентой фото сохраняется в формате <b>.svet</b>, готовые снимки — в JPG или PNG.</p>`,
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
Fleet.mountSwitcher('svet');
buildSliders();
renderPresets();

let splitDrag = false;
viewport.addEventListener('pointerdown', (e) => {
  if (!state.compare || !photo() || e.button !== 0 || vw.touches.size > 1) return;
  splitDrag = true;
  viewport.setPointerCapture(e.pointerId);
  moveSplit(e);
});
viewport.addEventListener('pointermove', (e) => { if (splitDrag) moveSplit(e); });
viewport.addEventListener('pointerup', () => { splitDrag = false; });
function moveSplit(e) {
  const r = view.getBoundingClientRect();
  state.split = clamp((e.clientX - r.left) / r.width, 0, 1);
  schedule();
}

$('#fileOpen').accept = Fleet.ACCEPT_ALL;
$('#fileOpen').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) openFiles(files);
});
viewport.addEventListener('dragover', (e) => { e.preventDefault(); viewport.classList.add('dragover'); });
viewport.addEventListener('dragleave', () => viewport.classList.remove('dragover'));
viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  viewport.classList.remove('dragover');
  if (e.dataTransfer.files.length) openFiles([...e.dataTransfer.files]);
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
  if (e.target.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod) {
    const map = {
      z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'save', o: 'open', e: 'exportJpg',
      '0': 'fit', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut',
    };
    if (e.shiftKey && k === 'c') { e.preventDefault(); runAction('copySettings'); return; }
    if (e.shiftKey && k === 'v') { e.preventDefault(); runAction('pasteSettings'); return; }
    if (map[k]) { e.preventDefault(); runAction(map[k]); }
    return;
  }
  if (e.target.matches('input')) return;
  if (e.key === 'ArrowLeft') { runAction('prevPhoto'); return; }
  if (e.key === 'ArrowRight') { runAction('nextPhoto'); return; }
  if (e.key === '[') { runAction('rotL'); return; }
  if (e.key === ']') { runAction('rotR'); return; }
  if (e.key === '\\') { runAction('compare'); return; }
  if (e.key === 'Escape') closeMenus();
});

renderStrip();
selectPhoto(-1);
updateHistoryButtons();
Fleet.takeHandoff().then((file) => { if (file) openFiles([file]); });
