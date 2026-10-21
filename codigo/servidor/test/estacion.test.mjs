// La estación: datos que llegan por MQTT (como los publica Home Assistant con mqtt_statestream, o zigbee2mqtt) salen a
// la malla como telemetría de ambiente del receptor y se guardan como lecturas suyas. Broker de verdad en memoria
// (aedes), un «Home Assistant» que publica y el nodo Meshtastic simulado de siempre, que ve el paquete que le llega.
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
import { telemetriaAmbiente } from "../src/estacion.js";
import { NodoFalso, hasta, ME, PORT } from "./nodo-falso.mjs";

const M = Protobuf.Mesh, TEL = Protobuf.Telemetry;
const T_TEMP = "ha_estados/sensor/estacion_temperatura/state";
const T_VIENTO = "ha_estados/sensor/estacion_viento/state";
const T_Z2M = "zigbee2mqtt/Estación del barrio";

async function broker(t) {
  const aedes = await Aedes.createBroker();
  const srv = net.createServer(aedes.handle);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise((r) => aedes.close(r)); await new Promise((r) => srv.close(r)); });
  return srv.address().port;
}

/** Quien publica los datos (Home Assistant, zigbee2mqtt), retenidos como hace mqtt_statestream. */
async function publicador(t, puerto) {
  const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { clientId: `ha-${Math.random()}` });
  t.after(() => c.endAsync());
  return (tema, carga) => c.publishAsync(tema, typeof carga === "string" ? carga : JSON.stringify(carga), { retain: true });
}

async function montar(t, puerto) {
  const nodo = new NodoFalso();
  const puertoNodo = await nodo.escucharTcp();
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, datos: os.tmpdir() });
  const registro = crearRegistro({ nivel: "error", salida: [] });
  const vigia = await crearVigia(config, registro, { almacen: abrirAlmacen(":memory:") });
  vigia.arrancar();
  await hasta(() => vigia.S.link.state === "ready", 8000, "receptor listo");
  t.after(async () => { await vigia.detener(); await nodo.cerrar(); });
  // El broker de Home Assistant («b1»), publicando también para Home Assistant (lo suyo no debe volver a la malla).
  assert.equal((await vigia.mqtt.configurarBroker(null, { nombre: "Home Assistant", url: `127.0.0.1:${puerto}` })).ok, true);
  assert.equal((await vigia.mqtt.configurarHA({ activado: true, broker: "b1" })).ok, true);
  await hasta(() => vigia.mqtt.conexion("b1")?.conectada, 5000, "MQTT conectado");
  return { vigia, nodo };
}

const DATOS = [
  { metrica: "temperature", broker: "b1", tema: T_TEMP },
  { metrica: "relativeHumidity", broker: "b1", tema: T_Z2M, campo: "humidity" },
  { metrica: "barometricPressure", broker: "b1", tema: T_Z2M, campo: "pressure" },
  { metrica: "windSpeed", broker: "b1", tema: T_VIENTO, unidad: "km/h" },
  { metrica: "rainfall24h", broker: "b1", tema: T_Z2M, campo: "lluvia.hoy", caduca: 60 },
];

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
  assert.ok(Math.abs(e.rainfall24h - 1.2) < 1e-4);
  assert.equal(e.barometricPressure, undefined); // lo que no se manda no va (no un 0)
});

