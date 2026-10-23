#!/usr/bin/env node
// Talaia Hub: start from the command line or from systemd. Each option has a Spanish and an English name.
//
//   talaia [--config /etc/talaia/config.json]
//   talaia --ports | --puertos             the nodes plugged in by USB
//   talaia --version
//   sudo talaia --password | --clave NAME  a new password for that user (made if it isn't there); ends their sessions
//   sudo talaia --users | --usuarios       the screen's users
//   sudo talaia --code | --codigo          the code to create the first user (exit 0; 3 if there are users already,
//                                          4 if the service hasn't made one yet)
//   sudo talaia --broker-init | --broker-inicial   this machine's broker's first dynamic-security.json (installer, Docker)
//   talaia --health | --salud              is the screen answering? (exit 0 or 1: Docker's health check)
//
// What it writes to the terminal goes in the terminal's language (LANG), or the server's if it says none (Docker).
// The service writes in the server's (Ajustes → Sistema); a new installation starts in the machine's.
import fs from "node:fs";
import path from "node:path";
import { leerConfig, RUTA_CONFIG, ErrorConfig, VARIABLES, idiomaDelEntorno } from "./config.js";
import { crearRegistro } from "./registro.js";
import { listarPuertos, describirPuerto } from "./puertos.js";
import { tx, setLanguage, localeOf } from "@talaia/nucleo/idioma.js";
import "./textos.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const ALIAS = { "--ports": "--puertos", "--password": "--clave", "--users": "--usuarios", "--code": "--codigo", "--broker-init": "--broker-inicial", "--health": "--salud" };
const args = process.argv.slice(2).map((a) => ALIAS[a] || a);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const delEntorno = idiomaDelEntorno();
setLanguage(delEntorno || "en");
// How the user runs these commands here.
const ORDEN = process.env.TALAIA_DOCKER ? "docker compose exec talaia talaia" : "sudo talaia";

if (args.includes("--version")) {
  console.log(`Talaia Hub ${VERSION} (Node ${process.versions.node})`);
  process.exit(0);
}

if (args.includes("--puertos")) {
  const lista = listarPuertos();
  if (!lista.length) console.log(tx("s.cli.noPorts"));
  for (const p of lista) console.log(`${tx(p.conocido ? "s.cli.portNode" : "s.cli.portOther").padEnd(6)} ${describirPuerto(p)}${p.fabricante ? ` · ${p.fabricante}` : ""}`);
  process.exit(0);
}

// node:sqlite arrives in Node 22.13 (without options) and 23.4.
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(tx("s.cli.oldNode", { v: process.versions.node }));
  process.exit(1);
}
// The «SQLite is experimental» warning at every start: it tells nothing in the journal.
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(`${w.name}: ${w.message}`); });

