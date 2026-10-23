#!/usr/bin/env bash
# Instala o actualiza Talaia Hub en Linux (Ubuntu, Debian, Raspberry Pi OS). Una instalación de Vigía servidor (hasta
# la 1.20) pasa a los nombres de Talaia, con los mismos datos y la misma configuración.
#
#   wget -qO- https://raw.githubusercontent.com/Dani-NRos/talaia-hub/main/codigo/servidor/instalar.sh | sudo bash
#   (o con curl -fsSL en vez de wget -qO-)
#
# Opciones (detrás de «bash -s --» si va por tubería):
#   --tcp HOST[:PUERTO]   el nodo por la red (WiFi/Ethernet o meshtasticd) en vez de por USB
#   --puerto RUTA|ID      el nodo por USB en ese puerto («/dev/serial/by-id/…» o «239a:8029»); por defecto, el que haya
#   --reconfigurar        reescribe /etc/talaia/config.json con lo anterior (si no, una configuración que ya existe se deja)
#   --rama RAMA           instala desde otra rama del repositorio (por defecto, main)
#   --desinstalar         quita el servicio y el programa; los datos se quedan en /var/lib/talaia
#   --borrar-datos        con --desinstalar, borra también los datos y la configuración
#   --codigo-local DIR    usa una copia local del repositorio en vez de descargarla
#   --node-local DIR      usa un Node ya descargado (DIR/bin/node) en vez de bajarlo de nodejs.org
#   --sin-mosquitto       no instala ni configura Mosquitto (el broker MQTT de este equipo)
#   --sin-systemd         no toca systemd (para probar en un contenedor)
#
# Qué hace: pone su propio Node en /opt/talaia/node (no toca el del sistema), el programa en /opt/talaia/versiones/…
# (con /opt/talaia/actual apuntando a la última), un usuario «talaia» sin privilegios en el grupo dialout, la
# configuración en /etc/talaia/config.json, los datos en /var/lib/talaia, el servicio talaia y la orden «talaia».
# Además, Mosquitto (apt) como broker MQTT de casa, con usuario y contraseña: los usuarios se gestionan desde Talaia y
# el servicio talaia-mosquitto (path + oneshot, como root) se los pasa a Mosquitto.
set -euo pipefail

# Sube cada vez que cambia lo que hace el instalador. Si el programa que se descarga trae uno más nuevo (pasa al
# instalar otra rama con el instalador de main), se sigue con ese.
INSTALADOR=4
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
MOSQ_PW="/etc/mosquitto/talaia.passwd"
TCP="" PUERTO="" RECONFIGURAR=0 DESINSTALAR=0 BORRAR=0 CODIGO_LOCAL="" NODE_LOCAL="" SIN_SYSTEMD=0 SIN_MOSQUITTO=0 PROGRAMA=""

ayuda() {
  cat <<'FIN'
Instala o actualiza Talaia Hub. Opciones:
  --tcp HOST[:PUERTO]   el nodo por la red en vez de por USB
  --puerto RUTA|ID      el nodo por USB en ese puerto (/dev/serial/by-id/… o 239a:8029)
  --reconfigurar        reescribe /etc/talaia/config.json con lo anterior
  --rama RAMA           instala desde otra rama (por defecto, main)
  --desinstalar         quita el servicio y el programa (los datos se quedan)
  --borrar-datos        con --desinstalar, borra también datos y configuración
  --sin-mosquitto       no instala ni configura Mosquitto (el broker MQTT de este equipo)
FIN
}
dice() { printf '\033[1m»\033[0m %s\n' "$*"; }
aviso() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
falla() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tcp) TCP="${2:?falta HOST}"; shift 2 ;;
    --puerto) PUERTO="${2:?falta la ruta o el id USB}"; shift 2 ;;
    --reconfigurar) RECONFIGURAR=1; shift ;;
    --rama) RAMA="${2:?falta la rama}"; shift 2 ;;
    --desinstalar) DESINSTALAR=1; shift ;;
    --borrar-datos) BORRAR=1; shift ;;
    --codigo-local) CODIGO_LOCAL="${2:?falta la carpeta}"; shift 2 ;;
    --node-local) NODE_LOCAL="${2:?falta la carpeta}"; shift 2 ;;
    --sin-systemd) SIN_SYSTEMD=1; shift ;;
    --sin-mosquitto) SIN_MOSQUITTO=1; shift ;;
    --programa) PROGRAMA="${2:?falta la carpeta}"; shift 2 ;; # interna: el programa ya descargado (al seguir con otro instalador)
    -h|--help) ayuda; exit 0 ;;
    *) falla "opción desconocida: $1 (mira --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || falla "hay que ejecutarlo como administrador: sudo bash instalar.sh"
