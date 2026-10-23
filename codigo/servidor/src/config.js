// Configuración del servidor: un JSON pequeño (por defecto /etc/talaia/config.json). Lo que no se ponga, por defecto.
//
// {
//   "receptor": { "tipo": "usb", "puerto": "auto" },        // o "/dev/serial/by-id/…", o "239a:8029"
//   "receptor": { "tipo": "tcp", "host": "192.168.1.60", "puerto": 4403 },
//   "web": { "puerto": 4404 },
//   "datos": "/var/lib/talaia",
//   "retencionDias": 365,
//   "registro": "info",                                      // o "depurar"
//   "mosquitto": { "puerto": 1883, "host": "127.0.0.1" }     // el broker MQTT de este equipo, que gestiona Talaia
// }
//
// «mosquitto» lo pone el instalador cuando instala Mosquitto: Talaia gestiona sus usuarios por el plugin de seguridad
// dinámica (mosquitto.js). «host»: dónde está (con Docker, el nombre de su contenedor).
//
// With Docker, the environment can say the same (and it wins over the file): see desdeEntorno.
import fs from "node:fs";
import { tx } from "@talaia/nucleo/idioma.js";
import "./textos.js";

export const RUTA_CONFIG = "/etc/talaia/config.json";

export const DEFECTO = {
  receptor: { tipo: "usb", puerto: "auto" },
  web: { puerto: 4404, escuchar: "0.0.0.0" },
  datos: "/var/lib/talaia",
  retencionDias: 365,
  registro: "info",
  mosquitto: null,
};

export class ErrorConfig extends Error {}

/**
 * What the environment says (Docker), as a piece of configuration:
 *   TALAIA_RECEIVER        usb · usb:/dev/ttyACM0 · usb:239a:8029 · tcp:192.168.1.60 · tcp:192.168.1.60:4403
 *   TALAIA_WEB_PORT        4404
 *   TALAIA_DATA            /data
 *   TALAIA_BROKER          mosquitto · mosquitto:1883 · off   (this machine's broker, whose users Talaia manages)
 *   TALAIA_RETENTION_DAYS  365
 *   TALAIA_LOG_LEVEL       debug · info · warn · error
 */
export const VARIABLES = ["TALAIA_RECEIVER", "TALAIA_WEB_PORT", "TALAIA_DATA", "TALAIA_BROKER", "TALAIA_RETENTION_DAYS", "TALAIA_LOG_LEVEL"];
export function desdeEntorno(env = process.env) {
  const v = (n) => String(env[n] ?? "").trim();
  const entero = (n) => {
    if (!/^\d+$/.test(v(n))) throw new ErrorConfig(`${n} tiene que ser un número (pone "${v(n)}")`);
    return Number(v(n));
  };
  // «host», «host:1234», «[fe80::1]:1234»
  const hostPuerto = (n, texto) => {
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(texto);
    if (!m) throw new ErrorConfig(`${n}: falta el nombre o la IP (pone "${v(n)}")`);
    return { host: m[1].replace(/^\[(.*)\]$/, "$1"), ...(m[2] ? { puerto: Number(m[2]) } : {}) };
  };
  const c = {};
  if (v("TALAIA_RECEIVER")) {
    const [tipo, ...resto] = v("TALAIA_RECEIVER").split(":");
    if (tipo === "usb") c.receptor = { tipo: "usb", puerto: resto.join(":") || "auto" };
    else if (tipo === "tcp") c.receptor = { tipo: "tcp", ...hostPuerto("TALAIA_RECEIVER", resto.join(":")) };
    else throw new ErrorConfig(`TALAIA_RECEIVER tiene que ser "usb", "usb:/dev/ttyACM0", "usb:239a:8029" o "tcp:IP" (pone "${v("TALAIA_RECEIVER")}")`);
  }
  if (v("TALAIA_WEB_PORT")) c.web = { puerto: entero("TALAIA_WEB_PORT") };
  if (v("TALAIA_DATA")) c.datos = v("TALAIA_DATA");
  if (v("TALAIA_BROKER")) c.mosquitto = v("TALAIA_BROKER") === "off" ? null : hostPuerto("TALAIA_BROKER", v("TALAIA_BROKER"));
  if (v("TALAIA_RETENTION_DAYS")) c.retencionDias = entero("TALAIA_RETENTION_DAYS");
  if (v("TALAIA_LOG_LEVEL")) {
    const nivel = { debug: "depurar", info: "info", warn: "aviso", warning: "aviso", error: "error", depurar: "depurar", aviso: "aviso" }[v("TALAIA_LOG_LEVEL").toLowerCase()];
    if (!nivel) throw new ErrorConfig(`TALAIA_LOG_LEVEL tiene que ser debug, info, warn o error (pone "${v("TALAIA_LOG_LEVEL")}")`);
    c.registro = nivel;
  }
  return c;
}

