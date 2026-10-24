// Automations (2.1): «if … then …». A real broker in memory (aedes), a fake Shelly that answers its commands, a
// «device» that publishes readings and the usual simulated Meshtastic node, which sees what reaches the mesh.
// Times are short (a «minute» of 200 ms) so that waits and «for N min» can be seen working.
process.env.TZ = "Europe/Madrid"; // times of day: the test's own clock, wherever it runs
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Aedes } from "aedes";
import mqtt from "mqtt";
import { crearTalaia } from "../src/talaia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { instantanea } from "../src/sincro.js";
import { NodoFalso, hasta, CASETA, PORT } from "./nodo-falso.mjs";

const TIMING = { min: 200, sec: 20, tick: 20, afterStart: 50, retry: 50 };
const T_TEMP = "huerto/temperatura", T_PUERTA = "zigbee2mqtt/puerta";
const ORDEN = { tema: "shellyplug01/command/switch:0", on: "on", off: "off" };

async function broker(t) {
  const aedes = await Aedes.createBroker();
  const srv = net.createServer(aedes.handle);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise((r) => aedes.close(r)); await new Promise((r) => srv.close(r)); });
  return srv.address().port;
}

/** Whoever publishes the readings (Home Assistant, a sensor…), retained. */
async function dispositivo(t, puerto) {
  const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { clientId: `dev-${Math.random()}` });
  t.after(() => c.endAsync());
  return (tema, carga) => c.publishAsync(tema, typeof carga === "string" ? carga : JSON.stringify(carga), { retain: true });
}

/** A fake Shelly Plug: answers its commands publishing its state (not retained). */
async function shellyFalso(t, puerto, prefijo = "shellyplug01") {
  const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { clientId: `shelly-${Math.random()}` });
  t.after(() => c.endAsync());
  const recibidas = [];
  let output = false;
  const estado = () => c.publishAsync(`${prefijo}/status/switch:0`, JSON.stringify({ id: 0, source: "init", output }));
  c.on("message", (tema, carga) => {
    const m = carga.toString();
    if (m === "on" || m === "off") { recibidas.push(m); output = m === "on"; estado(); } else if (m === "status_update") estado();
  });
  await c.subscribeAsync(`${prefijo}/command/#`);
  return { recibidas, get output() { return output; } };
}

async function montar(t, puerto, { almacen = abrirAlmacen(":memory:"), nodo = new NodoFalso(), conBroker = true } = {}) {
  const puertoNodo = nodo.tcp ? nodo.tcp.address().port : await nodo.escucharTcp();
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, datos: os.tmpdir() });
  const salida = [];
  const talaia = await crearTalaia(config, crearRegistro({ nivel: "error", salida }), { almacen, automations: TIMING });
  talaia.salida = salida;
  if (!nodo.cerrarAlFinal) { nodo.cerrarAlFinal = true; t.after(() => nodo.cerrar()); }
  t.after(() => talaia.detener()); // (it runs before closing the node: the last one added goes first)
  talaia.arrancar();
  await hasta(() => talaia.S.link.state === "ready", 8000, "receiver ready");
  if (conBroker && !talaia.S.mqtt.brokers.some((b) => b.id === "b1")) {
    assert.equal((await talaia.mqtt.configurarBroker(null, { nombre: "Casa", url: `127.0.0.1:${puerto}` })).ok, true);
  }
  await hasta(() => talaia.mqtt.conexion("b1")?.conectada, 5000, "MQTT connected");
  return { talaia, nodo };
}

/** A panel «Huerto» with its temperature (mq1) and a panel «Taller» with a Shelly (mq2) and a door (mq3). */
async function paneles(talaia) {
  const { paneles } = talaia;
  const huerto = paneles.crearPanel({ nombre: "Huerto", tipo: "otro" }).num;
  const taller = paneles.crearPanel({ nombre: "Taller", tipo: "shelly" }).num;
  assert.equal(paneles.guardarDatos(huerto, [{ tipo: "temperature", broker: "b1", tema: T_TEMP, campo: "" }]).ok, true);
  assert.equal(paneles.guardarDatos(taller, [
    { tipo: "estado", nombre: "Bomba", broker: "b1", tema: "shellyplug01/status/switch:0", campo: "output", orden: ORDEN },
    { tipo: "estado", nombre: "Puerta", nombres: "abierta", broker: "b1", tema: T_PUERTA, campo: "contact", invertir: true },
  ]).ok, true);
  return { huerto, taller };
}
const textos = (S) => S.log.map((e) => e.text);
const mensajes = (nodo) => nodo.paquetes(PORT.TEXT_MESSAGE_APP).map((p) => ({ to: p.to, channel: p.channel, text: new TextDecoder().decode(p.payloadVariant.value.payload) }));

