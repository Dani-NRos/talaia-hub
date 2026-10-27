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
  las secciones: `sheet` (la ficha del sensor, una captura por pestaña), `receiver` (la del receptor, con lo que manda a la malla),
  `full` (el sensor y el receptor a pantalla completa, comprobando que ninguna lectura se sale de su casilla) y
  `signin` (crear el primer usuario y entrar). Entra con el código que el servidor deja en su carpeta de datos.
- **`pestanas.mjs [carpeta]`**: las pestañas de la ficha: cuáles tiene cada tipo (nodo vigilado, sin vigilar, panel sin
  nodo), que se recuerda la última, que lo escrito sin guardar sobrevive al cambiar de pestaña, las gráficas a su ancho,
  la barra fija y las flechas del teclado. Sale con 1 si algo falla; con una carpeta, guarda capturas.
- **`orden.mjs [carpeta]`**: el orden de los datos y de las gráficas de un panel y la gráfica de su tarjeta: el editor
  (flechas, teclado y arrastre) en pantalla completa y en la ficha, lo que se ve en la tarjeta, la ficha y la pantalla
  completa, que otra pantalla lo ve al momento y que se queda al recargar (lo guarda el servidor). Sale con 1 si algo
  falla; con una carpeta, guarda capturas.
- **`cursor.mjs [carpeta]`**: el cursor de las gráficas: valor y hora con el ratón (ficha y pantalla completa) y con el
  dedo (móvil), en una línea y en una barra ON/OFF (con un broker MQTT en memoria), que vuelve al redibujarse, que la
  etiqueta queda dentro de su gráfica y que se quita al salir o tocar fuera. Sale con 1 si algo falla.
- **`telegram.mjs [carpeta]`**: Ajustes → Telegram contra un Telegram de mentira (el servidor arranca con
  `TALAIA_TELEGRAM_API` apuntando a él): guardar y comprobar el token, el código de emparejar, un chat y un grupo que
  se emparejan y salen en la lista, el mensaje de prueba, quitar un chat, apagar y encender, quitar el bot. Sale con 1
  si algo falla.
- **`tablero.mjs [carpeta]`**: el aviso de alarmas del Tablero: con una alarma sin ver no se contrae; vistas todas,
  se contrae a una línea (lo que ocupa «Todo en orden»), el aparato lo recuerda, una alarma nueva lo despliega y
  Alarmas sigue con la lista entera. Sale con 1 si algo falla.
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
