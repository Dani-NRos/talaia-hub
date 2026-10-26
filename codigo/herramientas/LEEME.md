# Herramientas de comprobación

Necesitan Playwright con Chromium (no va en el repo: se busca en `PLAYWRIGHT_DIR`, por defecto
`/opt/npm-tools/node_modules/`) y Mosquitto instalado.

- **`pantalla-servidor.mjs <salida> [IP]`**: de punta a punta con el servidor de verdad (`main.js`), un nodo simulado
  por TCP y dos pantallas a la vez (el primer usuario con su código y la entrada, vigilar, límite, alarma, «Enterado» compartido, petición, aviso por la malla,
  MQTT configurado desde Ajustes con un broker y un Home Assistant de mentira, el Mosquitto de este equipo con un
  usuario, datos MQTT en el panel del receptor que salen a la malla, renombrar, un panel sin nodo con su alarma,
  estados ON/OFF con su alarma y el tema de conexión (LWT), encender y apagar un Shelly de mentira desde el móvil,
  reinicio, quitar el panel, otro usuario, cerrar la sesión de otro aparato y quién hizo cada cosa en el registro).
  Guarda capturas y textos de cada paso y, si algo falla, cómo estaba cada pantalla.

- **`vistazo.mjs <salida> [secciones…] [--en]`**: capturas de cada sección en el ordenador y en el móvil, de día y
  de noche, con un nodo simulado (un sensor vigilado con una alarma y el receptor). Para revisar el diseño. Además de
  las secciones: `sheet` (la ficha del sensor, entera), `receiver` (la del receptor, con lo que manda a la malla),
  `full` (el sensor y el receptor a pantalla completa, comprobando que ninguna lectura se sale de su casilla) y
  `signin` (crear el primer usuario y entrar). Entra con el código que el servidor deja en su carpeta de datos.
- **`scroll.mjs`**: que el scroll no se mueva: la ficha de un nodo (con su alarma y las lecturas de otro nodo que
  también la tiene) y Ajustes, con el servidor de verdad y un nodo simulado. Sale con 1 si algo falla.
- **`iconos.mjs`**: dibuja los iconos de la app (`app/pwa/icon-*.png`) con la torre de `app/src/logo.js`.
- **`docker-prueba.mjs [imagen]`**: la imagen de Docker de punta a punta con `docker/compose.yaml` (Talaia y su
  Mosquitto) y un nodo simulado por la red: salud, receptor listo, el primer usuario con el código de
  `talaia --codigo`, un usuario del broker que deja entrar a un «Shelly», de quién es cada fichero, la zona horaria y
  que todo sigue tras reiniciar. La pasa GitHub Actions (`.github/workflows/ci.yml`); a mano, con Docker y
  `npm ci`: `docker build -t talaia-hub:prueba .` y `node codigo/herramientas/docker-prueba.mjs talaia-hub:prueba`.

Las herramientas de la app ligera (capturas antes/después y nodo por cable simulado) siguen en la rama `main`, con
la app congelada en la 1.20.
