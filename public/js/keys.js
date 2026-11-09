'use strict';
/* Configuración de teclas (escritorio). Va en public/js/keys.js y se carga ANTES de game.js.
 *
 * Cada columna tiene una tecla principal y una alternativa (por defecto: D F J K y las flechas).
 * Se guardan por posición física (event.code), así que funcionan igual con cualquier distribución de teclado.
 * API:  RA.keys.laneOf(code) -> 0..3 | undefined,  RA.keys.labels() -> ['D','F','J','K'],  RA.keys.open()
 */
(function () {
  const LANES = 4;
  const STORE = 'ra_keys';
  const DEFAULTS = {
    main: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
    alt: ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'],
  };
  const LANE_NAMES = ['Columna 1', 'Columna 2', 'Columna 3', 'Columna 4'];
  const LANE_COLORS = ['#ff4fd8', '#4fd8ff', '#ffe14f', '#7dff4f'];
  // Teclas que el juego o la ventana necesitan para sí
  const RESERVED = new Set(['Space', 'Tab', 'Enter', 'NumpadEnter', 'ContextMenu', 'MetaLeft', 'MetaRight',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
  };

  let cfg = load();
  let map = new Map();
  const listeners = [];

  function clone(o) { return { main: o.main.slice(), alt: o.alt.slice() }; }
  function load() {
    const out = clone(DEFAULTS);
    try {
      const raw = JSON.parse(ls.get(STORE) || 'null');
      if (raw && Array.isArray(raw.main) && Array.isArray(raw.alt)) {
        const seen = new Set();
        const ok = (v) => v === null || (typeof v === 'string' && v.length < 24 && !RESERVED.has(v));
        const main = [], alt = [];
        for (let i = 0; i < LANES; i += 1) { // primero todas las principales, luego las alternativas
          let m = raw.main[i];
          if (!ok(m) || m === null || seen.has(m)) m = null; else seen.add(m);
          main.push(m);
        }
        for (let i = 0; i < LANES; i += 1) {
          let a = raw.alt[i];
          if (!ok(a) || seen.has(a)) a = null; else if (a) seen.add(a);
          alt.push(a);
        }
        if (main.every(Boolean)) return { main, alt };
      }
    } catch (e) { /* configuración corrupta: se usan las de fábrica */ }
    return out;
  }
  function rebuild() {
    map = new Map();
    for (let i = 0; i < LANES; i += 1) {
      if (cfg.main[i]) map.set(cfg.main[i], i);
      if (cfg.alt[i]) map.set(cfg.alt[i], i);
    }
  }
  function save() {
    ls.set(STORE, JSON.stringify(cfg));
    rebuild();
    refreshHint();
    listeners.forEach((fn) => { try { fn(); } catch (e) { /* */ } });
  }

  // ------------------------------------------------------------- nombres legibles
  const PRETTY = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Semicolon: ';', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Quote: "'", Backquote: '`',
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', IntlBackslash: '<',
    ShiftLeft: 'Shift ⟵', ShiftRight: 'Shift ⟶', ControlLeft: 'Ctrl ⟵', ControlRight: 'Ctrl ⟶',
    AltLeft: 'Alt', AltRight: 'Alt Gr', CapsLock: 'Bloq Mayús', Backspace: '⌫', Delete: 'Supr',
    Insert: 'Ins', Home: 'Inicio', End: 'Fin', PageUp: 'Re Pág', PageDown: 'Av Pág',
    NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .',
  };
  function pretty(code) {
    if (!code) return '—';
    if (PRETTY[code]) return PRETTY[code];
    let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
    m = /^Digit(\d)$/.exec(code); if (m) return m[1];
    m = /^Numpad(\d)$/.exec(code); if (m) return `Num ${m[1]}`;
    return code;
  }

  function refreshHint() {
    const h = document.getElementById('keys-hint');
    if (h) h.textContent = cfg.main.map(pretty).join(' ');
  }

  // ------------------------------------------------------------- API
  const api = {
    laneOf(code) { return map.get(code); },
    labels() { return cfg.main.map(pretty); },
    get() { return clone(cfg); },
    reset() { cfg = clone(DEFAULTS); save(); },
    onChange(fn) { listeners.push(fn); },
    pretty,
    open: () => {},
  };
  rebuild();

  // Los estilos viajan dentro de este archivo: así el diálogo se ve bien aunque style.css esté en caché.
  const CSS = "/* ---------- Configuraci\u00f3n de teclas (escritorio) ---------- */\n#btn-keys{margin-left:auto}\n#btn-keys+#btn-fs-menu{margin-left:0}\n#btn-keys[hidden]{display:none}\n.keys-overlay{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:16px;background:rgba(5,6,18,.78)}\n.keys-overlay[hidden]{display:none}\n.keys-box{width:min(520px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:22px;border-radius:18px;background:var(--panel-solid);\n  border:1px solid var(--line);box-shadow:0 24px 70px rgba(0,0,0,.6)}\n.keys-box h3{margin:0 0 6px;font-size:1.3rem}\n.keys-intro{margin:0 0 14px;font-size:.9rem}\n.keys-preview{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}\n.keys-pad{height:34px;border-radius:10px;border:2px solid var(--c);background:rgba(255,255,255,.04);opacity:.55;transition:background .08s,opacity .08s,box-shadow .08s}\n.keys-pad.hit{background:var(--c);opacity:1;box-shadow:0 0 18px var(--c)}\n.keys-grid{display:grid;grid-template-columns:auto 1fr 1fr;gap:8px 10px;align-items:center}\n.keys-h{color:var(--muted);font-size:.78rem;font-weight:700;text-align:center}\n.keys-name{font-weight:700;font-size:.9rem;padding-left:10px;border-left:4px solid var(--c);white-space:nowrap}\n.keys-slot{min-height:42px;font-weight:800;letter-spacing:.02em}\n.keys-slot.empty{color:var(--muted);font-weight:600}\n.keys-slot.listening{border-color:var(--pink);background:rgba(255,79,216,.14);animation:keysPulse 1s ease-in-out infinite}\n@keyframes keysPulse{50%{box-shadow:0 0 0 4px rgba(255,79,216,.22)}}\n.keys-msg{margin:14px 0 4px;min-height:1.3em;font-size:.88rem}\n.keys-msg.bad{color:#ff7b8a}\n.keys-tip{margin:0 0 14px;font-size:.78rem}\n.keys-actions{display:flex;gap:10px;justify-content:flex-end}\n@media(prefers-reduced-motion:reduce){.keys-slot.listening{animation:none}}";
  function injectCss() {
    if (document.getElementById('keys-css')) return;
    const st = document.createElement('style'); st.id = 'keys-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------- diálogo
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  let overlay = null;
  function build() {
    overlay = el('div', 'keys-overlay');
    overlay.hidden = true;
    const box = el('div', 'keys-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'keys-title');

    const title = el('h3', '', 'Configurar teclas'); title.id = 'keys-title';
    const intro = el('p', 'muted keys-intro', 'Pulsa una casilla y luego la tecla que quieras usar. Cada columna tiene una tecla principal y otra alternativa.');
    const preview = el('div', 'keys-preview');
    const lanesEls = [];
    for (let i = 0; i < LANES; i += 1) { const p = el('div', 'keys-pad'); p.style.setProperty('--c', LANE_COLORS[i]); preview.appendChild(p); lanesEls.push(p); }

    const grid = el('div', 'keys-grid');
    grid.appendChild(el('span', 'keys-h', ''));
    grid.appendChild(el('span', 'keys-h', 'Principal'));
    grid.appendChild(el('span', 'keys-h', 'Alternativa'));
    const slots = []; // [{ kind, lane, btn }]
    for (let i = 0; i < LANES; i += 1) {
      const name = el('span', 'keys-name', LANE_NAMES[i]); name.style.setProperty('--c', LANE_COLORS[i]);
      grid.appendChild(name);
      for (const kind of ['main', 'alt']) {
        const b = el('button', 'keys-slot'); b.type = 'button';
        b.addEventListener('click', () => listen(kind, i));
        grid.appendChild(b); slots.push({ kind, lane: i, btn: b });
      }
    }

    const msg = el('p', 'keys-msg muted', 'Prueba tus teclas: se iluminan arriba al pulsarlas.');
    msg.setAttribute('role', 'status');
    const hint = el('p', 'keys-tip muted', 'Esc cancela · Retroceso borra la alternativa · ESPACIO queda reservado para el SUPER PERFECT.');
    const row = el('div', 'row keys-actions');
    const bReset = el('button', 'ghost', 'Restablecer'); bReset.type = 'button';
    const bClose = el('button', 'primary', 'Listo'); bClose.type = 'button';
    row.append(bReset, bClose);

    box.append(title, intro, preview, grid, msg, hint, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let listening = null; // { kind, lane }
    function paint() {
      for (const s of slots) {
        const on = listening && listening.kind === s.kind && listening.lane === s.lane;
        s.btn.textContent = on ? 'Pulsa una tecla…' : pretty(cfg[s.kind][s.lane]);
        s.btn.classList.toggle('listening', !!on);
        s.btn.classList.toggle('empty', !cfg[s.kind][s.lane]);
      }
    }
    function say(text, bad) { msg.textContent = text; msg.classList.toggle('bad', !!bad); }
    function listen(kind, lane) { listening = { kind, lane }; say('Esperando tecla…'); paint(); }

    /** Devuelve { error } o { note }. Si la tecla ya la usa otra casilla, se intercambian. */
    function assign(kind, lane, code) {
      const next = clone(cfg);
      let note = `${LANE_NAMES[lane]}: ${pretty(code)}`;
      for (const k of ['main', 'alt']) {
        for (let i = 0; i < LANES; i += 1) {
          if (next[k][i] === code && !(k === kind && i === lane)) {
            const old = next[kind][lane];
            if (!old && k === 'main') return { error: 'Esa tecla es la principal de otra columna.' };
            next[k][i] = old || null;
            note += ` · intercambiada con ${LANE_NAMES[i]}`;
          }
        }
      }
      next[kind][lane] = code;
      cfg = next; save();
      return { note };
    }

    function onKeyDown(e) {
      if (overlay.hidden) return;
      if (listening) {
        e.preventDefault(); e.stopPropagation();
        if (e.repeat) return;
        const { kind, lane } = listening;
        if (e.code === 'Escape') { listening = null; say('Cancelado.'); paint(); return; }
        if (e.code === 'Backspace' || e.code === 'Delete') {
          listening = null;
          if (kind === 'main') say('La tecla principal no se puede borrar: asigna otra.', true);
          else { const n = clone(cfg); n.alt[lane] = null; cfg = n; save(); say('Alternativa borrada.'); }
          paint(); return;
        }
        if (RESERVED.has(e.code) || !e.code) { say(`"${pretty(e.code)}" no se puede usar (reservada).`, true); return; }
        listening = null;
        const r = assign(kind, lane, e.code);
        if (r.error) say(r.error, true); else say(r.note);
        paint();
        return;
      }
      if (e.code === 'Escape') { e.preventDefault(); close(); return; }
      const l = map.get(e.code);
      if (l !== undefined && !e.repeat) {
        const pad = lanesEls[l]; pad.classList.add('hit');
        setTimeout(() => pad.classList.remove('hit'), 120);
      }
    }
    document.addEventListener('keydown', onKeyDown, true);

    bReset.addEventListener('click', () => { listening = null; api.reset(); say('Teclas restablecidas (D F J K y flechas).'); paint(); });
    bClose.addEventListener('click', () => close());
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay && !listening) close(); });

    let lastFocus = null;
    function close() { listening = null; overlay.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
    api.open = () => {
      lastFocus = document.activeElement; listening = null;
      say('Prueba tus teclas: se iluminan arriba al pulsarlas.'); paint();
      overlay.hidden = false; bClose.focus();
    };
  }

  function init() {
    injectCss();
    refreshHint();
    const btn = document.getElementById('btn-keys');
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (btn) {
      if (coarse && !window.matchMedia('(any-pointer: fine)').matches) btn.hidden = true; // móvil/tablet: sin teclado
      else btn.addEventListener('click', () => { if (!overlay) build(); api.open(); });
    }
  }

  window.RA = window.RA || {};
  window.RA.keys = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
