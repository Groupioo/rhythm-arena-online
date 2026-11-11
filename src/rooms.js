'use strict';

/**
 * Gestión de salas de Rhythm Arena Online.
 *
 * Ciclo de vida:  lobby -> countdown -> playing -> finished -> (rematch -> lobby | cierre)
 *
 * Salas casuales (crear sala): POR TURNOS. El anfitrión elige su canción (room.settings) y cada
 * invitado elige la suya (player.chart). Al empezar se arma la lista de rondas: primero la canción
 * del anfitrión y después la de cada invitado, en orden de entrada. En cada ronda TODOS juegan la
 * misma canción a la vez (tiempo real); al terminar todos, cuenta atrás corta y siguiente ronda.
 * El resultado final suma todas las rondas.
 * Salas clasificatorias (buscar partida): hay una fase de selección en el lobby en la que
 * CADA jugador elige su canción (player.chart). Cuando todos están listos (o vence
 * el tiempo de selección) empieza la cuenta atrás y se juega igual que en casual, por rondas.
 *
 * Clasificatoria ONLINE (botón "Jugar online"): hasta `onlineMaxPlayers` (6) jugadores. Primero hay una SALA DE ESPERA
 * (room.waiting): se llena sola con quien pulsa "Jugar online". Empieza la fase de selección cuando se completan los 6
 * o cuando TODOS los presentes (mínimo 2) confirman que quieren empezar con los que hay (player.wantsStart; si entra o
 * sale alguien, las confirmaciones se reinician). En la selección cada jugador elige UNA canción y se juegan por turnos.
 *
 * CANCIONES POR PARTIDA (casual): cada jugador puede elegir hasta SET_SONGS_MAX canciones
 * (la 1.ª en player.chart / room.settings del anfitrión, el resto en player.more). Las rondas se
 * reparten por turnos entre los jugadores (anfitrión primero) y la partida tiene como máximo
 * SET_SONGS_MAX canciones en total.
 *
 * COMBO ENCADENADO: el combo NO se reinicia entre canciones; solo lo rompe un fallo. Al acabar cada
 * ronda el servidor guarda en player.carry el combo con el que el jugador entra en la siguiente.
 * El resultado final incluye `maxCombo` (mejor racha de toda la partida) y `finalCombo`.
 *
 * RoomManager no conoce Socket.IO: emite eventos y el servidor los transmite.
 * Eventos: 'update', 'playerJoined', 'playerLeft', 'countdown', 'started',
 *          'scoreboard', 'finished', 'closed'.
 *
 * Los métodos que pueden fallar devuelven { ok: true, ... } o
 * { ok: false, error: { code, message } }.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { fail, LIMITS, ROOM_CODE_ALPHABET } = require('./validation');

const ROOM_STATES = Object.freeze({
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  FINISHED: 'finished',
});

const DEFAULT_OPTIONS = Object.freeze({
  maxPlayers: 4,
  onlineMaxPlayers: 6, // jugadores de una sala clasificatoria online
  minPlayersToStart: 2,
  codeLength: 5,
  countdownMs: 5_000,
  finishGraceMs: 10_000,
  roundGapMs: 6_000, // pausa entre rondas (cuenta atrás de la ronda siguiente)
  scoreboardIntervalMs: 250,
  rankedRoomTtlMs: 60_000,
  rankedPickMs: 180_000, // tiempo (3 min) para elegir canciones y marcarse listo en una sala clasificatoria
  autoPick: null, // () => { songId, difficulty, durationMs, totalNotes } | null (canción si alguien no elige)
  casualRoomTtlMs: 600_000,
  maxRooms: 1_000,
  ratingK: 32, // ya no se usa en clasificatoria (se conserva por compatibilidad)
  pointsPerPlayer: 16, // clasificatoria: puntos de base; el 1.º gana 16 × nº de jugadores
  paidPlaces: 3, // clasificatoria: cuántos puestos puntúan como máximo (siempre queda al menos 1 sin puntos)
});

const JUDGEMENT_WEIGHTS = Object.freeze({ perfect: 1, great: 0.85, good: 0.5 });
const MONOTONIC_FIELDS = Object.freeze(['score', 'perfect', 'great', 'good', 'miss', 'maxCombo']);
const MAX_REJECTED_UPDATES = 20;

const emptyStats = () => ({ score: 0, combo: 0, maxCombo: 0, perfect: 0, great: 0, good: 0, miss: 0 });

/** Datos de la canción que juega un jugador. */
const makeChart = (c) => ({
  songId: c.songId,
  difficulty: c.difficulty ?? 'normal',
  durationMs: c.durationMs,
  totalNotes: c.totalNotes,
});

const judgedCount = (s) => s.perfect + s.great + s.good + s.miss;

/** Precisión ponderada (0-100) respecto a un denominador (notas juzgadas o totales). */
function accuracyOf(stats, denominator) {
  if (!denominator || denominator <= 0) return 0;
  const weighted =
    stats.perfect * JUDGEMENT_WEIGHTS.perfect +
    stats.great * JUDGEMENT_WEIGHTS.great +
    stats.good * JUDGEMENT_WEIGHTS.good;
  return Math.round((weighted / denominator) * 10_000) / 100;
}

/**
 * Puntos de clasificatoria por puesto. Sistema fijo, sin restar nunca:
 *   puesto p con N jugadores -> perPlayer × (N − p + 1), solo para los primeros `paidPlaces` puestos
 *   (y siempre dejando al último sin puntos); el resto suma 0.
 *   Con 16 puntos: 6 jugadores -> 96 / 80 / 64 · 5 jugadores -> 80 / 64 / 48 · 2 jugadores -> 32.
 */
function pointsForRank(rank, players, { pointsPerPlayer = 16, paidPlaces = 3 } = {}) {
  const paid = Math.min(paidPlaces, Math.max(0, players - 1));
  return rank >= 1 && rank <= paid ? pointsPerPlayer * (players - rank + 1) : 0;
}

/**
 * Cambio de rating tipo Elo para varios jugadores (YA NO se usa: la clasificatoria reparte puntos fijos por puesto) (comparación por parejas).
 * entries: [{ id, rating, rank }]  ->  Map(id -> delta entero)
 */
function computeRatingChanges(entries, k = 32) {
  const changes = new Map();
  const n = entries.length;
  for (const a of entries) {
    if (n < 2) {
      changes.set(a.id, 0);
      continue;
    }
    let sum = 0;
    for (const b of entries) {
      if (a === b) continue;
      const actual = a.rank < b.rank ? 1 : a.rank > b.rank ? 0 : 0.5;
      const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      sum += actual - expected;
    }
    changes.set(a.id, Math.round((k / (n - 1)) * sum));
  }
  return changes;
}

class RoomManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.rooms = new Map(); // code -> room
    this.playerRoom = new Map(); // playerId -> code
  }

  // ------------------------------------------------------------------
  // Consultas
  // ------------------------------------------------------------------

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  getRoomByPlayer(playerId) {
    const code = this.playerRoom.get(playerId);
    return code ? this.rooms.get(code) || null : null;
  }

  stats() {
    return { rooms: this.rooms.size, players: this.playerRoom.size };
  }

  listPublicRooms() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.isPrivate || room.ranked || room.state !== ROOM_STATES.LOBBY) continue;
      if (room.players.size >= room.maxPlayers) continue;
      const host = room.players.get(room.hostId);
      list.push({
        code: room.code,
        hostNickname: host ? host.nickname : '',
        players: room.players.size,
        maxPlayers: room.maxPlayers,
        songId: room.settings.songId,
        difficulty: room.settings.difficulty,
      });
    }
    return list;
  }

  /** Estado público de una sala (lo que ven los clientes). */
  serialize(room, viewerId = null) {
    // En clasificatoria cada jugador ve SU canción en `settings`; en casual, la de la sala.
    let settings = { ...room.settings };
    const own = viewerId ? room.players.get(viewerId) : null;
    if (room.currentChart && room.state !== ROOM_STATES.LOBBY) {
      // Por turnos: durante la partida `settings` es la canción de la ronda en curso.
      settings = { ...settings, ...room.currentChart };
    } else if (room.ranked) {
      settings = {
        ...settings,
        songId: null,
        durationMs: null,
        totalNotes: null,
        ...(own && own.chart ? own.chart : {}),
      };
    }
    // Casual: las canciones son solo del anfitrión; todos ven las mismas (`settings` + `plan`).
    const lobbyChart = (p) =>
      p.chart || (!room.ranked && p.id === room.hostId && room.settings.songId ? room.settings : null);
    // Orden previsto de las canciones (solo en el lobby; durante la partida manda `round/totalRounds`).
    const plan = room.state === ROOM_STATES.LOBBY ? this._buildRounds(room, { partial: true }) : null;
    return {
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      ranked: room.ranked,
      mode: room.ranked ? null : room.mode || 'normal', // casual: el mismo para todos; clasificatoria: cada uno el suyo
      isPrivate: room.isPrivate,
      maxPlayers: room.maxPlayers,
      settings,
      pickDeadline: room.pickDeadline,
      startAt: room.startAt,
      // Clasificatoria: la partida tiene SET_SONGS_MAX canciones en total y a cada jugador le toca su parte.
      maxSongs: room.ranked && own ? this._quota(room, own.id) : LIMITS.SET_SONGS_MAX,
      totalSongs: this._songCap(room),
      waiting: Boolean(room.waiting), // clasificatoria online esperando a más jugadores
      prizes: room.ranked ? this.prizesFor(room.players.size) : null, // puntos del 1.º, 2.º... con los jugadores actuales
      minPlayers: this.options.minPlayersToStart,
      plan: plan
        ? plan.map((r) => ({
            ownerId: r.ownerId,
            ownerNickname: r.ownerNickname,
            slot: r.slot,
            songId: r.chart.songId,
            difficulty: r.chart.difficulty,
            // Velocidad con la que juega CADA jugador esta canción (cada uno la fija para sí mismo).
            speeds: [...room.players.values()].map((p) => ({ id: p.id, nickname: p.nickname, speed: this._speedOf(p, r.ownerId, r.slot) })),
          }))
        : null,
      carry: own ? { ...own.carry } : null, // combo con el que entras en la ronda en curso
      round: room.rounds ? room.round + 1 : null,
      totalRounds: room.rounds ? room.rounds.length : null,
      countdownMs: this.options.countdownMs,
      serverTime: Date.now(),
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        nickname: p.nickname,
        country: p.country ?? null,
        rating: p.rating,
        ready: p.ready,
        wantsStart: Boolean(p.wantsStart), // en la sala de espera: quiere empezar con los jugadores que hay
        quota: room.ranked ? this._quota(room, p.id) : null,
        isHost: p.id === room.hostId,
        finished: p.finished,
        // Qué canción ha elegido cada jugador (clasificatoria y casual por turnos).
        picked: Boolean(lobbyChart(p)),
        song: lobbyChart(p) ? { songId: lobbyChart(p).songId, difficulty: lobbyChart(p).difficulty } : null,
        // Todas las canciones que ha elegido (1.ª y extra), en orden.
        picks: this._pickList(room, p).map((c) => ({ songId: c.songId, difficulty: c.difficulty })),
      })),
    };
  }

  /** Puntos que se llevan los primeros puestos con `n` jugadores, p. ej. 6 -> [96, 80, 64]. */
  prizesFor(n) {
    const out = [];
    for (let rank = 1; rank <= n; rank += 1) {
      const pts = pointsForRank(rank, n, this.options);
      if (pts > 0) out.push(pts);
    }
    return out;
  }

  /** Marcador en vivo, ordenado por puntuación. */
  scoreboard(room) {
    const rows = [...room.players.values()].map((p) => this._scoreRow(room, p, false));
    for (const d of room.departed) rows.push(this._scoreRow(room, d, true));
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  // ------------------------------------------------------------------
  // Lobby
  // ------------------------------------------------------------------

  createRoom({ host, settings = {}, ranked = false, waiting = false }) {
    if (this.playerRoom.has(host.id)) return fail('ALREADY_IN_ROOM', 'Ya estás en una sala.');
    if (this.rooms.size >= this.options.maxRooms) return fail('SERVER_FULL', 'El servidor no admite más salas ahora mismo.');

    const code = this._generateCode();
    if (!code) return fail('SERVER_BUSY', 'No se pudo generar un código de sala. Inténtalo de nuevo.');

    const cap = ranked ? this.options.onlineMaxPlayers : this.options.maxPlayers;
    const room = {
      code,
      hostId: host.id,
      state: ROOM_STATES.LOBBY,
      ranked,
      waiting: ranked && waiting, // sala de espera de la clasificatoria online (aún sin fase de selección)
      isPrivate: ranked ? true : Boolean(settings.isPrivate),
      maxPlayers: Math.min(settings.maxPlayers ?? cap, cap),
      settings: {
        songId: settings.songId ?? null,
        difficulty: settings.difficulty ?? 'normal',
        durationMs: settings.durationMs ?? null,
        totalNotes: settings.totalNotes ?? null,
      },
      mode: 'normal', // casual: modo de juego de toda la sala (lo elige el anfitrión): normal | survival | super
      players: new Map(),
      departed: [],
      rounds: null, // casual por turnos: [{ ownerId, ownerNickname, chart }]
      round: 0, // índice de la ronda en curso
      currentChart: null, // canción de la ronda en curso
      results: null,
      createdAt: Date.now(),
      pickDeadline: null,
      startAt: null,
      startedAt: null,
      finishedAt: null,
      dirty: false,
      timers: { countdown: null, end: null, scoreboard: null, close: null, pick: null },
    };

    room.players.set(host.id, this._newPlayer(host));
    this.rooms.set(code, room);
    this.playerRoom.set(host.id, code);

    this.emit('update', room);
    return { ok: true, room };
  }

  /** `internal: true` permite entrar en salas clasificatorias (solo el matchmaking). */
  joinRoom(code, player, { internal = false } = {}) {
    const room = this.rooms.get(code);
    if (!room) return fail('ROOM_NOT_FOUND', 'La sala no existe.');
    if (this.playerRoom.has(player.id)) return fail('ALREADY_IN_ROOM', 'Ya estás en una sala.');
    if (room.ranked && !internal) return fail('ROOM_LOCKED', 'Esta sala no admite entradas directas.');
    if (room.state !== ROOM_STATES.LOBBY) return fail('ROOM_IN_PROGRESS', 'La partida ya ha comenzado.');
    if (room.players.size >= room.maxPlayers) return fail('ROOM_FULL', 'La sala está llena.');

    const state = this._newPlayer(player);
    room.players.set(player.id, state);
    this.playerRoom.set(player.id, code);
    if (room.waiting) this._resetVotes(room); // cambia el grupo: todos deben confirmar de nuevo

    this.emit('playerJoined', { room, player: state });
    this.emit('update', room);
    this._maybeEndWaiting(room); // si se completó la sala, empieza la selección de canciones
    return { ok: true, room };
  }

  /**
   * Clasificatoria online: entra en la sala de espera que tenga hueco o crea una nueva.
   * No se empareja por rating: entra quien llegue (el cambio de rating sigue calculándose entre todos).
   */
  joinOnline(player) {
    if (this.playerRoom.has(player.id)) return fail('ALREADY_IN_ROOM', 'Ya estás en una sala.');
    const open = this._openOnlineRoom();
    if (open) return this.joinRoom(open.code, player, { internal: true });
    return this.createRoom({ host: player, ranked: true, waiting: true });
  }

  /** Sala de espera: un jugador confirma (o retira) que quiere empezar con los jugadores que hay ahora mismo. */
  setWaitingStart(playerId, want) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return fail('NOT_IN_ROOM', 'No estás en ninguna sala.');
    if (!room.ranked || !room.waiting || room.state !== ROOM_STATES.LOBBY) {
      return fail('INVALID_STATE', 'La sala ya no está esperando jugadores.');
    }
    if (want && room.players.size < this.options.minPlayersToStart) {
      return fail('NOT_ENOUGH_PLAYERS', `Se necesitan al menos ${this.options.minPlayersToStart} jugadores para empezar.`);
    }
    room.players.get(playerId).wantsStart = Boolean(want);
    this.emit('update', room);
    this._maybeEndWaiting(room);
    return { ok: true, room };
  }

  leaveRoom(playerId, reason = 'left') {
    const room = this.getRoomByPlayer(playerId);
    this.playerRoom.delete(playerId);
    if (!room) return { ok: true, room: null };

    const player = room.players.get(playerId);
    room.players.delete(playerId);
    if (!player) return { ok: true, room };

    // Si se va a mitad de partida, conserva su resultado parcial.
    const byRounds = Boolean(room.rounds);
    if (room.state === ROOM_STATES.PLAYING) {
      if (byRounds) player.history.push(this._roundEntry(room, player)); // ronda en curso, parcial
      room.departed.push({ ...player, stats: { ...player.stats }, history: [...player.history] });
    } else if (byRounds && room.round > 0 && room.state === ROOM_STATES.COUNTDOWN) {
      room.departed.push({ ...player, stats: { ...player.stats }, history: [...player.history] });
    }
    // Sus rondas pendientes desaparecen (la en curso se termina).
    if (byRounds) room.rounds = room.rounds.filter((r, i) => i <= room.round || r.ownerId !== playerId);

    if (room.players.size === 0) {
      this.closeRoom(room.code, 'empty');
      return { ok: true, room: null };
    }

    if (room.hostId === playerId) {
      room.hostId = room.players.keys().next().value;
      // Casual en lobby: la canción del anfitrión pasa a ser la del nuevo anfitrión (si ya la había elegido).
      const nh = room.players.get(room.hostId);
      if (!room.ranked && room.state === ROOM_STATES.LOBBY && nh && nh.chart) {
        Object.assign(room.settings, nh.chart);
      }
    }

    if (
      room.state === ROOM_STATES.COUNTDOWN &&
      room.players.size < this.options.minPlayersToStart &&
      (!room.ranked || (room.rounds && room.round > 0))
    ) {
      clearTimeout(room.timers.countdown);
      room.timers.countdown = null;
      if (room.rounds && room.round > 0) {
        // Partida por turnos a medias: se cierra con lo jugado hasta ahora.
        this.emit('playerLeft', { room, player, reason });
        room.state = ROOM_STATES.PLAYING; // finishRoom exige PLAYING
        this.finishRoom(room.code, 'not_enough_players');
        return { ok: true, room };
      }
      room.state = ROOM_STATES.LOBBY;
      room.startAt = null;
      room.rounds = null;
      room.currentChart = null;
      room.round = 0;
    }

    this.emit('playerLeft', { room, player, reason });

    // En la sala de espera el grupo cambió: las confirmaciones de empezar se reinician (y no se cierra aunque quede 1).
    if (room.waiting) this._resetVotes(room);

    // Clasificatoria en fase de selección: si queda un solo jugador, no hay partida.
    if (
      room.ranked &&
      !room.waiting &&
      room.state === ROOM_STATES.LOBBY &&
      room.players.size < this.options.minPlayersToStart
    ) {
      this.closeRoom(room.code, 'opponent_left');
      return { ok: true, room: null };
    }

    // Clasificatoria: al cambiar el nº de jugadores cambia el reparto; quien se quede corto deja de estar listo.
    if (room.ranked && room.state === ROOM_STATES.LOBBY) {
      for (const p of room.players.values()) {
        if (p.ready && this._pickList(room, p).length < this._quota(room, p.id)) p.ready = false;
      }
    }
    this.emit('update', room);
    if (room.ranked && room.state === ROOM_STATES.LOBBY) this._maybeStartRanked(room);

    if (room.state === ROOM_STATES.PLAYING && this._allFinished(room)) {
      this._endRound(room.code, 'all_finished');
    }
    return { ok: true, room };
  }

  setReady(playerId, ready) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return fail('NOT_IN_ROOM', 'No estás en ninguna sala.');
    if (room.state !== ROOM_STATES.LOBBY) return fail('INVALID_STATE', 'Solo puedes cambiar tu estado en el lobby.');
    if (room.waiting) return fail('INVALID_STATE', 'Aún se está esperando a más jugadores.');
    const player = room.players.get(playerId);
    if (ready && room.ranked && !player.chart) {
      return fail('NO_SONG', 'Elige tu canción antes de marcarte como listo.');
    }
    if (ready && room.ranked) {
      const need = this._quota(room, playerId);
      const have = this._pickList(room, player).length;
      if (have < need) {
        return fail('NO_SONG', `Elige tus ${need} canciones antes de marcarte como listo (te faltan ${need - have}).`);
      }
    }
    player.ready = ready;
    this.emit('update', room);
    if (ready && room.ranked) this._maybeStartRanked(room);
    return { ok: true, room };
  }

  /**
   * Un jugador elige UNA de sus canciones. `slot` 0 = la primera (clasificatoria o invitado casual; el
   * anfitrión casual la cambia con los ajustes de sala); 1-3 = canciones extra, que se añaden en orden
   * (no puede haber huecos). `chart` ya viene validado/corregido por el servidor.
   * Cambiar de canción le quita el "listo" a ese jugador (si es el anfitrión casual, a todos).
   */
  setPlayerChart(playerId, chart, slot = 0) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return fail('NOT_IN_ROOM', 'No estás en ninguna sala.');
    const casualHost = !room.ranked && playerId === room.hostId;
    if (!room.ranked && !casualHost) {
      return fail('NOT_HOST', 'Solo el anfitrión puede elegir las canciones de la sala.');
    }
    if (casualHost && slot === 0) {
      return fail('USE_SETTINGS', 'El anfitrión elige su primera canción con los ajustes de la sala.');
    }
    if (room.state !== ROOM_STATES.LOBBY) return fail('INVALID_STATE', 'Ya no puedes cambiar de canción.');
    if (room.waiting) return fail('INVALID_STATE', 'Podrás elegir tu canción cuando empiece la partida.');
    if (!Number.isInteger(slot) || slot < 0 || slot >= LIMITS.SET_SONGS_MAX) {
      return fail('INVALID_SLOT', `La canción debe estar entre 1 y ${LIMITS.SET_SONGS_MAX}.`);
    }
    if (room.ranked && slot >= this._quota(room, playerId)) {
      return fail('INVALID_SLOT', 'En clasificatoria cada jugador elige una sola canción.');
    }
    if (!chart || !chart.songId || !chart.durationMs || !chart.totalNotes) {
      return fail('NO_SONG', 'Canción incompleta.');
    }
    const player = room.players.get(playerId);
    if (slot === 0) {
      player.chart = makeChart(chart);
    } else {
      const have = this._pickList(room, player).length;
      if (have === 0) return fail('NO_SONG', 'Elige primero tu canción 1.');
      if (slot > have) return fail('INVALID_SLOT', 'Elige las canciones en orden.');
      player.more[slot - 1] = makeChart(chart);
    }
    this._resetReady(room, playerId, casualHost);
    this.emit('update', room);
    return { ok: true, room };
  }

  /**
   * Cada jugador fija SU velocidad de juego (x1-x7) para cualquier canción de la partida, también las de sus rivales,
   * para no tener que jugarlas a la velocidad de su dueño. Todos ven las velocidades de todos en tiempo real.
   * No quita el "listo" de nadie.
   */
  setPickSpeed(playerId, ownerId, slot, speed) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return fail('NOT_IN_ROOM', 'No estás en ninguna sala.');
    if (room.state !== ROOM_STATES.LOBBY) return fail('INVALID_STATE', 'Ya no puedes cambiar la velocidad.');
    if (!Number.isInteger(speed) || speed < LIMITS.SPEED_MIN || speed > LIMITS.SPEED_MAX) {
      return fail('INVALID_SPEED', 'Velocidad inválida.');
    }
    const owner = room.players.get(ownerId);
    if (!owner) return fail('INVALID_SLOT', 'Ese jugador no está en la sala.');
    if (!Number.isInteger(slot) || slot < 0 || slot >= this._pickList(room, owner).length) {
      return fail('INVALID_SLOT', 'Esa canción no existe.');
    }
    room.players.get(playerId).speeds[`${ownerId}:${slot}`] = speed;
    this.emit('update', room);
    return { ok: true, room };
  }

  /** Velocidad general del jugador: la usa en todas las canciones y descarta sus ajustes por canción. */
  setBaseSpeed(playerId, speed) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return fail('NOT_IN_ROOM', 'No estás en ninguna sala.');
    if (room.state !== ROOM_STATES.LOBBY) return fail('INVALID_STATE', 'Ya no puedes cambiar la velocidad.');
    if (!Number.isInteger(speed) || speed < LIMITS.SPEED_MIN || speed > LIMITS.SPEED_MAX) {
      return fail('INVALID_SPEED', 'Velocidad inválida.');
    }
    const player = room.players.get(playerId);
    player.baseSpeed = speed;
    player.speeds = {};
    this.emit('update', room);
    return { ok: true, room };
  }

  /** Velocidad con la que juega `p` la ronda en curso (la que puso en el lobby; si no, su velocidad general). */
  speedForRound(room, p) {
    const r = room.rounds ? room.rounds[room.round] : null;
    return r ? this._speedOf(p, r.ownerId, r.slot) : p.baseSpeed;
  }

  /** Velocidad con la que juega `p` la canción `slot` de `ownerId`. */
  _speedOf(p, ownerId, slot) {
    return p.speeds[`${ownerId}:${slot}`] ?? p.baseSpeed;
  }

  /** Quita una canción extra (slot 1-3); las siguientes suben un puesto. La 1.ª solo se puede cambiar. */
  removePlayerSlot(playerId, slot) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return fail('NOT_IN_ROOM', 'No estás en ninguna sala.');
    if (room.state !== ROOM_STATES.LOBBY) return fail('INVALID_STATE', 'Ya no puedes cambiar de canción.');
    if (!room.ranked && playerId !== room.hostId) return fail('NOT_HOST', 'Solo el anfitrión puede quitar canciones de la sala.');
    const player = room.players.get(playerId);
    if (!Number.isInteger(slot) || slot < 1) return fail('INVALID_SLOT', 'La primera canción no se puede quitar, solo cambiar.');
    if (slot - 1 >= player.more.length) return fail('INVALID_SLOT', 'Esa canción no existe.');
    player.more.splice(slot - 1, 1);
    // Las velocidades que los jugadores habían puesto a las canciones siguientes suben un puesto con ellas.
    const total = this._pickList(room, player).length + 1; // canciones antes de quitar
    for (const q of room.players.values()) {
      for (let s = slot; s < total; s += 1) {
        const next = q.speeds[`${playerId}:${s + 1}`];
        if (next === undefined) delete q.speeds[`${playerId}:${s}`];
        else q.speeds[`${playerId}:${s}`] = next;
      }
      delete q.speeds[`${playerId}:${total - 1}`];
    }
    this._resetReady(room, playerId, !room.ranked && playerId === room.hostId);
    this.emit('update', room);
    return { ok: true, room };
  }

  /** Combo con el que el jugador entra en la ronda en curso (lo usa el servidor para validar su puntuación). */
  getCarry(playerId) {
    const room = this.getRoomByPlayer(playerId);
    const player = room && room.players.get(playerId);
    return player ? { ...player.carry } : undefined;
  }

  /** Casual: el anfitrión fija el modo de juego de TODA la sala (normal | survival | super). */
  setRoomMode(playerId, mode) {
    const ctx = this._hostRoom(playerId, ROOM_STATES.LOBBY);
    if (!ctx.ok) return ctx;
    const { room } = ctx;
    if (room.ranked) return fail('RANKED_LOCKED', 'En clasificatoria cada jugador elige su modo.');
    if (!['normal', 'survival', 'super'].includes(mode)) return fail('INVALID_MODE', 'Modo de juego no válido.');
    if (room.mode === mode) return { ok: true, room };
    room.mode = mode;
    for (const p of room.players.values()) p.ready = false; // los invitados deben confirmar el nuevo modo
    this.emit('update', room);
    return { ok: true, room };
  }

  updateSettings(playerId, settings) {
    const ctx = this._hostRoom(playerId, ROOM_STATES.LOBBY);
    if (!ctx.ok) return ctx;
    const { room } = ctx;
    if (room.ranked) return fail('RANKED_LOCKED', 'Los ajustes de una sala clasificatoria no se pueden cambiar.');

    if (settings.maxPlayers !== undefined) {
      if (settings.maxPlayers > this.options.maxPlayers) {
        return fail('INVALID_MAX_PLAYERS', `El máximo permitido es ${this.options.maxPlayers}.`);
      }
      if (settings.maxPlayers < room.players.size) {
        return fail('INVALID_MAX_PLAYERS', 'Hay más jugadores en la sala que el nuevo máximo.');
      }
      room.maxPlayers = settings.maxPlayers;
    }
    if (settings.isPrivate !== undefined) room.isPrivate = settings.isPrivate;
    if (settings.difficulty !== undefined) room.settings.difficulty = settings.difficulty;
    if (settings.songId !== undefined) {
      room.settings.songId = settings.songId;
      room.settings.durationMs = settings.durationMs;
      room.settings.totalNotes = settings.totalNotes;
    }

    // Cualquier cambio invalida el "listo" de los jugadores.
    for (const p of room.players.values()) p.ready = false;
    this.emit('update', room);
    return { ok: true, room };
  }

  // ------------------------------------------------------------------
  // Partida
  // ------------------------------------------------------------------

  startGame(playerId) {
    const ctx = this._hostRoom(playerId, ROOM_STATES.LOBBY);
    if (!ctx.ok) return ctx;
    const { room } = ctx;
    if (room.ranked) return fail('RANKED_LOCKED', 'Las salas clasificatorias empiezan automáticamente.');
    if (room.players.size < this.options.minPlayersToStart) {
      return fail('NOT_ENOUGH_PLAYERS', `Se necesitan al menos ${this.options.minPlayersToStart} jugadores.`);
    }
    if (!this._chartComplete(room)) return fail('NO_SONG', 'Selecciona una canción antes de empezar.');
    for (const p of room.players.values()) {
      if (p.id !== room.hostId && !p.ready) return fail('PLAYERS_NOT_READY', 'Todos los jugadores deben estar listos.');
    }
    if (!this._prepareRounds(room)) return fail('NO_SONG', 'Todos los jugadores deben elegir una canción.');
    this._beginCountdown(room);
    return { ok: true, room };
  }

  /**
   * Uso interno del matchmaking: abre la fase de selección. Cada jugador elige su canción y se
   * marca listo; si el tiempo se agota, se elige por él (o se le expulsa si no hay canciones).
   */
  beginRankedPick(code) {
    // Hay hasta `rankedPickMs` (3 min) para que todos elijan sus canciones y den "listo". Si se agota, se completa lo que falte.
    const room = this.rooms.get(code);
    if (!room || !room.ranked || room.state !== ROOM_STATES.LOBBY) return fail('INVALID_STATE', 'Sala no válida.');
    clearTimeout(room.timers.pick);
    room.pickDeadline = Date.now() + this.options.rankedPickMs;
    room.timers.pick = setTimeout(() => this._onPickTimeout(code), this.options.rankedPickMs);
    this.emit('update', room);
    return { ok: true, room };
  }

  /** Actualización de puntuación acumulada, validada contra el estado de la partida. */
  submitScore(playerId, stats) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return fail('NOT_IN_ROOM', 'No estás en ninguna sala.');
    if (room.state !== ROOM_STATES.PLAYING) return fail('INVALID_STATE', 'La partida no está en curso.');

    const player = room.players.get(playerId);
    if (player.finished) return fail('ALREADY_FINISHED', 'Ya has terminado la partida.');
    if (player.rejected >= MAX_REJECTED_UPDATES) {
      return fail('PLAYER_FLAGGED', 'Tus actualizaciones se ignoran por exceso de datos inválidos.');
    }

    const reason = this._checkPlausibility(room, player, stats);
    if (reason) {
      player.rejected += 1;
      return fail('SCORE_REJECTED', reason);
    }

    player.stats = { ...stats };
    room.dirty = true;
    return { ok: true, room };
  }

  /** El jugador terminó la canción. `stats` (opcional) es su estado final. */
  finishPlayer(playerId, stats = null) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return fail('NOT_IN_ROOM', 'No estás en ninguna sala.');
    if (room.state !== ROOM_STATES.PLAYING) return fail('INVALID_STATE', 'La partida no está en curso.');

    const player = room.players.get(playerId);
    if (player.finished) return fail('ALREADY_FINISHED', 'Ya has terminado la partida.');

    if (stats) {
      const result = this.submitScore(playerId, stats);
      if (!result.ok) return result;
    }

    player.finished = true;
    player.finishedAt = Date.now();
    room.dirty = true;

    if (this._allFinished(room)) {
      this._endRound(room.code, 'all_finished');
    }
    return { ok: true, room };
  }

  /**
   * Fin de una ronda. Clasificatoria / sala sin rondas: termina la partida. Casual por turnos:
   * archiva la ronda y, si quedan más, arranca la cuenta atrás de la siguiente.
   */
  _endRound(code, reason = 'all_finished') {
    const room = this.rooms.get(code);
    if (!room || room.state !== ROOM_STATES.PLAYING) return null;
    if (!room.rounds) return this.finishRoom(code, reason);

    for (const p of room.players.values()) {
      const entry = this._roundEntry(room, p);
      p.history.push(entry);
      p.carry = { combo: entry.comboEnd, maxCombo: entry.stats.maxCombo }; // el combo continúa en la ronda siguiente
    }
    if (room.round + 1 >= room.rounds.length) return this.finishRoom(code, reason);

    clearTimeout(room.timers.end);
    clearInterval(room.timers.scoreboard);
    room.timers.end = null;
    room.timers.scoreboard = null;
    room.round += 1;
    room.currentChart = room.rounds[room.round].chart;
    this._beginCountdown(room, { delayMs: this.options.roundGapMs, nextRound: true });
    return null;
  }

  finishRoom(code, reason = 'finished') {
    const room = this.rooms.get(code);
    if (!room || room.state !== ROOM_STATES.PLAYING) return null;

    this._clearTimers(room);
    room.state = ROOM_STATES.FINISHED;
    room.finishedAt = Date.now();
    room.dirty = false;

    const entries = [
      ...[...room.players.values()].map((p) => this._resultEntry(room, p, false)),
      ...room.departed.map((p) => this._resultEntry(room, p, true)),
    ];

    // Quien abandonó queda siempre por detrás de quien terminó o siguió en la sala.
    // Por turnos todos juegan las mismas canciones: manda la puntuación total.
    // (Sin rondas, en clasificatoria cada uno tendría una canción distinta: se ordenaría por precisión.)
    const NEVER = Number.MAX_SAFE_INTEGER;
    const primary = room.ranked && !room.rounds
      ? (a, b) => b.accuracy - a.accuracy || b.score - a.score
      : (a, b) => b.score - a.score || b.accuracy - a.accuracy;
    entries.sort(
      (a, b) =>
        Number(a.left) - Number(b.left) ||
        primary(a, b) ||
        (a.finishedAt ?? NEVER) - (b.finishedAt ?? NEVER)
    );
    entries.forEach((entry, i) => {
      const prev = entries[i - 1];
      const tied =
        prev &&
        prev.left === entry.left &&
        prev.score === entry.score &&
        (!room.ranked || prev.accuracy === entry.accuracy);
      entry.rank = tied ? prev.rank : i + 1;
    });

    // Clasificatoria: puntos fijos por puesto según los jugadores que empezaron la partida (quien abandonó no puntúa).
    const total = entries.length;
    for (const entry of entries) {
      entry.ratingChange = room.ranked && !entry.left ? pointsForRank(entry.rank, total, this.options) : 0;
      entry.ratingAfter = entry.ratingBefore + entry.ratingChange;
      const present = room.players.get(entry.playerId);
      if (present) present.rating = entry.ratingAfter;
    }

    room.results = entries;
    const ttl = room.ranked ? this.options.rankedRoomTtlMs : this.options.casualRoomTtlMs;
    room.timers.close = setTimeout(() => this.closeRoom(code, 'expired'), ttl);

    this.emit('finished', { room, results: entries, reason });
    this.emit('update', room);
    return entries;
  }

  /** El anfitrión vuelve al lobby tras una partida casual. */
  rematch(playerId) {
    const ctx = this._hostRoom(playerId, ROOM_STATES.FINISHED);
    if (!ctx.ok) return ctx;
    const { room } = ctx;
    if (room.ranked) return fail('RANKED_LOCKED', 'Las salas clasificatorias no admiten revancha.');

    clearTimeout(room.timers.close);
    room.timers.close = null;
    room.state = ROOM_STATES.LOBBY;
    room.startAt = null;
    room.startedAt = null;
    room.finishedAt = null;
    room.results = null;
    room.departed = [];
    room.rounds = null;
    room.round = 0;
    room.currentChart = null;
    for (const p of room.players.values()) this._resetPlayer(p);

    this.emit('update', room);
    return { ok: true, room };
  }

  closeRoom(code, reason = 'closed') {
    const room = this.rooms.get(code);
    if (!room) return false;
    this._clearTimers(room);
    const playerIds = [...room.players.keys()];
    for (const id of playerIds) this.playerRoom.delete(id);
    this.rooms.delete(code);
    this.emit('closed', { code, reason, playerIds });
    return true;
  }

  dispose() {
    for (const code of [...this.rooms.keys()]) this.closeRoom(code, 'shutdown');
    this.removeAllListeners();
  }

  // ------------------------------------------------------------------
  // Internos
  // ------------------------------------------------------------------

  _newPlayer(player) {
    return {
      id: player.id,
      clientId: player.clientId ?? null,
      nickname: player.nickname,
      country: player.country ?? null,
      rating: player.rating,
      ready: false,
      wantsStart: false, // sala de espera: quiere empezar con los jugadores que hay
      joinedAt: Date.now(),
      chart: null, // canción propia (clasificatoria, o invitado en casual por turnos)
      more: [], // canciones extra (2.ª, 3.ª, 4.ª) del jugador
      carry: { combo: 0, maxCombo: 0 }, // combo con el que entra en la ronda en curso
      baseSpeed: LIMITS.SPEED_DEFAULT, // velocidad de notas general del jugador (x1-x7)
      speeds: {}, // velocidad propia por canción: `${ownerId}:${slot}` -> x1-x7 (si falta, baseSpeed)
      history: [], // por turnos: resultado de cada ronda ya jugada
      stats: emptyStats(),
      finished: false,
      finishedAt: null,
      rejected: 0,
    };
  }

  /** Canción que juega un jugador: la suya en clasificatoria, la de la ronda en curso en casual. */
  _chartOf(room, player) {
    return room.currentChart || (room.ranked ? player.chart : room.settings);
  }

  /** Canciones de un jugador en orden: la 1.ª (la de la sala si es el anfitrión casual) y sus extras. [] si aún no eligió. */
  _pickList(room, p) {
    // Casual: solo el anfitrión tiene canciones; los invitados no eligen ninguna.
    if (!room.ranked && p.id !== room.hostId) return [];
    const first = !room.ranked && p.id === room.hostId ? room.settings : p.chart;
    if (!first || !first.songId || !first.durationMs || !first.totalNotes) return [];
    return [makeChart(first), ...p.more.map(makeChart)];
  }

  /**
   * Lista de rondas: reparto por turnos (anfitrión primero, luego por orden de entrada): 1.ª canción de cada
   * jugador, después la 2.ª de cada uno, etc., hasta SET_SONGS_MAX en total.
   * Devuelve null si a algún jugador le falta canción (con `partial: true` los salta: sirve para previsualizar).
   */
  _buildRounds(room, { partial = false } = {}) {
    // Casual: solo cuentan las canciones del anfitrión. Clasificatoria: reparto entre todos los jugadores.
    const ids = room.ranked ? [room.hostId, ...[...room.players.keys()].filter((id) => id !== room.hostId)] : [room.hostId];
    const lists = [];
    for (const id of ids) {
      const p = room.players.get(id);
      const picks = this._pickList(room, p);
      if (picks.length === 0 && !partial) return null;
      lists.push({ p, picks });
    }
    const rounds = [];
    const cap = this._songCap(room);
    for (let k = 0; rounds.length < cap; k += 1) {
      let added = false;
      for (const { p, picks } of lists) {
        if (rounds.length >= cap) break;
        if (k >= picks.length) continue;
        rounds.push({ ownerId: p.id, ownerNickname: p.nickname, slot: k, chart: picks[k] });
        added = true;
      }
      if (!added) break;
    }
    return rounds;
  }

  /** Cambiar canciones invalida el "listo": solo el del jugador, salvo anfitrión casual (cambia el plan de todos). */
  _resetReady(room, playerId, all) {
    if (all) for (const p of room.players.values()) p.ready = false;
    else room.players.get(playerId).ready = false;
  }

  /** Deja la sala lista para jugar por turnos (ronda 0). false si a alguien le falta canción. */
  _prepareRounds(room) {
    const rounds = this._buildRounds(room);
    if (!rounds) return false;
    room.rounds = rounds;
    room.round = 0;
    room.currentChart = rounds[0].chart;
    return true;
  }

  /** Resultado de la ronda en curso de un jugador (se guarda en p.history). */
  _roundEntry(room, p) {
    const chart = room.rounds[room.round].chart;
    const stats = { ...p.stats };
    // El combo solo se corta si el jugador NO terminó la canción (abandono o tiempo agotado).
    // Antes se exigía además judgedCount >= totalNotes: si el cliente terminaba con alguna nota menos juzgada
    // (o el nº de notas del servidor no coincidía exactamente con el chart del cliente), el combo se ponía a 0
    // al empezar la canción siguiente aunque no se hubiera fallado ninguna nota.
    const complete = p.finished || judgedCount(stats) >= chart.totalNotes;
    return {
      round: room.round,
      songId: chart.songId,
      difficulty: chart.difficulty,
      totalNotes: chart.totalNotes,
      stats,
      finished: p.finished,
      comboEnd: complete ? stats.combo : 0,
    };
  }

  _resetPlayer(p) {
    p.ready = false;
    p.history = [];
    p.carry = { combo: 0, maxCombo: 0 };
    p.stats = emptyStats();
    p.finished = false;
    p.finishedAt = null;
    p.rejected = 0;
  }

  _generateCode() {
    const { codeLength } = this.options;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      let code = '';
      for (let i = 0; i < codeLength; i += 1) {
        code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  _hostRoom(playerId, requiredState) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return fail('NOT_IN_ROOM', 'No estás en ninguna sala.');
    if (room.hostId !== playerId) return fail('NOT_HOST', 'Solo el anfitrión puede hacer esto.');
    if (requiredState && room.state !== requiredState) {
      return fail('INVALID_STATE', `Acción no disponible en el estado "${room.state}".`);
    }
    return { ok: true, room };
  }

  _chartComplete(room) {
    const s = room.settings;
    return Boolean(s.songId && s.durationMs && s.totalNotes);
  }

  /** Duración de la canción más larga de la sala. */
  _maxDuration(room) {
    if (room.currentChart) return room.currentChart.durationMs;
    if (!room.ranked) return room.settings.durationMs;
    let max = 0;
    for (const p of room.players.values()) max = Math.max(max, p.chart?.durationMs ?? 0);
    return max;
  }

  /** Clasificatoria: arranca la cuenta atrás en cuanto todos han elegido canción y están listos. */
  _maybeStartRanked(room) {
    if (!room.ranked || room.waiting || room.state !== ROOM_STATES.LOBBY) return;
    if (room.players.size < this.options.minPlayersToStart) return;
    for (const p of room.players.values()) {
      if (!p.chart || !p.ready) return;
      if (this._pickList(room, p).length < this._quota(room, p.id)) return;
    }
    if (!this._prepareRounds(room)) return;
    this._beginCountdown(room);
  }

  /** Clasificatoria: cada jugador elige UNA canción (con 6 jugadores se juegan 6 canciones). */
  // eslint-disable-next-line no-unused-vars
  _quota(room, playerId) {
    return 1;
  }

  /** Máximo de canciones de la partida: en clasificatoria, una por jugador; en casual, SET_SONGS_MAX. */
  _songCap(room) {
    return room.ranked ? Math.max(1, room.players.size) : LIMITS.SET_SONGS_MAX;
  }

  // ---- Sala de espera (clasificatoria online) ----
  _openOnlineRoom() {
    for (const room of this.rooms.values()) {
      if (room.ranked && room.waiting && room.state === ROOM_STATES.LOBBY && room.players.size < room.maxPlayers) return room;
    }
    return null;
  }

  _resetVotes(room) {
    for (const p of room.players.values()) p.wantsStart = false;
  }

  /** Empieza la selección de canciones si la sala está completa o si todos (mínimo 2) quieren empezar ya. */
  _maybeEndWaiting(room) {
    if (!room.waiting || room.state !== ROOM_STATES.LOBBY) return;
    const n = room.players.size;
    const full = n >= room.maxPlayers;
    const allWant = n >= this.options.minPlayersToStart && [...room.players.values()].every((p) => p.wantsStart);
    if (full || allWant) this._startPicking(room);
  }

  _startPicking(room) {
    room.waiting = false;
    this._resetVotes(room);
    for (const p of room.players.values()) p.ready = false;
    this.emit('pickStart', room);
    this.beginRankedPick(room.code); // abre el reloj de selección y envía el estado a todos
  }

  _onPickTimeout(code) {
    const room = this.rooms.get(code);
    if (!room || !room.ranked || room.state !== ROOM_STATES.LOBBY) return;
    room.timers.pick = null;

    // Se acabó el tiempo: a quien le falten canciones se le completan (al azar); sin canciones y sin alternativa, se le saca.
    const auto = () => (typeof this.options.autoPick === 'function' ? this.options.autoPick() : null);
    for (const p of [...room.players.values()]) {
      const need = this._quota(room, p.id);
      if (!p.chart) {
        const first = auto();
        if (!first) { this.leaveRoom(p.id, 'no_pick'); continue; }
        p.chart = makeChart(first);
      }
      while (this._pickList(room, p).length < need) {
        const next = auto();
        p.more.push(makeChart(next || p.more[p.more.length - 1] || p.chart)); // sin alternativa, repite su última canción
      }
    }

    const current = this.rooms.get(code);
    if (!current) return; // se cerró al quedarse sin jugadores
    if (current.players.size < this.options.minPlayersToStart) {
      this.closeRoom(code, 'not_enough_players');
      return;
    }
    for (const p of current.players.values()) p.ready = true;
    if (!this._prepareRounds(current)) {
      this.closeRoom(code, 'not_enough_players');
      return;
    }
    this._beginCountdown(current);
  }

  _allFinished(room) {
    return room.players.size > 0 && [...room.players.values()].every((p) => p.finished);
  }

  _clearTimers(room) {
    clearTimeout(room.timers.countdown);
    clearTimeout(room.timers.end);
    clearInterval(room.timers.scoreboard);
    clearTimeout(room.timers.close);
    clearTimeout(room.timers.pick);
    room.timers = { countdown: null, end: null, scoreboard: null, close: null, pick: null };
  }

  _beginCountdown(room, { delayMs = this.options.countdownMs, nextRound = false } = {}) {
    clearTimeout(room.timers.pick);
    room.timers.pick = null;
    room.pickDeadline = null;
    room.state = ROOM_STATES.COUNTDOWN;
    room.startAt = Date.now() + delayMs;
    if (!nextRound) {
      room.departed = [];
      room.results = null;
      for (const p of room.players.values()) {
        p.history = [];
        p.carry = { combo: 0, maxCombo: 0 };
      }
    }
    for (const p of room.players.values()) {
      // El combo heredado de la ronda anterior se mantiene (en la 1.ª ronda es 0).
      p.stats = { ...emptyStats(), combo: p.carry.combo, maxCombo: p.carry.maxCombo };
      p.finished = false;
      p.finishedAt = null;
      p.rejected = 0;
    }
    room.timers.countdown = setTimeout(() => this._beginPlaying(room.code), delayMs);

    this.emit('update', room);
    this.emit('countdown', room);
  }

  _beginPlaying(code) {
    const room = this.rooms.get(code);
    if (!room || room.state !== ROOM_STATES.COUNTDOWN) return;

    room.state = ROOM_STATES.PLAYING;
    room.startedAt = Date.now();
    room.timers.countdown = null;
    room.timers.end = setTimeout(
      () => this._endRound(code, 'timeout'),
      this._maxDuration(room) + this.options.finishGraceMs
    );
    room.timers.scoreboard = setInterval(() => {
      if (!room.dirty) return;
      room.dirty = false;
      this.emit('scoreboard', room);
    }, this.options.scoreboardIntervalMs);

    this.emit('update', room);
    this.emit('started', room);
  }

  /** Devuelve un texto con el motivo del rechazo, o null si la actualización es plausible. */
  _checkPlausibility(room, player, stats) {
    const chart = this._chartOf(room, player);
    if (!chart || !chart.totalNotes || !chart.durationMs) return 'No hay canción asignada.';
    const { totalNotes, durationMs } = chart;
    const elapsed = Date.now() - room.startAt;
    if (elapsed < -500) return 'La partida aún no ha comenzado.';

    const judged = judgedCount(stats);
    if (judged > totalNotes) return 'Hay más notas juzgadas que notas en la canción.';

    const progress = Math.min(1, (elapsed + LIMITS.PROGRESS_TOLERANCE_MS) / durationMs);
    const allowed = Math.min(totalNotes, Math.ceil(totalNotes * progress * LIMITS.PROGRESS_SLACK));
    if (judged > allowed) return 'Progreso imposible para el tiempo transcurrido.';

    if (stats.score > judged * LIMITS.MAX_SCORE_PER_NOTE) return 'Puntuación imposible.';

    for (const field of MONOTONIC_FIELDS) {
      if (stats[field] < player.stats[field]) return `El campo "${field}" no puede disminuir.`;
    }
    return null;
  }

  _scoreRow(room, p, left) {
    // Casual por turnos: la puntuación en vivo es la suma de las rondas ya jugadas + la actual.
    let score = p.stats.score;
    if (room.rounds) {
      const base = p.history.reduce((a, r) => a + r.stats.score, 0);
      score = left ? base : base + p.stats.score;
    }
    return {
      playerId: p.id,
      nickname: p.nickname,
      country: p.country ?? null,
      score,
      combo: p.stats.combo,
      maxCombo: p.stats.maxCombo,
      accuracy: accuracyOf(p.stats, judgedCount(p.stats)),
      finished: p.finished,
      songId: p.chart ? p.chart.songId : null,
      left,
    };
  }

  _resultEntry(room, p, left) {
    if (room.rounds) return this._multiRoundEntry(room, p, left);
    const chart = this._chartOf(room, p);
    const totalNotes = chart ? chart.totalNotes : 0;
    return {
      playerId: p.id,
      clientId: p.clientId,
      nickname: p.nickname,
      country: p.country ?? null,
      songId: chart ? chart.songId : null,
      difficulty: chart ? chart.difficulty : null,
      totalNotes,
      rank: 0,
      score: p.stats.score,
      maxCombo: p.stats.maxCombo,
      perfect: p.stats.perfect,
      great: p.stats.great,
      good: p.stats.good,
      miss: p.stats.miss,
      // Las notas no juzgadas cuentan como falladas.
      accuracy: accuracyOf(p.stats, totalNotes),
      finished: p.finished,
      finishedAt: p.finishedAt,
      left,
      ratingBefore: p.rating,
      ratingChange: 0,
      ratingAfter: p.rating,
    };
  }

  /** Resultado final de una partida por turnos: suma de todas las rondas jugadas por el jugador. */
  _multiRoundEntry(room, p, left) {
    const h = p.history;
    const sum = (k) => h.reduce((a, r) => a + r.stats[k], 0);
    const totalNotes = h.reduce((a, r) => a + r.totalNotes, 0);
    const stats = { perfect: sum('perfect'), great: sum('great'), good: sum('good'), miss: sum('miss') };
    return {
      playerId: p.id,
      clientId: p.clientId,
      nickname: p.nickname,
      country: p.country ?? null,
      songId: null,
      difficulty: null,
      totalNotes,
      rounds: h.map((r) => ({
        songId: r.songId,
        difficulty: r.difficulty,
        score: r.stats.score,
        accuracy: accuracyOf(r.stats, r.totalNotes),
        maxCombo: r.stats.maxCombo, // racha más larga hasta el final de esa canción (acumulada)
        comboEnd: r.comboEnd, // combo con el que se pasó a la siguiente
      })),
      rank: 0,
      score: sum('score'),
      // Combo encadenado entre canciones: la mejor racha de TODA la partida y el combo con el que se terminó.
      maxCombo: h.reduce((a, r) => Math.max(a, r.stats.maxCombo), 0),
      finalCombo: h.length ? h[h.length - 1].comboEnd : 0,
      ...stats,
      accuracy: accuracyOf(stats, totalNotes),
      finished: p.finished,
      finishedAt: p.finishedAt,
      left,
      ratingBefore: p.rating,
      ratingChange: 0,
      ratingAfter: p.rating,
    };
  }
}

module.exports = {
  RoomManager,
  ROOM_STATES,
  DEFAULT_OPTIONS,
  computeRatingChanges,
  pointsForRank,
  accuracyOf,
};
