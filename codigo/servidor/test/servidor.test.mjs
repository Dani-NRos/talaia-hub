// Pruebas del servidor completo contra un nodo simulado por TCP: conecta, lee la configuración, guarda el
// histórico, salta alarmas 24/7, no manda nada por la malla, reconecta y recuerda el estado al reiniciar.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crearVigia } from "../src/vigia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { NodoFalso, hasta, PORT, ME, CASETA } from "./nodo-falso.mjs";

async function montar(t, { almacen, datos } = {}) {
  const nodo = new NodoFalso();
  const puerto = await nodo.escucharTcp();
  datos ||= fs.mkdtempSync(path.join(os.tmpdir(), "vigia-"));
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto }, datos });
  const salida = [];
  const registro = crearRegistro({ nivel: "depurar", salida });
  const v = await crearVigia(config, registro, { almacen });
  t.after(async () => { await v.detener().catch(() => {}); await nodo.cerrar(); });
  return { v, nodo, salida, datos, config };
}

test("conecta por TCP, lee la configuración del nodo y la guarda", async (t) => {
  const { v, nodo } = await montar(t);
  v.arrancar();
  await hasta(() => v.S.link.state === "ready", 8000, "receptor listo");
  const { S } = v;
  assert.equal(S.myNode, ME);
  assert.equal(S.nodes.get(CASETA).long, "Caseta huerto");
  assert.equal(S.nodes.get(CASETA).metrics.batteryLevel.v, 87);
  assert.deepEqual(S.channels.map((c) => [c.name, c.private]), [["SFNarrow", false], ["avisos", true]]);
  assert.deepEqual(S.lora, { usePreset: false, modemPreset: 0, spreadFactor: 7, hopLimit: 6 });
  assert.equal(S.device.kind, "tcp");
  assert.match(S.log[0].text, /^Receptor listo por la red: DNN 5$/);
  // Despertar y nada más antes de la configuración.
  assert.ok(nodo.textos.length >= 1);
  assert.equal(nodo.recibido[0].payloadVariant.case, "wantConfigId");
  assert.deepEqual(v.almacen.leer("channels").map((c) => c.name), ["SFNarrow", "avisos"]);
  assert.equal(v.almacen.leer("my"), ME);
});

test("lectura en vivo: histórico en SQLite, alarma con el registro del sistema, y nada por la malla", async (t) => {
  const almacen = abrirAlmacen(":memory:");
  almacen.guardar("cfg", { watched: { [CASETA]: { offlineMin: 60, rules: { temperature: { max: 30 } } } } });
  const { v, nodo, salida } = await montar(t, { almacen });
  const alarmas = [];
  v.eventos.on("alarma", (al) => alarmas.push(al));
  v.arrancar();
  await hasta(() => v.S.link.state === "ready", 8000, "receptor listo");
  nodo.ambiente(CASETA, { temperature: 31.4, relativeHumidity: 64 });
  await hasta(() => v.S.active.has(`${CASETA}|temperature|high`), 3000, "alarma de temperatura");
  assert.equal(alarmas.length, 1);
  const filas = await almacen.lecturas.series(CASETA, "temperature", 0);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].v, 31.4);
  assert.ok(salida.some((l) => l.nivel === "aviso" && l.msg === "Alarma: Caseta huerto · Temperatura por encima de 30,0 °C"), JSON.stringify(salida.filter((l) => l.nivel === "aviso")));
  assert.equal(almacen.leer("active")[0].key, `${CASETA}|temperature|high`);
  // Con los avisos por la malla apagados (lo de por defecto), el servidor no manda ni un paquete.
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(nodo.paquetes(), []);
});

test("si se corta la conexión, salta «Receptor desconectado», reconecta solo y la cierra", async (t) => {
  const { v, nodo } = await montar(t);
  v.arrancar();
  await hasta(() => v.S.link.state === "ready", 8000, "receptor listo");
  nodo.cerrarFlujo();
  await hasta(() => v.S.active.has("link"), 3000, "alarma de receptor desconectado");
  assert.match(v.motor.alarmDetail(v.S.active.get("link")), /^Reintentando la conexión por la red\./);
  await hasta(() => v.S.link.state === "ready", 10000, "reconectado");
  assert.ok(!v.S.active.has("link"));
  assert.equal(nodo.conexiones, 2);
});

test("al reiniciar recuerda nodos, alarmas activas y registro", async (t) => {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-"));
  const a1 = abrirAlmacen(path.join(datos, "vigia.db"));
  a1.guardar("cfg", { watched: { [CASETA]: { offlineMin: 60, rules: { temperature: { max: 30 } } } } });
  a1.cerrar();
  {
    const { v, nodo } = await montar(t, { datos });
    v.arrancar();
    await hasta(() => v.S.link.state === "ready", 8000, "receptor listo");
    nodo.ambiente(CASETA, { temperature: 33 });
    await hasta(() => v.S.active.size === 1, 3000, "alarma");
    v.motor.ack(`${CASETA}|temperature|high`);
    await v.detener();
  }
  const { v } = await montar(t, { datos });
  assert.equal(v.S.nodes.get(CASETA).long, "Caseta huerto");
  assert.equal(v.S.nodes.get(CASETA).metrics.temperature.v, 33);
  assert.equal(v.S.active.get(`${CASETA}|temperature|high`).acked, true);
  assert.ok(v.S.log.some((e) => e.type === "ack"));
  // Las lecturas recientes de los vigilados vuelven a memoria para el cambio rápido.
  assert.equal(v.S.recent.get(`${CASETA}|temperature`).length, 1);
});

test("pedir datos desde el servidor sale por el receptor con el id capturado", async (t) => {
  const { v, nodo } = await montar(t);
  v.arrancar();
  await hasta(() => v.S.link.state === "ready", 8000, "receptor listo");
  v.motor.ask(CASETA, "env");
  await nodo.esperar(() => nodo.paquetes(PORT.TELEMETRY_APP).length === 1, 3000, "petición de ambiente");
  const p = nodo.paquetes(PORT.TELEMETRY_APP)[0];
  assert.equal(p.to, CASETA);
  assert.equal(p.wantAck, true);
  assert.equal(v.S.req.get(`${CASETA}|env`).id, p.id);
});
