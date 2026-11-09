'use strict';
/* Ajustes para móvil/tablet: menú de partida, pantalla completa, pantalla encendida y gestos.
 * Va en public/js/mobile.js (se carga al final de index.html). */
(function () {
  const body = document.body;
  const wrap = document.querySelector('.game-wrap');
  const btn = document.getElementById('btn-game-menu');
  const isPlaying = () => body.classList.contains('playing');

  // Botón ☰ de la partida: abre/cierra el marcador (volumen, pantalla completa, salir)
  if (wrap && btn) {
    const setOpen = (open) => {
      wrap.classList.toggle('menu-open', open);
      btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', () => setOpen(!wrap.classList.contains('menu-open')));
    // Al salir de la partida el menú se cierra para la siguiente
    new MutationObserver(() => { if (!isPlaying()) setOpen(false); })
      .observe(body, { attributes: true, attributeFilter: ['class'] });
  }

  // iPhone/iPad (Safari) no soportan la API de pantalla completa: se ocultan esos botones en vez de fallar
  const de = document.documentElement;
  if (!document.fullscreenEnabled || !de.requestFullscreen) {
    for (const id of ['btn-fs', 'btn-fs-menu']) {
      const b = document.getElementById(id);
      if (b) b.hidden = true;
    }
  }

  // Mantener la pantalla encendida mientras se juega
  let lock = null;
  async function wake() {
    if (!('wakeLock' in navigator) || lock) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch (e) { /* no permitido: se ignora */ }
  }
  function sleep() { if (lock) { lock.release().catch(() => {}); lock = null; } }
  new MutationObserver(() => (isPlaying() ? wake() : sleep()))
    .observe(body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isPlaying()) wake(); });

  // Durante la partida: sin menú contextual (pulsación larga) ni zoom por pellizco
  document.addEventListener('contextmenu', (e) => { if (isPlaying()) e.preventDefault(); });
  for (const ev of ['gesturestart', 'gesturechange']) {
    document.addEventListener(ev, (e) => { if (isPlaying()) e.preventDefault(); });
  }

  // Durante la partida, 2+ dedos sobre el canvas no deben disparar zoom, gestos del navegador ni scroll.
  // Solo se bloquea sobre el canvas: los botones del menú (☰, volumen, salir) siguen funcionando.
  const isStage = (t) => t && t.id === 'stage';
  for (const ev of ['touchstart', 'touchmove']) {
    document.addEventListener(ev, (e) => { if (isPlaying() && isStage(e.target)) e.preventDefault(); }, { passive: false });
  }

  // Al girar el móvil, el canvas se reajusta (game.js escucha 'resize')
  window.addEventListener('orientationchange', () => {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 250);
  });
})();
