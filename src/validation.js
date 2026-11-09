'use strict';

/**
 * Validación y saneamiento de todo lo que llega desde el cliente.
 * Regla de oro: el cliente nunca es de fiar.
 *
 * Todos los validadores devuelven { ok: true, value } o
 * { ok: false, error: { code, message } }.
 */

const LIMITS = Object.freeze({
  NICKNAME_MIN: 2,
  NICKNAME_MAX: 16,
  CHAT_MAX: 200,
  SONG_ID_MAX: 64,
  DURATION_MIN_MS: 10_000,
  DURATION_MAX_MS: 900_000,
  TOTAL_NOTES_MIN: 1,
  TOTAL_NOTES_MAX: 10_000,
  MAX_SCORE: 100_000_000,
  // Techo generoso de puntos por nota (incluye multiplicadores de combo).
  MAX_SCORE_PER_NOTE: 2_000,
  // Margen para el control de progreso (notas juzgadas vs. tiempo transcurrido).
  PROGRESS_TOLERANCE_MS: 5_000,
  PROGRESS_SLACK: 1.25,
  ROOM_PLAYERS_MIN: 2,
  ROOM_PLAYERS_MAX: 8,
  // Canciones que se encadenan en una partida (el combo continúa de una a otra).
  SET_SONGS_MAX: 4,
  // Velocidad de notas (x1 - x7). Cada jugador fija la suya para cada canción y los demás la ven en el lobby.
  SPEED_MIN: 1,
  SPEED_MAX: 7,
  SPEED_DEFAULT: 2,
});

const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard', 'expert']);

// Sin caracteres ambiguos (0/O, 1/I)
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const SONG_ID_RE = /^[A-Za-z0-9_-]+$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NICKNAME_RE = /^[\p{L}\p{N}_\-. ]+$/u;

// Caracteres de control, de ancho cero y de dirección de texto (bidi)
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2060-\u2069\uFEFF]/g;

const ok = (value) => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, error: { code, message } });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

/** Quita caracteres invisibles/de control y normaliza espacios. */
function cleanText(raw) {
  return raw.normalize('NFKC').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
}

function validateNickname(raw) {
  if (typeof raw !== 'string') {
    return fail('INVALID_NICKNAME', 'El apodo debe ser texto.');
  }
  const value = cleanText(raw);
  if (value.length < LIMITS.NICKNAME_MIN || value.length > LIMITS.NICKNAME_MAX) {
    return fail(
      'INVALID_NICKNAME',
      `El apodo debe tener entre ${LIMITS.NICKNAME_MIN} y ${LIMITS.NICKNAME_MAX} caracteres.`
    );
  }
  if (!NICKNAME_RE.test(value)) {
    return fail('INVALID_NICKNAME', 'El apodo solo puede contener letras, números, espacios, "_", "-" y ".".');
  }
  return ok(value);
}

/** clientId es opcional: si no viene, el servidor genera uno. */
function validateClientId(raw) {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== 'string' || !CLIENT_ID_RE.test(raw)) {
    return fail('INVALID_CLIENT_ID', 'clientId inválido (8-64 caracteres alfanuméricos, "_" o "-").');
  }
  return ok(raw);
}

function normalizeRoomCode(raw, length = 5) {
  if (typeof raw !== 'string') return fail('INVALID_ROOM_CODE', 'Código de sala inválido.');
  const code = raw.trim().toUpperCase();
  if (code.length !== length || ![...code].every((c) => ROOM_CODE_ALPHABET.includes(c))) {
    return fail('INVALID_ROOM_CODE', 'Código de sala inválido.');
  }
  return ok(code);
}

/**
 * Ajustes de sala. Devuelve solo las claves presentes en el payload.
 * Los datos del chart (songId, durationMs, totalNotes) viajan siempre juntos.
 */
