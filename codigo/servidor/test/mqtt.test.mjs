// Pruebas de MQTT y la salida a Home Assistant, con un broker de verdad en memoria (aedes) y un «espía» que hace de
// Home Assistant: ve lo que publica Talaia y puede pulsar botones. El nodo Meshtastic es el simulado de siempre.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import { Aedes } from "aedes";
import mqtt from "mqtt";
import { crearTalaia } from "../src/talaia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { instantanea } from "../src/sincro.js";
import { normalizarUrl, comprobarBroker, comprobarHA, migrarMqtt, coincide, textoError } from "../src/mqtt.js";
import { NodoFalso, hasta, CASETA, ME } from "./nodo-falso.mjs";
import { setLanguage } from "@talaia/nucleo/idioma.js";

const ID = CASETA.toString(16).padStart(8, "0");
const CFG = (tipo, ent, nodo = `talaia_${ID}`) => `homeassistant/${tipo}/${nodo}/${ent}/config`;

/** Broker MQTT en un puerto libre; con usuario, exige usuario y contraseña. */
async function broker(t, { usuario = null, clave = null } = {}) {
  const aedes = await Aedes.createBroker();
  if (usuario) aedes.authenticate = (c, u, p, cb) => cb(null, u === usuario && p?.toString() === clave);
  const srv = net.createServer(aedes.handle);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise((r) => aedes.close(r)); await new Promise((r) => srv.close(r)); });
  return { puerto: srv.address().port, aedes };
}

/** «Home Assistant» de mentira: guarda el último mensaje de cada tema y todos los eventos. */
async function espia(t, puerto, opts = {}) {
  const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { clientId: `espia-${Math.random()}`, ...opts });
  const ultimo = new Map(), eventos = [];
  c.on("message", (tema, carga) => {
    ultimo.set(tema, carga.toString());
    if (tema.endsWith("/servidor/evento")) eventos.push(JSON.parse(carga.toString()));
  });
  await c.subscribeAsync("#");
  t.after(() => c.endAsync());
  const json = (tema) => (ultimo.get(tema) ? JSON.parse(ultimo.get(tema)) : null);
  return { c, ultimo, eventos, json };
}

async function montar(t, almacen = abrirAlmacen(":memory:")) {
  const nodo = new NodoFalso();
  const puertoNodo = await nodo.escucharTcp();
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, datos: os.tmpdir() });
  const registro = crearRegistro({ nivel: "error", salida: [] });
  const talaia = await crearTalaia(config, registro, { almacen });
  talaia.arrancar();
  await hasta(() => talaia.S.link.state === "ready", 8000, "receptor listo");
  t.after(async () => { await talaia.detener(); await nodo.cerrar(); });
  // La caseta, vigilada, con máximo de temperatura y una lectura normal.
  talaia.acciones.vigilar(CASETA);
  talaia.acciones.ponerLimite(CASETA, "temperature", "max", 30);
  nodo.ambiente(CASETA, { temperature: 24.5, relativeHumidity: 60 });
  await hasta(() => talaia.S.nodes.get(CASETA)?.metrics?.temperature?.v === 24.5, 5000, "lectura de la caseta");
  return { talaia, nodo };
}

/** Como desde Ajustes: el broker de Home Assistant (será «b1») y publicar en él para Home Assistant. */
async function conHA(talaia, puerto, extra = {}) {
  const r = await talaia.mqtt.configurarBroker(null, { nombre: "Home Assistant", url: `127.0.0.1:${puerto}`, ...extra });
  if (r.ok) assert.equal((await talaia.mqtt.configurarHA({ activado: true, broker: r.id })).ok, true);
  return r;
}
const broker1 = (talaia) => talaia.S.mqtt.brokers.find((b) => b.id === "b1");

