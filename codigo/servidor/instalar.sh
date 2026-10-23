#!/usr/bin/env bash
# Installs or updates Talaia Hub on Linux (Ubuntu, Debian, Raspberry Pi OS). An installation of Vigía servidor (up to
# 1.20) moves to Talaia's names, with the same data and the same configuration.
#
#   wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash
#   (or with curl -fsSL instead of wget -qO-)
#
# It speaks the machine's language (LANG: Spanish, also for ca/eu/gl; otherwise English), or the one --lang says. Each
# option has an English and a Spanish name (after «bash -s --» when piped):
#   --tcp HOST[:PORT]                       the node over the network (WiFi/Ethernet or meshtasticd) instead of USB
#   --port | --puerto PATH|ID               the node by USB on that port («/dev/serial/by-id/…» or «239a:8029»)
#   --reconfigure | --reconfigurar          rewrites /etc/talaia/config.json with the above (else an existing one stays)
#   --branch | --rama BRANCH                installs from another branch of the repository (main by default)
#   --uninstall | --desinstalar             removes the service and the program; the data stays in /var/lib/talaia
#   --delete-data | --borrar-datos          with --uninstall, deletes the data and the configuration too
#   --local-code | --codigo-local DIR       uses a local copy of the repository instead of downloading it
#   --local-node | --node-local DIR         uses a Node already downloaded (DIR/bin/node) instead of nodejs.org's
#   --no-mosquitto | --sin-mosquitto        doesn't install or set up Mosquitto (this machine's MQTT broker)
#   --no-systemd | --sin-systemd            doesn't touch systemd (to try it in a container)
#   --lang | --idioma es|en                 the installer's language
#
# What it does: its own Node in /opt/talaia/node (the system's is left alone), the program in /opt/talaia/versiones/…
# (/opt/talaia/actual points to the latest), an unprivileged «talaia» user in the dialout group, the configuration in
# /etc/talaia/config.json, the data in /var/lib/talaia, the talaia service and the «talaia» command. Also Mosquitto
# (apt) as the home MQTT broker, with users and passwords: Talaia manages them through Mosquitto's dynamic security
# plugin.
set -euo pipefail

# Goes up each time what the installer does changes. If the program it downloads brings a newer one (installing
# another branch with main's installer), it carries on with that one.
INSTALADOR=6
ARGS=("$@")

REPO="Dani-NRos/talaia-hub"
RAMA="main"
BASE="/opt/talaia"
ETC="/etc/talaia"
CONFIG="$ETC/config.json"
DATOS="/var/lib/talaia"
SERVICIO="talaia"
USUARIO="talaia"
ORDEN="/usr/local/bin/talaia"
# Descargas de Node: nodejs.org, o un espejo con la misma estructura (TALAIA_NODE_DIST=https://…/dist).
NODE_DIST="${TALAIA_NODE_DIST:-${VIGIA_NODE_DIST:-https://nodejs.org/dist}}"
MOSQ_CONF="/etc/mosquitto/conf.d/talaia.conf"
# Los usuarios del broker, de Mosquitto (los escribe él: su carpeta tiene que ser suya).
MOSQ_DYN="/var/lib/mosquitto/talaia-dynamic-security.json"
TCP="" PUERTO="" RECONFIGURAR=0 DESINSTALAR=0 BORRAR=0 CODIGO_LOCAL="" NODE_LOCAL="" SIN_SYSTEMD=0 SIN_MOSQUITTO=0 PROGRAMA=""

# The language: --lang/--idioma, or the machine's (LC_ALL, LC_MESSAGES, LANG). m "español" "English" says the right one.
IDIOMA=""
for ((i = 1; i <= $#; i++)); do
  case "${!i}" in --lang|--idioma) j=$((i + 1)); IDIOMA="${!j:-}" ;; esac
done
if [ -z "$IDIOMA" ]; then
  case "$(printf '%s' "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" | tr '[:upper:]' '[:lower:]')" in
    es|es[_.@-]*|ca|ca[_.@-]*|eu|eu[_.@-]*|gl|gl[_.@-]*) IDIOMA=es ;;
    *) IDIOMA=en ;;
  esac
