'use strict';

/* =========================================================
   Волна — звуковой редактор (PhipiShip Флот)
   Формат .volna: JSON { format: "volna", version, app, sampleRate, channels,
     duration, audio: "data:audio/wav;base64,…" } — звук хранится как WAV 16 бит.
   Правки не меняют массивы на месте, поэтому история хранит лишь ссылки.
   ========================================================= */

const VOLNA_VERSION = 1;
const MAX_SECONDS = 20 * 60;
const PEAK_BLOCK = 256;

const state = {
  channels: [],      // Float32Array на канал
  rate: 44100,
  selA: 0, selB: 0,  // выделение в сэмплах (selA === selB — курсор)
  view: { start: 0, spp: 100 }, // первый видимый сэмпл и сэмплов на пиксель
  playing: false,
  recording: false,
  loop: false,
  dirty: false,
  docName: 'volna',
};

let actx = null;
const ctxAudio = () => (actx ||= new (window.AudioContext || window.webkitAudioContext)());
const len = () => (state.channels[0] ? state.channels[0].length : 0);
const fmtTime = (s) => {
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${m}:${sec.toFixed(3).padStart(6, '0')}`;
};
const hasSel = () => state.selB - state.selA > 1;
const range = () => (hasSel() ? [state.selA, state.selB] : [0, len()]);

const canvas = $('#wave');
const cctx = canvas.getContext('2d');
const area = $('#viewport');

/* ---------------- История ---------------- */

const hist = { undo: [], redo: [] };
const snap = () => ({ channels: state.channels, selA: state.selA, selB: state.selB });

function pushHistory() {
  hist.undo.push(snap());
  if (hist.undo.length > 40) hist.undo.shift();
  hist.redo.length = 0;
  state.dirty = true;
  updateHistoryButtons();
}

function restore(s) {
  state.channels = s.channels;
  state.selA = s.selA;
  state.selB = s.selB;
  afterEdit();
}

function undo() {
  if (!hist.undo.length) return;
  stop();
  hist.redo.push(snap());
  restore(hist.undo.pop());
  updateHistoryButtons();
}

function redo() {
  if (!hist.redo.length) return;
  stop();
  hist.undo.push(snap());
  restore(hist.redo.pop());
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('#undoBtn').disabled = !hist.undo.length;
  $('#redoBtn').disabled = !hist.redo.length;
}

/* ---------------- Пики для быстрой отрисовки ---------------- */

let peaks = []; // [{min, max}] на канал, блоками по PEAK_BLOCK

function buildPeaks() {
  peaks = state.channels.map((ch) => {
    const n = Math.ceil(ch.length / PEAK_BLOCK);
    const min = new Float32Array(n), max = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      let lo = 1, hi = -1;
      const end = Math.min(ch.length, (b + 1) * PEAK_BLOCK);
      for (let i = b * PEAK_BLOCK; i < end; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo;
      max[b] = hi;
    }
    return { min, max };
  });
}

/* ---------------- Отрисовка ---------------- */

const RULER = 22;
let playheadSample = -1;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const cw = () => canvas.width / (window.devicePixelRatio || 1);
const ch = () => canvas.height / (window.devicePixelRatio || 1);
const xOf = (s) => (s - state.view.start) / state.view.spp;
const sOf = (x) => Math.round(state.view.start + x * state.view.spp);

function clampView() {
  const w = cw();
  state.view.spp = clamp(state.view.spp, 0.05, Math.max(1, len() / Math.max(1, w)) * 1.05 || 1);
  state.view.start = clamp(state.view.start, 0, Math.max(0, len() - w * state.view.spp));
}

function draw() {
  const W = cw(), H = ch();
  cctx.clearRect(0, 0, W, H);
  $('#waveEmpty').hidden = len() > 0;
  if (!len()) return;
  clampView();
  const accent = cssVar('--accent') || '#ff7a59';
  const accent2 = cssVar('--accent-2') || '#3fd0c9';
  const text = cssVar('--muted') || '#8ea6c4';
  const nch = state.channels.length;
  const laneH = (H - RULER - 18) / nch;

  // Выделение
  if (hasSel()) {
    const x1 = Math.max(0, xOf(state.selA)), x2 = Math.min(W, xOf(state.selB));
    cctx.fillStyle = accent + '33';
    cctx.fillRect(x1, RULER, x2 - x1, H - RULER - 18);
  }

  // Линейка времени
  cctx.fillStyle = text;
  cctx.strokeStyle = text + '66';
  cctx.font = '11px system-ui, sans-serif';
  const secPerPx = state.view.spp / state.rate;
  const steps = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s / secPerPx >= 90) || 600;
  const t0 = state.view.start / state.rate;
  cctx.beginPath();
  for (let t = Math.ceil(t0 / step) * step; ; t += step) {
    const x = (t * state.rate - state.view.start) / state.view.spp;
    if (x > W) break;
    cctx.moveTo(x + 0.5, RULER - 8);
    cctx.lineTo(x + 0.5, RULER);
    const label = step < 1 ? fmtTime(t).replace(/0+$/, '').replace(/\.$/, '') : fmtTime(t).slice(0, -4);
    cctx.fillText(label, x + 4, 12);
  }
  cctx.stroke();

  // Волна
  state.channels.forEach((data, c) => {
    const mid = RULER + laneH * c + laneH / 2;
    const amp = laneH / 2 - 4;
    const grad = cctx.createLinearGradient(0, mid - amp, 0, mid + amp);
    grad.addColorStop(0, accent2);
    grad.addColorStop(0.5, accent);
    grad.addColorStop(1, accent2);
    cctx.strokeStyle = text + '33';
    cctx.beginPath();
    cctx.moveTo(0, mid + 0.5);
    cctx.lineTo(W, mid + 0.5);
    cctx.stroke();
    cctx.fillStyle = grad;
    const spp = state.view.spp;
    if (spp < 1) {
      // Сильное приближение: соединяем отдельные сэмплы линией.
      cctx.strokeStyle = accent;
      cctx.lineWidth = 1.5;
      cctx.beginPath();
      const s0 = Math.max(0, Math.floor(state.view.start)), s1 = Math.min(data.length, Math.ceil(state.view.start + W * spp) + 1);
      for (let s = s0; s < s1; s++) {
        const x = xOf(s), y = mid - data[s] * amp;
        if (s === s0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
      }
      cctx.stroke();
      cctx.lineWidth = 1;
      return;
    }
    const pk = peaks[c];
    for (let x = 0; x < W; x++) {
      const a = Math.floor(state.view.start + x * spp), b = Math.min(data.length, Math.floor(state.view.start + (x + 1) * spp));
      if (a >= data.length) break;
      let lo = 1, hi = -1;
      if (spp >= PEAK_BLOCK * 2 && pk) {
        for (let k = Math.floor(a / PEAK_BLOCK), e = Math.ceil(b / PEAK_BLOCK); k < e; k++) {
          if (pk.min[k] < lo) lo = pk.min[k];
          if (pk.max[k] > hi) hi = pk.max[k];
        }
      } else {
        for (let i = a; i < Math.max(b, a + 1); i++) {
          const v = data[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      const y1 = mid - hi * amp, y2 = mid - lo * amp;
      cctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  });

  // Курсор и указатель воспроизведения
  if (!hasSel()) {
    const x = xOf(state.selA);
    cctx.fillStyle = accent;
    cctx.fillRect(Math.round(x), RULER, 1.5, H - RULER - 18);
  }
  if (playheadSample >= 0) {
    const x = xOf(playheadSample);
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(Math.round(x), 0, 2, H - 18);
    cctx.beginPath();
    cctx.moveTo(x - 5, 0);
    cctx.lineTo(x + 7, 0);
    cctx.lineTo(x + 1, 8);
    cctx.fill();
  }
}

function updateInfo() {
  const n = len();
  $('#durInfo').textContent = fmtTime(n / state.rate).slice(0, -2);
  $('#rateInfo').textContent = n ? `${state.rate} Гц` : '—';
  $('#chInfo').textContent = n ? (state.channels.length === 1 ? 'моно' : 'стерео') : '—';
  let peak = 0;
  for (const p of peaks) for (let i = 0; i < p.max.length; i++) peak = Math.max(peak, p.max[i], -p.min[i]);
  $('#peakInfo').textContent = n ? (peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} дБ` : '−∞ дБ') : '—';
  if (hasSel()) {
    $('#selInfo').textContent = `Выделено: ${fmtTime(state.selA / state.rate)} — ${fmtTime(state.selB / state.rate)} (${((state.selB - state.selA) / state.rate).toFixed(2)} с)`;
  } else {
    $('#selInfo').textContent = n ? `Курсор: ${fmtTime(state.selA / state.rate)}` : 'Выделения нет';
  }
  $('#clock').textContent = fmtTime((playheadSample >= 0 ? playheadSample : state.selA) / state.rate);
  const full = len() / Math.max(1, cw());
  $('#zoomLabel').textContent = n ? (state.view.spp >= full * 0.98 ? 'весь трек' : `×${(full / state.view.spp).toFixed(1)}`) : 'весь трек';
  const maxStart = Math.max(0, len() - cw() * state.view.spp);
  $('#scroll').disabled = maxStart <= 0;
  $('#scroll').value = maxStart > 0 ? Math.round((state.view.start / maxStart) * 1000) : 0;
}

