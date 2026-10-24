# Talaia Hub

*[Español](README.es.md)*

24/7 watch over a [Meshtastic](https://meshtastic.org) mesh and MQTT devices (Shelly, Tasmota, ESPHome, zigbee2mqtt…)
from a small Linux computer at home: a mini PC, a Raspberry Pi 4/5 or a Pi Zero 2 W. Everything stays on your own
machine; it works without internet.

- **Dashboard** with a panel for each node or device you watch: readings, charts, battery, ON/OFF states and switches.
- **Alarms**: thresholds, fast changes, an anti-theft fence, no signal, a door open for too long… They sound and notify
  on every screen that's open, and the server can send them over the mesh itself, to a private channel or a node.
- **A year of history** in SQLite, with charts and CSV export.
- **The whole mesh**: map, list with search, routes, requests to nodes (telemetry, position, node info, traceroute).
- **MQTT**: its own Mosquitto broker with users managed from the screen, other brokers at the same time, and data from
  any device as panels. A weather station's values can go out over the mesh as the receiver's telemetry.
- **Home Assistant** over MQTT with discovery: the watched nodes, their alarms and an *Acknowledge* button.
- **Users and passwords**, a screen in English and Spanish, light and dark themes, installable as an app, and access
  from outside your home with Tailscale.

## Install

On Ubuntu, Debian or Raspberry Pi OS, with the node plugged in by USB:

```
wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash
```

With a node over the network, add `-s -- --tcp 192.168.1.60` after `bash`. When it finishes, it says where to open the
screen (`http://<IP>:4404`) and the code to create the first user.

**With Docker** (amd64 and arm64), Talaia and its own Mosquitto:

```
wget https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/docker/compose.yaml
docker compose up -d
docker compose exec talaia talaia --code
```

## Documentation

- **[User guide](docs/guide.md)**: installing, Docker, configuration, the screen, Tailscale, MQTT, Home Assistant,
  panels and data to the mesh.
- **[Changes](CHANGELOG.md)** in each version.

Problems and suggestions: [issues](https://github.com/Dani-NRos/talaia-hub/issues). The screen's
*Settings → Receiver → Connection diagnostics* can be copied into one.

License: [GPL-3.0](LICENSE).
