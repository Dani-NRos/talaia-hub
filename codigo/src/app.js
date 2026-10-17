import { METRICS, extractMetrics, metricMeta, sortMetrics, fmtValue, fmtWithUnit, fmtNum, fmtLimit } from "./metrics.js";
import { createIdbStore, createMemStore } from "./store.js";
import { createMapView } from "./map.js";
import { Receptor } from "./receptor.js";
import { buildDemo, DEMO_IDS } from "./demo.js";
import { Protobuf } from "@meshtastic/core";
import { encodeUser, routingErrorReason } from "./pb.js";
import { distM, compass, precisionM, fmtDist, coordText, mapsUrl, SOURCE, nextPlace, placeFromPos } from "./geo.js";
import { trendCheck, trendDefault, parseTrendRule } from "./trend.js";

/* ───────────── utilidades ───────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const APP_VERSION = "1.9.0";
const REPO_URL = "https://github.com/Dani-NRos/vigia-mesh";
const ISSUES_URL = `${REPO_URL}/issues`;
const validT = (t) => isNum(t) && t > 1.6e12 && t < Date.now() + 5 * MIN;

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nada */ } },
};

const hhmm = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit" });
const dShort = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });
const wday = new Intl.DateTimeFormat("es-ES", { weekday: "short" });

function dur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 día" : `${d} días`;
}
function ago(t) {
  if (!t) return "nunca";
  const ms = Date.now() - t;
  if (ms < 60000) return "ahora mismo";
  return `hace ${dur(ms)}`;
}
function stamp(t) {
  const d = new Date(t), today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? hhmm.format(d) : `${dShort.format(d)} ${hhmm.format(d)}`;
}
function parseNum(s) {
  const x = String(s ?? "").trim().replace(",", ".");
  if (x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

/* ───────────── estado ───────────── */
const DEFAULT_SETTINGS = { sound: true, wake: false, retentionDays: 30, defaultOfflineMin: 75, mesh: null };
const MESH_DEFAULT = () => ({ enabled: false, channel: null, node: null, onClear: false });
const S = {
  demo: false,
  demoTimer: null,
  store: null,
  cfg: { watched: {} },
  settings: { ...DEFAULT_SETTINGS },
  nodes: new Map(),
  myNode: null,
  trouble: null, // último fallo de conexión clasificado
  otherWindow: null, // "busy" | "lost" si otra ventana de Vigía tiene el receptor
  diag: [],
  channels: [], // canales del receptor: { index, name, primary, private, why } (sin claves)
  demoMesh: null,
  meshLast: null,
  link: { state: "idle", extra: null },
  device: null,
  active: new Map(),
  log: [],
  recent: new Map(),
  seen: new Set(),
  meshExpanded: false,
  logExpanded: false,
  detail: null, // { num, range }
  req: new Map(), // peticiones a nodos en curso o recientes, por nodo|tipo
  myUser: null, // ficha de nuestro receptor, se manda al pedir la de otro nodo
  infoAsked: {}, // última vez que se pidió la ficha a cada nodo: los nodos no contestan otra vez en 12 h
  demoData: null,
  demoToken: 0,
};
let receptor = null;
let swReg = null;
let mapView = null; // se crea al abrir el mapa por primera vez

/* ───────────── persistencia (solo modo real) ───────────── */
function saveCfg() { if (!S.demo) LS.set("vigia.cfg", S.cfg); }
function saveSettings() { LS.set("vigia.settings", S.settings); }
let nodesTimer = null;
function saveNodes() {
  if (S.demo) return;
  clearTimeout(nodesTimer);
  nodesTimer = setTimeout(() => LS.set("vigia.nodes", [...S.nodes.values()]), 1500);
}
function saveLog() { if (!S.demo) LS.set("vigia.log", S.log.slice(0, 200)); }
function saveActive() { if (!S.demo) LS.set("vigia.active", [...S.active.values()]); }

function loadReal() {
  S.cfg = LS.get("vigia.cfg", { watched: {} });
  if (!S.cfg.watched) S.cfg.watched = {};
  S.nodes = new Map((LS.get("vigia.nodes", []) || []).map((n) => [n.num, n]));
  S.log = LS.get("vigia.log", []);
  S.active = new Map((LS.get("vigia.active", []) || []).map((a) => [a.key, a]));
  S.myNode = LS.get("vigia.my", null);
  S.store = createIdbStore();
  S.channels = LS.get("vigia.channels", []) || [];
  S.infoAsked = LS.get("vigia.infoAsk", {}) || {};
  S.recent = new Map();
}

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
const hexId = (num) => `!${(num >>> 0).toString(16).padStart(8, "0")}`;
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
function seriesKey(num, metric) { return `${num}|${metric}`; }

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
  touch(num, t);
  saveNodes();
  if (S.detail && S.detail.num === num) refreshDetailLive();
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
const trendKey = (num, k) => `${num}|${k}|trend`;
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
/** Decimales para un cambio: los pequeños llevan uno más (3,4 hPa, no 3 hPa). */
const trendDec = (k, change) => Math.max(metricMeta(k).dec, Math.abs(change) < 10 ? 1 : 0);
function fmtTrend(k, v, dec) {
  const u = metricMeta(k).unit;
  return u ? `${fmtNum(v, dec)} ${u}` : fmtNum(v, dec);
}
const trendVerb = (dir) => (dir === "down" ? "baja" : "sube");
/** «30 min», «1,5 h», «3 h». */
const hoursText = (h) => (h < 1 ? `${Math.round(h * 60)} min` : `${fmtNum(h, h % 1 ? 1 : 0)} h`);
/** «en las últimas 3 horas», «en la última hora», «en los últimos 30 min». */
function lastWindow(h) {
  if (h < 1) return `en los últimos ${Math.round(h * 60)} min`;
  if (h === 1) return "en la última hora";
  return `en las últimas ${fmtNum(h, h % 1 ? 1 : 0)} horas`;
}
/** «ha bajado 1,2 hPa en las últimas 3 horas» con los datos de ahora, para la ficha. */
function trendNowText(num, k, rule) {
  const r = trendNow(num, k, rule);
  if (!r) return `Ahora: aún no hay lecturas de hace ${hoursText(rule.hours / 2)} o más para comparar.`;
  if (r.change <= 0) return `Ahora: no ${rule.dir === "down" ? "ha bajado" : "ha subido"} ${lastWindow(rule.hours)}.`;
  return `Ahora: ${rule.dir === "down" ? "ha bajado" : "ha subido"} ${fmtTrend(k, r.change, trendDec(k, r.change))} ${lastWindow(rule.hours)}.`;
}
/** Para la tarjeta: «↓3/3 h». */
const trendShort = (k, rule) => `${rule.dir === "down" ? "↓" : "↑"}${fmtLimit(k, rule.delta)}/${hoursText(rule.hours)}`;

/* ───────────── valla antirrobo ───────────── */
// Salta cuando dos posiciones nuevas seguidas caen fuera del radio; se cierra al volver con un 20 % de margen.
const FENCE_CONFIRM = 2, FENCE_CLEAR = 0.8;
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
  if (al.kind === "link") return "Reintentando la conexión Bluetooth. Las alarmas de nodo sin señal quedan en pausa.";
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
// Telemetría: cada tipo es un campo del mensaje Telemetry; se pide mandando ese campo vacío con want_response.
const ASK = {
  env:    { label: "Ambiente", what: "Temperatura, humedad y presión", field: 3, variant: "environmentMetrics" },
  device: { label: "Batería",  what: "Batería, tensión y uso del canal", field: 2, variant: "deviceMetrics" },
  air:    { label: "Aire",     what: "CO₂ y partículas", field: 4, variant: "airQualityMetrics" },
  power:  { label: "Energía",  what: "Tensión y corriente de los canales INA", field: 5, variant: "powerMetrics" },
};
// Ficha del nodo (NodeInfo): nombre y clave pública. Sin la clave, el receptor no le manda peticiones.
const ASK_ALL = { ...ASK, info: { label: "Ficha" }, pos: { label: "Posición" } };
const ASK_BY_VARIANT = Object.fromEntries(Object.entries(ASK).map(([k, a]) => [a.variant, k]));
const ASK_TIMEOUT = 60000, ASK_COOLDOWN = 30000, INFO_COOLDOWN = 60000, ASK_SHOW = 10 * MIN;
const RE = Protobuf.Mesh.Routing_Error;
// Códigos que la librería incluida aún no nombra (firmware 2.7+).
const E_RATE_LIMIT = 38, E_NO_PUBKEY = 39;
const KEY_ERRORS = new Set([RE.PKI_FAILED, RE.PKI_UNKNOWN_PUBKEY, E_NO_PUBKEY]);
const askKey = (num, type) => `${num}|${type}`;
const canAsk = () => S.demo || (S.link.state === "ready" && !!receptor?.mesh);
const askVisible = (r) => r && (r.state === "wait" || Date.now() - r.tDone < ASK_SHOW);
// Quién confirmó cada paquete nuestro (requestId → nodo), para saber si el acuse vino del destino.
const ackFrom = new Map();
const askById = new Map(); // id del paquete de cada petición → la petición, para casar acuses y errores tardíos
const INFO_SUPPRESS = 12 * HOUR;
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
      return `sin respuesta en ${ASK_TIMEOUT / 1000} s`;
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
  const isInfo = type === "info", isPos = type === "pos";
  const k = askKey(num, type);
  const prev = S.req.get(k);
  if (prev?.state === "wait") return;
  const cool = isInfo || isPos ? INFO_COOLDOWN : ASK_COOLDOWN;
  const since = prev ? Date.now() - prev.t0 : Infinity;
  if (since < cool) return toast(`Espera ${Math.ceil((cool - since) / 1000)} s antes de repetir, para no saturar la malla.`);
  if (!canAsk()) return toast("Conecta el receptor para pedir datos.");
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
    if (!S.demo) LS.set("vigia.infoAsk", Object.fromEntries(Object.entries(S.infoAsked).filter(([, t]) => Date.now() - t < INFO_SUPPRESS)));
  }
  const r = { num, type, state: "wait", t0: Date.now(), tDone: 0, why: null, timer: null, acked: false };
  S.req.set(k, r);
  r.timer = setTimeout(() => finishAsk(r, "fail", "timeout"), ASK_TIMEOUT);
  refreshAsk(num);
  refreshPos(num);
  if (S.demo) return demoAsk(r);
  try {
    const ch = S.nodes.get(num)?.channel || 0;
    const sent = isInfo ? receptor.requestNodeInfo(num, encodeUser(S.myUser), ch)
      : isPos ? receptor.requestPosition(num, ch)
      : receptor.requestTelemetry(num, ASK[type].field, ch);
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

function askChips(num) {
  const ok = canAsk();
  return Object.entries(ASK).map(([type, a]) => {
    const r = S.req.get(askKey(num, type));
    const st = askVisible(r) && !staleKeyFail(r) ? r.state : "";
    return `<button type="button" class="ask-b${st ? ` is-${st}` : ""}" data-ask="${type}" data-num="${num}" title="${esc(a.what)}"${!ok || st === "wait" ? " disabled" : ""}>${a.label}</button>`;
  }).join("");
}
function askStatus(num, types = Object.keys(ASK_ALL).filter((t) => t !== "pos")) {
  return types.map((type) => S.req.get(askKey(num, type))).filter((r) => askVisible(r) && !staleKeyFail(r)).sort((a, b) => b.t0 - a.t0).map((r) => {
    const l = ASK_ALL[r.type].label;
    const secs = Math.round((Date.now() - r.t0) / 1000);
    if (r.state === "wait") return `<span class="s-wait">${l}: ${r.acked ? "la petición llegó, esperando respuesta" : "esperando respuesta"}… ${secs} s</span>`;
    if (r.state === "ok" && r.type === "pos") return `<span class="s-ok">${l}: ${r.noLoc ? "el nodo no comparte su ubicación en este canal" : `recibida a las ${hhmm.format(new Date(r.tDone))}`}</span>`;
    if (r.state === "ok" && r.type === "info") return `<span class="s-ok">${l}: recibida a las ${hhmm.format(new Date(r.tDone))}${r.gotKey ? ", clave guardada" : ", pero ese nodo no tiene clave (firmware anterior a 2.5)"}</span>`;
    if (r.state === "ok") return `<span class="s-ok">${l}: recibido a las ${hhmm.format(new Date(r.tDone))}, tardó ${Math.max(1, Math.round((r.tDone - r.t0) / 1000))} s</span>`;
    return `<span class="s-fail">${l}: ${esc(askFailText(r.why, r))}</span>`;
  }).join("");
}
function keyRow(num, sheet) {
  if (num === S.myNode && !S.demo) return "";
  const need = keyNeeded(num);
  if (!sheet && !need) return "";
  const n = S.nodes.get(num);
  const r = S.req.get(askKey(num, "info"));
  const waiting = r?.state === "wait";
  const theyLack = Object.keys(ASK).some((t) => { const q = S.req.get(askKey(num, t)); return askVisible(q) && q.state === "fail" && q.why === RE.PKI_UNKNOWN_PUBKEY && !staleKeyFail(q); });
  const txt = need && theyLack ? "Este nodo no tiene la clave de tu receptor y no puede leer tus peticiones. Pedir su ficha se la envía, aunque no conteste."
    : need ? "Tu receptor no tiene la clave de este nodo y no le puede pedir datos."
    : n?.key ? "Tu receptor tiene la clave de este nodo."
    : "La ficha trae el nombre y la clave del nodo.";
  return `<div class="key-row${need ? " need" : ""}"><span>${txt}</span><button type="button" class="btn ghost sm" data-ask="info" data-num="${num}"${!canAsk() || waiting ? " disabled" : ""}>${waiting ? "Pidiendo ficha…" : "Pedir ficha del nodo"}</button></div>`;
}
function askBlock(num, sheet = false) {
  return `<span class="ask-l">Pedir datos ahora</span><div class="ask-row">${askChips(num)}</div>${keyRow(num, sheet)}<p class="ask-st" data-ask-st="${num}">${askStatus(num)}</p>`;
}
function refreshAsk(num) {
  for (const el of $$(`[data-ask-box="${num}"]`)) el.innerHTML = askBlock(num, el.dataset.sheet === "1");
}
function patchAskStatus(num) {
  for (const el of $$(`[data-ask-st="${num}"]`)) el.innerHTML = askStatus(num);
  for (const el of $$(`[data-pos-st="${num}"]`)) el.innerHTML = askStatus(num, ["pos"]);
}

/* ───────────── bloque de ubicación ───────────── */
function fenceLine(num) {
  const w = S.cfg.watched[num], n = S.nodes.get(num);
  if (!w?.fence || !n?.pos) return "";
  const d = distM(w.fence, n.pos);
  const r = `valla de ${fmtDist(w.fence.r)}`;
  if (S.active.has(`${num}||moved`)) return `<p class="fence bad">Fuera de su sitio: a ${fmtDist(d)} al ${compass(w.fence, n.pos)} · ${r}</p>`;
  if (d > w.fence.r) return `<p class="fence warn">Posible movimiento: a ${fmtDist(d)} al ${compass(w.fence, n.pos)}. Esperando otra posición para confirmar · ${r}</p>`;
  return `<p class="fence ok">En su sitio${d >= 1 ? ` · a ${fmtDist(d)}` : ""} · ${r}</p>`;
}
function posMeta(p) {
  const pm = precisionM(p.bits);
  return [pm ? `±${fmtDist(pm)}` : p.bits >= 32 ? "precisión completa" : "", ago(p.t)].filter(Boolean).join(" · ");
}
function posBlock(num, sheet = false) {
  const n = S.nodes.get(num), p = n?.pos;
  const w = S.cfg.watched[num];
  const r = S.req.get(askKey(num, "pos"));
  const waiting = r?.state === "wait";
  const askBtn = `<button type="button" class="mini" data-ask="pos" data-num="${num}"${!canAsk() || waiting ? " disabled" : ""}>${waiting ? "Pidiendo…" : "Pedir posición"}</button>`;
  let h = `<div class="pos-top"><span class="pos-l">Ubicación</span>${p ? `<span class="pos-m">${esc(posMeta(p))}</span>` : ""}</div>`;
  if (p) {
    const c = coordText(p);
    h += `<code class="pos-c">${c}</code><div class="pos-row"><button type="button" class="mini" data-copy="${c}">Copiar</button><button type="button" class="mini" data-map-focus="${num}">Ver en el mapa</button><a class="mini" href="${mapsUrl(p)}" target="_blank" rel="noopener" title="Abre Google Maps; necesita internet">Google Maps</a>${sheet ? askBtn : ""}</div>`;
  } else {
    h += `<div class="pos-row"><span class="hint">Este nodo aún no ha compartido su ubicación.</span>${askBtn}</div>`;
  }
  h += `<p class="ask-st" data-pos-st="${num}">${askStatus(num, ["pos"])}</p>`;
  if (!sheet) return h + fenceLine(num);
  if (p) {
    const facts = [SOURCE[p.src] ? `Origen: ${SOURCE[p.src]}` : "", isNum(p.alt) ? `Altitud ${fmtNum(p.alt, 0)} m` : "", `Posición de las ${stamp(p.t)}`].filter(Boolean);
    h += `<p class="hint">${esc(facts.join(" · "))}</p>`;
  }
  if (!w) return h;
  // valla antirrobo (solo nodos vigilados)
  const f = w.fence;
  const pm = p ? precisionM(p.bits) : null;
  const rVal = f ? f.r : Math.max(200, pm ? Math.ceil((pm * 2) / 50) * 50 : 0);
  h += `<div class="fence-box"><h4>Valla antirrobo</h4>`;
  h += f ? fenceLine(num) + `<p class="hint">Su sitio: ${coordText(f)}, fijado ${esc(stamp(f.at))}.</p>`
    : `<p class="hint">Fija su sitio y un radio. Si dos posiciones seguidas caen fuera, salta la alarma.</p>`;
  h += `<div class="off-row"><label for="fence-r">Radio</label><span class="inp-u"><input id="fence-r" class="inp" inputmode="numeric" autocomplete="off" value="${rVal}"><span>m</span></span></div>`;
  h += `<div class="btns"><button type="button" class="btn ${f ? "ghost" : "primary"} sm" data-fence-set="${num}"${p ? "" : " disabled"}>${f ? "Mover su sitio a la posición actual" : "Fijar su sitio en la posición actual"}</button>${f ? `<button type="button" class="btn danger-ghost sm" data-fence-del="${num}">Quitar valla</button>` : ""}</div>`;
  if (p?.src === 1) h += `<p class="warn-t">Este nodo tiene la posición fijada a mano: si se lo llevan seguirá mandando las mismas coordenadas. Para él, la alarma útil es la de «sin señal».</p>`;
  if (pm && pm > (f ? f.r : rVal) / 2) h += `<p class="warn-t">Este nodo comparte su posición con ±${fmtDist(pm)} de precisión: no se notan movimientos menores. Para afinar, que la comparta en un canal privado con precisión completa.</p>`;
  return h + `</div>`;
}
function refreshPos(num) {
  for (const el of $$(`[data-pos-box="${num}"]`)) {
    if (el.contains(document.activeElement) && document.activeElement.matches("input")) continue; // no pisar lo que se escribe
    el.innerHTML = posBlock(num, el.dataset.sheet === "1");
  }
}

function setFence(num) {
  const w = S.cfg.watched[num], n = S.nodes.get(num);
  if (!w || !n?.pos) return;
  const r = parseNum($("#fence-r")?.value);
  if (!r || Number.isNaN(r) || r < 20) return toast("Pon un radio de 20 m o más.");
  w.fence = { lat: n.pos.lat, lon: n.pos.lon, r: Math.round(r), at: Date.now() };
  n.fenceOut = 0;
  saveCfg();
  clearAlarm(`${num}||moved`, { silent: true });
  addLog("info", `${nodeName(num)} · Valla de ${fmtDist(w.fence.r)} fijada en ${coordText(w.fence)}`, num);
  refreshPos(num);
  render();
  toast("Valla fijada en su posición actual");
}
function setFenceRadius(num, input) {
  const w = S.cfg.watched[num];
  if (!w?.fence) return;
  const r = parseNum(input.value);
  if (!r || Number.isNaN(r) || r < 20) { input.value = w.fence.r; return toast("Pon un radio de 20 m o más."); }
  w.fence.r = Math.round(r);
  saveCfg();
  evalFence(num, { force: true });
  input.blur();
  refreshPos(num);
  render();
  toast(`Radio de la valla: ${fmtDist(w.fence.r)}`);
}
function delFence(num) {
  const w = S.cfg.watched[num];
  if (!w?.fence) return;
  delete w.fence;
  saveCfg();
  clearAlarm(`${num}||moved`, { silent: true });
  addLog("info", `${nodeName(num)} · Valla quitada`, num);
  refreshPos(num);
  render();
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Respaldo: seleccionar el texto para copiarlo a mano o con execCommand.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0;left:0;top:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* sin portapapeles */ }
    ta.remove();
    if (!ok) return toast(`No se pudo copiar. Coordenadas: ${text}`);
  }
  if (btn) { btn.textContent = "Copiado"; setTimeout(() => { if (btn.isConnected) btn.textContent = "Copiar"; }, 1600); }
  toast("Coordenadas copiadas");
}
// Solo se reescribe el texto de estado cada segundo, para no robar toques a los botones.
setInterval(() => {
  const waiting = new Set([...S.req.values()].filter((r) => r.state === "wait").map((r) => r.num));
  for (const num of waiting) patchAskStatus(num);
}, 1000);

