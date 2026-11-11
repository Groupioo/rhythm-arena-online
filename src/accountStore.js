'use strict';
/**
 * Almacenamiento de cuentas. Interfaz: get(id) -> objeto|null, create(id, data) -> bool (false si ya existe), update(id, data).
 *  - Firestore (producción): si existe la variable FIREBASE_SERVICE_ACCOUNT. Solo el servidor accede (firebase-admin),
 *    así que las reglas de Firestore pueden estar en "denegar todo" y nadie puede leer los hashes desde el navegador.
 *  - Archivo JSON (solo desarrollo local): si no hay credenciales. En Render se borra en cada despliegue.
 * Además: top(campo, n) -> las n cuentas con mayor valor en ese campo (ranking mundial). Solo devuelve campos públicos:
 * nunca salt, hash ni tokens.
 */
const fs = require('fs');
const path = require('path');

function parseCredentials(raw) {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'); // JSON directo o en base64
  const cred = JSON.parse(text);
  if (typeof cred.private_key === 'string') cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return cred;
}

const PUBLIC_FIELDS = ['nickname', 'country', 'rating', 'games', 'wins', 'losses', 'draws', 'avatar'];
const publicOnly = (a) => Object.fromEntries(PUBLIC_FIELDS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

function createFirestoreStore(raw) {
  const admin = require('firebase-admin'); // se carga solo si se usa
  admin.initializeApp({ credential: admin.credential.cert(parseCredentials(raw)) });
  const col = admin.firestore().collection('accounts');
  return {
    kind: 'firestore',
    async get(id) { const d = await col.doc(id).get(); return d.exists ? d.data() : null; },
    async create(id, data) {
      try { await col.doc(id).create(data); return true; }
      catch (e) { if (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message))) return false; throw e; }
    },
    async update(id, data) { await col.doc(id).set(data, { merge: true }); },
    // Índice de un solo campo (automático en Firestore): no hace falta crear índices compuestos.
    async top(field, limit) {
      const snap = await col.orderBy(field, 'desc').limit(limit).select(...PUBLIC_FIELDS).get();
      return snap.docs.map((d) => d.data());
    },
  };
}

function createFileStore(file) {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.error('[accounts] No se pudo leer', file, e.message); }
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(db));
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    kind: 'file',
    async get(id) { return db[id] ? { ...db[id] } : null; },
    async create(id, data) { if (db[id]) return false; db[id] = { ...data }; persist(); return true; },
    async update(id, data) { db[id] = { ...(db[id] || {}), ...data }; persist(); },
    async top(field, limit) {
      return Object.values(db)
        .filter((a) => typeof a[field] === 'number')
        .sort((a, b) => b[field] - a[field])
        .slice(0, limit)
        .map(publicOnly);
    },
  };
}

function createAccountStore({ firebaseServiceAccount, file }) {
  if (firebaseServiceAccount) return createFirestoreStore(firebaseServiceAccount);
  return createFileStore(file);
}

module.exports = { createAccountStore };
