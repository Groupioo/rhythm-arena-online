const path = require('path');
const express = require('express');
const app = express();

// Importar la librería de canciones
const { createSongLibrary } = require('./songs');
const library = createSongLibrary({
  dir: path.join(__dirname, '..', 'public', 'songs')
});

// Montar la API de canciones ANTES de express.static
library.mount(app);

// Servir archivos estáticos desde la carpeta public
app.use(express.static(path.join(__dirname, '..', 'public')));

// Iniciar el servidor en el puerto 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[info] Rhythm Arena Online escuchando en http://localhost:${PORT}`);
});