function resetAsks() {
  for (const r of S.req.values()) clearTimeout(r.timer);
  S.req = new Map();
}

/* ───────────── avisos por la malla ───────────── */
// Clave por defecto de Meshtastic (canales públicos) y la del canal de eventos, según Channels.h del firmware.
const DEFAULT_PSK = [0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59, 0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01];
const EVENT_PSK = [0x38, 0x4b, 0xbc, 0xc0, 0x1d, 0xc0, 0x22, 0xd1, 0x81, 0xbf, 0x36, 0xb8, 0x61, 0x21, 0xe1, 0xfb,
  0x96, 0xb7, 0x2e, 0x55, 0xbf, 0x74, 0x22, 0x7e, 0x9d, 0x6a, 0xfb, 0x48, 0xd6, 0x4c, 0xb1, 0xa1];
const MESH_GAP = 8000, MESH_HOURLY = 20, MESH_MAX_AGE = 30 * MIN;

/** ¿Lo puede leer cualquiera? Sin cifrar, clave por defecto (o su atajo de 1 byte), clave corta o canal de eventos. */
function channelPrivacy(psk) {
  const k = psk ? [...psk] : [];
  if (k.length === 0) return { private: false, why: "sin cifrar" };
  if (k.length === 1) return { private: false, why: k[0] === 0 ? "sin cifrar" : "clave pública por defecto" };
  if (k.length < 16) return { private: false, why: "clave demasiado corta" };
  if (k.length === 16 && k.slice(0, 15).every((b, i) => b === DEFAULT_PSK[i])) return { private: false, why: "clave pública por defecto" };
  if (k.length === 32 && k.every((b, i) => b === EVENT_PSK[i])) return { private: false, why: "clave pública de eventos" };
  return { private: true, why: "" };
}
function setChannel(c) {
  const idx = c.index;
  S.channels = S.channels.filter((x) => x.index !== idx);
  if (c.role !== 0) {
    const primary = c.role === 1;
    S.channels.push({ index: idx, name: c.settings?.name || (primary ? "Principal" : `Canal ${idx}`), primary, ...channelPrivacy(c.settings?.psk) });
    S.channels.sort((a, b) => a.index - b.index);
  }
  if (!S.demo) LS.set("vigia.channels", S.channels); // solo nombre e índice: las claves no se guardan
}

const meshCfg = () => (S.demo ? (S.demoMesh ||= MESH_DEFAULT()) : (S.settings.mesh ||= MESH_DEFAULT()));
function saveMeshCfg() { if (!S.demo) saveSettings(); }