function redraw() {
  draw();
  updateInfo();
}

function afterEdit() {
  state.selA = clamp(state.selA, 0, len());
  state.selB = clamp(state.selB, state.selA, len());
  buildPeaks();
  redraw();
}

function fit() {
  state.view.start = 0;
  state.view.spp = Math.max(0.05, len() / Math.max(1, cw()));
  redraw();
}

function zoomAt(factor, x = cw() / 2) {
  const s = state.view.start + x * state.view.spp;
  state.view.spp /= factor;
  clampView();
  state.view.start = s - x * state.view.spp;
  redraw();
}

/* ---------------- Воспроизведение ---------------- */

let source = null, playStart = 0, playOffset = 0, raf = 0;

function toBuffer(channels, from = 0, to = channels[0].length) {
  const ac = ctxAudio();
  const buf = ac.createBuffer(channels.length, Math.max(1, to - from), state.rate);
  channels.forEach((d, c) => buf.copyToChannel(d.subarray(from, to), c));
  return buf;
}

function play() {
  if (!len() || state.recording) return;
  const ac = ctxAudio();
  ac.resume();
  stop(true);
  const [a, b] = hasSel() ? [state.selA, state.selB] : [state.selA >= len() - 1 ? 0 : state.selA, len()];
  source = ac.createBufferSource();
  source.buffer = toBuffer(state.channels);
  source.connect(ac.destination);
  if (state.loop && hasSel()) {
    source.loop = true;
    source.loopStart = a / state.rate;
    source.loopEnd = b / state.rate;
    source.start(0, a / state.rate);
  } else {
    source.start(0, a / state.rate, (b - a) / state.rate);
  }
  source.onended = () => { if (state.playing && !source.loop) stop(); };
  playStart = ac.currentTime;
  playOffset = a;
  state.playing = true;
  $('#playBtn').textContent = '❚❚';
  const tick = () => {
    if (!state.playing) return;
    let pos = playOffset + (ac.currentTime - playStart) * state.rate;
    if (source && source.loop) pos = a + ((pos - a) % (b - a));
    playheadSample = Math.min(pos, len());
    // Автопрокрутка за указателем.
    const x = xOf(playheadSample);
    if (x > cw() * 0.9 || x < 0) state.view.start = playheadSample - cw() * 0.1 * state.view.spp;
    meterAt(playheadSample);
    redraw();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function stop(keepHead) {
  if (source) {
    source.onended = null;
    try { source.stop(); } catch (_) { /* уже остановлен */ }
    source.disconnect();
    source = null;
  }
  cancelAnimationFrame(raf);
  if (state.playing && !keepHead && playheadSample >= 0 && !hasSel()) state.selA = state.selB = Math.round(playheadSample);
  state.playing = false;
  playheadSample = -1;
  $('#playBtn').textContent = '▶';
  $('#meterBar').style.width = '0';
  redraw();
}

function meterAt(s) {
  let peak = 0;
  const a = Math.floor(s), b = Math.min(len(), a + 1024);
  for (const d of state.channels) for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(d[i]));
  $('#meterBar').style.width = Math.round(Math.min(1, peak) * 100) + '%';
}

/* ---------------- Запись ---------------- */

let recorder = null, recStream = null, recTimer = 0, recAnalyser = null;

async function toggleRecord() {
  if (state.recording) {
    recorder.stop();
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    status('Этот браузер не умеет записывать звук.');
    return;
  }
  stop();
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    status('Нет доступа к микрофону — разрешите его в настройках браузера.');
    return;
  }
  const ac = ctxAudio();
  ac.resume();
  recAnalyser = ac.createAnalyser();
  recAnalyser.fftSize = 1024;
  ac.createMediaStreamSource(recStream).connect(recAnalyser);
  const chunks = [];
  recorder = new MediaRecorder(recStream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    state.recording = false;
    clearInterval(recTimer);
    recStream.getTracks().forEach((t) => t.stop());
    $('#recBtn').classList.remove('on');
    $('#meterBar').style.width = '0';
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      const decoded = await ac.decodeAudioData(await blob.arrayBuffer());
      insertBuffer(decoded, 'Запись вставлена');
    } catch (_) {
      status('Не удалось обработать запись.');
    }
  };
  recorder.start();
  state.recording = true;
  $('#recBtn').classList.add('on');
  const t0 = performance.now();
  const buf = new Float32Array(recAnalyser.fftSize);
  recTimer = setInterval(() => {
    recAnalyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    $('#meterBar').style.width = Math.round(Math.min(1, peak) * 100) + '%';
    $('#clock').textContent = '● ' + fmtTime((performance.now() - t0) / 1000);
  }, 60);
  status('Идёт запись… Нажмите ● ещё раз, чтобы остановить.');
}

