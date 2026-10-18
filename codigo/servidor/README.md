# Vigía servidor

Vigía Mesh funcionando 24/7 en Linux: las mismas alarmas que la app (umbral, cambio rápido, valla antirrobo, sin
señal) y el histórico de lecturas en SQLite, aunque no haya ningún móvil ni ordenador mirando.

> **En pruebas.** Vigila, guarda el histórico y lo cuenta en el diario del sistema; tiene la misma pantalla que la app
> (ábrela desde el navegador en la red de casa), manda los avisos por la malla si los activas y publica en Home
> Assistant por MQTT. El acceso desde fuera con https (Tailscale) llega en el siguiente paso.

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
wget -qO- https://raw.githubusercontent.com/Dani-NRos/vigia-mesh/main/codigo/servidor/instalar.sh | sudo bash
```

Por defecto usa el nodo que haya enchufado por USB. Para un nodo por la red:

```
wget -qO- https://raw.githubusercontent.com/Dani-NRos/vigia-mesh/main/codigo/servidor/instalar.sh | sudo bash -s -- --tcp 192.168.1.60
```

El instalador:

- pone su propio Node en `/opt/vigia/node`, sin tocar el del sistema;
- deja el programa en `/opt/vigia/actual` y guarda las dos versiones anteriores;
- crea un usuario `vigia` sin privilegios, con permiso para el puerto serie (grupo `dialout`);
- escribe la configuración en `/etc/vigia/servidor.json` y guarda los datos en `/var/lib/vigia`;
- deja el servicio `vigia-servidor` en marcha, y arranca solo al encender.

Para **actualizar**, vuelve a ejecutar la misma orden: se queda con tu configuración y tus datos.

## Seguirlo

```
journalctl -u vigia-servidor -f       lo que va pasando
vigia-servidor --puertos              qué nodos hay enchufados por USB
systemctl status vigia-servidor       si está en marcha
```

En el diario salen la conexión con el receptor, las alarmas, las resueltas, los fallos (con qué hacer) y un resumen
cada hora.

## Configuración

`/etc/vigia/servidor.json`; tras cambiarla, `sudo systemctl restart vigia-servidor`.

```json
{
  "receptor": { "tipo": "usb", "puerto": "auto" },
  "web": { "puerto": 4404 },
  "datos": "/var/lib/vigia",
  "retencionDias": 365,
  "registro": "info"
}
```

- `receptor.puerto` por USB: `"auto"` (el nodo que haya enchufado), un id USB como `"239a:8029"` (sigue valiendo si
  el puerto cambia de nombre) o una ruta fija, mejor de `/dev/serial/by-id/` (el nombre de `vigia-servidor --puertos`).
- Por la red: `{ "tipo": "tcp", "host": "192.168.1.60", "puerto": 4403 }`.
- `retencionDias`: cuánto histórico se guarda (por defecto, un año). Guarda la telemetría de **todos** los nodos que
  oye el receptor, y cada lectura ocupa unos 80 bytes: 50 nodos con 4 sensores cada media hora son unos 22 MB al mes
  (unos 270 MB al año). Si tu receptor oye cientos de nodos (por ejemplo, llegados por MQTT), pueden ser varios GB al
  año: en una Raspberry con tarjeta SD, baja los días. El diario dice cada 6 horas cuántas lecturas hay y cuánto ocupa.
- `registro`: `"depurar"` cuenta también cada reintento de conexión.

## Si no conecta

El diario dice qué pasa y qué hacer. Lo más habitual:

- **No hay ningún nodo enchufado**: un cable que solo carga, o el nodo apagado. Al enchufarlo conecta solo en menos de
  un minuto.
- **El puerto está ocupado**: otro programa lo tiene abierto (la web de Meshtastic, un monitor serie…). En Ubuntu de
  escritorio, `brltty` se queda con los nodos de chip CH340: si no usas una línea braille, `sudo apt remove brltty`.
- **Por la red, se corta a menudo**: otro cliente (la app de Meshtastic, Home Assistant…) se está conectando al mismo
  nodo y echa al servidor.

## Desinstalar

```
wget -qO- https://raw.githubusercontent.com/Dani-NRos/vigia-mesh/main/codigo/servidor/instalar.sh | sudo bash -s -- --desinstalar
```

Los datos se quedan en `/var/lib/vigia`; con `--desinstalar --borrar-datos` se borran también.

## La pantalla

Al terminar, el instalador dice en qué direcciones abrirla, como `http://192.168.1.50:4404`. Es la misma app de
Vigía, pero los datos y el receptor son los del servidor: todos tus aparatos ven lo mismo, y si das «Enterado» en uno,
queda visto en todos. El sonido y la pantalla encendida son de cada aparato.