const te8 = new TextEncoder();
/** Recorta a 200 bytes (el límite práctico de un texto Meshtastic); las tildes ocupan 2. */
function fitBytes(str, max = 200) {
  if (te8.encode(str).length <= max) return str;
  let s2 = str;
  while (s2 && te8.encode(s2 + "…").length > max) s2 = s2.slice(0, -1);
  return s2 + "…";
}
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
      if (!S.demo && !(S.link.state === "ready" && receptor?.mesh)) break; // se reanuda al volver el receptor
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
  S.meshLast = { t: Date.now(), label: tg.label, result: "enviando…", text };
  patchMeshLast();
  let result, ok = false;
  if (S.demo) {
    await new Promise((r) => setTimeout(r, 1200));
    result = tg.type === "node" ? "entregado" : "repetido por la malla";
    ok = true;
  } else {
    try {
      const dest = tg.type === "node" ? tg.num : "broadcast";
      const ch = tg.type === "node" ? S.nodes.get(tg.num)?.channel || 0 : tg.index;
      const id = await receptor.sendText(dest, ch, text);
      ok = true;
      result = tg.type === "node" ? (ackFrom.get(id) === tg.num ? "entregado" : "salió a la malla") : "repetido por la malla";
    } catch (e) {
      const code = e && typeof e === "object" && "error" in e ? e.error : "send";
      result = code === RE.TIMEOUT ? "sin confirmación"
        : code === RE.MAX_RETRANSMIT ? (tg.type === "node" ? "no llegó tras varios intentos" : "nadie lo repitió (¿hay nodos al alcance?)")
        : askFailText(code);
    }
  }
  const late = Date.now() - it.t > 2 * MIN ? " (con retraso)" : "";
  S.meshLast = { t: Date.now(), label: tg.label, result: result + late, text, ok };
  addLog("info", `Aviso por la malla a ${tg.label}: ${result}${late}`);
  patchMeshLast();
  renderLog();
}
function meshLastHTML() {
  const l = S.meshLast;
  if (!l) return "Todavía no se ha enviado ningún aviso.";
  return `Último: «${esc(l.text)}» → ${esc(l.label)}: <strong class="${l.ok ? "okt" : l.result === "enviando…" ? "" : "warn-t"}">${esc(l.result)}</strong> · ${esc(stamp(l.t))}`;
}
function patchMeshLast() { const el = $("#meshLast"); if (el) el.innerHTML = meshLastHTML(); }

function meshSection() {
  const cfg = meshCfg();
  const chs = S.channels;
  const chOpts = [`<option value=""${cfg.channel == null ? " selected" : ""}>Ninguno</option>`]
    .concat(chs.map((c) => `<option value="${c.index}"${c.private ? "" : " disabled"}${cfg.channel === c.index ? " selected" : ""}>${c.index} · ${esc(c.name)}${c.private ? "" : " — público"}</option>`)).join("");
  const nodes = [...S.nodes.values()].filter((n) => n.num !== S.myNode).sort((a, b) => (a.long || "").localeCompare(b.long || "", "es"));
  const pki = receptorUsesPki();
  const nodeOpts = [`<option value=""${cfg.node == null ? " selected" : ""}>Ninguno</option>`]
    .concat(nodes.map((n) => `<option value="${n.num}"${cfg.node === n.num ? " selected" : ""}>${esc(n.long)} (${esc(n.short)})${pki && n.key === false ? " — sin clave" : ""}</option>`)).join("");
  let chHint = "";
  if (!chs.length) chHint = `<p class="hint">Conecta el receptor para ver sus canales.</p>`;
  const pub = chs.filter((c) => !c.private);
  if (chs.length && pub.length) chHint = `<p class="hint">Bloqueados por públicos: ${pub.map((c) => `${esc(c.name)} (${esc(c.why)})`).join(", ")}.</p>`;
  if (chs.length && !chs.some((c) => c.private)) chHint += `<p class="warn-t">Tu receptor no tiene ningún canal privado. Crea uno en la app de Meshtastic con una clave aleatoria y compártelo (con su código QR) con quien deba recibir los avisos.</p>`;
  const sel = cfg.channel != null ? chs.find((c) => c.index === cfg.channel) : null;
  if (sel && !sel.private) chHint += `<p class="warn-t">El canal guardado («${esc(sel.name)}») es público y no se usará.</p>`;
  const nsel = cfg.node != null ? S.nodes.get(cfg.node) : null;
  const nodeHint = nsel && pki && nsel.key === false
    ? `<p class="warn-t">Tu receptor no tiene la clave de ${esc(nsel.long)}: pide su ficha en su tarjeta o el aviso no saldrá (error 39).</p>` : "";
  return `<section class="blk" id="meshBox"><h3>Avisos por la malla</h3>
      <div class="set-row"><label class="sw" for="meshOn"><input type="checkbox" id="meshOn" ${cfg.enabled ? "checked" : ""}><span class="sw-ui"></span><span>Mandar las alarmas por la malla</span></label></div>
      <div class="set-row"><label for="meshCh">A un canal privado</label><select id="meshCh" class="inp sel">${chOpts}</select></div>
      ${chHint}
      <div class="set-row"><label for="meshNode">A un nodo</label><select id="meshNode" class="inp sel">${nodeOpts}</select></div>
      ${nodeHint}
      <div class="set-row"><label class="sw" for="meshClear"><input type="checkbox" id="meshClear" ${cfg.onClear ? "checked" : ""}><span class="sw-ui"></span><span>Avisar también cuando se resuelve</span></label></div>
      <div class="btns"><button class="btn ghost" data-mesh-test>Enviar mensaje de prueba</button></div>
      <p class="hint" id="meshLast">${meshLastHTML()}</p>
      <p class="hint">Sale un mensaje al saltar cada alarma de umbral, sin señal o fuera de su sitio: en un canal lo leen todos los que lo tengan; a un nodo, solo él, y confirma la entrega. Como mucho uno cada 8 s y ${MESH_HOURLY} por hora, para no saturar la malla. Solo con Vigía abierta y el receptor conectado. Los canales públicos están bloqueados porque lo leería cualquiera.</p>
    </section>`;
}

/* ───────────── avisos: sonido, vibración, notificación ───────────── */
let actx = null;
function unlockAudio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
  } catch { /* sin audio */ }
}
document.addEventListener("pointerdown", unlockAudio, { capture: true });
document.addEventListener("keydown", unlockAudio, { capture: true });

function beep() {
  if (!actx || actx.state !== "running") return;
  const t0 = actx.currentTime;
  [[880, 0], [660, 0.2], [880, 0.4]].forEach(([f, d]) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "square";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + d);
    g.gain.exponentialRampToValueAtTime(0.16, t0 + d + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.17);
    o.connect(g).connect(actx.destination);
    o.start(t0 + d);
    o.stop(t0 + d + 0.18);
  });
}
const unacked = () => [...S.active.values()].filter((a) => !a.acked);
setInterval(() => { if (S.settings.sound && unacked().length) beep(); }, 2500);

function fireAlarm(al) {
  try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.([300, 150, 300, 150, 700]); } catch { /* sin vibración */ }
  if (S.settings.sound) beep();
  notify(al);
}

async function notify(al) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = alarmTitle(al), body = alarmDetail(al);
  try {
    const reg = swReg || (navigator.serviceWorker && (await navigator.serviceWorker.getRegistration()));
    if (reg) { await reg.showNotification(title, { body, tag: al.key, renotify: true, requireInteraction: true, icon: "./icon-192.png", badge: "./icon-192.png" }); return; }
  } catch { /* sigue */ }
  try { new Notification(title, { body, tag: al.key }); } catch { /* Android exige service worker */ }
}

/* ───────────── pantalla encendida ───────────── */
let wake = null;
async function applyWake() {
  if (!S.settings.wake) {
    try { await wake?.release(); } catch { /* ya liberado */ }
    wake = null;
    renderFoot();
    return;
  }
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || wake) return;
  try {
    wake = await navigator.wakeLock.request("screen");
    wake.addEventListener("release", () => { wake = null; renderFoot(); });
  } catch {
    toast("Este navegador no deja mantener la pantalla encendida.");
  }
  renderFoot();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    applyWake();
    // Con la página congelada no corrían los temporizadores de reintento: se reintenta ya.
    if (receptor && S.link.state === "reconnecting" && S.link.extra?.at) receptor.retryNow();
    evalOffline();
    render();
  }
});

/* ───────────── gráficas ───────────── */
function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}
function gapOf(series) {
  if (series.length < 3) return 3 * HOUR;
  const d = [];
  for (let i = 1; i < series.length; i++) d.push(series[i].t - series[i - 1].t);
  d.sort((a, b) => a - b);
  return Math.max(3 * d[Math.floor(d.length / 2)], 20 * MIN);
}
function segmentsOf(series, gap) {
  const segs = [];
  let cur = [];
  for (const p of series) {
    if (cur.length && p.t - cur[cur.length - 1].t > gap) { segs.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
  return segs;
}
function yDomain(series, metric, rule) {
  const vals = series.map((p) => p.v).filter((v) => !(metric === "batteryLevel" && v > 100));
  const lims = [rule?.min, rule?.max].filter(isNum);
  if (!vals.length) return null;
  let lo = Math.min(...vals, ...lims), hi = Math.max(...vals, ...lims);
  const minSpan = Math.max(5 * 10 ** -metricMeta(metric).dec, Math.abs(hi) * 0.02, 1);
  if (hi - lo < minSpan) { const c = (hi + lo) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
  const pad = (hi - lo) * 0.14;
  return [lo - pad, hi + pad];
}

/** Gráfica completa con ejes, en píxeles reales. */
function chartSVG(series, metric, rule, from, to, W) {
  const H = 132, pl = 42, pr = 12, pt = 10, pb = 22;
  const ser = series.filter((p) => !(metric === "batteryLevel" && p.v > 100));
  const dom = yDomain(ser, metric, rule);
  if (!dom) return `<p class="empty-chart">Sin lecturas en este periodo.</p>`;
  const [lo, hi] = dom;
  const x = (t) => pl + ((t - from) / (to - from)) * (W - pl - pr);
  const y = (v) => pt + ((hi - v) / (hi - lo)) * (H - pt - pb);
  const m = metricMeta(metric);
  let g = "";
  const st = niceStep(hi - lo, 3);
  for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) {
    const yy = y(v).toFixed(1);
    g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}"/><text class="tick" x="${pl - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle">${fmtNum(v, st < 1 ? 1 : 0)}</text>`;
  }
  const span = to - from;
  const xs = span <= 2 * DAY ? 6 * HOUR : DAY;
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  if (xs === DAY) first.setHours(0);
  else first.setHours(Math.ceil(first.getHours() / 6) * 6);
  for (let t = first.getTime(); t <= to; t += xs) {
    if (t < from) continue;
    const xx = x(t).toFixed(1);
    const lab = xs === DAY ? wday.format(new Date(t)) : hhmm.format(new Date(t));
    g += `<line class="grid v" x1="${xx}" x2="${xx}" y1="${pt}" y2="${H - pb}"/><text class="tick" x="${xx}" y="${H - 6}" text-anchor="middle">${lab}</text>`;
  }
  let thr = "";
  for (const [side, val] of [["máx", rule?.max], ["mín", rule?.min]]) {
    if (!isNum(val)) continue;
    const yy = y(val).toFixed(1);
    const above = +yy - pt > 14;
    thr += `<line class="thr" x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}"/><text class="thr-l" x="${pl + 4}" y="${(above ? +yy - 4 : +yy + 12).toFixed(1)}">${side} ${fmtLimit(metric, val)}</text>`;
  }
  const segs = segmentsOf(ser, gapOf(ser));
  let area = "", line = "";
  for (const s of segs) {
    const pts = s.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
    line += `<polyline class="ln" points="${pts.join(" ")}"/>`;
    if (s.length > 1) area += `<path class="ar" d="M${pts[0]} L${pts.join(" L")} L${x(s[s.length - 1].t).toFixed(1)},${H - pb} L${x(s[0].t).toFixed(1)},${H - pb} Z"/>`;
  }
  const last = ser[ser.length - 1];
  const out = (isNum(rule?.max) && last.v > rule.max) || (isNum(rule?.min) && last.v < rule.min);
  const dot = `<circle class="end-ring${out ? " bad" : ""}" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="6"/><circle class="end${out ? " bad" : ""}" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="3.2"/>`;
  return `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.label)}">${g}${area}${line}${thr}${dot}</svg>`;
}

/** Mini gráfica de la tarjeta: se estira al ancho, el punto final va en HTML. */
function sparkHTML(series, metric, rule) {
  const W = 300, H = 46;
  const now = Date.now(), from = now - DAY;
  const ser = series.filter((p) => p.t >= from && !(metric === "batteryLevel" && p.v > 100));
  const dom = yDomain(ser, metric, rule);
  if (!dom || ser.length < 2 || ser[ser.length - 1].t - ser[0].t < 45 * MIN) return `<div class="spark spark-empty"><span>Aún sin histórico</span></div>`;
  const [lo, hi] = dom;
  const x = (t) => ((t - from) / (now - from)) * W;
  const y = (v) => 2 + ((hi - v) / (hi - lo)) * (H - 4);
  let area = "", line = "", thr = "";
  for (const s of segmentsOf(ser, gapOf(ser))) {
    const pts = s.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
    line += `<polyline class="ln" points="${pts.join(" ")}" vector-effect="non-scaling-stroke"/>`;
    if (s.length > 1) area += `<path class="ar" d="M${pts[0]} L${pts.join(" L")} L${x(s[s.length - 1].t).toFixed(1)},${H} L${x(s[0].t).toFixed(1)},${H} Z"/>`;
  }
  for (const val of [rule?.max, rule?.min]) if (isNum(val)) {
    const yy = y(val).toFixed(1);
    thr += `<line class="thr" x1="0" x2="${W}" y1="${yy}" y2="${yy}" vector-effect="non-scaling-stroke"/>`;
  }
  const last = ser[ser.length - 1];
  const out = (isNum(rule?.max) && last.v > rule.max) || (isNum(rule?.min) && last.v < rule.min);
  return `<div class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${area}${thr}${line}</svg><i class="spark-dot${out ? " bad" : ""}" style="left:${((x(last.t) / W) * 100).toFixed(2)}%;top:${((y(last.v) / H) * 100).toFixed(2)}%"></i></div>`;
}

/* ───────────── render ───────────── */
let raf = 0;
function render() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderTop();
    renderBoard();
    renderCards();
    renderMesh();
    renderLog();
    renderFoot();
    mapView?.update();
    const n = unacked().length;
    document.title = n ? `(${n}) Alarma · Vigía Mesh` : "Vigía Mesh";
  });
}

