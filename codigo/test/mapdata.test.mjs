// Pruebas de lo que pinta el mapa (sin Leaflet). Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { metricCounts, defaultMetric, mapPoints, declutter, ageOpacity, pillText, scaleFor, inkFor, ageMs } from "../src/mapdata.js";

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 16, 20, 0);
const pos = (lat, lon, t = NOW - HOUR, bits = 32) => ({ lat, lon, t, bits });

const nodes = [
  { num: 1, lastHeard: NOW - 5 * MIN, pos: pos(39.15, -0.43), metrics: { temperature: { v: 18.4, t: NOW - 5 * MIN }, relativeHumidity: { v: 66, t: NOW - 5 * MIN }, channelUtilization: { v: 12, t: NOW } } },
  { num: 2, lastHeard: NOW - 2 * HOUR, pos: pos(39.16, -0.44), metrics: { temperature: { v: 31.2, t: NOW - 2 * HOUR } } },
  { num: 3, lastHeard: NOW - 3 * DAY, pos: pos(39.2, -0.5), metrics: { temperature: { v: 9, t: NOW - 3 * DAY } } }, // vieja
  { num: 4, lastHeard: NOW - 10 * MIN, pos: pos(39.17, -0.42), metrics: { batteryLevel: { v: 101, t: NOW - 10 * MIN } } }, // sin temperatura
  { num: 5, lastHeard: NOW, metrics: { temperature: { v: 20, t: NOW } } }, // sin ubicación: nunca sale
  // Se movió: llegó a su sitio hace 1 h y su temperatura es de hace 3 h.
  { num: 6, lastHeard: NOW, pos: pos(39.3, -0.6), place: { lat: 39.3, lon: -0.6, since: NOW - HOUR, moved: true, bits: 32 }, metrics: { temperature: { v: 25, t: NOW - 3 * HOUR } } },
];

test("recuento por métrica: solo con ubicación, dentro del periodo y sin métricas de canal", () => {
  const c = metricCounts(nodes, ageMs("24h"), NOW);
  assert.deepEqual([...c], [["temperature", 3], ["relativeHumidity", 1], ["batteryLevel", 1]]);
  assert.equal(metricCounts(nodes, ageMs("all"), NOW).get("temperature"), 4);
  assert.equal(metricCounts(nodes, ageMs("3h"), NOW).get("temperature"), 3); // la de hace 3 h justas entra
});

test("métrica por defecto: la elegida si existe, si no temperatura, si no la más extendida", () => {
  const c = metricCounts(nodes, ageMs("24h"), NOW);
  assert.equal(defaultMetric(c), "temperature");
  assert.equal(defaultMetric(c, "batteryLevel"), "batteryLevel");
  assert.equal(defaultMetric(new Map([["lux", 1], ["co2", 3]])), "co2");
  assert.equal(defaultMetric(new Map()), null);
});

test("puntos: los que tienen la métrica, y aparte los nodos oídos sin ella", () => {
  const { points, others } = mapPoints(nodes, "temperature", ageMs("24h"), NOW);
  assert.deepEqual(points.map((p) => p.num).sort(), [1, 2, 6]);
  assert.deepEqual(others.map((o) => o.num), [4]); // el 3 es de hace 3 días: fuera del periodo
  assert.equal(points.find((p) => p.num === 6).far, true);
  assert.equal(points.find((p) => p.num === 1).far, false);
});

test("radio de precisión: solo cuando el canal recorta la posición", () => {
  const ns = [
    { num: 1, lastHeard: NOW, pos: pos(39.1, -0.4, NOW, 15), metrics: { temperature: { v: 20, t: NOW } } }, // canal público
    { num: 2, lastHeard: NOW, pos: pos(39.2, -0.4, NOW, 32), metrics: { temperature: { v: 20, t: NOW } } }, // completa
    { num: 3, lastHeard: NOW, pos: pos(39.3, -0.4, NOW, 0), metrics: { temperature: { v: 20, t: NOW } } },  // desconocida
    { num: 4, lastHeard: NOW, pos: pos(39.4, -0.4, NOW, 13), metrics: {} },                                    // sin sensor
  ];
  const { points, others } = mapPoints(ns, "temperature", ageMs("24h"), NOW);
  const acc = Object.fromEntries([...points, ...others].map((q) => [q.num, q.acc]));
  assert.ok(acc[1] > 700 && acc[1] < 760);
  assert.equal(acc[2], null);
  assert.equal(acc[3], null);
  assert.ok(acc[4] > 2800 && acc[4] < 3000);
});

test("píldoras que se pisan: la primera se queda, las demás se apartan arriba y abajo", () => {
  const pill = (key, x, y) => ({ key, x, y, w: 52, h: 26 });
  const off = declutter([pill(1, 100, 100), pill(2, 100, 100), pill(3, 104, 100), pill(4, 400, 100)]);
  assert.deepEqual([off.get(1), off.get(2), off.get(3), off.get(4)], [0, -29, 29, 0]);
  // Lejos: nadie se mueve.
  const far = declutter([pill(1, 0, 0), pill(2, 0, 200)]);
  assert.deepEqual([far.get(1), far.get(2)], [0, 0]);
});

test("opacidad baja con la antigüedad", () => {
  assert.equal(ageOpacity(10 * MIN), 1);
  assert.ok(ageOpacity(3 * HOUR) < 1);
  assert.ok(ageOpacity(2 * DAY) < ageOpacity(12 * HOUR));
});

test("texto de la píldora", () => {
  assert.equal(pillText("temperature", 18.44), "18,4°");
  assert.equal(pillText("relativeHumidity", 65.6), "66 %");
  assert.equal(pillText("barometricPressure", 1012.3), "1012"); // en español, 4 cifras van sin punto de millar
  assert.equal(pillText("batteryLevel", 101), "USB");
  assert.equal(pillText("voltage", 3.912), "3,91 V");
});

test("temperatura: frío azul, 18° gris neutro, calor rojo; fuera de rango se satura", () => {
  const sc = scaleFor("temperature", [5, 30]);
  assert.equal(sc.kind, "div");
  assert.equal(sc.color(18), "#f0efec");
  assert.equal(sc.color(-2), "#0d366b");
  assert.equal(sc.color(-20), "#0d366b");
  assert.equal(sc.color(38), "#641819");
  const [r, , b] = [1, 3, 5].map((i) => parseInt(sc.color(30).slice(i, i + 2), 16));
  assert.ok(r > b, "30° debe tirar a rojo");
});

test("secuencial: claro el mínimo, oscuro el máximo; un solo valor no rompe", () => {
  const sc = scaleFor("barometricPressure", [1005, 1020]);
  assert.equal(sc.color(1005), "#cde2fb");
  assert.equal(sc.color(1020), "#0d366b");
  const one = scaleFor("barometricPressure", [1012]);
  assert.equal(one.kind, "one");
  assert.match(one.color(1012), /^#[0-9a-f]{6}$/);
  assert.equal(scaleFor("batteryLevel", [101]).kind, "seq"); // rango fijo 0–100
});

test("tinta de la píldora: oscura sobre claro, blanca sobre oscuro", () => {
  assert.equal(inkFor("#f0efec"), "#152320");
  assert.equal(inkFor("#cde2fb"), "#152320");
  assert.equal(inkFor("#0d366b"), "#ffffff");
  assert.equal(inkFor("#641819"), "#ffffff");
});
