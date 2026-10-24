// Orders over the mesh (2.1b): text messages that the simulated node «hears» (direct ones encrypted with a key, or on
// a channel), a fake Shelly on a broker in memory, and what the server answers back over the (simulated) mesh.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import { Aedes } from "aedes";
import mqtt from "mqtt";
import { create } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import { crearTalaia } from "../src/talaia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { instantanea } from "../src/sincro.js";
import { NodoFalso, hasta, ME, CASETA, AVISADO, VECINO, PORT } from "./nodo-falso.mjs";

const M = Protobuf.Mesh;
const KEY = (b) => new Uint8Array(32).fill(b); // the simulated node's keys: CASETA 2, AVISADO 3
const ORDEN = { tema: "shellyplug01/command/switch:0", on: "on", off: "off" };

async function broker(t) {
  const aedes = await Aedes.createBroker();
  const srv = net.createServer(aedes.handle);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise((r) => aedes.close(r)); await new Promise((r) => srv.close(r)); });
  return srv.address().port;
}
async function shellyFalso(t, puerto) {
  const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { clientId: `shelly-${Math.random()}` });
  t.after(() => c.endAsync());
  const recibidas = [];
  let output = false;
  const estado = () => c.publishAsync("shellyplug01/status/switch:0", JSON.stringify({ id: 0, output }));
  c.on("message", (tema, carga) => {
    const m = carga.toString();
    if (m === "on" || m === "off") { recibidas.push(m); output = m === "on"; estado(); } else if (m === "status_update") estado();
  });
  await c.subscribeAsync("shellyplug01/command/#");
  return { recibidas, get output() { return output; } };
}

/** The server with a panel «Taller» and its switch «Bomba» (mq1), orders on, CASETA allowed and the word «bomba». */
async function montar(t, { orders = true, afterReady = 0 } = {}) {
  const puerto = await broker(t);
  const shelly = await shellyFalso(t, puerto);
  const nodo = new NodoFalso();
  const puertoNodo = await nodo.escucharTcp();
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, datos: os.tmpdir() });
  const talaia = await crearTalaia(config, crearRegistro({ nivel: "error", salida: [] }), { almacen: abrirAlmacen(":memory:"), meshGap: 20, meshOrders: { afterReady } });
  t.after(async () => { await talaia.detener(); await nodo.cerrar(); });
  talaia.arrancar();
  await hasta(() => talaia.S.link.state === "ready", 8000, "receiver ready");
  assert.equal((await talaia.mqtt.configurarBroker(null, { nombre: "Casa", url: `127.0.0.1:${puerto}` })).ok, true);
  await hasta(() => talaia.mqtt.conexion("b1")?.conectada, 5000, "MQTT connected");
  const taller = talaia.paneles.crearPanel({ nombre: "Taller", tipo: "shelly" }).num;
  assert.equal(talaia.paneles.guardarDatos(taller, [{ tipo: "estado", nombre: "Bomba", broker: "b1", tema: "shellyplug01/status/switch:0", campo: "output", orden: ORDEN }]).ok, true);
  await hasta(() => talaia.S.nodes.get(taller).metrics.mq1?.v === 0, 3000, "the Shelly says it's off");
  const mo = talaia.meshOrders;
  if (orders) {
    assert.equal(mo.configure({ on: true, words: { [`${taller}|mq1`]: "Bomba" } }).ok, true);
    assert.equal(mo.addNode(CASETA).ok, true);
  }
  let id = 5000;
  /** A text that the receiver hears. dm: to it, encrypted with the sender's key (pki); or on a channel, to all. */
  const oye = (from, text, { dm = true, pki = dm, key = KEY(from === CASETA ? 2 : 3), channel = 0, pid = ++id, rxTime } = {}) => nodo.paquete({
    from, to: dm ? ME : 0xffffffff, channel, id: pid, ...(rxTime ? { rxTime } : {}),
    ...(pki ? { pkiEncrypted: true, publicKey: key } : {}),
    payloadVariant: { case: "decoded", value: create(M.DataSchema, { portnum: PORT.TEXT_MESSAGE_APP, payload: new TextEncoder().encode(text) }) },
  });
  /** What the server has sent over the mesh: { to, channel, text }. */
  const dichos = () => nodo.paquetes(PORT.TEXT_MESSAGE_APP).map((p) => ({ to: p.to, channel: p.channel, text: new TextDecoder().decode(p.payloadVariant.value.payload) }));
  return { talaia, nodo, shelly, taller, mo, oye, dichos };
}
const textos = (S) => S.log.map((e) => e.text);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