fi
[ "$IDIOMA" = es ] || IDIOMA=en
m() { if [ "$IDIOMA" = es ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

ayuda() {
  if [ "$IDIOMA" = es ]; then
    cat <<'FIN'
Instala o actualiza Talaia Hub. Opciones:
  --tcp HOST[:PUERTO]       el nodo por la red en vez de por USB
  --puerto RUTA|ID          el nodo por USB en ese puerto (/dev/serial/by-id/… o 239a:8029)
  --reconfigurar            reescribe /etc/talaia/config.json con lo anterior
  --rama RAMA               instala desde otra rama (por defecto, main)
  --desinstalar             quita el servicio y el programa (los datos se quedan)
  --borrar-datos            con --desinstalar, borra también datos y configuración
  --sin-mosquitto           no instala ni configura Mosquitto (el broker MQTT de este equipo)
  --idioma es|en            el idioma del instalador
Cada opción tiene también su nombre en inglés: --port, --reconfigure, --branch, --uninstall, --delete-data,
--no-mosquitto, --lang.
FIN
  else
    cat <<'FIN'
Installs or updates Talaia Hub. Options:
  --tcp HOST[:PORT]         the node over the network instead of by USB
  --port PATH|ID            the node by USB on that port (/dev/serial/by-id/… or 239a:8029)
  --reconfigure             rewrites /etc/talaia/config.json with the above
  --branch BRANCH           installs from another branch (main by default)
  --uninstall               removes the service and the program (the data stays)
  --delete-data             with --uninstall, deletes the data and the configuration too
  --no-mosquitto            doesn't install or set up Mosquitto (this machine's MQTT broker)
  --lang es|en              the installer's language
FIN
  fi
}
dice() { printf '\033[1m»\033[0m %s\n' "$*"; }
aviso() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
falla() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
# The value of an option, or why it's missing.
valor() { [ -n "${2:-}" ] && [ "${2#--}" = "$2" ] || falla "$(m "a $1 le falta su valor (mira --help)" "$1 needs a value (see --help)")"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tcp) valor "$1" "${2:-}"; TCP="$2"; shift 2 ;;
    --port|--puerto) valor "$1" "${2:-}"; PUERTO="$2"; shift 2 ;;
    --reconfigure|--reconfigurar) RECONFIGURAR=1; shift ;;
    --branch|--rama) valor "$1" "${2:-}"; RAMA="$2"; shift 2 ;;
    --uninstall|--desinstalar) DESINSTALAR=1; shift ;;
    --delete-data|--borrar-datos) BORRAR=1; shift ;;
    --local-code|--codigo-local) valor "$1" "${2:-}"; CODIGO_LOCAL="$2"; shift 2 ;;
    --local-node|--node-local) valor "$1" "${2:-}"; NODE_LOCAL="$2"; shift 2 ;;
    --no-systemd|--sin-systemd) SIN_SYSTEMD=1; shift ;;
    --no-mosquitto|--sin-mosquitto) SIN_MOSQUITTO=1; shift ;;
    --lang|--idioma) shift 2 ;; # read above
    --programa) valor "$1" "${2:-}"; PROGRAMA="$2"; shift 2 ;; # internal: the program already downloaded (carrying on with another installer)
    -h|--help) ayuda; exit 0 ;;
    *) falla "$(m "opción desconocida: $1 (mira --help)" "unknown option: $1 (see --help)")" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || falla "$(m "hay que ejecutarlo como administrador: sudo bash instalar.sh" "it has to run as administrator: sudo bash instalar.sh")"
[ "$(uname -s)" = "Linux" ] || falla "$(m "Talaia Hub funciona en Linux" "Talaia Hub runs on Linux")"
con_systemd() { [ "$SIN_SYSTEMD" -eq 0 ]; }