const ICON = {
  bt: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10-5 4V3l5 4L7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.4h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4-2-1.6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

const STAGE_TEXT = { gatt: "Buscando el nodo…", service: "Abriendo canal…", notify: "Abriendo canal…" };
const LINK_TEXT = {
  idle: "Conectar receptor",
  connecting: "Conectando…",
  configuring: "Leyendo el nodo…",
  ready: "Receptor conectado",
  reconnecting: "Reconectando…",
};

function renderTop() {
  const b = $("#linkBtn");
  const st = S.demo ? "demo" : S.link.state;
  b.dataset.state = st;
  let label = S.demo ? "Demo" : LINK_TEXT[st] || st;
  if (st === "ready" && S.myNode != null) label = `${S.nodes.get(S.myNode)?.short || "Receptor"} conectado`;
  const ex = S.link.extra || {};
  if ((st === "connecting" || st === "reconnecting") && ex.stage && !ex.at) label = STAGE_TEXT[ex.stage] || label;
  if (st === "configuring" && ex.packets) label = `Leyendo el nodo · ${ex.packets}`;
  if (st === "reconnecting" && ex.at) {
    const s = Math.max(0, Math.round((ex.at - Date.now()) / 1000));
    label = s > 0 ? `Reintento en ${s} s` : "Reconectando…";
  }
  b.innerHTML = `<span class="ld"></span>${ICON.bt}<span class="lt">${esc(label)}</span>`;
  $("#demoBar").hidden = !S.demo;
}

function renderBoard() {
  const el = $("#board");
  const list = [...S.active.values()].sort((a, b) => (a.acked - b.acked) || (b.since - a.since));
  const watchedN = Object.keys(S.cfg.watched).length;
  let html = "";
  if (list.length) {
    const open = list.filter((a) => !a.acked).length;
    const cls = open ? "crit" : "seen";
    html += `<div class="board ${cls}"><div class="board-h"><h2>${open ? (open === 1 ? "1 alarma sin atender" : `${open} alarmas sin atender`) : (list.length === 1 ? "1 alarma vista, sigue activa" : `${list.length} alarmas vistas, siguen activas`)}</h2>${open > 1 ? `<button class="btn on-dark" data-ackall>Enterado todas</button>` : ""}</div><ul class="al-list">`;
    for (const a of list) {
      html += `<li class="al${a.acked ? " acked" : ""}" data-kind="${a.kind}"><div class="al-main"${a.num != null ? ` data-open="${a.num}"` : ""}><strong>${esc(alarmTitle(a))}</strong><span>${esc(alarmDetail(a))}${a.late ? " Recibida al reconectar." : ""}</span></div><div class="al-side"><span class="al-t">desde ${esc(stamp(a.since))}</span>${a.acked ? `<span class="al-ok">Visto</span>` : `<button class="btn on-dark" data-ack="${esc(a.key)}">Enterado</button>`}</div></li>`;
    }
    html += `</ul></div>`;
  } else {
    let lastT = 0;
    for (const num of Object.keys(S.cfg.watched)) lastT = Math.max(lastT, S.nodes.get(Number(num))?.lastHeard || 0);
    const parts = watchedN
      ? [`${watchedN} ${watchedN === 1 ? "nodo vigilado" : "nodos vigilados"}`, lastT ? `último dato ${ago(lastT)}` : "sin datos aún"]
      : ["Ningún nodo vigilado todavía"];
    html += `<div class="board calm"><span class="calm-dot"></span><div><h2>${watchedN ? "Todo en orden" : "Elige qué vigilar"}</h2><p>${esc(parts.join(" · "))}</p></div></div>`;
  }
  const tHTML = troubleHTML();
  html += tHTML;
  if (!S.demo && S.otherWindow) {
    html += S.otherWindow === "lost"
      ? `<div class="notice"><p>La conexión con el receptor ha pasado a otra ventana de Vigía.</p><button class="btn primary" data-takeover>Recuperarla aquí</button></div>`
      : `<div class="notice"><p>Vigía ya está conectada al receptor en otra ventana o pestaña. El nodo solo admite una conexión: usa esa, o tráete la conexión aquí.</p><button class="btn primary" data-takeover>Conectar aquí</button></div>`;
  } else if (!S.demo && !tHTML && S.link.state !== "ready" && !S.active.has("link")) {
    const msg = S.link.state === "idle"
      ? "Sin receptor conectado. Mientras tanto ves los últimos datos guardados y no puedo saber si un nodo deja de emitir."
      : "Esperando al receptor. Las alarmas de nodo sin señal están en pausa hasta que vuelva.";
    html += `<div class="notice"><p>${esc(msg)}</p>${S.link.state === "idle" ? `<button class="btn primary" data-connect>Conectar receptor</button>` : ""}</div>`;
  }
  el.innerHTML = html;
}

/* ───────────── guía cuando no conecta ───────────── */
const TROUBLE = {
  busy: {
    title: "El nodo no responde",
    lead: "No se pudo abrir la conexión. Lo normal es que otro móvil o la app de Meshtastic lo tenga ocupado, o que esté apagado o lejos.",
    steps: [
      "Cierra del todo la app de Meshtastic, o desconecta el nodo desde ella. En Android sigue conectada en segundo plano aunque no la abras, y el nodo solo admite un móvil.",
      "Si lo has usado desde el ordenador, cierra allí la pestaña o la app que lo tenga conectado.",
      "Comprueba que el nodo está encendido y a pocos metros.",
      "Apaga y enciende el Bluetooth del móvil. Si sigue igual, reinicia el nodo.",
    ],
  },
  pairing: {
    title: "Problema de emparejamiento",
    lead: "La conexión se abre pero se corta al empezar a hablar con el nodo. Casi siempre es que el móvil y el nodo ya no coinciden en el emparejamiento (pasa al actualizar el firmware o al emparejar el nodo con varios aparatos).",
    steps: [
      "En los ajustes de Bluetooth del móvil, olvida «{name}».",
      "Vuelve aquí y pulsa Conectar receptor. Android te pedirá un PIN: sale en la pantalla del nodo (si no tiene pantalla, suele ser 123456).",
      "Si te pasa a menudo y el receptor es fijo en casa, puedes poner su Bluetooth en «Sin PIN» desde la app de Meshtastic. Se acaba este problema, a cambio de que cualquiera a pocos metros pueda conectarse a él.",
    ],
  },
  service: {
    title: "Ese aparato no parece un nodo Meshtastic",
    lead: "Se conecta, pero no encuentra el servicio de Meshtastic.",
    steps: [
      "Comprueba que has elegido el nodo correcto.",
      "Si acabas de actualizar su firmware, olvídalo en los ajustes de Bluetooth del móvil: Android guarda la lista de servicios antigua.",
      "Pulsa Conectar receptor y elígelo otra vez.",
    ],
  },
  lost: {
    title: "La conexión se corta",
    lead: "Conecta, pero se corta antes de terminar de leer el nodo.",
    steps: [
      "Acerca el móvil al nodo.",
      "Cierra la app de Meshtastic y cualquier otra que use el nodo.",
      "Apaga y enciende el Bluetooth del móvil.",
    ],
  },
};
TROUBLE.other = TROUBLE.lost;

function troubleHTML() {
  const tr = S.trouble;
  if (S.demo || !tr || S.otherWindow || S.link.state === "ready") return "";
  const urgent = tr.kind === "pairing" || tr.kind === "service";
  if (!urgent && tr.count < 2) return "";
  const g = TROUBLE[tr.kind] || TROUBLE.other;
  const name = tr.name || S.device?.name || "el nodo";
  const steps = g.steps.map((x) => `<li>${esc(x.replace("{name}", name))}</li>`).join("");
  const retry = S.link.state === "idle" ? `<button class="btn primary" data-connect>Conectar receptor</button>` : `<button class="btn primary" data-retry>Reintentar ahora</button>`;
  return `<div class="trouble" role="status"><h2>${esc(g.title)}</h2><p>${esc(g.lead)} <span class="tr-n">${tr.count === 1 ? "1 intento" : `${tr.count} intentos seguidos`}.</span></p><ol>${steps}</ol><div class="btns">${retry}<button class="btn ghost" data-diag>Ver diagnóstico</button></div></div>`;
}

/* ───────────── diagnóstico de conexión ───────────── */
let diagSaveT = null;
function pushDiag(e) {
  S.diag.push(e);
  if (S.diag.length > 150) S.diag.splice(0, S.diag.length - 150);
  clearTimeout(diagSaveT);
  diagSaveT = setTimeout(() => LS.set("vigia.diag", S.diag), 800);
  const el = $("#diagList");
  if (el) el.textContent = diagLines(40);
}
const diagLine = (e) => `${new Date(e.t).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}  ${e.msg}`;
const diagLines = (n) => S.diag.slice(-n).map(diagLine).join("\n") || "Sin registros todavía.";
function diagText() {
  const head = [
    `Vigía Mesh ${APP_VERSION}`,
    navigator.userAgent,
    `Receptor: ${S.device?.name || "—"} · estado: ${S.link.state}${S.trouble ? ` · último fallo: ${S.trouble.kind} (${S.trouble.count})` : ""}`,
    `Bluetooth web: ${navigator.bluetooth ? "sí" : "no"} · getDevices: ${navigator.bluetooth?.getDevices ? "sí" : "no"} · forget: ${typeof BluetoothDevice !== "undefined" && BluetoothDevice.prototype?.forget ? "sí" : "no"} · locks: ${navigator.locks ? "sí" : "no"}`,
    "",
  ];
  return head.join("\n") + S.diag.map(diagLine).join("\n");
}
/** Enlace a un aviso nuevo en GitHub con el diagnóstico ya pegado (recortado para que quepa en la URL). */
function issueUrl() {
  const intro = "**Qué pasó:**\n\n\n**Modelo del nodo receptor y versión de firmware:**\n\n\n**Diagnóstico** (revísalo antes de enviar: el aviso es público)\n";
  const lines = diagText().split("\n");
  const keep = 4; // cabecera: versión, navegador, receptor y capacidades
  let cut = false;
  const build = () => `${ISSUES_URL}/new?title=${encodeURIComponent("Fallo de conexión")}&body=${encodeURIComponent(`${intro}\n\`\`\`\n${[...lines.slice(0, keep), ...(cut ? ["(líneas más antiguas recortadas)"] : []), ...lines.slice(keep)].join("\n")}\n\`\`\`\n`)}`;
  let url = build();
  while (url.length > 7000 && lines.length > keep + 1) {
    lines.splice(keep, Math.max(1, Math.ceil((lines.length - keep) / 8)));
    cut = true;
    url = build();
  }
  return url;
}

function nodeState(num) {
  const al = [...S.active.values()].filter((a) => a.num === num);
  if (al.some((a) => a.kind === "moved")) return ["crit", "Fuera de sitio"];
  if (al.some((a) => a.kind === "high" || a.kind === "low" || a.kind === "trend")) return ["crit", "Alarma"];
  if (al.some((a) => a.kind === "offline")) return ["off", "Sin señal"];
  const n = S.nodes.get(num);
  if (!n || !n.lastHeard) return ["none", "Sin datos"];
  return ["ok", "Normal"];
}

function metaLine(n) {
  const bits = [n.lastHeard ? `visto ${ago(n.lastHeard)}` : "sin señal registrada"];
  if (isNum(n.hops)) bits.push(n.hops === 0 ? "directo" : `${n.hops} ${n.hops === 1 ? "salto" : "saltos"}`);
  if (isNum(n.snr) && n.snr !== 0) bits.push(`SNR ${fmtNum(n.snr, 1)} dB`);
  return bits.join(" · ");
}

function renderCards() {
  const el = $("#cards");
  const nums = Object.keys(S.cfg.watched).map(Number)
    .sort((a, b) => (S.nodes.get(a)?.long || "").localeCompare(S.nodes.get(b)?.long || "", "es"));
  $("#watchCount").textContent = nums.length ? String(nums.length) : "";
  if (!nums.length) {
    el.innerHTML = `<div class="empty"><p><strong>Aquí aparecerán tus sensores.</strong> En “Resto de la malla” toca <em>Vigilar</em> en un nodo para fijarlo aquí y ponerle alarmas de umbral y de nodo sin señal.</p></div>`;
    return;
  }
  el.innerHTML = nums.map((num) => {
    const n = node(num);
    const w = S.cfg.watched[num];
    const [st, stLabel] = nodeState(num);
    const keys = sortMetrics(Object.keys(n.metrics).filter((k) => !metricMeta(k).minor));
    const readings = keys.map((k) => {
      const m = metricMeta(k), r = (w.rules || {})[k] || {};
      const v = n.metrics[k].v;
      const bad = (isNum(r.max) && v > r.max) || (isNum(r.min) && v < r.min) || S.active.has(trendKey(num, k));
      const lim = [isNum(r.min) ? `mín ${fmtLimit(k, r.min)}` : "", isNum(r.max) ? `máx ${fmtLimit(k, r.max)}` : "", r.trend ? trendShort(k, r.trend) : ""].filter(Boolean).join(" · ");
      const unit = k === "batteryLevel" && v > 100 ? "" : m.unit;
      return `<div class="rd${bad ? " bad" : ""}"><span class="rd-l">${esc(m.label)}</span><span class="rd-v">${fmtValue(k, v)}${unit ? `<small>${esc(unit)}</small>` : ""}</span><span class="rd-lim">${lim || "&nbsp;"}</span></div>`;
    }).join("");
    const sparkMetric = ["temperature", "batteryLevel", "relativeHumidity"].find((k) => n.metrics[k]) || keys[0];
    const spark = sparkMetric
      ? `<div class="spark-wrap"><span class="spark-cap">${esc(metricMeta(sparkMetric).label)} · últimas 24 h</span>${sparkHTML(S.recent.get(seriesKey(num, sparkMetric)) || [], sparkMetric, (w.rules || {})[sparkMetric])}</div>`
      : "";
    return `<article class="card st-${st}" data-open="${num}">
      <header class="card-h"><span class="tag">${esc(n.short)}</span><div class="card-t"><h3><button type="button" class="name-btn" data-open="${num}" aria-label="Abrir ficha de ${esc(n.long)}, estado ${stLabel}">${esc(n.long)}</button></h3><p class="meta">${esc(metaLine(n))}</p></div><span class="pill p-${st}">${stLabel}</span></header>
      ${readings ? `<div class="rds">${readings}</div>` : `<p class="no-rd">Este nodo aún no ha mandado telemetría.</p>`}
      ${n.pos ? `<div class="pos" data-pos-box="${num}">${posBlock(num)}</div>` : ""}
      ${spark}
      <div class="ask" data-ask-box="${num}">${askBlock(num)}</div>
    </article>`;
  }).join("");
}

function renderMesh() {
  const el = $("#mesh");
  const all = [...S.nodes.values()].filter((n) => !isWatched(n.num))
    .sort((a, b) => (b.hasEnv - a.hasEnv) || ((b.lastHeard || 0) - (a.lastHeard || 0)));
  $("#meshCount").textContent = all.length ? String(all.length) : "";
  const shown = S.meshExpanded ? all : all.slice(0, 8);
  if (!all.length) {
    el.innerHTML = `<li class="empty-row">${S.demo || S.link.state === "ready" ? "No hay más nodos en la base de datos del receptor." : "Conecta el receptor para ver los nodos que oye."}</li>`;
  } else {
    el.innerHTML = shown.map((n) => {
      const tags = [n.num === S.myNode ? "receptor" : "", n.hasEnv ? "sensores" : "", n.num !== S.myNode && n.key === false && receptorUsesPki() ? "sin clave" : ""].filter(Boolean);
      return `<li class="row"><button class="row-main" data-open="${n.num}"><span class="tag sm">${esc(n.short)}</span><span class="row-t"><span class="row-n">${esc(n.long)}${tags.map((t) => `<span class="chip${t === "sin clave" ? " warn" : ""}">${t}</span>`).join("")}</span><span class="meta">${esc(metaLine(n))}</span></span></button><button class="btn ghost" data-watch="${n.num}">Vigilar</button></li>`;
    }).join("");
  }
  const more = $("#meshMore");
  more.hidden = all.length <= 8;
  more.textContent = S.meshExpanded ? "Ver menos" : `Ver los ${all.length} nodos`;
}

function renderLog() {
  const el = $("#log");
  const list = S.logExpanded ? S.log : S.log.slice(0, 12);
  el.innerHTML = list.length
    ? list.map((e) => `<li class="lg lg-${e.type}"><time>${esc(stamp(e.t))}</time><span>${esc(e.text)}</span></li>`).join("")
    : `<li class="empty-row">Todavía no ha pasado nada.</li>`;
  const more = $("#logMore");
  more.hidden = S.log.length <= 12;
  more.textContent = S.logExpanded ? "Ver menos" : `Ver todo el registro (${S.log.length})`;
}

function renderFoot() {
  const bits = ["Sin internet: los datos se guardan solo en este dispositivo."];
  if (wake) bits.push("Pantalla fija activada.");
  $("#foot").textContent = bits.join(" ");
  const v = $("#footVer");
  if (v) v.textContent = `Vigía Mesh ${APP_VERSION}`;
}

/* ───────────── mapa ───────────── */
const TILE_CACHE = "teselas-osm"; // el mismo nombre que en sw.js
let persistAsked = false;
/** focus: nodo en el que centrar el mapa (desde su tarjeta o su ficha). */
function openMap(focus = null) {
  // Que el navegador no vacíe el fondo guardado cuando el móvil vaya justo de espacio.
  if (!persistAsked && window.__VIGIA_PWA) { persistAsked = true; navigator.storage?.persist?.().catch(() => {}); }
  if (!mapView) {
    mapView = createMapView({
      nodes: () => [...S.nodes.values()],
      myNode: () => S.myNode,
      esc, ago, stamp,
      load: () => LS.get("vigia.map", {}),
      save: (v) => LS.set("vigia.map", v),
    });
  }
  const detail = $("#detail");
  // Desde la ficha: si el mapa ya estaba abierto debajo, se cierra la ficha para verlo;
  // si no, el mapa se abre encima y al cerrarlo se vuelve a la ficha.
  if (focus != null && detail.open && $("#map").open) detail.close();
  mapView.open(focus);
}

/* ───────────── detalle de nodo ───────────── */
function openDetail(num) {
  S.detail = { num, range: S.detail?.num === num ? S.detail.range : "24h" };
  renderDetail();
  const d = $("#detail");
  // Con el mapa abierto, la ficha puede estar debajo (se abrió antes): se reabre para que quede encima.
  if (d.open && $("#map").open) d.close();
  if (!d.open) d.showModal();
  drawCharts();
}

function renderDetail() {
  const { num } = S.detail;
  const n = node(num);
  const w = S.cfg.watched[num];
  const keys = sortMetrics(new Set([...Object.keys(n.metrics), ...Object.keys(w?.rules || {})]));
  const tags = [hexId(num), n.hw ? n.hw.replaceAll("_", " ") : "", n.num === S.myNode ? "tu receptor" : ""].filter(Boolean).join(" · ");
  let body = `<section class="blk"><h3>Pedir datos ahora</h3><div class="ask in-sheet" data-ask-box="${num}" data-sheet="1">${askBlock(num, true)}</div>
    <p class="hint">La petición sale por LoRa desde tu receptor y el nodo contesta con una lectura recién tomada. Si está dormido para ahorrar batería o fuera de alcance, no contesta.</p></section>`;
  body += `<section class="blk"><div class="pos in-sheet" data-pos-box="${num}" data-sheet="1">${posBlock(num, true)}</div></section>`;
  if (w) {
    const off = isNum(w.offlineMin) ? w.offlineMin : S.settings.defaultOfflineMin;
    const rows = keys.filter((k) => !metricMeta(k).minor).map((k) => {
      const m = metricMeta(k), r = (w.rules || {})[k] || {};
      const cur = n.metrics[k];
      return `<tr><th scope="row">${esc(m.label)}${m.unit ? ` <small>${esc(m.unit)}</small>` : ""}</th><td class="now" data-now="${k}">${cur ? fmtValue(k, cur.v) : "—"}</td>
        <td><input id="r-${k}-min" class="inp" data-rule="${k}" data-side="min" inputmode="decimal" autocomplete="off" placeholder="—" value="${isNum(r.min) ? fmtLimit(k, r.min) : ""}" aria-label="${esc(m.label)} mínimo"></td>
        <td><input id="r-${k}-max" class="inp" data-rule="${k}" data-side="max" inputmode="decimal" autocomplete="off" placeholder="—" value="${isNum(r.max) ? fmtLimit(k, r.max) : ""}" aria-label="${esc(m.label)} máximo"></td></tr>`;
    }).join("");
    body += `<section class="blk"><h3>Alarmas de este nodo</h3>
      <div class="off-row"><label for="r-off">Avisar si no da señal en más de</label><span class="inp-u"><input id="r-off" class="inp" inputmode="numeric" autocomplete="off" value="${off || ""}" placeholder="no"><span>min</span></span></div>
      <p class="hint">Por defecto la telemetría sale cada 30 min. Deja margen para dos envíos perdidos; vacío desactiva este aviso.</p>
      ${rows ? `<div class="tbl"><table class="thr-t"><thead><tr><th scope="col">Métrica</th><th scope="col">Ahora</th><th scope="col">Mín.</th><th scope="col">Máx.</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">Escribe el límite y sal de la casilla para guardarlo. Vacía la casilla para quitarlo.</p>` : `<p class="hint">Cuando este nodo mande telemetría aparecerán aquí sus métricas para ponerles límites.</p>`}
      <p class="form-err" id="ruleErr" role="alert" hidden></p>
      <div class="trend-box" id="trendBox">${trendBlock(num)}</div></section>`;
  } else {
    body += `<section class="blk cta"><p>Vigila este nodo para fijarlo arriba y ponerle alarmas de umbral y de nodo sin señal.</p><button class="btn primary" data-watch="${num}">Vigilar este nodo</button></section>`;
  }
  body += `<section class="blk"><div class="blk-h"><h3>Histórico</h3><div class="seg" role="group" aria-label="Periodo">
      <button type="button" data-range="24h" aria-pressed="${S.detail.range === "24h"}">24 h</button><button type="button" data-range="7d" aria-pressed="${S.detail.range === "7d"}">7 días</button></div></div>
      <div id="chartList" class="chart-list">${keys.length ? keys.map((k) => `<figure class="chart" data-m="${k}"><figcaption><span>${esc(metricMeta(k).label)}</span><b data-cur="${k}">${n.metrics[k] ? esc(fmtWithUnit(k, n.metrics[k].v)) : "—"}</b><span class="mm" data-mm="${k}"></span></figcaption><div class="chart-box"></div></figure>`).join("") : `<p class="hint">Sin telemetría de este nodo.</p>`}</div></section>`;
  if (w) body += `<section class="blk end"><button class="btn danger-ghost" id="unwatchBtn" data-unwatch="${num}">Dejar de vigilar</button></section>`;

  $("#detail").innerHTML = `<div class="sheet-h"><span class="tag">${esc(n.short)}</span><div class="sheet-t"><h2>${esc(n.long)}</h2><p class="meta">${esc(tags)}<br>${esc(metaLine(n))}</p></div><button class="icon-btn" data-close aria-label="Cerrar">${ICON.close}</button></div><div class="sheet-b">${body}</div>`;
}

async function drawCharts() {
  if (!S.detail) return;
  const { num, range } = S.detail;
  const to = Date.now(), from = to - (range === "7d" ? 7 * DAY : DAY);
  const rules = S.cfg.watched[num]?.rules || {};
  for (const fig of $$("#chartList .chart")) {
    const k = fig.dataset.m;
    const ser = await S.store.series(num, k, from, to);
    if (!S.detail || S.detail.num !== num) return;
    const box = $(".chart-box", fig);
    const W = Math.max(240, Math.floor(box.clientWidth || 320));
    box.innerHTML = chartSVG(ser, k, rules[k], from, to, W);
    const vals = ser.map((p) => p.v).filter((v) => !(k === "batteryLevel" && v > 100));
    $(`[data-mm="${k}"]`, fig).textContent = vals.length ? `mín ${fmtNum(Math.min(...vals), metricMeta(k).dec)} · máx ${fmtNum(Math.max(...vals), metricMeta(k).dec)}` : "";
  }
}

let liveT = null;
function refreshDetailLive() {
  if (!S.detail || !$("#detail").open) return;
  const n = S.nodes.get(S.detail.num);
  if (!n) return;
  for (const [k, m] of Object.entries(n.metrics)) {
    const a = $(`#detail [data-now="${k}"]`);
    if (a) a.textContent = fmtValue(k, m.v);
    const b = $(`#detail [data-cur="${k}"]`);
    if (b) b.textContent = fmtWithUnit(k, m.v);
    const c = $(`#detail [data-trend-now="${k}"]`), rule = S.cfg.watched[S.detail.num]?.rules?.[k]?.trend;
    if (c && rule) {
      c.textContent = trendNowText(S.detail.num, k, rule);
      c.closest("li")?.classList.toggle("bad", S.active.has(trendKey(S.detail.num, k)));
    }
  }
  clearTimeout(liveT);
  liveT = setTimeout(drawCharts, 400);
}

