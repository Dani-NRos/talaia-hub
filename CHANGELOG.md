# Changes

## Unreleased

- **Zigbee through Zigbee2MQTT**, step by step in the guide: the Sonoff ZBDongle-E on the same machine as Talaia,
  Zigbee2MQTT installed on its own with a user of Talaia's broker, its service, the firmware it needs, pairing and
  renaming the devices, and bringing each one into a panel with *Find topics*.
- **The receiver's port «auto» leaves other radios alone**: a Zigbee coordinator (or a Z-Wave one) uses the same
  USB-serial chips as some Meshtastic boards; now what says *Zigbee* in its USB name doesn't count as a node.

## 2.3.0

- **The alarm notice of the Dashboard folds** once every alarm is seen: one line, the size of *All clear*, with the
  alarms' names; each device remembers it, and a new alarm unfolds it. *Alarms* keeps the whole list.
- **Telegram** (*Settings → Telegram*): paste a bot's token from @BotFather and pair a chat or a group with a code.
  Every alarm goes there with an *Acknowledge* button (the log says who pressed it); `/paneles`, `/panel name`,
  `/alarmas` and `/ayuda` answer in the chat (a panel's answer has buttons for its switches), and the switches' words
  of the orders over the mesh work there too. Nothing to open at home: the server asks Telegram for what is new.
- **Automations and Telegram**: a step *Message by Telegram* (optionally with a node's position as a pin), and the
  order trigger says where it may come from: the mesh, Telegram or either.
- **The charts say the value and the time under the mouse or the finger**: a line marks the nearest reading and a
  label gives its value and when; on an ON/OFF bar, the state, from when to when and how long. With a finger, a tap
  shows it and dragging sideways moves it (the page still scrolls up and down); it stays until you tap elsewhere.
  In the sheet and in full screen.

## 2.2.0

- **The scroll no longer jumps to the top.** A node's sheet went back to the top every time a reading arrived from
  *another* node that has an alarm on, and when you changed its own limits. Now it only repaints when something it
  shows has changed, and keeps where you were when it does. Settings keeps its place too when it is painted again.
- **The sheet has tabs**: *Node*, *Alarms*, *History* and *Settings* (a panel without a node has no *Node*; a node that
  isn't watched has *Node* and *History*). The bar stays under the header while the body scrolls, the arrow keys move
  between tabs, each device remembers the last one used, and what was typed but not saved survives changing tabs.
  A panel just created opens on *Settings*.
- **Choose the order of a panel's data and charts, and the chart on its card.** *Reorder* (in full screen and in the
  sheet's *History*) has the readings and the charts in two lists, with arrows and a handle to drag. The readings keep
  their order on the card, the sheet and the full screen; the charts, in the sheet and the full screen. *On the card*,
  on each chart, picks the one the Dashboard card shows. It is kept by the server, per panel, and every screen sees it.

## 2.1.0

- **Automations**, in their own section: “if … then …” that the server runs 24/7. *If* a datum goes above or below a
  value or a state becomes ON or OFF (optionally for at least some minutes), at a time of day on some days, or when an
  order arrives over the mesh. *Then*, in order: switch on or off (optionally for some minutes, and back), wait, a
  message over the mesh, ask a node for data. Only the moment it happens counts; waits survive a restart; one that
  runs 10 times in 10 minutes is paused. *Try* runs one now.
- **Orders over the mesh** (*Settings → Mesh*): `word on`, `word off` and `word ?` for the switches you give a word,
  the text of an automation, and `help`. Only by direct messages encrypted with the key of the nodes you allow (the
  key is pinned when you add them) and, if you choose, on a private channel. The answer goes back the same way.

## 2.0.0

The first version of **Talaia Hub**.

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
- **Terminal commands**: `talaia --ports`, `--users`, `--password NAME`, `--code`.
