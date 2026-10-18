#!/usr/bin/env bash
# Instala o actualiza Vigía servidor en Linux (Ubuntu, Debian, Raspberry Pi OS).
#
#   curl -fsSL https://raw.githubusercontent.com/Dani-NRos/vigia-mesh/main/codigo/servidor/instalar.sh | sudo bash
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
#   --sin-systemd         no toca systemd (para probar en un contenedor)
#
# Qué hace: pone su propio Node en /opt/vigia/node (no toca el del sistema), el programa en /opt/vigia/versiones/…
# (con /opt/vigia/actual apuntando a la última), un usuario «vigia» sin privilegios en el grupo dialout, la
# configuración en /etc/vigia/servidor.json, los datos en /var/lib/vigia y el servicio vigia-servidor.
set -euo pipefail

REPO="Dani-NRos/vigia-mesh"
RAMA="main"
BASE="/opt/vigia"
ETC="/etc/vigia"
DATOS="/var/lib/vigia"
SERVICIO="vigia-servidor"
# Descargas de Node: nodejs.org, o un espejo con la misma estructura (VIGIA_NODE_DIST=https://…/dist).
NODE_DIST="${VIGIA_NODE_DIST:-https://nodejs.org/dist}"
TCP="" PUERTO="" RECONFIGURAR=0 DESINSTALAR=0 BORRAR=0 CODIGO_LOCAL="" NODE_LOCAL="" SIN_SYSTEMD=0

ayuda() {
  cat <<'FIN'
Instala o actualiza Vigía servidor. Opciones:
  --tcp HOST[:PUERTO]   el nodo por la red en vez de por USB
  --puerto RUTA|ID      el nodo por USB en ese puerto (/dev/serial/by-id/… o 239a:8029)
  --reconfigurar        reescribe /etc/vigia/servidor.json con lo anterior
  --rama RAMA           instala desde otra rama (por defecto, main)
  --desinstalar         quita el servicio y el programa (los datos se quedan)
  --borrar-datos        con --desinstalar, borra también datos y configuración
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
    systemctl disable --now "$SERVICIO" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICIO.service"
    systemctl daemon-reload
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
for orden in curl tar xz sha256sum; do
  command -v "$orden" >/dev/null || falla "falta «$orden»: instálalo (sudo apt install curl tar xz-utils coreutils) y repite"
done

# ── Node, propio de Vigía ──
mkdir -p "$BASE"
if [ -n "$NODE_LOCAL" ]; then
  [ -x "$NODE_LOCAL/bin/node" ] || falla "no hay $NODE_LOCAL/bin/node"
  rm -rf "$BASE/node"; cp -a "$NODE_LOCAL" "$BASE/node"
  dice "Node $("$BASE/node/bin/node" --version) copiado de $NODE_LOCAL"
else
  SUMAS="$(curl -fsSL "$NODE_DIST/latest-v$NODE_RAMA.x/SHASUMS256.txt")" || falla "no se pudo consultar $NODE_DIST (¿hay internet?)"
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
    curl -fsSL -o "$TMP/$FICHERO" "$NODE_DIST/$VERSION_NODE/$FICHERO"
    (cd "$TMP" && printf '%s\n' "$LINEA" | sha256sum -c --quiet -) || falla "la descarga de Node no coincide con su suma de comprobación"
    mkdir -p "$TMP/node" && tar -xJf "$TMP/$FICHERO" -C "$TMP/node" --strip-components=1
    rm -rf "$BASE/node" && mv "$TMP/node" "$BASE/node"
  fi
fi
NODE="$BASE/node/bin/node"
export PATH="$BASE/node/bin:$PATH"

# ── programa ──
mkdir -p "$BASE/versiones"
if [ -n "$CODIGO_LOCAL" ]; then
  [ -f "$CODIGO_LOCAL/codigo/servidor/package.json" ] || falla "$CODIGO_LOCAL no parece el repositorio de Vigía"
  ID="local-$(date +%Y%m%d-%H%M%S)"
  DEST="$BASE/versiones/$ID"
  mkdir -p "$DEST"
  # Solo el código: sin node_modules ni compilados de la copia local.
  tar -C "$CODIGO_LOCAL/codigo" --exclude=node_modules --exclude=dist -cf - . | tar -C "$DEST" -xf -
else
  COMMIT="$(curl -fsSL "https://api.github.com/repos/$REPO/commits/$RAMA" 2>/dev/null | grep -m1 '"sha"' | sed -E 's/.*"([0-9a-f]{40})".*/\1/' || true)"
  REF="${COMMIT:-$RAMA}"
  ID="$(date +%Y%m%d-%H%M%S)-${REF:0:7}"
  DEST="$BASE/versiones/$ID"
  dice "Descargando Vigía (rama $RAMA${COMMIT:+, ${COMMIT:0:7}})…"
  TMPC="$(mktemp -d)"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$TMPC" --strip-components=1 || falla "no se pudo descargar el programa de GitHub"
  mkdir -p "$DEST" && cp -a "$TMPC/codigo/." "$DEST/" && rm -rf "$TMPC"
fi
dice "Instalando lo que necesita el servidor…"
(cd "$DEST" && "$BASE/node/bin/npm" ci --omit=dev -w @vigia/servidor --no-audit --no-fund --loglevel=error) || falla "npm no pudo instalar las dependencias"
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
  "retencionDias": 90,
  "registro": "info"
}
EOF
  chmod 644 "$ETC/servidor.json"
  dice "Configuración en $ETC/servidor.json"
else
  [ -n "$TCP$PUERTO" ] && aviso "Ya había configuración en $ETC/servidor.json y se ha dejado tal cual. Para cambiarla, añade --reconfigurar."
  dice "Se mantiene la configuración de $ETC/servidor.json"
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
dice "Hecho. Para seguirlo:"
echo "    journalctl -u $SERVICIO -f          lo que va pasando"
echo "    vigia-servidor --puertos            los nodos enchufados por USB"
echo "    sudo systemctl restart $SERVICIO    tras cambiar $ETC/servidor.json"
