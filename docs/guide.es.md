# Talaia Hub: manual de uso

*[English](guide.md)*

Talaia vigila 24/7 en Linux una malla [Meshtastic](https://meshtastic.org) y dispositivos MQTT: alarmas (umbral,
cambio rápido, valla antirrobo, sin señal, estados ON/OFF), automatizaciones, órdenes por la malla, un año de
histórico en SQLite y una pantalla para el navegador, aunque no haya ningún móvil ni ordenador mirando.

- [Qué hace falta](#qué-hace-falta)
- [Instalar](#instalar) · [Con Docker](#con-docker) · [Seguirlo](#seguirlo) · [Configuración](#configuración) ·
  [Si no conecta](#si-no-conecta) · [Desinstalar](#desinstalar)
- [La pantalla](#la-pantalla) · [Desde fuera de casa (Tailscale)](#desde-fuera-de-casa-tailscale)
- [Avisos por la malla](#avisos-por-la-malla) · [MQTT](#mqtt) · [Home Assistant](#home-assistant)
- [Paneles y datos por MQTT](#paneles-y-datos-por-mqtt) · [A la malla (el panel del receptor)](#a-la-malla-el-panel-del-receptor) ·
  [Zigbee (Zigbee2MQTT)](#zigbee-zigbee2mqtt)
- [Automatizaciones](#automatizaciones) · [Órdenes por la malla](#órdenes-por-la-malla) · [Telegram](#telegram)

## Qué hace falta

- **Un ordenador con Linux**: un mini PC con Ubuntu o Debian, o una Raspberry Pi 4, 5 o Zero 2 W con Raspberry Pi OS
  de **64 bits** (en 32 bits funciona con Node 22, con soporte hasta abril de 2027). La Zero W original no vale.
- **Un nodo Meshtastic solo para el servidor**, enchufado por USB con un cable de datos, o accesible por la red (WiFi,
  Ethernet o una Raspberry con placa LoRa y `meshtasticd`).

**Un nodo, un cliente.** El firmware reparte lo que recibe entre todos los clientes conectados a la vez (Bluetooth,
cable y red): si el servidor y otro programa usan el mismo nodo, a cada uno le llega solo una parte de las lecturas.
Además, por la red solo admite un cliente: uno nuevo echa al anterior. Si Home Assistant ya usa un nodo con la
integración de Meshtastic, el servidor necesita otro.

## Instalar

Con `wget`, que viene en Ubuntu y en Raspberry Pi OS (con `curl` también vale: `curl -fsSL` en vez de `wget -qO-`):

```
wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash
```

Por defecto usa el nodo que haya enchufado por USB. Para un nodo por la red:

```
wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash -s -- --tcp 192.168.1.60
```

El instalador habla el idioma del equipo (español si el sistema está en español, catalán, euskera o gallego; si no,
inglés), o el que digas con `--idioma es` o `--idioma en`. Sus opciones (cada una tiene también su nombre en inglés):

| Opción | Qué hace |
|---|---|
| `--tcp HOST[:PUERTO]` | el nodo por la red en vez de por USB |
| `--puerto RUTA\|ID` | el nodo por USB en ese puerto (`/dev/serial/by-id/…` o `239a:8029`) |
| `--reconfigurar` | reescribe `/etc/talaia/config.json` con lo anterior (si no, una configuración que ya existe se deja) |
| `--rama RAMA` | instala desde otra rama del repositorio (por defecto, `main`) |
| `--sin-mosquitto` | no instala ni configura Mosquitto |
| `--desinstalar`, `--borrar-datos` | ver [Desinstalar](#desinstalar) |

El instalador:

- pone su propio Node en `/opt/talaia/node`, sin tocar el del sistema;
- deja el programa en `/opt/talaia/actual` y guarda las dos versiones anteriores;
- crea un usuario `talaia` sin privilegios, con permiso para el puerto serie (grupo `dialout`);
- escribe la configuración en `/etc/talaia/config.json` y guarda los datos en `/var/lib/talaia`;
- instala **Mosquitto** (el broker MQTT de casa) en el puerto 1883, **con usuario y contraseña**; los usuarios se
  crean desde la pantalla (ver [MQTT](#mqtt)). Si Mosquitto ya tenía su propia configuración, no la toca;
- deja el servicio `talaia` en marcha, y arranca solo al encender;
- si aún no hay usuarios de la pantalla, termina diciendo el **código para crear el primero** (ver
  [La pantalla](#la-pantalla)).

Para **actualizar**, vuelve a ejecutar la misma orden: se queda con tu configuración y tus datos.

## Con Docker

Para quien ya usa Docker, en un mini PC o una Raspberry Pi de 64 bits (para 32 bits, el instalador). La imagen,
`ghcr.io/dani-nros/talaia-hub` (amd64 y arm64), lleva el servidor y la pantalla; el `compose.yaml` le añade su propio
Mosquitto (la imagen oficial, `eclipse-mosquitto`), cuyos usuarios gestiona Talaia igual que con el instalador.

```
mkdir talaia && cd talaia
wget https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/docker/compose.yaml
docker compose up -d
docker compose exec talaia talaia --codigo
```

Antes del `up`, en `compose.yaml`:

- **El nodo por USB**: en `devices`, el aparato con el mismo nombre a los dos lados (`ls /dev/ttyACM* /dev/ttyUSB*`
  dice cuál es). **Por la red**: quita `devices` y pon `TALAIA_RECEIVER: tcp:192.168.1.60`.
- `TZ`: tu zona horaria (la de las horas del diario y del CSV).
- Si ya tienes un broker en el puerto 1883 de ese equipo, cambia el de Talaia (`"1884:1883"`). Sin broker:
  `TALAIA_BROKER: off` y quita el servicio `mosquitto`.

La configuración va en variables, que mandan sobre `/data/config.json` (que no hace falta):

| Variable | Qué es | Por defecto |
|---|---|---|
| `TALAIA_RECEIVER` | `usb`, `usb:/dev/ttyACM0`, `usb:239a:8029`, `tcp:192.168.1.60` o `tcp:192.168.1.60:4403` | `usb` |
| `TALAIA_BROKER` | el broker de este equipo: `mosquitto` (el del compose) o `off` | sin broker |
| `TALAIA_WEB_PORT` | el puerto de la pantalla dentro del contenedor | `4404` |
| `TALAIA_RETENTION_DAYS` | días de histórico | `365` |
| `TALAIA_LOG_LEVEL` | `debug`, `info`, `warn` o `error` | `info` |

Lo que cambia respecto al instalador:

- Las órdenes de la terminal van con `docker compose exec talaia talaia …` y el diario es `docker compose logs -f talaia`.
- Sin `LANG` en el contenedor, una instalación nueva empieza en inglés: el idioma se cambia en *Ajustes → Sistema*.
- Para **actualizar**: `docker compose pull && docker compose up -d`. Los datos están en el volumen `talaia-data` y los
  usuarios del broker en `broker-data`.
- **El USB es más delicado**: el contenedor recibe el puerto que dice `devices` al arrancar. Si el nodo se desenchufa y
  vuelve con otro nombre (`ttyACM1`), hay que cambiarlo ahí y repetir el `up`. Con el instalador no pasa.
- Dentro del contenedor, Talaia no sabe la IP del equipo: en Ajustes → MQTT dice «la IP de este equipo».
- Talaia corre con un usuario sin privilegios (uid 4404); el contenedor arranca como root solo para preparar sus
  carpetas, los ficheros de Mosquitto y el permiso del puerto USB.
- Al arrancar, el diario dice una vez que el broker no contesta: Mosquitto arranca justo después de Talaia. A los pocos
  segundos dice «conectado».

## Seguirlo

```
journalctl -u talaia -f       lo que va pasando
talaia --puertos              qué nodos hay enchufados por USB
systemctl status talaia       si está en marcha
sudo talaia --usuarios        los usuarios de la pantalla
sudo talaia --clave NOMBRE    contraseña nueva para ese usuario (lo crea si no está)
sudo talaia --codigo          el código para crear el primer usuario
```

En el diario salen la conexión con el receptor, las alarmas, las resueltas, los fallos (con qué hacer) y un resumen
cada hora, en el idioma del servidor (*Ajustes → Sistema*). La orden `talaia` contesta en el idioma de la terminal.

## Configuración

`/etc/talaia/config.json`; tras cambiarla, `sudo systemctl restart talaia`. Las claves valen en español o en inglés
(`receptor` o `receiver`, `datos` o `data`…).

```json
{
  "receptor": { "tipo": "usb", "puerto": "auto" },
  "web": { "puerto": 4404 },
  "datos": "/var/lib/talaia",
  "retencionDias": 365,
  "registro": "info",
  "mosquitto": { "puerto": 1883 }
}
```

- `receptor.puerto` por USB: `"auto"` (el nodo que haya enchufado; una radio USB que dice *Zigbee* o *Z-Wave* en su
  nombre no cuenta), un id USB como `"239a:8029"` (sigue valiendo si el puerto cambia de nombre) o una ruta fija, mejor
  de `/dev/serial/by-id/` (el nombre de `talaia --puertos`). Con dos radios por USB, fíjalo.
- Por la red: `{ "tipo": "tcp", "host": "192.168.1.60", "puerto": 4403 }`.
- `retencionDias`: cuánto histórico se guarda (por defecto, un año). Guarda la telemetría de **todos** los nodos que
  oye el receptor, y cada lectura ocupa unos 80 bytes: 50 nodos con 4 sensores cada media hora son unos 22 MB al mes
  (unos 270 MB al año). Si tu receptor oye cientos de nodos (por ejemplo, llegados por MQTT), pueden ser varios GB al
  año: en una Raspberry con tarjeta SD, baja los días. El diario dice cada 6 horas cuántas lecturas hay y cuánto ocupa.
- `registro`: `"depurar"` cuenta también cada reintento de conexión.
- `mosquitto`: el broker de este equipo, cuyos usuarios gestiona Talaia; lo pone el instalador.

## Si no conecta

El diario dice qué pasa y qué hacer. Lo más habitual:

- **No hay ningún nodo enchufado**: un cable que solo carga, o el nodo apagado. Al enchufarlo conecta solo en menos de
  un minuto.
- **El puerto está ocupado**: otro programa lo tiene abierto (la web de Meshtastic, un monitor serie…). En Ubuntu de
  escritorio, `brltty` se queda con los nodos de chip CH340: si no usas una línea braille, `sudo apt remove brltty`.
- **Por la red, se corta a menudo**: otro cliente (la app de Meshtastic, Home Assistant…) se está conectando al mismo
  nodo y echa al servidor.

En *Ajustes → Receptor* está el **diagnóstico de conexión**, que se puede copiar para contar un problema.

## Desinstalar

```
wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash -s -- --desinstalar
```

Los datos se quedan en `/var/lib/talaia`; con `--desinstalar --borrar-datos` se borran también (y los usuarios del
broker). Mosquitto se queda instalado, sin la configuración de Talaia (si no lo usas para nada más:
`sudo apt remove mosquitto`).

## La pantalla

Al terminar, el instalador dice en qué direcciones abrirla, como `http://192.168.1.50:4404`. Los datos y el receptor
son los del servidor: todos tus aparatos ven lo mismo, y si das *Enterado* en uno, queda visto en todos.

- **Secciones**: *Tablero* (el aviso de alarmas y los paneles de lo que vigilas), *Mapa*, *Nodos* (toda la malla, con su
  buscador: desde ahí se vigila un nodo), *Automatizaciones* (ver [Automatizaciones](#automatizaciones)), *Alarmas* (las
  activas y el registro) y *Ajustes*. En el ordenador van en una barra a la izquierda; en el móvil, abajo, y *Ajustes*
  en el engranaje de arriba.
- **El aviso de alarmas** de arriba del Tablero lista las activas. Cuando todas están vistas, una flecha lo contrae a
  una línea, lo que ocupa *Todo en orden*, y este aparato lo recuerda; una alarma nueva lo despliega. *Alarmas* enseña
  siempre la lista entera.
- **La ficha de un nodo o panel** (se abre pulsando su nombre) tiene pestañas: *Nodo* (pedir datos, ruta, ubicación y
  valla; solo en nodos Meshtastic), *Alarmas* (sin señal, límites, estados, cambio rápido), *Histórico* (las gráficas)
  y *Ajustes* (nombre, datos MQTT, conexión, lo que sale a la malla, y dejar de vigilar o quitar el panel). Uno que no
  se vigila solo tiene *Nodo* e *Histórico*. Cada aparato recuerda la última pestaña que usó, y lo que hayas escrito
  sin guardar sigue ahí al cambiar de pestaña.
- **El orden de los datos de un panel** lo eliges tú: *Ordenar* (en la pantalla completa y en el *Histórico* de la
  ficha) abre dos listas, los datos y las gráficas, cada una con flechas y un asa para arrastrar. El orden de los datos
  es el mismo en la tarjeta, la ficha y la pantalla completa; el de las gráficas, en la ficha y la pantalla completa.
  Cada gráfica tiene un botón *En la tarjeta*: es la gráfica que enseña la tarjeta del panel en el Tablero (púlsalo
  otra vez para que Talaia elija una). Lo guarda el servidor, por panel, así que todas las pantallas ven lo mismo; lo
  que aún no tiene sitio (un dato nuevo) va al final.
- **Las gráficas** dicen el valor y la hora de una lectura al pasar el ratón o tocarlas (en una barra ON/OFF: el
  estado, desde cuándo hasta cuándo y cuánto duró). Con el dedo, arrastra de lado para moverte por la línea; toca
  fuera para quitarlo.
- **Ajustes**, en apartados: *Malla* (sin señal para los nodos nuevos, avisos y órdenes por la malla), *MQTT* (brokers,
  usuarios del broker de este equipo, Home Assistant), *Receptor* (estado, nodo, radio, canales, diagnóstico), *Sistema*
  (idioma del servidor, histórico, acerca de), *Usuarios* y *Esta pantalla* (idioma, tema claro u oscuro, sonido,
  notificaciones, pantalla encendida y mapa sin internet: lo que es de cada aparato).
- **Dos idiomas**: cada pantalla elige el suyo (por defecto, el del navegador). El del servidor, aparte, es el de lo
  que escribe él: el registro, los avisos por la malla, Home Assistant, el diario y el CSV.
- **Con usuario y contraseña**, también en casa: sin entrar no se ve nada (ni nodos, ni posiciones, ni el
  histórico) ni se puede mandar nada. La primera vez, la pantalla pide crear el primer usuario con un **código** que
  dice el instalador al terminar (también está en el diario y con `sudo talaia --codigo`); así nadie de tu red
  se adelanta. Después, cada aparato entra una vez y se recuerda **30 días desde la última vez que se usa** (una
  pantalla que no se apaga no se cierra nunca).
- **Usuarios** (*Ajustes → Usuarios*): todos pueden hacerlo todo, también añadir y quitar usuarios o ponerles una
  contraseña nueva. Ahí se ve en qué aparatos está abierta cada sesión y se pueden cerrar. Nadie se puede quitar a sí
  mismo, así que siempre queda alguien. El registro dice quién hizo cada cosa (*Vigilando Garaje · Ana*). Si olvidas
  tu contraseña y no hay nadie más: `sudo talaia --clave TU_NOMBRE` en el equipo.
- **Las contraseñas** van cifradas (scrypt) y nunca salen del servidor; al menos 10 caracteres, sin más reglas (una
  frase sirve). Tras cinco intentos fallidos con un nombre, cada intento más espera el doble (hasta 15 min).
- **Por http, el navegador no deja** instalarla como app ni mostrar notificaciones con la página cerrada. Eso llega
  con https (Tailscale). Mientras tanto, la página suena y avisa mientras está abierta.
- **No conectes también el móvil por Bluetooth** al nodo del servidor: el nodo repartiría lo que recibe entre los dos.

## Desde fuera de casa (Tailscale)

Con [Tailscale](https://tailscale.com), la pantalla se abre desde el móvil o el portátil fuera de casa, sin abrir
puertos en el router: solo los aparatos de tu red de Tailscale llegan al servidor.

1. **El servidor en Tailscale**: instalado y unido a tu cuenta (`tailscale status` lo dice, con su nombre y su IP
   `100.…`). Así ya se puede abrir `http://100.x.y.z:4404` (o `http://nombre-del-equipo:4404`) desde cualquier aparato
   de tu red de Tailscale.
2. **Con https (recomendado)**: en la consola de Tailscale, *DNS*, deja activado *MagicDNS* y pulsa *Enable HTTPS*
   (en *HTTPS Certificates*). En el servidor:
   ```
   sudo tailscale serve --bg 4404
   ```
   Dice la dirección, como `https://bmax.tail1234.ts.net`. Se queda puesto aunque se reinicie el equipo
   (`tailscale serve status` para verlo; `sudo tailscale serve --https=443 off` para quitarlo). La primera vez tarda
   unos segundos: está sacando el certificado.
3. **En el móvil**: la app de Tailscale con la misma cuenta, conectada, y abre esa dirección en Chrome. Con https se
   puede **instalar como app** (menú de Chrome → *Instalar aplicación*) y dejar que avise con notificaciones mientras
   está abierta.

Lo que hay que saber:

- **Nada de Tailscale Funnel**: Funnel publica en internet. Si llega algo por Funnel, Talaia lo rechaza y lo apunta
  en el diario. Usa `tailscale serve`, que solo es para tu red de Tailscale.
- Desde tu red de Tailscale se llega a la pantalla, pero hay que entrar con un usuario, como en casa. Con https, la
  sesión solo viaja cifrada.
- El certificado de https sale en los registros públicos de certificados: el nombre del equipo y de tu red de
  Tailscale se pueden ver (no se puede entrar con ellos).
- Las notificaciones con la app cerrada (push) llegarán más adelante.

## Avisos por la malla

Se activan en *Ajustes → Malla → Avisos por la malla* (vienen apagados). Una vez activados, los manda el servidor
24/7, aunque no haya ninguna pantalla abierta: cada alarma (y, si quieres, cuando se resuelve) a un canal privado, a
un nodo o a ambos. Como mucho 20 por hora; los canales públicos están bloqueados.

## MQTT

Talaia se conecta a la vez a varios brokers MQTT, que se apuntan en *Ajustes → MQTT*:

- **Este servidor**: el Mosquitto de este equipo, el que pone el instalador. Ahí pueden publicar los dispositivos de
  casa (Shelly, Tasmota, zigbee2mqtt, ESPHome…). Solo deja entrar con usuario y contraseña: en *Usuarios de este
  broker* se crean (por ejemplo, uno para los Shelly), se les cambia la contraseña (guardando otra vez el mismo
  usuario) y se quitan. En el dispositivo: servidor, la IP de este equipo; puerto, 1883; y ese usuario. Las
  contraseñas se guardan cifradas y no vuelven a salir en ninguna pantalla.
- **Otros brokers** con *Añadir broker*, como el Mosquitto de Home Assistant: nombre, dirección, usuario y
  contraseña. Debajo de cada uno dice si está conectado o qué falla.

Por dentro, Talaia se los pide al plugin de seguridad dinámica de Mosquitto (por MQTT, con su propio usuario,
`talaia`): un usuario nuevo o una contraseña cambiada valen al momento, sin recargar Mosquitto ni cortar a quien ya está
conectado. Mosquitto los guarda, con la contraseña cifrada, en `/var/lib/mosquitto/talaia-dynamic-security.json`. Los
usuarios de los dispositivos pueden publicar y suscribirse en cualquier tema salvo en los que empiezan por `$` (así no
pueden crearse usuarios). Si usas un cortafuegos (`ufw`), abre el 1883 para la red de casa.

Home Assistant solo se conecta a un broker. Si quieres en Home Assistant algo que se publica en el de Talaia, lo normal
es un «puente» entre los dos Mosquitto (unas líneas de configuración en uno de ellos).

## Home Assistant

Home Assistant crea solos los dispositivos de Talaia. En *Ajustes → MQTT → Home Assistant*: activa *Publicar los
nodos vigilados*, elige el broker de Home Assistant y pulsa *Guardar* (viene apagado).

**Con el complemento Mosquitto de Home Assistant:**

1. En Home Assistant, crea un usuario para Talaia: Ajustes → Personas → *Añadir persona* (por ejemplo `talaia`), con
   permiso para iniciar sesión, y ponle contraseña. Mosquitto deja entrar con los usuarios de Home Assistant (los
   nombres `homeassistant` y `addons` están reservados).
2. En la pantalla de Talaia, *Ajustes → MQTT → Añadir broker*: nombre (Home Assistant), la dirección de
   Home Assistant (como `192.168.1.20`; si no pones puerto, usa el 1883), ese usuario y su contraseña. Luego, en
   *Home Assistant*, actívalo y elige ese broker.
3. En Home Assistant aparecen solos, en Ajustes → Dispositivos y servicios → MQTT:
   - **Talaia** (el servidor): receptor conectado, alarmas sin atender (sí/no y cuántas), alarmas activas, nodos oídos
     en la última hora, último aviso por la malla, el evento *Alarmas* y el botón *Enterado todas*.
   - **Talaia · Caseta huerto** (uno por cada nodo vigilado): sus lecturas (temperatura, humedad, batería…), cuándo se
     oyó por última vez, saltos y SNR; y por cada alarma que le tengas puesta, un sensor (encendido mientras salta,
     con el detalle en sus atributos) y su botón *Enterado*. La posición no se manda.

Los nombres salen en el idioma del servidor (*Ajustes → Sistema*); al cambiarlo se le vuelven a anunciar a Home
Assistant, sin cambiar sus identificadores ni sus temas.

Las alarmas y los límites se siguen poniendo en Talaia: Home Assistant los ve y puede dar *Enterado*, pero no los
cambia. Va solo lo de los nodos Meshtastic: los datos MQTT de los paneles y sus alarmas, no (ni cuentan en las
alarmas activas, ni *Enterado todas* las da por vistas). Si renombras un nodo en Talaia, su dispositivo cambia de
nombre. Si dejas de vigilar un nodo, su dispositivo desaparece de Home Assistant. Si el servidor se apaga o se cae,
Home Assistant marca sus entidades como no disponibles. Talaia sigue sonando y avisando como siempre: Home Assistant es
una salida más.

**Avisar al móvil con la app de Home Assistant.** Cada alarma que salta, se resuelve o se da por vista llega como
evento, con `event_type` *alarma*, *resuelta* o *vista*, y en sus atributos `texto`, `detalle`, `nodo` e `id`. La
entidad es *Alarmas* en el dispositivo *Talaia*: `event.talaia_alarmas` (`event.talaia_alarms` si el servidor estaba
en inglés al crearla). Una automatización (en YAML; cambia `mobile_app_mi_movil` por tu móvil y la entidad por la tuya):

```yaml
alias: Talaia → móvil
triggers:
  - trigger: state
    entity_id: event.talaia_alarmas
    not_from: [unavailable, unknown]   # que no avise al reiniciar Home Assistant o el servidor
conditions:
  - condition: template
    value_template: "{{ trigger.to_state.attributes.event_type == 'alarma' }}"
actions:
  - action: notify.mobile_app_mi_movil
    data:
      title: Talaia
      message: "{{ trigger.to_state.attributes.texto }}. {{ trigger.to_state.attributes.detalle or '' }}"
```

**Temas** (por si los usas desde otro programa; el tema base se cambia en *Ajustes → MQTT → Home Assistant → Temas*):

```
talaia/estado                    online / offline (retenido; offline también si el servidor se cae)
talaia/servidor/estado           JSON: receptor, sin_atender, activas, oidos, aviso (retenido)
talaia/servidor/evento           JSON por cada alarma, resuelta o vista (no retenido)
talaia/servidor/enterado_todas   ← cualquier mensaje: «Enterado» a todas
talaia/nodo/<id>/estado          JSON: m (lecturas), oido, saltos, snr, a (alarmas ON/OFF), d (su detalle) (retenido)
talaia/nodo/<id>/enterado        ← el nombre de la alarma (como temperature_alta): «Enterado» a esa
homeassistant/…/talaia_…/config  autodescubrimiento de Home Assistant (retenido)
```

`<id>` es el número del nodo en hexadecimal, sin `!` (como `3c6e19a2`). Los identificadores en Home Assistant empiezan
por el tema base (`talaia_…`): si lo cambias, Home Assistant ve dispositivos nuevos y los de antes se quitan.

Cualquier usuario de la pantalla puede cambiar a qué broker se conecta el servidor o apagar MQTT, pero no ver la
contraseña guardada.

## Paneles y datos por MQTT

El tablero no es solo de nodos Meshtastic: cualquier dispositivo que publique por MQTT (Shelly, Tasmota, Sonoff,
Zigbee con zigbee2mqtt, ESPHome, Home Assistant…) puede tener su panel, con sus lecturas, gráficas, alarmas (también
avisos por la malla) e histórico, como un nodo.

- **Panel nuevo**: *Añadir panel*, en el tablero. Un nombre y qué es (solo para la etiqueta).
- **Datos por MQTT**: en la ficha de cada panel (también en la de un nodo, para tener junto a él otro dato, como la
  temperatura de dentro de la caseta). Cada dato lleva su nombre (puede haber varias temperaturas), qué es, de qué
  broker viene, el tema y, si llega un JSON, el campo (`temperature`, o `ENERGY.Power` si va dentro de otro). Si el
  viento llega en km/h o la temperatura en °F, se elige la unidad y Talaia la pasa a la suya. Debajo de cada dato se
  ve el último valor que ha llegado. *Otro número* sirve para lo que no está en la lista (con la unidad que pongas).
- **Buscar temas** escucha los brokers unos segundos y enseña los temas con números (se pueden filtrar). **Usar**
  pone uno en la lista: adivina qué es por el nombre (temperature, humidity, Power…) y, si Home Assistant publica la
  unidad, la elige; si no, el viento queda en km/h, lo normal en Home Assistant. Compruébalo.
- **Lecturas**: el valor se ve y salta la alarma al momento; en el histórico se guarda uno por minuto como mucho.
- **Estados ON/OFF** (*Estado ON/OFF* en el tipo): un enchufe, un relé, una puerta, un detector de agua… Talaia
  entiende `ON`/`OFF`, `on`/`off`, `true`/`false`, `1`/`0`, `open`/`closed`, `online`/`offline` y un JSON con
  cualquiera de ellos (`{"POWER":"ON"}` de Tasmota, `{"output":true}` de Shelly, `{"contact":false}` de
  zigbee2mqtt). Se eligen sus nombres (*Encendido / Apagado*, *Abierta / Cerrada*, *Hay agua / Seco*…) y, si el
  dispositivo lo dice al revés, *Al revés*: el `contact` de zigbee2mqtt es `true` con la puerta **cerrada** (al usarlo
  desde *Buscar temas* ya se marca). Cada cambio se guarda al momento en el histórico (si no cambia, uno por hora) y
  su gráfica es una barra de tiempo con lo que estuvo encendido.
- **Shelly de segunda y tercera generación** (Plus, Pro, Gen3): en el Shelly, *Ajustes → MQTT*, activa *Generic status
  update over MQTT*; el estado completo sale en `<prefijo>/status/switch:0` (campos `output`, `apower`, `voltage`,
  `aenergy.total` en Wh, `temperature.tC`), y la conexión en `<prefijo>/online`. Sin esa opción, solo está
  `<prefijo>/events/rpc`, con el campo `params.switch:0.output`: llega solo cuando algo cambia (*Buscar temas* lo ve si
  pulsas el enchufe mientras busca) y a veces sin ese campo (solo la potencia): esos mensajes no cuentan para el dato.
- **Alarma de un estado**, en la ficha: *Avisar cuando: Abierta* (o *Cerrada*), al momento o solo si sigue así más de
  unos minutos (una puerta abierta más de 10 min, una bomba encendida más de 1 h). Se resuelve al cambiar.
- **Encender y apagar desde Talaia**: en un estado, *Encender y apagar desde Talaia* y el tema al que se mandan las
  órdenes, con el mensaje para cada estado. Talaia lo propone a partir del tema de estado (Shelly Plus/Pro/Gen3:
  `…/command/switch:0` con `on` y `off`, con *Enable MQTT Control* activado en el Shelly; Tasmota: `cmnd/…/POWER` con
  `ON` y `OFF`; zigbee2mqtt: `zigbee2mqtt/…/set` con `{"state":"ON"}`; ESPHome: `…/switch/…/command`); se puede
  cambiar. En la tarjeta, la ficha y la pantalla completa sale un interruptor: se pulsa y se manda, **sin
  confirmación** (cualquier usuario de la pantalla puede usarlo). Dice *Enviando…* hasta que el dispositivo cuenta por
  su tema de estado que lo ha hecho; si en 10 s no lo cuenta, *No ha contestado*. Cada orden queda en el registro.
  Home Assistant no recibe órdenes por `mqtt_statestream`.
- **Los Shelly no guardan su estado en el broker**: al conectar con él (y al guardar los datos), Talaia les pide que lo
  digan (`status_update` en `…/command/switch:0`; en los de primera generación, `update`). Solo es una petición de
  información, no cambia nada. Por `…/events/rpc` no se puede pedir: mejor `…/status/switch:0`.
- **Conexión del dispositivo** (paneles sin nodo, opcional): el tema donde dice si está conectado. Tasmota:
  `tele/…/LWT` (`Online`/`Offline`); Shelly: `…/online` (`true`/`false`); zigbee2mqtt: `zigbee2mqtt/…/availability`
  (campo `state`). Con él, el panel dice *Sin conexión* al momento y, con *Avisar si se desconecta*, salta su alarma
  (y su aviso por la malla, si están activados). *Buscar temas* lo reconoce y ofrece *Usar como conexión*.
- **Nombre**: todos los paneles se pueden renombrar. El de un nodo es solo para Talaia (tablero, alarmas, avisos por
  la malla y Home Assistant): su nombre de Meshtastic se queda como información y, con el nombre vacío, vuelve a él.
- **Sin datos**: en un panel sin nodo, la alarma «no llega ningún dato en más de…» viene apagada, porque hay
  dispositivos que solo publican cuando algo cambia.
- **Pantalla completa**: el botón de la cabecera de cada tarjeta enseña ese panel a toda pantalla y la deja encendida
  (para una tableta en la pared).
- **Quitar panel** (al final de su ficha) lo borra con su histórico. Al quitar un dato, se borra también el suyo.

La ubicación y el mapa siguen siendo solo de los nodos Meshtastic. A Home Assistant no van los datos MQTT ni sus
alarmas: si los quieres allí, Home Assistant puede leerlos del broker donde se publican. (El sensor *último aviso por
la malla* sí enseña el texto del último mensaje que salió por la malla, sea de lo que sea.)

## A la malla (el panel del receptor)

Los datos MQTT del panel del receptor pueden salir a la malla cada cierto tiempo como **su telemetría de ambiente**,
como si tuviera esos sensores: la app de Meshtastic y Talaia los ven en sus gráficas. Es lo de una estación del barrio
en la misma ubicación que el nodo.

- En cada dato del receptor, la casilla **A la malla**, y debajo de *Datos por MQTT*, **Mandar a la malla**: **cada**
  cuánto (por defecto, 30 minutos, a las en punto y a las y media), **por qué canal** y con **cuántos saltos** (por
  defecto, los del receptor). Viene apagado.
- **Enviar ahora** manda lo que haya sin esperar (como mucho, uno por minuto).

Lo que hay que saber:

- **Un dato de cada tipo.** La telemetría de Meshtastic no lleva nombres: tiene un hueco por tipo de dato. Puede
  haber varias temperaturas en el panel del receptor, pero solo una sale a la malla. Potencia, energía o CO₂ no tienen
  hueco en la telemetría de ambiente: se ven en el panel, pero no salen.
- **Salen como medidos por el receptor y en su posición.** Para una estación del barrio, bien; para datos de otro
  sitio, quien los vea en el mapa los pondrá donde está el receptor.
- **Si el receptor tiene sensores de ambiente propios**, sus valores se mezclarían con los de la estación.
- **«No disponible» no se manda.** Si Home Assistant dice `unavailable` o `unknown`, ese dato no sale. Como Home
  Assistant solo publica cuando el valor cambia (la lluvia puede estar a 0 días), por defecto se manda el último que
  llegó; en cada dato se puede elegir dejar de mandarlo si lleva 1, 3, 12 o 24 h sin llegar nada nuevo.
- **Canal público o privado.** Por un canal público lo ve cualquiera y puede acabar en los mapas de internet; para
  una estación del barrio puede tener sentido, para datos de casa, mejor uno privado. El firmware manda su propia
  telemetría por el canal principal; por otro canal la ven quienes lo tengan.
- **Lluvia 24 h** es «las últimas 24 horas»: si tu estación da «lluvia de hoy», saldrá con ese nombre.
- En el diario sale cada fallo (una vez, no cada media hora) y cuando vuelve a salir bien.

**Desde Home Assistant**, sus sensores no salen por MQTT por su cuenta. Con `mqtt_statestream` en
`configuration.yaml` (y reiniciar Home Assistant):

```yaml
mqtt_statestream:
  base_topic: ha_estados
  publish_attributes: true
  include:
    entities:
      - sensor.estacion_temperatura
      - sensor.estacion_humedad
      - sensor.estacion_presion
      - sensor.estacion_viento
```

Con `publish_attributes: true` sale también la unidad de cada uno y Talaia la elige sola. Cada uno sale en
`ha_estados/sensor/estacion_temperatura/state` (retenido: Talaia lo tiene nada más conectar). No incluyas los sensores
«Talaia · …»: Talaia rechaza sus propios temas para no volver a recibir lo que ya publica él.

## Zigbee (Zigbee2MQTT)

Los sensores y enchufes Zigbee (contactos de puerta, temperatura y humedad, fugas de agua, movimiento, enchufes
inteligentes…) llegan a Talaia a través de **Zigbee2MQTT**, un programa aparte que habla con un coordinador Zigbee por
USB y publica cada dispositivo por MQTT. Talaia no lo instala ni lo actualiza: va por su cuenta, en el mismo equipo, y
publica en el broker de Talaia; desde ahí sus dispositivos son [datos MQTT](#paneles-y-datos-por-mqtt) como cualquier
otro. Así se monta en Ubuntu, Debian o Raspberry Pi OS con el **Sonoff ZBDongle-E** (otro coordinador va igual,
cambiando `adapter`). Donde esta guía y [la de Zigbee2MQTT](https://www.zigbee2mqtt.io/guide/installation/01_linux.html)
no coincidan, manda la suya: cambia más deprisa que Talaia.

### 1. El dongle

- Enchúfalo **con el alargador USB** que trae, lejos de los puertos USB 3, de los SSD y del nodo Meshtastic:
  interfieren en los 2,4 GHz de Zigbee.
- `ls /dev/serial/by-id/` lo enseña como `usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_…-if00` (el ZBDongle-P, más
  antiguo, dice `…Dongle_Plus_…` sin `V2`, y lleva `adapter: zstack`). Ese es el nombre que se usa más abajo:
  `/dev/ttyACM0` puede cambiar al reiniciar.
- **El receptor de Talaia no debe quedárselo.** Con `"puerto": "auto"` Talaia salta los puertos que dicen *Zigbee* en
  su nombre USB, pero con dos radios por USB es más seguro fijar el puerto del nodo en `/etc/talaia/config.json`: su id
  USB (lo da `talaia --puertos`, como `239a:8029`) o su ruta `/dev/serial/by-id/…`, y después
  `sudo systemctl restart talaia`. La regla de udev que pone el instalador ya mantiene a ModemManager lejos del chip
  del dongle.

### 2. Un usuario para él en el broker de Talaia

En la pantalla, *Ajustes → MQTT → Usuarios de este broker*: un usuario `zigbee2mqtt` con una contraseña de al menos
8 caracteres. Guárdala para el paso 4.

### 3. Instalar Zigbee2MQTT

Necesita su propio Node.js, 20 o más nuevo. El de `/opt/talaia/node` es de Talaia (su instalador lo reemplaza): no
apuntes Zigbee2MQTT a él. El `nodejs` del sistema en Ubuntu 24.04 y Raspberry Pi OS 12 es demasiado viejo; se coge de
NodeSource (64 bits), como hace la guía de Zigbee2MQTT:

```
sudo apt-get install -y git make g++ gcc libsystemd-dev curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm
```

Después el programa, en `/opt/zigbee2mqtt`, como un usuario propio que pueda usar el puerto serie:

```
sudo useradd --system --home-dir /opt/zigbee2mqtt --shell /usr/sbin/nologin zigbee2mqtt
sudo usermod -aG dialout zigbee2mqtt
sudo mkdir -p /opt/zigbee2mqtt && sudo chown zigbee2mqtt:zigbee2mqtt /opt/zigbee2mqtt
sudo -u zigbee2mqtt -H git clone --depth 1 https://github.com/Koenkk/zigbee2mqtt.git /opt/zigbee2mqtt
cd /opt/zigbee2mqtt
sudo -u zigbee2mqtt -H pnpm i --frozen-lockfile
sudo -u zigbee2mqtt -H pnpm run build
```

Los dos últimos tardan unos minutos en un mini PC o una Raspberry Pi 4/5. En una Pi Zero 2 W (512 MB) van muy lentos
y pueden quedarse sin memoria: Zigbee2MQTT no está hecho para ella.

### 4. Su configuración

`/opt/zigbee2mqtt/data/configuration.yaml` (sustituye el que trae la descarga; respeta la sangría):

```yaml
homeassistant:
  enabled: false
frontend:
  enabled: true
  port: 8080
  auth_token: una-contraseña-larga-para-su-pantalla
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://127.0.0.1:1883
  user: zigbee2mqtt
  password: la-contraseña-del-paso-2
serial:
  port: /dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_…-if00
  adapter: ember
availability:
  enabled: true
advanced:
  network_key: GENERATE
  pan_id: GENERATE
  ext_pan_id: GENERATE
  channel: 15
```

- `availability` hace que cada dispositivo publique si está al alcance (`zigbee2mqtt/<nombre>/availability`): Talaia
  lo usa como la conexión del panel.
- `channel`: 11 por defecto; 15, 20 y 25 chocan menos con el WiFi. Elígelo ahora: cambiarlo después obliga a
  emparejar todo otra vez.
- `frontend.auth_token` protege con contraseña la pantalla propia de Zigbee2MQTT (si no, cualquiera de la red podría
  emparejar o quitar dispositivos).
- `homeassistant` se queda apagado: el broker de Talaia no es el de Home Assistant. Si quieres los dispositivos Zigbee
  también en Home Assistant, o Home Assistant lee el broker de Talaia (un puente entre los dos Mosquitto) o Zigbee2MQTT
  publica en el broker de Home Assistant y añades ese broker en Talaia (*Ajustes → MQTT*).

### 5. El servicio

`/etc/systemd/system/zigbee2mqtt.service`:

```ini
[Unit]
Description=Zigbee2MQTT
After=network.target mosquitto.service

[Service]
Type=simple
User=zigbee2mqtt
Group=zigbee2mqtt
WorkingDirectory=/opt/zigbee2mqtt
ExecStart=/usr/bin/node index.js
Environment=NODE_ENV=production
Restart=always
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now zigbee2mqtt
journalctl -u zigbee2mqtt -f
```

El diario debe decir, por este orden, que ha conectado con el servidor MQTT, la versión del firmware del coordinador,
que la pantalla está en el puerto 8080 y `Zigbee2MQTT started!`. En Talaia, *Buscar temas* (paso 7) enseñará
`zigbee2mqtt/bridge/…` en cuanto esté en marcha.

### 6. Si el firmware es demasiado viejo

`adapter: ember` necesita EmberZNet **7.4 o más nuevo** en el dongle. Muchos ZBDongle-E se venden con 6.10.x:
Zigbee2MQTT entonces se para al arrancar diciendo que el firmware es demasiado viejo (o que no puede hablar con el
adaptador). Flashéalo siguiendo [las instrucciones de ITead](https://dongle.sonoff.tech/) con el firmware *Zigbee 3.0
NCP (EmberZNet)* del ZBDongle-E, desde un ordenador con Chrome, y vuelve a enchufarlo. La
[página de EmberZNet](https://www.zigbee2mqtt.io/guide/adapters/emberznet.html) de Zigbee2MQTT tiene los detalles y
las versiones que recomienda. Después, `sudo systemctl restart zigbee2mqtt`.

### 7. Emparejar los dispositivos y traerlos a Talaia

- Abre la pantalla de Zigbee2MQTT, `http://<la IP de este equipo>:8080`, y pulsa **Permit join (All)**; pon el
  dispositivo en modo de emparejar (normalmente, su botón unos segundos) y aparece en menos de un minuto, con su modelo.
- **Renómbralo enseguida** (el lápiz, *Rename device*), con un nombre corto y sin acentos, como `puerta-caseta`: el
  nombre es su tema MQTT (`zigbee2mqtt/puerta-caseta`). Si lo renombras más tarde, sus datos en Talaia dejan de llegar
  hasta que los apuntes al tema nuevo.
- En el dispositivo, *Settings (specific)* → **Retain** activado, y guarda: el último valor se queda en el broker, así
  Talaia lo tiene en cuanto conecta (y *Buscar temas* lo ve sin esperar a que el sensor hable).
- En el tablero de Talaia, **Añadir panel**: un nombre y *Zigbee* como qué es. En su pestaña *Ajustes*, **Buscar
  temas** y **Usar** en cada campo de `zigbee2mqtt/<nombre>`: `temperature`, `humidity`, `battery`, `contact` (viene
  con *Al revés* marcado), `water_leak`, `occupancy`, `state` (un enchufe: *Encender y apagar desde Talaia* propone
  `zigbee2mqtt/<nombre>/set`), `power`, `energy`, `voltage`… `linkquality` no es una medida que Talaia guarde; déjalo.
  En `zigbee2mqtt/<nombre>/availability`, **Usar como conexión** y, si quieres, *Avisar si se desconecta*. Guarda.

Desde entonces es un panel como cualquier otro: alarmas, histórico, automatizaciones, órdenes por la malla y Telegram.

### Actualizar Zigbee2MQTT

Lee antes sus notas de versión: cambia a menudo y a veces cambia lo que publica (lo que lee Talaia son los temas
estándar, que no cambian). Después:

```
sudo systemctl stop zigbee2mqtt
cd /opt/zigbee2mqtt
sudo -u zigbee2mqtt -H cp -r data data.bak
sudo -u zigbee2mqtt -H git pull
sudo -u zigbee2mqtt -H pnpm i --frozen-lockfile
sudo -u zigbee2mqtt -H pnpm run build
sudo systemctl start zigbee2mqtt
```

Actualizar Talaia no toca nada de esto.

## Automatizaciones

Reglas «si… entonces…» que el servidor cumple 24/7, aunque no haya ninguna pantalla abierta. Se hacen en la sección
*Automatizaciones* (*Nueva*).

**Si…**, lo que la pone en marcha:

- **Un dato o un estado** de un panel: un número que pasa de un valor o baja de él (*Huerto · Humedad suelo baja de
  30 %*), o un estado ON/OFF que pasa a uno de los dos (*Taller · Puerta pasa a Abierta*). Si quieres, **y sigue así al
  menos** unos minutos.
- **Una hora del día**, los días de la semana que elijas, con la hora del servidor.
- **Una orden** (por la malla o Telegram): un texto que mandas desde un nodo Meshtastic (ver
  [Órdenes por la malla](#órdenes-por-la-malla)) o desde un chat de Telegram emparejado (ver [Telegram](#telegram)).
  *Llega por* dice cuál de los dos caminos cuenta: la malla, Telegram o cualquiera.

**Entonces…**, pasos en orden (hasta 20):

- **Encender o apagar** un interruptor (un dato ON/OFF con *Encender y apagar desde Talaia*). Con minutos en
  **Durante**, después vuelve como estaba.
- **Esperar** segundos, minutos u horas (hasta 24 h).
- **Mensaje por la malla**, a un canal privado o a un nodo. `{valor}` pone el valor del dato que la ha puesto en marcha,
  y `{hora}`, la hora (también valen `{value}` y `{time}`).
- **Mensaje por Telegram**, a todos los chats emparejados (ver [Telegram](#telegram)), con los mismos `{valor}` y
  `{hora}`. Con un nodo en *Con la posición de*, va también su última posición como un punto en el mapa.
- **Pedir datos a un nodo**: ambiente, batería, calidad del aire, energía o posición.

Cada una tiene su interruptor para activarla o desactivarla y **Probar** (se pulsa dos veces) para hacer sus pasos ya;
la lista dice qué está esperando y cuándo se puso en marcha por última vez, y el registro, cada vez que se pone en
marcha y por qué.

Conviene saber:

- **Solo cuenta el momento en que pasa.** Si ya era así al guardarla, activarla o arrancar el servidor, espera a que
  deje de serlo. Para volver a ponerse en marcha, un número tiene que volver atrás con un pequeño margen (0,3 °C la
  temperatura, 2 % la humedad…): una lectura que baila sobre el límite no la pone en marcha una y otra vez.
- **Si se pone en marcha mientras espera**, empieza otra vez desde el primer paso: *encender la luz, esperar 5 min,
  apagarla* la apaga 5 min después de la última vez.
- **«Durante» siempre vuelve**, aunque mientras tanto desactives, cambies o quites la automatización: una bomba nunca se
  queda encendida. Si una automatización le manda otra orden a ese interruptor mientras tanto, vale la última.
- **Las esperas siguen tras un reinicio.** Lo que venció con el servidor parado se hace unos segundos después de
  arrancar; volver a poner un interruptor como estaba se reintenta durante 10 minutos si su broker aún no está
  conectado. Una hora del día que pasó con el servidor parado no se hace después.
- **El freno**: una que se pone en marcha sola 10 veces en 10 minutos se pausa, y el registro lo dice. Revísala y
  actívala otra vez.
- **Los mensajes** salen por la cola de los avisos: uno cada 8 s, 20 por hora como mucho contando todo, y solo a canales
  privados o a un nodo.
- **Con Docker**, la hora del día es la del contenedor: `TZ` en `compose.yaml` (viene `Europe/Madrid`).
- Una automatización no manda nada por la malla hasta que se pone en marcha; lo que pruebes con *Probar* sí sale.

## Órdenes por la malla

Desde un nodo Meshtastic (el móvil con la app de Meshtastic, un nodo de mano…), con un mensaje de texto al receptor del
servidor: encender o apagar un interruptor, preguntar cómo está o poner en marcha una automatización. Talaia contesta
por el mismo camino. Se configura en *Ajustes → Malla → Órdenes por la malla* (apagado de entrada).

- **Nodos que pueden mandarlas**, por **mensaje directo**. El mensaje tiene que venir cifrado con la clave de ese nodo
  (Meshtastic lo hace solo cuando los dos tienen clave; desde el firmware 2.7.15 no deja pasar otros mensajes
  directos), y esa clave tiene que ser la que tenía el nodo al añadirlo. Si cambia (alguien que se hace pasar por él,
  o el mismo nodo flasheado otra vez), sus órdenes se rechazan; si es el mismo nodo, quítalo y vuelve a añadirlo.
- **Y por el canal** (si quieres): un canal privado, en el que puede mandar órdenes cualquiera que tenga su clave.
- **Una palabra para cada interruptor**. Con la palabra `bomba`: `bomba on`, `bomba off` y `bomba ?` (cómo está);
  también valen `encender` y `apagar`, `1` y `0` o `estado`. No importan las mayúsculas ni los acentos.
- **Automatizaciones por orden**: una cuyo *Si…* es *Una orden por la malla* se pone en marcha con su texto (`riego`)
  y contesta *Riego del huerto: en marcha* (o que está desactivada).
- **`ayuda`** (o `help`, `?`) contesta con las órdenes que hay.

Las respuestas, en el idioma del servidor:

- La de un interruptor, cuando el dispositivo dice que lo ha hecho: *Bomba: Encendido*, o *Bomba: no ha contestado a
  «Encendido»* a los 10 s. Para `bomba ?`, cómo está y desde cuándo: *Bomba: Apagado desde hace 2 h*.
- Vuelven por donde llegó la orden (mensaje directo, o el canal), por la cola de los avisos: uno cada 8 s y 20 por
  hora como mucho contando todo.
- A un nodo autorizado que manda un mensaje directo que no es una orden, le dice cómo verlas. Por el canal solo
  contesta a las órdenes: si no, dos servidores en el mismo canal se contestarían entre sí.

No se toman como órdenes:

- Los mensajes de quien no está autorizado. Van al registro (uno cada 10 minutos por nodo) y no se contesta nada.
- Lo que esperaba en el receptor mientras el servidor no estaba conectado: lo que llega en los primeros 10 s tras
  conectar, o tiene más de 10 minutos según el reloj del receptor (que puede ir unos minutos desfasado).
- El mismo mensaje oído dos veces (por un vecino que lo repite) y más de 20 órdenes en 10 minutos del mismo nodo.

## Telegram

Un bot de Telegram te manda las alarmas al móvil y atiende órdenes desde un chat o un grupo. No se abre nada en
casa: el servidor le pregunta a Telegram qué hay de nuevo, así que funciona detrás de cualquier router y con
Tailscale. Está apagado hasta que lo configuras, y lo que manda pasa por los servidores de Telegram (los textos de las
alarmas y las lecturas de tus paneles cuando las pides), así que déjalo apagado si prefieres que todo se quede en casa.

- **Crear el bot**: en Telegram, habla con *@BotFather*, manda `/newbot` y ponle un nombre. Te contesta con un
  **token** (como `123456789:AAH…`). Pégalo en *Ajustes → Telegram* y pulsa *Guardar y conectar*: Talaia lo comprueba
  y dice *Conectado como @tubot*. El token se guarda en el servidor y no vuelve a mostrarse.
- **Emparejar un chat o un grupo**: *Ajustes → Telegram* enseña un **código**. Abre un chat con tu bot (o añádelo a
  un grupo) y manda el código tal cual. El chat aparece en la lista y el código cambia: un código empareja un chat.
  A cualquier otro que encuentre el bot se le dice que hace falta un código, y nada más. Puedes quitar un chat de la
  lista (se le avisa de que ya no recibe nada), y un grupo que echa al bot, o una persona que lo bloquea, sale solo.
- **Alarmas**: cada alarma que salta va a todos los chats emparejados, con su detalle y un botón **Enterado** que la
  da por vista en Talaia (el registro dice quién: *Ana, por Telegram*). Cuando la alarma se ve o se resuelve, el botón
  pasa a ser una nota (*✓ Vista*, *✓ Resuelta*). Van también las alarmas de los datos MQTT y las del receptor.
- **En el chat**: `/paneles` enseña un botón por cada panel vigilado: pulsa uno y contesta con sus datos de ahora,
  cuándo llegó el último, sus alarmas (con sus botones) y un par de botones por cada interruptor que tenga. `/panel nombre` hace lo mismo por el nombre. `/alarmas`
  lista las activas. `/ayuda` cuenta todo esto.
- **Órdenes**: las palabras de los interruptores de [Órdenes por la malla](#órdenes-por-la-malla) valen aquí también
  (`riego on`, `riego off`, `riego ?`), y los textos de las automatizaciones. En un grupo el bot solo ve lo que empieza
  por `/` o lo menciona, así que allí escribe `/riego on`. La respuesta vuelve al chat y el registro dice quién dio la
  orden.
- **Un mensaje de prueba** (*Ajustes → Telegram → Mandar un mensaje de prueba*) te dice que llega a todos los chats.