[ "$(uname -s)" = "Linux" ] || falla "Talaia Hub funciona en Linux"
con_systemd() { [ "$SIN_SYSTEMD" -eq 0 ]; }

# ── de Vigía (hasta la 1.20 y el instalador 3): los mismos datos, con los nombres de Talaia ──
# Cada paso mira si ya está hecho: si algo se corta a medias, repetir el instalador lo termina.
desde_vigia() {
  [ -e /opt/vigia ] || [ -e /etc/vigia ] || [ -e /var/lib/vigia ] || id vigia >/dev/null 2>&1 \
    || [ -e /etc/systemd/system/vigia-servidor.service ] || [ -e /etc/mosquitto/conf.d/vigia.conf ] || return 0
  dice "Pasando la instalación de Vigía a los nombres de Talaia (mismos datos y configuración)…"
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
      aviso "No se pudo cambiar el nombre del usuario «vigia» (¿tiene algo en marcha?): se crea «$USUARIO» y se queda con los datos."
      useradd --system --home-dir "$DATOS" --no-create-home --shell /usr/sbin/nologin "$USUARIO"
    fi
  fi
  if [ -d /var/lib/vigia ]; then
    if [ -e "$DATOS" ]; then
      aviso "Hay datos en /var/lib/vigia y también en $DATOS: se usan los de $DATOS; los de Vigía se quedan donde están."
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
  # Mosquitto: su configuración con el nombre nuevo (más abajo); los usuarios del broker son los mismos.
  rm -f /etc/mosquitto/conf.d/vigia.conf
  if [ -f /etc/mosquitto/vigia.passwd ]; then
    if [ ! -f "$MOSQ_PW" ]; then mv /etc/mosquitto/vigia.passwd "$MOSQ_PW"; else rm -f /etc/mosquitto/vigia.passwd; fi
  fi
  dice "Hecho: ahora es el servicio «$SERVICIO» y la orden «talaia» (antes, vigia-servidor)."
}
desde_vigia

# ── desinstalar ──
if [ "$DESINSTALAR" -eq 1 ]; then
  if con_systemd; then
    systemctl disable --now "$SERVICIO" talaia-mosquitto.path 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICIO.service" /etc/systemd/system/talaia-mosquitto.path /etc/systemd/system/talaia-mosquitto.service
    systemctl daemon-reload
  fi
  if [ -f "$MOSQ_CONF" ]; then
    rm -f "$MOSQ_CONF" "$MOSQ_PW"
    if con_systemd; then systemctl restart mosquitto 2>/dev/null || true; fi
    aviso "Mosquitto sigue instalado, sin la configuración de Talaia. Si no lo usas para nada más: sudo apt remove mosquitto"
  fi
  rm -rf "$BASE" "$ORDEN" /etc/udev/rules.d/60-talaia-meshtastic.rules
  if [ "$BORRAR" -eq 1 ]; then
    rm -rf "$DATOS" "$ETC"
    userdel "$USUARIO" 2>/dev/null || true
    dice "Talaia Hub desinstalado, con sus datos y su configuración."
  else
    dice "Talaia Hub desinstalado. Los datos siguen en $DATOS y la configuración en $ETC (bórralos con --desinstalar --borrar-datos)."
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
    aviso "Sistema de 32 bits (armv7l): Node 24 ya no existe para él y se usa Node 22, con soporte hasta abril de 2027."
    aviso "Si es una Raspberry Pi 3, 4, 5 o Zero 2 W, mejor instala Raspberry Pi OS de 64 bits." ;;
  armv6l) falla "esta placa es ARMv6 (Raspberry Pi Zero W o 1): Node.js ya no funciona en ella. La Zero 2 W sí vale." ;;
  *) falla "arquitectura no soportada: $ARQ" ;;