/* ── piezas ── */
test("MQTT: direcciones, configuración y temas", () => {
  assert.equal(normalizarUrl("192.168.1.20"), "mqtt://192.168.1.20:1883");
  assert.equal(normalizarUrl("192.168.1.20:1884"), "mqtt://192.168.1.20:1884");
  assert.equal(normalizarUrl("mqtts://ha.local"), "mqtts://ha.local:8883");
  assert.equal(normalizarUrl("http://x"), null);
  assert.equal(normalizarUrl(""), null);
  assert.match(comprobarBroker({ nombre: "HA", url: "" }).error, /Falta la dirección/);
  assert.match(comprobarBroker({ nombre: "HA", url: "ftp://x" }).error, /No entiendo la dirección/);
  assert.match(comprobarBroker({ url: "x" }).error, /Ponle un nombre/);
  assert.match(comprobarHA({ base: "talaia/#" }).error, /tema base/);
  assert.match(comprobarHA({ activado: true }).error, /Elige en qué broker/);
  assert.match(comprobarHA({ activado: true, broker: "b9" }, undefined, (id) => id === "b1").error, /ya no está/);
  // La contraseña: sin dar se queda; null la borra.
  const a = comprobarBroker({ id: "b1", nombre: "HA", url: "x", usuario: "v", clave: "s" }).broker;
  assert.equal(comprobarBroker({ usuario: "u" }, a).broker.clave, "s");
  assert.equal(comprobarBroker({ clave: null }, a).broker.clave, "");
  assert.equal(comprobarBroker({ nombre: "Otro" }, a).broker.id, "b1");
  // La configuración de la 1.16 (un broker) pasa a la de varios.
  assert.deepEqual(migrarMqtt({ activado: true, url: "192.168.1.20", usuario: "u", clave: "c", base: "vigia", ha: { activado: true, prefijo: "homeassistant" } }), {
    brokers: [{ id: "b1", nombre: "Home Assistant", url: "192.168.1.20", usuario: "u", clave: "c", activado: true }],
    ha: { activado: true, broker: "b1", base: "vigia", prefijo: "homeassistant" },
  });
  assert.equal(migrarMqtt({ activado: false, url: "x", ha: { activado: true } }).ha.activado, false);
  assert.deepEqual(migrarMqtt({}).brokers, []);
  const nuevo = { brokers: [], ha: {} };
  assert.equal(migrarMqtt(nuevo), nuevo);
  assert.ok(coincide("talaia/nodo/+/enterado", "talaia/nodo/3c6e19a2/enterado"));
  assert.ok(coincide("homeassistant/#", "homeassistant/sensor/x/y/config"));
  assert.ok(!coincide("talaia/nodo/+/enterado", "talaia/nodo/3c6e19a2/estado"));
  assert.match(textoError({ code: "ECONNREFUSED" }), /no hay ningún broker/);
  assert.match(textoError({ code: 5 }), /usuario o contraseña/);
});

/* ── con broker ── */
test("al conectar publica «online», el servidor y la caseta vigilada; la contraseña no llega a las pantallas", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { talaia } = await montar(t);
  assert.match((await conHA(talaia, puerto, { clave: "secreta" })).error, /hace falta también el usuario/);
  const r = await conHA(talaia, puerto, { usuario: "talaia", clave: "secreta" });
  assert.equal(r.ok, true);
  await hasta(() => ha.ultimo.get("talaia/estado") === "online", 5000, "online");
  await hasta(() => ha.json(`talaia/nodo/${ID}/estado`), 5000, "estado de la caseta");
  const temp = ha.json(CFG("sensor", "temperature"));
  assert.equal(temp.name, "Temperatura");
  assert.equal(temp.device.name, "Talaia · Caseta huerto");
  assert.equal(temp.device_class, "temperature");
  assert.equal(temp.unit_of_measurement, "°C");
  assert.equal(temp.availability_topic, "talaia/estado");
  assert.equal(temp.device.via_device, "talaia_servidor");
  assert.ok(ha.json(CFG("binary_sensor", "alarma_temperature_alta")));
  assert.ok(ha.json(CFG("binary_sensor", "alarma_sin_senal")));
  assert.equal(ha.json(CFG("button", "enterado_temperature_alta")).payload_press, "temperature_alta");
  assert.ok(ha.json(CFG("binary_sensor", "receptor", "talaia_servidor")));
  assert.deepEqual(ha.json(CFG("event", "alarmas", "talaia_servidor")).event_types, ["alarma", "resuelta", "vista"]);
  const est = ha.json(`talaia/nodo/${ID}/estado`);
  assert.equal(est.m.temperature, 24.5);
  assert.equal(est.a.temperature_alta, "OFF");
  await hasta(() => ha.json("talaia/servidor/estado")?.receptor === "ON", 5000, "receptor en el servidor");
  // Lo que ven las pantallas: sin la contraseña.
  assert.equal(broker1(talaia).hayClave, true);
  await hasta(() => broker1(talaia).estado.fase === "conectada", 3000, "conectada");
  assert.doesNotMatch(JSON.stringify(instantanea(talaia.S)), /secreta/);
});

