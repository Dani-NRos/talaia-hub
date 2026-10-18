// Pruebas de canales (qué es privado, cuánto cabe en un mensaje) y de los textos de tiempo. Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { channelPrivacy, fitBytes, DEFAULT_PSK, EVENT_PSK } from "../src/canales.js";
import { dur, ago, hoursText, lastWindow, validT } from "../src/textos.js";

test("canales públicos: sin cifrar, clave por defecto (y su atajo), clave corta o la de eventos", () => {
  assert.deepEqual(channelPrivacy(new Uint8Array([])), { private: false, why: "sin cifrar" });
  assert.deepEqual(channelPrivacy(new Uint8Array([0])), { private: false, why: "sin cifrar" });
  assert.deepEqual(channelPrivacy(new Uint8Array([1])), { private: false, why: "clave pública por defecto" });
  assert.deepEqual(channelPrivacy(new Uint8Array(8).fill(3)), { private: false, why: "clave demasiado corta" });
  // La clave por defecto con el último byte cambiado (lo que hace el atajo «simple1»…«simple10») sigue siendo pública.
  assert.equal(channelPrivacy(Uint8Array.from([...DEFAULT_PSK.slice(0, 15), 9])).private, false);
  assert.deepEqual(channelPrivacy(Uint8Array.from(EVENT_PSK)), { private: false, why: "clave pública de eventos" });
  assert.deepEqual(channelPrivacy(new Uint8Array(32).fill(9)), { private: true, why: "" });
});

test("los mensajes se recortan a 200 bytes contando que las tildes ocupan 2", () => {
  assert.equal(fitBytes("corto"), "corto");
  const largo = "á".repeat(150); // 300 bytes
  const r = fitBytes(largo);
  assert.ok(new TextEncoder().encode(r).length <= 200);
  assert.ok(r.endsWith("…"));
});

test("textos de tiempo", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 18, 7) });
  assert.equal(dur(59 * 1000), "1 min");
  assert.equal(dur(90 * 60000), "1 h 30 min");
  assert.equal(dur(26 * 3600000), "1 día");
  assert.equal(ago(Date.now() - 30000), "ahora mismo");
  assert.equal(ago(Date.now() - 2 * 3600000), "hace 2 h");
  assert.equal(hoursText(0.5), "30 min");
  assert.equal(hoursText(1.5), "1,5 h");
  assert.equal(lastWindow(1), "en la última hora");
  assert.equal(lastWindow(3), "en las últimas 3 horas");
  assert.equal(validT(0), false); // reloj sin hora: 1970
  assert.equal(validT(Date.now() + 10 * 60000), false); // muy en el futuro
  assert.equal(validT(Date.now() - 60000), true);
});