test("what an automation can be: the server checks every part", async (t) => {
  const puerto = await broker(t);
  const { talaia } = await montar(t, puerto);
  const { huerto, taller } = await paneles(talaia);
  const save = (a) => talaia.automations.save(a);
  const sube = { type: "value", num: huerto, key: "mq1", op: "above", value: 25 };
  const bomba = { type: "switch", num: taller, key: "mq2", value: 1 };
  assert.match(save({ when: sube, steps: [bomba] }).error, /Ponle un nombre/);
  assert.match(save({ name: "x".repeat(41), when: sube, steps: [bomba] }).error, /demasiado largo/);
  assert.match(save({ name: "Riego", when: { type: "value", num: 12345, key: "mq1", op: "above", value: 1 }, steps: [bomba] }).error, /ya no está en el tablero/);
  assert.match(save({ name: "Riego", when: { ...sube, key: "mq9" }, steps: [bomba] }).error, /Elige un dato/);
  assert.match(save({ name: "Riego", when: { ...sube, op: "is" }, steps: [bomba] }).error, /sube o baja/);
  assert.match(save({ name: "Riego", when: { ...sube, value: "25" }, steps: [bomba] }).error, /Escribe un número/);
  assert.match(save({ name: "Riego", when: { ...sube, for: 2000 }, steps: [bomba] }).error, /de 0 a 1440/);
  assert.match(save({ name: "Puerta", when: { type: "value", num: taller, key: "mq3", op: "above", value: 1 }, steps: [bomba] }).error, /en qué estado/);
  assert.match(save({ name: "Mañana", when: { type: "time", at: "7:30", days: [1] }, steps: [bomba] }).error, /Hora no válida/);
  assert.match(save({ name: "Mañana", when: { type: "time", at: "07:30", days: [] }, steps: [bomba] }).error, /al menos un día/);
  assert.match(save({ name: "Riego", when: sube, steps: [] }).error, /al menos un paso/);
  assert.match(save({ name: "Riego", when: sube, steps: [{ type: "wait", seconds: 5 }] }).error, /Solo hay esperas/);
  assert.match(save({ name: "Riego", when: sube, steps: [bomba, { type: "wait", seconds: 0 }] }).error, /^Paso 2: la espera va de 1 s a 24 h/);
  assert.match(save({ name: "Riego", when: sube, steps: [{ ...bomba, key: "mq3" }] }).error, /^Paso 1: elige un interruptor/, "the door can't be switched");
  assert.match(save({ name: "Riego", when: sube, steps: [{ ...bomba, value: 2 }] }).error, /encender o apagar/);
  assert.match(save({ name: "Riego", when: sube, steps: [{ type: "message", to: { channel: 0 }, text: "hola" }] }).error, /«SFNarrow» es público/);
  assert.match(save({ name: "Riego", when: sube, steps: [{ type: "message", to: { channel: 1 }, text: "ñ".repeat(101) }] }).error, /no cabe/);
  assert.match(save({ name: "Riego", when: sube, steps: [{ type: "message", to: { node: talaia.S.myNode }, text: "hola" }] }).error, /canal privado o un nodo/);
  assert.match(save({ name: "Riego", when: sube, steps: [{ type: "ask", num: CASETA, what: "route" }] }).error, /qué pedir/);
  assert.match(save({ name: "Riego", when: sube, steps: [{ type: "explode" }] }).error, /paso no válido/);
  assert.match(save({ name: "Riego", when: sube, steps: Array(21).fill(bomba) }).error, /Como mucho 20 pasos/);
  assert.match(save({ id: 99, name: "Riego", when: sube, steps: [bomba] }).error, /ya no está/);
  // A good one: only what is known is kept.
  const r = save({ name: " Riego ", when: { ...sube, extra: 1 }, steps: [{ ...bomba, for: 10, cosa: 2 }, { type: "message", to: { channel: 1 }, text: "Riego: {valor}" }], hack: true });
  assert.equal(r.ok, true, r.error);
  const a = talaia.automations.list[0];
  assert.deepEqual(a, { name: "Riego", on: true, when: { type: "value", num: huerto, key: "mq1", op: "above", value: 25, for: 0 }, steps: [{ type: "switch", num: taller, key: "mq2", value: 1, for: 10 }, { type: "message", to: { channel: 1 }, text: "Riego: {valor}" }], id: r.id });
  assert.deepEqual(textos(talaia.S)[0], "Automatización nueva: Riego");
  // The screens see it.
  assert.equal(instantanea(talaia.S).automations.list[0].name, "Riego");
});

