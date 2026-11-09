'use strict';

/**
 * Rhythm Arena Online - Servidor principal
 * Express (estáticos + endpoints REST mínimos) + Socket.IO (tiempo real).
 *
 * Contrato de eventos (cliente -> servidor), todos admiten callback `ack`:
 *   time:sync          { clientTime }                       -> { clientTime, serverTime }
 *   session:hello      { nickname, clientId? }              -> { clientId, nickname, rating, games }
 *   rooms:list                                              -> { rooms }
 *   room:create        { songId, durationMs, totalNotes, difficulty, maxPlayers, isPrivate } (todos opcionales)
 *   room:join          { code }
 *   room:leave
 *   room:ready         { ready }
 *   room:settings      { songId, durationMs, totalNotes, difficulty, maxPlayers, isPrivate, slot?, remove? }
 *                        - sala casual: el anfitrión elige su 1.ª canción (la de la sala); cada invitado la suya
 *                        - sala clasificatoria: cualquier jugador, y SOLO afecta a su propia canción
 *                          (songId, difficulty); `maxPlayers` e `isPrivate` se ignoran
 *                        - `slot` (1-3) = canción extra del jugador (hasta 4 canciones por partida, se
 *                          juegan por turnos y el combo continúa de una a otra); `remove: true` la quita
 *   room:speed         { base } | { ownerId, slot, speed }   tu velocidad de juego (general o por canción); la ven todos
 *   room:mode          { mode }                             modo de juego de toda la sala casual (solo anfitrión)
 *   room:start                                              (solo anfitrión)
 *   room:rematch                                            (solo anfitrión)
 *   game:score         { score, combo, maxCombo, perfect, great, good, miss }
 *   game:finish        { ...igual que game:score } (opcional)
 *   chat:message       { text }
 *   matchmaking:join   { mode? }
 *   matchmaking:leave
 *   matchmaking:status
 *
 * Eventos (servidor -> cliente):
 *   room:state, room:notice, room:closed, game:countdown, game:start,
 *   game:scoreboard, game:results, profile:update, chat:message,
 *   matchmaking:found, matchmaking:timeout, server:error
 *
 * Formato de ack: { ok: true, data } | { ok: false, error: { code, message } }
 */

require('dotenv').config();

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');

const {
  LIMITS,
  fail,
  isPlainObject,
  validateNickname,
  validateClientId,
  normalizeRoomCode,
  validateRoomSettings,
  validateReady,
  validateScorePayload,
  validateSlot,
  validateSpeed,
  validateChatMessage,
  validateTimeSync,
  validateMatchmakingMode,
  createRateLimiter,
} = require('./src/validation');
const { RoomManager } = require('./src/rooms');
const { Matchmaker } = require('./src/matchmaking');
const { createSongLibrary } = require('./songs');

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------

const log = {
  info: (...args) => console.log(new Date().toISOString(), '[info]', ...args),
  warn: (...args) => console.warn(new Date().toISOString(), '[warn]', ...args),
  error: (...args) => console.error(new Date().toISOString(), '[error]', ...args),
};