function validateRoomSettings(raw, { maxPlayersCap = LIMITS.ROOM_PLAYERS_MAX } = {}) {
  if (raw === undefined || raw === null) return ok({});
  if (!isPlainObject(raw)) return fail('INVALID_PAYLOAD', 'Ajustes de sala inválidos.');

  const value = {};

  const chartKeys = ['songId', 'durationMs', 'totalNotes'];
  const present = chartKeys.filter((k) => raw[k] !== undefined);
  if (present.length > 0) {
    if (present.length !== chartKeys.length) {
      return fail('INCOMPLETE_CHART', 'songId, durationMs y totalNotes deben enviarse juntos.');
    }
    if (typeof raw.songId !== 'string' || raw.songId.length > LIMITS.SONG_ID_MAX || !SONG_ID_RE.test(raw.songId)) {
      return fail('INVALID_SONG', 'songId inválido.');
    }
    if (!isInt(raw.durationMs, LIMITS.DURATION_MIN_MS, LIMITS.DURATION_MAX_MS)) {
      return fail('INVALID_DURATION', 'durationMs fuera de rango.');
    }
    if (!isInt(raw.totalNotes, LIMITS.TOTAL_NOTES_MIN, LIMITS.TOTAL_NOTES_MAX)) {
      return fail('INVALID_TOTAL_NOTES', 'totalNotes fuera de rango.');
    }
    value.songId = raw.songId;
    value.durationMs = raw.durationMs;
    value.totalNotes = raw.totalNotes;
  }

  if (raw.difficulty !== undefined) {
    if (!DIFFICULTIES.includes(raw.difficulty)) {
      return fail('INVALID_DIFFICULTY', `Dificultad inválida. Usa: ${DIFFICULTIES.join(', ')}.`);
    }
    value.difficulty = raw.difficulty;
  }

  if (raw.maxPlayers !== undefined) {
    const upper = Math.min(maxPlayersCap, LIMITS.ROOM_PLAYERS_MAX);
    if (!isInt(raw.maxPlayers, LIMITS.ROOM_PLAYERS_MIN, upper)) {
      return fail('INVALID_MAX_PLAYERS', `maxPlayers debe estar entre ${LIMITS.ROOM_PLAYERS_MIN} y ${upper}.`);
    }
    value.maxPlayers = raw.maxPlayers;
  }

  if (raw.isPrivate !== undefined) {
    if (typeof raw.isPrivate !== 'boolean') return fail('INVALID_PRIVACY', 'isPrivate debe ser booleano.');
    value.isPrivate = raw.isPrivate;
  }

  return ok(value);
}

/** Acepta `true` o `{ ready: true }`. */
function validateReady(raw) {
  const value = isPlainObject(raw) ? raw.ready : raw;
  if (typeof value !== 'boolean') return fail('INVALID_PAYLOAD', 'ready debe ser booleano.');
  return ok(value);
}

/**
 * Estadísticas acumuladas de un jugador durante la canción en curso.
 *
 * El combo se hereda entre canciones: `carry` = { combo, maxCombo } con lo que el jugador traía al
 * empezar esta canción (lo conoce el servidor). Por eso `combo` y `maxCombo` pueden superar los
 * aciertos de ESTA canción, pero nunca lo que traía más los aciertos de esta.
 */
