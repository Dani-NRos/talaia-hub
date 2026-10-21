// Datos que llegan por MQTT a los paneles: leer valores, unidades, qué tipo parece cada tema, configuración y horario
// de lo que sale a la malla.
import test from "node:test";
import assert from "node:assert/strict";
import {
  leerValor, convertir, comprobarDatos, comprobarMalla, proximoEnvio, textoValores, unidades, unidadDe, adivinarTipo,
  metasDe, esClaveMqtt, MALLA_DEFECTO, TIPOS, LISTA_TIPOS,
} from "../src/mqtt-datos.js";
import { metricMeta, registrarMetricas, fmtWithUnit } from "../src/metrics.js";

test("leer el valor: número suelto (Home Assistant) o campo de un JSON (zigbee2mqtt, Tasmota, Shelly)", () => {
  assert.deepEqual(leerValor("21.4"), { v: 21.4 });
  assert.deepEqual(leerValor(Buffer.from(" -3.5 ")), { v: -3.5 });
  assert.deepEqual(leerValor("21,4"), { v: 21.4 });
  assert.deepEqual(leerValor("unavailable"), { nulo: true });
  assert.deepEqual(leerValor("unknown"), { nulo: true });
  assert.deepEqual(leerValor(""), { nulo: true });
  assert.match(leerValor("soleado").error, /no es un número/);
  assert.match(leerValor('{"temperature":21}').error, /indica el campo/);
  const z = JSON.stringify({ temperature: 19.8, humidity: "61", battery: null, ENERGY: { Power: 120 }, estado: "ok" });
  assert.deepEqual(leerValor(z, "temperature"), { v: 19.8 });
  assert.deepEqual(leerValor(z, "humidity"), { v: 61 });
  assert.deepEqual(leerValor(z, "battery"), { nulo: true });
  assert.deepEqual(leerValor(z, "ENERGY.Power"), { v: 120 });
  assert.match(leerValor(z, "presion").error, /no trae «presion»/);
  assert.match(leerValor(z, "ENERGY").error, /no es un número/);
  assert.match(leerValor(z, "estado").error, /no es un número/);
  assert.match(leerValor("21.4", "temperature").error, /no trae «temperature»/);
  assert.match(leerValor("hola", "temperature").error, /no llega un JSON/);
});

test("unidades: se pasa a la de Vigía y se rechaza lo imposible", () => {
  assert.deepEqual(unidades("temperature"), ["°C", "°F"]);
  assert.deepEqual(unidades("windSpeed"), ["m/s", "km/h", "mph"]);
  assert.deepEqual(unidades("power"), ["W", "kW"]);
  assert.deepEqual(unidades("otro"), []);
  assert.deepEqual(convertir("temperature", "°C", 21.44), { v: 21.44 });
  assert.deepEqual(convertir("temperature", "°F", 68), { v: 20 });
  assert.deepEqual(convertir("windSpeed", "km/h", 36), { v: 10 });
  assert.deepEqual(convertir("windGust", "km/h", 15), { v: 4.1667 });
  assert.deepEqual(convertir("power", "kW", 1.5), { v: 1500 });
  assert.deepEqual(convertir("energy", "Wh", 2500), { v: 2.5 });
  assert.deepEqual(convertir("currentA", "mA", 350), { v: 0.35 });
  assert.deepEqual(convertir("otro", "rpm", 1234.5), { v: 1234.5 });
  // Presión en Pa en vez de hPa: no vale.
  assert.match(convertir("barometricPressure", "hPa", 101325).error, /101\.325 hPa no es normal: ¿está bien la unidad\?/);
  assert.match(convertir("relativeHumidity", "%", 140).error, /no es normal/);
  assert.equal(unidadDe("windSpeed", "km/h"), "km/h");
  assert.equal(unidadDe("barometricPressure", "mbar"), "mbar");
  assert.equal(unidadDe("power", "kw"), "kW");
  assert.equal(unidadDe("windSpeed", "kn"), null);
  assert.equal(textoValores({ relativeHumidity: 61, temperature: 21.44, windSpeed: 4.17 }), "Temperatura 21,4 °C · Humedad 61 % · Viento 4,2 m/s");
});