function envInt(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    log.warn(`Valor inválido para ${name}="${raw}". Se usa ${fallback}.`);
    return fallback;
  }
  return n;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function parseOrigins(raw, port) {
  if (!raw || raw.trim() === '') return [`http://localhost:${port}`];
  if (raw.trim() === '*') return '*';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = envInt('PORT', 3000, { min: 1, max: 65535 });

const MAX_PLAYERS = envInt('MAX_PLAYERS_PER_ROOM', 4, { min: 2, max: LIMITS.ROOM_PLAYERS_MAX });
const MIN_PLAYERS = envInt('MIN_PLAYERS_TO_START', 2, { min: 2, max: MAX_PLAYERS });

const config = {
  port: PORT,
  host: process.env.HOST || '0.0.0.0',
  trustProxy: envBool('TRUST_PROXY', false),
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN, PORT),
  maxConnectionsPerIp: envInt('MAX_CONNECTIONS_PER_IP', 10, { min: 1 }),
  rateBurst: envInt('RATE_LIMIT_BURST', 30, { min: 1 }),
  ratePerSec: envInt('RATE_LIMIT_PER_SEC', 10, { min: 1 }),
  gameRatePerSec: envInt('GAME_RATE_LIMIT_PER_SEC', 20, { min: 1 }),
  initialRating: envInt('INITIAL_RATING', 1000, { min: 0 }),
  songsDir: process.env.SONGS_DIR || path.join(__dirname, 'demo'),
  rankedUseLibrary: envBool('RANKED_USE_LIBRARY', false), // añade las canciones de la biblioteca al pool clasificatorio
  maxProfiles: envInt('MAX_PROFILES', 5000, { min: 100 }),
  rooms: {
    maxPlayers: MAX_PLAYERS,
    minPlayersToStart: MIN_PLAYERS,
    codeLength: envInt('ROOM_CODE_LENGTH', 5, { min: 4, max: 8 }),
    maxRooms: envInt('MAX_ROOMS', 1000, { min: 1 }),
    countdownMs: envInt('COUNTDOWN_MS', 5000, { min: 1000, max: 30000 }),
    finishGraceMs: envInt('FINISH_GRACE_MS', 10000, { min: 0 }),
    scoreboardIntervalMs: envInt('SCOREBOARD_INTERVAL_MS', 250, { min: 50 }),
    rankedRoomTtlMs: envInt('RANKED_ROOM_TTL_MS', 60000, { min: 1000 }),
    rankedPickMs: envInt('RANKED_PICK_MS', 180000, { min: 5000, max: 600000 }), // tiempo para elegir canciones y dar listo (3 min)
    casualRoomTtlMs: envInt('CASUAL_ROOM_TTL_MS', 600000, { min: 1000 }),
    ratingK: envInt('RATING_K_FACTOR', 32, { min: 1, max: 200 }),
  },
  matchmaking: {
    tickMs: envInt('MATCHMAKING_TICK_MS', 1000, { min: 200 }),
    baseWindow: envInt('MATCHMAKING_BASE_WINDOW', 100, { min: 0 }),
    windowGrowthPerSec: envInt('MATCHMAKING_WINDOW_GROWTH_PER_SEC', 25, { min: 0 }),
    maxWindow: envInt('MATCHMAKING_MAX_WINDOW', 1500, { min: 0 }),
    matchSize: envInt('MATCHMAKING_MATCH_SIZE', 4, { min: 2, max: MAX_PLAYERS }),
    minPlayers: envInt('MATCHMAKING_MIN_PLAYERS', 2, { min: 2, max: MAX_PLAYERS }),
    partialAfterMs: envInt('MATCHMAKING_PARTIAL_AFTER_MS', 15000, { min: 0 }),
    maxQueueMs: envInt('MATCHMAKING_MAX_QUEUE_MS', 120000, { min: 5000 }),
  },
};

/** Formato: id|dificultad|duracionMs|totalNotas ; id|dificultad|duracionMs|totalNotas */
function parseRankedSongs(raw) {
  if (!raw || raw.trim() === '') return [];
  const songs = [];
  for (const entry of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [songId, difficulty, durationMs, totalNotes] = entry.split('|').map((s) => s.trim());
    const parsed = validateRoomSettings({
      songId,
      difficulty,
      durationMs: Number(durationMs),
      totalNotes: Number(totalNotes),
    });
    if (!parsed.ok) {
      log.warn(`RANKED_SONGS: entrada ignorada "${entry}" (${parsed.error.message})`);
      continue;
    }
    songs.push(parsed.value);
  }
  return songs;
}

const rankedSongs = parseRankedSongs(process.env.RANKED_SONGS);
if (rankedSongs.length === 0 && !config.rankedUseLibrary) {
  log.warn('RANKED_SONGS vacío y RANKED_USE_LIBRARY=0: si un jugador no elige canción a tiempo, será expulsado de la partida en vez de recibir una al azar.');
}

/**
 * Canciones integradas del cliente (public/js/game.js). El servidor no las genera, solo conoce sus ids
 * para rechazar ids inventados. Mantén esta lista en sincronía con SONGS de game.js.
 */
const BUILTIN_SONG_IDS = new Set(['quick-demo', 'neon-pulse', 'cyber-drift', 'pixel-rush', 'midnight-grid', 'solar-flare']);

// ---------------------------------------------------------------------
// Servicios
// ---------------------------------------------------------------------

const library = createSongLibrary({ dir: config.songsDir });
// `autoPick` se usa en clasificatoria cuando alguien no elige canción a tiempo (pickRankedSong es una
// declaración de función, está disponible aquí por hoisting y se evalúa de forma diferida).
const rooms = new RoomManager({ ...config.rooms, autoPick: () => pickRankedSong() });
const matchmaker = new Matchmaker(config.matchmaking);

