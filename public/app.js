const $ = id => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');
const STORE_KEY = 'codevideo.saved.v1';
const DEFAULT_TPL = 'particles';
const DEFAULT_CODE = TEMPLATES[DEFAULT_TPL];
const ACTIVE_KEY = 'codevideo.activeRender';

const TPL_META = {
  particles: ['Partikel', '2D'], bars: ['Bar chart', '2D'], typewriter: ['Ketik', '2D'],
  wave: ['Gelombang', '2D'], pulse: ['Denyut', '2D'],
  cube: ['Kubus', '3D'], globe: ['Bola titik', '3D'], torus: ['Torus', '3D'],
};
const TITLES = { editor: 'Editor', render: 'Render', gallery: 'Galeri', saved: 'Tersimpan', docs: 'Dokumentasi' };

//  STATE 
const state = { size: 720, ratio: '1:1', fps: 30, dur: 5, quality: 'medium' };
const RATIOS = { '1:1': [1, 1], '16:9': [16, 9], '9:16': [9, 16], '4:5': [4, 5] };
const QUALITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };
const DUR_WARN_LIMIT = 120;
let propValues = {};
let schemaKey = null;
let busy = false;
let raf = null;
let abortRender = false;
let defaultDest = '';
let audio = null; // { id, name, duration, loop }
const scrollMemo = {};

function dims() {
  const [rw, rh] = RATIOS[state.ratio];
  let W, H;
  if (rw >= rh) { W = state.size; H = state.size * rh / rw; }
  else          { H = state.size; W = state.size * rw / rh; }
  W = Math.round(W / 2) * 2;
  H = Math.round(H / 2) * 2;
  return { W, H, fps: state.fps, D: state.dur };
}

function refreshInfo() {
  const d = dims();
  $('dims').textContent = `${d.W}×${d.H}`;
  $('frames').textContent = Math.round(d.D * d.fps);
  $('qLabel').textContent = QUALITY_LABEL[state.quality];
  $('hint').classList.toggle('show', state.size >= 1440);
  $('hint').querySelector('span').textContent = state.size >= 2160
    ? 'Render 4K butuh waktu lama dan memori besar. Gunakan Low atau Medium jika lambat.'
    : 'Render 1440p ke atas lebih lama dan butuh memori lebih besar.';
  refreshAudioNote();
}

//  TAB 
function currentTab() {
  const a = document.querySelector('.page.active');
  return a ? a.id.replace('page-', '') : 'editor';
}

function showTab(name) {
  const prev = currentTab();
  if (prev !== name) scrollMemo[prev] = window.scrollY;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  $('pageTitle').textContent = TITLES[name] || name;
  if (name === 'gallery') loadGallery();
  if (name === 'saved') renderSaved();
  if (name === 'docs') loadDocs();
  window.scrollTo(0, scrollMemo[name] || 0);
}

document.querySelectorAll('.nav-item').forEach(b => b.onclick = () => showTab(b.dataset.tab));
$('toGallery').onclick = () => showTab('gallery');
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

//  SNACKBAR 
const SNACK_ICON = { success: 'circle-check', error: 'circle-exclamation', warn: 'triangle-exclamation', info: 'circle-info' };
function toast(msg, type = 'info', icon = null) {
  const host = $('snackbars');
  host.querySelectorAll('.snack').forEach(s => s.remove());
  const el = document.createElement('div');
  el.className = `snack ${type}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<i class="fa-solid fa-${icon || SNACK_ICON[type]}"></i><span></span>`;
  el.querySelector('span').textContent = msg;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, 3200);
}

//  DIALOG 
function confirmBox(title, text, opts = {}) {
  return new Promise(resolve => {
    const icon = $('mIcon');
    icon.className = 'dlg-icon ' + (opts.kind || '');
    icon.innerHTML = `<i class="fa-solid fa-${opts.icon || 'circle-info'}"></i>`;
    $('mTitle').textContent = title;
    $('mText').textContent = text;
    const inp = $('mInput');
    inp.hidden = !opts.input;
    if (opts.input) { inp.value = opts.input.value || ''; inp.placeholder = opts.input.placeholder || ''; }
    const ok = $('mOk');
    ok.textContent = opts.okText || 'OK';
    ok.className = 'btn text ' + (opts.okClass || 'primary');
    if (opts.okClass === 'danger') ok.classList.add('danger-txt');
    $('overlay').classList.add('show');
    if (opts.input) setTimeout(() => inp.focus(), 60);
    const done = v => {
      $('overlay').classList.remove('show');
      ok.onclick = $('mCancel').onclick = null;
      resolve(v);
    };
    ok.onclick = () => done(opts.input ? inp.value.trim() : true);
    $('mCancel').onclick = () => done(opts.input ? null : false);
  });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('overlay').classList.contains('show')) $('mCancel').click();
});