function saveRuleFromInput(inp) {
  const num = S.detail?.num;
  const w = S.cfg.watched[num];
  if (!w) return;
  const err = $("#ruleErr");
  if (inp.id === "r-off") {
    const v = parseNum(inp.value);
    if (Number.isNaN(v) || (v !== null && v < 1)) { showErr(err, "Pon un número de minutos (1 o más) o déjalo vacío."); inp.focus(); return; }
    w.offlineMin = v === null ? 0 : Math.round(v);
    err.hidden = true;
    saveCfg();
    evalOffline();
    render();
    toast(v === null ? "Aviso de nodo sin señal desactivado" : `Avisará tras ${dur(w.offlineMin * MIN)} sin señal`);
    return;
  }
  const k = inp.dataset.rule, side = inp.dataset.side;
  const v = parseNum(inp.value);
  if (Number.isNaN(v)) { showErr(err, `“${inp.value}” no es un número. Usa coma o punto para los decimales.`); inp.focus(); return; }
  w.rules = w.rules || {};
  const r = { ...(w.rules[k] || {}) };
  if (v === null) delete r[side]; else r[side] = v;
  if (isNum(r.min) && isNum(r.max) && r.min >= r.max) { showErr(err, `En ${metricMeta(k).label.toLowerCase()} el mínimo tiene que ser menor que el máximo.`); inp.focus(); return; }
  err.hidden = true;
  if (isNum(r.min) || isNum(r.max) || r.trend) w.rules[k] = r; else delete w.rules[k];
  saveCfg();
  const cur = S.nodes.get(num)?.metrics[k];
  if (cur) evalThreshold(num, k, cur.v, cur.t);
  else { clearAlarm(`${num}|${k}|high`, { silent: true }); clearAlarm(`${num}|${k}|low`, { silent: true }); }
  render();
  drawCharts();
  toast("Límite guardado");
}
function showErr(el, msg) { el.textContent = msg; el.hidden = false; }

