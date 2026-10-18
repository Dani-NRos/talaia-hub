#!/usr/bin/env node
// Vigía servidor: arranque desde la línea de órdenes o desde systemd.
//
//   vigia-servidor [--config /etc/vigia/servidor.json]
//   vigia-servidor --puertos        lista los nodos enchufados por USB
//   vigia-servidor --version
import fs from "node:fs";
import { leerConfig, RUTA_CONFIG, ErrorConfig } from "./config.js";
import { crearRegistro } from "./registro.js";
import { listarPuertos, describirPuerto } from "./puertos.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (args.includes("--version")) {
  console.log(`Vigía servidor ${VERSION} (Node ${process.versions.node})`);
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
  console.error(`Vigía servidor necesita Node 22.13 o más reciente (tienes ${process.versions.node}). El instalador pone uno en /opt/vigia/node.`);
  process.exit(1);
}
// Aviso de «SQLite es experimental» en cada arranque: no aporta nada en el diario.
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(`${w.name}: ${w.message}`); });

const rutaConfig = opcion("--config") || process.env.VIGIA_CONFIG || RUTA_CONFIG;
let config;
try {
  config = leerConfig(rutaConfig);
} catch (e) {
  console.error(`Configuración no válida: ${e instanceof ErrorConfig ? e.message : e.stack}`);
  process.exit(2);
}
const registro = crearRegistro({ nivel: config.registro });
// Una promesa rechazada sin atender (suele ser de la librería, al cortarse el enlace) se apunta y se sigue.
process.on("unhandledRejection", (e) => registro.error(`Error sin atender: ${e?.stack || e}`));
// Una excepción sin atender deja el estado en duda: se apunta y se sale; systemd vuelve a arrancar en 5 s.
process.on("uncaughtException", (e) => { registro.error(`Excepción sin atender, se reinicia: ${e?.stack || e}`); process.exit(70); });

registro.info(`Vigía servidor ${VERSION} · Node ${process.versions.node} · configuración: ${fs.existsSync(rutaConfig) ? rutaConfig : "por defecto"} · datos: ${config.datos}`);
const { crearVigia } = await import("./vigia.js");
let vigia;
try {
  vigia = await crearVigia(config, registro);
} catch (e) {
  registro.error(`No se pudo arrancar: ${e.message}`);
  if (e.code === "EACCES") registro.error(`El usuario del servicio no puede escribir en ${config.datos}.`);
  process.exit(1);
}
vigia.arrancar();

let parando = false;
async function parar(senal) {
  if (parando) return;
  parando = true;
  registro.info(`Parando (${senal})…`);
  const t = setTimeout(() => process.exit(0), 5000);
  try { await vigia.detener(); } catch (e) { registro.error(`Al parar: ${e.message}`); }
  clearTimeout(t);
  process.exit(0);
}
process.on("SIGTERM", () => parar("SIGTERM"));
process.on("SIGINT", () => parar("SIGINT"));
