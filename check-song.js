'use strict';
/* Diagnóstico: node check-song.js "demo/SDO/BLACK CODE"
 * Dice por qué una carpeta de canción se reconoce o se omite. Va en la raíz del proyecto, junto a server.js. */
const path = require('path');
const { createSongLibrary } = require('./songs');
const dir = path.resolve(process.argv[2] || 'demo');
const lib = createSongLibrary({ dir });
const list = lib.list();
if (!list.length) console.log('\n❌ No se reconoció ninguna canción. Mira el aviso "[songs] Se omite..." de arriba: ese es el motivo.');
for (const s of list) {
  console.log(`\n✅ ${s.id}: "${s.title}" — ${s.artist || 's/artista'} · ${s.bpm} BPM · ${Math.round(s.durationMs / 1000)} s · portada: ${s.cover ? 'sí' : 'no'}`);
  for (const [d, v] of Object.entries(s.difficulties)) console.log(`   ${d}: ${v.totalNotes} notas (nivel ${v.meter})`);
}
