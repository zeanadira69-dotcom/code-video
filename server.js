const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'output');
const TMP = path.join(ROOT, 'tmp');
const JOBS_FILE = path.join(ROOT, 'jobs.json');
const HOME = os.homedir();
const STORAGE_ROOT = path.join(HOME, 'storage');
const DEFAULT_DEST = path.join(STORAGE_ROOT, 'shared', 'Movies', 'CodeVideo');
const MAX_W = 3840, MAX_H = 2160;
const MAX_AUDIO = 60 * 1024 * 1024; // 60 MB
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const QUALITY = {
  low:    { preset: 'ultrafast', crf: '28' },
  medium: { preset: 'veryfast',  crf: '23' },
  high:   { preset: 'medium',    crf: '20' },
  ultra:  { preset: 'slow',      crf: '16' },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
let jobs = [];
try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch {}
// Job yang masih "running" saat server baru start berarti server sebelumnya mati
jobs.forEach(j => { if (j.status === 'running') { j.status = 'error'; j.error = 'Server dimulai ulang saat render'; } });

function saveJobs() {
  try { fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs.slice(0, 30), null, 2)); } catch {}
}

let session = null; // render aktif: { job, ff, frameBytes, lastSeen, log }
const STALE_MS = 15000; // tanpa frame selama 15 detik dianggap browser terputus

setInterval(() => {
  if (session && Date.now() - session.lastSeen > STALE_MS) {
    failSession('Browser tidak mengirim frame (terputus / layar mati)');
  }
}, 3000);

function failSession(msg) {
  if (!session) return;
  const s = session;
  session = null;
  s.job.status = 'error';
  s.job.error = msg;
  s.job.finishedAt = Date.now();
  saveJobs();
  try { s.ff.stdin.end(); } catch {}
  s.ff.kill('SIGKILL');
}

// Audio sementara dipertahankan agar bisa dipakai untuk beberapa kali render.
// File audio yang lebih tua dari 24 jam dibersihkan otomatis.
function cleanTmp(maxAgeMs = 24 * 60 * 60 * 1000) {
  fs.readdir(TMP, (err, files) => {
    if (err) return;
    const now = Date.now();
    for (const f of files) {
      if (!/^audio-\d+\./.test(f)) continue;
      const fp = path.join(TMP, f);
      fs.stat(fp, (e, st) => {
        if (!e && now - st.mtimeMs > maxAgeMs) fs.rm(fp, () => {});
      });
    }
  });
}
cleanTmp();
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, raw = false, limit = 1024 * 1024 * 80) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { req.destroy(); return reject(new Error('body terlalu besar')); }
      chunks.push(c);
    });
    req.on('end', () => {
      const b = Buffer.concat(chunks);
      resolve(raw ? b : b.toString());
    });
    req.on('error', reject);
  });
}

function safeVideoName(raw) {
  const name = path.basename(decodeURIComponent(raw || ''));
  return /^video-\d+\.mp4$/.test(name) ? name : null;
}

function isAllowedDest(p) {
  const r = path.resolve(p);
  return r === STORAGE_ROOT || r.startsWith(STORAGE_ROOT + path.sep);
}

