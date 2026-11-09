'use strict';
/* Conexión Socket.IO, promesas para acks y sincronización de reloj con el servidor. */
(function () {
  const socket = io({ transports: ['websocket', 'polling'] });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const net = {
    socket,
    offset: 0, // serverTime ≈ Date.now() + offset
    now() {
      return Date.now() + net.offset;
    },
    req(event, payload) {
      return new Promise((resolve, reject) => {
        socket.timeout(5000).emit(event, payload, (err, res) => {
          if (err) return reject(new Error('El servidor no responde.'));
          if (!res || !res.ok) return reject(new Error(res && res.error ? res.error.message : 'Error desconocido.'));
          return resolve(res.data);
        });
      });
    },
    /** Se queda con la muestra de menor latencia (RTT). */
    async sync(samples = 6) {
      let best = { rtt: Infinity, offset: 0 };
      for (let i = 0; i < samples; i += 1) {
        const t0 = Date.now();
        try {
          const d = await net.req('time:sync', { clientTime: t0 });
          const t1 = Date.now();
          const rtt = t1 - t0;
          if (rtt < best.rtt) best = { rtt, offset: d.serverTime + rtt / 2 - t1 };
        } catch (e) { /* se ignora la muestra */ }
        await sleep(60);
      }
      if (best.rtt < Infinity) net.offset = best.offset;
    },
  };

  window.RA = window.RA || {};
  window.RA.net = net;
})();
