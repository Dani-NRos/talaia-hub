// Pruebas del motor por el camino del receptor real (no la demo): alarmas, peticiones, rutas y avisos por la malla.
// La radio es falsa: apunta lo que se manda y deja contestar cuando toca. El reloj es simulado. Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { Protobuf } from "@meshtastic/core";
import { crearMotor, estadoInicial, RE, askKey, trendKey, estadoKey, conexionKey, MESH_HOURLY } from "../src/motor.js";
import { crearAcciones } from "../src/acciones.js";
import { registrarMetricas } from "../src/metrics.js";
import { metaDato } from "../src/mqtt-datos.js";

const PORT = Protobuf.Portnums.PortNum;
const T0 = Date.UTC(2026, 9, 18, 7, 0, 0); // 09:00 en Madrid
const MIN = 60000, HOUR = 60 * MIN;
const ME = 0xa1b2c3d4, CASETA = 0x3c6e19a2, VECINO = 0x11223344, AVISADO = 0x5d20b7f1;
const PUBLICO = { index: 0, name: "LongFast", primary: true, private: false, why: "clave pública por defecto" };
const AVISOS = { index: 1, name: "avisos", primary: false, private: true, why: "" };
const KEY = new Uint8Array(32).fill(7);

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

/** Motor con radio falsa. watched: nodos vigilados; mesh: avisos por la malla. */
function montar(t, { watched = {}, mesh = null, channels = [PUBLICO, AVISOS], link = "ready", pki = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
  const S = estadoInicial();
  S.store = { rows: [], add(r) { this.rows.push(...r); } };
  S.cfg.watched = watched;
  S.settings.mesh = mesh;
  S.channels = channels;
  S.myNode = ME;
  S.myUser = pki ? { longName: "Receptor", shortName: "RX", publicKey: KEY } : null;
  S.link = { state: link, extra: null };
  const ev = { alarmas: [], toasts: [], diag: [], guardado: [], rutas: [] };
  const enviados = [];
  let nextId = 5000;
  let listo = true;
  const send = (kind) => (...args) => {
    const id = ++nextId;
    let res, rej;
    const done = new Promise((a, b) => { res = a; rej = b; });
    done.catch(() => {});
    enviados.push({ kind, args, id, ok: () => res(id), fail: (error) => rej({ id, error }) });
    return { id, done };
  };
  const radio = {
    listo: () => listo,
    requestTelemetry: send("telemetry"),
    requestNodeInfo: send("info"),
    requestPosition: send("pos"),
    requestTraceroute: send("route"),
    sendText: send("text"),
  };
  const motor = crearMotor(S, {
    alarma: (al) => ev.alarmas.push(al),
    toast: (m) => ev.toasts.push(m),
    diag: (e) => ev.diag.push(e.msg),
    guardar: (k) => ev.guardado.push(k),
    ruta: (num) => ev.rutas.push(num),
    radio,
  });
  const setListo = (v) => { listo = v; };
  return { S, motor, ev, enviados, setListo };
}

/* Paquetes con la forma que entrega @meshtastic/core. */
const decoded = (portnum, requestId, payload) => ({ case: "decoded", value: { portnum, requestId, payload } });
function routing(from, requestId, err = 0) {
  return { from, to: ME, channel: 0, rxTime: Math.floor(Date.now() / 1000), hopStart: 3, hopLimit: 3, rxSnr: 6,
    payloadVariant: decoded(PORT.ROUTING_APP, requestId, new Uint8Array([0x18, err])) };
}
function tele(from, kind, value, { id = 1, rx = Date.now() } = {}) {
  return { from, id, rxTime: new Date(rx), data: { time: 0, variant: { case: kind, value } } };
}
/* RouteDiscovery como lo manda el firmware: nodos (fixed32) y SNR×4 empaquetados. */
function routeDiscovery({ route = [], snrTowards = [], routeBack = [], snrBack = [] }) {
  const out = [];
  const varint = (v) => { let x = BigInt.asUintN(64, BigInt(v)); while (x > 0x7fn) { out.push(Number((x & 0x7fn) | 0x80n)); x >>= 7n; } out.push(Number(x)); };
  const field = (no, vals, fixed) => {
    if (!vals.length) return;
    const body = [];
    for (const v of vals) {
      if (fixed) body.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
      else { let x = BigInt.asUintN(64, BigInt(v)); while (x > 0x7fn) { body.push(Number((x & 0x7fn) | 0x80n)); x >>= 7n; } body.push(Number(x)); }
    }
    varint(no * 8 + 2); varint(body.length); out.push(...body);
  };
  field(1, route, true); field(2, snrTowards, false); field(3, routeBack, true); field(4, snrBack, false);
  return new Uint8Array(out);
}
const vigilado = (rules = {}, extra = {}) => ({ offlineMin: 60, rules, ...extra });

/* ───────────── alarmas ───────────── */

test("umbral: salta una vez, se queda con la histéresis y se cierra al volver al rango", (t) => {
  const { S, motor, ev } = montar(t, { watched: { [CASETA]: vigilado({ temperature: { max: 30 } }) } });
  const key = `${CASETA}|temperature|high`;
  motor.ingest(CASETA, { temperature: 31 }, T0);
  assert.ok(S.active.has(key));
  assert.equal(ev.alarmas.length, 1);
  assert.equal(S.log[0].type, "raise");
  assert.match(S.log[0].text, /Temperatura por encima de 30/);
  assert.deepEqual(S.store.rows, [{ node: CASETA, metric: "temperature", t: T0, v: 31 }]);
  assert.ok(["active", "log", "nodes"].every((k) => ev.guardado.includes(k)));
  motor.ingest(CASETA, { temperature: 32 }, T0 + MIN); // sigue alta: se actualiza, no vuelve a sonar
  assert.equal(ev.alarmas.length, 1);
  assert.equal(S.active.get(key).value, 32);
  motor.ingest(CASETA, { temperature: 29.8 }, T0 + 2 * MIN); // dentro de la histéresis (0,3 °C)
  assert.ok(S.active.has(key));
  motor.ingest(CASETA, { temperature: 29.7 }, T0 + 3 * MIN);
  assert.ok(!S.active.has(key));
  assert.equal(S.log[0].type, "clear");
  assert.match(S.log[0].text, /de vuelta en rango \(29,7 °C\)/);
});

test("una lectura vieja que llega al reconectar salta marcada como «recibida al reconectar»", (t) => {
  const { S, motor } = montar(t, { watched: { [CASETA]: vigilado({ batteryLevel: { min: 20 } }) } });
  motor.ingest(CASETA, { batteryLevel: 15 }, T0 - 20 * MIN, { replay: true });
  const al = S.active.get(`${CASETA}|batteryLevel|low`);
  assert.equal(al.late, true);
  assert.match(S.log[0].text, /\(recibida al reconectar\)$/);
});

test("una lectura más antigua que la última no cambia el valor ni dispara la alarma", (t) => {
  const { S, motor, ev } = montar(t, { watched: { [CASETA]: vigilado({ temperature: { max: 30 } }) } });
  motor.ingest(CASETA, { temperature: 20 }, T0);
  motor.ingest(CASETA, { temperature: 35 }, T0 - 10 * MIN);
  assert.equal(S.nodes.get(CASETA).metrics.temperature.v, 20);
  assert.equal(ev.alarmas.length, 0);
  assert.equal(S.store.rows.length, 2); // al histórico va todo
});

test("cambio rápido: la presión baja 4 hPa en 3 h y salta, aunque no toque ningún límite", (t) => {
  const rule = { dir: "down", delta: 3, hours: 3 };
  const { S, motor } = montar(t, { watched: { [CASETA]: vigilado({ barometricPressure: { trend: rule } }) } });
  for (let i = 0; i <= 6; i++) motor.ingest(CASETA, { barometricPressure: 1015 - (4 * i) / 6 }, T0 - 3 * HOUR + i * 30 * MIN);
  const al = S.active.get(trendKey(CASETA, "barometricPressure"));
  assert.ok(al, "debería saltar");
  assert.equal(al.kind, "trend");
  assert.match(motor.alarmTitle(al), /Presión bajando rápido \(−4,0 hPa en 3 h\)/);
});

test("estado ON/OFF (servidor): «abierta más de 10 min», «desde» se mantiene, se cierra al cerrarse; cambiar la regla no avisa", (t) => {
  registrarMetricas({ mq1: metaDato({ tipo: "estado", nombre: "Puerta", nombres: "abierta" }), mq2: metaDato({ tipo: "power" }) });
  t.after(() => registrarMetricas({}));
  const P = -1;
  const { S, motor, ev } = montar(t, { watched: { [P]: vigilado({ mq1: { estado: { cuando: 1, min: 10 } } }, { offlineMin: 0 }) } });
  const acciones = crearAcciones(motor);
  const n = Object.assign(motor.node(P), { long: "Garaje", short: "ZIGB" });
  // Como lo hace el servidor al llegar un estado: el valor y desde cuándo lo tiene.
  const llega = (v) => { const p = n.metrics.mq1; n.metrics.mq1 = { v, t: Date.now(), desde: p && p.v === v ? p.desde : Date.now() }; motor.evalEstado(P, "mq1"); };
  const key = estadoKey(P, "mq1");
  llega(1);
  t.mock.timers.tick(9 * MIN);
  llega(1); // sigue abierta (el dispositivo lo repite): no cuenta desde ahora
  motor.evalEstados();
  assert.equal(S.active.size, 0);
  t.mock.timers.tick(MIN);
  motor.evalEstados();
  const al = S.active.get(key);
  assert.ok(al, "abierta 10 min: salta");
  assert.equal(ev.alarmas.length, 1);
  assert.equal(motor.alarmTitle(al), "Garaje · Puerta: Abierta más de 10 min");
  assert.match(motor.alarmDetail(al), /^Abierta desde /);
  assert.match(motor.meshText("raise", al), /^⚠ Vigía: Garaje · Puerta: Abierta desde las \d\d:\d\d · /);
  assert.equal(S.log[0].mqtt, true); // no va a Home Assistant
  // La lectura que guarda el servidor no le quita el «desde».
  motor.ingest(P, { mq1: 1 }, Date.now());
  assert.equal(n.metrics.mq1.desde, T0);
  llega(0);
  assert.ok(!S.active.has(key));
  assert.equal(S.log[0].text, "Garaje · Puerta: Cerrada (tras 10 min)");
  assert.match(motor.meshText("clear", al, { v: 0 }), /^✓ Vigía: Garaje · Puerta: Cerrada · /);
  // Al momento, cuando esté cerrada.
  assert.equal(acciones.ponerEstado(P, "mq1", 0, null).toast, "Avisará con «Cerrada»");
  assert.equal(motor.alarmTitle(S.active.get(key)), "Garaje · Puerta: Cerrada");
  // Cambiar la regla no es que cambie el estado: se cierra sin aviso.
  const antes = S.log.length;
  assert.equal(acciones.ponerEstado(P, "mq1", 1, 30).toast, "Avisará con «Abierta» durante más de 30 min");
  assert.ok(!S.active.has(key));
  assert.equal(S.log.length, antes);
  assert.deepEqual(S.cfg.watched[P].rules.mq1, { estado: { cuando: 1, min: 30 } });
  assert.match(acciones.ponerEstado(P, "mq1", 1, 1.5).error, /número entero/);
  assert.equal(acciones.ponerEstado(P, "mq2", 1, 0).ok, false); // un número no tiene estados
  assert.equal(acciones.ponerEstado(P, "mq1", null, null).toast, "Aviso quitado");
  assert.equal(S.cfg.watched[P].rules.mq1, undefined);
  // Sin conexión (el tema de conexión del dispositivo).
  const c = { key: conexionKey(P), num: P, kind: "conexion", value: T0 };
  assert.equal(motor.alarmTitle(c), "Garaje · Sin conexión");
  assert.equal(motor.clearText(c, {}), "Garaje · Conectado otra vez");
  assert.match(motor.meshText("raise", c), /^⚠ Vigía: Garaje sin conexión desde las /);
});

test("valla antirrobo: hacen falta dos posiciones fuera; se cierra al volver dentro del 80 % del radio", (t) => {
  const fence = { lat: 39.15, lon: -0.44, r: 100, at: T0 - HOUR };
  const { S, motor } = montar(t, { watched: { [CASETA]: vigilado({}, { fence }) } });
  const key = `${CASETA}||moved`;
  motor.setPosition(CASETA, { lat: 39.1545, lon: -0.44, t: T0, bits: 32 }, { live: true }); // ~500 m al norte
  assert.ok(!S.active.has(key));
  motor.setPosition(CASETA, { lat: 39.1546, lon: -0.44, t: T0 + MIN, bits: 32 }, { live: true });
  assert.ok(S.active.has(key));
  assert.match(motor.alarmDetail(S.active.get(key)), /al N de su sitio \(valla de 100 m\)/);
  motor.setPosition(CASETA, { lat: 39.1508, lon: -0.44, t: T0 + 2 * MIN, bits: 32 }, { live: true }); // ~89 m: aún no
  assert.ok(S.active.has(key));
  motor.setPosition(CASETA, { lat: 39.1505, lon: -0.44, t: T0 + 3 * MIN, bits: 32 }, { live: true }); // ~56 m
  assert.ok(!S.active.has(key));
  assert.match(S.log[0].text, /De vuelta en su sitio/);
});

test("sin señal: salta pasado el límite con receptor conectado; sin receptor no se sabe y no salta", (t) => {
  const { S, motor } = montar(t, { watched: { [CASETA]: vigilado(), [ME]: vigilado() }, link: "reconnecting" });
  motor.node(CASETA).lastHeard = T0 - 61 * MIN;
  motor.node(ME).lastHeard = T0 - 5 * HOUR;
  motor.evalOffline();
  assert.equal(S.active.size, 0);
  S.link.state = "ready";
  motor.evalOffline();
  assert.ok(S.active.has(`${CASETA}||offline`));
  assert.ok(!S.active.has(`${ME}||offline`), "el propio receptor nunca da «sin señal»");
  motor.recibir.packet({ from: CASETA, to: 0xffffffff, channel: 1, rxTime: Math.floor(T0 / 1000), hopStart: 3, hopLimit: 1, rxSnr: -7.5 });
  assert.ok(!S.active.has(`${CASETA}||offline`));
  assert.match(S.log[0].text, /Vuelve a dar señal/);
  const n = S.nodes.get(CASETA);
  assert.deepEqual([n.hops, n.snr, n.channel], [2, -7.5, 1]);
});

test("Enterado: queda visto, se apunta y deja de contar como pendiente", (t) => {
  const { S, motor } = montar(t, { watched: { [CASETA]: vigilado({ temperature: { max: 30, min: 0 } }) } });
  motor.ingest(CASETA, { temperature: 31 }, T0);
  motor.raise("test", { kind: "test", num: null, t: T0 });
  assert.equal(motor.unacked().length, 2);
  motor.ack(`${CASETA}|temperature|high`);
  assert.match(S.log[0].text, /^Enterado: /);
  motor.ackAll();
  assert.equal(motor.unacked().length, 0);
});

/* ───────────── peticiones a nodos ───────────── */

test("pedir datos: el acuse de un vecino no cuenta, el del nodo sí; la respuesta vale aunque el reloj del receptor vaya atrasado", async (t) => {
  const { S, motor, enviados } = montar(t);
  motor.node(CASETA).channel = 1;
  motor.ask(CASETA, "env");
  const [p] = enviados;
  assert.equal(p.kind, "telemetry");
  assert.deepEqual(p.args, [CASETA, 3, 1]); // campo 3 = ambiente, por el canal del nodo
  const r = S.req.get(askKey(CASETA, "env"));
  motor.recibir.packet(routing(VECINO, p.id)); // acuse implícito: un vecino la repitió
  assert.equal(r.acked, false);
  motor.recibir.packet(routing(CASETA, p.id));
  assert.equal(r.acked, true);
  p.ok();
  await flush();
  t.mock.timers.tick(4000);
  // La lectura llega con la hora del receptor, 3 min atrasado: sigue siendo la respuesta.
  motor.recibir.telemetry(tele(CASETA, "environmentMetrics", { temperature: 18.5 }, { rx: Date.now() - 3 * MIN }));
  assert.equal(r.state, "ok");
  assert.match(S.log[0].text, /Ambiente: datos recibidos a petición$/);
  assert.equal(S.nodes.get(CASETA).metrics.temperature.v, 18.5);
});

test("pedir datos: un error de la malla la cierra con su explicación; la librería rindiéndose a los 60 s no", async (t) => {
  const { S, motor, enviados } = montar(t);
  motor.ask(CASETA, "power");
  motor.recibir.packet(routing(CASETA, enviados[0].id, RE.NO_RESPONSE));
  assert.equal(S.req.get(askKey(CASETA, "power")).state, "fail");
  assert.match(S.log[0].text, /no tiene ese sensor/);
  motor.ask(CASETA, "device");
  const r = S.req.get(askKey(CASETA, "device"));
  enviados[1].fail(RE.TIMEOUT);
  await flush();
  assert.equal(r.state, "wait");
  t.mock.timers.tick(60000);
  assert.equal(r.state, "fail");
  assert.match(S.log[0].text, /Batería: sin respuesta en 60 s$/);
});

test("pedir datos: no se repite antes de 30 s, ni sin receptor", (t) => {
  const { motor, ev, enviados, S } = montar(t);
  motor.ask(CASETA, "env");
  motor.recibir.packet(routing(CASETA, enviados[0].id, RE.MAX_RETRANSMIT));
  t.mock.timers.tick(10000);
  motor.ask(CASETA, "env");
  assert.match(ev.toasts.at(-1), /^Espera 20 s antes de repetir/);
  assert.equal(enviados.length, 1);
  t.mock.timers.tick(25000);
  S.link.state = "reconnecting";
  motor.ask(CASETA, "env");
  assert.equal(ev.toasts.at(-1), "Conecta el receptor para pedir datos.");
  assert.equal(enviados.length, 1);
});

test("traceroute: lee ida y vuelta, guarda la ruta y solo deja uno cada 30 s", async (t) => {
  const { S, motor, ev, enviados } = montar(t);
  motor.node(VECINO).long = "Repetidor";
  motor.node(CASETA).hops = 1;
  motor.ask(CASETA, "route");
  const [p] = enviados;
  assert.equal(p.kind, "route");
  motor.ask(AVISADO, "route");
  assert.match(ev.toasts.at(-1), /solo lanza un traceroute cada 30 s, a cualquier nodo\. Espera 30 s/);
  t.mock.timers.tick(9000);
  const payload = routeDiscovery({ route: [VECINO], snrTowards: [24, 20], routeBack: [VECINO], snrBack: [16, 12] });
  motor.recibir.packet({ from: CASETA, to: ME, rxTime: Math.floor(Date.now() / 1000), hopStart: 3, hopLimit: 2, payloadVariant: decoded(PORT.TRACEROUTE_APP, p.id, payload) });
  const tr = S.traces[CASETA];
  assert.deepEqual(tr.fwd, { nodes: [ME, VECINO, CASETA], snr: [6, 5] });
  assert.deepEqual(tr.back, { nodes: [CASETA, VECINO, ME], snr: [4, 3] });
  assert.equal(tr.ms, 9000);
  assert.ok(ev.guardado.includes("traces"));
  assert.deepEqual(ev.rutas, [CASETA]);
  assert.match(S.log[0].text, /Ruta: ida por Repetidor; vuelta por Repetidor$/);
});

test("traceroute: si el receptor avisa de que no lo manda (límite de 30 s), se cierra como tal", (t) => {
  const { S, motor, enviados } = montar(t);
  motor.ask(CASETA, "route");
  motor.recibir.notice({ message: "TraceRoute can only be sent once every 30 seconds", replyId: enviados[0].id });
  assert.equal(S.req.get(askKey(CASETA, "route")).why, "throttled");
});

test("ficha del nodo: manda la nuestra, guarda la clave y avisa antes de repetir en 12 h", async (t) => {
  const { S, motor, ev, enviados } = montar(t);
  motor.ask(CASETA, "info");
  assert.equal(enviados[0].kind, "info");
  assert.equal(S.infoAsked[CASETA], T0);
  assert.ok(ev.guardado.includes("infoAsk"));
  t.mock.timers.tick(5000);
  motor.recibir.user(CASETA, { longName: "Caseta huerto", shortName: "CAS", hwModel: 43, publicKey: KEY }, { from: CASETA, to: ME });
  const r = S.req.get(askKey(CASETA, "info"));
  assert.equal(r.state, "ok");
  assert.equal(r.gotKey, true);
  assert.equal(S.nodes.get(CASETA).key, true);
  assert.equal(S.nodes.get(CASETA).long, "Caseta huerto");
  t.mock.timers.tick(2 * MIN);
  motor.ask(CASETA, "info");
  assert.match(ev.toasts.at(-1), /^Ya se la pediste hace 2 min\./);
  assert.equal(enviados.length, 1);
  motor.ask(CASETA, "info"); // segundo toque: va
  assert.equal(enviados.length, 2);
});

test("la copia de la base de datos del receptor no cuenta como respuesta a «Pedir ficha»", (t) => {
  const { S, motor } = montar(t);
  motor.ask(CASETA, "info");
  motor.recibir.user(CASETA, { longName: "Caseta", publicKey: KEY }, { from: CASETA, to: CASETA });
  assert.equal(S.req.get(askKey(CASETA, "info")).state, "wait");
});

/* ───────────── avisos por la malla ───────────── */

test("aviso a un canal privado al saltar y al resolverse", async (t) => {
  const mesh = { enabled: true, channel: 1, node: null, onClear: true };
  const { S, motor, enviados } = montar(t, { mesh, watched: { [CASETA]: vigilado({ temperature: { max: 30 } }) } });
  motor.node(CASETA).long = "Caseta";
  motor.ingest(CASETA, { temperature: 31.2 }, T0);
  await flush();
  assert.equal(enviados.length, 1);
  assert.deepEqual(enviados[0].args, ["broadcast", 1, "⚠ Vigía: Caseta · Temperatura 31,2 °C (máx 30,0) · 09:00"]);
  enviados[0].ok();
  await flush();
  assert.equal(S.meshLast.result, "repetido por la malla");
  t.mock.timers.tick(10 * MIN);
  motor.ingest(CASETA, { temperature: 25 }, Date.now());
  await flush();
  assert.equal(enviados[1].args[2], "✓ Vigía: Caseta · Temperatura de vuelta en rango (25,0 °C) · 09:10");
});

test("un canal público nunca recibe avisos, aunque esté guardado", async (t) => {
  const mesh = { enabled: true, channel: 0, node: null, onClear: false };
  const { S, motor, enviados } = montar(t, { mesh, watched: { [CASETA]: vigilado({ temperature: { max: 30 } }) } });
  motor.ingest(CASETA, { temperature: 31 }, T0);
  await flush();
  assert.equal(enviados.length, 0);
  assert.ok(S.log.some((l) => /bloqueado: el canal «LongFast» es público \(clave pública por defecto\)/.test(l.text)));
});

test("aviso directo: el acuse del propio receptor solo dice que salió; entregado cuando confirma el destino", async (t) => {
  const mesh = { enabled: true, channel: null, node: AVISADO, onClear: false };
  const { S, motor, enviados } = montar(t, { mesh });
  motor.node(AVISADO).long = "Garaje";
  motor.meshNotify("test");
  await flush();
  const [m] = enviados;
  assert.deepEqual(m.args.slice(0, 2), [AVISADO, 0]);
  motor.recibir.packet(routing(ME, m.id)); // implícito: el receptor oyó a un vecino repetirlo
  m.ok();
  await flush();
  assert.equal(S.meshLast.st.phase, "relayed");
  assert.match(S.meshLast.result, /^en camino: un vecino lo ha repetido; esperando a que Garaje confirme/);
  t.mock.timers.tick(3000);
  motor.recibir.packet(routing(AVISADO, m.id));
  assert.equal(S.meshLast.result, "entregado (3 s)");
  assert.equal(S.meshLast.ok, true);
});

test("aviso directo sin confirmación del destino en 90 s: «sin confirmar»", async (t) => {
  const mesh = { enabled: true, channel: null, node: AVISADO, onClear: false };
  const { S, motor, enviados } = montar(t, { mesh });
  motor.meshNotify("test");
  await flush();
  motor.recibir.packet(routing(ME, enviados[0].id));
  t.mock.timers.tick(90000);
  assert.equal(S.meshLast.ok, false);
  assert.match(S.meshLast.result, /^sin confirmar: salió a la malla \(un vecino lo repitió\)/);
});

test("aviso directo sin cifrado por clave y por canal público: bloqueado", async (t) => {
  const mesh = { enabled: true, channel: null, node: AVISADO, onClear: false };
  const { S, motor, enviados } = montar(t, { mesh, pki: false });
  motor.meshNotify("test");
  await flush();
  assert.equal(enviados.length, 0);
  assert.match(S.log[0].text, /bloqueado: sin cifrado por clave/);
});

test("avisos por la malla: uno cada 8 s mientras hay cola, y como mucho 20 por hora", async (t) => {
  const mesh = { enabled: true, channel: 1, node: AVISADO, onClear: false }; // dos destinos: cada aviso son 2 mensajes
  const { S, motor, enviados } = montar(t, { mesh });
  for (let i = 0; i < 11; i++) motor.meshNotify("test"); // 22 mensajes
  await flush();
  assert.equal(enviados.length, 1);
  t.mock.timers.tick(7999);
  await flush();
  assert.equal(enviados.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(enviados.length, 2);
  for (let i = 0; i < 30; i++) { t.mock.timers.tick(8000); await flush(); }
  assert.equal(enviados.length, MESH_HOURLY);
  assert.ok(S.log.some((l) => l.text === `Avisos por la malla en pausa: ya van ${MESH_HOURLY} en la última hora (2 sin enviar)`));
});

// Aceptado (Dani, 18 oct. 2026): si saltan varias alarmas en el mismo instante (una lectura de ambiente con temperatura
// y humedad fuera de rango) y los avisos van a un solo destino, salen seguidos, sin los 8 s. El nodo los pone en cola.
test("dos alarmas a la vez con un solo destino salen seguidas (aceptado)", async (t) => {
  const mesh = { enabled: true, channel: 1, node: null, onClear: false };
  const { motor, enviados } = montar(t, { mesh, watched: { [CASETA]: vigilado({ temperature: { max: 30 }, relativeHumidity: { max: 80 } }) } });
  motor.ingest(CASETA, { temperature: 35, relativeHumidity: 90 }, T0);
  await flush();
  assert.equal(enviados.length, 2);
});

test("sin receptor los avisos esperan en cola; si pasan 30 min se descartan", async (t) => {
  const mesh = { enabled: true, channel: 1, node: null, onClear: false };
  const { S, motor, enviados, setListo } = montar(t, { mesh });
  setListo(false);
  motor.meshNotify("test");
  await flush();
  assert.equal(enviados.length, 0);
  t.mock.timers.tick(31 * MIN);
  setListo(true);
  motor.pumpMesh();
  await flush();
  assert.equal(enviados.length, 0);
  assert.match(S.log[0].text, /descartado: tenía más de 30 min$/);
});

/* ───────────── receptor ───────────── */

test("avisa en el diagnóstico si el reloj del receptor va desfasado", (t) => {
  const { motor, ev } = montar(t);
  for (let i = 0; i < 30; i++) motor.recibir.packet({ from: CASETA, to: ME, rxTime: Math.floor((Date.now() - 4 * MIN) / 1000) });
  assert.equal(ev.diag.length, 1);
  assert.match(ev.diag[0], /^El reloj del receptor va 4 min atrasado/);
});

test("la telemetría repetida (mismo nodo y mismo id) se cuenta una sola vez", (t) => {
  const { S, motor } = montar(t);
  motor.recibir.telemetry(tele(CASETA, "deviceMetrics", { batteryLevel: 80, voltage: 4.01 }, { id: 77 }));
  motor.recibir.telemetry(tele(CASETA, "deviceMetrics", { batteryLevel: 80, voltage: 4.01 }, { id: 77 }));
  assert.equal(S.store.rows.length, 2); // batería y tensión, una vez
});

test("canales: guarda nombre y si es privado, nunca la clave", (t) => {
  const { S, motor, ev } = montar(t, { channels: [] });
  motor.recibir.channel({ index: 0, role: 1, settings: { name: "SFNarrow", psk: new Uint8Array([1]) } });
  motor.recibir.channel({ index: 2, role: 2, settings: { name: "avisos", psk: new Uint8Array(32).fill(9) } });
  motor.recibir.channel({ index: 3, role: 0, settings: {} });
  assert.deepEqual(S.channels, [
    { index: 0, name: "SFNarrow", primary: true, private: false, why: "clave pública por defecto" },
    { index: 2, name: "avisos", primary: false, private: true, why: "" },
  ]);
  assert.ok(ev.guardado.includes("channels"));
});
