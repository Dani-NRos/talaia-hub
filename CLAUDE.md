# Talaia Hub (camino de la 2.0)

**Talaia Hub** (hasta la 1.20, «Vigía servidor»): vigilancia 24/7 en Linux (BMAX con Ubuntu, Raspberry Pi 4/5, Pi
Zero 2 W) de nodos Meshtastic y dispositivos MQTT, con histórico en SQLite, Home Assistant por MQTT y acceso desde fuera
con Tailscale. Dentro de la app se llama solo **«Talaia»**. Este repositorio (`talaia-hub`, rama `main`) es el de la
**versión 2.0** (plan abajo); trae la historia de la rama `mapa` de `vigia-mesh`.

Lo que se ve ya dice Talaia (la app, los avisos por la malla «⚠ Talaia: …», los nombres en Home Assistant «Talaia ·
Caseta», el CSV `talaia-fecha.csv`). Hasta que se cambien (Docker, ver el plan), los nombres de dentro siguen siendo de
Vigía: paquetes `@vigia/*`, servicio `vigia-servidor`, `/opt/vigia`, `/etc/vigia`, `/var/lib/vigia`, usuario `vigia`,
y los identificadores y temas `vigia…` de Home Assistant (cambiarlos sin migrar duplicaría los dispositivos en HA y
perdería su histórico).