esac
for orden in tar xz sha256sum; do
  command -v "$orden" >/dev/null || falla "falta «$orden»: instálalo (sudo apt install tar xz-utils coreutils) y repite"
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
  falla "hace falta curl o wget para descargar: sudo apt update && sudo apt install curl"
fi

# ── Node, propio de Talaia ──
mkdir -p "$BASE"
if [ -n "$NODE_LOCAL" ]; then
  [ -x "$NODE_LOCAL/bin/node" ] || falla "no hay $NODE_LOCAL/bin/node"
  rm -rf "$BASE/node"; cp -a "$NODE_LOCAL" "$BASE/node"
  dice "Node $("$BASE/node/bin/node" --version) copiado de $NODE_LOCAL"
else
  SUMAS="$(bajar "$NODE_DIST/latest-v$NODE_RAMA.x/SHASUMS256.txt")" || falla "no se pudo consultar $NODE_DIST (¿hay internet?)"
  LINEA="$(printf '%s\n' "$SUMAS" | grep -E " node-v[0-9.]+-linux-$NODE_ARQ\.tar\.xz$" | head -1)"
  [ -n "$LINEA" ] || falla "$NODE_DIST no tiene Node $NODE_RAMA para linux-$NODE_ARQ"
  FICHERO="${LINEA##* }"
  VERSION_NODE="$(printf '%s' "$FICHERO" | sed -E 's/^node-(v[0-9.]+)-.*/\1/')"
  ACTUAL="$([ -x "$BASE/node/bin/node" ] && "$BASE/node/bin/node" --version || true)"
  if [ "$ACTUAL" = "$VERSION_NODE" ]; then
    dice "Node $VERSION_NODE ya está"
  else
    dice "Descargando Node $VERSION_NODE ($NODE_ARQ)…"
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    bajar "$NODE_DIST/$VERSION_NODE/$FICHERO" > "$TMP/$FICHERO" || falla "no se pudo descargar Node de $NODE_DIST"
    (cd "$TMP" && printf '%s\n' "$LINEA" | sha256sum -c --quiet -) || falla "la descarga de Node no coincide con su suma de comprobación"
    mkdir -p "$TMP/node" && tar -xJf "$TMP/$FICHERO" -C "$TMP/node" --strip-components=1
    rm -rf "$BASE/node" && mv "$TMP/node" "$BASE/node"
  fi
fi
NODE="$BASE/node/bin/node"
export PATH="$BASE/node/bin:$PATH"

# ── programa ──
mkdir -p "$BASE/versiones"
if [ -n "$PROGRAMA" ]; then
  [ -f "$PROGRAMA/servidor/package.json" ] || falla "$PROGRAMA no es una copia del programa"
  DEST="$PROGRAMA"
elif [ -n "$CODIGO_LOCAL" ]; then
  [ -f "$CODIGO_LOCAL/codigo/servidor/package.json" ] || falla "$CODIGO_LOCAL no parece el repositorio de Talaia"
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
  dice "Descargando Talaia (rama $RAMA${COMMIT:+, ${COMMIT:0:7}})…"
  TMPC="$(mktemp -d)"
  bajar "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$TMPC" --strip-components=1 || falla "no se pudo descargar el programa de GitHub"
  mkdir -p "$DEST" && cp -a "$TMPC/codigo/." "$DEST/" && rm -rf "$TMPC"
fi
# Si el programa trae un instalador más nuevo que este, se sigue con el suyo (con lo ya descargado).
NUEVO="$(sed -nE 's/^INSTALADOR=([0-9]+).*/\1/p' "$DEST/servidor/instalar.sh" 2>/dev/null | head -1)"
if [ -z "$PROGRAMA" ] && [ -n "$NUEVO" ] && [ "$NUEVO" -gt "$INSTALADOR" ]; then
  dice "Este programa trae un instalador más nuevo: sigo con ese."
  exec bash "$DEST/servidor/instalar.sh" "${ARGS[@]}" --programa "$DEST"
