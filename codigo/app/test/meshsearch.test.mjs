// Pruebas del buscador de «Resto de la malla». Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { normalize, tokens, matchScore, searchNodes, highlight } from "../src/meshsearch.js";

const NOW = Date.UTC(2026, 9, 17, 21, 0);
const MIN = 60000, HOUR = 60 * MIN;
const ME = { lat: 39.152, lon: -3.438 };
const nodes = [
  { num: 0x5e10a001, long: "Atalaya R3/PEÑA DEL CUERVO", short: "R3", hw: "RAK4631", hops: 2, snr: 2.25, lastHeard: NOW - 3 * HOUR, pos: { lat: 39.05, lon: -3.5 } },
  { num: 0x0bd1f2a3, long: "V - VILLAVERDE - TORRE 4 ", short: "TOR4", hw: "HELTEC_V3", hops: 0, snr: 12.5, lastHeard: NOW - 2 * MIN, hasEnv: true, pos: { lat: 39.153, lon: -3.437 } },
  { num: 0x0c2d3e4f, long: "Orion 🌞🗼", short: "V1", hw: "HELTEC_V4", hops: 0, snr: -3, lastHeard: NOW - 16 * MIN, pos: { lat: 39.2, lon: -3.6 } },
  { num: 0x0d3e4f50, long: "Marco 66 T114 Cabo", short: "MB66", hw: "HELTEC_MESH_NODE_T114", hops: 2, snr: -2, lastHeard: NOW - 30 * HOUR },
  { num: 0x4b001337, long: "V - Norte - mesh.ejemplo.org 🏠🗼", short: "1337", hw: "", hops: 1, snr: null, lastHeard: NOW - 10 * MIN, hasEnv: true },
];
const names = (r) => r.map((x) => x.n.short);

test("normaliza sin tildes ni mayúsculas", () => {
  assert.equal(normalize("PEÑA Alcúdia"), "pena alcudia");
  assert.deepEqual(tokens("  Peña   el  "), ["pena", "el"]);
});

test("busca por nombre sin tildes, por nombre corto, por ID y por modelo", () => {
  assert.deepEqual(names(searchNodes(nodes, { q: "pena", now: NOW })), ["R3"]);
  assert.deepEqual(names(searchNodes(nodes, { q: "mb66", now: NOW })), ["MB66"]);
  assert.deepEqual(names(searchNodes(nodes, { q: "!0bd1", now: NOW })), ["TOR4"]);
  assert.deepEqual(names(searchNodes(nodes, { q: "bd1f2a3", now: NOW })), ["TOR4"]);
  assert.deepEqual(names(searchNodes(nodes, { q: "heltec v4", now: NOW })), ["V1"]);
  assert.deepEqual(names(searchNodes(nodes, { q: "t114", now: NOW })), ["MB66"]);
  // Una letra suelta no coincide con los ID (todos tienen letras hexadecimales).
  assert.deepEqual(names(searchNodes(nodes, { q: "f", now: NOW })), []);
});

test("varias palabras: tienen que estar todas, en cualquier campo", () => {
  assert.deepEqual(names(searchNodes(nodes, { q: "villaverde torre", now: NOW })), ["TOR4"]);
  assert.deepEqual(names(searchNodes(nodes, { q: "villaverde orion", now: NOW })), []);
  assert.deepEqual(names(searchNodes(nodes, { q: "cabo heltec", now: NOW })), ["MB66"]);
});

test("orden recomendado con texto: exacto, empieza por, contiene, solo ID o modelo", () => {
  const list = [
    { num: 1, long: "Caseta V1 huerto", short: "CSV1", lastHeard: NOW },
    { num: 2, long: "V1 repetidor", short: "REP", lastHeard: NOW - HOUR },
    { num: 3, long: "Orion", short: "V1", lastHeard: NOW - 2 * HOUR },
    { num: 4, long: "Otro", short: "OTR", hw: "HELTEC_V1", lastHeard: NOW },
  ];
  assert.deepEqual(searchNodes(list, { q: "v1", now: NOW }).map((x) => x.n.num), [3, 2, 1, 4]);
  assert.equal(matchScore(list[0], ["v1"]), 2); // «V1» empieza una palabra de «Caseta V1 huerto»
  assert.equal(matchScore({ num: 5, long: "CasetaV1", short: "X" }, ["v1"]), 3); // solo lo contiene
});

test("filtros: sensores, ubicación, cerca y últimas 24 h", () => {
  assert.deepEqual(names(searchNodes(nodes, { filters: new Set(["env"]), now: NOW })), ["TOR4", "1337"]);
  assert.deepEqual(names(searchNodes(nodes, { filters: new Set(["near", "pos"]), now: NOW })), ["TOR4", "V1"]);
  assert.ok(!names(searchNodes(nodes, { filters: new Set(["day"]), now: NOW })).includes("MB66"));
});

test("órdenes: saltos, distancia al receptor, señal y nombre", () => {
  assert.deepEqual(names(searchNodes(nodes, { sort: "hops", now: NOW })).slice(0, 2), ["TOR4", "V1"]);
  const byDist = searchNodes(nodes, { sort: "dist", now: NOW, from: ME });
  assert.deepEqual(names(byDist).slice(0, 3), ["TOR4", "R3", "V1"]);
  assert.ok(byDist[0].dist < 200);
  assert.equal(byDist.at(-1).dist, null); // sin ubicación, al final
  assert.deepEqual(names(searchNodes(nodes, { sort: "snr", now: NOW })), ["TOR4", "R3", "MB66", "V1", "1337"]);
  assert.equal(names(searchNodes(nodes, { sort: "name", now: NOW }))[0], "R3"); // «Atalaya…» va antes que «Marco»
});

test("sin texto ni filtros, el orden de siempre: primero con sensores, luego los oídos hace menos", () => {
  assert.deepEqual(names(searchNodes(nodes, { now: NOW })), ["TOR4", "1337", "V1", "R3", "MB66"]);
});

test("resaltado en el texto original, aunque lleve tildes", () => {
  assert.deepEqual(highlight("Peña del Cuervo", ["pena"]), [{ text: "Peña", hit: true }, { text: " del Cuervo", hit: false }]);
  assert.deepEqual(highlight("Torre 4", ["torre", "4"]).filter((p) => p.hit).map((p) => p.text), ["Torre", "4"]);
  assert.deepEqual(highlight("Orion 🌞", ["ion"]).map((p) => p.text), ["Or", "ion", " 🌞"]);
  assert.deepEqual(highlight("Nada", []), [{ text: "Nada", hit: false }]);
});
