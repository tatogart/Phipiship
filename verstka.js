'use strict';

/* =========================================================
   Вёрстка — макеты страниц и печать (PhipiShip Флот)
   Формат .verstka: JSON { format: "verstka", version, app, size: { w, h } (мм),
     images: { id: "data:image/…" }, pages: [{ bg, items: [{ type, x, y, w, h, … }] }] }
   Все размеры — в миллиметрах, кегль — в пунктах, как в типографии.
   ========================================================= */

const VERSTKA_VERSION = 1;
const MM = 96 / 25.4;      // пикселей в миллиметре при 100%
const PT = 25.4 / 72;      // миллиметров в пункте
const MARGIN = 10;
const FONTS = [
  ['system-ui, sans-serif', 'Без засечек'], ['Georgia, serif', 'С засечками'], ['ui-monospace, monospace', 'Моноширинный'],
  ["Impact, 'Arial Black', sans-serif", 'Плакатный'], ["'Comic Sans MS', 'Comic Neue', cursive", 'Рукописный'],
];
const TOOL_NAMES = { select: 'Выбор', text: 'Текстовый блок', image: 'Картинка', rect: 'Прямоугольник', ellipse: 'Эллипс' };
const TOOL_HINTS = {
  select: 'Клик — выбрать, тяните — двигать (липнет к полям и центру), двойной клик по тексту — править прямо на странице.',
  text: 'Протяните рамку для текста или просто кликните на странице.',
  image: 'Кликните на странице — откроется выбор картинки.',
  rect: 'Протяните мышью. Shift — квадрат.',
  ellipse: 'Протяните мышью. Shift — круг.',
};
const TOOL_KEYS = { v: 'select', t: 'text', i: 'image', r: 'rect', o: 'ellipse' };

const state = {
  size: { w: 210, h: 297 },
  pages: [],
  images: {},          // id → dataURL (вне истории, чтобы снимки были лёгкими)
  sel: null,           // { page, id }
  curPage: 0,
  tool: 'select',
  zoom: 1,
  guides: true,
  dirty: false,
  docName: 'verstka',
};
let nextId = 1;
const imgCache = new Map();

const area = $('#viewport');
const pagesBox = $('#pages');

const findItem = (sel = state.sel) => {
  if (!sel) return null;
  const page = state.pages[sel.page];
  return page ? page.items.find((it) => it.id === sel.id) || null : null;
};

/* ---------------- Шаблоны ---------------- */

const text = (x, y, w, h, t, o = {}) => ({
  type: 'text', x, y, w, h, text: t, font: FONTS[0][0], size: 14, color: '#1d1d1f', align: 'left',
  bold: false, italic: false, lh: 1.3, bg: null, opacity: 1, ...o,
});
const box = (type, x, y, w, h, o = {}) => ({ type, x, y, w, h, fill: '#ff7a59', stroke: null, sw: 1, radius: 0, opacity: 1, ...o });

const TEMPLATES = {
  blank: { name: 'Пустой лист A4', size: { w: 210, h: 297 }, pages: () => [{ bg: '#ffffff', items: [] }] },
  card: {
    name: 'Открытка (A6)', size: { w: 148, h: 105 },
    pages: () => [{
      bg: '#fff4e0', items: [
        box('rect', 0, 0, 148, 14, { fill: '#ff7a59' }),
        box('ellipse', 112, 58, 50, 50, { fill: '#ffd180' }),
        box('ellipse', -14, 70, 40, 40, { fill: '#a7ffeb' }),
        text(12, 28, 124, 30, 'С днём рождения!', { size: 30, bold: true, align: 'center', color: '#c2410c', font: FONTS[4][0] }),
        text(20, 62, 108, 24, 'Пусть каждый день будет\nтёплым и радостным!', { size: 13, align: 'center', color: '#5b3a29' }),
      ],
    }],
  },
  poster: {
    name: 'Плакат (A3)', size: { w: 297, h: 420 },
    pages: () => [{
      bg: '#12253d', items: [
        box('rect', 24, 150, 249, 160, { fill: '#1f3b73', radius: 6 }),
        text(24, 210, 249, 40, 'Место для фото', { size: 24, align: 'center', color: '#8ea6c4' }),
        text(24, 30, 249, 60, 'КОНЦЕРТ', { size: 96, bold: true, align: 'center', color: '#ffffff', font: FONTS[3][0], lh: 1 }),
        text(24, 100, 249, 30, 'Школьный ансамбль «Волна»', { size: 26, align: 'center', color: '#3fd0c9' }),
        box('rect', 24, 330, 249, 2, { fill: '#ff7a59' }),
        text(24, 345, 249, 50, 'Суббота, 18:00 · Актовый зал\nВход свободный', { size: 22, align: 'center', color: '#ffffff', lh: 1.4 }),
      ],
    }],
  },
  booklet: {
    name: 'Буклет (A5, 2 страницы)', size: { w: 148, h: 210 },
    pages: () => [
      {
        bg: '#0d4a40', items: [
          box('ellipse', 34, 40, 80, 80, { fill: '#5ef2b0' }),
          text(14, 135, 120, 30, 'Наш проект', { size: 32, bold: true, align: 'center', color: '#ffffff' }),
          text(14, 168, 120, 20, 'Исследование про морских обитателей', { size: 12, align: 'center', color: '#a7ffeb' }),
        ],
      },
      {
        bg: '#ffffff', items: [
          text(14, 14, 120, 16, 'Введение', { size: 20, bold: true, color: '#0d4a40' }),
          box('rect', 14, 32, 30, 1.5, { fill: '#5ef2b0' }),
          text(14, 38, 120, 150, 'Здесь можно рассказать, о чём ваш проект: что вы изучали, какие вопросы себе задавали и что удалось узнать.\n\nДважды щёлкните по тексту, чтобы изменить его прямо на странице.', { size: 11, lh: 1.5 }),
        ],
      },
    ],
  },
  square: {
    name: 'Квадратный пост', size: { w: 200, h: 200 },
    pages: () => [{
      bg: '#7c5cff', items: [
        box('ellipse', 120, -40, 130, 130, { fill: '#ff8a80', opacity: 0.9 }),
        text(16, 110, 168, 40, 'Большая новость!', { size: 34, bold: true, color: '#ffffff' }),
        text(16, 150, 168, 30, 'Подробности — по ссылке в профиле', { size: 14, color: '#ede9fe' }),
      ],
    }],
  },
};

