'use strict';

/* =========================================================
   Общий интерфейс программ флота (Анимка, Контур):
   меню, модальные окна, подсказки, масштаб холста, цвета.
   ========================================================= */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let msgTimer = 0;
function status(msg) {
  const el = $('#statusMsg');
  el.textContent = msg;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (el.textContent = ''), 3500);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    const img = new Image();
    img.onload = () => { if (typeof src !== 'string') URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { if (typeof src !== 'string') URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать изображение')); };
    img.src = url;
  });
}

function bindRange(id, out, fmt, apply) {
  const input = $(id);
  const o = out && $(out);
  const sync = () => {
    apply(Number(input.value));
    if (o) o.textContent = fmt(input.value);
  };
  input.addEventListener('input', sync);
  sync();
  return (v) => { input.value = v; sync(); };
}

/* ---------- Модальное окно ---------- */

let modalHandlers = null;

function openModal({ title, fields = [], html, onInput, onOk, onCancel, okText = 'OK', cancel = true }) {
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
      input.style.cssText = 'grid-column: span 2; resize: vertical;';
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#modalForm').requestSubmit();
      });
    } else {
      input = document.createElement('input');
      input.type = f.type || 'number';
      if (f.type === 'checkbox') input.checked = !!f.value;
      else input.value = f.value;
      for (const k of ['min', 'max', 'step']) if (f[k] !== undefined) input[k] = f[k];
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
      else if (f.type === 'select' || f.type === 'textarea' || f.type === 'text') v[k] = input.value;
      else v[k] = Number(input.value);
    }
    return v;
  };
  for (const { input, out, f } of Object.values(inputs)) {
    input.addEventListener('input', () => {
      if (out && f.type === 'range') out.textContent = input.value;
      if (onInput) onInput(values(), input, inputs);
    });
  }
  $('#modalOk').textContent = okText;
  $('#modalCancel').hidden = !cancel;
  modalHandlers = { onOk: () => onOk && onOk(values()), onCancel };
  $('#modal').hidden = false;
  const first = body.querySelector('input, select, textarea');
  (first || $('#modalOk')).focus();
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

const modalOpen = () => !$('#modal').hidden;

function initModal() {
  $('#modalForm').addEventListener('submit', (e) => {
    e.preventDefault();
    closeModal(true);
  });
  $('#modalCancel').onclick = () => closeModal(false);
  $('#modal').addEventListener('pointerdown', (e) => {
    if (e.target.id === 'modal') closeModal(false);
  });
}

/* ---------- Меню ---------- */

function closeMenus() {
  $$('.menu.open').forEach((m) => m.classList.remove('open'));
  $$('.dropdown.show').forEach((d) => d.classList.remove('show'));
}

function initMenus(runAction) {
  const openMenu = (menu) => {
    const r = menu.querySelector('.menu-title').getBoundingClientRect();
    const dd = menu.dropdown;
    menu.classList.add('open');
    dd.classList.add('show');
    dd.style.top = r.bottom + 6 + 'px';
    dd.style.left = Math.max(8, Math.min(r.left, window.innerWidth - dd.offsetWidth - 8)) + 'px';
  };
  for (const menu of $$('.menu')) {
    // В body: backdrop-filter у строки меню ломает position: fixed.
    menu.dropdown = menu.querySelector('.dropdown');
    document.body.appendChild(menu.dropdown);
    menu.querySelector('.menu-title').addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = menu.classList.contains('open');
      closeMenus();
      if (!wasOpen) openMenu(menu);
    });
    menu.addEventListener('mouseenter', () => {
      if ($('.menu.open') && !menu.classList.contains('open')) {
        closeMenus();
        openMenu(menu);
      }
    });
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    closeMenus();
    if (btn) runAction(btn.dataset.action);
  });
}

/* ---------- Подсказки у инструментов и панель на телефоне ---------- */

