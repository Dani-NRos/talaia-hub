// Pruebas del sitio actual de un nodo (nextPlace / readingPlace). Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { nextPlace, readingPlace, placeFromPos, moveThreshold } from "../src/geo.js";

const MIN = 60000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 16, 8, 0);
const ALZIRA = { lat: 39.15204, lon: -0.43797 };
// Desplaza un punto unos metros hacia el norte (1° de latitud ≈ 111 195 m).
const north = (p, m) => ({ lat: p.lat + m / 111195, lon: p.lon });
const pos = (p, t, bits = 32) => ({ ...p, t, bits });

// Aplica una serie de posiciones como lo hace setPosition.
const run = (list, place = null) => list.reduce((pl, p) => nextPlace(pl, p), place);

test("la primera posición crea el sitio, sin marcarlo como movido", () => {
  const pl = run([pos(ALZIRA, T0)]);
  assert.equal(pl.since, T0);
  assert.equal(pl.moved, false);
  assert.equal(readingPlace(pl, T0 - 5 * HOUR), "here");
});

test("nodo fijo: misma posición una y otra vez, el sitio no cambia", () => {
  const first = run([pos(ALZIRA, T0)]);
  const pl = run([pos(ALZIRA, T0 + HOUR), pos(ALZIRA, T0 + 2 * HOUR)], first);
  assert.equal(pl, first);
  assert.equal(readingPlace(pl, T0 - 24 * HOUR), "here");
});

test("ruido del GPS de 30 m no cuenta como moverse", () => {
  const pl = run([pos(ALZIRA, T0), pos(north(ALZIRA, 30), T0 + 15 * MIN), pos(north(ALZIRA, -25), T0 + 30 * MIN)]);
  assert.equal(pl.moved, false);
  assert.equal(pl.since, T0);
});

test("se mueve 5 km: lo de antes de llegar es de otro sitio", () => {
  const B = north(ALZIRA, 5000);
  const tB = T0 + HOUR;
  const pl = run([pos(ALZIRA, T0), pos(B, tB)]);
  assert.equal(pl.moved, true);
  assert.equal(pl.since, tB);
  assert.equal(readingPlace(pl, T0 + 10 * MIN), "elsewhere"); // medida en Alzira
  assert.equal(readingPlace(pl, T0 + 40 * MIN), "elsewhere"); // medida por el camino
  assert.equal(readingPlace(pl, tB - 30 * 1000), "here");     // 30 s de desfase de relojes
  assert.equal(readingPlace(pl, tB + 5 * MIN), "here");
});

test("coche aparcado: muchas posiciones en el destino no borran cuándo llegó", () => {
  // Con «las dos últimas posiciones» esto fallaría: tras aparcar, las dos coinciden
  // y una temperatura medida en el origen se pintaría como si fuera del destino.
  const B = north(ALZIRA, 8000);
  const tB = T0 + HOUR;
  const parked = Array.from({ length: 10 }, (_, i) => pos(north(B, (i % 3) * 10), tB + (i + 1) * 15 * MIN));
  const pl = run([pos(ALZIRA, T0), pos(B, tB), ...parked]);
  assert.equal(pl.since, tB);
  assert.equal(readingPlace(pl, T0 + 5 * MIN), "elsewhere");
  assert.equal(readingPlace(pl, tB + 2 * HOUR), "here");
});

test("quien avanza a pasos cortos también cuenta como movido", () => {
  // 120 m entre posiciones: ninguna pareja supera 200 m, pero se compara con el ancla.
  const steps = [0, 120, 240, 360].map((m, i) => pos(north(ALZIRA, m), T0 + i * 10 * MIN));
  const pl = run(steps);
  assert.equal(pl.moved, true);
  assert.equal(pl.since, T0 + 20 * MIN); // a 240 m del punto de partida
});

test("canal público (≈730 m): saltar de celda no es moverse, 3 km sí", () => {
  assert.ok(moveThreshold(15) > 1000 && moveThreshold(15) < 1200);
  const cell = run([pos(ALZIRA, T0, 15), pos(north(ALZIRA, 729), T0 + 30 * MIN, 15)]);
  assert.equal(cell.moved, false);
  const far = run([pos(ALZIRA, T0, 15), pos(north(ALZIRA, 3000), T0 + 30 * MIN, 15)]);
  assert.equal(far.moved, true);
});

test("precisión completa o desconocida: umbral de 200 m", () => {
  assert.equal(moveThreshold(32), 200);
  assert.equal(moveThreshold(0), 200);
  assert.equal(moveThreshold(undefined), 200);
});

test("nodos guardados antes de este cambio: sin sitio, todo cuenta como de aquí", () => {
  assert.equal(placeFromPos(null), null);
  assert.equal(readingPlace(null, T0), "here");
  const old = placeFromPos(pos(ALZIRA, T0 - 3 * 24 * HOUR));
  assert.equal(old.moved, false);
  const pl = nextPlace(old, pos(north(ALZIRA, 2000), T0));
  assert.equal(pl.moved, true);
  assert.equal(readingPlace(pl, T0 - HOUR), "elsewhere");
});