test("de MQTT a la malla: valores al momento, envío por el canal y saltos elegidos, y lecturas del receptor", async (t) => {
  const puerto = await broker(t);
  const publicar = await publicador(t, puerto);
  const { vigia, nodo } = await montar(t, puerto);
  const { S, estacion } = vigia;
  await publicar(T_TEMP, "21.4");
  await publicar(T_VIENTO, "15");
  await publicar(T_Z2M, { humidity: 61, pressure: 1016.2, lluvia: { hoy: 0.4 }, battery: 90 });

  // Lo que no vale, con su motivo.
  assert.match(estacion.configurar({ datos: [{ metrica: "temperature", broker: "b1", tema: "vigia/nodo/3c6e19a2/estado" }] }).error, /publica Vigía/);
  assert.match(estacion.configurar({ datos: [{ metrica: "temperature", broker: "b1", tema: "ha_estados/sensor/vigia_dnn_5_temperatura/state" }] }).error, /publica Vigía/);
  assert.match(estacion.configurar({ activado: true, datos: [] }).error, /al menos un dato/);

  const r = estacion.configurar({ activado: true, canal: 1, saltos: 3, datos: DATOS });
  assert.equal(r.ok, true, r.error);
  assert.match(r.toast, /Próximo envío a las \d\d:\d\d/);
  // Llegan (retenidos) nada más suscribirse; el viento, de km/h a m/s.
  await hasta(() => estacion.valores.size === 5, 5000, "los cinco valores");
  assert.equal(estacion.valores.get("temperature").v, 21.4);
  assert.deepEqual({ ...estacion.valores.get("windSpeed"), t: 0 }, { v: 4.17, b: 15, u: "km/h", t: 0 });
  assert.equal(estacion.valores.get("rainfall24h").v, 0.4);
  // Lo ven las pantallas: configuración, valores y lo que saldría.
  await hasta(() => instantanea(S).estacion?.previo?.texto?.includes("Viento"), 3000, "previo en pantalla");
  const est = instantanea(S).estacion;
  assert.equal(est.previo.texto, "Temperatura 21,4 °C · Humedad 61 % · Presión 1016 hPa · Viento 4,2 m/s · Lluvia 24 h 0,4 mm");
  assert.ok(est.proximo > Date.now() && est.proximo <= Date.now() + 30 * 60000);
  assert.equal(est.receptor, "DNN 5");

  // Se manda: un paquete de telemetría a todos, por el canal 1 y con 3 saltos.
  const oidoAntes = S.nodes.get(ME).lastHeard;
  const envio = estacion.enviar(true);
  await nodo.esperar(() => telemetria(nodo), 5000, "telemetría");
  const { p, tel } = telemetria(nodo);
  // Lecturas del receptor sin tocar cuándo se le oyó: no han llegado por radio.
  assert.equal(S.nodes.get(ME).lastHeard, oidoAntes);
  assert.equal(p.to, 0xffffffff);
  assert.equal(p.channel, 1);
  assert.equal(p.hopLimit, 3);
  assert.equal(p.wantAck, true);
  const e = tel.variant.value;
  assert.equal(tel.variant.case, "environmentMetrics");
  assert.ok(Math.abs(e.temperature - 21.4) < 1e-4 && e.relativeHumidity === 61 && Math.abs(e.windSpeed - 4.17) < 1e-4);
  assert.ok(Math.abs(e.barometricPressure - 1016.2) < 1e-3 && Math.abs(e.rainfall24h - 0.4) < 1e-4);
  assert.ok(Math.abs(tel.time - Date.now() / 1000) < 5);
  acuse(nodo, p.id);
  await envio;
  assert.equal(S.estacion.ultimo.resultado, "repetido por la malla");
  assert.equal(S.estacion.ultimo.ok, true);
  assert.equal(S.estacion.ultimo.destino, "canal «avisos»");
  // Y quedan como lecturas del receptor.
  const n = S.nodes.get(ME);
  assert.equal(n.metrics.temperature.v, 21.4);
  assert.equal(n.metrics.windSpeed.v, 4.17);
  assert.equal(n.hasEnv, true);
  await hasta(async () => (await S.store.series(ME, "temperature", 0)).length === 1, 3000, "lectura guardada");
});

test("lo que no está al día no sale; sin receptor se guarda la lectura igual; los fallos de la malla se cuentan", async (t) => {
  const puerto = await broker(t);
  const publicar = await publicador(t, puerto);
  const { vigia, nodo } = await montar(t, puerto);
  const { S, estacion } = vigia;
  await publicar(T_TEMP, "unavailable");
  await publicar(T_VIENTO, "huracán");
  await publicar(T_Z2M, { humidity: 61, pressure: 101620, lluvia: { hoy: 0.4 } }); // presión en Pa: no
  assert.equal(estacion.configurar({ activado: true, datos: DATOS }).ok, true);
  await hasta(() => estacion.valores.size === 5, 5000, "valores");
  // La lluvia, con caducidad de 1 h: como si el último dato fuera de hace 2 h.
  estacion.valores.get("rainfall24h").t -= 2 * 3600000;
  const envio = estacion.enviar(true);
  await nodo.esperar(() => telemetria(nodo), 5000, "telemetría");
  const { p, tel } = telemetria(nodo);
  assert.deepEqual(Object.keys(tel.variant.value).filter((k) => typeof tel.variant.value[k] === "number"), ["relativeHumidity"]);
  assert.equal(p.hopLimit, 0); // sin elegir: los del receptor (los pone el firmware)
  assert.equal(p.channel, 0);
  const faltan = S.estacion.ultimo.faltan.join(" | ");
  assert.match(faltan, /Temperatura \(no disponible\)/);
  assert.match(faltan, /Viento \(«huracán» no es un número\)/);
  assert.match(faltan, /Presión \(101\.620 hPa no es normal: ¿está bien la unidad\?\)/);
  assert.match(faltan, /Lluvia 24 h \(sin datos nuevos desde las \d\d:\d\d\)/);
  // La malla no lo repite.
  acuse(nodo, p.id, Protobuf.Mesh.Routing_Error.MAX_RETRANSMIT);
  await envio;
  assert.equal(S.estacion.ultimo.ok, false);
  assert.match(S.estacion.ultimo.resultado, /nadie lo repitió/);

  // Nada al día: no se manda nada.
  await publicar(T_Z2M, { humidity: "unknown" });
  await hasta(() => estacion.valores.get("relativeHumidity").nulo, 3000, "humedad no disponible");
  const antes = nodo.paquetes(PORT.TELEMETRY_APP).length;
  await estacion.enviar(true);
  assert.equal(S.estacion.ultimo.resultado, "nada que mandar: ningún dato al día");
  assert.equal(nodo.paquetes(PORT.TELEMETRY_APP).length, antes);

  // Sin receptor: no sale, pero queda la lectura.
  await publicar(T_TEMP, "18.2");
  await hasta(() => estacion.valores.get("temperature").v === 18.2, 3000, "temperatura");
  nodo.cerrarFlujo();
  await hasta(() => S.link.state !== "ready", 5000, "receptor perdido");
  await estacion.enviar(true);
  assert.match(S.estacion.ultimo.resultado, /no ha salido: el receptor no está conectado/);
  assert.equal(S.nodes.get(ME).metrics.temperature.v, 18.2);
});

