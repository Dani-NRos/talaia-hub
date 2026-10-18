// Pruebas de las acciones del usuario (las mismas en la app y en el servidor). Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { crearMotor, estadoInicial } from "../src/motor.js";
import { crearAcciones } from "../src/acciones.js";

const T0 = Date.UTC(2026, 9, 18, 7);
const CASETA = 0x3c6e19a2, GARAJE = 0x5d20b7f1;

function montar(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const S = estadoInicial();
  S.store = { rows: [], async add(r) { this.rows.push(...r); }, async series() { return [{ t: T0 - 60000, v: 20 }]; }, async prune() { return 0; }, async clear() { this.rows = []; } };
  S.link = { state: "ready" };
  S.channels = [{ index: 0, name: "SFNarrow", private: false, why: "clave pública por defecto" }, { index: 1, name: "avisos", private: true, why: "" }];
  const guardado = [];
  const motor = crearMotor(S, { guardar: (k) => guardado.push(k) });
  motor.node(CASETA).long = "Caseta";
  Object.assign(motor.node(CASETA), { metrics: { temperature: { v: 31, t: T0 } }, pos: { lat: 39.15, lon: -0.44, t: T0, bits: 32 }, lastHeard: T0 });
  return { S, motor, a: crearAcciones(motor), guardado };
}

test("vigilar: lo fija con el «sin señal» por defecto, lo apunta y evalúa; dejar de vigilar cierra sus alarmas", async (t) => {
  const { S, a, guardado } = montar(t);
  S.settings.defaultOfflineMin = 45;
  const r = a.vigilar(CASETA);
  assert.equal(r.toast, "Caseta fijado arriba. Ponle límites en su ficha.");
  assert.deepEqual(S.cfg.watched[CASETA], { offlineMin: 45, rules: {} });
  assert.equal(S.log[0].text, "Vigilando Caseta");
  assert.ok(guardado.includes("cfg"));
  await r.recientes;
  assert.equal(S.recent.get(`${CASETA}|temperature`).length, 1);
  assert.equal(a.vigilar(CASETA).ok, false); // ya vigilado
  a.ponerLimite(CASETA, "temperature", "max", 30);
  assert.equal(S.active.size, 1);
  a.dejarDeVigilar(CASETA);
  assert.equal(S.active.size, 0);
  assert.equal(S.log[0].text, "Ya no se vigila Caseta");
});

test("límites: el mínimo menor que el máximo; quitar los dos borra la regla", (t) => {
  const { S, a } = montar(t);
  a.vigilar(CASETA);
  assert.equal(a.ponerLimite(CASETA, "temperature", "max", 25).toast, "Límite guardado");
  assert.ok(S.active.has(`${CASETA}|temperature|high`));
  assert.equal(a.ponerLimite(CASETA, "temperature", "min", 26).error, "En temperatura el mínimo tiene que ser menor que el máximo.");
  assert.equal(S.cfg.watched[CASETA].rules.temperature.min, undefined);
  assert.equal(a.ponerLimite(CASETA, "temperature", "max", Number.NaN).error, "No es un número.");
  a.ponerLimite(CASETA, "temperature", "max", null);
  assert.equal(S.cfg.watched[CASETA].rules.temperature, undefined);
  assert.ok(!S.active.has(`${CASETA}|temperature|high`));
  assert.equal(a.ponerLimite(GARAJE, "temperature", "max", 25).ok, false); // no vigilado
});

test("sin señal: minutos o nada", (t) => {
  const { S, a } = montar(t);
  a.vigilar(CASETA);
  assert.equal(a.ponerSinSenal(CASETA, 90).toast, "Avisará tras 1 h 30 min sin señal");
  assert.equal(S.cfg.watched[CASETA].offlineMin, 90);
  assert.equal(a.ponerSinSenal(CASETA, null).toast, "Aviso de nodo sin señal desactivado");
  assert.equal(S.cfg.watched[CASETA].offlineMin, 0);
  assert.match(a.ponerSinSenal(CASETA, 0).error, /1 o más/);
});

test("cambio rápido: valida la regla, la apunta y se quita", (t) => {
  const { S, a } = montar(t);
  a.vigilar(CASETA);
  assert.equal(a.ponerTendencia(CASETA, "temperature", { dir: "up", delta: 3, hours: 30 }).error, "Pon un tiempo entre media hora y 24 horas.");
  assert.equal(a.ponerTendencia(CASETA, "temperature", { dir: "up", delta: 3, hours: 2 }).toast, "Aviso de cambio rápido añadido");
  assert.equal(S.log[0].text, "Caseta · Aviso de cambio rápido: Temperatura si sube 3,0 °C o más en 2 h");
  assert.equal(a.ponerTendencia(CASETA, "temperature", { dir: "up", delta: 4, hours: 2 }).toast, "Aviso de cambio rápido actualizado");
  assert.equal(a.quitarTendencia(CASETA, "temperature").toast, "Aviso quitado");
  assert.equal(S.cfg.watched[CASETA].rules.temperature, undefined);
});

test("valla: radio de 20 m o más; se fija en la posición actual, se cambia y se quita", (t) => {
  const { S, a } = montar(t);
  assert.equal(a.fijarValla(CASETA, 100).ok, false); // no vigilado
  a.vigilar(CASETA);
  assert.equal(a.fijarValla(CASETA, 10).error, "Pon un radio de 20 m o más.");
  assert.equal(a.fijarValla(CASETA, 150).toast, "Valla fijada en su posición actual");
  assert.deepEqual(S.cfg.watched[CASETA].fence, { lat: 39.15, lon: -0.44, r: 150, at: T0 });
  assert.deepEqual(a.radioValla(CASETA, 5), { ok: false, error: "Pon un radio de 20 m o más.", radio: 150 });
  assert.equal(a.radioValla(CASETA, 300).toast, "Radio de la valla: 300 m");
  assert.equal(a.quitarValla(CASETA).ok, true);
  assert.equal(S.cfg.watched[CASETA].fence, undefined);
});

test("avisos por la malla: un canal público no se acepta; la prueba necesita el receptor", (t) => {
  const { S, a, guardado } = montar(t);
  assert.equal(a.avisosMalla({ enabled: true }).toast, "Elige ahora un canal privado o un nodo.");
  assert.equal(S.settings.mesh.enabled, true);
  assert.deepEqual(a.avisosMalla({ channel: 0 }), { ok: false, toast: "Ese canal es público: no se puede usar para avisos." });
  assert.equal(S.settings.mesh.channel, null);
  assert.equal(a.avisosMalla({ channel: 1 }).ok, true);
  assert.equal(S.settings.mesh.channel, 1);
  assert.ok(guardado.includes("settings"));
  S.link.state = "reconnecting";
  assert.equal(a.pruebaMalla().toast, "Conecta el receptor para enviar la prueba.");
});

test("ajustes: «sin señal» por defecto y días de histórico", async (t) => {
  const { S, a } = montar(t);
  assert.deepEqual(a.sinSenalPorDefecto(0), { ok: false, error: "Pon un número de minutos (1 o más).", valor: 75 });
  assert.equal(a.sinSenalPorDefecto(90.4).toast, "Guardado");
  assert.equal(S.settings.defaultOfflineMin, 90);
  const r = a.retencion(365);
  assert.equal(S.settings.retentionDays, 365);
  await r.poda;
});