test("qué tipo parece cada tema: Home Assistant (por la entidad) y JSON (por el campo)", () => {
  const ha = (x) => `ha_estados/sensor/meteoclimatic_weather_for_alzira_ajuntament_valencia_espva4600000046600b_alzira_ajuntament_valencia_${x}/state`;
  assert.equal(adivinarTipo(ha("temperature")), "temperature");
  assert.equal(adivinarTipo(ha("humidity")), "relativeHumidity");
  assert.equal(adivinarTipo(ha("pressure")), "barometricPressure");
  assert.equal(adivinarTipo(ha("daily_precipitation")), "rainfall24h");
  assert.equal(adivinarTipo(ha("wind_speed")), "windSpeed");
  assert.equal(adivinarTipo(ha("daily_max_wind_speed")), "windGust");
  for (const x of ["dew_point", "wind_bearing", "uv_index", "feels_like", "power_factor"]) assert.equal(adivinarTipo(ha(x)), null, x);
  assert.equal(adivinarTipo("x/event_count"), null);
  // Enchufes: Tasmota (tele/…/SENSOR), Shelly de segunda generación (status/switch:0) y de la primera (relay/0/power).
  assert.equal(adivinarTipo("tele/enchufe/SENSOR", "ENERGY.Power"), "power");
  assert.equal(adivinarTipo("tele/enchufe/SENSOR", "ENERGY.Total"), "energy");
  assert.equal(adivinarTipo("tele/enchufe/SENSOR", "ENERGY.Voltage"), "voltage");
  assert.equal(adivinarTipo("tele/enchufe/SENSOR", "ENERGY.Current"), "currentA");
  assert.equal(adivinarTipo("tele/enchufe/SENSOR", "ENERGY.Factor"), null);
  assert.equal(adivinarTipo("shellyplus1pm/status/switch:0", "apower"), "power");
  assert.equal(adivinarTipo("shellyplus1pm/status/switch:0", "aenergy.total"), "energy");
  assert.equal(adivinarTipo("shellyplus1pm/status/switch:0", "temperature.tC"), "temperature");
  assert.equal(adivinarTipo("shellies/shellyplug-s/relay/0/power"), "power");
  assert.equal(adivinarTipo("tele/tasmota/SENSOR", "BME280.Pressure"), "barometricPressure");
  // zigbee2mqtt: el campo manda, no el nombre del dispositivo.
  assert.equal(adivinarTipo("zigbee2mqtt/Sensor temperatura", "humidity"), "relativeHumidity");
  assert.equal(adivinarTipo("zigbee2mqtt/Sensor temperatura", "battery"), "batteryLevel");
  assert.equal(adivinarTipo("zigbee2mqtt/Sensor temperatura", "linkquality"), null);
  assert.equal(adivinarTipo("zigbee2mqtt/Huerto", "soil_moisture"), "soilMoisture");
  assert.equal(adivinarTipo("estacio/pluviometre"), "rainfall24h");
});