test("server language in English: Home Assistant gets the names again; ids and topics stay the same", async (t) => {
  t.after(() => setLanguage("es"));
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { talaia } = await montar(t);
  await conHA(talaia, puerto);
  await hasta(() => ha.json(CFG("sensor", "temperature"))?.name === "Temperatura", 5000, "en español");
  const antes = ha.json(CFG("sensor", "temperature"));
  talaia.idioma("en");
  await hasta(() => ha.json(CFG("sensor", "temperature"))?.name === "Temperature", 5000, "en inglés");
  const despues = ha.json(CFG("sensor", "temperature"));
  assert.equal(despues.unique_id, antes.unique_id);
  assert.equal(despues.state_topic, antes.state_topic);
  assert.equal(despues.device.name, "Talaia · Caseta huerto");
  assert.deepEqual(despues.device.identifiers, antes.device.identifiers);
  assert.deepEqual(ha.json(CFG("event", "alarmas", "talaia_servidor")).event_types, ["alarma", "resuelta", "vista"]);
});

test("alarma: sensor binario encendido y evento; «Enterado» desde HA queda visto en Talaia", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { talaia, nodo } = await montar(t);
  await conHA(talaia, puerto);
  await hasta(() => ha.json(`talaia/nodo/${ID}/estado`), 5000, "estado de la caseta");
  nodo.ambiente(CASETA, { temperature: 31.5, relativeHumidity: 60 });
  await hasta(() => ha.json(`talaia/nodo/${ID}/estado`)?.a.temperature_alta === "ON", 5000, "alarma encendida");
  const d = ha.json(`talaia/nodo/${ID}/estado`).d.temperature_alta;
  assert.match(d.titulo, /Caseta huerto · Temperatura por encima de 30,0 °C/);
  assert.equal(d.visto, false);
  await hasta(() => ha.eventos.some((e) => e.event_type === "alarma"), 5000, "evento de alarma");
  assert.equal(ha.eventos.find((e) => e.event_type === "alarma").nodo, "Caseta huerto");
  assert.match(ha.eventos.find((e) => e.event_type === "alarma").detalle, /^Ahora \d+,\d °C\.$/);
  await hasta(() => ha.json("talaia/servidor/estado")?.sin_atender === 1, 5000, "una sin atender");
  // HA pulsa «Enterado · Temperatura alta».
  await ha.c.publishAsync(`talaia/nodo/${ID}/enterado`, "temperature_alta");
  const key = `${CASETA}|temperature|high`;
  await hasta(() => talaia.S.active.get(key)?.acked === true, 5000, "vista en Talaia");
  await hasta(() => ha.json(`talaia/nodo/${ID}/estado`)?.d.temperature_alta.visto === true, 5000, "vista en HA");
  await hasta(() => ha.json("talaia/servidor/estado")?.sin_atender === 0, 5000, "ninguna sin atender");
  assert.ok(ha.eventos.some((e) => e.event_type === "vista"));
  // Vuelve a su sitio: resuelta.
  nodo.ambiente(CASETA, { temperature: 25, relativeHumidity: 60 });
  await hasta(() => ha.eventos.some((e) => e.event_type === "resuelta"), 5000, "evento de resuelta");
  await hasta(() => ha.json(`talaia/nodo/${ID}/estado`)?.a.temperature_alta === "OFF", 5000, "alarma apagada");
});

