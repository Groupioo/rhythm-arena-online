#!/usr/bin/env node
'use strict';
/**
 * Genera un chart.json base a partir del BPM (rejilla de tiempo fija). Es un punto de partida:
 * ábrelo y ajusta a mano, o sustitúyelo por el de tu editor de charts.
 *
 *   node tools/make-chart.js --bpm 128 --duration 183000 --offset 420 \
 *        --title "Mi canción" --artist "Artista" --out public/songs/mi-cancion/chart.json
 *
 *  --offset = ms hasta el primer beat del audio (silencio inicial del MP3).
 */
const fs = require('fs');
const path = require('path');

const args = {};
process.argv.slice(2).forEach((x, i, a) => { if (x.startsWith('--')) args[x.slice(2)] = a[i + 1]; });
const bpm = Number(args.bpm) || 120, duration = Number(args.duration) || 60000, offset = Number(args.offset) || 0;
const out = args.out || 'chart.json';
const beat = 60000 / bpm;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// div = notas por pulso (1 = negras, 2 = corcheas, 4 = semicorcheas); p = probabilidad de poner nota en cada hueco
const PROFILES = {
  easy:   { level: 3,  div: 1, p: 0.55 },
  normal: { level: 6,  div: 1, p: 0.95 },
  hard:   { level: 8,  div: 2, p: 0.60 },
  expert: { level: 10, div: 2, p: 0.92, burst: 0.12 },
};

function build(name, prof) {
  const rand = rng(bpm * 1000 + name.length), notes = [];
  const first = offset + beat * 4, last = duration - 2000;
  let prev = -1, run = 0;
  const push = (t) => {
    let lane = Math.floor(rand() * 4);
    if (lane === prev && run >= 2) lane = (lane + 1 + Math.floor(rand() * 3)) % 4;
    run = lane === prev ? run + 1 : 1; prev = lane;
    notes.push([Math.round(t), lane]);
  };
  for (let t = first; t <= last; t += beat / prof.div) {
    if (rand() < prof.p) push(t);
    if (prof.burst && rand() < prof.burst && t + beat / 4 <= last) push(t + beat / 4);
  }
  return { level: prof.level, notes };
}

const difficulties = {};
for (const [name, prof] of Object.entries(PROFILES)) difficulties[name] = build(name, prof);

const chart = {
  version: 1,
  meta: { title: args.title || 'Sin título', artist: args.artist || 'Desconocido', bpm, durationMs: duration, offsetMs: 0 },
  difficulties,
};
const text = JSON.stringify(chart, null, 2).replace(/\[\s+(\d+),\s+(\d)\s+\]/g, '[$1,$2]');
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, text + '\n');
console.log(`OK ${out}: ` + Object.entries(difficulties).map(([k, v]) => `${k}=${v.notes.length}`).join('  '));
