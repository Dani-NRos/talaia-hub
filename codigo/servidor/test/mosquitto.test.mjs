// The broker of this machine: Talaia manages its users through Mosquitto's dynamic security plugin, as its own admin
// client. With a real Mosquitto if it's installed with the plugin (if not, only the pieces).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import mqtt from "mqtt";
import { cifrar, desdePasswd, claveValida, comprobarUsuario, ficheroInicial, USUARIO_INTERNO, ROL_DISPOSITIVOS } from "../src/mosquitto.js";
import { crearTalaia } from "../src/talaia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { instantanea } from "../src/sincro.js";
import { NodoFalso, hasta } from "./nodo-falso.mjs";

const hay = (orden) => spawnSync("sh", ["-c", `command -v ${orden}`]).status === 0;
const PLUGIN = (spawnSync("sh", ["-c", "find /usr/lib /usr/local/lib -name mosquitto_dynamic_security.so 2>/dev/null | head -1"]).stdout || "").toString().trim();
const MOSQUITTO = hay("mosquitto") && !!PLUGIN;
const MAIN = new URL("../src/main.js", import.meta.url).pathname;

/** A line of a Mosquitto password file, as mosquitto_passwd writes it (up to 2.0, Talaia kept these). */
function lineaPasswd(clave) {
  const sal = crypto.randomBytes(12);
  return `$7$101$${sal.toString("base64")}$${crypto.pbkdf2Sync(clave, sal, 101, 64, "sha512").toString("base64")}`;
}

test("hashes as Mosquitto's; a password file line becomes the same hash; valid users", () => {
  const h = cifrar("Clave secreta ñ");
  assert.equal(h.iterations, 101);
  assert.equal(Buffer.from(h.salt, "base64").length, 12);
  assert.ok(claveValida("Clave secreta ñ", h));
  assert.ok(!claveValida("otra", h));
  assert.ok(claveValida("del viejo", desdePasswd(lineaPasswd("del viejo"))));
  assert.equal(desdePasswd("texto plano"), null);
  if (hay("mosquitto_passwd")) {
    // One made by mosquitto_passwd itself.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-pw-"));
    const f = path.join(dir, "pw");
    fs.writeFileSync(f, "", { mode: 0o600 });
    spawnSync("mosquitto_passwd", ["-b", f, "shelly", "Clave secreta ñ"]);
    assert.ok(claveValida("Clave secreta ñ", desdePasswd(fs.readFileSync(f, "utf8").trim().split(":").slice(1).join(":"))));
  }
  assert.equal(comprobarUsuario("shelly_salon", "12345678"), null);
  assert.match(comprobarUsuario("con espacio", "12345678"), /solo puede llevar/);
  assert.match(comprobarUsuario(USUARIO_INTERNO, "12345678"), /es el usuario de Talaia/);
  assert.match(comprobarUsuario("shelly", "corta"), /al menos 8/);
});

test("the first file: Talaia as admin, and the users of before 2.0 with their hashes", () => {
  const f = ficheroInicial({ interno: { clave: "la-de-talaia" }, usuarios: [{ nombre: "shelly", cifrada: lineaPasswd("del-shelly") }, { nombre: "talaia", cifrada: lineaPasswd("x") }, { nombre: "roto", cifrada: "nada" }] });
  assert.deepEqual(f.clients.map((c) => c.username), ["talaia", "shelly"]);
  assert.deepEqual(f.clients[0].roles.map((r) => r.rolename), ["admin", ROL_DISPOSITIVOS]);
  assert.deepEqual(f.clients[1].roles.map((r) => r.rolename), [ROL_DISPOSITIVOS]);
  assert.ok(claveValida("la-de-talaia", f.clients[0]));
  assert.ok(claveValida("del-shelly", f.clients[1]));
  // Devices: everything but «$» topics ($CONTROL among them); by default, nothing.
  const dispositivos = f.roles.find((r) => r.rolename === ROL_DISPOSITIVOS);
  assert.ok(dispositivos.acls.every((a) => a.topic === "#"));
  assert.equal(f.defaultACLAccess.publishClientSend, false);
  assert.equal(f.defaultACLAccess.subscribe, false);
});