# ── de Vigía (hasta la 1.20 y el instalador 3): los mismos datos, con los nombres de Talaia ──
# Cada paso mira si ya está hecho: si algo se corta a medias, repetir el instalador lo termina.
desde_vigia() {
  [ -e /opt/vigia ] || [ -e /etc/vigia ] || [ -e /var/lib/vigia ] || id vigia >/dev/null 2>&1 \
    || [ -e /etc/systemd/system/vigia-servidor.service ] || [ -e /etc/mosquitto/conf.d/vigia.conf ] || return 0
  dice "$(m "Pasando la instalación de Vigía a los nombres de Talaia (mismos datos y configuración)…" "Moving the Vigía installation to Talaia's names (same data and configuration)…")"
  if con_systemd; then
    systemctl disable --now vigia-servidor.service vigia-mosquitto.path vigia-mosquitto.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/vigia-servidor.service /etc/systemd/system/vigia-mosquitto.path /etc/systemd/system/vigia-mosquitto.service
    systemctl daemon-reload
  fi
  # El usuario cambia de nombre y se queda con su número: sus ficheros siguen siendo suyos. Si no se puede (tiene algo
  # en marcha), se crea el nuevo y los datos pasan a él más abajo; el viejo se queda sin uso.
  if id vigia >/dev/null 2>&1 && ! id "$USUARIO" >/dev/null 2>&1; then
    if usermod -l "$USUARIO" vigia 2>/dev/null; then
      if getent group vigia >/dev/null; then groupmod -n "$USUARIO" vigia; fi
      usermod -d "$DATOS" "$USUARIO"
    else
      aviso "$(m "No se pudo cambiar el nombre del usuario «vigia» (¿tiene algo en marcha?): se crea «$USUARIO» y se queda con los datos." "The «vigia» user couldn't be renamed (is something of it running?): «$USUARIO» is made and gets the data.")"
      useradd --system --home-dir "$DATOS" --no-create-home --shell /usr/sbin/nologin "$USUARIO"
    fi
  fi
  if [ -d /var/lib/vigia ]; then
    if [ -e "$DATOS" ]; then
      aviso "$(m "Hay datos en /var/lib/vigia y también en $DATOS: se usan los de $DATOS; los de Vigía se quedan donde están." "There's data in /var/lib/vigia and in $DATOS too: $DATOS's is used; Vigía's stays where it is.")"
    else
      mv /var/lib/vigia "$DATOS"
      if id "$USUARIO" >/dev/null 2>&1; then chown -R "$USUARIO:$USUARIO" "$DATOS"; fi
    fi
  fi
  if [ -f /etc/vigia/servidor.json ] && [ ! -f "$CONFIG" ]; then
    mkdir -p "$ETC"
    mv /etc/vigia/servidor.json "$CONFIG"
  fi
  rmdir /etc/vigia 2>/dev/null || true
  # La carpeta de datos de siempre pasa a la nueva (si se había puesto otra a mano, se deja).
  if [ -f "$CONFIG" ]; then sed -i 's#"/var/lib/vigia"#"/var/lib/talaia"#' "$CONFIG"; fi
  # Node se queda (sin descargarlo otra vez) y también el programa que se está instalando; las versiones viejas se
  # van: solo funcionarían con los nombres de antes.
  if [ -d /opt/vigia ]; then
    mkdir -p "$BASE/versiones"
    if [ -d /opt/vigia/node ] && [ ! -e "$BASE/node" ]; then mv /opt/vigia/node "$BASE/node"; fi
    if [ -n "$PROGRAMA" ] && [ "${PROGRAMA#/opt/vigia/}" != "$PROGRAMA" ] && [ -d "$PROGRAMA" ]; then
      mv "$PROGRAMA" "$BASE/versiones/"
      PROGRAMA="$BASE/versiones/$(basename "$PROGRAMA")"
    fi
    rm -rf /opt/vigia
  fi
  rm -f /usr/local/bin/vigia-servidor /etc/udev/rules.d/60-vigia-meshtastic.rules
  # Mosquitto: su configuración con el nombre nuevo (más abajo); los usuarios del broker pasan de la base de datos de
  # Talaia, donde estaban, al plugin de seguridad dinámica.
  rm -f /etc/mosquitto/conf.d/vigia.conf /etc/mosquitto/vigia.passwd
  dice "$(m "Hecho: ahora es el servicio «$SERVICIO» y la orden «talaia» (antes, vigia-servidor)." "Done: it's now the «$SERVICIO» service and the «talaia» command (before, vigia-servidor).")"
}
desde_vigia

# Hasta el instalador 4, Talaia escribía un fichero de usuarios y un servicio de systemd (talaia-mosquitto.path, como
# root) se lo pasaba a Mosquitto. Ya no: se quita (los usuarios siguen en la base de datos hasta pasar al plugin).
quitar_passwd() {
  if con_systemd && [ -e /etc/systemd/system/talaia-mosquitto.path ]; then
    systemctl disable --now talaia-mosquitto.path talaia-mosquitto.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/talaia-mosquitto.path /etc/systemd/system/talaia-mosquitto.service
    systemctl daemon-reload
  fi
  rm -f /etc/systemd/system/talaia-mosquitto.path /etc/systemd/system/talaia-mosquitto.service /etc/mosquitto/talaia.passwd
  rm -rf "$DATOS/mosquitto"
}