//  PENGATURAN RENDER 
function setBusy(on) {
  busy = on;
  $('play').disabled = on;
  $('render').disabled = on;
  $('saveBtn').disabled = on;
  $('pickAudio').disabled = on;
  $('clearAudio').disabled = on;
  $('loopAudio').disabled = on;
}

function setChip(key, value) {
  const group = document.querySelector(`[data-group="${key}"]`);
  group.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.value === value));
  if (key === 'dur') $('customRow').style.display = value === 'custom' ? 'flex' : 'none';
  if (key === 'size') state.size = +value;
  else if (key === 'ratio') state.ratio = value;
  else if (key === 'fps') state.fps = +value;
  else if (key === 'quality') state.quality = value;
  else if (key === 'dur' && value !== 'custom') {
    state.dur = +value;
    $('durWarn').classList.remove('show');
  }
  refreshInfo();
}

document.querySelectorAll('[data-group]').forEach(group => {
  const key = group.dataset.group;
  group.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip || busy) return;
    if (key === 'dur' && chip.dataset.value === 'custom') {
      setChip('dur', 'custom');
      applyCustomDur(true);
      return;
    }
    setChip(key, chip.dataset.value);
  });
});

//  DURASI KUSTOM 
function applyCustomDur(commit = false) {
  const raw = $('durInput').value.trim();
  let v = parseFloat(raw);

  if (!commit) {
    if (!isNaN(v) && v > 0) state.dur = v;
    warnDuration(!isNaN(v) ? v : NaN);
    refreshInfo();
    return;
  }

  if (isNaN(v) || v <= 0) {
    v = state.dur > 0 ? state.dur : 5;
  }
  v = Math.round(v * 10) / 10;
  $('durInput').value = v;
  state.dur = v;
  warnDuration(v);
  refreshInfo();
}

function warnDuration(v) {
  const warn = $('durWarn');
  const over = !isNaN(v) && v > DUR_WARN_LIMIT;
  warn.classList.toggle('show', over);
  if (over) {
    warn.querySelector('span').textContent =
      `Durasi ${v} detik lebih dari ${DUR_WARN_LIMIT} detik. Render akan lama dan memakan banyak memori. Pastikan HP tetap aktif.`;
  }
}

$('durInput').addEventListener('input', () => applyCustomDur(false));
$('durInput').addEventListener('change', () => applyCustomDur(true));
$('durInput').addEventListener('blur', () => applyCustomDur(true));
$('durInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('durInput').blur(); }
});

//  AUDIO 
function fmtDur(s) {
  s = Math.round(s * 10) / 10;
  const m = Math.floor(s / 60), r = (s - m * 60).toFixed(1);
  return m ? `${m}:${r.padStart(4, '0')}` : `${r} dtk`;
}

function refreshAudioNote() {
  if (!audio) return;
  const vd = dims().D;
  let msg;
  if (audio.duration > vd + 0.05) {
    msg = `Audio ${fmtDur(audio.duration)} lebih panjang dari video ${fmtDur(vd)}. Audio akan dipotong.`;
  } else if (audio.duration < vd - 0.05) {
    msg = `Audio ${fmtDur(audio.duration)} lebih pendek dari video ${fmtDur(vd)}. Sisanya hening, atau aktifkan loop agar audio berulang.`;
  } else {
    msg = `Durasi audio dan video sama (${fmtDur(vd)}).`;
  }
  $('loopNote').textContent = msg;
}

function renderAudio() {
  $('audioEmpty').hidden = !!audio;
  $('audioSet').hidden = !audio;
  if (audio) {
    $('audioName').textContent = audio.name;
    $('audioMeta').textContent = fmtDur(audio.duration);
    $('loopAudio').checked = !!audio.loop;
  }
  refreshAudioNote();
}

