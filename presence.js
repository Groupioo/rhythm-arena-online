'use strict';
/* Jugadores conectados (SERVIDOR). Va en la raíz del proyecto, junto a server.js.
 *
 * Integración en server.js (3 líneas):
 *
 *   const createPresence = require('./presence');
 *   const presence = createPresence(io);                       // después de crear `io`
 *
 *   io.on('connection', (socket) => {
 *     socket.emit('presence:update', presence.snapshot());     // el que llega ve la lista al instante (también en el login)
 *     socket.on('disconnect', () => presence.leave(socket));
 *     ...
 *     // dentro de tu handler 'session:hello', justo después de validar el apodo y antes de responder:
 *     presence.join(socket, profile.nickname);
 *   });
 */
const MAX_LIST = 100; // apodos que se envían como máximo (el contador siempre es el total real)

module.exports = function createPresence(io) {
  const users = new Map(); // socket.id -> apodo
  let timer = null;

  const snapshot = () => ({ count: users.size, players: [...users.values()].slice(0, MAX_LIST) });

  // Agrupa cambios seguidos (p. ej. muchos entrando a la vez) en un solo envío
  function broadcast() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; io.emit('presence:update', snapshot()); }, 250);
  }

  return {
    snapshot,
    join(socket, nickname) {
      const isNew = !users.has(socket.id);
      users.set(socket.id, String(nickname).slice(0, 16));
      broadcast();
      if (isNew) socket.broadcast.emit('presence:joined', { nickname: String(nickname).slice(0, 16) });
    },
    leave(socket) { if (users.delete(socket.id)) broadcast(); },
  };
};
