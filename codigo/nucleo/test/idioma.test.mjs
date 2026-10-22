// The core's texts in Spanish and English: same keys, numbers and times in each language, alarm titles.
import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage, getLanguage, tx, _textDicts } from "../src/idioma.js";
import { fmtNum, metricMeta, fmtWithUnit } from "../src/metrics.js";
import { dur, ago } from "../src/textos.js";
import { NOMBRES_ESTADO, TIPOS } from "../src/mqtt-datos.js";
import { compass } from "../src/geo.js";

test("Spanish and English have the same keys", () => {
  const es = Object.keys(_textDicts.es), en = Object.keys(_textDicts.en);
  assert.deepEqual(en.filter((k) => !es.includes(k)), []);
  assert.deepEqual(es.filter((k) => !en.includes(k)), []);
});

test("numbers, times, names and states follow the language", () => {
  try {
    assert.equal(getLanguage(), "es");
    assert.equal(fmtNum(31.4, 1), "31,4");
    assert.equal(fmtNum(1015, 0), "1015");
    assert.equal(metricMeta("temperature").label, "Temperatura");
    assert.equal(dur(90 * 60000), "1 h 30 min");
    assert.equal(NOMBRES_ESTADO.abierta[1], "Cerrada");
    assert.equal(TIPOS.power.label, "Potencia");
    assert.equal(compass({ lat: 39, lon: -0.4 }, { lat: 38.9, lon: -0.5 }), "SO");
    setLanguage("en");
    assert.equal(fmtNum(31.4, 1), "31.4");
    assert.equal(fmtNum(1015, 0), "1015");
    assert.equal(fmtNum(12000, 0), "12,000");
    assert.equal(fmtWithUnit("barometricPressure", 1014.8), "1015 hPa");
    assert.equal(metricMeta("temperature").label, "Temperature");
    assert.equal(dur(2 * 86400000), "2 days");
    assert.equal(ago(Date.now() - 5 * 60000), "5 min ago");
    assert.equal(NOMBRES_ESTADO.abierta[1], "Closed");
    assert.equal(TIPOS.power.label, "Power");
    assert.equal(compass({ lat: 39, lon: -0.4 }, { lat: 38.9, lon: -0.5 }), "SW");
    assert.equal(tx("al.high", { name: "Huerto", label: "Temperature", limit: "30.0 °C" }), "Huerto · Temperature above 30.0 °C");
  } finally {
    setLanguage("es");
  }
});
