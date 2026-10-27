'use strict';

/* =========================================================
   PhipiShip Флот — общий модуль для всех программ набора:
   реестр программ и форматов, передача файла между программами,
   недавние файлы, темы и переключатель программ.
   ========================================================= */

const Fleet = (() => {
  const APPS = [
    {
      id: 'photo', name: 'PhipiShip Фото', short: 'Фото', ext: 'photik', page: 'photo.html', icon: 'logo.svg',
      color: '#ff7a59', what: 'Растровая графика',
      desc: 'Фотографии и рисунки: слои, кисти, выделение, градиенты, фильтры.',
    },
    {
      id: 'animka', name: 'Анимка', short: 'Анимка', ext: 'animka', page: 'animka.html', icon: 'icon-animka.svg',
      color: '#ff5f8f', what: 'Покадровая анимация',
      desc: 'Мультики по кадрам: калька, таймлайн, предпросмотр и экспорт в GIF.',
    },
    {
      id: 'kontur', name: 'Контур', short: 'Контур', ext: 'kontur', page: 'kontur.html', icon: 'icon-kontur.svg',
      color: '#14b8a6', what: 'Векторная графика',
      desc: 'Логотипы и иллюстрации из фигур и линий: масштаб без потери качества, экспорт в SVG.',
    },
  ];
  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico'];
  const RECENT_LIMIT = 12;

  const byId = (id) => APPS.find((a) => a.id === id);
  const extOf = (name) => (/\.([^.]+)$/.exec(name || '') || [])[1]?.toLowerCase() || '';
  const baseName = (name) => (name || '').replace(/\.[^.]+$/, '');

  /** Программа, которая открывает файл, — по расширению; обычные картинки идут в Фото. */
  function appForFile(name, type) {
    const ext = extOf(name);
    const app = APPS.find((a) => a.ext === ext);
    if (app) return app;
    if ((type && type.startsWith('image/')) || IMAGE_EXT.includes(ext)) return byId('photo');
    return null;
  }

  /* ---------- IndexedDB: передача файлов и недавние ---------- */

  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('phipiship-fleet', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('handoff');
          req.result.createObjectStore('recent', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }

  /** Открывает файл в подходящей программе (переходом на её страницу). */
  async function openIn(file, appId) {
    const app = appId ? byId(appId) : appForFile(file.name, file.type);
    if (!app) throw new Error(`Неизвестный формат: ${file.name}`);
    await tx('handoff', 'readwrite', (s) => s.put({ name: file.name, type: file.type, blob: file }, 'pending'));
    location.href = app.page + '?open=1';
  }

  /** Забирает файл, переданный этой странице через openIn. */
  async function takeHandoff() {
    if (!new URLSearchParams(location.search).has('open')) return null;
    window.history.replaceState(null, '', location.pathname); // в Фото есть своя переменная history
    try {
      const rec = await tx('handoff', 'readonly', (s) => s.get('pending'));
      await tx('handoff', 'readwrite', (s) => s.delete('pending'));
      return rec ? new File([rec.blob], rec.name, { type: rec.type || '' }) : null;
    } catch (_) {
      return null;
    }
  }

  async function addRecent(name, appId, blob, thumb) {
    try {
      const key = appId + ':' + name;
      await tx('recent', 'readwrite', (s) => s.put({ key, name, app: appId, time: Date.now(), size: blob.size, blob, thumb }));
      const all = await listRecent();
      for (const r of all.slice(RECENT_LIMIT)) await tx('recent', 'readwrite', (s) => s.delete(r.key));
    } catch (_) { /* приватный режим: недавние просто не запоминаются */ }
  }

  async function listRecent() {
    try {
      const all = await tx('recent', 'readonly', (s) => s.getAll());
      return all.sort((a, b) => b.time - a.time);
    } catch (_) {
      return [];
    }
  }

  async function openRecent(key) {
    const r = await tx('recent', 'readonly', (s) => s.get(key));
    if (!r) throw new Error('Файл больше не найден в недавних');
    await openIn(new File([r.blob], r.name), r.app);
  }

  function removeRecent(key) {
    return tx('recent', 'readwrite', (s) => s.delete(key));
  }

  /** Маленькое превью холста для списка недавних. */
  function thumbOf(canvas, max = 240) {
    const k = Math.min(1, max / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * k));
    c.height = Math.max(1, Math.round(canvas.height * k));
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  /* ---------- Файлы ---------- */

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** Собирает файл .photik (формат PhipiShip Фото) — для передачи из других программ. */
  function makePhotik(w, h, layers) {
    const doc = {
      format: 'photik', version: 1, app: 'PhipiShip', width: w, height: h, active: layers.length - 1,
      layers: layers.map((l) => ({
        name: l.name, visible: l.visible !== false, opacity: l.opacity ?? 1, blend: l.blend || 'source-over',
        png: l.canvas.toDataURL('image/png'),
      })),
    };
    return new Blob([JSON.stringify(doc)], { type: 'application/octet-stream' });
  }

  /** Строка accept для поля выбора файла: все форматы флота и картинки. */
  const ACCEPT_ALL = ['image/*', ...APPS.map((a) => '.' + a.ext)].join(',');

  /* ---------- Темы ---------- */

  const THEME_KEY = 'phipiship-theme';
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'ocean'; } catch (_) { return 'ocean'; }
  }
  function setTheme(name) {
    document.documentElement.dataset.theme = name;
    for (const b of document.querySelectorAll('[data-theme-pick]')) b.classList.toggle('active', b.dataset.themePick === name);
    try { localStorage.setItem(THEME_KEY, name); } catch (_) { /* приватный режим */ }
  }
  function initThemePicker() {
    for (const b of document.querySelectorAll('[data-theme-pick]')) b.addEventListener('click', () => setTheme(b.dataset.themePick));
    setTheme(getTheme());
  }
  // Сразу, ещё до отрисовки страницы, чтобы не мигала тема по умолчанию.
  document.documentElement.dataset.theme = getTheme();

  /* ---------- Переключатель программ ---------- */

  const GRID_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg>';

  function mountSwitcher(currentId) {
    const bar = document.querySelector('.menubar');
    const btn = document.createElement('button');
    btn.className = 'fleet-btn';
    btn.title = 'Программы PhipiShip Флот';
    btn.innerHTML = GRID_ICON;
    bar.insertBefore(btn, bar.firstChild);

    const pop = document.createElement('div');
    pop.className = 'fleet-pop';
    pop.innerHTML =
      '<a class="fleet-home" href="index.html"><img src="icon-fleet.svg" alt=""><span><b>Гавань</b><small>все программы и недавние файлы</small></span></a>' +
      APPS.map((a) => `<a href="${a.page}"${a.id === currentId ? ' class="current"' : ''}>
        <img src="${a.icon}" alt=""><span><b>${a.name}</b><small>${a.what} · .${a.ext}</small></span></a>`).join('');
    document.body.appendChild(pop);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = btn.getBoundingClientRect();
      pop.style.left = r.left + 'px';
      pop.style.top = r.bottom + 8 + 'px';
      pop.classList.toggle('show');
    });
    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target)) pop.classList.remove('show');
    });
  }

  return {
    APPS, byId, extOf, baseName, appForFile, openIn, takeHandoff, addRecent, listRecent, openRecent,
    removeRecent, thumbOf, download, makePhotik, ACCEPT_ALL, getTheme, setTheme, initThemePicker, mountSwitcher,
  };
})();