function getProbe(file) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => resolve(parseFloat(out) || 0));
    p.on('error', () => resolve(0));
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/config') {
    return json(res, 200, { defaultDest: DEFAULT_DEST, storageReady: fs.existsSync(STORAGE_ROOT) });
  }
  if (req.method === 'GET' && p === '/api/jobs') {
    const active = session ? session.job.id : null;
    return json(res, 200, { active, jobs: jobs.slice(0, 10) });
  }

  if (req.method === 'DELETE' && p.startsWith('/api/jobs/')) {
    const id = p.slice('/api/jobs/'.length);
    if (session && session.job.id === id) return json(res, 409, { error: 'render masih berjalan' });
    jobs = jobs.filter(j => j.id !== id);
    saveJobs();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/api/videos') {
    const list = fs.readdirSync(OUT)
      .filter(f => /^video-\d+\.mp4$/.test(f))
      .map(f => {
        const st = fs.statSync(path.join(OUT, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return json(res, 200, list);
  }

  if (req.method === 'DELETE' && p.startsWith('/api/videos/')) {
    const name = safeVideoName(p.slice('/api/videos/'.length));
    if (!name) return json(res, 400, { error: 'nama file tidak valid' });
    if (session && session.name === name) return json(res, 409, { error: 'video sedang dirender' });
    const file = path.join(OUT, name);
    if (!fs.existsSync(file)) return json(res, 404, { error: 'file tidak ditemukan' });
    fs.unlinkSync(file);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && /^\/api\/videos\/[^/]+\/move$/.test(p)) {
    const name = safeVideoName(p.split('/')[3]);
    if (!name) return json(res, 400, { error: 'nama file tidak valid' });
    if (session && session.name === name) return json(res, 409, { error: 'video sedang dirender' });
    const src = path.join(OUT, name);
    if (!fs.existsSync(src)) return json(res, 404, { error: 'file tidak ditemukan' });
    if (!fs.existsSync(STORAGE_ROOT)) {
      return json(res, 400, { error: 'Akses penyimpanan belum aktif. Jalankan "termux-setup-storage" dulu.' });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'JSON tidak valid' }); }
    const destDir = path.resolve(String(body.dest || DEFAULT_DEST).trim());
    if (!isAllowedDest(destDir)) return json(res, 400, { error: `Folder tujuan harus berada di ${STORAGE_ROOT}` });
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const target = path.join(destDir, name);
      fs.copyFileSync(src, target);
      fs.unlinkSync(src);
      return json(res, 200, { ok: true, path: target });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === 'GET' && p.startsWith('/output/')) {
    const name = safeVideoName(p.slice('/output/'.length));
    const file = name && path.join(OUT, name);
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(file).size });
    return fs.createReadStream(file).pipe(res);
  }

  if (req.method === 'POST' && p === '/api/audio') {
    if (session) return json(res, 409, { error: 'render sedang berjalan' });
    // Client mengirim nama file dalam bentuk encodeURIComponent
    const rawName = String(req.headers['x-filename'] || '');
    let fileName;
    try { fileName = decodeURIComponent(rawName); } catch { fileName = rawName; }
    fileName = path.basename(fileName);
    const type = req.headers['content-type'] || '';
    if (!type.startsWith('audio/') && !/\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(fileName)) {
      return json(res, 400, { error: 'file harus berupa audio' });
    }
    if (+req.headers['content-length'] > MAX_AUDIO) return json(res, 400, { error: 'maks 60 MB' });
    const buf = await readBody(req, true, MAX_AUDIO);
    let ext = path.extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, '');
    if (!/^\.[a-z0-9]+$/.test(ext)) ext = '.mp3';
    const id = `audio-${Date.now()}${ext}`;
    fs.writeFileSync(path.join(TMP, id), buf);
    const dur = await getProbe(path.join(TMP, id));
    if (!dur) { fs.rm(path.join(TMP, id), () => {}); return json(res, 400, { error: 'audio tidak bisa dibaca' }); }
    cleanTmp();
    return json(res, 200, { id, duration: dur, name: fileName || id });
  }

  if (req.method === 'POST' && p === '/api/start') {
    if (session) return json(res, 409, { error: 'render lain sedang berjalan' });

    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'JSON tidak valid' }); }

    const width = Math.round(+body.width);
    const height = Math.round(+body.height);
    const fps = +body.fps;
    const duration = +body.duration;
    if (!width || !height || width > MAX_W || height > MAX_H || width % 2 || height % 2) {
      return json(res, 400, { error: `Ukuran tidak valid (maks ${MAX_W}x${MAX_H}, harus genap)` });
    }
    if (!(fps > 0 && fps <= 120)) return json(res, 400, { error: 'FPS tidak valid' });
    if (!(duration > 0)) return json(res, 400, { error: 'durasi tidak valid' });

    let audioPath = null, audioInfo = null;
    if (body.audio) {
      const aid = String(body.audio.id || '');
      if (!/^audio-\d+\.[a-z0-9]+$/.test(aid) || !fs.existsSync(path.join(TMP, aid))) {
        return json(res, 400, { error: 'audio tidak ditemukan di server, silakan unggah ulang' });
      }
      audioPath = path.join(TMP, aid);
      audioInfo = { name: String(body.audio.name || aid), loop: !!body.audio.loop };
    }

    const q = QUALITY[body.quality] || QUALITY.medium;
    const name = `video-${Date.now()}.mp4`;
    const out = path.join(OUT, name);
    const id = name.replace('.mp4', '');

    const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-'];
    if (audioPath) {
      if (audioInfo.loop) args.push('-stream_loop', '-1');
      args.push('-i', audioPath);
      // apad: audio yang lebih pendek dilanjutkan dengan hening; panjang total
      // ditentukan oleh -t di bawah. (-shortest memotong video & membuat FFmpeg
      // berhenti di tengah render.)
      args.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '160k', '-af', 'apad');
    }
    args.push(
      '-c:v', 'libx264', '-preset', q.preset, '-crf', q.crf,
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-t', String(duration),
      '-movflags', '+faststart', out
    );

    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let log = '';
    ff.stderr.on('data', d => { log = (log + d).slice(-4000); });
    ff.stdin.on('error', () => {});

    const job = {
      id, name, status: 'running',
      width, height, fps, duration,
      quality: body.quality || 'medium',
      audio: audioInfo ? audioInfo.name : null,
      frames: 0, total: Math.round(duration * fps),
      startedAt: Date.now(), finishedAt: null, error: null,
    };
    jobs.unshift(job);
    saveJobs();

    session = {
      job, ff, name, audioPath,
      frameBytes: width * height * 4,
      lastSeen: Date.now(),
      getLog: () => log,
    };
    ff.on('close', code => {
      if (session && session.ff === ff) {
        failSession('FFmpeg berhenti: ' + log.slice(-200));
      }
    });
    return json(res, 200, { ok: true, id });
  }
  
  if (req.method === 'POST' && p === '/api/frame') {
    const s = session;
    if (!s) return json(res, 400, { error: 'belum start' });
    const buf = await readBody(req, true, 40 * 1024 * 1024);
    if (session !== s) return json(res, 409, { error: 'render sudah berhenti' });
    if (buf.length !== s.frameBytes) {
      return json(res, 400, { error: `ukuran frame salah: ${buf.length} byte` });
    }
    const stdin = s.ff.stdin;
    const ffError = () => json(res, 500, { error: 'FFmpeg berhenti: ' + s.getLog().slice(-200) });
    if (stdin.destroyed || stdin.writableEnded) return ffError();
    s.lastSeen = Date.now();
    s.job.frames += 1;
    if (!stdin.write(buf)) {
      // Tunggu drain, tapi jangan menggantung selamanya jika FFmpeg sudah mati
      const ok = await new Promise(resolve => {
        const done = v => {
          stdin.off('drain', onDrain); stdin.off('close', onEnd); stdin.off('error', onEnd);
          resolve(v);
        };
        const onDrain = () => done(true);
        const onEnd = () => done(false);
        stdin.once('drain', onDrain); stdin.once('close', onEnd); stdin.once('error', onEnd);
      });
      if (!ok) return ffError();
    }
    return json(res, 200, { ok: true, frames: s.job.frames });
  }

  if (req.method === 'POST' && p === '/api/finish') {
    if (!session) return json(res, 400, { error: 'belum start' });
    const s = session;
    session = null;
    s.ff.stdin.end();
    const code = s.ff.exitCode !== null ? s.ff.exitCode : await new Promise(r => s.ff.once('close', r));
    if (code !== 0) {
      s.job.status = 'error'; s.job.error = s.getLog().slice(-300); s.job.finishedAt = Date.now();
      saveJobs();
      return json(res, 500, { error: s.getLog() });
    }
    s.job.status = 'done'; s.job.finishedAt = Date.now(); s.job.file = `/output/${s.name}`;
    saveJobs();
    return json(res, 200, { file: `/output/${s.name}`, name: s.name });
  }

  if (req.method === 'POST' && p === '/api/abort') {
    if (session) failSession('Dibatalkan pengguna');
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET') {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(PUB, path.normalize(rel));
    if (file.startsWith(PUB + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      return fs.createReadStream(file).pipe(res);
    }
  }

  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message || 'kesalahan server' });
    else res.end();
  });
});

server.listen(PORT, () => {
  console.log(`Code → Video berjalan di http://localhost:${PORT}`);
  console.log('Buka alamat itu di browser HP kamu (Chrome/Firefox).');
});
