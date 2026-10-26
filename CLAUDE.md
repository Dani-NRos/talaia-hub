# Talaia Hub

Talaia Hub watches a Meshtastic mesh and MQTT devices 24/7 on a small Linux computer (a mini PC, a Raspberry Pi 4/5, a
Pi Zero 2 W): alarms, automations, orders over the mesh, a year of history in SQLite, Home Assistant over MQTT, and a
screen served to browsers (installable as an app) with users and passwords. Also as a Docker image. In the app it is
called just «Talaia». How to use it: `docs/guide.md` (English) and `docs/guide.es.md` (Spanish).

**The maintainer's notes** (decisions and their reasons, plans, history) are in the private repository
`Dani-NRos/talaia-notas`. If it isn't in the session, add it before changing anything: its `CLAUDE.md` applies too,
and where they differ, it wins. This repository is public: nothing personal goes in it, nor in commit messages
(names of people or places, the maintainer's equipment, mesh settings, real node names, ids or positions). Tests and
tools use invented ones.

## Working rules

- **Nothing over a real mesh without asking**: no messages, test alerts, traceroutes or requests to nodes; don't
  change anyone's alarms or watched nodes. Bluetooth and serial port pickers are for the person to use.
- **One thing at a time**: finish, test and check each step before the next. Each step on its own branch until the
  maintainer has tried it; then to `main`.
- **Tests** with `node --test` (`npm test` in `codigo/`); with real equipment, the maintainer tests it.
- **Language**: code, comments and commit messages in English. The screen and what the server writes, in Spanish
  (Spain) and English, in plain words, without jargon.
- **No yes-man answers**: if something doesn't make sense or there's a better option, say so; ask when deciding.

## Layout

```
codigo/                 npm workspaces: npm install, npm test, npm run build
  nucleo/               logic without a screen, shared by the app and the server (@talaia/nucleo)
    src/motor.js        nodes, readings, alarms, requests to nodes, traceroute, alerts over the mesh (meshNotify,
                        meshSay: one queue, 8 s apart, 20 an hour), what arrives from the receiver
    src/acciones.js     what the user changes (watch, limits, fence, settings…), the same on app and server
    src/receptor-base.js  connection cycle, first read, retries, requests with an id
    src/idioma.js       the core's texts: tx("key"). Each screen sets its own language; the server, its own
                        (Settings → System). Number and time formats. The server adds its texts with addTexts
    src/textos.js canales.js tramas.js mqtt-datos.js metrics.js trend.js delivery.js route.js geo.js pb.js
                        times and common texts; which channel is private; serial frames (0x94 0xC3), own framing,
                        heartbeat; MQTT data (types, units, reading a JSON, checking the configuration); metrics…
  app/                  the PWA (@talaia/app): it only shows; state comes from the server (SSE), presses go to it as
                        orders (POST). localStorage only for what belongs to each device
    src/app.js shell.js i18n.js ctx.js ui.js alerts.js charts.js logo.js map.js mapdata.js meshsearch.js remoto.js
    src/views/          one section per file: dashboard, node-parts, nodes, alarms, sheet, panel-config, fullscreen,
                        settings, signin, users, automations, mesh-orders
    src/css/            the order is in build.mjs
    index.src.html build.mjs pwa/
  servidor/             the server (@talaia/servidor), Node ≥ 22.13
    src/main.js         start (systemd or by hand) and the `talaia` command; src/talaia.js: engine + receiver +
                        SQLite + periodic tasks
    src/receptor.js enlace.js puertos.js   the node over USB (serialport) or TCP 4403
    src/almacen.js      SQLite (node:sqlite): readings and the saved state
    src/textos.js       the server's texts in Spanish and English («s.*» keys)
    src/web.js sincro.js  the app and its API (SSE + orders); everything but the app, /api/salud and signing in needs
                        a session (HttpOnly cookie)
    src/usuarios.js     users and sessions (scrypt, 30 days since last used, first user with a code)
    src/mqtt.js mosquitto.js homeassistant.js  brokers (several at once), this machine's Mosquitto (dynamic
                        security plugin), Home Assistant with discovery
    src/paneles.js      panels: names, panels without a node (negative numbers), MQTT data («mq1»…), switches,
                        the receiver's data to the mesh
    src/automations.js  automations (2.1); src/mesh-orders.js orders over the mesh (2.1)
    instalar.sh sistema/  installer (own Node in /opt/talaia, Mosquitto from apt), systemd units, udev rule
    test/               node --test; nodo-falso.mjs is a simulated Meshtastic node (real protobuf) over TCP or a
                        virtual serial port; aedes is an MQTT broker in memory; mosquitto.test.mjs needs Mosquitto
  herramientas/         pantalla-servidor.mjs (end to end with Playwright), vistazo.mjs (screenshots of every section),
                        scroll.mjs (the scroll of the sheet and Settings must not move), pestanas.mjs (the sheet's tabs),
                        docker-prueba.mjs (the image with compose): see herramientas/LEEME.md
Dockerfile docker/      the image and compose.yaml
.github/workflows/      ci.yml (tests on Node 22 and 24, build, image amd64+arm64) and release.yml (image to ghcr.io)
docs/                   guide.md and guide.es.md (README.md / README.es.md, CHANGELOG.md)
```

The engine gets the state object `S` (see `estadoInicial()`) and hooks; the app adds its screen things to `S`.

## How it works (keep it so)

- **Languages**: the screen's texts in `app/src/i18n.js` and the server's in `servidor/src/textos.js`, always both
  languages with the same placeholders (`app/test/i18n.test.mjs` and `servidor/test/textos.test.mjs` check it). What
  the server writes (log, alerts and answers over the mesh, Home Assistant names, journal, CSV) goes in the server's
  language, set in *Settings → System*.
- **Panels without a node** are «nodes» with a negative number in `S.nodes` (`fuente: "mqtt"`), watched. A node's
  name in Talaia goes in `n.alias` (Meshtastic's stays in `n.long`). MQTT data keys are `mq1`, `mq2`… and behave as
  any metric (readings, alarms, history; one reading a minute, states on every change). Their alarms don't go to Home
  Assistant.
- **Switches**: an ON/OFF datum with `orden: { tema, on, off }`. `paneles.mandar` publishes (qos 1, not retained)
  and waits for the state topic to say the value (10 s); the pending order is registered before publishing.
- **Automations** (`automations.js`): only the crossing counts (what already held at save, switch-on or start doesn't
  fire; numbers re-arm past the metric's `hyst`); fired again while waiting, it starts over; «for N min» always goes
  back (the last command to a switch wins); waits and «for» survive restarts; 10 runs by itself in 10 min → paused.
- **Orders over the mesh** (`mesh-orders.js`): direct messages with `pkiEncrypted` from listed nodes whose key is the
  one pinned when added, or anyone on the chosen private channel; answers back the same way through `meshSay`.
  Answers must never read as orders, and on a channel only orders are answered. What waited in the receiver (10 s
  after connecting, or older than 10 min by its clock) isn't taken.
- **Home Assistant**: only watched nodes, as devices «Talaia · name», without position; base topic `talaia` by
  default and the ids come from it (`prefijoIds`).
- **Users**: one kind of user (everyone can do everything); sessions in an HttpOnly cookie, only their SHA-256 in the
  database; Tailscale Funnel is refused.
- **History**: a year by default; nothing in the normal path goes through the whole readings table (the total is in
  memory, the CSV comes out in blocks).
- **The sheet has tabs** (Node, Alarms, History, Settings: `sheetTabs()` in `sheet.js`; none for what doesn't apply).
  Every panel is rendered and the inactive ones are hidden by CSS (`data-tab` on the dialog), so drafts, typed values
  and id lookups (`#datBox`, `[data-cur]`…) keep working and the repaint check doesn't depend on the tab. The last tab
  is in `localStorage["talaia.sheetTab"]`; if it doesn't exist for that sheet, the first one. The charts are only drawn
  while History shows. `herramientas/pestanas.mjs` checks it.
- **Repainting keeps the scroll**: the parts that arrive (`active`, `cfg`…) are not specific to the sheet's node, so
  `renderSheet()` skips the repaint when its HTML is the same as the last one (`{ force: true }` when opening it) and,
  when it does repaint, puts `.sheet-b` back where it was (`holdScroll`/`releaseScroll`: the charts fill in later and
  can shorten it for a moment). `renderSettings()` keeps `window.scrollY` for the same part. `herramientas/scroll.mjs`
  checks it.

## Publishing

- Install from a branch to try it: `wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/<branch>/codigo/servidor/instalar.sh | sudo bash -s -- --branch <branch>`.
- **Versions**: the four `package.json` (and `npm install --package-lock-only`), `CHANGELOG.md`; the maintainer makes
  the release on GitHub (tag `vX.Y.Z` equal to `codigo/package.json`) and `release.yml` publishes the image. Tags
  can't be pushed from these sessions.
- **`INSTALADOR=` in `instalar.sh`**: raise it every time what the installer does changes.
- GitHub Actions: job logs can't be read from these sessions, their annotations can (`check-runs/<id>/annotations`):
  ci.yml turns failures into `::error` annotations. Tests that depend on the time zone set `process.env.TZ`.

## Learned with the mesh and the firmware (respect it)

- **Acknowledgements by packet id**: the first ack is usually the receiver's own implicit one (it hears a neighbour
  relay the packet). Delivered only when the destination node confirms.
- **An answer is recognised by when it arrives**, not by the packet's time: a receiver's clock can be minutes off.
- **Traceroute**: one every 30 s at most (the firmware limits it). **Node info**: a node doesn't answer whoever asked
  in the last 12 h.
- **Serial framing**: `@meshtastic/core`'s drops packets with 0x94 0xC3 inside; use `nucleo/src/tramas.js`. When
  reconnecting a serial port, wait for the previous one to finish closing.
- **Firmware (checked on 2.8.2)**: over TCP (4403) there's one client only (a new one closes the previous one); the
  packets received go to **one queue shared** by all clients (Bluetooth, cable, TCP), so two clients on one node
  each get a part: the server needs a node of its own; without traffic from the client, API mode stops after 15 min
  (send a heartbeat). Since 2.7.15 direct messages without PKI are dropped (CVE-2025-53627).
- **Accepted**: alerts over the mesh that fire in the same instant to one destination go out one after another
  without the 8 s gap (those that queue up do keep it); a test in `nucleo/test/motor.test.mjs` fixes it.