# ── desinstalar ──
if [ "$DESINSTALAR" -eq 1 ]; then
  if con_systemd; then
    systemctl disable --now "$SERVICIO" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICIO.service"
    systemctl daemon-reload
  fi
  quitar_passwd
  if [ -f "$MOSQ_CONF" ]; then
    rm -f "$MOSQ_CONF"
    if con_systemd; then systemctl restart mosquitto 2>/dev/null || true; fi
    aviso "$(m "Mosquitto sigue instalado, sin la configuración de Talaia. Si no lo usas para nada más: sudo apt remove mosquitto" "Mosquitto is still installed, without Talaia's configuration. If you don't use it for anything else: sudo apt remove mosquitto")"
  fi
  # Sus usuarios se quedan (si se vuelve a instalar, siguen valiendo), salvo que se borren los datos.
  if [ "$BORRAR" -eq 1 ]; then rm -f "$MOSQ_DYN"; fi
  rm -rf "$BASE" "$ORDEN" /etc/udev/rules.d/60-talaia-meshtastic.rules
  if [ "$BORRAR" -eq 1 ]; then
    rm -rf "$DATOS" "$ETC"
    userdel "$USUARIO" 2>/dev/null || true
    dice "$(m "Talaia Hub desinstalado, con sus datos y su configuración." "Talaia Hub uninstalled, with its data and its configuration.")"
  else
    dice "$(m "Talaia Hub desinstalado. Los datos siguen en $DATOS y la configuración en $ETC (bórralos con --desinstalar --borrar-datos)." "Talaia Hub uninstalled. The data is still in $DATOS and the configuration in $ETC (delete them with --uninstall --delete-data).")"
  fi
  exit 0
fi

# ── sistema ──
ARQ="$(uname -m)"
case "$ARQ" in
  x86_64) NODE_ARQ="x64"; NODE_RAMA="24" ;;
  aarch64|arm64) NODE_ARQ="arm64"; NODE_RAMA="24" ;;
  armv7l)
    NODE_ARQ="armv7l"; NODE_RAMA="22"
    aviso "$(m "Sistema de 32 bits (armv7l): Node 24 ya no existe para él y se usa Node 22, con soporte hasta abril de 2027." "32-bit system (armv7l): there's no Node 24 for it, so Node 22 is used, supported until April 2027.")"
    aviso "$(m "Si es una Raspberry Pi 3, 4, 5 o Zero 2 W, mejor instala Raspberry Pi OS de 64 bits." "If it's a Raspberry Pi 3, 4, 5 or Zero 2 W, better install 64-bit Raspberry Pi OS.")" ;;
  armv6l) falla "$(m "esta placa es ARMv6 (Raspberry Pi Zero W o 1): Node.js ya no funciona en ella. La Zero 2 W sí vale." "this board is ARMv6 (Raspberry Pi Zero W or 1): Node.js doesn't run on it any more. The Zero 2 W does.")" ;;
  *) falla "$(m "arquitectura no soportada: $ARQ" "architecture not supported: $ARQ")" ;;
esac
for orden in tar xz sha256sum; do
  command -v "$orden" >/dev/null || falla "$(m "falta «$orden»: instálalo (sudo apt install tar xz-utils coreutils) y repite" "«$orden» is missing: install it (sudo apt install tar xz-utils coreutils) and try again")"
done
# Descargas a la salida estándar, y quien llama decide dónde guardarlas: así sirve también el curl de snap, que tiene
# su propio /tmp y no puede escribir donde le diga este script. Se prefiere el curl normal; si no, wget; si no, el de snap.
CURL="$(command -v curl || true)"
if [ -n "$CURL" ] && [ "${CURL#/snap/}" = "$CURL" ]; then
  bajar() { curl -fsSL "$1"; }
elif command -v wget >/dev/null; then
  bajar() { wget -qO- "$1"; }
elif [ -n "$CURL" ]; then
  bajar() { curl -fsSL "$1" 2>/dev/null; }
else
  falla "$(m "hace falta curl o wget para descargar: sudo apt update && sudo apt install curl" "curl or wget is needed to download: sudo apt update && sudo apt install curl")"
fi

# ── Node, propio de Talaia ──
mkdir -p "$BASE"
if [ -n "$NODE_LOCAL" ]; then
  [ -x "$NODE_LOCAL/bin/node" ] || falla "$(m "no hay $NODE_LOCAL/bin/node" "there's no $NODE_LOCAL/bin/node")"
  rm -rf "$BASE/node"; cp -a "$NODE_LOCAL" "$BASE/node"
  dice "$(m "Node $("$BASE/node/bin/node" --version) copiado de $NODE_LOCAL" "Node $("$BASE/node/bin/node" --version) copied from $NODE_LOCAL")"