- **Sin contraseña**: la protege la red de casa. Cualquiera conectado a tu WiFi puede abrirla, ver las posiciones de
  los nodos y mandar mensajes por la malla con tu receptor.
- **Por http, el navegador no deja** instalarla como app ni mostrar notificaciones con la página cerrada. Eso llega
  con https (Tailscale). Mientras tanto, la página suena y avisa mientras está abierta.
- **No conectes también el móvil por Bluetooth** al nodo del servidor: el nodo repartiría lo que recibe entre los dos.

## Avisos por la malla

Los activas en Ajustes → *Avisos por la malla*, como en la app (vienen apagados). Una vez activados, los manda el
servidor 24/7, aunque no haya ninguna pantalla abierta: cada alarma (y, si quieres, cuando se resuelve) a un canal
privado, a un nodo o a ambos. Como mucho 20 por hora; los canales públicos están bloqueados.

## MQTT y Home Assistant

El servidor se conecta a un broker MQTT (el Mosquitto de Home Assistant, por ejemplo) y Home Assistant crea solo los
dispositivos de Vigía. Se configura en Ajustes → *MQTT y Home Assistant* (viene apagado); la configuración se guarda en
el servidor y la contraseña no vuelve a salir en ninguna pantalla.

**Con el complemento Mosquitto de Home Assistant:**

1. En Home Assistant, crea un usuario para Vigía: Ajustes → Personas → *Añadir persona* (por ejemplo `vigia`), con
   permiso para iniciar sesión, y ponle contraseña. Mosquitto deja entrar con los usuarios de Home Assistant (los
   nombres `homeassistant` y `addons` están reservados).
2. En la pantalla de Vigía servidor, Ajustes → *MQTT y Home Assistant*: la dirección de Home Assistant (como
   `192.168.1.20`; si no pones puerto, usa el 1883), ese usuario y su contraseña. Activa *Conectar a un broker MQTT* y
   pulsa *Guardar*. Debajo dice si ha conectado o qué falla.
3. En Home Assistant aparecen solos, en Ajustes → Dispositivos y servicios → MQTT:
   - **Vigía servidor**: receptor conectado, alarmas sin atender (sí/no y cuántas), alarmas activas, nodos oídos en la
     última hora, último aviso por la malla, el evento *Alarmas* y el botón *Enterado todas*.
   - **Vigía · Caseta huerto** (uno por cada nodo vigilado): sus lecturas (temperatura, humedad, batería…), cuándo se
     oyó por última vez, saltos y SNR; y por cada alarma que le tengas puesta, un sensor (encendido mientras salta,
     con el detalle en sus atributos) y su botón *Enterado*. La posición no se manda.

Las alarmas y los límites se siguen poniendo en Vigía: Home Assistant los ve y puede dar «Enterado», pero no los
cambia. Si dejas de vigilar un nodo, su dispositivo desaparece de Home Assistant. Si el servidor se apaga o se cae,
Home Assistant marca sus entidades como no disponibles. Vigía sigue sonando y avisando como siempre: Home Assistant es
una salida más.

**Avisar al móvil con la app de Home Assistant.** Cada alarma que salta, se resuelve o se da por vista llega como
evento (`event.vigia_servidor_alarmas`, con `event_type` *alarma*, *resuelta* o *vista*, y en sus atributos `texto`,
`detalle`, `nodo` e `id`). Una automatización (en YAML; cambia `mobile_app_mi_movil` por tu móvil, y comprueba el
nombre de la entidad *Alarmas* en el dispositivo *Vigía servidor*):

