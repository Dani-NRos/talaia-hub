// La estación (datos de MQTT que salen a la malla como del receptor): leer valores, unidades, configuración y horario.
import test from "node:test";
import assert from "node:assert/strict";
import {
  leerValor, aMeshtastic, comprobarEstacion, proximoEnvio, textoValores, unidades, ESTACION_DEFECTO, METRICAS_ESTACION,
} from "../src/estacion.js";

test("leer el valor: número suelto (Home Assistant) o campo de un JSON (zigbee2mqtt, Shelly)", () => {
  assert.deepEqual(leerValor("21.4"), { v: 21.4 });
  assert.deepEqual(leerValor(Buffer.from(" -3.5 ")), { v: -3.5 });
  assert.deepEqual(leerValor("21,4"), { v: 21.4 });
  assert.deepEqual(leerValor("unavailable"), { nulo: true });
  assert.deepEqual(leerValor("unknown"), { nulo: true });
  assert.deepEqual(leerValor(""), { nulo: true });
  assert.match(leerValor("soleado").error, /no es un número/);
  assert.match(leerValor('{"temperature":21}').error, /indica el campo/);
  const z = JSON.stringify({ temperature: 19.8, humidity: "61", battery: null, datos: { lluvia: 0.4 }, estado: "ok" });
  assert.deepEqual(leerValor(z, "temperature"), { v: 19.8 });
  assert.deepEqual(leerValor(z, "humidity"), { v: 61 });
  assert.deepEqual(leerValor(z, "battery"), { nulo: true });
  assert.deepEqual(leerValor(z, "datos.lluvia"), { v: 0.4 });
  assert.match(leerValor(z, "presion").error, /no trae «presion»/);
  assert.match(leerValor(z, "datos").error, /no es un número/);
  assert.match(leerValor(z, "estado").error, /no es un número/);
  assert.match(leerValor("21.4", "temperature").error, /no trae «temperature»/);
  assert.match(leerValor("hola", "temperature").error, /no llega un JSON/);
});

test("unidades: se pasa a la de Meshtastic y se rechaza lo imposible", () => {
  assert.deepEqual(unidades("temperature"), ["°C", "°F"]);
  assert.deepEqual(unidades("windSpeed"), ["m/s", "km/h", "mph"]);
  assert.deepEqual(unidades("barometricPressure"), ["hPa"]);
  assert.deepEqual(aMeshtastic("temperature", "°C", 21.44), { v: 21.44 });
  assert.deepEqual(aMeshtastic("temperature", "°F", 68), { v: 20 });
  assert.deepEqual(aMeshtastic("windSpeed", "km/h", 36), { v: 10 });
  assert.deepEqual(aMeshtastic("windGust", "km/h", 15), { v: 4.17 });
  assert.deepEqual(aMeshtastic("windSpeed", "mph", 10), { v: 4.47 });
  // Presión en Pa en vez de hPa: no se manda a la malla.
  assert.match(aMeshtastic("barometricPressure", "hPa", 101325).error, /101\.325 hPa no es normal: ¿está bien la unidad\?/);
  assert.match(aMeshtastic("relativeHumidity", "%", 140).error, /no es normal/);
  assert.equal(textoValores({ relativeHumidity: 61, temperature: 21.44, windSpeed: 4.17 }), "Temperatura 21,4 °C · Humedad 61 % · Viento 4,2 m/s");
});

