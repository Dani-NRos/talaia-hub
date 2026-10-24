# Talaia Hub

*[English](README.md)*

Vigilancia 24/7 de una malla [Meshtastic](https://meshtastic.org) y de dispositivos MQTT (Shelly, Tasmota, ESPHome,
zigbee2mqtt…) desde un ordenador pequeño con Linux en casa: un mini PC, una Raspberry Pi 4/5 o una Pi Zero 2 W. Todo se
queda en tu equipo y funciona sin internet.

- **Tablero** con un panel por cada nodo o dispositivo que vigilas: lecturas, gráficas, batería, estados ON/OFF e
  interruptores.
- **Alarmas**: límites, cambios rápidos, valla antirrobo, sin señal, una puerta abierta demasiado rato… Suenan y avisan
  en cada pantalla abierta, y el servidor puede mandarlas él mismo por la malla, a un canal privado o a un nodo.
- **Un año de histórico** en SQLite, con gráficas y exportación a CSV.
- **Toda la malla**: mapa, lista con buscador, rutas y peticiones a los nodos (telemetría, posición, ficha,
  traceroute).
- **MQTT**: su propio broker Mosquitto con los usuarios gestionados desde la pantalla, otros brokers a la vez y los
  datos de cualquier dispositivo como paneles. Los valores de una estación meteorológica pueden salir a la malla como
  telemetría del receptor.
- **Home Assistant** por MQTT con autodescubrimiento: los nodos vigilados, sus alarmas y un botón *Enterado*.
- **Usuarios y contraseñas**, la pantalla en español e inglés, tema claro y oscuro, instalable como app y acceso desde
  fuera de casa con Tailscale.

## Instalar

En Ubuntu, Debian o Raspberry Pi OS, con el nodo enchufado por USB:

```
wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash
```

Con un nodo por la red, añade `-s -- --tcp 192.168.1.60` detrás de `bash`. Al terminar dice dónde abrir la pantalla
(`http://<IP>:4404`) y el código para crear el primer usuario.

**Con Docker** (amd64 y arm64), Talaia y su propio Mosquitto:

```
wget https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/docker/compose.yaml
docker compose up -d
docker compose exec talaia talaia --codigo
```

## Documentación

- **[Manual de uso](docs/guide.es.md)**: instalar, Docker, configuración, la pantalla, Tailscale, MQTT, Home
  Assistant, paneles y datos a la malla.
- **[Cambios](CHANGELOG.md)** de cada versión (en inglés).

Problemas y sugerencias: [issues](https://github.com/Dani-NRos/talaia-hub/issues). El *diagnóstico de conexión* de la
pantalla (*Ajustes → Receptor*) se puede copiar en uno.

Licencia: [GPL-3.0](LICENSE).
