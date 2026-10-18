// Pruebas del traceroute: lectura de la respuesta, ida/vuelta, saltos desconocidos y calidad. Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { decodeRouteDiscovery } from "../src/pb.js";
import { readTrace, relays, snrQuality, loraSf, weakest, traceTimeout, UNKNOWN_NODE } from "../src/route.js";

/* Codificador de prueba, como lo haría nanopb: campos repetidos empaquetados; int32 negativos en 10 bytes. */
function varint(v, out) {
  let x = BigInt.asUintN(64, BigInt(v));
  while (x > 0x7fn) { out.push(Number((x & 0x7fn) | 0x80n)); x >>= 7n; }
  out.push(Number(x));
}
function encode({ route = [], snrTowards = [], routeBack = [], snrBack = [] }, packed = true) {
  const out = [];
  const fx = (n, o) => o.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  const field = (no, vals, kind) => {
    if (!vals.length) return;
    if (packed) {
      const body = [];
      for (const v of vals) kind === "f" ? fx(v, body) : varint(v, body);
      varint(no * 8 + 2, out); varint(body.length, out); out.push(...body);
    } else {
      for (const v of vals) { varint(no * 8 + (kind === "f" ? 5 : 0), out); kind === "f" ? fx(v, out) : varint(v, out); }
    }
  };
  field(1, route, "f"); field(2, snrTowards, "v"); field(3, routeBack, "f"); field(4, snrBack, "v");
  return new Uint8Array(out);
}

const ME = 0x64591ab0, R3 = 0x2299aa10, DNN4 = 0xaa62b264, LEJOS = 0xdeadbeef;

test("lee la respuesta empaquetada y suelta, con SNR negativos", () => {
  const msg = { route: [R3], snrTowards: [25, -18], routeBack: [R3], snrBack: [-12, 28] };
  for (const packed of [true, false]) {
    const rd = decodeRouteDiscovery(encode(msg, packed));
    assert.deepEqual(rd, msg, packed ? "empaquetada" : "suelta");
  }
  assert.deepEqual(decodeRouteDiscovery(new Uint8Array()), { route: [], snrTowards: [], routeBack: [], snrBack: [] });
  assert.equal(decodeRouteDiscovery(new Uint8Array([0x0a, 0x08, 1, 2])), null); // cortada
});

test("directo: sin nodos intermedios, un SNR en cada sentido", () => {
  const t = readTrace({ route: [], snrTowards: [44], routeBack: [], snrBack: [41] }, ME, DNN4);
  assert.deepEqual(t.fwd, { nodes: [ME, DNN4], snr: [11] });
  assert.deepEqual(t.back, { nodes: [DNN4, ME], snr: [10.25] });
  assert.deepEqual(relays(t.fwd), []);
});

test("dos saltos, con la vuelta por otro camino", () => {
  const t = readTrace({ route: [R3, LEJOS], snrTowards: [25, -18, -50], routeBack: [R3], snrBack: [-39, 28] }, ME, DNN4);
  assert.deepEqual(t.fwd.nodes, [ME, R3, LEJOS, DNN4]);
  assert.deepEqual(t.fwd.snr, [6.25, -4.5, -12.5]);
  assert.deepEqual(t.back.nodes, [DNN4, R3, ME]);
  assert.deepEqual(t.back.snr, [-9.75, 7]);
  assert.deepEqual(weakest(t), { snr: -12.5, from: LEJOS, to: DNN4, leg: "fwd" });
});

test("salto desconocido (repite sin la clave del canal) y SNR desconocido", () => {
  const t = readTrace({ route: [UNKNOWN_NODE], snrTowards: [-128, 12], routeBack: [], snrBack: [8] }, ME, DNN4);
  assert.deepEqual(t.fwd.nodes, [ME, UNKNOWN_NODE, DNN4]);
  assert.deepEqual(t.fwd.snr, [null, 3]);
});

test("vuelta incompleta (firmware antiguo en el camino): sin vuelta y SNR de ida desconocidos", () => {
  const t = readTrace({ route: [R3], snrTowards: [], routeBack: [], snrBack: [] }, ME, DNN4);
  assert.deepEqual(t.fwd.snr, [null, null]);
  assert.equal(t.back, null);
  assert.equal(readTrace({ route: [], snrTowards: [4], routeBack: [], snrBack: [4] }, ME, DNN4, false).back, null);
});

test("calidad según el preset del receptor", () => {
  assert.equal(loraSf(null), 11);
  assert.equal(loraSf({ usePreset: true, modemPreset: 4 }), 9); // MediumFast
  assert.equal(loraSf({ usePreset: false, spreadFactor: 10 }), 10);
  assert.equal(snrQuality(-5, 11), "ok");    // 12,5 dB de margen sobre −17,5
  assert.equal(snrQuality(-10, 11), "warn");
  assert.equal(snrQuality(-15, 11), "bad");
  assert.equal(snrQuality(-5, 9), "warn");   // con MediumFast el mismo SNR va más justo
  assert.equal(snrQuality(null), null);
});

test("espera según los saltos", () => {
  assert.equal(traceTimeout(0), 60000);
  assert.equal(traceTimeout(3), 120000);
  assert.equal(traceTimeout(10), 150000);
  assert.equal(traceTimeout(undefined), 100000);
});