test("a value that goes above a number: only on the crossing, with the metric's margin; then a switch and a message", async (t) => {
  const puerto = await broker(t);
  const publicar = await dispositivo(t, puerto);
  const shelly = await shellyFalso(t, puerto);
  const { talaia, nodo } = await montar(t, puerto);
  const { S, automations } = talaia;
  const { huerto, taller } = await paneles(talaia);
  const temp = () => S.nodes.get(huerto).metrics.mq1?.v;
  await publicar(T_TEMP, "27");
  await hasta(() => temp() === 27, 3000, "27 °C");
  // It's already above when it's saved: that doesn't count.
  const r = automations.save({
    name: "Calor", when: { type: "value", num: huerto, key: "mq1", op: "above", value: 25 },
    steps: [{ type: "switch", num: taller, key: "mq2", value: 1 }, { type: "message", to: { channel: 1 }, text: "Calor en el huerto: {valor}" }],
  });
  assert.equal(r.ok, true, r.error);
  await publicar(T_TEMP, "28");
  await hasta(() => temp() === 28, 3000, "28 °C");
  assert.equal(shelly.recibidas.length, 0, "already above when saved");
  // Down (past the margin of 0.3 °C) and up again: now it fires.
  await publicar(T_TEMP, "24");
  await hasta(() => temp() === 24, 3000, "24 °C");
  await publicar(T_TEMP, "25.4");
  await hasta(() => shelly.output, 3000, "the pump on");
  assert.deepEqual(shelly.recibidas, ["on"]);
  assert.ok(textos(S).includes("Automatización «Calor»: Huerto · Temperatura ha pasado de 25,0 °C (25,4 °C)"), textos(S).join("\n"));
  await hasta(() => textos(S).includes("Taller · Bomba: Encendido (orden desde Talaia)"), 3000, "the command, in the log");
  const linea = S.log.find((e) => e.text === "Taller · Bomba: Encendido (orden desde Talaia)");
  assert.equal(linea.by, "automatización «Calor»", "who sent it");
  await nodo.esperar(() => mensajes(nodo).length === 1, 15000, "the message");
  assert.deepEqual(mensajes(nodo)[0], { to: 0xffffffff, channel: 1, text: "Calor en el huerto: 25,4 °C" });
  // It wobbles on the line (within the margin): nothing more.
  for (const v of ["24.9", "25.2", "24.8", "25.3"]) {
    await publicar(T_TEMP, v);
    await hasta(() => temp() === Number(v), 3000, v);
  }
  assert.deepEqual(shelly.recibidas, ["on"]);
  assert.equal(S.automations.last[r.id] != null, true);
  // Switched off, it doesn't fire; on again, what holds now doesn't count either.
  assert.equal(automations.setOn(r.id, false).ok, true);
  await publicar(T_TEMP, "20");
  await hasta(() => temp() === 20, 3000, "20 °C");
  await publicar(T_TEMP, "30");
  await hasta(() => temp() === 30, 3000, "30 °C");
  assert.equal(automations.setOn(r.id, true).ok, true);
  await publicar(T_TEMP, "31");
  await hasta(() => temp() === 31, 3000, "31 °C");
  assert.deepEqual(shelly.recibidas, ["on"]);
  assert.deepEqual(textos(S).slice(0, 2), ["Automatización activada: Calor", "Automatización desactivada: Calor"]);
});

