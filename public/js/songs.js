'use strict';
/* Cliente de la biblioteca de canciones (navegador). Va en public/js/songs.js.
 * (El songs.js del SERVIDOR es otro archivo y va en la raíz del proyecto, junto a server.js.)
 *
 * API que usa main.js:  fetchCatalog, normalize, pickDiff, notesFor, loadChart, loadAudio, prepare, prefetch
 * Formato de chart que entiende game.js:  { lanes: Float64Array[4], total }
 */
(function () {
  const DIFFS = ['easy', 'normal', 'hard', 'expert'];
  const MAX_CACHED = 3; // canciones decodificadas que se conservan en memoria (el PCM pesa mucho)

  const charts = new Map(); // `${chartUrl}|${diff}|${offset}` -> Promise<{lanes,total}>
  const audios = new Map(); // audioUrl -> Promise<AudioBuffer>   (orden de inserción = antigüedad)

  async function fetchCatalog() {
    const res = await fetch('/api/songs', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`No se pudo cargar la lista de canciones (${res.status}).`);
    const data = await res.json();
    return Array.isArray(data.songs) ? data.songs : [];
  }

  /** Canción del servidor -> objeto de catálogo del cliente (mismos campos que las integradas + lib:true). */
  function normalize(s) {
    return {
      songId: s.id, name: s.title, artist: s.artist, bpm: s.bpm, hue: s.hue, durationMs: s.durationMs,
      lib: true, audioUrl: s.audioUrl, chartUrl: s.chartUrl, cover: s.cover, version: s.version,
      offsetMs: Number(s.offsetMs) || 0, difficulties: s.difficulties || {}, source: s.source,
    };
  }

  /** Devuelve la dificultad pedida o, si la canción no la tiene, la disponible más cercana (a igualdad, la más fácil). */
  function pickDiff(song, wanted) {
    const have = DIFFS.filter((d) => song.difficulties[d]);
    if (!have.length) return wanted;
    if (have.includes(wanted)) return wanted;
    const w = Math.max(0, DIFFS.indexOf(wanted));
    return have.slice().sort((a, b) => Math.abs(DIFFS.indexOf(a) - w) - Math.abs(DIFFS.indexOf(b) - w) || DIFFS.indexOf(a) - DIFFS.indexOf(b))[0];
  }

  function notesFor(song, diff) {
    const d = song.difficulties[diff];
    return d ? d.totalNotes : 0;
  }

  // ---------------------------------------------------------------- chart
  function buildLanes(notes, offsetMs) {
    const buckets = [[], [], [], []];
    for (const n of notes) {
      if (!Array.isArray(n) || !Number.isFinite(n[0]) || !(n[1] >= 0 && n[1] <= 3)) continue;
      buckets[n[1] | 0].push(n[0] + offsetMs);
    }
    const lanes = buckets.map((b) => Float64Array.from(b).sort());
    return { lanes, total: lanes.reduce((a, l) => a + l.length, 0) };
  }

  function loadChart(song, diff) {
    const key = `${song.chartUrl}|${diff}`;
    if (!charts.has(key)) {
      const p = fetch(song.chartUrl)
        .then((r) => { if (!r.ok) throw new Error(`chart ${r.status}`); return r.json(); })
        .then((json) => {
          const d = json.difficulties ? json.difficulties[diff] : { notes: json.notes };
          if (!d || !Array.isArray(d.notes)) throw new Error(`el chart no tiene la dificultad "${diff}"`);
          const meta = json.meta || {};
          return buildLanes(d.notes, Number(meta.offsetMs) || 0);
        });
      p.catch(() => charts.delete(key)); // que un fallo no quede cacheado
      charts.set(key, p);
      if (charts.size > 8) charts.delete(charts.keys().next().value);
    }
    return charts.get(key);
  }

  // ---------------------------------------------------------------- audio
  async function download(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`audio ${res.status}`);
    const total = Number(res.headers.get('Content-Length')) || 0;
    if (!res.body || !res.body.getReader || !total || !onProgress) return res.arrayBuffer();
    const reader = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      onProgress(Math.min(1, got / total));
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out.buffer;
  }

  function loadAudio(song, onProgress) {
    const url = song.audioUrl;
    if (audios.has(url)) { const p = audios.get(url); audios.delete(url); audios.set(url, p); return p; } // refresca antigüedad
    const p = (async () => {
      const ctx = window.RA && window.RA.audio && window.RA.audio();
      if (!ctx) throw new Error('Este navegador no tiene Web Audio.');
      const bytes = await download(url, onProgress);
      return ctx.decodeAudioData(bytes);
    })();
    p.catch(() => audios.delete(url));
    audios.set(url, p);
    while (audios.size > MAX_CACHED) audios.delete(audios.keys().next().value);
    return p;
  }

  /** Chart + audio listos para game.start(). Sin audio devuelve buffer:null (game.js usa música generada). */
  async function prepare(song, diff, onProgress) {
    const audio = loadAudio(song, onProgress).catch(() => null);
    let chart;
    try { chart = await loadChart(song, diff); }
    catch (e) { throw new Error(`No se pudo cargar el chart de "${song.name}": ${e.message}`); }
    return { chart, buffer: await audio };
  }

  /** Precarga silenciosa (lobby). */
  function prefetch(song, diff) {
    loadChart(song, diff).catch(() => {});
    loadAudio(song).catch(() => {});
  }

  window.RA = window.RA || {};
  window.RA.songs = { fetchCatalog, normalize, pickDiff, notesFor, loadChart, loadAudio, prepare, prefetch };
})();
