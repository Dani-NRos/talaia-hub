// Motor de Vigía, sin pantalla: nodos, lecturas, alarmas (umbral, cambio rápido, valla, sin señal), peticiones a
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
import { extractMetrics, metricMeta, fmtWithUnit, fmtNum, fmtLimit } from "./metrics.js";
import { encodeUser, routingErrorReason, decodeRouteDiscovery } from "./pb.js";
import { readTrace, relays, traceTimeout, UNKNOWN_NODE } from "./route.js";
import { distM, compass, fmtDist, coordText, nextPlace, placeFromPos } from "./geo.js";
import { trendCheck } from "./trend.js";
import { newDelivery, deliveryStep } from "./delivery.js";
import { channelPrivacy, fitBytes } from "./canales.js";
import { MIN, HOUR, isNum, validT, hhmm, dur, ago, stamp, trendDec, fmtTrend, trendVerb, hoursText } from "./textos.js";

/* ───────────── constantes ───────────── */
export const MESH_DEFAULT = () => ({ enabled: false, channel: null, node: null, onClear: false });

// Telemetría: cada tipo es un campo del mensaje Telemetry; se pide mandando ese campo vacío con want_response.
export const ASK = {
  env:    { label: "Ambiente", what: "Temperatura, humedad y presión", field: 3, variant: "environmentMetrics" },
  device: { label: "Batería",  what: "Batería, tensión y uso del canal", field: 2, variant: "deviceMetrics" },
  air:    { label: "Aire",     what: "CO₂ y partículas", field: 4, variant: "airQualityMetrics" },
  power:  { label: "Energía",  what: "Tensión y corriente de los canales INA", field: 5, variant: "powerMetrics" },
};
// Ficha del nodo (NodeInfo): nombre y clave pública. Sin la clave, el receptor no le manda peticiones.
export const ASK_ALL = { ...ASK, info: { label: "Ficha" }, pos: { label: "Posición" }, route: { label: "Ruta" } };
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
export const hexId = (num) => `!${(num >>> 0).toString(16).padStart(8, "0")}`;

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
  const nodeName = (num) => (S.nodes.get(num)?.long) || hexId(num);
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
      if (newer) n.metrics[k] = { v, t };
      rows.push({ node: num, metric: k, t, v });
      const key = seriesKey(num, k);
      const arr = S.recent.get(key) || [];
      arr.push({ t, v });
      if (arr.length > 1 && arr[arr.length - 2].t > t) arr.sort((a, b) => a.t - b.t);
      while (arr.length && arr[0].t < Date.now() - 26 * HOUR) arr.shift();
      S.recent.set(key, arr);
      if (newer) { evalThreshold(num, k, v, t, opts); evalTrend(num, k, opts); }
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
    for (const k of Object.keys(S.cfg.watched[num]?.rules || {})) evalTrend(num, k, opts);
    // métricas con regla pero que ya no tienen dato: nada que evaluar
    for (const key of [...S.active.keys()]) {
      const a = S.active.get(key);
      if (a.num === num && (a.kind === "high" || a.kind === "low" || a.kind === "trend") && !isWatched(num)) clearAlarm(key, { silent: true });
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
    addLog("info", `${nodeName(num)} · Valla de ${fmtDist(w.fence.r)} fijada en ${coordText(w.fence)}`, num);
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
    addLog("info", `${nodeName(num)} · Valla quitada`, num);
    return true;
  }

  function evalOffline(opts = {}) {
    const now = Date.now();
    for (const key of [...S.active.keys()]) {
      const a = S.active.get(key);
      if (a.kind === "offline" && !isWatched(a.num)) clearAlarm(key, { silent: true });
    }
    if (!linkKnown()) return; // sin receptor no sé si los nodos callan
    for (const [numStr, w] of Object.entries(S.cfg.watched)) {
      const num = Number(numStr);
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
    addLog("raise", alarmTitle(al) + (al.late ? " (recibida al reconectar)" : ""), al.num);
    saveActive();
    if (!opts.silent) fireAlarm(al);
    if (!opts.silent) meshNotify("raise", al);
    render();
  }

  function clearAlarm(key, info = {}) {
    const al = S.active.get(key);
    if (!al) return;
    S.active.delete(key);
    if (!info.silent) addLog("clear", clearText(al, info), al.num);
    if (!info.silent) meshNotify("clear", al, info);
    saveActive();
    render();
  }

  function ack(key) {
    const al = S.active.get(key);
    if (!al || al.acked) return;
    al.acked = true;
    addLog("ack", `Enterado: ${alarmTitle(al)}`, al.num);
    saveActive();
    render();
  }
  function ackAll() { for (const k of S.active.keys()) ack(k); }
  const unacked = () => [...S.active.values()].filter((a) => !a.acked);

  function alarmTitle(al) {
    if (al.kind === "link") return "Receptor desconectado";
    if (al.kind === "test") return "Alarma de prueba";
    const name = nodeName(al.num);
    if (al.kind === "offline") return `${name} · Sin señal más de ${dur(al.limit * MIN)}`;
    if (al.kind === "moved") return `${name} · Fuera de su sitio`;
    const m = metricMeta(al.metric);
    if (al.kind === "trend") {
      const sign = al.dir === "down" ? "−" : "+";
      return `${name} · ${m.label} ${al.dir === "down" ? "bajando" : "subiendo"} rápido (${sign}${fmtTrend(al.metric, al.value, trendDec(al.metric, al.value))} en ${dur(al.to.t - al.from.t)})`;
    }
    return `${name} · ${m.label} ${al.kind === "high" ? "por encima de" : "por debajo de"} ${fmtLimit(al.metric, al.limit, true)}`;
  }
  function alarmDetail(al) {
    if (al.kind === "link") return `Reintentando la conexión${S.device?.kind === "serial" ? " por cable" : S.device?.kind === "tcp" ? " por la red" : " Bluetooth"}. Las alarmas de nodo sin señal quedan en pausa.`;
    if (al.kind === "test") return "Así suena y se ve un aviso. Pulsa Enterado para callarlo.";
    if (al.kind === "offline") return `Último dato ${ago(al.value)} (${stamp(al.value)}).`;
    if (al.kind === "moved") {
      const n = S.nodes.get(al.num), f = S.cfg.watched[al.num]?.fence;
      const dir = n?.pos && f ? ` al ${compass(f, n.pos)}` : "";
      return `Está a ${fmtDist(al.value)}${dir} de su sitio (valla de ${fmtDist(al.limit)}). Posición de las ${n?.pos ? hhmm.format(new Date(n.pos.t)) : "—"}.`;
    }
    if (al.kind === "trend") {
      const d = trendDec(al.metric, al.value);
      return `De ${fmtTrend(al.metric, al.from.v, d)} a las ${stamp(al.from.t)} a ${fmtTrend(al.metric, al.to.v, d)} a las ${stamp(al.to.t)}. Avisa si ${trendVerb(al.dir)} ${fmtLimit(al.metric, al.limit, true)} o más en ${hoursText(al.hours)}.`;
    }
    return `Ahora ${fmtWithUnit(al.metric, al.value)}.`;
  }
  function clearText(al, info) {
    if (al.kind === "link") return "Receptor conectado de nuevo";
    if (al.kind === "test") return "Alarma de prueba cerrada";
    const name = nodeName(al.num);
    if (al.kind === "offline") return `${name} · Vuelve a dar señal`;
    if (al.kind === "moved") return `${name} · De vuelta en su sitio${isNum(info.v) ? ` (a ${fmtDist(info.v)})` : ""}`;
    const m = metricMeta(al.metric);
    if (al.kind === "trend") return `${name} · ${m.label} ya no ${trendVerb(al.dir)} tan rápido${isNum(info.v) ? ` (${fmtWithUnit(al.metric, info.v)})` : ""}`;
    return `${name} · ${m.label} de vuelta en rango${isNum(info.v) ? ` (${fmtWithUnit(al.metric, info.v)})` : ""}`;
  }

  function addLog(type, text, num) {
    S.log.unshift({ t: Date.now(), type, text, num: num ?? null });
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
    pushDiag({ t: Date.now(), msg: `El reloj del receptor va ${dur(Math.abs(clock.min))} ${clock.min > 0 ? "atrasado" : "adelantado"}: las horas de las lecturas saldrán desplazadas. Se corrige dándole hora (GPS, o conectándolo un momento a la app de Meshtastic).` });
  }
  /** Receptor recién conectado: se vuelve a medir el desfase de su reloj. */
  function resetClock() { Object.assign(clock, { n: 0, min: Infinity, said: false }); }

  function askFailText(code, r) {
    switch (code) {
      case RE.NO_RESPONSE: return "el nodo contesta que no tiene ese sensor";
      case RE.MAX_RETRANSMIT: return "no llegó al nodo tras varios intentos";
      case RE.NO_ROUTE: case RE.GOT_NAK: return "no hay ruta hasta el nodo";
      case RE.NO_CHANNEL: return "el receptor no tiene el canal de ese nodo";
      case E_NO_PUBKEY: return "tu receptor no tiene la clave de este nodo, pide su ficha";
      case RE.PKI_UNKNOWN_PUBKEY: return "el nodo no tiene la clave de tu receptor, pedir su ficha se la envía";
      case RE.PKI_FAILED: return "fallo de cifrado con ese nodo, pedir su ficha suele arreglarlo";
      case RE.DUTY_CYCLE_LIMIT: return "el receptor ha agotado su tiempo de emisión, prueba en unos minutos";
      case E_RATE_LIMIT: return "límite de uso del canal alcanzado, prueba en unos minutos";
      case RE.TOO_LARGE: case RE.BAD_REQUEST: return "el nodo rechazó la petición";
      case "timeout":
        if (r?.acked && r.type === "info") return "el nodo la recibió y ya tiene la clave de tu receptor, pero no contestó: no repite su ficha a quien se la pidió en las últimas 12 h, ni si acaba de anunciarla";
        if (r?.acked && r.type === "pos") return "el nodo la recibió pero no contestó; como mucho repite su posición cada 3 min";
        if (r?.acked) return "el nodo la recibió pero no mandó datos";
        if (r?.type === "info") return `sin respuesta en ${ASK_TIMEOUT / 1000} s. Aunque no conteste, si le llegó ya tiene la clave de tu receptor: vuelve a pedirle los datos`;
        if (r?.type === "route") return `sin respuesta en ${Math.round(r.limit / 1000)} s: el nodo está fuera de alcance, apagado, más lejos que el límite de saltos de tu receptor${S.lora?.hopLimit ? ` (${S.lora.hopLimit})` : ""} o en otro canal; o la respuesta se perdió por el camino`;
        return `sin respuesta en ${ASK_TIMEOUT / 1000} s`;
      case "throttled": return "tu receptor solo lanza un traceroute cada 30 s; espera un poco y repite";
      case "notice": return `el receptor no la envió: ${r?.notice || "sin motivo"}`;
      case "send": return "no se pudo enviar al receptor";
      default: return `error ${RE[code] ?? code}`;
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
    if (isRoute && num === S.myNode) return toast("Es tu receptor: las rutas se trazan desde él.");
    const cool = isInfo || isPos ? INFO_COOLDOWN : ASK_COOLDOWN;
    const since = prev ? Date.now() - prev.t0 : Infinity;
    if (!isRoute && since < cool) return toast(`Espera ${Math.ceil((cool - since) / 1000)} s antes de repetir, para no saturar la malla.`);
    if (!canAsk()) return toast(isRoute ? "Conecta el receptor para trazar la ruta." : "Conecta el receptor para pedir datos.");
    if (isRoute) {
      const gap = Date.now() - S.traceAt;
      if (gap < TRACE_GAP) return toast(`Tu receptor solo lanza un traceroute cada 30 s, a cualquier nodo. Espera ${Math.ceil((TRACE_GAP - gap) / 1000)} s.`);
    }
    if (isInfo && !S.demo && !S.myUser) return toast("Espera a que el receptor termine de cargar sus datos.");
    if (isInfo) {
      // El firmware no contesta a la misma petición de ficha en 12 h, y cada petición nueva reinicia esa cuenta.
      const ago = Date.now() - (S.infoAsked[num] || 0);
      if (ago < INFO_SUPPRESS && infoArmed !== num) {
        infoArmed = num;
        setTimeout(() => { if (infoArmed === num) infoArmed = null; }, 6000);
        return toast(`Ya se la pediste ${ago < MIN ? "hace un momento" : `hace ${dur(ago)}`}. Los nodos no vuelven a contestar en 12 h y cada intento alarga la espera. Toca otra vez si aun así quieres pedirla.`);
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
    let msg;
    if (state !== "ok") msg = `${what}: ${askFailText(why, r)}`;
    else if (r.type === "info") msg = `${what}: recibida${r.gotKey ? ", clave guardada" : ", el nodo no tiene clave"}`;
    else if (r.type === "pos") msg = `${what}: ${r.noLoc ? "el nodo no comparte su ubicación en ese canal" : "recibida a petición"}`;
    else if (r.type === "route") msg = `${what}: ida ${r.trace ? legText(r.trace.fwd) : "?"}; vuelta ${r.trace?.back ? legText(r.trace.back) : "sin datos"}${lateOk ? " (tarde)" : ""}`;
    else msg = `${what}: datos recibidos a petición${lateOk ? " (tarde)" : ""}`;
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
    if (num === UNKNOWN_NODE) return "Nodo sin la clave del canal";
    if (num === S.myNode) return "Tu receptor";
    return S.nodes.get(num)?.long || hexId(num);
  }
  /** «directa» o «por R3 → DNN4». */
  function legText(leg) {
    const mid = relays(leg);
    return mid.length ? `por ${mid.map(hopName).join(" → ")}` : "directa";
  }

  /* ───────────── avisos por la malla ───────────── */
  const meshById = new Map(); // id del paquete → aviso directo en curso o reciente

  function setChannel(c) {
    const idx = c.index;
    S.channels = S.channels.filter((x) => x.index !== idx);
    if (c.role !== 0) {
      const primary = c.role === 1;
      S.channels.push({ index: idx, name: c.settings?.name || (primary ? "Principal" : `Canal ${idx}`), primary, ...channelPrivacy(c.settings?.psk) });
      S.channels.sort((a, b) => a.index - b.index);
    }
    if (!S.demo) save("channels"); // solo nombre e índice: las claves no se guardan
  }

  const meshCfg = () => (S.demo ? (S.demoMesh ||= MESH_DEFAULT()) : (S.settings.mesh ||= MESH_DEFAULT()));

  function meshText(kind, al, info) {
    const now = hhmm.format(new Date());
    if (kind === "test") return `✓ Vigía: mensaje de prueba de avisos · ${now}`;
    const name = nodeName(al.num);
    if (kind === "clear") {
      if (al.kind === "offline") return `✓ Vigía: ${name} vuelve a dar señal · ${now}`;
      if (al.kind === "moved") return `✓ Vigía: ${name} de vuelta en su sitio · ${now}`;
      if (al.kind === "trend") return `✓ Vigía: ${name} · ${metricMeta(al.metric).label} ya no ${trendVerb(al.dir)} tan rápido · ${now}`;
      return `✓ Vigía: ${name} · ${metricMeta(al.metric).label} de vuelta en rango${isNum(info?.v) ? ` (${fmtWithUnit(al.metric, info.v)})` : ""} · ${now}`;
    }
    const late = al.late ? " (con retraso)" : "";
    if (al.kind === "offline") return `⚠ Vigía: ${name} sin señal desde las ${hhmm.format(new Date(al.value))} · ${now}`;
    if (al.kind === "moved") {
      const n = S.nodes.get(al.num), f = S.cfg.watched[al.num]?.fence;
      const where = n?.pos ? ` · ${coordText(n.pos)}` : "";
      return `⚠ Vigía: ${name} fuera de su sitio, a ${fmtDist(al.value)}${n?.pos && f ? ` al ${compass(f, n.pos)}` : ""}${where} · ${now}${late}`;
    }
    if (al.kind === "trend") {
      const d = trendDec(al.metric, al.value), u = metricMeta(al.metric).unit;
      return `⚠ Vigía: ${name} · ${metricMeta(al.metric).label} ${al.dir === "down" ? "bajando" : "subiendo"} rápido: ${al.dir === "down" ? "−" : "+"}${fmtTrend(al.metric, al.value, d)} en ${dur(al.to.t - al.from.t)} (${fmtNum(al.from.v, d)}→${fmtNum(al.to.v, d)}${u ? ` ${u}` : ""}) · ${now}${late}`;
    }
    return `⚠ Vigía: ${name} · ${metricMeta(al.metric).label} ${fmtWithUnit(al.metric, al.value)} (${al.kind === "high" ? "máx" : "mín"} ${fmtLimit(al.metric, al.limit)}) · ${now}${late}`;
  }

  /** Destinos válidos ahora mismo. Un canal público nunca pasa, aunque se haya guardado antes. */
  function meshTargets(report = false) {
    const cfg = meshCfg();
    const out = [];
    if (cfg.channel != null) {
      const ch = S.channels.find((c) => c.index === cfg.channel);
      if (ch?.private) out.push({ type: "channel", index: ch.index, label: `canal «${ch.name}»` });
      else if (report) addLog("info", ch ? `Aviso por la malla bloqueado: el canal «${ch.name}» es público (${ch.why})` : "Aviso por la malla no enviado: el canal elegido ya no existe en el receptor");
    }
    if (cfg.node != null) {
      const n = S.nodes.get(cfg.node);
      if (!S.demo && !receptorUsesPki() && !S.channels.find((c) => c.index === (n?.channel || 0))?.private) {
        if (report) addLog("info", `Aviso a ${nodeName(cfg.node)} bloqueado: sin cifrado por clave, iría por un canal público`);
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
    if (!targets.length) { if (kind === "test") toast("Elige un canal privado o un nodo."); return; }
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
          addLog("info", `Avisos por la malla en pausa: ya van ${MESH_HOURLY} en la última hora (${n} sin enviar)`);
          break;
        }
        const it = meshQ.shift();
        if (Date.now() - it.t > MESH_MAX_AGE) { addLog("info", `Aviso por la malla a ${it.tg.label} descartado: tenía más de 30 min`); continue; }
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
    const rec = { tg, text, tq: it.t, t: Date.now(), result: "enviando…", ok: null, st: newDelivery(), timer: null };
    S.meshLast = rec;
    patchMeshLast();
    if (S.demo) {
      await new Promise((r) => setTimeout(r, 1200));
      if (tg.type === "node") { meshDelivery(rec, { type: "ack", from: S.myNode, err: 0 }); await new Promise((r) => setTimeout(r, 1800)); meshDelivery(rec, { type: "ack", from: tg.num, err: 0 }); }
      else meshDone(rec, "repetido por la malla", true);
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
      else meshDone(rec, "repetido por la malla", true);
    } catch (e) {
      const code = e && typeof e === "object" && "error" in e ? e.error : "send";
      if (tg.type === "node") {
        if (code === RE.TIMEOUT) return; // la librería se rinde a los 60 s; manda nuestra espera
        meshDelivery(rec, { type: "ack", from: null, err: code });
        return;
      }
      meshDone(rec, code === RE.TIMEOUT ? "sin confirmación" : code === RE.MAX_RETRANSMIT ? "nadie lo repitió (¿hay nodos al alcance?)" : askFailText(code), false);
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
      rec.result = `en camino: un vecino lo ha repetido; esperando a que ${name} confirme…`;
      rec.ok = null;
      return patchMeshLast();
    }
    clearTimeout(rec.timer);
    if (st.phase === "delivered") return meshDone(rec, st.late ? `entregado, aunque la confirmación llegó tarde (${secs})` : `entregado (${secs})`, true);
    if (st.phase === "unconfirmed") {
      return meshDone(rec, st.relayed
        ? `sin confirmar: salió a la malla (un vecino lo repitió), pero ${name} no ha confirmado que le llegara en ${MESH_CONFIRM / 1000} s`
        : `sin confirmar: ni un vecino lo repitió ni ${name} contestó en ${MESH_CONFIRM / 1000} s`, false);
    }
    const why = st.code === RE.MAX_RETRANSMIT ? "no llegó tras varios intentos" : askFailText(st.code);
    meshDone(rec, `no entregado: ${why}`, false);
  }

  function meshDone(rec, result, ok) {
    const late = rec.t - rec.tq > 2 * MIN ? " (salió con retraso)" : "";
    rec.result = result + late;
    rec.ok = ok;
    rec.tDone = Date.now();
    addLog("info", `Aviso por la malla a ${rec.tg.label}: ${rec.result}`);
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
      if (msg) pushDiag({ t: Date.now(), msg: `Aviso del receptor: ${msg}` });
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
    ingest, evalThreshold, evalNode, linkKnown, trendSeries, trendNow, evalTrend, evalFence, setPosition,
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
