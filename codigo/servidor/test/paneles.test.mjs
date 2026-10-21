// Paneles del servidor: renombrar, paneles sin nodo con datos que llegan por MQTT (un Tasmota, Home Assistant…),
// sus alarmas e histórico, y los datos del receptor que salen a la malla. Broker de verdad en memoria (aedes), un
// «publicador» que hace de los dispositivos y el nodo Meshtastic simulado de siempre, que ve el paquete que le llega.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import { Aedes } from "aedes";
import mqtt from "mqtt";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import { crearVigia } from "../src/vigia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { instantanea } from "../src/sincro.js";
import { telemetriaAmbiente } from "../src/paneles.js";
import { metricMeta, fmtWithUnit } from "@vigia/nucleo/metrics.js";
import { conexionKey, estadoKey } from "@vigia/nucleo/motor.js";
import { NodoFalso, hasta, ME, CASETA, PORT } from "./nodo-falso.mjs";

const M = Protobuf.Mesh, TEL = Protobuf.Telemetry;
const T_TEMP = "ha_estados/sensor/estacion_temperatura/state";
const T_VIENTO = "ha_estados/sensor/estacion_viento/state";
const T_TASMOTA = "tele/enchufe-taller/SENSOR";

async function broker(t) {
  const aedes = await Aedes.createBroker();
  const srv = net.createServer(aedes.handle);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise((r) => aedes.close(r)); await new Promise((r) => srv.close(r)); });
  return srv.address().port;
}

/** Quien publica (Home Assistant, un Tasmota…), retenido; y un espía que ve todo lo que se publica. */
async function cliente(t, puerto) {
  const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { clientId: `cli-${Math.random()}` });
  t.after(() => c.endAsync());
  const visto = new Map();
  c.on("message", (tema, carga) => visto.set(tema, carga.toString()));
  await c.subscribeAsync("#");
  const publicar = (tema, carga) => c.publishAsync(tema, typeof carga === "string" ? carga : JSON.stringify(carga), { retain: true });
  return { publicar, visto, cliente: c };
}

async function montar(t, puerto, almacen = abrirAlmacen(":memory:")) {
  const nodo = new NodoFalso();
  const puertoNodo = await nodo.escucharTcp();
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, datos: os.tmpdir() });
  const vigia = await crearVigia(config, crearRegistro({ nivel: "error", salida: [] }), { almacen });
  vigia.arrancar();
  await hasta(() => vigia.S.link.state === "ready", 8000, "receptor listo");
  t.after(async () => { await vigia.detener(); await nodo.cerrar(); });
  if (!vigia.S.mqtt.brokers.some((b) => b.id === "b1")) {
    assert.equal((await vigia.mqtt.configurarBroker(null, { nombre: "Home Assistant", url: `127.0.0.1:${puerto}` })).ok, true);
  }
  await hasta(() => vigia.mqtt.conexion("b1")?.conectada, 5000, "MQTT conectado");
  return { vigia, nodo, almacen };
}

/** El paquete de telemetría que le ha llegado al nodo, decodificado. */
function telemetria(nodo) {
  const p = nodo.paquetes(PORT.TELEMETRY_APP).at(-1);
  return p && { p, tel: fromBinary(TEL.TelemetrySchema, p.payloadVariant.value.payload) };
}
/** El receptor oye a un vecino repetirlo: acuse implícito (o un error de la malla). */
function acuse(nodo, id, error = 0) {
  const rout = toBinary(M.RoutingSchema, create(M.RoutingSchema, { variant: { case: "errorReason", value: error } }));
  nodo.paquete({ from: ME, payloadVariant: { case: "decoded", value: create(M.DataSchema, { portnum: PORT.ROUTING_APP, payload: rout, requestId: id }) } });
}

test("el paquete de telemetría lleva cada dato en su hueco", () => {
  const tel = fromBinary(TEL.TelemetrySchema, telemetriaAmbiente({ temperature: 21.4, relativeHumidity: 61, soilMoisture: 33.6, rainfall24h: 1.2 }, 1760000000));
  assert.equal(tel.time, 1760000000);
  assert.equal(tel.variant.case, "environmentMetrics");
  const e = tel.variant.value;
  assert.ok(Math.abs(e.temperature - 21.4) < 1e-4);
  assert.equal(e.relativeHumidity, 61);
  assert.equal(e.soilMoisture, 34);
  assert.equal(e.barometricPressure, undefined); // lo que no se manda no va (no un 0)
});