function withIds(pages) {
  for (const p of pages) for (const it of p.items) it.id = nextId++;
  return pages;
}

/* ---------------- Отрисовка (экран и печать) ---------------- */

function unitFns(mode) {
  return mode === 'print'
    ? { L: (mm) => mm + 'mm', F: (pt) => pt + 'pt' }
    : { L: (mm) => mm * MM * state.zoom + 'px', F: (pt) => (pt * 96 / 72) * state.zoom + 'px' };
}

function itemEl(it, mode) {
  const { L, F } = unitFns(mode);
  const el = document.createElement('div');
  el.className = 'item ' + it.type;
  el.dataset.id = it.id;
  Object.assign(el.style, { left: L(it.x), top: L(it.y), width: L(it.w), height: L(it.h), opacity: it.opacity ?? 1 });
  if (it.type === 'rect' || it.type === 'ellipse') {
    el.style.background = it.fill || 'transparent';
    if (it.stroke) el.style.border = `${F(it.sw || 1)} solid ${it.stroke}`;
    el.style.borderRadius = it.type === 'ellipse' ? '50%' : L(it.radius || 0);
  } else if (it.type === 'image') {
    const src = state.images[it.img];
    el.style.backgroundImage = src ? `url("${src}")` : 'none';
    el.style.backgroundSize = it.fit === 'contain' ? 'contain' : 'cover';
    el.style.borderRadius = L(it.radius || 0);
  } else if (it.type === 'text') {
    el.textContent = it.text;
    Object.assign(el.style, {
      fontFamily: it.font, fontSize: F(it.size), color: it.color, textAlign: it.align,
      fontWeight: it.bold ? 700 : 400, fontStyle: it.italic ? 'italic' : 'normal', lineHeight: it.lh,
      background: it.bg || 'transparent',
    });
  }
  return el;
}

function pageEl(page, index, mode) {
  const { L } = unitFns(mode);
  const el = document.createElement('div');
  el.className = mode === 'print' ? 'print-page' : 'page';
  el.dataset.page = index;
  Object.assign(el.style, { width: L(state.size.w), height: L(state.size.h), background: page.bg });
  for (const it of page.items) el.appendChild(itemEl(it, mode));
  return el;
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function render() {
  pagesBox.innerHTML = '';
  state.pages.forEach((page, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `Страница ${i + 1}`;
    const el = pageEl(page, i, 'screen');
    if (state.guides) {
      const { L } = unitFns('screen');
      const m = document.createElement('div');
      m.className = 'margin-guide';
      Object.assign(m.style, { left: L(MARGIN), top: L(MARGIN), right: L(MARGIN), bottom: L(MARGIN) });
      el.prepend(m);
    }
    if (state.sel && state.sel.page === i) {
      const itEl = el.querySelector(`.item[data-id="${state.sel.id}"]`);
      if (itEl) {
        itEl.classList.add('selected');
        for (const h of HANDLES) {
          const hd = document.createElement('i');
          hd.className = 'h ' + h;
          hd.dataset.h = h;
          itEl.appendChild(hd);
        }
      }
    }
    wrap.append(label, el);
    pagesBox.appendChild(wrap);
  });
  $('#zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
  $('#statusSize').textContent = `${state.size.w} × ${state.size.h} мм · страниц: ${state.pages.length}`;
}

function renderAll() {
  render();
  renderProps();
  renderPageList();
}

/* ---------------- Растровая отрисовка (PNG, превью) ---------------- */

function getImg(id) {
  const src = state.images[id];
  if (!src) return null;
  let img = imgCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => renderPageList();
    img.src = src;
    imgCache.set(src, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

function wrapText(ctx, str, maxW) {
  const out = [];
  for (const para of String(str).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = word; } else line = test;
    }
    out.push(line);
  }
  return out;
}

function drawPage(ctx, page, k) {
  ctx.fillStyle = page.bg || '#ffffff';
  ctx.fillRect(0, 0, state.size.w * k, state.size.h * k);
  for (const it of page.items) {
    const x = it.x * k, y = it.y * k, w = it.w * k, h = it.h * k;
    ctx.save();
    ctx.globalAlpha = it.opacity ?? 1;
    if (it.type === 'rect' || it.type === 'ellipse') {
      ctx.beginPath();
      if (it.type === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else ctx.roundRect(x, y, w, h, Math.min((it.radius || 0) * k, w / 2, h / 2));
      if (it.fill) { ctx.fillStyle = it.fill; ctx.fill(); }
      if (it.stroke) {
        const lw = (it.sw || 1) * PT * k;
        ctx.lineWidth = lw;
        ctx.strokeStyle = it.stroke;
        ctx.beginPath();
        if (it.type === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2 - lw / 2), Math.max(0, h / 2 - lw / 2), 0, 0, Math.PI * 2);
        else ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, Math.max(0, Math.min((it.radius || 0) * k, w / 2, h / 2) - lw / 2));
        ctx.stroke();
      }
    } else if (it.type === 'image') {
      const img = getImg(it.img);
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, Math.min((it.radius || 0) * k, w / 2, h / 2));
      ctx.clip();
      if (img) {
        const s = it.fit === 'contain' ? Math.min(w / img.naturalWidth, h / img.naturalHeight) : Math.max(w / img.naturalWidth, h / img.naturalHeight);
        const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
        ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
      }
    } else if (it.type === 'text') {
      if (it.bg) { ctx.fillStyle = it.bg; ctx.fillRect(x, y, w, h); }
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const size = it.size * PT * k;
      ctx.font = `${it.italic ? 'italic ' : ''}${it.bold ? 700 : 400} ${size}px ${it.font}`;
      ctx.fillStyle = it.color;
      ctx.textBaseline = 'top';
      ctx.textAlign = it.align === 'center' ? 'center' : it.align === 'right' ? 'right' : 'left';
      const lh = size * (it.lh || 1.3);
      const tx = it.align === 'center' ? x + w / 2 : it.align === 'right' ? x + w : x;
      let ty = y + (lh - size) / 2;
      for (const line of wrapText(ctx, it.text, w)) {
        ctx.fillText(line, tx, ty);
        ty += lh;
      }
    }
    ctx.restore();
  }
}