test("settings: words, the channel and the nodes allowed (with their key pinned)", async (t) => {
  const { talaia, taller, mo } = await montar(t, { orders: false });
  const { S, automations } = talaia;
  const ref = `${taller}|mq1`;
  assert.match(mo.configure({ channel: 0 }).error, /«SFNarrow» es público/);
  assert.match(mo.configure({ channel: 7 }).error, /no está en el receptor/);
  assert.equal(mo.configure({ channel: 1 }).ok, true);
  assert.match(mo.configure({ words: { [ref]: "on" } }).error, /ya es una orden/);
  assert.match(mo.configure({ words: { [ref]: "la bomba" } }).error, /una sola palabra/);
  assert.match(mo.configure({ words: { [`${taller}|mq9`]: "bomba" } }).error, /ya no es un interruptor/);
  // An automation's order and a switch's word can't be the same.
  assert.equal(automations.save({ name: "Regar", when: { type: "mesh", text: "Riego largo" }, steps: [{ type: "switch", num: taller, key: "mq1", value: 1 }] }).ok, true);
  assert.match(mo.configure({ words: { [ref]: "RIEGO" } }).error, /ya pone en marcha una automatización/);
  assert.equal(mo.configure({ words: { [ref]: "Bomba" } }).ok, true);
  assert.match(automations.save({ name: "Otra", when: { type: "mesh", text: "bomba ya" }, steps: [{ type: "switch", num: taller, key: "mq1", value: 1 }] }).error, /es la palabra de un interruptor/);
  assert.match(automations.save({ name: "Otra", when: { type: "mesh", text: "Ayuda" }, steps: [{ type: "switch", num: taller, key: "mq1", value: 1 }] }).error, /ya es una orden/);
  // Nodes: only with a known key (it's pinned); not the receiver itself.
  assert.match(mo.addNode(ME).error, /Elige un nodo/);
  talaia.motor.node(VECINO);
  assert.match(mo.addNode(VECINO).error, /Aún no se conoce la clave/);
  assert.equal(mo.addNode(CASETA).ok, true);
  assert.deepEqual(S.meshOrders.nodes, [{ num: CASETA, key: "02020202", now: "same" }]);
  // The screens see it, without the whole key.
  const foto = instantanea(S).meshOrders;
  assert.deepEqual({ ...foto, nodes: foto.nodes.length }, { on: false, channel: 1, words: { [ref]: "Bomba" }, nodes: 1 });
  // If the receiver says that node now has another key, the screens are told.
  mo.publicKey(CASETA, KEY(7));
  assert.equal(S.meshOrders.nodes[0].now, "changed");
  assert.equal(mo.removeNode(CASETA).ok, true);
  assert.deepEqual(S.meshOrders.nodes, []);
  assert.deepEqual(textos(S).slice(0, 4), ["Órdenes por la malla: Caseta huerto ya no puede mandarlas", "Órdenes por la malla: puede mandarlas Caseta huerto (clave 02020202…)", "Órdenes por la malla: interruptores Bomba", "Automatización nueva: Regar"]);
});

test("direct messages from an allowed node: switch, state, help; the answer back to it; the rest, refused", async (t) => {
  const { talaia, shelly, oye, dichos } = await montar(t);
  const { S } = talaia;
  oye(CASETA, "Bomba ON!");
  await hasta(() => shelly.output, 3000, "pump on");
  await hasta(() => dichos().length === 1, 3000, "the answer");
  assert.deepEqual(dichos()[0], { to: CASETA, channel: 0, text: "Bomba: Encendido" });
  assert.ok(textos(S).includes("Orden por la malla de Caseta huerto: «Bomba ON!»"));
  const hecho = S.log.find((e) => e.text === "Taller · Bomba: Encendido (orden desde Talaia)");
  assert.equal(hecho.by, "Caseta huerto, por la malla");
  oye(CASETA, "bomba ?");
  await hasta(() => dichos().length === 2, 3000, "its state");
  assert.equal(dichos()[1].text, "Bomba: Encendido (acaba de cambiar)");
  oye(CASETA, "AYUDA");
  await hasta(() => dichos().length === 3, 3000, "help");
  assert.equal(dichos()[2].text, "Órdenes: bomba on/off/?");
  oye(CASETA, "hola");
  await hasta(() => dichos().length === 4, 3000, "not an order");
  assert.equal(dichos()[3].text, "No conozco «hola». Manda «ayuda» para ver las órdenes");
  oye(CASETA, "bomba quizá");
  await hasta(() => dichos().length === 5, 3000, "how");
  assert.equal(dichos()[4].text, "bomba: on, off o ?");
  // The same packet twice (heard again through a neighbour): one order.
  oye(CASETA, "bomba off", { pid: 777 });
  oye(CASETA, "bomba off", { pid: 777 });
  await hasta(() => !shelly.output, 3000, "pump off");
  await espera(300);
  assert.deepEqual(shelly.recibidas, ["on", "off"]);
  assert.equal(dichos().length, 6);

  // Refused, without an answer: a node not on the list; the allowed one with another key; not encrypted with its key.
  oye(AVISADO, "bomba on");
  await hasta(() => textos(S)[0].startsWith("Orden por la malla de Garaje rechazada"), 3000, "refused");
  assert.equal(textos(S)[0], "Orden por la malla de Garaje rechazada: no está entre los nodos que pueden mandar órdenes");
  oye(CASETA, "bomba on", { key: KEY(9) });
  await hasta(() => textos(S)[0].includes("su clave no es la que se apuntó"), 3000, "another key");
  await espera(300);
  assert.equal(shelly.output, false);
  assert.equal(dichos().length, 6, "nothing answered to them");
  oye(AVISADO, "hola"); // chat from someone else: nothing at all
  await espera(200);
  assert.equal(dichos().length, 6);
});