test("buscar temas: los que traen números, sin lo que publica Vigía; y sigue al cambiar de broker", async (t) => {
  const puerto = await broker(t);
  const publicar = await publicador(t, puerto);
  const { vigia } = await montar(t, puerto);
  const { estacion } = vigia;
  await publicar(T_TEMP, "21.4");
  await publicar(T_Z2M, { humidity: 61, datos: { presion: 1016 }, nombre: "estación", lista: [1, 2] });
  await publicar("ha_estados/sensor/vigia_dnn_5_temperatura/state", "21.4");
  await publicar("homeassistant/sensor/algo/config", { suggested_display_precision: 1 });
  // mqtt_statestream con publish_attributes: la unidad va en su propio tema, como texto JSON.
  await publicar(T_VIENTO, "15");
  await publicar("ha_estados/sensor/estacion_viento/unit_of_measurement", '"km/h"');
  await publicar("ha_estados/sensor/estacion_viento/friendly_name", '"Viento"');
  await hasta(() => vigia.S.mqtt.brokers[0].estado.fase === "conectada", 3000, "conectado");
  const r = await estacion.buscarTemas();
  assert.equal(r.ok, true);
  const vistos = r.temas.map((x) => `${x.tema}|${x.campo}`);
  assert.ok(vistos.includes(`${T_TEMP}|`));
  assert.ok(r.temas.every((x) => x.broker === "b1"));
  assert.ok(vistos.includes(`${T_Z2M}|humidity`));
  assert.ok(vistos.includes(`${T_Z2M}|datos.presion`));
  assert.equal(r.temas.find((x) => x.tema === T_VIENTO).unidad, "km/h");
  assert.equal(r.temas.find((x) => x.tema === T_TEMP).unidad, undefined);
  assert.ok(!vistos.some((v) => /unit_of_measurement|friendly_name/.test(v)));
  assert.ok(!vistos.some((v) => /vigia|config|nombre|lista/.test(v)), vistos.join("\n"));
  // Lo que publica la salida a Home Assistant (vigia/…) tampoco.
  assert.ok(!r.temas.some((x) => x.tema.startsWith("vigia/")));

  // Al volver a configurar MQTT (nueva conexión), la estación se vuelve a enganchar.
  assert.equal(estacion.configurar({ datos: [{ metrica: "temperature", broker: "b1", tema: T_TEMP }] }).ok, true);
  await hasta(() => estacion.valores.get("temperature")?.v === 21.4, 3000, "temperatura");
  await vigia.mqtt.configurarBroker("b1", { nombre: "HA de casa" });
  await hasta(() => vigia.mqtt.conexion("b1")?.conectada, 5000, "reconectado");
  await publicar(T_TEMP, "22.6");
  await hasta(() => estacion.valores.get("temperature")?.v === 22.6, 5000, "valor nuevo tras reconectar");
  // Un dato de un broker que no existe no vale; y no se puede quitar un broker que usa la estación.
  assert.match(estacion.configurar({ datos: [{ metrica: "temperature", broker: "b5", tema: T_TEMP }] }).error, /ya no está en la lista/);
  await vigia.mqtt.configurarHA({ activado: false });
  assert.match((await vigia.mqtt.quitarBroker("b1")).error, /Lo usa: la estación \(Temperatura\)/);
  // Sin ningún broker conectado: buscar avisa.
  await vigia.mqtt.configurarBroker("b1", { activado: false });
  assert.match((await estacion.buscarTemas()).error, /Primero conecta algún broker/);
});
