// Pruebas de la entrega de avisos directos a un nodo. Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { newDelivery, deliveryStep } from "../src/delivery.js";

const ME = 0x1a2b3c4d, DEST = 0x0bd1f2a3, OTHER = 0x0c2d3e4f;
const ctx = { dest: DEST };
const run = (...evs) => evs.reduce((st, ev) => deliveryStep(st, ev, ctx), newDelivery());
const ack = (from, err = 0) => ({ type: "ack", from, err });

test("vecino directo: el acuse del destino lo da por entregado", () => {
  assert.equal(run(ack(DEST)).phase, "delivered");
});

test("el acuse implícito de tu receptor no es una entrega: solo que salió a la malla", () => {
  const st = run(ack(ME));
  assert.equal(st.phase, "relayed");
  assert.equal(run(ack(ME), ack(DEST)).phase, "delivered");
});

test("tras el acuse implícito, un error del camino o del destino lo da por fallido (antes salía «salió a la malla»)", () => {
  const st = run(ack(ME), ack(DEST, 35)); // PKI_UNKNOWN_PUBKEY
  assert.equal(st.phase, "failed");
  assert.equal(st.code, 35);
  assert.equal(st.relayed, true);
  assert.equal(run(ack(ME), ack(OTHER, 5)).phase, "failed"); // MAX_RETRANSMIT de un nodo intermedio
});

test("sin noticias del destino: sin confirmar, recordando si un vecino lo repitió", () => {
  const st = run(ack(ME), { type: "timeout" });
  assert.equal(st.phase, "unconfirmed");
  assert.equal(st.relayed, true);
  assert.equal(run({ type: "timeout" }).relayed, false);
});

test("un acuse del destino que llega tarde lo pasa a entregado (tarde)", () => {
  const a = run(ack(ME), { type: "timeout" }, ack(DEST));
  assert.equal(a.phase, "delivered");
  assert.equal(a.late, true);
  const b = run(ack(ME, 5), ack(DEST)); // el receptor agotó reintentos, pero el destino sí lo recibió
  assert.equal(b.phase, "delivered");
  assert.equal(b.late, true);
});

test("ya entregado: nada lo cambia; ya fallido: otro error no lo cambia", () => {
  assert.equal(run(ack(DEST), ack(OTHER, 5), { type: "timeout" }).phase, "delivered");
  const f = run(ack(DEST, 35), ack(OTHER, 5));
  assert.equal(f.code, 35);
});
