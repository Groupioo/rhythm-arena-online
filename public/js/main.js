'use strict';
/* Pantallas y flujo de la aplicación. Todo texto de usuario se inserta con textContent. */
(function () {
  const { net, game, SONGS, songs } = window.RA;
  const $ = (id) => document.getElementById(id);
  const S = { me: null, room: null, queued: false, queueTimer: 0, solo: null, autoPickSent: false, slot: 0, lobbyCode: null, roundPlan: [] };

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
  };
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
    document.body.classList.toggle('playing', name === 'game');
    // Vídeo de fondo solo en el menú y en el lobby; se pausa en el resto para no gastar CPU/GPU.
    const withBg = name === 'login' || name === 'menu' || name === 'lobby';
    document.body.classList.toggle('bgvideo', withBg);
    if (name !== 'lobby') { const c = $('pick-clock'); if (c) c.hidden = true; } // el reloj solo se ve en el lobby
    const bg = document.querySelector('#bg-video video');
    if (bg) {
      if (withBg) { const p = bg.play(); if (p && p.catch) p.catch(() => {}); }
      else bg.pause();
    }
    setMusic(MUSIC_SCREENS.includes(name));
  }

  // ---------- Música de fondo (demo.mp3) ----------
  // Pantallas donde suena. Añade 'menu' o 'lobby' a la lista si la quieres también ahí.
  const MUSIC_SCREENS = ['login'];
  const MUSIC_VOLUME = 0.5;
  let musicFade = 0;
  function setMusic(on) {
    const a = $('bg-music');
    if (!a) return;
    clearInterval(musicFade);
    if (on) {
      a.volume = MUSIC_VOLUME;
      const p = a.play();
      // Si el navegador bloquea el autoplay, empieza con el primer clic o tecla
      if (p && p.catch) p.catch(() => {
        const resume = () => { if (!a.paused) return; a.play().catch(() => {}); };
        for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, resume, { once: true });
      });
    } else if (!a.paused) {
      // Fundido de salida de ~0,6 s y pausa
      musicFade = setInterval(() => {
        a.volume = Math.max(0, a.volume - MUSIC_VOLUME / 12);
        if (a.volume <= 0) { clearInterval(musicFade); a.pause(); a.currentTime = 0; }
      }, 50);
    }
  }
  // Si la pestaña no se ve, el vídeo se pausa (y se retoma al volver) para no gastar GPU.
  document.addEventListener('visibilitychange', () => {
    const bg = document.querySelector('#bg-video video');
    if (!bg) return;
    if (document.hidden) bg.pause();
    else if (document.body.classList.contains('bgvideo')) { const p = bg.play(); if (p && p.catch) p.catch(() => {}); }
  });
  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
  }
  // Nombre de jugador con su bandera delante
  function nameEl(nick, country, left) {
    const s = el('span', '');
    const f = window.RA.flag(country); if (f) s.appendChild(f);
    s.appendChild(document.createTextNode((left ? '✗ ' : '') + nick));
    return s;
  }
  async function act(fn) {
    try { return await fn(); } catch (e) { toast(e.message); return undefined; }
  }
  const isHost = () => S.room && S.room.hostId === net.socket.id;

  // ---------- Velocidad de notas (preferencia local de cada jugador) ----------
  const SPEEDS = [1, 2, 3, 4, 5, 6, 7];
  S.speed = Number(ls.get('ra_speed'));
  if (!SPEEDS.includes(S.speed)) S.speed = 2;
  // Velocidad por canción: cada jugador fija la SUYA en cada canción del lobby (también en las de sus rivales).
  // El servidor reparte las velocidades de todos en tiempo real. Sin ajuste propio se usa la velocidad general.
  S.roundSpeeds = [];
  document.querySelectorAll('.speed-select').forEach((sel) => {
    SPEEDS.forEach((v) => { const o = el('option', '', `x${v}`); o.value = String(v); sel.appendChild(o); });
    sel.value = String(S.speed);
    sel.addEventListener('change', () => {
      S.speed = Number(sel.value);
      ls.set('ra_speed', String(S.speed));
      document.querySelectorAll('.speed-select').forEach((o) => { o.value = String(S.speed); });
      // Cambiar la velocidad general la aplica a todas las canciones de la partida (y se descartan tus ajustes por canción).
      if (S.room && S.room.state === 'lobby') net.req('room:speed', { base: S.speed }).catch((e) => toast(e.message));
    });
  });

  // ---------- Volumen de la música (preferencia local) ----------
  S.vol = Number(ls.get('ra_vol'));
  if (!Number.isFinite(S.vol) || ls.get('ra_vol') === null) S.vol = 70;
  $('vol').value = String(S.vol);
  $('vol').addEventListener('input', () => {
    S.vol = Number($('vol').value);
    ls.set('ra_vol', String(S.vol));
    game.setVolume(S.vol / 100);
  });

  S.offset = Number(ls.get('ra_offset')) || 0; // calibración global en ms (consola: localStorage.ra_offset = 30)

  // ---------- Sesión ----------
  // Cuentas: registro / inicio de sesión con contraseña. El servidor devuelve un token para reconectar sin pedirla de nuevo.
  function startSession(p) {
    ls.set('ra_token', p.token); ls.set('ra_nick', p.nickname);
    S.me = p;
    renderMe();
    return p;
  }
  // Espera hasta 20 s (la primera consulta a la base de datos tras un rato de inactividad puede tardar)
  const authCall = (event, payload) => new Promise((resolve, reject) => {
    net.socket.timeout(20000).emit(event, payload, (err, res) => {
      if (err) return reject(new Error('El servidor tarda en responder. Espera unos segundos y vuelve a intentarlo.'));
      if (!res || !res.ok) return reject(new Error(res && res.error ? res.error.message : 'Error desconocido.'));
      return resolve(startSession(res.data));
    });
  });
  const resumeSession = () => authCall('auth:resume', { nickname: (S.me && S.me.nickname) || ls.get('ra_nick'), token: ls.get('ra_token') });
  // Foto de perfil, o la inicial del apodo sobre un degradado si no hay foto
  function paintAvatar(elm, me) {
    if (me.avatar) {
      elm.textContent = '';
      elm.style.background = `center / cover no-repeat url("${me.avatar}")`;
      return;
    }
    const n = me.nickname || '?';
    let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 360;
    elm.textContent = n.trim().charAt(0).toUpperCase();
    elm.style.background = `linear-gradient(135deg, hsl(${h},90%,62%), hsl(${(h + 60) % 360},90%,60%))`;
  }
  function renderMe() {
    const n = S.me.nickname || '?';
    paintAvatar($('me-avatar'), S.me);
    $('me-name').replaceChildren(...[window.RA.flag(S.me.country), document.createTextNode(n)].filter(Boolean));
    $('me-meta').textContent = `${S.me.games} ${S.me.games === 1 ? 'partida' : 'partidas'}`;
    $('me-rating').textContent = `${S.me.rating} pts`;
  }

  // ---------- Perfil (modal): estadísticas, foto y biografía ----------
  const pm = { avatar: undefined }; // undefined = sin cambios, null = quitar foto, string = foto nueva
  const pmBox = () => $('profile-modal');
  function pmCount() { $('pm-count').textContent = `${$('pm-bio').value.length}/160`; }
  function pmPaint() {
    const me = S.me;
    const view = { ...me, avatar: pm.avatar === undefined ? me.avatar : pm.avatar };
    paintAvatar($('pm-avatar'), view);
    $('pm-remove').hidden = !view.avatar;
  }
  function openProfile() {
    if (!S.me) return;
    const me = S.me, w = me.wins || 0, l = me.losses || 0, d = me.draws || 0, t = w + l + d;
    pm.avatar = undefined;
    $('pm-title').replaceChildren(...[window.RA.flag(me.country), document.createTextNode(me.nickname)].filter(Boolean));
    $('pm-meta').textContent = `${me.rating} pts · ${t ? Math.round((w * 100) / t) : 0}% de victorias`;
    $('pm-wins').textContent = w; $('pm-losses').textContent = l; $('pm-draws').textContent = d;
    $('pm-bio').value = me.bio || ''; pmCount();
    $('pm-msg').textContent = '';
    pmPaint();
    pmBox().hidden = false;
    $('pm-change').focus();
  }
  function closeProfile() { pmBox().hidden = true; $('me').focus(); }
  function fileToAvatar(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) return reject(new Error('Elige un archivo de imagen.'));
      if (file.size > 10 * 1024 * 1024) return reject(new Error('La imagen pesa más de 10 MB.'));
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
        img.onload = () => {
          // Recorte cuadrado centrado y reducción a 192x192: ocupa muy poco en la base de datos
          const size = 192, side = Math.min(img.naturalWidth, img.naturalHeight);
          const c = document.createElement('canvas'); c.width = c.height = size;
          c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
          for (const q of [0.85, 0.7, 0.55, 0.4]) {
            const url = c.toDataURL('image/jpeg', q);
            if (url.length <= 55000) return resolve(url);
          }
          return reject(new Error('La imagen es demasiado compleja. Prueba con otra.'));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  $('me').addEventListener('click', openProfile);
  $('me').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProfile(); } });
  $('pm-close').addEventListener('click', closeProfile);
  $('pm-cancel').addEventListener('click', closeProfile);
  pmBox().addEventListener('pointerdown', (e) => { if (e.target === pmBox()) closeProfile(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pmBox().hidden) closeProfile(); });
  $('pm-bio').addEventListener('input', pmCount);
  $('pm-change').addEventListener('click', () => $('pm-file').click());
  $('pm-remove').addEventListener('click', () => { pm.avatar = null; pmPaint(); });
  $('pm-file').addEventListener('change', async () => {
    const f = $('pm-file').files[0]; $('pm-file').value = '';
    if (!f) return;
    try { pm.avatar = await fileToAvatar(f); $('pm-msg').textContent = ''; pmPaint(); }
    catch (err) { $('pm-msg').textContent = err.message; }
  });
  $('pm-save').addEventListener('click', async () => {
    const btn = $('pm-save'); btn.disabled = true; $('pm-msg').textContent = '';
    try {
      const payload = { bio: $('pm-bio').value };
      if (pm.avatar !== undefined) payload.avatar = pm.avatar;
      S.me = await net.req('profile:save', payload);
      renderMe(); closeProfile(); toast('Perfil guardado.');
    } catch (err) { $('pm-msg').textContent = err.message; }
    btn.disabled = false;
  });

  // ---------- Ranking mundial (modal): mejores jugadores por puntos y por victorias ----------
  const rk = { tab: 'rating', data: null, loading: false };
  const rkBox = () => $('rank-modal');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // El ranking puede tardar si la base de datos estaba dormida: se espera hasta 20 s
  const rkFetch = () => new Promise((resolve, reject) => {
    net.socket.timeout(20000).emit('leaderboard:get', {}, (err, res) => {
      if (err) return reject(new Error('El servidor tarda en responder. Inténtalo de nuevo.'));
      if (!res || !res.ok) return reject(new Error(res && res.error ? res.error.message : 'No se pudo cargar el ranking.'));
      return resolve(res.data);
    });
  });
  function rkRender() {
    const list = $('rk-list');
    list.dataset.tab = rk.tab;
    list.replaceChildren();
    const rows = rk.data ? rk.data[rk.tab] : [];
    if (!rows.length) {
      list.appendChild(el('li', 'rk-empty', rk.data ? 'Aún no hay jugadores en este ranking. ¡Juega una clasificatoria!' : 'Cargando…'));
    }
    let meIn = false;
    for (const p of rows) {
      const mine = !!(S.me && p.nickname === S.me.nickname);
      if (mine) meIn = true;
      const li = el('li', `rk-row${mine ? ' me' : ''}${p.rank <= 3 ? ` top${p.rank}` : ''}`);
      const av = el('div', 'avatar rk-av'); av.setAttribute('aria-hidden', 'true'); paintAvatar(av, p);
      const who = el('div', 'rk-who');
      const name = nameEl(p.nickname, p.country); name.className = 'rk-name';
      const total = p.wins + p.losses + p.draws;
      who.append(name, el('span', 'rk-meta', `${plural(p.games, 'partida', 'partidas')} · ${total ? Math.round((p.wins * 100) / total) : 0}% de victorias`));
      const val = el('div', 'rk-val');
      const pts = `${p.rating} pts`, wins = plural(p.wins, 'victoria', 'victorias');
      val.append(el('strong', '', rk.tab === 'wins' ? wins : pts), el('span', '', rk.tab === 'wins' ? pts : wins));
      li.append(el('span', 'rk-pos', String(p.rank)), av, who, val);
      list.appendChild(li);
    }
    // Si no estás en el top, se muestra tu marca para que sepas cuánto te falta
    const note = $('rk-me');
    if (rk.data && S.me && !meIn) {
      const w = S.me.wins || 0;
      note.textContent = `Tú: ${S.me.rating} pts · ${plural(w, 'victoria', 'victorias')}. Gana partidas clasificatorias para entrar en el top ${rk.data.size || 20}.`;
      note.hidden = false;
    } else note.hidden = true;
  }
  function rkSetTab(tab) {
    rk.tab = tab;
    for (const t of ['rating', 'wins']) {
      const b = $(`rk-tab-${t}`);
      b.classList.toggle('on', t === tab);
      b.setAttribute('aria-selected', String(t === tab));
    }
    rkRender();
  }
  async function rkLoad() {
    if (rk.loading) return;
    rk.loading = true; $('rk-refresh').disabled = true; $('rk-msg').textContent = 'Cargando…';
    try {
      rk.data = await rkFetch();
      $('rk-msg').textContent = `Actualizado ${new Date(rk.data.updatedAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
    } catch (err) { $('rk-msg').textContent = err.message; }
    rk.loading = false; $('rk-refresh').disabled = false;
    if (!rkBox().hidden) rkRender();
  }
  function openRanking() {
    if (!S.me) return;
    rkRender(); // si ya se había abierto antes, se ve al instante y se refresca detrás
    rkBox().hidden = false;
    $('rk-close').focus();
    rkLoad();
  }
  function closeRanking() { rkBox().hidden = true; $('btn-rank').focus(); }
  $('btn-rank').addEventListener('click', openRanking);
  $('rk-close').addEventListener('click', closeRanking);
  $('rk-refresh').addEventListener('click', rkLoad);
  $('rk-tab-rating').addEventListener('click', () => rkSetTab('rating'));
  $('rk-tab-wins').addEventListener('click', () => rkSetTab('wins'));
  rkBox().addEventListener('pointerdown', (e) => { if (e.target === rkBox()) closeRanking(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !rkBox().hidden) closeRanking(); });

  show('login'); // vídeo y música desde la pantalla de inicio
  $('nick').value = ls.get('ra_nick') || '';
  let authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    const reg = mode === 'register';
    $('tab-login').classList.toggle('on', !reg); $('tab-register').classList.toggle('on', reg);
    $('tab-login').setAttribute('aria-selected', String(!reg)); $('tab-register').setAttribute('aria-selected', String(reg));
    $('pass2-wrap').hidden = !reg; $('pass2').required = reg;
    $('country-wrap').hidden = !reg; if (!reg) closeCountry();
    $('pass').autocomplete = reg ? 'new-password' : 'current-password';
    $('auth-submit').textContent = reg ? 'Crear cuenta' : 'Entrar';
    $('auth-msg').textContent = '';
  }
  // Selector de nacionalidad: todas las banderas, con buscador
  let pickedCountry = '';
  const cgrid = $('country-grid'), cpanel = $('country-panel'), cbtn = $('country-btn');
  for (const c of window.RA.countries.list) {
    const b = el('button', 'country-item'); b.type = 'button'; b.dataset.code = c.code; b.dataset.name = c.name.toLowerCase();
    b.setAttribute('role', 'option'); b.title = c.name;
    b.append(window.RA.flag(c.code), el('span', '', c.name));
    cgrid.appendChild(b);
  }
  const closeCountry = () => { cpanel.hidden = true; cbtn.setAttribute('aria-expanded', 'false'); };
  cbtn.addEventListener('click', () => {
    cpanel.hidden = !cpanel.hidden; cbtn.setAttribute('aria-expanded', String(!cpanel.hidden));
    if (!cpanel.hidden) $('country-search').focus();
  });
  $('country-search').addEventListener('input', () => {
    const q = $('country-search').value.trim().toLowerCase();
    for (const b of cgrid.children) b.hidden = q !== '' && !b.dataset.name.includes(q);
  });
  $('country-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); if (e.key === 'Escape') closeCountry(); });
  cgrid.addEventListener('click', (e) => {
    const b = e.target.closest('.country-item'); if (!b) return;
    pickedCountry = b.dataset.code;
    for (const x of cgrid.children) x.classList.toggle('on', x === b);
    cbtn.replaceChildren(window.RA.flag(pickedCountry), el('span', '', window.RA.countries.nameOf(pickedCountry)));
    closeCountry();
  });
  $('tab-login').addEventListener('click', () => setAuthMode('login'));
  $('tab-register').addEventListener('click', () => setAuthMode('register'));

  async function enterMenu() {
    await loadCatalog().catch(() => {});
    show('menu'); refreshRooms();
    net.sync();
    setInterval(() => { if (!$('screen-game').classList.contains('active')) net.sync(3); }, 30000);
  }
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('auth-submit'), msg = $('auth-msg');
    msg.textContent = ''; btn.disabled = true;
    try {
      if (authMode === 'register') {
        if (!pickedCountry) throw new Error('Elige tu nacionalidad.');
        await authCall('auth:register', { nickname: $('nick').value, password: $('pass').value, password2: $('pass2').value, country: pickedCountry });
      } else {
        await authCall('auth:login', { nickname: $('nick').value, password: $('pass').value });
      }
      $('pass').value = ''; $('pass2').value = '';
      await enterMenu();
    } catch (err) { msg.textContent = err.message; }
    btn.disabled = false;
  });
  $('btn-logout').addEventListener('click', () => {
    const done = () => { ls.set('ra_token', ''); location.reload(); };
    net.req('auth:logout').then(done, done);
  });
  // Inicio automático si este navegador ya tiene una sesión guardada
  if (ls.get('ra_token') && ls.get('ra_nick')) {
    resumeSession().then(enterMenu).catch(() => { S.me = null; ls.set('ra_token', ''); });
  }

  net.socket.on('disconnect', () => toast('Conexión perdida. Reconectando…'));
  net.socket.on('connect', () => {
    if (!S.me) return;
    game.stop(); stopQueue(); S.room = null;
    resumeSession().then(() => { show('menu'); net.sync(); toast('Reconectado.'); })
      .catch(() => { S.me = null; ls.set('ra_token', ''); show('login'); toast('Sesión caducada. Inicia sesión de nuevo.'); });
  });

  // ---------- Menú ----------
  // allSongs = canciones integradas + canciones MP3 del servidor (/api/songs)
  const allSongs = SONGS.slice();
  function chartOf(song, difficulty) {
    const d = song.lib ? songs.pickDiff(song, difficulty) : difficulty;
    return { songId: song.songId, durationMs: song.durationMs, totalNotes: song.lib ? songs.notesFor(song, d) : song.totalNotes, difficulty: d };
  }
  function songLabel(s) {
    return `${s.lib ? `${s.name} — ${s.artist}` : s.name} · ${s.bpm} BPM · ${Math.round(s.durationMs / 1000)} s`;
  }
  function fillSongSelects() {
    for (const sel of [$('solo-song'), $('song')]) {
      const prev = sel.value;
      sel.replaceChildren();
      // las 6 canciones de prueba integradas (música generada) ya no se listan: se conservan solo como respaldo interno
      for (const s of allSongs) { if (!s.lib) continue; const o = el('option', '', songLabel(s)); o.value = s.songId; sel.appendChild(o); }
      if (allSongs.some((s) => s.songId === prev)) sel.value = prev;
    }
  }
  async function loadCatalog() {
    const list = (await songs.fetchCatalog()).map(songs.normalize);
    allSongs.length = SONGS.length;
    allSongs.push(...list);
    fillSongSelects();
  }
  $('btn-create').addEventListener('click', () => act(async () => {
    const d = await net.req('room:create', chartOf(allSongs.find((x) => x.lib) || SONGS[0], 'normal')); // primera canción de la biblioteca
    S.autoPickSent = false; S.room = d.room; renderLobby(); show('lobby');
  }));
  $('btn-join').addEventListener('click', () => act(async () => {
    const d = await net.req('room:join', { code: $('join-code').value });
    S.autoPickSent = false; S.room = d.room; renderLobby(); show('lobby');
  }));
  $('btn-refresh').addEventListener('click', () => act(async () => { await loadCatalog().catch(() => {}); await refreshRooms(); }));
  async function refreshRooms() {
    const { rooms } = await net.req('rooms:list');
    const ul = $('room-list');
    ul.replaceChildren();
    if (!rooms.length) { ul.appendChild(el('li', 'empty', 'No hay salas públicas ahora mismo. Crea una y aparecerá aquí.')); return; }
    const DN = { easy: 'Fácil', normal: 'Normal', hard: 'Difícil', expert: 'Experto' };
    for (const r of rooms) {
      const li = el('li', 'room-item');
      const info = el('div', 'room-info');
      info.appendChild(el('strong', '', r.hostNickname));
      info.appendChild(el('span', 'muted', `${r.players}/${r.maxPlayers} jugadores`));
      li.appendChild(info);
      const act2 = el('div', 'room-actions');
      act2.appendChild(el('span', 'chip', DN[r.difficulty] || r.difficulty));
      const b = el('button', '', 'Unirse');
      b.addEventListener('click', () => { $('join-code').value = r.code; $('btn-join').click(); });
      act2.appendChild(b);
      li.appendChild(act2);
      ul.appendChild(li);
    }
  }

  // ---------- Modo un jugador (100 % local, sin servidor) ----------
  fillSongSelects();
  function soloBoard(st) {
    const ol = $('scoreboard');
    ol.replaceChildren();
    const li = el('li');
    li.appendChild(nameEl(S.me.nickname, S.me.country));
    li.appendChild(el('span', '', String(st.score)));
    ol.appendChild(li);
  }
  let loadToken = 0;
  async function startSolo(song, difficulty) {
    const diff = song.lib ? songs.pickDiff(song, difficulty) : difficulty;
    S.solo = { song, difficulty: diff };
    const token = ++loadToken;
    soloBoard({ score: 0 });
    let prepared = {};
    if (song.lib) {
      $('wait').textContent = 'Cargando canción…'; $('wait').hidden = false;
      show('game');
      try {
        prepared = await songs.prepare(song, diff, (p) => { $('wait').textContent = `Cargando canción… ${Math.round(p * 100)} %`; });
      } catch (e) {
        if (token === loadToken) { $('wait').hidden = true; S.solo = null; show('menu'); toast(e.message); }
        return;
      }
      if (token !== loadToken || !S.solo) return; // el jugador salió mientras cargaba
      if (!prepared.buffer) toast('No se pudo cargar el audio: sonará música generada.');
    } else show('game');
    $('wait').hidden = true;
    game.start({
      settings: chartOf(song, diff), meta: song, chart: prepared.chart, audio: prepared.buffer, offsetMs: S.offset,
      startAt: net.now() + 3000, speed: S.speed, volume: S.vol / 100,
      onStats: soloBoard,
      onFinish: (st) => finishSolo(st, song),
    });
  }
  // ---------- Pantalla de resultados ----------
  const DIFF_NAMES = { easy: 'Fácil', normal: 'Normal', hard: 'Difícil', expert: 'Experto' };
  const fmtNum = (n) => Number(n || 0).toLocaleString('es');
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const accuracyOf = (st, total) => Math.round(((st.perfect + st.great * 0.85 + st.good * 0.5) / Math.max(1, total)) * 10000) / 100;
  const gradeOf = (acc) => (acc >= 95 ? 'S' : acc >= 90 ? 'A' : acc >= 80 ? 'B' : acc >= 70 ? 'C' : 'D');
  const GRADE_TEXT = { S: 'Excelente', A: 'Muy bien', B: 'Bien', C: 'Aceptable', D: 'A practicar' };
  const RING_C = 2 * Math.PI * 52;
  let countRaf = 0;

  function countUp(node, to) {
    cancelAnimationFrame(countRaf);
    if (reduceMotion() || to <= 0) { node.textContent = fmtNum(to); return; }
    const t0 = performance.now(), ms = 1100;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      node.textContent = fmtNum(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) countRaf = requestAnimationFrame(step);
    };
    countRaf = requestAnimationFrame(step);
  }

  /**
   * o = { song, difficulty, mode, score, accuracy, maxCombo, total, stats?, rank?, players?, rating?, record?, best?, rows?, ranked? }
   * stats = { perfect, great, good, miss } (solo y propia partida online). rows = clasificación de la sala.
   */
  function renderResults(o) {
    const song = o.song || null;
    const played = o.songs && o.songs.length > 1 ? o.songs : null; // partida por turnos: todas las canciones jugadas
    $('res-mode').textContent = o.mode;
    $('res-song').textContent = played ? played.map((s) => s.name).join(' + ') : song ? song.name : 'Partida';

    // Portada(s) (o inicial con el color de la canción) + datos
    const fillCover = (node, sg) => {
      node.replaceChildren();
      node.style.setProperty('--h', String(sg && sg.hue !== undefined ? sg.hue : 200));
      node.appendChild(el('span', '', sg && sg.name ? sg.name.trim().charAt(0).toUpperCase() : '♪'));
      if (sg && sg.cover) {
        const img = el('img'); img.alt = ''; img.src = sg.cover;
        img.addEventListener('error', () => img.remove());
        node.appendChild(img);
      }
    };
    const cover = $('res-cover');
    cover.parentNode.querySelectorAll('.extra-cover').forEach((n) => n.remove());
    fillCover(cover, played ? played[0] : song);
    if (played) {
      cover.dataset.r = 'R1';
      let prev = cover;
      played.slice(1).forEach((sg, i) => {
        const c = el('div', 'res-cover extra-cover');
        c.dataset.r = `R${i + 2}`; c.setAttribute('aria-hidden', 'true');
        fillCover(c, sg);
        prev.after(c); prev = c;
      });
    } else delete cover.dataset.r;
    const meta = $('res-meta');
    meta.replaceChildren();
    if (played) {
      (o.roundDiffs || []).forEach((df, i) => { if (df) meta.appendChild(el('span', 'chip', `R${i + 1}: ${DIFF_NAMES[df] || df}`)); });
    } else {
      if (song && song.lib && song.artist) meta.appendChild(el('span', 'meta-artist', song.artist));
      if (o.difficulty) meta.appendChild(el('span', 'chip', DIFF_NAMES[o.difficulty] || o.difficulty));
      if (song && song.bpm) meta.appendChild(el('span', 'chip', `${song.bpm} BPM`));
    }
    const rs = played ? S.roundSpeeds.filter(Boolean) : [];
    if (rs.length > 1 && rs.some((v) => v !== rs[0])) meta.appendChild(el('span', 'chip', `Velocidad ${rs.map((v, i) => `R${i + 1} x${v}`).join(' · ')}`));
    else meta.appendChild(el('span', 'chip', `Velocidad x${rs.length ? rs[0] : S.speed}`));

    // Nota
    const grade = gradeOf(o.accuracy);
    const g = $('res-grade');
    g.dataset.g = grade;
    g.setAttribute('aria-label', `Nota ${grade}: ${GRADE_TEXT[grade]}`);
    $('res-grade-letter').textContent = grade;

    // Puntuación e insignias
    countUp($('res-score-val'), o.score);
    const badges = $('res-badges');
    badges.replaceChildren();
    const st = o.stats;
    // 'ap' = All Perfect (todo Perfect, 100 % de precisión) · 'fc' = Full Combo (sin ningún Miss) · null = ninguno.
    // Se calcula con los datos de golpes de cada jugador (los del servidor en online), igual para todos.
    const comboFlag = (s, total) => {
      if (!s || !(total > 0) || s.left || s.miss > 0 || s.perfect + s.great + s.good < total) return null;
      return s.great + s.good === 0 ? 'ap' : 'fc';
    };
    // Tu insignia: en online se usa tu fila del servidor (misma fuente que la tabla); en solo, tus estadísticas locales.
    const myRow = o.rows ? o.rows.find((r) => r.playerId === net.socket.id) : null;
    const myFlag = myRow ? comboFlag(myRow, myRow.totalNotes) : comboFlag(st, o.total);
    if (myFlag) badges.appendChild(el('span', myFlag === 'ap' ? 'pill gold' : 'pill lime', myFlag === 'ap' ? 'All Perfect · 100%' : 'Full Combo'));
    if (o.record) badges.appendChild(el('span', 'pill pink', 'Nuevo récord'));
    else if (o.best && o.best > o.score) badges.appendChild(el('span', 'pill', `Tu récord: ${fmtNum(o.best)}`));
    if (o.rank) badges.appendChild(el('span', 'pill', `Puesto ${o.rank} de ${o.players}`));

    // Anillo de precisión
    const bar = $('res-ring-bar');
    bar.style.strokeDasharray = String(RING_C);
    bar.style.strokeDashoffset = String(RING_C);
    $('res-acc').textContent = `${o.accuracy}%`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.strokeDashoffset = String(RING_C * (1 - Math.max(0, Math.min(100, o.accuracy)) / 100));
    }));

    // Datos rápidos
    const tiles = $('res-stats');
    tiles.replaceChildren();
    const tile = (label, value, cls) => {
      const d = el('div', 'tile' + (cls ? ' ' + cls : ''));
      d.appendChild(el('strong', '', String(value)));
      d.appendChild(el('span', '', label));
      tiles.appendChild(d);
    };
    // En partidas de varias canciones el combo se encadena: es la mejor racha de TODA la partida.
    tile(played ? 'Combo total' : 'Combo máximo', fmtNum(o.maxCombo));
    if (played && o.finalCombo > 0 && o.finalCombo !== o.maxCombo) tile('Combo al terminar', fmtNum(o.finalCombo));
    if (st) tile('Notas acertadas', `${fmtNum(st.perfect + st.great + st.good)} / ${fmtNum(o.total)}`);
    else if (o.total) tile('Notas en la canción', fmtNum(o.total));
    if (o.rating) tile('Rating', `${o.rating.ratingAfter} (${o.rating.ratingChange > 0 ? '+' : ''}${o.rating.ratingChange})`, o.rating.ratingChange >= 0 ? 'pos' : 'neg');
    else if (o.players > 1) tile('Jugadores', o.players);

    // Reparto de golpes
    const judge = $('res-judge');
    judge.hidden = !st;
    if (st) {
      const rows = [['Perfect', st.perfect, 'perfect'], ['Great', st.great, 'great'], ['Good', st.good, 'good'], ['Miss', st.miss, 'miss']];
      const sum = Math.max(1, rows.reduce((a, r) => a + r[1], 0));
      const jb = $('judge-bar'), lg = $('judge-legend');
      jb.replaceChildren(); lg.replaceChildren();
      const segs = [];
      for (const [name, n, cls] of rows) {
        const seg = el('span', 'seg ' + cls);
        seg.style.width = '0%';
        seg.dataset.w = String((n / sum) * 100);
        seg.title = `${name}: ${n}`;
        jb.appendChild(seg); segs.push(seg);
        const li = el('li');
        li.appendChild(el('i', 'dot ' + cls));
        li.appendChild(el('span', 'jn', name));
        li.appendChild(el('strong', '', fmtNum(n)));
        const pct = (n / sum) * 100;
        li.appendChild(el('span', 'jp', `${pct > 0 && pct < 1 ? pct.toFixed(1).replace('.', ',') : Math.round(pct)}%`));
        lg.appendChild(li);
      }
      requestAnimationFrame(() => requestAnimationFrame(() => segs.forEach((s) => { s.style.width = s.dataset.w + '%'; })));
    }

    // Clasificación (solo online)
    const board = $('res-board');
    board.hidden = !(o.rows && o.rows.length);
    if (o.rows && o.rows.length) {
      const table = $('results-table');
      table.replaceChildren();
      const head = el('tr');
      const byRound = o.rows.some((r) => r.rounds && r.rounds.length > 1);
      const showSong = o.ranked && !byRound;
      ['#', 'Jugador', ...(showSong ? ['Canción'] : []), 'Puntos', 'Precisión', byRound ? 'Combo total' : 'Combo', ...(byRound ? ['Por ronda'] : []), ...(o.ranked ? ['Rating'] : [])].forEach((t) => head.appendChild(el('th', '', t)));
      table.appendChild(head);
      for (const r of o.rows) {
        const tr = el('tr', r.playerId === net.socket.id ? 'me' : '');
        const rk = el('td'); rk.appendChild(el('span', 'rk rk' + Math.min(r.rank, 4), String(r.rank))); tr.appendChild(rk);
        [r.nickname + (r.left ? ' (abandonó)' : ''), ...(showSong ? [songName(r.songId)] : []), fmtNum(r.score), r.accuracy + '%', fmtNum(r.maxCombo),
          ...(byRound ? [(r.rounds || []).map((x, i) => `R${i + 1} ${fmtNum(x.score)}`).join(' · ')] : [])].forEach((v, i) => tr.appendChild(i === 0 ? (() => {
          const td = el('td'); td.appendChild(nameEl(String(v), r.country));
          // Insignia junto al nombre de cada jugador que hizo Full Combo / All Perfect
          const fl = comboFlag(r, r.totalNotes);
          if (fl) td.appendChild(el('span', `combo-tag ${fl}`, fl === 'ap' ? 'AP' : 'FC'));
          return td;
        })() : el('td', r.accuracy >= 100 && i === (showSong ? 3 : 2) ?'acc-full' : '', String(v))));
        if (o.ranked) {
          const sign = r.ratingChange > 0 ? '+' : '';
          tr.appendChild(el('td', r.ratingChange >= 0 ? 'pos' : 'neg', `${r.ratingAfter} (${sign}${r.ratingChange})`));
        }
        table.appendChild(tr);
      }
    }
    window.scrollTo(0, 0);
  }

  function finishSolo(st, song) {
    game.stop();
    const diff = S.solo ? S.solo.difficulty : 'normal';
    const total = chartOf(song, diff).totalNotes;
    const key = `ra_best_${song.songId}_${diff}`;
    const prev = Number(ls.get(key)) || 0;
    if (st.score > prev) ls.set(key, String(st.score));
    renderResults({
      song, difficulty: diff, mode: 'Un jugador', score: st.score, accuracy: accuracyOf(st, total), maxCombo: st.maxCombo,
      total, stats: st, record: prev > 0 && st.score > prev, best: Math.max(prev, st.score), players: 1,
    });
    $('btn-rematch').textContent = 'Jugar de nuevo';
    $('btn-rematch').hidden = false;
    show('results');
  }
  $('btn-solo').addEventListener('click', () => {
    const song = allSongs.find((x) => x.songId === $('solo-song').value);
    startSolo(song, $('solo-diff').value);
  });
  $('btn-quit').addEventListener('click', () => act(async () => {
    loadToken += 1;
    game.stop();
    if (S.solo) S.solo = null;
    else { await net.req('room:leave'); S.room = null; }
    show('menu'); refreshRooms();
  }));

  $('btn-fs').addEventListener('click', () => {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } catch (e) { /* no soportado */ }
  });

  // ---------- Clasificatoria online (hasta 6 jugadores) ----------
  // "Jugar online" te mete en una sala de espera. La partida empieza sola al llegar a 6 jugadores, o cuando todos los
  // presentes (mínimo 2) confirman que quieren empezar con los que hay. Después cada jugador elige UNA canción.
  function stopQueue() { $('queue-status').textContent = ''; }
  $('btn-quick').addEventListener('click', () => {
    const btn = $('btn-quick'); btn.disabled = true;
    act(async () => {
      const d = await net.req('online:join');
      S.autoPickSent = false; S.room = d.room; renderLobby(); show('lobby');
    }).finally(() => { btn.disabled = false; });
  });
  $('btn-wait-start').addEventListener('click', () => {
    const me = S.room && S.room.players.find((p) => p.id === net.socket.id);
    act(() => net.req('online:start', { want: !(me && me.wantsStart) }));
  });
  // Premios de la partida con los jugadores actuales, p. ej. "Premios: 1.º +96 · 2.º +80 · 3.º +64" (cambian si entra o sale alguien)
  const prizeText = (r) => (r.prizes && r.prizes.length ? `Premios: ${r.prizes.map((p, i) => `${i + 1}.º +${p}`).join(' · ')}` : '');
  // Sala de espera: puntos de jugadores, cuántos quieren empezar y el botón de confirmar
  function renderWait(r, me) {
    const card = $('wait-card');
    card.hidden = !(r.ranked && r.waiting && r.state === 'lobby');
    if (card.hidden) return;
    const n = r.players.length, max = r.maxPlayers, min = r.minPlayers || 2;
    const voted = r.players.filter((p) => p.wantsStart).length, want = Boolean(me && me.wantsStart);
    const dots = $('wait-dots');
    dots.replaceChildren();
    for (let i = 0; i < max; i += 1) dots.appendChild(el('span', `wait-dot${i < n ? ' on' : ''}`));
    $('wait-title').textContent = `Esperando jugadores · ${n}/${max}`;
    $('wait-prizes').textContent = prizeText(r);
    const btn = $('btn-wait-start');
    btn.disabled = n < min;
    btn.classList.toggle('primary', !want);
    btn.textContent = n < min ? `Faltan jugadores (mínimo ${min})` : want ? 'Cancelar · seguir esperando' : `Empezar con ${n} jugadores`;
    $('wait-text').textContent = n < min
      ? 'Esperando a que entre otro jugador. Puedes salir cuando quieras.'
      : `La partida empieza sola al llegar a ${max} jugadores. Si no quieres esperar, pulsa empezar: arrancará cuando todos lo confirmen (${voted}/${n} quieren empezar). Si entra o sale alguien, hay que confirmar de nuevo.`;
  }

  // ---------- Lobby ----------
  const songSel = $('song');
  // S.slot = canción que se está editando (0 = la primera; 1-3 = extra). Hasta 4 canciones por partida.
  function sendSettings() {
    if (S.room && !S.room.ranked && !isHost()) return; // casual: solo el anfitrión elige las canciones
    const song = allSongs.find((s) => s.songId === songSel.value);
    if (!song) return;
    const extra = S.slot > 0 ? { slot: S.slot } : {};
    act(() => net.req('room:settings', { ...chartOf(song, $('difficulty').value), ...extra }));
  }
  const myPicks = () => {
    const me = S.room && S.room.players.find((p) => p.id === net.socket.id);
    return (me && me.picks) || [];
  };
  function selectSlot(i) {
    if (!S.room || S.room.state !== 'lobby') return;
    if (!S.room.ranked && !isHost()) return;
    const picks = myPicks();
    if (i > picks.length || i >= (S.room.maxSongs || 4)) return;
    S.slot = i;
    if (i < picks.length) {
      // Editar una canción ya elegida: el selector pasa a mostrarla.
      songSel.value = picks[i].songId;
      $('difficulty').value = picks[i].difficulty || 'normal';
    } else {
      // Canción nueva: se propone la siguiente de la lista (para no repetir la anterior) y se envía.
      const opts = [...songSel.options];
      const idx = Math.max(0, opts.findIndex((o) => o.value === songSel.value));
      if (opts.length) songSel.value = opts[(idx + 1) % opts.length].value;
      sendSettings();
    }
    renderLobby();
  }
  function renderSlots(r, picks) {
    const bar = $('slot-bar');
    bar.replaceChildren();
    const max = r.maxSongs || 4;
    for (let i = 0; i < max; i += 1) {
      const has = i < picks.length, isNext = i === picks.length;
      const b = el('button', 'slot' + (has ? ' has' : '') + (i === S.slot ? ' on' : ''));
      b.type = 'button';
      b.disabled = !has && !isNext;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === S.slot));
      b.appendChild(el('span', 'n', `CANCIÓN ${i + 1}`));
      b.appendChild(el('span', 't', has ? songName(picks[i].songId) : isNext ? '+ Añadir' : '—'));
      b.addEventListener('click', () => selectSlot(i));
      bar.appendChild(b);
    }
    $('btn-slot-remove').hidden = !(S.slot >= 1 && S.slot < picks.length);
  }
  // Orden de canciones. Cada jugador fija SU velocidad en cualquier canción (también las de sus rivales) y ve las de los demás en vivo.
  let planRows = [];
  function renderPlan(r) {
    const plan = r.plan || [];
    const ol = $('plan-list');
    $('plan-card').hidden = plan.length === 0;
    const mySpeed = (x) => { const m = (x.speeds || []).find((z) => z.id === net.socket.id); return m ? m.speed : S.speed; };
    const othersText = (x) => (x.speeds || []).filter((z) => z.id !== net.socket.id).map((z) => `${z.nickname} x${z.speed}`).join(' · ');
    // Estructura (orden/canciones/jugadores): si cambia se reconstruye la lista. Si solo cambian velocidades se actualizan
    // los valores en su sitio, para no cerrar un desplegable que el jugador tenga abierto.
    const key = plan.map((x) => `${x.ownerId}|${x.slot}|${x.songId}|${x.difficulty}|${(x.speeds || []).map((z) => z.id).join('/')}`).join(',');
    if (ol.dataset.key === key && planRows.length === plan.length) {
      plan.forEach((x, i) => {
        const row = planRows[i];
        row.others.textContent = othersText(x);
        if (document.activeElement !== row.sel) row.sel.value = String(mySpeed(x));
      });
    } else {
      ol.dataset.key = key;
      ol.replaceChildren();
      planRows = [];
      plan.forEach((x, i) => {
        const li = el('li');
        const sg = allSongs.find((z) => z.songId === x.songId);
        const left = el('span', '', `${i + 1}. ${songName(x.songId)}`);
        if (sg && sg.bpm) left.appendChild(el('span', 'muted plan-bpm', ` · ${sg.bpm} BPM`));
        li.appendChild(left);
        const right = el('span', 'plan-right');
        right.appendChild(el('span', 'muted', `${x.ownerId === net.socket.id ? 'tuya' : x.ownerNickname} · ${DIFF_NAMES[x.difficulty] || x.difficulty}`));
        const others = el('span', 'plan-others', othersText(x)); // velocidades de los demás jugadores en esta canción
        right.appendChild(others);
        const sel = el('select', 'plan-speed');
        sel.setAttribute('aria-label', `Tu velocidad en la canción ${i + 1}`);
        SPEEDS.forEach((v) => { const o = el('option', '', `x${v}`); o.value = String(v); sel.appendChild(o); });
        sel.value = String(mySpeed(x));
        sel.addEventListener('change', () => {
          net.req('room:speed', { ownerId: x.ownerId, slot: x.slot, speed: Number(sel.value) })
            .catch((e) => { toast(e.message); sel.value = String(mySpeed(x)); });
        });
        right.appendChild(sel);
        li.appendChild(right);
        ol.appendChild(li);
        planRows.push({ others, sel });
      });
    }
    const cap = r.totalSongs || r.maxSongs || 4;
    $('plan-note').textContent = plan.length
      ? `Se jugarán ${plan.length} ${plan.length === 1 ? 'canción' : 'canciones'} seguidas (máx. ${cap}). El combo continúa de una a otra y al final se muestra el combo total. Cada jugador elige su propia velocidad en cada canción (también en las de sus rivales) y las demás se ven en tiempo real.`
      : '';
  }
  $('btn-slot-remove').addEventListener('click', () => act(async () => {
    if (S.slot < 1) return;
    const slot = S.slot;
    S.slot = slot - 1;
    await net.req('room:settings', { slot, remove: true });
  }));
  // El selector visual dispara 'change' al recorrer la rueda: se envía al servidor al dejar de moverla.
  let pickSend = 0;
  songSel.addEventListener('change', () => {
    S.pickPending = true; clearTimeout(pickSend);
    pickSend = setTimeout(() => { S.pickPending = false; sendSettings(); }, 350);
  });
  $('difficulty').addEventListener('change', sendSettings);
  // Modo de juego de la sala casual: lo fija el anfitrión y se aplica a todos los jugadores.
  $('lobby-mode').addEventListener('change', () => {
    if (S.syncingMode || !S.room || S.room.state !== 'lobby' || S.room.ranked || !isHost()) return;
    act(() => net.req('room:mode', { mode: $('lobby-mode').value }));
  });
  $('btn-start').addEventListener('click', () => act(() => net.req('room:start')));
  $('btn-ready').addEventListener('click', () => {
    const me = S.room.players.find((p) => p.id === net.socket.id);
    act(() => net.req('room:ready', { ready: !(me && me.ready) }));
  });
  $('btn-leave').addEventListener('click', () => act(async () => {
    await net.req('room:leave'); S.room = null; show('menu'); refreshRooms();
  }));

  // Temporizador de selección de canción (solo clasificatoria)
  let pickTimer = 0;
  function stopPickTimer() {
    clearInterval(pickTimer); pickTimer = 0;
    const i = $('pick-info'); if (i) i.hidden = true;
    const c = $('pick-clock'); if (c) c.hidden = true;
  }
  function renderPickTimer(r) {
    clearInterval(pickTimer); pickTimer = 0;
    const info = $('pick-info');
    if (!r.ranked || r.state !== 'lobby' || r.waiting) { info.hidden = true; $('pick-clock').hidden = true; return; }
    // Hay un tiempo límite (3 min): la partida empieza en cuanto todos han elegido sus canciones y están listos.
    // Si se agota, el servidor completa al azar las canciones que falten y empieza.
    const me = r.players.find((p) => p.id === net.socket.id);
    const ready = r.players.filter((p) => p.ready).length;
    const clock = $('pick-clock');
    const tick = () => {
      if (r.pickDeadline) {
        const left = Math.max(0, Math.ceil((r.pickDeadline - net.now()) / 1000));
        $('pick-clock-val').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        clock.classList.toggle('low', left <= 30); // últimos 30 s: se pone rojo y parpadea
        clock.hidden = false;
        if (left <= 0) clearInterval(pickTimer);
      } else clock.hidden = true;
      info.textContent = `Cada jugador elige 1 canción (${r.players.length} en total). `
        + `${prizeText(r)}${r.prizes && r.prizes.length ? ' pts. ' : ''}`
        + `Cuando todos estén listos empieza la partida (${ready}/${r.players.length} listos).`
        + (r.pickDeadline ? ' Si se acaba el tiempo, se elige al azar la canción de quien no la haya elegido.' : '');
    };
    info.hidden = false; tick();
    if (r.pickDeadline) pickTimer = setInterval(tick, 500);
  }

  const songName = (id) => { const s = allSongs.find((x) => x.songId === id); return s ? s.name : id || ''; };

  function renderLobby() {
    const r = S.room;
    const me = r.players.find((p) => p.id === net.socket.id);
    if (S.lobbyCode !== r.code) {
      S.lobbyCode = r.code; S.slot = 0; lobbyChatReset(); // sala nueva: se empieza editando la canción 1
      net.req('room:speed', { base: S.speed }).catch(() => {}); // tu velocidad general, visible para el resto
    }
    const picks = (me && me.picks) || [];
    if (S.slot > picks.length) S.slot = Math.max(0, picks.length - 1);
    const cur = picks[S.slot] || (S.slot === 0 ? r.settings : null); // canción que muestra el selector
    $('lobby-code').textContent = r.ranked ? '(clasificatoria)' : r.code;
    const song = allSongs.find((s) => s.songId === (cur && cur.songId));
    const label = song ? `${song.name} (${song.bpm} BPM)` : (cur && cur.songId) || 'Sin canción';
    const guestCasual = !r.ranked && !isHost();
    const waiting = Boolean(r.ranked && r.waiting);
    if (waiting) {
      $('lobby-info').textContent = `Clasificatoria online · ${r.players.length}/${r.maxPlayers} jugadores`;
    } else if (guestCasual) {
      // Invitado en sala casual: solo ve lo que ha elegido el anfitrión.
      const names = (r.plan || []).map((x) => songName(x.songId));
      const list = names.length ? names.join(' + ') : 'el anfitrión aún no ha elegido canciones';
      $('lobby-info').textContent = `Canciones del anfitrión: ${list} · ${r.players.length}/${r.maxPlayers} jugadores`;
    } else {
      $('lobby-info').textContent = `Tu canción ${S.slot + 1}: ${label} · ${(cur && cur.difficulty) || ''} · ${r.players.length}/${r.maxPlayers} jugadores`;
    }
    const ul = $('players');
    ul.replaceChildren();
    // Por turnos: el anfitrión primero, luego cada jugador por orden de entrada (el orden exacto está en "Orden de canciones").
    const order = [...r.players.filter((p) => p.isHost), ...r.players.filter((p) => !p.isHost)];
    for (const p of order) {
      const li = el('li');
      const left = el('span', '', `${p.nickname} (${p.rating})`);
      { const f = window.RA.flag(p.country); if (f) left.prepend(f); }
      if (p.isHost && !r.ranked) left.appendChild(el('span', 'badge', 'anfitrión'));
      if (!waiting && (r.ranked || p.isHost)) {
        const names = p.picks && p.picks.length ? p.picks.map((x) => songName(x.songId)).join(' + ') : '';
        left.appendChild(el('span', 'muted', names ? ` · ${names}` : p.song ? ` · ${songName(p.song.songId)}` : ' · eligiendo…'));
      }
      li.appendChild(left);
      const ready = waiting ? Boolean(p.wantsStart) : p.ready || (p.isHost && !r.ranked);
      const label = waiting ? (ready ? 'quiere empezar' : 'esperando') : (ready ? 'listo' : 'esperando');
      li.appendChild(el('span', ready ? 'badge ok' : 'badge', label));
      ul.appendChild(li);
    }

    // Casual: solo el anfitrión elige la canción. Clasificatoria: cada jugador elige la SUYA.
    // Casual por turnos: todos eligen SU canción; se juega primero la del anfitrión y luego la de cada jugador.
    $('lobby-chat').hidden = !r.ranked;
    $('host-controls').hidden = (!r.ranked && !isHost()) || waiting; // casual: los invitados no ven el selector de canciones
    $('btn-start').hidden = r.ranked || !isHost(); // la clasificatoria arranca sola cuando todos están listos
    $('host-controls-hint').hidden = false;
    $('host-controls-hint').textContent = r.ranked
      ? 'Elige tu canción: cada jugador elige una. Se juegan por turnos y el combo continúa de una a la siguiente.'
      : `Solo tú, como anfitrión, eliges las canciones de la sala: de 1 a ${r.maxSongs || 4}. Las jugáis todos seguidas, en el orden que las pongas, y el combo continúa de una a la siguiente.`;
    $('btn-ready').hidden = (!r.ranked && isHost()) || waiting;
    renderWait(r, me);
    $('btn-ready').textContent = me && me.ready ? 'Cancelar listo' : 'Estoy listo';
    if (cur && cur.songId && !S.pickPending) songSel.value = cur.songId;
    if (cur && cur.difficulty) $('difficulty').value = cur.difficulty;
    renderSlots(r, picks);
    renderPlan(r);
    if (guestCasual && $('plan-note').textContent) $('plan-note').textContent += ' Solo el anfitrión elige las canciones: tú solo puedes elegir la velocidad a la que juegas cada una.';
    // Casual: el modo de juego es de toda la sala. El anfitrión lo elige; el invitado solo ve cuál es (y elige su velocidad).
    for (const e of [document.querySelector('label[for="lobby-mode"]'), $('lobby-mode'), $('lobby-mode-desc')]) if (e) e.hidden = guestCasual;
    const modeLabel = document.querySelector('label[for="lobby-mode"]');
    if (modeLabel) modeLabel.textContent = r.ranked ? 'Tu modo de juego' : 'Modo de juego de la sala (para todos)';
    if (!r.ranked && r.mode && $('lobby-mode').value !== r.mode && document.activeElement !== $('lobby-mode')) {
      S.syncingMode = true;
      $('lobby-mode').value = r.mode;
      $('lobby-mode').dispatchEvent(new Event('change')); // actualiza la descripción del modo
      S.syncingMode = false;
    }
    if (guestCasual) {
      const MODE_NAMES = { normal: 'Normal', survival: 'Supervivencia', super: 'Super Perfect' };
      $('lobby-info').textContent += ` · Modo: ${MODE_NAMES[r.mode] || 'Normal'}`;
    }
    if (r.plan) S.roundPlan = r.plan; // para precargar la canción de la ronda siguiente durante la partida

    // Clasificatoria: si aún no has elegido, se registra la canción que muestra el selector.
    if (r.ranked && !r.waiting && r.state === 'lobby' && me && !me.picked && !S.autoPickSent && allSongs.some((s) => s.songId === songSel.value)) {
      S.autoPickSent = true;
      sendSettings();
    }
    renderPickTimer(r);

    const picked = allSongs.find((s) => s.songId === (cur && cur.songId));
    if (picked && picked.lib) songs.prefetch(picked, cur.difficulty); // precarga mientras esperan en el lobby
  }

  // ---------- Eventos de sala y partida ----------
  net.socket.on('room:state', (room) => {
    const was = S.room;
    S.room = room;
    if (was && was.code === room.code && was.waiting && !room.waiting && room.state === 'lobby') toast('¡Empieza la partida! Elige tu canción.');
    if (room.state === 'lobby') { game.stop(); renderLobby(); show('lobby'); }
    else stopPickTimer();
    if (room.state === 'finished') $('btn-rematch').hidden = room.ranked || !isHost();
  });
  net.socket.on('room:notice', (n) => {
    toast(`${n.nickname} ${n.type === 'player_joined' ? 'entró a' : 'salió de'} la sala`);
  });
  net.socket.on('room:closed', (d) => {
    const WHY = {
      opponent_left: 'los demás jugadores abandonaron antes de empezar', no_pick: 'no elegiste canción a tiempo',
      not_enough_players: 'no hay suficientes jugadores', empty: 'sala vacía', expired: 'sala expirada',
    };
    stopPickTimer(); game.stop(); stopQueue(); S.room = null; show('menu');
    if (d.reason !== 'empty') toast('Sala cerrada: ' + (WHY[d.reason] || d.reason)); // 'empty': saliste tú mismo
    refreshRooms().catch(() => {});
  });
  net.socket.on('profile:update', (p) => { S.me = p; renderMe(); });

  // ---------- Jugadores conectados ----------
  // El servidor emite 'presence:update' { count } al entrar/salir alguien y al conectarse (solo el número, sin apodos).
  S.online = { count: 0 };
  const hueOf = (n) => { let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  function renderOnline() {
    const n = S.online.count;
    $('login-online').textContent = n === 1 ? '1 jugador conectado' : `${n} jugadores conectados`;
    $('online-badge-text').textContent = `${n} en línea`;
    $('online-count').textContent = String(n);
    $('online-summary-num').textContent = String(n);
    $('online-summary-txt').textContent = n === 1 ? 'jugador conectado' : 'jugadores conectados';
  }
  net.socket.on('presence:update', (d) => {
    if (!d || !Number.isFinite(d.count)) return;
    S.online = { count: Math.max(0, d.count | 0) };
    renderOnline();
  });
  renderOnline();

  // Chat global: mensajes del servidor ('globalchat:history' al entrar, 'globalchat:message' en vivo)
  const gLog = $('gchat-log');
  function gchatEmpty() { gLog.replaceChildren(el('div', 'empty', 'Aún no hay mensajes. ¡Escribe el primero!')); }
  function gchatAdd(m, log = log) {
    if (!m || typeof m.text !== 'string' || typeof m.nickname !== 'string') return;
    if (log.querySelector('.empty')) log.replaceChildren();
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const mine = S.me && m.nickname === S.me.nickname;
    const row = el('div', mine ? 'gchat-msg me' : 'gchat-msg');
    const nick = el('span', 'nick', m.nickname.slice(0, 16));
    { const f = window.RA.flag(m.country); if (f) nick.prepend(f); }
    nick.style.color = mine ? '' : `hsl(${hueOf(m.nickname)},90%,70%)`;
    const d = new Date(Number(m.at) || Date.now());
    const time = el('span', 'time', `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    row.append(nick, document.createTextNode(m.text.slice(0, 200)), time);
    log.appendChild(row);
    while (log.children.length > 100) log.removeChild(log.firstChild);
    if (nearBottom || mine) log.scrollTop = log.scrollHeight;
  }
  gchatEmpty();

  // Pestañas de la tarjeta: Salas públicas / Conectados (chat)
  function showTab(which) {
    const online = which === 'online';
    for (const [id, on] of [['rooms', !online], ['online', online]]) {
      $('tab-' + id).classList.toggle('on', on);
      $('tab-' + id).setAttribute('aria-selected', String(on));
      $('pane-' + id).hidden = !on;
    }
    if (online) { $('tab-online').classList.remove('unread'); gLog.scrollTop = gLog.scrollHeight; }
  }
  $('tab-rooms').addEventListener('click', () => showTab('rooms'));
  $('tab-online').addEventListener('click', () => showTab('online'));
  $('online-badge').addEventListener('click', () => {
    showTab('online');
    $('tab-online').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  net.socket.on('globalchat:history', (list) => {
    gLog.replaceChildren();
    if (Array.isArray(list)) list.forEach(gchatAdd);
    if (!gLog.children.length) gchatEmpty();
    gLog.scrollTop = gLog.scrollHeight;
  });
  net.socket.on('globalchat:message', (m) => {
    gchatAdd(m);
    if ($('pane-online').hidden && m && S.me && m.nickname !== S.me.nickname) $('tab-online').classList.add('unread');
  });
  $('gchat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('gchat-input'), text = input.value.trim();
    if (!text) return;
    input.value = '';
    try { await net.req('globalchat:send', { text }); }
    catch (err) { input.value = text; toast(err.message); }
  });

  const addStats = (a, b) => (a ? {
    score: a.score + b.score, combo: b.combo, maxCombo: Math.max(a.maxCombo, b.maxCombo),
    perfect: a.perfect + b.perfect, great: a.great + b.great, good: a.good + b.good, miss: a.miss + b.miss,
  } : { ...b });
  net.socket.on('game:countdown', async (d) => {
    // Casual por turnos: el servidor manda la canción de la ronda; en clasificatoria cada uno usa la suya.
    const settings = d.chart ? { ...S.room.settings, ...d.chart } : S.room.settings;
    if (!d.round || d.round === 1) { S.sumStats = null; S.roundSpeeds = []; gameChatOpen(false); }
    $('gamechat').hidden = !(S.room && S.room.ranked); // el chat de partida solo existe en clasificatoria
    // Mi velocidad en esta canción, la que puse en el lobby: la manda el servidor (respaldo: el plan guardado o la general).
    const planRound = S.roundPlan && S.roundPlan[(d.round || 1) - 1];
    const mine = planRound && (planRound.speeds || []).find((z) => z.id === net.socket.id);
    const roundSpeed = Number(d.speed) >= 1 ? Number(d.speed) : (mine ? mine.speed : S.speed);
    S.roundSpeeds[(d.round || 1) - 1] = roundSpeed;
    // El combo continúa entre canciones: el servidor dice con cuánto entras en esta ronda (0 en la primera).
    let carry = null;
    if (d.round > 1) {
      carry = (S.room && S.room.carry) || (S.lastStats ? { combo: S.lastStats.combo, maxCombo: S.lastStats.maxCombo } : null);
    }
    if (d.totalRounds > 1) {
      const owner = d.ownerId === net.socket.id ? 'tu canción' : `canción de ${d.ownerNickname}`;
      const keep = carry && carry.combo > 0 ? ` · combo x${carry.combo} continúa` : '';
      toast(`Canción ${d.round}/${d.totalRounds}: ${songName(settings.songId)} (${owner}) · velocidad x${roundSpeed}${keep}`);
    }
    let song = allSongs.find((s) => s.songId === settings.songId);
    if (!song) { await loadCatalog().catch(() => {}); song = allSongs.find((s) => s.songId === settings.songId); }
    let chart = null, buffer = null;
    if (song && song.lib) {
      const diff = songs.pickDiff(song, settings.difficulty);
      buffer = songs.loadAudio(song).catch(() => null); // sin esperar: si llega tarde, entra en el punto correcto
      try { chart = await songs.loadChart(song, diff); } catch (e) { /* se gestiona abajo */ }
      if (!chart) {
        toast('No se pudo cargar el chart de la canción.');
        net.req('game:finish', { score: 0, combo: 0, maxCombo: carry ? carry.maxCombo : 0, perfect: 0, great: 0, good: 0, miss: settings.totalNotes }).catch(() => {});
        return;
      }
    }
    $('wait').textContent = 'Terminaste. Esperando al resto…';
    S.lastStats = null;
    $('wait').hidden = true; $('scoreboard').replaceChildren();
    show('game');
    game.start({
      settings, meta: song, chart, audio: buffer, offsetMs: S.offset,
      startAt: d.startAt,
      mode: (S.room && !S.room.ranked && S.room.mode) || $('lobby-mode').value, // casual: modo de la sala (lo fija el anfitrión); clasificatoria: el tuyo
      carry,
      speed: roundSpeed,
      volume: S.vol / 100,
      onStats: (stats) => net.socket.emit('game:score', stats),
      onFinish: (stats) => {
        S.lastStats = stats;
        S.sumStats = addStats(S.sumStats, stats);
        $('wait').hidden = false;
        net.req('game:finish', stats).catch((e) => toast(e.message));
      },
    });
    // Precarga la canción de la ronda siguiente mientras se juega esta (el hueco entre canciones es corto).
    const next = d.totalRounds > 1 && S.roundPlan ? S.roundPlan[d.round] : null;
    const nextSong = next ? allSongs.find((s) => s.songId === next.songId) : null;
    if (nextSong && nextSong.lib) { try { songs.prefetch(nextSong, next.difficulty); } catch (e) { /* solo es una optimización */ } }
  });
  // ---------- Chat de la partida (clasificatoria) ----------
  // El servidor reenvía 'chat:message' a toda la sala. Los mensajes antiguos se desvanecen solos; al abrir el chat se ven todos.
  const gcBox = $('gamechat'), gcLog = $('gamechat-log'), gcForm = $('gamechat-form'), gcInput = $('gamechat-input'), gcToggle = $('gamechat-toggle');
  function gameChatOpen(open) {
    gcForm.hidden = !open;
    gcBox.classList.toggle('open', open);
    gcToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      gcToggle.classList.remove('unread');
      gcLog.scrollTop = gcLog.scrollHeight;
      gcInput.focus();
    } else gcInput.blur();
  }
  function gameChatReset() {
    gcLog.replaceChildren();
    gcInput.value = '';
    gcToggle.classList.remove('unread');
    gameChatOpen(false);
  }
  function gameChatAdd(m) {
    if (!m || typeof m.text !== 'string' || typeof m.nickname !== 'string') return;
    const mine = S.me && m.nickname === S.me.nickname;
    const row = el('div', mine ? 'gc-msg me' : 'gc-msg');
    const nick = el('span', 'nick', m.nickname.slice(0, 16));
    { const f = window.RA.flag(m.country); if (f) nick.prepend(f); }
    nick.style.color = mine ? '' : `hsl(${hueOf(m.nickname)},90%,70%)`;
    row.append(nick, document.createTextNode(m.text.slice(0, 200)));
    gcLog.appendChild(row);
    while (gcLog.children.length > 50) gcLog.removeChild(gcLog.firstChild);
    gcLog.scrollTop = gcLog.scrollHeight;
    setTimeout(() => row.classList.add('old'), 8000);
    if (!mine && gcForm.hidden) gcToggle.classList.add('unread');
  }
  net.socket.on('chat:message', (m) => {
    if (!S.room || !S.room.ranked) return;
    gameChatAdd(m);
    gchatAdd(m, $('lobby-chat-log'));
  });
  // Chat del lobby de la clasificatoria (mismo canal que el de la partida)
  function lobbyChatReset() {
    const log = $('lobby-chat-log');
    log.replaceChildren(el('div', 'empty', 'Escribe para saludar a tus rivales.'));
    gcLog.replaceChildren();
  }
  $('lobby-chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('lobby-chat-input'), text = input.value.trim();
    if (!text) return;
    input.value = '';
    try { await net.req('chat:message', { text }); }
    catch (err) { input.value = text; toast(err.message); }
  });
  gcToggle.addEventListener('click', () => gameChatOpen(gcForm.hidden));
  // Las teclas escritas en el chat no deben llegar al juego (D F J K...) ni a ningún atajo de la página.
  for (const ev of ['keydown', 'keyup', 'keypress']) {
    gcInput.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (ev === 'keydown' && e.key === 'Escape') gameChatOpen(false);
    });
  }
  gcForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = gcInput.value.trim();
    if (!text) return;
    gcInput.value = '';
    try { await net.req('chat:message', { text }); }
    catch (err) { gcInput.value = text; toast(err.message); }
  });

  net.socket.on('game:scoreboard', (d) => {
    const ol = $('scoreboard');
    ol.replaceChildren();
    for (const row of d.scoreboard) {
      const li = el('li');
      li.appendChild(nameEl(row.nickname, row.country, row.left));
      li.appendChild(el('span', '', String(row.score)));
      ol.appendChild(li);
    }
  });

  // ---------- Resultados ----------
  net.socket.on('game:results', (d) => {
    game.stop();
    S.solo = null;
    $('btn-rematch').textContent = 'Revancha';
    const mine = d.results.find((r) => r.playerId === net.socket.id) || null;
    const settings = (S.room && S.room.settings) || {};
    const multi = mine && Array.isArray(mine.rounds) && mine.rounds.length > 1;
    const song = multi ? null : allSongs.find((s) => s.songId === settings.songId) || null;
    const st = (multi ? S.sumStats : S.lastStats) || null;
    const totalNotes = mine && mine.totalNotes ? mine.totalNotes : settings.totalNotes || 0;
    // Canciones jugadas (en orden de ronda): se toma el resultado con más rondas por si alguien abandonó antes.
    const full = d.results.reduce((b, r) => (r.rounds && r.rounds.length > (b && b.rounds ? b.rounds.length : 0) ? r : b), null);
    const songsPlayed = full && full.rounds.length > 1
      ? full.rounds.map((r) => allSongs.find((s) => s.songId === r.songId) || { name: songName(r.songId) })
      : null;
    renderResults({
      songs: songsPlayed, roundDiffs: songsPlayed ? full.rounds.map((r) => r.difficulty) : null,
      song, difficulty: multi ? null : settings.difficulty, mode: d.ranked ? 'Clasificatoria' : multi ? 'Sala · por turnos' : 'Sala',
      score: mine ? mine.score : st ? st.score : 0,
      accuracy: mine ? Number(mine.accuracy) || 0 : st ? accuracyOf(st, totalNotes) : 0,
      maxCombo: mine ? mine.maxCombo : st ? st.maxCombo : 0,
      finalCombo: mine && mine.finalCombo ? mine.finalCombo : 0,
      total: totalNotes, stats: st, rank: mine ? mine.rank : null, players: d.results.length,
      rating: d.ranked && mine && typeof mine.ratingAfter === 'number' ? mine : null,
      rows: d.results, ranked: d.ranked,
    });
    $('btn-rematch').hidden = d.ranked || !isHost();
    show('results');
  });
  $('btn-rematch').addEventListener('click', () => act(async () => {
    if (S.solo) { startSolo(S.solo.song, S.solo.difficulty); return; }
    await net.req('room:rematch');
  }));
  $('btn-menu').addEventListener('click', () => act(async () => {
    if (S.solo) S.solo = null;
    else { await net.req('room:leave'); S.room = null; }
    $('btn-rematch').textContent = 'Revancha';
    show('menu'); refreshRooms();
  }));
})();