$('pickAudio').onclick = () => $('audioFile').click();
$('audioFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) return toast('Ukuran audio maksimal 60 MB', 'error');
  toast('Mengunggah audio...', 'info', 'cloud-arrow-up');
  try {
    const r = await fetch('/api/audio', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'audio/mpeg', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'gagal');
    audio = { id: data.id, name: data.name, duration: data.duration, loop: false };
    renderAudio();
    toast('Audio siap dipakai', 'success', 'music');
  } catch (err) {
    toast('Gagal unggah audio: ' + err.message, 'error');
  }
};

$('clearAudio').onclick = () => {
  audio = null;
  renderAudio();
};

$('loopAudio').onchange = () => {
  if (audio) audio.loop = $('loopAudio').checked;
};

//  TEMPLATE DROPDOWN 
function buildTplSelect() {
  const sel = $('tplSelect');
  sel.innerHTML = '';
  const placeholder = new Option('Pilih template…', '');
  placeholder.disabled = true;
  sel.appendChild(placeholder);
  ['2D', '3D'].forEach(group => {
    const og = document.createElement('optgroup');
    og.label = group === '2D' ? '2D — Dua dimensi' : '3D — Tiga dimensi';
    Object.keys(TEMPLATES).forEach(key => {
      const meta = TPL_META[key];
      if (meta && meta[1] === group) og.appendChild(new Option(meta[0], key));
    });
    sel.appendChild(og);
  });
  sel.value = DEFAULT_TPL;
}

$('tplSelect').addEventListener('change', () => {
  const key = $('tplSelect').value;
  if (!key || busy) return;
  $('code').value = TEMPLATES[key];
  propValues = {};
  syncProps(true);
  toast(`Template "${TPL_META[key][0]}" dimuat`, 'success', 'wand-magic-sparkles');
});