```yaml
alias: Vigía → móvil
triggers:
  - trigger: state
    entity_id: event.vigia_servidor_alarmas
    not_from: [unavailable, unknown]   # que no avise al reiniciar Home Assistant o el servidor
conditions:
  - condition: template
    value_template: "{{ trigger.to_state.attributes.event_type == 'alarma' }}"
actions:
  - action: notify.mobile_app_mi_movil
    data:
      title: Vigía
      message: "{{ trigger.to_state.attributes.texto }}. {{ trigger.to_state.attributes.detalle or '' }}"
```

**Temas** (por si los usas desde otro programa; el tema base se cambia en Ajustes → *Temas*):

```
vigia/estado                     online / offline (retenido; offline también si el servidor se cae)
vigia/servidor/estado            JSON: receptor, sin_atender, activas, oidos, aviso (retenido)
vigia/servidor/evento            JSON por cada alarma, resuelta o vista (no retenido)
vigia/servidor/enterado_todas    ← cualquier mensaje: «Enterado» a todas
vigia/nodo/<id>/estado           JSON: m (lecturas), oido, saltos, snr, a (alarmas ON/OFF), d (su detalle) (retenido)
vigia/nodo/<id>/enterado         ← el nombre de la alarma (como temperature_alta): «Enterado» a esa
homeassistant/…/vigia_…/config   autodescubrimiento de Home Assistant (retenido)
```

`<id>` es el número del nodo en hexadecimal, sin `!` (como `3c6e19a2`).

**Sin contraseña en la pantalla**: cualquiera en tu WiFi puede cambiar a qué broker se conecta el servidor o apagar
MQTT (no ver la contraseña guardada).

## De MQTT a la malla (una estación)

Los datos de una estación que lleguen por MQTT (una estación meteorológica en Home Assistant, un sensor de
zigbee2mqtt…) salen cada cierto tiempo a la malla como **telemetría de ambiente del receptor**, como si tuviera esos
sensores: la app de Meshtastic y Vigía los ven en sus gráficas. El servidor los guarda además como lecturas del
receptor, así que tienen gráficas, alarmas (vigilando el receptor) e histórico como cualquier nodo.

Se configura en Ajustes → *De MQTT a la malla* (viene apagado; hace falta MQTT conectado):

- **Cada** cuánto (por defecto, 30 minutos, a las en punto y a las y media), **por qué canal** y con **cuántos
  saltos** (por defecto, los del receptor).
- **Los datos**: qué es cada uno (temperatura, humedad, presión, viento, racha, lluvia…), el tema MQTT y, si llega
  un JSON, el campo (`humidity`, o `datos.humedad` si va dentro de otro). Si el viento llega en km/h o la temperatura
  en °F, se elige la unidad y Vigía la pasa a la de Meshtastic. Un valor imposible (la presión en Pa en vez de hPa)
  no se manda. Debajo de cada dato se ve el último valor que ha llegado.
- **Buscar temas** escucha el broker unos segundos y ofrece los temas con números para elegirlos al escribir.
- **Enviar ahora** manda lo que haya sin esperar (como mucho, uno por minuto).

Lo que hay que saber:

- **Un dato de cada tipo.** La telemetría de Meshtastic no lleva nombres: tiene un hueco por tipo de dato. Con un
  receptor se manda una temperatura, una humedad… (una estación), no varias temperaturas.
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
  include:
    entities:
      - sensor.estacion_temperatura
      - sensor.estacion_humedad
      - sensor.estacion_presion
      - sensor.estacion_viento
```

Cada uno sale en `ha_estados/sensor/estacion_temperatura/state` (retenido: Vigía lo tiene nada más conectar). No
incluyas los sensores «Vigía · …»: Vigía rechaza sus propios temas para no mandar a la malla lo que ya viene de ella.