const generalLimiter = createRateLimiter({ capacity: config.rateBurst, refillPerSec: config.ratePerSec });
const gameLimiter = createRateLimiter({ capacity: config.gameRatePerSec * 2, refillPerSec: config.gameRatePerSec });
const chatLimiter = createRateLimiter({ capacity: 5, refillPerSec: 1 });

/**
 * Perfiles en memoria (clientId -> perfil). El rating NO sobrevive a un reinicio
 * del servidor. Para persistirlo, sustituye este Map por una base de datos.
 * Nota: el clientId actúa como credencial ligera; no lo expongas a otros jugadores.
 */
const profiles = new Map();

function getProfile(clientId, nickname) {
  let profile = profiles.get(clientId);
  if (profile) {
    profiles.delete(clientId); // reinserta al final (LRU sencillo)
  } else {
    profile = { clientId, nickname, rating: config.initialRating, games: 0 };
  }
  profile.nickname = nickname;
  profiles.set(clientId, profile);
  while (profiles.size > config.maxProfiles) {
    profiles.delete(profiles.keys().next().value);
  }
  return profile;
}

const publicProfile = (p) => ({ clientId: p.clientId, nickname: p.nickname, rating: p.rating, games: p.games });

const ipConnections = new Map();

function getClientIp(socket) {
  if (config.trustProxy) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  }
  return socket.handshake.address || 'unknown';
}

// ---------------------------------------------------------------------
// HTTP (Express)
// ---------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public');
const app = express();

app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'media-src': ["'self'", 'blob:', 'data:'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'upgrade-insecure-requests': IS_PROD ? [] : null,
      },
    },
  })
);

library.mount(app); // ANTES de express.static: sirve /api/songs y /songs/:id/:file
app.use(express.static(PUBLIC_DIR, { maxAge: IS_PROD ? '1h' : 0 })); // <--- ESTO SIRVE LA INTERFAZ VISUAL DEL JUEGO

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    ...rooms.stats(),
    queued: matchmaker.size(),
    sockets: io.engine.clientsCount,
  });
});

app.get('/api/rooms', (req, res) => {
  res.json({ rooms: rooms.listPublicRooms() });
});

app.use((req, res) => {
  res.status(404).json(fail('NOT_FOUND', 'Recurso no encontrado.'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error('Error HTTP:', err);
  res.status(500).json(fail('INTERNAL_ERROR', 'Error interno del servidor.'));
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: config.corsOrigins, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10_000,
  pingInterval: 10_000,
  pingTimeout: 10_000,
  connectTimeout: 10_000,
});

// ---------------------------------------------------------------------
// Jugadores conectados (presencia)
//   presence:update { count }  -> a todos, al entrar/salir alguien y al conectarse
// ---------------------------------------------------------------------

// Chat global (menú): últimos mensajes en memoria; solo lo reciben los que ya entraron (room 'online').
const GLOBAL_CHAT_KEEP = 50;
const globalChat = [];

const presence = (() => {
  const users = new Set(); // ids de socket que ya entraron al juego (solo se comparte el NÚMERO, nunca los apodos)
  let timer = null;

  const snapshot = () => ({ count: users.size });

  // Agrupa cambios seguidos (muchos entrando a la vez) en un solo envío
  function broadcast() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      io.emit('presence:update', snapshot());
    }, 250);
  }

  return {
    snapshot,
    join(socket) {
      if (users.has(socket.id)) return;
      users.add(socket.id);
      broadcast();
    },
    leave(socket) {
      if (users.delete(socket.id)) broadcast();
    },
  };
})();

// ---------------------------------------------------------------------
// Eventos del RoomManager -> Socket.IO
// ---------------------------------------------------------------------

rooms.on('update', (room) => {
  // Cada jugador recibe el estado con SU canción en `settings` (clasificatoria y casual por turnos).
  for (const id of room.players.keys()) io.to(id).emit('room:state', rooms.serialize(room, id));
});

rooms.on('playerJoined', ({ room, player }) => {
  io.to(room.code).emit('room:notice', { type: 'player_joined', playerId: player.id, nickname: player.nickname });
});

rooms.on('playerLeft', ({ room, player, reason }) => {
  if (reason === 'no_pick') {
    // Expulsado por no elegir canción: se le avisa y se le saca del canal de la sala.
    const s = io.sockets.sockets.get(player.id);
    if (s) {
      s.emit('room:closed', { code: room.code, reason });
      s.leave(room.code);
    }
  }
  io.to(room.code).emit('room:notice', {
    type: 'player_left',
    playerId: player.id,
    nickname: player.nickname,
    reason,
  });
});