//  PROPS 
function parseProps(code) {
  const m = code.match(/\/\*\s*props\s*([\s\S]*?)\*\//);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

function renderPropsGrid(schema) {
  const grid = $('propsGrid');
  grid.innerHTML = '';
  if (schema === null) {
    grid.innerHTML = '<div class="empty"><i class="fa-solid fa-triangle-exclamation"></i>Blok <code>/* props */</code> bukan JSON yang valid</div>';
    return;
  }
  if (!schema.length) {
    grid.innerHTML = '<div class="empty"><i class="fa-solid fa-sliders"></i>Composition ini belum punya props.<br>Tambahkan blok <code>/* props [...] */</code> di baris pertama.</div>';
    return;
  }
  schema.forEach(item => {
    const v = propValues[item.key];
    const row = document.createElement('div');
    row.className = 'prop';
    const label = document.createElement('label');
    label.textContent = item.label || item.key;
    row.appendChild(label);

    let input, out = null;
    if (item.type === 'range') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = item.min; input.max = item.max; input.step = item.step || 'any';
      input.value = v;
      out = document.createElement('span');
      out.className = 'val';
      out.textContent = v;
    } else if (item.type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!v;
    } else if (item.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.value = /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff';
    } else if (item.type === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.className = 'field';
      input.step = item.step || 'any';
      input.value = v;
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'field';
      input.maxLength = 200;
      input.value = v ?? '';
    }

    input.addEventListener('input', () => {
      let val;
      if (item.type === 'checkbox') val = input.checked;
      else if (item.type === 'range' || item.type === 'number') val = parseFloat(input.value);
      else val = input.value;
      propValues[item.key] = val;
      if (out) out.textContent = val;
    });

    row.appendChild(input);
    if (out) row.appendChild(out);
    grid.appendChild(row);
  });
}

function syncProps(force = false) {
  const schema = parseProps($('code').value);
  const key = JSON.stringify(schema);
  if (!force && key === schemaKey) return;
  schemaKey = key;
  if (schema === null) { renderPropsGrid(null); return; }
  const next = {};
  schema.forEach(item => {
    next[item.key] = (item.key in propValues) ? propValues[item.key] : item.value;
  });
  propValues = next;
  renderPropsGrid(schema);
}

$('resetProps').onclick = async () => {
  const ok = await confirmBox('Kembalikan props?', 'Semua nilai props akan kembali ke default dari kode.', { icon: 'arrow-rotate-left' });
  if (!ok) return;
  propValues = {};
  syncProps(true);
  toast('Props dikembalikan ke default', 'warn', 'arrow-rotate-left');
};

let codeTimer = null;
$('code').addEventListener('input', () => {
  clearTimeout(codeTimer);
  codeTimer = setTimeout(() => syncProps(), 350);
});

//  PREVIEW 
function compile(code) {
  return new Function('ctx', 't', 'W', 'H', 'D', 'P', code);
}
function syncCanvas(d) {
  if (cv.width !== d.W) cv.width = d.W;
  if (cv.height !== d.H) cv.height = d.H;
}

$('play').onclick = () => {
  cancelAnimationFrame(raf);
  let fn;
  try { fn = compile($('code').value); }
  catch (e) { return toast('Error kompilasi: ' + e.message, 'error'); }
  const start = performance.now();
  const loop = now => {
    const d = dims();
    syncCanvas(d);
    const t = ((now - start) / 1000) % d.D;
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      fn(ctx, t, d.W, d.H, d.D, { ...propValues });
    } catch (e) {
      toast('Runtime error: ' + e.message, 'error');
      return;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  toast('Preview berjalan', 'info', 'play');
};

//  RENDER 
function setRenderUI(on) {
  setBusy(on);
  $('stop').style.display = on ? '' : 'none';
  $('renderWarn').hidden = !on;
  $('render').classList.toggle('busy', on);
  $('render').innerHTML = on
    ? '<i class="fa-solid fa-spinner"></i> Rendering'
    : '<i class="fa-solid fa-clapperboard"></i> Render';
  $('progress').classList.toggle('show', on);
}

function updateProgress(done, total) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  $('bar').style.width = pct + '%';
  $('ppct').textContent = pct + '%';
  $('ptext').textContent = `Frame ${done} / ${total}`;
}

function fmtAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  return new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function renderJobCard(jobs) {
  const card = $('jobCard');
  const list = $('jobList');
  if (!jobs.length) { card.hidden = true; return; }
  card.hidden = false;
  list.innerHTML = '';
  jobs.forEach(j => {
    const el = document.createElement('div');
    el.className = 'job-item';
    const label = { running: 'Berjalan', done: 'Selesai', error: 'Gagal' }[j.status] || j.status;
    const pct = j.total ? Math.min(100, Math.round((j.frames / j.total) * 100)) : 0;
    el.innerHTML = `
      <div class="job-top">
        <div class="txt">
          <div class="name"></div>
          <div class="meta">${j.width}×${j.height} · ${j.fps} fps · ${j.duration} dtk${j.audio ? ' · audio' : ''} · ${fmtAgo(j.startedAt)}</div>
        </div>
        <span class="job-status ${j.status}">${label}</span>
      </div>
      ${j.status === 'running' ? `<div class="job-bar"><span style="width:${pct}%"></span></div>
        <div class="job-msg">Frame ${j.frames} / ${j.total}. Jika layar mati atau browser ditutup, render bisa terhenti.</div>` : ''}
      ${j.status === 'error' ? `<div class="job-msg"></div>` : ''}
      <div class="job-actions">
        ${j.status === 'done' ? `<a class="btn filled" href="${j.file}" download="${j.id}.mp4"><i class="fa-solid fa-download"></i> Unduh</a>
          <button class="btn outlined" data-jact="gallery"><i class="fa-solid fa-photo-film"></i> Galeri</button>` : ''}
        ${j.status !== 'running' ? `<button class="btn text" data-jact="remove"><i class="fa-solid fa-trash"></i> Hapus riwayat</button>` : ''}
      </div>`;
    if (j.status === 'error') el.querySelector('.job-msg').textContent = j.error || 'Render gagal';
    el.querySelector('.name').textContent = j.name;
    el.dataset.id = j.id;
    list.appendChild(el);
  });
}

const DISMISS_KEY = 'codevideo.dismissedJobs';
const dismissed = new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'));
function dismiss(id) {
  dismissed.add(id);
  localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed].slice(-50)));
}
function recentEnough(j) {
  return (Date.now() - (j.finishedAt || j.startedAt)) < 60 * 60 * 1000;
}

async function refreshJobs() {
  try {
    const data = await (await fetch('/api/jobs')).json();
    const visible = data.jobs.filter(j =>
      j.status === 'running' || (!dismissed.has(j.id) && recentEnough(j)));
    renderJobCard(visible);
    updateLiveRender(data);
  } catch {}
}