El repositorio `vigia-mesh` sigue aparte:
- `main`: la **app ligera** (PWA de Bluetooth y cable) **congelada en la 1.20**, publicada en GitHub Pages
  (https://dani-nros.github.io/vigia-mesh/). Solo arreglos graves. No se renombra el repositorio: las URL de GitHub
  Pages de un proyecto no se redirigen al renombrarlo y las apps instaladas dejarían de actualizarse.
- `version-1.20`: el servidor y la app tal como estaban en la 1.20 (el proxy de esta sesión no deja subir etiquetas).
- `mapa`: donde se hizo la 2.0 hasta pasar aquí; ya no se usa (su README apunta a `talaia-hub`).

## Normas de trabajo (de Dani)

- **Nada por la malla sin preguntar**: ni mensajes, ni avisos de prueba, ni traceroutes, ni peticiones a nodos.
  Tampoco cambiar sus alarmas o sus nodos vigilados. Los selectores de Bluetooth y de puerto los maneja él.
- **Una cosa cada vez**: terminar, probar y comprobar cada fase antes de seguir.
- **Pruebas** automáticas con `node --test`; cuando haga falta, con su equipo real (lo prueba él).
- **Arreglos en la app ligera** (`main` de `vigia-mesh`): primero una copia de pruebas en `/beta/`, luego publicar.
- **Idioma**: textos de la app en español de España, claros y sin jerga (hasta que llegue el inglés con el rediseño).
  Desde la 2.0: código nuevo, comentarios nuevos y mensajes de commit en inglés.
- **Sin complacencia**: si algo no tiene sentido o hay una opción mejor, decirlo; preguntar al decidir algo.

## Estructura

```
codigo/                 raíz de npm workspaces: npm install, npm test, npm run build
  nucleo/               lógica sin pantalla, la usan la app y el servidor (@vigia/nucleo)
    src/motor.js        nodos, lecturas, alarmas, peticiones, traceroute, avisos por la malla, lo que llega del receptor
    src/acciones.js     lo que cambia el usuario (vigilar, límites, valla, ajustes…): igual en la app y el servidor
    src/receptor-base.js  ciclo de conexión, lectura inicial, reintentos y peticiones con id (app y servidor)
    src/textos.js       tiempos y textos comunes (dur, ago, stamp…)
    src/idioma.js       idioma de los textos del núcleo (alarmas, tiempos, nombres de métricas, peticiones, estados):
                        tx("clave"). La pantalla pone el de quien la mira; el servidor, el suyo (Ajustes → Sistema).
                        También los formatos de número (1015 hPa; miles a partir de cinco cifras) y de hora. El
                        servidor añade sus textos con addTexts (servidor/src/textos.js)
    src/canales.js      qué canal es privado (`kind`: el porqué, que cada pantalla dice en su idioma con
                        channelWhy); recorte a 200 bytes
    src/tramas.js       tramas del puerto serie (0x94 0xC3), troceado propio, latido, despertar, fabricantes USB
    src/mqtt-datos.js   datos MQTT: tipos y unidades, qué parece cada tema, leer el valor de un JSON, comprobar la
                        configuración (también lo que puede salir a la malla); metrics.js registra sus métricas
    src/metrics.js trend.js delivery.js route.js geo.js pb.js
  app/                  la PWA (@vigia/app)
    src/app.js          pantalla; crea el motor con ganchos (redibujar, sonar…) solo para mostrar: el estado llega
                        del servidor por SSE y lo que se pulsa va a él como orden por POST (src/remoto.js). En
                        localStorage, solo lo de cada aparato (sonido, pantalla encendida, tarjetas, buscador, mapa,
                        idioma y tema)
    src/shell.js        el marco: barra de secciones, barra de arriba, qué sección se ve (#/dashboard, #/alarms,
                        #/nodes, #/map, #/automations, #/settings) y qué apartado (#/settings/mqtt), pestaña del
                        navegador y tema
    src/i18n.js         idioma de cada pantalla (es/en): t("clave", valores); las secciones pasan aquí al reescribirse.
                        En app.js se importa como `tr` (allí `t` es el elemento en los manejadores de eventos)
    src/ctx.js ui.js    lo que comparten las secciones (estado, motor, orden, toast) y utilidades ($, esc, LS, iconos)
    src/views/          una sección por fichero, en inglés: dashboard.js (aviso de alarmas y tarjetas),
                        node-parts.js (pedir datos, ubicación y valla, interruptor: tarjeta y ficha), nodes.js
                        (toda la malla, también los vigilados; 50 por página), alarms.js (registro), sheet.js (la
                        ficha: peticiones, ruta, ubicación, alarmas, cambio rápido, estados, gráficas), panel-config.js
                        (en la ficha de un panel vigilado: nombre, datos MQTT, conexión, lo que sale a la malla; y
                        «Panel nuevo»; lo cambiado sin guardar se queda si se vuelve a abrir el mismo), fullscreen.js
                        (un panel a pantalla completa, con la pantalla encendida), settings.js (Ajustes, en
                        apartados; el diagnóstico de conexión)
    src/views/signin.js la entrada (y el primer usuario con su código), encima de todo; views/users.js, Ajustes → Usuarios
    src/alerts.js       cómo avisa esta pantalla: sonido, vibración, notificación, pantalla encendida
    src/charts.js       gráficas en SVG (con ejes, la de las tarjetas y la barra de los estados ON/OFF)
    src/logo.js         la torre de vigilancia (logo, icono de la pestaña: su ventana se enciende con alarmas sin atender)
    src/css/            base.css (colores, letras, botones), forms.css (bloques y casillas: ficha y Ajustes),
                        dashboard.css lists.css map.css sheet.css fullscreen.css settings.css shell.css. El orden,
                        en build.mjs
    src/map.js mapdata.js meshsearch.js remoto.js
    index.src.html build.mjs pwa/ (manifiesto, iconos y sw.js: la pantalla del servidor se instala como app)
  servidor/             Vigía servidor (@vigia/servidor), Node ≥ 22.13
    src/main.js         arranque (systemd o a mano); src/vigia.js: motor + receptor + SQLite + tareas periódicas
    src/receptor.js enlace.js puertos.js   nodo por USB (serialport, con binarios: no compila) o TCP 4403
    src/almacen.js      SQLite (node:sqlite): lecturas y el estado que la app guarda en localStorage
    src/textos.js       los textos del servidor en español e inglés (claves «s.*»: s.j.* el diario, s.log.* el
                        registro, s.ha.* Home Assistant…); se piden con tx() como los del núcleo
    src/web.js sincro.js  la app servida en la red de casa y su API (SSE + órdenes); todo menos la app, /api/salud y
                        entrar pide sesión (cookie HttpOnly)
    src/usuarios.js     usuarios y sesiones (paso 4): scrypt, sesiones de 30 días sin usar, código del primer usuario,
                        intentos fallidos que frenan; desde la terminal: --clave, --usuarios, --codigo (main.js)
    src/mqtt.js         MQTT (MQTT.js): varios brokers a la vez (una conexión cada uno), configurados en Ajustes y
                        guardados en SQLite; reconexión; testamento solo en el de Home Assistant; migra lo de la 1.16
    src/mosquitto.js    el broker de este equipo: usuarios (cifrado de mosquitto_passwd: $7$, PBKDF2-SHA512) que Vigía
                        escribe en <datos>/mosquitto/passwd; vigia-mosquitto.path (root) los pasa a Mosquitto y recarga
    src/homeassistant.js  salida a Home Assistant por MQTT con autodescubrimiento (los temas, arriba del fichero)
    src/paneles.js      paneles: nombres, paneles sin nodo (números negativos: -1, -2…), datos MQTT de cada panel
                        (claves «mq1», «mq2»…: lecturas, alarmas e histórico como una métrica más; una lectura por
                        minuto) y lo del receptor que sale a la malla como su telemetría; migra la estación de la 1.16
                        (lo común con la pantalla, en nucleo/src/mqtt-datos.js)
    instalar.sh sistema/  instalador (Node propio en /opt/vigia, Mosquitto por apt), servicios systemd, regla de udev
    test/nodo-falso.mjs nodo Meshtastic simulado (protobuf de verdad) por TCP o puerto virtual
    test/mqtt.test.mjs paneles.test.mjs  con un broker en memoria (aedes) y un «Home Assistant» de mentira
    test/mosquitto.test.mjs  con un Mosquitto de verdad si está instalado (apt install mosquitto)
  herramientas/         pantalla-servidor.mjs: de punta a punta con Playwright (ver herramientas/LEEME.md)
  dist/app/             app compilada (no va al repo)
```

El motor recibe el objeto de estado `S` (ver `estadoInicial()`) y ganchos; la app le añade a `S` lo de pantalla.
La app ligera congelada tiene su propia copia del código en `main`: aquí ya no hace falta mantener el formato de su
`localStorage` ni que la app sin servidor quede igual.

### Decisiones del servidor (Dani, 18 oct. 2026)

- Nodo propio por USB para el servidor (su DNN 5); Home Assistant sigue con el suyo por WiFi.
- Sin contraseña ni token: la red de casa es la protección (hasta el paso 4: desde entonces, usuarios). Puerto web 4404.
- Manda por la malla todo lo que la app: peticiones que se pulsan y avisos automáticos de alarmas (si se activan).
- Histórico de todos los nodos que oye el receptor, un año por defecto (`retencionDias`).
- Con un año de todo, nada que recorra la tabla de lecturas entera en el camino normal: el total va en memoria y el
  CSV sale por bloques.

### MQTT y Home Assistant (Dani, 18 oct. 2026)

- Un **cliente MQTT general** en el servidor (Home Assistant primero; más adelante, quizá zigbee2mqtt o Shelly como
  entradas, con un Mosquitto en la misma máquina: solo es la dirección, no está pedido).
- **No quita nada de Vigía**: sonido, notificaciones y avisos por la malla siguen igual; HA es una salida más. Si Dani
  no quiere que Vigía avise, lo silencia él en Vigía.
- Se configura en **Ajustes → MQTT** (solo en modo Servidor): los brokers (con usuario y contraseña opcionales; la
  contraseña se guarda en SQLite y nunca sale por la API) y, aparte, en cuál se publica para Home Assistant (apagado
  por defecto).
- A HA van **solo los nodos vigilados**, como dispositivos «Vigía · nombre» («Talaia · nombre» desde la 3.4); **sin posición**. Un sensor binario y un
  botón «Enterado» por cada alarma puesta, «Enterado todas» y un evento por alarma/resuelta/vista para notificar.
  Las alarmas y límites se cambian solo en Vigía.

### De MQTT a la malla (Dani, 18 oct. 2026)

- Para la estación meteorológica de su barrio (en la misma ubicación que el nodo): temperatura, humedad, presión,
  lluvia, viento… salen por el DNN 5 como su telemetría de ambiente (protobuf `Telemetry`, `environmentMetrics`).
- Cada 30 min por defecto (alineado al reloj); canal y saltos a elegir (el canal puede ser público: es su decisión).
- Los valores se guardan también como **lecturas del receptor** (gráficas, alarmas, histórico), sin tocar «oído por
  última vez» (no llegan por radio). Se guardan aunque el receptor esté desconectado.
- Un dato por tipo (la telemetría no lleva nombres). Sin dirección del viento todavía: Vigía no la conoce como métrica.
- Saltos distintos de los del receptor: la librería no deja ponerlos, el paquete se arma en `servidor/src/receptor.js`.

### Paneles y dispositivos MQTT (Dani, 21 oct. 2026) — plan por fases

Vigía servidor deja de ser solo Meshtastic: los paneles muestran también dispositivos MQTT (Shelly, Tasmota, Sonoff
con Tasmota/ESPHome, Zigbee por zigbee2mqtt, ESPHome, Home Assistant…).
- **Datos MQTT dentro de los paneles**, configurados desde el propio panel (broker, tema, campo, unidad), no en
  Ajustes. Cualquier panel puede llevarlos: el de un nodo Meshtastic o uno nuevo sin nodo («Añadir panel»).
- **Solo los del panel del receptor (DNN 5)** pueden salir a la malla como telemetría (casilla por dato; uno por
  tipo). La estación de la 1.16 pasa a ser datos MQTT del panel del DNN 5 (con su histórico).
- Todos los paneles se pueden **renombrar** (los nodos guardan su nombre de Meshtastic como información). Solo en
  modo Servidor; la app de Bluetooth no cambia.
- Cada dato MQTT con nombre propio; varios del mismo tipo en un panel (salvo para la malla).
- Números y **estados ON/OFF** (alarma «cuando esté ON/OFF»), **control** con interruptor (sin confirmación; sin
  login entonces; desde el paso 4, cualquier usuario).
- Lo de los nodos sigue yendo a Home Assistant como hasta ahora; los datos MQTT, no (si Dani los quiere en HA, los
  lee del broker de Vigía).
- Ubicación y mapa, solo nodos Meshtastic.
- **Brokers**: Mosquitto propio en el BMAX (instalador), **con usuario y contraseña**, fáciles de cambiar desde
  Vigía; Vigía usa a la vez el suyo y otros (el de HA). Cada broker se apunta una vez; en cada dato se elige cuál, y se
  puede añadir uno desde el propio panel.
- Hecho así (fase 2): un panel sin nodo es un «nodo» de número negativo en `S.nodes` (con `fuente: "mqtt"`,
  `tipoPanel`) vigilado con «sin datos» apagado; el nombre de Vigía de un nodo va en `n.alias` (el de Meshtastic sigue
  en `n.long`). Las alarmas de datos MQTT no van a Home Assistant (ni eventos, ni cuenta, ni «Enterado todas»): el
  registro las marca con `mqtt: true`. Los paneles sin nodo no salen en «Resto de la malla» ni en el mapa.
- Hecho así (fase 3, Dani 21 oct. 2026): tipo de dato «estado» (1/0) con nombres a elegir (`NOMBRES_ESTADO`) y «al
  revés»; `n.metrics[k].desde` = desde cuándo tiene ese valor. Alarma `rules[k].estado = { cuando, min }` («cuando:
  Abierta», al momento o «más de X min»; `evalEstados` cada 15 s en el servidor). Lecturas de un estado: cada cambio
  al momento, si no cambia una por hora. Tema de conexión (LWT) por panel sin nodo: `n.conectado`, alarma
  `${num}||conexion` si se marca «Avisar si se desconecta». Las alarmas de los datos MQTT siguen sin ir a Home
  Assistant: Dani valorará más adelante mandarlas a HA o a Telegram con un bot.
- Hecho así (fase 4, Dani 22 oct. 2026): un estado puede llevar `orden: { tema, on, off }` (la propone
  `proponerOrden` desde el tema de estado; se puede cambiar). Interruptor en tarjeta, ficha y pantalla completa, sin
  confirmación; `paneles.mandar` publica (qos 1, sin retener) y espera a que el tema de estado diga el valor (10 s;
  si no, «No ha contestado»); queda en el registro. La orden queda esperando antes de publicarla: un dispositivo del
  mismo broker puede contestar antes que el acuse (qos 1) del broker, y su respuesta tiene que encontrarla. A los Shelly se les pide el estado al conectar con el broker y al
  guardar los datos (`pedirEstadoShelly`: `status_update` en `…/command/switch:0`): solo información.
- Fases: 1) brokers (Mosquitto propio + varios); 2) paneles, nombres, datos MQTT numéricos, estación al panel del
  receptor; 3) ON/OFF; 4) control; 5) descubrimiento automático (**congelada** por Dani el 22 oct. 2026 hasta que
  haya más dispositivos compatibles; él tiene Shelly Plus/Pro/Gen3; idea: «Añadir panel» → «Buscar dispositivos»);
  6) **controlar interruptores desde la malla** (a Dani le interesa mucho). Más adelante: un segundo receptor 868 con
  firmware propio para estaciones meteorológicas cercanas (si publica por MQTT, es otra fuente más).