function pageCanvas(i, k) {
  const c = makeCanvas(Math.max(1, Math.round(state.size.w * k)), Math.max(1, Math.round(state.size.h * k)));
  drawPage(c.getContext('2d'), state.pages[i], k);
  return c;
}

function renderPageList() {
  const ul = $('#pageList');
  ul.innerHTML = '';
  state.pages.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'page-item' + (i === state.curPage ? ' active' : '');
    const k = 46 / state.size.h;
    const c = pageCanvas(i, k);
    c.className = 'page-thumb';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = `Страница ${i + 1} · объектов: ${p.items.length}`;
    li.append(c, nm);
    li.onclick = () => {
      state.curPage = i;
      renderPageList();
      pagesBox.children[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (!state.sel) renderProps();
    };
    ul.appendChild(li);
  });
}

/* ---------------- Свойства ---------------- */

function row(label, html) {
  return `<div class="row"><span>${label}</span>${html}</div>`;
}

function renderProps() {
  const it = findItem();
  const box = $('#props');
  if (!it) {
    const page = state.pages[state.curPage];
    $('#propsTitle').textContent = `Страница ${state.curPage + 1}`;
    box.innerHTML = page ? row('Фон', `<input type="color" data-page="bg" value="${page.bg}">`) +
      row('Размер', `<span>${state.size.w} × ${state.size.h} мм</span>`) +
      '<button data-action="docSize">Изменить размер страниц…</button>' +
      '<p class="hint-small">Выберите объект на странице, чтобы настроить его. Двойной клик по тексту — правка прямо на месте.</p>' : '';
    const bg = box.querySelector('[data-page=bg]');
    if (bg) {
      bg.addEventListener('input', () => { beginEdit(); page.bg = bg.value; render(); });
      bg.addEventListener('change', () => { editing = false; renderPageList(); });
    }
    return;
  }
  $('#propsTitle').textContent = { text: 'Текст', image: 'Картинка', rect: 'Прямоугольник', ellipse: 'Эллипс' }[it.type];
  const n = (k, v, step = 1, min = -1000, max = 2000) => `<input type="number" data-p="${k}" value="${Math.round(v * 10) / 10}" step="${step}" min="${min}" max="${max}" style="width:64px">`;
  let html = row('X / Y, мм', `<span>${n('x', it.x)} ${n('y', it.y)}</span>`) + row('Ш / В, мм', `<span>${n('w', it.w, 1, 1)} ${n('h', it.h, 1, 1)}</span>`);
  if (it.type === 'text') {
    html += `<textarea data-p="text" rows="3">${esc(it.text)}</textarea>`;
    html += row('Шрифт', `<select data-p="font">${FONTS.map(([v, t]) => `<option value="${esc(v)}"${v === it.font ? ' selected' : ''}>${t}</option>`).join('')}</select>`);
    html += row('Кегль, пт', n('size', it.size, 1, 4, 400));
    html += row('Цвет', `<input type="color" data-p="color" value="${it.color}">`);
    html += row('Выравнивание', `<span class="seg">${[['left', '⯇'], ['center', '≡'], ['right', '⯈'], ['justify', '☰']].map(([v, t]) => `<button data-align="${v}" class="${it.align === v ? 'primary' : ''}" title="${v}">${t}</button>`).join('')}</span>`);
    html += row('Начертание', `<span><label><input type="checkbox" data-p="bold"${it.bold ? ' checked' : ''}> Ж</label> <label><input type="checkbox" data-p="italic"${it.italic ? ' checked' : ''}> <i>К</i></label></span>`);
    html += row('Интерлиньяж', n('lh', it.lh, 0.1, 0.8, 3));
    html += row(`<label><input type="checkbox" data-p="bgOn"${it.bg ? ' checked' : ''}> Подложка</label>`, `<input type="color" data-p="bg" value="${it.bg || '#fff4e0'}">`);
  } else if (it.type === 'image') {
    html += row('Вписать', `<select data-p="fit"><option value="cover"${it.fit !== 'contain' ? ' selected' : ''}>Заполнить рамку</option><option value="contain"${it.fit === 'contain' ? ' selected' : ''}>Целиком</option></select>`);
    html += row('Скругление, мм', n('radius', it.radius || 0, 1, 0, 500));
    html += '<button data-action="replaceImage">Заменить картинку…</button>';
  } else {
    html += row(`<label><input type="checkbox" data-p="fillOn"${it.fill ? ' checked' : ''}> Заливка</label>`, `<input type="color" data-p="fill" value="${it.fill || '#ff7a59'}">`);
    html += row(`<label><input type="checkbox" data-p="strokeOn"${it.stroke ? ' checked' : ''}> Обводка</label>`, `<input type="color" data-p="stroke" value="${it.stroke || '#12253d'}">`);
    html += row('Толщина, пт', n('sw', it.sw || 1, 0.5, 0.25, 100));
    if (it.type === 'rect') html += row('Скругление, мм', n('radius', it.radius || 0, 1, 0, 500));
  }
  html += row('Непрозрачность', `<input type="range" data-p="opacity" min="0" max="1" step="0.05" value="${it.opacity ?? 1}">`);
  html += `<div class="layer-actions"><button data-action="toBack" title="На задний план">⤓</button><button data-action="toFront" title="На передний план">⤒</button>
    <button data-action="duplicate" title="Дублировать">⧉</button><button data-action="remove" title="Удалить">🗑</button></div>`;
  box.innerHTML = html;
  for (const input of box.querySelectorAll('[data-p]')) {
    const ev = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(ev, () => {
      beginEdit();
      const p = input.dataset.p;
      if (p === 'bgOn') it.bg = input.checked ? box.querySelector('[data-p=bg]').value : null;
      else if (p === 'fillOn') it.fill = input.checked ? box.querySelector('[data-p=fill]').value : null;
      else if (p === 'strokeOn') it.stroke = input.checked ? box.querySelector('[data-p=stroke]').value : null;
      else if (input.type === 'checkbox') it[p] = input.checked;
      else if (input.type === 'number' || input.type === 'range') {
        const v = Number(input.value);
        if (Number.isFinite(v)) it[p] = ['w', 'h'].includes(p) ? Math.max(1, v) : v;
      } else it[p] = input.value;
      if (p === 'bg') { it.bg = input.value; box.querySelector('[data-p=bgOn]').checked = true; }
      if (p === 'fill') { it.fill = input.value; box.querySelector('[data-p=fillOn]').checked = true; }
      if (p === 'stroke') { it.stroke = input.value; box.querySelector('[data-p=strokeOn]').checked = true; }
      render();
    });
    input.addEventListener('change', () => { editing = false; renderPageList(); });
  }
  for (const b of box.querySelectorAll('[data-align]')) {
    b.addEventListener('click', () => {
      pushHistory();
      it.align = b.dataset.align;
      renderAll();
    });
  }
}