test("panel sin nodo (un Tasmota): sus datos, al momento; lecturas, alarmas e histórico como un nodo", async (t) => {
  const puerto = await broker(t);
  const dispositivo = await cliente(t, puerto);
  const { vigia } = await montar(t, puerto);
  const { S, paneles, acciones } = vigia;
  assert.match(paneles.crearPanel({ nombre: "", tipo: "tasmota" }).error, /Ponle un nombre/);
  assert.match(paneles.crearPanel({ nombre: "Taller", tipo: "tostadora" }).error, /Elige qué es/);
  const r = paneles.crearPanel({ nombre: "Enchufe del taller", tipo: "tasmota" });
  assert.equal(r.ok, true);
  const num = r.num;
  assert.ok(num < 0);
  const n = S.nodes.get(num);
  assert.equal(n.long, "Enchufe del taller");
  assert.equal(n.short, "TASM");
  assert.equal(n.fuente, "mqtt");
  assert.equal(S.cfg.watched[num].offlineMin, 0, "«sin datos» apagado de entrada");

  await dispositivo.publicar(T_TASMOTA, { ENERGY: { Power: 1250, Total: 3.5, Voltage: 231 }, DS18B20: { Temperature: 4.2 } });
  const g = paneles.guardarDatos(num, [
    { tipo: "power", broker: "b1", tema: T_TASMOTA, campo: "ENERGY.Power" },
    { tipo: "energy", broker: "b1", tema: T_TASMOTA, campo: "ENERGY.Total" },
    { tipo: "temperature", nombre: "Nevera", broker: "b1", tema: T_TASMOTA, campo: "DS18B20.Temperature" },
  ]);
  assert.equal(g.ok, true, g.error);
  const datos = S.paneles.paneles[num].datos;
  assert.deepEqual(datos.map((d) => d.clave), ["mq1", "mq2", "mq3"]);
  // Llega el retenido: el valor, al momento, en el panel; y la primera lectura, guardada.
  await hasta(() => n.metrics.mq1?.v === 1250 && n.metrics.mq3?.v === 4.2, 5000, "valores en el panel");
  assert.ok(n.lastHeard > 0, "que llegue un dato es «dar señal»");
  await hasta(async () => (await S.store.series(num, "mq1", 0)).length === 1, 3000, "lectura guardada");
  // Lo ven las pantallas, con su nombre y su unidad.
  await hasta(() => instantanea(S).paneles?.valores?.mq3?.v === 4.2, 3000, "valores en la foto");
  assert.equal(metricMeta("mq3").label, "Nevera");
  assert.equal(fmtWithUnit("mq1", 1250), "1250 W");
  assert.equal(metricMeta("mq2").label, "Energía");

  // Un límite como en cualquier métrica: la alarma salta al momento, sin esperar al minuto de la lectura.
  assert.equal(acciones.ponerLimite(num, "mq3", "max", 8).ok, true);
  await dispositivo.publicar(T_TASMOTA, { ENERGY: { Power: 1300, Total: 3.6 }, DS18B20: { Temperature: 9.5 } });
  await hasta(() => S.active.has(`${num}|mq3|high`), 3000, "alarma de la nevera");
  assert.equal(vigia.motor.alarmTitle(S.active.get(`${num}|mq3|high`)), "Enchufe del taller · Nevera por encima de 8,0 °C");
  // Ese segundo valor, dentro del minuto: en el panel ya está; en el histórico, más tarde (una lectura por minuto).
  assert.equal(n.metrics.mq1.v, 1300);
  assert.equal((await S.store.series(num, "mq1", 0)).length, 1);

  // Renombrar; quitar un dato (con su histórico); quitar el panel.
  assert.equal(paneles.renombrar(num, "Taller").ok, true);
  assert.equal(S.nodes.get(num).long, "Taller");
  assert.match(paneles.renombrar(num, "").error, /Ponle un nombre/);
  assert.equal(paneles.guardarDatos(num, datos.filter((d) => d.clave !== "mq1")).ok, true);
  assert.equal(n.metrics.mq1, undefined);
  assert.equal((await S.store.series(num, "mq1", 0)).length, 0);
  assert.equal(paneles.quitarPanel(num).ok, true);
  assert.equal(S.cfg.watched[num], undefined);
  assert.equal(S.nodes.has(num), false);
  assert.equal(S.active.has(`${num}|mq3|high`), false);
  assert.equal((await S.store.series(num, "mq3", 0)).length, 0);
});

