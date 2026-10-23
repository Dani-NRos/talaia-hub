// Motor de Talaia, sin pantalla: nodos, lecturas, alarmas (umbral, cambio rápido, valla, sin señal), peticiones a
// nodos, traceroute y avisos por la malla. Lo usan la app y el servidor; cada uno pone su pantalla y su almacén.
//
//   const motor = crearMotor(S, ganchos);
//
// S es el estado compartido (la app le añade lo suyo de pantalla); ver estadoInicial(). Ganchos, todos opcionales:
//   cambio()            algo ha cambiado: redibujar
//   lectura(num)        llegaron lecturas de ese nodo
//   posicion(num)       cambió su ubicación o su petición de posición
//   peticion(num)       cambió una petición a ese nodo (botones y estado)
//   peticionEstado(num) solo el texto de estado de sus peticiones
//   ruta(num)           llegó una ruta nueva hasta ese nodo
//   avisoMalla()        cambió el último aviso por la malla
//   registro()          entró algo en el registro que conviene enseñar ya
//   alarma(al)          saltó una alarma nueva: sonar, vibrar, notificar
//   toast(texto)        mensaje corto para quien pulsó (p. ej., «espera 30 s»)
//   diag(entrada)       línea para el diagnóstico de conexión
//   guardar(clave)      guardar esa parte del estado: cfg, nodes, log, active, infoAsk, traces, channels, lora, my
//   radio               el receptor: { listo(), requestTelemetry, requestNodeInfo, requestPosition, requestTraceroute,
//                       sendText }. Cada envío devuelve { id, done } (id del paquete al momento; done, promesa).
//
// Lo aprendido con la malla real, que hay que respetar:
//  - Acuses y errores se casan por el id del paquete. El primer acuse suele ser el implícito del propio receptor
//    (oye a un vecino repetirlo), así que solo cuenta el que manda el nodo destino.
//  - Una respuesta se reconoce por cuándo llega, no por la hora del paquete: el reloj del receptor puede ir desfasado.
//  - Traceroute: uno cada 30 s como mucho (lo limita el firmware). Ficha: el nodo no contesta a quien se la pidió
//    en las últimas 12 h.

import { Protobuf } from "@meshtastic/core";
import { extractMetrics, metricMeta, fmtValue, fmtWithUnit, fmtNum, fmtLimit } from "./metrics.js";
import { encodeUser, routingErrorReason, decodeRouteDiscovery } from "./pb.js";
import { readTrace, relays, traceTimeout, UNKNOWN_NODE } from "./route.js";
import { distM, compass, fmtDist, coordText, nextPlace, placeFromPos } from "./geo.js";
import { trendCheck } from "./trend.js";
import { newDelivery, deliveryStep } from "./delivery.js";
import { channelPrivacy, channelWhy, fitBytes } from "./canales.js";
import { MIN, HOUR, isNum, validT, hhmm, dur, ago, stamp, trendDec, fmtTrend, trendVerb, hoursText } from "./textos.js";
import { esClaveMqtt } from "./mqtt-datos.js";
import { tx } from "./idioma.js";

/* ───────────── constantes ───────────── */
export const MESH_DEFAULT = () => ({ enabled: false, channel: null, node: null, onClear: false });

// Telemetría: cada tipo es un campo del mensaje Telemetry; se pide mandando ese campo vacío con want_response.
// Names in the core's language (idioma.js: «ask.env», «ask.env.what»…).
const askNames = (type, extra = {}) => Object.defineProperties(extra, {
  label: { get: () => tx(`ask.${type}`), enumerable: true },
  what: { get: () => tx(`ask.${type}.what`), enumerable: true },
});
export const ASK = {
  env:    askNames("env", { field: 3, variant: "environmentMetrics" }),
  device: askNames("device", { field: 2, variant: "deviceMetrics" }),
  air:    askNames("air", { field: 4, variant: "airQualityMetrics" }),
  power:  askNames("power", { field: 5, variant: "powerMetrics" }),
};
// Ficha del nodo (NodeInfo): nombre y clave pública. Sin la clave, el receptor no le manda peticiones.
export const ASK_ALL = { ...ASK, info: askNames("info"), pos: askNames("pos"), route: askNames("route") };
const ASK_BY_VARIANT = Object.fromEntries(Object.entries(ASK).map(([k, a]) => [a.variant, k]));
export const ASK_TIMEOUT = 60000, ASK_COOLDOWN = 30000, INFO_COOLDOWN = 60000, ASK_SHOW = 10 * MIN, TRACE_GAP = 30000;
export const RE = Protobuf.Mesh.Routing_Error;
// Códigos que la librería incluida aún no nombra (firmware 2.7+).
export const E_RATE_LIMIT = 38, E_NO_PUBKEY = 39;
export const KEY_ERRORS = new Set([RE.PKI_FAILED, RE.PKI_UNKNOWN_PUBKEY, E_NO_PUBKEY]);
export const askKey = (num, type) => `${num}|${type}`;
export const INFO_SUPPRESS = 12 * HOUR;

// Valla antirrobo: salta cuando dos posiciones nuevas seguidas caen fuera del radio; se cierra al volver con un 20 %
// de margen.
export const FENCE_CONFIRM = 2, FENCE_CLEAR = 0.8;

// Avisos por la malla: como mucho uno cada 8 s y 20 por hora; uno que lleve 30 min en cola ya no sale.
export const MESH_GAP = 8000, MESH_HOURLY = 20, MESH_MAX_AGE = 30 * MIN;
// Espera al acuse del nodo destino de un aviso directo; uno que llegue después aún cuenta como entregado (tarde).
export const MESH_CONFIRM = 90000;

export const seriesKey = (num, metric) => `${num}|${metric}`;
export const trendKey = (num, k) => `${num}|${k}|trend`;
export const estadoKey = (num, k) => `${num}|${k}|estado`; // alarma de un dato ON/OFF (servidor)
export const conexionKey = (num) => `${num}||conexion`; // un panel sin nodo cuyo dispositivo se ha desconectado
export const hexId = (num) => `!${(num >>> 0).toString(16).padStart(8, "0")}`;
/** Alarma de un dato MQTT (de un panel sin nodo o de un dato MQTT en el de un nodo): no va a Home Assistant. */
export const esAlarmaMqtt = (al) => al.num < 0 || esClaveMqtt(al.metric || "");

/** Lo que el motor necesita en S. La app y el servidor le añaden lo suyo. */
export function estadoInicial() {
  return {
    demo: false,
    demoData: null,
    demoToken: 0,
    store: null, // histórico: { add(rows), series(num, metric, since), all(), prune(t), clear() }
    cfg: { watched: {} },
    settings: { defaultOfflineMin: 75, mesh: null },
    nodes: new Map(),
    myNode: null,
    myUser: null, // ficha de nuestro receptor, se manda al pedir la de otro nodo
    channels: [], // canales del receptor: { index, name, primary, private, why } (sin claves)
    demoMesh: null,
    meshLast: null,
    link: { state: "idle", extra: null },
    device: null, // { kind: "ble" | "serial", … }
    active: new Map(),
    log: [],
    recent: new Map(),
    seen: new Set(),
    req: new Map(), // peticiones a nodos en curso o recientes, por nodo|tipo
    infoAsked: {}, // última vez que se pidió la ficha a cada nodo: los nodos no contestan otra vez en 12 h
    traces: {}, // última ruta trazada a cada nodo: { t, ms, fwd, back }
    traceAt: 0, // último traceroute enviado, a cualquier nodo (el firmware solo deja uno cada 30 s)
    lora: null, // preset y límite de saltos del receptor: { usePreset, modemPreset, spreadFactor, hopLimit }
  };
}

