'use strict';
/* Motor de ritmo: charts (generados o desde chart.json), reloj maestro = reloj de audio, render en canvas a 60 FPS. */
(function () {
  const LANES = 4;
  // Dimensiones dinámicas: se recalculan en layout() según el tamaño real de la pantalla.
  const TOUCH = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); // móvil/tablet: no hay tecla ESPACIO
  let W = 800, H = 600, HIT_Y = 150, LW = 100, FW = LW * LANES, FX = (W - FW) / 2, K = 1, U = 1;
  const FONT = "'Outfit', system-ui, -apple-system, 'Segoe UI', sans-serif";
  const WIN = { perfect: 45, great: 90, good: 135 };
  const BASE = { perfect: 1000, great: 800, good: 500 };
  const COLORS = ['#ff4fd8', '#4fd8ff', '#ffe14f', '#7dff4f'];
  const KEYS = { d: 0, f: 1, j: 2, k: 3, arrowleft: 0, arrowdown: 1, arrowup: 2, arrowright: 3 };
  // Modos de juego. normal = como siempre; survival = barra de vida; super = medidor SUPER PERFECT (ESPACIO).
  const MODES = ['normal', 'survival', 'super'];
  const MODE_DESC = {
    normal: 'Clásico: sin barra especial.',
    survival: 'Cada fallo te quita vida; los aciertos la recuperan. Si llega a 0, pierdes.',
    super: 'Cuesta cargar la barra con aciertos seguidos. Con ESPACIO (o tocando la barra), 11 s de 100% de perfección.',
  };
  const SURV_DMG = { easy: 7, normal: 9, hard: 11, expert: 13 };          // vida perdida por fallo
  const SURV_REGEN = { perfect: 1.5, great: 1, good: 0.4 };               // vida recuperada por acierto
  const SUPER_W = { perfect: 1, great: 0.8, good: 0.6 };                  // peso de cada acierto en la carga
  const END_FADE_MS = 1800;  // al terminar la canción la pantalla se oscurece durante este tiempo...
  const END_HOLD_MS = 300;   // ...se queda en negro este rato y entonces aparecen los resultados
  const SUPER_MS = 11000;                                                 // duración del SUPER PERFECT (11 s)
  const MAX_PIXELS = 5e6; // tope de píxeles del canvas: evita gastar VRAM/memoria en pantallas 4K con DPR alto

  // Canciones integradas (música generada). Las canciones MP3 vienen de /api/songs (ver songs.js).
  // style: root = nota MIDI del bajo, scale, prog = grados del acorde por compás, lead = onda, drum = 'four'|'break'|'half'.
  const SONGS = [
    { songId: 'quick-demo', name: 'Quick Demo', bpm: 128, hue: 140, durationMs: 45000, totalNotes: 150,
      style: { root: 45, scale: 'minor', prog: [0, 5, 3, 4], lead: 'square', drum: 'four' } },
    { songId: 'neon-pulse', name: 'Neon Pulse', bpm: 120, hue: 305, durationMs: 120000, totalNotes: 480,
      style: { root: 40, scale: 'minor', prog: [0, 5, 2, 6], lead: 'sawtooth', drum: 'four' } },
    { songId: 'cyber-drift', name: 'Cyber Drift', bpm: 140, hue: 195, durationMs: 150000, totalNotes: 720,
      style: { root: 38, scale: 'dorian', prog: [0, 3, 6, 4], lead: 'sawtooth', drum: 'break' } },
    { songId: 'pixel-rush', name: 'Pixel Rush', bpm: 150, hue: 50, durationMs: 90000, totalNotes: 450,
      style: { root: 43, scale: 'major', prog: [0, 4, 5, 3], lead: 'square', drum: 'four' } },
    { songId: 'midnight-grid', name: 'Midnight Grid', bpm: 100, hue: 260, durationMs: 100000, totalNotes: 400,
      style: { root: 41, scale: 'minor', prog: [0, 3, 5, 4], lead: 'triangle', drum: 'half' } },
    { songId: 'solar-flare', name: 'Solar Flare', bpm: 160, hue: 20, durationMs: 130000, totalNotes: 650,
      style: { root: 45, scale: 'phrygian', prog: [0, 1, 0, 6], lead: 'sawtooth', drum: 'break' } },
  ];

  function seedFrom(str) {
    let h = 2166136261 >>> 0;
    for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Chart determinista de las canciones integradas. (NO CAMBIAR: debe ser idéntico al servidor) */
  function makeChart(songId, durationMs, totalNotes) {
    const rand = rng(seedFrom(songId));
    const span = durationMs - 4000;
    const step = totalNotes > 1 ? span / (totalNotes - 1) : 0;
    const grid = Math.max(1, Math.min(125, step));
    const notes = [];
    let last = -1, run = 0;
    for (let i = 0; i < totalNotes; i += 1) {
      let lane = Math.floor(rand() * LANES);
      if (lane === last && run >= 2) lane = (lane + 1 + Math.floor(rand() * 3)) % LANES;
      run = lane === last ? run + 1 : 1;
      last = lane;
      notes.push({ time: 2000 + Math.round((i * step) / grid) * grid, lane });
    }
    return notes;
  }
  /** [{time,lane}] -> { lanes: Float64Array[4], total } (mismo formato que produce songs.js). */
  function toChart(notes) {
    const b = [[], [], [], []];
    notes.forEach((n) => b[n.lane].push(n.time));
    const lanes = b.map((x) => Float64Array.from(x));
    return { lanes, total: notes.length };
  }

  // ---- Audio ----
  let actx = null;
  function audio() {
    if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC({ latencyHint: 'interactive' }); }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  /**
   * Posición (en s, dominio del AudioContext) de lo que el jugador está ESCUCHANDO ahora mismo.
   * getOutputTimestamp() descuenta la latencia de salida y se interpola con performance.now(),
   * así el reloj avanza suave en cada frame (currentTime solo cambia a saltos de ~3-10 ms).
   */
  function audioNowSec(a) {
    if (a.getOutputTimestamp) {
      const ts = a.getOutputTimestamp();
      if (ts.performanceTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return a.currentTime - (a.outputLatency || 0);
  }

  // ---- Música procedural original (sin archivos) ----
  const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10] };
  const DEFAULT_STYLE = { root: 45, scale: 'minor', prog: [0, 5, 3, 4], lead: 'square', drum: 'four' };
  const KICK = { four: [0, 4, 8, 12], break: [0, 6, 10], half: [0, 10] };
  const SNARE = { four: [4, 12], break: [4, 12], half: [8] };
  const BASS = { four: [0, 3, 6, 8, 11, 14], break: [0, 3, 6, 10, 13], half: [0, 6, 10] };
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const semi = (sc, d) => sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  const noiseBufs = new WeakMap();

  function noiseBuf(a) {
    let b = noiseBufs.get(a);
    if (!b) {
      b = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
      noiseBufs.set(a, b);
    }
    return b;
  }
  function voice(a, dest, type, freq, at, dur, gain, lp, atk) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, at);
    if (lp) { const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); f.connect(g); } else o.connect(g);
    g.connect(dest);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + (atk || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.start(at); o.stop(at + dur + 0.03);
  }
  function noiseHit(a, dest, at, dur, gain, type, freq) {
    const n = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    n.buffer = noiseBuf(a); f.type = type; f.frequency.value = freq;
    n.connect(f); f.connect(g); g.connect(dest);
    g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    n.start(at, Math.random() * 0.4); n.stop(at + dur + 0.02);
  }
  function kick(a, dest, at) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(160, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.14);
    g.gain.setValueAtTime(0.95, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    o.connect(g); g.connect(dest); o.start(at); o.stop(at + 0.32);
  }
  function makeMelody(songId) {
    const r = rng(seedFrom(songId) + 99), pool = [0, 2, 4, 1, 3, 5, 7, 4, 2], m = [];
    for (let i = 0; i < 64; i += 1) {
      const on = (i % 2 === 0 && r() < 0.7) || r() < 0.22;
      m.push(on ? pool[Math.floor(r() * pool.length)] : null);
    }
    return m;
  }
  function playStep(s, m, n, at) {
    const a = actx, o = m.out, st = s.style, sc = SCALES[st.scale] || SCALES.minor;
    const bar = Math.floor(n / 16), sp = n % 16, section = Math.floor(bar / 4), step = s.stepMs / 1000;
    const deg = st.prog[bar % st.prog.length], root = st.root;
    if (KICK[st.drum].includes(sp)) kick(a, o, at);
    if (SNARE[st.drum].includes(sp)) { noiseHit(a, o, at, 0.16, 0.32, 'highpass', 1800); voice(a, o, 'triangle', 190, at, 0.1, 0.18); }
    if (st.drum === 'half') noiseHit(a, o, at, 0.04, sp % 4 === 2 ? 0.1 : 0.05, 'highpass', 8000);
    else if (sp % 2 === 0) noiseHit(a, o, at, sp === 14 ? 0.2 : 0.045, sp % 4 === 2 ? 0.13 : 0.07, 'highpass', 7500);
    if (BASS[st.drum].includes(sp)) {
      const oct = sp === 6 || sp === 14 ? 12 : 0;
      voice(a, o, 'sawtooth', mtof(root + semi(sc, deg) + oct), at, step * (st.drum === 'half' ? 3 : 1.7), 0.26, 420 + section * 60);
    }
    if (sp === 0) for (const d of [0, 2, 4]) voice(a, o, 'sawtooth', mtof(root + 12 + semi(sc, deg + d)), at, step * 16, 0.03, 900, 0.25);
    if (section >= 1 && (sp % 2 === 0 || section >= 2)) {
      const tones = [0, 2, 4, 7];
      voice(a, o, 'triangle', mtof(root + 24 + semi(sc, deg + tones[sp % 4])), at, step * 1.6, 0.07, 3000);
    }
    if (section >= 2) {
      const k = s.melody[(bar % 4) * 16 + sp];
      if (k !== null && k !== undefined) voice(a, o, st.lead, mtof(root + 24 + semi(sc, deg + k)), at, step * 2.2, 0.075, 3600);
    }
  }
  /** Programa por adelantado (250 ms) los pasos de la música generada, en el dominio del AudioContext. */
  function tickSynth(s) {
    const m = s.music, a = actx;
    if (!m || m.stopped || !a || S !== s || !s.began) return;
    const horizon = a.currentTime + 0.25;
    if (m.next === null) m.next = Math.max(0, Math.ceil(((a.currentTime - s.ctxStart) * 1000) / s.stepMs));
    while (s.ctxStart + (m.next * s.stepMs) / 1000 < horizon && m.next * s.stepMs <= s.duration) {
      const at = s.ctxStart + (m.next * s.stepMs) / 1000;
      if (at >= a.currentTime - 0.03) playStep(s, m, m.next, Math.max(at, a.currentTime));
      m.next += 1;
    }
  }
  /**
   * Arranca la música. audioIn = AudioBuffer | Promise<AudioBuffer|null> | null.
   * El MP3 se programa en el instante exacto ctxStart (reloj de audio): sin deriva ni retrasos de <audio>.
   * Si el buffer llega tarde, entra en el punto correcto; si no hay buffer, suena la música generada.
   */
  function startMusic(s, audioIn) {
    const a = actx;
    if (!a) return;
    const out = a.createGain(), comp = a.createDynamicsCompressor();
    out.gain.value = s.volume * 0.8; out.connect(comp); comp.connect(a.destination);
    const m = { out, comp, timer: 0, next: null, src: null, stopped: false };
    s.music = m;
    const synth = () => {
      if (S !== s || m.stopped) return;
      m.timer = setInterval(() => tickSynth(s), 40); tickSynth(s);
    };
    if (!audioIn) { if (!s.silent) synth(); return; }
    Promise.resolve(audioIn).then((buf) => {
      if (S !== s || m.stopped) return;
      if (!buf) { synth(); return; }
      const src = a.createBufferSource();
      src.buffer = buf; src.connect(out); m.src = src;
      const lead = s.ctxStart - a.currentTime; // > 0: todavía no toca empezar
      if (lead >= 0) src.start(s.ctxStart, 0);
      else if (-lead < buf.duration) src.start(0, -lead);
    }).catch(() => synth());
  }
  function stopMusic(s) {
    const m = s && s.music, a = actx;
    if (!m) return;
    m.stopped = true; clearInterval(m.timer);
    if (a) {
      try { if (m.src) m.src.stop(a.currentTime + 0.25); } catch (e) { /* ya detenido */ }
      m.out.gain.cancelScheduledValues(a.currentTime);
      m.out.gain.setTargetAtTime(0, a.currentTime, 0.06);
      setTimeout(() => { try { m.out.disconnect(); m.comp.disconnect(); } catch (e) { /* ok */ } }, 700);
    }
    s.music = null; // suelta la referencia al AudioBuffer (la caché de songs.js decide si lo conserva)
  }
  function setVolume(v) {
    if (!S || !S.music || !actx) return;
    S.volume = v;
    S.music.out.gain.setTargetAtTime(v * 0.8, actx.currentTime, 0.02);
  }

  // ---- Voces ----
  // Archivos en public/voices/ (se sirven como /voices/...). Se descargan y decodifican UNA sola vez por sesión
  // (al iniciar la primera partida) y quedan en memoria como AudioBuffer: reproducirlas después no cuesta nada.
  const VOICE_BASE = '/voices/';
  const VOICE_FILES = {
    start: 'VOICE_0003.wav',
    100: 'VOICE_0008.wav', 200: 'VOICE_0007.wav', 300: 'VOICE_0006.wav', 400: 'VOICE_0005.wav', 500: 'VOICE_0004.wav',
    600: '600combos.wav', super: 'showtime.wav',
    perfect: 'VOICE_0018.wav',
    boom: 'showtimeboom.wav', active: 'electricity.wav', ending: 'showtimeenegy.wav', // efectos del SUPER PERFECT
  };
  const voiceBufs = new Map(); // clave -> Promise<AudioBuffer|null>
  const voiceEls = new Map();  // clave -> <audio> de respaldo (si el navegador no puede decodificar el WAV con Web Audio)
  function loadVoices() {
    const a = actx;
    if (!a) return;
    for (const key of Object.keys(VOICE_FILES)) {
      if (voiceBufs.has(key)) continue;
      const url = VOICE_BASE + VOICE_FILES[key];
      voiceBufs.set(key, fetch(url)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} (¿está el archivo en public/voices?)`); return r.arrayBuffer(); })
        .then((b) => a.decodeAudioData(b))
        .catch((e) => {
          console.warn(`[voces] ${url}: ${e && e.message ? e.message : e}`);
          const el = new Audio(url); el.preload = 'auto'; voiceEls.set(key, el); // plan B
          return null;
        }));
    }
  }
  /** key: 'start' o el múltiplo de 100 del combo ('super' = al activar el SUPER PERFECT). */
  function playVoice(s, key) {
    key = String(key);
    const p = voiceBufs.get(key);
    if (!p || !actx) return;
    p.then((buf) => {
      if (S !== s || !actx) return;
      const vol = Math.min(1, s.volume * 1.3); // sigue el control de volumen del jugador
      if (!buf) {
        const el = voiceEls.get(key);
        if (el) { el.volume = vol; el.currentTime = 0; el.play().catch((e) => console.warn(`[voces] ${key}: ${e.message}`)); }
        return;
      }
      // las voces ya NO se cortan entre sí: si suena la de un combo y activas el SUPER PERFECT, ambas se oyen completas
      const src = actx.createBufferSource(), g = actx.createGain();
      g.gain.value = vol;
      src.buffer = buf; src.connect(g); g.connect(actx.destination);
      src.onended = () => { try { g.disconnect(); } catch (e) { /* ok */ } if (s.voices) s.voices.delete(src); };
      (s.voices || (s.voices = new Set())).add(src); src.start();
    });
  }

  /**
   * Efecto que NO corta a las voces (pueden sonar a la vez). o: { loop, gain }.
   * Devuelve un manejador { stop(), duck(f) } (f = factor de volumen 0..1) utilizable aunque el audio aún no haya cargado.
   */
  function playSfx(s, key, o) {
    o = o || {};
    const p = voiceBufs.get(String(key));
    if (!p || !actx) return null;
    const h = { dead: false, base: 0, src: null, g: null, el: null };
    h.stop = () => {
      h.dead = true;
      try { if (h.src) h.src.stop(); } catch (e) { /* ya terminado */ }
      try { if (h.g) h.g.disconnect(); } catch (e) { /* ok */ }
      if (h.el) h.el.pause();
    };
    h.duck = (f) => {
      if (h.g && actx) h.g.gain.setTargetAtTime(h.base * f, actx.currentTime, 0.08);
      if (h.el) h.el.volume = Math.min(1, h.base * f);
    };
    p.then((buf) => {
      if (h.dead || S !== s || !actx) return;
      h.base = Math.min(1, s.volume * 1.3 * (o.gain || 1));
      if (buf) {
        const src = actx.createBufferSource(), g = actx.createGain();
        g.gain.value = h.base; src.buffer = buf; src.loop = !!o.loop;
        src.connect(g); g.connect(actx.destination);
        src.onended = () => { try { g.disconnect(); } catch (e) { /* ok */ } };
        h.src = src; h.g = g; src.start();
      } else {
        const el = voiceEls.get(String(key));
        if (el) { el.loop = !!o.loop; el.volume = h.base; el.currentTime = 0; el.play().catch((e) => console.warn(`[voces] ${key}: ${e.message}`)); h.el = el; }
      }
    });
    return h;
  }
  /** Duración (ms) de un sonido cargado, o 0. */
  function sfxMs(key) {
    const p = voiceBufs.get(String(key));
    if (!p) return Promise.resolve(0);
    return p.then((buf) => {
      if (buf) return buf.duration * 1000;
      const el = voiceEls.get(String(key));
      return el && isFinite(el.duration) ? el.duration * 1000 : 0;
    });
  }
  /** Corta los sonidos del SUPER PERFECT. all=true también el aviso final. */
  function stopSuperSfx(s, all) {
    if (!s) return;
    clearTimeout(s.spTimer);
    if (s.spLoop) { s.spLoop.stop(); s.spLoop = null; }
    if (all && s.spEnd) { s.spEnd.stop(); s.spEnd = null; }
  }

  /** Promise<ms>: duración de la voz de inicio (0 si no está disponible). */
  function introMs() {
    loadVoices();
    const p = voiceBufs.get('start');
    if (!p) return Promise.resolve(0);
    return p.then((buf) => {
      if (buf) return buf.duration * 1000;
      const el = voiceEls.get('start');
      if (!el) return 0;
      if (el.readyState >= 1 && isFinite(el.duration)) return el.duration * 1000;
      return new Promise((res) => {
        const t = setTimeout(() => res(0), 1500);
        el.addEventListener('loadedmetadata', () => { clearTimeout(t); res(isFinite(el.duration) ? el.duration * 1000 : 0); }, { once: true });
      });
    });
  }

  // ---- Motor ----
  let S = null;

  function judge(kind) {
    const st = S.stats;
    S.judged += 1;
    if (kind === 'miss') { st.miss += 1; st.combo = 0; S.perfRun = 0; }
    else {
      st[kind] += 1; st.combo += 1;
      if (st.combo > st.maxCombo) st.maxCombo = st.combo;
      if (st.combo % 100 === 0) milestone(st.combo); // 100, 200, 300...: animación + voz
      if (kind === 'perfect') { S.perfRun = (S.perfRun | 0) + 1; perfectVoice(); } else S.perfRun = 0; // racha de PERFECT seguidos
      st.score += Math.round(BASE[kind] * (1 + Math.min(st.combo, 40) / 80)); // máx. 1500/nota
    }
    S.text = kind; S.textAt = performance.now(); if (kind !== 'miss') S.comboAt = S.textAt; S.dirty = true;

    if (S.mode === 'survival') {
      if (kind === 'miss') {
        S.life = Math.max(0, S.life - (SURV_DMG[S.diff] || SURV_DMG.normal)); S.hurtAt = S.textAt;
        if (S.life <= 0) die();
      } else S.life = Math.min(100, S.life + SURV_REGEN[kind]);
    } else if (S.mode === 'super' && !S.spActive && kind !== 'miss') {
      S.charge = Math.min(100, S.charge + (100 / S.spNeed) * SUPER_W[kind]); // spNeed = aciertos perfectos para llenar
      if (S.charge >= 100 && !S.spReady) { S.spReady = true; S.spReadyAt = S.textAt; }
    }
  }

  /**
   * Voz de "racha perfecta" (VOICE_0018). Para que no resulte repetitiva solo se considera cada 10 PERFECT seguidos
   * a partir de 30, con un 40 % de probabilidad, un enfriamiento de 25 s, y nunca pisa a otra voz ni al SUPER PERFECT.
   */
  function perfectVoice() {
    const s = S, now = performance.now(), run = s.perfRun | 0;
    if (s.spActive || run < 30 || run % 10 !== 0) return;
    if (now - (s.perfVoiceAt || -1e9) < 25000) return;
    if ((s.voices && s.voices.size) || (s.mile && now - s.mile.at < 3000)) return;
    if (Math.random() > 0.4) return;
    s.perfVoiceAt = now;
    playVoice(s, 'perfect');
  }

  /** Combo 100/200/300...: voz + animación (el estado de las partículas se crea solo aquí, no en cada frame). */
  function milestone(n) {
    const parts = [], hue = S.hue;
    for (let i = 0; i < 34; i += 1) {
      const a = Math.random() * Math.PI * 2;
      parts.push({ a, sp: 140 + Math.random() * 300, sz: 2 + Math.random() * 3.5, col: i % 3 === 0 ? '#ffffff' : i % 3 === 1 ? '#ffd84a' : `hsl(${hue},100%,70%)` });
    }
    S.mile = { at: performance.now(), n, parts };
    if (n <= 600) playVoice(S, n); // voces de 100 a 600; de 700 en adelante solo animación, sin voz
  }

  /** Supervivencia: sin vida se acaba la partida (se conservan las estadísticas hasta ese momento). */
  function die() {
    const s = S;
    if (!s || s.dead) return;
    s.dead = true; s.done = true; s.deadAt = performance.now();
    window.RA.lastResult = { mode: s.mode, died: true };
    stopMusic(s);
    if (s.onStats) s.onStats({ ...s.stats });
    setTimeout(() => { if (S === s) s.onFinish({ ...s.stats }); }, 1900);
  }
  /** Super perfect: se activa solo con la barra llena. */
  function activateSuper() {
    const s = S;
    if (!s || s.done || s.mode !== 'super' || s.spActive) return;
    const now = performance.now();
    if (!s.spReady) { s.spDeniedAt = now; return; }
    s.spReady = false; s.spActive = true; s.spStart = now; s.spUntil = now + SUPER_MS; s.charge = 0;
    playVoice(s, 'super');                               // voz "showtime"
    playSfx(s, 'boom');                                  // golpe al pulsar ESPACIO
    stopSuperSfx(s, true);
    s.spLoop = playSfx(s, 'active', { loop: true });     // suena mientras la barra está activa
    sfxMs('ending').then((dur) => {                      // aviso final: termina justo cuando acaba el SUPER PERFECT
      if (S !== s || !s.spActive) return;
      const wait = Math.max(0, s.spUntil - performance.now() - dur);
      s.spTimer = setTimeout(() => {
        if (S !== s || !s.spActive) return;
        if (s.spLoop) s.spLoop.duck(0.35);               // baja el bucle para que se oiga el aviso
        s.spEnd = playSfx(s, 'ending');
      }, wait);
    });
  }
  function endSuper() { stopSuperSfx(S, false); S.spActive = false; S.charge = 0; S.spReady = false; }

  /**
   * Anti-machaque, sin castigo visible: una pulsación suelta al aire no hace nada (ni MISS ni vida).
   * Solo si se aplastan 3 o más flechas casi a la vez y alguna no tenía nota, el combo se corta en silencio.
   */
  function mash(lane, stray) {
    const s = S, now = performance.now();
    if (!s || s.spActive) return;
    const h = (s.recent = (s.recent || []).filter((x) => now - x.t < 120));
    h.push({ t: now, lane, stray });
    if (h.length < 3 || !h.some((x) => x.stray)) return;
    if (new Set(h.map((x) => x.lane)).size >= 3 && s.stats.combo > 0) { s.stats.combo = 0; s.perfRun = 0; s.dirty = true; s.recent = []; }
  }

  function press(lane) {
    if (!S || S.done) return;
    const t = S.now(); // se lee en el instante de la pulsación, no al inicio del frame
    const q = S.lanes[lane], i = S.heads[lane];
    S.flash[lane] = performance.now();
    const d = i < q.length ? Math.abs(q[i] - t) : Infinity;
    if (d > WIN.good) { mash(lane, d > WIN.good * 1.6); return; }
    S.heads[lane] += 1;
    judge(S.spActive || d <= WIN.perfect ? 'perfect' : d <= WIN.great ? 'great' : 'good');
    mash(lane, false);
  }

  function onKey(e) {
    if (e.code === 'Space' || e.key === ' ') {
      if (S && S.mode === 'super') { e.preventDefault(); if (!e.repeat) activateSuper(); }
      return;
    }
    // Teclas configurables (RA.keys); si el módulo no está, se usan las de fábrica
    const RK = window.RA && window.RA.keys;
    const lane = RK ? RK.laneOf(e.code) : KEYS[e.key.toLowerCase()];
    if (lane === undefined || e.repeat) return;
    e.preventDefault();
    press(lane);
  }
  /** ¿La siguiente nota de esa columna está dentro de la ventana de acierto? */
  function noteReady(lane) {
    const q = S.lanes[lane], i = S.heads[lane];
    return i < q.length && Math.abs(q[i] - S.now()) <= WIN.good;
  }
  /**
   * Un toque = una o dos columnas. Si el dedo cae sobre el borde entre dos flechas (o su huella, `rad`, abarca las dos),
   * cuenta como pulsar ambas cuando las dos tienen nota a la vez (salto con un solo dedo, p. ej. izquierda + abajo).
   * Si solo una de las dos tiene nota a tiempo, se pulsa solo esa; si ninguna, la más cercana (sin penalización).
   */
  function tapAt(canvas, cx, cy, rad) {
    const r = canvas.getBoundingClientRect();
    const px = ((cx - r.left) / r.width) * W, py = ((cy - r.top) / r.height) * H;
    // La barra del SUPER PERFECT solo "roba" el toque cuando YA está lista: si no, el toque debe tocar la flecha.
    const br = S && S.mode === 'super' && S.spReady && !S.spActive && S.barRect;
    if (br && px >= br.x && px <= br.x + br.w && py >= br.y && py <= br.y + br.h) { activateSuper(); return; }
    const clamp = (l) => Math.min(LANES - 1, Math.max(0, l));
    const main = clamp(Math.floor((px - FX) / LW));
    if (!rad && rad !== 0) { press(main); return; }              // ratón / lápiz: una columna
    const m = Math.min(LW * 0.45, Math.max(LW * 0.22, (rad || 0) * (W / r.width))); // margen alrededor del dedo
    const a = clamp(Math.floor((px - m - FX) / LW)), b = clamp(Math.floor((px + m - FX) / LW));
    if (a === b) { press(main); return; }
    const ready = [a, b].filter(noteReady);
    if (ready.length) for (const l of ready) press(l);
    else press(main);
  }
  // Navegadores con eventos táctiles (casi todos los móviles): los dedos van por 'touchstart'.
  // Si no existen (algunos WebView), los dedos van por Pointer Events (un pointerdown por dedo).
  const HAS_TOUCH_EVENTS = 'ontouchstart' in window;
  function onPointer(e) {
    e.preventDefault();
    if ((e.pointerType === 'touch' || e.pointerType === 'pen') && HAS_TOUCH_EVENTS) return; // ya lo cuenta onTouch
    tapAt(e.currentTarget, e.clientX, e.clientY, e.pointerType === 'mouse' ? undefined : (e.width || 0) / 2);
  }
  /** Multitáctil: cada dedo nuevo es una pulsación independiente, aunque varios lleguen en el mismo instante. */
  function onTouch(e) {
    e.preventDefault();
    const cv = e.currentTarget, list = e.changedTouches;
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      tapAt(cv, t.clientX, t.clientY, Math.max(t.radiusX || 0, t.webkitRadiusX || 0));
    }
  }
  /** Sin esto algunos navegadores cancelan o mueven la página al apoyar un segundo dedo. */
  function onTouchBlock(e) { e.preventDefault(); }

  // ---------- Render ----------
  const ROT = [-Math.PI / 2, Math.PI, 0, Math.PI / 2]; // ← ↓ ↑ →
  const JUDGE = { perfect: ['FANTASTIC!', '#7ff6ff'], great: ['GREAT', '#b6ff6a'], good: ['GOOD', '#6aa8ff'], miss: ['MISS', '#ff5a6a'] };
  const DIFF = { easy: ['Easy', 3], normal: ['Normal', 6], hard: ['Hard', 8], expert: ['Expert', 10] };

  function makeFx(songId) {
    const r = rng(seedFrom(songId) + 7);
    return {
      bars: Array.from({ length: 16 }, () => ({ x: r(), w: 6 + r() * 40, a: 0.04 + r() * 0.12 })),
      drops: Array.from({ length: 60 }, () => ({ x: r(), y0: r(), sp: 50 + r() * 170, len: 6 + r() * 18 })),
    };
  }
  function rr(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  const font = (weight, size, italic) => `${italic ? 'italic ' : ''}${weight} ${Math.round(size)}px ${FONT}`;

  function pill(c, x, y, w, h, text, hue) {
    rr(c, x, y, w, h, h / 2);
    const pc = S.g && S.g.pill; let g;
    if (pc && pc.y === y && pc.h === h) g = pc.g;
    else { g = c.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, 'rgba(18,22,48,.82)'); g.addColorStop(1, 'rgba(6,8,22,.82)'); }
    c.fillStyle = g; c.fill();
    c.lineWidth = 1.5 * K; c.strokeStyle = `hsla(${hue},90%,70%,.75)`; c.stroke();
    c.font = font(700, 15 * K); c.textAlign = 'center'; c.fillStyle = '#eef6ff';
    c.fillText(text, x + w / 2, y + h / 2 + 5.2 * K, w - 18 * K);
  }
  function label(c, str, x, y, f, fill, align) {
    c.font = f; c.textAlign = align || 'center'; c.lineJoin = 'round'; c.lineWidth = 5 * K;
    c.strokeStyle = 'rgba(0,0,0,.85)'; c.strokeText(str, x, y); c.fillStyle = fill; c.fillText(str, x, y);
  }
  /**
   * Texto con contorno y resplandor. La sombra gaussiana por frame es lo más caro del canvas 2D, así que cada texto
   * se dibuja UNA vez en un canvas aparte (cacheado por texto/fuente/color) y después es un simple drawImage.
   */
  function glowText(c, str, x, y, weight, size, italic, fill, glow, blur) {
    const g = S.g, f = font(weight, size, italic), key = `${f}|${str}|${fill}|${glow}|${Math.round(blur)}`;
    let t = g.txt.get(key);
    if (!t) {
      const dpr = g.dpr;
      c.save(); c.font = f; const tw = c.measureText(str).width; c.restore();
      const pad = Math.ceil(blur * 1.6 + 6 * K), w = Math.ceil(tw + pad * 2), h = Math.ceil(size * 1.4 + pad * 2), base = Math.ceil(pad + size * 1.05);
      const cv = document.createElement('canvas'); cv.width = Math.ceil(w * dpr); cv.height = Math.ceil(h * dpr);
      const x2 = cv.getContext('2d'); x2.setTransform(dpr, 0, 0, dpr, 0, 0);
      x2.font = f; x2.textAlign = 'center'; x2.lineJoin = 'round'; x2.lineWidth = 5 * K;
      x2.shadowColor = glow; x2.shadowBlur = blur;
      x2.strokeStyle = 'rgba(0,0,0,.85)'; x2.strokeText(str, w / 2, base);
      x2.fillStyle = fill; x2.fillText(str, w / 2, base);
      if (g.txt.size > 80) g.txt.clear();
      t = { cv, w, h, base }; g.txt.set(key, t);
    }
    c.drawImage(t.cv, x - t.w / 2, y - t.base, t.w, t.h);
  }
  /** Flecha tipo DDR. o: { grad, alpha, glow, stroke, lw } */
  function arrow(c, x, y, lane, s, color, o) {
    c.save(); c.translate(x, y); c.rotate(ROT[lane]);
    c.beginPath();
    c.moveTo(0, -s); c.lineTo(s, s * 0.1); c.lineTo(s * 0.5, s * 0.1); c.lineTo(s * 0.5, s * 0.95);
    c.lineTo(-s * 0.5, s * 0.95); c.lineTo(-s * 0.5, s * 0.1); c.lineTo(-s, s * 0.1); c.closePath();
    if (o.grad) {
      const g = c.createLinearGradient(0, -s, 0, s);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.4, color); g.addColorStop(1, color);
      c.fillStyle = g;
    } else c.fillStyle = color;
    c.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
    if (o.glow) { c.shadowColor = o.glow; c.shadowBlur = 16 * U; }
    c.fill();
    c.shadowBlur = 0; c.globalAlpha = 1; c.lineJoin = 'round'; c.lineWidth = (o.lw || 3) * U; c.strokeStyle = o.stroke; c.stroke();
    c.restore();
  }

  /** Flecha en imagen (public/img/arrow.png, apunta hacia ARRIBA). Si no carga, se usan las flechas vectoriales de arrow(). */
  const ARROW = { img: new Image(), ready: false };
  ARROW.img.onload = () => { ARROW.ready = true; if (S) layout(); };
  ARROW.img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAB6RElEQVR42u39eZxeZX3/jz/f13XOue97tkwWSAJkI2HVCmRjU0chC7gQtFLbunQBN1TAWhdARVtFLdVPa39tbYntp3UBxX3FkLD4/bQICrKvySxZCJBkMvtyn3Nd798f59yTCQK575l7MpNwXzwOKOSeOefc1/t9vV7v5fUWauulsgzgVdW82B8SEV/6s7VXdvgvqb2Cl8QKgGT1Oef8eV9f39Xe45X9HYEg3hgxM5tnXPvTDb/4z9Jnaq+u5gBq6zAw/vNWr764rbVt/fDwMEYE/b2NIKgqUS5i0bFLLrn5lpu/VnMCLw1YWFuH6WqhJUBI1q5ae0lrW/v6OI59EARejPHmOZcY8TawPo5j39a6ef35a9degkjS0tIS1N5kDQHU1qEK+1evvrijtX19XBz2xhgp4ztXVe+jKGePnnfMxZtuu+0/akjg8F229gpeGsZvjSkX8YmIkCSJ9vf1X3jGitOfenLL5t9mP7MWGKw5gNo6FIx/7aq1l3S0t61PisPOGGMqpHsiIjjntKen64KVK1duf3Lz5ntqTqAWA6itKc35CRCSVeesuqS9vfX64vCwl9T4x0L1RERkeLjot2zesn5Vy2v/AqjFBGoxgNqasie/kKxetfrijrb29fHwsLdiRGVs37GqIiIA6r3XXC5nFh+35N0/+8Uvrm+B4I5aTKBGAWprasH+81avvri9rX19UiymAT8Zu4PPjH9/OtDVdcHK5Su3b2yt0YGaA6itKWX8q1evvri9smh/pXQA55x293SvO+3UU7a2trff20JL0EFHzQnUYgC1NSmcP+XjydpVqy7paBuJ9lfb+PeLCRSHi377tu3/cf6a8991B3fUYgK1GEBtTS7sP+/i1rYt65Ni0UuK2yf6O1VV1TAMzeJjl1zy81rFYI0C1NbkGP+aNWv+sr11y9eSYtGNI9pfFTpQiwnUKEBtHUTjX7tq1SUdrW1fK6YBv4Nl/PvTgWJKB16/5vx3UUsR1hBAbU3sWrZsWbhz585k7apVl7S1d1wfD1ca8BMQAyIvfFXgBIwxJEmi3d3dF6xcuWLHxk2bftvS0hJ0dNQCg7UYQG1NyMm/evXqi7e2tq0vllJ95X6HIqiPUV98wQ8oYEwOpITmy/rRIzGBefPn/eXG226rtRLXHEBtTYTxn7d69cWtpSIfY0TL+v4UTIDGgwT1R5OrPwGPe4HNoAz3Powf2g22AdXUWQgWfXF6P1IstGTxknf99Je/WF9zAjUHUFtVWC0tLcEdd9yRrFq16pJt7R3XF4tFb8qM9qsoxoeo70ca5jFr/rsgPwvVIr8f/lEMFj+8iz1b/wvt24K19XhAcZQRLlLvvUZRNJIdKN177VusOYDaGsfJv2rVqku2tnVcH+9r7CkT9lt8MkBQfwzTF70bwnq8G0BeMPSjYPMQd7O3/Rto31aMCUiMw2hZ8WJVVQ2CwCxcsPDiDbdtqrUST/FVCwJOceNfu2rVJVvbO66Pi8PeiBGRMjI3qmADNBnKjP9dEDWCH0YkAqOIWETMfpcRQRQkyJNrPpHhgQ50+BmQesBhMjrA7+kJjYo0iKhzTgf6By5csWL5js1bttRaiWsOoLbGyvnb2jvWx8VievKXY/yiQIjEA9B4NDMWvhsNm8APgoTZf5cXOP8FFVB1mKCO3LQTKPZtxQw/jTERKHhxB2oxEGMMcRz73u6edcuXr9y+udY7MGVXrQ5gCnJ+smh/a2vb+mR42BuRCvL8Fu/6kYZjmLnwPfhcPZ4BMCGKotn5/aKXGLyL0XAmzYvfCQ1L8M5lN3Dg21BVMcaYYhz71i1Prl9z7rl/Sa1OoBYDqK0yYf/atZe0bWkdyfNLdm4fEPYbm8H+eTQvuhiXawQ3nEbxxVf0dQseVQPWQtJHT+t/4Xu3gG1CGcYggMlcygvflfde87m8WXjswnf/YsOGWitxjQLU1osZ/5o1a/6yfUvr+riSPL8oaADJIDQew8xF78JH04DB9Me+COx/0bNBQL3DBnXkmk6g2L8VGX4aawqoKl58uXRAe3p7L1ixfPm2TVu21OhAzQHU1vMZf6rh1/a1pMT5y7RaEYv6IaTxGKYf+x58VI8yhCEEdFw3JiKo9/iwkfy04xnq344O700Li6QswYF9vQNd3RcuW7p025a2tpoTqMUAamuE8wvJmlVr3pW29Ba9pGoeB87zA2oMPh7C1M9j+qJ3o1Ed+BijIYjPKnxlfJdRjBtGg2lMW/JOaDwG74cQQhSXFQvJgZyAJHHst3Zs/dr5a9a8S0SSZcuWhbUdUIsB1Dj/qlWXtLe1X19Zea8iBEgyCE3H0Lzo3bioCbQfoyEqWtVtImgqE2ZDtNhNz+b/C/2tiG3Ca5z9PnMgKKDOOZ/L5ey8RQsvueWWW2qtxDUKUOP87a1tlXF+QAjwySDSdAzNi9+Ly9UjOoSREC+AkRdv+qnoIoX7RiCjA3XNJzDYtwMd3gNiUDHl0gFxzmlvd/e6FUtXbNvcVosJ1CjASw320zIS7W9vbftaHMdpkU857XgqIBZNBggb5tG05D24fD3iiwghXnw5OYMxLc12jPgiLjeNpuPeiTbOw+voTAOIlkEHksS3b23/Wm0CUQ0BvOQ4/x0dd2Tlve37WnrLFPBUY5F4EG06mqbj3ktgmoAhEDsq2j+RzC5FBHiHBPUUpr+MYm87DO/EUgfiK8oO9Pb0rjvt1KXbb7391ntqrcS1GMBLAvZn0f4U9kv5xi9icMkgNB3N9MUfgKgAfmiS/LiCBw0K2GInezd/A3q2IEGIF4OoK2d7qXqvQRiaYxcfe8nNtZhADQEc7sY/MrEnrsD4NeXg3g8QNiyg6bj3o/kGbByjJsw8uSCY7J8H4y+TSod7h4b1FJpfxmD/E+jQHkTyIEk5jyYigvdee3v71q1ctmL7k7WYQM0BHI6wv6OjI5XubhtV5FOubr8YTDyENB1D0wnvx9pp4AfxJkTQ/YJ11Qv8VXCphzBHvvlUir1bYPgprDag4lAonw709qxbetqp27a0td1TkxyvOYDDh/PfMcL5K4L9ChgxaDKENs+j+bgPorl60EFU0qCbStbAM6mXoOrwUYG65pMZ6nsaHdoJJsi6Bw9YhjxqFmHPhStXrtyxsXXTb1sg6KghgZoDOJRhf0dHRwb7269P4tgbYzhwV59maTULrh/bMJ+GE96Pz9dh4yLejq7wmyJhHBFEEzQLDA73b4aBXWBzcOAOwpITUOec9vb0rlu5cuX2jbWy4ZoDONQ5/748fyVTeiXtz4+HoGkeDSd9ABNNAzeE2uA5sH8qXQbUoWGO3PSlDPduTnsHtAGVuByHVRpN7nt7ei5cesortm1pb685gZoDOAQ5/9aOkdr+uFj0VowpD/YrRiwaD6HNx9B4wmVIrh7cICJ28nh+JU7AJ0iQJz/zDxjqeQo/tANMmNYvcOAUoRgjSRxrX2//hStXrqiJitQcwKEI+1dd0tHesT6D/eVxfk2N3yX92Kb5NJ74AVy+gI2LqAlGzs8pf4kBTRBTID/jZQz1bYbB3YiNKqEDOO+0t6dn3YoVK3ZsaW2tOYGaAzg0YP/qc1Zf3NHesb5Y4aBOsRYpDiDNC2g6+YPYYBrGDaEmGGnqGe8JfaDGn2rTAYIChenLGO59Eh1+hoAGvInLERcRMUISJ9rb07vu1FNeUZtAVHMAh4Dxr159cUdHWuRT7qBOlVSjj3gIps+j6cQrIGrAuwEwESouG+hR2VEspSh9ViFgREg0pRleUqHvfZfiVbBWMlUgqQYUAK/4KE9u5isY7t6BH94GJo9gyqMDaUxA+/tqdKDmAKY451+7au0l7e1t65NiXPbJryiWAO8GME3zaDrxgyS5AiZJi3xUNEsaVG6B6S/PHIcR+pOE+lweEwg2CLFBkF0WG4QEFgYGi9gwxKpHx/h7n+uFRBPE1lGYeTJDva3IwC6wWbuyyoHe0kiKsLenZ92KpSt2bGlrrU0gqtKqlQJX6eRfVVLvrXRclzHI8ABMW0D9yz6AhI1ptN8EgBvHV6RoJtwVKHQPFPnQO1/BRefOI3EWG9g0mzASf0gP7O/esoUvf/1+GhtT1R/VajUWebyJsMND9D/6T7ieNqw04YIhxJfnK0vDR46ed8zFm267rSY5XkMAU8P416xZ85cdoyb2VAr7Zfo8mk66AqJ6vE9hPySjqvsqvRQvhgAD1tPTl/CRd76c973l5dQX8jTWhdTnn3MVQurzlhUvO5JcznLbb54iyqfYw4sgpTlE46ADxjk0iohmnMJw91YY3gqmkKKUF6EDqpq2EBpDEsfa39d/4ZkrV+x4okYHag5g0mB/WqqarFq16pKSko+pwPiNBqgbwEybT93Jl+ELecQVQVL1XhmHtXm1GBHUJvR1Kx/581N5z1tejvcvDvwUxTtY8bIjyEeW2+9+ljBvsb6EFcZHB0q9AxIUyM18OXFPOzLwLAQBjDzz83KA36MD3T3d61auXLn9yS2ba12ENQdw8Dn/HVvvSFads+qSrR2Vw34xBuIBzLQF1J/8QXyuERsP4ez4NfxAEAMBQk9vwkf+/FTe+4cn4WKHCUwW7X+h4H1qhN45Vrx8DvkINt79LPlc+mTjvTNNTRjVBBfWYWedinY/hg50YqWAN+U3ECVJor3d3etOefkp22771e331MqGaw7goMH+UmPP1o6OymA/aW0/xWGYUYL9TagOIiYaxfnHEO5HMpEwg1hPT3/MR97xB7z3LS8jSRzGKAe8TQXEgzE4p6x4+Wwac8LG3zxFPheMiiuMMzBoBFQJbISddRrFnq3o0FbU1Gc34l6wWnqEDmROYGBg4MIVK5Y/tbFGB2oO4GBx/vNWr764o619fVIJ7EexGuLjfmTafOpfdjmuUIf6YaCk4ZflzyvNuSMYsQTGkwSevh7ho392Gu/9w5PwXrHWpKjjQLcpko0Jk6ygT1n2spkUchG3/WYXpg4sgseMr0Yg+7yqh7CO/KyTSLraYXAnEoQvQlKenw709vRcsHLlyu1Pbq5NIKo5gAmE/aWTv6O1vfIin0zGS5oXUv8Hl5HkGwmGh9PGnpKEV6VBP5MG/BRBbIJIQE+v56N/9nLe++YTSGKHCewY8wgewaR04GWziQrK7XftJsoBxqQWZkaFFMZyGQEfo0EDwZFL8XufQAc7sZKviA5kkuPrTjv1lK2t7e331lqJaw6gqmvZsmXhnXfemaxatfaSbe2t64vDw95aW/bJL8YixSFk+nwaXv4hyE1LdfxLuXBjxizZjRhCDN4oewdjrn7bSbznD19GEvsM9lcwVWz/SGV2b5bEeU4/+Qjq8wG33PM0+ciQPr0Zv+y4STMABCHBkUuJuzpgqAO1jRkn8QdqnkzpQBzrwMDAhacvX7nzli2bflMLDNYcQNVg/86dO1POX3GRD4iG+KQfmT6fxpdfjivUo34II9nEHhlHKYZaQhyJdfT1Cle941Te/eaT8E6xgUGMZax1BDKaDqTBe5afPINCFLDpN7sI8j7NDsj4S0lEBFGfDiQ94mSKXe3owA5sGKEqWb3CARuIUj2B7p4LVp6+cvvGTZtqdKDmAKrD+Vefs/rirR1pnr8y2G/wST80L0yNP99AUBzep+QzPrNBJMFIQF8vfOTPTua9bzqBOInHAftf6DelwiPeKStfNptCXrnt7j3k8lLWwOIyvQBogg+asLNPxXc9mWUHcjiTlPN7npcO1JxAzQGMnfNvTfP8lUT7vYDRUqpvGDttPvWvuALNTwM3DDZCxlPhJ4IXg8niBZ2DMVe//STe86aTKTpPYEj/WxVdgGIw4hGxxN5z+smzqc8Lt9zzDIUohfJKtZCAw4QR4ZHLiLtaYXAr2EZKHQtl0YEk0YH+gQtPX778qSe3bKmVDdccQOUnf6mld2t7x/VJBQE/o4oQkvhBzLR55E+5HM01Ii6F/YqOjzOrJRKHs57ePuWqt5/Ku998As5BYE2aZqxyhbeM8P20qcg7z/KTZ1EfWTb9dg9BvcfqvmKfscczsss7JMgTHfly4s52ZGAHJsylcYly6EAJCXT3XLBy2YodG2/b9NtaYLDmACqD/atXX9ze3r4+GS76NFBVHtYVY0ky9d78Kz6E5Buwrkhio/QUywpqKtLcY19XH9ahxqSw/x0n8b43nUBSTDChPShTXkp0QJ2y/OQjyReU237TSRiVahHGqS8IqElThC5qIpj9ClzXZnRgL8aE+ArlxXp6UjpwW/vtNTpQcwDlGf955513cXtr2/p4uOhs2TJe6SlJPETYNJ9w6RVIrgnnhlATYtTtC5iNYVK3YkjlBIW9AzFX/elJvPdNJxM7T2DTjNrB6O1SSRt5xZiUDpw0m0Je2HDPTvKRZIe0GfutZE4gnUocY4IcwRHLcF1b0MGtiG0CcYDHVEAHVixf/lStlbjmAF6c83d0JKvOWXVJe1vb+ni46Msd0S2qqIRoMgDT5xOddgUSNSF+EJG0gm480X7BEOJwVunpS/jE207j3W86fgT2ywTA/hcJPe5HB5zzrDhpJvVRwIZ7d2WBQR3X/ciIP01nEZooRzD7D0j2diAD2zE2n6GN8vQERrIDmZ5ALSZQcwDPy/lXn7P64m0d7RUP6lRrcW6AXONC8qf9FRLVY5JhnIkwMk7OLwY1DmcM/b3wsbefxHsvPI64GGNCW/ZogQmlAwmsOPlI6iLPrb/tpBBlWYjxjiUf1UDkgmkEs/8At3cLOtCJMUE5I8j2dwJdXetOPfXUbbfdfnstRVhzAM+B/avPu7i9o7IpvZrBfomHCBsXYJZfgY0a8X4YtSFWk7GdhJJ2DKawX7EYugdirv6TE3nvhScTO7BWDhrsf2E6YFIHN5oORMKGe5+iEJWGhVYhMiECGmPDPPaIpbi9T8LgdrDTQBLS6IjlRdqVUjrgnA4MDF54xorltVbimgPYB/vPO2f1xa3tbevjuHzjF9VUtCMexEybj13x14RhE94NoJLm+cc8tIM05hiKIwmguz/hE3+6jHdfeByJg9DKQYX9Lw7VZYQOJN6x8qSZ1Echv7z3WfK5bHgJ4x9eggjeO0yYJzzyFRkd2Iq1hcwZlTeQNIlj7eruWbdi+bLtm1tbX/JdhPalbPx33JG29HZ0VNbYk745iyaDRE0LCJf9NUHUgPq0tl+QdLCHmKy5p7xLM26tmLQZxxr6euDKt53Ee9ctIZkCsP/F6AAY1AkrTp5BfWS47Z5OopxFMWN6H899N4hF1ePDJsI5f4Df24bv34MJ7CgNhfLoQHdPz7plS0/bdmtb20vaCbxUHUCa51+79pKt7e3XFzPjl3JOfg9Ygy+m0X5Z8SEk14h3RbwNsFmqb6yXM4bAKEaFroGYq//4RN637kScAxNMPuw/IB0QyejAkeRywob7nqKQS0eXq0pW/jz295M+eYwJ8pgjl+G7n4C+HYhpREfowIGzAy5JtL9/4MIVK5bveCm3Er8UHcA+Ga/WtvXFCsp7BcWbAIqDBM3zkZV/RRBNg3gQtVEaFBsP51VDKAkqaWPPJ/7kNN637jgSLwRTBPaXTwcSTj9pJg1RxM33PEM+b8qRAi/jF6VZWe89JsxhZ5+C29uGDGzD2Lp0krLx5Q4k9b09PeuWL1++bfNLdAzZS8oBlGS8ShN7Kob9YpF4EDttAbLirwmiOiQp4oNc1tE79qNNMYhNU19dfcI1bz2B9647jqEkxhrJynsPlTWKDpw0nYbIsvHe3eRDW4pwMm55MQyqDg0bCWa/nGRvB75vFxJY0LJIkoiIZL0DFy5bunTblva2l5wTeMk4gJaWluCOjjuStWvXXtLR2rY+KRa9GJP1uh0o4Adq0iIfaV5IsPLDhFET3iX4IEphPzIWHY9UDtMYbAb7e/tjrn7ribznwhNwXrBGsKJwUOr8qgUHUjqACLHL6EAkbPzdM+SjIBUYVTPu2SMmayAyYR3BkUvRrsfR/qfANGTZAcqiA965lA4sW/bUltbW3y5btizcuXOnrzmAw4zzr169OqvwqwT2g7cWjQcJmhcQrPxrbNgMbjCt8CuNvh6jkpcXwYpDUHr7Y678k1N577olxA4CWzr5zSH1sp9LB4o+4cwTZ9IQ5dnwu2fJ5zKVYWTcSsNpxWCJDpxKsqcNGdqKlXoymdNy6YD29vZesHzZ0u3/3//7fy+ZmMBLwQHsm9jT2lZxkQ/GQHGQsHkhsuIjBFE9PkkFPEXGF/BTISvv9ewehCvfegKXrlvCcDEhCGS0/NUhvDxGDM4JK05qoj40bLx3F7m8zYKHVGUCkVeHDxrIzX45cedWtP9ZJAjKyw3s10DUvW7Z0hXbtrS9NGICh7UDKOX516xZ866tbe3Xx3HsjZhUUfJAO8ID1sLwEGb6QuSMD2NzjfgkxgchRn02eqty7GoQvFiseFQMXYOOT110IpeuOwHvBAkyxZ3DYW7LSHYAEgcrT5pFmDNs/N0z5HLptGMtTQcaz8xDBEiQsIFg9mkkex9D+p/G2HpU4qw4uQw64L329fdduGLF8h1bWg//CUSHswMYqe3vaGu/Po6L3oiUNaU3hf0GLQ4STF+AOeMj2HA6Eg+mqb7SGJ2xqu0ZgyEGEXoHEq586yu49IIlJA6MFWyV+/mnBh1I/+l8wpknzqIujLjld7uJqpYdEBCLV4fJ5QjmLCfZuwUZ2IoxDVlVYiXZgd51y09dun3T7bce1nMHDlcHMAL7t7Zntf3pcE1TzoZVkxl/8wLM6R/F5hqw8SDeRmmjy7h63g0GJTRK5xBc/ZbjeP8blzCcOKzNZMMP06WkiEcdrDypKdUT+N0ucpEdcRDj65tgJCagUSPh3D9gqHMr9D2FseHIqLSy6ECSaHdvz7oVy5dv33TrrYctHbCHq/GPDOrMYH+WRD/QDkWtRYYHCZoXImf+NTbfiCZJOrRDxg77hVTJxxoHAl2DyiffcgLvu+B4nAdrDiPY/wKu1WDSjIaAc8LKE2cS5oVN9z5DLrKZNLoZ/wh00t4BCRsIZ59C0vkI0vcMJqhDJamIDvT29a1bsWL5js2trYdlYPCwcgAjLb2rVl2yta39+rik5FMm7Fdr0HgIO30h5owPY6LpmHgQH4SjWlzHZqBqBCFGxdLXn3DlRS/j0jcuIXapbr85jGD/i/OB9KRWIPEJZ55wBHVhyIb7dpHPWaoS98yQlvoEifLYOStJOp9E+rdhK6cD2tvTu+60U0/Z3noYlg0fTg7gOcZfzE7+Mo3fGExxiGD6AjjjY5hcAyYZwoU5ZJwTckuR6ECEPQPC1W9ZzPsvWMxQBvvtYQz7n/+FSKrsIwE+gZUnNVAfRWy6/1lyod0nClIFR6BeIaonmn0Kw51boX8sdMBpb2/vuuXLlu3YdJghgcPFAexr6R2B/VJWHk3U46xBhgcxzYuQMz9CkGtAXILaUrRfDzBT7wUKVQDFEpoEAboHlU+9ZQmXXnA83pusyOdwhv0v7HGNGIyAGMU5w8oTpxPmDBvuf5b6yKTdlGMornrey8dI5gR85yNo37NIkEclzmRGDywq4r3Xvt6+bCDp4ZMitIeL8adFPq378vzlJtFHYP+xcOaHsdGMbFBngKgfjV0rXt4IgSSoBPQOOK56y0m8742LiT2jyntfYsb/HE9QKoZKNOHM44+gEAVsvHcP+VwqKzZeCysNJPU+QfN57JzTcbsfRwa2Y6URjIMDVwuM7h24cOlpp27b0nZ4lA0f0g5gP86fRfttBY09GIsODxFMX4iceRUm34iNB3FBDrQkZjHGEd3Z7K5AoHMQrvzDY7k0i/Yb0Zce7H8xOkBKB5xTzjihiVw+ZMN9z5APg8wJjP17GOm1EIM4xefqCOeeQnHP1lRtOMihasqKCYiIJEmivT29Fy5ftnLHltYtvz3UYwKHsgPIpLvXXtLR3n59JRN7xIMzARQHsDOWIGd+DJOrhyRO+/lHWlYrw5paKk0VS2BSQ+8agk/+4RIufeMSnDcEJoX+L+2T//npgBFIvOWM45vJR4YND+ymPjSpOlKmlTDmzEA28FR8AlEjubmn4Pc8ju99OnUC4rK4Q7l0oGfdiqUrdmxsO7RjAoeqAxiZ2NPR3lpxea8YA8MD2BmL4Oy/xuSnI8kQ3qT9/DKqVr/cpp60sSdVAbKSoMbSO+i4+s3Hc+kbFlMcUfKhZvwvRAdIB6uk2YEjKUSGDfftJpfNIlTGFwvQrE4An+Bzddi5K/G7H4X+p7DSiJpk1J2UQQf6etedesorDukJRPaQNf7Vqy/uyAQ8bdnRfk1VZeIhzMyF8KorCfJNBMUBvI0w4kbUe6WirZtlEsQgCIF4uobgyjcfy/tfv4ThxGOlNKiztl6EDaRQXAJ8Rgfq8hEb73+GfGQxpdkIYwcbpWMcnMfn80RzT6W4exsysA0bFLJZhP5AO0CMMRLHsfb39l24cuUZOzZv2XxIIoFDygFkbZr7inxGAn7lGX9iDaY4SDDjWDj7Y9hcAxSL6YjujAPqmHrTwRNgxGPxdA4Zrn7TEj7w+iU4LwS2BvvLxQD7sgMQO8sZx08jH1k23L+HQiB4w7g7iEpqw+ISCBsJjzoVv+cJ6N2J2GhEx/AA31aaIvRee3u6161YsWLHodhKfCg5gHRK7zmrL+7oaBvToE6GB7EzFqewP9eMKQ7jghLnL2HFyveUGoMlAQnoHvRc+YfH8YHXLSZONFXyqRhTTOApW0IrBzglJ90VKHhRnHNZsZCw4f695KNRCZ5xdxFaVBN8rh47ZwV+z6PQ/zRWGlBTzFzAgWMCWWBw3SmnvGLb//zv/x5S2YFDxQHsk/Fqb/9auYM6IVXvxVq0OEww61j0VVdictMwySAuiLKW3rEHlrxJRSsDPN2DysffvJAPvu44YufATH60X0vUB8ErqVDHqK393Mt7lxmYTIn7FmNxznPGCU0UchEbS8VCJssOjKuLkLQ3I1FcvkBw1FLiPR1IfwdiChkaPHCKUDK14f6+/gtLw0cOFScw5R1ACwRbRZJVq9ZesrWtrSL1XkHxNkCG+7EzFqOv/Cgmqoe4BPt1lJRXhWRSQcUikmDx7B22XP2mxXzgdUvwXrDWTHpXn0I6clsM6j3WGIpJkWLiUTxO97/Up2XJsXPA5DYmlYailLIDsbeccXwjURSw4f491IWSZgc0C6yOp1hTAB9DWI+d+wf43U8gfTsxQZTNZyiTDjinvT0961asWLFj8yHSSixT3fjvKEX7O9rXx8VKYb+gxUFkxmL01R9FoyaCpIgXW06g50VNKx2ZncH+Accn3ryYD5y3mDjx2biuqQH4nSrqEoIg5PqNW/jmr54hyhvw+1uMEWEwTnjHq47mknMXESeOMAimyE7wJArqHGEQ8i83b+FvvtfKtLrMzetocjOOt6UOb/MExT6S//kCsmczxjbhzCCiZQmyqvfe53I5e/S8Yy7edNtt/1FCrzUEMAbY31GK9re3lYp8gPJaepFUutvOXIxvSWG/TQZxNpPxGitvzLr6MBAKdA94PvHmhXzgvCXEiaLGE5ipAvuVxEMYCF/d2M5nvvM4XcWYrp4iu3sTOnuL7Bl99Sfc9mAnDXWwcsksnM/ogngm86zwkJZjl+jA8dPI50NueeDZVGjUpA5Zxik5bhDEKz6XIzpqOfGuNmSgHWPqMzrgDtxFOJoOnHH6js2bp3Z2YKo6gH39/G3t65Ni0ZmKpvRGaLGPYMZi/KuvxEb12GQYTJBOth3HX6nCTYLF0Tlo+eQfLuED5y1OW3qtIZgCnB91eITEC5FN+LeN2/mbm55gWl1EZC3WWCKb1iWUrsAKUSDkAvj5A900RZ4VS5pTumAmt2FJMhVgQ1o+HXvhzOMyOvBAJw2ByeQFZZzfbTp3QXyChnWER70Cv2sz0v8UEoT4DPuVP5C0a93pK1duf3Lz5ikbGLRT1vjPWX3x1o72km5/2YL4YgQd6sPOPB5aPo5EjRgX422QDaUwY5GfpVROao0HG9E9CJ9800I+cN6xFBMlMFMD9pdm5nqXEAXCVzc9xd/etIVpdQFewGsJG8jvXU4MRjz5yHLL/XuoL9RxxnHTUC+kpRZT4/kUIfGes46bRUMAGx7qJh+l36syvs4hLQ1k1QSfbyY4agXJnkehbxeBFFATl6UrU8oO9PT0rDvtD07Z2trRfu9UjAlMNQcQiEiydtWqS9o7OtZXEu0nixgnxWGCIxbjWq6CaBriB0hMOD7Or2ljj6bIn+6+hKvftJAPnreYYgxqlcBMfsAvHUwCiVeiwPDVje18+qbHaahLR2d5lRf9vNG0nkGJCULLLx/cRXMOViyZjndp0M2Mc9R5NeiAEY8xliRxnH7CdHI5y4YHniEfWtRkGoPjfZdiIHH4XER41AqS3ZuR/rZ0ApEqJlM3kueNJWjaOCBCEic6MDhw4emnn/7ULRs3/jabTeFrDuAFTv7zVq++uL29o8JZfemgTh0eJJi1hORVHyfINWDcEGqCEVHKsWeLLFYSAjx7BuETb17CZectSmv7A8lg/2Qav4L3eITYQ856/m3jdj7z3S1Mq7MjAhymjJLmVK7bIiLUWfjpQykdWHncNOLEo6akWTi52QEhRSVFp5x1XBO5KOCXD3XSGEo2KHR8ZcMZ2wPvIKonPOpU3LOtmL4dSBBmTuL5A4+jGlFFzAgduGDlspXbN7ZumlJ0wE4l4199zuqL29vb18fFYVcu7FfAGIsOD2BnHoe+5uOYqBGTZLDf6DibyQ0iHpGQzkH49IWL+OB5iyjGJSWfqQCL0+5D5xy5QPi3Tdv59Hc301RnUVvqq081yLV0gpvnb3gwNp3f50mHkBZCy8YHO6mrK3DGkmngBGOmSLmQekSExCtnHTeT+kD52UNd1EX74Pz4p48Y0AQXTSM45jTcrofQgU4kKCC+mHmJA9OBdCBp97rTTj1la2t7+71TpYtw0h3Afi29HR3r4+KwtxVwfmsMbniQYNZx6GuvhNx0xA+nuv24/bt1KikXVdJov4AVobd/mKsvnM8HzjuOJFG8SWH/ZDJj1dGw3xEFAV+9tYPPfPcJGhvSOgc/qlx5OHZYG2ZRc35PW98YZXBYCQKLUcWLBYmJopCND+yiPoKVx6V0wImfAnRAsCgiFu8cpx8/g0LesuHBXdRFQRoxUDPqpB77GDLxCeTqCI45i+Kuxwl62nFBM6jDiD+QwtBITGCgf+DCFcuXP7Vxy9RoJZ5sV54JeK66pK294/qkWPRSQRmaSgjFXoKZi4lbPoHJNyJxCvuF8cp4WYyJMUDXgHD1hUv44Jqjcc5gpwhu8j5BxZJ4JWc9/75pG5/4fhvTcwaVNNWvYghI2DsEH3vDAt6w9EiKiRDI/rUzXiE0ws/u38Xf/SjNGKhmHRJGMerpHBI++6YFvGfVQoZiRxDYSc967HMGSuKUyHr+acN2rvlRG0fkbapErNXyuB6xOcxQJ/Gv/h7Z/TiSq8N7X26Xp6qqRmFojj12ySU/v+XmrzHJdQJ2so0/beltH5nVVzbsFwPFPsys40nOuRqTb4RkOJXxGqntr9DZm5JjEYx1gGHPoPKpdQv44Nr5DMceO2WKfFIlHecTclb46q07ufIHrcwopNkOzTIigTj2DCmfumAhV5y3mFkNAbObAo5ozHNEYzRyHdkUMasx5MwljYS5PLc8tIt8ZBFRvBoQTz6Emx/cQ319HWcubkL91KEDZHQg9spZx02nPnD8/JFu6sOMCsCosuGxggGDEhPnphMcvRy3+yG0vxMJchgfj5kOTGZMYFIcQAn2n3feeRd3tLWtL1ag5FOC/UlxkGDmYvScqyE/HZsM4U2YDuqUsU2aERW8sVmwzNAzEPOJCxbwwbWLSRLAKnYKwf7YOXJByL/dto1Pfe9xZtSFI2kytZYAz95BwzXr0mcoegXvcJpWQ6iy3+V9GlA8c8l0ClGQOYEgHWBKGkyNopCN9z9DQySsXNKMS9KmncmmA5rRASOW2CWcefxMGkLDLx9+lrpMWUixz2n8qrx3wJQkx3P1mHmnkzz7KLnuDpJoOvg404SohA6c/tTmLZsnLTtw0B3AsmXLwjvvvDOF/RUP6lSQHFrsJ5x1LMlrP4nkp2HjAXxW5KMVbsJSGbkATgxWYqx6OgeVq990ApevmYd3BhsINos+T+5Jl6Qaeh5ygfLvmzr45A/aac4HIxp6KgYrCV1DcNUb53PZ2kXE3hEagzEWa1IZ8t+7svEJ3sMZS6YRRgG3PPhsNrjD4zUtlCkEws8e7mZapKxYMo3YeTB2UkeYy0jANn2G2CtnLmmgEEb87OG91FkzgozG9fqzd4VPIKwnOGYp8a7NhD3bIMxl7+iAZclijEnrBLq7L1i5bMWOja2bJqV34GA7gH0tvaWJPZUM6hQLw73IrONIzvkEkm9A4vTkR3RMbeJ+5J+CMekgyz2DwmfeuIAPrpnHcOwx1jJlkC6Cc54oUP7ttp1c+cM2ZuQMXsCR0phAE/YMKp+4YCGXr11EXHRpY405sBS2UGq+cZy1pJkoCrnlwV1EURoQdZqWxOYDuPmhvdTX1XHmsY2oN0wdvROPiCFROHPJNOoDz88e7aYuSGs5fj8ASsVDXVUE1QQXTccesxT/7MP4gU5MEKbOoQI60NPTve60U5duve322w46HTiYDmCfdHdHW0UCnmgq4+WLg9hZi9Fzr0QL05F4GG+iLAo7tm/TZLX9YjxiAnr7Yz7xxgV8cO0iEpdqe6eVppMJ+zWD9pC4hCgI+bfbt/GJHzzJjHw4UqiEMQQoeweFa9Yt5LI1x1JMYowNsEYravMVBOcdZy2ZTi4XcsuDu4kiO1IshEAUWTY98AwNOWHl4maSBLz4zFlOJh0wmbSbIfaOM4+bSX1kuPmhZ6mLwsxFmFEub4zZARHEx5ioHr/gDPwzDxN2byUJmzFaTL+zsulA34UrVpx+0JWFDooDGJ3qa2+vbES3AN6EaHGAcNZi3LmfQvPNmGQINVGWzjZjnifnTTql16rQPei56sITuXz1PJwzBHaKwH7SIp9Elcga/u3Wdq7+UQfTcyFeJL1MgBWle0C5at18Ll+9iMSlHX1GSpPRyn8OEcEYg/PKmYunkYtCNj60m1wuyGiTxRjIhZafP9TLtBysXDyNoktRlEwqHRi1J4wlcZ4zFzdSF+X42cN7aQhMdkCbcc0iTMvKDV5d2m+S0YGopwPCfNl0oDSLsKe7e92K5cu2b25tPWgDSQ+GAxiZ0ru1vf36UY09ZR5FBon7sEccT3LupzD5Bkhi1IRZsG6MX+BIY4/HitA5KFzzhnlctvoYhmKHsTKpnPa5sN/7NMX177ft5OofdzA9Z8EIqqmMVkhC15Djk29YyBVrFhDHPn0+Y8blvtLmG8dZo5xAPkwpkSMd/V1v4ZcP7yVfX+CsRY0jsYKp8fLSWpBE4czFTTRY5eePdlMfmEzBebwDSTPn6hwu14ydtxS361F8/x5sEKDelxMcHdVA1L3u1FOXbrvt9tsOSsXgRDuAkUGdWztGxnUZkXJhv+CHB5EjjoNVV0OuCXFDqLVYXPZDdExXOqI7QUToGYy5+o3HcNmahSTOgNEpAPvJAm+pSm5kLf92+w4+9cMn01RfFu3HCgGOrmHPpy6YzwdXL6KYJCOwvxrDR1I64DlzSTO5KMiQgMWoxwlgPFFoufX+p6nLwcpjm0k8eJ18OgAGsx8dmEV9JPzy4d0UwmBELdhkvX5jvsRjfBET1aMLTkefeYigeztJNA3r03oSf2A6oM45HRwYuPCMFct3PHEQlIXsRBv/6tWrL94P9pc9qy/ADw8SHLkYd+41+FKqT3Kkg6MsSqlDuLLLYwky4+8e9Fy57kSuWDUvre3PZvVNPux3OAzO+9T4b2vnqh9vpTkf4TF4DCopfekaclz9+kVctmohifNjhv0HpgPpKRrlMicQhRgVVANElDAMuPmhXhrycPqx00icR8zkvsvRdAAxJN5x5uIm8mHIzx/ppC7MOj3HuJf2XTbVGPQeE9Yj85ZRfPZJwu42XFjAKVgpS22YOI59T0/vuuXLVm7f3DqxrcQT4gD2cf5zLtnaVmljT/qFmWIf5sjjiFd/JhvUOYy3ozX8xhrBFYykRSN7hg2fesM8Lj/3KIYTjzETC/ud13059wNcTgWvnpxVvnr7U1z1k23MzBvUyEgUW3B0DTk+8bqFXL5mHnHispLeialVEEmDkCU6cMvDuwkzue4EC8ZRFyg3P9JNfV2eMxc14rzgVQ/4vKVLJ5A+yEh2QDhrcQP1Afz80W7qQjteoeFRxWTpGLIk10ywYCl+1xPQvYsoCFHVcumAOOe0u7tr3bKlS7dtaZ+4qcQT4QBGJvZsbe+4vnTyS1l1klk/f3EQZh2Prv4EUpiWVviZIINpY4T9oql6r8ZgLN1DCZ96/dFcvmoBSVbRFlQbrqriUVRTKP+C+ffnuayBwAhfvX0H1/yojemFIJ1xR0oNjHgGHFz1ugVcvnohsfMYE2BsVqwyEQ4giwl49Zy5uJkoMPx/T+5Jewd8gheLStpAtOHhZ6kP4fRjm8t+5vRS8JCoToAzTmMWhrSB6MwlM6mL4OZHd5EP03KnNGo/PjogAsYnSNQA80+HZ+5He7anDUW+OHLIlRMTGOgfuHDFsmVPbWxtnZDegWq/4ZGW3tbWtgrz/IpKgMaDBLMWEa+6Bi00Y+MBVKKRNNhYb9iLEGgCJdh/wfF86LWzSbRk+BND5IuqBD5h2Ctf//VO+gYVa0tpKH2BjwmGhKd7HN+661lsYLGkp6gAxgg9A44LT5vJv73zJIZdkZwJD1olngLep1WR7/vvh/nufXtoKuQQn+AzrUSHYSgR/vKMmcyaVod6lw32eGGa4ZynLhfyF2fPJmcEJJiwR3KqOO+ILPzjrTu55qftzMybtBo0mxAxPrNKHb8JcjDUhd/0BYKn7yMuTAefEGS6kgfwAuqd0yjKmYWLF11884YNVdcYDKpt/Ksz46882m+RYh8y6ziG1/wNQa6AJoM4EyLqRybC6Jg2rKTowcDuIeEzr5/PZa89kmLisLZ8pbHKk3cQoRTF8uGbHuK/7uwkDDLQpf4F30y6fUKsGaKxrg7rFaf7jE+AWD31DQGqHnGgB1GxpzTnQFVprM/hJRXpSLI7jyUk9EXqQ8NX/2c3PknS5zXy4vMIREjimAe29/BPf3p8Og5sgiqM0/1gGPZw+TlzEByf/unWtKIyc7bjc5FkMYdBfN10olUfJtl4HfLME4S5XKq3KAc6P1TEGIpx0bdu3vK1NeeuYcOtG/4DrZ4TqAoFKHH+NavWvKujfXS0X8pq7BExaHEAjjge1nwKCk2oS9CSko8Zu7yTmoBAHBhD95DnmvNT2O+yyjU7EimqIuxXxWfpH4fyoRsf41u/7WLO9AINoVLIhdTnghe86nIBdXmhLohQFbzofoMxjRGGEsfSY5pY+7KZJKSS3wcz2KaqGCPc/Oge7t02QCHaJ8eVzvgLUKAQWerylrp8QH0UvugzF6KApkLEr9sH2NZV5HUnTUur7tRVX6JcUjpggViFs46dTl0IGx7pJBdmIipixtU7kMabDOIcGjXBgtOxTz+A9uzE5RoJ/DAjk4sPQAe8c9rX13thtSXHq+EAgo6OjlS9t63t+kqi/aWTX+Mh7Kxj8Ws+hSvMwMQDqA2z2v+x81lFCEnSxp7BmKvecDwfOvcYnDdYk/LZqh8vArGmYhWqCR/49ma+fc8ejmwMiZ1Po/dlBMXSVtx9abj9Ti8RhmLPafMbWXPyDDwQHOQZBKrpfWx4bC/3b+ujEJr92m73oQTKDnyqptC8KWe5u72XrZ1DvOHl09MoPlS1uKh0f5LNG3Q+4czFzeSiiJsf6aI+tFnTlYz7d5D1DkhUBwvORJ95jGBvK0nUSCq9Un52oLend91py5Zuv/XWW6uSHRivW903sadizg8YC8V+zMxFFNf+LaYwjSAZxJkonegzLhBWEouAPUPwydfN569eeyTDSYLKxNVWeE1hv4rhg9/Zwvd/8yzTG/IMO9kfHtbWC4XpSJxyRH3Ad+7dxftv3DwSPfcT8OrSfZIGUIe94fLXHsmn3zCPzsF4BM1UC3H4ZJhiYQay6mMkc05FhgYIxaBlnMOqKsYYUywWfceW1vXnrVnzlxkNCCbFAbS0tIwU+bS3tn0tjmNvJM0+l0ORRCx+uB+ZdRxu7TWYfAOJS0hMkML+kaaLyi9v0kIhjLB7SPn0+XO57Nz5ODUENpiAoJ/i1JO4BEUZBi7/9mN8+55OpjXmcd4huDE/zwtfU2DqoO5rqKrGM3kUDBQVZtQHfOu3u/jgtzfjXJJOM/LV1c6QDIVagUiUYW+5/LXz+PQb5tM9GO9TBRMZ97OJMdikH1eYia65EjlyEX64P+1nUVfODEkREUmSxLe3tn3t/LVrLxGRJLPFg0cBWlpagjvuuCMt7+1ov36kpVfKle62JMVBzBHH4s67BleYSRAP7lPykfFM7LHpoE5j6R4sctUblvBX5xyTRfulKpVxz7eNEtUUjXnPB76zmRvv6WRWQ0DsMynrKp4moynA2pNm4FUP+hiyEgW45dFOfre9n7qwSid0SbtDwCk05i13tfextXOY14/QAakqcxtNBySjA2cd20wuF/LzR/dSCE22t8b3hlNtRoP6BInqkUVnI08/iu1qI46aQBPMgaOeJTqgvT2960479ZTtt95++5h7B8biAEY4/9ZSS6+Ua/yKmABf7McccSzJ665FCo2EyRBxEEFWoDP2oEsatLGi7Bk2XHP+MfzVa7MiH5m4WXdeIcj65d9/02Z+8NtdTG8skHhFMlFSqYZA5X5BwKnhADY8tpf7tvdRiAy+is84MnyV1An8pqM3dQIvm4ExZkKyA5rJqyKWogqvXJSnEAVseGRvqolg9vUOjPV5EEGMAfUkuWbMgqUkz7Zi9m4nDKO0v6IMn1VqIOrt7V23Yvny7ZvGGBOo1AGksH/t2ks6WrNBnWUafypRFaJDfZgjTsSd/xk034AkMd7YTNd27IDWjQr47R0Wrjn/aK44Zx5O04aYQKoc7SdNzSVJghghBq64MYX9zY05nE/FIicixWgkcwDzUgegqgd9kOcIAnikk3u3D1IXTQxHl8zBNubg7o5etnUXOf/E5pFUnal2YDAbSBqgFNVw9qImChH88pFuCoFJRWeqUl4N4oporhGzaAXm6QfQ7qfRsK4ieTHvvPb29q5buXLl9ie3bKnYCZS9a1pIOf+qVasuadu85fri8HCq4VcmsjXG4IYHkCOXEJ//KZK66ZjiMCqWUcOgx1R75TEE6vES0TXo+OTrFnHFa+elFX5pv0w5L7Ti7eK8Ymxa+nn5jU/wzd91MbMxJPaa3ZcdT3vJAa+psEY47gQ9o8/edTGxzKrP8a27O/nAd9oyeXOqJ/j5PJF7AxSd47LXzONTr19I56DLUp3VeC6DWosmw7hcM27t36KzT8QO7SEJCqnG4YEfTow1Mjw87Fs3b1m/5pxz/hJIWioIDJZlFS0tLcEd3FGa1Xd9pRV+ZLr9wRGLGH7dtfj6ZoJ4AGejNCI/Hthv0t5usZ7OoueT5x/Dh1qOpOhchgsmMNovKWh8/3dbuene3cxqzDGsMip3TFUh8e9Pr5j85UuqSkzcc2om2FpUOKLBcuPvnuXSm1oxGSn3Wn13qAhWNMsOCFe8ZhZ/84aFdA/7DManlHM8+oKlTJjGRVzdDDj/kxTnLMUMdGGNzaTGtZzsgBSHi769rf1r569ae8kdFTiBcijASG1/e3vb+iSOyzd+TWE/xX44Ygnu/M8hdU0Qp/38UprImv29or9UAJvB/rSx52/WHMUVr027+qw16clfZRfgvZJoGmcoClz2ncf59r17mdGQx3nFplxn3IMqX+wvI4ahWDntmAbWnjQdp3rQh3fuFwPYMUhdaFCdyKdOC8Yc0JAz/KZjgI69RV538jQQX3UaVPp9RiAQJXaWsxY1ko8MGx7tTRWTNaV443wqrAjiYjTXhFmwEnn6QXz3TnyugPVJ6mjKiQk4p719KR3YVCYdOJADGCnv7WhrrTjPL8aQDA8gs5cQv/5vSepmYOK+rMJvn6etIOO0zxCNYCTGm4A9QzF/e95CLn/tUSQJBFaYqARZ4lINePXKZd99gm/d28WshpA4PQbxIhMOz0WEwdiPOAA/yQ7gdzsGqpcFeBHSrBmg8kBjznLn1h62dg3z+pNmpoG1KmcHnpuWcN5x1qJm8pHh5492UYjSAqXxVpWkcyclrX7N1cPCszBPP0iwdxtJ1IRqEaMHRH0j8mK9PT3rlp7yiq1bypAcNy8G+xFJjb81k+6WSmB/yvntkccy/LrP4euaieIe1NalfD/jjpXkj0t/1ksKs0WEvYPw2TVHc/lrZlOMHUYmbsaCz0Q6BHj/99q44d69HNEUEasizxEl1YNxMYXWQXjeEvdGhKJXjqwPuPGe3Vz6vdZ0j08UHdC0OciYgKLzXN4yk8+8bh7dQ0kqFS6aOv6xPte+QFna/1I/Hc67hnjOUuxAF8aEgC0rJmCtleHhYd+xddt/nL927SXIixcL2ecP+BHckcH+jtGwX8oafYLYAB3qR2afQPyGz2ewv4g3EaV2SR3rxEYsVmIQ2DMc8rk1s7k8i/aHxoycBNWF/T6D/R4nhsu+u4Ub7uukuSFP4rLmnYnk+s9NJxlhMPGcNq+e806cXARw8+Nd3LtjkLrIpBGXg/D8pZ6DRA0Necuvt/aztavI605qGjHYqmYHSqPTMmNPvOXsRQ3kQ8vNj6WjyUWy7r5xf7cWfILLN6PHLkeefhDp2omP0mKhStSGe3t61q1YsWLHltbWF1QWss/L+Ucm9rSuL6awv+yAoTEGFw/A7BPwr/8srm4mQdyfFvmIjgTGyhdelEz8Im3OiEwMNqBzUPjs2jlc/pqjiZ0nMKaUx5kA2O/SwhSUy7+7mW/e28XMhgA3UuRjKnqm8V4jdQDHTL4D+OXjXSMUoDSE9GBckL4HRWjMGe7qSJ3A60+eNvLfJ6ZYSEZmMZ69aBq5UPjl470UShqDI/GKsT2XlsRGfRHJNaGLzoanHyDcu50kakK0WI7eg4iIpnSgd93SU16xbUt7+/PGBMwLcv6t+03sKWN3lWD/IPaI40je8Hlc/XTC4S6cyY28xkq1akZGW0o6k09F6ByAz605kstbjiLOjHMiN7rNkpSXfq+db/2ui1mNAbHKyDScg1uCM7WWMNooD+LvHTXtK/HC7EbDt3+3m/d9b+vIf5+ImIQnSy0bS9E5PtRyBJ85bx69wy4buqzlBO0OsN/TACRJ2kqs5/8NxblLCQY7EROlA08PHHkwxpgSHfja+WvXXsLz9A7Y0Zy/Y+vWfdH+YiXRfo+3ITrcj5l9AsXXfx4pNEE8iJMwe21j5KwiCJZAEkQ8ncMhn109mw++5hicGqwYrKm+sJF6T9rRqyQGPvi9Vr5z7x6m1+dIvGYlm9XPQ5e7+Qdjx2nHNIxCAAe5EpAsCPh4F/fsGKAQMLFBwBe5DxFwXmjMWe7e1s+2vUXOP6kRzYp2ql0sJFKqL5G0WGhhHfnIsuGxXnKRgnpUpTpfdFJEokZ08Qrk6Yewe58iyaV1AtYbDvBr9tGB7u51K5at2LG5bf9WYjs61bfqnFWXdIyu7S93R1mDGRzAzj6BoTd+Flc3HRP3peO6xpkLVxGsiXFi0um0a+ZwWcvRFL0jMBOnP5/C/rS3/4Pf25LC/saIRPeJV0zWtR8FOGHyHcC9Owaoi0zq5iflnaR35Dw05IRfb+1nW1fMG17WvF+df9WjnpKOX3fecfbCZnKB5+bH+yhEdswaFr93GYNqgkZN6KKz0KcfINqznSSqB4oZnj6wvFiSJNrb17vulFNese22228foQM2cwLuvNWrL25v71gfF4crGNSZFfkMDuLnLmH4jZ9H6qYTxL2oze+bMzWWYAhpkY+RFGp3Dxo+t/oILms5htglWBGM2Cpvas1KTwVRRUW59PsdfOv+Lo5oDIkhPfmNTA0HcPRUcgBS9V6AsQRHnQqNefj1tn627k1448nNI3RAqhwj8pnSlMkkx89eVEchirjl8a50ipJkUuDjLQgzgvEJ5JvQRWegO58k6GzF5xowXlOh3APFBIwhiWPt7+u/8MyVp+94Ip1AZKyI6JpVq/6io709bemtyPgDGOyDuSeQvPELmEITEg+ipWg/YxdXVdIBlwbH7mIK+y97zdEp7Dem6sYP4J2SeDDG443wge+18u37O5lVyKX/XrUUkZjUa6Qb8JgGzjuheXKCgNl9/PKJLn63s1QINLnvpQTMnAqNkeHubWmx0PknNqZ3rKbqoiKSGbgRIc7oQC6yWWBQq7RnMkfg0sCgW7IC2fkw0Z4dxPk8KFgvZdOB7p7udSuWL9+6pbX1d8Z7b7r2dn9meLiIMab8jkcTYAb6kNknMnTBZ3F1zZAM4IxFs5z42PPbGew3hj3Dls+uOoLLWo6i6B1mJM46EXl+jxVFPXzwe09y4/1dzKjPUcSncK8KPeHPrX0YT/58Ki3lINU+lPleYoWZ9YZv/m43l36vY6Qqe2JiNjJyWBedcsUrj+LTq2bTOZTNbKxSzYcai3dDaDQD94bPMXTMiUR9vXgT4GxSjlWIiOjw8DB79uz5jPc+m+cqDMGB251LspxqAnSoD3/U8QxceC1amEEY9+BNrioeNj3MhJ5B4XPnzuKKVx+dwn6qH21W1VTUQtOiThXP+37Qxjfu76G5ISD2PsvxVhc66qj/fZikA8bqNrI2sH3/ZtzfaUY9E4QjGoUbHujkvd/fmlI8UfwERCs9hgAIjCV2MVe8eg6fXns0PUPZrAbRqrxfNQbcIElhGskb/pbiMX9AMNgFkitvr2dOwBgzxEhKQHUf8n6R5RCMGsxQF8mck0ku+ALUNRHEA8Q2P2pbyzhPE6VrOOCzq4/kslfNIfFCaMOJOfV9qkNnrUcNXPr9dr750B6OaCikxm8Y6QCrGn/Mpv2WjiSt0KlpVjo6UhSiTJx87ouG39O07EgpayXQ2WfPgaDe73PsVapwLP2MYRVmNhpufGAPAvzzm+ZnOUKDqeIEEpOdXGnjqaXo4a9eeQQG5dMbt1Ofj9LemGo8XRggfggpzCC+8BrMDz6N3fkgvtCYbugXPv5LL0c087kVEUcjBomH0Tkvx19wLUldExL3401ItSrgjcBQAn/z2iO47FVzKDpHYHQC97HHiAOnvO+HW/jWA13MyWfGPyFWk/2vIJfGUOQlWkFgGBG/MEFUBS3+F0hQqcElwsyGkG89sJdLf7R1pLtwolK4pdO06IUrXjmHT54zh2S4SFCt51NSMV03CLkZJBd8lmTuSRAPVbyfKnIAXgTjBogXnUHSfAzhcC9qclUrShcg9jC9YPmLM45MO7wmoMxG0VSZ12fxBFEu/dFWbryvj1n1IUOaThKq/u8NQB2aayJ46lFk52OIzWdiU4fm0uzutcL961QJggB99kn06Yew0bSsjl+r28iVZUeKDmbUww337+XSH2xLacAIHaju+/eSCtBYSWcnXLJyFo11dRS9VndHmQAZ7idpnoNfeCZSHKxY98JUZqBKjGCSIqoJLov2lwJ31bnSn1VMBBGLNUH1d60HFysJDlDe+8Ot/PeDe5hZl2r4ZTh7P4Y63mfyWMQN43PN8MzDmJ9eDYN7cSZMacAYfu7vHTkHlfNnESEZ272rCrEJkP49BD/+DDx7H5JvSqcKZzygGu/eU9IrgMQbZtYZbrx/D+/9YQfeOxyu6gVMJssOGAwihmEXjFQIVs9O0nfojUW9Q11xTKI3FVuXsE/cUKoss7WvDHJi58t7PGoV4w3v/tkWbnywm7mFOoY1maDCIkF8Ea1rxj71CMFPrybo78JF+VQ2rCQsUbbtHfzS2xd5siwCXlmxjZgsuh3lifo6cT/8JMNvupbwyJNwxQEqSUhVshKFGfWWG+/fi4jwrxcek+7pCQyhiJQqFmUixlBktQZmTEjGjPm3Vi1me5CgqmawP51Aihp490/b+c69vRxRCClqksL+Kj+SYsAnkJ+GffoJwp9cTdjXhQ8bQB1OxlwkXaWQaxUcwBjuoAS8jVN8LoLBvYQ//ATmmUcw0TQcqQy4SsbGqkSdVSBRYUa9cMP9e3nvD7alis7iJ4QOTLSlaKm5bjzBy4q9mWQiBmPU8JsMvTtVJUnA4cE7PvDDrdz4wB5m1gcUfdYipVJFfTtNPbMfxhea4ZnHCH74UexAJy6sQ/xwduromN5jqSYByNSRDj77T9HUc+lbGdeoqh01pHMDwwJB/x7Mj67BPHMvEjWTZB/wolXaU/uS6okXZtZbbnigi/f+cCvOO/wE0IER1DxBuoleKsvAjJsC7LcF0gbpKhtq9nOrT/tRk2CccMnP2vn2g93MLtQz7JNSDqeKjkcBg/oirm46wY5HiX70cWSwCw3qMJqMmgxbSulJRe9dzdSgAGoYuX81FVpFqf0VwHuSXB7bvwvzg0/h3vxFwjnHo0MDeDt6PFq1qIEQe5jZYLnxwb2IEb667uhUilyZGAqavaOq+pjSoTXGQlDDYbxK0X6XpfRE4F0/38q37+9jVn3EkDp0QrimRTVB8k2YnY8S/PjjBP17IagDTVJFo8nG7lWkAGPiIfJcNAA2UXyURwb3kv/BlcjTj+LqmpEsWIuAUVMlW0xrOxIPMxoMNzzQxft+uJ3EJQjpnqmqqcoY31M5OGwcfSAVZgGqx8cOFkpN4hT2K55Lf7yNGx7oZFZdQOIy4KpS5a8jhf3kpiFPP0b+Bx8jHOgkieoRjRmNNVRkfCW9UyIQOLbSbHme+IWKYryHKI8Z3IP9wSeJnr4XzU1Pm3l8+meqRQlHAoOJMKve8K0HunjvT3bgNE4pXBX3+ghMnwiKMY6feVgjAK+ggcN6w7t+2sE3HtrLkfl6YjdRw0EF9cP4wnTCnY+R/34K+/0I7H+pyoZU+sV5XJQnGthN8P1rkJ2PEubqUPX4CTiBjAhFpxkS2Mt7fvJUqv0oMil6DwdzjUO6RGAKjr1Q0qYe5xwiHgNc8vMOvnN/H0fURcQ+JtXupmr3qSVZMBQpTMfsfJTwBx/bB/u9wz/Pqy5p2439d1foUNSDapobf54r/akezf5cBTQUrThE+uLHYZBomiYd2EPh+1finn4MX2jGeoc3WZNNKsg2/nBtJlUXe+XIBsOND/bwnh8/hfMO8LhqHBgjKL16NlLqUNFx2ExQqXVpCboaYCoGAdXj4gS1IeI97//pNm54aC9H1EfE3u8L+JkqEjKx4IcgPxPz9KPkv/9RzEAnxVwDgY+zwaD+udGJNHJuzD59gUqDgKOKcQ70LGn1Xaqt4FWf175Ht62XC+21FIWuMLi1rxfgBUCAKOIVDQvYgT3kvv8J4rd8Gj9nKQz3EGBwxlc1eCsIw46UDjzYhRfDv79hblp2qzrm2osRnm6kqmrOCogvvXs5CA7guXBXbLr5qx24Eztm21QVNAgxqrzrZ9v55sOdHFmoJ/YlRdUJgOE+gcJM7I5HKHzvr5HBXpKoHuuSMhp9Su+xfDCWxg60wveiBNmpaV5wC6b36rxiTKVb0VYWzxBN984B5NzEO5IoT9i/C/nuNQy85QuYuSdSHOrPxICqu/8EGHbKjLqQGx7oBBH+/fVzQIJxFwspklUDVjEAaHwmJMpBcACyD/JJNv2mmgaV9mhIxfX/Cqh3eBWM8QTAxT/bznceGGR2fR2J94hRRE0VHVXm1X2C5JvRnY8Qfv/jSH83PlefDnjkxaqz0hNl9ISY8nlb9o7kwFXzziuqjsAG3N7Rxbfu7yFn7e9xaREoxp4/eUUTr13YxLCD0LosSPoiQhqjJN4r6dna12B94A9Zp8S5PGH/buq/+zEG3vJ5zNxTsEOdOJs6deNTpyhV2ISC4D3MajDc+MBejPd89Y1HYTE4BWsq30eaVUuaKiIWzdy5jEMhIxizpU7QYIoxsRn1JIkDG+K98P6fb+NbD+7lyPpUySfDzVXP84sfgNwMZOfD5L//UYKBPcRRA4GLM6PQA4RRyjWB539HWsafjJ0nH1pub9vDn/zgaXYPKTkSUjep+zmVIsrPN3fx3+vmcc7iZgYdBMYQ4nnhIVKjqEilIaSM8x0o3KCiWA8uV4cd6CT/vasoXvQ3JLOXYoa7waQtyaJVrOUQKDqY1SDc8HAX3lj+/fWzEeyY6wRGFwNV7RDKRuuNNZwXjOM3T0gMINOawmnaMVaSmTpA0BiCAKOed/98B998pIvZdfXE3qPGT4CCkKA+hrpZ2O0Pk//uh9HBHlzUQJikef6y4dRo3cTyw9ZlvXfnIR8Kt7d38yc/3EXiYU694sg9/2ltlGJR+NOfbuW/LzCsWdTEoHOjRq09vyGLjGEf+Aw5VPC5lA4UyPXuhZs+hb7l89ijXkZxuC+lLFWuiLQEFL3S3BBw44N7QODfXzcbKwGJH/2V6fPvES1pTOr+QZZqmovfF4M5aFkAQSZUkkqApshgRQhMOjzxxa7QGsR73v3LHdz4YD+z8wVi9TABxi8Z4pDCdOSpxwi/9zFkoAcTFiCJKxL30PFuiNLJq891iJoqKBnhtvYu3vaDp4gVosAQ+wD1ZA72OZeDMBASl+Mvf/AUm9p7KFhLMTF4krTr7Dm/bKzyZCUB0UqzetZ5ivmIsH83dd/9OP7pR5H8DHAOlax3oKq0VHBOmVUXcOMD3bznZ88w7ByBcdhs9Pzz70tG9m5jFGR3NAE6ltl0ZhkjtBhzEFCl+uG07PBn2Ckf3LCNQmAOWIyhKDlj2by3n00dnukNntiNtrBqhicNXoeQ/HTY+RD5736EsH83Sa4J44rZZJiDmDiW57/L2DlyoeW29r386Q+eZkiFOhPj9EDCLYJTJW+gX5W3/7CDb6ybx7mLpjHo5HnpwJghrTA2+iOK8YqL6gj6Oom+/TGKb/0bkrlLkaHuVDvTpDGBcRvXPrbLEML0RsONj+3lmYEhTpjZyLAvponIF9xnipiQuOgZ0gAjcRrwnULFBcF49p2foD70oirfeLAXX0ZyQ0mbYcJAmZaH2GcjyKq+TAr789OxOx6j/qa/wg/0kESNBElcJuz//fc4Why0koP/hfa395ALLbd2dPMnP3qaRJV84Ih9OqPBl9FDGAMFI7hinrf/eDv//UbD6mObGCzNYniB76ESmytF1MfKIMU74nyBsK8TvnMNXPR5mPsHKR1A8dVSbxsVr4mdoykXcMf2Ihs7nkY0wL+gqmN6GBhVxDimhXkQSd9/NUeW6UF2AKIyEvUVkQkpRxVgRsGW/Z40a+ONvWBVysqLV7IDRD2eBFOYhn3qMfLf/QhksN+7OCvyqSQELiPFQ6Xo8Nj0APbFEbwH5xPCIOC29r28/UfPkHghFwSp5qEoGMVqOmlJX3C0lJCo4sRhcsKwD/iLHz/Ff18I5yxsYjhRwiBGvQFr0zTcyPxGqegdpG2sY8/M2MST5COivt2Y73yMgbd+EXv0y2GwC28CBIPR6gDBdIsZ8J6m0KQyZsYjGhxwMzuJEJciyOpHo0pK1XpwHMCIdyuJG0xQLKCiId/ZN5wOYqiybLgI6h3km+GpR4m+81cEfbsYzk8jyGD/2ECw7hMbrfQ9yu8HlGLvyAUBt7V38qc/2sUwhoKNScj4pzH0x57YS+rMnveoE0Kr1IegavFAwRr6vPK2H+3g6+uUVQubGHRp6ikYqUasPCYkgBtnDCSlA5DkCtj+PRS+/TGG/+Ra4jnLMYNdqAVnFVMFD+BHKItJXaeAlJNZUhC/D5FMiLmM44eOqx14oirqxwvXtJpv1sdIvhnZ8SgN374CHegmyTURxsW0iq8Kv82P4fse/ZnEQz4w3Nq+lz/58e4U9tuEWNNUn7XC3sGEN51Qx+sWTyf2mgmt7ts5XpVQlJs3d/Odx4eYlRdiIFbN6ECOt/90B19/vWX1ogb6kgTYP6bgK3yIaqXExCckuXrCvr3ojVfDH30ePeoVFId7sSoTtk+1bEdV+WfKRkEHNwaQ1k2nYhTp2K7DVtVWPaoxJt+M7HyE/E0fRvq7kKgO9fFI7f+4nLak5bAVUwAYGXjp1ZMPhFs7unnbj0uw36QTlEhHhj096HjHiY1c//p5WTXgC7uiPzyhHrG7uPHRXqbXRYiLcQJBLmHYW/7spzv4+gVzOXfBtLTnwjisKkiAqSAEKmLQTFZOxm0YgnWOpJAj7NuNfOfjDLz177FHvwwd6gJj04IZnXoDVca9Tc2+UXpji2xNqO87VJegOChMh52PUbjxw+R6duFyDXhNSvjvoJ4iv0dLRIi9w4hhY3sXf/rj3QxiyQUOV1LXDQzPDHnecVIj//76o7BGSDwkPh2k+dyr6ITAhHzt/Jn80clNdA0OY60gPq3LyBlhSIW3/eQpbm7rwgjEGhAHlorzH1JdFKCiiPO4XJodKHz7w9id96H5mRiXji3zh2Hvq44ilAcBAWS+2qR10SPjoCZI032yjB+fnvzseIyGGy5DBnqI89MQV6x+IQeVZ1OMpEbcXGe5a2c3b/3JLrxKyvl9yswDK+wZKPKnL5vBv6+dRWl+ZPAiTVBGIU4cJsiz/ryZoEVueqxIc53Fe0cRCK0hiQPe/tMd/PjNATND8BTxJo/3vtKdVPUTOaUDdYS9XegNV2He+gWSY07FD3VjkDFla6ay8ad00OPt2Nh85ZqAWMxgJyaAJGvaETk8jF9UwReR/DRkx8PU3XgFDPRAVEB8cVziiy8UxxvLD3SqNETC/7e9j3f+ZCeJV8JAMs4PkYVdg44/PqmZ9efNIbAhxtoD+i4RIQojBCGSiK+ddwwXnVTH3oEhjA0JVEnw2DCh6C1/9rPt3L6jn0IY4Z1W+K5L76H6cXHrHC7LDoTf/hj+qQcxhYa0kAkPh5EugwEI8piB7jHJglemCOQdmmsmuu+HmP+9kbCuEVwCKs+r8HKInPcjm181gXwz9qnHKHz7r8n37sKHdXifTMhWHbPnV4gCy0PPxOweglwg2RAVsIHh2SHP205oZP35c1POn809LDuwJIITgxXD/z3vCC46eQZd/YMYawg0Lc4qBOng1sd2J+SsARmDYU3QC9WsldjlCgT9nTTc8GHkqQfQ/EysNyPDaw/1Zb3HNTYT/c83Ce/7Mb7QAN6NiQKU5b4VgwYJ+JDmn1xHn/EMn/6nSH93VhdwaNIBKcH+QjOy4zHqb7gM6e+mOAL7qxPtfyH+NtZ6ilxkM7lzlw5RsYa9A0X+9MTprD9vdurdx9jHbkhphrV5/mPNdNCYmx4fZkYhnaunKNaABGBcqRmnAqsWJqyOZN+B5fFhHUF/F3Xfuorin36B+OhTYag7mwtoDtGYVtqF6humkf/1d8j9/HOIrQO1gCv3J+iIA1Ce0xr2wuATcYKYgLgOcj+9DvWW4pkXkQz2E+IRzbyrHiIvUkC0iBamY3Y8TN2NH0L7ukfB/vKMv1QjX5axyb5iKrLxUWN5YSMBIAkIjfDMYMLbTprO+vPSk388IhZGhCgM8apYG/G1849G5Cm+80gf05oKEA+DGLzLAlC+0i997IbvvccYoyIieoCyWvEOH+UI+nchN3yM5E+uwx59Mn6wNx0Og00bkw4ZJ5CyfqmfQXjXt8j/9ItI1JhmpdSVsfUEr16dpnwxADSKwl2CLFJV9+K0IJt1rh4hQKyh/mfXogjmjD/EDXQjJszEHg6Rs98lFOtnkNv2CPXf+jBh7y7iXBOqcValVpbxq7WBqPrEex9UbHRmPCehEhrh2SzVt/682ZnxV0fw0YgQe4PRhP9ceyRIyHce6WR6Q4RLwBgdxasraITyae1BxTUQInEURWEcx0I5umiSzn73UYGgbw/13/ow/W+7Do46lWCwl9hqqklySHACTScp103H3PUt6n/yRYjqsgM3Kev9q6oXIYii8FlAjYiw/LSV75k7d06ncy4oG0PgEfEkUQMNP/tbwru+DY2z0s2QJXd9Vuqq2Yk3la50NlWCq28i2vYIDd+4DOnbTTE/LVX4Kdf4vXe5XCTHHD33MlV9yqRiEWUfJ+N9DmMsewYT3nZiE+vPm5OeeKpVHdsmpUGqNsfXVjXzhyc1snvIEFiT1YTYyt+/EVIOIRW8KsGrPnPMvGP+PIqiWNMunLJ8iHhPEtRh+/ZS982PEe64D1fXBD7tjlAjU3Kf7nepIvVNBL++gcaffBHCQmb8ZZe+O+dcMGfOnM4zV658r4hgLrroIvOP//KP953xqteumT137l7nnJVynICCMwYRxUd15H/69+Tu/BbUN1LMnIOZshFXAVeEQjN2x6PU33AFDHShUQHji5n/0gMDWK9JEAR2zpw5X/nVnXf+k1NtLDeIZ3zatTbW0KICoVF2Dyl/dGIT69fOxhqL2HCkSKhaK7AmzQ6oYIKI/1w7lz85IeTZ4YRoRBlKK3YqpbGpFWYPGjbdfvt/zT1q7luiKHKqKlJm74/RBJ/LE/TvJrrhY5in7sfU1ad1+ko2rHyqHv4J1DVjf/0d6n72BYgKaRFQmZ2Fqupcktg5c+bsPfPMV635+3/8x/suuugiYx955BFtaWkJbrjhmzsu+qOLbtnbufei3t7eemOMO1CWoAT60qpAQ/TY7cR1RyCLlhLHwwhh9ofMPrXJSb3SezHeE9dPJ9j+MPXf+hBRz7NoVI+oKz+VojgxEkyfMeN7v/7tb/6y2TU35ptzHzIihQOTXMH4hOE/WIs7YmGaSanwHVkjdA0LF51Yz3+uOZIoO4Wl3DjEGJinCHgVAjzrjq2ntTvhnmeL5CKbTaip4HsAfBBh92wjenADlJHHzjj/QH1j4/oHHnzwvuXLVj7a09vzhy5JjEgZHWCSOh4NIqL+Xuzjv6J47FL8jIXYYpHYajpkc0rs1VHvShVTmE5w17do+PEXMVEhfdfltxU77709+uijO1/7mpbVf/d//v7elpaW4Oc//7kzAHfccUfS0tIS/MM//MO9Z7/6VavmHn3UHudc+SFFFDHgonqafvIZol/fiCnMyHhJAAgeS3qumkm6BAhQ53B1TUTbH6bxmx8k6N1Nkp+GjIiGankvFG+nTW/e/L53fOAS55wsXLawolSBjtqVlT6LEUNvrJwzL89/rT6SIJudYybI+H/P83kBG/Lvq6fz6vn19BddCufLfoZ9e2Esq76+PgbMzbfcfNMxx8x/a65QUFcpHcjVE/TtpeHrHyHa/juS+ibEa0ZdS/dmJnW/Kgb1gtQ1E/z62zT++Do0l6/Y+J1zdu5RR+157Wtfs+ra6667t6WlJbjjjjsSRp/wJSfw5S9/+XevfPWr18yeM2ev994K4sqAZemUW1Fc1EDhx39P4dc3YOqnk+Cw4rHis/5vnaRLMDqM1DcTbH+I+m+mqT4f1aeju8uk7qJ4771pbGzqPHXZsvP/4kN/0QVoX1+fr8SIFE0VcY1U/CxWoOjhpJl5QhOQqMEeJKYVGEMQBqgaCkEdL5sZMeQFi0cqeAYRsKKVV1Tvc3B+2bJl4abbN33viDmz3xLlco4K6IBojMvoQP5bHyfY8QA234Q4j0UJ0Iqep9qXCBh12LpphHfeQN1Pr4Uwnzr4Mow/rWtR55yzc+bM2fvKs85c89kvfvF3o42f50L8khO47rrr7j39rDNXHzl7dmfikrKQgGhWSYdggpDCj79IcOeN5Ar1FClJQDMKih9M2C9piWjdjMz4ryDq3Q1BAfHlRU+zl6pevdY3NMgpS09719e+9rXNy5YtC6uCrSu8xAjDTpmIyYbl3HJWX0TRgRGzL6dfwfeiMj5NyXvuuScBgl/96lc/OHbRwj+2Yegy/b2ykYCPCkjfszR9/QrY+TC+bhrioGj9pMJ+UQ91zZi7vkH9T76ACUucv8wjRtV57+1RRx3VeXbLq1df9w//cO9zjZ/n4/glJ/CVr3zlnle/8jWr5x51VGdFdEAUNeDCPE0/+hvsnd/GFGaCxojarAPO7N8HP0FXqjlhwSdofRO5bQ/S8PUPEPbtIc41jYL9ZWOpRMLQzjzyiHd//etf/35LS0uQbcIqEOzKL5HJDbGOdCWKjOH+qzacJWlpaQl+sWHD9+YvWvjWqJDHeV82HTDeI2Edvn8PDf/9V+R23EdcP40gSRGAGt2ne3EwrixILPXTCO76Jg0/+kIW7a8c9h81d27na1rOXf2lL33pnuczfl4oyDeCBP7huntf2fLq1bPnzOn0ZWYHSqEYY5Qk30jdj6+jcOc30LrpJD7GeJcmgamuRPLz8WtBUDeE1jVjtj1M/hsfRAZS9V5TCexPPWoc5fPhgoUL/s+vfvWr65ctWxY+3wstE0mkP9NIRSKiz/dzqmJC4/QCYxEG9VqC/+PfAdn3EG7cuPH7R86Z/ZYon/flZgeUFGpLVEfYt4v6//sRwqfuw9dNI/E+nYalE1vXNiLzrul8C61rwv7vDdT/6POYqJBlpCuD/XPnzOk8++yzVl973bX3vpDx82JR/tF0YOmK5WuOnDNnb1IuEsjogKgQhCGFH/0d4f/egK1voCiA2v2M31f1klKVAupjkvqZ2G0P0PD1y4j6OiHIVwT7M5ecAGFTY+NPNm3a9HFVrc7Jn72DsT7rVKpdq/Q5xuv8nmfFJTqwYNHCtwYV0AHN6IDL5ZHB3TT/54ew2x9CCtMwDhKbqg17JuYqJUQVhzZMJ7zzmzT88PPYoK6ik38U7N971lmvXvNCsL8sBzDaCfzrv/7rPa9+7WtWjaYDUsbRoLg0oprL0/zDz2Dv/A6mbiZCkkoZZ4Uw1aVQPhXZ8EW0floK+//rA9i+3SRRI+JdpTp0DjHBjFkzH/ne/++f3ioixcwJVsX+Srr6Y7mmVGVFpfc+Miuvqs+RLFu2LNywYcP3FqV0QDM6UBZAEa/4XB3076Hpvz5E+NR9JCU6wESGqHw6O7J+JtH/foOmH3wBcgWc1cry/M7ZuXPndr6m5dWrvvSVL91zzQGM/4AO4LlI4JWrzk3pgPdlIIFSW5AieIq5Rhp++HcU/ue/cQ0zsFJAA4sGARqE2T/Hf3mbQ7BI/SyCrQ9R+PoHsYM9+KgR64uZfkHZAXvvvTdRIb/rpJe97C3zzzpr8KKLLrLjNf6RPvix9gOzv4qOTvLJj4xtOOVEVIzfc889cUtLS/DLjRu/P3PO7ItyhbxqiuHLKxZKEnyugBnYTcN/fphw+724xhmotVXdpyNXGGBMHt8wg7r/93Uaf/B5NJdPYzy+PMdbOvnnzp3T+crXtKwupfo+UwZFLUtFYMQJXHvtvVe8//2r77z7N7c8s3PnDGutoxxZMlUsBhOG5H/09+CV/tPOJRhyqUEaX7VabEHBhtitD9L47Y9C3x58NqizQjEI9d5rXaHOH7dk8Zu//vWvP3rRRRfZm266yVXdiCoUBFGZOEn28cYCKnWCfgKeoRQT+J9f/eoHa85d80ft7a03uji2mUmZA73bNDuQR/p30fyfH6XrbZ8lnjUfSeKqdy+Kpr+r7u6byP/kWlyuLg2sVgz753ae3dKy+rrn5Pmr4gBGO4F/+Od/vveKK65Yfdf/3rlx51NPTbfWOgF7oMJZn/UIaBRQ+Nnnqd+0HidJ2q5apSNMs2/XBRYZ7sF7QcJ6TOJw1qSplTLhrPfe5XK5YMGCeZf/8Kc//X8tLS3BTTfdlFTZ9Nk/xFxp2mCqGP5Y7kfQiX2GGAg2bNrwvTXnrvnjrVvbvz08NGSMMV448BxT4xQf1aODnTT9x6UQFTjglJoxIyiDGerDB4WKjL8U7Z8zd+7e17TsO/krCU6bSj1rqWLwtS3nrjpyzpxO77xVLYcOlGbrAGEDvtiLFAeReAiS6lySDKHJEHawHyHE2AjRBDWUZfwlXu28T4IgCGbNmvmFn99yy1daIBhrxP+FzHekGEhMOmm5okv2laxmBGCyaEA6l640J6KCZyCLB5gJdQJJS0tLsGHThu/NPmruW3L5gqpXKYcDppLjDg2yuQfFgart0+fuWYkH0DAs2/izfToS7X/V2S2rxmL8FTuA0U7g2uuuvff0M1+16sg5szudr6RsmDQNaGxaHDQBl5ZmzmtlzUipuIY6IxLMnDVr41333HtlS0tLcEclzzYGHj/W6PFUWhU/h2EMrUBjowOZYfxw/vwFfxREoc8UK8rKDqQGmSmfyMTtWbR8RYJSY89RRx3Vee6556y67h/GZvxjcgCjX+o//dOXf/fq175m9VEVZQf2Y4ETeI1pOURsY1PTbz921ZVvjuOiueOOOyYu4yZjHJD3HCwx6RxgrPch5qA8wh133JFmBzZt+N6CBYv+OMznnFeV8kMQOpX2a6m2v/Psllevfr7y3gl3AM/NDpzd8urVR86Zs1e9tzpBp+XE72NRVbWNTU19Z5/+qrddeOGFvddccw0TckiVot8iI1H0Sqvo9kXeJ1t+qZTWq+T+0wyRYA6a0uI999wTL1u2LLzl1lu+O/uYuRfl83n13gs65cDUixp/kiR27ty5e1959lmrr7vuunuvGYfxj8sBPNcJnHX62auOmDO7srLhKYRgvXM+zOWGFy5YdOE/r//nJ1paWoLPfOYzE7w5siCgHVt/wxRzoJVdk7BKKcI7br3jh0fPn3dRkMup/v6gpSlt/FlL76pSkc9nxhmbGrcCwr7swD/c+5pz1q6ae/TReyqnA5N6fuG9d3WFOrv42CWX/+inP9rUMk6vWlEUvNREPI7a8cln/6XmhPLve7JuvUQHNm7c+P0F8xe+NchFznvPBGUkq2b8LknsUUcfvedVz9PSO6kOYLQT+OIXP/u7s1559tpSsdChQAdUfWKtDWbMnPnlX2z4xb8tY+w1/pUYjWo6Gqs0VXesf02Jd1iq8Kvkvs3koYH96MC8OX+ULxTI6IBOSeN3zh511FGdZ51x+tovjpPzT4gDGO0EvvSlL92z/PSVq4+cM+dQoAOJCYJg1hFH/uh/777rw6pqf6u/TQ6q8QAerfjSKbJb0yo7zQQ+K7iUkeeYTDrwq1t/9YOjj553UZjL+exedEoZf5LYo+bO7Tz7NS2rv/SVr9xzTZXRaVVF0EpO4J//+Z/vPfc1q0ZaiVXVjYp3T/ol6c513vugrqH+kQvetO5i5xJzzTXXqByUMUcywv9H8uFjqaWfAgCgdC+V3X9JP2Byp3VmhhRsvG3j9+fPX/jHNhd53Z8OTNYeHTH+uUcd1Xn22fsq/D5TZXRqJuKlluoEXtmS9g6oqvWqXlVlKlzee+9VbUNT056zX/nK11111VV7LrroIpn4oN/vu4GRv42hk2RKHFWZOohW2i2DpBN8Jt+LJSU6cPTcuX+Uz+dVVY1X1UnYl6XLO+fs3KOP3vPKs89aPZ48/4FWMFGeNc0OXHvvZZddtubuX9/1072de+ZYY1Gd/G2rYGwQ9B+7ZPHb/uVf/qVjYsp8y8QBmladVVD+mYasdWog1dJR6Ul7/MtHDprpCEz+c5TowG133PH989es+aOOrdv+yzlXP1kawapqmhqbtpz1qldecN2XvvRI1oMyIfszmKiHuOOOO5KLLrrIfuUrX7nn7/7u707b1tZ2rHqfeJ3cCQwmy/cHhULnP/7jPz4OmIkP+j03aKYjfZKlAFpF0lglTa4pkArUUiKtdE/lfs6XVISnBtnO9oD5xYYN3/urv/qrBwd7B2dZMxn7NUCt2hOOOWbLFVdf/cxENaBNuAMAuOmmm9w111xjPvrRjz4NPD3VIoDXXHONOdiwf//wX2o0lc7Ik1HFQFOBAZTm/FUC51X2aSFMoeUB8+Uvf/kJ4Ikpsj/dxLqbCV6f+cxnvKrKH/3RH5mTTz5ZH3nkkSnxjZ988sk6ecb/fHGAMX528qOAmQeoTDdrKoqalJzANddcYyZ7n37nO9/xIjLh+zM4OHtElEO1RHjCzF5GxqaJjgXOT5UgoGHfrNlKGq/SQiivU28az5Q4GA6Scwxqxji5fkCRVKikgi/cT7VSYEmnQ/nKPpLFQGrbYDJXzQFM6tIRbbyKDHoKxQDUjK5JkMo+Z+QQmSJ9+C5TewWTcWBmIh6ldlgdq/uQSY8HyH6xgLLdXvo5ZQoVNNccQG1Nnvm8FLFP7fSvUYDa0jF09qlMPePZV2NdvvFX8pnaqjmAw9L4VUaN1yoXN0ylGEAphmGE8pNWihGDSpBFu7W2GWoO4KULhXWMCGDKmE2F48H2dbzUjv+aA6itig1ZD/Hn0FHox1M7/2sO4KVq8TJGYYzSyHOZIrXAo7sBy/yQ4tNGIJFaIGASVy0LUFu1VXMAtVVbtVWjALV10GCzIZ2oY0bUcSrMAhjBmxKfmDwI7QGMwaAVzV40xoAx42qGqq2aAzg8QgKHQx2AVBYELGUOfC0LWHMAL2njP0ifORjPUYkD8KMcQQ0B1BzAS44DqHpUBBWbVcNXagVmBAqkw20my4rM2CCJeBSTjYutQYCaA3gpBwTGlAYEsTKp0oBKpgJmDZXMeJfs76koSG0H1BzAS9z+xxIDEIG9sRspC1b1IAZVwchEG356egvQ5RySKRxWks43Wnr8mgeYzFVLA06i4ZcsVVQRpezLeagLhR9uc3zh0UEikzCsgvPg1E8oolbvSZwSSMK1j/Tyg61CfeRJKP/+yYaCpM6kBv9rCOCl7gjGMiJLlMgarnx4CCHHx04KKLqEgAA1E6e3n4gSGuXzjw1z9aOeusAQCwRqUCk/FiGaqQLXEEDNAdScQOV24BECA01G+PhDQ6h4Pn5iHbFXAgUviqipGsdWPF6FUITPPjnAJx8SGq0SmxjrKzP+9Jll9D9qq+YAXpqG74xgx9jaG2cx9ELOcuWDMUKRj51oKPoAq6AkGAnGfcaqehKvhNZz7aODfPJBoT6fZLDfoiadcVDJ73FmXzNQhYLCtVVzAIeTE5B9+nhjWD4L5DTkLR9/ZBAlz8dPDIidR8Rm8mPjcwEJEFrP5x+LufoxaMgpRUN68pt9P79cIxZAPSM6ArU1easWBDwMlkNAlcbQcOUjQ1z7xBChtXg8qorL/jkW2O9UCUX43BPDXPWoz2B/khn/2NWzZarMNqwhgNo62Ev3k/OsBpNQYkm9eSEyXP1gjEH4+PGWog+xHrxxGMqnA4oncZ7QwucfG+QTD6WwPy7B/kme7FtbNQRQW8+B1Z40v16XE658pMgXHvdEJsHjUK0sFpAohFb5wmNFrnpMqc95YhTxtcq9GgKorepZbTZTrxqYQDI6EACNQZoidJLn6uMjYueyKTwpZzcvEH5X9XiBUODaJ4pc/ZjQaCwOxWqAN0k6yag6D1/bAzUH8FK0+1Itr2T9ACYbsVWdFWsaWyvkQj7xcIxBufL4gKJLyw69cUTP89UrHuc9kYVrHx/kEw9Z6vKeompm9B7BVM9uTW0yUM0BvKSP/7Qszlf7MJQUwgeq1OXgqkdiVC1XneAy1he84AethWufiLn6cSgUHAmK8RZvdAKevFYHWHMAL1m+HiMSooHBpGX8eKrXHC+S0oFQoT4yXP3YIDF5/nguDOAJxOznczwQ4rlpxxDXPC7UB5AgGB/grasu7RcQ51Br0qvmBWoO4KW0VBUhov6nX6F/ySuQuuloMoTBVr09Ns4IRz4M+PQTRf6+VfDekIjfzwEoEKH0OaXBWGLjQNNUn1DdGQTiPD5fQLufZvqP/xkRmdSG5pfyqmUBJmF58ZCLyD/8G2b9n7+AwU4IcqiWOu2o2lUybi9KPoRhDSma1Nx01AVCUQ1hDophAj4cgejVuwT1DpfPYwZ6mfvliwke+V98Lo/UYEDNARwGJ3tZu9h6iziPm9ZIw6N3MfNLF2MGetGcYLyM9MtX9+YM3luMOAJv9gXhR19GsYkFb/EmmQDPFyNRHTLQxRFf/nNyT/waaWpGvKvkFdc8Rc0BTL01Z84ctdbmsv35optUJVUDMklC3DCD+kd/Q9M//hlB3xDkc3jj0wrZUo9AVa60F1dVceb3g2+abYdSQHIE9lflEsR7JF9ABjqZ86U/J//4Xfj6GeDcAZ3dyDtVFTESdXZ21pxAzQFMnYP/mmuuMbfffnv/ovkLPxIEAd77AzqBfadiQtzUwLSHfsOML78T378HsTlUNZueI9W9Rg0iGf3v0/8/Ab9PDKqOpJCHgR6O+PKfEz3+a1zDdMSVhzJERFWVIAx18YIFl+7atas/27s1RzDeeEztFVTRmYr4Va95zbu2bd3273EcOyNi9ADvWFTwomACbF8nAyeeRedf/ydxQwNmyKedds+J2B9Su8vHENYj/XuYc91fED3xa7R+Ovik3O2n3nst5PNm/vyFb79504ZvZsbva1tu/MvWXkH1kAAQtHZ0/HblitOf6enpfqNLnGbju+TFjCRF6B6fb6Bux2Zky2+Jl70BrasDTbCY/ceIHyKXeI9EBexAF7P//i/IPX4XvnFGxvkPDPvFiFdVcvm8mTd/3tt/uWnjN1taWoKOjg5X2241BzAVlweCza1b7l6xdNmzPX29b3BJ4kXKk75RFM3nqN/ejnnyLgZXroWoAZLkEGubFfAOzeUx/V0ccd07U87fWDnsj6JIFs5f+M5f3rrxm0DY0dGR1LZZzQFMaSfQAsGtba13n3bqKU/39fVd4JLEmzKcgFGDAkm+QO6pJ8k9cR+DK87DF/JIEYykdGDqY6EEwnoY6GTOF/+cwhN34+ubwSXlSgCp917z+bxZOH/hO2++9ZZvkNas1Iy/5gCm/urIkEBrW9tvVq48/Zmenp43OucOjAQky8irQ3NN5HY8gdlyD/HyN+Dq6nAaYzCjsgMyha7sfryHXAEzsJc5X/xz8k/chWucnsL+Mo1fVTWfz5t5C+a/bRTsrxl/zQEcgnRgy+a7l69Y8Uxvd/cbkyQ5cEwgg9CKR6MchRIdOOM8JNcIPski+WaKcX4D6tFCDtPfzRF/907yT9yFNs4oG/aXjD+KIjNv/rx33LJp0zeBmvHXHMCh7QS2tLbevfQVpz7dN9D/xnLpgGiqtZ8UCuR2PEn0+H0MnX4eWsgjscdIKga2r45vEi8R8DGaq8f27WXO5/+M/BN34xumI8kYYP+ihe/YsGnTN5YtWxbu3LmzZvw1B3DoO4HWjvbfrFi+4tme3nLpQFach4OokdyOx7Cbf0dx2etxdfV4HU57B6YA/BfvkbCA6e/kyC/+2aiA3xhh/8aN31y2bFl4zz33xLXtM7GrVgdw8FYAJGtXrX1vW9uWf03i2ImIKes7kHSMlu3to+/k5ez52H/hCjMhGUZNyYcf7DHh2e9zDs1HmIEuZl/7jtT4G5pT468Q9s9fuOBtGzZu/FYt4FdDAIcvHWjbcvfSU099uq+v/wJXZkxAVPAorlAgt+MJwsfuY/DMNWihAXFJmh046F+lSYt88nlMfzdzPv9OCo/fhTZMr8j4S7D/2EUL33FzdvLXYH/NARzWTqCtvf03y5et2NXT0/2GioqFcJBrInzqEewT91JccR6+rgHvYiz24NXFiqRR/Vwe6d/L7M+/g7rHsmh/ZXn+Edh/88aN31zGsvCenTXYX3MALwEnsLlt813Ll654pqe3+43elZ8dcCSYXAOF7a3YJ+9iaOXrINcELsYYm9EFssm7E3Q5n8L+wb3pyf/YXbjGCmG/9xrmcjJ/3oK3b7g1hf07qZ38NQfwUqIDrVvuXrZ0+c7evt4LXOLKLxYSj8vXkd/+JOHj9zFw1iooNKBJjIjixeKzqcPVvtAYCnmkr4u5n/szCo/9GtdUOvnLCWeIeu81l8uZo+Yd8/ZNt91a4/w1B/DSdQKt7a2/Wb58WSk7UDYdQB2S0YHgsfsYWnk+rq4+5eUT9bV6j+TySF8nc659B/knfj0K9pdn/M45n8vl7NELFr391ls3favG+WsOoEYHWrfcvXzpimd6errf6MtxAoCoIZEEm2uksG0zZvOvGV7xOsg3QpIgxlLVrIDzaD5E+jqZ+7kU9ldS2w+oqve5XM4uWnjs+zZs2vCfLS0twZ133lkz/poDqDmBLa2tdy89bdnT/X29byyLDkipd8Dh6hrIb32C8In7GHjlGiTXAK4IllTG24wz1+8TpBBhS7D/8RLsjyuB/T6KIrtg0cJLf7nxlq9Sq/CrOYDaei4daPvNihUrn+np7qqADqSddybfRPTUw0QPP0D/meehdQ1IHOOtHfmzFV2lz3iP5HNI317mXPtO6h4fE+zXXC5nFy0+9tJf3nLLv9Y4f80B1NbzOIEWCDa1brl72T46UFYrsajBi8NGTYQ7HiN6/NcMnv46XF0TEieoNZXXCQmpXFc+Qgb2ctTn/oz8o79Oy3t9RbX9Gexf8L5fbtz41Zrx1xxAbb3A6hgpFmq9e+mpy57u7+u9oCw9AQGjaYrQ1zWQ27qZ3GO/o/+Va5BcI+KKmYBWUN7xLwbjHVIIsb1dHPW376Tw6J34SmG/qo/CMIP9NeOvOYDaKpsOtLW3ZdmB3gp6B1I6IPkmgp2PUHjwfvrPXovmG5E4AROUnecnHxD0dzHn2tT4xxrtX7T42Et/uXFjDfbXHEBtVeoENm/ZLztQgahImiIMdj5G/pG7GTzjDWhDPbgEEYM836Evpb6dGMkH2P4e5n72HRQeubNi2J/l+e2xixa+9xcbb/kqWjP+mgOorTE5gS2tW+4+7bRTn+nt7XujT5wTMQdGAip4Enyhgfy2zQSP/Zb+V67BFhqwxSFEkrSO4DmX8TFBLkAGujj6b95B7pH/xTfNyAQ8ywgbPCfaf/OmTTXjrzmA2hqPE2iB4Pb29rtXLF+e6+3tbSnGxcRa++Lfm6RKAXiHFhqInnqUwkMPMHDGuRSPnIaPArTwnCsf4BtDzO4ejvzbd1B49Ne4phkV1faPwP6Fi96/4dZN/4pqzfin+Kq1Ax8aKzDGJOevXfvVtta29wz098dBEIQHHJKjgjeKSIjt72TwhNMZWNaCiT3+OV+9oBAaCvfcQd1jdxI3TMf4spW31Xs/Eu3/RS3gV3MAtVX178kGQZCct3bt+i1Pbr54aGAgtmU4AUHweDABZmgAGR54/hnEkg4P8vk6fK4O41xa+1/eya+5KDILFi183y83bazB/poDqK0J+q6Mtdadt3r19a2tbZcM9g/EQVgGEhj5CQY1L64qLN6Dlnfy7zP+nFl47ML3/3Ljxn95tWpwR834azGA2pqYpaq2ta3tR6efecYxfT09K4aHh+MDxgT2fRpR/6JXOdO2sgrFka6+RYuOfd/Nmzb8K0rQUTP+mgOorYPgBFpbf7R8xcpj+np6VsTFYmKMPWgDA0rR/lwuZxcsXPC+m2uw/5BdteGgh6T9q0+SxP7i5l+8a+Gxi79WqKsLEhfHInJQjD/j/HbxsYsu3bBp01dr0f6aA6itgxkMEFHAe+/tho0bLllywvHr6+rqwyRJJswJSDr8o5TqM/MXLbz0Zxs2/KvWjL9GAWprcunAlv3pQGzKjglUCPtdCvvnL1xw6YZNm2rlvTUHUFtTYXnv7ZYtW360cvmKeb39fcuLFQUGy+X8TqMosksWH3vpLzfe8q81zl+jALU1hWIC3nt788YNlxx3/HFfK9TVhUmSxGacdCBrDlLnnI+inFk0Avtrxl9zALU15WICzjn785tvvuTYJUvW1xUKpZiAJ+0rGNNVEvOYv3DBpTdv2vSvLTXYX6MAtTW16UBra+uPVixbMa9/oH/58NCQiEg6QrDMS1UFEO+9RFEki0bB/lqe/zA7PGqv4LDjAyIiYq31561Z8/ldu3a/hVTRu8LvWr0x1sxonnbdzzZs+HdqJ3/NAdTWIfe9qqqOi+ZlFMJklKC2DrP1/wdfJkAOXXEmmwAAAABJRU5ErkJggg=='; // imagen incrustada: no depende de ninguna ruta
  ARROW.tinted = {};

  /**
   * Devuelve la flecha recoloreada con `color`: solo se cambian los píxeles azules (el relleno degradado);
   * el contorno negro y el interior blanco (píxeles sin saturación) se conservan, y el sombreado
   * del azul original (más oscuro arriba, más claro abajo) se traslada al nuevo color.
   * Se calcula una sola vez por color. Si el canvas queda "tainted", devuelve la imagen original.
   */
  function tintedArrow(color) {
    if (ARROW.tinted[color]) return ARROW.tinted[color];
    const im = ARROW.img, w = im.naturalWidth, h = im.naturalHeight;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const x = cv.getContext('2d', { willReadFrequently: true });
    x.drawImage(im, 0, 0);
    try {
      const d = x.getImageData(0, 0, w, h), px = d.data;
      const tr = parseInt(color.slice(1, 3), 16), tg = parseInt(color.slice(3, 5), 16), tb = parseInt(color.slice(5, 7), 16);
      const REF = 117; // luminancia del azul medio de la flecha original
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx ? (mn === mx ? 0 : (mx - mn) / mx) : 0;
        // peso 0..1: 0 = neutro (negro/blanco/gris), 1 = azul de relleno
        const t = Math.min(1, Math.max(0, (sat - 0.12) / 0.33));
        if (t === 0) continue;
        const f = Math.min(1.25, Math.max(0.55, (0.299 * r + 0.587 * g + 0.114 * b) / REF));
        px[i]     = r + (Math.min(255, tr * f) - r) * t;
        px[i + 1] = g + (Math.min(255, tg * f) - g) * t;
        px[i + 2] = b + (Math.min(255, tb * f) - b) * t;
      }
      x.putImageData(d, 0, 0);
    } catch (e) { return im; }
    ARROW.tinted[color] = cv;
    return cv;
  }


  // ---------- Skins de imagen (ver skins.js): pug, huellas, flecha rayada... ----------
  // Cada imagen viaja como L+A: A = silueta completa (con el interior relleno) y L = 0 en el trazo negro, 255 en el relleno.
  // Nota = el relleno toma el color de la columna y el trazo se queda negro; receptor = trazo apagado (gris azulado).
  const SKC = {}; // caché por skin: { note: { color: canvas }, rec: canvas }
  /** Skin activa (distinta de la clásica) con su imagen ya cargada; si no, null y se usan las flechas de siempre. */
  function skinDef() {
    const k = window.RA && window.RA.skins, d = k && k.def(k.get());
    return d && d.ready ? d : null;
  }
  /* Misma proporción que la flecha clásica: su silueta ocupa casi todo el cuadrado de 256 px (254 x 254, 1:1).
   * Cada skin se recorta a su caja real y se ajusta a ese mismo cuadrado, así todas miden igual y quedan centradas.
   * SKIN_STRETCH = true  -> llena el cuadrado 1:1 exacto, como la clásica (deforma un poco las huellas).
   * SKIN_STRETCH = false -> mantiene la forma original y solo iguala el lado mayor. */
  const SKIN_STRETCH = true;
  function skinSource(def) {
    if (def.norm) return def.norm;
    const im = def.img, w = im.naturalWidth, h = im.naturalHeight;
    const t = document.createElement('canvas'); t.width = w; t.height = h;
    const tx = t.getContext('2d', { willReadFrequently: true });
    tx.drawImage(im, 0, 0);
    try {
      const px = tx.getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y += 1) for (let xx = 0; xx < w; xx += 1) {
        if (px[(y * w + xx) * 4 + 3] > 20) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < x0 || y1 < y0) return (def.norm = im);
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1, box = Math.round(Math.min(w, h) * 254 / 256);
      const sx = box / bw, sy = box / bh;
      const kx = SKIN_STRETCH ? sx : Math.min(sx, sy), ky = SKIN_STRETCH ? sy : kx;
      const o = document.createElement('canvas'); o.width = w; o.height = h;
      const ox = o.getContext('2d');
      ox.imageSmoothingQuality = 'high';
      ox.drawImage(t, x0, y0, bw, bh, (w - bw * kx) / 2, (h - bh * ky) / 2, bw * kx, bh * ky);
      return (def.norm = o);
    } catch (e) { return (def.norm = im); }
  }
  function skinCanvas(def, fn) {
    const im = skinSource(def), w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const x = cv.getContext('2d', { willReadFrequently: true });
    x.drawImage(im, 0, 0);
    try { const d = x.getImageData(0, 0, w, h); fn(d.data, w, h); x.putImageData(d, 0, 0); } catch (e) { return im; }
    return cv;
  }
  function skinTinted(def, color) {
    const c = SKC[def.id] || (SKC[def.id] = { note: {}, rec: null });
    if (c.note[color]) return c.note[color];
    const tr = parseInt(color.slice(1, 3), 16), tg = parseInt(color.slice(3, 5), 16), tb = parseInt(color.slice(5, 7), 16);
    return (c.note[color] = skinCanvas(def, (px, w, h) => {
      for (let y = 0; y < h; y += 1) {
        const mix = y < h * 0.3 ? 1 - y / (h * 0.3) : 0; // algo más claro arriba
        const r = tr + (255 - tr) * mix, g = tg + (255 - tg) * mix, b = tb + (255 - tb) * mix;
        for (let xx = 0; xx < w; xx += 1) {
          const i = (y * w + xx) * 4;
          if (!px[i + 3]) continue;
          const t = px[i] / 255;
          px[i] = r * t; px[i + 1] = g * t; px[i + 2] = b * t;
        }
      }
    }));
  }
  function skinRec(def) {
    const c = SKC[def.id] || (SKC[def.id] = { note: {}, rec: null });
    return c.rec || (c.rec = skinCanvas(def, (px) => {
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3]; if (!a) continue;
        const t = px[i] / 255;
        px[i] = 205; px[i + 1] = 215; px[i + 2] = 230;
        px[i + 3] = a * (0.9 * (1 - t) + 0.1 * t);
      }
    }));
  }
  /** Dibuja 4 notas de muestra (una por columna) en un canvas del menú. Devuelve false si las imágenes aún no cargaron. */
  function previewSkin(cv, id) {
    const c = cv.getContext('2d'), w = cv.width, h = cv.height;
    c.clearRect(0, 0, w, h);
    const def = id === 'classic' ? null : window.RA.skins.def(id);
    if (def ? !def.ready : !ARROW.ready) return false;
    const side = Math.min(h * 0.82, w / 4 * 0.9);
    for (let l = 0; l < LANES; l += 1) {
      c.save(); c.translate(w * (l + 0.5) / 4, h / 2);
      c.shadowColor = COLORS[l]; c.shadowBlur = 10;
      if (def) { if (def.rotate) c.rotate(ROT[l]); c.drawImage(skinTinted(def, COLORS[l]), -side / 2, -side / 2, side, side); }
      else { c.rotate(ROT[l]); c.drawImage(tintedArrow(COLORS[l]), -side / 2, -side / 2, side, side); }
      c.restore();
    }
    return true;
  }

  /**
   * Todo lo costoso se dibuja UNA vez por tamaño de pantalla:
   *  - sprites de las 4 flechas (con degradado y brillo): cada nota es un drawImage en vez de ~20 operaciones + sombra;
   *  - degradados de fondo/pista/viñeta/haces (los objetos CanvasGradient se reutilizan en cada frame);
   *  - bordes de neón (la sombra gaussiana es de lo más caro del canvas 2D).
   */
  function buildCaches(dpr) {
    const c = S.ctx, hue = S.hue, g = {};
    g.bg = c.createLinearGradient(0, 0, 0, H);
    g.bg.addColorStop(0, `hsl(${hue},55%,4%)`); g.bg.addColorStop(1, `hsl(${hue},65%,14%)`);
    g.track = c.createLinearGradient(0, 0, 0, H);
    g.track.addColorStop(0, 'rgba(3,5,16,.78)'); g.track.addColorStop(1, 'rgba(3,5,16,.62)');
    g.glow = c.createRadialGradient(W / 2, H * 0.55, 0, W / 2, H * 0.55, Math.max(W, H) * 0.6);
    g.glow.addColorStop(0, `hsla(${hue},90%,55%,.2)`); g.glow.addColorStop(1, `hsla(${hue},90%,55%,0)`);
    g.vig = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.8);
    g.vig.addColorStop(0, 'rgba(0,0,0,0)'); g.vig.addColorStop(1, 'rgba(0,0,0,.55)');
    g.drop = `hsla(${hue},100%,75%,.5)`;
    g.dpr = dpr; g.txt = new Map();                       // sprites de texto con resplandor (ver glowText)
    g.comboGlow = `hsl(${hue},100%,65%)`;
    g.lane = COLORS.map((col) => { const lg = c.createLinearGradient(0, HIT_Y, 0, H); lg.addColorStop(0, col); lg.addColorStop(1, col + '00'); return lg; });
    g.spTrack = c.createLinearGradient(0, 0, 0, H);        // pista dorada del SUPER PERFECT (solo varía el alpha)
    g.spTrack.addColorStop(0, 'rgba(255,216,74,0)'); g.spTrack.addColorStop(1, 'rgba(255,216,74,.24)');
    g.prog = c.createLinearGradient(16 * K, 0, W - 16 * K, 0);
    g.prog.addColorStop(0, `hsl(${hue},90%,55%)`); g.prog.addColorStop(1, '#fff');
    { const py = 12 * K, ph = 32 * K, pgr = c.createLinearGradient(0, py, 0, py + ph);
      pgr.addColorStop(0, 'rgba(18,22,48,.82)'); pgr.addColorStop(1, 'rgba(6,8,22,.82)'); g.pill = { y: py, h: ph, g: pgr }; }
    g.beams = S.fx.bars.map((b) => {
      const x = b.x * W, w = b.w * K, gr = c.createLinearGradient(x, 0, x + w, 0), a = Math.min(1, b.a * 1.4);
      gr.addColorStop(0, `hsla(${hue},90%,60%,0)`); gr.addColorStop(0.5, `hsla(${hue},90%,62%,${a})`); gr.addColorStop(1, `hsla(${hue},90%,60%,0)`);
      return { gr, x, w };
    });
    S.g = g;

    const s = 34 * U, size = Math.ceil((s + 22 * U) * 2);
    S.spriteSize = size;
    const newSprite = () => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = Math.ceil(size * dpr);
      const x = cv.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { cv, x };
    };
    const skin = skinDef();
    if (skin) {
      // Skin de imagen: notas = imagen con el color de su columna (girada solo si es una flecha); receptores = imagen apagada
      const side = s * 2.3;
      const skinSprite = (src, l, glow) => {
        const { cv, x } = newSprite();
        x.translate(size / 2, size / 2);
        if (skin.rotate) x.rotate(ROT[l]);
        if (glow) { x.shadowColor = glow; x.shadowBlur = 10 * U; }
        x.drawImage(src, -side / 2, -side / 2, side, side);
        return cv;
      };
      S.sprites = COLORS.map((col, l) => skinSprite(skinTinted(skin, col), l, col));
      const rec = skinRec(skin);
      S.recSprites = COLORS.map((col, l) => skinSprite(rec, l, null));
    } else if (ARROW.ready) {
      // Notas: la imagen girada según el carril (← ↓ ↑ →). Receptores: la misma imagen apagada (gris azulado).
      const side = s * 2.3;
      const imgSprite = (l, tint) => {
        const { cv, x } = newSprite();
        x.translate(size / 2, size / 2); x.rotate(ROT[l]);
        if (!tint) { x.shadowColor = COLORS[l]; x.shadowBlur = 10 * U; }
        x.drawImage(tint ? ARROW.img : tintedArrow(COLORS[l]), -side / 2, -side / 2, side, side);
        if (tint) { x.globalCompositeOperation = 'source-atop'; x.fillStyle = tint; x.fillRect(-size, -size, size * 2, size * 2); }
        return cv;
      };
      S.sprites = COLORS.map((col, l) => imgSprite(l));
      S.recSprites = S.sprites; // receptores: la misma flecha de cada carril, con sus colores (no cambian al pulsar)
    } else {
      S.sprites = COLORS.map((col, l) => {
        const { cv, x } = newSprite();
        arrow(x, size / 2, size / 2, l, s, col, { grad: true, glow: col, stroke: '#fff', lw: 3 });
        return cv;
      });
      S.recSprites = null;
    }

    const ew = Math.ceil(44 * K), ec = document.createElement('canvas');
    ec.width = Math.ceil(ew * 2 * dpr); ec.height = Math.ceil(H * dpr);
    const x = ec.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.shadowColor = `hsl(${hue},100%,65%)`; x.shadowBlur = 18 * K; x.fillStyle = `hsla(${hue},100%,78%,.9)`;
    x.fillRect(ew - 1.25, -20, 2.5, H + 40);
    S.edge = ec; S.edgeW = ew;
  }

  /** Ajusta el canvas al tamaño real de la pantalla y recalcula geometría y cachés. */
  function layout() {
    if (!S) return;
    const cv = S.canvas;
    W = Math.max(320, cv.clientWidth); H = Math.max(320, cv.clientHeight);
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (W * H))));
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    K = Math.max(0.7, Math.min(1.5, Math.min(H / 640, W / 720)));
    LW = Math.max(60, Math.min(132, H * 0.17, (W - 16) / LANES));
    U = LW / 100; FW = LW * LANES; FX = (W - FW) / 2;
    HIT_Y = Math.max(160 * K, H * 0.21);
    buildCaches(dpr);
  }
  let resizeTimer = 0;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 120); };

  /**
   * Animación de hito de combo (100, 200, 300...). Se dibuja DETRÁS de las flechas y, si hay espacio, solo en los
   * laterales de la pista (recortada), para que nunca tape las notas ni los receptores. En pantallas estrechas
   * (sin espacio lateral) va centrada pero tenue y debajo de las notas.
   */
  function drawMilestone(c, now, hue, g) {
    const ml = S.mile;
    if (!ml) return;
    const age = now - ml.at;
    if (age >= 1500) { S.mile = null; return; }
    const side = FX >= 96 * K;                       // ¿caben los efectos a los lados de la pista?
    const centers = side ? [FX / 2, W - FX / 2] : [W / 2];
    const cy = H * 0.42, room = side ? FX - 20 * K : FW * 0.8;
    c.save();
    if (side) { c.beginPath(); c.rect(0, 0, FX, H); c.rect(FX + FW, 0, FX, H); c.clip(); }
    const dim = side ? 1 : 0.4;                      // sin espacio lateral: más transparente para no estorbar
    if (age < 300) { c.fillStyle = `rgba(255,255,255,${0.1 * dim * (1 - age / 300)})`; c.fillRect(0, 0, W, H); }
    const rMax = Math.min(250 * K, side ? FX * 1.05 : 250 * K);
    const ts = age / 1000;
    for (const cx of centers) {
      c.save();
      for (let r = 0; r < 3; r += 1) { // ondas expansivas
        const a = age - r * 140;
        if (a <= 0 || a >= 900) continue;
        const p = a / 900, e = 1 - (1 - p) * (1 - p);
        c.globalAlpha = (1 - p) * 0.85 * dim; c.lineWidth = (7 * (1 - p) + 1) * K;
        c.strokeStyle = r === 1 ? '#fff' : `hsl(${hue},100%,70%)`;
        c.beginPath(); c.arc(cx, cy, (24 * K) + rMax * e, 0, Math.PI * 2); c.stroke();
      }
      c.globalCompositeOperation = 'lighter'; // chispas
      for (const q of ml.parts) {
        const d = q.sp * K * ts * (1 - 0.3 * ts) * (side ? Math.min(1, FX / (330 * K)) : 1);
        c.globalAlpha = Math.max(0, 1 - age / 1100) * dim; c.fillStyle = q.col;
        const sz = q.sz * K;
        c.fillRect(cx + Math.cos(q.a) * d - sz / 2, cy + Math.sin(q.a) * d + 110 * K * ts * ts - sz / 2, sz, sz);
      }
      c.restore();
      // rótulo "N COMBO!" con rebote, ajustado al ancho disponible
      const pp = Math.min(1, age / 320), o = pp - 1;
      const sc = 0.3 + 0.7 * (1 + 2.70158 * o * o * o + 1.70158 * o * o);
      const digits = String(ml.n).length, big = Math.min(84 * K, room / (0.62 * digits)), small = Math.min(26 * K, room / 3.9);
      c.save(); c.translate(cx, cy); c.scale(sc, sc);
      c.globalAlpha = (age < 1000 ? 1 : 1 - (age - 1000) / 500) * dim;
      glowText(c, String(ml.n), 0, 0, 900, big, true, '#ffd84a', g.comboGlow, 28 * K * (big / (84 * K)));
      label(c, 'COMBO!', 0, big * 0.43 + small * 0.4, font(900, small, true), '#ffffff');
      c.restore();
    }
    c.restore();
  }

  function draw(t) {
    const c = S.ctx, now = performance.now(), hue = S.hue, st = S.stats, g = S.g;
    const beat = t >= 0 ? 1 - ((t % S.beatMs) / S.beatMs) : 0.3;

    // Fondo
    c.fillStyle = g.bg; c.fillRect(0, 0, W, H);
    c.globalAlpha = (0.6 + 0.8 * beat * beat) / 1.4;
    for (const b of g.beams) { c.fillStyle = b.gr; c.fillRect(b.x, 0, b.w, H); }
    c.globalAlpha = (0.1 + 0.1 * beat * beat) / 0.2;
    c.fillStyle = g.glow; c.fillRect(0, 0, W, H);
    c.globalAlpha = 1;
    c.fillStyle = g.drop; c.beginPath();
    const ts = Math.max(t, 0) / 1000;
    for (const d of S.fx.drops) c.rect(d.x * W, (d.y0 * H + ts * d.sp * K) % H, 2 * K, d.len * K);
    c.fill();

    // Pista
    c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(0, 0, W, H);
    c.fillStyle = g.track; c.fillRect(FX, 0, FW, H);
    for (let l = 0; l < LANES; l += 1) {
      const age = now - S.flash[l];
      if (age < 260) {
        const k = 1 - age / 260;
        c.globalAlpha = 0.28 * k; c.fillStyle = g.lane[l]; c.fillRect(FX + l * LW, 0, LW, H); c.globalAlpha = 1;
      }
    }
    c.fillStyle = 'rgba(255,255,255,.07)';
    for (let l = 1; l < LANES; l += 1) c.fillRect(FX + l * LW - 1, 0, 2, H);
    c.drawImage(S.edge, FX - S.edgeW, 0, S.edgeW * 2, H);
    c.drawImage(S.edge, FX + FW - S.edgeW, 0, S.edgeW * 2, H);

    drawMilestone(c, now, hue, g); // detrás de receptores y notas

    // Receptores
    for (let l = 0; l < LANES; l += 1) {
      const x = FX + l * LW + LW / 2, age = now - S.flash[l];
      if (age < 200) {
        const k = 1 - age / 200;
        if (S.recSprites) {
          const d = S.spriteSize * 1.04 * (1 + 0.22 * k);
          c.globalAlpha = 0.65 + 0.35 * k; c.drawImage(S.sprites[l], x - d / 2, HIT_Y - d / 2, d, d);
        } else arrow(c, x, HIT_Y, l, 36 * U * (1 + 0.22 * k), COLORS[l], { alpha: 0.5 + 0.5 * k, glow: COLORS[l], stroke: '#fff', lw: 4 });
        c.globalAlpha = k; c.lineWidth = 3 * U; c.strokeStyle = COLORS[l];
        c.beginPath(); c.arc(x, HIT_Y, (38 + (1 - k) * 34) * U, 0, Math.PI * 2); c.stroke(); c.globalAlpha = 1;
      } else {
        if (S.recSprites) {
          const d = S.spriteSize * 1.04 * (1 + 0.05 * beat * beat);
          c.globalAlpha = 0.62; c.drawImage(S.recSprites[l], x - d / 2, HIT_Y - d / 2, d, d); c.globalAlpha = 1;
        } else arrow(c, x, HIT_Y, l, 36 * U * (1 + 0.05 * beat * beat), 'rgba(255,255,255,.1)', { stroke: 'rgba(205,215,230,.85)', lw: 3 });
      }
    }

    // Notas: posición = HIT_Y + (tiempoNota - tiempoActual) * píxelesPorMs. Solo se recorren las visibles.
    const ppm = (H - HIT_Y + 40 * U) / S.approach, ss = S.spriteSize, half = ss / 2;
    for (let l = 0; l < LANES; l += 1) {
      const q = S.lanes[l], x = FX + l * LW + LW / 2 - half, sp = S.sprites[l];
      for (let i = S.heads[l]; i < q.length; i += 1) {
        const dy = q[i] - t;
        if (dy > S.approach) break; // las notas están ordenadas: el resto queda fuera de pantalla
        c.drawImage(sp, x, HIT_Y + dy * ppm - half, ss, ss);
      }
    }

    // HUD superior
    const dl = DIFF[S.diff] || DIFF.normal;
    const m = 12 * K, ph = 32 * K, gap = 8 * K;
    const wD = 112 * K, wS = 58 * K, wB = 104 * K;
    pill(c, m, m, wD, ph, `${dl[0]} ${dl[1]}`, hue);
    pill(c, W - m - wS, m, wS, ph, `x${S.speed}`, hue);
    pill(c, W - m - wS - gap - wB, m, wB, ph, `${S.bpm} BPM`, hue);
    const nx = m + wD + gap, nw = W - m - wS - gap - wB - gap - nx;
    if (nw > 60) pill(c, nx, m, nw, ph, S.name, hue);
    label(c, String(st.score).padStart(7, '0'), W / 2, m + ph + 46 * K, font(900, 34 * K, true), '#ffd84a');

    // Juicio
    const jage = now - S.textAt;
    if (S.text && jage < 700) {
      const [txt, col] = JUDGE[S.text];
      c.save(); c.translate(W / 2, H * 0.5);
      const sc = 1 + 0.35 * Math.max(0, 1 - jage / 90); c.scale(sc, sc);
      c.globalAlpha = jage < 450 ? 1 : 1 - (jage - 450) / 250;
      glowText(c, txt, 0, 0, 900, 48 * K, true, col, col, 26 * K);
      c.restore();
    }
    // Combo
    if (st.combo >= 2) {
      c.save(); c.translate(W / 2, H * 0.64);
      const sc = 1 + 0.25 * Math.max(0, 1 - (now - S.comboAt) / 120); c.scale(sc, sc);
      glowText(c, String(st.combo), 0, 0, 900, 78 * K, true, '#fff', g.comboGlow, 24 * K);
      label(c, 'COMBO', 0, 32 * K, font(700, 20 * K), '#bfe8ff');
      c.restore();
    }
    // HUD inferior
    const left = Math.max(0, S.duration - Math.max(0, t)) / 1000, mm = Math.floor(left / 60), ss2 = String(Math.floor(left % 60)).padStart(2, '0');
    const acc = ((st.perfect + st.great * 0.85 + st.good * 0.5) / Math.max(1, S.judged)) * 100;
    const bx = 16 * K, bh = 6 * K, by = H - 22 * K;
    label(c, `${mm}:${ss2}`, bx, by - 14 * K, font(800, 22 * K), '#ffd84a', 'left');
    label(c, `${acc.toFixed(1)}%`, W - bx, by - 14 * K, font(800, 22 * K), '#fff', 'right');
    c.fillStyle = 'rgba(255,255,255,.14)'; rr(c, bx, by, W - 2 * bx, bh, bh / 2); c.fill();
    const pw = (W - 2 * bx) * Math.min(1, Math.max(0, t / S.duration));
    if (pw > 1) {
      c.fillStyle = g.prog; rr(c, bx, by, pw, bh, bh / 2); c.fill();
    }

    drawModeHud(c, now, t);

    // Viñeta
    c.fillStyle = g.vig; c.fillRect(0, 0, W, H);
    drawModeOverlays(c, now);
    if (S.endAt) { // fundido a negro al terminar la canción
      const k = Math.min(1, (now - S.endAt) / END_FADE_MS);
      c.fillStyle = `rgba(5,6,15,${k * k * (3 - 2 * k)})`; c.fillRect(0, 0, W, H);
    }
  }

  /** Barra del modo (vida o SUPER PERFECT), encima del tiempo/precisión. Animada y con brillo propio. */
  function drawModeHud(c, now, t) {
    const s = S;
    if (s.mode === 'normal') return;
    const beat = t >= 0 ? 1 - ((t % s.beatMs) / s.beatMs) : 0.3, pulse = 0.5 + 0.5 * Math.sin(now / 130);
    // Escritorio: arriba a la izquierda, bajo la píldora de dificultad (el ancho evita el marcador central).
    // Móvil/tablet: abajo al centro, justo encima de la barra de progreso de la canción y su tiempo.
    const m = 12 * K, ph = 32 * K;
    const mobile = TOUCH || W <= 820;
    const bh = (mobile ? 32 : 22) * K, r = bh / 2; // en móvil: más gruesa (más profundidad)
    const bw = mobile ? Math.min(460 * K, W * 0.78) : Math.max(120 * K, Math.min(240 * K, W / 2 - 90 * K - m));
    const bx = mobile ? (W - bw) / 2 : m;
    const by = mobile ? H - 94 * K : m + ph + 10 * K;
    s.barRect = { x: bx - 6 * K, y: by - 8 * K, w: bw + 12 * K, h: bh + 16 * K };
    let pct = 0, txt = '', stops, glow, glowAmt, edge = 'rgba(255,255,255,.6)', hot = false;
    const sp = s.mode === 'super'; // la barra del SUPER PERFECT lleva más brillo que la de vida

    if (s.mode === 'survival') {
      pct = s.life / 100; txt = 'VIDA';
      const h0 = Math.round(pct * 120);
      stops = [`hsl(${h0},90%,42%)`, `hsl(${h0},100%,62%)`, `hsl(${h0},100%,78%)`];
      glow = `hsl(${h0},100%,60%)`; glowAmt = 10 + 8 * beat * beat;
      if (pct <= 0.25 && !s.done) { glow = '#ff2d4d'; glowAmt = 16 + 18 * pulse; edge = `rgba(255,90,110,${0.6 + 0.4 * pulse})`; }
    } else if (s.spActive) {
      pct = Math.max(0, (s.spUntil - now) / SUPER_MS); hot = true;
      txt = `SUPER ${(pct * SUPER_MS / 1000).toFixed(1)}s`;
      const h0 = (now / 5) % 360; // arcoíris que gira
      stops = [`hsl(${h0},100%,60%)`, `hsl(${(h0 + 70) % 360},100%,68%)`, `hsl(${(h0 + 140) % 360},100%,78%)`];
      glow = `hsl(${(h0 + 40) % 360},100%,68%)`; glowAmt = 18 + 10 * pulse; edge = '#fff';
    } else if (s.spReady) {
      pct = 1; hot = true; txt = TOUCH ? '¡TOCA AQUÍ!' : '¡ESPACIO!';
      stops = ['#ff9d1a', '#ffd23a', '#fff08a'];
      glow = '#ffd23a'; glowAmt = 18 + 14 * pulse; edge = '#fff';
    } else {
      pct = s.charge / 100; txt = `SUPER ${Math.floor(s.charge)}%`;
      const h0 = 255 - pct * 70; // violeta -> cian a medida que carga
      stops = [`hsl(${h0},100%,58%)`, `hsl(${h0 - 25},100%,70%)`, `hsl(${h0 - 40},100%,82%)`];
      glow = `hsl(${h0 - 20},100%,66%)`; glowAmt = 14 + 14 * pct + 6 * beat * beat;
      if (now - s.spDeniedAt < 300) { edge = '#ff5a6a'; glow = '#ff3b55'; glowAmt = 24; }
    }

    c.save();
    if (hot) { // la barra "late" cuando está lista o activa
      const k = 1 + (s.spActive ? 0.02 + 0.015 * beat : 0.035 * pulse);
      c.translate(bx + bw / 2, by + bh / 2); c.scale(k, k * 1.08); c.translate(-(bx + bw / 2), -(by + bh / 2));
    }
    // fondo con halo de luz
    // (capas translúcidas: mucho más barato que shadowBlur, que se repetía varias veces por frame)
    c.save(); c.fillStyle = glow;
    if (sp) c.globalCompositeOperation = 'lighter'; // luz aditiva: brilla de verdad sobre el fondo oscuro
    for (let i = sp ? 4 : 3; i >= 1; i -= 1) { const e = glowAmt * K * i / 5; c.globalAlpha = sp ? 0.16 : 0.1; rr(c, bx - e, by - e, bw + 2 * e, bh + 2 * e, r + e); c.fill(); }
    c.restore();
    rr(c, bx, by, bw, bh, r); c.fillStyle = sp ? 'rgba(10,12,34,.8)' : 'rgba(8,10,28,.88)'; c.fill();

    const fw = bw * pct;
    if (fw > 1) {
      c.save();
      rr(c, bx, by, bw, bh, r); c.clip();
      const gr = c.createLinearGradient(bx, by, bx, by + bh); // degradado vertical: cuerpo con volumen
      gr.addColorStop(0, stops[2]); gr.addColorStop(0.45, stops[1]); gr.addColorStop(1, stops[0]);
      c.fillStyle = gr; c.fillRect(bx, by, fw, bh);
      if (s.spActive) { // color horizontal encima para el arcoíris
        const gh = c.createLinearGradient(bx, 0, bx + bw, 0);
        gh.addColorStop(0, stops[0]); gh.addColorStop(0.5, stops[1]); gh.addColorStop(1, stops[2]);
        c.globalAlpha = 0.55; c.fillStyle = gh; c.fillRect(bx, by, fw, bh); c.globalAlpha = 1;
      }
      // franjas diagonales en movimiento (más rápidas cuando está activo)
      c.globalAlpha = sp ? (s.spActive ? 0.22 : 0.1) : (s.spActive ? 0.34 : 0.14); c.strokeStyle = '#fff'; c.lineWidth = 6 * K; c.beginPath();
      const step = bh * 1.1, off = (now / (s.spActive ? 14 : 38)) % step;
      for (let x = bx - bh + off; x < bx + fw + bh; x += step) { c.moveTo(x, by + bh); c.lineTo(x + bh, by); }
      c.stroke(); c.globalAlpha = 1;
      // brillo que barre la barra de lado a lado
      const sw = bw * 0.22, sx = bx + (((now / (s.spActive ? 600 : 1300)) % 1.5) - 0.25) * bw;
      const sh = c.createLinearGradient(sx - sw, 0, sx + sw, 0);
      sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.5, 'rgba(255,255,255,.75)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
      const x0 = Math.max(sx - sw, bx), x1 = Math.min(sx + sw, bx + fw);
      if (x1 > x0) { c.fillStyle = sh; c.fillRect(x0, by, x1 - x0, bh); }
      // chispas flotando dentro del relleno
      c.fillStyle = '#fff'; c.globalAlpha = 0.45 + 0.5 * Math.abs(Math.sin(now / 150)); c.beginPath(); // todas en un solo trazo
      for (let i = 0; i < 7; i += 1) {
        const px = bx + ((now * (0.00016 + i * 0.00004) + i * 0.173) % 1) * fw, rad = (1.1 + (i % 3) * 0.5) * K;
        const py = by + bh * (0.5 + 0.32 * Math.sin(now / 190 + i * 2.1));
        c.moveTo(px + rad, py); c.arc(px, py, rad, 0, 6.2832);
      }
      c.fill(); c.globalAlpha = 1;
      if (sp) {
        // relieve de "tubo de neón": línea de luz fina arriba y sombra de color abajo (sin blanquear el relleno)
        c.fillStyle = 'rgba(255,255,255,.7)'; c.fillRect(bx, by + bh * 0.10, fw, Math.max(1.5, bh * 0.14));
        const dk = c.createLinearGradient(0, by + bh * 0.55, 0, by + bh);
        dk.addColorStop(0, 'rgba(0,0,0,0)'); dk.addColorStop(1, 'rgba(0,0,0,.2)');
        c.fillStyle = dk; c.fillRect(bx, by + bh * 0.55, fw, bh * 0.45);
        c.globalCompositeOperation = 'lighter';           // un toque aditivo del propio color: más viveza, no más blanco
        c.globalAlpha = 0.3 + 0.12 * pulse; c.fillStyle = stops[1]; c.fillRect(bx, by, fw, bh);
        c.globalAlpha = 1;
      } else { c.fillStyle = 'rgba(255,255,255,.3)'; c.fillRect(bx, by, fw, bh * 0.4); }
      c.restore();
      // destello en la punta del relleno
      if (pct < 0.999) {
        const tx = bx + fw, tr = bh * (1.1 + 0.4 * pulse);
        c.save(); c.globalCompositeOperation = 'lighter';
        const tg = c.createRadialGradient(tx, by + bh / 2, 0, tx, by + bh / 2, tr);
        tg.addColorStop(0, 'rgba(255,255,255,.9)'); tg.addColorStop(0.35, stops[2]); tg.addColorStop(1, 'rgba(255,255,255,0)');
        c.globalAlpha = 0.65; c.fillStyle = tg; c.fillRect(tx - tr, by - tr, tr * 2, tr * 2 + bh); c.restore();
      }
    }
    c.save();
    rr(c, bx, by, bw, bh, r); c.globalAlpha = sp ? 0.65 : 0.35; c.lineWidth = (sp ? 8 : 6) * K; c.strokeStyle = glow; c.stroke();
    c.globalAlpha = 1; c.lineWidth = 2.5 * K; c.strokeStyle = sp && edge === 'rgba(255,255,255,.6)' ? 'rgba(255,255,255,.95)' : edge; c.stroke();
    c.restore();
    c.save();
    const fs = (mobile ? 15 : 12) * K;
    c.font = font(900, fs); c.textAlign = 'center'; c.lineJoin = 'round';
    const tx0 = bx + bw / 2, ty0 = by + bh / 2 + fs * 0.38;
    c.lineWidth = 3.5 * K; c.strokeStyle = 'rgba(0,0,0,.75)'; c.strokeText(txt, tx0, ty0, bw - 10 * K);
    if (sp) { c.shadowColor = glow; c.shadowBlur = 8 * K; }
    c.fillStyle = '#fff'; c.fillText(txt, tx0, ty0, bw - 10 * K);
    c.restore();
    c.restore();

    if (s.spActive) {
      c.save();
      // la pista se ilumina y los bordes laten mientras dura
      c.globalAlpha = (0.16 + 0.08 * pulse) / 0.24; c.fillStyle = s.g.spTrack; c.fillRect(FX, 0, FW, H);
      c.globalAlpha = 0.5 + 0.4 * pulse; c.fillStyle = glow;
      c.fillRect(FX - 2 * K, 0, 3 * K, H); c.fillRect(FX + FW - K, 0, 3 * K, H);
      c.restore();
      const age = now - s.spStart;
      if (age < 420) { c.fillStyle = `rgba(255,255,255,${0.4 * (1 - age / 420)})`; c.fillRect(0, 0, W, H); } // flash al activar
      if (age < 1100) { // cartel de activación
        const k = Math.min(1, age / 140), fade = age < 800 ? 1 : 1 - (age - 800) / 300;
        c.save(); c.globalAlpha = fade; c.translate(W / 2, H * 0.4); c.scale(0.6 + 0.5 * k, 0.6 + 0.5 * k);
        glowText(c, 'SUPER PERFECT!', 0, 0, 900, 44 * K, true, '#fff', '#ffd84a', 30 * K);
        c.restore();
      }
    }
    if (t < 0) {
      label(c, s.mode === 'survival' ? 'Sobrevive: no falles las flechas' : (TOUCH ? 'Toca la barra para activar el SUPER PERFECT' : 'ESPACIO activa el SUPER PERFECT'), W / 2, H * 0.74, font(800, 16 * K), '#bfe8ff');
    }
  }

  /** Efectos de pantalla completa: golpe rojo al fallar (supervivencia) y pantalla de eliminación. */
  function drawModeOverlays(c, now) {
    const s = S;
    if (s.mode !== 'survival') return;
    const age = now - s.hurtAt;
    if (age < 320 && !s.dead) { c.fillStyle = `rgba(255,30,60,${0.22 * (1 - age / 320)})`; c.fillRect(0, 0, W, H); }
    if (s.dead) {
      const a = Math.min(1, (now - s.deadAt) / 500);
      c.fillStyle = `rgba(0,0,0,${0.68 * a})`; c.fillRect(0, 0, W, H);
      c.save(); c.globalAlpha = a; c.shadowColor = '#ff3b55'; c.shadowBlur = 30 * K;
      label(c, 'ELIMINADO', W / 2, H * 0.48, font(900, 64 * K, true), '#ff5a6a');
      c.shadowBlur = 0;
      label(c, 'Te quedaste sin vida', W / 2, H * 0.48 + 36 * K, font(700, 20 * K), '#ffd0d6');
      c.restore();
    }
  }

  /** Fin de la canción: la pantalla se oscurece (y la música se apaga) y, ya en negro, se muestran los resultados. */
  function beginEnding(s) {
    s.done = true; s.endAt = performance.now();
    stopSuperSfx(s, true); // si la canción termina con el SUPER PERFECT activo, se cortan sus sonidos
    if (s.onStats) s.onStats({ ...s.stats });
    if (s.music && actx) { try { s.music.out.gain.setTargetAtTime(0, actx.currentTime, 0.45); } catch (e) { /* ok */ } }
    document.body.classList.add('ending'); // oculta marcador y botones sobre el canvas
    setTimeout(() => { if (S === s) s.onFinish({ ...s.stats }); }, END_FADE_MS + END_HOLD_MS);
  }

  function loop() {
    const s = S;
    if (!s) return;
    const t = s.now();
    if (s.spActive) {
      const np = performance.now();
      if (np >= s.spUntil) endSuper();
      else { // SUPER PERFECT: toda nota que llega a la línea cuenta como perfecta
        for (let l = 0; l < LANES; l += 1) {
          const q = s.lanes[l];
          while (s.heads[l] < q.length && q[s.heads[l]] <= t) { s.flash[l] = np; s.heads[l] += 1; judge('perfect'); }
        }
      }
    }
    if (!s.dead) {
      for (let l = 0; l < LANES; l += 1) {
        const q = s.lanes[l];
        while (!s.dead && s.heads[l] < q.length && q[s.heads[l]] + WIN.good < t) { judge('miss'); s.heads[l] += 1; }
      }
    }
    draw(t);
    if (!s.done && s.judged >= s.total) beginEnding(s);
    s.raf = requestAnimationFrame(loop);
  }

  /** Fija el instante t=0 de la canción en el reloj del AudioContext y arranca la música. */
  function begin(s, audioIn) {
    if (S !== s || s.began || !actx) return;
    s.began = true;
    s.ctxStart = actx.currentTime + (s.startAt - window.RA.net.now()) / 1000; // startAt viene del reloj del servidor
    startMusic(s, audioIn);
  }

  /**
   * start({ settings, startAt, onStats, onFinish, speed, volume, meta, chart, audio, offsetMs, mode, carry })
   *  - carry:  { combo, maxCombo } heredado de la canción anterior (partidas de varias canciones). El combo NO se
   *            reinicia entre canciones: solo un fallo lo corta. `maxCombo` pasa a ser la mejor racha de toda la partida.
   *  - chart:  { lanes: Float64Array[4], total } (de songs.js). Si falta, se genera con makeChart (canciones integradas).
   *  - audio:  AudioBuffer o Promise<AudioBuffer|null>. Si falta, suena la música generada.
   *  - meta:   { name, bpm, hue, style } de la canción.
   *  - offsetMs: calibración global. Positivo = las flechas llegan antes que el audio; negativo = después.
   */
  function start({ settings, startAt, onStats, onFinish, speed = 2, volume = 0.7, meta = null, chart = null, audio: audioIn = null, offsetMs = 0, mode = null, carry = null }) {
    stop();
    document.body.classList.remove('ending');
    const gameMode = resolveMode(mode);
    window.RA.lastResult = { mode: gameMode, died: false };
    const carryCombo = carry && Number.isFinite(carry.combo) ? Math.max(0, Math.floor(carry.combo)) : 0;
    const carryMax = carry && Number.isFinite(carry.maxCombo) ? Math.max(carryCombo, Math.floor(carry.maxCombo)) : carryCombo;
    const canvas = document.getElementById('stage');
    const ch = chart || toChart(makeChart(settings.songId, settings.durationMs, settings.totalNotes));
    const song = meta || SONGS.find((x) => x.songId === settings.songId);
    const bpm = song && song.bpm ? song.bpm : 120;
    S = {
      ctx: canvas.getContext('2d', { alpha: false }), canvas, startAt, onFinish, lanes: ch.lanes, heads: [0, 0, 0, 0],
      total: ch.total, judged: 0, done: false, dirty: false, flash: [0, 0, 0, 0],
      text: '', textAt: 0, raf: 0, timer: 0,
      beatMs: 60000 / bpm,
      name: song ? song.name : settings.songId, hue: song && song.hue !== undefined ? song.hue : seedFrom(settings.songId) % 360,
      duration: settings.durationMs, diff: settings.difficulty, comboAt: 0, fx: makeFx(settings.songId),
      bpm, speed,
      // Velocidad tipo DDR: a x1 se ven 8 compases; a xN, 8/N compases (mín. 400 ms)
      approach: Math.max(400, ((60000 / bpm) * 8) / speed),
      stats: { score: 0, combo: carryCombo, maxCombo: carryMax, perfect: 0, great: 0, good: 0, miss: 0 },
      endAt: 0, stepMs: 15000 / bpm, volume, style: (song && song.style) || DEFAULT_STYLE, melody: makeMelody(settings.songId),
      offsetMs, lastMs: -1e9, began: false, ctxStart: 0, music: null,
      // modos de juego
      mode: gameMode, onStats, life: 100, hurtAt: -1e9, dead: false, deadAt: 0,
      // aciertos Fantastic necesarios para llenar la barra: 22% de las notas, entre 60 y 110 (cargar es lento a propósito)
      spNeed: Math.max(60, Math.min(110, Math.round(ch.total * 0.22))),
      charge: 0, spReady: false, spReadyAt: 0, spActive: false, spStart: 0, spUntil: 0, spDeniedAt: -1e9, barRect: null,
    };
    const s = S;
    /** Reloj maestro (ms de canción). Con audio activo = posición audible; antes de eso, reloj de red. Nunca retrocede. */
    s.now = () => {
      let ms = s.began && actx ? (audioNowSec(actx) - s.ctxStart) * 1000 : window.RA.net.now() - s.startAt;
      if (ms < s.lastMs) ms = s.lastMs; else s.lastMs = ms;
      return ms + s.offsetMs;
    };
    layout();
    s.timer = setInterval(() => {
      if (s.dirty && !s.done) { s.dirty = false; onStats({ ...s.stats }); }
    }, 250);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onResize);
    canvas.addEventListener('pointerdown', onPointer);
    canvas.addEventListener('touchstart', onTouch, { passive: false });
    canvas.addEventListener('touchmove', onTouchBlock, { passive: false });
    canvas.addEventListener('touchend', onTouchBlock, { passive: false });
    const solo = modeSrc.v === 'solo';
    /* Sin cuenta atrás: suena VOICE_0003 y la canción empieza cuando termina.
     *  - Un jugador: startAt se calcula aquí según la duración de la voz.
     *  - Online: startAt lo manda el servidor (sincroniza a todos), así que la voz se programa para que TERMINE en startAt
     *    (si el servidor da menos tiempo que la duración de la voz, empieza ya y termina un poco después). */
    const kick = () => {
      introMs().then((ms) => {
        if (S !== s) return;
        if (solo) { s.startAt = window.RA.net.now() + (ms ? ms + 250 : 600); s.lastMs = -1e9; }
        begin(s, audioIn);
        if (ms) setTimeout(() => playVoice(s, 'start'), Math.max(0, s.startAt - window.RA.net.now() - ms));
      });
    };
    const a = audio();
    if (a) { if (a.state === 'running') kick(); else a.resume().then(kick).catch(() => {}); }
    s.raf = requestAnimationFrame(loop);
  }

  /**
   * Modo de la partida. Si main.js no lo pasa en start({ mode }), se toma del selector del menú de origen:
   * un jugador -> #solo-mode, sala privada y clasificatoria -> #lobby-mode (por jugador, como la velocidad).
   */
  const modeSrc = { v: null };
  function resolveMode(m) {
    let v = m;
    if (!v) {
      const sel = (id) => { const el = document.getElementById(id); return el ? el.value : 'normal'; };
      v = modeSrc.v === 'solo' ? sel('solo-mode') : modeSrc.v === 'lobby' || modeSrc.v === 'ranked' ? sel('lobby-mode') : 'normal';
    }
    return MODES.includes(v) ? v : 'normal';
  }
  function initModeUI() {
    const $ = (id) => document.getElementById(id);
    const on = (id, ev, fn, cap) => { const el = $(id); if (el) el.addEventListener(ev, fn, cap); };
    on('btn-solo', 'click', () => { modeSrc.v = 'solo'; }, true);
    on('btn-quick', 'click', () => { modeSrc.v = 'ranked'; }, true);
    for (const id of ['btn-create', 'btn-join', 'room-list']) on(id, 'click', () => { modeSrc.v = 'lobby'; }, true);
    on('join-code', 'keydown', (e) => { if (e.key === 'Enter') modeSrc.v = 'lobby'; }, true);
    for (const [selId, descId] of [['solo-mode', 'solo-mode-desc'], ['lobby-mode', 'lobby-mode-desc']]) {
      const sel = $(selId), d = $(descId);
      if (!sel) continue;
      const upd = () => { if (d) d.textContent = MODE_DESC[sel.value] || ''; };
      sel.addEventListener('change', upd); upd();
    }
  }
  initModeUI();

  function stop() {
    if (!S) return;
    cancelAnimationFrame(S.raf);
    clearInterval(S.timer); clearTimeout(resizeTimer);
    stopMusic(S);
    if (S.voices) for (const v of S.voices) { try { v.stop(); } catch (e) { /* ya terminada */ } }
    stopSuperSfx(S, true);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onResize);
    S.canvas.removeEventListener('pointerdown', onPointer);
    S.canvas.removeEventListener('touchstart', onTouch);
    S.canvas.removeEventListener('touchmove', onTouchBlock);
    S.canvas.removeEventListener('touchend', onTouchBlock);
    document.body.classList.remove('ending');
    S = null; // libera sprites, gradientes y referencias a charts/audio
  }

  window.RA = window.RA || {};
  window.RA.SONGS = SONGS;
  window.RA.audio = audio;
  window.RA.modes = MODES;
  window.RA.game = { start, stop, makeChart, setVolume, previewSkin };
})();