### Tailscale (Dani, 22 oct. 2026)

- Para abrir la pantalla fuera de casa: Tailscale en el BMAX (ya unido a su cuenta) y `sudo tailscale serve --bg 4404`
  (https en `*.ts.net`, instalable como app). `tailscale serve` deja el Host tal cual, así valen las comprobaciones de
  `web.js` (`ts.net` está entre los nombres de casa). Lo que llega por **Funnel** (cabecera `Tailscale-Funnel-Request`)
  se rechaza (también con usuarios). Más adelante: notificaciones push. Quién manda cada orden ya lo dicen los usuarios
  (paso 4).

### Versión 2.0 (Dani, 22 oct. 2026) — plan acordado

- **Solo el servidor**: la webapp de Bluetooth/cable se **congela** en la 1.20 y sigue publicada como versión ligera
  (solo arreglos graves); sale del repositorio principal (rama o repositorio aparte). La interfaz de la v2 es solo la
  del servidor.
- **Nombre nuevo** (sin «Mesh»: ya no es solo Meshtastic; a Dani no le gusta cómo suena «Vigía»): **Talaia Hub**
  (elegido el 22 oct. 2026: corto y describe lo que es). Talaia es atalaya en euskera y en valenciano. En la app, solo
  «Talaia»; Naika, si acaso, como firma y no en el nombre. Ojo legal: existió Talaia Networks (monitorización de
  redes, Barcelona), comprada por Auvik en 2018, que pasó a llamar al producto TrafficInsights. Antes de registrar o
  vender nada, mirar «talaia» en TMview (clases 9 y 42). La palabra descriptiva («Hub») no protege si «Talaia»
  estuviera registrada para lo mismo.
