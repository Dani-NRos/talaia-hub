// The server's configuration: a small JSON (by default /etc/talaia/config.json). Whatever isn't there, by default.
// Its keys can be written in Spanish or in English (inside, the Spanish ones):
//
// {                                                          {
//   "receptor": { "tipo": "usb", "puerto": "auto" },           "receiver": { "type": "usb", "port": "auto" },
//   "web": { "puerto": 4404 },                                 "web": { "port": 4404 },
//   "datos": "/var/lib/talaia",                                "data": "/var/lib/talaia",
//   "retencionDias": 365,                                      "retentionDays": 365,
//   "registro": "info",                                        "logLevel": "info",
//   "mosquitto": { "puerto": 1883, "host": "127.0.0.1" }       "broker": { "port": 1883, "host": "127.0.0.1" }
// }                                                          }
//
// The receiver by USB: "auto", a path ("/dev/serial/by-id/…") or a USB id ("239a:8029"); over the network:
// { "tipo": "tcp", "host": "192.168.1.60", "puerto": 4403 }. «mosquitto» (this machine's broker, whose users Talaia
// manages through Mosquitto's dynamic security plugin: mosquitto.js) is put there by the installer; «host» is where it
// is (with Docker, its container's name). With Docker, the environment says the same and wins over the file:
// desdeEntorno.
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

const NIVELES = { debug: "depurar", info: "info", warn: "aviso", warning: "aviso", error: "error", depurar: "depurar", aviso: "aviso" };

/** The English keys, as the Spanish ones (a Spanish key wins if both are there). */
function enEspanol(dada) {
  if (!dada || typeof dada !== "object") return dada;
  const sub = (o, mapa) => {
    if (!o || typeof o !== "object") return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) if (!(mapa[k] && Object.hasOwn(o, mapa[k]))) out[mapa[k] || k] = v;
    return out;
  };
  const c = sub(dada, { receiver: "receptor", data: "datos", retentionDays: "retencionDias", logLevel: "registro", broker: "mosquitto" });
  if (c.receptor) c.receptor = sub(c.receptor, { type: "tipo", port: "puerto" });
  if (c.web) c.web = sub(c.web, { port: "puerto", listen: "escuchar" });
  if (c.mosquitto) c.mosquitto = sub(c.mosquitto, { port: "puerto" });
  if (typeof c.registro === "string" && NIVELES[c.registro]) c.registro = NIVELES[c.registro];
  return c;
}

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
    if (!/^\d+$/.test(v(n))) throw new ErrorConfig(tx("s.cfg.envNumber", { name: n, value: v(n) }));
    return Number(v(n));
  };
  // «host», «host:1234», «[fe80::1]:1234»
  const hostPuerto = (n, texto) => {
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(texto);
    if (!m) throw new ErrorConfig(tx("s.cfg.envHost", { name: n, value: v(n) }));
    return { host: m[1].replace(/^\[(.*)\]$/, "$1"), ...(m[2] ? { puerto: Number(m[2]) } : {}) };
  };
  const c = {};
  if (v("TALAIA_RECEIVER")) {
    const [tipo, ...resto] = v("TALAIA_RECEIVER").split(":");
    if (tipo === "usb") c.receptor = { tipo: "usb", puerto: resto.join(":") || "auto" };
    else if (tipo === "tcp") c.receptor = { tipo: "tcp", ...hostPuerto("TALAIA_RECEIVER", resto.join(":")) };
    else throw new ErrorConfig(tx("s.cfg.envReceiver", { value: v("TALAIA_RECEIVER") }));
  }
  if (v("TALAIA_WEB_PORT")) c.web = { puerto: entero("TALAIA_WEB_PORT") };
  if (v("TALAIA_DATA")) c.datos = v("TALAIA_DATA");
  if (v("TALAIA_BROKER")) c.mosquitto = v("TALAIA_BROKER") === "off" ? null : hostPuerto("TALAIA_BROKER", v("TALAIA_BROKER"));
  if (v("TALAIA_RETENTION_DAYS")) c.retencionDias = entero("TALAIA_RETENTION_DAYS");
  if (v("TALAIA_LOG_LEVEL")) {
    const nivel = NIVELES[v("TALAIA_LOG_LEVEL").toLowerCase()];
    if (!nivel) throw new ErrorConfig(tx("s.cfg.envLog", { value: v("TALAIA_LOG_LEVEL") }));
    c.registro = nivel;
  }
  return c;
}