test("estados ON/OFF y conexión: un enchufe Tasmota con su LWT y una puerta de Zigbee al revés", async (t) => {
  const puerto = await broker(t);
  const dispositivo = await cliente(t, puerto);
  const { vigia } = await montar(t, puerto);
  const { S, paneles, acciones, motor } = vigia;
  const { num } = paneles.crearPanel({ nombre: "Taller", tipo: "tasmota" });
  await dispositivo.publicar("tele/enchufe/LWT", "Offline");
  await dispositivo.publicar("stat/enchufe/POWER", "ON");
  await dispositivo.publicar("zigbee2mqtt/Puerta", { contact: true, battery: 90 });
  const datos = [
    { tipo: "estado", nombre: "Enchufe", broker: "b1", tema: "stat/enchufe/POWER" },
    { tipo: "estado", nombre: "Puerta", nombres: "abierta", invertir: true, broker: "b1", tema: "zigbee2mqtt/Puerta", campo: "contact" },
  ];
  assert.match(paneles.guardarDatos(num, datos, { broker: "b1", tema: "vigia/estado" }).error, /publica Vigía/);
  assert.equal(paneles.guardarDatos(num, datos, { broker: "b1", tema: "tele/enchufe/LWT", avisar: true }).ok, true);
  const n = S.nodes.get(num);
  await hasta(() => n.metrics.mq1?.v === 1 && n.metrics.mq2?.v === 0 && n.conectado === false, 3000, "estados y conexión");
  assert.equal(fmtWithUnit("mq1", 1), "Encendido");
  assert.equal(fmtWithUnit("mq2", 0), "Cerrada"); // contact: true es cerrada
  // Sin conexión: al momento, con su alarma; y al volver.
  await hasta(() => S.active.has(conexionKey(num)), 3000, "sin conexión");
  assert.equal(motor.alarmTitle(S.active.get(conexionKey(num))), "Taller · Sin conexión");
  await hasta(() => S.paneles.conexion[num]?.v === 0, 3000, "a las pantallas (como mucho cada segundo)");
  await dispositivo.publicar("tele/enchufe/LWT", "Online");
  await hasta(() => !S.active.has(conexionKey(num)), 3000, "conectado");
  assert.equal(S.log[0].text, "Taller · Conectado otra vez");
  assert.equal(n.conectado, true);
  // Cada cambio, una lectura al momento; el mismo estado repetido, no.
  const sleep = () => new Promise((r) => setTimeout(r, 30));
  await dispositivo.publicar("stat/enchufe/POWER", "OFF");
  await hasta(() => n.metrics.mq1.v === 0, 3000, "apagado");
  const desde = n.metrics.mq1.desde;
  await sleep();
  await dispositivo.publicar("stat/enchufe/POWER", "OFF");
  await sleep();
  assert.equal(n.metrics.mq1.desde, desde, "repetido: sigue apagado desde antes");
  // Alarma «cuando esté apagado», al momento.
  assert.equal(acciones.ponerEstado(num, "mq1", 0, 0).ok, true);
  assert.equal(motor.alarmTitle(S.active.get(estadoKey(num, "mq1"))), "Taller · Enchufe: Apagado");
  await dispositivo.publicar("stat/enchufe/POWER", "ON");
  await hasta(() => !S.active.has(estadoKey(num, "mq1")), 3000, "encendido otra vez");
  assert.match(S.log[0].text, /^Taller · Enchufe: Encendido \(tras /);
  assert.deepEqual((await S.store.series(num, "mq1", 0)).map((x) => x.v), [1, 0, 1]);
  // Buscar temas: los estados y la conexión también salen.
  const { temas } = await paneles.buscarTemas();
  const de = (tema, campo = "") => temas.find((x) => x.tema === tema && x.campo === campo);
  assert.equal(de("tele/enchufe/LWT").conexion, true);
  assert.equal(de("stat/enchufe/POWER").estado, true);
  assert.deepEqual(de("zigbee2mqtt/Puerta", "contact"), { broker: "b1", tema: "zigbee2mqtt/Puerta", campo: "contact", v: "true", estado: true });
  assert.equal(de("zigbee2mqtt/Puerta", "battery").v, 90);
  // Un estado que pasa a número es otro dato (su histórico no vale): clave nueva.
  const ahora = S.paneles.paneles[num].datos;
  assert.equal(paneles.guardarDatos(num, [{ ...ahora[0] }, { ...ahora[1], tipo: "batteryLevel", campo: "battery" }]).ok, true);
  assert.deepEqual(S.paneles.paneles[num].datos.map((d) => d.clave), ["mq1", "mq3"]);
  assert.equal((await S.store.series(num, "mq2", 0)).length, 0);
  // Sin el tema de conexión ya no se sabe si está conectado.
  assert.equal(paneles.guardarDatos(num, S.paneles.paneles[num].datos, null).ok, true);
  assert.equal(n.conectado, undefined);
  assert.equal(S.paneles.paneles[num].conexion, undefined);
  // El de un nodo no lleva tema de conexión.
  acciones.vigilar(CASETA);
  assert.match(paneles.guardarDatos(CASETA, [], { broker: "b1", tema: "tele/x/LWT" }).error, /paneles sin nodo/);
});

test("un Shelly por events/rpc: «params.switch:0.output»; los avisos sin ese campo no lo estropean", async (t) => {
  const puerto = await broker(t);
  const dispositivo = await cliente(t, puerto);
  const { vigia } = await montar(t, puerto);
  const { S, paneles } = vigia;
  const { num } = paneles.crearPanel({ nombre: "Enchufe", tipo: "shelly" });
  const T = "shellyplug01/events/rpc";
  const aviso = (cambio) => ({ src: "shellyplugmg3-9070696fed78", dst: "shellyplug01/events", method: "NotifyStatus", params: { ts: 1792619486.33, "switch:0": cambio } });
  assert.equal(paneles.guardarDatos(num, [
    { tipo: "estado", nombre: "Enchufe", broker: "b1", tema: T, campo: "params.switch:0.output" },
    { tipo: "power", broker: "b1", tema: T, campo: "params.switch:0.apower" },
  ]).ok, true);
  // Antes de ningún valor bueno, el aviso de que no trae el campo sí se ve (por si está mal escrito).
  await dispositivo.publicar(T, aviso({ id: 0, apower: 12.5 }));
  await hasta(() => S.nodes.get(num).metrics.mq2?.v === 12.5, 3000, "la potencia");
  assert.match(paneles.valores.get("mq1").error, /no trae «params.switch:0.output»/);
  await dispositivo.publicar(T, aviso({ id: 0, output: true, source: "button" }));
  await hasta(() => S.nodes.get(num).metrics.mq1?.v === 1, 3000, "encendido");
  // Otro aviso solo con la potencia: el estado sigue como estaba, sin error; y al revés.
  await dispositivo.publicar(T, aviso({ id: 0, apower: 40 }));
  await hasta(() => S.nodes.get(num).metrics.mq2?.v === 40, 3000, "la potencia otra vez");
  assert.deepEqual(paneles.valores.get("mq1").v, 1);
  await dispositivo.publicar(T, aviso({ id: 0, output: false, source: "button" }));
  await hasta(() => S.nodes.get(num).metrics.mq1?.v === 0, 3000, "apagado");
  assert.equal(paneles.valores.get("mq2").v, 40);
});

/** Un Shelly Plug de mentira: contesta a las órdenes y a «status_update» publicando su estado (sin retener). */
async function shellyFalso(t, puerto, prefijo = "shellyplug01", { contesta = true } = {}) {
  const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { clientId: `shelly-${Math.random()}` });
  t.after(() => c.endAsync());
  const recibidas = [];
  let output = false;
  const estado = () => c.publishAsync(`${prefijo}/status/switch:0`, JSON.stringify({ id: 0, source: "init", output, apower: output ? 45 : 0 }));
  c.on("message", (tema, carga) => {
    const m = carga.toString();
    recibidas.push([tema, m]);
    if (!contesta) return;
    if (m === "on" || m === "off") { output = m === "on"; estado(); } else if (m === "status_update") estado();
  });
  await c.subscribeAsync(`${prefijo}/command/#`);
  return { recibidas, get output() { return output; }, estado };
}