const puertoLibre = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
/** Does that user get in? true, or the error. */
async function entra(puerto, usuario, clave) {
  try {
    const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { username: usuario, password: clave, reconnectPeriod: 0, connectTimeout: 3000 });
    await c.endAsync();
    return true;
  } catch (e) {
    return e.code ?? e.message;
  }
}
/** Mosquitto as the installer leaves it: with users only, managed by the plugin. As root in the tests. */
let salidaMq = ""; // what Mosquitto says, to show it if Talaia can't get in
function mosquitto(datos, puerto, fichero) {
  const conf = path.join(datos, "mosquitto.conf");
  fs.writeFileSync(conf, `listener ${puerto} 127.0.0.1\nallow_anonymous false\nplugin ${PLUGIN}\nplugin_opt_config_file ${fichero}\npersistence false\nlog_dest stderr\nuser ${os.userInfo().username}\n`);
  const p = spawn("mosquitto", ["-c", conf], { stdio: ["ignore", "pipe", "pipe"] });
  const apuntar = (d) => { salidaMq = (salidaMq + d).slice(-4000); };
  p.stdout.on("data", apuntar);
  p.stderr.on("data", apuntar);
  p.on("exit", (code, sig) => apuntar(`\n[mosquitto exited: ${code ?? sig}]\n`));
  return p;
}
/** hasta(), and if it doesn't happen, with what Mosquitto and Talaia said. */
async function hastaMq(cond, ms, que, estado) {
  try {
    await hasta(cond, ms, que);
  } catch (e) {
    e.message += `\nMosquitto (${PLUGIN}):\n${salidaMq}\nTalaia: ${JSON.stringify(estado())}`;
    throw e;
  }
}