test("datos de un panel: se completan, y lo que no vale se explica", () => {
  const prohibido = (t) => (t.startsWith("vigia/") ? "es de Vigía" : null);
  const c = (datos, receptor = false) => comprobarDatos(datos, { temaProhibido: prohibido, brokers: new Set(["b1", "local"]), receptor });
  const d = { tipo: "temperature", broker: "b1", tema: " ha/sensor/t/state " };
  assert.deepEqual(c([d]).datos, [{ nombre: "", tipo: "temperature", broker: "b1", tema: "ha/sensor/t/state", campo: "", unidad: "°C", caduca: 0, malla: false }]);
  assert.equal(c([{ ...d, clave: "mq3" }]).datos[0].clave, "mq3");
  assert.match(c([{ ...d, clave: "x" }]).error, /no es válida/);
  // Dos del mismo tipo: con nombres distintos sí.
  assert.match(c([d, { ...d, tema: "otro" }]).error, /Hay dos «Temperatura»/);
  assert.equal(c([d, { ...d, nombre: "Temperatura nevera" }]).datos.length, 2);
  assert.match(c([{ ...d, tema: "ha/#" }]).error, /no puede llevar «\+» ni «#»/);
  assert.match(c([{ ...d, tema: "" }]).error, /Falta el tema MQTT de «Temperatura»/);
  assert.match(c([{ ...d, tema: "vigia/nodo/x/estado" }]).error, /«Temperatura»: es de Vigía/);
  assert.match(c([{ ...d, tipo: "rpm" }]).error, /qué tipo de dato/);
  assert.match(c([{ ...d, unidad: "K" }]).error, /unidad de «Temperatura» no es válida/);
  assert.match(c([{ ...d, campo: "a..b" }]).error, /campo de «Temperatura» no es válido/);
  assert.match(c([{ ...d, caduca: 5 }]).error, /cuándo deja de mandarse/);
  assert.match(c([{ ...d, broker: "" }]).error, /Elige el broker de «Temperatura»/);
  assert.match(c([{ ...d, broker: "b7" }]).error, /broker de «Temperatura» ya no está/);
  assert.equal(c([{ tipo: "otro", nombre: "Revoluciones", unidad: "rpm", broker: "b1", tema: "x" }]).datos[0].unidad, "rpm");
  // A la malla: solo en el receptor, solo tipos que caben, uno de cada.
  assert.match(c([{ ...d, malla: true }]).error, /solo los datos del panel del receptor/);
  assert.equal(c([{ ...d, malla: true }], true).datos[0].malla, true);
  assert.match(c([{ ...d, tipo: "power", unidad: "W", malla: true }], true).error, /no tiene hueco para potencia/);
  assert.match(c([{ ...d, malla: true }, { ...d, nombre: "Otra", malla: true }], true).error, /solo tiene un hueco para cada tipo/);
  assert.equal(c([{ ...d, malla: true }, { ...d, nombre: "Otra" }], true).datos.length, 2);
});

test("lo de mandar a la malla", () => {
  assert.deepEqual(comprobarMalla({}).malla, MALLA_DEFECTO);
  assert.deepEqual(comprobarMalla({ activado: true, cada: 60, canal: 1, saltos: 3 }).malla, { activado: true, cada: 60, canal: 1, saltos: 3 });
  assert.match(comprobarMalla({ cada: 5 }).error, /cada cuánto/);
  assert.match(comprobarMalla({ saltos: 9 }).error, /saltos/);
  assert.match(comprobarMalla({ activado: true, canal: null }).error, /por qué canal/);
});

test("los datos MQTT se ven como métricas: nombre, unidad y decimales", () => {
  const metas = metasDe({ "-1": { datos: [{ clave: "mq1", nombre: "Nevera", tipo: "temperature" }, { clave: "mq2", tipo: "power" }, { clave: "mq3", tipo: "otro", unidad: "rpm" }] } });
  registrarMetricas(metas);
  assert.equal(metricMeta("mq1").label, "Nevera");
  assert.equal(fmtWithUnit("mq1", 4.26), "4,3 °C");
  assert.equal(fmtWithUnit("mq2", 1234.4), "1234 W");
  assert.equal(fmtWithUnit("mq3", 1500), "1500,00 rpm");
  assert.equal(metricMeta("temperature").label, "Temperatura", "las de Meshtastic, igual");
  registrarMetricas({});
  assert.equal(metricMeta("mq1").label, "mq1");
  assert.ok(esClaveMqtt("mq12") && !esClaveMqtt("temperature"));
  assert.equal(LISTA_TIPOS.length, Object.keys(TIPOS).length);
});

test("horario: en punto y a las y media (cada 30 min), contando desde la medianoche", () => {
  const h = (hh, mm, ss = 0) => new Date(2026, 9, 18, hh, mm, ss).getTime();
  assert.equal(proximoEnvio(h(23, 18), 30), h(23, 30));
  assert.equal(proximoEnvio(h(23, 30), 30), h(24, 0));
  assert.equal(proximoEnvio(h(23, 59, 59), 30), h(24, 0));
  assert.equal(proximoEnvio(h(10, 1), 15), h(10, 15));
  assert.equal(proximoEnvio(h(10, 1), 180), h(12, 0));
});