test("«for N min» on a switch, waits, starting again when it fires while waiting; tried by hand", async (t) => {
  const puerto = await broker(t);
  const shelly = await shellyFalso(t, puerto);
  const { talaia } = await montar(t, puerto);
  const { S, automations } = talaia;
  const { huerto, taller } = await paneles(talaia);
  await hasta(() => S.nodes.get(taller).metrics.mq2?.v === 0, 3000, "the Shelly says it's off");
  // On for 1 «minute» (200 ms here), and back.
  const a = automations.save({ name: "Riego", on: false, when: { type: "value", num: huerto, key: "mq1", op: "below", value: 5 }, steps: [{ type: "switch", num: taller, key: "mq2", value: 1, for: 1 }] });
  assert.equal(automations.runNow(a.id).ok, true, "tried by hand even when it's off");
  await hasta(() => shelly.output, 3000, "on");
  assert.equal(S.automations.backs.length, 1);
  assert.deepEqual(S.automations.backs[0], { id: a.id, num: taller, key: "mq2", value: 0, at: S.automations.backs[0].at });
  await hasta(() => !shelly.output, 3000, "off again after its minute");
  assert.deepEqual(shelly.recibidas, ["on", "off"]);
  assert.equal(S.automations.backs.length, 0);
  assert.ok(textos(S).includes("Automatización «Riego»: probada a mano"));

  // Waits: on, wait 10 «s» (200 ms), off. Fired again while waiting: it starts again (the off comes later).
  const b = automations.save({ name: "Luz", when: { type: "value", num: huerto, key: "mq1", op: "below", value: 5 }, steps: [
    { type: "switch", num: taller, key: "mq2", value: 1 }, { type: "wait", seconds: 10 }, { type: "switch", num: taller, key: "mq2", value: 0 },
  ] });
  automations.runNow(b.id);
  await hasta(() => shelly.output, 3000, "on");
  assert.equal(S.automations.runs[b.id].step, 2);
  await new Promise((r) => setTimeout(r, 120));
  automations.runNow(b.id); // again, 120 ms into its wait
  const t0 = Date.now();
  await hasta(() => !shelly.output, 3000, "off");
  assert.ok(Date.now() - t0 >= 150, "the wait started again");
  assert.deepEqual(shelly.recibidas, ["on", "off", "on", "on", "off"]);
  assert.equal(S.automations.runs[b.id], undefined);
  // Switched off while waiting: it stops there (the off doesn't go).
  automations.runNow(b.id);
  await hasta(() => shelly.output, 3000, "on");
  automations.setOn(b.id, false);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(shelly.output, true, "stopped in its wait");
  assert.equal(S.automations.runs[b.id], undefined);

  // «For N min» goes back even if the automation is removed meanwhile; a newer command to the switch drops it.
  await talaia.paneles.mandar(taller, "mq2", 0);
  await hasta(() => !shelly.output, 3000, "off by hand");
  automations.runNow(a.id);
  await hasta(() => shelly.output, 3000, "on");
  assert.equal(automations.remove(a.id).ok, true);
  await hasta(() => !shelly.output, 3000, "back off although removed");
  const c = automations.save({ name: "Apaga", on: false, when: { type: "value", num: huerto, key: "mq1", op: "below", value: 5 }, steps: [{ type: "switch", num: taller, key: "mq2", value: 1, for: 1 }] });
  const d = automations.save({ name: "Enciende", on: false, when: { type: "value", num: huerto, key: "mq1", op: "below", value: 5 }, steps: [{ type: "switch", num: taller, key: "mq2", value: 1 }] });
  automations.runNow(c.id);
  await hasta(() => shelly.output && S.automations.backs.length === 1, 3000, "on for a minute");
  automations.runNow(d.id); // on, with nothing after: it stays on
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(shelly.output, true, "the last command counts");
  assert.equal(S.automations.backs.length, 0);
});