function validateScorePayload(raw, { carry } = {}) {
  if (!isPlainObject(raw)) return fail('INVALID_PAYLOAD', 'Datos de puntuación inválidos.');

  const maxCount = LIMITS.TOTAL_NOTES_MAX;
  const maxChain = LIMITS.TOTAL_NOTES_MAX * LIMITS.SET_SONGS_MAX;
  const fields = {
    score: LIMITS.MAX_SCORE,
    combo: maxChain,
    maxCombo: maxChain,
    perfect: maxCount,
    great: maxCount,
    good: maxCount,
    miss: maxCount,
  };

  const value = {};
  for (const [key, max] of Object.entries(fields)) {
    if (!isInt(raw[key], 0, max)) {
      return fail('INVALID_SCORE', `El campo "${key}" es inválido.`);
    }
    value[key] = raw[key];
  }

  const baseCombo = carry && isInt(carry.combo, 0, maxChain) ? carry.combo : 0;
  const baseMax = carry && isInt(carry.maxCombo, 0, maxChain) ? Math.max(carry.maxCombo, baseCombo) : baseCombo;
  const hits = value.perfect + value.great + value.good;

  if (value.combo > value.maxCombo) {
    return fail('INVALID_SCORE', 'combo no puede superar maxCombo.');
  }
  if (value.combo > baseCombo + hits) {
    return fail('INVALID_SCORE', 'combo no puede superar el combo heredado más los aciertos.');
  }
  if (value.maxCombo > Math.max(baseMax, baseCombo + hits)) {
    return fail('INVALID_SCORE', 'maxCombo no puede superar el combo heredado más los aciertos.');
  }
  if (value.maxCombo < baseMax) {
    return fail('INVALID_SCORE', 'maxCombo no puede ser menor que el combo heredado.');
  }
  return ok(value);
}

/** Hueco de canción de un jugador (0 = la primera). */
function validateSlot(raw) {
  if (raw === undefined || raw === null) return ok(0);
  if (!isInt(raw, 0, LIMITS.SET_SONGS_MAX - 1)) {
    return fail('INVALID_SLOT', `La canción debe estar entre 1 y ${LIMITS.SET_SONGS_MAX}.`);
  }
  return ok(raw);
}

/** Velocidad (entero 1-7) de una canción del lobby. */
function validateSpeed(raw) {
  if (!isInt(raw, LIMITS.SPEED_MIN, LIMITS.SPEED_MAX)) {
    return fail('INVALID_SPEED', `La velocidad debe estar entre x${LIMITS.SPEED_MIN} y x${LIMITS.SPEED_MAX}.`);
  }
  return ok(raw);
}

function validateChatMessage(raw) {
  const text = isPlainObject(raw) ? raw.text : raw;
  if (typeof text !== 'string') return fail('INVALID_MESSAGE', 'El mensaje debe ser texto.');
  const value = cleanText(text);
  if (value.length === 0) return fail('INVALID_MESSAGE', 'El mensaje está vacío.');
  if (value.length > LIMITS.CHAT_MAX) {
    return fail('INVALID_MESSAGE', `El mensaje no puede superar ${LIMITS.CHAT_MAX} caracteres.`);
  }
  return ok(value);
}

function validateTimeSync(raw) {
  if (!isPlainObject(raw) || typeof raw.clientTime !== 'number' || !Number.isFinite(raw.clientTime)) {
    return fail('INVALID_PAYLOAD', 'clientTime inválido.');
  }
  return ok(raw.clientTime);
}

function validateMatchmakingMode(raw) {
  const mode = isPlainObject(raw) && raw.mode !== undefined ? raw.mode : 'ranked';
  if (mode !== 'ranked') return fail('INVALID_MODE', 'Modo de matchmaking no soportado.');
  return ok(mode);
}

/**
 * Limitador por cubo de tokens (token bucket), indexado por clave (socket.id).
 * capacity: ráfaga máxima; refillPerSec: tokens recuperados por segundo.
 */
function createRateLimiter({ capacity, refillPerSec }) {
  const buckets = new Map();
  return {
    consume(key, cost = 1, now = Date.now()) {
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: capacity, updatedAt: now };
        buckets.set(key, bucket);
      }
      const elapsedSec = Math.max(0, now - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
      bucket.updatedAt = now;
      if (bucket.tokens < cost) return false;
      bucket.tokens -= cost;
      return true;
    },
    reset(key) {
      buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
  };
}

module.exports = {
  LIMITS,
  DIFFICULTIES,
  ROOM_CODE_ALPHABET,
  ok,
  fail,
  isPlainObject,
  cleanText,
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
};