let watchTimer = null;
function updateLiveRender(data) {
  const running = data.jobs.find(j => j.status === 'running');
  if (running && !busy) {
    setRenderUI(true);
    $('stop').style.display = 'none';
    $('ptext').textContent = 'Render berjalan di server';
    updateProgress(running.frames, running.total);
    $('renderWarn').querySelector('span').textContent =
      'Render sedang berjalan di server. Jangan tutup aplikasi ini hingga selesai.';
    $('render').disabled = true;
    $('play').disabled = true;
  } else if (!running && !busy) {
    if (document.querySelector('.page.active').id === 'page-render') {
      setRenderUI(false);
    }
    $('renderWarn').querySelector('span').textContent =
      'Jangan tutup atau tinggalkan aplikasi ini saat render berlangsung. Layar sebaiknya tetap menyala.';
  }
  if (running) {
    if (!watchTimer) watchTimer = setInterval(refreshJobs, 2000);
  } else if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

$('hideJob').onclick = () => {
  document.querySelectorAll('.job-item').forEach(el => {
    if (!el.querySelector('.job-status.running')) dismiss(el.dataset.id);
  });
  refreshJobs();
};

$('jobList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-jact]');
  if (!btn) return;
  const el = btn.closest('.job-item');
  const id = el.dataset.id;
  if (btn.dataset.jact === 'gallery') return showTab('gallery');
  if (btn.dataset.jact === 'remove') {
    dismiss(id);
    await fetch('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
    refreshJobs();
  }
});

window.addEventListener('beforeunload', e => {
  if (busy) { e.preventDefault(); e.returnValue = ''; }
});

$('stop').onclick = () => { abortRender = true; };

$('render').onclick = async () => {
  cancelAnimationFrame(raf);
  let fn;
  try { fn = compile($('code').value); }
  catch (e) { return toast('Error kompilasi: ' + e.message, 'error'); }

  const d = dims();
  const total = Math.round(d.D * d.fps);
  const props = { ...propValues };
  syncCanvas(d);

  setBusy(true);
  abortRender = false;
  setRenderUI(true);
  $('renderWarn').querySelector('span').textContent =
    'Jangan tutup atau tinggalkan aplikasi ini saat render berlangsung. Layar sebaiknya tetap menyala.';
  $('ptext').textContent = 'Memulai encoder...';
  $('ppct').textContent = '0%';
  $('bar').style.width = '0%';
  $('result').classList.remove('show');

  let started = false;
  try {
    const s = await fetch('/api/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        width: d.W, height: d.H, fps: d.fps, duration: d.D,
        quality: state.quality,
        audio: audio ? { id: audio.id, name: audio.name, loop: audio.loop } : null,
      })
    });
    const sd = await s.json();
    if (!s.ok) throw new Error(sd.error || 'gagal memulai');
    started = true;
    refreshJobs();

    for (let i = 0; i < total; i++) {
      if (abortRender) throw new Error('Dihentikan pengguna');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      fn(ctx, i / d.fps, d.W, d.H, d.D, props);
      const buf = ctx.getImageData(0, 0, d.W, d.H).data.buffer;
      const r = await fetch('/api/frame', { method: 'POST', body: buf });
      if (!r.ok) throw new Error((await r.json()).error || 'frame gagal');
      if (i % 5 === 0 || i === total - 1) updateProgress(i + 1, total);
    }

    $('ptext').textContent = 'Menyelesaikan encoding...';
    const res = await fetch('/api/finish', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'FFmpeg gagal');

    $('ptext').textContent = 'Selesai';
    $('vid').src = data.file;
    $('dl').href = data.file;
    $('dl').download = data.name;
    $('result').classList.add('show');
    toast('Video berhasil dirender', 'success');
  } catch (e) {
    if (started) fetch('/api/abort', { method: 'POST' }).catch(() => {});
    if (/audio tidak ditemukan/.test(e.message)) { audio = null; renderAudio(); }
    $('ptext').textContent = 'Gagal';
    toast('Render gagal: ' + e.message.slice(-200), 'error');
  } finally {
    setBusy(false);
    setRenderUI(false);
    refreshJobs();
  }
};

//  GALERI 
async function loadConfig() {
  try {
    const c = await (await fetch('/api/config')).json();
    defaultDest = c.defaultDest;
  } catch {}
}