else
  SUMAS="$(bajar "$NODE_DIST/latest-v$NODE_RAMA.x/SHASUMS256.txt")" || falla "$(m "no se pudo consultar $NODE_DIST (¿hay internet?)" "couldn't reach $NODE_DIST (is there internet?)")"
  LINEA="$(printf '%s\n' "$SUMAS" | grep -E " node-v[0-9.]+-linux-$NODE_ARQ\.tar\.xz$" | head -1)"
  [ -n "$LINEA" ] || falla "$(m "$NODE_DIST no tiene Node $NODE_RAMA para linux-$NODE_ARQ" "$NODE_DIST has no Node $NODE_RAMA for linux-$NODE_ARQ")"
  FICHERO="${LINEA##* }"
  VERSION_NODE="$(printf '%s' "$FICHERO" | sed -E 's/^node-(v[0-9.]+)-.*/\1/')"
  ACTUAL="$([ -x "$BASE/node/bin/node" ] && "$BASE/node/bin/node" --version || true)"
  if [ "$ACTUAL" = "$VERSION_NODE" ]; then
    dice "$(m "Node $VERSION_NODE ya está" "Node $VERSION_NODE is there already")"
  else
    dice "$(m "Descargando Node $VERSION_NODE ($NODE_ARQ)…" "Downloading Node $VERSION_NODE ($NODE_ARQ)…")"
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    bajar "$NODE_DIST/$VERSION_NODE/$FICHERO" > "$TMP/$FICHERO" || falla "$(m "no se pudo descargar Node de $NODE_DIST" "couldn't download Node from $NODE_DIST")"
    (cd "$TMP" && printf '%s\n' "$LINEA" | sha256sum -c --quiet -) || falla "$(m "la descarga de Node no coincide con su suma de comprobación" "the Node download doesn't match its checksum")"
    mkdir -p "$TMP/node" && tar -xJf "$TMP/$FICHERO" -C "$TMP/node" --strip-components=1
    rm -rf "$BASE/node" && mv "$TMP/node" "$BASE/node"
  fi
fi
NODE="$BASE/node/bin/node"
export PATH="$BASE/node/bin:$PATH"

# ── programa ──
mkdir -p "$BASE/versiones"
if [ -n "$PROGRAMA" ]; then
  [ -f "$PROGRAMA/servidor/package.json" ] || falla "$(m "$PROGRAMA no es una copia del programa" "$PROGRAMA isn't a copy of the program")"
  DEST="$PROGRAMA"
elif [ -n "$CODIGO_LOCAL" ]; then
  [ -f "$CODIGO_LOCAL/codigo/servidor/package.json" ] || falla "$(m "$CODIGO_LOCAL no parece el repositorio de Talaia" "$CODIGO_LOCAL doesn't look like Talaia's repository")"
  ID="local-$(date +%Y%m%d-%H%M%S)"
  DEST="$BASE/versiones/$ID"
  mkdir -p "$DEST"
  # Solo el código: sin node_modules ni compilados de la copia local.
  tar -C "$CODIGO_LOCAL/codigo" --exclude=node_modules --exclude=dist -cf - . | tar -C "$DEST" -xf -
else
  COMMIT="$(bajar "https://api.github.com/repos/$REPO/commits/$RAMA" 2>/dev/null | grep -m1 '"sha"' | sed -E 's/.*"([0-9a-f]{40})".*/\1/' || true)"
  REF="${COMMIT:-$RAMA}"
  ID="$(date +%Y%m%d-%H%M%S)-${REF:0:7}"
  DEST="$BASE/versiones/$ID"
  dice "$(m "Descargando Talaia (rama $RAMA${COMMIT:+, ${COMMIT:0:7}})…" "Downloading Talaia (branch $RAMA${COMMIT:+, ${COMMIT:0:7}})…")"
  TMPC="$(mktemp -d)"
  bajar "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$TMPC" --strip-components=1 || falla "$(m "no se pudo descargar el programa de GitHub" "couldn't download the program from GitHub")"
  mkdir -p "$DEST" && cp -a "$TMPC/codigo/." "$DEST/" && rm -rf "$TMPC"
fi
# Si el programa trae un instalador más nuevo que este, se sigue con el suyo (con lo ya descargado).
NUEVO="$(sed -nE 's/^INSTALADOR=([0-9]+).*/\1/p' "$DEST/servidor/instalar.sh" 2>/dev/null | head -1)"
if [ -z "$PROGRAMA" ] && [ -n "$NUEVO" ] && [ "$NUEVO" -gt "$INSTALADOR" ]; then
  dice "$(m "Este programa trae un instalador más nuevo: sigo con ese." "This program brings a newer installer: carrying on with that one.")"
  exec bash "$DEST/servidor/instalar.sh" "${ARGS[@]}" --programa "$DEST"
