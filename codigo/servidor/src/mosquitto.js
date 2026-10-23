// The MQTT broker of this machine (Mosquitto, put there by the installer or by Docker compose): Talaia manages its
// users through Mosquitto's dynamic security plugin, talking to it over MQTT ($CONTROL/dynamic-security/v1) as its own
// admin client, «talaia». Mosquitto keeps the users (with their passwords hashed) in its dynamic-security.json and the
// screens see only their names; a user added or changed can connect at once, without reloading anything.
//
// Every device user gets the role «talaia-dispositivos»: publish and subscribe anywhere, as when Mosquitto read a
// password file, but not $CONTROL (the "#" of an ACL doesn't reach topics that start with "$"), so a device can't
// make itself users. Talaia's own client also has «admin», with $CONTROL.
//
// The first file (ficheroInicial) is made by Talaia: with the installer, `talaia --broker-inicial`; with Docker,
// Talaia itself writes it if it's missing. It carries the users of before 2.0 (Mosquitto's password file, which
// Talaia kept in SQLite), with the same hashes: their devices keep connecting with the same passwords.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tx } from "@talaia/nucleo/idioma.js";
import "./textos.js";

export const USUARIO_INTERNO = "talaia";
export const ROL_DISPOSITIVOS = "talaia-dispositivos";
const CONTROL = "$CONTROL/dynamic-security/v1";
const NOMBRE_OK = /^[A-Za-z0-9._-]{1,64}$/;
export const CLAVE_MIN = 8;
const ESPERA_MS = 5000;

/** A password hashed as Mosquitto does (2.0): PBKDF2-SHA512, 101 rounds, 12-byte salt. { password, salt, iterations } */
export function cifrar(clave, sal = crypto.randomBytes(12), vueltas = 101) {
  const h = crypto.pbkdf2Sync(Buffer.from(String(clave), "utf8"), sal, vueltas, 64, "sha512");
  return { password: h.toString("base64"), salt: sal.toString("base64"), iterations: vueltas };
}
/** The same, from a line of a Mosquitto password file («$7$101$sal$hash»), or null if it isn't one. */
export function desdePasswd(cifrada) {
  const [vacio, tipo, vueltas, sal, h] = String(cifrada).split("$");
  if (vacio !== "" || tipo !== "7" || !sal || !h || !(Number(vueltas) > 0)) return null;
  return { password: h, salt: sal, iterations: Number(vueltas) };
}
/** Is that the password of that hash? (for the tests) */
export function claveValida(clave, { password, salt, iterations }) {
  const d = crypto.pbkdf2Sync(Buffer.from(String(clave), "utf8"), Buffer.from(salt, "base64"), iterations, 64, "sha512");
  return crypto.timingSafeEqual(d, Buffer.from(password, "base64"));
}

const acl = (acltype, topic) => ({ acltype, topic, allow: true });
const ROLES = [
  { rolename: "admin", acls: [acl("publishClientSend", "$CONTROL/dynamic-security/#"), acl("publishClientReceive", "$CONTROL/dynamic-security/#"), acl("subscribePattern", "$CONTROL/dynamic-security/#"), acl("publishClientReceive", "$SYS/#"), acl("subscribePattern", "$SYS/#")] },
  { rolename: ROL_DISPOSITIVOS, acls: [acl("publishClientSend", "#"), acl("publishClientReceive", "#"), acl("subscribePattern", "#"), acl("unsubscribePattern", "#")] },
];

/**
 * The first dynamic-security.json: Talaia's admin client (its password, kept in SQLite) and the users of before 2.0.
 * guardado: what SQLite has under «mosquitto» ({ interno: { clave }, usuarios: [{ nombre, cifrada }] }).
 */
export function ficheroInicial(guardado) {
  const clientes = [{ username: USUARIO_INTERNO, textName: "Talaia", ...cifrar(guardado.interno.clave), roles: [{ rolename: "admin" }, { rolename: ROL_DISPOSITIVOS }] }];
  for (const u of guardado.usuarios || []) {
    const h = desdePasswd(u.cifrada);
    if (h && NOMBRE_OK.test(u.nombre) && u.nombre !== USUARIO_INTERNO) clientes.push({ username: u.nombre, ...h, roles: [{ rolename: ROL_DISPOSITIVOS }] });
  }
  return {
    clients: clientes,
    roles: ROLES,
    defaultACLAccess: { publishClientSend: false, publishClientReceive: true, subscribe: false, unsubscribe: true },
  };
}

/** Why a new user isn't valid (or null if it is). */
export function comprobarUsuario(nombre, clave) {
  if (!NOMBRE_OK.test(String(nombre || ""))) return tx("s.mq.badUser");
  if (nombre === USUARIO_INTERNO || nombre === "vigia-servidor") return tx("s.mq.internal", { name: nombre });
  if (clave != null && String(clave).length < CLAVE_MIN) return tx("s.mq.passShort", { n: CLAVE_MIN });
  if (clave != null && /[\r\n]/.test(clave)) return tx("s.mq.passLines");
  return null;
}

