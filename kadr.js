'use strict';

/* =========================================================
   Кадр — видеомонтаж (PhipiShip Флот)
   Формат .kadr: JSON { format: "kadr", version, app, width, height,
     media: [{ id, kind, name, data: "data:…" }],
     clips: [{ kind, media, in, out, dur, text, caption, … }], music }
   ========================================================= */

const KADR_VERSION = 1;
const MAX_MEDIA_MB = 300;
const FPS = 30;

const state = {
  w: 1280, h: 720,
  media: new Map(),  // id → { id, kind, name, blob, url, el, duration, thumb }
  clips: [],
  music: null,       // { media, volume }
  selected: null,    // id клипа
  t: 0,
  pps: 60,           // пикселей на секунду на таймлайне
  playing: false,
  exporting: false,
  dirty: false,
  docName: 'kadr',
};
let nextMediaId = 1, nextClipId = 1;

const view = $('#view');
const vctx = view.getContext('2d');
const viewport = $('#viewport');
const stage = $('#stage');

const clipDur = (c) => (c.kind === 'video' ? Math.max(0.1, c.out - c.in) : c.dur);
const total = () => state.clips.reduce((s, c) => s + clipDur(c), 0);
const selClip = () => state.clips.find((c) => c.id === state.selected) || null;
const fmt = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

function clipAt(t) {
  let acc = 0;
  for (let i = 0; i < state.clips.length; i++) {
    const d = clipDur(state.clips[i]);
    if (t < acc + d || i === state.clips.length - 1) return { clip: state.clips[i], index: i, start: acc, local: clamp(t - acc, 0, d) };
    acc += d;
  }
  return null;
}

const clipStart = (clip) => {
  let acc = 0;
  for (const c of state.clips) {
    if (c === clip) return acc;
    acc += clipDur(c);
  }
  return acc;
};

/* ---------------- Медиа ---------------- */

function mediaKind(file) {
  const app = Fleet.appForFile(file.name, file.type);
  if (file.type.startsWith('video/') || (app && app.id === 'kadr')) return 'video';
  if (file.type.startsWith('image/') || (app && app.id === 'photo')) return 'image';
  if (file.type.startsWith('audio/') || (app && app.id === 'volna')) return 'audio';
  return null;
}

/** Загружает медиа из Blob: создаёт элемент, узнаёт длительность и делает миниатюру. */
async function loadMedia(blob, kind, name, id = nextMediaId++) {
  nextMediaId = Math.max(nextMediaId, id + 1);
  const url = URL.createObjectURL(blob);
  const m = { id, kind, name, blob, url, el: null, duration: 0, thumb: '' };
  if (kind === 'image') {
    m.el = await loadImage(url);
    m.thumb = Fleet.thumbOf(m.el, 160);
  } else {
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.preload = 'auto';
    el.playsInline = true;
    el.src = url;
    await new Promise((resolve, reject) => {
      el.onloadeddata = resolve;
      el.onerror = () => reject(new Error(`Браузер не может проиграть «${name}»`));
    });
    m.el = el;
    m.duration = el.duration;
    if (kind === 'video') {
      await seekTo(el, Math.min(0.5, el.duration / 3));
      const c = makeCanvas(160, Math.max(1, Math.round((160 * el.videoHeight) / Math.max(1, el.videoWidth))));
      c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
      m.thumb = c.toDataURL('image/jpeg', 0.7);
    }
  }
  state.media.set(id, m);
  return m;
}

function seekTo(el, t) {
  return new Promise((resolve) => {
    if (Math.abs(el.currentTime - t) < 0.01 && el.readyState >= 2) { resolve(); return; }
    const done = () => { el.removeEventListener('seeked', done); resolve(); };
    el.addEventListener('seeked', done);
    el.currentTime = t;
  });
}

async function importFiles(files) {
  let added = 0;
  for (const file of files) {
    const kind = mediaKind(file);
    if (!kind) { status(`Не подходит для фильма: ${file.name}`); continue; }
    const used = [...state.media.values()].reduce((s, m) => s + m.blob.size, 0);
    if ((used + file.size) / 1048576 > MAX_MEDIA_MB) { status(`Слишком много медиа (больше ${MAX_MEDIA_MB} МБ).`); break; }
    try {
      status(`Загружаю ${file.name}…`);
      const m = await loadMedia(file, kind, Fleet.baseName(file.name) || file.name);
      pushHistory();
      if (kind === 'audio') {
        state.music = { media: m.id, volume: 0.6 };
      } else {
        state.clips.push(newClip(m));
      }
      added++;
    } catch (err) {
      status(err.message);
    }
  }
  if (added) {
    renderBin();
    renderAll();
    seek(state.t);
    status(`Добавлено файлов: ${added}`);
  }
}