/* ── cambio rápido: bloque de la ficha ── */
function trendMetrics(num) {
  const n = S.nodes.get(num), w = S.cfg.watched[num];
  return sortMetrics(new Set([...Object.keys(n?.metrics || {}), ...Object.keys(w?.rules || {})])).filter((k) => !metricMeta(k).minor);
}
/** sel: métrica que queda elegida en el formulario (la que se acaba de guardar). */
function trendBlock(num, sel = null) {
  const w = S.cfg.watched[num];
  if (!w) return "";
  const ks = trendMetrics(num);
  let h = `<h4>Cambio rápido</h4><p class="hint">Avisa si un valor baja o sube mucho en poco tiempo, aunque no llegue a ningún límite. Por ejemplo, una bajada de presión de 3 hPa en 3 h suele anunciar tormenta.</p>`;
  const set = ks.filter((k) => w.rules?.[k]?.trend);
  if (set.length) {
    h += `<ul class="tr-list">${set.map((k) => {
      const rule = w.rules[k].trend, on = S.active.has(trendKey(num, k));
      return `<li${on ? ` class="bad"` : ""}><span class="tr-t"><span><b>${esc(metricMeta(k).label)}</b>: si ${trendVerb(rule.dir)} ${esc(fmtLimit(k, rule.delta, true))} o más en ${esc(hoursText(rule.hours))}</span><small data-trend-now="${k}">${esc(trendNowText(num, k, rule))}</small></span><button type="button" class="mini" data-trend-del="${k}" aria-label="Quitar el aviso de cambio rápido de ${esc(metricMeta(k).label)}">Quitar</button></li>`;
    }).join("")}</ul>`;
  }
  if (!ks.length) return h + `<p class="hint">Cuando este nodo mande telemetría podrás ponerle este aviso.</p>`;
  const pick = (sel && ks.includes(sel) && sel) || ks.find((k) => k === "barometricPressure" && !w.rules?.[k]?.trend) || ks.find((k) => !w.rules?.[k]?.trend) || ks[0];
  const d = w.rules?.[pick]?.trend || trendDefault(pick);
  h += `<div class="tr-form"><span>Avisar si</span>
    <select id="tr-metric" class="inp sel" aria-label="Métrica">${ks.map((k) => `<option value="${k}"${k === pick ? " selected" : ""}>${esc(metricMeta(k).label)}</option>`).join("")}</select>
    <select id="tr-dir" class="inp sel" aria-label="Dirección"><option value="down"${d.dir === "down" ? " selected" : ""}>baja</option><option value="up"${d.dir === "up" ? " selected" : ""}>sube</option></select>
    <span class="inp-u"><input id="tr-delta" class="inp" inputmode="decimal" autocomplete="off" value="${fmtLimit(pick, d.delta)}" aria-label="Cuánto"><span id="tr-unit">${esc(metricMeta(pick).unit)}</span></span>
    <span>o más en</span>
    <span class="inp-u"><input id="tr-hours" class="inp" inputmode="decimal" autocomplete="off" value="${fmtNum(d.hours, d.hours % 1 ? 1 : 0)}" aria-label="Horas"><span>h</span></span></div>
    <p class="form-err" id="trErr" role="alert" hidden></p>
    <div class="btns"><button type="button" class="btn primary sm" data-trend-add="${num}">${w.rules?.[pick]?.trend ? "Guardar aviso" : "Añadir aviso"}</button></div>`;
  return h;
}
function refreshTrend(num, sel = null) {
  const box = $("#trendBox");
  if (box && S.detail?.num === num) box.innerHTML = trendBlock(num, sel);
}
/** Al cambiar de métrica en el formulario: sus valores (los guardados o los recomendados). */
function trendFormFill() {
  const num = S.detail?.num, k = $("#tr-metric")?.value;
  if (!k) return;
  const cur = S.cfg.watched[num]?.rules?.[k]?.trend;
  const d = cur || trendDefault(k);
  $("#tr-dir").value = d.dir;
  $("#tr-delta").value = fmtLimit(k, d.delta);
  $("#tr-hours").value = fmtNum(d.hours, d.hours % 1 ? 1 : 0);
  $("#tr-unit").textContent = metricMeta(k).unit;
  $("[data-trend-add]").textContent = cur ? "Guardar aviso" : "Añadir aviso";
  $("#trErr").hidden = true;
}
function addTrend(num) {
  const w = S.cfg.watched[num];
  if (!w) return;
  const k = $("#tr-metric").value, err = $("#trErr");
  const delta = parseNum($("#tr-delta").value), hours = parseNum($("#tr-hours").value);
  const { rule, error } = parseTrendRule($("#tr-dir").value, delta ?? NaN, hours ?? NaN);
  if (error) { showErr(err, error); return; }
  w.rules = w.rules || {};
  const had = !!w.rules[k]?.trend;
  w.rules[k] = { ...(w.rules[k] || {}), trend: rule };
  saveCfg();
  addLog("info", `${nodeName(num)} · Aviso de cambio rápido: ${metricMeta(k).label} si ${trendVerb(rule.dir)} ${fmtLimit(k, rule.delta, true)} o más en ${hoursText(rule.hours)}`, num);
  evalTrend(num, k, { strict: true });
  refreshTrend(num, k);
  render();
  toast(had ? "Aviso de cambio rápido actualizado" : "Aviso de cambio rápido añadido");
}
function delTrend(num, k) {
  const w = S.cfg.watched[num];
  if (!w?.rules?.[k]?.trend) return;
  delete w.rules[k].trend;
  if (!Object.keys(w.rules[k]).length) delete w.rules[k];
  saveCfg();
  clearAlarm(trendKey(num, k), { silent: true });
  addLog("info", `${nodeName(num)} · Quitado el aviso de cambio rápido de ${metricMeta(k).label.toLowerCase()}`, num);
  refreshTrend(num);
  render();
  toast("Aviso quitado");
}

function watch(num) {
  if (isWatched(num)) return;
  S.cfg.watched[num] = { offlineMin: S.settings.defaultOfflineMin, rules: {} };
  saveCfg();
  loadRecent([num]).then(render);
  addLog("info", `Vigilando ${nodeName(num)}`, num);
  evalNode(num);
  render();
  if (S.detail?.num === num && $("#detail").open) { renderDetail(); drawCharts(); }
  toast(`${nodeName(num)} fijado arriba. Ponle límites en su ficha.`);
}

function unwatch(num) {
  delete S.cfg.watched[num];
  saveCfg();
  for (const k of [...S.active.keys()]) if (S.active.get(k).num === num) clearAlarm(k, { silent: true });
  addLog("info", `Ya no se vigila ${nodeName(num)}`, num);
  render();
}

/* ───────────── ajustes ───────────── */
const PREVIEW = !window.__VIGIA_PWA;
function btSupportMsg() {
  if (PREVIEW) return "Esta es la vista previa: aquí el navegador no deja usar Bluetooth. Instala la app desde tu dirección https para conectar el nodo.";
  const s = Receptor.support();
  if (s === "insecure") return "Bluetooth web solo funciona en páginas seguras (https). Abre la app desde su dirección https.";
  if (s === "none") return "Este navegador no tiene Bluetooth web. Usa Chrome en Android o en el ordenador; en iPhone no está disponible.";
  return "";
}