export function crearMotor(S, g = {}) {
  const render = () => g.cambio?.();
  const toast = (msg) => g.toast?.(msg);
  const refreshPos = (num) => g.posicion?.(num);
  const refreshAsk = (num) => g.peticion?.(num);
  const patchAskStatus = (num) => g.peticionEstado?.(num);
  const patchMeshLast = () => g.avisoMalla?.();
  const renderLog = () => g.registro?.();
  const fireAlarm = (al) => g.alarma?.(al);
  const pushDiag = (e) => g.diag?.(e);
  const save = (k) => g.guardar?.(k);
  const saveCfg = () => save("cfg");
  const saveNodes = () => save("nodes");
  const saveLog = () => save("log");
  const saveActive = () => save("active");
  const radioReady = () => !!g.radio?.listo?.();

  /* ───────────── nodos ───────────── */
  function node(num) {
    let n = S.nodes.get(num);
    if (!n) {
      const hex = (num >>> 0).toString(16).padStart(8, "0");
      n = { num, short: hex.slice(-4), long: `!${hex}`, hw: "", lastHeard: 0, hops: null, snr: null, metrics: {}, hasEnv: false };
      S.nodes.set(num, n);
    }
    if (!n.metrics) n.metrics = {};
    return n;
  }
  // El nombre que le haya puesto el usuario (paneles del servidor) o el suyo de Meshtastic.
  const nodeName = (num) => (S.nodes.get(num)?.alias || S.nodes.get(num)?.long) || hexId(num);
  // Paneles sin nodo (servidor: datos que llegan por MQTT): números negativos, que ningún nodo Meshtastic puede tener.
  const sinNodo = (num) => num < 0;
  const isWatched = (num) => !!S.cfg.watched[num];

  function touch(num, t) {
    const n = node(num);
    if (validT(t) && t > (n.lastHeard || 0)) {
      n.lastHeard = t;
      if (S.active.has(`${num}||offline`)) evalOffline();
    }
  }

  /* ───────────── lecturas y alarmas ───────────── */
  function ingest(num, metrics, t, opts = {}) {
    const n = node(num);
    const rows = [];
    for (const [k, v] of Object.entries(metrics)) {
      const prev = n.metrics[k];
      const newer = !prev || t >= prev.t;
      // «desde»: cuándo pasó a ese valor (los estados ON/OFF del servidor: «abierta más de 10 min»).
      if (newer) n.metrics[k] = prev?.desde != null && prev.v === v ? { v, t, desde: prev.desde } : { v, t };
      rows.push({ node: num, metric: k, t, v });
      const key = seriesKey(num, k);
      const arr = S.recent.get(key) || [];
      arr.push({ t, v });
      if (arr.length > 1 && arr[arr.length - 2].t > t) arr.sort((a, b) => a.t - b.t);
      while (arr.length && arr[0].t < Date.now() - 26 * HOUR) arr.shift();
      S.recent.set(key, arr);
      if (newer) { evalThreshold(num, k, v, t, opts); evalTrend(num, k, opts); evalEstado(num, k, opts); }
    }
    if (opts.env || opts.kind === "environmentMetrics") n.hasEnv = true;
    if (opts.store !== false) S.store.add(rows);
    if (opts.touch !== false) touch(num, t); // false: no llegó por radio (la estación del servidor)
    saveNodes();
    g.lectura?.(num);
    render();
  }

  function evalThreshold(num, metric, v, t, opts = {}) {
    const w = S.cfg.watched[num];
    const kh = `${num}|${metric}|high`, kl = `${num}|${metric}|low`;
    if (!w) { clearAlarm(kh, { v, t, silent: true }); clearAlarm(kl, { v, t, silent: true }); return; }
    const r = (w.rules || {})[metric] || {};
    const hy = metricMeta(metric).hyst || 0;
    if (isNum(r.max) && v > r.max) raise(kh, { num, metric, kind: "high", value: v, limit: r.max, t }, opts);
    else if (S.active.has(kh) && (!isNum(r.max) || v <= r.max - hy)) clearAlarm(kh, { v, t });
    if (isNum(r.min) && v < r.min) raise(kl, { num, metric, kind: "low", value: v, limit: r.min, t }, opts);
    else if (S.active.has(kl) && (!isNum(r.min) || v >= r.min + hy)) clearAlarm(kl, { v, t });
  }

  function evalNode(num, opts = {}) {
    const n = S.nodes.get(num);
    if (n) for (const [k, m] of Object.entries(n.metrics)) evalThreshold(num, k, m.v, m.t, opts);
    for (const k of Object.keys(S.cfg.watched[num]?.rules || {})) { evalTrend(num, k, opts); evalEstado(num, k, opts); }
    // métricas con regla pero que ya no tienen dato: nada que evaluar
    for (const key of [...S.active.keys()]) {
      const a = S.active.get(key);
      if (a.num === num && (a.kind === "high" || a.kind === "low" || a.kind === "trend" || a.kind === "estado") && !isWatched(num)) clearAlarm(key, { silent: true });
    }
    evalOffline(opts);
    evalFence(num, { silent: opts.silent });
  }

  function linkKnown() { return S.demo || S.link.state === "ready"; }

  /* ───────────── cambio rápido (tendencia) ───────────── */
  // Avisa cuando un valor baja o sube mucho en poco tiempo aunque no llegue a ningún límite
  // (la presión que cae antes de una tormenta, la batería que se vacía de golpe).
  /** Lecturas de las últimas 26 h; la batería «USB» (101) no cuenta. */
  function trendSeries(num, k) {
    const s = S.recent.get(seriesKey(num, k)) || [];
    return k === "batteryLevel" ? s.filter((p) => p.v <= 100) : s;
  }
  /** Cambio en la ventana de la regla, hasta la última lectura; null sin historia suficiente. */
  function trendNow(num, k, rule) {
    const last = S.nodes.get(num)?.metrics?.[k];
    if (!last || (k === "batteryLevel" && last.v > 100)) return null;
    return trendCheck(trendSeries(num, k), last.t, rule);
  }
  /** strict: al cambiar la regla, se cierra en cuanto deja de cumplirse (sin el margen del 70 %). */
  function evalTrend(num, k, opts = {}) {
    const key = trendKey(num, k);
    const rule = S.cfg.watched[num]?.rules?.[k]?.trend;
    if (!rule) return clearAlarm(key, { silent: true });
    const last = S.nodes.get(num)?.metrics?.[k];
    if (k === "batteryLevel" && last?.v > 100) return clearAlarm(key, { v: last.v, t: last.t }); // ya está enchufado
    const r = trendNow(num, k, rule);
    if (!r) return;
    if (r.fire) raise(key, { num, metric: k, kind: "trend", dir: rule.dir, value: r.change, limit: rule.delta, hours: rule.hours, from: r.from, to: r.to, t: r.to.t }, opts);
    else if (S.active.has(key) && (r.clear || opts.strict)) clearAlarm(key, { v: r.to.v, t: r.to.t });
  }

  /* ───────────── estados ON/OFF (datos MQTT del servidor) ───────────── */
  // Regla: rules[k].estado = { cuando: 1 | 0, min: minutos que tiene que durar (0: al momento) }.
  /** strict: al cambiar la regla, lo que ya no la cumple se cierra sin aviso (no es que haya cambiado el estado). */
  function evalEstado(num, k, opts = {}) {
    const key = estadoKey(num, k);
    const r = S.cfg.watched[num]?.rules?.[k]?.estado;
    const m = S.nodes.get(num)?.metrics?.[k];
    if (!r || !m) return clearAlarm(key, { silent: true });
    const desde = m.desde ?? m.t;
    const lim = (r.min || 0) * MIN;
    if (m.v === r.cuando && Date.now() - desde >= lim) {
      raise(key, { num, metric: k, kind: "estado", value: m.v, limit: r.min || 0, desde, t: desde + lim }, opts);
    } else if (S.active.has(key)) {
      if (m.v === r.cuando || opts.strict) clearAlarm(key, { silent: true }); // la regla ha cambiado, no el estado
      else clearAlarm(key, { v: m.v, t: m.t });
    }
  }
  /** Los que tienen que durar un tiempo («abierta más de 10 min»): se miran cada poco. */
  function evalEstados() {
    for (const [numStr, w] of Object.entries(S.cfg.watched)) {
      for (const [k, r] of Object.entries(w.rules || {})) if (r.estado) evalEstado(Number(numStr), k);
    }
  }

  /* ───────────── valla antirrobo ───────────── */
  function evalFence(num, opts = {}) {
    const key = `${num}||moved`;
    const w = S.cfg.watched[num];
    const n = S.nodes.get(num);
    if (!w?.fence || !n?.pos) { clearAlarm(key, { silent: true }); if (n) n.fenceOut = 0; return; }
    const d = distM(w.fence, n.pos);
    if (d > w.fence.r) {
      if (opts.fresh) n.fenceOut = (n.fenceOut || 0) + 1;
      if (opts.force || (n.fenceOut || 0) >= FENCE_CONFIRM || S.active.has(key)) {
        raise(key, { num, kind: "moved", value: d, limit: w.fence.r, t: n.pos.t }, opts);
      }
    } else {
      n.fenceOut = 0;
      if (S.active.has(key) && d <= w.fence.r * FENCE_CLEAR) clearAlarm(key, { v: d, t: n.pos.t });
    }
  }

  /** Guarda una posición nueva del nodo. live: llegó por la malla ahora (no es la copia de la base de datos). */
  function setPosition(num, pos, opts = {}) {
    const n = node(num);
    const prev = n.pos;
    if (prev && pos.t < prev.t) return false;
    if (!pos.bits && prev?.bits && prev.lat === pos.lat && prev.lon === pos.lon) pos.bits = prev.bits;
    const fresh = !prev || pos.t > prev.t;
    n.pos = pos;
    // Sitio actual y desde cuándo está en él: para saber si sus lecturas se midieron aquí (mapa).
    n.place = nextPlace(n.place || placeFromPos(prev), pos);
    evalFence(num, { fresh: fresh && opts.live, replay: opts.replay });
    saveNodes();
    refreshPos(num);
    render();
    return true;
  }

  /** Fija el sitio del nodo en su posición actual con ese radio (m). Devuelve false si no se puede. */
  function setFence(num, r) {
    const w = S.cfg.watched[num], n = S.nodes.get(num);
    if (!w || !n?.pos) return false;
    w.fence = { lat: n.pos.lat, lon: n.pos.lon, r: Math.round(r), at: Date.now() };
    n.fenceOut = 0;
    saveCfg();
    clearAlarm(`${num}||moved`, { silent: true });
    addLog("info", tx("log.fenceSet", { name: nodeName(num), r: fmtDist(w.fence.r), coords: coordText(w.fence) }), num);
    return true;
  }
  function setFenceRadius(num, r) {
    const w = S.cfg.watched[num];
    if (!w?.fence) return false;
    w.fence.r = Math.round(r);
    saveCfg();
    evalFence(num, { force: true });
    return true;
  }
  function delFence(num) {
    const w = S.cfg.watched[num];
    if (!w?.fence) return false;
    delete w.fence;
    saveCfg();
    clearAlarm(`${num}||moved`, { silent: true });
    addLog("info", tx("log.fenceRemoved", { name: nodeName(num) }), num);
    return true;
  }

  function evalOffline(opts = {}) {
    const now = Date.now();
    for (const key of [...S.active.keys()]) {
      const a = S.active.get(key);
      if (a.kind === "offline" && !isWatched(a.num)) clearAlarm(key, { silent: true });
    }
    const radio = linkKnown(); // sin receptor no sé si los nodos callan (los paneles sin nodo no dependen de él)
    for (const [numStr, w] of Object.entries(S.cfg.watched)) {
      const num = Number(numStr);
      if (!radio && !sinNodo(num)) continue;
      const n = S.nodes.get(num);
      const key = `${num}||offline`;
      const lim = isNum(w.offlineMin) ? w.offlineMin : S.settings.defaultOfflineMin;
      if (num === S.myNode && !S.demo) { clearAlarm(key, {}); continue; }
      if (!lim || !n || !n.lastHeard) { clearAlarm(key, { silent: true }); continue; }
      if (now - n.lastHeard > lim * MIN) raise(key, { num, kind: "offline", limit: lim, value: n.lastHeard, t: n.lastHeard + lim * MIN }, opts);
      else clearAlarm(key, { t: n.lastHeard });
    }
  }

  function raise(key, a, opts = {}) {
    const ex = S.active.get(key);
    if (ex) {
      ex.value = a.value;
      ex.lastT = a.t;
      if (isNum(a.limit)) ex.limit = a.limit;
      if (a.kind === "trend") Object.assign(ex, { dir: a.dir, hours: a.hours, from: a.from, to: a.to });
      saveActive();
      return;
    }
    const al = { key, ...a, since: isNum(a.t) ? a.t : Date.now(), acked: false, late: !!opts.replay };
    S.active.set(key, al);
    addLog("raise", alarmTitle(al) + (al.late ? tx("al.late") : ""), al.num, marcaMqtt(al));
    saveActive();
    if (!opts.silent) fireAlarm(al);
    if (!opts.silent) meshNotify("raise", al);
    render();
  }

  function clearAlarm(key, info = {}) {
    const al = S.active.get(key);
    if (!al) return;
    S.active.delete(key);
    if (!info.silent) addLog("clear", clearText(al, info), al.num, marcaMqtt(al));
    if (!info.silent) meshNotify("clear", al, info);
    saveActive();
    render();
  }

  function ack(key) {
    const al = S.active.get(key);
    if (!al || al.acked) return;
    al.acked = true;
    addLog("ack", tx("al.ack", { title: alarmTitle(al) }), al.num, marcaMqtt(al));
    saveActive();
    render();
  }
  function ackAll() { for (const k of S.active.keys()) ack(k); }
  const unacked = () => [...S.active.values()].filter((a) => !a.acked);

  // Texts of an alarm, in the core's language (idioma.js).
  function alarmTitle(al) {
    if (al.kind === "link") return tx("al.link");
    if (al.kind === "test") return tx("al.test");
    const name = nodeName(al.num);
    if (al.kind === "offline") return tx(sinNodo(al.num) ? "al.offlineData" : "al.offline", { name, d: dur(al.limit * MIN) });
    if (al.kind === "moved") return tx("al.moved", { name });
    if (al.kind === "conexion") return tx("al.conexion", { name });
    const m = metricMeta(al.metric);
    if (al.kind === "estado") return tx(al.limit ? "al.estadoFor" : "al.estado", { name, label: m.label, state: fmtValue(al.metric, al.value), d: al.limit ? dur(al.limit * MIN) : "" });
    if (al.kind === "trend") {
      const change = fmtTrend(al.metric, al.value, trendDec(al.metric, al.value));
      return tx(al.dir === "down" ? "al.trendDown" : "al.trendUp", { name, label: m.label, change, d: dur(al.to.t - al.from.t) });
    }
    return tx(al.kind === "high" ? "al.high" : "al.low", { name, label: m.label, limit: fmtLimit(al.metric, al.limit, true) });
  }
  function alarmDetail(al) {
    if (al.kind === "link") return tx(S.device?.kind === "serial" ? "al.d.link.serial" : S.device?.kind === "tcp" ? "al.d.link.tcp" : "al.d.link.ble");
    if (al.kind === "test") return tx("al.d.test");
    if (al.kind === "offline") return tx("al.d.offline", { ago: ago(al.value), stamp: stamp(al.value) });
    if (al.kind === "conexion") return tx("al.d.conexion", { stamp: stamp(al.value) });
    if (al.kind === "estado") return tx("al.d.estado", { state: fmtValue(al.metric, al.value), stamp: stamp(al.desde) });
    if (al.kind === "moved") {
      const n = S.nodes.get(al.num), f = S.cfg.watched[al.num]?.fence;
      const dir = n?.pos && f ? tx("al.d.movedDir", { dir: compass(f, n.pos) }) : "";
      return tx("al.d.moved", { dist: fmtDist(al.value), dir, fence: fmtDist(al.limit), time: n?.pos ? hhmm.format(new Date(n.pos.t)) : "—" });
    }
    if (al.kind === "trend") {
      const d = trendDec(al.metric, al.value);
      return tx("al.d.trend", {
        from: fmtTrend(al.metric, al.from.v, d), fromT: stamp(al.from.t), to: fmtTrend(al.metric, al.to.v, d), toT: stamp(al.to.t),
        verb: trendVerb(al.dir), limit: fmtLimit(al.metric, al.limit, true), hours: hoursText(al.hours),
      });
    }
    return tx("al.d.value", { value: fmtWithUnit(al.metric, al.value) });
  }
  function clearText(al, info) {
    if (al.kind === "link") return tx("al.c.link");
    if (al.kind === "test") return tx("al.c.test");
    const name = nodeName(al.num);
    if (al.kind === "offline") return tx(sinNodo(al.num) ? "al.c.offlineData" : "al.c.offline", { name });
    if (al.kind === "moved") return isNum(info.v) ? tx("al.c.movedAt", { name, dist: fmtDist(info.v) }) : tx("al.c.moved", { name });
    if (al.kind === "conexion") return tx("al.c.conexion", { name });
    const m = metricMeta(al.metric);
    if (al.kind === "estado") {
      const state = isNum(info.v) ? fmtValue(al.metric, info.v) : tx("al.c.estadoOff");
      return isNum(info.t) ? tx("al.c.estadoAfter", { name, label: m.label, state, d: dur(info.t - al.desde) }) : tx("al.c.estado", { name, label: m.label, state });
    }
    if (al.kind === "trend") {
      const verb = trendVerb(al.dir);
      return isNum(info.v) ? tx("al.c.trendAt", { name, label: m.label, verb, value: fmtWithUnit(al.metric, info.v) }) : tx("al.c.trend", { name, label: m.label, verb });
    }
    return isNum(info.v) ? tx("al.c.rangeAt", { name, label: m.label, value: fmtWithUnit(al.metric, info.v) }) : tx("al.c.range", { name, label: m.label });
  }

  // En el registro, las alarmas de datos MQTT llevan «mqtt» (solo con servidor: en la app no hay datos MQTT).
  const marcaMqtt = (al) => (esAlarmaMqtt(al) ? { mqtt: true } : null);
  function addLog(type, text, num, extra = null) {
    // Who did it (on the server, while an order from a screen runs): for what people do, not for alarms coming and going.
    const by = type === "info" || type === "ack" ? S.actor : null;
    S.log.unshift({ t: Date.now(), type, text, num: num ?? null, ...(by ? { by } : {}), ...extra });
    if (S.log.length > 300) S.log.length = 300;
    saveLog();
  }

  /* ───────────── pedir datos a un nodo ───────────── */
  const canAsk = () => S.demo || (S.link.state === "ready" && radioReady());
  const askVisible = (r) => r && (r.state === "wait" || Date.now() - r.tDone < ASK_SHOW);
  // Quién confirmó cada paquete nuestro (requestId → nodo), para saber si el acuse vino del destino.
  const ackFrom = new Map();
  const askById = new Map(); // id del paquete de cada petición → la petición, para casar acuses y errores tardíos
  let infoArmed = null;

  /**
   * Acuse o error de la malla para una de nuestras peticiones. err: 0 acuse, otro número error, null otro tipo.
   * El acuse solo cuenta si lo manda el propio nodo (el de tu receptor al oír que otro la repite no dice nada).
   * Un error, venga de quien venga, cierra la petición: NO_RESPONSE (no tiene ese sensor), PKI (falta una clave),
   * MAX_RETRANSMIT (no llegó)… La librería solo atiende el primer acuse y los perdía si llegaban después.
   */
  function askRouting(reqId, from, err) {
    const r = askById.get(reqId);
    if (!r || r.state !== "wait" || err == null) return;
    if (err === 0) {
      if (from === r.num && !r.acked) { r.acked = true; patchAskStatus(r.num); }
      return;
    }
    finishAsk(r, "fail", err);
  }

  /** Avisa en el diagnóstico si el reloj del receptor va muy desfasado (las horas de las lecturas las pone él). */
  const clock = { n: 0, min: Infinity, said: false };
  function checkClock(rx) {
    clock.n++;
    clock.min = Math.min(clock.min, Date.now() - rx); // el paquete más reciente da el desfase real
    if (clock.said || clock.n < 30 || Math.abs(clock.min) < 2 * MIN) return;
    clock.said = true;
    pushDiag({ t: Date.now(), msg: tx("diag.clock", { d: dur(Math.abs(clock.min)), dir: tx(clock.min > 0 ? "diag.clockBehind" : "diag.clockAhead") }) });
  }
  /** Receptor recién conectado: se vuelve a medir el desfase de su reloj. */
  function resetClock() { Object.assign(clock, { n: 0, min: Infinity, said: false }); }

  function askFailText(code, r) {
    switch (code) {
      case RE.NO_RESPONSE: return tx("ask.f.noResponse");
      case RE.MAX_RETRANSMIT: return tx("ask.f.maxRetransmit");
      case RE.NO_ROUTE: case RE.GOT_NAK: return tx("ask.f.noRoute");
      case RE.NO_CHANNEL: return tx("ask.f.noChannel");
      case E_NO_PUBKEY: return tx("ask.f.noPubkey");
      case RE.PKI_UNKNOWN_PUBKEY: return tx("ask.f.unknownPubkey");
      case RE.PKI_FAILED: return tx("ask.f.pkiFailed");
      case RE.DUTY_CYCLE_LIMIT: return tx("ask.f.dutyCycle");
      case E_RATE_LIMIT: return tx("ask.f.rateLimit");
      case RE.TOO_LARGE: case RE.BAD_REQUEST: return tx("ask.f.rejected");
      case "timeout":
        if (r?.acked && r.type === "info") return tx("ask.f.infoAcked");
        if (r?.acked && r.type === "pos") return tx("ask.f.posAcked");
        if (r?.acked) return tx("ask.f.acked");
        if (r?.type === "info") return tx("ask.f.infoTimeout", { s: ASK_TIMEOUT / 1000 });
        if (r?.type === "route") return tx("ask.f.routeTimeout", { s: Math.round(r.limit / 1000), hops: S.lora?.hopLimit ? ` (${S.lora.hopLimit})` : "" });
        return tx("ask.f.timeout", { s: ASK_TIMEOUT / 1000 });
      case "throttled": return tx("ask.f.throttled");
      case "notice": return tx("ask.f.notice", { why: r?.notice || tx("ask.f.noticeNone") });
      case "send": return tx("ask.f.send");
      default: return tx("ask.f.error", { code: RE[code] ?? code });
    }
  }

  // ¿El receptor cifra los mensajes directos con clave? (firmware 2.5+ y sin modo radioaficionado)
  const receptorUsesPki = () => S.demo || (S.myUser?.publicKey?.length === 32 && !S.myUser.isLicensed);
  // Un fallo de clave deja de contar en cuanto llega la ficha del nodo.
  function keyFixedAt(num) {
    let t = 0;
    for (const type of Object.keys(ASK_ALL)) {
      if (type === "route") continue; // el traceroute no usa claves: que conteste no dice nada de ellas
      const r = S.req.get(askKey(num, type));
      if (r?.state === "ok" && r.tDone > t) t = r.tDone;
    }
    return t;
  }
  const staleKeyFail = (r) => r.state === "fail" && KEY_ERRORS.has(r.why) && r.tDone <= keyFixedAt(r.num);
  function keyNeeded(num) {
    if (num === S.myNode) return false;
    if (receptorUsesPki() && S.nodes.get(num)?.key === false) return true;
    return Object.keys(ASK).some((t) => {
      const r = S.req.get(askKey(num, t));
      return askVisible(r) && r.state === "fail" && KEY_ERRORS.has(r.why) && !staleKeyFail(r);
    });
  }

  async function ask(num, type) {
    const isInfo = type === "info", isPos = type === "pos", isRoute = type === "route";
    const k = askKey(num, type);
    const prev = S.req.get(k);
    if (prev?.state === "wait") return;
    if (isRoute && num === S.myNode) return toast(tx("ask.t.mine"));
    const cool = isInfo || isPos ? INFO_COOLDOWN : ASK_COOLDOWN;
    const since = prev ? Date.now() - prev.t0 : Infinity;
    if (!isRoute && since < cool) return toast(tx("ask.t.wait", { s: Math.ceil((cool - since) / 1000) }));
    if (!canAsk()) return toast(tx(isRoute ? "ask.t.connectRoute" : "ask.t.connect"));
    if (isRoute) {
      const gap = Date.now() - S.traceAt;
      if (gap < TRACE_GAP) return toast(tx("ask.t.traceGap", { s: Math.ceil((TRACE_GAP - gap) / 1000) }));
    }
    if (isInfo && !S.demo && !S.myUser) return toast(tx("ask.t.loading"));
    if (isInfo) {
      // El firmware no contesta a la misma petición de ficha en 12 h, y cada petición nueva reinicia esa cuenta.
      const ago = Date.now() - (S.infoAsked[num] || 0);
      if (ago < INFO_SUPPRESS && infoArmed !== num) {
        infoArmed = num;
        setTimeout(() => { if (infoArmed === num) infoArmed = null; }, 6000);
        return toast(tx("ask.t.infoAgain", { when: ago < MIN ? tx("ask.t.justNow") : tx("t.ago", { d: dur(ago) }) }));
      }
      infoArmed = null;
      S.infoAsked[num] = Date.now();
      if (!S.demo) save("infoAsk");
    }
    const r = { num, type, state: "wait", t0: Date.now(), tDone: 0, why: null, timer: null, acked: false };
    r.limit = isRoute ? traceTimeout(S.nodes.get(num)?.hops) : ASK_TIMEOUT;
    if (isRoute) S.traceAt = Date.now();
    S.req.set(k, r);
    r.timer = setTimeout(() => finishAsk(r, "fail", "timeout"), r.limit);
    refreshAsk(num);
    refreshPos(num);
    if (S.demo) return demoAsk(r);
    try {
      const radio = g.radio;
      const ch = S.nodes.get(num)?.channel || 0;
      const sent = isInfo ? radio.requestNodeInfo(num, encodeUser(S.myUser), ch)
        : isPos ? radio.requestPosition(num, ch)
        : isRoute ? radio.requestTraceroute(num, ch)
        : radio.requestTelemetry(num, ASK[type].field, ch);
      if (sent.id != null) {
        r.id = sent.id;
        askById.set(sent.id, r);
        if (askById.size > 100) askById.delete(askById.keys().next().value);
      }
      const id = await sent.done;
      // Acuse sin respuesta todavía: seguimos esperando. Solo cuenta si lo manda el propio nodo.
      if (r.state === "wait" && ackFrom.get(id) === num) { r.acked = true; patchAskStatus(num); }
    } catch (e) {
      const code = e && typeof e === "object" && "error" in e ? e.error : "send";
      // La librería no cuenta la respuesta como acuse y da TIMEOUT a los 60 s: manda nuestro temporizador.
      if (code === RE.TIMEOUT) return;
      finishAsk(r, "fail", code);
    }
  }

  function finishAsk(r, state, why = null) {
    if (S.req.get(askKey(r.num, r.type)) !== r) return;
    const lateOk = state === "ok" && r.state === "fail";
    if (r.state !== "wait" && !lateOk) return;
    clearTimeout(r.timer);
    Object.assign(r, { state, why, tDone: Date.now() });
    const what = `${nodeName(r.num)} · ${ASK_ALL[r.type].label}`;
    const late = lateOk ? tx("log.ask.late") : "";
    let msg;
    if (state !== "ok") msg = `${what}: ${askFailText(why, r)}`;
    else if (r.type === "info") msg = tx(r.gotKey ? "log.ask.info" : "log.ask.infoNoKey", { what });
    else if (r.type === "pos") msg = tx(r.noLoc ? "log.ask.posNone" : "log.ask.pos", { what });
    else if (r.type === "route") msg = tx("log.ask.route", { what, fwd: r.trace ? legText(r.trace.fwd) : "?", back: r.trace?.back ? legText(r.trace.back) : tx("log.ask.noBack"), late });
    else msg = tx("log.ask.data", { what, late });
    addLog("info", msg, r.num);
    refreshAsk(r.num);
    refreshPos(r.num);
    render();
  }

  function demoAsk(r) {
    const token = S.demoToken;
    const res = S.demoData.reply(r.num, r.type);
    setTimeout(() => {
      if (!S.demo || token !== S.demoToken) return;
      if (res.error) return finishAsk(r, "fail", typeof res.error === "number" ? res.error : RE[res.error]);
      if (r.type === "info") {
        node(r.num).key = true;
        r.gotKey = true;
        return finishAsk(r, "ok");
      }
      if (r.type === "route") return gotTrace(r, res.route, S.myNode, r.num, true);
      if (r.type === "pos") {
        r.noLoc = !res.pos;
        finishAsk(r, "ok");
        if (res.pos) setPosition(r.num, { ...res.pos, t: Date.now() }, { live: true });
        return;
      }
      finishAsk(r, "ok");
      ingest(r.num, res.metrics, Date.now(), { kind: ASK[r.type].variant });
    }, res.delay);
  }

  function resetAsks() {
    for (const r of S.req.values()) clearTimeout(r.timer);
    S.req = new Map();
  }

  /* ───────────── ruta por la malla (traceroute) ───────────── */
  function saveTraces() {
    if (S.demo) return;
    // La última de cada nodo; como mucho 60 nodos, los más recientes.
    S.traces = Object.fromEntries(Object.entries(S.traces).sort((a, b) => b[1].t - a[1].t).slice(0, 60));
    save("traces");
  }
  /** Respuesta a un traceroute nuestro: rd = RouteDiscovery leído; origin = nuestro receptor; dest = el nodo. */
  function gotTrace(r, rd, origin, dest, hasHopStart) {
    const trace = readTrace(rd, origin, dest, hasHopStart);
    r.trace = trace;
    S.traces[r.num] = { t: Date.now(), ms: Date.now() - r.t0, ...trace };
    saveTraces();
    finishAsk(r, "ok");
    g.ruta?.(r.num);
  }
  function hopName(num) {
    if (num === UNKNOWN_NODE) return tx("hop.unknown");
    if (num === S.myNode) return tx("hop.mine");
    return S.nodes.get(num)?.long || hexId(num);
  }
  /** «directa» o «por R3 → DNN4». */
  function legText(leg) {
    const mid = relays(leg);
    return mid.length ? tx("leg.via", { list: mid.map(hopName).join(" → ") }) : tx("leg.direct");
  }

  /* ───────────── avisos por la malla ───────────── */
  const meshById = new Map(); // id del paquete → aviso directo en curso o reciente

  function setChannel(c) {
    const idx = c.index;
    S.channels = S.channels.filter((x) => x.index !== idx);
    if (c.role !== 0) {
      const primary = c.role === 1;
      S.channels.push({ index: idx, name: c.settings?.name || (primary ? tx("ch.primary") : tx("ch.n", { n: idx })), primary, ...channelPrivacy(c.settings?.psk) });
      S.channels.sort((a, b) => a.index - b.index);
    }
    if (!S.demo) save("channels"); // solo nombre e índice: las claves no se guardan
  }

  const meshCfg = () => (S.demo ? (S.demoMesh ||= MESH_DEFAULT()) : (S.settings.mesh ||= MESH_DEFAULT()));

  /** The text of an alert over the mesh (at most 200 bytes once cut): in the language of whoever sends it. */
  function meshText(kind, al, info) {
    const now = hhmm.format(new Date());
    if (kind === "test") return tx("mesh.test", { now });
    const name = nodeName(al.num);
    const at = (t) => hhmm.format(new Date(t));
    const label = al.metric ? metricMeta(al.metric).label : "";
    if (kind === "clear") {
      if (al.kind === "offline") return tx(sinNodo(al.num) ? "mesh.c.offlineData" : "mesh.c.offline", { name, now });
      if (al.kind === "moved") return tx("mesh.c.moved", { name, now });
      if (al.kind === "conexion") return tx("mesh.c.conexion", { name, now });
      if (al.kind === "estado") return tx("mesh.c.estado", { name, label, state: isNum(info?.v) ? fmtValue(al.metric, info.v) : tx("mesh.c.noLonger"), now });
      if (al.kind === "trend") return tx("mesh.c.trend", { name, label, verb: trendVerb(al.dir), now });
      return tx("mesh.c.range", { name, label, v: isNum(info?.v) ? ` (${fmtWithUnit(al.metric, info.v)})` : "", now });
    }
    const late = al.late ? tx("mesh.late") : "";
    if (al.kind === "offline") return tx(sinNodo(al.num) ? "mesh.offlineData" : "mesh.offline", { name, time: at(al.value), now });
    if (al.kind === "conexion") return tx("mesh.conexion", { name, time: at(al.value), now, late });
    if (al.kind === "estado") return tx("mesh.estado", { name, label, state: fmtValue(al.metric, al.value), time: at(al.desde), now, late });
    if (al.kind === "moved") {
      const n = S.nodes.get(al.num), f = S.cfg.watched[al.num]?.fence;
      const where = n?.pos ? ` · ${coordText(n.pos)}` : "";
      const dir = n?.pos && f ? tx("mesh.movedDir", { dir: compass(f, n.pos) }) : "";
      return tx("mesh.moved", { name, dist: fmtDist(al.value), dir, where, now, late });
    }
    if (al.kind === "trend") {
      const d = trendDec(al.metric, al.value), u = metricMeta(al.metric).unit;
      return tx("mesh.trend", {
        name, label, going: tx(al.dir === "down" ? "mesh.trendDown" : "mesh.trendUp"), sign: al.dir === "down" ? "−" : "+",
        change: fmtTrend(al.metric, al.value, d), d: dur(al.to.t - al.from.t), from: fmtNum(al.from.v, d), to: fmtNum(al.to.v, d), unit: u ? ` ${u}` : "", now, late,
      });
    }
    return tx("mesh.limit", { name, label, value: fmtWithUnit(al.metric, al.value), side: tx(al.kind === "high" ? "mesh.max" : "mesh.min"), limit: fmtLimit(al.metric, al.limit), now, late });
  }

  /** Destinos válidos ahora mismo. Un canal público nunca pasa, aunque se haya guardado antes. */
  function meshTargets(report = false) {
    const cfg = meshCfg();
    const out = [];
    if (cfg.channel != null) {
      const ch = S.channels.find((c) => c.index === cfg.channel);
      if (ch?.private) out.push({ type: "channel", index: ch.index, label: tx("mesh.channel", { name: ch.name }) });
      else if (report) addLog("info", ch ? tx("log.mesh.blocked", { name: ch.name, why: channelWhy(ch) }) : tx("log.mesh.noChannel"));
    }
    if (cfg.node != null) {
      const n = S.nodes.get(cfg.node);
      if (!S.demo && !receptorUsesPki() && !S.channels.find((c) => c.index === (n?.channel || 0))?.private) {
        if (report) addLog("info", tx("log.mesh.nodeBlocked", { name: nodeName(cfg.node) }));
      } else out.push({ type: "node", num: cfg.node, label: nodeName(cfg.node) });
    }
    return out;
  }

  const meshQ = [];
  const meshSent = [];
  let meshBusy = false;
  function meshNotify(kind, al, info) {
    const cfg = meshCfg();
    if (kind !== "test" && !cfg.enabled) return;
    if (al && (al.kind === "link" || al.kind === "test")) return; // sin receptor no hay malla; la prueba es local
    if (kind === "clear" && !cfg.onClear) return;
    const targets = meshTargets(true);
    if (!targets.length) { if (kind === "test") toast(tx("mesh.t.choose")); return; }
    const text = fitBytes(meshText(kind, al, info));
    for (const tg of targets) meshQ.push({ tg, text, t: Date.now() });
    pumpMesh();
  }
  async function pumpMesh() {
    if (meshBusy) return;
    meshBusy = true;
    try {
      while (meshQ.length) {
        if (!S.demo && !(S.link.state === "ready" && radioReady())) break; // se reanuda al volver el receptor
        while (meshSent.length && meshSent[0] < Date.now() - HOUR) meshSent.shift();
        if (meshSent.length >= MESH_HOURLY) {
          const n = meshQ.splice(0).length;
          addLog("info", tx("log.mesh.paused", { max: MESH_HOURLY, n }));
          break;
        }
        const it = meshQ.shift();
        if (Date.now() - it.t > MESH_MAX_AGE) { addLog("info", tx("log.mesh.dropped", { to: it.tg.label })); continue; }
        meshSent.push(Date.now());
        sendMeshOne(it);
        if (meshQ.length) await new Promise((r) => setTimeout(r, MESH_GAP));
      }
    } finally {
      meshBusy = false;
    }
  }
  async function sendMeshOne(it) {
    const { tg, text } = it;
    const rec = { tg, text, tq: it.t, t: Date.now(), result: tx("mesh.r.sending"), ok: null, st: newDelivery(), timer: null };
    S.meshLast = rec;
    patchMeshLast();
    if (S.demo) {
      await new Promise((r) => setTimeout(r, 1200));
      if (tg.type === "node") { meshDelivery(rec, { type: "ack", from: S.myNode, err: 0 }); await new Promise((r) => setTimeout(r, 1800)); meshDelivery(rec, { type: "ack", from: tg.num, err: 0 }); }
      else meshDone(rec, tx("mesh.r.relayed"), true);
      return;
    }
    const dest = tg.type === "node" ? tg.num : "broadcast";
    const ch = tg.type === "node" ? S.nodes.get(tg.num)?.channel || 0 : tg.index;
    const sent = g.radio.sendText(dest, ch, text);
    if (tg.type === "node") {
      if (sent.id != null) {
        meshById.set(sent.id, rec);
        if (meshById.size > 50) meshById.delete(meshById.keys().next().value);
      }
      rec.timer = setTimeout(() => meshDelivery(rec, { type: "timeout" }), MESH_CONFIRM);
    }
    try {
      const id = await sent.done;
      // Primer acuse, el que atiende la librería: si es del destino, entregado; si no, solo salió a la malla.
      if (tg.type === "node") meshDelivery(rec, { type: "ack", from: ackFrom.get(id) ?? S.myNode, err: 0 });
      else meshDone(rec, tx("mesh.r.relayed"), true);
    } catch (e) {
      const code = e && typeof e === "object" && "error" in e ? e.error : "send";
      if (tg.type === "node") {
        if (code === RE.TIMEOUT) return; // la librería se rinde a los 60 s; manda nuestra espera
        meshDelivery(rec, { type: "ack", from: null, err: code });
        return;
      }
      meshDone(rec, code === RE.TIMEOUT ? tx("mesh.r.noConfirm") : code === RE.MAX_RETRANSMIT ? tx("mesh.r.nobody") : askFailText(code), false);
    }
  }

  /** Acuse o error de la malla para un aviso directo (desde onPacket). err: 0 acuse, otro número error. */
  function meshRouting(reqId, from, err) {
    const rec = meshById.get(reqId);
    if (rec && err != null) meshDelivery(rec, { type: "ack", from, err });
  }

  /** Avanza la entrega de un aviso directo y cuenta el resultado cuando cambia. */
  function meshDelivery(rec, ev) {
    const prev = rec.st;
    const st = deliveryStep(prev, ev, { dest: rec.tg.num });
    if (st === prev) return;
    rec.st = st;
    const name = nodeName(rec.tg.num);
    const secs = `${Math.max(1, Math.round((Date.now() - rec.t) / 1000))} s`;
    if (st.phase === "relayed") {
      rec.result = tx("mesh.r.onTheWay", { name });
      rec.ok = null;
      return patchMeshLast();
    }
    clearTimeout(rec.timer);
    if (st.phase === "delivered") return meshDone(rec, tx(st.late ? "mesh.r.deliveredLate" : "mesh.r.delivered", { s: secs }), true);
    if (st.phase === "unconfirmed") return meshDone(rec, tx(st.relayed ? "mesh.r.unconfRelayed" : "mesh.r.unconf", { name, s: MESH_CONFIRM / 1000 }), false);
    const why = st.code === RE.MAX_RETRANSMIT ? tx("mesh.r.retries") : askFailText(st.code);
    meshDone(rec, tx("mesh.r.notDelivered", { why }), false);
  }

  function meshDone(rec, result, ok) {
    const late = rec.t - rec.tq > 2 * MIN ? tx("mesh.r.lateOut") : "";
    rec.result = result + late;
    rec.ok = ok;
    rec.tDone = Date.now();
    addLog("info", tx("log.mesh.result", { to: rec.tg.label, result: rec.result }));
    patchMeshLast();
    renderLog();
  }

  /* ───────────── lo que llega del receptor ───────────── */
  function setUser(n, u) {
    if (u.longName) n.long = u.longName;
    if (u.shortName) n.short = u.shortName;
    if (typeof u.hwModel === "number" && u.hwModel > 0) n.hw = Protobuf.Mesh.HardwareModel?.[u.hwModel] || n.hw;
    if (u.publicKey) n.key = u.publicKey.length === 32;
  }
  function pickUser(u) {
    const { id, longName, shortName, macaddr, hwModel, isLicensed, role, publicKey, isUnmessagable } = u;
    return { id, longName, shortName, macaddr, hwModel, isLicensed, role, publicKey, isUnmessagable };
  }

  const recibir = {
    myNode(num) {
      S.myNode = num;
      save("my");
      node(num);
    },
    channel(c) { setChannel(c); },
    lora(l) {
      S.lora = { usePreset: l.usePreset, modemPreset: l.modemPreset, spreadFactor: l.spreadFactor, hopLimit: l.hopLimit };
      save("lora");
    },
    notice(n) {
      const msg = String(n?.message || "").trim();
      if (msg) pushDiag({ t: Date.now(), msg: tx("diag.notice", { msg }) });
      // El firmware avisa así cuando no manda una petición (p. ej. un traceroute antes de 30 s).
      const r = n?.replyId ? askById.get(n.replyId) : null;
      if (!r || r.state !== "wait") return;
      if (r.type === "route" && /trace ?route/i.test(msg)) { S.traceAt = Date.now(); return finishAsk(r, "fail", "throttled"); }
      r.notice = msg;
      finishAsk(r, "fail", "notice");
    },
    nodeInfo(ni) {
      const n = node(ni.num);
      if (ni.user) setUser(n, ni.user);
      if (ni.user && ni.num === S.myNode) S.myUser = pickUser(ni.user);
      const lh = ni.lastHeard ? ni.lastHeard * 1000 : 0;
      touch(ni.num, lh);
      if (isNum(ni.hopsAway)) n.hops = ni.hopsAway;
      if (isNum(ni.snr) && ni.snr !== 0) n.snr = ni.snr;
      if (isNum(ni.channel)) n.channel = ni.channel;
      const dm = ni.deviceMetrics;
      if (dm && validT(lh)) {
        const m = {};
        if (isNum(dm.batteryLevel) && dm.batteryLevel > 0) m.batteryLevel = dm.batteryLevel;
        if (isNum(dm.voltage) && dm.voltage > 0) m.voltage = dm.voltage;
        for (const [k, v] of Object.entries(m)) {
          const prev = n.metrics[k];
          if (!prev || lh > prev.t) { n.metrics[k] = { v, t: lh }; evalThreshold(ni.num, k, v, lh); }
        }
      }
      saveNodes();
      render();
    },
    user(from, user, meta) {
      const n = node(from);
      setUser(n, user);
      if (from === S.myNode) S.myUser = pickUser(user);
      // Un paquete en vivo (no la copia de la base de datos del receptor) responde a «Pedir ficha».
      const live = meta && meta.to !== meta.from;
      const r = S.req.get(askKey(from, "info"));
      if (live && r && Date.now() - r.t0 < 5 * MIN) { r.gotKey = user.publicKey?.length === 32; finishAsk(r, "ok"); }
      saveNodes();
      render();
    },
    packet(p) {
      const rx = p.rxTime ? p.rxTime * 1000 : 0;
      touch(p.from, validT(rx) ? rx : Date.now());
      const n = node(p.from);
      if (p.hopStart > 0 && isNum(p.hopLimit)) n.hops = Math.max(0, p.hopStart - p.hopLimit);
      if (isNum(p.rxSnr) && p.rxSnr !== 0) n.snr = p.rxSnr;
      const dec = p.payloadVariant?.case === "decoded" ? p.payloadVariant.value : null;
      if (dec && dec.portnum === Protobuf.Portnums.PortNum.ROUTING_APP && dec.requestId) {
        ackFrom.set(dec.requestId, p.from);
        if (ackFrom.size > 200) ackFrom.delete(ackFrom.keys().next().value);
        const err = routingErrorReason(dec.payload);
        askRouting(dec.requestId, p.from, err);
        meshRouting(dec.requestId, p.from, err);
      }
      // Respuesta a un traceroute nuestro: lleva el id de la petición.
      if (dec && dec.portnum === Protobuf.Portnums.PortNum.TRACEROUTE_APP && dec.requestId) {
        const r = askById.get(dec.requestId);
        const rd = r?.type === "route" ? decodeRouteDiscovery(dec.payload) : null;
        if (rd) gotTrace(r, rd, p.to, p.from, p.hopStart > 0);
      }
      if (validT(rx) && S.link.state === "ready") checkClock(rx);
      // Canal por el que emite el nodo, para pedirle datos por el mismo.
      if (p.to === 0xffffffff && isNum(p.channel) && p.channel < 8) n.channel = p.channel;
      saveNodes();
      render();
    },
    position(p) {
      const d = p.data;
      const live = p.to !== p.from; // la copia de la base de datos del receptor llega con from = to
      const hasLoc = !!(d && (d.latitudeI || d.longitudeI));
      const r = S.req.get(askKey(p.from, "pos"));
      if (live && r && Date.now() - r.t0 < 5 * MIN) { r.noLoc = !hasLoc; finishAsk(r, "ok"); }
      if (!hasLoc) return;
      const tPos = d.time ? d.time * 1000 : 0;
      const rx = p.rxTime?.getTime?.() || 0;
      const t = validT(tPos) ? tPos : live && validT(rx) ? rx : S.nodes.get(p.from)?.lastHeard || Date.now();
      setPosition(p.from, {
        lat: d.latitudeI / 1e7, lon: d.longitudeI / 1e7, t,
        alt: d.altitude || null, bits: d.precisionBits || 0, src: d.locationSource || 0,
      }, { live, replay: live && Date.now() - t > 5 * MIN });
    },
    telemetry(p) {
      const id = `${p.from}:${p.id}`;
      if (p.id && S.seen.has(id)) return;
      if (p.id) { S.seen.add(id); if (S.seen.size > 600) S.seen.delete(S.seen.values().next().value); }
      const rx = p.rxTime?.getTime?.() || 0;
      const sent = p.data?.time ? p.data.time * 1000 : 0;
      const t = validT(rx) ? rx : validT(sent) ? sent : Date.now();
      const kind = p.data.variant?.case;
      const pending = ASK_BY_VARIANT[kind] && S.req.get(askKey(p.from, ASK_BY_VARIANT[kind]));
      // Es la respuesta si llega después de pedirla. No se compara la hora del paquete: la pone el reloj del
      // receptor, y si va unos segundos atrasado la lectura parecía anterior a la petición y se perdía la respuesta.
      if (pending && Date.now() - pending.t0 < 5 * MIN) finishAsk(pending, "ok");
      const metrics = extractMetrics(p.data);
      if (!Object.keys(metrics).length) return;
      ingest(p.from, metrics, t, { kind, replay: Date.now() - t > 5 * MIN });
    },
  };

  return {
    S,
    // nodos
    node, nodeName, isWatched, touch,
    // lecturas y alarmas
    ingest, evalThreshold, evalNode, linkKnown, trendSeries, trendNow, evalTrend, evalEstado, evalEstados, evalFence, setPosition,
    setFence, setFenceRadius, delFence, evalOffline, raise, clearAlarm, ack, ackAll, unacked,
    alarmTitle, alarmDetail, clearText, addLog,
    // peticiones a nodos y rutas
    canAsk, askVisible, askFailText, receptorUsesPki, keyNeeded, staleKeyFail, ask, finishAsk, resetAsks,
    hopName, legText, resetClock,
    // avisos por la malla
    setChannel, meshCfg, meshTargets, meshText, meshNotify, pumpMesh,
    // lo que llega del receptor
    recibir,
    // guardar una parte del estado (lo usan las acciones)
    guardar: save,
  };
}
