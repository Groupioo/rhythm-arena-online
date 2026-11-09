'use strict';

/**
 * Biblioteca de canciones del SERVIDOR (va en la raíz del proyecto, junto a server.js).
 * (El songs.js del navegador es otro archivo y va en public/js/songs.js.)
 *
 * Lee una carpeta (por defecto ./demo, o SONGS_DIR) con una carpeta por canción. Cada carpeta
 * necesita AUDIO (mp3, ogg, wav, flac, m4a...) y UN chart en cualquiera de estos formatos:
 *   - StepMania:  *.sm / *.ssc  (modo dance-single, 4 columnas)
 *   - JSON:       chart.json con { meta?:{title,artist,bpm,audio,offsetMs}, difficulties:{easy:{notes:[[ms,columna],...]},...} }
 *                 o simplemente { notes:[[ms,columna],...] } (se toma como "normal")
 * Opcional: portada (png/jpg/webp). Se admiten subcarpetas (packs) hasta 4 niveles; una canción puede estar en la raíz y convivir con packs.
 *
 * API: createSongLibrary({ dir }) -> { mount(app), list(), get(id), validate(id, difficulty), refresh() }
 *   GET /api/songs               -> { songs: [...] }
 *   GET /songs/:id/chart.json    -> chart normalizado { meta, difficulties:{ easy:{notes:[[ms,col]]} } }
 *   GET /songs/:id/audio.<ext>   -> audio original (con soporte de Range)
 *   GET /songs/:id/cover.<ext>   -> portada
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIFFS = ['easy', 'normal', 'hard', 'expert'];
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.oga', '.opus', '.wav', '.flac', '.m4a', '.aac']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_SCAN_DEPTH = 4;
const SCAN_TTL_MS = 5 * 60_000; // re-escaneo completo cada 5 min (antes 2 s: bloqueaba el servidor con miles de archivos)
const MAX_NOTES = 10_000; // = LIMITS.TOTAL_NOTES_MAX de validation.js
const DURATION_MIN_MS = 10_000; // = LIMITS.DURATION_MIN_MS
const DURATION_MAX_MS = 900_000; // = LIMITS.DURATION_MAX_MS
const MAX_JSON_BYTES = 5_000_000;

// ---------------------------------------------------------------------
// Duración del audio (sin dependencias externas)
// ---------------------------------------------------------------------

const MP3_BITRATES = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Header(buf, i) {
  if (i < 0 || i + 4 > buf.length || buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const vb = (buf[i + 1] >> 3) & 3;
  const lb = (buf[i + 1] >> 1) & 3;
  if (vb === 1 || lb === 0) return null;
  const brIdx = buf[i + 2] >> 4;
  const srIdx = (buf[i + 2] >> 2) & 3;
  const pad = (buf[i + 2] >> 1) & 1;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const layer = 4 - lb;
  const mpeg1 = vb === 3;
  const br = MP3_BITRATES[`${mpeg1 ? 1 : 2}-${layer}`][brIdx] * 1000;
  const sr = MP3_RATES[vb][srIdx];
  const spf = layer === 1 ? 384 : layer === 3 && !mpeg1 ? 576 : 1152;
  const len =
    layer === 1
      ? (Math.floor((12 * br) / sr) + pad) * 4
      : Math.floor(((layer === 3 && !mpeg1 ? 72 : 144) * br) / sr) + pad;
  const mono = ((buf[i + 3] >> 6) & 3) === 3;
  return { len, sr, spf, mpeg1, mono };
}

function mp3DurationMs(buf) {
  let pos = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    pos = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  const findSync = (from) => {
    for (let i = from; i + 4 <= buf.length; i += 1) {
      const h = mp3Header(buf, i);
      if (h && (mp3Header(buf, i + h.len) || i + h.len + 4 >= buf.length)) return i;
    }
    return -1;
  };
  const first = findSync(pos);
  if (first < 0) return null;
  const h0 = mp3Header(buf, first);

  // Cabecera Xing/Info (VBR y la mayoría de CBR) o VBRI: trae el número total de frames.
  const side = h0.mpeg1 ? (h0.mono ? 17 : 32) : h0.mono ? 9 : 17;
  const tag = first + 4 + side;
  if (tag + 12 <= buf.length) {
    const id = buf.toString('latin1', tag, tag + 4);
    if ((id === 'Xing' || id === 'Info') && buf.readUInt32BE(tag + 4) & 1) {
      return Math.round(((buf.readUInt32BE(tag + 8) * h0.spf) / h0.sr) * 1000);
    }
  }
  if (first + 54 <= buf.length && buf.toString('latin1', first + 36, first + 40) === 'VBRI') {
    return Math.round(((buf.readUInt32BE(first + 36 + 14) * h0.spf) / h0.sr) * 1000);
  }

  // Sin cabecera: se cuentan los frames.
  let i = first;
  let frames = 0;
  while (i + 4 <= buf.length) {
    const h = mp3Header(buf, i);
    if (h && i + h.len <= buf.length) {
      frames += 1;
      i += h.len;
    } else {
      const next = findSync(i + 1);
      if (next < 0) break;
      i = next;
    }
  }
  return frames ? Math.round(((frames * h0.spf) / h0.sr) * 1000) : null;
}

function wavDurationMs(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let i = 12;
  let byteRate = 0;
  while (i + 8 <= buf.length) {
    const id = buf.toString('latin1', i, i + 4);
    let size = buf.readUInt32LE(i + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(i + 16);
    else if (id === 'data') {
      if (!byteRate) return null;
      size = Math.min(size, buf.length - (i + 8));
      return Math.round((size / byteRate) * 1000);
    }
    i += 8 + size + (size & 1);
  }
  return null;
}

function oggDurationMs(buf) {
  if (buf.toString('latin1', 0, 4) !== 'OggS') return null;
  const p = 27 + buf[26];
  let rate = 0;
  let skip = 0;
  if (buf.toString('latin1', p + 1, p + 7) === 'vorbis') rate = buf.readUInt32LE(p + 12);
  else if (buf.toString('latin1', p, p + 8) === 'OpusHead') {
    rate = 48000;
    skip = buf.readUInt16LE(p + 10);
  } else return null;
  const last = buf.lastIndexOf('OggS');
  if (last <= 0 || last + 14 > buf.length) return null;
  const granule = buf.readUInt32LE(last + 10) * 4294967296 + buf.readUInt32LE(last + 6);
  if (!rate || granule <= skip) return null;
  return Math.round(((granule - skip) / rate) * 1000);
}

function flacDurationMs(buf) {
  if (buf.toString('latin1', 0, 4) !== 'fLaC' || buf.length < 26) return null;
  const d = 8; // tras 'fLaC' + cabecera del bloque STREAMINFO
  const rate = (buf[d + 10] << 12) | (buf[d + 11] << 4) | (buf[d + 12] >> 4);
  const total = (buf[d + 13] & 0x0f) * 4294967296 + buf.readUInt32BE(d + 14);
  return rate && total ? Math.round((total / rate) * 1000) : null;
}

function mp4DurationMs(buf) {
  const at = buf.indexOf('mvhd');
  if (at < 0 || at + 32 > buf.length) return null;
  const v = buf[at + 4];
  const timescale = buf.readUInt32BE(at + (v === 1 ? 24 : 16));
  const duration = v === 1 ? Number(buf.readBigUInt64BE(at + 28)) : buf.readUInt32BE(at + 20);
  return timescale ? Math.round((duration / timescale) * 1000) : null;
}

function audioDurationMs(file) {
  try {
    const buf = fs.readFileSync(file);
    switch (path.extname(file).toLowerCase()) {
      case '.mp3': return mp3DurationMs(buf);
      case '.wav': return wavDurationMs(buf);
      case '.ogg': case '.oga': case '.opus': return oggDurationMs(buf);
      case '.flac': return flacDurationMs(buf);
      case '.m4a': case '.aac': return mp4DurationMs(buf);
      default: return null;
    }
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------
// Charts: StepMania (.sm / .ssc) y JSON  ->  { easy:{notes:[[ms,col]], meter}, ... }
// ---------------------------------------------------------------------

const SM_DIFFICULTY_ORDER = {
  easy: ['easy', 'basic', 'light', 'beginner'],
  normal: ['medium', 'standard'],
  hard: ['hard', 'difficult', 'heavy'],
  expert: ['challenge', 'expert', 'oni', 'edit'],
};

function parseNumberPairs(raw) {
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const [a, b] = part.split('=').map((s) => Number.parseFloat(s.trim()));
    if (Number.isFinite(a) && Number.isFinite(b)) out.push([a, b]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** Devuelve beat -> segundos, teniendo en cuenta cambios de BPM y paradas (stops). */