function newClip(m) {
  const c = {
    id: nextClipId++, kind: m.kind, media: m.id, in: 0, out: m.duration || 0, dur: 4,
    caption: '', capPos: 'bottom', capSize: 6, fadeIn: false, fadeOut: false, zoom: m.kind === 'image', volume: 1,
  };
  if (m.kind === 'video') c.out = m.duration;
  return c;
}

function renderBin() {
  const bin = $('#bin');
  bin.innerHTML = '';
  for (const m of state.media.values()) {
    const b = document.createElement('button');
    b.className = 'bin-item';
    b.title = `${m.name} — клик добавит на таймлайн`;
    if (m.kind === 'audio') b.innerHTML = '<span>♫</span>';
    else b.style.backgroundImage = `url("${m.thumb}")`;
    b.onclick = () => {
      pushHistory();
      if (m.kind === 'audio') state.music = { media: m.id, volume: state.music ? state.music.volume : 0.6 };
      else state.clips.push(newClip(m));
      renderAll();
    };
    bin.appendChild(b);
  }
}

/* ---------------- Отрисовка кадра ---------------- */

function drawContain(ctx, src, sw, sh, zoom = 1) {
  const k = Math.min(state.w / sw, state.h / sh) * zoom;
  const w = sw * k, h = sh * k;
  ctx.drawImage(src, (state.w - w) / 2, (state.h - h) / 2, w, h);
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = word; } else line = test;
    }
    out.push(line);
  }
  return out;
}