test("«Enterado todas» desde HA", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { talaia, nodo } = await montar(t);
  await conHA(talaia, puerto);
  nodo.ambiente(CASETA, { temperature: 33, relativeHumidity: 60 });
  await hasta(() => talaia.S.active.size === 1, 5000, "alarma");
  await hasta(() => ha.ultimo.has("talaia/estado"), 5000, "conectado");
  await ha.c.publishAsync("talaia/servidor/enterado_todas", "PRESS");
  await hasta(() => [...talaia.S.active.values()].every((a) => a.acked), 5000, "todas vistas");
});

test("dejar de vigilar quita sus entidades de HA y su estado retenido", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { talaia } = await montar(t);
  await conHA(talaia, puerto);
  await hasta(() => ha.json(CFG("sensor", "temperature")), 5000, "sensor publicado");
  talaia.acciones.dejarDeVigilar(CASETA);
  talaia.eventos.emit("parte", "cfg");
  await hasta(() => ha.ultimo.get(CFG("sensor", "temperature")) === "", 5000, "sensor retirado");
  await hasta(() => ha.ultimo.get(`talaia/nodo/${ID}/estado`) === "", 5000, "estado retirado");
  assert.equal(ha.ultimo.get(CFG("button", "enterado_temperature_alta")), "");
  assert.ok(ha.json(CFG("binary_sensor", "receptor", "talaia_servidor")), "el servidor sigue");
});

test("the ids follow the base topic; changing it takes the old devices out of Home Assistant", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { talaia } = await montar(t);
  const r = await conHA(talaia, puerto);
  await hasta(() => ha.json(CFG("sensor", "temperature")), 5000, "con la base de siempre");
  assert.equal((await talaia.mqtt.configurarHA({ activado: true, broker: r.id, base: "casa/talaia" })).ok, true);
  await hasta(() => ha.json(CFG("sensor", "temperature", `casa_talaia_${ID}`)), 5000, "ids de la base nueva");
  assert.equal(ha.json(CFG("sensor", "temperature", `casa_talaia_${ID}`)).state_topic, `casa/talaia/nodo/${ID}/estado`);
  await hasta(() => ha.ultimo.get(CFG("sensor", "temperature")) === "", 5000, "los de antes, retirados");
});

test("al conectar quita lo que había de antes y ya no corresponde", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const viejo = "homeassistant/sensor/talaia_deadbeef/temperature/config";
  await ha.c.publishAsync(viejo, JSON.stringify({ name: "viejo" }), { retain: true });
  const ajeno = "homeassistant/sensor/zigbee_salon/temperature/config";
  await ha.c.publishAsync(ajeno, JSON.stringify({ name: "de otro" }), { retain: true });
  const { talaia } = await montar(t);
  await conHA(talaia, puerto);
  await hasta(() => ha.ultimo.get(viejo) === "", 8000, "lo viejo de Talaia, retirado");
  assert.ok(ha.json(ajeno), "lo que no es de Talaia no se toca");
});

test("cuando HA arranca (homeassistant/status online), se le vuelve a contar todo", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { talaia } = await montar(t);
  await conHA(talaia, puerto);
  await hasta(() => ha.json(CFG("sensor", "temperature")), 5000, "sensor publicado");
  ha.ultimo.clear();
  await ha.c.publishAsync("homeassistant/status", "online");
  await hasta(() => ha.json(CFG("sensor", "temperature")) && ha.json(`talaia/nodo/${ID}/estado`), 8000, "publicado otra vez");
});

test("usuario o contraseña mal: error en español; al corregirlos conecta", async (t) => {
  const { puerto } = await broker(t, { usuario: "talaia", clave: "buena" });
  const { talaia } = await montar(t);
  await conHA(talaia, puerto, { usuario: "talaia", clave: "mala" });
  await hasta(() => broker1(talaia).estado.fase === "error", 5000, "error");
  assert.match(broker1(talaia).estado.error, /usuario o contraseña incorrectos/);
  assert.equal((await talaia.mqtt.configurarBroker("b1", { clave: "buena" })).ok, true);
  await hasta(() => broker1(talaia).estado.fase === "conectada", 5000, "conectada");
});

