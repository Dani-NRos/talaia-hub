// Pruebas del enlace por cable con un puerto simulado (el troceado de tramas se prueba en el núcleo). Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { frame, SerialLink, classifySerial } from "../src/serial.js";

const te = new TextEncoder();
const bytes = (...a) => new Uint8Array(a.flat());
const pkt = (p) => [...frame(new Uint8Array(p))];

/* Puerto serie simulado: lo que escribe la app queda en `written`; `feed` mete bytes como si los mandara el nodo. */
function fakePort({ failOpen = null } = {}) {
  const written = [];
  let rctrl;
  const listeners = {};
  const port = {
    written,
    readable: null,
    writable: null,
    opened: 0,
    closed: 0,
    getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }),
    async open(opts) {
      if (failOpen) throw Object.assign(new Error(failOpen), { name: "NetworkError" });
      if (this.readable) throw Object.assign(new Error("The port is already open."), { name: "InvalidStateError" });
      this.opened++;
      this.baud = opts.baudRate;
      this.readable = new ReadableStream({ start: (c) => { rctrl = c; } });
      this.writable = new WritableStream({ write: (chunk) => { written.push(...chunk); } });
    },
    async close() { this.closed++; this.readable = null; this.writable = null; },
    addEventListener(t, f) { listeners[t] = f; },
    removeEventListener(t) { delete listeners[t]; },
    feed: (b) => rctrl.enqueue(b),
    unplug: () => { listeners.disconnect?.(); rctrl.error(Object.assign(new Error("The device has been lost."), { name: "NetworkError" })); },
  };
  return port;
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("abre a 115200, despierta al nodo, enmarca lo que se manda y entrega los paquetes", async () => {
  const port = fakePort();
  const log = [];
  let packets = 0;
  const link = new SerialLink(port, { log: (m) => log.push(m), onPacket: () => packets++ });
  await link.open();
  assert.equal(port.baud, 115200);
  assert.deepEqual(port.written.slice(0, 32), new Array(32).fill(0xc3));
  const w = link.toDevice.getWriter();
  await w.write(new Uint8Array([0x18, 0x2a])); // ToRadio { want_config_id: 42 }
  assert.deepEqual(port.written.slice(32), [0x94, 0xc3, 0, 2, 0x18, 0x2a]);
  const r = link.fromDevice.getReader();
  assert.equal((await r.read()).value.type, "status");
  port.feed(bytes([...te.encode("DEBUG | algo\n")], pkt([0x08, 0x05])));
  const got = (await r.read()).value;
  assert.deepEqual([got.type, [...got.data]], ["packet", [0x08, 0x05]]);
  assert.equal(packets, 1);
  assert.match(log[0], /10c4:ea60/);
  await link.disconnect();
  await tick();
  assert.deepEqual(port.written.slice(-6), [0x94, 0xc3, 0, 2, 0x20, 0x01]); // ToRadio { disconnect: true }
  assert.equal(port.closed, 1);
});

test("puerto ocupado: falla en la fase «open» y se clasifica como ocupado", async () => {
  const link = new SerialLink(fakePort({ failOpen: "Failed to open serial port." }), {});
  await assert.rejects(link.open(), (e) => e.stage === "open" && classifySerial(e) === "busy");
});

test("cable fuera: avisa una sola vez con «lost» y cierra el puerto", async () => {
  const port = fakePort();
  const fails = [];
  const link = new SerialLink(port, { onFail: (e) => fails.push(e) });
  await link.open();
  port.unplug();
  await tick();
  assert.equal(fails.length, 1);
  assert.equal(classifySerial(fails[0]), "lost");
  assert.equal(port.closed, 1);
});

test("volver a abrir el mismo puerto: se espera a que el cierre anterior termine", async () => {
  const port = fakePort();
  const a = new SerialLink(port, {});
  await a.open();
  const closing = a.disconnect(); // como hace el receptor al reconectar: no espera…
  const b = new SerialLink(port, {});
  await closing; // …pero connect() espera esta promesa antes de abrir
  await b.open();
  assert.equal(port.opened, 2);
  // Un enlace caído también deja su cierre a mano para esperarlo.
  const fails = [];
  const c = new SerialLink(port, { onFail: (e) => fails.push(e) });
  await b.disconnect();
  await c.open();
  port.unplug();
  await c.disconnect();
  assert.equal(fails.length, 1);
  assert.equal(port.readable, null);
});