test("encender y apagar un Shelly desde Vigía: espera a que diga que lo ha hecho; al conectar, se le pide el estado", async (t) => {
  const puerto = await broker(t);
  const shelly = await shellyFalso(t, puerto);
  const mudo = await shellyFalso(t, puerto, "shellymudo", { contesta: false });
  const { vigia } = await montar(t, puerto);
  const { S, paneles, motor } = vigia;
  const { num } = paneles.crearPanel({ nombre: "Taller", tipo: "shelly" });
  const orden = { tema: "shellyplug01/command/switch:0", on: "on", off: "off" };
  assert.equal(paneles.guardarDatos(num, [
    { tipo: "estado", nombre: "Enchufe", broker: "b1", tema: "shellyplug01/status/switch:0", campo: "output", orden },
    { tipo: "estado", nombre: "Mudo", broker: "b1", tema: "shellymudo/status/switch:0", campo: "output", orden: { ...orden, tema: "shellymudo/command/switch:0" } },
    { tipo: "power", broker: "b1", tema: "shellyplug01/status/switch:0", campo: "apower" },
  ]).ok, true);
  // Al guardar (y al conectar con el broker) se pide el estado a los Shelly: solo información.
  const n = S.nodes.get(num);
  await hasta(() => n.metrics.mq1?.v === 0, 3000, "estado pedido al guardar");
  assert.deepEqual(shelly.recibidas.at(-1), ["shellyplug01/command/switch:0", "status_update"]);
  assert.equal(shelly.output, false, "pedir el estado no cambia nada");
  // Encender: se manda la orden, «enviando» hasta que el Shelly dice que está encendido.
  assert.equal((await paneles.mandar(num, "mq1", 1)).ok, true);
  assert.equal(S.paneles.ordenes.mq1.enviando, true);
  await hasta(() => n.metrics.mq1.v === 1 && n.metrics.mq3?.v === 45, 3000, "encendido");
  await hasta(() => !S.paneles.ordenes.mq1, 3000, "confirmada");
  assert.equal(S.log[0].text, "Taller · Enchufe: Encendido (orden desde Vigía)");
  assert.match((await paneles.mandar(num, "mq3", 1)).error, /no se puede encender ni apagar/);
  assert.match((await paneles.mandar(num, "mq9", 1)).error, /ya no está/);
  // Uno que no contesta: a los 10 s, «no ha contestado» (aquí, con el reloj de la prueba).
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal((await paneles.mandar(num, "mq2", 1)).ok, true);
  // (con los temporizadores de mentira, se espera a que llegue cediendo el turno, sin setTimeout)
  for (let i = 0; i < 5000 && mudo.recibidas.at(-1)?.[1] !== "on"; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(mudo.recibidas.at(-1), ["shellymudo/command/switch:0", "on"]);
  assert.match((await paneles.mandar(num, "mq2", 1)).error, /aún no ha contestado/);
  t.mock.timers.tick(10000);
  t.mock.timers.reset();
  assert.equal(S.paneles.ordenes.mq2.error, "No ha contestado");
  assert.equal(S.log[0].text, "Taller · Mudo: no ha contestado a la orden «Encendido»");
  // Al volver a conectar con el broker, se le vuelve a pedir el estado.
  const antes = shelly.recibidas.length;
  motor.addLog("info", "—");
  vigia.mqtt.conexion("b1").emit("conectada");
  await hasta(() => shelly.recibidas.length > antes, 3000, "status_update al reconectar");
  assert.deepEqual(shelly.recibidas.at(-1), ["shellyplug01/command/switch:0", "status_update"]);
});

test("al parar, lo que esperaba su minuto se guarda como lectura", async (t) => {
  const puerto = await broker(t);
  const dispositivo = await cliente(t, puerto);
  const { vigia } = await montar(t, puerto);
  const { S, paneles } = vigia;
  const { num } = paneles.crearPanel({ nombre: "Enchufe", tipo: "tasmota" });
  assert.equal(paneles.guardarDatos(num, [{ tipo: "power", broker: "b1", tema: T_TASMOTA, campo: "ENERGY.Power" }]).ok, true);
  await dispositivo.publicar(T_TASMOTA, { ENERGY: { Power: 100 } });
  await hasta(() => S.nodes.get(num).metrics.mq1?.v === 100, 3000, "primer valor");
  await dispositivo.publicar(T_TASMOTA, { ENERGY: { Power: 120 } });
  await hasta(() => S.nodes.get(num).metrics.mq1?.v === 120, 3000, "segundo valor");
  assert.equal((await S.store.series(num, "mq1", 0)).length, 1);
  paneles.parar();
  assert.deepEqual((await S.store.series(num, "mq1", 0)).map((x) => x.v), [100, 120]);
});

test("panel de un nodo: renombrar, datos MQTT junto a los suyos (sin tocar cuándo se le oyó) y nada de eso a HA", async (t) => {
  const puerto = await broker(t);
  const ha = await cliente(t, puerto);
  const { vigia, nodo } = await montar(t, puerto);
  const { S, paneles, acciones } = vigia;
  assert.equal((await vigia.mqtt.configurarHA({ activado: true, broker: "b1" })).ok, true);
  acciones.vigilar(CASETA);
  nodo.ambiente(CASETA, { temperature: 24.5, relativeHumidity: 60 });
  await hasta(() => S.nodes.get(CASETA)?.metrics?.temperature?.v === 24.5, 5000, "lectura de la caseta");
  // Datos solo en paneles que se ven.
  assert.match(paneles.guardarDatos(0x5d20b7f1, [{ tipo: "temperature", broker: "b1", tema: "x" }]).error, /ya no está/);
  // Renombrar: el nombre de Vigía manda en todo; el de Meshtastic se queda como información.
  assert.equal(paneles.renombrar(CASETA, "Huerto").ok, true);
  assert.equal(vigia.motor.nodeName(CASETA), "Huerto");
  assert.equal(S.nodes.get(CASETA).long, "Caseta huerto");
  // Un sensor de la caseta por Zigbee, en su panel. «A la malla» solo en el del receptor.
  await ha.publicar("zigbee2mqtt/Caseta", { temperature: 19.2, humidity: 70, linkquality: 120 });
  const datos = [{ tipo: "temperature", nombre: "Temperatura dentro", broker: "b1", tema: "zigbee2mqtt/Caseta", campo: "temperature" }];
  assert.match(paneles.guardarDatos(CASETA, [{ ...datos[0], malla: true }]).error, /solo los datos del panel del receptor/);
  const oido = S.nodes.get(CASETA).lastHeard;
  assert.equal(paneles.guardarDatos(CASETA, datos).ok, true);
  await hasta(() => S.nodes.get(CASETA).metrics.mq1?.v === 19.2, 5000, "dato MQTT en la caseta");
  assert.equal(S.nodes.get(CASETA).metrics.temperature.v, 24.5, "la suya sigue");
  assert.equal(S.nodes.get(CASETA).lastHeard, oido, "un dato MQTT no es oír al nodo por radio");
  // A Home Assistant va lo del nodo, no lo MQTT; y el nombre del dispositivo es el de Vigía.
  const ID = CASETA.toString(16).padStart(8, "0");
  await hasta(() => ha.visto.get(`homeassistant/sensor/vigia_${ID}/temperature/config`), 5000, "sensor del nodo en HA");
  await hasta(() => JSON.parse(ha.visto.get(`homeassistant/sensor/vigia_${ID}/temperature/config`)).device.name === "Vigía · Huerto", 5000, "nombre en HA");
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(![...ha.visto.keys()].some((k) => k.includes("/mq1/")), "el dato MQTT no va a HA");
  assert.ok(!("mq1" in (JSON.parse(ha.visto.get(`vigia/nodo/${ID}/estado`) || "{}").m || {})));
  // Ni sus alarmas: ni evento, ni en la cuenta de activas, ni «Enterado todas» desde HA las da por vistas.
  const eventos = [];
  ha.cliente.on("message", (tema, carga) => { if (tema === "vigia/servidor/evento") eventos.push(JSON.parse(carga)); });
  assert.equal(acciones.ponerLimite(CASETA, "mq1", "max", 18).ok, true);
  assert.equal(acciones.ponerLimite(CASETA, "temperature", "max", 20).ok, true);
  await hasta(() => S.active.has(`${CASETA}|mq1|high`) && S.active.has(`${CASETA}|temperature|high`), 3000, "las dos alarmas");
  await hasta(() => eventos.length >= 1, 3000, "evento de la del nodo");
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(eventos.map((e) => e.texto), ["Huerto · Temperatura por encima de 20,0 °C"]);
  assert.equal(JSON.parse(ha.visto.get("vigia/servidor/estado")).activas, 1);
  await ha.cliente.publishAsync("vigia/servidor/enterado_todas", "PRESS");
  await hasta(() => S.active.get(`${CASETA}|temperature|high`).acked, 3000, "vista la del nodo");
  assert.equal(S.active.get(`${CASETA}|mq1|high`).acked, false);
  // Volver a su nombre.
  assert.match(paneles.renombrar(CASETA, "").toast, /Vuelve a su nombre: «Caseta huerto»/);
  assert.equal(vigia.motor.nodeName(CASETA), "Caseta huerto");
  // Un broker que usan los datos no se quita.
  await vigia.mqtt.configurarHA({ activado: false });
  assert.match((await vigia.mqtt.quitarBroker("b1")).error, /Lo usa: Caseta huerto \(Temperatura dentro\)/);
});

test("la estación de la 1.16 pasa al panel del receptor, con su histórico, y sigue saliendo a la malla", async (t) => {
  const puerto = await broker(t);
  const ha = await cliente(t, puerto);
  const almacen = abrirAlmacen(":memory:");
  // Lo que había en la 1.16: un broker, la estación con dos datos y lecturas del receptor de esos datos.
  almacen.guardar("my", ME);
  almacen.guardar("mqtt", { activado: true, url: `127.0.0.1:${puerto}`, usuario: "", clave: "", base: "vigia", ha: { activado: false, prefijo: "homeassistant" } });
  almacen.guardar("estacion", { activado: true, cada: 30, canal: 1, saltos: 3, datos: [
    { metrica: "temperature", tema: T_TEMP, campo: "", unidad: "°C", caduca: 0 },
    { metrica: "windSpeed", tema: T_VIENTO, campo: "", unidad: "km/h", caduca: 60 },
  ] });
  const hace = Date.now() - 3600000;
  await almacen.lecturas.add([{ node: ME, metric: "temperature", t: hace, v: 18.5 }, { node: ME, metric: "windSpeed", t: hace, v: 3.2 }, { node: ME, metric: "voltage", t: hace, v: 4.1 }]);
  await ha.publicar(T_TEMP, "21.4");
  await ha.publicar(T_VIENTO, "18");
  const { vigia, nodo } = await montar(t, puerto, almacen);
  const { S, paneles } = vigia;

  // Pasa al panel del receptor (que queda en el tablero), del broker de antes, a la malla.
  assert.ok(S.cfg.watched[ME]);
  const datos = S.paneles.paneles[ME].datos;
  assert.deepEqual(datos.map((d) => [d.clave, d.tipo, d.broker, d.unidad, d.malla]), [["mq1", "temperature", "b1", "°C", true], ["mq2", "windSpeed", "b1", "km/h", true]]);
  assert.deepEqual(S.paneles.malla, { ...S.paneles.malla, activado: true, cada: 30, canal: 1, saltos: 3 });
  // Su histórico, con las claves nuevas; lo del propio nodo (tensión), donde estaba.
  assert.equal((await S.store.series(ME, "mq1", 0))[0].v, 18.5);
  assert.equal((await S.store.series(ME, "temperature", 0)).length, 0);
  assert.equal((await S.store.series(ME, "voltage", 0)).length, 1);
  assert.equal(almacen.leer("estacion", null), null);
  // Y sigue funcionando: valores al momento, convertidos.
  await hasta(() => paneles.valores.get("mq2")?.v === 5, 5000, "viento de km/h a m/s");
  assert.equal(S.nodes.get(ME).metrics.mq1.v, 21.4);
  // A la malla: un paquete de telemetría a todos, por el canal 1 y con 3 saltos, con los tipos de Meshtastic.
  await hasta(() => S.paneles.malla.previo.texto === "Temperatura 21,4 °C · Viento 5,0 m/s", 3000, "lo que saldría");
  const envio = paneles.enviar(true);
  await nodo.esperar(() => telemetria(nodo), 5000, "telemetría");
  const { p, tel } = telemetria(nodo);
  assert.deepEqual([p.to, p.channel, p.hopLimit, p.wantAck], [0xffffffff, 1, 3, true]);
  const e = tel.variant.value;
  assert.ok(Math.abs(e.temperature - 21.4) < 1e-4 && Math.abs(e.windSpeed - 5) < 1e-4);
  acuse(nodo, p.id);
  await envio;
  assert.equal(S.paneles.malla.ultimo.resultado, "repetido por la malla");
  assert.equal(S.paneles.malla.ultimo.destino, "canal «avisos»");
  // Quitar un dato de la malla, cambiar cada cuánto; apagar.
  assert.match(paneles.configurarMalla({ cada: 7 }).error, /cada cuánto/);
  assert.match(paneles.configurarMalla({ cada: 60 }).toast, /Próximo envío a las \d\d:\d\d/);
  assert.equal(paneles.guardarDatos(ME, datos.map((d) => ({ ...d, malla: d.tipo === "windSpeed" }))).ok, true);
  await hasta(() => S.paneles.malla.previo.texto === "Viento 5,0 m/s", 3000, "solo el viento");
  assert.equal(paneles.configurarMalla({ activado: false }).ok, true);
  assert.equal(S.paneles.malla.proximo, null);
});

test("lo que no está al día no sale a la malla; los fallos se cuentan; buscar temas en todos los brokers", async (t) => {
  const puerto = await broker(t);
  const ha = await cliente(t, puerto);
  const { vigia, nodo } = await montar(t, puerto);
  const { S, paneles, acciones } = vigia;
  acciones.vigilar(ME);
  await ha.publicar(T_TEMP, "unavailable");
  await ha.publicar(T_VIENTO, "huracán");
  await ha.publicar("zigbee2mqtt/Estación", { humidity: 61, pressure: 101620 }); // presión en Pa: no
  assert.equal(paneles.guardarDatos(ME, [
    { tipo: "temperature", broker: "b1", tema: T_TEMP, malla: true },
    { tipo: "windSpeed", broker: "b1", tema: T_VIENTO, malla: true },
    { tipo: "relativeHumidity", broker: "b1", tema: "zigbee2mqtt/Estación", campo: "humidity", malla: true, caduca: 60 },
    { tipo: "barometricPressure", broker: "b1", tema: "zigbee2mqtt/Estación", campo: "pressure", malla: true },
  ]).ok, true);
  await hasta(() => paneles.valores.size === 4, 5000, "valores");
  const faltan = () => S.paneles.malla.previo.faltan.join(" | ");
  await hasta(() => /Temperatura \(no disponible\)/.test(faltan()), 3000, "no disponible");
  assert.match(faltan(), /Viento \(«huracán» no es un número\)/);
  assert.match(faltan(), /Presión \(101\.620 hPa no es normal: ¿está bien la unidad\?\)/);
  // La humedad, caducada: como si hubiera llegado hace 2 h.
  paneles.valores.get("mq3").t -= 2 * 3600000;
  await paneles.enviar(true);
  assert.equal(S.paneles.malla.ultimo.resultado, "nada que mandar: ningún dato al día");
  assert.equal(telemetria(nodo), undefined);
  // Con la humedad al día, sale; la malla no lo repite.
  await ha.publicar("zigbee2mqtt/Estación", { humidity: 62, pressure: 1016 });
  await hasta(() => paneles.valores.get("mq4")?.v === 1016, 3000, "presión buena");
  const envio2 = paneles.enviar(true);
  await nodo.esperar(() => telemetria(nodo), 5000, "telemetría");
  const { p, tel } = telemetria(nodo);
  assert.equal(p.hopLimit, 0); // sin elegir: los del receptor (los pone el firmware)
  assert.deepEqual(Object.keys(tel.variant.value).filter((k) => typeof tel.variant.value[k] === "number").sort(), ["barometricPressure", "relativeHumidity"]);
  acuse(nodo, p.id, Protobuf.Mesh.Routing_Error.MAX_RETRANSMIT);
  await envio2;
  assert.match(S.paneles.malla.ultimo.resultado, /nadie lo repitió/);

  // Buscar temas: en todos los brokers, sin lo de Vigía.
  const r = await paneles.buscarTemas();
  assert.equal(r.ok, true);
  const vistos = r.temas.map((x) => `${x.broker}|${x.tema}|${x.campo}`);
  assert.ok(vistos.includes("b1|zigbee2mqtt/Estación|humidity"));
  assert.ok(!vistos.some((v) => v.includes("vigia/")));
});
