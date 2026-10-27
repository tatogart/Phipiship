'use strict';

/* Гавань: меню всех программ флота, недавние файлы, открытие любого файла. */

const $ = (s) => document.querySelector(s);

const FORMAT_DETAILS = {
  photik: 'Слои с названиями, видимостью, прозрачностью и режимами наложения',
  animka: 'Кадры, скорость (кадров в секунду), фон и настройки кальки',
  kontur: 'Векторные фигуры, линии и текст с цветами и обводкой',
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
    '<span class="ext" style="--c:#64748b">картинки</span>';

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

Fleet.initThemePicker();
renderApps();

