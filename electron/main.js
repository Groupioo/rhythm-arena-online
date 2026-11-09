'use strict';
/**
 * Rhythm Arena Online - Proceso principal de Electron.
 *
 * Va en  electron/main.js  (NO es el main.js del navegador, que vive en public/js/main.js).
 *
 * Qué hace:
 *   1. Elige un puerto libre y configura las variables de entorno ANTES de cargar server.js
 *      (server.js lee process.env al hacer require y arranca solo).
 *   2. Arranca el servidor Express + Socket.IO dentro del propio proceso de Electron.
 *   3. Espera a que /health responda y abre la ventana apuntando a ese servidor.
 *
 * Modo cliente remoto: si pones una URL en REMOTE_SERVER_URL, NO se arranca servidor local y la
 * ventana carga ese servidor (así todos los jugadores comparten salas y clasificatoria).
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

// ---------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------
// Servidor online compartido. Orden de prioridad:
//   1. RA_SERVER_URL (variable de entorno)
//   2. DEFAULT_REMOTE_URL (URL fija; úsala si tienes VPS/dominio)
//   3. DISCOVERY_URL: archivo de texto PÚBLICO que contiene la URL actual del túnel (se lee al arrancar)
//   4. Si nada responde -> servidor local (el modo "Un jugador" sigue funcionando sin conexión)
const DEFAULT_REMOTE_URL = '';
const DISCOVERY_URL = 'https://raw.githubusercontent.com/Groupioo/rhythm-arena-online/main/server-url.txt';
const REMOTE_SERVER_URL = process.env.RA_SERVER_URL || DEFAULT_REMOTE_URL;
const DEFAULT_PORT = 3000;
const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = !app.isPackaged;

// Audio y vídeo sin gesto previo del usuario; sin limitar la ventana en segundo plano (juego de ritmo).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let baseUrl = '';
let songsDir = '';
let logFile = '';

/** Duplica console.* en %APPDATA%/<app>/logs/server.log (ahí salen los avisos "[songs] Se omite ..."). */
function setupFileLog() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'server.log');
  try { fs.writeFileSync(logFile, `--- Inicio ${new Date().toISOString()} ---\n`); } catch (e) { return; }
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        fs.appendFileSync(logFile, `${args.map((a) => (typeof a === 'string' ? a : require('util').inspect(a))).join(' ')}\n`);
      } catch (e) { /* sin log */ }
      original(...args);
    };
  }
}

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
function isPortFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

function randomFreePort(host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function pickPort(preferred, host) {
  return (await isPortFree(preferred, host)) ? preferred : randomFreePort(host);
}

function waitForServer(url, { retries = 75, delayMs = 200 } = {}) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryOnce = () => {
      attempts += 1;
      const req = http.get(`${url}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        return retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => req.destroy());
    };
    const retry = () => {
      if (attempts >= retries) return reject(new Error('El servidor local no respondió a tiempo.'));
      return setTimeout(tryOnce, delayMs);
    };
    tryOnce();
  });
}

/** Copia las canciones de demostración a una carpeta escribible la primera vez (instalado). */
function prepareSongsDir() {
  if (IS_DEV) return path.join(APP_ROOT, 'demo'); // en desarrollo se usa la carpeta del proyecto
  // Instalado: se usan las canciones directamente desde resources/demo. NO se copian a %APPDATA%
  // (son ~1,5 GB y llenarían el disco C:). El servidor solo lee esa carpeta, nunca escribe en ella.
  const bundled = path.join(process.resourcesPath, 'demo');
  if (fs.existsSync(bundled)) return bundled;
  console.warn('[songs] No existe la carpeta empaquetada:', bundled);
  const dir = path.join(app.getPath('userData'), 'songs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** GET simple (http/https) con tiempo límite. Devuelve { status, body }. */
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

/** Devuelve la URL del servidor online a usar, o '' para arrancar el servidor local. */
async function resolveRemoteUrl() {
  if (REMOTE_SERVER_URL) return REMOTE_SERVER_URL.replace(/\/+$/, '');
  if (!DISCOVERY_URL || DISCOVERY_URL.includes('TU_USUARIO')) return '';
  try {
    // El parámetro t evita que la caché devuelva una URL vieja.
    const file = await httpGet(`${DISCOVERY_URL}?t=${Date.now()}`, 5000);
    if (file.status !== 200) throw new Error(`discovery ${file.status}`);
    const url = file.body.trim().split(/\s+/)[0].replace(/\/+$/, '');
    if (!/^https:\/\/[^\s/]+$/i.test(url)) throw new Error('URL no válida en el archivo');
    const health = await httpGet(`${url}/health`, 6000);
    if (health.status !== 200) throw new Error(`/health ${health.status}`);
    console.log('[online] Servidor online encontrado:', url);
    return url;
  } catch (e) {
    console.warn('[online] Sin servidor online, se usa el local:', e.message);
    return '';
  }
}

// ---------------------------------------------------------------------
// Servidor local
// ---------------------------------------------------------------------
async function startLocalServer() {
  // .env del usuario (opcional): %APPDATA%/<nombre-app>/.env  -> sirve para ajustar PORT, HOST, RANKED_SONGS...
  // dotenv NO pisa variables ya definidas, así que lo cargamos primero.
  require('dotenv').config({ path: path.join(app.getPath('userData'), '.env') });

  const host = process.env.HOST || '127.0.0.1'; // solo este PC. Pon HOST=0.0.0.0 en el .env para jugar en LAN.
  const port = await pickPort(Number(process.env.PORT) || DEFAULT_PORT, host);

  songsDir = prepareSongsDir();

  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  process.env.HOST = host;
  process.env.PORT = String(port);
  process.env.SONGS_DIR = process.env.SONGS_DIR || songsDir;
  process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || `http://127.0.0.1:${port},http://localhost:${port}`;

  require(path.join(APP_ROOT, 'server.js')); // arranca Express + Socket.IO

  baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl);
}

// ---------------------------------------------------------------------
// Ventana y menú
// ---------------------------------------------------------------------
function buildMenu() {
  const template = [
    {
      label: 'Archivo',
      submenu: [
        ...(songsDir ? [{ label: 'Abrir carpeta de canciones', click: () => shell.openPath(songsDir) }] : []),
        ...(logFile ? [{ label: 'Ver registro del servidor (canciones omitidas)', click: () => shell.openPath(logFile) }] : []),
        { type: 'separator' },
        { role: 'quit', label: 'Salir' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        { role: 'reload', label: 'Recargar' },
        ...(IS_DEV ? [{ role: 'toggleDevTools', label: 'Herramientas de desarrollo' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#070814',
    title: 'Rhythm Arena Online',
    autoHideMenuBar: true, // el menú aparece al pulsar Alt
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // no frenar timers/audio si la ventana pierde el foco
      devTools: IS_DEV,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Enlaces externos -> navegador del sistema; la app nunca navega fuera de su servidor.
  const origin = new URL(baseUrl).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadURL('https://rhythm-arena-online.onrender.com');
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      setupFileLog();
      const remote = await resolveRemoteUrl();
      if (remote) baseUrl = remote;
      else await startLocalServer();
      buildMenu();
      createWindow();
    } catch (err) {
      dialog.showErrorBox('Rhythm Arena Online', `No se pudo iniciar el juego:\n\n${err && err.message ? err.message : err}`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!mainWindow && baseUrl) createWindow(); });
}