function renderSettings() {
  const st = S.link.state;
  const dev = S.device || LS.get("vigia.device", null);
  const sup = btSupportMsg();
  let rec = "";
  if (sup) rec = `<p class="warn-t">${esc(sup)}</p>`;
  else if (S.demo) rec = `<p>Estás en la demo. Sal de ella para conectar tu nodo.</p><div class="btns"><button class="btn primary" data-demo-off>Salir de la demo y conectar</button></div>`;
  else {
    const my = S.myNode != null ? S.nodes.get(S.myNode) : null;
    const statusTxt = {
      idle: dev?.name ? `Desconectado. Último receptor: ${dev.name}.` : "Ningún receptor emparejado todavía.",
      connecting: `Conectando con ${dev?.name || "el nodo"}…`,
      configuring: "Conectado. Leyendo la base de datos de nodos…",
      ready: `Conectado a ${my ? `${my.short} · ${my.long}` : dev?.name || "tu nodo"}.`,
      reconnecting: `Se ha perdido la conexión con ${dev?.name || "el receptor"}. Reintentando sola.`,
    }[st];
    rec = `<p>${esc(statusTxt)}</p><div class="btns">`;
    if (st === "idle") rec += `<button class="btn primary" data-connect>Conectar receptor</button><button class="btn ghost" data-connect-all>Mi nodo no aparece</button>`;
    else rec += `${st === "reconnecting" ? `<button class="btn primary" data-retry>Reintentar ahora</button>` : ""}<button class="btn ghost" data-disconnect>Desconectar</button>`;
    rec += `${dev && st === "idle" ? `<button class="btn danger-ghost" data-forget>Olvidar este receptor</button>` : ""}</div><p class="hint">El receptor es el nodo que tienes al lado del móvil; los sensores le llegan por LoRa. El móvil se conecta a él por Bluetooth, sin internet.</p>
      <details class="tips"><summary>Si no conecta</summary><ul>
        <li><strong>La app de Meshtastic lo tiene ocupado.</strong> En Android sigue conectada en segundo plano aunque no la abras. Ciérrala del todo o desconecta el nodo desde ella: el nodo solo admite un móvil.</li>
        <li><strong>Emparejamiento roto.</strong> Si se conecta y se corta enseguida, olvida el nodo en los ajustes de Bluetooth del móvil y vuelve a conectar; te pedirá el PIN que sale en su pantalla.</li>
        <li><strong>Otra ventana de Vigía.</strong> Si la tienes abierta en Chrome y también instalada, solo una puede conectarse.</li>
        <li><strong>Bluetooth del móvil atascado.</strong> Apagarlo y encenderlo arregla muchos fallos raros de Android.</li>
      </ul></details>`;
  }
  const notifState = !("Notification" in window) ? "none" : Notification.permission;
  const notif = notifState === "granted" ? `<span class="okt">Activadas</span>`
    : notifState === "denied" ? `<span class="warn-t">Bloqueadas en los ajustes del navegador</span>`
    : notifState === "none" ? `<span class="hint">No disponibles aquí</span>`
    : `<button class="btn ghost" data-notif>Activar</button>`;
  $("#settings").innerHTML = `<div class="sheet-h"><div class="sheet-t"><h2>Ajustes</h2></div><button class="icon-btn" data-close aria-label="Cerrar">${ICON.close}</button></div>
  <div class="sheet-b">
    <section class="blk"><h3>Receptor</h3>${rec}</section>
    <section class="blk"><h3>Avisos</h3>
      <div class="set-row"><label class="sw" for="setSound"><input type="checkbox" id="setSound" ${S.settings.sound ? "checked" : ""}><span class="sw-ui"></span><span>Sonido de alarma</span></label><button class="btn ghost" data-test>Probar alarma</button></div>
      <div class="set-row"><label class="sw" for="setWake"><input type="checkbox" id="setWake" ${S.settings.wake ? "checked" : ""}><span class="sw-ui"></span><span>Mantener la pantalla encendida</span></label></div>
      <div class="set-row"><span>Notificaciones del sistema</span>${notif}</div>
      <div class="set-row"><label for="setOff">Sin señal, valor para nodos nuevos</label><span class="inp-u"><input id="setOff" class="inp" inputmode="numeric" autocomplete="off" value="${S.settings.defaultOfflineMin}"><span>min</span></span></div>
      <p class="hint">Las alarmas solo saltan con la app abierta y en pantalla. Con el móvil bloqueado, Chrome congela la página; al volver, recoge lo que guardó el receptor y avisa de lo que se perdió.</p>
    </section>
    ${PREVIEW && !S.demo ? "" : meshSection()}
    <section class="blk"><h3>Histórico</h3>
      <div class="set-row"><span id="histCount">Contando lecturas…</span><select id="setRet" class="inp sel" aria-label="Tiempo que se guardan las lecturas">${[7, 30, 90, 365].map((d) => `<option value="${d}"${S.settings.retentionDays === d ? " selected" : ""}>Guardar ${d} días</option>`).join("")}</select></div>
      <div class="btns">${PREVIEW ? "" : `<button class="btn ghost" data-export>Exportar CSV</button>`}<button class="btn danger-ghost" data-wipe>Borrar histórico</button></div>
    </section>
    ${PREVIEW ? "" : `<section class="blk"><h3>Mapa sin internet</h3>
      <div class="set-row"><span id="tileCount">Contando el fondo guardado…</span><button class="btn ghost" data-wipe-tiles>Borrar fondo guardado</button></div>
      <p class="hint">El fondo del mapa se guarda solo de las zonas que ves con conexión y en los zooms que usas, hasta unas 2.000 teselas (unos 40 MB). Antes de ir a un sitio sin cobertura, recórrelo en el mapa con internet.</p>
      <p class="hint" id="tilePersist"></p>
    </section>
    <section class="blk" id="diagBox"><h3>Diagnóstico de conexión</h3>
      <p class="hint">Cada paso de la conexión queda apuntado aquí. Si falla, copia el diagnóstico: dice en qué paso se corta.</p>
      <pre class="diag" id="diagList">${esc(diagLines(40))}</pre>
      <div class="btns"><button class="btn ghost" data-copy-diag>Copiar diagnóstico</button><button class="btn ghost" data-report>Avisar del fallo en GitHub</button><button class="btn ghost" data-clear-diag>Borrar</button></div>
      <p class="hint">«Avisar del fallo» abre un aviso nuevo en GitHub con el diagnóstico ya pegado. Necesita internet y una cuenta de GitHub, y el aviso es público: revisa el texto antes de enviarlo.</p>
    </section>`}
    <section class="blk"><h3>Demostración</h3>${S.demo ? `<p>Los datos que ves son inventados y no se guardan.</p>${PREVIEW ? "" : `<button class="btn ghost" data-demo-off>Salir de la demo</button>`}` : `<p>Prueba el panel con nodos inventados. Tus datos reales no se tocan.</p><button class="btn ghost" data-demo-on>Ver la demo</button>`}</section>
    <section class="blk about"><h3>Acerca de</h3>
      <p><strong>Vigía Mesh ${APP_VERSION}</strong>. Panel de alarmas para nodos Meshtastic que funciona sin internet. Hecho por Dani-NRos.</p>
      <div class="btns"><a class="btn ghost" href="${REPO_URL}" target="_blank" rel="noopener">Código en GitHub</a><a class="btn ghost" href="${ISSUES_URL}" target="_blank" rel="noopener">Avisos y sugerencias</a></div>
      <p class="hint">Para abrir los enlaces hace falta internet. Si algo falla o echas algo en falta, cuéntalo en los avisos de GitHub.</p>
      <p class="hint">Código abierto con licencia GPL-3.0. Proyecto independiente, no afiliado a Meshtastic. Meshtastic® es una marca registrada de Meshtastic LLC.</p>
    </section>
  </div>`;
  S.store.count().then((c) => { const el = $("#histCount"); if (el) el.textContent = `${c.toLocaleString("es-ES")} lecturas${S.demo ? " (demo)" : ""}`; });
  if (!PREVIEW) tileInfo();
}

async function tileInfo() {
  let n = 0, mb = null, kept = null;
  try { n = (await (await caches.open(TILE_CACHE)).keys()).length; } catch { /* sin caché */ }
  try { const e = await navigator.storage.estimate(); if (e.usageDetails?.caches != null) mb = e.usageDetails.caches / 1048576; } catch { /* sin estimación */ }
  try { kept = await navigator.storage.persisted(); } catch { /* sin dato */ }
  const el = $("#tileCount");
  if (el) el.textContent = n ? `${n.toLocaleString("es-ES")} teselas${mb != null ? ` (≈ ${fmtNum(mb, mb < 10 ? 1 : 0)} MB)` : ""}` : "Nada guardado todavía";
  const p = $("#tilePersist");
  if (p) p.textContent = kept === true ? "Guardado permanente: el navegador no lo borra aunque falte espacio."
    : kept === false ? "El navegador puede borrarlo si el móvil se queda sin espacio. Instalar la app suele evitarlo." : "";
}
function openSettings() {
  renderSettings();
  const d = $("#settings");
  if (!d.open) d.showModal();
}