/** This machine's addresses on the home network, to set up the devices («192.168.1.50»). */
export function direccionesLocales() {
  const out = [];
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const a of lista || []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

/** What SQLite keeps («mosquitto»): Talaia's password on its broker, made the first time. */
export function guardadoBroker(almacen) {
  let g = almacen.leer("mosquitto", null);
  if (!g?.interno?.clave) {
    g = { interno: { clave: crypto.randomBytes(24).toString("base64url") }, usuarios: g?.usuarios || [] };
    almacen.guardar("mosquitto", g);
  }
  return g;
}

/**
 * config: the server's (with config.mosquitto: { puerto, fichero? }). almacen: SQLite. registro: the journal.
 * With config.mosquitto.fichero (Docker), the first dynamic-security.json is written there if it isn't.
 * Returns { url, puerto, interno, usuarios(), enganchar(id, conexion), ponerUsuario, quitarUsuario, alCambiar }.
 */
export function crearBrokerLocal({ config, almacen, registro }) {
  const guardado = guardadoBroker(almacen);
  const ruta = config.mosquitto.fichero;
  if (ruta && !fs.existsSync(ruta)) {
    try {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      fs.writeFileSync(ruta, `${JSON.stringify(ficheroInicial(guardado), null, 2)}\n`, { mode: 0o600 });
      registro.info(tx("s.j.mqFirstFile", { file: ruta }));
    } catch (e) {
      registro.error(tx("s.j.mqWriteFail", { file: ruta, e: e.message }));
    }
  }

  let conexion = null;
  let lista = []; // the device users Mosquitto has (names only)
  let cambio = () => {};
  const pendientes = new Map(); // correlationData → resolve
  let n = 0;

  /** Sends commands to the plugin and waits for its answers (in the same order). null if the broker doesn't answer. */
  async function mandar(comandos) {
    if (!conexion?.conectada) return null;
    const ids = comandos.map(() => `t${++n}-${Date.now().toString(36)}`);
    const esperas = ids.map((id) => new Promise((resolve) => {
      const t = setTimeout(() => { pendientes.delete(id); resolve(null); }, ESPERA_MS);
      pendientes.set(id, (r) => { clearTimeout(t); resolve(r); });
    }));
    const ok = await conexion.publicar(CONTROL, { commands: comandos.map((c, i) => ({ ...c, correlationData: ids[i] })) }, { qos: 1 });
    if (!ok) { for (const id of ids) pendientes.get(id)?.(null); return null; }
    const r = await Promise.all(esperas);
    return r.some((x) => x == null) ? null : r;
  }
  function respuesta(tema, carga) {
    let j;
    try { j = JSON.parse(carga.toString("utf8")); } catch { return; }
    for (const r of j?.responses || []) pendientes.get(r.correlationData)?.(r);
  }

  /** The users Mosquitto has, again (and its role for devices, if it doesn't have it: a file made elsewhere). */
  async function refrescar() {
    const r = await mandar([{ command: "listClients", verbose: false, count: -1 }, { command: "getRole", rolename: ROL_DISPOSITIVOS }]);
    if (!r) return;
    if (r[0].error) { registro.aviso(tx("s.j.mqControl", { e: r[0].error })); return; }
    lista = (r[0].data?.clients || []).filter((u) => u !== USUARIO_INTERNO).sort((a, b) => a.localeCompare(b));
    if (r[1].error) await mandar([{ command: "createRole", rolename: ROL_DISPOSITIVOS, acls: ROLES[1].acls }]);
    // Mosquitto has the users now: the copy of before 2.0 goes (it would bring back removed users in a new file).
    if (guardado.usuarios?.length || guardado.interno.cifrada) {
      guardado.usuarios = [];
      delete guardado.interno.cifrada;
      almacen.guardar("mosquitto", guardado);
    }
    cambio();
  }

  const fallo = (r) => ({ ok: false, error: r ? tx("s.mq.refused", { e: r.error }) : tx("s.mq.noAnswer") });

  return {
    url: `mqtt://${config.mosquitto.host.includes(":") ? `[${config.mosquitto.host}]` : config.mosquitto.host}:${config.mosquitto.puerto}`,
    puerto: config.mosquitto.puerto,
    interno: { usuario: USUARIO_INTERNO, clave: guardado.interno.clave },
    usuarios: () => lista.map((nombre) => ({ nombre })),
    /** mqtt.js tells when the users list changed (to the screens). */
    set alCambiar(f) { cambio = f; },
    /** An «enganche» of mqtt.js: on this machine's broker, listen to the plugin's answers and read the users. */
    enganchar(id, c) {
      if (id !== "local") return null;
      conexion = c;
      const soltar = c.suscribir(`${CONTROL}/response`, respuesta);
      const alConectar = () => { refrescar(); };
      c.on("conectada", alConectar);
      return () => { soltar(); c.off("conectada", alConectar); if (conexion === c) conexion = null; };
    },
    /** Adds a user or changes their password. */
    async ponerUsuario(nombre, clave) {
      nombre = String(nombre || "").trim();
      const error = comprobarUsuario(nombre, String(clave ?? ""));
      if (error) return { ok: false, error };
      const habia = lista.includes(nombre);
      const [r] = (await mandar([habia
        ? { command: "setClientPassword", username: nombre, password: String(clave) }
        : { command: "createClient", username: nombre, password: String(clave), roles: [{ rolename: ROL_DISPOSITIVOS }] }])) || [];
      if (!r || r.error) return fallo(r);
      await refrescar();
      registro.info(tx(habia ? "s.j.mqPass" : "s.j.mqUser", { name: nombre }));
      return { ok: true, toast: tx(habia ? "s.mq.passChanged" : "s.mq.userCreated", { name: nombre }) };
    },
    async quitarUsuario(nombre) {
      if (!lista.includes(nombre)) return { ok: false, error: tx("s.mq.noUser") };
      const [r] = (await mandar([{ command: "deleteClient", username: nombre }])) || [];
      if (!r || r.error) return fallo(r);
      await refrescar();
      registro.info(tx("s.j.mqUserRemoved", { name: nombre }));
      return { ok: true, toast: tx("s.mq.userRemoved", { name: nombre }) };
    },
    refrescar,
  };
}