/* ---------------- История ---------------- */

const hist = { undo: [], redo: [] };
let editing = false;
const snap = () => JSON.stringify({ size: state.size, pages: state.pages, sel: state.sel, curPage: state.curPage });

function pushHistory() {
  hist.undo.push(snap());
  if (hist.undo.length > 100) hist.undo.shift();
  hist.redo.length = 0;
  state.dirty = true;
  updateHistoryButtons();
}

function beginEdit() {
  if (!editing) { pushHistory(); editing = true; }
}

function applySnap(s) {
  const d = JSON.parse(s);
  Object.assign(state, { size: d.size, pages: d.pages, sel: d.sel, curPage: clamp(d.curPage, 0, d.pages.length - 1) });
  renderAll();
}

function undo() {
  if (!hist.undo.length) return;
  hist.redo.push(snap());
  applySnap(hist.undo.pop());
  updateHistoryButtons();
}

function redo() {
  if (!hist.redo.length) return;
  hist.undo.push(snap());
  applySnap(hist.redo.pop());
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('#undoBtn').disabled = !hist.undo.length;
  $('#redoBtn').disabled = !hist.redo.length;
}

/* ---------------- Мышь ---------------- */

let drag = null;

function pagePoint(e, pageIndex) {
  const el = pagesBox.querySelector(`.page[data-page="${pageIndex}"]`);
  const r = el.getBoundingClientRect();
  return { x: (e.clientX - r.left) / (MM * state.zoom), y: (e.clientY - r.top) / (MM * state.zoom) };
}

