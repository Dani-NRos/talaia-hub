// Pruebas de MQTT y la salida a Home Assistant, con un broker de verdad en memoria (aedes) y un «espía» que hace de
// Home Assistant: ve lo que publica Vigía y puede pulsar botones. El nodo Meshtastic es el simulado de siempre.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import { Aedes } from "aedes";
import mqtt from "mqtt";
import { crearVigia } from "../src/vigia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { instantanea } from "../src/sincro.js";
import { normalizarUrl, comprobarMqtt, coincide, textoError } from "../src/mqtt.js";
import { NodoFalso, hasta, CASETA } from "./nodo-falso.mjs";

const ID = CASETA.toString(16).padStart(8, "0");
const CFG = (tipo, ent, nodo = `vigia_${ID}`) => `homeassistant/${tipo}/${nodo}/${ent}/config`;

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

async function montar(t) {
  const nodo = new NodoFalso();
  const puertoNodo = await nodo.escucharTcp();
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, datos: os.tmpdir() });
  const registro = crearRegistro({ nivel: "error", salida: [] });
  const vigia = await crearVigia(config, registro, { almacen: abrirAlmacen(":memory:") });
  vigia.arrancar();
  await hasta(() => vigia.S.link.state === "ready", 8000, "receptor listo");
  t.after(async () => { await vigia.detener(); await nodo.cerrar(); });
  // La caseta, vigilada, con máximo de temperatura y una lectura normal.
  vigia.acciones.vigilar(CASETA);
  vigia.acciones.ponerLimite(CASETA, "temperature", "max", 30);
  nodo.ambiente(CASETA, { temperature: 24.5, relativeHumidity: 60 });
  await hasta(() => vigia.S.nodes.get(CASETA)?.metrics?.temperature?.v === 24.5, 5000, "lectura de la caseta");
  return { vigia, nodo };
}

/* ── piezas ── */
test("MQTT: direcciones, configuración y temas", () => {
  assert.equal(normalizarUrl("192.168.1.20"), "mqtt://192.168.1.20:1883");
  assert.equal(normalizarUrl("192.168.1.20:1884"), "mqtt://192.168.1.20:1884");
  assert.equal(normalizarUrl("mqtts://ha.local"), "mqtts://ha.local:8883");
  assert.equal(normalizarUrl("http://x"), null);
  assert.equal(normalizarUrl(""), null);
  assert.match(comprobarMqtt({ activado: true, url: "" }).error, /Falta la dirección/);
  assert.match(comprobarMqtt({ url: "ftp://x" }).error, /No entiendo la dirección/);
  assert.match(comprobarMqtt({ base: "vigia/#" }).error, /tema base/);
  // La contraseña: sin dar se queda; null la borra.
  const a = comprobarMqtt({ activado: true, url: "x", usuario: "v", clave: "s" }).cfg;
  assert.equal(comprobarMqtt({ usuario: "u" }, a).cfg.clave, "s");
  assert.equal(comprobarMqtt({ clave: null }, a).cfg.clave, "");
  assert.ok(coincide("vigia/nodo/+/enterado", "vigia/nodo/3c6e19a2/enterado"));
  assert.ok(coincide("homeassistant/#", "homeassistant/sensor/x/y/config"));
  assert.ok(!coincide("vigia/nodo/+/enterado", "vigia/nodo/3c6e19a2/estado"));
  assert.match(textoError({ code: "ECONNREFUSED" }), /no hay ningún broker/);
  assert.match(textoError({ code: 5 }), /usuario o contraseña/);
});