rooms.on('countdown', (room) => {
  // Casual por turnos: se manda la canción de la ronda (todos juegan la misma a la vez).
  const r = room.rounds ? room.rounds[room.round] : null;
  // Cada jugador recibe SU velocidad para esta canción (la que puso en el lobby): así no depende de lo que tenga guardado el cliente.
  for (const p of room.players.values()) {
    io.to(p.id).emit('game:countdown', {
      startAt: room.startAt,
      countdownMs: Math.max(0, room.startAt - Date.now()),
      round: r ? room.round + 1 : 1,
      totalRounds: r ? room.rounds.length : 1,
      chart: r ? r.chart : null,
      ownerId: r ? r.ownerId : null,
      ownerNickname: r ? r.ownerNickname : null,
      speed: rooms.speedForRound(room, p),
      serverTime: Date.now(),
    });
  }
});

rooms.on('started', (room) => {
  // Cada jugador recibe en `settings` la canción que le toca (la suya en clasificatoria).
  for (const player of room.players.values()) {
    const { settings } = rooms.serialize(room, player.id);
    io.to(player.id).emit('game:start', {
      startAt: room.startAt,
      settings,
      serverTime: Date.now(),
    });
  }
});

rooms.on('scoreboard', (room) => {
  io.to(room.code).emit('game:scoreboard', {
    scoreboard: rooms.scoreboard(room),
    serverTime: Date.now(),
  });
});

rooms.on('finished', ({ room, results, reason }) => {
  if (room.ranked) {
    for (const entry of results) {
      const socket = io.sockets.sockets.get(entry.playerId);
      const profile = socket?.data.session?.profile ?? (entry.clientId ? profiles.get(entry.clientId) : null);
      if (!profile) continue;
      profile.rating = entry.ratingAfter;
      profile.games += 1;
      if (socket) socket.emit('profile:update', publicProfile(profile));
    }
  }
  io.to(room.code).emit('game:results', {
    code: room.code,
    ranked: room.ranked,
    reason,
    results,
    serverTime: Date.now(),
  });
});

rooms.on('closed', ({ code, reason }) => {
  io.to(code).emit('room:closed', { code, reason });
  io.in(code).socketsLeave(code);
});

// ---------------------------------------------------------------------
// Matchmaking -> salas
// ---------------------------------------------------------------------

/** Pool clasificatorio: RANKED_SONGS + (opcional) toda la biblioteca, con duración/notas reales del servidor. */
function rankedPool() {
  if (!config.rankedUseLibrary) return rankedSongs;
  const fromLibrary = [];
  for (const s of library.list()) {
    const difficulty = Object.keys(s.difficulties)[0]; // la más fácil disponible; sustituye por 'normal' si lo prefieres
    const v = library.validate(s.id, difficulty);
    if (!v) continue;
    const parsed = validateRoomSettings({ songId: s.id, difficulty, durationMs: v.durationMs, totalNotes: v.totalNotes });
    if (parsed.ok) fromLibrary.push(parsed.value);
    else log.warn(`Canción "${s.id}" no apta para clasificatoria: ${parsed.error.message}`);
  }
  return [...rankedSongs, ...fromLibrary];
}

function pickRankedSong() {
  const pool = rankedPool();
  return pool.length ? pool[crypto.randomInt(pool.length)] : null;
}

/**
 * Anti-trampas: para canciones de la biblioteca, duración y nº de notas salen del servidor, no del cliente.
 * Devuelve { ok:true, payload } con los ajustes corregidos, o un error de ack.
 */
function resolveSongSettings(payload) {
  if (!isPlainObject(payload) || payload.songId === undefined) return { ok: true, payload };
  const songId = payload.songId;
  if (typeof songId === 'string' && library.get(songId)) {
    const difficulty = payload.difficulty === undefined ? 'normal' : payload.difficulty;
    const v = typeof difficulty === 'string' ? library.validate(songId, difficulty) : null;
    if (!v) return fail('SONG_DIFFICULTY', 'Esa canción no tiene la dificultad elegida.');
    return { ok: true, payload: { ...payload, difficulty, durationMs: v.durationMs, totalNotes: v.totalNotes } };
  }
  if (typeof songId === 'string' && BUILTIN_SONG_IDS.has(songId)) return { ok: true, payload };
  return fail('SONG_NOT_FOUND', 'Esa canción no existe en el servidor.');
}