test("with a real Mosquitto: the users of before stay, users are added, changed and removed at once", { skip: !MOSQUITTO && "no Mosquitto with the dynamic security plugin" }, async (t) => {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-mq-"));
  const puerto = await puertoLibre();
  const nodo = new NodoFalso();
  const puertoNodo = await nodo.escucharTcp();
  const fichero = path.join(datos, "dynamic-security.json");
  const dada = { receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, datos, mosquitto: { puerto } };
  const config = comprobar(dada);
  // As an install of before 2.0: Talaia's password and a Shelly's user, from the password file.
  const almacen = abrirAlmacen(path.join(datos, "talaia.db"));
  almacen.guardar("mosquitto", { interno: { clave: "la-clave-interna-de-antes", cifrada: lineaPasswd("la-clave-interna-de-antes") }, usuarios: [{ nombre: "viejo", cifrada: lineaPasswd("clave-del-viejo") }] });
  // The first users file, as the installer and the Docker image make it: `talaia --broker-inicial`.
  const cfg = path.join(datos, "config.json");
  fs.writeFileSync(cfg, JSON.stringify(dada));
  const r = spawnSync(process.execPath, [MAIN, "--config", cfg, "--broker-inicial"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).clients.map((c) => c.username), ["talaia", "viejo"]);
  fs.writeFileSync(fichero, r.stdout, { mode: 0o600 });
  const talaia = await crearTalaia(config, crearRegistro({ nivel: "error", salida: [] }), { almacen });
  let mq = mosquitto(datos, puerto, fichero);
  t.after(async () => { await talaia.detener(); await nodo.cerrar(); mq.kill(); });
  await new Promise((r) => setTimeout(r, 400));
  talaia.arrancar();

  const local = () => talaia.S.mqtt.brokers.find((b) => b.id === "local");
  assert.equal(local().nombre, "Este servidor");
  await hastaMq(() => local().estado.fase === "conectada", 15000, "Talaia connected to its broker", () => local().estado);
  await hasta(() => talaia.S.mqtt.local.usuarios.length === 1, 5000, "the users, from Mosquitto");
  assert.deepEqual(talaia.S.mqtt.local.usuarios, [{ nombre: "viejo" }]);
  assert.deepEqual(almacen.leer("mosquitto"), { interno: { clave: "la-clave-interna-de-antes" }, usuarios: [] }, "the old copy goes once Mosquitto has them");
  assert.equal(await entra(puerto, "viejo", "clave-del-viejo"), true, "the user of before gets in with the same password");
  assert.notEqual(await entra(puerto, null, null), true, "without a user, no");

  // A user for a Shelly: in at once, without reloading anything.
  assert.match((await talaia.mqtt.ponerUsuario("shelly", "corta")).error, /al menos 8/);
  assert.equal((await talaia.mqtt.ponerUsuario("shelly", "clave-del-shelly")).ok, true);
  assert.equal(await entra(puerto, "shelly", "clave-del-shelly"), true);
  assert.notEqual(await entra(puerto, "shelly", "otra-clave-mala"), true);
  // New password: the old one no longer works.
  assert.match((await talaia.mqtt.ponerUsuario("shelly", "clave-nueva-1")).toast, /Contraseña de «shelly» cambiada/);
  assert.equal(await entra(puerto, "shelly", "clave-nueva-1"), true);
  assert.notEqual(await entra(puerto, "shelly", "clave-del-shelly"), true);
  // What the screens see: names, no passwords or hashes.
  assert.deepEqual(talaia.S.mqtt.local.usuarios, [{ nombre: "shelly" }, { nombre: "viejo" }]);
  const foto = JSON.stringify(instantanea(talaia.S));
  assert.doesNotMatch(foto, /clave-nueva|"salt"|"iterations"/);
  assert.ok(!foto.includes(talaia.mqtt.brokers().find((b) => b.id === "local").clave), "Talaia's password doesn't go out");

  // A device can't make itself users through $CONTROL.
  const shelly = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { username: "shelly", password: "clave-nueva-1" });
  await shelly.publishAsync("$CONTROL/dynamic-security/v1", JSON.stringify({ commands: [{ command: "createClient", username: "intruso", password: "clave-intrusa" }] }));
  await new Promise((r) => setTimeout(r, 400));
  assert.notEqual(await entra(puerto, "intruso", "clave-intrusa"), true);
  // Home Assistant on this broker: «online» is seen by whoever gets in.
  assert.equal((await talaia.mqtt.configurarHA({ activado: true, broker: "local" })).ok, true);
  const visto = new Map();
  shelly.on("message", (tema, c) => visto.set(tema, c.toString()));
  await shelly.subscribeAsync("talaia/#");
  await hasta(() => visto.get("talaia/estado") === "online", 15000, "online on the local broker");
  await shelly.endAsync();
  assert.match((await talaia.mqtt.quitarBroker("local")).error, /no se puede quitar/);

  // Removing the user: out.
  assert.equal((await talaia.mqtt.quitarUsuario("shelly")).ok, true);
  assert.notEqual(await entra(puerto, "shelly", "clave-nueva-1"), true);
  assert.match((await talaia.mqtt.quitarUsuario("shelly")).error, /no existe/);

  // Mosquitto starts again: its users are kept (it saves them in its file) and Talaia gets back in by itself.
  mq.kill();
  await hasta(() => local().estado.fase !== "conectada", 10000, "broker gone");
  assert.match((await talaia.mqtt.ponerUsuario("otro", "clave-del-otro")).error, /no contesta/);
  mq = mosquitto(datos, puerto, fichero);
  await hastaMq(() => local().estado.fase === "conectada", 20000, "Talaia back in", () => local().estado);
  assert.equal(await entra(puerto, "viejo", "clave-del-viejo"), true);
  assert.notEqual(await entra(puerto, "shelly", "clave-nueva-1"), true);
  assert.ok(!fs.readFileSync(fichero, "utf8").includes("shelly"));
});