function makeTimer(bpmsRaw, stopsRaw) {
  let bpms = parseNumberPairs(bpmsRaw).filter(([, bpm]) => bpm > 0);
  if (bpms.length === 0) bpms = [[0, 120]];
  if (bpms[0][0] > 0) bpms.unshift([0, bpms[0][1]]);
  const segs = [];
  let time = 0;
  bpms.forEach(([beat, bpm], i) => {
    segs.push({ beat, bpm, time });
    if (bpms[i + 1]) time += ((bpms[i + 1][0] - beat) * 60) / bpm;
  });
  const stops = parseNumberPairs(stopsRaw).filter(([, sec]) => sec > 0);
  return {
    bpms,
    at(beat) {
      let seg = segs[0];
      for (const s of segs) {
        if (s.beat <= beat) seg = s;
        else break;
      }
      let t = seg.time + ((beat - seg.beat) * 60) / seg.bpm;
      for (const [sb, sec] of stops) if (sb < beat) t += sec; // la parada ocurre DESPUÉS de su beat
      return t;
    },
  };
}

function parseStepData(data, timer, offsetSec) {
  const notes = [];
  data.split(',').forEach((measure, mi) => {
    const rows = measure.trim().split(/\s+/).filter((r) => r.length >= 4);
    rows.forEach((row, ri) => {
      const beat = mi * 4 + (ri / rows.length) * 4;
      for (let lane = 0; lane < 4; lane += 1) {
        const c = row[lane];
        if (c === '1' || c === '2' || c === '4') { // nota normal, inicio de hold o de roll
          notes.push([Math.round((timer.at(beat) - offsetSec) * 1000), lane]);
        }
      }
    });
  });
  return notes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function parseSimfile(text) {
  const clean = text.replace(/^\uFEFF/, '').replace(/(^|[\s;])\/\/[^\n]*/g, '$1');
  const tags = {};
  const charts = [];
  let cur = null;
  const re = /#([A-Za-z0-9_]+):([\s\S]*?);/g;
  let m;
  while ((m = re.exec(clean))) {
    const key = m[1].toUpperCase();
    const val = m[2];
    if (key === 'NOTEDATA') { cur = {}; charts.push(cur); continue; } // .ssc
    if (cur && key === 'STEPSTYPE') cur.type = val.trim().toLowerCase();
    else if (cur && key === 'DIFFICULTY') cur.diff = val.trim().toLowerCase();
    else if (cur && key === 'METER') cur.meter = Number.parseInt(val, 10) || 0;
    else if (cur && key === 'NOTES') cur.data = val;
    else if (key === 'NOTES' && !cur) { // .sm: tipo:desc:dificultad:medidor:radar:datos
      const parts = val.split(':');
      if (parts.length >= 6) {
        charts.push({
          type: parts[0].trim().toLowerCase(),
          diff: parts[2].trim().toLowerCase(),
          meter: Number.parseInt(parts[3], 10) || 0,
          data: parts.slice(5).join(':'),
        });
      }
    } else if (!(key in tags)) tags[key] = val.trim();
  }

  const timer = makeTimer(tags.BPMS, tags.STOPS);
  const offsetSec = Number.parseFloat(tags.OFFSET) || 0;
  const singles = charts.filter((c) => c.type === 'dance-single' && c.data);
  if (singles.length === 0) throw new Error('no hay charts "dance-single" (4 columnas)');

  const difficulties = {};
  const used = new Set();
  for (const target of DIFFS) {
    for (const name of SM_DIFFICULTY_ORDER[target]) {
      const chart = singles.find((c) => c.diff === name && !used.has(c));
      if (chart) {
        used.add(chart);
        difficulties[target] = { notes: parseStepData(chart.data, timer, offsetSec), meter: chart.meter };
        break;
      }
    }
  }
  if (Object.keys(difficulties).length === 0) { // nombres de dificultad desconocidos: se usa el primero como "normal"
    const c = singles[0];
    difficulties.normal = { notes: parseStepData(c.data, timer, offsetSec), meter: c.meter };
  }

  let bpm = timer.bpms[0][1];
  if (tags.DISPLAYBPM && Number.parseFloat(tags.DISPLAYBPM) > 0) bpm = Number.parseFloat(tags.DISPLAYBPM);
  return {
    meta: { title: tags.TITLE, artist: tags.ARTIST, bpm: Math.round(bpm), audio: tags.MUSIC, covers: [tags.JACKET, tags.BANNER, tags.BACKGROUND] },
    difficulties,
  };
}

function parseJsonChart(text) {
  const json = JSON.parse(text);
  const meta = json.meta && typeof json.meta === 'object' ? json.meta : {};
  const offset = Number(meta.offsetMs) || 0;
  let source = null;
  if (json.difficulties && typeof json.difficulties === 'object') source = json.difficulties;
  else if (Array.isArray(json.notes)) source = { normal: { notes: json.notes } };
  if (!source) throw new Error('el JSON no tiene "difficulties" ni "notes"');

  const difficulties = {};
  for (const diff of DIFFS) {
    const d = source[diff];
    if (!d || !Array.isArray(d.notes)) continue;
    const notes = [];
    for (const n of d.notes) {
      if (!Array.isArray(n) || !Number.isFinite(n[0]) || !Number.isInteger(n[1]) || n[1] < 0 || n[1] > 3) continue;
      notes.push([Math.round(n[0] + offset), n[1]]);
    }
    notes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    difficulties[diff] = { notes, meter: Number(d.meter) || 0 };
  }
  return {
    meta: { title: meta.title, artist: meta.artist, bpm: Math.round(Number(meta.bpm) || 0), audio: meta.audio, covers: [meta.cover] },
    difficulties,
  };
}

// ---------------------------------------------------------------------
// Biblioteca
// ---------------------------------------------------------------------

const slugify = (s) =>
  String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'song';

const hueOf = (id) => parseInt(crypto.createHash('md5').update(id).digest('hex').slice(0, 6), 16) % 360;

function createSongLibrary({ dir, logger = console } = {}) {
  const root = path.resolve(dir || path.join(__dirname, 'demo'));
  const cache = new Map(); // carpeta -> { sig, record }
  const warned = new Set();
  let songs = new Map(); // id -> record
  let lastScan = 0;

  const warnOnce = (key, msg) => {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(`[songs] ${msg}`);
  };

  /** Busca carpetas de canción: las que contienen un chart (.sm/.ssc/.json). */
  function findSongDirs() {
    const found = [];
    (function walk(d, depth) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      const files = entries.filter((e) => e.isFile()).map((e) => e.name);
      // Una carpeta con chart es una canción, pero aun así se sigue buscando en sus subcarpetas
      // (p. ej. una canción suelta en la raíz junto a una carpeta-pack con más canciones).
      if (files.some((f) => /\.(sm|ssc|json)$/i.test(f))) found.push(d);
      if (depth >= MAX_SCAN_DEPTH) return;
      const subdirs = entries.filter((x) => x.isDirectory() && !x.name.startsWith('.')); // ignora .chart-cache, .git...
      for (const e of subdirs.sort((a, b) => a.name.localeCompare(b.name))) {
        walk(path.join(d, e.name), depth + 1);
      }
    })(root, 0);
    return found;
  }

  function loadFolder(folder) {
    const names = fs.readdirSync(folder).filter((n) => fs.statSync(path.join(folder, n)).isFile()).sort();
    const sig = names.map((n) => { const st = fs.statSync(path.join(folder, n)); return `${n}:${st.size}:${st.mtimeMs}`; }).join('|');
    const hit = cache.get(folder);
    if (hit && hit.sig === sig) return hit.record;

    let record = null;
    try {
      record = buildRecord(folder, names, sig);
    } catch (e) {
      warnOnce(`${folder}|${sig}`, `Se omite "${path.relative(root, folder) || path.basename(root)}": ${e.message}`);
    }
    cache.set(folder, { sig, record });
    return record;
  }

  function buildRecord(folder, names, sig) {
    const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
    const pick = (n) => (n ? byLower.get(String(n).toLowerCase()) : undefined);

    // --- chart
    const simName = names.find((n) => /\.ssc$/i.test(n)) || names.find((n) => /\.sm$/i.test(n));
    let parsed;
    let source;
    if (simName) {
      parsed = parseSimfile(fs.readFileSync(path.join(folder, simName), 'utf8'));
      source = 'stepmania';
    } else {
      const jsonNames = [...names.filter((n) => n.toLowerCase() === 'chart.json'), ...names.filter((n) => /\.json$/i.test(n) && n.toLowerCase() !== 'chart.json')];
      let lastErr = null;
      for (const n of jsonNames) {
        try {
          if (fs.statSync(path.join(folder, n)).size > MAX_JSON_BYTES) throw new Error(`${n} es demasiado grande`);
          parsed = parseJsonChart(fs.readFileSync(path.join(folder, n), 'utf8'));
          source = 'json';
          break;
        } catch (e) { lastErr = e; }
      }
      if (!parsed) throw new Error(lastErr ? `chart no válido (${lastErr.message})` : 'no hay chart');
    }

    // --- audio
    const audioNames = names.filter((n) => AUDIO_EXT.has(path.extname(n).toLowerCase()));
    const audioName = pick(parsed.meta.audio) && audioNames.includes(pick(parsed.meta.audio)) ? pick(parsed.meta.audio) : audioNames[0];
    if (!audioName) throw new Error('no hay archivo de audio (mp3, ogg, wav, flac, m4a)');

    // --- portada
    const imageNames = names.filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()));
    let coverName = null;
    for (const c of parsed.meta.covers || []) {
      const f = pick(c);
      if (f && imageNames.includes(f)) { coverName = f; break; }
    }
    if (!coverName) coverName = imageNames.find((n) => /cover|jacket|album|banner|folder|art/i.test(n)) || null;

    // --- dificultades válidas
    const difficulties = {};
    const charts = {};
    let lastNote = 0;
    for (const diff of DIFFS) {
      const d = parsed.difficulties[diff];
      if (!d) continue;
      if (d.notes.length < 1 || d.notes.length > MAX_NOTES) {
        warnOnce(`${folder}|${diff}|${sig}`, `"${path.basename(folder)}" (${diff}): ${d.notes.length} notas fuera de rango (1-${MAX_NOTES}); se omite esa dificultad.`);
        continue;
      }
      difficulties[diff] = { totalNotes: d.notes.length, meter: d.meter || 0 };
      charts[diff] = { notes: d.notes };
      lastNote = Math.max(lastNote, d.notes[d.notes.length - 1][0]);
    }
    if (Object.keys(difficulties).length === 0) throw new Error('ninguna dificultad tiene un número de notas válido');

    // --- duración
    const audioMs = audioDurationMs(path.join(folder, audioName));
    if (!audioMs) warnOnce(`${folder}|dur|${sig}`, `"${path.basename(folder)}": no se pudo leer la duración de ${audioName}; se estima a partir del chart.`);
    let durationMs = Math.max(audioMs || 0, lastNote + (audioMs ? 1500 : 4000));
    if (durationMs > DURATION_MAX_MS) throw new Error(`dura más de ${DURATION_MAX_MS / 60000} minutos`);
    durationMs = Math.max(DURATION_MIN_MS, Math.round(durationMs));

    const version = crypto.createHash('md5').update(sig).digest('hex').slice(0, 8);
    const base = path.basename(folder);
    const title = parsed.meta.title || base;
    const chartJson = JSON.stringify({ meta: { title, artist: parsed.meta.artist || '', bpm: parsed.meta.bpm || 0, offsetMs: 0 }, difficulties: charts });

    const audioExt = path.extname(audioName).toLowerCase();
    const coverExt = coverName ? path.extname(coverName).toLowerCase() : null;
    return {
      folder,
      version,
      title,
      artist: parsed.meta.artist || '',
      bpm: parsed.meta.bpm || 0,
      durationMs,
      difficulties,
      source,
      audioFile: path.join(folder, audioName),
      audioExt,
      coverFile: coverName ? path.join(folder, coverName) : null,
      coverExt,
      chartJson,
    };
  }

  function refresh() {
    lastScan = Date.now();
    const next = new Map();
    if (!fs.existsSync(root)) {
      warnOnce(`root|${root}`, `La carpeta de canciones no existe: ${root}`);
      songs = next;
      return;
    }
    for (const folder of findSongDirs()) {
      let record;
      try { record = loadFolder(folder); } catch (e) { warnOnce(`${folder}|io`, `No se pudo leer "${folder}": ${e.message}`); continue; }
      if (!record) continue;
      const rel = path.relative(root, folder) || path.basename(root);
      let id = slugify(rel.split(path.sep).join('-'));
      for (let n = 2; next.has(id); n += 1) id = `${slugify(rel.split(path.sep).join('-')).slice(0, 44)}-${n}`;
      next.set(id, { id, ...record });
    }
    songs = next;
  }

  const ensureFresh = () => { if (Date.now() - lastScan > SCAN_TTL_MS) refresh(); };

  function publicSong(r) {
    const v = `?v=${r.version}`;
    return {
      id: r.id,
      title: r.title,
      artist: r.artist,
      bpm: r.bpm,
      hue: hueOf(r.id),
      durationMs: r.durationMs,
      audioUrl: `/songs/${r.id}/audio${r.audioExt}${v}`,
      chartUrl: `/songs/${r.id}/chart.json${v}`,
      cover: r.coverFile ? `/songs/${r.id}/cover${r.coverExt}${v}` : null,
      version: r.version,
      offsetMs: 0, // los tiempos del chart ya incluyen el desfase
      difficulties: Object.fromEntries(DIFFS.filter((d) => r.difficulties[d]).map((d) => [d, { ...r.difficulties[d] }])),
      source: r.source,
    };
  }

  function list() {
    ensureFresh();
    return [...songs.values()].map(publicSong).sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }));
  }

  function get(id) {
    ensureFresh();
    const r = typeof id === 'string' ? songs.get(id) : null;
    return r ? publicSong(r) : null;
  }

  /** Duración y nº de notas reales (del servidor) de una canción+dificultad, o null si no existe. */
  function validate(id, difficulty) {
    ensureFresh();
    const r = typeof id === 'string' ? songs.get(id) : null;
    const d = r && typeof difficulty === 'string' ? r.difficulties[difficulty] : null;
    return d ? { durationMs: r.durationMs, totalNotes: d.totalNotes } : null;
  }

  function mount(app) {
    app.get('/api/songs', (req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.json({ songs: list() });
    });

    app.get('/songs/:id/:file', (req, res, next) => {
      ensureFresh();
      const r = songs.get(req.params.id);
      if (!r) return next();
      const file = String(req.params.file).toLowerCase();

      if (file === 'chart.json') {
        res.set('Cache-Control', 'public, max-age=3600');
        res.type('application/json').send(r.chartJson);
        return undefined;
      }
      let abs = null;
      if (file === `audio${r.audioExt}`) abs = r.audioFile;
      else if (r.coverFile && file === `cover${r.coverExt}`) abs = r.coverFile;
      if (!abs) return next();

      return res.sendFile(abs, { dotfiles: 'allow', maxAge: '1h' }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    });
  }

  refresh();
  logger.info?.(`[songs] ${songs.size} canción(es) en ${root}`);
  return { mount, list, get, validate, refresh, dir: root };
}

module.exports = { createSongLibrary, audioDurationMs, parseSimfile };