function playerOf(socket) {
  const { profile } = socket.data.session;
  return { id: socket.id, clientId: profile.clientId, nickname: profile.nickname, rating: profile.rating };
}

matchmaker.on('match', ({ players: tickets }) => {
  // Descarta a quien se haya desconectado o entrado en otra sala entre ticks.
  const valid = tickets
    .map((ticket) => ({ ticket, socket: io.sockets.sockets.get(ticket.playerId) }))
    .filter(({ socket }) => socket && socket.connected && socket.data.session && !rooms.getRoomByPlayer(socket.id));

  if (valid.length < config.matchmaking.minPlayers) {
    for (const { ticket } of valid) matchmaker.enqueue(ticket); // conserva su antigüedad
    return;
  }

  const [first, ...others] = valid;
  const created = rooms.createRoom({
    host: playerOf(first.socket),
    ranked: true,
    settings: { maxPlayers: valid.length }, // sin canción: cada jugador elegirá la suya
  });
  if (!created.ok) {
    log.error('No se pudo crear la sala clasificatoria:', created.error);
    for (const { ticket } of valid) matchmaker.enqueue(ticket);
    return;
  }

  const { code } = created.room;
  first.socket.join(code);
  for (const { socket } of others) {
    const joined = rooms.joinRoom(code, playerOf(socket), { internal: true });
    if (joined.ok) socket.join(code);
    else log.warn('Jugador no pudo entrar a sala clasificatoria:', joined.error);
  }

  if (created.room.players.size < config.matchmaking.minPlayers) {
    // Casi imposible, pero no dejamos a nadie solo en una sala clasificatoria.
    const survivors = [...created.room.players.keys()];
    rooms.closeRoom(code, 'not_enough_players');
    for (const { ticket, socket } of valid) if (survivors.includes(socket.id)) matchmaker.enqueue(ticket);
    return;
  }

  for (const { socket } of valid) {
    if (rooms.getRoomByPlayer(socket.id)?.code !== code) continue;
    socket.emit('matchmaking:found', { code, room: rooms.serialize(created.room, socket.id) });
  }
  // Fase de selección: cada jugador elige su canción y se marca listo (o se elige por él al agotarse el tiempo).
  rooms.beginRankedPick(code);
  log.info(`Partida clasificatoria ${code} creada con ${created.room.players.size} jugadores (selección de canción).`);
});

matchmaker.on('timeout', (ticket) => {
  io.to(ticket.playerId).emit('matchmaking:timeout', { waitedMs: Date.now() - ticket.joinedAt });
});

// ---------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------

const done = (data = {}) => ({ ok: true, data });

function leaveCurrentRoom(socket, reason) {
  const room = rooms.getRoomByPlayer(socket.id);
  if (!room) return;
  const { code } = room;
  rooms.leaveRoom(socket.id, reason);
  socket.leave(code);
}

/** Registra un handler con rate limit, control de sesión y manejo de errores uniforme. */
function on(socket, event, handler, { session = true, limiter = generalLimiter, cost = 1 } = {}) {
  socket.on(event, (payload, ack) => {
    if (typeof payload === 'function') {
      ack = payload;
      payload = undefined;
    }
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      if (!limiter.consume(socket.id, cost)) {
        return reply(fail('RATE_LIMITED', 'Demasiadas solicitudes. Espera un momento.'));
      }
      if (session && !socket.data.session) {
        return reply(fail('NO_SESSION', 'Primero debes enviar session:hello.'));
      }
      return handler(payload, reply);
    } catch (err) {
      log.error(`Error en el evento "${event}":`, err);
      return reply(fail('INTERNAL_ERROR', 'Error interno del servidor.'));
    }
  });
}

