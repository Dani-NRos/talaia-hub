# Talaia Hub

24/7 monitoring of [Meshtastic](https://meshtastic.org) mesh networks and MQTT devices (Shelly, Tasmota, ESPHome,
zigbee2mqtt…) on a small Linux computer at home: a mini PC, a Raspberry Pi 4/5 or a Pi Zero 2 W. Dashboards, alarms,
a year of history in SQLite, switches you can control, Home Assistant over MQTT and access from outside your home with
Tailscale. Everything stays on your own machine.

**Under development towards version 2.0.** Up to version 1.20 it was called *Vigía servidor*. The interface is in
English and Spanish and has user accounts; Docker and the English documentation are on the way (today the
documentation is only in Spanish).

- **Install the development version** (Ubuntu, Debian, Raspberry Pi OS):
  `wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash`
- **How to set it up and use it**: [`codigo/servidor`](codigo/servidor/README.md) (in Spanish).
- **Stable version (1.20)**: Vigía servidor, installed from [vigia-mesh](https://github.com/Dani-NRos/vigia-mesh).
- **The light app** (Bluetooth or USB cable, nothing to install), frozen at 1.20:
  https://dani-nros.github.io/vigia-mesh/

License: [GPL-3.0](LICENSE).

## En español

Talaia Hub vigila 24/7 una malla [Meshtastic](https://meshtastic.org) y dispositivos MQTT (Shelly, Tasmota, ESPHome,
zigbee2mqtt…) desde un ordenador pequeño con Linux en casa: un mini PC, una Raspberry Pi 4/5 o una Pi Zero 2 W.
Paneles, alarmas, un año de histórico en SQLite, interruptores que se manejan desde la pantalla, Home Assistant por
MQTT y acceso desde fuera de casa con Tailscale. Todo se queda en tu equipo.

**En desarrollo hacia la versión 2.0.** Hasta la 1.20 se llamaba *Vigía servidor*. La pantalla ya está en español e
inglés y tiene usuarios con contraseña; llegarán Docker y la documentación en inglés.

- **Instalar la versión en desarrollo** (Ubuntu, Debian, Raspberry Pi OS): el mismo comando de arriba. Si ya tienes
  Vigía servidor, se instala encima, pasa a los nombres de Talaia (servicio `talaia`, `/var/lib/talaia`…) y conserva
  los datos y la configuración.
- **Cómo configurarlo y usarlo**: [`codigo/servidor`](codigo/servidor/README.md).
- **Versión estable (1.20)**: Vigía servidor, que se instala desde [vigia-mesh](https://github.com/Dani-NRos/vigia-mesh).
- **La app ligera** (Bluetooth o cable USB, sin instalar nada), congelada en la 1.20:
  https://dani-nros.github.io/vigia-mesh/
