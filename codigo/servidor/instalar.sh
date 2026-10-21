#!/usr/bin/env bash
# Instala o actualiza Vigía servidor en Linux (Ubuntu, Debian, Raspberry Pi OS).
#
#   wget -qO- https://raw.githubusercontent.com/Dani-NRos/vigia-mesh/main/codigo/servidor/instalar.sh | sudo bash
#   (o con curl -fsSL en vez de wget -qO-)
#
# Opciones (detrás de «bash -s --» si va por tubería):
#   --tcp HOST[:PUERTO]   el nodo por la red (WiFi/Ethernet o meshtasticd) en vez de por USB
#   --puerto RUTA|ID      el nodo por USB en ese puerto («/dev/serial/by-id/…» o «239a:8029»); por defecto, el que haya
#   --reconfigurar        reescribe /etc/vigia/servidor.json con lo anterior (si no, una configuración que ya existe se deja)
#   --rama RAMA           instala desde otra rama del repositorio (por defecto, main)
#   --desinstalar         quita el servicio y el programa; los datos se quedan en /var/lib/vigia
#   --borrar-datos        con --desinstalar, borra también los datos y la configuración
#   --codigo-local DIR    usa una copia local del repositorio en vez de descargarla
#   --node-local DIR      usa un Node ya descargado (DIR/bin/node) en vez de bajarlo de nodejs.org
#   --sin-mosquitto       no instala ni configura Mosquitto (el broker MQTT de este equipo)
#   --sin-systemd         no toca systemd (para probar en un contenedor)
#
# Qué hace: pone su propio Node en /opt/vigia/node (no toca el del sistema), el programa en /opt/vigia/versiones/…
# (con /opt/vigia/actual apuntando a la última), un usuario «vigia» sin privilegios en el grupo dialout, la
# configuración en /etc/vigia/servidor.json, los datos en /var/lib/vigia y el servicio vigia-servidor. Además,
# Mosquitto (apt) como broker MQTT de casa, con usuario y contraseña: los usuarios se gestionan desde Vigía y el
# servicio vigia-mosquitto (path + oneshot, como root) se los pasa a Mosquitto.
set -euo pipefail

# Sube cada vez que cambia lo que hace el instalador. Si el programa que se descarga trae uno más nuevo (pasa al
# instalar otra rama con el instalador de main), se sigue con ese.
INSTALADOR=2
ARGS=("$@")

REPO="Dani-NRos/vigia-mesh"
RAMA="main"
BASE="/opt/vigia"
ETC="/etc/vigia"
DATOS="/var/lib/vigia"
SERVICIO="vigia-servidor"
# Descargas de Node: nodejs.org, o un espejo con la misma estructura (VIGIA_NODE_DIST=https://…/dist).
NODE_DIST="${VIGIA_NODE_DIST:-https://nodejs.org/dist}"
MOSQ_CONF="/etc/mosquitto/conf.d/vigia.conf"
MOSQ_PW="/etc/mosquitto/vigia.passwd"
TCP="" PUERTO="" RECONFIGURAR=0 DESINSTALAR=0 BORRAR=0 CODIGO_LOCAL="" NODE_LOCAL="" SIN_SYSTEMD=0 SIN_MOSQUITTO=0 PROGRAMA=""