/* ---------------- Правка ---------------- */

/** Приводит каналы к числу каналов документа. */
function matchChannels(chs) {
  const n = state.channels.length || chs.length;
  if (chs.length === n) return chs;
  if (n === 1) {
    const m = new Float32Array(chs[0].length);
    for (const d of chs) for (let i = 0; i < m.length; i++) m[i] += d[i] / chs.length;
    return [m];
  }
  return Array.from({ length: n }, (_, c) => chs[Math.min(c, chs.length - 1)]);
}

function insertChannels(chs, at) {
  chs = matchChannels(chs);
  if (!state.channels.length) {
    state.channels = chs.map((d) => new Float32Array(d));
    return;
  }
  state.channels = state.channels.map((d, c) => {
    const out = new Float32Array(d.length + chs[c].length);
    out.set(d.subarray(0, at), 0);
    out.set(chs[c], at);
    out.set(d.subarray(at), at + chs[c].length);
    return out;
  });
}

function removeRange(a, b) {
  state.channels = state.channels.map((d) => {
    const out = new Float32Array(d.length - (b - a));
    out.set(d.subarray(0, a), 0);
    out.set(d.subarray(b), a);
    return out;
  });
}

function insertBuffer(buf, msg) {
  const chs = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  if (len() + chs[0].length > MAX_SECONDS * state.rate) { status('Слишком длинная запись (предел — 20 минут).'); return; }
  const wasEmpty = !len();
  pushHistory();
  if (wasEmpty) state.rate = buf.sampleRate;
  // Запись и вставка из файла не стирают выделение — встают сразу после него (или в курсор).
  const at = state.selB;
  insertChannels(chs, at);
  state.selA = at;
  state.selB = at + chs[0].length;
  afterEdit();
  if (wasEmpty) fit();
  status(msg);
}

