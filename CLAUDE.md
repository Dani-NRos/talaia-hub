# Vigía Mesh

App web (PWA) de telemetría y alarmas para nodos Meshtastic, sin internet. Publicada en GitHub Pages:
https://dani-nros.github.io/vigia-mesh/ . En pruebas: **Vigía servidor**, la misma lógica funcionando 24/7 en Linux
(BMAX con Ubuntu, Raspberry Pi 4/5, Pi Zero 2 W), con histórico en SQLite y Home Assistant por MQTT. Después: acceso
desde fuera con https (Tailscale), notificaciones push y MCP de lectura; luego Docker y complemento de HA.

## Normas de trabajo (de Dani)

- **Nada por la malla sin preguntar**: ni mensajes, ni avisos de prueba, ni traceroutes, ni peticiones a nodos.
  Tampoco cambiar sus alarmas o sus nodos vigilados. Los selectores de Bluetooth y de puerto los maneja él.
- **Una cosa cada vez**: terminar, probar y comprobar cada fase antes de seguir.
- **Pruebas** automáticas con `node --test`; cuando haga falta, con su equipo real (lo prueba él).
- **Cambios en la PWA**: primero una copia de pruebas en `/beta/`, luego publicar.
- **Idioma**: textos de la app en español de España, claros y sin jerga. Mensajes de commit en español.
- **Sin complacencia**: si algo no tiene sentido o hay una opción mejor, decirlo; preguntar al decidir algo.

## Estructura

```
codigo/                 raíz de npm workspaces: npm install, npm test, npm run build
  nucleo/               lógica sin pantalla, la usan la app y el servidor (@vigia/nucleo)
    src/motor.js        nodos, lecturas, alarmas, peticiones, traceroute, avisos por la malla, lo que llega del receptor
    src/acciones.js     lo que cambia el usuario (vigilar, límites, valla, ajustes…): igual en la app y el servidor
    src/receptor-base.js  ciclo de conexión, lectura inicial, reintentos y peticiones con id (app y servidor)
    src/textos.js       tiempos y textos comunes (dur, ago, stamp…)
    src/canales.js      qué canal es privado; recorte a 200 bytes
    src/tramas.js       tramas del puerto serie (0x94 0xC3), troceado propio, latido, despertar, fabricantes USB
    src/metrics.js trend.js delivery.js route.js geo.js pb.js
  app/                  la PWA (@vigia/app)
    src/app.js          pantalla; crea el motor con ganchos (redibujar, guardar en localStorage, sonar…) y radio.
                        Con window.__VIGIA_SERVIDOR (lo pone el servidor al servirla) arranca en modo «Servidor»:
                        estado del servidor por SSE y órdenes por POST (src/remoto.js)
    src/receptor.js     conexión al nodo desde el navegador (Bluetooth o Web Serial)
    src/ble.js serial.js store.js (IndexedDB) map.js mapdata.js meshsearch.js demo.js remoto.js
    index.src.html build.mjs pwa/
  servidor/             Vigía servidor (@vigia/servidor), Node ≥ 22.13
    src/main.js         arranque (systemd o a mano); src/vigia.js: motor + receptor + SQLite + tareas periódicas
    src/receptor.js enlace.js puertos.js   nodo por USB (serialport, con binarios: no compila) o TCP 4403
    src/almacen.js      SQLite (node:sqlite): lecturas y el estado que la app guarda en localStorage
    src/web.js sincro.js  la app servida en la red de casa y su API (SSE + órdenes), sin contraseña (decisión de Dani)
    src/mqtt.js         cliente MQTT general (MQTT.js): configuración desde Ajustes, guardada en SQLite, reconexión, LWT
    src/homeassistant.js  salida a Home Assistant por MQTT con autodescubrimiento (los temas, arriba del fichero)
    instalar.sh sistema/  instalador (Node propio en /opt/vigia), servicio systemd y regla de udev
    test/nodo-falso.mjs nodo Meshtastic simulado (protobuf de verdad) por TCP o puerto virtual
    test/mqtt.test.mjs  con un broker en memoria (aedes) y un «Home Assistant» espía
  herramientas/         comprobaciones con Playwright (capturas antes/después, nodo por cable simulado, servidor de
                        punta a punta con MQTT): ver herramientas/LEEME.md
  dist/app/             app compilada (no va al repo)
```

El motor recibe el objeto de estado `S` (ver `estadoInicial()`) y ganchos; la app le añade a `S` lo de pantalla.
No cambiar el formato de lo que se guarda en `localStorage` (`vigia.*`): la copia de `/beta/` comparte origen con la
app instalada y lee y escribe los mismos datos.

### Decisiones del servidor (Dani, 18 oct. 2026)

- Nodo propio por USB para el servidor (su DNN 5); Home Assistant sigue con el suyo por WiFi.
- Sin contraseña ni token: la red de casa es la protección. Puerto web 4404.
- Manda por la malla todo lo que la app: peticiones que se pulsan y avisos automáticos de alarmas (si se activan).
- Histórico de todos los nodos que oye el receptor, un año por defecto (`retencionDias`).
- Con un año de todo, nada que recorra la tabla de lecturas entera en el camino normal: el total va en memoria y el
  CSV sale por bloques.

### MQTT y Home Assistant (Dani, 18 oct. 2026)

- Un **cliente MQTT general** en el servidor (Home Assistant primero; más adelante, quizá zigbee2mqtt o Shelly como
  entradas, con un Mosquitto en la misma máquina: solo es la dirección, no está pedido).
- **No quita nada de Vigía**: sonido, notificaciones y avisos por la malla siguen igual; HA es una salida más. Si Dani
  no quiere que Vigía avise, lo silencia él en Vigía.
- Se configura en **Ajustes → MQTT y Home Assistant** (solo en modo Servidor), viene apagado. Usuario y contraseña del
  broker opcionales (el Mosquitto de HA los pide); la contraseña se guarda en SQLite y nunca sale por la API.
- A HA van **solo los nodos vigilados**, como dispositivos «Vigía · nombre»; **sin posición**. Un sensor binario y un
  botón «Enterado» por cada alarma puesta, «Enterado todas» y un evento por alarma/resuelta/vista para notificar.
  Las alarmas y límites se cambian solo en Vigía.

## Publicar

- Se desarrolla en la rama `mapa`; se publica subiendo `mapa:main`. GitHub Pages sirve `main` desde la raíz.
- **Copia de pruebas**: compilar y copiar `codigo/dist/app` a `beta/` **sin `sw.js`** (para no tocar la app
  instalada), con un `beta/README.md` que lo explique. Commit «… (en pruebas en /beta/)».
- **Publicar una versión**: subir la versión en los `package.json` (`codigo/`, `nucleo/`, `app/`, `servidor/`) y
  `APP_VERSION` en `app.js`; compilar; copiar `codigo/dist/app/*` a la raíz; borrar `beta/`. Commit «Vigía Mesh X.Y: …».

## Comprobar que la app no cambia

Para cambios que no deberían verse (refactorizaciones), comparar capturas de la app compilada en modo demo con el
reloj congelado, antes y después: Playwright con `page.clock.install` + `pauseAt`, bloqueando las teselas de
OpenStreetMap y las fuentes de Google (si no, el resultado varía entre pasadas). Textos y `localStorage` idénticos;
imágenes con tolerancia de suavizado.

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
