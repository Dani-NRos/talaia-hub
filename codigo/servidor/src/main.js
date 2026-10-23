#!/usr/bin/env node
// Talaia Hub: start from the command line or from systemd.
//
//   talaia [--config /etc/talaia/config.json]
//   talaia --puertos        lista los nodos enchufados por USB
//   talaia --version
//   sudo talaia --clave NOMBRE   contraseña nueva para ese usuario (lo crea si no está); cierra sus sesiones
//   sudo talaia --usuarios       los usuarios de la pantalla
//   sudo talaia --codigo         el código para crear el primer usuario
//   sudo talaia --broker-inicial el primer dynamic-security.json del broker de este equipo (instalador y Docker)
//   talaia --salud          is the screen answering? (exit 0 or 1: Docker's health check)
import fs from "node:fs";
import path from "node:path";
import { leerConfig, RUTA_CONFIG, ErrorConfig, VARIABLES } from "./config.js";
import { crearRegistro } from "./registro.js";
import { listarPuertos, describirPuerto } from "./puertos.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (args.includes("--version")) {
  console.log(`Talaia Hub ${VERSION} (Node ${process.versions.node})`);
  process.exit(0);
}

if (args.includes("--puertos")) {
  const lista = listarPuertos();
  if (!lista.length) console.log("No hay ningún puerto serie USB (ttyACM/ttyUSB). ¿Está el nodo enchufado con un cable de datos?");
  for (const p of lista) console.log(`${p.conocido ? "nodo  " : "otro  "} ${describirPuerto(p)}${p.fabricante ? ` · ${p.fabricante}` : ""}`);
  process.exit(0);
}

// node:sqlite llega en Node 22.13 (sin opciones) y en 23.4.
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`Talaia Hub necesita Node 22.13 o más reciente (tienes ${process.versions.node}). El instalador pone uno en /opt/talaia/node.`);
  process.exit(1);
}
// Aviso de «SQLite es experimental» en cada arranque: no aporta nada en el diario.
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(`${w.name}: ${w.message}`); });

const rutaConfig = opcion("--config") || process.env.TALAIA_CONFIG || process.env.VIGIA_CONFIG || RUTA_CONFIG;
let config;
try {
  config = leerConfig(rutaConfig);
} catch (e) {
  console.error(`Configuración no válida: ${e instanceof ErrorConfig ? e.message : e.stack}`);
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
if (["--clave", "--usuarios", "--codigo", "--broker-inicial"].some((o) => args.includes(o))) process.exit(await usuariosTerminal());
const registro = crearRegistro({ nivel: config.registro });
// Una promesa rechazada sin atender (suele ser de la librería, al cortarse el enlace) se apunta y se sigue.
process.on("unhandledRejection", (e) => registro.error(`Error sin atender: ${e?.stack || e}`));
// Una excepción sin atender deja el estado en duda: se apunta y se sale; systemd vuelve a arrancar en 5 s.
process.on("uncaughtException", (e) => { registro.error(`Excepción sin atender, se reinicia: ${e?.stack || e}`); process.exit(70); });

const variables = VARIABLES.filter((n) => process.env[n]?.trim());
registro.info(`Talaia Hub ${VERSION} · Node ${process.versions.node} · configuración: ${fs.existsSync(rutaConfig) ? rutaConfig : "por defecto"}${variables.length ? ` + ${variables.join(", ")}` : ""} · datos: ${config.datos}`);
const { crearTalaia } = await import("./talaia.js");
let talaia;
try {
  talaia = await crearTalaia(config, registro);
} catch (e) {
  registro.error(`No se pudo arrancar: ${e.message}`);
  if (e.code === "EACCES") registro.error(`El usuario del servicio no puede escribir en ${config.datos}.`);
  process.exit(1);
}
talaia.arrancar();
const { crearWeb, direcciones } = await import("./web.js");
const { tx } = await import("@talaia/nucleo/idioma.js"); // from here on, in the server's language (read by crearTalaia)
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

/* ── users, from the terminal (in Spanish until step 5, like the rest of what is written before starting) ── */

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
  const { abrirAlmacen, rutaAlmacen } = await import("./almacen.js");
  const ruta = rutaAlmacen(config.datos); // the one there is: the service renames it when it starts
  let almacen;
  try {
    fs.accessSync(config.datos, fs.constants.R_OK | fs.constants.W_OK);
    almacen = abrirAlmacen(ruta);
  } catch (e) {
    console.error(`No se puede abrir ${ruta} (${e.code || e.message}). Prueba con sudo: sudo talaia ${args.join(" ")}`);
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
      if (!lista.length) console.log("No hay usuarios todavía. Crea el primero desde la pantalla (sudo talaia --codigo) o aquí: sudo talaia --clave NOMBRE");
      const fecha = (t) => (t ? new Date(t).toLocaleString("es-ES") : "nunca");
      for (const u of lista) console.log(`${u.nombre} · ${u.sesiones.length} sesiones abiertas · último uso: ${fecha(u.usado)}`);
      return 0;
    }
    if (args.includes("--codigo")) {
      if (usuarios.hay()) { console.log("Ya hay usuarios: no hace falta código. Para cambiar una contraseña: sudo talaia --clave NOMBRE"); return 0; }
      let cod = null;
      try { cod = fs.readFileSync(path.join(config.datos, "primer-usuario.txt"), "utf8").trim(); } catch { /* not made yet */ }
      console.log(cod ? `Código para crear el primer usuario: ${cod}` : "Aún no hay código: arranca el servicio (sudo systemctl restart talaia) y vuelve a mirarlo.");
      return 0;
    }
    const nombre = opcion("--clave");
    if (!nombre || nombre.startsWith("--")) { console.error("Falta el nombre: sudo talaia --clave NOMBRE"); return 2; }
    const { createInterface } = await import("node:readline");
    const lineas = process.stdin.isTTY ? null : createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    const clave = await leerOculto(`Contraseña nueva para ${nombre}: `, lineas);
    const otra = await leerOculto("Otra vez: ", lineas);
    if (clave !== otra) { console.error("No coinciden. No se ha cambiado nada."); return 1; }
    const r = await usuarios.ponerDesdeTerminal(nombre, clave);
    if (!r.ok) { console.error(r.error); return 1; }
    console.log(`Hecho: ${r.nombre} ya puede entrar con esa contraseña. Sus sesiones abiertas se han cerrado.`);
    return 0;
  } finally {
    almacen.cerrar();
  }
}