/** Применяет fn(вход, выход, i0) к выделению (или всей записи) — с копированием массивов. */
function applyEffect(name, fn) {
  if (!len()) return;
  stop();
  pushHistory();
  const [a, b] = range();
  state.channels = state.channels.map((d, c) => {
    const out = new Float32Array(d);
    fn(d.subarray(a, b), out.subarray(a, b), c);
    return out;
  });
  afterEdit();
  status(name);
}

let clip = null;

function encodeWAV(channels, rate, from = 0, to = channels[0].length) {
  const n = to - from, nch = channels.length;
  const buf = new ArrayBuffer(44 + n * nch * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * nch * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * nch * 2, true);
  let o = 44;
  for (let i = from; i < to; i++) {
    for (let c = 0; c < nch; c++) {
      const s = clamp(channels[c][i], -1, 1);
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function waveThumb() {
  const c = makeCanvas(240, 120);
  const x = c.getContext('2d');
  x.fillStyle = '#0d2340';
  x.fillRect(0, 0, 240, 120);
  x.fillStyle = '#3fd0c9';
  const d = state.channels[0];
  if (d) {
    const spp = d.length / 240;
    for (let i = 0; i < 240; i++) {
      let hi = 0;
      for (let s = Math.floor(i * spp), e = Math.floor((i + 1) * spp); s < e; s += 16) hi = Math.max(hi, Math.abs(d[s]));
      x.fillRect(i, 60 - hi * 55, 1, Math.max(1, hi * 110));
    }
  }
  return c;
}

async function saveVolna() {
  if (!len()) { status('Нечего сохранять — запись пустая.'); return; }
  const doc = {
    format: 'volna', version: VOLNA_VERSION, app: 'Волна',
    sampleRate: state.rate, channels: state.channels.length, duration: len() / state.rate,
    audio: await blobToDataUrl(encodeWAV(state.channels, state.rate)),
  };
  const name = state.docName + '.volna';
  const blob = new Blob([JSON.stringify(doc)], { type: 'application/octet-stream' });
  Fleet.download(blob, name);
  Fleet.addRecent(name, 'volna', blob, Fleet.thumbOf(waveThumb()));
  state.dirty = false;
  status(`⚓ Сохранено: ${name}`);
}

async function decodeFile(file) {
  const ac = ctxAudio();
  try {
    return await ac.decodeAudioData(await file.arrayBuffer());
  } catch (_) {
    throw new Error('Не удалось прочитать звук из этого файла');
  }
}

function confirmDiscard() {
  return !state.dirty || confirm('Несохранённые изменения будут потеряны. Продолжить?');
}

function loadBuffer(buf, name) {
  stop();
  state.rate = buf.sampleRate;
  state.channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => new Float32Array(buf.getChannelData(c)));
  state.selA = state.selB = 0;
  hist.undo.length = 0;
  hist.redo.length = 0;
  updateHistoryButtons();
  state.dirty = false;
  state.docName = name || 'volna';
  buildPeaks();
  fit();
}

async function openFile(file) {
  try {
    const app = Fleet.appForFile(file.name, file.type);
    const ext = Fleet.extOf(file.name);
    if (ext === 'volna') {
      let doc;
      try { doc = JSON.parse(await file.text()); } catch (_) { throw new Error('Файл .volna повреждён'); }
      if (!doc || doc.format !== 'volna' || typeof doc.audio !== 'string' || !doc.audio.startsWith('data:audio/wav;base64,')) {
        throw new Error('Это не файл Волны (.volna)');
      }
      if (doc.version > VOLNA_VERSION) throw new Error('Файл создан более новой версией Волны — обновите страницу');
      const bin = await (await fetch(doc.audio)).blob();
      const buf = await decodeFile(bin);
      if (!confirmDiscard()) return;
      loadBuffer(buf, Fleet.baseName(file.name));
      Fleet.addRecent(file.name, 'volna', file, Fleet.thumbOf(waveThumb()));
      status(`⚓ Открыт ${file.name}`);
      return;
    }
    if (app && (app.id === 'volna' || app.id === 'kadr') && ext !== 'kadr') {
      const buf = await decodeFile(file);
      if (buf.duration > MAX_SECONDS) throw new Error('Слишком длинный файл (предел — 20 минут)');
      if (!confirmDiscard()) return;
      loadBuffer(buf, Fleet.baseName(file.name));
      status(`Открыт ${file.name}: ${buf.duration.toFixed(1)} с`);
      return;
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

/* ---------------- Действия ---------------- */

const actions = {
  new() {
    if (!confirmDiscard()) return;
    stop();
    state.channels = [];
    state.selA = state.selB = 0;
    hist.undo.length = hist.redo.length = 0;
    updateHistoryButtons();
    state.dirty = false;
    state.docName = 'volna';
    afterEdit();
  },
  open: () => $('#fileOpen').click(),
  importAudio: () => $('#fileImport').click(),
  save: saveVolna,
  exportWav() {
    if (!len()) return;
    Fleet.download(encodeWAV(state.channels, state.rate), state.docName + '.wav');
    status('WAV сохранён');
  },
  exportSel() {
    if (!hasSel()) { status('Сначала выделите кусок записи.'); return; }
    Fleet.download(encodeWAV(state.channels, state.rate, state.selA, state.selB), state.docName + '-part.wav');
  },
  harbor: () => { location.href = 'index.html'; },
  undo, redo,
  play: () => (state.playing ? stop() : play()),
  stop: () => stop(),
  toStart() { stop(); state.selA = state.selB = 0; state.view.start = 0; redraw(); },
  record: toggleRecord,
  copy() {
    if (!hasSel()) return;
    clip = state.channels.map((d) => d.slice(state.selA, state.selB));
    status('Скопировано');
  },
  cut() {
    if (!hasSel()) return;
    actions.copy();
    actions.del();
  },
  paste() {
    if (!clip) { status('Буфер пуст.'); return; }
    stop();
    pushHistory();
    const at = state.selA;
    if (hasSel()) removeRange(state.selA, state.selB);
    insertChannels(clip, at);
    state.selA = at;
    state.selB = at + clip[0].length;
    afterEdit();
  },
  del() {
    if (!hasSel()) return;
    stop();
    pushHistory();
    removeRange(state.selA, state.selB);
    state.selB = state.selA;
    afterEdit();
  },
  crop() {
    if (!hasSel()) { status('Выделите, что оставить.'); return; }
    stop();
    pushHistory();
    state.channels = state.channels.map((d) => d.slice(state.selA, state.selB));
    state.selA = 0;
    state.selB = len();
    afterEdit();
    fit();
  },
  selectAll() { state.selA = 0; state.selB = len(); redraw(); },
  deselect() { state.selB = state.selA; redraw(); },
  fadeIn: () => applyEffect('Плавное появление', (src, out) => {
    for (let i = 0; i < src.length; i++) out[i] = src[i] * (i / src.length);
  }),
  fadeOut: () => applyEffect('Плавное затухание', (src, out) => {
    for (let i = 0; i < src.length; i++) out[i] = src[i] * (1 - i / src.length);
  }),
  normalize() {
    let peak = 0;
    const [a, b] = range();
    for (const d of state.channels) for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (!peak) return;
    const k = 0.891 / peak; // −1 дБ
    applyEffect(`Нормализовано (×${k.toFixed(2)})`, (src, out) => { for (let i = 0; i < src.length; i++) out[i] = src[i] * k; });
  },
  gain() {
    openModal({
      title: 'Громкость',
      fields: [{ key: 'db', label: 'Изменить на, дБ', type: 'range', min: -24, max: 24, step: 0.5, value: 3 }],
      onOk: ({ db }) => {
        const k = 10 ** (db / 20);
        applyEffect(`Громкость ${db > 0 ? '+' : ''}${db} дБ`, (src, out) => {
          for (let i = 0; i < src.length; i++) out[i] = clamp(src[i] * k, -1, 1);
        });
      },
    });
  },
  echo() {
    openModal({
      title: 'Эхо',
      fields: [
        { key: 'delay', label: 'Задержка, мс', type: 'range', min: 40, max: 1000, step: 10, value: 250 },
        { key: 'fb', label: 'Повторы, %', type: 'range', min: 0, max: 90, value: 45 },
        { key: 'mix', label: 'Громкость эха, %', type: 'range', min: 0, max: 100, value: 50 },
      ],
      onOk: ({ delay, fb, mix }) => {
        const dS = Math.round((delay / 1000) * state.rate), f = fb / 100, m = mix / 100;
        applyEffect('Эхо', (src, out) => {
          const wet = new Float32Array(src.length);
          for (let i = 0; i < src.length; i++) wet[i] = (i >= dS ? (src[i - dS] + wet[i - dS] * f) : 0);
          for (let i = 0; i < src.length; i++) out[i] = clamp(src[i] + wet[i] * m, -1, 1);
        });
      },
    });
  },
  reverse: () => applyEffect('Задом наперёд', (src, out) => {
    for (let i = 0; i < src.length; i++) out[i] = src[src.length - 1 - i];
  }),
  silence() {
    if (!hasSel()) { status('Выделите кусок, который нужно заглушить.'); return; }
    applyEffect('Заглушено', (src, out) => out.fill(0));
  },
  insertSilence() {
    openModal({
      title: 'Вставить тишину',
      fields: [{ key: 's', label: 'Длительность, с', value: 1, min: 0.01, max: 600, step: 0.01 }],
      onOk: ({ s }) => {
        const n = Math.round(clamp(s, 0.01, 600) * state.rate);
        stop();
        pushHistory();
        const nch = state.channels.length || 1;
        insertChannels(Array.from({ length: nch }, () => new Float32Array(n)), state.selA);
        state.selB = state.selA + n;
        afterEdit();
        if (len() === n) fit();
      },
    });
  },
  zoomIn: () => zoomAt(1.6),
  zoomOut: () => zoomAt(1 / 1.6),
  fit,
  zoomSel() {
    if (!hasSel()) return;
    state.view.spp = (state.selB - state.selA) / (cw() * 0.9);
    state.view.start = state.selA - cw() * 0.05 * state.view.spp;
    redraw();
  },
  shortcuts() {
    const rows = [
      ['Пробел', 'Играть / пауза'], ['R', 'Запись с микрофона'], ['L', 'Повтор выделения'], ['Home', 'В начало'],
      ['Ctrl+A', 'Выделить всё'], ['Ctrl+X / C / V', 'Вырезать / копировать / вставить'], ['Del', 'Удалить выделение'],
      ['+ / −', 'Приблизить / отдалить'], ['Колесо мыши', 'Масштаб (Shift — прокрутка)'], ['Ctrl+0', 'Вся запись'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Отменить / повторить'], ['Ctrl+S', 'Сохранить .volna'],
    ];
    openModal({ title: 'Горячие клавиши', html: '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>', cancel: false });
  },
  about() {
    openModal({
      title: 'Волна',
      html: `<p><b>Волна</b> — звуковой редактор из набора PhipiShip Флот. Запишите голос с микрофона или откройте
        файл (MP3, WAV, OGG, M4A, звук из видео), вырежьте лишнее, добавьте затухания и эхо.</p>
        <p>Проект хранится в формате <b>.volna</b>, для других программ — экспорт в WAV.</p>`,
      cancel: false,
    });
  },
};

function runAction(name) {
  const fn = actions[name];
  if (fn) fn();
}

/* ---------------- Мышь ---------------- */

let drag = null;

canvas.addEventListener('pointerdown', (e) => {
  if (!len() || e.button !== 0) return;
  const r = canvas.getBoundingClientRect();
  const s = clamp(sOf(e.clientX - r.left), 0, len());
  if (e.shiftKey && (hasSel() || state.selA)) {
    // Shift+клик расширяет выделение.
    if (s < state.selA) state.selA = s; else state.selB = s;
    redraw();
    return;
  }
  if (state.playing) stop(true);
  drag = { anchor: s };
  state.selA = state.selB = s;
  canvas.setPointerCapture(e.pointerId);
  redraw();
});

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const s = clamp(sOf(e.clientX - r.left), 0, len());
  $('#statusCoords').textContent = len() ? fmtTime(s / state.rate) : '—';
  if (!drag) return;
  state.selA = Math.min(drag.anchor, s);
  state.selB = Math.max(drag.anchor, s);
  redraw();
});

const endDrag = () => { drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('wheel', (e) => {
  if (!len()) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    state.view.start += (e.deltaX || e.deltaY) * state.view.spp;
    redraw();
  } else {
    zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX - r.left);
  }
}, { passive: false });

$('#scroll').addEventListener('input', (e) => {
  const maxStart = Math.max(0, len() - cw() * state.view.spp);
  state.view.start = (e.target.value / 1000) * maxStart;
  draw();
});

/* ---------------- Привязки ---------------- */

initModal();
initMenus(runAction);
initTooltips();
Fleet.initThemePicker();
Fleet.mountSwitcher('volna');

$('#loop').addEventListener('change', (e) => { state.loop = e.target.checked; });
$('#fileOpen').accept = Fleet.ACCEPT_ALL;
$('#fileOpen').addEventListener('change', (e) => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('#fileImport').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { insertBuffer(await decodeFile(f), `Вставлено: ${f.name}`); } catch (err) { status(err.message); }
});

area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('dragover'); });
area.addEventListener('dragleave', () => area.classList.remove('dragover'));
area.addEventListener('drop', (e) => {
  e.preventDefault();
  area.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });
new ResizeObserver(() => { resizeCanvas(); redraw(); }).observe(canvas);
new MutationObserver(() => draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

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
    const map = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: 'save', o: 'open', a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', '0': 'fit' };
    if (map[k]) { e.preventDefault(); runAction(map[k]); }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); runAction('play'); return; }
  if (e.key === 'Escape') { closeMenus(); actions.deselect(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); runAction('del'); return; }
  if (e.key === 'Home') { runAction('toStart'); return; }
  if (e.key === 'End') { state.selA = state.selB = len(); redraw(); return; }
  if (e.key === '+' || e.key === '=') { runAction('zoomIn'); return; }
  if (e.key === '-') { runAction('zoomOut'); return; }
  if (k === 'r') { runAction('record'); return; }
  if (k === 'l') { $('#loop').click(); return; }
});

resizeCanvas();
afterEdit();
updateHistoryButtons();
Fleet.takeHandoff().then((file) => { if (file) openFile(file); });