/** Прилипание к краям, центру и полям страницы и к другим объектам. */
function snapBox(page, it, x, y) {
  const th = 6 / (MM * state.zoom);
  const W = state.size.w, H = state.size.h;
  const xs = [0, MARGIN, W / 2, W - MARGIN, W], ys = [0, MARGIN, H / 2, H - MARGIN, H];
  for (const o of page.items) {
    if (o.id === it.id) continue;
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const best = (pos, size, cands) => {
    let d = th, out = null, line = null;
    for (const [k, off] of [[0, 0], [1, size / 2], [2, size]]) {
      for (const c of cands) {
        if (Math.abs(pos + off - c) < d) { d = Math.abs(pos + off - c); out = c - off; line = c; }
      }
    }
    return [out ?? pos, line];
  };
  const [nx, gx] = best(x, it.w, xs);
  const [ny, gy] = best(y, it.h, ys);
  return { x: nx, y: ny, gx, gy };
}

function showGuides(pageIndex, gx, gy) {
  const el = pagesBox.querySelector(`.page[data-page="${pageIndex}"]`);
  el.querySelectorAll('.snap-guide').forEach((g) => g.remove());
  const { L } = unitFns('screen');
  if (gx !== null && gx !== undefined) {
    const g = document.createElement('div');
    g.className = 'snap-guide v';
    g.style.left = L(gx);
    el.appendChild(g);
  }
  if (gy !== null && gy !== undefined) {
    const g = document.createElement('div');
    g.className = 'snap-guide h';
    g.style.top = L(gy);
    el.appendChild(g);
  }
}

let pendingImageAt = null;

pagesBox.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const pageEl = e.target.closest('.page');
  if (e.target.closest('[contenteditable="true"]')) return;
  if (!pageEl) { if (state.sel) { state.sel = null; renderAll(); } return; }
  const pi = Number(pageEl.dataset.page);
  const page = state.pages[pi];
  const p = pagePoint(e, pi);
  if (state.curPage !== pi) { state.curPage = pi; renderPageList(); }
  const handle = e.target.closest('[data-h]');
  const itemEl = e.target.closest('.item');

  if (state.tool === 'select') {
    if (handle && state.sel) {
      const it = findItem();
      pushHistory();
      drag = { type: 'resize', h: handle.dataset.h, it, orig: { ...it }, start: p, page, pi, moved: false };
    } else if (itemEl) {
      state.sel = { page: pi, id: Number(itemEl.dataset.id) };
      const it = findItem();
      pushHistory();
      drag = { type: 'move', it, orig: { ...it }, start: p, page, pi, moved: false };
      render();
      renderProps();
    } else {
      state.sel = null;
      renderAll();
      return;
    }
    pagesBox.setPointerCapture(e.pointerId);
    return;
  }
  if (state.tool === 'image') {
    pendingImageAt = { pi, x: p.x, y: p.y };
    $('#fileImage').click();
    return;
  }
  // Новый объект.
  pushHistory();
  const it = state.tool === 'text'
    ? text(p.x, p.y, 0, 0, 'Новый текст', { size: 14 })
    : box(state.tool, p.x, p.y, 0, 0, { fill: '#7c5cff' });
  it.id = nextId++;
  page.items.push(it);
  state.sel = { page: pi, id: it.id };
  drag = { type: 'create', it, start: p, page, pi };
  pagesBox.setPointerCapture(e.pointerId);
  render();
});