function fmtSize(b) {
  return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
}
function fmtDate(ms) {
  return new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

async function loadGallery() {
  const box = $('galleryList');
  box.innerHTML = '<div class="empty"><i class="fa-solid fa-spinner fa-spin"></i>Memuat...</div>';
  try {
    const list = await (await fetch('/api/videos')).json();
    renderGallery(list);
  } catch {
    box.innerHTML = '<div class="empty"><i class="fa-solid fa-triangle-exclamation"></i>Gagal memuat galeri</div>';
  }
}

function renderGallery(list) {
  const box = $('galleryList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="card empty"><i class="fa-regular fa-folder-open"></i>Belum ada video. Render dulu di tab Render.</div>';
    return;
  }
  list.forEach(v => {
    const el = document.createElement('div');
    el.className = 'vid';
    el.innerHTML = `
      <video src="/output/${v.name}" controls playsinline preload="metadata"></video>
      <div class="vid-info">
        <div class="name"></div>
        <div class="meta">${fmtSize(v.size)} · ${fmtDate(v.mtime)}</div>
      </div>
      <div class="vid-actions">
        <a class="btn text" href="/output/${v.name}" download="${v.name}"><i class="fa-solid fa-download"></i> Unduh</a>
        <button class="btn text" data-act="move" data-name="${v.name}"><i class="fa-solid fa-folder-open"></i> Pindah</button>
        <button class="btn text danger-txt" data-act="del" data-name="${v.name}"><i class="fa-solid fa-trash"></i> Hapus</button>
      </div>`;
    el.querySelector('.name').textContent = v.name;
    box.appendChild(el);
  });
}

$('galleryList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const name = btn.dataset.name;

  if (btn.dataset.act === 'move') {
    const dest = await confirmBox(
      'Pindahkan video',
      'Video akan disalin ke folder berikut lalu dihapus dari aplikasi. Folder harus berada di dalam ~/storage.',
      { icon: 'folder-open', okText: 'Pindahkan', okClass: 'primary',
        input: { value: defaultDest, placeholder: 'Path folder tujuan' } }
    );
    if (!dest) return;
    btn.disabled = true;
    try {
      const r = await fetch(`/api/videos/${encodeURIComponent(name)}/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'gagal');
      toast('Video dipindahkan ke ' + data.path, 'success', 'folder-open');
      loadGallery();
    } catch (err) {
      toast('Gagal memindahkan: ' + err.message, 'error');
      btn.disabled = false;
    }
  }

  if (btn.dataset.act === 'del') {
    const ok = await confirmBox('Hapus video?', `"${name}" akan dihapus permanen dari aplikasi.`,
      { icon: 'trash', kind: 'danger', okText: 'Hapus', okClass: 'danger' });
    if (!ok) return;
    try {
      const r = await fetch(`/api/videos/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'gagal');
      toast('Video dihapus', 'warn', 'trash');
      loadGallery();
    } catch (err) {
      toast('Gagal menghapus: ' + err.message, 'error');
    }
  }
});

$('refreshGallery').onclick = loadGallery;

//  DOKUMENTASI 
let docsText = '';
async function loadDocs() {
  if (docsText) return;
  try {
    docsText = await (await fetch('/docs.md')).text();
    renderDocs(docsText);
  } catch {
    $('docView').textContent = 'Gagal memuat dokumentasi.';
  }
}

function renderDocs(md) {
  const view = $('docView');
  if (window.marked) {
    view.innerHTML = marked.parse(md, { gfm: true });
  } else {
    // Fallback jika CDN marked tidak termuat: tampilkan teks mentah
    view.textContent = md;
  }
}

$('copyDocs').onclick = async () => {
  if (!docsText) await loadDocs();
  try {
    await navigator.clipboard.writeText(docsText);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = docsText; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('Markdown dokumentasi disalin', 'success', 'copy');
};

//  RESET / EKSPOR / IMPOR 
$('reset').onclick = async () => {
  const ok = await confirmBox('Reset kode?', 'Kode saat ini akan diganti dengan template awal. Perubahanmu akan hilang.', { icon: 'rotate-left' });
  if (!ok) return;
  $('code').value = DEFAULT_CODE;
  buildTplSelect();
  propValues = {};
  syncProps(true);
  toast('Kode dikembalikan ke template awal', 'warn', 'rotate-left');
};

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function currentSettings() {
  return { size: state.size, ratio: state.ratio, fps: state.fps, dur: state.dur, quality: state.quality, props: { ...propValues } };
}

$('exportBtn').onclick = () => {
  const payload = { app: 'code-video', version: 2, code: $('code').value, settings: currentSettings() };
  const name = (($('saveName').value || 'komposisi').trim().replace(/[^\w\- ]+/g, '') || 'komposisi') + '.json';
  download(name, JSON.stringify(payload, null, 2));
  toast('File .json diunduh', 'success', 'file-export');
};

$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (typeof obj.code !== 'string') throw new Error('format tidak valid');
    loadComposition(obj);
    showTab('editor');
    toast('Komposisi diimpor', 'success', 'file-import');
  } catch (err) {
    toast('Gagal impor: ' + err.message, 'error');
  }
};

