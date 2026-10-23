# Changes

## 2.0.0

The first version as **Talaia Hub** (up to 1.20, *Vigía servidor*). Only the server: the light app (Bluetooth or USB
cable, no server) stays frozen at 1.20 at https://dani-nros.github.io/vigia-mesh/.

**New**

- **A new screen**: icon bar on the left on a computer and at the bottom on a phone, with *Dashboard*, *Map*, *Nodes*,
  *Automations* (coming in 2.1), *Alarms* and *Settings* in parts (*Mesh*, *MQTT*, *Receiver*, *System*, *Users*,
  *This screen*). A field-instrument look, sand and forest green by day and a dark “night watch”, with a signal orange
  only for alarms. Readings always fit in their boxes, and each card can go full screen.
- **English and Spanish**: each screen picks its own language; the server has one too (*Settings → System*) for the
  log, the alerts over the mesh, Home Assistant, the journal and the CSV. The installer and the `talaia` command speak
  the machine's language, and every option has an English name (`--port`, `--uninstall`, `--users`, `--password`…).
  `config.json` takes English keys too (`receiver`, `data`, `broker`…).
- **Users and passwords**, always, at home too. The first user is created on the screen with a code the installer
  shows; sessions last 30 days since last used; the log says who did what. `sudo talaia --password NAME` from the
  terminal.
- **Docker**: the `ghcr.io/dani-nros/talaia-hub` image (amd64 and arm64) and a `compose.yaml` with its own Mosquitto,
  configured with `TALAIA_*` variables.
- **This machine's broker** manages its users through Mosquitto's dynamic security plugin: a new user or password
  works at once, without reloading Mosquitto, and devices can't make themselves users.
- **Documentation in English and Spanish**: [user guide](docs/guide.md), [manual de uso](docs/guide.es.md).

**Changed**

- The names inside are Talaia's: the `talaia` service and command, `/opt/talaia`, `/etc/talaia/config.json`,
  `/var/lib/talaia` (`talaia.db`), the `talaia` user. Home Assistant's ids and topics keep saying `vigia`, so its
  devices and history stay.
- A new installation starts in the machine's language; one coming from Vigía keeps Spanish.
- The terminal commands: `talaia --ports`, `--users`, `--password NAME`, `--code` (the Spanish names still work).

**Updating from Vigía servidor 1.x**: run the installer (`wget -qO- …/instalar.sh | sudo bash`). It moves the
installation to Talaia's names with its data and configuration, takes the broker's users to the plugin with the same
passwords and, on the screen, asks to create the first user with the code it shows. Nothing changes in Home Assistant.
