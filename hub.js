'use strict';

/* Гавань: меню всех программ флота, недавние файлы, открытие любого файла. */

const $ = (s) => document.querySelector(s);

const FORMAT_DETAILS = {
  photik: 'Слои с названиями, видимостью, прозрачностью и режимами наложения',
  animka: 'Кадры, скорость (кадров в секунду), фон и настройки кальки',
  kontur: 'Векторные фигуры, линии и текст с цветами и обводкой',
  svet: 'Лента фотографий-оригиналов и настройки света и цвета для каждой',
  kadr: 'Видео, фото и музыка вместе с таймлайном: обрезка, титры, переходы',
  volna: 'Звук в формате WAV без потерь',
  verstka: 'Страницы в миллиметрах: текстовые блоки, картинки и фигуры',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function renderApps() {
  $('#apps').innerHTML = Fleet.APPS.map((a) => `
    <article class="app-card" style="--c:${a.color}">
      <header>
        <img src="${a.icon}" alt="">
        <div>
          <h3>${esc(a.name)}</h3>
          <div class="what">${esc(a.what)} · <span class="ext" style="--c:${a.color}">.${a.ext}</span></div>
        </div>
      </header>
      <p>${esc(a.desc)}</p>
      <div class="actions">
        <a class="launch" href="${a.page}">Запустить</a>
      </div>
    </article>`).join('');

  $('#formatsLine').innerHTML = Fleet.APPS.map((a) => `<span class="ext" style="--c:${a.color}">.${a.ext}</span>`).join('') +
    '<span class="ext" style="--c:#64748b">картинки, видео, звук</span>';

  $('#formats').innerHTML = Fleet.APPS.map((a) => `
    <tr>
      <td><span class="ext" style="--c:${a.color}">.${a.ext}</span></td>
      <td><img src="${a.icon}" alt="">${esc(a.name)}</td>
      <td>${esc(FORMAT_DETAILS[a.ext])}</td>
    </tr>`).join('') + `
    <tr>
      <td><span class="ext" style="--c:#64748b">.png .jpg .gif .webp</span></td>
      <td><img src="logo.svg" alt="">PhipiShip Фото</td>
      <td>Обычные картинки открываются как новый документ</td>
    </tr>
    <tr>
      <td><span class="ext" style="--c:#64748b">.mp4 .webm .mov</span></td>
      <td><img src="icon-kadr.svg" alt="">Кадр</td>
      <td>Видео добавляются на таймлайн нового фильма</td>
    </tr>
    <tr>
      <td><span class="ext" style="--c:#64748b">.mp3 .wav .ogg .m4a</span></td>
      <td><img src="icon-volna.svg" alt="">Волна</td>
      <td>Звук открывается для редактирования</td>
    </tr>`;
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return Math.round(s / 60) + ' мин назад';
  if (s < 86400) return Math.round(s / 3600) + ' ч назад';
  return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function fmtSize(b) {
  return b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ';
}

async function renderRecent() {
  const list = await Fleet.listRecent();
  const box = $('#recent');
  if (!list.length) {
    box.innerHTML = '<div class="recent-empty">Пока пусто. Сохраните или откройте проект в любой программе — он появится здесь.</div>';
    return;
  }
  box.innerHTML = '';
  for (const r of list) {
    const app = Fleet.byId(r.app) || Fleet.APPS[0];
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.tabIndex = 0;
    item.style.setProperty('--c', app.color);
    item.innerHTML = `
      <div class="thumb${r.thumb ? '' : ' empty'}"><img src="${r.thumb || app.icon}" alt=""></div>
      <div class="info">
        <div class="name" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="meta"><span class="ext" style="--c:${app.color}">.${app.ext}</span>${esc(app.short)} · ${timeAgo(r.time)} · ${fmtSize(r.size)}</div>
      </div>
      <button class="remove" title="Убрать из недавних">×</button>`;
    const open = () => Fleet.openRecent(r.key).catch((e) => toast(e.message));
    item.addEventListener('click', (e) => {
      if (e.target.closest('.remove')) return;
      open();
    });
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    item.querySelector('.remove').addEventListener('click', async () => {
      await Fleet.removeRecent(r.key);
      renderRecent();
    });
    box.appendChild(item);
  }
}

async function openAny(file) {
  const app = Fleet.appForFile(file.name, file.type);
  if (!app) {
    toast(`Не знаем такой формат: ${file.name}`);
    return;
  }
  toast(`Открываем в «${app.name}»…`);
  try {
    await Fleet.openIn(file, app.id);
  } catch (e) {
    toast(e.message);
  }
}

$('#fileAny').accept = Fleet.ACCEPT_ALL;
$('#openAny').addEventListener('click', () => $('#fileAny').click());
$('#fileAny').addEventListener('change', (e) => {
  if (e.target.files[0]) openAny(e.target.files[0]);
  e.target.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragover');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragover'); }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) openAny(f);
});