test("apagar Home Assistant retira sus entidades y deja «offline»; desconectar el broker lo para", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { talaia } = await montar(t);
  await conHA(talaia, puerto);
  await hasta(() => ha.json(CFG("sensor", "temperature")), 5000, "sensor publicado");
  await talaia.mqtt.configurarHA({ activado: false });
  await hasta(() => ha.ultimo.get(CFG("sensor", "temperature")) === "", 5000, "retirado");
  await hasta(() => ha.ultimo.get("talaia/estado") === "offline", 5000, "offline");
  await hasta(() => broker1(talaia).estado.fase === "conectada", 5000, "el broker sigue conectado");
  await talaia.mqtt.configurarBroker("b1", { activado: false });
  assert.equal(broker1(talaia).estado.fase, "parada");
});

test("si el servidor cae sin despedirse, el broker publica «offline» por él", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { talaia } = await montar(t);
  await conHA(talaia, puerto);
  await hasta(() => ha.ultimo.get("talaia/estado") === "online", 5000, "online");
  talaia.mqtt.conexion("b1").c.stream.destroy(); // como si se cortara la luz
  await hasta(() => ha.ultimo.get("talaia/estado") === "offline", 5000, "testamento");
});

test("dos brokers a la vez: Home Assistant en uno y nada en el otro; no se quita uno en uso", async (t) => {
  const p1 = (await broker(t)).puerto, p2 = (await broker(t)).puerto;
  const ha = await espia(t, p1);
  const otro = await espia(t, p2);
  const { talaia } = await montar(t);
  await conHA(talaia, p1);
  const r2 = await talaia.mqtt.configurarBroker(null, { nombre: "Taller", url: `127.0.0.1:${p2}` });
  assert.equal(r2.id, "b2");
  await hasta(() => talaia.S.mqtt.brokers.every((b) => b.estado.fase === "conectada"), 5000, "los dos conectados");
  await hasta(() => ha.json(CFG("sensor", "temperature")), 5000, "HA en el primero");
  assert.ok(![...otro.ultimo.keys()].some((k) => k.startsWith("homeassistant/") || k.startsWith("talaia/")), "nada en el otro");
  assert.match((await talaia.mqtt.quitarBroker("b1")).error, /Lo usa: Home Assistant/);
  // Home Assistant pasa al segundo: lo del primero se retira y aparece en el segundo.
  assert.equal((await talaia.mqtt.configurarHA({ broker: "b2" })).ok, true);
  await hasta(() => ha.ultimo.get(CFG("sensor", "temperature")) === "", 5000, "retirado del primero");
  await hasta(() => otro.json(CFG("sensor", "temperature")), 5000, "publicado en el segundo");
  assert.equal((await talaia.mqtt.quitarBroker("b1")).ok, true);
  assert.deepEqual(talaia.S.mqtt.brokers.map((b) => b.id), ["b2"]);
});

test("la configuración de la 1.16 (un broker y la estación) se migra al arrancar", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const almacen = abrirAlmacen(":memory:");
  almacen.guardar("mqtt", { activado: true, url: `127.0.0.1:${puerto}`, usuario: "", clave: "", base: "vigia", ha: { activado: true, prefijo: "homeassistant" } });
  almacen.guardar("my", ME);
  almacen.guardar("estacion", { activado: false, cada: 30, canal: 0, saltos: null, datos: [{ metrica: "temperature", tema: "ha/t", campo: "", unidad: "°C", caduca: 0 }] });
  const { talaia } = await montar(t, almacen);
  assert.deepEqual(talaia.S.mqtt.brokers.map((b) => [b.id, b.nombre]), [["b1", "Home Assistant"]]);
  assert.equal(talaia.S.mqtt.ha.broker, "b1");
  assert.equal(talaia.S.paneles.paneles[ME].datos[0].broker, "b1");
  // It published on «vigia/…» then: the same base and ids, so Home Assistant keeps the same devices.
  assert.equal(talaia.S.mqtt.ha.base, "vigia");
  await hasta(() => ha.json(CFG("sensor", "temperature", `vigia_${ID}`)), 5000, "sigue publicando en HA, con los mismos ids");
  assert.match((await talaia.mqtt.quitarBroker("b1")).error, /Lo usa: Home Assistant, DNN 5 \(Temperatura\)/);
});