function drawText(ctx, text, sizePct, pos, color, outline) {
  const size = Math.round((state.h * sizePct) / 100);
  ctx.font = `800 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, text, state.w * 0.86);
  const lh = size * 1.2;
  const blockH = lines.length * lh;
  let y = pos === 'top' ? state.h * 0.1 + lh / 2 : pos === 'center' ? state.h / 2 - blockH / 2 + lh / 2 : state.h * 0.9 - blockH + lh / 2;
  for (const line of lines) {
    if (outline) {
      ctx.lineWidth = Math.max(2, size / 7);
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.lineJoin = 'round';
      ctx.strokeText(line, state.w / 2, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(line, state.w / 2, y);
    y += lh;
  }
}

function drawClip(ctx, clip, local) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, state.w, state.h);
  if (!clip) return;
  const m = state.media.get(clip.media);
  const d = clipDur(clip);
  if (clip.kind === 'title') {
    ctx.fillStyle = clip.bg || '#12253d';
    ctx.fillRect(0, 0, state.w, state.h);
    drawText(ctx, clip.text || '', clip.size || 9, 'center', clip.color || '#ffffff', false);
  } else if (clip.kind === 'image' && m) {
    drawContain(ctx, m.el, m.el.naturalWidth, m.el.naturalHeight, clip.zoom ? 1 + 0.12 * (local / d) : 1);
  } else if (clip.kind === 'video' && m && m.el.readyState >= 2) {
    drawContain(ctx, m.el, m.el.videoWidth, m.el.videoHeight);
  }
  if (clip.caption) drawText(ctx, clip.caption, clip.capSize || 6, clip.capPos || 'bottom', '#ffffff', true);
  let fade = 0;
  if (clip.fadeIn && local < 0.6) fade = 1 - local / 0.6;
  if (clip.fadeOut && d - local < 0.6) fade = Math.max(fade, 1 - (d - local) / 0.6);
  if (fade > 0) {
    ctx.fillStyle = `rgba(0,0,0,${fade})`;
    ctx.fillRect(0, 0, state.w, state.h);
  }
}

let seekBusy = false, seekPending = null;

/** Показывает кадр в момент t (без воспроизведения): для видео дожидаемся перемотки. */
async function seek(t) {
  state.t = clamp(t, 0, total());
  updatePlayhead();
  if (seekBusy) { seekPending = state.t; return; }
  seekBusy = true;
  const at = clipAt(state.t);
  if (at && at.clip.kind === 'video') {
    const m = state.media.get(at.clip.media);
    if (m) await seekTo(m.el, at.clip.in + at.local);
  }
  drawClip(vctx, at && at.clip, at ? at.local : 0);
  $('#empty').hidden = state.clips.length > 0;
  seekBusy = false;
  if (seekPending !== null) {
    const p = seekPending;
    seekPending = null;
    if (Math.abs(p - (at ? at.start + at.local : 0)) > 0.001) seek(p);
  }
}

/* ---------------- Воспроизведение ---------------- */

let raf = 0, t0 = 0, tStart = 0, activeClip = null;

function pauseAllMedia() {
  for (const m of state.media.values()) if (m.el && m.el.pause) m.el.pause();
}

function play(onEnd) {
  if (!state.clips.length) return;
  if (state.t >= total() - 0.05) state.t = 0;
  state.playing = true;
  $('#playBtn').textContent = '❚❚';
  t0 = performance.now();
  tStart = state.t;
  activeClip = null;
  const music = state.music && state.media.get(state.music.media);
  if (music) {
    music.el.currentTime = state.t % Math.max(0.1, music.duration);
    music.el.volume = state.music.volume;
    music.el.loop = true;
    music.el.play().catch(() => {});
  }
  const tick = (now) => {
    if (!state.playing) return;
    const t = tStart + (now - t0) / 1000;
    if (t >= total()) {
      state.t = total();
      stopPlay();
      if (onEnd) onEnd();
      return;
    }
    state.t = t;
    const at = clipAt(t);
    if (at.clip !== activeClip) {
      if (activeClip && activeClip.kind === 'video') state.media.get(activeClip.media).el.pause();
      activeClip = at.clip;
      if (at.clip.kind === 'video') {
        const el = state.media.get(at.clip.media).el;
        el.currentTime = at.clip.in + at.local;
        el.volume = clamp(at.clip.volume ?? 1, 0, 1);
        el.play().catch(() => {});
      }
    } else if (at.clip.kind === 'video') {
      const el = state.media.get(at.clip.media).el;
      if (Math.abs(el.currentTime - (at.clip.in + at.local)) > 0.35) el.currentTime = at.clip.in + at.local;
    }
    drawClip(vctx, at.clip, at.local);
    updatePlayhead(true);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function stopPlay() {
  state.playing = false;
  cancelAnimationFrame(raf);
  pauseAllMedia();
  $('#playBtn').textContent = '▶';
  seek(state.t);
}

/* ---------------- Экспорт видео ---------------- */

let audioCtx = null, audioDest = null;

function routeAudio() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  audioDest ||= audioCtx.createMediaStreamDestination();
  for (const m of state.media.values()) {
    if (m.kind === 'image' || m.node) continue;
    m.node = audioCtx.createMediaElementSource(m.el);
    m.node.connect(audioCtx.destination);
    m.node.connect(audioDest);
  }
  return audioCtx.resume();
}

function pickMime() {
  const list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

async function exportVideo() {
  if (!state.clips.length) { status('Фильм пустой — добавьте клипы.'); return; }
  if (!window.MediaRecorder || !view.captureStream) { status('Этот браузер не умеет записывать видео. Попробуйте Chrome или Edge.'); return; }
  const mime = pickMime();
  stopPlay();
  await routeAudio();
  const stream = new MediaStream([...view.captureStream(FPS).getVideoTracks(), ...audioDest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  let cancelled = false;
  const dur = total();
  openModal({
    title: 'Экспорт видео',
    html: `<p>Фильм записывается в реальном времени — это займёт ${fmt(dur)}. Не переключайте вкладку.</p>
      <div class="meter big"><div id="exportBar"></div></div><p id="exportInfo">0%</p>`,
    okText: 'Готово',
    onCancel: () => { cancelled = true; stopPlay(); rec.stop(); },
    onOk: () => {},
  });
  $('#modalOk').disabled = true;
  const timer = setInterval(() => {
    const p = Math.min(1, state.t / dur);
    const bar = $('#exportBar');
    if (bar) bar.style.width = Math.round(p * 100) + '%';
    const info = $('#exportInfo');
    if (info) info.textContent = `${Math.round(p * 100)}% · ${fmt(state.t)} из ${fmt(dur)}`;
  }, 200);
  rec.onstop = () => {
    clearInterval(timer);
    state.exporting = false;
    $('#modalOk').disabled = false;
    if (cancelled) { status('Экспорт отменён'); return; }
    const type = rec.mimeType || mime || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    Fleet.download(new Blob(chunks, { type }), `${state.docName}.${ext}`);
    closeModal(true);
    status(`🎬 Видео готово: ${state.docName}.${ext}`);
  };
  state.exporting = true;
  state.t = 0;
  rec.start(500);
  play(() => setTimeout(() => rec.state !== 'inactive' && rec.stop(), 300));
}

/* ---------------- Таймлайн ---------------- */

function updatePlayhead(scroll) {
  const x = state.t * state.pps;
  $('#playhead').style.transform = `translateX(${x}px)`;
  $('#clock').textContent = `${fmt(state.t)} / ${fmt(total())}`;
  if (scroll) {
    const sc = $('#tlScroll');
    if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft) sc.scrollLeft = x - 40;
  }
}

function drawRuler() {
  const c = $('#ruler');
  const w = Math.max($('#tlScroll').clientWidth, (total() + 10) * state.pps);
  c.width = w;
  $('#tlInner').style.width = w + 'px';
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, c.height);
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';
  ctx.fillStyle = muted;
  ctx.strokeStyle = muted;
  ctx.font = '10px system-ui, sans-serif';
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * state.pps >= 60) || 120;
  ctx.beginPath();
  for (let t = 0; t * state.pps < w; t += step) {
    const x = Math.round(t * state.pps) + 0.5;
    ctx.moveTo(x, 14);
    ctx.lineTo(x, 22);
    ctx.fillText(fmt(t).replace(/\.0$/, ''), x + 3, 10);
  }
  ctx.stroke();
}

function renderTimeline() {
  drawRuler();
  const track = $('#track');
  track.innerHTML = '';
  let acc = 0;
  for (const c of state.clips) {
    const d = clipDur(c);
    const m = state.media.get(c.media);
    const el = document.createElement('div');
    el.className = `clip ${c.kind}` + (c.id === state.selected ? ' active' : '');
    el.style.left = acc * state.pps + 'px';
    el.style.width = Math.max(8, d * state.pps - 2) + 'px';
    if (c.kind === 'title') {
      el.style.background = c.bg || '#12253d';
      el.style.color = c.color || '#fff';
    } else if (m && m.thumb) {
      el.style.backgroundImage = `url("${m.thumb}")`;
    }
    const label = c.kind === 'title' ? '🅣 ' + (c.text || '').split('\n')[0] : (c.kind === 'video' ? '🎬 ' : '🖼 ') + (m ? m.name : '');
    el.innerHTML = `<span class="clip-name">${esc(label)}</span><span class="clip-dur">${d.toFixed(1)} с</span>
      <i class="trim l" data-trim="l"></i><i class="trim r" data-trim="r"></i>`;
    if (c.fadeIn) el.classList.add('fade-in');
    if (c.fadeOut) el.classList.add('fade-out');
    el.dataset.id = c.id;
    track.appendChild(el);
    acc += d;
  }
  const mt = $('#musicTrack');
  mt.innerHTML = '';
  if (state.music) {
    const m = state.media.get(state.music.media);
    const bar = document.createElement('div');
    bar.className = 'music-clip';
    bar.style.width = Math.max(40, total() * state.pps) + 'px';
    bar.textContent = '♫ ' + (m ? m.name : 'музыка');
    mt.appendChild(bar);
  }
  updatePlayhead();
}

function renderAll() {
  renderTimeline();
  renderProps();
  renderMusic();
  $('#empty').hidden = state.clips.length > 0;
  $('#formatInfo').textContent = `${state.w}×${state.h} · клипов: ${state.clips.length}`;
}

/* ---------------- Свойства клипа ---------------- */

function propRow(label, html) {
  return `<div class="row"><span>${label}</span>${html}</div>`;
}

function renderProps() {
  const c = selClip();
  const box = $('#clipProps');
  if (!c) {
    $('#clipTitle').textContent = 'Клип';
    box.innerHTML = '<p class="hint-small">Выберите клип на таймлайне, чтобы настроить его. Края клипа можно тянуть — так он обрезается.</p>';
    return;
  }
  const m = state.media.get(c.media);
  $('#clipTitle').textContent = c.kind === 'title' ? 'Титр' : c.kind === 'video' ? 'Видео' : 'Фото';
  let html = '';
  if (c.kind === 'video') {
    html += propRow('Начало, с', `<input type="number" data-p="in" step="0.1" min="0" max="${m ? m.duration.toFixed(2) : 0}" value="${c.in.toFixed(2)}">`);
    html += propRow('Конец, с', `<input type="number" data-p="out" step="0.1" min="0" max="${m ? m.duration.toFixed(2) : 0}" value="${c.out.toFixed(2)}">`);
    html += propRow('Громкость', `<input type="range" data-p="volume" min="0" max="1" step="0.05" value="${c.volume ?? 1}">`);
  } else {
    html += propRow('Длительность, с', `<input type="number" data-p="dur" step="0.5" min="0.5" max="600" value="${c.dur}">`);
  }
  if (c.kind === 'title') {
    html += `<textarea data-p="text" rows="2" placeholder="Текст титра">${esc(c.text || '')}</textarea>`;
    html += propRow('Фон', `<input type="color" data-p="bg" value="${c.bg || '#12253d'}">`);
    html += propRow('Цвет текста', `<input type="color" data-p="color" value="${c.color || '#ffffff'}">`);
    html += propRow('Размер текста', `<input type="range" data-p="size" min="3" max="20" step="0.5" value="${c.size || 9}">`);
  } else {
    html += `<input type="text" data-p="caption" placeholder="Подпись поверх кадра" value="${esc(c.caption || '')}">`;
    html += propRow('Где подпись', `<select data-p="capPos">
      <option value="bottom"${c.capPos === 'bottom' ? ' selected' : ''}>Снизу</option>
      <option value="center"${c.capPos === 'center' ? ' selected' : ''}>По центру</option>
      <option value="top"${c.capPos === 'top' ? ' selected' : ''}>Сверху</option></select>`);
    html += propRow('Размер подписи', `<input type="range" data-p="capSize" min="3" max="15" step="0.5" value="${c.capSize || 6}">`);
  }
  if (c.kind === 'image') html += `<label class="row"><span><input type="checkbox" data-p="zoom"${c.zoom ? ' checked' : ''}> Плавное приближение</span></label>`;
  html += `<label class="row"><span><input type="checkbox" data-p="fadeIn"${c.fadeIn ? ' checked' : ''}> Появление из темноты</span></label>`;
  html += `<label class="row"><span><input type="checkbox" data-p="fadeOut"${c.fadeOut ? ' checked' : ''}> Уход в темноту</span></label>`;
  html += `<div class="layer-actions">
    <button data-action="moveLeft" title="Влево">◀</button><button data-action="split" title="Разрезать (S)">✂</button>
    <button data-action="duplicate" title="Дублировать">⧉</button><button data-action="moveRight" title="Вправо">▶</button>
    <button data-action="remove" title="Удалить">🗑</button></div>`;
  box.innerHTML = html;
  for (const input of box.querySelectorAll('[data-p]')) {
    const ev = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener('focus', () => { editingProp = false; });
    input.addEventListener(ev, () => setProp(c, input));
    input.addEventListener('change', () => { editingProp = false; });
  }
}

let editingProp = false;

function setProp(c, input) {
  if (!editingProp) { pushHistory(); editingProp = true; }
  const p = input.dataset.p;
  const m = state.media.get(c.media);
  let v = input.type === 'checkbox' ? input.checked : input.value;
  if (['in', 'out', 'dur', 'volume', 'size', 'capSize'].includes(p)) v = Number(v) || 0;
  if (p === 'in') v = clamp(v, 0, c.out - 0.1);
  if (p === 'out') v = clamp(v, c.in + 0.1, m ? m.duration : v);
  if (p === 'dur') v = clamp(v, 0.5, 600);
  c[p] = v;
  renderTimeline();
  seek(clamp(state.t, clipStart(c), clipStart(c) + clipDur(c) - 0.01));
}

function renderMusic() {
  const box = $('#musicBox');
  const mu = state.music;
  const m = mu && state.media.get(mu.media);
  if (!m) {
    box.innerHTML = '<p class="hint-small">Добавьте звуковой файл (MP3, WAV…) — он станет музыкой фильма.</p>';
    return;
  }
  box.innerHTML = `<div class="row"><span>♫ ${esc(m.name)}</span><span>${fmt(m.duration)}</span></div>
    <div class="row"><span>Громкость</span><input type="range" id="musicVol" min="0" max="1" step="0.05" value="${mu.volume}"></div>
    <button data-action="removeMusic">Убрать музыку</button>`;
  $('#musicVol').addEventListener('input', (e) => {
    mu.volume = Number(e.target.value);
    m.el.volume = mu.volume;
    state.dirty = true;
  });
}

/* ---------------- Мышь на таймлайне ---------------- */

let tlDrag = null;
const tlInner = $('#tlInner');

tlInner.addEventListener('pointerdown', (e) => {
  if (state.exporting) return;
  const r = tlInner.getBoundingClientRect();
  const x = e.clientX - r.left;
  const clipEl = e.target.closest('.clip');
  if (state.playing) stopPlay();
  if (clipEl) {
    const c = state.clips.find((k) => k.id === Number(clipEl.dataset.id));
    state.selected = c.id;
    const trim = e.target.dataset.trim;
    pushHistory();
    tlDrag = { type: trim ? 'trim-' + trim : 'move', clip: c, x0: x, orig: { ...c }, moved: false };
    tlInner.setPointerCapture(e.pointerId);
    renderTimeline();
    renderProps();
    if (!trim) seek(clamp(x / state.pps, clipStart(c), clipStart(c) + clipDur(c) - 0.01));
    return;
  }
  tlDrag = { type: 'scrub' };
  tlInner.setPointerCapture(e.pointerId);
  seek(x / state.pps);
});

tlInner.addEventListener('pointermove', (e) => {
  const r = tlInner.getBoundingClientRect();
  const x = e.clientX - r.left;
  $('#statusCoords').textContent = fmt(Math.max(0, x / state.pps));
  if (!tlDrag) return;
  if (tlDrag.type === 'scrub') { seek(x / state.pps); return; }
  const c = tlDrag.clip, o = tlDrag.orig;
  const dt = (x - tlDrag.x0) / state.pps;
  if (Math.abs(x - tlDrag.x0) > 3) tlDrag.moved = true;
  if (!tlDrag.moved) return;
  const m = state.media.get(c.media);
  if (tlDrag.type === 'trim-l') {
    if (c.kind === 'video') c.in = clamp(o.in + dt, 0, o.out - 0.1);
    else c.dur = clamp(o.dur - dt, 0.5, 600);
  } else if (tlDrag.type === 'trim-r') {
    if (c.kind === 'video') c.out = clamp(o.out + dt, o.in + 0.1, m ? m.duration : o.out);
    else c.dur = clamp(o.dur + dt, 0.5, 600);
  } else if (tlDrag.type === 'move') {
    // Перестановка: клип встаёт туда, где окажется его середина.
    const mid = clipStart(c) + clipDur(c) / 2 + dt - (tlDrag.applied || 0);
    const others = state.clips.filter((k) => k !== c);
    let acc = 0, idx = others.length;
    for (let i = 0; i < others.length; i++) {
      if (mid < acc + clipDur(others[i]) / 2) { idx = i; break; }
      acc += clipDur(others[i]);
    }
    const cur = state.clips.indexOf(c);
    if (idx !== cur) {
      const before = clipStart(c);
      state.clips.splice(cur, 1);
      state.clips.splice(idx, 0, c);
      tlDrag.applied = (tlDrag.applied || 0) + (clipStart(c) - before);
    }
  }
  renderTimeline();
  if (tlDrag.type.startsWith('trim')) {
    const at = tlDrag.type === 'trim-l' ? clipStart(c) : clipStart(c) + clipDur(c) - 0.02;
    seek(at);
  }
});

const endTl = () => {
  if (tlDrag && tlDrag.type !== 'scrub' && !tlDrag.moved) {
    hist.undo.pop();
    updateHistoryButtons();
  }
  if (tlDrag && tlDrag.type !== 'scrub') renderProps();
  tlDrag = null;
};
tlInner.addEventListener('pointerup', endTl);
tlInner.addEventListener('pointercancel', endTl);

/* ---------------- История ---------------- */

const hist = { undo: [], redo: [] };
const snap = () => JSON.stringify({ clips: state.clips, music: state.music, selected: state.selected });

function pushHistory() {
  hist.undo.push(snap());
  if (hist.undo.length > 100) hist.undo.shift();
  hist.redo.length = 0;
  state.dirty = true;
  updateHistoryButtons();
}

function applySnap(s) {
  const d = JSON.parse(s);
  state.clips = d.clips;
  state.music = d.music;
  state.selected = d.selected;
  renderAll();
  seek(state.t);
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

/* ---------------- Файлы ---------------- */

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function saveKadr() {
  if (!state.clips.length && !state.music) { status('Фильм пустой.'); return; }
  status('Упаковываю проект…');
  const used = new Set(state.clips.map((c) => c.media).concat(state.music ? [state.music.media] : []));
  const media = [];
  for (const m of state.media.values()) {
    if (!used.has(m.id)) continue;
    media.push({ id: m.id, kind: m.kind, name: m.name, data: await blobToDataUrl(m.blob) });
  }
  const doc = {
    format: 'kadr', version: KADR_VERSION, app: 'Кадр', width: state.w, height: state.h,
    media, clips: state.clips.map(({ id, ...rest }) => rest), music: state.music,
  };
  const name = state.docName + '.kadr';
  const blob = new Blob([JSON.stringify(doc)], { type: 'application/octet-stream' });
  Fleet.download(blob, name);
  const thumb = makeCanvas(state.w, state.h);
  drawClip(thumb.getContext('2d'), state.clips[0], 0.7);
  Fleet.addRecent(name, 'kadr', blob, Fleet.thumbOf(thumb));
  state.dirty = false;
  status(`⚓ Сохранено: ${name} (${(blob.size / 1048576).toFixed(1)} МБ)`);
}

const MEDIA_RE = { video: /^data:video\//, image: /^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/, audio: /^data:audio\// };

async function openKadr(file) {
  let doc;
  try { doc = JSON.parse(await file.text()); } catch (_) { throw new Error('Файл .kadr повреждён'); }
  if (!doc || doc.format !== 'kadr' || !Array.isArray(doc.clips) || !Array.isArray(doc.media)) throw new Error('Это не файл Кадра (.kadr)');
  if (doc.version > KADR_VERSION) throw new Error('Файл создан более новой версией Кадра — обновите страницу');
  if (!confirmDiscard()) return;
  resetProject(clamp(Math.round(doc.width) || 1280, 16, 3840), clamp(Math.round(doc.height) || 720, 16, 3840));
  const idMap = new Map();
  for (const md of doc.media) {
    if (!MEDIA_RE[md.kind] || typeof md.data !== 'string' || !MEDIA_RE[md.kind].test(md.data)) continue;
    const blob = await (await fetch(md.data)).blob();
    const m = await loadMedia(blob, md.kind, String(md.name || 'медиа').slice(0, 80));
    idMap.set(md.id, m.id);
  }
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const color = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
  state.clips = doc.clips.map((src) => {
    if (!['video', 'image', 'title'].includes(src.kind)) return null;
    const mid = src.kind === 'title' ? null : idMap.get(src.media);
    if (src.kind !== 'title' && !mid) return null;
    const m = mid && state.media.get(mid);
    return {
      id: nextClipId++, kind: src.kind, media: mid,
      in: clamp(num(src.in, 0), 0, m ? m.duration : 0), out: clamp(num(src.out, 1), 0.1, m ? m.duration || 1 : 1),
      dur: clamp(num(src.dur, 4), 0.5, 600), text: String(src.text ?? '').slice(0, 500),
      bg: color(src.bg, '#12253d'), color: color(src.color, '#ffffff'), size: clamp(num(src.size, 9), 3, 20),
      caption: String(src.caption ?? '').slice(0, 300), capPos: ['top', 'center', 'bottom'].includes(src.capPos) ? src.capPos : 'bottom',
      capSize: clamp(num(src.capSize, 6), 3, 15), fadeIn: !!src.fadeIn, fadeOut: !!src.fadeOut, zoom: !!src.zoom,
      volume: clamp(num(src.volume, 1), 0, 1),
    };
  }).filter(Boolean);
  if (doc.music && idMap.get(doc.music.media)) state.music = { media: idMap.get(doc.music.media), volume: clamp(num(doc.music.volume, 0.6), 0, 1) };
  state.docName = Fleet.baseName(file.name) || 'kadr';
  state.dirty = false;
  renderBin();
  renderAll();
  fitTimeline();
  await seek(0);
  const thumb = makeCanvas(state.w, state.h);
  drawClip(thumb.getContext('2d'), state.clips[0], 0.7);
  Fleet.addRecent(file.name, 'kadr', file, Fleet.thumbOf(thumb));
  status(`⚓ Открыт ${file.name}: клипов ${state.clips.length}`);
}

function resetProject(w, h) {
  stopPlay();
  for (const m of state.media.values()) URL.revokeObjectURL(m.url);
  state.media = new Map();
  Object.assign(state, { w, h, clips: [], music: null, selected: null, t: 0, dirty: false });
  view.width = w;
  view.height = h;
  hist.undo.length = hist.redo.length = 0;
  updateHistoryButtons();
  fitPreview();
  renderBin();
  renderAll();
  seek(0);
}

function confirmDiscard() {
  return !state.dirty || confirm('Несохранённые изменения будут потеряны. Продолжить?');
}

async function openFile(file) {
  try {
    const ext = Fleet.extOf(file.name);
    if (ext === 'kadr') return await openKadr(file);
    if (mediaKind(file) && !['photik', 'animka', 'kontur', 'svet', 'volna', 'verstka'].includes(ext)) return await importFiles([file]);
    const app = Fleet.appForFile(file.name, file.type);
    if (app) {
      if (confirmDiscard()) await Fleet.openIn(file, app.id);
      return;
    }
    status(`Не знаю такой формат: ${file.name}`);
  } catch (err) {
    status(err.message);
  }
}

/* ---------------- Превью ---------------- */

function fitPreview() {
  const r = viewport.getBoundingClientRect();
  const k = Math.min((r.width - 32) / state.w, (r.height - 32) / state.h);
  const z = k > 0 ? k : 1;
  stage.style.transform = `translate(${(r.width - state.w * z) / 2}px, ${(r.height - state.h * z) / 2}px) scale(${z})`;
}

function fitTimeline() {
  const w = $('#tlScroll').clientWidth - 60;
  state.pps = clamp(w / Math.max(1, total()), 4, 400);
  $('#zoomLabel').textContent = Math.round((state.pps / 60) * 100) + '%';
  renderTimeline();
}

function zoomTimeline(k) {
  state.pps = clamp(state.pps * k, 4, 400);
  $('#zoomLabel').textContent = Math.round((state.pps / 60) * 100) + '%';
  renderTimeline();
}

/* ---------------- Действия ---------------- */

function splitAt() {
  const at = clipAt(state.t);
  if (!at || at.local < 0.1 || clipDur(at.clip) - at.local < 0.1) { status('Поставьте курсор внутрь клипа, чтобы разрезать.'); return; }
  pushHistory();
  const a = at.clip;
  const b = { ...a, id: nextClipId++, fadeIn: false };
  a.fadeOut = false;
  if (a.kind === 'video') {
    b.in = a.in + at.local;
    a.out = b.in;
  } else {
    b.dur = a.dur - at.local;
    a.dur = at.local;
  }
  state.clips.splice(at.index + 1, 0, b);
  state.selected = b.id;
  renderAll();
  status('Клип разрезан');
}

const actions = {
  new() {
    openModal({
      title: 'Новый фильм',
      fields: [{ key: 'size', label: 'Формат', type: 'select', value: '1280x720', options: [
        ['1280x720', 'Широкий 16:9 (1280×720)'], ['1920x1080', 'Full HD 16:9 (1920×1080)'],
        ['1080x1920', 'Вертикальный 9:16 (1080×1920)'], ['1080x1080', 'Квадрат (1080×1080)'],
      ] }],
      okText: 'Создать',
      onOk: ({ size }) => {
        if (!confirmDiscard()) return;
        const [w, h] = size.split('x').map(Number);
        resetProject(w, h);
        state.docName = 'kadr';
      },
    });
  },
  open: () => $('#fileOpen').click(),
  importMedia: () => $('#fileMedia').click(),
  save: saveKadr,
  exportVideo,
  exportFrame() {
    view.toBlob((b) => Fleet.download(b, `${state.docName}-frame.png`), 'image/png');
  },
  harbor: () => { location.href = 'index.html'; },
  undo, redo,
  play: () => (state.playing ? stopPlay() : play()),
  toStart: () => { if (state.playing) stopPlay(); seek(0); },
  toEnd: () => { if (state.playing) stopPlay(); seek(total()); },
  split: splitAt,
  addTitle() {
    pushHistory();
    const c = { id: nextClipId++, kind: 'title', media: null, in: 0, out: 0, dur: 3, text: 'Мой фильм', bg: '#12253d', color: '#ffffff', size: 9, caption: '', capPos: 'bottom', capSize: 6, fadeIn: true, fadeOut: true, zoom: false, volume: 1 };
    const at = clipAt(state.t);
    const idx = at ? (at.local > clipDur(at.clip) / 2 ? at.index + 1 : at.index) : state.clips.length;
    state.clips.splice(idx, 0, c);
    state.selected = c.id;
    renderAll();
    seek(clipStart(c) + 0.7);
  },
  duplicate() {
    const c = selClip();
    if (!c) return;
    pushHistory();
    const d = { ...c, id: nextClipId++ };
    state.clips.splice(state.clips.indexOf(c) + 1, 0, d);
    state.selected = d.id;
    renderAll();
  },
  remove() {
    const c = selClip();
    if (!c) return;
    pushHistory();
    state.clips.splice(state.clips.indexOf(c), 1);
    state.selected = null;
    renderAll();
    seek(state.t);
  },
  moveLeft() {
    const c = selClip();
    const i = state.clips.indexOf(c);
    if (!c || i <= 0) return;
    pushHistory();
    [state.clips[i - 1], state.clips[i]] = [state.clips[i], state.clips[i - 1]];
    renderAll();
  },
  moveRight() {
    const c = selClip();
    const i = state.clips.indexOf(c);
    if (!c || i >= state.clips.length - 1) return;
    pushHistory();
    [state.clips[i + 1], state.clips[i]] = [state.clips[i], state.clips[i + 1]];
    renderAll();
  },
  removeMusic() {
    if (!state.music) return;
    pushHistory();
    state.music = null;
    renderAll();
  },
  tlZoomIn: () => zoomTimeline(1.4),
  tlZoomOut: () => zoomTimeline(1 / 1.4),
  tlFit: fitTimeline,
  shortcuts() {
    const rows = [
      ['Пробел', 'Играть / пауза'], ['Home / End', 'В начало / в конец'], ['← / →', 'Шаг 1 кадр (Shift — 1 секунда)'],
      ['S', 'Разрезать клип'], ['T', 'Добавить титр'], ['Del', 'Удалить клип'], ['Ctrl+D', 'Дублировать клип'],
      ['+ / −', 'Масштаб таймлайна'], ['Ctrl+I', 'Добавить медиа'], ['Ctrl+E', 'Экспорт видео'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Отменить / повторить'], ['Ctrl+S', 'Сохранить .kadr'],
    ];
    openModal({ title: 'Горячие клавиши', html: '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>', cancel: false });
  },
  about() {
    openModal({
      title: 'Кадр',
      html: `<p><b>Кадр</b> — видеоредактор из набора PhipiShip Флот. Склеивайте видео и фото, обрезайте клипы за края,
        добавляйте титры, подписи, затемнения и фоновую музыку.</p>
        <p>Проект сохраняется в формате <b>.kadr</b> (вместе с медиафайлами), готовый фильм — в WebM или MP4.</p>`,
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
Fleet.mountSwitcher('kadr');

$('#fileOpen').accept = Fleet.ACCEPT_ALL;
$('#fileOpen').addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('#fileMedia').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
});
for (const zone of [viewport, $('#tlScroll')]) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); viewport.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => viewport.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    viewport.classList.remove('dragover');
    const files = [...e.dataTransfer.files];
    if (files.length === 1 && Fleet.extOf(files[0].name) === 'kadr') openFile(files[0]);
    else if (files.length) importFiles(files);
  });
}

window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });
new ResizeObserver(() => { fitPreview(); drawRuler(); }).observe(viewport);

window.addEventListener('keydown', (e) => {
  if (modalOpen()) {
    if (e.key === 'Escape' && !state.exporting) closeModal(false);
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
    const map = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'save', o: 'open', i: 'importMedia', e: 'exportVideo', d: 'duplicate' };
    if (map[k]) { e.preventDefault(); runAction(map[k]); }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); runAction('play'); return; }
  if (e.key === 'Home') { runAction('toStart'); return; }
  if (e.key === 'End') { runAction('toEnd'); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (state.playing) stopPlay();
    seek(state.t + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / FPS));
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); runAction('remove'); return; }
  if (e.key === '+' || e.key === '=') { runAction('tlZoomIn'); return; }
  if (e.key === '-') { runAction('tlZoomOut'); return; }
  if (k === 's') { runAction('split'); return; }
  if (k === 't') { runAction('addTitle'); return; }
  if (e.key === 'Escape') { closeMenus(); state.selected = null; renderAll(); }
});

resetProject(state.w, state.h);
Fleet.takeHandoff().then((file) => { if (file) openFile(file); });