- **Idioma**: README y documentación en inglés (con versión en español); la app en español e inglés (elegible),
  hecho junto al rediseño; código nuevo en inglés y lo existente se renombra por partes al reescribirlo, con las
  pruebas como red. Los commits pasan al inglés cuando empiece la v2.
- **Rediseño**: barra lateral de iconos en ordenador y barra inferior en el móvil; secciones Tablero, Alarmas, Mapa,
  Automatizaciones, Ajustes (MQTT, Malla, Receptor, Sistema). Estilo de instrumento de campo, sin adornos: oliva o
  verde bosque con arena, un color de señal para las alarmas, números monoespaciados, modo oscuro «guardia nocturna».
  Logo: torre de vigilancia forestal geométrica que se lea a 16 px. Sin propuestas visuales previas (Dani se fía del
  planteamiento).
- **Usuarios y contraseña** obligatorios antes de abrirlo al mundo; **Docker** para instalarlo fácil.
- Paso 2 hecho (22 oct. 2026): `main` es la app ligera congelada (con aviso en su README), `version-1.20` guarda la
  1.20 y `mapa` ya no lleva los ficheros compilados de la app ligera ni sus herramientas. Con el nombre, `mapa` pasó a
  `talaia-hub` (22 oct. 2026) con su historia; el instalador descarga de aquí.