test("plain direct messages, the private channel, automations by order, and what was waiting in the receiver", async (t) => {
  const { talaia, shelly, taller, mo, oye, dichos } = await montar(t);
  const { S, automations } = talaia;
  // A direct message not encrypted with the sender's key: refused (once in the log, not every time).
  oye(CASETA, "bomba on", { pki: false });
  await hasta(() => textos(S)[0].includes("no venía cifrado"), 3000, "plain refused");
  // On channel 1 (private) once it's chosen: anyone on it; the answer to the channel. Channel 0 (public) never.
  oye(AVISADO, "bomba on", { dm: false, channel: 1 });
  await espera(300);
  assert.equal(shelly.output, false, "no channel chosen yet");
  assert.equal(mo.configure({ channel: 1 }).ok, true);
  oye(AVISADO, "bomba on", { dm: false, channel: 0 });
  await espera(300);
  assert.equal(shelly.output, false, "not on the public channel");
  oye(AVISADO, "Bomba on", { dm: false, channel: 1 });
  await hasta(() => shelly.output, 3000, "on from the channel");
  await hasta(() => dichos().length === 1, 3000, "answered on the channel");
  assert.deepEqual(dichos()[0], { to: 0xffffffff, channel: 1, text: "Bomba: Encendido" });
  assert.ok(textos(S).includes("Orden por la malla de Garaje por el canal «avisos»: «Bomba on»"));
  // On a channel, what isn't quite an order gets no answer (another server on it could answer it back).
  oye(AVISADO, "Bomba: Encendido", { dm: false, channel: 1 });
  oye(AVISADO, "charla del canal", { dm: false, channel: 1 });
  await espera(300);
  assert.equal(dichos().length, 1);

  // An automation «if «Riego» arrives over the mesh», and one that is off.
  const r = automations.save({ name: "Regar", when: { type: "mesh", text: "Riego" }, steps: [{ type: "switch", num: taller, key: "mq1", value: 0 }] });
  assert.equal(r.ok, true, r.error);
  automations.save({ name: "Luces", on: false, when: { type: "mesh", text: "luces" }, steps: [{ type: "switch", num: taller, key: "mq1", value: 1 }] });
  oye(CASETA, "riego");
  await hasta(() => !shelly.output, 3000, "the automation ran");
  await hasta(() => dichos().length === 2, 3000, "answered");
  assert.equal(dichos()[1].text, "Regar: en marcha");
  assert.ok(textos(S).includes("Automatización «Regar»: «Riego» por la malla, de Caseta huerto"));
  oye(CASETA, "Luces");
  await hasta(() => dichos().length === 3, 3000, "answered");
  assert.equal(dichos()[2].text, "Luces: desactivada");
  oye(CASETA, "?");
  await hasta(() => dichos().length === 4, 3000, "help");
  assert.equal(dichos()[3].text, "Órdenes: bomba on/off/?, riego, luces");

  // Waiting in the receiver: older than 10 min by its clock, or arriving right after it connects.
  oye(CASETA, "bomba on", { rxTime: Math.floor(Date.now() / 1000) - 20 * 60 });
  await espera(300);
  assert.equal(shelly.output, false);
  mo.ready(); // as if it had just connected (here, with no wait: what arrives now is fresh)
  oye(CASETA, "bomba on");
  await hasta(() => shelly.output, 3000, "fresh order");
});

test("right after connecting, what arrives was waiting in the receiver; too many orders from one sender", async (t) => {
  const { talaia, shelly, mo, oye } = await montar(t, { afterReady: 500 });
  const { S } = talaia;
  await espera(500);
  mo.ready();
  oye(CASETA, "bomba on");
  await espera(300);
  assert.equal(shelly.output, false, "from before the server connected");
  await espera(300);
  for (let i = 0; i < 21; i++) oye(CASETA, "bomba ?");
  await hasta(() => textos(S)[0].includes("demasiadas órdenes seguidas"), 3000, "too many");
  assert.equal(textos(S).filter((x) => x === "Orden por la malla de Caseta huerto: «bomba ?»").length, 20);
});