fi
dice "$(m "Instalando lo que necesita el servidor y compilando la pantalla…" "Installing what the server needs and building the screen…")"
(cd "$DEST" && "$BASE/node/bin/npm" ci --omit=dev -w @talaia/servidor -w @talaia/app --no-audit --no-fund --loglevel=error) || falla "$(m "npm no pudo instalar las dependencias" "npm couldn't install the dependencies")"
(cd "$DEST" && "$BASE/node/bin/npm" run build -w @talaia/app --silent >/dev/null) || falla "$(m "no se pudo compilar la pantalla" "couldn't build the screen")"
VERSION_TALAIA="$("$NODE" "$DEST/servidor/src/main.js" --version)" || falla "$(m "el programa instalado no arranca" "the installed program doesn't start")"
ln -sfn "$DEST" "$BASE/actual.nuevo" && mv -Tf "$BASE/actual.nuevo" "$BASE/actual"
# Se guardan las tres últimas versiones, para volver atrás si hace falta.
find "$BASE/versiones" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
# Con sudo, como el usuario del servicio: lo que escriba en los datos (usuarios de la pantalla) sigue siendo suyo.
cat > "$ORDEN" <<EOF
#!/bin/sh
if [ "\$(id -u)" = 0 ] && id $USUARIO >/dev/null 2>&1 && command -v runuser >/dev/null; then
  exec runuser -u $USUARIO -- "$NODE" "$BASE/actual/servidor/src/main.js" --config "$CONFIG" "\$@"
fi
exec "$NODE" "$BASE/actual/servidor/src/main.js" --config "$CONFIG" "\$@"
EOF
chmod 755 "$ORDEN"
dice "$VERSION_TALAIA"

# ── usuario, datos y configuración ──
if ! id "$USUARIO" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATOS" --no-create-home --shell /usr/sbin/nologin "$USUARIO"
fi
usermod -aG dialout "$USUARIO"
mkdir -p "$DATOS" && chown "$USUARIO:$USUARIO" "$DATOS" && chmod 750 "$DATOS"
mkdir -p "$ETC"
if [ ! -f "$CONFIG" ] || [ "$RECONFIGURAR" -eq 1 ]; then
  # With the keys in the installer's language (Talaia reads both).
  if [ -n "$TCP" ]; then
    H="${TCP%%:*}"; P="4403"; [ "$TCP" != "$H" ] && P="${TCP##*:}"
    RECEPTOR="$(m "{ \"tipo\": \"tcp\", \"host\": \"$H\", \"puerto\": $P }" "{ \"type\": \"tcp\", \"host\": \"$H\", \"port\": $P }")"
  else
    RECEPTOR="$(m "{ \"tipo\": \"usb\", \"puerto\": \"${PUERTO:-auto}\" }" "{ \"type\": \"usb\", \"port\": \"${PUERTO:-auto}\" }")"
  fi
  if [ "$IDIOMA" = es ]; then
    cat > "$CONFIG" <<EOF
{
  "receptor": $RECEPTOR,
  "web": { "puerto": 4404 },
  "datos": "$DATOS",
  "retencionDias": 365,
  "registro": "info"
}
EOF
  else
    cat > "$CONFIG" <<EOF
{
  "receiver": $RECEPTOR,
  "web": { "port": 4404 },
  "data": "$DATOS",
  "retentionDays": 365,
  "logLevel": "info"
}
EOF
  fi
  chmod 644 "$CONFIG"
  dice "$(m "Configuración en $CONFIG" "Configuration in $CONFIG")"
else
  [ -n "$TCP$PUERTO" ] && aviso "$(m "Ya había configuración en $CONFIG y se ha dejado tal cual. Para cambiarla, añade --reconfigurar." "There was a configuration in $CONFIG already and it's been left as it was. To change it, add --reconfigure.")"
  dice "$(m "Se mantiene la configuración de $CONFIG" "Keeping the configuration in $CONFIG")"
fi

