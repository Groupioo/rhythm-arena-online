'use strict';

/**
 * Matchmaking por rating con ventana que se amplía con el tiempo de espera.
 *
 * - Cada jugador en cola tiene una ventana: base + crecimiento * segundos esperados
 *   (limitada por maxWindow).
 * - Dos jugadores son compatibles si su diferencia de rating cabe en la ventana
 *   más amplia de los dos (así quien lleva mucho esperando acaba encontrando partida).
 * - Se crea una partida cuando hay `matchSize` jugadores compatibles, o cuando
 *   el jugador más antiguo del grupo lleva `partialAfterMs` esperando y hay al
 *   menos `minPlayers`.
 *
 * Eventos:
 *   'match'   -> { mode, players: [ticket], averageRating }
 *   'timeout' -> ticket   (llevaba demasiado tiempo en cola)
 */

const { EventEmitter } = require('events');
const { fail } = require('./validation');

const DEFAULT_OPTIONS = Object.freeze({
  tickMs: 1_000,
  baseWindow: 100,
  windowGrowthPerSec: 25,
  maxWindow: 1_500,
  minPlayers: 2,
  matchSize: 4,
  partialAfterMs: 15_000,
  maxQueueMs: 120_000,
});

class Matchmaker extends EventEmitter {
  constructor(options = {}) {
    super();
    const merged = { ...DEFAULT_OPTIONS, ...options };
    merged.minPlayers = Math.max(2, merged.minPlayers);
    merged.matchSize = Math.max(merged.minPlayers, merged.matchSize);
    this.options = merged;
    this.queue = new Map(); // playerId -> ticket
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.tickMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  size() {
    return this.queue.size;
  }

  has(playerId) {
    return this.queue.has(playerId);
  }

  /**
   * ticket: { playerId, clientId, nickname, rating, mode?, joinedAt? }
   * `joinedAt` permite devolver a la cola a un jugador sin perder su antigüedad.
   */
  enqueue(ticket) {
    if (this.queue.has(ticket.playerId)) return fail('ALREADY_QUEUED', 'Ya estás en la cola.');
    const entry = {
      playerId: ticket.playerId,
      clientId: ticket.clientId ?? null,
      nickname: ticket.nickname,
      rating: ticket.rating,
      mode: ticket.mode ?? 'ranked',
      joinedAt: ticket.joinedAt ?? Date.now(),
    };
    this.queue.set(entry.playerId, entry);
    return { ok: true, ticket: entry };
  }

  dequeue(playerId) {
    return this.queue.delete(playerId);
  }

  windowFor(ticket, now = Date.now()) {
    const waitedSec = Math.max(0, now - ticket.joinedAt) / 1000;
    return Math.min(
      this.options.maxWindow,
      this.options.baseWindow + this.options.windowGrowthPerSec * waitedSec
    );
  }

  getStatus(playerId, now = Date.now()) {
    const ticket = this.queue.get(playerId);
    if (!ticket) return { queued: false };
    let sameMode = 0;
    for (const t of this.queue.values()) if (t.mode === ticket.mode) sameMode += 1;
    return {
      queued: true,
      mode: ticket.mode,
      waitedMs: now - ticket.joinedAt,
      ratingWindow: Math.round(this.windowFor(ticket, now)),
      playersInQueue: sameMode,
    };
  }

  /**
   * Un ciclo de emparejamiento. Es público para poder probarlo con un `now` simulado.
   * Devuelve el número de partidas formadas.
   */
  tick(now = Date.now()) {
    const { maxQueueMs, matchSize, minPlayers, partialAfterMs } = this.options;

    // 1) Cancelar búsquedas demasiado largas
    for (const ticket of [...this.queue.values()]) {
      if (now - ticket.joinedAt >= maxQueueMs) {
        this.queue.delete(ticket.playerId);
        this.emit('timeout', ticket);
      }
    }

    // 2) Emparejar, empezando por quien lleva más tiempo esperando
    const tickets = [...this.queue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const taken = new Set();
    const groups = [];

    for (const anchor of tickets) {
      if (taken.has(anchor.playerId)) continue;
      const anchorWindow = this.windowFor(anchor, now);

      const candidates = tickets
        .filter(
          (t) =>
            t !== anchor &&
            !taken.has(t.playerId) &&
            t.mode === anchor.mode &&
            Math.abs(t.rating - anchor.rating) <= Math.max(anchorWindow, this.windowFor(t, now))
        )
        .sort((a, b) => Math.abs(a.rating - anchor.rating) - Math.abs(b.rating - anchor.rating))
        .slice(0, matchSize - 1);

      const group = [anchor, ...candidates];
      const isFull = group.length >= matchSize;
      const partialOk = group.length >= minPlayers && now - anchor.joinedAt >= partialAfterMs;

      if (isFull || partialOk) {
        for (const t of group) taken.add(t.playerId);
        groups.push(group);
      }
    }

    // 3) Retirar de la cola y notificar
    for (const group of groups) {
      for (const t of group) this.queue.delete(t.playerId);
      const averageRating = Math.round(group.reduce((sum, t) => sum + t.rating, 0) / group.length);
      this.emit('match', { mode: group[0].mode, players: group, averageRating });
    }
    return groups.length;
  }
}

module.exports = { Matchmaker, DEFAULT_OPTIONS };