test("configuración: se completa, y lo que no vale se explica", () => {
  const prohibido = (t) => (t.startsWith("vigia/") ? "es de Vigía" : null);
  const c = (dada, antes) => comprobarEstacion(dada, antes, { temaProhibido: prohibido, brokers: new Set(["b1", "local"]) });
  const dato = { metrica: "temperature", broker: "b1", tema: " ha/sensor/t/state " };
  const ok = c({ activado: true, datos: [dato] }).cfg;
  assert.deepEqual(ok, { activado: true, cada: 30, canal: 0, saltos: null, datos: [{ metrica: "temperature", broker: "b1", tema: "ha/sensor/t/state", campo: "", unidad: "°C", caduca: 0 }] });
  // Lo que no viene se queda.
  assert.equal(c({ cada: 60 }, ok).cfg.datos.length, 1);
  assert.equal(c({}, {}).cfg.activado, false);
  assert.deepEqual(c({}).cfg, ESTACION_DEFECTO);
  assert.match(c({ datos: [dato, { ...dato, tema: "otro" }] }).error, /«Temperatura» está dos veces/);
  assert.match(c({ datos: [{ ...dato, tema: "ha/#" }] }).error, /no puede llevar «\+» ni «#»/);
  assert.match(c({ datos: [{ ...dato, tema: "" }] }).error, /Falta el tema MQTT de «Temperatura»/);
  assert.match(c({ datos: [{ ...dato, tema: "vigia/nodo/x/estado" }] }).error, /«Temperatura»: es de Vigía/);
  assert.match(c({ datos: [{ ...dato, metrica: "batteryLevel" }] }).error, /Elige qué dato/);
  assert.match(c({ datos: [{ ...dato, unidad: "K" }] }).error, /unidad de «Temperatura» no es válida/);
  assert.match(c({ datos: [{ ...dato, campo: "a..b" }] }).error, /campo de «Temperatura» no es válido/);
  assert.match(c({ datos: [{ ...dato, caduca: 5 }] }).error, /cuándo deja de mandarse/);
  assert.match(c({ cada: 5 }).error, /cada cuánto/);
  assert.match(c({ saltos: 9 }).error, /saltos/);
  assert.match(c({ activado: true, canal: null, datos: [dato] }).error, /por qué canal/);
  assert.match(c({ activado: true, datos: [] }).error, /al menos un dato/);
  assert.match(c({ datos: [{ ...dato, broker: "" }] }).error, /Elige el broker de «Temperatura»/);
  assert.match(c({ datos: [{ ...dato, broker: "b7" }] }).error, /broker de «Temperatura» ya no está/);
  // Con km/h y caducidad.
  const v = c({ datos: [{ metrica: "windSpeed", broker: "local", tema: "ha/v", unidad: "km/h", caduca: 60 }] }).cfg.datos[0];
  assert.deepEqual(v, { metrica: "windSpeed", broker: "local", tema: "ha/v", campo: "", unidad: "km/h", caduca: 60 });
  assert.equal(METRICAS_ESTACION.length, new Set(METRICAS_ESTACION).size);
});

test("horario: en punto y a las y media (cada 30 min), contando desde la medianoche", () => {
  const h = (hh, mm, ss = 0) => new Date(2026, 9, 18, hh, mm, ss).getTime();
  assert.equal(proximoEnvio(h(23, 18), 30), h(23, 30));
  assert.equal(proximoEnvio(h(23, 30), 30), h(24, 0)); // justo a la hora: el siguiente
  assert.equal(proximoEnvio(h(23, 59, 59), 30), h(24, 0));
  assert.equal(proximoEnvio(h(10, 1), 15), h(10, 15));
  assert.equal(proximoEnvio(h(10, 1), 180), h(12, 0));
  assert.equal(proximoEnvio(h(10, 1), 60), h(11, 0));
});

test("adivinar qué dato es por el nombre del tema (Home Assistant) o del campo (zigbee2mqtt)", async () => {
  const { adivinarMetrica: a, unidadDe } = await import("../src/estacion.js");
  // Los de Dani: Meteoclimatic en Home Assistant con mqtt_statestream.
  const ha = (x) => `ha_estados/sensor/meteoclimatic_weather_for_alzira_ajuntament_valencia_espva4600000046600b_alzira_ajuntament_valencia_${x}/state`;
  assert.equal(a(ha("temperature")), "temperature");
  assert.equal(a(ha("humidity")), "relativeHumidity");
  assert.equal(a(ha("pressure")), "barometricPressure");
  assert.equal(a(ha("daily_precipitation")), "rainfall24h");
  assert.equal(a(ha("wind_speed")), "windSpeed");
  assert.equal(a(ha("daily_max_wind_speed")), "windGust");
  // Lo que no cabe o no es lo que parece.
  for (const x of ["dew_point", "wind_bearing", "uv_index", "feels_like", "battery"]) assert.equal(a(ha(x)), null, x);
  assert.equal(a("x/event_count"), null);
  // Con JSON, manda el campo.
  assert.equal(a("zigbee2mqtt/Sensor temperatura", "humidity"), "relativeHumidity");
  assert.equal(a("zigbee2mqtt/Sensor temperatura", "voltage"), null);
  assert.equal(a("zigbee2mqtt/Huerto", "soil_moisture"), "soilMoisture");
  assert.equal(a("tele/tasmota/SENSOR", "BME280.Pressure"), "barometricPressure");
  assert.equal(a("shellies/ht/sensor/temperature"), "temperature");
  assert.equal(a("estacio/pluviometre"), "rainfall24h");
  // Unidades tal como las escribe Home Assistant.
  assert.equal(unidadDe("windSpeed", "km/h"), "km/h");
  assert.equal(unidadDe("barometricPressure", "mbar"), "hPa");
  assert.equal(unidadDe("windSpeed", "kn"), null);
});