function initTooltips() {
  let tipEl = null;
  for (const b of $$('.toolbar [data-tool]')) {
    const m = b.title.match(/^(.*?)\s*\((.*)\)$/);
    const name = m ? m[1] : b.title, key = m ? m[2] : '';
    b.setAttribute('aria-label', b.title);
    b.removeAttribute('title');
    b.addEventListener('mouseenter', () => {
      const r = b.getBoundingClientRect();
      tipEl = document.createElement('div');
      tipEl.className = 'tip';
      tipEl.textContent = name;
      if (key) {
        const k = document.createElement('kbd');
        k.textContent = key;
        tipEl.appendChild(k);
      }
      tipEl.style.left = r.right + 10 + 'px';
      tipEl.style.top = r.top + r.height / 2 + 'px';
      document.body.appendChild(tipEl);
    });
    b.addEventListener('mouseleave', () => { if (tipEl) tipEl.remove(); tipEl = null; });
  }
  $('#panelToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    document.body.classList.toggle('panel-open');
  });
}

/* ---------- Масштаб и прокрутка холста ---------- */

function createView(viewport, stage, getSize, onChange) {
  const v = { zoom: 1, panX: 0, panY: 0 };
  v.apply = () => {
    stage.style.transform = `translate(${v.panX}px, ${v.panY}px) scale(${v.zoom})`;
    $('#zoomLabel').textContent = Math.round(v.zoom * 100) + '%';
    if (onChange) onChange(v);
  };
  v.fit = () => {
    const r = viewport.getBoundingClientRect();
    const { w, h } = getSize();
    v.zoom = Math.min(1, (r.width - 48) / w, (r.height - 48) / h);
    if (!(v.zoom > 0)) v.zoom = 1;
    v.panX = (r.width - w * v.zoom) / 2;
    v.panY = (r.height - h * v.zoom) / 2;
    v.apply();
  };
  v.zoomAt = (factor, cx, cy) => {
    const r = viewport.getBoundingClientRect();
    if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
    const nz = clamp(v.zoom * factor, 0.05, 32);
    v.panX = cx - ((cx - v.panX) * nz) / v.zoom;
    v.panY = cy - ((cy - v.panY) * nz) / v.zoom;
    v.zoom = nz;
    v.apply();
  };
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    v.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // Два пальца — масштаб и прокрутка.
  const touches = new Map();
  let pinch = null;
  v.touches = touches;
  v.pinching = () => !!pinch;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        zoom: v.zoom, panX: v.panX, panY: v.panY,
      };
      if (v.onPinchStart) v.onPinchStart();
    }
  }, true);
  viewport.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinch || touches.size < 2) return;
    const [a, b] = [...touches.values()];
    const r = viewport.getBoundingClientRect();
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const nz = clamp((pinch.zoom * dist) / pinch.dist, 0.05, 32);
    v.panX = mid.x - r.left - ((pinch.mid.x - r.left - pinch.panX) * nz) / pinch.zoom;
    v.panY = mid.y - r.top - ((pinch.mid.y - r.top - pinch.panY) * nz) / pinch.zoom;
    v.zoom = nz;
    v.apply();
  }, true);
  const end = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
  };
  viewport.addEventListener('pointerup', end, true);
  viewport.addEventListener('pointercancel', end, true);
  return v;
}

/* ---------- Цвета ---------- */

const PALETTE = [
  '#000000', '#3a3a3a', '#7a7a7a', '#b5b5b5', '#ffffff', '#5b3a29', '#a0522d', '#d2a679', '#f5deb3', '#fff4e0',
  '#e53935', '#fb8c00', '#fdd835', '#7cb342', '#43a047', '#00897b', '#039be5', '#3949ab', '#8e24aa', '#d81b60',
  '#ff8a80', '#ffd180', '#ffff8d', '#ccff90', '#a7ffeb', '#80d8ff', '#82b1ff', '#b388ff', '#ff80ab', '#7c5cff',
];

function buildPalette(el, onPrimary, onSecondary) {
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.style.background = c;
    b.title = c + ' (клик — основной, правый клик — второй)';
    b.onclick = () => onPrimary(c);
    b.oncontextmenu = (e) => { e.preventDefault(); onSecondary(c); };
    el.appendChild(b);
  }
}