const rutaConfig = opcion("--config") || process.env.TALAIA_CONFIG || process.env.VIGIA_CONFIG || RUTA_CONFIG;
let config;
try {
  config = leerConfig(rutaConfig);
} catch (e) {
  console.error(tx("s.cli.badConfig", { e: e instanceof ErrorConfig ? e.message : e.stack }));
  process.exit(2);
}
if (args.includes("--salud")) {
  try {
    const r = await fetch(`http://127.0.0.1:${config.web.puerto}/api/salud`, { signal: AbortSignal.timeout(4000) });
    process.exit(r.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
const { rutaAlmacen, leerGuardado } = await import("./almacen.js");
// The server's language, if it has one already (to write in it from the first line).
const guardado = leerGuardado(rutaAlmacen(config.datos), "settings")?.language;
if (["--clave", "--usuarios", "--codigo", "--broker-inicial"].some((o) => args.includes(o))) {
  if (!delEntorno && guardado) setLanguage(guardado);
  process.exit(await usuariosTerminal());
}
if (guardado) setLanguage(guardado);
const registro = crearRegistro({ nivel: config.registro });
// A promise rejected and not handled (usually the library's, when the link drops) is noted, and on it goes.
process.on("unhandledRejection", (e) => registro.error(tx("s.cli.unhandled", { e: e?.stack || e })));
// An exception not handled leaves the state in doubt: noted, and out; systemd starts it again in 5 s.
process.on("uncaughtException", (e) => { registro.error(tx("s.cli.uncaught", { e: e?.stack || e })); process.exit(70); });

const variables = VARIABLES.filter((n) => process.env[n]?.trim());
const cfg = `${fs.existsSync(rutaConfig) ? rutaConfig : tx("s.cli.cfgDefault")}${variables.length ? ` + ${variables.join(", ")}` : ""}`;
registro.info(tx("s.cli.start", { v: VERSION, node: process.versions.node, cfg, data: config.datos }));
const { crearTalaia } = await import("./talaia.js");
let talaia;
try {
  // A new installation starts in the machine's language (in Docker, unless LANG says otherwise, English).
  talaia = await crearTalaia(config, registro, { idiomaNuevo: delEntorno || "en" });
} catch (e) {
  registro.error(tx("s.cli.startFail", { e: e.message }));
  if (e.code === "EACCES") registro.error(tx("s.cli.noWrite", { dir: config.datos }));
  process.exit(1);
}
talaia.arrancar();
const { crearWeb, direcciones } = await import("./web.js");
const web = crearWeb(talaia, config, registro);
try {
  const puerto = await web.escuchar();
  const dirs = direcciones(puerto);
  registro.info(tx("s.j.screen", { where: dirs.length ? dirs.join(" · ") : tx("s.j.port", { n: puerto }) }));
} catch (e) {
  registro.error(tx("s.j.screenFail", { n: config.web.puerto, why: e.code === "EADDRINUSE" ? tx("s.j.portBusy") : e.message }));
}

let parando = false;
async function parar(senal) {
  if (parando) return;
  parando = true;
  registro.info(tx("s.j.stopping", { signal: senal }));
  const t = setTimeout(() => process.exit(0), 5000);
  try { await web.cerrar(); await talaia.detener(); } catch (e) { registro.error(tx("s.j.stopFail", { e: e.message })); }
  clearTimeout(t);
  process.exit(0);
}
process.on("SIGTERM", () => parar("SIGTERM"));
process.on("SIGINT", () => parar("SIGINT"));

/* ── users, from the terminal ── */

/** A line typed without showing it (a password); from a pipe, the next line. */
function leerOculto(pregunta, lineas) {
  if (!process.stdin.isTTY) return lineas.next().then((r) => (r.done ? "" : r.value));
  process.stdout.write(pregunta);
  return new Promise((resolve) => {
    const { stdin } = process;
    let s = "";
    const fin = (v) => { stdin.setRawMode(false); stdin.pause(); stdin.off("data", tecla); process.stdout.write("\n"); resolve(v); };
    const tecla = (trozo) => {
      for (const c of trozo) {
        if (c === "\r" || c === "\n") return fin(s);
        if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        s = c === "\u007f" || c === "\b" ? [...s].slice(0, -1).join("") : s + c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", tecla);
  });
}

async function usuariosTerminal() {
  const { abrirAlmacen } = await import("./almacen.js");
  const ruta = rutaAlmacen(config.datos); // the one there is: the service renames it when it starts
  let almacen;
  try {
    fs.accessSync(config.datos, fs.constants.R_OK | fs.constants.W_OK);
    almacen = abrirAlmacen(ruta);
  } catch (e) {
    console.error(tx("s.cli.cantOpen", { path: ruta, e: e.code || e.message, args: process.argv.slice(2).join(" ") }));
    return 1;
  }
  const { crearUsuarios } = await import("./usuarios.js");
  const usuarios = crearUsuarios({ almacen, datos: config.datos, codigoInicial: false });
  try {
    if (args.includes("--broker-inicial")) {
      // The broker's first users file, to standard output: Talaia's client (with the password it keeps) and the
      // users of before 2.0, with their same passwords.
      const { guardadoBroker, ficheroInicial } = await import("./mosquitto.js");
      process.stdout.write(`${JSON.stringify(ficheroInicial(guardadoBroker(almacen)), null, 2)}\n`);
      return 0;
    }
    if (args.includes("--usuarios")) {
      const lista = usuarios.lista();
      if (!lista.length) console.log(tx("s.cli.noUsers", { cmd: ORDEN }));
      const fecha = (t) => (t ? new Date(t).toLocaleString(localeOf()) : tx("s.cli.never"));
      for (const u of lista) console.log(tx("s.cli.userLine", { name: u.nombre, n: u.sesiones.length, when: fecha(u.usado) }));
      return 0;
    }
    if (args.includes("--codigo")) {
      if (usuarios.hay()) { console.log(tx("s.cli.haveUsers", { cmd: ORDEN })); return 3; }
      let cod = null;
      try { cod = fs.readFileSync(path.join(config.datos, "primer-usuario.txt"), "utf8").trim(); } catch { /* not made yet */ }
      if (!cod) {
        console.log(tx("s.cli.noCode", { restart: process.env.TALAIA_DOCKER ? "docker compose restart talaia" : "sudo systemctl restart talaia" }));
        return 4;
      }
      console.log(tx("s.cli.code", { code: cod }));
      return 0;
    }
    const nombre = opcion("--clave");
    if (!nombre || nombre.startsWith("--")) { console.error(tx("s.cli.noName", { cmd: ORDEN })); return 2; }
    const { createInterface } = await import("node:readline");
    const lineas = process.stdin.isTTY ? null : createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    const clave = await leerOculto(tx("s.cli.newPass", { name: nombre }), lineas);
    const otra = await leerOculto(tx("s.cli.again"), lineas);
    if (clave !== otra) { console.error(tx("s.cli.noMatch")); return 1; }
    const r = await usuarios.ponerDesdeTerminal(nombre, clave);
    if (!r.ok) { console.error(r.error); return 1; }
    console.log(tx("s.cli.passDone", { name: r.nombre }));
    return 0;
  } finally {
    almacen.cerrar();
  }
}
