'use strict';
/**
 * Biblioteca de canciones: escanea  public/songs/<id>/{chart.json, audio.mp3, cover.jpg?}
 * y expone  GET /api/songs  (solo metadatos; las notas se descargan aparte como chart.json).
 *
 * Uso (Express):
 *   const { createSongLibrary } = require('./songs');
 *   const library = createSongLibrary({ dir: path.join(__dirname, 'public', 'songs') });
 *   library.mount(app);              // ANTES de express.static('public')
 *
 * Validación online (anti-trampas), p. ej. en room:settings:
 *   const v = library.validate(songId, difficulty);   // { durationMs, totalNotes } | null
 */
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const express = require('express');

const AUDIO_EXT = ['.mp3', '.ogg', '.m4a', '.wav'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i; // nombre de carpeta seguro (sin rutas ni espacios raros)
const DIFFS = ['easy', 'normal', 'hard', 'expert'];
const MAX_NOTES = 6000;
const MAX_CHART_BYTES = 3 * 1024 * 1024;

const hashStr = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

/** Cada nota es [tiempoMs, carril]; carril 0..3 = D, F, J, K. */
function checkNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) throw new Error('sin notas');
  if (notes.length > MAX_NOTES) throw new Error(`demasiadas notas (máx. ${MAX_NOTES})`);
  let lastMs = 0;
  for (const n of notes) {
    if (!Array.isArray(n) || !Number.isFinite(n[0]) || n[0] < 0 || !Number.isInteger(n[1]) || n[1] < 0 || n[1] > 3) {
      throw new Error(`nota inválida ${JSON.stringify(n)}`);
    }
    if (n[0] > lastMs) lastMs = n[0];
  }
  return { total: notes.length, lastMs };
}

function pickAudio(files, wanted) {
  if (typeof wanted === 'string' && path.basename(wanted) === wanted && files.includes(wanted)) return wanted;
  const audios = files.filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()));
  return audios.find((f) => path.parse(f).name.toLowerCase() === 'audio') || audios[0] || null;
}

function createSongLibrary({ dir, urlBase = '/songs', watch = true }) {
  fsSync.mkdirSync(dir, { recursive: true });
  let catalog = new Map();
  let debounce = 0;

  async function readSong(id) {
    const folder = path.join(dir, id);
    const chartPath = path.join(folder, 'chart.json');
    const [cst, files] = await Promise.all([fs.stat(chartPath), fs.readdir(folder)]);
    if (cst.size > MAX_CHART_BYTES) throw new Error('chart.json demasiado grande');
    const chart = JSON.parse(await fs.readFile(chartPath, 'utf8'));
    const meta = chart.meta || {};

    const audioFile = pickAudio(files, chart.audio);
    if (!audioFile) throw new Error('no hay archivo de audio (audio.mp3)');
    const ast = await fs.stat(path.join(folder, audioFile));

    const sources = chart.difficulties || { normal: { notes: chart.notes } };
    const difficulties = {};
    let lastMs = 0;
    for (const name of DIFFS) {
      const d = sources[name];
      if (!d) continue;
      const r = checkNotes(d.notes);
      difficulties[name] = { level: Number(d.level) || 0, totalNotes: r.total };
      lastMs = Math.max(lastMs, r.lastMs);
    }
    if (!Object.keys(difficulties).length) throw new Error('sin dificultades válidas');

    const offsetMs = Number(meta.offsetMs) || 0;
    const minDuration = lastMs + Math.max(0, offsetMs) + 2000;
    const version = Math.floor(Math.max(cst.mtimeMs, ast.mtimeMs)).toString(36); // invalida caché al editar
    const url = (f) => `${urlBase}/${encodeURIComponent(id)}/${encodeURIComponent(f)}?v=${version}`;
    const cover = files.find((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase()) && path.parse(f).name.toLowerCase() === 'cover');

    return {
      id,
      title: String(meta.title || id).slice(0, 80),
      artist: String(meta.artist || 'Desconocido').slice(0, 80),
      bpm: Math.min(300, Math.max(40, Number(meta.bpm) || 120)),
      hue: Number.isFinite(Number(meta.hue)) && meta.hue !== undefined ? Number(meta.hue) % 360 : hashStr(id) % 360,
      durationMs: Math.max(Number(meta.durationMs) || 0, minDuration),
      offsetMs,
      audioUrl: url(audioFile),
      chartUrl: url('chart.json'),
      cover: cover ? url(cover) : null,
      version,
      difficulties,
    };
  }

  async function rescan() {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const ids = entries.filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name);
    const results = await Promise.allSettled(ids.map(readSong));
    const next = new Map();
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') next.set(ids[i], r.value);
      else console.warn(`[songs] "${ids[i]}" ignorada: ${r.reason.message}`);
    });
    catalog = next;
    console.log(`[songs] ${catalog.size} canción(es) disponibles`);
  }

  const schedule = () => { clearTimeout(debounce); debounce = setTimeout(() => rescan().catch(console.error), 400); };
  const ready = rescan().catch(console.error);

  if (watch) {
    try { fsSync.watch(dir, { recursive: true }, schedule).unref(); } // Windows/macOS/Node 20+
    catch (e) { setInterval(() => rescan().catch(console.error), 15000).unref(); } // respaldo: sondeo cada 15 s
  }

  const list = () => [...catalog.values()].sort((a, b) => a.title.localeCompare(b.title));
  const get = (id) => catalog.get(id) || null;
  const validate = (id, difficulty) => {
    const s = catalog.get(id), d = s && s.difficulties[difficulty];
    return d ? { durationMs: s.durationMs, totalNotes: d.totalNotes } : null;
  };

  const router = express.Router();
  router.get('/api/songs', async (req, res) => {
    await ready;
    res.set('Cache-Control', 'no-cache'); // el cliente siempre revalida; ETag evita retransmitir si no cambió
    res.json({ songs: list() });
  });

  function mount(app) {
    app.use(router);
    // Las URLs llevan ?v=<versión>, así que los archivos pueden cachearse "para siempre" en el navegador.
    app.use(urlBase, express.static(dir, { maxAge: '30d', immutable: true, index: false, dotfiles: 'ignore' }));
  }

  return { router, mount, list, get, validate, rescan, ready };
}

module.exports = { createSongLibrary };