function registerHandlers(socket) {
  // --- Sincronización de reloj (útil para sincronizar las notas) ---
  on(
    socket,
    'time:sync',
    (payload, reply) => {
      const t = validateTimeSync(payload);
      if (!t.ok) return reply(t);
      return reply(done({ clientTime: t.value, serverTime: Date.now() }));
    },
    { session: false }
  );

  // --- Sesión ---
  on(
    socket,
    'session:hello',
    (payload, reply) => {
      if (rooms.getRoomByPlayer(socket.id)) {
        return reply(fail('IN_ROOM', 'No puedes cambiar tu perfil dentro de una sala.'));
      }
      const data = isPlainObject(payload) ? payload : {};
      const nickname = validateNickname(data.nickname);
      if (!nickname.ok) return reply(nickname);
      const clientId = validateClientId(data.clientId);
      if (!clientId.ok) return reply(clientId);

      matchmaker.dequeue(socket.id);
      const profile = getProfile(clientId.value || crypto.randomUUID(), nickname.value);
      socket.data.session = { profile };
      presence.join(socket);
      socket.join('online');
      socket.emit('globalchat:history', globalChat);
      return reply(done(publicProfile(profile)));
    },
    { session: false }
  );

  // --- Salas ---
  on(socket, 'rooms:list', (payload, reply) => reply(done({ rooms: rooms.listPublicRooms() })));

  on(socket, 'room:create', (payload, reply) => {
    const song = resolveSongSettings(payload);
    if (!song.ok) return reply(song);
    const settings = validateRoomSettings(song.payload, { maxPlayersCap: config.rooms.maxPlayers });
    if (!settings.ok) return reply(settings);

    matchmaker.dequeue(socket.id);
    const result = rooms.createRoom({ host: playerOf(socket), settings: settings.value });
    if (!result.ok) return reply(result);

    socket.join(result.room.code);
    return reply(done({ room: rooms.serialize(result.room) }));
  });

  on(socket, 'room:join', (payload, reply) => {
    const code = normalizeRoomCode(isPlainObject(payload) ? payload.code : undefined, config.rooms.codeLength);
    if (!code.ok) return reply(code);

    matchmaker.dequeue(socket.id);
    const result = rooms.joinRoom(code.value, playerOf(socket));
    if (!result.ok) return reply(result);

    socket.join(code.value);
    return reply(done({ room: rooms.serialize(result.room, socket.id) }));
  });

  on(socket, 'room:leave', (payload, reply) => {
    leaveCurrentRoom(socket, 'left');
    return reply(done());
  });

  on(socket, 'room:ready', (payload, reply) => {
    const ready = validateReady(payload);
    if (!ready.ok) return reply(ready);
    const result = rooms.setReady(socket.id, ready.value);
    return reply(result.ok ? done() : result);
  });

  // Velocidad de juego del jugador (la suya, no la de otros), visible para toda la sala:
  //   { base: 1-7 }                      -> velocidad general: vale para todas las canciones de la partida
  //   { ownerId, slot (0-3), speed }     -> velocidad para UNA canción concreta (de cualquier jugador de la sala)
  on(socket, 'room:speed', (payload, reply) => {
    if (!isPlainObject(payload)) return reply(fail('INVALID_PAYLOAD', 'Datos inválidos.'));
    if (payload.base !== undefined) {
      const base = validateSpeed(payload.base);
      if (!base.ok) return reply(base);
      const r = rooms.setBaseSpeed(socket.id, base.value);
      return reply(r.ok ? done() : r);
    }
    if (typeof payload.ownerId !== 'string' || payload.ownerId.length > 64) return reply(fail('INVALID_PAYLOAD', 'Dueño de canción inválido.'));
    const slot = validateSlot(payload.slot);
    if (!slot.ok) return reply(slot);
    const speed = validateSpeed(payload.speed);
    if (!speed.ok) return reply(speed);
    const r = rooms.setPickSpeed(socket.id, payload.ownerId, slot.value, speed.value);
    return reply(r.ok ? done() : r);
  });

  on(socket, 'room:mode', (payload, reply) => {
    if (!isPlainObject(payload) || typeof payload.mode !== 'string') return reply(fail('INVALID_PAYLOAD', 'Modo inválido.'));
    const r = rooms.setRoomMode(socket.id, payload.mode);
    return reply(r.ok ? done() : r);
  });

  on(socket, 'room:settings', (payload, reply) => {
    if (!isPlainObject(payload)) return reply(fail('INVALID_PAYLOAD', 'Ajustes de sala inválidos.'));

    // Clasificatoria: cada jugador elige SU canción (no toca los ajustes de los demás).
    // Casual: el anfitrión usa los ajustes de sala (su canción); cada invitado elige la SUYA.
    const current = rooms.getRoomByPlayer(socket.id);

    // Canciones extra (2.ª-4.ª): cualquier jugador, también el anfitrión casual.
    const slot = validateSlot(payload.slot);
    if (!slot.ok) return reply(slot);
    if (slot.value >= 1) {
      if (!current) return reply(fail('NOT_IN_ROOM', 'No estás en ninguna sala.'));
      if (payload.remove === true) {
        const removed = rooms.removePlayerSlot(socket.id, slot.value);
        return reply(removed.ok ? done({ room: rooms.serialize(removed.room, socket.id) }) : removed);
      }
      const resolvedExtra = resolveSongSettings({
        songId: payload.songId,
        difficulty: payload.difficulty,
        durationMs: payload.durationMs,
        totalNotes: payload.totalNotes,
      });
      if (!resolvedExtra.ok) return reply(resolvedExtra);
      const parsedExtra = validateRoomSettings(resolvedExtra.payload);
      if (!parsedExtra.ok) return reply(parsedExtra);
      const added = rooms.setPlayerChart(socket.id, { difficulty: 'normal', ...parsedExtra.value }, slot.value);
      return reply(added.ok ? done({ room: rooms.serialize(added.room, socket.id) }) : added);
    }

    if (current && (current.ranked || current.hostId !== socket.id)) {
      const own = current.players.get(socket.id);
      const merged = {
        songId: payload.songId ?? own?.chart?.songId,
        difficulty: payload.difficulty ?? own?.chart?.difficulty,
        durationMs: payload.songId === undefined ? own?.chart?.durationMs : payload.durationMs,
        totalNotes: payload.songId === undefined ? own?.chart?.totalNotes : payload.totalNotes,
      };
      if (merged.songId === undefined) return reply(fail('NO_SONG', 'Elige una canción.'));
      const resolved = resolveSongSettings(merged);
      if (!resolved.ok) return reply(resolved);
      const parsed = validateRoomSettings(resolved.payload);
      if (!parsed.ok) return reply(parsed);
      const picked = rooms.setPlayerChart(socket.id, { difficulty: 'normal', ...parsed.value });
      return reply(picked.ok ? done({ room: rooms.serialize(picked.room, socket.id) }) : picked);
    }

    const song = resolveSongSettings(payload);
    if (!song.ok) return reply(song);
    const settings = validateRoomSettings(song.payload, { maxPlayersCap: config.rooms.maxPlayers });
    if (!settings.ok) return reply(settings);
    const result = rooms.updateSettings(socket.id, settings.value);
    return reply(result.ok ? done({ room: rooms.serialize(result.room) }) : result);
  });

  on(socket, 'room:start', (payload, reply) => {
    // La canción pudo borrarse o cambiar de chart mientras esperaban en el lobby: se revalida con el catálogo actual.
    const room = rooms.getRoomByPlayer(socket.id);
    const staleChart = (chart) => {
      if (library.get(chart.songId)) {
        const v = library.validate(chart.songId, chart.difficulty);
        if (!v) return 'La canción ya no está disponible con esa dificultad. Elige otra.';
        if (v.durationMs !== chart.durationMs || v.totalNotes !== chart.totalNotes) return 'La canción cambió en el servidor. Vuelve a elegirla.';
        return null;
      }
      return BUILTIN_SONG_IDS.has(chart.songId) ? null : 'La canción ya no está disponible. Elige otra.';
    };
    if (room && room.settings && room.settings.songId) {
      const msg = staleChart(room.settings);
      if (msg) return reply(fail('SONG_UNAVAILABLE', msg));
    }
    // Casual por turnos: también se revalidan las canciones de los invitados.
    if (room && !room.ranked) {
      for (const p of room.players.values()) {
        if (p.id === room.hostId || !p.chart) continue;
        const msg = staleChart(p.chart);
        if (msg) return reply(fail('SONG_UNAVAILABLE', `La canción de ${p.nickname}: ${msg}`));
      }
    }
    // Canciones extra de todos los jugadores (también las del anfitrión).
    if (room && !room.ranked) {
      for (const p of room.players.values()) {
        for (const c of p.more) {
          const msg = staleChart(c);
          if (msg) return reply(fail('SONG_UNAVAILABLE', `Canción extra de ${p.nickname}: ${msg}`));
        }
      }
    }
    const result = rooms.startGame(socket.id);
    return reply(result.ok ? done() : result);
  });

  on(socket, 'room:rematch', (payload, reply) => {
    const result = rooms.rematch(socket.id);
    return reply(result.ok ? done() : result);
  });

  // --- Partida ---
  on(
    socket,
    'game:score',
    (payload, reply) => {
      // El combo se hereda entre canciones: se valida contra el combo con el que el jugador entró en la ronda.
      const stats = validateScorePayload(payload, { carry: rooms.getCarry(socket.id) });
      if (!stats.ok) return reply(stats);
      const result = rooms.submitScore(socket.id, stats.value);
      return reply(result.ok ? done() : result);
    },
    { limiter: gameLimiter }
  );

  on(socket, 'game:finish', (payload, reply) => {
    let stats = null;
    if (payload !== undefined && payload !== null) {
      const parsed = validateScorePayload(payload, { carry: rooms.getCarry(socket.id) });
      if (!parsed.ok) return reply(parsed);
      stats = parsed.value;
    }
    const result = rooms.finishPlayer(socket.id, stats);
    return reply(result.ok ? done() : result);
  });

  // --- Chat de sala ---
  on(
    socket,
    'chat:message',
    (payload, reply) => {
      const room = rooms.getRoomByPlayer(socket.id);
      if (!room) return reply(fail('NOT_IN_ROOM', 'No estás en ninguna sala.'));
      const text = validateChatMessage(payload);
      if (!text.ok) return reply(text);
      io.to(room.code).emit('chat:message', {
        from: socket.id,
        nickname: socket.data.session.profile.nickname,
        text: text.value,
        at: Date.now(),
      });
      return reply(done());
    },
    { limiter: chatLimiter }
  );

  // --- Chat global (jugadores conectados) ---
  on(
    socket,
    'globalchat:send',
    (payload, reply) => {
      const text = validateChatMessage(payload);
      if (!text.ok) return reply(text);
      const msg = {
        from: socket.id,
        nickname: socket.data.session.profile.nickname,
        text: text.value,
        at: Date.now(),
      };
      globalChat.push(msg);
      if (globalChat.length > GLOBAL_CHAT_KEEP) globalChat.shift();
      io.to('online').emit('globalchat:message', msg);
      return reply(done());
    },
    { limiter: chatLimiter }
  );

  // --- Matchmaking ---
  on(socket, 'matchmaking:join', (payload, reply) => {
    const mode = validateMatchmakingMode(payload);
    if (!mode.ok) return reply(mode);
    if (rooms.getRoomByPlayer(socket.id)) {
      return reply(fail('IN_ROOM', 'Sal de tu sala actual antes de buscar partida.'));
    }

    const { profile } = socket.data.session;
    const result = matchmaker.enqueue({
      playerId: socket.id,
      clientId: profile.clientId,
      nickname: profile.nickname,
      rating: profile.rating,
      mode: mode.value,
    });
    if (!result.ok) return reply(result);
    return reply(done(matchmaker.getStatus(socket.id)));
  });

  on(socket, 'matchmaking:leave', (payload, reply) => {
    matchmaker.dequeue(socket.id);
    return reply(done());
  });

  on(socket, 'matchmaking:status', (payload, reply) => reply(done(matchmaker.getStatus(socket.id))));
}