fi
dice "Instalando lo que necesita el servidor y compilando la pantalla…"
(cd "$DEST" && "$BASE/node/bin/npm" ci --omit=dev -w @talaia/servidor -w @talaia/app --no-audit --no-fund --loglevel=error) || falla "npm no pudo instalar las dependencias"
(cd "$DEST" && "$BASE/node/bin/npm" run build -w @talaia/app --silent >/dev/null) || falla "no se pudo compilar la pantalla"
VERSION_TALAIA="$("$NODE" "$DEST/servidor/src/main.js" --version)" || falla "el programa instalado no arranca"
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
  if [ -n "$TCP" ]; then
    H="${TCP%%:*}"; P="4403"; [ "$TCP" != "$H" ] && P="${TCP##*:}"
    RECEPTOR="{ \"tipo\": \"tcp\", \"host\": \"$H\", \"puerto\": $P }"
  else
    RECEPTOR="{ \"tipo\": \"usb\", \"puerto\": \"${PUERTO:-auto}\" }"
  fi
  cat > "$CONFIG" <<EOF
{
  "receptor": $RECEPTOR,
  "web": { "puerto": 4404 },
  "datos": "$DATOS",
  "retencionDias": 365,
  "registro": "info"
}
EOF
  chmod 644 "$CONFIG"
  dice "Configuración en $CONFIG"
else
  [ -n "$TCP$PUERTO" ] && aviso "Ya había configuración en $CONFIG y se ha dejado tal cual. Para cambiarla, añade --reconfigurar."
  dice "Se mantiene la configuración de $CONFIG"
fi