/** Lee y comprueba la configuración (el fichero y, encima, el entorno). Sin fichero, la de por defecto (salvo que se pida que exista). */
export function leerConfig(ruta = RUTA_CONFIG, { obligatoria = false, entorno = process.env } = {}) {
  let dada = {};
  if (fs.existsSync(ruta)) {
    try {
      dada = JSON.parse(fs.readFileSync(ruta, "utf8"));
    } catch (e) {
      throw new ErrorConfig(`${ruta} no es un JSON válido: ${e.message}`);
    }
  } else if (obligatoria) {
    throw new ErrorConfig(`no existe ${ruta}`);
  }
  const env = desdeEntorno(entorno);
  return comprobar({
    ...dada,
    ...env,
    ...(env.web ? { web: { ...(dada.web || {}), ...env.web } } : {}),
  });
}

export function comprobar(dada) {
  const c = {
    ...DEFECTO,
    ...dada,
    receptor: { ...(dada.receptor?.tipo === "tcp" ? { tipo: "tcp", puerto: 4403 } : DEFECTO.receptor), ...(dada.receptor || {}) },
    web: { ...DEFECTO.web, ...(dada.web || {}) },
  };
  if (c.mosquitto) {
    c.mosquitto = { puerto: 1883, host: "127.0.0.1", ...c.mosquitto };
    delete c.mosquitto.usuarios; // the password file Talaia wrote, up to 2.0: no longer used
    if (!Number.isInteger(c.mosquitto.puerto) || c.mosquitto.puerto < 1 || c.mosquitto.puerto > 65535) throw new ErrorConfig("mosquitto.puerto tiene que ser un número de puerto (por defecto 1883)");
    if (typeof c.mosquitto.host !== "string" || !/^[A-Za-z0-9.:_-]{1,253}$/.test(c.mosquitto.host)) throw new ErrorConfig("mosquitto.host tiene que ser un nombre o una IP (por defecto 127.0.0.1)");
  }
  const r = c.receptor;
  if (r.tipo !== "usb" && r.tipo !== "tcp") throw new ErrorConfig(`receptor.tipo tiene que ser "usb" o "tcp" (pone "${r.tipo}")`);
  if (r.tipo === "tcp") {
    if (!r.host || typeof r.host !== "string") throw new ErrorConfig('para el receptor por TCP falta "host": la IP o el nombre del nodo');
    if (!Number.isInteger(r.puerto) || r.puerto < 1 || r.puerto > 65535) throw new ErrorConfig("receptor.puerto tiene que ser un número de puerto (por defecto 4403)");
  } else {
    const p = String(r.puerto ?? "auto");
    if (!(p === "auto" || p.startsWith("/") || /^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(p))) {
      throw new ErrorConfig(`receptor.puerto por USB tiene que ser "auto", una ruta como "/dev/ttyACM0" o un id USB como "239a:8029" (pone "${p}")`);
    }
    r.puerto = p;
  }
  if (!Number.isInteger(c.web.puerto) || c.web.puerto < 1 || c.web.puerto > 65535) throw new ErrorConfig("web.puerto tiene que ser un número de puerto");
  if (typeof c.datos !== "string" || !c.datos) throw new ErrorConfig("datos tiene que ser una carpeta");
  if (!(Number.isFinite(c.retencionDias) && c.retencionDias >= 1)) throw new ErrorConfig("retencionDias tiene que ser un número de días (1 o más)");
  if (!["depurar", "info", "aviso", "error"].includes(c.registro)) throw new ErrorConfig('registro tiene que ser "depurar", "info", "aviso" o "error"');
  return c;
}

/** «por TCP en 192.168.1.60:4403», «por USB», «por USB en /dev/ttyACM0»: para el registro. */
export const describirReceptor = (r) => (r.tipo === "tcp" ? tx("s.rx.desc.tcp", { addr: `${r.host}:${r.puerto}` }) : r.puerto === "auto" ? tx("s.rx.desc.usb") : tx("s.rx.desc.usbAt", { port: r.puerto }));