test("a state for N min, a time of day on some days, asking a node, the brake", async (t) => {
  const puerto = await broker(t);
  const publicar = await dispositivo(t, puerto);
  const shelly = await shellyFalso(t, puerto);
  const { talaia, nodo } = await montar(t, puerto);
  const { S, automations } = talaia;
  const { taller, huerto } = await paneles(talaia);
  const puerta = () => S.nodes.get(taller).metrics.mq3;
  await publicar(T_PUERTA, { contact: true });
  await hasta(() => puerta()?.v === 0, 3000, "closed");
  // Open more than 1 «min» (200 ms): a direct message to a node.
  const p = automations.save({ name: "Puerta", when: { type: "value", num: taller, key: "mq3", op: "is", value: 1, for: 1 }, steps: [{ type: "message", to: { node: CASETA }, text: "Puerta del taller abierta ({hora})" }] });
  assert.equal(p.ok, true, p.error);
  await publicar(T_PUERTA, { contact: false });
  await hasta(() => puerta()?.v === 1, 3000, "open");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(mensajes(nodo).length, 0, "not yet");
  await nodo.esperar(() => mensajes(nodo).length === 1, 3000, "the message after its minute");
  assert.equal(mensajes(nodo)[0].to, CASETA);
  assert.match(mensajes(nodo)[0].text, /^Puerta del taller abierta \(\d\d:\d\d\)$/);
  assert.ok(textos(S).includes("Automatización «Puerta»: Taller · Puerta: Abierta, desde hace 1 min"), textos(S).join("\n"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mensajes(nodo).length, 1, "once each time it opens");
  // Closed before its minute: nothing.
  await publicar(T_PUERTA, { contact: true });
  await hasta(() => puerta()?.v === 0, 3000, "closed");
  await publicar(T_PUERTA, { contact: false });
  await hasta(() => puerta()?.v === 1, 3000, "open");
  await publicar(T_PUERTA, { contact: true });
  await hasta(() => puerta()?.v === 0, 3000, "closed");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mensajes(nodo).length, 1);

  // A time of day: Monday to Friday at 07:30 (the server's clock), once in that minute; asks a node for its data.
  automations.setOn(p.id, false);
  const h = automations.save({ name: "Mañana", when: { type: "time", at: "07:30", days: [1, 2, 3, 4, 5] }, steps: [{ type: "ask", num: CASETA, what: "env" }] });
  assert.equal(h.ok, true, h.error);
  const pedidos = () => nodo.paquetes(PORT.TELEMETRY_APP).filter((x) => x.to === CASETA).length;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T07:29:58+01:00") }); // a Monday
  automations.tick();
  assert.equal(pedidos(), 0);
  t.mock.timers.setTime(new Date("2026-10-26T07:30:03+01:00").getTime());
  automations.tick();
  automations.tick();
  t.mock.timers.setTime(new Date("2026-10-26T07:30:40+01:00").getTime());
  automations.tick();
  t.mock.timers.setTime(new Date("2026-10-25T07:30:10+01:00").getTime()); // a Sunday
  automations.tick();
  t.mock.timers.reset();
  await nodo.esperar(() => pedidos() === 1, 3000, "the request");
  assert.equal(textos(S).filter((x) => x === "Automatización «Mañana»: son las 07:30").length, 1);
  // Tried again while that request is still waiting for its answer: no second one.
  automations.runNow(h.id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pedidos(), 1);

  // The brake: one that runs by itself 10 times in 10 «min» is paused.
  const temp = () => S.nodes.get(huerto).metrics.mq1?.v;
  const f = automations.save({ name: "Loca", when: { type: "value", num: huerto, key: "mq1", op: "above", value: 20 }, steps: [{ type: "switch", num: taller, key: "mq2", value: 1 }] });
  for (let i = 0; i < 11; i++) {
    for (const v of [i, 40 + i]) { await publicar(T_TEMP, String(v)); await hasta(() => temp() === v, 3000, `${v}`); }
  }
  const loca = automations.list.find((a) => a.id === f.id);
  assert.equal(loca.on, false);
  assert.ok(loca.paused > 0);
  assert.ok(textos(S).includes("Automatización «Loca» pausada: se ha disparado 10 veces en 10 min. Revísala y vuelve a activarla"));
  assert.equal(textos(S).filter((x) => x.startsWith("Automatización «Loca»: Huerto · Temperatura ha pasado de")).length, 10);
  assert.ok(shelly.recibidas.length >= 1);
  automations.setOn(f.id, true);
  assert.equal(automations.list.find((a) => a.id === f.id).paused, undefined);
});

test("waits and «for N min» survive a restart: what came due runs shortly after starting", async (t) => {
  const puerto = await broker(t);
  const shelly = await shellyFalso(t, puerto);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-auto-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ruta = path.join(dir, "talaia.db");
  const nodo = new NodoFalso();
  let { talaia } = await montar(t, puerto, { almacen: abrirAlmacen(ruta), nodo });
  const { huerto, taller } = await paneles(talaia);
  const a = talaia.automations.save({ name: "Riego", when: { type: "value", num: huerto, key: "mq1", op: "below", value: 5 }, steps: [
    { type: "switch", num: taller, key: "mq2", value: 1, for: 2 }, { type: "wait", seconds: 15 }, { type: "message", to: { channel: 1 }, text: "Sigue el riego" },
  ] });
  talaia.automations.runNow(a.id);
  await hasta(() => shelly.output, 3000, "on");
  await hasta(() => talaia.S.automations.runs[a.id], 3000, "waiting");
  await talaia.detener();
  // Stopped for longer than its wait and its «2 min» (400 ms here).
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(shelly.output, true, "nobody turned it off while stopped");
  ({ talaia } = await montar(t, puerto, { almacen: abrirAlmacen(ruta), nodo, conBroker: false }));
  await hasta(() => !shelly.output, 3000, "off after starting again");
  await nodo.esperar(() => mensajes(nodo).some((m) => m.text === "Sigue el riego"), 15000, "what came after the wait");
  assert.ok(textos(talaia.S).includes("Automatización «Riego»: sigue con retraso (el servidor estaba parado)"));
  assert.equal(talaia.S.automations.backs.length, 0);
  assert.deepEqual(talaia.S.automations.runs, {});
});