# ── Mosquitto: el broker MQTT de casa, con usuario y contraseña (los usuarios, desde Talaia) ──
MOSQUITTO_OK=0
if [ "$SIN_MOSQUITTO" -eq 0 ]; then
  if ! command -v mosquitto >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      dice "Instalando Mosquitto (el broker MQTT de casa)…"
      export DEBIAN_FRONTEND=noninteractive
      apt-get install -y -q mosquitto mosquitto-clients >/dev/null 2>&1 \
        || { apt-get update -q >/dev/null 2>&1 && apt-get install -y -q mosquitto mosquitto-clients >/dev/null 2>&1; } \
        || aviso "No se pudo instalar Mosquitto. Talaia funciona sin él; repite el instalador cuando haya internet para tenerlo."
    else
      aviso "No hay apt-get: si quieres el broker MQTT en este equipo, instala Mosquitto y repite el instalador."
    fi
  fi
  if command -v mosquitto >/dev/null 2>&1 && id mosquitto >/dev/null 2>&1; then
    # Si Mosquitto ya tiene otra configuración que escucha en la red o pide usuarios, no se toca.
    OTRA="$(grep -lsE '^[[:space:]]*(listener|port|password_file)[[:space:]]' /etc/mosquitto/mosquitto.conf /etc/mosquitto/conf.d/*.conf 2>/dev/null | grep -vx "$MOSQ_CONF" || true)"
    if [ -n "$OTRA" ]; then
      aviso "Mosquitto ya tiene su propia configuración ($(echo $OTRA)): no se toca. Talaia puede usarlo como un broker más (Ajustes → MQTT)."
    else
      MOSQUITTO_OK=1
      install -m 644 "$BASE/actual/servidor/sistema/mosquitto-talaia.conf" "$MOSQ_CONF"
      [ -f "$MOSQ_PW" ] || install -m 600 -o mosquitto -g mosquitto /dev/null "$MOSQ_PW"
      mkdir -p "$DATOS/mosquitto" && chown "$USUARIO:$USUARIO" "$DATOS/mosquitto" && chmod 700 "$DATOS/mosquitto"
      # Que Talaia sepa que tiene su broker (también en una configuración que ya existía).
      "$NODE" -e '
        const fs = require("fs"), f = process.argv[1], c = JSON.parse(fs.readFileSync(f, "utf8"));
        if (!c.mosquitto) { c.mosquitto = { puerto: 1883 }; fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n"); }' "$CONFIG"
      dice "Mosquitto: broker MQTT en el puerto 1883, con usuario y contraseña (se crean en Talaia: Ajustes → MQTT)"
    fi
  fi
fi

"$NODE" -e 'import("'"$BASE"'/actual/servidor/src/config.js").then((m) => m.leerConfig(process.argv[1], { obligatoria: true })).catch((e) => { console.error(e.message); process.exit(1); })' "$CONFIG" \
  || falla "la configuración de $CONFIG no es válida"

# ── el sistema alrededor ──
if [ -d /etc/udev ]; then
  install -D -m 644 "$BASE/actual/servidor/sistema/60-talaia-meshtastic.rules" /etc/udev/rules.d/60-talaia-meshtastic.rules
  if command -v udevadm >/dev/null; then udevadm control --reload-rules 2>/dev/null || true; fi
fi
if command -v brltty >/dev/null 2>&1; then
  aviso "Está instalado brltty (lector braille): en Ubuntu de escritorio se queda con los nodos de chip CH340 y su puerto desaparece."
  aviso "Si no usas una línea braille: sudo apt remove brltty"
fi

if con_systemd && [ "$MOSQUITTO_OK" -eq 1 ]; then
  install -m 644 "$BASE/actual/servidor/sistema/talaia-mosquitto.path" "$BASE/actual/servidor/sistema/talaia-mosquitto.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now talaia-mosquitto.path >/dev/null 2>&1
  # Los usuarios que ya hubiera (de una instalación anterior) pasan a Mosquitto antes de arrancarlo.
  [ -f "$DATOS/mosquitto/passwd" ] && systemctl start talaia-mosquitto.service 2>/dev/null || true
  systemctl enable mosquitto >/dev/null 2>&1
  systemctl restart mosquitto || aviso "Mosquitto no ha arrancado. Mira qué dice: journalctl -u mosquitto -n 30"
fi

if con_systemd; then
  install -m 644 "$BASE/actual/servidor/sistema/$SERVICIO.service" "/etc/systemd/system/$SERVICIO.service"
  systemctl daemon-reload
  systemctl enable "$SERVICIO" >/dev/null 2>&1
  systemctl restart "$SERVICIO"
  sleep 3
  if systemctl is-active --quiet "$SERVICIO"; then
    dice "Servicio $SERVICIO en marcha."
  else
    aviso "El servicio no ha arrancado. Mira qué dice: journalctl -u $SERVICIO -n 50"
  fi
  echo
  journalctl -u "$SERVICIO" -n 12 --no-pager -o cat 2>/dev/null || true
fi

echo
IPS="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' | head -3 || true)"
PUERTO_WEB="$("$NODE" -e 'import("'"$BASE"'/actual/servidor/src/config.js").then((m) => console.log(m.leerConfig(process.argv[1]).web.puerto))' "$CONFIG" 2>/dev/null || echo 4404)"
if [ -n "$IPS" ]; then
  dice "Pantalla en la red de casa:"
  for ip in $IPS; do echo "    http://$ip:$PUERTO_WEB"; done
  if [ "$MOSQUITTO_OK" -eq 1 ]; then
    dice "Broker MQTT (crea sus usuarios en la pantalla: Ajustes → MQTT):"
    for ip in $IPS; do echo "    mqtt://$ip:1883"; done
  fi
fi
# Sin usuarios todavía, el servicio escribe un código para crear el primero desde la pantalla: aquí se enseña.
if con_systemd && systemctl is-active --quiet "$SERVICIO"; then
  for _ in $(seq 1 30); do
    CODIGO="$("$ORDEN" --codigo 2>/dev/null || true)"
    case "$CODIGO" in
      *"Código para crear"*)
        echo
        dice "Aún no hay usuarios. Abre la pantalla y crea el primero con este código:"
        echo "    ${CODIGO##*: }"
        break ;;
      *"Ya hay usuarios"*) break ;;
    esac
    sleep 0.5
  done
fi
echo
dice "Hecho. Para seguirlo:"
echo "    journalctl -u $SERVICIO -f           lo que va pasando"
echo "    talaia --puertos                     los nodos enchufados por USB"
echo "    sudo talaia --clave NOMBRE           contraseña nueva para un usuario de la pantalla"
echo "    sudo systemctl restart $SERVICIO     tras cambiar $CONFIG"
