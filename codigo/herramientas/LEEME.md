# Herramientas de comprobación

Para comprobar cambios antes de publicar. Necesitan Playwright con Chromium (no va en el repo: se busca en
`PLAYWRIGHT_DIR`, por defecto `/opt/npm-tools/node_modules/`) y Python 3 con Pillow para comparar.

- **`capturar.mjs <dist/app> <salida>`**: recorre la app en modo demo y en modo real con datos guardados (vigilar,
  límites, cambio rápido, valla, ajustes…), con el reloj congelado. Guarda capturas, textos y `localStorage`.
- **`real.mjs <dist/app> <salida>`**: la app con un nodo simulado por cable (Web Serial falso que habla protobuf):
  conexión, alarma, avisos por la malla, peticiones, ruta, ficha. Guarda además lo que la app manda al nodo.
- **`comparar.py <antes> <después>`**: textos, `localStorage` y mensajes al nodo idénticos; capturas con tolerancia de
  suavizado. Dice `IGUALES` o qué cambia.
- **`pantalla-servidor.mjs <salida> [IP]`**: de punta a punta con el servidor de verdad (`main.js`), un nodo simulado
  por TCP y dos pantallas a la vez (vigilar, límite, alarma, «Enterado» compartido, petición, aviso por la malla,
  MQTT configurado desde Ajustes con un broker y un Home Assistant de mentira, reinicio).

Para una refactorización que no debe verse: compilar la versión publicada (con `git worktree`) y la nueva, pasar
`capturar.mjs` y `real.mjs` a las dos y `comparar.py`. Antes, pasarlos dos veces a la misma versión: si ya salen
distintos, algo no está congelado.
