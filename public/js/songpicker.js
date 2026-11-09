'use strict';
/* Menú "Un jugador": selector de música estilo "Select Music" (banner + datos a la izquierda, rueda de canciones a la derecha)
   y selector de modos. Mejora progresiva: los <select> originales (#solo-song, #solo-mode) siguen siendo la fuente de verdad
   (main.js los lee igual); este módulo los oculta y los mantiene sincronizados.
   El selector de música es reutilizable (createPicker): se usa en el menú (un jugador) y en el lobby de las salas
   (#song es la fuente de verdad en el lobby; cada cambio dispara 'change' y main.js lo envía al servidor). */
(function () {
  const $ = (id) => document.getElementById(id);
  const selMode = $('solo-mode'), wrapMode = $('mode-picker-wrap');
  if (!selMode || !wrapMode) return;

  const COVER_KEYS = ['cover', 'coverUrl', 'cover_url', 'coverImage', 'cover_image', 'image', 'imageUrl', 'image_url',
    'img', 'thumbnail', 'thumb', 'art', 'artwork', 'picture', 'poster', 'portada', 'foto'];
  const meta = {}; // songId -> datos de /api/songs

  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const MODES = [
    { v: 'normal', cls: 'm-normal', name: 'Normal', desc: 'Clásico, sin barra especial.', icon: svg('<path d="M7 4.5v15l12-7.5z"/>') },
    { v: 'survival', cls: 'm-survival', name: 'Supervivencia', desc: 'Cada fallo te quita vida. Sin vida, pierdes.', icon: svg('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>') },
    { v: 'super', cls: 'm-super', name: 'Super Perfect', desc: 'Carga la barra y pulsa ESPACIO: 11 s perfectos.', icon: svg('<path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/>') },
  ];

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
  function hueOf(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
  function coverUrl(song) {
    if (!song) return '';
    const keys = COVER_KEYS.filter((k) => typeof song[k] === 'string' && song[k].trim());
    let u = keys.length ? song[keys[0]].trim() : '';
    if (!u) { const k = Object.keys(song).find((x) => /cover|image|img|thumb|art|pic|poster|portada|foto/i.test(x) && typeof song[x] === 'string' && song[x].trim()); if (k) u = song[k].trim(); }
    if (!u) return '';
    return /^(https?:|data:|\/)/i.test(u) ? u : '/' + u;
  }
  const fmtDur = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const initial = (name) => (name.match(/[A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]/) || ['♪'])[0].toUpperCase();

  // Búsqueda sin tildes ni mayúsculas
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // /api/songs se pide una sola vez y se comparte entre los selectores (menú y lobby)
  let catalogP = null;
  function getCatalog() {
    if (!catalogP) {
      catalogP = fetch('/api/songs').then((r) => (r.ok ? r.json() : null)).then((d) => {
        const arr = Array.isArray(d) ? d : d && (d.songs || d.items || d.data) || [];
        for (const s of arr) { const id = s.songId || s.id; if (id) meta[id] = s; }
        return arr;
      }).catch(() => []);
    }
    return catalogP;
  }

  /** Portada: solo el degradado con inicial (barato). La imagen se añade después con attachCover, cuando la fila está cerca y la rueda en reposo. */
  function makeCover(it) {
    const d = el('div', 'cover', initial(it.title));
    d.style.setProperty('--h', it.hue);
    d._src = it.cover || '';
    return d;
  }
  function attachCover(d) {
    if (!d || !d._src || d._img) return;
    const im = new Image();
    im.alt = ''; im.decoding = 'async';
    im.onerror = () => im.remove();
    im.src = d._src;
    d._img = im;
    d.appendChild(im);
  }
  /** Banner grande: la portada completa sobre una copia desenfocada de sí misma. */
  function makeBanner(it) {
    const b = el('div', 'sm-banner');
    const base = el('div', 'cover', initial(it.title)); base.style.setProperty('--h', it.hue);
    b.appendChild(base);
    if (it.cover) {
      const bg = el('div', 'bg'); bg.style.backgroundImage = `url("${it.cover.replace(/"/g, '%22')}")`;
      const im = new Image(); im.alt = ''; im.decoding = 'async';
      im.onerror = () => { im.remove(); bg.remove(); };
      im.src = it.cover;
      b.append(bg, im);
    }
    return b;
  }

  /** Selector de música estilo "Select Music" sobre un <select> de canciones.
   *  cfg = { selSong, root, wrap, hide:[nodos], screenId, hint, fixed?, onEnter?, onTick? } */
  function createPicker(cfg) {
  const { selSong, root, screenId } = cfg;
  function readItems() {
    return [...selSong.options].filter((o) => o.value && !o.disabled).map((o) => {
      const m = meta[o.value] || {}, parts = o.textContent.split(' · ');
      const full = m.name || parts[0] || o.value;
      const k = full.indexOf(' — ');
      const bpm = +(m.bpm || ((parts.find((p) => /BPM/i.test(p)) || '').match(/\d+/) || [0])[0]) || 0;
      const dur = +(m.durationMs || (((parts.find((p) => /\d+\s*s\b/.test(p) && !/BPM/i.test(p)) || '').match(/\d+/) || [0])[0] * 1000)) || 0;
      const notes = +(m.totalNotes || m.notes || m.noteCount || m.total_notes) || 0;
      const ttl = k > 0 ? full.slice(0, k) : full, art = m.artist || m.author || (k > 0 ? full.slice(k + 3) : '');
      return { id: o.value, title: ttl, artist: art, q: norm(ttl + ' ' + art),
        bpm, dur, notes, hue: m.hue !== undefined ? m.hue : hueOf(o.value), cover: coverUrl(m) };
    });
  }

  // ================= Selector de música =================
  root.textContent = '';
  const sm = el('div', cfg.fixed ? 'sm sm-fixed' : 'sm');
  const left = el('div', 'sm-left'), right = el('div', 'sm-right');
  let banner = el('div');
  const title = el('h4', 'sm-title'), artist = el('p', 'sm-artist'), stats = el('div', 'sm-stats'), radar = el('div', 'sm-radar');
  left.append(banner, title, artist, stats, radar);
  const search = el('input'); search.type = 'search'; search.placeholder = 'Buscar canción…'; search.setAttribute('aria-label', 'Buscar canción'); search.autocomplete = 'off';
  const count = el('span', 'sm-count');
  const wheel = el('div', 'sm-wheel'); wheel.tabIndex = 0; wheel.setAttribute('role', 'listbox'); wheel.setAttribute('aria-label', 'Canciones');
  const track = el('div', 'sm-track'), thumb = el('i'); track.appendChild(thumb);
  const hint = el('p', 'sm-hint', cfg.hint);
  right.append(Object.assign(el('div', 'sm-search'), {}), el('div', 'sm-wheelwrap'), hint);
  const pvBtn = el('button', 'sm-pv'); pvBtn.type = 'button'; pvBtn.title = 'Vista previa de la canción';
  const pvVol = el('input', 'sm-vol'); pvVol.type = 'range'; pvVol.min = 0; pvVol.max = 100; pvVol.step = 5; pvVol.title = 'Volumen'; pvVol.setAttribute('aria-label', 'Volumen de la vista previa');
  right.children[0].append(search, pvBtn, pvVol, count);
  right.children[1].append(wheel, track);
  sm.append(left, right);
  root.appendChild(sm);

  let items = [], list = [], sel = 0, shown = null, rows = 9;
  const rowEls = new Map();   // filas actualmente en el DOM
  const rowCache = new Map(); // filas ya creadas (se reutilizan al buscar/desplazar)
  let coverTimer = 0;
  let thumbH = 40;
  let rowH = 58;
  const ROW_H = () => rowH;

  const DASH = window.matchMedia('(min-width:1000px) and (min-height:620px)'); // mismo criterio que el CSS a pantalla completa
  /** Ajusta el alto de fila a la pantalla y calcula cuántas filas caben: la rueda llena todo el alto disponible. */
  function setRows() {
    const rh = Math.max(52, Math.min(78, Math.round(window.innerHeight * 0.068)));
    rowH = rh;
    sm.style.setProperty('--rh', rh + 'px');
    if (!cfg.fixed && DASH.matches) {
      let n = Math.floor((wheel.clientHeight || rh * 9) / rh);
      if (n % 2 === 0) n -= 1;
      rows = Math.max(5, Math.min(17, n));
    } else rows = cfg.fixed || window.innerHeight < 820 ? 7 : 9;
    wheel.style.setProperty('--rows', rows);
    thumbH = thumb.offsetHeight || 40;
    layoutWheel();
  }

  function makeRow(it) {
    const b = el('button', 'sm-row'); b.type = 'button'; b.dataset.id = it.id; b.setAttribute('role', 'option'); b.tabIndex = -1;
    b.style.setProperty('--h', it.hue);
    const t = el('div', 't'); t.append(el('strong', '', it.title), el('span', '', it.artist || (it.dur ? fmtDur(it.dur) : '')));
    b.append(makeCover(it), t);
    if (it.bpm) b.append(el('span', 'bpm', `${it.bpm} BPM`));
    b.addEventListener('click', () => { const i = list.findIndex((x) => x.id === it.id); if (i >= 0) pick(i); });
    return b;
  }

  /** Coloca solo las filas cercanas a la seleccionada; la canción elegida queda en el centro, las demás se curvan hacia la derecha. */
  function layoutWheel() {
    const rh = ROW_H(), vis = Math.floor(rows / 2) + 1, seen = new Set();
    const lo = Math.max(0, sel - vis), hi = Math.min(list.length - 1, sel + vis);
    let fresh = false;
    for (let i = lo; i <= hi; i += 1) {
      const it = list[i]; seen.add(it.id);
      let r = rowEls.get(it.id);
      if (!r) {
        r = rowCache.get(it.id);
        if (!r) {
          if (rowCache.size > 80) { for (const [cid, cr] of rowCache) if (!rowEls.has(cid)) rowCache.delete(cid); }
          r = makeRow(it); rowCache.set(it.id, r);
        }
        rowEls.set(it.id, r); r.style.opacity = 0; r.style.transform = `translate3d(40px, ${(i - sel) * rh}px, 0)`; wheel.appendChild(r); fresh = true;
      }
    }
    if (fresh) void wheel.offsetWidth; // un único reflow para todas las filas nuevas (antes era uno por fila)
    for (let i = lo; i <= hi; i += 1) {
      const r = rowEls.get(list[i].id);
      const d = i - sel, ad = Math.abs(d), on = d === 0;
      r.style.transform = `translate3d(${on ? -12 : ad * ad * 3.5}px, ${d * rh}px, 0)`;
      r.style.opacity = Math.max(0, 1 - ad * (1.05 / vis));
      r.style.zIndex = 100 - ad;
      if (r._on !== on) { r._on = on; r.classList.toggle('on', on); r.setAttribute('aria-selected', on); }
    }
    for (const [id, r] of rowEls) if (!seen.has(id)) { rowEls.delete(id); r.remove(); }
    // las imágenes de portada solo se cargan cuando la rueda se detiene un instante
    clearTimeout(coverTimer);
    coverTimer = setTimeout(() => { for (const r of rowEls.values()) attachCover(r.firstChild); }, 140);
    thumb.style.top = list.length > 1 ? `calc((100% - ${thumbH}px) * ${sel / (list.length - 1)})` : '0';
    count.textContent = list.length ? `${sel + 1} / ${list.length}` : '0';
    let empty = wheel.querySelector('.sm-empty');
    if (!list.length) { if (!empty) wheel.appendChild(el('div', 'sm-empty', 'Sin resultados')); } else if (empty) empty.remove();
  }

  function pick(i, fromUser = true) {
    if (!list.length) return;
    sel = Math.max(0, Math.min(list.length - 1, i));
    const it = list[sel];
    if (fromUser && selSong.value !== it.id) {
      selSong.value = it.id;
      selSong.dispatchEvent(new Event('input', { bubbles: true })); selSong.dispatchEvent(new Event('change', { bubbles: true }));
    }
    shown = it.id;
    layoutWheel(); scheduleInfo(it, fromUser);
    schedulePreview(it.id);
  }

  function renderRadar(it) {
    radar.textContent = '';
    const have = items.filter((x) => x.notes && x.dur);
    if (!it.notes || !it.dur || have.length < 2) return;
    const nps = (x) => x.notes / (x.dur / 1000);
    const max = (f) => Math.max(...have.map(f)) || 1;
    const axes = [['BPM', it.bpm / max((x) => x.bpm)], ['Densidad', nps(it) / max(nps)], ['Duración', it.dur / max((x) => x.dur)],
      ['Notas', it.notes / max((x) => x.notes)], ['Intensidad', (nps(it) * it.bpm) / max((x) => nps(x) * x.bpm)]];
    const c = 110, R = 68, ang = (k) => (-90 + k * 72) * Math.PI / 180, pt = (k, f) => [c + Math.cos(ang(k)) * R * f, c + Math.sin(ang(k)) * R * f];
    let s = '<svg viewBox="0 0 220 220" role="img" aria-label="Perfil de la canción">';
    for (const f of [1, 0.66, 0.33]) s += `<polygon class="ring" points="${axes.map((_, k) => pt(k, f).join(',')).join(' ')}"/>`;
    axes.forEach((_, k) => { s += `<line class="axis" x1="${c}" y1="${c}" x2="${pt(k, 1)[0]}" y2="${pt(k, 1)[1]}"/>`; });
    s += `<polygon class="poly" points="${axes.map(([, v], k) => pt(k, Math.max(0.14, Math.min(1, v))).join(',')).join(' ')}"/>`;
    axes.forEach(([n], k) => { const [x, y] = pt(k, 1.32); s += `<text x="${x}" y="${y + 3}">${n}</text>`; });
    radar.innerHTML = s + '</svg>';
  }

  // La rueda responde al instante; el panel izquierdo (banner, estadísticas, radar) espera a que el dedo se detenga un instante
  let infoTimer = 0, infoRaf = 0;
  function scheduleInfo(it, fast) {
    clearTimeout(infoTimer); cancelAnimationFrame(infoRaf);
    if (!fast) { renderInfo(it); return; }
    left.style.setProperty('--h', it.hue);
    title.textContent = it.title;
    infoTimer = setTimeout(() => { infoRaf = requestAnimationFrame(() => renderInfo(it)); }, 70);
  }
  function renderInfo(it) {
    left.style.setProperty('--h', it.hue);
    banner.replaceWith(banner = makeBanner(it));
    title.textContent = it.title; artist.textContent = it.artist; artist.hidden = !it.artist;
    stats.textContent = '';
    const add = (v, l) => { const s = el('div', 'sm-stat'); s.append(el('b', '', v), el('small', '', l)); stats.appendChild(s); };
    if (it.bpm) add(it.bpm, 'BPM');
    if (it.dur) add(fmtDur(it.dur), 'Duración');
    if (it.notes) add(it.notes, 'Notas');
    renderRadar(it);
  }

  function applyFilter() {
    const q = norm(search.value.trim());
    const cur = (list[sel] || {}).id || selSong.value;
    list = q ? items.filter((x) => x.q.includes(q)) : items.slice();
    let i = list.findIndex((x) => x.id === cur);
    if (i < 0) i = 0;
    for (const r of rowEls.values()) r.remove(); rowEls.clear(); // las filas siguen en rowCache
    if (!list.length) { layoutWheel(); return; }
    pick(i, list[i].id !== selSong.value);
  }

  function rebuild() {
    items = readItems();
    list = items.slice(); search.value = '';
    for (const r of rowEls.values()) r.remove(); rowEls.clear(); rowCache.clear();
    if (!items.length) { layoutWheel(); return; }
    const i = Math.max(0, items.findIndex((x) => x.id === selSong.value));
    pick(i, false);
  }

  // ================= Vista previa de audio =================
  // Al elegir una canción suena un fragmento (~22 s, desde ~1/3 del tema) con fundidos y en bucle.
  // Usa <audio> en streaming (no decodifica el MP3 entero) y se detiene al salir del menú o al empezar a jugar.
  const PREVIEW_S = 22;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ok */ } };
  const pv = { a: new Audio(), id: null, tok: 0, wait: 0, raf: 0 };
  pv.a.preload = 'auto';
  let pvOn = lsGet('ra_preview') !== '0', pvBlocked = false;
  const SPK = '<path d="M11 5L6 9H2v6h4l5 4z"/>';
  const menuActive = () => { const m = $(screenId); return !!m && m.classList.contains('active') && !document.hidden; };
  function previewVol() { const raw = lsGet('ra_vol'); let v = raw === null ? 70 : Number(raw); if (!Number.isFinite(v)) v = 70; return Math.max(0, Math.min(1, v / 100)) * 0.85; }
  function paintPv() {
    pvBtn.classList.toggle('off', !pvOn); pvBtn.setAttribute('aria-pressed', pvOn);
    pvBtn.innerHTML = svg(SPK + (pvOn ? '<path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>' : '<path d="M23 9l-6 6M17 9l6 6"/>'));
    const v = lsGet('ra_vol'); pvVol.value = v === null ? 70 : v; pvVol.disabled = !pvOn;
  }
  function fade(to, ms, done) {
    cancelAnimationFrame(pv.raf);
    const a = pv.a, from = a.volume, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      a.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k < 1) pv.raf = requestAnimationFrame(step); else if (done) done();
    };
    pv.raf = requestAnimationFrame(step);
  }
  function stopPreview(soft) {
    pv.tok += 1; clearTimeout(pv.wait); pv.id = null;
    const a = pv.a;
    if (a.paused) return;
    if (soft) { const t = pv.tok; fade(0, 250, () => { if (pv.tok === t) a.pause(); }); }
    else { cancelAnimationFrame(pv.raf); a.pause(); }
  }
  function loopPreview(tok, at) {
    if (tok !== pv.tok) return;
    fade(0, 600, () => {
      if (tok !== pv.tok) return;
      try { pv.a.currentTime = at; } catch (e) { /* ok */ }
      fade(previewVol(), 600);
      pv.wait = setTimeout(() => loopPreview(tok, at), (PREVIEW_S - 1) * 1000);
    });
  }
  function startPreview(id, url) {
    if (!pvOn || !menuActive() || (list[sel] || {}).id !== id) { if (pv.id === id) pv.id = null; return; }
    const a = pv.a, tok = ++pv.tok, m = meta[id] || {};
    cancelAnimationFrame(pv.raf); a.pause(); a.volume = 0;
    const begin = () => {
      if (tok !== pv.tok) return;
      const dur = Number.isFinite(a.duration) ? a.duration : 0;
      let at = Number(m.previewStartMs) / 1000;
      if (!(at >= 0)) at = dur ? Math.min(Math.max(dur * 0.33, 8), Math.max(0, dur - PREVIEW_S - 2)) : 0;
      try { a.currentTime = at; } catch (e) { /* ok */ }
      a.play().then(() => {
        if (tok !== pv.tok) return;
        fade(previewVol(), 700);
        pv.wait = setTimeout(() => loopPreview(tok, at), PREVIEW_S * 1000);
      }).catch(() => {
        if (tok !== pv.tok) return;
        pv.id = null; pvBlocked = true; // el navegador exige un gesto del usuario: se reintenta al primer clic/tecla
        const again = () => { pvBlocked = false; document.removeEventListener('pointerdown', again, true); document.removeEventListener('keydown', again, true); };
        document.addEventListener('pointerdown', again, true); document.addEventListener('keydown', again, true);
      });
    };
    const abs = new URL(url, location.href).href;
    if (a.src !== abs) { a.src = abs; a.load(); }
    if (a.readyState >= 1) begin(); else a.addEventListener('loadedmetadata', begin, { once: true });
  }
  function schedulePreview(id) {
    if (!pvOn || pvBlocked || !menuActive()) return;
    const url = meta[id] && meta[id].audioUrl;
    if (!url || pv.id === id) return;
    stopPreview(true);
    pv.id = id;
    pv.wait = setTimeout(() => startPreview(id, url), 380); // espera a que el usuario deje de desplazarse
  }
  pvBtn.addEventListener('click', () => {
    pvOn = !pvOn; lsSet('ra_preview', pvOn ? '1' : '0'); paintPv();
    if (pvOn) { pvBlocked = false; schedulePreview((list[sel] || {}).id); } else stopPreview(true);
  });
  pvVol.addEventListener('input', () => {
    const g = $('vol'); // comparte el volumen con el de la partida
    if (g) { g.value = pvVol.value; g.dispatchEvent(new Event('input', { bubbles: true })); } else lsSet('ra_vol', pvVol.value);
    if (!pv.a.paused) fade(previewVol(), 120);
  });
  // al lanzar cualquier partida, la vista previa se corta al instante
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#btn-solo,#btn-quick,#btn-create,#btn-join,#btn-ready,#btn-start,#btn-leave')) stopPreview(false); }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPreview(false); });
  paintPv();

  // Interacción: rueda del ratón, teclado, arrastre táctil
  let lastWheel = 0;
  let flingRaf = 0;
  const stopFling = () => { cancelAnimationFrame(flingRaf); flingRaf = 0; wheel.classList.remove('fling'); };
  wheel.addEventListener('wheel', (e) => {
    e.preventDefault(); stopFling();
    const n = performance.now(); if (n - lastWheel < 45) return; lastWheel = n;
    pick(sel + (e.deltaY > 0 ? 1 : -1));
  }, { passive: false });

  // Arrastre táctil con inercia (se sigue desplazando al soltar) y sin "clics fantasma" tras arrastrar
  let dragY = null, acc = 0, moved = false, vel = 0, lastT = 0, totalDrag = 0;
  wheel.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    stopFling(); dragY = e.clientY; acc = 0; moved = false; totalDrag = 0; vel = 0; lastT = performance.now();
  });
  wheel.addEventListener('pointermove', (e) => {
    if (dragY === null) return;
    const now = performance.now(), dy = dragY - e.clientY, dt = Math.max(1, now - lastT);
    vel = vel * 0.6 + (dy / dt) * 0.4; lastT = now;
    acc += dy; dragY = e.clientY; totalDrag += Math.abs(dy);
    if (totalDrag > 8) moved = true;
    const rh = ROW_H(); while (Math.abs(acc) >= rh) { pick(sel + Math.sign(acc)); acc -= Math.sign(acc) * rh; }
  });
  const endDrag = () => {
    if (dragY === null) return;
    dragY = null;
    if (!moved || Math.abs(vel) < 0.15 || performance.now() - lastT > 90) return;
    wheel.classList.add('fling');
    let v = Math.max(-4, Math.min(4, vel)), last = performance.now(); // px/ms
    const step = (now) => {
      const dt = Math.min(48, now - last); last = now;
      acc += v * dt; v *= Math.pow(0.94, dt / 16);
      const rh = ROW_H(); let guard = 0;
      while (Math.abs(acc) >= rh && guard++ < 6) {
        const nx = sel + Math.sign(acc);
        if (nx < 0 || nx > list.length - 1) { v = 0; acc = 0; break; }
        pick(nx); acc -= Math.sign(acc) * rh;
      }
      if (Math.abs(v) > 0.03) flingRaf = requestAnimationFrame(step); else stopFling();
    };
    flingRaf = requestAnimationFrame(step);
  };
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) wheel.addEventListener(ev, endDrag);
  // si el gesto fue un arrastre, el clic posterior no debe elegir otra canción
  wheel.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);

  // Barra lateral arrastrable (salto directo a cualquier punto de la lista)
  let trackDrag = false;
  const trackTo = (e) => {
    const r = track.getBoundingClientRect();
    if (!r.height || list.length < 2) return;
    const f = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    const i = Math.round(f * (list.length - 1)); if (i !== sel) pick(i);
  };
  track.addEventListener('pointerdown', (e) => { stopFling(); trackDrag = true; try { track.setPointerCapture(e.pointerId); } catch (x) { /* ok */ } trackTo(e); e.preventDefault(); });
  track.addEventListener('pointermove', (e) => { if (trackDrag) trackTo(e); });
  for (const ev of ['pointerup', 'pointercancel']) track.addEventListener(ev, () => { trackDrag = false; });

  // Búsqueda: se espera ~140 ms tras la última tecla para no recalcular en cada pulsación
  let searchTimer = 0;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilter, 140); });
  document.addEventListener('keydown', (e) => {
    const menu = $(screenId);
    if (!menu || !menu.classList.contains('active')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'select' || (tag === 'input' && e.target !== search)) return;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 }[e.key];
    if (step) { e.preventDefault(); pick(sel + step); }
    else if (e.key === 'Home' && e.target !== search) { e.preventDefault(); pick(0); }
    else if (e.key === 'End' && e.target !== search) { e.preventDefault(); pick(list.length - 1); }
    else if (e.key === 'Enter' && tag !== 'button' && tag !== 'textarea') { if (cfg.onEnter) cfg.onEnter(); }
  });
  window.addEventListener('resize', setRows);
  if (window.ResizeObserver) new ResizeObserver(setRows).observe(wheel); // la rueda cambia de alto con la ventana

  // Activar la versión visual y ocultar los controles originales
  for (const n of cfg.hide) if (n) n.hidden = true;
  cfg.wrap.hidden = false;
  setRows();

  // main.js llena el <select> de canciones de forma asíncrona: se reconstruye cuando cambian las opciones
  new MutationObserver(rebuild).observe(selSong, { childList: true });
  rebuild();
  setInterval(() => {
    if (list.length && selSong.value !== shown) { const i = list.findIndex((x) => x.id === selSong.value); if (i >= 0) pick(i, false); }
    if (cfg.onTick) cfg.onTick();
    if (menuActive()) { const cur = (list[sel] || {}).id; if (cur && pv.id !== cur) schedulePreview(cur); }
    else if (pv.id || !pv.a.paused) stopPreview(false);
  }, 400);

  // Datos (nombre, BPM, duración, notas y portada) de la API
  getCatalog().then((arr) => {
    const keep = selSong.value; rebuild(); if (keep) { const i = list.findIndex((x) => x.id === keep); if (i >= 0) pick(i, false); }
    if (arr.length && !arr.some((s) => coverUrl(s))) console.info('[songpicker] /api/songs no trae portada; campos disponibles:', Object.keys(arr[0]));
  });
  }

  // Botón de pantalla completa del menú
  const fsBtn = $('btn-fs-menu');
  if (fsBtn) {
    if (!document.documentElement.requestFullscreen) fsBtn.hidden = true;
    else {
      fsBtn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
      });
      document.addEventListener('fullscreenchange', () => fsBtn.classList.toggle('on', !!document.fullscreenElement));
    }
  }

  // ================= Modos =================
  const modes = $('mode-picker');
  function markMode() { for (const b of modes.children) { const on = b.dataset.v === selMode.value; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); } }
  for (const m of MODES) {
    const b = el('button'); b.type = 'button'; b.className = `mode-opt ${m.cls}`; b.dataset.v = m.v; b.setAttribute('role', 'radio');
    b.innerHTML = `${m.icon}<strong>${m.name}</strong><span>${m.desc}</span>`;
    b.addEventListener('click', () => { selMode.value = m.v; selMode.dispatchEvent(new Event('change', { bubbles: true })); markMode(); });
    modes.appendChild(b);
  }

  // Modo un jugador (menú) y selector de canción del lobby
  for (const s of [selMode]) { const f = s.closest('.field'); if (f) f.hidden = true; }
  wrapMode.hidden = false; markMode();
  const soloSel = $('solo-song');
  if (soloSel && $('song-picker') && $('song-picker-wrap')) {
    createPicker({ selSong: soloSel, root: $('song-picker'), wrap: $('song-picker-wrap'), hide: [soloSel.closest('.field')], screenId: 'screen-menu',
      hint: 'Rueda del ratón o ↑ ↓ para recorrer · Enter para jugar', onEnter: () => { const b = $('btn-solo'); if (b) b.click(); }, onTick: markMode });
  }
  const lobbySel = $('song');
  if (lobbySel && $('lobby-song-picker') && $('lobby-picker-wrap')) {
    createPicker({ selSong: lobbySel, root: $('lobby-song-picker'), wrap: $('lobby-picker-wrap'), hide: [lobbySel, document.querySelector('label[for="song"]')],
      screenId: 'screen-lobby', fixed: true, hint: 'Rueda del ratón o ↑ ↓ para recorrer · tu elección se envía sola' });
  }
})();