# ── Mosquitto: el broker MQTT de casa, con usuario y contraseña (los usuarios, desde Talaia) ──
MOSQUITTO_OK=0
if [ "$SIN_MOSQUITTO" -eq 0 ]; then
  if ! command -v mosquitto >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      dice "$(m "Instalando Mosquitto (el broker MQTT de casa)…" "Installing Mosquitto (the home MQTT broker)…")"
      export DEBIAN_FRONTEND=noninteractive
      apt-get install -y -q mosquitto mosquitto-clients >/dev/null 2>&1 \
        || { apt-get update -q >/dev/null 2>&1 && apt-get install -y -q mosquitto mosquitto-clients >/dev/null 2>&1; } \
        || aviso "$(m "No se pudo instalar Mosquitto. Talaia funciona sin él; repite el instalador cuando haya internet para tenerlo." "Mosquitto couldn't be installed. Talaia works without it; run the installer again when there's internet to have it.")"
    else
      aviso "$(m "No hay apt-get: si quieres el broker MQTT en este equipo, instala Mosquitto y repite el instalador." "There's no apt-get: if you want the MQTT broker on this machine, install Mosquitto and run the installer again.")"
    fi
  fi
  if command -v mosquitto >/dev/null 2>&1 && id mosquitto >/dev/null 2>&1; then
    # Si Mosquitto ya tiene otra configuración que escucha en la red, pide usuarios o lleva plugins, no se toca.
    OTRA="$(grep -lsE '^[[:space:]]*(listener|port|password_file|allow_anonymous|plugin|auth_plugin)[[:space:]]' /etc/mosquitto/mosquitto.conf /etc/mosquitto/conf.d/*.conf 2>/dev/null | grep -vx "$MOSQ_CONF" || true)"
    PLUGIN="$(find /usr/lib /usr/local/lib -name mosquitto_dynamic_security.so 2>/dev/null | head -1)"
    if [ -n "$OTRA" ]; then
      aviso "$(m "Mosquitto ya tiene su propia configuración ($(echo $OTRA)): no se toca. Talaia puede usarlo como un broker más (Ajustes → MQTT)." "Mosquitto has its own configuration already ($(echo $OTRA)): it's left alone. Talaia can use it as one more broker (Settings → MQTT).")"
    elif [ -z "$PLUGIN" ]; then
      aviso "$(m "Este Mosquitto no trae el plugin de seguridad dinámica (mosquitto_dynamic_security.so), con el que Talaia gestiona sus usuarios: no se configura." "This Mosquitto lacks the dynamic security plugin (mosquitto_dynamic_security.so), with which Talaia manages its users: it isn't set up.")"
    else
      MOSQUITTO_OK=1
      # Que Talaia sepa que tiene su broker (también en una configuración que ya existía).
      "$NODE" -e '
        const fs = require("fs"), f = process.argv[1], c = JSON.parse(fs.readFileSync(f, "utf8"));
        if (!c.mosquitto && !c.broker) {
          if (c.receiver || c.data) c.broker = { port: 1883 }; else c.mosquitto = { puerto: 1883 };
          fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
        }' "$CONFIG"
      # Los usuarios: los primeros, de Talaia (su usuario y los de antes de la 2.0, con las mismas contraseñas). Si el
      # fichero ya está, es de Mosquitto y se deja.
      if [ ! -s "$MOSQ_DYN" ]; then
        install -d -o mosquitto -g mosquitto -m 755 "$(dirname "$MOSQ_DYN")"
        TMPD="$(mktemp)"
        "$ORDEN" --broker-inicial > "$TMPD" || { rm -f "$TMPD"; falla "$(m "no se pudieron preparar los usuarios del broker" "the broker's users couldn't be made")"; }
        install -o mosquitto -g mosquitto -m 600 "$TMPD" "$MOSQ_DYN" && rm -f "$TMPD"
      fi
      sed "s#@PLUGIN@#$PLUGIN#" "$BASE/actual/servidor/sistema/mosquitto-talaia.conf" > "$MOSQ_CONF.nuevo"
      chmod 644 "$MOSQ_CONF.nuevo" && mv -f "$MOSQ_CONF.nuevo" "$MOSQ_CONF"
      quitar_passwd
      dice "$(m "Mosquitto: broker MQTT en el puerto 1883, con usuario y contraseña (se crean en Talaia: Ajustes → MQTT)" "Mosquitto: MQTT broker on port 1883, with users and passwords (made in Talaia: Settings → MQTT)")"
    fi
  fi
fi

"$NODE" -e 'import("'"$BASE"'/actual/servidor/src/config.js").then((m) => m.leerConfig(process.argv[1], { obligatoria: true })).catch((e) => { console.error(e.message); process.exit(1); })' "$CONFIG" \
  || falla "$(m "la configuración de $CONFIG no es válida" "the configuration in $CONFIG isn't valid")"