/* ── con broker ── */
test("al conectar publica «online», el servidor y la caseta vigilada; la contraseña no llega a las pantallas", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { vigia } = await montar(t);
  assert.match((await vigia.mqtt.configurar({ activado: true, url: `127.0.0.1:${puerto}`, clave: "secreta" })).error, /hace falta también el usuario/);
  const r = await vigia.mqtt.configurar({ activado: true, url: `127.0.0.1:${puerto}`, usuario: "vigia", clave: "secreta" });
  assert.equal(r.ok, true);
  await hasta(() => ha.ultimo.get("vigia/estado") === "online", 5000, "online");
  await hasta(() => ha.json(`vigia/nodo/${ID}/estado`), 5000, "estado de la caseta");
  const temp = ha.json(CFG("sensor", "temperature"));
  assert.equal(temp.name, "Temperatura");
  assert.equal(temp.device.name, "Vigía · Caseta huerto");
  assert.equal(temp.device_class, "temperature");
  assert.equal(temp.unit_of_measurement, "°C");
  assert.equal(temp.availability_topic, "vigia/estado");
  assert.equal(temp.device.via_device, "vigia_servidor");
  assert.ok(ha.json(CFG("binary_sensor", "alarma_temperature_alta")));
  assert.ok(ha.json(CFG("binary_sensor", "alarma_sin_senal")));
  assert.equal(ha.json(CFG("button", "enterado_temperature_alta")).payload_press, "temperature_alta");
  assert.ok(ha.json(CFG("binary_sensor", "receptor", "vigia_servidor")));
  assert.deepEqual(ha.json(CFG("event", "alarmas", "vigia_servidor")).event_types, ["alarma", "resuelta", "vista"]);
  const est = ha.json(`vigia/nodo/${ID}/estado`);
  assert.equal(est.m.temperature, 24.5);
  assert.equal(est.a.temperature_alta, "OFF");
  await hasta(() => ha.json("vigia/servidor/estado")?.receptor === "ON", 5000, "receptor en el servidor");
  // Lo que ven las pantallas: sin la contraseña.
  assert.equal(vigia.S.mqtt.hayClave, true);
  assert.equal(vigia.S.mqtt.estado.fase, "conectada");
  assert.doesNotMatch(JSON.stringify(instantanea(vigia.S)), /secreta/);
});

test("alarma: sensor binario encendido y evento; «Enterado» desde HA queda visto en Vigía", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { vigia, nodo } = await montar(t);
  await vigia.mqtt.configurar({ activado: true, url: `127.0.0.1:${puerto}` });
  await hasta(() => ha.json(`vigia/nodo/${ID}/estado`), 5000, "estado de la caseta");
  nodo.ambiente(CASETA, { temperature: 31.5, relativeHumidity: 60 });
  await hasta(() => ha.json(`vigia/nodo/${ID}/estado`)?.a.temperature_alta === "ON", 5000, "alarma encendida");
  const d = ha.json(`vigia/nodo/${ID}/estado`).d.temperature_alta;
  assert.match(d.titulo, /Caseta huerto · Temperatura por encima de 30,0 °C/);
  assert.equal(d.visto, false);
  await hasta(() => ha.eventos.some((e) => e.event_type === "alarma"), 5000, "evento de alarma");
  assert.equal(ha.eventos.find((e) => e.event_type === "alarma").nodo, "Caseta huerto");
  assert.match(ha.eventos.find((e) => e.event_type === "alarma").detalle, /^Ahora \d+,\d °C\.$/);
  await hasta(() => ha.json("vigia/servidor/estado")?.sin_atender === 1, 5000, "una sin atender");
  // HA pulsa «Enterado · Temperatura alta».
  await ha.c.publishAsync(`vigia/nodo/${ID}/enterado`, "temperature_alta");
  const key = `${CASETA}|temperature|high`;
  await hasta(() => vigia.S.active.get(key)?.acked === true, 5000, "vista en Vigía");
  await hasta(() => ha.json(`vigia/nodo/${ID}/estado`)?.d.temperature_alta.visto === true, 5000, "vista en HA");
  await hasta(() => ha.json("vigia/servidor/estado")?.sin_atender === 0, 5000, "ninguna sin atender");
  assert.ok(ha.eventos.some((e) => e.event_type === "vista"));
  // Vuelve a su sitio: resuelta.
  nodo.ambiente(CASETA, { temperature: 25, relativeHumidity: 60 });
  await hasta(() => ha.eventos.some((e) => e.event_type === "resuelta"), 5000, "evento de resuelta");
  await hasta(() => ha.json(`vigia/nodo/${ID}/estado`)?.a.temperature_alta === "OFF", 5000, "alarma apagada");
});

test("«Enterado todas» desde HA", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { vigia, nodo } = await montar(t);
  await vigia.mqtt.configurar({ activado: true, url: `127.0.0.1:${puerto}` });
  nodo.ambiente(CASETA, { temperature: 33, relativeHumidity: 60 });
  await hasta(() => vigia.S.active.size === 1, 5000, "alarma");
  await hasta(() => ha.ultimo.has("vigia/estado"), 5000, "conectado");
  await ha.c.publishAsync("vigia/servidor/enterado_todas", "PRESS");
  await hasta(() => [...vigia.S.active.values()].every((a) => a.acked), 5000, "todas vistas");
});