- **Paso 3, rediseño** (Dani, 22 oct. 2026), hecho en la rama `rediseno` y pasado a `main` el 23 oct. 2026. Barra, **solo iconos** y en este orden
  (Dani, 22 oct. 2026): Tablero, Mapa, **Nodos** (la lista de toda la malla con su buscador), **Automatizaciones**
  («Llega en la 2.1»), Alarmas; y Ajustes. El nombre de la sección va en la barra de arriba (y en el título y la
  etiqueta de cada icono). En el ordenador, todo en la barra lateral (Ajustes abajo); en el móvil, cinco en la barra
  inferior y Ajustes en un engranaje arriba a la derecha. Por partes: 3.1) quitar la app ligera de la pantalla (hecho: sin Bluetooth, cable,
  demo ni modo sin servidor; la prueba de peticiones pasó al núcleo); 3.2) esqueleto, estilo, logo, nombre «Talaia» e
  idioma (hecho: lo elige cada pantalla; por defecto, el del navegador, español también para ca/eu/gl); 3.3) cada
  sección en los dos idiomas (hecho, 23 oct. 2026; app/test/i18n.test.mjs comprueba que cada texto que se pide está en
  los dos y con los mismos huecos); 3.4) lo que sale del servidor con un idioma del servidor (hecho, 23 oct. 2026).
  No se pierde ninguna función.