# ── el sistema alrededor ──
if [ -d /etc/udev ]; then
  install -D -m 644 "$BASE/actual/servidor/sistema/60-talaia-meshtastic.rules" /etc/udev/rules.d/60-talaia-meshtastic.rules
  if command -v udevadm >/dev/null; then udevadm control --reload-rules 2>/dev/null || true; fi
fi
if command -v brltty >/dev/null 2>&1; then
  aviso "$(m "Está instalado brltty (lector braille): en Ubuntu de escritorio se queda con los nodos de chip CH340 y su puerto desaparece." "brltty (braille reader) is installed: on desktop Ubuntu it takes the nodes with a CH340 chip and their port disappears.")"
  aviso "$(m "Si no usas una línea braille: sudo apt remove brltty" "If you don't use a braille display: sudo apt remove brltty")"
fi

if con_systemd && [ "$MOSQUITTO_OK" -eq 1 ]; then
  systemctl enable mosquitto >/dev/null 2>&1
  systemctl restart mosquitto || aviso "$(m "Mosquitto no ha arrancado. Mira qué dice: journalctl -u mosquitto -n 30" "Mosquitto hasn't started. See what it says: journalctl -u mosquitto -n 30")"
fi

if con_systemd; then
  install -m 644 "$BASE/actual/servidor/sistema/$SERVICIO.service" "/etc/systemd/system/$SERVICIO.service"
  systemctl daemon-reload
  systemctl enable "$SERVICIO" >/dev/null 2>&1
  systemctl restart "$SERVICIO"
  sleep 3
  if systemctl is-active --quiet "$SERVICIO"; then
    dice "$(m "Servicio $SERVICIO en marcha." "Service $SERVICIO running.")"
  else
    aviso "$(m "El servicio no ha arrancado. Mira qué dice: journalctl -u $SERVICIO -n 50" "The service hasn't started. See what it says: journalctl -u $SERVICIO -n 50")"
  fi
  echo
  journalctl -u "$SERVICIO" -n 12 --no-pager -o cat 2>/dev/null || true
fi

echo
IPS="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' | head -3 || true)"
PUERTO_WEB="$("$NODE" -e 'import("'"$BASE"'/actual/servidor/src/config.js").then((m) => console.log(m.leerConfig(process.argv[1]).web.puerto))' "$CONFIG" 2>/dev/null || echo 4404)"
if [ -n "$IPS" ]; then
  dice "$(m "Pantalla en la red de casa:" "The screen, on your home network:")"
  for ip in $IPS; do echo "    http://$ip:$PUERTO_WEB"; done
  if [ "$MOSQUITTO_OK" -eq 1 ]; then
    dice "$(m "Broker MQTT (crea sus usuarios en la pantalla: Ajustes → MQTT):" "MQTT broker (make its users on the screen: Settings → MQTT):")"
    for ip in $IPS; do echo "    mqtt://$ip:1883"; done
  fi
fi
# With no users yet, the service writes a code to create the first one on the screen: it's shown here.
# `talaia --code`: 0 and the code; 3, there are users; 4, not made yet.
if con_systemd && systemctl is-active --quiet "$SERVICIO"; then
  for _ in $(seq 1 30); do
    ESTADO=0
    CODIGO="$("$ORDEN" --code 2>/dev/null)" || ESTADO=$?
    if [ "$ESTADO" -eq 0 ]; then
      echo
      dice "$(m "Aún no hay usuarios. Abre la pantalla y crea el primero con este código:" "There are no users yet. Open the screen and create the first one with this code:")"
      echo "    ${CODIGO##*: }"
      break
    fi
    [ "$ESTADO" -eq 3 ] && break
    sleep 0.5
  done
fi
echo
dice "$(m "Hecho. Para seguirlo:" "Done. To follow it:")"
if [ "$IDIOMA" = es ]; then
  echo "    journalctl -u $SERVICIO -f           lo que va pasando"
  echo "    talaia --puertos                     los nodos enchufados por USB"
  echo "    sudo talaia --clave NOMBRE           contraseña nueva para un usuario de la pantalla"
  echo "    sudo systemctl restart $SERVICIO     tras cambiar $CONFIG"
else
  echo "    journalctl -u $SERVICIO -f           what's going on"
  echo "    talaia --ports                       the nodes plugged in by USB"
  echo "    sudo talaia --password NAME          a new password for a user of the screen"
  echo "    sudo systemctl restart $SERVICIO     after changing $CONFIG"
fi
