// Pruebas del troceado de tramas del puerto serie. Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createFramer, createLines, frame, wakeBytes } from "../src/tramas.js";

const te = new TextEncoder();
const bytes = (...a) => new Uint8Array(a.flat());
const pkt = (p) => [...frame(new Uint8Array(p))];

test("trama: cabecera 0x94 0xC3 y longitud de dos bytes", () => {
  assert.deepEqual([...frame(new Uint8Array([1, 2, 3]))], [0x94, 0xc3, 0, 3, 1, 2, 3]);
  const big = frame(new Uint8Array(300));
  assert.deepEqual([...big.slice(0, 4)], [0x94, 0xc3, 1, 44]);
});

test("separa texto del registro y paquetes, aunque lleguen troceados", () => {
  const f = createFramer();
  const all = bytes([...te.encode("INFO | arranque\n")], pkt([8, 1]), [...te.encode("más texto\n")], pkt([0x0a, 0x02, 0x94, 0xc3]));
  const out = [];
  for (let i = 0; i < all.length; i += 3) out.push(...f.push(all.slice(i, i + 3))); // de 3 en 3 bytes
  const packets = out.filter((x) => x.type === "packet").map((x) => [...x.data]);
  // El segundo paquete lleva 0x94 0xC3 dentro: es un paquete válido y no se tira.
  assert.deepEqual(packets, [[8, 1], [0x0a, 0x02, 0x94, 0xc3]]);
  const text = new TextDecoder().decode(new Uint8Array(out.filter((x) => x.type === "text").flatMap((x) => [...x.data])));
  assert.equal(text, "INFO | arranque\nmás texto\n");
});

test("cabecera falsa con longitud imposible: se salta y se recupera", () => {
  const f = createFramer();
  const out = f.push(bytes([0x94, 0xc3, 0xff, 0xff], pkt([7, 7])));
  assert.deepEqual(out.filter((x) => x.type === "packet").map((x) => [...x.data]), [[7, 7]]);
});

test("un 0x94 al final se guarda por si es media cabecera", () => {
  const f = createFramer();
  const a = f.push(bytes([...te.encode("ok")], [0x94]));
  assert.deepEqual(a.map((x) => x.type), ["text"]);
  const b = f.push(bytes([0xc3, 0, 1, 9]));
  assert.deepEqual(b.map((x) => [x.type, [...x.data]]), [["packet", [9]]]);
});

test("líneas del registro: completas, sin colores ANSI, y guarda la que llega a medias", () => {
  const lines = [];
  const push = createLines((l) => lines.push(l));
  push(te.encode("\x1b[32mINFO\x1b[0m | arranque\r\nDEBUG | med"));
  assert.deepEqual(lines, ["INFO | arranque"]);
  push(te.encode("io\n"));
  assert.deepEqual(lines, ["INFO | arranque", "DEBUG | medio"]);
});

test("despertar: 32 bytes 0xC3", () => {
  const w = wakeBytes();
  assert.equal(w.length, 32);
  assert.ok(w.every((b) => b === 0xc3));
});