async function exportCsv() {
  const rows = (await S.store.all()).sort((a, b) => a.t - b.t);
  const lines = ["fecha;nodo;nombre;metrica;valor;unidad"];
  for (const r of rows) {
    const m = metricMeta(r.metric);
    lines.push([new Date(r.t).toISOString(), hexId(r.node), `"${nodeName(r.node).replaceAll('"', "'")}"`, r.metric, String(r.v).replace(".", ","), m.unit].join(";"));
  }
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `vigia-mesh-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`${rows.length.toLocaleString("es-ES")} lecturas exportadas`);
}

/* ───────────── receptor ───────────── */
function makeReceptor() {
  return new Receptor({
    onStatus(state, extra) {
      S.link = { state, extra: extra || null };
      if ($("#settings").open) renderSettings();
      if (S.detail) refreshAsk(S.detail.num);
      render();
    },
    onDevice(dev) {
      S.device = { id: dev.id, name: dev.name || "Nodo Meshtastic" };
      LS.set("vigia.device", S.device);
    },
    onReady() {
      Object.assign(clock, { n: 0, min: Infinity, said: false });
      setTimeout(pumpMesh, 1500);
      S.trouble = null;
      S.otherWindow = null;
      LS.set("vigia.ever", true);
      clearAlarm("link", {});
      addLog("info", `Receptor listo: ${S.myNode != null ? nodeName(S.myNode) : S.device?.name || "nodo"}`);
      evalOffline();
      render();
    },
    onLost(reason, wasReady) {
      if (wasReady) raise("link", { kind: "link", num: null, t: Date.now() });
      evalOffline();
    },
    onTrouble(info) {
      S.trouble = info;
      if (info.count === 1 && info.kind !== "pairing" && info.kind !== "service") toast("No se pudo conectar. Reintentando…");
      render();
    },
    onDiag(e) { pushDiag(e); },
    onChannel(c) { setChannel(c); },
    onOtherWindow() { S.otherWindow = "busy"; render(); },
    onLockLost() { S.otherWindow = "lost"; addLog("info", "La conexión con el receptor ha pasado a otra ventana"); render(); },
    onMyNode(num) {
      S.myNode = num;
      LS.set("vigia.my", num);
      node(num);
    },
    onNodeInfo(ni) {
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
    onUser(from, user, meta) {
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
    onPacket(p) {
      const rx = p.rxTime ? p.rxTime * 1000 : 0;
      touch(p.from, validT(rx) ? rx : Date.now());
      const n = node(p.from);
      if (p.hopStart > 0 && isNum(p.hopLimit)) n.hops = Math.max(0, p.hopStart - p.hopLimit);
      if (isNum(p.rxSnr) && p.rxSnr !== 0) n.snr = p.rxSnr;
      const dec = p.payloadVariant?.case === "decoded" ? p.payloadVariant.value : null;
      if (dec && dec.portnum === Protobuf.Portnums.PortNum.ROUTING_APP && dec.requestId) {
        ackFrom.set(dec.requestId, p.from);
        if (ackFrom.size > 200) ackFrom.delete(ackFrom.keys().next().value);
        askRouting(dec.requestId, p.from, routingErrorReason(dec.payload));
      }
      if (validT(rx) && S.link.state === "ready") checkClock(rx);
      // Canal por el que emite el nodo, para pedirle datos por el mismo.
      if (p.to === 0xffffffff && isNum(p.channel) && p.channel < 8) n.channel = p.channel;
      saveNodes();
      render();
    },
    onPosition(p) {
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
    onTelemetry(p) {
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
  });
}

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

function btErrorText(e) {
  const name = e?.name || "";
  const msg = String(e?.message || "");
  if (name === "NotFoundError" && /cancel/i.test(msg)) return "";
  if (name === "NotFoundError") return "No se encontró el nodo. Comprueba que tiene el Bluetooth activo y está cerca.";
  if (name === "SecurityError" || /permissions policy|disallowed/i.test(msg)) return "Esta página no tiene permiso para usar Bluetooth. Pasa en la vista previa: abre la app instalada desde tu dirección https.";
  if (name === "NetworkError") return "El nodo no responde. Acércalo, o reinícialo si tiene otro móvil conectado.";
  if (name === "NotAllowedError") return "Has denegado el acceso al Bluetooth.";
  return `No se pudo conectar: ${msg || name || "error desconocido"}`;
}

async function connectFlow(all = false) {
  const sup = btSupportMsg();
  if (sup) { toast(sup); openSettings(); return; }
  if (S.demo) stopDemo();
  if (!receptor) receptor = makeReceptor();
  try {
    await receptor.pick(all);
  } catch (e) {
    const t = btErrorText(e);
    if (t) toast(t);
    if (receptor.state !== "reconnecting") { S.link = { state: "idle", extra: null }; render(); }
  }
}

/* ───────────── demo ───────────── */
function startDemo() {
  if (receptor && receptor.state !== "idle") receptor.disconnect();
  S.demo = true;
  const d = buildDemo(Date.now());
  S.demoData = d;
  S.demoToken++;
  resetAsks();
  S.store = createMemStore();
  S.store.add(d.rows);
  S.nodes = new Map();
  for (const n of d.nodes) S.nodes.set(n.num, { metrics: {}, snr: null, hasEnv: false, hw: "", ...n });
  for (const r of d.rows) {
    const n = S.nodes.get(r.node);
    const prev = n.metrics[r.metric];
    if (!prev || r.t >= prev.t) n.metrics[r.metric] = { v: r.v, t: r.t };
  }
  for (const [num, ms] of Object.entries(d.extraMetrics)) Object.assign(S.nodes.get(Number(num)).metrics, ms);
  S.myNode = d.myNode;
  S.channels = [
    { index: 0, name: "LongFast", primary: true, private: false, why: "clave pública por defecto" },
    { index: 1, name: "avisos", primary: false, private: true, why: "" },
    { index: 2, name: "familia", primary: false, private: true, why: "" },
  ];
  S.demoMesh = MESH_DEFAULT();
  S.infoAsked = {};
  S.meshLast = null;
  S.cfg = { watched: JSON.parse(JSON.stringify(d.watched)) };
  S.active = new Map();
  S.log = [{ t: Date.now(), type: "info", text: "Demo cargada con nodos inventados" }];
  S.recent = new Map();
  const since = Date.now() - 26 * HOUR;
  for (const r of d.rows) if (r.t >= since) {
    const k = seriesKey(r.node, r.metric);
    if (!S.recent.has(k)) S.recent.set(k, []);
    S.recent.get(k).push({ t: r.t, v: r.v });
  }
  for (const num of Object.keys(S.cfg.watched)) evalNode(Number(num), { silent: true });
  mapView?.reset();
  const seen = S.active.get(`${DEMO_IDS.monte}||offline`);
  if (seen) seen.acked = true;
  clearInterval(S.demoTimer);
  S.demoTimer = setInterval(() => {
    const x = d.tick();
    ingest(x.num, x.metrics, Date.now(), { env: true });
  }, 12000);
  render();
}

function stopDemo() {
  clearInterval(S.demoTimer);
  S.demoTimer = null;
  S.demo = false;
  S.demoData = null;
  S.demoToken++;
  resetAsks();
  loadReal();
  mapView?.reset();
  if (S.detail && $("#detail").open) $("#detail").close();
  loadRecent().then(render);
  render();
}

async function loadRecent(nums) {
  const list = nums || Object.keys(S.cfg.watched).map(Number);
  const since = Date.now() - 26 * HOUR;
  for (const num of list) {
    const n = S.nodes.get(num);
    if (!n) continue;
    for (const k of Object.keys(n.metrics)) {
      const ser = await S.store.series(num, k, since);
      if (ser.length) S.recent.set(seriesKey(num, k), ser);
    }
  }
}

/* ───────────── toast ───────────── */
let toastT = null;
function toast(msg) {
  if (!msg) return;
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove("show");
  void t.offsetWidth;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.classList.remove("show"); setTimeout(() => { t.hidden = true; }, 250); }, 3600);
}

/* ───────────── eventos ───────────── */
let wipeArmed = 0, unwatchArmed = 0, forgetArmed = 0;
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("a, button, [data-open], [data-close]");
  if (t?.tagName === "A") return; // enlaces (Google Maps, GitHub) van a lo suyo
  if (!t) {
    const dlg = ev.target.closest("dialog");
    if (dlg && ev.target === dlg) dlg.close();
    return;
  }
  const ds = t.dataset;
  if ("ask" in ds) return ask(Number(ds.num), ds.ask);
  if ("mapFocus" in ds) return openMap(Number(ds.mapFocus));
  if ("copy" in ds) return copyText(ds.copy, t);
  if ("fenceSet" in ds) return setFence(Number(ds.fenceSet));
  if ("fenceDel" in ds) return delFence(Number(ds.fenceDel));
  if ("trendAdd" in ds) return addTrend(Number(ds.trendAdd));
  if ("trendDel" in ds) return S.detail && delTrend(S.detail.num, ds.trendDel);
  if ("ack" in ds) return ack(ds.ack);
  if ("ackall" in ds) return ackAll();
  if ("watch" in ds) return watch(Number(ds.watch));
  if ("close" in ds) return t.closest("dialog")?.close();
  if ("connect" in ds) { $("#settings").open && $("#settings").close(); return connectFlow(false); }
  if ("connectAll" in ds) { $("#settings").close(); return connectFlow(true); }
  if ("retry" in ds) return receptor?.retryNow();
  if ("takeover" in ds) {
    if (!receptor) receptor = makeReceptor();
    if (!receptor.device) { S.otherWindow = null; render(); return connectFlow(false); }
    if (!(await receptor.takeOver())) return toast("No se pudo tomar la conexión. Cierra la otra ventana de Vigía.");
    S.otherWindow = null;
    return render();
  }
  if ("diag" in ds) { openSettings(); setTimeout(() => $("#diagBox")?.scrollIntoView({ block: "start" }), 50); return; }
  if ("meshTest" in ds) {
    if (!S.demo && S.link.state !== "ready") return toast("Conecta el receptor para enviar la prueba.");
    meshNotify("test");
    return;
  }
  if ("copyDiag" in ds) {
    const txt = diagText();
    try { await navigator.clipboard.writeText(txt); toast("Diagnóstico copiado"); }
    catch { const r = document.createRange(); const el = $("#diagList"); if (el) { el.textContent = txt; r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } toast("Selecciona y copia el texto del diagnóstico"); }
    return;
  }
  if ("report" in ds) {
    if (!navigator.onLine) return toast("Sin internet: copia el diagnóstico y avisa cuando tengas conexión.");
    window.open(issueUrl(), "_blank", "noopener");
    return;
  }
  if ("clearDiag" in ds) { S.diag = []; LS.del("vigia.diag"); const el = $("#diagList"); if (el) el.textContent = diagLines(40); return; }
  if ("forget" in ds) {
    if (Date.now() - forgetArmed > 4000) { forgetArmed = Date.now(); t.textContent = "Toca otra vez para olvidarlo"; return; }
    forgetArmed = 0;
    await receptor?.forget();
    LS.del("vigia.device");
    S.device = null;
    S.trouble = null;
    renderSettings();
    render();
    return toast("Receptor olvidado. Al conectar podrás elegir otro.");
  }
  if ("disconnect" in ds) { await receptor?.disconnect(); S.trouble = null; addLog("info", "Receptor desconectado a mano"); clearAlarm("link", { silent: true }); render(); return; }
  if ("demoOn" in ds) { $("#settings").close(); startDemo(); return toast("Demo activada: datos inventados"); }
  if ("demoOff" in ds) { $("#settings").open && $("#settings").close(); if (PREVIEW) return toast(btSupportMsg()); stopDemo(); return connectFlow(false); }
  if ("notif" in ds) { try { await Notification.requestPermission(); } catch { /* nada */ } renderSettings(); return; }
  if ("test" in ds) { unlockAudio(); raise("test", { kind: "test", num: null, t: Date.now() }); $("#settings").close(); return; }
  if ("export" in ds) return exportCsv();
  if ("wipe" in ds) {
    if (Date.now() - wipeArmed > 4000) { wipeArmed = Date.now(); t.textContent = "Toca otra vez para borrar"; return; }
    wipeArmed = 0;
    await S.store.clear();
    S.recent = new Map();
    renderSettings();
    render();
    return toast("Histórico borrado");
  }
  if ("wipeTiles" in ds) {
    try { await caches.delete(TILE_CACHE); } catch { /* nada que borrar */ }
    tileInfo();
    return toast("Fondo del mapa borrado. Se volverá a guardar al usarlo con internet.");
  }
  if ("unwatch" in ds) {
    if (Date.now() - unwatchArmed > 4000) { unwatchArmed = Date.now(); t.textContent = "Toca otra vez para dejar de vigilar"; return; }
    unwatchArmed = 0;
    unwatch(Number(ds.unwatch));
    renderDetail();
    drawCharts();
    return;
  }
  if ("range" in ds) { S.detail.range = ds.range; $$("#detail [data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === ds.range))); return drawCharts(); }
  if (t.id === "linkBtn") { if (!S.demo && S.link.state === "idle" && !btSupportMsg()) return connectFlow(false); return openSettings(); }
  if (t.id === "setBtn") return openSettings();
  if (t.id === "mapBtn") return openMap();
  if (t.id === "meshMore") { S.meshExpanded = !S.meshExpanded; return renderMesh(); }
  if (t.id === "logMore") { S.logExpanded = !S.logExpanded; return renderLog(); }
  if ("open" in ds) return openDetail(Number(ds.open));
});

document.addEventListener("keydown", (ev) => {
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.(".card[data-open]")) { ev.preventDefault(); openDetail(Number(ev.target.dataset.open)); }
  if (ev.key === "Enter" && ev.target.closest?.(".tr-form") && ev.target.matches("input")) { ev.preventDefault(); return S.detail && addTrend(S.detail.num); }
  if (ev.key === "Enter" && ev.target.matches?.("#detail .inp")) ev.target.blur();
});

document.addEventListener("change", (ev) => {
  const t = ev.target;
  if (t.id === "fence-r") return S.detail && setFenceRadius(S.detail.num, t);
  if (t.id === "tr-metric") return trendFormFill();
  if (t.closest(".tr-form")) return; // se guarda con el botón
  if (t.matches("#detail .inp")) return saveRuleFromInput(t);
  if (t.id === "setSound") { S.settings.sound = t.checked; saveSettings(); if (t.checked) { unlockAudio(); beep(); } return; }
  if (t.id === "setWake") { S.settings.wake = t.checked; saveSettings(); return applyWake(); }
  if (t.id === "setOff") {
    const v = parseNum(t.value);
    if (!v || Number.isNaN(v) || v < 1) { t.value = S.settings.defaultOfflineMin; return toast("Pon un número de minutos (1 o más)."); }
    S.settings.defaultOfflineMin = Math.round(v);
    saveSettings();
    return toast("Guardado");
  }
  if (t.id === "meshOn" || t.id === "meshClear") {
    const cfg = meshCfg();
    if (t.id === "meshOn") cfg.enabled = t.checked; else cfg.onClear = t.checked;
    saveMeshCfg();
    if (t.id === "meshOn" && t.checked && cfg.channel == null && cfg.node == null) toast("Elige ahora un canal privado o un nodo.");
    return;
  }
  if (t.id === "meshCh" || t.id === "meshNode") {
    const cfg = meshCfg();
    const v = t.value === "" ? null : Number(t.value);
    if (t.id === "meshCh") {
      const ch = S.channels.find((c) => c.index === v);
      if (v != null && !ch?.private) { t.value = ""; cfg.channel = null; saveMeshCfg(); return toast("Ese canal es público: no se puede usar para avisos."); }
      cfg.channel = v;
    } else cfg.node = v;
    saveMeshCfg();
    return renderSettings();
  }
  if (t.id === "setRet") {
    S.settings.retentionDays = Number(t.value);
    saveSettings();
    S.store.prune(Date.now() - S.settings.retentionDays * DAY).then(renderSettings);
  }
});

$("#detail").addEventListener("close", () => { if ($("#detail").open) return; S.detail = null; unwatchArmed = 0; });
window.addEventListener("resize", () => { clearTimeout(liveT); liveT = setTimeout(drawCharts, 200); });

/* ───────────── arranque ───────────── */
async function boot() {
  S.settings = { ...DEFAULT_SETTINGS, ...LS.get("vigia.settings", {}) };
  S.diag = LS.get("vigia.diag", []) || [];
  loadReal();
  const ever = LS.get("vigia.ever", false);
  if (!ever && S.nodes.size === 0) {
    startDemo();
  } else {
    await loadRecent();
    S.store.prune(Date.now() - S.settings.retentionDays * DAY);
    render();
    const dev = LS.get("vigia.device", null);
    if (dev && !btSupportMsg()) {
      receptor = makeReceptor();
      S.device = dev;
      receptor.restore(dev.id).catch(() => {});
    }
  }
  applyWake();
  if (window.__VIGIA_PWA && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").then((r) => { swReg = r; }).catch(() => {});
  }
  setInterval(() => { evalOffline(); render(); }, 15000);
  setInterval(() => { if (S.link.state === "reconnecting") renderTop(); }, 1000);
}
boot();