- Idioma del servidor (3.4, Dani 23 oct. 2026): se elige en Ajustes → Sistema (`S.settings.language`, «es» por
  defecto) y vale para todo lo que escribe el servidor: el registro (Alarmas → Registro), los avisos y resultados por
  la malla, los nombres en Home Assistant (al cambiarlo se le vuelven a anunciar; los `unique_id`, temas y tipos de
  evento no cambian), lo que contesta a las órdenes, el diario (journalctl) y el CSV (en español, «;» y coma decimal;
  en inglés, «,» y punto). Lo que ya está en el registro se queda en el idioma en que se escribió. Siguen en español
  hasta el paso 5 (Docker): las líneas de main.js antes de arrancar y los errores de configuración (config.js).
  servidor/test/textos.test.mjs comprueba que cada clave que se pide con tx() está en los dos idiomas con los mismos
  huecos.
- Estilo (3.2): arena y verde bosque de día, «guardia nocturna» (fondo casi negro verdoso, texto color arena) de
  noche; oliva para lo que se pulsa; naranja de señal (#c2410c / #e2531b; de noche #ff6b2b) solo para alarmas.
  Letras Overpass y Overpass Mono (OFL, de npm @fontsource-variable, incrustadas por build.mjs: sin internet se ve
  igual). Las lecturas, en Overpass con cifras tabulares (todas igual de anchas), no en la monoespaciada: esa le da a la
  coma decimal el ancho de una cifra y Dani las vio demasiado espaciadas. Overpass dibuja «·» sin anchura: ese carácter sale de otra letra
  (unicode-range). Las lecturas (tarjetas y pantalla completa) caben siempre en su casilla: `fitSame` (ui.js) las
  mide y, si una no cabe, las de esa tarjeta (o todas las casillas de la pantalla completa) bajan a la vez por el mismo
  factor (`--fit`); si una tarjeta tendría que bajar de 0,7, pasa a columnas más anchas. En las tarjetas, las lecturas
  van separadas como una tabla sin cerrar: unas rayas discontinuas en los huecos (Dani, 23 oct. 2026). El botón de
  pantalla completa va en la cabecera de la tarjeta, a la izquierda de la flecha de contraer. Ajustes, en cinco apartados con pestañas, cada uno con su dirección (#/settings/mesh…): Malla
  (sin señal para los nodos nuevos, avisos por la malla), MQTT (brokers, usuarios del broker de este equipo, Home
  Assistant), Receptor (estado, nodo, radio, canales, diagnóstico; ahí lleva el botón de estado de arriba), Sistema
  (idioma del servidor, histórico, acerca de) y Esta pantalla (idioma, tema, sonido, notificaciones, pantalla encendida, mapa sin
  internet: todo lo que es de cada aparato). Cada aparato recuerda el último abierto. Ajustes, en una columna centrada (texto a la izquierda). Los registros y alarmas están en Alarmas; el Tablero
  tiene el aviso de alarmas y los paneles; el mapa es una sección (map.js ya no usa un diálogo).
- **Paso 4, usuarios** (Dani, 23 oct. 2026), hecho en la rama `usuarios` y pasado a `main` el 23 oct. 2026: usuario y contraseña **siempre**, también en casa; **un solo tipo de usuario** (todos pueden todo,
  también usuarios; la tabla guarda un `rol`, todos «admin», por si llegan tipos); el **primer usuario se crea en la
  pantalla con un código** (8 letras, en `<datos>/primer-usuario.txt` hasta entonces; lo dicen el diario, el
  instalador y `sudo vigia-servidor --codigo`); **sesión de 30 días sin usarla**, renovada con el uso (cookie
  `talaia_sesion` HttpOnly, SameSite=Lax, Secure por `*.ts.net`; en la base, solo su SHA-256; las pantallas piden
  `/api/sesion` cada 6 h). Contraseñas con scrypt (N=16384), de 10 a 200 caracteres y no iguales al nombre. Cinco
  fallos libres por nombre y después esperas que doblan (hasta 15 min); 50 fallos en un minuto, esperan todos. No se
  puede quitar uno a sí mismo; la propia contraseña pide la actual y deja abierta esta sesión; la de otro cierra todas
  las suyas. Al cerrarse una sesión, sus pantallas abiertas (SSE) se cortan y vuelven a «Entra». El registro lleva
  quién (`by`) en lo que hace una persona (tipo info y ack; no en alarmas que saltan o se resuelven), y apunta las
  entradas y los cambios de usuarios. El instalador (`INSTALADOR=3`) enseña el código y `vigia-servidor` corre como
  `vigia` con sudo (lo que escribe en los datos sigue siendo del servicio). El service worker ya no guarda nada de
  `/api/`.
- Orden (1 y 2, hechos): 1) nombre y política de idioma; 2) congelar la webapp y reorganizar el repositorio;
  3) rediseño con los dos idiomas; 4) usuarios; 5) Docker y documentación en inglés → **2.0**. Las
  **automatizaciones** («si… entonces…», centradas en la malla, con la fase 6 de control desde la malla dentro) →
  **2.1**. Nada de editor de flujos.