// Вернулись назад из программы — обновим список недавних.
window.addEventListener('pageshow', renderRecent);

/* ---------------- Работа без интернета ---------------- */

const isHttp = location.protocol.startsWith('http');
let installEvent = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('#installBtn').disabled = false;
  $('#installHint').textContent = '';
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  $('#installBtn').disabled = true;
  $('#installBtn').textContent = 'Установлено ✓';
  toast('Флот установлен — ищите значок с якорем');
});

function installHint() {
  const ua = navigator.userAgent;
  if (window.matchMedia('(display-mode: standalone)').matches) return 'Вы уже в установленном приложении.';
  if (!isHttp) return 'Установка доступна, когда Флот открыт с сайта (а не из файла на диске).';
  if (/iPhone|iPad|iPod/.test(ua)) return 'На iPhone и iPad: кнопка «Поделиться» → «На экран „Домой“».';
  if (/Firefox/.test(ua)) return 'Firefox не устанавливает сайты как приложения, но после первого открытия Флот и так работает без интернета.';
  return 'Если кнопка не активна — откройте меню браузера (⋮) → «Установить приложение» или «Добавить на главный экран».';
}

$('#installBtn').disabled = true;
$('#installHint').textContent = installHint();
$('#installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
});

async function checkOffline() {
  const el = $('#offlineStatus');
  if (!isHttp) { el.textContent = '✓ запущено с диска — интернет не нужен'; return; }
  if (!('caches' in window)) { el.textContent = 'браузер не умеет хранить программы — скачайте ZIP'; return; }
  try {
    const keys = await caches.keys();
    const key = keys.find((k) => k === 'phipiship-' + FLEET_VERSION);
    const cache = key && await caches.open(key);
    let n = 0;
    if (cache) for (const f of FLEET_FILES) if (await cache.match(f)) n++;
    el.textContent = n >= FLEET_FILES.length
      ? '✓ все программы сохранены в браузере и откроются без интернета'
      : `сохраняю программы для работы без интернета… ${n} из ${FLEET_FILES.length}`;
    if (n < FLEET_FILES.length) setTimeout(checkOffline, 1500);
  } catch (_) {
    el.textContent = 'не удалось проверить кэш';
  }
}

/* ZIP без сжатия (метод «store») — свой упаковщик, без библиотек. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);            // имена в UTF-8
    head.setUint16(10, dosTime, true);
    head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, f.data.length, true);
    head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true);
    parts.push(head, name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

const README_OFFLINE = `PhipiShip Флот — версия для работы без интернета
=================================================

Как запустить:
  1. Распакуйте архив в любую папку (например, на флешку).
  2. Откройте файл index.html двойным кликом — это Гавань со всеми программами.

Советы:
  • Лучше всего работает в Chrome, Edge или Яндекс Браузере.
  • Некоторые браузеры (например, Firefox) ограничивают страницы, открытые с диска:
    тогда передача файлов между программами и список «Недавние» могут не работать.
    Все программы при этом работают, а файлы открываются через «Файл → Открыть».
  • Чтобы всё работало полностью, можно запустить простой сервер в этой папке:
      python3 -m http.server
    и открыть в браузере http://localhost:8000

Все программы работают на вашем компьютере, файлы никуда не отправляются.
`;

$('#zipBtn').addEventListener('click', async () => {
  const btn = $('#zipBtn');
  btn.disabled = true;
  try {
    const files = [];
    for (const [i, name] of FLEET_FILES.entries()) {
      $('#zipInfo').textContent = `Собираю ${i + 1} из ${FLEET_FILES.length}: ${name}`;
      const res = await fetch(name, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`Не удалось получить ${name}`);
      files.push({ name: 'PhipiShip-Flot/' + name, data: new Uint8Array(await res.arrayBuffer()) });
    }
    files.push({ name: 'PhipiShip-Flot/КАК ЗАПУСТИТЬ.txt', data: new TextEncoder().encode(README_OFFLINE) });
    const zip = makeZip(files);
    Fleet.download(zip, 'PhipiShip-Flot.zip');
    $('#zipInfo').textContent = `Готово: ${files.length} файлов, ${(zip.size / 1048576).toFixed(1)} МБ`;
  } catch (e) {
    $('#zipInfo').textContent = isHttp ? e.message : 'Архив собирается, только когда Флот открыт с сайта.';
  }
  btn.disabled = false;
});

// Файлы флота, открытые двойным кликом в установленном приложении.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (params.files && params.files.length) openAny(await params.files[0].getFile());
  });
}

checkOffline();
if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('controllerchange', checkOffline);

Fleet.initThemePicker();
renderApps();