io.on('connection', (socket) => {
  const ip = getClientIp(socket);
  const current = ipConnections.get(ip) ?? 0;
  if (current >= config.maxConnectionsPerIp) {
    socket.emit('server:error', fail('TOO_MANY_CONNECTIONS', 'Demasiadas conexiones desde tu red.').error);
    socket.disconnect(true);
    return;
  }
  ipConnections.set(ip, current + 1);
  socket.data.ip = ip;
  socket.data.session = null;

  registerHandlers(socket);
  socket.emit('presence:update', presence.snapshot()); // quien llega ve ya cuántos hay (también en el login)

  socket.on('disconnect', (reason) => {
    presence.leave(socket);
    matchmaker.dequeue(socket.id);
    leaveCurrentRoom(socket, 'disconnect');
    generalLimiter.reset(socket.id);
    gameLimiter.reset(socket.id);
    chatLimiter.reset(socket.id);

    const remaining = (ipConnections.get(ip) ?? 1) - 1;
    if (remaining <= 0) ipConnections.delete(ip);
    else ipConnections.set(ip, remaining);

    log.info(`Socket ${socket.id} desconectado (${reason}).`);
  });
});

// ---------------------------------------------------------------------
// Arranque y apagado ordenado
// ---------------------------------------------------------------------

server.listen(config.port, config.host, () => {
  matchmaker.start();
  log.info(`Rhythm Arena Online escuchando en http://${config.host}:${config.port} (${IS_PROD ? 'production' : 'development'})`);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} recibido. Cerrando servidor...`);

  matchmaker.stop();
  rooms.dispose();

  const forceTimer = setTimeout(() => {
    log.error('Cierre forzado por tiempo de espera.');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  io.close(() => {
    server.close(() => {
      log.info('Servidor cerrado correctamente.');
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('Promesa rechazada sin manejar:', reason));
process.on('uncaughtException', (err) => {
  log.error('Excepción no capturada:', err);
  shutdown('uncaughtException');
});
