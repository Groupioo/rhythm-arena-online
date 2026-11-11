'use strict';
/**
 * Cuentas de jugador: apodo + contraseña (+ nacionalidad).
 * - Contraseñas con scrypt + sal única. Nunca se guardan en claro.
 * - Almacén intercambiable (src/accountStore.js): Firestore en producción. Cada cuenta es un documento cuyo id es el
 *   hash del apodo en minúsculas, y `create()` garantiza que no haya dos cuentas con el mismo apodo.
 * - Tras iniciar sesión se entrega un token aleatorio (se guarda solo su hash) para reconectar sin pedir la contraseña.
 * - Freno de fuerza bruta: 5 fallos seguidos bloquean ese apodo 60 s.
 * - Las cuentas usadas desde el arranque se conservan en memoria; los cambios (rating, partidas, tokens) se agrupan y se
 *   escriben cada pocos segundos para gastar pocas escrituras.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const { ok, fail, validateNickname, cleanText } = require('./validation');
const { COUNTRY_SET } = require('./countries');

const scrypt = promisify(crypto.scrypt);
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;
const MAX_TOKENS = 5; // sesiones recordadas por cuenta (móvil, PC...)
const MAX_FAILS = 5;
const LOCK_MS = 60_000;
const FLUSH_MS = 3_000;
const PERSISTED = ['nickname', 'country', 'clientId', 'rating', 'games', 'wins', 'losses', 'draws', 'bio', 'avatar', 'salt', 'hash', 'tokens', 'createdAt'];
const BIO_MAX = 160;
const AVATAR_MAX = 60_000; // caracteres del data URL (≈45 KB); el cliente lo reduce a 192x192 JPEG

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const keyOf = (nickname) => nickname.normalize('NFKC').toLowerCase();
const idOf = (key) => sha256(key);

function createAccounts({ store, initialRating, log = console }) {
  const byKey = new Map(); // apodo en minúsculas -> cuenta (en memoria)
  const byClientId = new Map();
  const dirty = new Set();
  const fails = new Map(); // apodo -> { n, until }
  let timer = null;

  function remember(key, account) {
    byKey.set(key, account);
    byClientId.set(account.clientId, account);
    return account;
  }
  async function getAccount(key) {
    if (byKey.has(key)) return byKey.get(key);
    const data = await store.get(idOf(key));
    return data ? remember(key, data) : null;
  }

  // ---- Escritura agrupada ----
  const pick = (a) => Object.fromEntries(PERSISTED.map((k) => [k, a[k]]).filter(([, v]) => v !== undefined));
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const batch = [...dirty]; dirty.clear();
    await Promise.all(batch.map((a) => store.update(idOf(keyOf(a.nickname)), pick(a)).catch((e) => {
      dirty.add(a); log.error('[accounts] No se pudo guardar', a.nickname, e.message);
    })));
  }
  function save(account) {
    if (account) dirty.add(account);
    if (!timer) { timer = setTimeout(() => flush().catch(() => {}), FLUSH_MS); timer.unref?.(); }
  }

  // ---- Utilidades ----
  function validatePassword(raw) {
    if (typeof raw !== 'string') return fail('INVALID_PASSWORD', 'La contraseña debe ser texto.');
    if (raw.length < PASSWORD_MIN || raw.length > PASSWORD_MAX) {
      return fail('INVALID_PASSWORD', `La contraseña debe tener entre ${PASSWORD_MIN} y ${PASSWORD_MAX} caracteres.`);
    }
    return ok(raw);
  }
  function newToken(account) {
    const token = crypto.randomBytes(32).toString('hex');
    account.tokens = [...(account.tokens || []), sha256(token)].slice(-MAX_TOKENS);
    return token;
  }
  const isLocked = (k) => { const f = fails.get(k); return f && f.until > Date.now(); };
  function noteFail(k) {
    const f = fails.get(k) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= MAX_FAILS) { f.n = 0; f.until = Date.now() + LOCK_MS; }
    fails.set(k, f);
  }

  // ---- Perfil ----
  function validateBio(raw) {
    if (typeof raw !== 'string') return fail('INVALID_BIO', 'La biografía debe ser texto.');
    const v = cleanText(raw);
    if (v.length > BIO_MAX) return fail('INVALID_BIO', `La biografía no puede superar ${BIO_MAX} caracteres.`);
    return ok(v);
  }
  /** null = quitar foto. Solo data URL jpeg/png/webp, con tamaño máximo y firma de archivo comprobada. */
  function validateAvatar(raw) {
    if (raw === null) return ok(null);
    const m = typeof raw === 'string' && raw.length <= AVATAR_MAX ? /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw) : null;
    if (!m) return fail('INVALID_AVATAR', 'La foto no es válida o es demasiado grande.');
    const head = Buffer.from(m[2].slice(0, 24), 'base64');
    const good = m[1] === 'jpeg' ? head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
      : m[1] === 'png' ? head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      : head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
    return good ? ok(raw) : fail('INVALID_AVATAR', 'El archivo no es una imagen válida.');
  }
  /** data: { bio?, avatar? }  (avatar: string = nueva foto, null = quitar, ausente = sin cambios) */
  function updateProfile(account, data) {
    const changes = {};
    if (data.bio !== undefined) { const r = validateBio(data.bio); if (!r.ok) return r; changes.bio = r.value; }
    if (data.avatar !== undefined) { const r = validateAvatar(data.avatar); if (!r.ok) return r; changes.avatar = r.value; }
    Object.assign(account, changes);
    save(account);
    return ok(account);
  }
  /** outcome: 'win' | 'loss' | 'draw' (partida clasificatoria terminada) */
  function recordResult(account, outcome) {
    const k = outcome === 'win' ? 'wins' : outcome === 'draw' ? 'draws' : 'losses';
    account[k] = (account[k] || 0) + 1;
    save(account);
  }

  // ---- API ----
  async function register({ nickname, password, password2, country }) {
    const nick = validateNickname(nickname);
    if (!nick.ok) return nick;
    const pw = validatePassword(password);
    if (!pw.ok) return pw;
    if (password !== password2) return fail('PASSWORD_MISMATCH', 'Las contraseñas no coinciden.');
    if (typeof country !== 'string' || !COUNTRY_SET.has(country.toUpperCase())) return fail('INVALID_COUNTRY', 'Elige tu nacionalidad.');
    const k = keyOf(nick.value);
    if (await getAccount(k)) return fail('NICKNAME_TAKEN', 'Ese apodo ya está en uso.');

    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    const account = {
      clientId: crypto.randomUUID(), nickname: nick.value, country: country.toUpperCase(), rating: initialRating, games: 0,
      salt: salt.toString('hex'), hash: hash.toString('hex'), tokens: [], createdAt: Date.now(),
    };
    const token = newToken(account);
    const created = await store.create(idOf(k), pick(account)); // atómico: falla si otro lo registró a la vez
    if (!created) return fail('NICKNAME_TAKEN', 'Ese apodo ya está en uso.');
    remember(k, account);
    return ok({ account, token });
  }

  async function login({ nickname, password }) {
    const generic = fail('BAD_CREDENTIALS', 'Apodo o contraseña incorrectos.');
    const nick = validateNickname(nickname);
    if (!nick.ok || typeof password !== 'string' || password.length > PASSWORD_MAX) return generic;
    const k = keyOf(nick.value);
    if (isLocked(k)) return fail('LOCKED', 'Demasiados intentos. Espera un minuto.');

    const account = await getAccount(k);
    // Si la cuenta no existe se hace igualmente un hash, para no revelar por tiempo qué apodos existen
    const salt = account ? Buffer.from(account.salt, 'hex') : Buffer.alloc(16);
    const got = await scrypt(password, salt, 64);
    const good = account && crypto.timingSafeEqual(got, Buffer.from(account.hash, 'hex'));
    if (!good) { noteFail(k); return generic; }

    fails.delete(k);
    const token = newToken(account);
    save(account);
    return ok({ account, token });
  }

  /** Reconexión / inicio automático con el token guardado en el navegador. */
  async function resume({ nickname, token }) {
    const bad = fail('BAD_TOKEN', 'Sesión caducada. Inicia sesión de nuevo.');
    const nick = validateNickname(nickname);
    if (!nick.ok || typeof token !== 'string' || token.length !== 64) return bad;
    const account = await getAccount(keyOf(nick.value));
    if (!account || !(account.tokens || []).includes(sha256(token))) return bad;
    return ok({ account, token });
  }

  /** Cierra la sesión de ese token (cerrar sesión). */
  function revoke(account, token) {
    account.tokens = (account.tokens || []).filter((t) => t !== sha256(String(token)));
    save(account);
  }

  return { register, login, resume, revoke, save, flush, updateProfile, recordResult, getByClientId: (id) => byClientId.get(id) || null };
}

module.exports = { createAccounts };
