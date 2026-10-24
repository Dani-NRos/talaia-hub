# Talaia Hub: user guide

*[Español](guide.es.md)*

Talaia watches over a [Meshtastic](https://meshtastic.org) mesh and MQTT devices 24/7 on Linux: alarms (threshold,
fast change, anti-theft fence, no signal, ON/OFF states), a year of history in SQLite and a screen for the browser,
even when no phone or computer is looking.

- [What you need](#what-you-need)
- [Install](#install) · [With Docker](#with-docker) · [Keeping an eye on it](#keeping-an-eye-on-it) ·
  [Configuration](#configuration) · [If it doesn't connect](#if-it-doesnt-connect) · [Uninstall](#uninstall)
- [The screen](#the-screen) · [From outside your home (Tailscale)](#from-outside-your-home-tailscale)
- [Alerts over the mesh](#alerts-over-the-mesh) · [MQTT](#mqtt) · [Home Assistant](#home-assistant)
- [Panels and MQTT data](#panels-and-mqtt-data) · [To the mesh (the receiver's panel)](#to-the-mesh-the-receivers-panel)

## What you need

- **A computer with Linux**: a mini PC with Ubuntu or Debian, or a Raspberry Pi 4, 5 or Zero 2 W with **64-bit**
  Raspberry Pi OS (on 32 bits it works with Node 22, supported until April 2027). The original Zero W won't do.
- **A Meshtastic node just for the server**, plugged in by USB with a data cable, or reachable over the network (WiFi,
  Ethernet or a Raspberry with a LoRa board and `meshtasticd`).

**One node, one client.** The firmware shares what it receives among all the clients connected at the same time
(Bluetooth, cable and network): if the server and another program use the same node, each one gets only part of the
readings. Besides, over the network it takes a single client: a new one throws the previous one out. If Home Assistant
already uses a node through the Meshtastic integration, the server needs another one.

## Install

With `wget`, which comes with Ubuntu and Raspberry Pi OS (`curl` works too: `curl -fsSL` instead of `wget -qO-`):

```
wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash
```

By default it uses whichever node is plugged in by USB. For a node over the network:

```
wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash -s -- --tcp 192.168.1.60
```

The installer speaks the machine's language (Spanish if the system is in Spanish, Catalan, Basque or Galician;
otherwise English), or the one you give with `--lang en` or `--lang es`. Its options (each one has a Spanish name too):

| Option | What it does |
|---|---|
| `--tcp HOST[:PORT]` | the node over the network instead of by USB |
| `--port PATH\|ID` | the node by USB on that port (`/dev/serial/by-id/…` or `239a:8029`) |
| `--reconfigure` | rewrites `/etc/talaia/config.json` with the above (otherwise an existing configuration stays) |
| `--branch BRANCH` | installs from another branch of the repository (`main` by default) |
| `--no-mosquitto` | doesn't install or set up Mosquitto |
| `--uninstall`, `--delete-data` | see [Uninstall](#uninstall) |

The installer:

- puts its own Node in `/opt/talaia/node`, leaving the system's alone;
- leaves the program in `/opt/talaia/actual` and keeps the two previous versions;
- makes an unprivileged `talaia` user, allowed to use the serial port (`dialout` group);
- writes the configuration in `/etc/talaia/config.json` and keeps the data in `/var/lib/talaia`;
- installs **Mosquitto** (the home MQTT broker) on port 1883, **with users and passwords**; the users are made on the
  screen (see [MQTT](#mqtt)). If Mosquitto already had its own configuration, it's left alone;
- leaves the `talaia` service running, and starting by itself at boot;
- if the screen has no users yet, ends by giving the **code to create the first one** (see [The screen](#the-screen)).

To **update**, run the same command again: it keeps your configuration and your data.

## With Docker

For those who already use Docker, on a mini PC or a 64-bit Raspberry Pi (for 32 bits, the installer). The image,
`ghcr.io/dani-nros/talaia-hub` (amd64 and arm64), carries the server and the screen; `compose.yaml` adds its own
Mosquitto (the official image, `eclipse-mosquitto`), whose users Talaia manages just as with the installer.

```
mkdir talaia && cd talaia
wget https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/docker/compose.yaml
docker compose up -d
docker compose exec talaia talaia --code
```

Before the `up`, in `compose.yaml`:

- **The node by USB**: in `devices`, the device with the same name on both sides (`ls /dev/ttyACM* /dev/ttyUSB*`
  tells which). **Over the network**: remove `devices` and set `TALAIA_RECEIVER: tcp:192.168.1.60`.
- `TZ`: your time zone (that of the times in the journal and the CSV).
- If there's a broker on port 1883 of that machine already, change Talaia's (`"1884:1883"`). Without a broker:
  `TALAIA_BROKER: off` and remove the `mosquitto` service.

The configuration goes in variables, which win over `/data/config.json` (not needed):

| Variable | What it is | Default |
|---|---|---|
| `TALAIA_RECEIVER` | `usb`, `usb:/dev/ttyACM0`, `usb:239a:8029`, `tcp:192.168.1.60` or `tcp:192.168.1.60:4403` | `usb` |
| `TALAIA_BROKER` | this machine's broker: `mosquitto` (the compose's) or `off` | no broker |
| `TALAIA_WEB_PORT` | the screen's port inside the container | `4404` |
| `TALAIA_RETENTION_DAYS` | days of history | `365` |
| `TALAIA_LOG_LEVEL` | `debug`, `info`, `warn` or `error` | `info` |

What's different from the installer:

- The terminal commands go with `docker compose exec talaia talaia …` and the journal is `docker compose logs -f talaia`.
- With no `LANG` in the container, a new installation starts in English: the language is changed in
  *Settings → System*.
- To **update**: `docker compose pull && docker compose up -d`. The data is in the `talaia-data` volume and the
  broker's users in `broker-data`.
- **USB is more delicate**: the container gets the port `devices` names when it starts. If the node is unplugged and
  comes back under another name (`ttyACM1`), change it there and run `up` again. With the installer, that doesn't
  happen.
- Inside the container, Talaia doesn't know the machine's IP: *Settings → MQTT* says “this machine's IP”.
- Talaia runs as an unprivileged user (uid 4404); the container starts as root only to prepare its folders,
  Mosquitto's files and the USB port's permission.
- On starting, the journal says once that the broker doesn't answer: Mosquitto starts right after Talaia. A few
  seconds later it says “connected”.

## Keeping an eye on it

```
journalctl -u talaia -f          what's going on
talaia --ports                   which nodes are plugged in by USB
systemctl status talaia          whether it's running
sudo talaia --users              the screen's users
sudo talaia --password NAME      a new password for that user (made if it isn't there)
sudo talaia --code               the code to create the first user
```

The journal shows the connection with the receiver, the alarms, the resolved ones, the failures (with what to do) and
a summary every hour, in the server's language (*Settings → System*). The `talaia` command answers in the terminal's.

## Configuration

`/etc/talaia/config.json`; after changing it, `sudo systemctl restart talaia`. The keys work in English or Spanish
(`receiver` or `receptor`, `data` or `datos`…).

```json
{
  "receiver": { "type": "usb", "port": "auto" },
  "web": { "port": 4404 },
  "data": "/var/lib/talaia",
  "retentionDays": 365,
  "logLevel": "info",
  "broker": { "port": 1883 }
}
```

- `receiver.port` by USB: `"auto"` (whichever node is plugged in), a USB id like `"239a:8029"` (still good if the port
  changes name) or a fixed path, better from `/dev/serial/by-id/` (the name `talaia --ports` gives).
- Over the network: `{ "type": "tcp", "host": "192.168.1.60", "port": 4403 }`.
- `retentionDays`: how much history is kept (a year by default). It keeps the telemetry of **all** the nodes the
  receiver hears, and each reading takes about 80 bytes: 50 nodes with 4 sensors every half hour are about 22 MB a
  month (about 270 MB a year). If your receiver hears hundreds of nodes (for example, arriving over MQTT), it can be
  several GB a year: on a Raspberry with an SD card, lower the days. Every 6 hours the journal says how many readings
  there are and how much they take.
- `logLevel`: `"debug"` also tells every connection retry.
- `broker`: this machine's broker, whose users Talaia manages; the installer puts it there.

## If it doesn't connect

The journal says what's going on and what to do. The most usual:

- **No node is plugged in**: a cable that only charges, or the node switched off. Once plugged in, it connects by
  itself in less than a minute.
- **The port is busy**: another program has it open (Meshtastic's web client, a serial monitor…). On desktop Ubuntu,
  `brltty` takes the nodes with a CH340 chip: if you don't use a braille display, `sudo apt remove brltty`.
- **Over the network, it drops often**: another client (the Meshtastic app, Home Assistant…) is connecting to the same
  node and throws the server out.

*Settings → Receiver* has the **connection diagnostics**, which can be copied to report a problem.

## Uninstall

```
wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash -s -- --uninstall
```

The data stays in `/var/lib/talaia`; with `--uninstall --delete-data` it's deleted too (and the broker's users).
Mosquitto stays installed, without Talaia's configuration (if you don't use it for anything else:
`sudo apt remove mosquitto`).

## The screen

When it finishes, the installer says where to open it, like `http://192.168.1.50:4404`. The data and the receiver are
the server's: all your devices see the same, and an *Acknowledge* on one is seen on all of them.

- **Sections**: *Dashboard* (the alarm notice and the panels of what you watch), *Map*, *Nodes* (the whole mesh, with
  its search: a node is watched from there), *Automations* (coming in 2.1), *Alarms* (the active ones and the log) and
  *Settings*. On a computer they're in a bar on the left; on a phone, at the bottom, with *Settings* in the gear at the
  top.
- **Settings**, in parts: *Mesh* (no signal for new nodes, alerts over the mesh), *MQTT* (brokers, users of this
  machine's broker, Home Assistant), *Receiver* (status, node, radio, channels, diagnostics), *System* (the server's
  language, history, about), *Users* and *This screen* (language, light or dark theme, sound, notifications, keeping
  the screen on and the map without internet: what belongs to each device).
- **Two languages**: each screen picks its own (by default, the browser's). The server's, separately, is the language
  of what it writes: the log, the alerts over the mesh, Home Assistant, the journal and the CSV.
- **With a user name and password**, at home too: without signing in nothing is seen (no nodes, no positions, no
  history) and nothing can be sent. The first time, the screen asks to create the first user with a **code** the
  installer gives when it finishes (it's also in the journal and with `sudo talaia --code`); that way nobody on your
  network gets there first. After that, each device signs in once and is remembered **for 30 days since it was last
  used** (a screen that's never switched off never signs out).
- **Users** (*Settings → Users*): everyone can do everything, including adding and removing users or giving them a new
  password. There you see on which devices each session is open, and you can end them. Nobody can remove themselves,
  so there's always someone left. The log says who did what (*Watching Garage · Ana*). If you forget your password and
  there's nobody else: `sudo talaia --password YOUR_NAME` on the machine.
- **Passwords** are hashed (scrypt) and never leave the server; at least 10 characters, no other rules (a phrase will
  do). After five failed attempts with a name, each further attempt waits twice as long (up to 15 min).
- **Over http, the browser won't let** it be installed as an app or show notifications with the page closed. That
  comes with https (Tailscale). Meanwhile, the page sounds and warns while it's open.
- **Don't connect your phone by Bluetooth too** to the server's node: the node would share what it receives between
  the two.

## From outside your home (Tailscale)

With [Tailscale](https://tailscale.com), the screen opens from your phone or laptop away from home, without opening
ports on the router: only the devices of your Tailscale network reach the server.

1. **The server on Tailscale**: installed and joined to your account (`tailscale status` says so, with its name and
   its `100.…` IP). Then `http://100.x.y.z:4404` (or `http://machine-name:4404`) opens from any device of your
   Tailscale network.
2. **With https (recommended)**: in Tailscale's console, *DNS*, keep *MagicDNS* on and press *Enable HTTPS* (under
   *HTTPS Certificates*). On the server:
   ```
   sudo tailscale serve --bg 4404
   ```
   It says the address, like `https://bmax.tail1234.ts.net`. It stays even if the machine restarts
   (`tailscale serve status` to see it; `sudo tailscale serve --https=443 off` to remove it). The first time it takes a
   few seconds: it's getting the certificate.
3. **On the phone**: the Tailscale app with the same account, connected, and open that address in Chrome. With https
   it can be **installed as an app** (Chrome's menu → *Install app*) and allowed to warn with notifications while it's
   open.

Worth knowing:

- **No Tailscale Funnel**: Funnel publishes on the internet. If anything arrives through Funnel, Talaia refuses it and
  notes it in the journal. Use `tailscale serve`, which is only for your Tailscale network.
- From your Tailscale network the screen can be reached, but you have to sign in with a user, as at home. With https,
  the session only travels encrypted.
- The https certificate appears in the public certificate logs: the name of the machine and of your Tailscale network
  can be seen (they can't be used to get in).
- Notifications with the app closed (push) will come later.

## Alerts over the mesh

They're switched on in *Settings → Mesh → Alerts over the mesh* (off by default). Once on, the server sends them 24/7,
even with no screen open: each alarm (and, if you want, when it's resolved) to a private channel, to a node or to
both. At most 20 an hour; public channels are blocked.

## MQTT

Talaia connects to several MQTT brokers at once, set in *Settings → MQTT*:

- **This server**: this machine's Mosquitto, the one the installer puts there. The home devices (Shelly, Tasmota,
  zigbee2mqtt, ESPHome…) can publish there. It only lets in with a user name and password: in *Users of this broker*
  they're made (for example, one for the Shellys), their password changed (saving the same user again) and removed. On
  the device: server, this machine's IP; port, 1883; and that user. The passwords are kept hashed and never show on any
  screen again.
- **Other brokers** with *Add broker*, like Home Assistant's Mosquitto: name, address, user and password. Under each
  one it says whether it's connected or what's failing.

Inside, Talaia asks Mosquitto's dynamic security plugin for them (over MQTT, with its own user, `talaia`): a new user
or a changed password works at once, without reloading Mosquitto or cutting off whoever is connected. Mosquitto keeps
them, with the password hashed, in `/var/lib/mosquitto/talaia-dynamic-security.json`. The devices' users can publish
and subscribe on any topic except those starting with `$` (so they can't make users). If you use a firewall (`ufw`),
open 1883 for the home network.

Home Assistant connects to a single broker. If you want in Home Assistant something published on Talaia's, the usual
way is a “bridge” between the two Mosquittos (a few lines of configuration in one of them).

## Home Assistant

Home Assistant makes Talaia's devices by itself. In *Settings → MQTT → Home Assistant*: switch on *Publish the watched
nodes*, pick Home Assistant's broker and press *Save* (off by default).

**With Home Assistant's Mosquitto add-on:**

1. In Home Assistant, make a user for Talaia: Settings → People → *Add person* (for example `talaia`), allowed to log
   in, and give it a password. Mosquitto lets in Home Assistant's users (the names `homeassistant` and `addons` are
   reserved).
2. On Talaia's screen, *Settings → MQTT → Add broker*: a name (Home Assistant), Home Assistant's address (like
   `192.168.1.20`; with no port, 1883), that user and its password. Then, in *Home Assistant*, switch it on and pick
   that broker.
3. They show up by themselves in Home Assistant, in Settings → Devices & services → MQTT:
   - **Talaia** (the server): receiver connected, unattended alarms (yes/no and how many), active alarms, nodes heard
     in the last hour, last alert over the mesh, the *Alarms* event and the *Acknowledge all* button.
   - **Talaia · Garden shed** (one per watched node): its readings (temperature, humidity, battery…), when it was last
     heard, hops and SNR; and for each alarm you've set on it, a sensor (on while it's going off, with the detail in its
     attributes) and its *Acknowledge* button. The position isn't sent.

The names come in the server's language (*Settings → System*); when it's changed they're announced to Home Assistant
again, without changing their ids or topics.

Alarms and limits are still set in Talaia: Home Assistant sees them and can *Acknowledge*, but doesn't change them.
Only what belongs to the Meshtastic nodes goes there: the panels' MQTT data and their alarms don't (they don't count
in the active alarms, nor does *Acknowledge all* take them as seen). If you rename a node in Talaia, its device changes
name. If you stop watching a node, its device disappears from Home Assistant. If the server goes off or crashes, Home
Assistant marks its entities as unavailable. Talaia keeps sounding and warning as always: Home Assistant is one more
output.

**Warning your phone with the Home Assistant app.** Each alarm that goes off, is resolved or is acknowledged arrives as
an event, with `event_type` *alarma* (alarm), *resuelta* (resolved) or *vista* (acknowledged), and in its attributes
`texto` (text), `detalle` (detail), `nodo` (node) and `id`. These names are the same in both languages. The entity is
*Alarms* in the *Talaia* device: `event.talaia_alarms` (`event.talaia_alarmas` if the server was in Spanish when it was
made). An automation (in YAML; change `mobile_app_my_phone` to your phone and the entity to yours):

```yaml
alias: Talaia → phone
triggers:
  - trigger: state
    entity_id: event.talaia_alarms
    not_from: [unavailable, unknown]   # so it doesn't warn when Home Assistant or the server restart
conditions:
  - condition: template
    value_template: "{{ trigger.to_state.attributes.event_type == 'alarma' }}"
actions:
  - action: notify.mobile_app_my_phone
    data:
      title: Talaia
      message: "{{ trigger.to_state.attributes.texto }}. {{ trigger.to_state.attributes.detalle or '' }}"
```

**Topics** (in case you use them from another program; the base topic is changed in
*Settings → MQTT → Home Assistant → Topics*):

```
talaia/estado                    online / offline (retained; offline also if the server crashes)
talaia/servidor/estado           JSON: receptor, sin_atender, activas, oidos, aviso (retained)
talaia/servidor/evento           JSON for each alarm, resolved or acknowledged (not retained)
talaia/servidor/enterado_todas   ← any message: acknowledges all
talaia/nodo/<id>/estado          JSON: m (readings), oido, saltos, snr, a (alarms ON/OFF), d (their detail) (retained)
talaia/nodo/<id>/enterado        ← the alarm's name (like temperature_alta): acknowledges that one
homeassistant/…/talaia_…/config  Home Assistant's discovery (retained)
```

`<id>` is the node's number in hexadecimal, without `!` (like `3c6e19a2`). The topics and the JSON fields are in Spanish
in both languages. The ids in Home Assistant start with the base topic (`talaia_…`): if you change it, Home Assistant
sees new devices and the old ones are removed.

Any user of the screen can change which broker the server connects to or switch MQTT off, but can't see the saved
password.

## Panels and MQTT data

The dashboard isn't only for Meshtastic nodes: any device publishing over MQTT (Shelly, Tasmota, Sonoff, Zigbee with
zigbee2mqtt, ESPHome, Home Assistant…) can have its panel, with its readings, charts, alarms (alerts over the mesh too)
and history, like a node.

- **New panel**: *Add panel*, on the dashboard. A name and what it is (only for the label).
- **Data over MQTT**: in each panel's sheet (also a node's, to have another value next to it, like the temperature
  inside the shed). Each datum has its name (there can be several temperatures), what it is, which broker it comes
  from, the topic and, if a JSON arrives, the field (`temperature`, or `ENERGY.Power` if it's inside another one). If
  the wind arrives in km/h or the temperature in °F, pick the unit and Talaia converts it to its own. Under each datum
  you see the last value that arrived. *Other number* is for what isn't on the list (with the unit you set).
- **Find topics** listens to the brokers for a few seconds and shows the topics with numbers (they can be filtered).
  **Use** puts one on the list: it guesses what it is from the name (temperature, humidity, Power…) and, if Home
  Assistant publishes the unit, picks it; otherwise the wind stays in km/h, the usual in Home Assistant. Check it.
- **Readings**: the value is shown and the alarm goes off at once; the history keeps one a minute at most.
- **ON/OFF states** (*ON/OFF state* as the type): a plug, a relay, a door, a water detector… Talaia understands
  `ON`/`OFF`, `on`/`off`, `true`/`false`, `1`/`0`, `open`/`closed`, `online`/`offline` and a JSON with any of them
  (Tasmota's `{"POWER":"ON"}`, Shelly's `{"output":true}`, zigbee2mqtt's `{"contact":false}`). You pick their names
  (*On / Off*, *Open / Closed*, *Water / Dry*…) and, if the device says it the other way round, *Reversed*:
  zigbee2mqtt's `contact` is `true` with the door **closed** (when used from *Find topics* it's ticked already). Each
  change goes into the history at once (if it doesn't change, one an hour) and its chart is a time bar showing when it
  was on.
- **Second and third generation Shellys** (Plus, Pro, Gen3): on the Shelly, *Settings → MQTT*, switch on *Generic
  status update over MQTT*; the whole status comes on `<prefix>/status/switch:0` (fields `output`, `apower`,
  `voltage`, `aenergy.total` in Wh, `temperature.tC`), and the connection on `<prefix>/online`. Without that option,
  there's only `<prefix>/events/rpc`, with the field `params.switch:0.output`: it arrives only when something changes
  (*Find topics* sees it if you press the plug while it's searching) and sometimes without that field (only the
  power): those messages don't count for the datum.
- **A state's alarm**, in the sheet: *Warn when: Open* (or *Closed*), at once or only if it stays so for more than a
  few minutes (a door open for more than 10 min, a pump on for more than 1 h). It's resolved when it changes.
- **Switching on and off from Talaia**: on a state, *Switch on and off from Talaia* and the topic the commands go to,
  with the message for each state. Talaia proposes it from the state topic (Shelly Plus/Pro/Gen3: `…/command/switch:0`
  with `on` and `off`, with *Enable MQTT Control* on in the Shelly; Tasmota: `cmnd/…/POWER` with `ON` and `OFF`;
  zigbee2mqtt: `zigbee2mqtt/…/set` with `{"state":"ON"}`; ESPHome: `…/switch/…/command`); it can be changed. A switch
  shows on the card, the sheet and the full screen: press it and it's sent, **without confirmation** (any user of the
  screen can use it). It says *Sending…* until the device tells through its state topic that it's done; if it doesn't
  within 10 s, *No answer*. Each command stays in the log. Home Assistant takes no commands through
  `mqtt_statestream`.
- **Shellys don't keep their state on the broker**: when connecting to it (and when saving the data), Talaia asks them
  to say it (`status_update` on `…/command/switch:0`; on the first generation ones, `update`). It's only a request for
  information, it changes nothing. It can't be asked through `…/events/rpc`: better `…/status/switch:0`.
- **The device's connection** (panels without a node, optional): the topic where it says whether it's connected.
  Tasmota: `tele/…/LWT` (`Online`/`Offline`); Shelly: `…/online` (`true`/`false`); zigbee2mqtt:
  `zigbee2mqtt/…/availability` (field `state`). With it, the panel says *Disconnected* at once and, with *Warn if it
  disconnects*, its alarm goes off (and its alert over the mesh, if they're on). *Find topics* recognises it and offers
  *Use as connection*.
- **Name**: every panel can be renamed. A node's is only for Talaia (dashboard, alarms, alerts over the mesh and Home
  Assistant): its Meshtastic name stays as information and, with the name empty, it goes back to it.
- **No data**: on a panel without a node, the “no data arrives for more than…” alarm is off by default, because some
  devices only publish when something changes.
- **Full screen**: the button on each card's header shows that panel on the whole screen and keeps it on (for a tablet
  on the wall).
- **Remove panel** (at the end of its sheet) deletes it with its history. Removing a datum deletes its history too.

Location and the map are still only for Meshtastic nodes. The MQTT data and its alarms don't go to Home Assistant: if
you want them there, Home Assistant can read them from the broker where they're published. (The *last alert over the
mesh* sensor does show the text of the last message that went out over the mesh, whatever it was about.)

## To the mesh (the receiver's panel)

The MQTT data of the receiver's panel can go out over the mesh every so often as **its environment telemetry**, as if
it had those sensors: the Meshtastic app and Talaia show them in their charts. It's what a neighbourhood weather
station at the same place as the node is for.

- On each datum of the receiver, the **To the mesh** box, and under *Data over MQTT*, **Send to the mesh**: **how
  often** (by default, 30 minutes, on the hour and at half past), **on which channel** and with **how many hops** (by
  default, the receiver's). Off by default.
- **Send now** sends what there is without waiting (one a minute at most).

Worth knowing:

- **One datum of each type.** Meshtastic's telemetry carries no names: it has one slot per type of data. There can be
  several temperatures on the receiver's panel, but only one goes out over the mesh. Power, energy or CO₂ have no slot
  in the environment telemetry: they're shown on the panel, but don't go out.
- **They go out as measured by the receiver, at its position.** For a neighbourhood station, fine; for data from
  somewhere else, whoever sees them on the map will place them where the receiver is.
- **If the receiver has environment sensors of its own**, their values would mix with the station's.
- **“Unavailable” isn't sent.** If Home Assistant says `unavailable` or `unknown`, that datum doesn't go out. As Home
  Assistant only publishes when the value changes (rain can stay at 0 for days), by default the last one that arrived
  is sent; on each datum you can choose to stop sending it if nothing new has arrived for 1, 3, 12 or 24 h.
- **Public or private channel.** On a public channel anyone sees it and it can end up on internet maps; for a
  neighbourhood station that can make sense, for home data, better a private one. The firmware sends its own telemetry
  on the primary channel; on another channel, those who have it see it.
- **Rain 24 h** means “the last 24 hours”: if your station gives “today's rain”, it will go out under that name.
- The journal shows each failure (once, not every half hour) and when it goes out fine again.

**From Home Assistant**, its sensors don't go out over MQTT on their own. With `mqtt_statestream` in
`configuration.yaml` (and restarting Home Assistant):

```yaml
mqtt_statestream:
  base_topic: ha_states
  publish_attributes: true
  include:
    entities:
      - sensor.station_temperature
      - sensor.station_humidity
      - sensor.station_pressure
      - sensor.station_wind
```

With `publish_attributes: true` each one's unit goes out too and Talaia picks it by itself. Each one goes out on
`ha_states/sensor/station_temperature/state` (retained: Talaia has it as soon as it connects). Don't include the
“Talaia · …” sensors: Talaia refuses its own topics so as not to receive again what it publishes.
