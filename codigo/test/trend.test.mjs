// Pruebas de la alarma de tendencia. Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { trendOf, trendCheck, parseTrendRule, trendDefault, TREND_CLEAR } from "../src/trend.js";

const MIN = 60000, HOUR = 60 * MIN;
const T = Date.UTC(2026, 9, 17, 18, 0);
// Serie cada 30 min hasta T, con los valores dados (el último es el de T).
const serie = (vals, step = 30 * MIN) => vals.map((v, i) => ({ t: T - (vals.length - 1 - i) * step, v }));
const storm = { dir: "down", delta: 3, hours: 3 };

test("presión que baja 4 hPa en 3 h: salta", () => {
  const s = serie([1013, 1013.2, 1012.5, 1011.4, 1010.6, 1009.8, 1009.2]);
  const r = trendCheck(s, T, storm);
  assert.ok(r.fire);
  assert.equal(Math.round(r.change * 10) / 10, 4);
  assert.equal(r.from.v, 1013.2);
  assert.equal(r.to.v, 1009.2);
});

test("bajada lenta de 2 hPa en 3 h: no salta, y cierra una abierta", () => {
  const s = serie([1013, 1012.7, 1012.3, 1012, 1011.6, 1011.3, 1011]);
  const r = trendCheck(s, T, storm);
  assert.equal(r.fire, false);
  assert.equal(r.clear, true); // 2 < 3 × 0,7
});

test("entre el 70 % y el límite: ni salta ni cierra (histéresis)", () => {
  const s = serie([1013.5, 1013, 1012.5, 1012, 1011.5, 1011]); // 2,5 hPa en 2,5 h
  const r = trendCheck(s, T, storm);
  assert.equal(r.fire, false);
  assert.equal(r.clear, false);
  assert.ok(2.5 >= storm.delta * TREND_CLEAR);
});

test("lo que pasó fuera de la ventana no cuenta", () => {
  // Bajó 5 hPa hace 6 h y desde entonces está estable.
  const s = serie([1015, 1012, 1010, 1010, 1010.1, 1010, 1009.9, 1010, 1010.1, 1010, 1010, 1010, 1010]);
  assert.equal(trendCheck(s, T, storm).fire, false);
});

test("sin historia suficiente: null (ni salta ni cierra)", () => {
  assert.equal(trendOf(serie([1013, 1009]), T, 3), null); // solo 30 min de datos para una ventana de 3 h
  assert.equal(trendOf([{ t: T, v: 1010 }], T, 3), null);
  assert.ok(trendOf(serie([1013, 1012, 1011, 1009]), T, 3)); // 1,5 h: justo media ventana
});

test("subida: temperatura que sube 6 °C en una hora", () => {
  const s = serie([20, 20.5, 23, 26], 20 * MIN);
  const r = trendCheck(s, T, { dir: "up", delta: 5, hours: 1 });
  assert.ok(r.fire);
  assert.equal(r.change, 6);
  assert.equal(r.from.v, 20);
});

test("cuenta desde el máximo de la ventana, no desde la primera lectura", () => {
  // Sube un poco y luego cae: lo que importa es la caída desde el pico.
  const s = serie([1010, 1011.5, 1012, 1011, 1009.5, 1008.8]);
  const r = trendCheck(s, T, storm);
  assert.equal(r.from.v, 1012);
  assert.ok(Math.abs(r.change - 3.2) < 1e-9);
});

test("validación de la regla", () => {
  assert.deepEqual(parseTrendRule("down", 3, 3).rule, storm);
  assert.ok(parseTrendRule("down", 0, 3).error);
  assert.ok(parseTrendRule("down", 3, 0.2).error);
  assert.ok(parseTrendRule("down", 3, 30).error);
  assert.ok(parseTrendRule("sideways", 3, 3).error);
  assert.deepEqual(trendDefault("barometricPressure"), storm);
  assert.equal(trendDefault("cosaRara").hours, 3);
});