//  SIMPAN KOMPOSISI 
function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function writeStore(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; }
  catch { return false; }
}

function loadComposition(obj) {
  $('code').value = obj.code;
  const s = obj.settings || {};
  propValues = (s.props && typeof s.props === 'object') ? { ...s.props } : {};
  if (s.size) setChip('size', String(s.size));
  if (s.ratio) setChip('ratio', s.ratio);
  if (s.fps) setChip('fps', String(s.fps));
  if (s.quality) setChip('quality', s.quality);
  if (s.dur) {
    if (['3', '5', '10'].includes(String(s.dur))) setChip('dur', String(s.dur));
    else {
      setChip('dur', 'custom');
      $('durInput').value = s.dur;
      applyCustomDur(true);
    }
  }
  $('tplSelect').value = '';
  syncProps(true);
}

function renderSaved() {
  const list = readStore();
  const box = $('savedList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty"><i class="fa-regular fa-folder-open"></i>Belum ada komposisi tersimpan</div>';
    return;
  }
  list.forEach((item, idx) => {
    const st = item.settings || {};
    const el = document.createElement('div');
    el.className = 'saved-row';
    el.innerHTML = `
      <div class="txt">
        <div class="name"></div>
        <div class="meta">${st.size}p · ${st.ratio} · ${st.fps} fps · ${st.dur} dtk · ${QUALITY_LABEL[st.quality] || 'Medium'}</div>
      </div>
      <button class="icon-btn" data-act="load" title="Muat"><i class="fa-solid fa-folder-open"></i></button>
      <button class="icon-btn" data-act="rename" title="Ubah nama"><i class="fa-solid fa-pen"></i></button>
      <button class="icon-btn danger" data-act="del" title="Hapus"><i class="fa-solid fa-trash"></i></button>`;
    el.querySelector('.name').textContent = item.name;
    el.addEventListener('click', async e => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'load') {
        loadComposition(item);
        showTab('editor');
        toast(`"${item.name}" dimuat`, 'success', 'folder-open');
      } else if (act === 'rename') {
        const n = await confirmBox('Ubah nama', 'Masukkan nama baru untuk komposisi ini.',
          { icon: 'pen', okText: 'Simpan', input: { value: item.name } });
        if (!n) return;
        const l = readStore(); l[idx].name = n.slice(0, 60);
        writeStore(l); renderSaved();
        toast('Nama diubah', 'success');
      } else if (act === 'del') {
        const ok = await confirmBox('Hapus komposisi?', `"${item.name}" akan dihapus permanen dari perangkat ini.`,
          { icon: 'trash', kind: 'danger', okText: 'Hapus', okClass: 'danger' });
        if (!ok) return;
        const l = readStore(); l.splice(idx, 1);
        writeStore(l); renderSaved();
        toast('Komposisi dihapus', 'warn', 'trash');
      }
    });
    box.appendChild(el);
  });
}

$('saveBtn').onclick = () => {
  const name = $('saveName').value.trim().slice(0, 60);
  if (!name) return toast('Isi nama komposisi dulu', 'warn', 'pen');
  const entry = { name, code: $('code').value, settings: currentSettings(), savedAt: Date.now() };
  const list = readStore();
  const existing = list.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
  if (existing >= 0) list[existing] = entry; else list.unshift(entry);
  if (!writeStore(list)) return toast('Penyimpanan penuh atau diblokir', 'error');
  $('saveName').value = '';
  renderSaved();
  toast(existing >= 0 ? 'Komposisi diperbarui' : 'Komposisi disimpan', 'success', 'floppy-disk');
};

//  INIT 
buildTplSelect();
$('code').value = DEFAULT_CODE;
syncProps(true);
refreshInfo();
renderAudio();
loadConfig();
renderSaved();
refreshJobs();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