pagesBox.addEventListener('pointermove', (e) => {
  const pageEl = e.target.closest && e.target.closest('.page');
  if (pageEl && !drag) {
    const p = pagePoint(e, Number(pageEl.dataset.page));
    $('#statusCoords').textContent = `X: ${p.x.toFixed(1)} мм  Y: ${p.y.toFixed(1)} мм`;
  }
  if (!drag) return;
  const p = pagePoint(e, drag.pi);
  const it = drag.it, o = drag.orig;
  if (drag.type === 'move') {
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) * MM * state.zoom < 3) return;
    drag.moved = true;
    const s = e.altKey ? { x: o.x + dx, y: o.y + dy } : snapBox(drag.page, it, o.x + dx, o.y + dy);
    it.x = s.x;
    it.y = s.y;
    render();
    showGuides(drag.pi, s.gx, s.gy);
  } else if (drag.type === 'resize') {
    drag.moved = true;
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (drag.h.includes('w')) x1 = Math.min(p.x, x2 - 2);
    if (drag.h.includes('e')) x2 = Math.max(p.x, x1 + 2);
    if (drag.h.includes('n')) y1 = Math.min(p.y, y2 - 2);
    if (drag.h.includes('s')) y2 = Math.max(p.y, y1 + 2);
    if ((e.shiftKey || it.type === 'image') && drag.h.length === 2) {
      const k = Math.max((x2 - x1) / o.w, (y2 - y1) / o.h);
      if (drag.h.includes('w')) x1 = x2 - o.w * k; else x2 = x1 + o.w * k;
      if (drag.h.includes('n')) y1 = y2 - o.h * k; else y2 = y1 + o.h * k;
    }
    Object.assign(it, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    render();
  } else if (drag.type === 'create') {
    let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (e.shiftKey) {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * s;
      dy = Math.sign(dy || 1) * s;
    }
    Object.assign(it, {
      x: Math.min(drag.start.x, drag.start.x + dx), y: Math.min(drag.start.y, drag.start.y + dy),
      w: Math.abs(dx), h: Math.abs(dy),
    });
    render();
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
  if (d.type === 'create') {
    const it = d.it;
    if (it.w < 3 || it.h < 3) Object.assign(it, it.type === 'text' ? { w: 80, h: 20 } : { w: 40, h: 40 });
    setTool('select');
    if (it.type === 'text') {
      renderAll();
      startTextEdit(it);
      return;
    }
  }
  renderAll();
}
pagesBox.addEventListener('pointerup', endDrag);
pagesBox.addEventListener('pointercancel', endDrag);

pagesBox.addEventListener('dblclick', (e) => {
  const itemEl = e.target.closest('.item.text');
  if (!itemEl) return;
  const pi = Number(itemEl.closest('.page').dataset.page);
  state.sel = { page: pi, id: Number(itemEl.dataset.id) };
  startTextEdit(findItem());
});

function startTextEdit(it) {
  const el = pagesBox.querySelector(`.item[data-id="${it.id}"]`);
  if (!el) return;
  el.querySelectorAll('.h').forEach((h) => h.remove());
  el.contentEditable = 'true';
  el.classList.add('editing');
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(range);
  el.addEventListener('paste', (ev) => {
    ev.preventDefault();
    document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'));
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') el.blur();
    ev.stopPropagation();
  });
  el.addEventListener('blur', () => {
    const t = el.innerText.replace(/\n$/, '');
    if (t !== it.text) {
      pushHistory();
      it.text = t;
    }
    renderAll();
  }, { once: true });
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

async function addImage(file, at) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { status('Поддерживаются PNG, JPG, GIF и WebP.'); return; }
  const src = await readDataUrl(file);
  const img = await loadImage(src);
  const id = 'img' + nextId++;
  state.images[id] = src;
  const pi = at ? at.pi : state.curPage;
  const maxW = state.size.w * 0.6, maxH = state.size.h * 0.5;
  const k = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
  const w = img.naturalWidth * k, h = img.naturalHeight * k;
  pushHistory();
  const it = { type: 'image', img: id, x: at ? at.x : (state.size.w - w) / 2, y: at ? at.y : (state.size.h - h) / 2, w, h, fit: 'cover', radius: 0, opacity: 1, id: nextId++ };
  state.pages[pi].items.push(it);
  state.sel = { page: pi, id: it.id };
  setTool('select');
  renderAll();
}

function serialize() {
  const used = new Set();
  for (const p of state.pages) for (const it of p.items) if (it.type === 'image') used.add(it.img);
  return {
    format: 'verstka', version: VERSTKA_VERSION, app: 'Вёрстка', size: state.size,
    images: Object.fromEntries([...used].filter((id) => state.images[id]).map((id) => [id, state.images[id]])),
    pages: state.pages.map((p) => ({ bg: p.bg, items: p.items.map(({ id, ...rest }) => rest) })),
  };
}

function saveVerstka() {
  const name = state.docName + '.verstka';
  const blob = new Blob([JSON.stringify(serialize())], { type: 'application/octet-stream' });
  Fleet.download(blob, name);
  Fleet.addRecent(name, 'verstka', blob, Fleet.thumbOf(pageCanvas(0, 240 / Math.max(state.size.w, state.size.h))));
  state.dirty = false;
  status(`⚓ Сохранено: ${name}`);
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;

function sanitizeItem(src, images) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const col = (v) => (typeof v === 'string' && COLOR_RE.test(v) ? v : null);
  if (!src || !['text', 'image', 'rect', 'ellipse'].includes(src.type)) return null;
  const it = {
    id: nextId++, type: src.type, x: num(src.x, 0), y: num(src.y, 0),
    w: clamp(num(src.w, 20), 1, 5000), h: clamp(num(src.h, 20), 1, 5000), opacity: clamp(num(src.opacity, 1), 0, 1),
  };
  if (src.type === 'text') {
    Object.assign(it, {
      text: String(src.text ?? '').slice(0, 20000), font: FONTS.some(([f]) => f === src.font) ? src.font : FONTS[0][0],
      size: clamp(num(src.size, 14), 4, 400), color: col(src.color) || '#1d1d1f',
      align: ['left', 'center', 'right', 'justify'].includes(src.align) ? src.align : 'left',
      bold: !!src.bold, italic: !!src.italic, lh: clamp(num(src.lh, 1.3), 0.8, 3), bg: col(src.bg),
    });
  } else if (src.type === 'image') {
    if (!images[src.img]) return null;
    Object.assign(it, { img: src.img, fit: src.fit === 'contain' ? 'contain' : 'cover', radius: clamp(num(src.radius, 0), 0, 500) });
  } else {
    Object.assign(it, { fill: col(src.fill), stroke: col(src.stroke), sw: clamp(num(src.sw, 1), 0.25, 100), radius: clamp(num(src.radius, 0), 0, 500) });
  }
  return it;
}

async function openVerstka(file) {
  let doc;
  try { doc = JSON.parse(await file.text()); } catch (_) { throw new Error('Файл .verstka повреждён'); }
  if (!doc || doc.format !== 'verstka' || !Array.isArray(doc.pages) || !doc.pages.length) throw new Error('Это не файл Вёрстки (.verstka)');
  if (doc.version > VERSTKA_VERSION) throw new Error('Файл создан более новой версией Вёрстки — обновите страницу');
  if (!confirmDiscard()) return;
  const images = {};
  for (const [id, src] of Object.entries(doc.images || {})) {
    if (typeof src === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(src)) images[id] = src;
  }
  const w = clamp(Number(doc.size && doc.size.w) || 210, 20, 2000), h = clamp(Number(doc.size && doc.size.h) || 297, 20, 2000);
  loadDoc({ w, h }, doc.pages.slice(0, 200).map((p) => ({
    bg: COLOR_RE.test(p.bg) ? p.bg : '#ffffff',
    items: (Array.isArray(p.items) ? p.items : []).map((it) => sanitizeItem(it, images)).filter(Boolean),
  })), images);
  state.docName = Fleet.baseName(file.name) || 'verstka';
  Fleet.addRecent(file.name, 'verstka', file, Fleet.thumbOf(pageCanvas(0, 240 / Math.max(w, h))));
  status(`⚓ Открыт ${file.name}: страниц ${state.pages.length}`);
}

function loadDoc(size, pages, images = {}) {
  Object.assign(state, { size, pages, images, sel: null, curPage: 0, dirty: false });
  hist.undo.length = hist.redo.length = 0;
  updateHistoryButtons();
  fit();
  renderAll();
}

function confirmDiscard() {
  return !state.dirty || confirm('Несохранённые изменения будут потеряны. Продолжить?');
}

async function openFile(file) {
  try {
    const ext = Fleet.extOf(file.name);
    if (ext === 'verstka') return await openVerstka(file);
    const app = Fleet.appForFile(file.name, file.type);
    if (app && app.id === 'photo' && ext !== 'photik') return await addImage(file);
    if (app) {
      if (confirmDiscard()) await Fleet.openIn(file, app.id);
      return;
    }
    status(`Не знаю такой формат: ${file.name}`);
  } catch (err) {
    status(err.message);
  }
}

/* ---------------- Печать ---------------- */

function printDoc() {
  const area = $('#printArea');
  area.innerHTML = '';
  state.pages.forEach((p, i) => area.appendChild(pageEl(p, i, 'print')));
  $('#pageStyle').textContent = `@page { size: ${state.size.w}mm ${state.size.h}mm; margin: 0; }`;
  setTimeout(() => {
    window.print();
    setTimeout(() => { area.innerHTML = ''; }, 500);
  }, 100);
}

/* ---------------- Вид ---------------- */

function fit() {
  // Страница целиком в окне: по ширине и по высоте.
  const zw = (area.clientWidth - 80) / (state.size.w * MM);
  const zh = (area.clientHeight - 90) / (state.size.h * MM);
  state.zoom = clamp(Math.min(zw, zh), 0.1, 2);
}

function setZoom(z) {
  state.zoom = clamp(z, 0.1, 4);
  render();
}

function setTool(tool) {
  state.tool = tool;
  for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  $('#optToolName').textContent = TOOL_NAMES[tool];
  $('#toolHint').textContent = TOOL_HINTS[tool];
  area.dataset.cursor = tool === 'select' ? '' : 'crosshair';
}

/* ---------------- Действия ---------------- */

function reorder(toFront) {
  const it = findItem();
  if (!it) return;
  const items = state.pages[state.sel.page].items;
  pushHistory();
  items.splice(items.indexOf(it), 1);
  if (toFront) items.push(it); else items.unshift(it);
  renderAll();
}

const actions = {
  new() {
    openModal({
      title: 'Новый документ',
      fields: [{ key: 't', label: 'Шаблон', type: 'select', value: 'card', options: Object.entries(TEMPLATES).map(([k, v]) => [k, v.name]) }],
      okText: 'Создать',
      onOk: ({ t }) => {
        if (!confirmDiscard()) return;
        const tpl = TEMPLATES[t];
        loadDoc({ ...tpl.size }, withIds(tpl.pages()));
        state.docName = 'verstka';
      },
    });
  },
  open: () => $('#fileOpen').click(),
  save: saveVerstka,
  print: printDoc,
  exportPng() {
    openModal({
      title: 'Экспорт страницы PNG',
      fields: [
        { key: 'page', label: 'Страница', value: state.curPage + 1, min: 1, max: state.pages.length },
        { key: 'dpi', label: 'Качество', type: 'select', value: '150', options: [['96', 'Для экрана (96 dpi)'], ['150', 'Хорошее (150 dpi)'], ['300', 'Для печати (300 dpi)']] },
      ],
      okText: 'Сохранить',
      onOk: ({ page, dpi }) => {
        const i = clamp(Math.round(page) - 1, 0, state.pages.length - 1);
        pageCanvas(i, Number(dpi) / 25.4).toBlob((b) => Fleet.download(b, `${state.docName}-page${i + 1}.png`), 'image/png');
      },
    });
  },
  async toPhoto() {
    if (!confirmDiscard()) return;
    const c = pageCanvas(state.curPage, 150 / 25.4);
    await Fleet.openIn(new File([Fleet.makePhotik(c.width, c.height, [{ name: `Страница ${state.curPage + 1}`, canvas: c }])], state.docName + '.photik'), 'photo');
  },
  harbor: () => { location.href = 'index.html'; },
  undo, redo,
  duplicate() {
    const it = findItem();
    if (!it) return;
    pushHistory();
    const c = { ...it, id: nextId++, x: it.x + 5, y: it.y + 5 };
    state.pages[state.sel.page].items.push(c);
    state.sel = { page: state.sel.page, id: c.id };
    renderAll();
  },
  remove() {
    const it = findItem();
    if (!it) return;
    pushHistory();
    const items = state.pages[state.sel.page].items;
    items.splice(items.indexOf(it), 1);
    state.sel = null;
    renderAll();
  },
  toFront: () => reorder(true),
  toBack: () => reorder(false),
  addPage() {
    pushHistory();
    state.pages.splice(state.curPage + 1, 0, { bg: '#ffffff', items: [] });
    state.curPage++;
    renderAll();
    pagesBox.children[state.curPage]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  dupPage() {
    pushHistory();
    const src = state.pages[state.curPage];
    state.pages.splice(state.curPage + 1, 0, { bg: src.bg, items: src.items.map((it) => ({ ...it, id: nextId++ })) });
    state.curPage++;
    renderAll();
  },
  delPage() {
    if (state.pages.length < 2) { status('Нельзя удалить единственную страницу.'); return; }
    pushHistory();
    state.pages.splice(state.curPage, 1);
    state.curPage = Math.min(state.curPage, state.pages.length - 1);
    state.sel = null;
    renderAll();
  },
  pageUp() {
    const i = state.curPage;
    if (i <= 0) return;
    pushHistory();
    [state.pages[i - 1], state.pages[i]] = [state.pages[i], state.pages[i - 1]];
    state.curPage--;
    state.sel = null;
    renderAll();
  },
  pageDown() {
    const i = state.curPage;
    if (i >= state.pages.length - 1) return;
    pushHistory();
    [state.pages[i + 1], state.pages[i]] = [state.pages[i], state.pages[i + 1]];
    state.curPage++;
    state.sel = null;
    renderAll();
  },
  docSize() {
    openModal({
      title: 'Размер страниц',
      fields: [
        { key: 'preset', label: 'Формат', type: 'select', value: '', options: [
          ['', '— свой —'], ['210x297', 'A4 книжный'], ['297x210', 'A4 альбомный'], ['148x210', 'A5'], ['148x105', 'Открытка A6'],
          ['297x420', 'Плакат A3'], ['200x200', 'Квадрат'], ['90x50', 'Визитка'],
        ] },
        { key: 'w', label: 'Ширина', value: state.size.w, min: 20, max: 2000, suffix: 'мм' },
        { key: 'h', label: 'Высота', value: state.size.h, min: 20, max: 2000, suffix: 'мм' },
      ],
      onInput: (v, input, inputs) => {
        if (input === inputs.preset.input && v.preset) {
          const [w, h] = v.preset.split('x');
          inputs.w.input.value = w;
          inputs.h.input.value = h;
        }
      },
      onOk: ({ w, h }) => {
        pushHistory();
        state.size = { w: clamp(Math.round(w) || 210, 20, 2000), h: clamp(Math.round(h) || 297, 20, 2000) };
        fit();
        renderAll();
      },
    });
  },
  replaceImage: () => { pendingImageAt = 'replace'; $('#fileImage').click(); },
  zoomIn: () => setZoom(state.zoom * 1.2),
  zoomOut: () => setZoom(state.zoom / 1.2),
  fit: () => { fit(); render(); },
  toggleGuides: () => { state.guides = !state.guides; render(); },
  shortcuts() {
    const rows = [
      ['V / T / I / R / O', 'Выбор / Текст / Картинка / Прямоугольник / Эллипс'], ['Двойной клик', 'Править текст на месте'],
      ['Alt при перетаскивании', 'Без прилипания'], ['Shift', 'Пропорции / квадрат'], ['Стрелки', 'Сдвиг на 1 мм (Shift — 10 мм)'],
      ['Ctrl+D', 'Дублировать'], ['Del', 'Удалить'], ['Shift+[ / Shift+]', 'На задний / передний план'],
      ['Ctrl+P', 'Печать / PDF'], ['Ctrl+Z / Ctrl+Shift+Z', 'Отменить / повторить'], ['Ctrl+S', 'Сохранить .verstka'],
    ];
    openModal({ title: 'Горячие клавиши', html: '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>', cancel: false });
  },
  about() {
    openModal({
      title: 'Вёрстка',
      html: `<p><b>Вёрстка</b> — программа для макетов из набора PhipiShip Флот: открытки, плакаты, буклеты,
        визитки и многостраничные документы. Размеры — в миллиметрах, как в типографии.</p>
        <p>Документ хранится в формате <b>.verstka</b>. Чтобы получить PDF, выберите «Печать» и «Сохранить как PDF».</p>`,
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
Fleet.mountSwitcher('verstka');
for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));

$('#fileOpen').accept = Fleet.ACCEPT_ALL;
$('#fileOpen').addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('#fileImage').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  const at = pendingImageAt;
  pendingImageAt = null;
  if (!f) return;
  try {
    if (at === 'replace') {
      const it = findItem();
      if (!it || it.type !== 'image') return;
      const id = 'img' + nextId++;
      state.images[id] = await readDataUrl(f);
      pushHistory();
      it.img = id;
      renderAll();
    } else {
      await addImage(f, at);
    }
  } catch (err) {
    status(err.message);
  }
});

area.addEventListener('dragover', (e) => { e.preventDefault(); });
area.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});
area.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(state.zoom * Math.exp(-e.deltaY * 0.002));
}, { passive: false });

window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });

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
  if (e.target.isContentEditable || e.target.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod) {
    const map = {
      z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'save', o: 'open', d: 'duplicate', p: 'print',
      '0': 'fit', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut',
    };
    if (map[k]) { e.preventDefault(); runAction(map[k]); }
    return;
  }
  if (e.key === 'Escape') { closeMenus(); state.sel = null; renderAll(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); runAction('remove'); return; }
  if (e.code === 'BracketRight' && e.shiftKey) { runAction('toFront'); return; }
  if (e.code === 'BracketLeft' && e.shiftKey) { runAction('toBack'); return; }
  if (e.key === 'Enter' && findItem() && findItem().type === 'text') { e.preventDefault(); startTextEdit(findItem()); return; }
  if (e.key.startsWith('Arrow') && findItem()) {
    e.preventDefault();
    const it = findItem();
    const step = e.shiftKey ? 10 : 1;
    pushHistory();
    it.x += e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    it.y += e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    renderAll();
    return;
  }
  if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});

setTool('select');
loadDoc({ ...TEMPLATES.card.size }, withIds(TEMPLATES.card.pages()));
Fleet.takeHandoff().then((file) => { if (file) openFile(file); });