## Publicar

- **Desarrollo de la 2.0** en `main` de `talaia-hub`. Dani lo prueba instalando desde aquí (se instala encima de lo
  que haya: mismo servicio, mismos datos):
  `wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash`
  Hasta la 2.0, la versión estable del servidor es la 1.20 (instalador de `main` de `vigia-mesh`).
- **`INSTALADOR=` en `instalar.sh`**: subirlo cada vez que cambia lo que hace el instalador. Si el programa descargado
  trae uno más nuevo, el instalador que corre sigue con ese (`--programa`), pero eso solo lo hacen los de la 2 en adelante.
- **Arreglos en la app ligera** (repositorio `vigia-mesh`): rama desde `main`, compilar, copia en `beta/` sin `sw.js`
  (con `beta/README.md`), Dani la prueba, y se publica en `main` (subir versión 1.20.x, compilar y copiar
  `codigo/dist/app/*` a la raíz, borrar `beta/`). Las herramientas para comprobar que no cambia nada más (`capturar.mjs`, `real.mjs`,
  `comparar.py`, con Playwright y el reloj congelado) están en `main`.

## Lo aprendido con la malla y el firmware (respetarlo)

- **Acuses por id de paquete**, no fiarse de la librería: el primer acuse suele ser el implícito del propio receptor
  (oye a un vecino repetir el paquete). Entregado solo cuando confirma el nodo destino.
- **Una respuesta se reconoce por cuándo llega**, no por la hora del paquete: el reloj del receptor puede ir desfasado
  (el de Dani va unos minutos atrasado).
- Su malla: `usePreset: false`, **SF7**, límite de **6 saltos**, canal «SFNarrow». La calidad del SNR depende del SF.
- **Traceroute**: uno cada 30 s como mucho (lo limita el firmware).
- **Ficha (NodeInfo)**: el nodo no contesta a quien se la pidió en las últimas 12 h.
- **Troceado serie**: el de `@meshtastic/core` tira paquetes con 0x94 0xC3 dentro; usar `nucleo/src/tramas.js`.
  Al reconectar un puerto serie, esperar a que el anterior termine de cerrarse.
- Su receptor: **DNN 5** (nRF52, USB 239a:8029). Su base de nodos tiene unos 1100 (muchos llegados por MQTT).
- **Firmware (comprobado en 2.8.2, oct. 2026)**:
  - Por TCP (puerto 4403) solo hay un cliente: uno nuevo cierra al anterior («Force close previous TCP connection»).
  - Los paquetes recibidos van a **una sola cola compartida** entre todos los clientes (Bluetooth, cable, TCP): si hay
    dos conectados al mismo nodo, cada uno se queda con una parte. El servidor tendrá su propio nodo por USB; Home
    Assistant mantiene el suyo por WiFi.
  - Sin tráfico del cliente, el modo API se corta a los 15 min (cable y TCP): mandar latido (`tramas.js`).

## Comportamiento aceptado

- Avisos por la malla: si saltan varias alarmas en el mismo instante y van a un solo destino, salen seguidos sin los
  8 s de separación (los que se juntan en cola sí los respetan). Dani decidió dejarlo así (18 oct. 2026); el README ya
  no promete los 8 s. Lo fija una prueba en `nucleo/test/motor.test.mjs`.