/** Reads and checks the configuration (the file and, over it, the environment). With no file, the default one (unless it must exist). */
export function leerConfig(ruta = RUTA_CONFIG, { obligatoria = false, entorno = process.env } = {}) {
  let dada = {};
  if (fs.existsSync(ruta)) {
    try {
      dada = enEspanol(JSON.parse(fs.readFileSync(ruta, "utf8")));
    } catch (e) {
      throw new ErrorConfig(tx("s.cfg.json", { file: ruta, e: e.message }));
    }
  } else if (obligatoria) {
    throw new ErrorConfig(tx("s.cfg.missing", { file: ruta }));
  }
  const env = desdeEntorno(entorno);
  return comprobar({
    ...dada,
    ...env,
    ...(env.web ? { web: { ...(dada.web || {}), ...env.web } } : {}),
  });
}

export function comprobar(dada) {
  dada = enEspanol(dada);
  const c = {
    ...DEFECTO,
    ...dada,
    receptor: { ...(dada.receptor?.tipo === "tcp" ? { tipo: "tcp", puerto: 4403 } : DEFECTO.receptor), ...(dada.receptor || {}) },
    web: { ...DEFECTO.web, ...(dada.web || {}) },
  };
  if (c.mosquitto) {
    c.mosquitto = { puerto: 1883, host: "127.0.0.1", ...c.mosquitto };
    delete c.mosquitto.usuarios; // the password file Talaia wrote, up to 2.0: no longer used
    if (!Number.isInteger(c.mosquitto.puerto) || c.mosquitto.puerto < 1 || c.mosquitto.puerto > 65535) throw new ErrorConfig(tx("s.cfg.mqPort"));
    if (typeof c.mosquitto.host !== "string" || !/^[A-Za-z0-9.:_-]{1,253}$/.test(c.mosquitto.host)) throw new ErrorConfig(tx("s.cfg.mqHost"));
  }
  const r = c.receptor;
  if (r.tipo !== "usb" && r.tipo !== "tcp") throw new ErrorConfig(tx("s.cfg.rxType", { value: r.tipo }));
  if (r.tipo === "tcp") {
    if (!r.host || typeof r.host !== "string") throw new ErrorConfig(tx("s.cfg.rxHost"));
    if (!Number.isInteger(r.puerto) || r.puerto < 1 || r.puerto > 65535) throw new ErrorConfig(tx("s.cfg.rxPort"));
  } else {
    const p = String(r.puerto ?? "auto");
    if (!(p === "auto" || p.startsWith("/") || /^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(p))) throw new ErrorConfig(tx("s.cfg.rxUsb", { value: p }));
    r.puerto = p;
  }
  if (!Number.isInteger(c.web.puerto) || c.web.puerto < 1 || c.web.puerto > 65535) throw new ErrorConfig(tx("s.cfg.webPort"));
  if (typeof c.datos !== "string" || !c.datos) throw new ErrorConfig(tx("s.cfg.data"));
  if (!(Number.isFinite(c.retencionDias) && c.retencionDias >= 1)) throw new ErrorConfig(tx("s.cfg.retention"));
  if (!["depurar", "info", "aviso", "error"].includes(c.registro)) throw new ErrorConfig(tx("s.cfg.log"));
  return c;
}

/**
 * The language a terminal or a service asks for with its locale (LC_ALL, LC_MESSAGES, LANG): "es" (also for Catalan,
 * Basque and Galician, as the screen does), "en", or null if it says none (unset, C, POSIX).
 */
export function idiomaDelEntorno(env = process.env) {
  const l = String(env.LC_ALL || env.LC_MESSAGES || env.LANG || "").trim().toLowerCase();
  if (!l || l === "c" || l === "posix" || l.startsWith("c.")) return null;
  return /^(es|ca|eu|gl)([_.@-]|$)/.test(l) ? "es" : "en";
}

/** «por TCP en 192.168.1.60:4403», «por USB», «por USB en /dev/ttyACM0»: para el registro. */
export const describirReceptor = (r) => (r.tipo === "tcp" ? tx("s.rx.desc.tcp", { addr: `${r.host}:${r.puerto}` }) : r.puerto === "auto" ? tx("s.rx.desc.usb") : tx("s.rx.desc.usbAt", { port: r.puerto }));
