# Herramientas de comprobación

Necesitan Playwright con Chromium (no va en el repo: se busca en `PLAYWRIGHT_DIR`, por defecto
`/opt/npm-tools/node_modules/`) y Mosquitto instalado.

- **`pantalla-servidor.mjs <salida> [IP]`**: de punta a punta con el servidor de verdad (`main.js`), un nodo simulado
  por TCP y dos pantallas a la vez (vigilar, límite, alarma, «Enterado» compartido, petición, aviso por la malla,
  MQTT configurado desde Ajustes con un broker y un Home Assistant de mentira, el Mosquitto de este equipo con un
  usuario, datos MQTT en el panel del receptor que salen a la malla, renombrar, un panel sin nodo con su alarma,
  estados ON/OFF con su alarma y el tema de conexión (LWT), encender y apagar un Shelly de mentira desde el móvil,
  reinicio y quitar el panel). Guarda capturas y textos de cada paso y, si algo falla, cómo estaba cada pantalla.

- **`vistazo.mjs <salida> [secciones…] [--en]`**: capturas de cada sección en el ordenador y en el móvil, de día y
  de noche, con un nodo simulado (un sensor vigilado con una alarma y el receptor). Para revisar el diseño. Además de
  las secciones: `sheet` (la ficha del sensor, entera), `receiver` (la del receptor, con lo que manda a la malla) y
  `full` (el sensor a pantalla completa).
- **`iconos.mjs`**: dibuja los iconos de la app (`app/pwa/icon-*.png`) con la torre de `app/src/logo.js`.

Las herramientas de la app ligera (capturas antes/después y nodo por cable simulado) siguen en la rama `main`, con
la app congelada en la 1.20.