ayuda() {
  cat <<'FIN'
Instala o actualiza Vigía servidor. Opciones:
  --tcp HOST[:PUERTO]   el nodo por la red en vez de por USB
  --puerto RUTA|ID      el nodo por USB en ese puerto (/dev/serial/by-id/… o 239a:8029)
  --reconfigurar        reescribe /etc/vigia/servidor.json con lo anterior
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
[ "$(uname -s)" = "Linux" ] || falla "Vigía servidor funciona en Linux"
con_systemd() { [ "$SIN_SYSTEMD" -eq 0 ]; }

# ── desinstalar ──
if [ "$DESINSTALAR" -eq 1 ]; then
  if con_systemd; then
    systemctl disable --now "$SERVICIO" vigia-mosquitto.path 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICIO.service" /etc/systemd/system/vigia-mosquitto.path /etc/systemd/system/vigia-mosquitto.service
    systemctl daemon-reload
  fi
  if [ -f "$MOSQ_CONF" ]; then
    rm -f "$MOSQ_CONF" "$MOSQ_PW"
    if con_systemd; then systemctl restart mosquitto 2>/dev/null || true; fi
    aviso "Mosquitto sigue instalado, sin la configuración de Vigía. Si no lo usas para nada más: sudo apt remove mosquitto"
  fi
  rm -rf "$BASE" /usr/local/bin/vigia-servidor /etc/udev/rules.d/60-vigia-meshtastic.rules
  if [ "$BORRAR" -eq 1 ]; then
    rm -rf "$DATOS" "$ETC"
    userdel vigia 2>/dev/null || true
    dice "Vigía servidor desinstalado, con sus datos y su configuración."
  else
    dice "Vigía servidor desinstalado. Los datos siguen en $DATOS y la configuración en $ETC (bórralos con --desinstalar --borrar-datos)."
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

# ── Node, propio de Vigía ──
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
  [ -f "$CODIGO_LOCAL/codigo/servidor/package.json" ] || falla "$CODIGO_LOCAL no parece el repositorio de Vigía"
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
  dice "Descargando Vigía (rama $RAMA${COMMIT:+, ${COMMIT:0:7}})…"
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
(cd "$DEST" && "$BASE/node/bin/npm" ci --omit=dev -w @vigia/servidor -w @vigia/app --no-audit --no-fund --loglevel=error) || falla "npm no pudo instalar las dependencias"
(cd "$DEST" && "$BASE/node/bin/npm" run build -w @vigia/app --silent >/dev/null) || falla "no se pudo compilar la pantalla"
VERSION_VIGIA="$("$NODE" "$DEST/servidor/src/main.js" --version)" || falla "el programa instalado no arranca"
ln -sfn "$DEST" "$BASE/actual.nuevo" && mv -Tf "$BASE/actual.nuevo" "$BASE/actual"
# Se guardan las tres últimas versiones, para volver atrás si hace falta.
find "$BASE/versiones" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
cat > /usr/local/bin/vigia-servidor <<EOF
#!/bin/sh
exec "$NODE" "$BASE/actual/servidor/src/main.js" "\$@"
EOF
chmod 755 /usr/local/bin/vigia-servidor
dice "$VERSION_VIGIA"

# ── usuario, datos y configuración ──
if ! id vigia >/dev/null 2>&1; then
  useradd --system --home-dir "$DATOS" --no-create-home --shell /usr/sbin/nologin vigia
fi
usermod -aG dialout vigia
mkdir -p "$DATOS" && chown vigia:vigia "$DATOS" && chmod 750 "$DATOS"
mkdir -p "$ETC"
if [ ! -f "$ETC/servidor.json" ] || [ "$RECONFIGURAR" -eq 1 ]; then
  if [ -n "$TCP" ]; then
    H="${TCP%%:*}"; P="4403"; [ "$TCP" != "$H" ] && P="${TCP##*:}"
    RECEPTOR="{ \"tipo\": \"tcp\", \"host\": \"$H\", \"puerto\": $P }"
  else
    RECEPTOR="{ \"tipo\": \"usb\", \"puerto\": \"${PUERTO:-auto}\" }"
  fi
  cat > "$ETC/servidor.json" <<EOF
{
  "receptor": $RECEPTOR,
  "web": { "puerto": 4404 },
  "datos": "$DATOS",
  "retencionDias": 365,
  "registro": "info"
}
EOF
  chmod 644 "$ETC/servidor.json"
  dice "Configuración en $ETC/servidor.json"
else
  [ -n "$TCP$PUERTO" ] && aviso "Ya había configuración en $ETC/servidor.json y se ha dejado tal cual. Para cambiarla, añade --reconfigurar."
  dice "Se mantiene la configuración de $ETC/servidor.json"
fi

# ── Mosquitto: el broker MQTT de casa, con usuario y contraseña (los usuarios, desde Vigía) ──
MOSQUITTO_OK=0
if [ "$SIN_MOSQUITTO" -eq 0 ]; then
  if ! command -v mosquitto >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      dice "Instalando Mosquitto (el broker MQTT de casa)…"
      export DEBIAN_FRONTEND=noninteractive
      apt-get install -y -q mosquitto mosquitto-clients >/dev/null 2>&1 \
        || { apt-get update -q >/dev/null 2>&1 && apt-get install -y -q mosquitto mosquitto-clients >/dev/null 2>&1; } \
        || aviso "No se pudo instalar Mosquitto. Vigía funciona sin él; repite el instalador cuando haya internet para tenerlo."
    else
      aviso "No hay apt-get: si quieres el broker MQTT en este equipo, instala Mosquitto y repite el instalador."
    fi
  fi
  if command -v mosquitto >/dev/null 2>&1 && id mosquitto >/dev/null 2>&1; then
    # Si Mosquitto ya tiene otra configuración que escucha en la red o pide usuarios, no se toca.
    OTRA="$(grep -lsE '^[[:space:]]*(listener|port|password_file)[[:space:]]' /etc/mosquitto/mosquitto.conf /etc/mosquitto/conf.d/*.conf 2>/dev/null | grep -vx "$MOSQ_CONF" || true)"
    if [ -n "$OTRA" ]; then
      aviso "Mosquitto ya tiene su propia configuración ($(echo $OTRA)): no se toca. Vigía puede usarlo como un broker más (Ajustes → MQTT)."
    else
      MOSQUITTO_OK=1
      install -m 644 "$BASE/actual/servidor/sistema/mosquitto-vigia.conf" "$MOSQ_CONF"
      [ -f "$MOSQ_PW" ] || install -m 600 -o mosquitto -g mosquitto /dev/null "$MOSQ_PW"
      mkdir -p "$DATOS/mosquitto" && chown vigia:vigia "$DATOS/mosquitto" && chmod 700 "$DATOS/mosquitto"
      # Que Vigía sepa que tiene su broker (también en una configuración que ya existía).
      "$NODE" -e '
        const fs = require("fs"), f = process.argv[1], c = JSON.parse(fs.readFileSync(f, "utf8"));
        if (!c.mosquitto) { c.mosquitto = { puerto: 1883 }; fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n"); }' "$ETC/servidor.json"
      dice "Mosquitto: broker MQTT en el puerto 1883, con usuario y contraseña (se crean en Vigía: Ajustes → MQTT)"
    fi
  fi
fi

"$NODE" -e 'import("'"$BASE"'/actual/servidor/src/config.js").then((m) => m.leerConfig(process.argv[1], { obligatoria: true })).catch((e) => { console.error(e.message); process.exit(1); })' "$ETC/servidor.json" \
  || falla "la configuración de $ETC/servidor.json no es válida"

# ── el sistema alrededor ──
if [ -d /etc/udev ]; then
  install -D -m 644 "$BASE/actual/servidor/sistema/60-vigia-meshtastic.rules" /etc/udev/rules.d/60-vigia-meshtastic.rules
  if command -v udevadm >/dev/null; then udevadm control --reload-rules 2>/dev/null || true; fi
fi
if command -v brltty >/dev/null 2>&1; then
  aviso "Está instalado brltty (lector braille): en Ubuntu de escritorio se queda con los nodos de chip CH340 y su puerto desaparece."
  aviso "Si no usas una línea braille: sudo apt remove brltty"
fi

if con_systemd && [ "$MOSQUITTO_OK" -eq 1 ]; then
  install -m 644 "$BASE/actual/servidor/sistema/vigia-mosquitto.path" "$BASE/actual/servidor/sistema/vigia-mosquitto.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now vigia-mosquitto.path >/dev/null 2>&1
  # Los usuarios que ya hubiera (de una instalación anterior) pasan a Mosquitto antes de arrancarlo.
  [ -f "$DATOS/mosquitto/passwd" ] && systemctl start vigia-mosquitto.service 2>/dev/null || true
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
PUERTO_WEB="$("$NODE" -e 'import("'"$BASE"'/actual/servidor/src/config.js").then((m) => console.log(m.leerConfig(process.argv[1]).web.puerto))' "$ETC/servidor.json" 2>/dev/null || echo 4404)"
if [ -n "$IPS" ]; then
  dice "Pantalla en la red de casa:"
  for ip in $IPS; do echo "    http://$ip:$PUERTO_WEB"; done
  if [ "$MOSQUITTO_OK" -eq 1 ]; then
    dice "Broker MQTT (crea sus usuarios en la pantalla: Ajustes → MQTT):"
    for ip in $IPS; do echo "    mqtt://$ip:1883"; done
  fi
fi
echo
dice "Hecho. Para seguirlo:"
echo "    journalctl -u $SERVICIO -f          lo que va pasando"
echo "    vigia-servidor --puertos            los nodos enchufados por USB"
echo "    sudo systemctl restart $SERVICIO    tras cambiar $ETC/servidor.json"