test("dejar de vigilar quita sus entidades de HA y su estado retenido", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { vigia } = await montar(t);
  await vigia.mqtt.configurar({ activado: true, url: `127.0.0.1:${puerto}` });
  await hasta(() => ha.json(CFG("sensor", "temperature")), 5000, "sensor publicado");
  vigia.acciones.dejarDeVigilar(CASETA);
  vigia.eventos.emit("parte", "cfg");
  await hasta(() => ha.ultimo.get(CFG("sensor", "temperature")) === "", 5000, "sensor retirado");
  await hasta(() => ha.ultimo.get(`vigia/nodo/${ID}/estado`) === "", 5000, "estado retirado");
  assert.equal(ha.ultimo.get(CFG("button", "enterado_temperature_alta")), "");
  assert.ok(ha.json(CFG("binary_sensor", "receptor", "vigia_servidor")), "el servidor sigue");
});

test("al conectar quita lo que había de antes y ya no corresponde", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const viejo = "homeassistant/sensor/vigia_deadbeef/temperature/config";
  await ha.c.publishAsync(viejo, JSON.stringify({ name: "viejo" }), { retain: true });
  const ajeno = "homeassistant/sensor/zigbee_salon/temperature/config";
  await ha.c.publishAsync(ajeno, JSON.stringify({ name: "de otro" }), { retain: true });
  const { vigia } = await montar(t);
  await vigia.mqtt.configurar({ activado: true, url: `127.0.0.1:${puerto}` });
  await hasta(() => ha.ultimo.get(viejo) === "", 8000, "lo viejo de Vigía, retirado");
  assert.ok(ha.json(ajeno), "lo que no es de Vigía no se toca");
});

test("cuando HA arranca (homeassistant/status online), se le vuelve a contar todo", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { vigia } = await montar(t);
  await vigia.mqtt.configurar({ activado: true, url: `127.0.0.1:${puerto}` });
  await hasta(() => ha.json(CFG("sensor", "temperature")), 5000, "sensor publicado");
  ha.ultimo.clear();
  await ha.c.publishAsync("homeassistant/status", "online");
  await hasta(() => ha.json(CFG("sensor", "temperature")) && ha.json(`vigia/nodo/${ID}/estado`), 8000, "publicado otra vez");
});

test("usuario o contraseña mal: error en español; al corregirlos conecta", async (t) => {
  const { puerto } = await broker(t, { usuario: "vigia", clave: "buena" });
  const { vigia } = await montar(t);
  await vigia.mqtt.configurar({ activado: true, url: `127.0.0.1:${puerto}`, usuario: "vigia", clave: "mala" });
  await hasta(() => vigia.S.mqtt.estado.fase === "error", 5000, "error");
  assert.match(vigia.S.mqtt.estado.error, /usuario o contraseña incorrectos/);
  await vigia.mqtt.configurar({ clave: "buena" });
  await hasta(() => vigia.S.mqtt.estado.fase === "conectada", 5000, "conectada");
});

test("apagar Home Assistant retira sus entidades; apagar MQTT deja «offline»", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { vigia } = await montar(t);
  await vigia.mqtt.configurar({ activado: true, url: `127.0.0.1:${puerto}` });
  await hasta(() => ha.json(CFG("sensor", "temperature")), 5000, "sensor publicado");
  await vigia.mqtt.configurar({ ha: { activado: false } });
  await hasta(() => ha.ultimo.get(CFG("sensor", "temperature")) === "", 5000, "retirado");
  await vigia.mqtt.configurar({ activado: false });
  await hasta(() => ha.ultimo.get("vigia/estado") === "offline", 5000, "offline");
  assert.equal(vigia.S.mqtt.estado.fase, "parada");
});

test("si el servidor cae sin despedirse, el broker publica «offline» por él", async (t) => {
  const { puerto } = await broker(t);
  const ha = await espia(t, puerto);
  const { vigia } = await montar(t);
  await vigia.mqtt.configurar({ activado: true, url: `127.0.0.1:${puerto}` });
  await hasta(() => ha.ultimo.get("vigia/estado") === "online", 5000, "online");
  vigia.mqtt.conexion.c.stream.destroy(); // como si se cortara la luz
  await hasta(() => ha.ultimo.get("vigia/estado") === "offline", 5000, "testamento");
});
