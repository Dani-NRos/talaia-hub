import { metricMeta, sortMetrics, fmtValue, fmtWithUnit, fmtNum, fmtLimit, registrarMetricas } from "@vigia/nucleo/metrics.js";
import { createIdbStore, createMemStore } from "./store.js";
import { createMapView } from "./map.js";
import { Receptor } from "./receptor.js";
import { buildDemo, DEMO_IDS } from "./demo.js";
import { relays, snrQuality, loraSf, weakest, UNKNOWN_NODE, PRESET_NAME } from "@vigia/nucleo/route.js";
import { distM, compass, precisionM, fmtDist, coordText, mapsUrl, SOURCE } from "@vigia/nucleo/geo.js";
import { trendDefault, parseTrendRule } from "@vigia/nucleo/trend.js";
import { searchNodes, highlight, tokens, FILTERS, SORTS } from "./meshsearch.js";
import { conectarServidor, crearStoreRemoto } from "./remoto.js";
import { MIN, HOUR, DAY, isNum, hhmm, dShort, ago, stamp, dur, trendDec, fmtTrend, trendVerb, hoursText, lastWindow } from "@vigia/nucleo/textos.js";
import { crearAcciones } from "@vigia/nucleo/acciones.js";
import { TIPOS, LISTA_TIPOS, TIPOS_PANEL, NOMBRES_ESTADO, tipoMalla, esEstado, unidades, adivinarTipo, adivinarEstado, proponerOrden, unidadDe, textoDato, metasDe, MALLA_MAX_SALTOS } from "@vigia/nucleo/mqtt-datos.js";
import { crearMotor, estadoInicial, MESH_DEFAULT, MESH_HOURLY, ASK, ASK_ALL, askKey, RE, INFO_SUPPRESS, seriesKey, trendKey, estadoKey, hexId } from "@vigia/nucleo/motor.js";

/* ───────────── utilidades ───────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const APP_VERSION = "1.19.0";
// Abierta desde Vigía servidor: el estado es el del servidor y lo que se pulsa va a él como una orden.
const SERVIDOR = typeof window !== "undefined" && !!window.__VIGIA_SERVIDOR;
const REPO_URL = "https://github.com/Dani-NRos/vigia-mesh";
const ISSUES_URL = `${REPO_URL}/issues`;

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nada */ } },
};

const wday = new Intl.DateTimeFormat("es-ES", { weekday: "short" });

function parseNum(s) {
  const x = String(s ?? "").trim().replace(",", ".");
  if (x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

/* ───────────── estado ───────────── */
const DEFAULT_SETTINGS = { sound: true, wake: false, retentionDays: 30, defaultOfflineMin: 75, mesh: null };
// Lo que comparte con el servidor (nodos, alarmas, peticiones…) lo define el núcleo; aquí se añade lo de pantalla.
const S = {
  ...estadoInicial(),
  demoTimer: null,
  settings: { ...DEFAULT_SETTINGS },
  trouble: null, // último fallo de conexión clasificado
  otherWindow: null, // "busy" | "lost" si otra ventana de Vigía tiene el receptor
  diag: [],
  meshExpanded: false,
  ui: { collapsed: {}, order: [] }, // tarjetas vigiladas: contraídas y orden elegido (se guardan aparte de las alarmas)
  ordering: false, // modo «Ordenar» de las tarjetas
  full: null, // nodo abierto a pantalla completa: { num, range }
  meshQ: "", // texto del buscador de «Resto de la malla» (no se guarda)
  meshView: { filters: [], sort: "auto" }, // filtros y orden del buscador (se guardan)
  logExpanded: false,
  detail: null, // { num, range }
  servidorOk: false, // modo «Servidor»: hay conexión con él
};
let receptor = null;
let swReg = null;
let mapView = null; // se crea al abrir el mapa por primera vez

/* ───────────── motor (núcleo común con el servidor) ───────────── */
const motor = crearMotor(S, {
  cambio: () => render(),
  lectura(num) { if (S.detail && S.detail.num === num) refreshDetailLive(); refreshFull(num); },
  posicion: (num) => refreshPos(num),
  peticion: (num) => refreshAsk(num),
  peticionEstado: (num) => patchAskStatus(num),
  ruta() { if (mapView && $("#map").open) mapView.update(); },
  avisoMalla: () => patchMeshLast(),
  registro: () => renderLog(),
  alarma: (al) => fireAlarm(al),
  toast: (msg) => toast(msg),
  diag: (e) => pushDiag(e),
  // Con servidor, lo guarda él; aquí solo los ajustes de este aparato (sonido, pantalla encendida).
  guardar: (k) => { if (!SERVIDOR || k === "settings") SAVE[k]?.(); },
  radio: {
    listo: () => (SERVIDOR ? S.servidorOk : !!receptor?.mesh),
    requestTelemetry: (...a) => receptor.requestTelemetry(...a),
    requestNodeInfo: (...a) => receptor.requestNodeInfo(...a),
    requestPosition: (...a) => receptor.requestPosition(...a),
    requestTraceroute: (...a) => receptor.requestTraceroute(...a),
    sendText: (...a) => receptor.sendText(...a),
  },
});
const {
  node, nodeName, isWatched, ingest, evalNode, trendNow, evalOffline, raise, clearAlarm,
  ack, ackAll, unacked, alarmTitle, alarmDetail, addLog, canAsk, askVisible, askFailText, receptorUsesPki, keyNeeded,
  staleKeyFail, ask, resetAsks, hopName, meshCfg, pumpMesh,
} = motor;
// Lo que cambia el usuario (vigilar, límites, valla, ajustes…): lo mismo que hace el servidor con sus órdenes.
const acciones = crearAcciones(motor);
let servidor = null; // modo «Servidor»: la conexión con él
const orden = (datos) => servidor.orden(datos);

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
  S.meshView = { filters: [], sort: "auto", ...(LS.get("vigia.meshView", {}) || {}) };
  S.ui = { collapsed: {}, order: [], ...(LS.get("vigia.cards", {}) || {}) };
  S.traces = LS.get("vigia.traces", {}) || {};
  S.lora = LS.get("vigia.lora", null);
  S.recent = new Map();
}
// Lo que el motor pide guardar. En la demo no se guarda nada (lo comprueba cada función o el propio motor).
const SAVE = {
  cfg: saveCfg,
  nodes: saveNodes,
  log: saveLog,
  active: saveActive,
  infoAsk: () => LS.set("vigia.infoAsk", Object.fromEntries(Object.entries(S.infoAsked).filter(([, t]) => Date.now() - t < INFO_SUPPRESS))),
  traces: () => LS.set("vigia.traces", S.traces),
  channels: () => LS.set("vigia.channels", S.channels),
  lora: () => LS.set("vigia.lora", S.lora),
  my: () => LS.set("vigia.my", S.myNode),
  settings: saveSettings,
};

/* ───────────── cambio rápido (tendencia) ───────────── */
/** «ha bajado 1,2 hPa en las últimas 3 horas» con los datos de ahora, para la ficha. */
function trendNowText(num, k, rule) {
  const r = trendNow(num, k, rule);
  if (!r) return `Ahora: aún no hay lecturas de hace ${hoursText(rule.hours / 2)} o más para comparar.`;
  if (r.change <= 0) return `Ahora: no ${rule.dir === "down" ? "ha bajado" : "ha subido"} ${lastWindow(rule.hours)}.`;
  return `Ahora: ${rule.dir === "down" ? "ha bajado" : "ha subido"} ${fmtTrend(k, r.change, trendDec(k, r.change))} ${lastWindow(rule.hours)}.`;
}
/** Para la tarjeta: «↓3/3 h». */
const trendShort = (k, rule) => `${rule.dir === "down" ? "↓" : "↑"}${fmtLimit(k, rule.delta)}/${hoursText(rule.hours)}`;

/* ───────────── pedir datos a un nodo ───────────── */
function askChips(num) {
  const ok = canAsk();
  return Object.entries(ASK).map(([type, a]) => {
    const r = S.req.get(askKey(num, type));
    const st = askVisible(r) && !staleKeyFail(r) ? r.state : "";
    return `<button type="button" class="ask-b${st ? ` is-${st}` : ""}" data-ask="${type}" data-num="${num}" title="${esc(a.what)}"${!ok || st === "wait" ? " disabled" : ""}>${a.label}</button>`;
  }).join("");
}
function askStatus(num, types = Object.keys(ASK_ALL).filter((t) => t !== "pos" && t !== "route")) {
  return types.map((type) => S.req.get(askKey(num, type))).filter((r) => askVisible(r) && !staleKeyFail(r)).sort((a, b) => b.t0 - a.t0).map((r) => {
    const l = ASK_ALL[r.type].label;
    const secs = Math.round((Date.now() - r.t0) / 1000);
    if (r.state === "wait" && r.type === "route") return `<span class="s-wait">Trazando la ruta… ${secs} s</span>`;
    if (r.state === "wait") return `<span class="s-wait">${l}: ${r.acked ? "la petición llegó, esperando respuesta" : "esperando respuesta"}… ${secs} s</span>`;
    if (r.state === "ok" && r.type === "route") return "";
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
  for (const el of $$(`[data-route-box="${num}"]`)) el.innerHTML = routeBlock(num);
}
function patchAskStatus(num) {
  for (const el of $$(`[data-ask-st="${num}"]`)) el.innerHTML = askStatus(num);
  for (const el of $$(`[data-pos-st="${num}"]`)) el.innerHTML = askStatus(num, ["pos"]);
  for (const el of $$(`[data-route-st="${num}"]`)) el.innerHTML = askStatus(num, ["route"]);
}

/* ───────────── ruta por la malla (traceroute) ───────────── */
function legHops(leg) {
  const k = relays(leg).length;
  return k === 0 ? "directa" : `por ${k} ${k === 1 ? "nodo" : "nodos"}`;
}
const fmtSnr = (s) => `${fmtNum(s, Number.isInteger(s) ? 0 : Number.isInteger(s * 2) ? 1 : 2)} dB`;
function legHTML(title, leg, sf) {
  let h = `<div class="rt"><h4>${title} <span>${legHops(leg)}</span></h4><ol class="rt-l">`;
  leg.nodes.forEach((num, i) => {
    if (i > 0) {
      const s = leg.snr[i - 1], q = snrQuality(s, sf);
      h += `<li class="rt-s${q ? ` q-${q}` : ""}" aria-label="Salto: ${s == null ? "SNR desconocido" : `SNR ${fmtSnr(s)}`}"><span>${s == null ? "SNR ?" : fmtSnr(s)}</span></li>`;
    }
    const n = S.nodes.get(num);
    const unk = num === UNKNOWN_NODE;
    const tag = unk ? "?" : n?.short || "";
    const name = esc(hopName(num));
    const canOpen = !unk && n && num !== S.detail?.num;
    h += `<li class="rt-n${unk ? " unk" : ""}">${tag ? `<span class="tag sm">${esc(tag)}</span>` : ""}${canOpen ? `<button type="button" class="link-btn" data-open="${num}">${name}</button>` : `<span>${name}</span>`}</li>`;
  });
  return h + `</ol></div>`;
}
function routeBlock(num) {
  if (num === S.myNode) return `<h3>Ruta por la malla</h3><p class="hint">Es tu receptor: las rutas se trazan desde él hasta los demás nodos.</p>`;
  const r = S.req.get(askKey(num, "route"));
  const waiting = r?.state === "wait";
  const tr = S.traces[num];
  const sf = loraSf(S.lora);
  let h = `<div class="blk-h"><h3>Ruta por la malla</h3><button type="button" class="mini" data-ask="route" data-num="${num}"${!canAsk() || waiting ? " disabled" : ""}>${waiting ? "Trazando…" : tr ? "Volver a trazar" : "Trazar ruta"}</button></div>`;
  h += `<p class="ask-st" data-route-st="${num}">${askStatus(num, ["route"])}</p>`;
  if (tr) {
    h += `<p class="meta">Trazada ${esc(ago(tr.t))} (${esc(stamp(tr.t))}) · contestó en ${Math.max(1, Math.round(tr.ms / 1000))} s</p>`;
    h += `<div class="rt-cols">${legHTML("Ida", tr.fwd, sf)}${tr.back ? legHTML("Vuelta", tr.back, sf) : `<div class="rt"><h4>Vuelta</h4><p class="hint">Sin datos: algún nodo del camino tiene un firmware anterior a 2.5.</p></div>`}</div>`;
    const w = weakest(tr);
    if (w && snrQuality(w.snr, sf) !== "ok") h += `<p class="hint">Salto más flojo: ${esc(hopName(w.from))} → ${esc(hopName(w.to))}, ${fmtSnr(w.snr)}.</p>`;
    const located = new Set([...tr.fwd.nodes, ...(tr.back?.nodes || [])].filter((x) => S.nodes.get(x)?.pos));
    if (located.size >= 2) h += `<div class="pos-row"><button type="button" class="mini" data-route-map="${num}">Ver la ruta en el mapa</button></div>`;
  }
  const preset = S.lora && (S.lora.usePreset !== false ? PRESET_NAME[S.lora.modemPreset ?? 0] : `SF${S.lora.spreadFactor}`);
  h += `<p class="hint">Por qué nodos pasa una petición tuya hasta este nodo y por cuáles vuelve su respuesta. Cada número es el SNR con que un nodo oye al anterior: <b class="q-ok">sobrado</b>, <b class="q-warn">justo</b> o <b class="q-bad">al límite</b>${preset ? ` con ${esc(preset)}` : ""}. Los que repiten sin la clave del canal salen sin nombre. Tu receptor solo lanza un traceroute cada 30 s.</p>`;
  return h;
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

async function setFence(num) {
  const r = parseNum($("#fence-r")?.value);
  const res = SERVIDOR ? await orden({ orden: "valla", num, radio: r }) : acciones.fijarValla(num, r);
  if (res.error) return toast(res.error);
  if (!res.ok) return;
  refreshPos(num);
  render();
  toast(res.toast);
}
async function setFenceRadius(num, input) {
  const r = parseNum(input.value);
  const res = SERVIDOR ? await orden({ orden: "radioValla", num, radio: r }) : acciones.radioValla(num, r);
  if (res.error) { if (res.radio != null) input.value = res.radio; return toast(res.error); }
  if (!res.ok) return;
  input.blur();
  refreshPos(num);
  render();
  toast(res.toast);
}
async function delFence(num) {
  if (!(SERVIDOR ? await orden({ orden: "quitarValla", num }) : acciones.quitarValla(num)).ok) return;
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

/* ───────────── avisos por la malla ───────────── */

function meshLastHTML() {
  const l = S.meshLast;
  if (!l) return "Todavía no se ha enviado ningún aviso.";
  const cls = l.ok === true ? "okt" : l.ok === false ? "warn-t" : "";
  return `Último: «${esc(l.text)}» → ${esc(l.tg?.label || l.label)}: <strong class="${cls}">${esc(l.result)}</strong> · ${esc(stamp(l.tDone || l.t))}`;
}
function patchMeshLast() { const el = $("#meshLast"); if (el) el.innerHTML = meshLastHTML(); }

/* ───────────── MQTT: brokers y Home Assistant (solo con servidor) ───────────── */
// Lo escrito y aún sin guardar: si Ajustes se redibuja (llega un estado, diagnóstico…), no se pierde.
let brokerEdit = null; // el broker que se está añadiendo (id null) o cambiando: { id, nombre, url, usuario, clave, activado }
let haBorrador = null; // { activado, broker, base, prefijo }
const mqttBrokers = () => S.mqtt?.brokers || [];
const nombreBroker = (id) => mqttBrokers().find((b) => b.id === id)?.nombre || "(broker quitado)";

function brokerEstadoHTML(b) {
  const e = b.estado || {};
  if (!b.activado) return "Desconectado (apagado).";
  if (e.fase === "conectada") return `<span class="okt">Conectado</span> desde las ${esc(hhmm.format(new Date(e.desde)))}.`;
  if (e.fase === "error") return `<span class="warn-t">No se puede conectar</span>: ${esc(e.error || "")}. Lo vuelve a intentar cada 5 s.`;
  return "Conectando…";
}
function brokerEditorHTML() {
  const b = brokerEdit;
  const guardado = b.id ? mqttBrokers().find((x) => x.id === b.id) : null;
  return `<div class="mq-ed">
      <div class="mq-f">
        <label for="brkNombre">Nombre</label><input id="brkNombre" class="inp" data-brk="nombre" autocomplete="off" placeholder="Home Assistant" value="${esc(b.nombre || "")}">
        <label for="brkUrl">Dirección</label><input id="brkUrl" class="inp" data-brk="url" autocomplete="off" spellcheck="false" placeholder="192.168.1.20 o 192.168.1.20:1883" value="${esc(b.url || "")}">
        <label for="brkUser">Usuario</label><input id="brkUser" class="inp" data-brk="usuario" autocomplete="off" spellcheck="false" placeholder="sin usuario" value="${esc(b.usuario || "")}">
        <label for="brkPass">Contraseña</label><input id="brkPass" class="inp" data-brk="clave" type="password" autocomplete="new-password" placeholder="${guardado?.hayClave ? "guardada; escribe otra para cambiarla" : "sin contraseña"}" value="${esc(b.clave || "")}">
      </div>
      <div class="set-row"><label class="sw" for="brkOn"><input type="checkbox" id="brkOn" data-brk="activado" ${b.activado !== false ? "checked" : ""}><span class="sw-ui"></span><span>Conectado</span></label></div>
      <p class="form-err" id="brkErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-brk-save>Guardar</button>${guardado?.hayClave ? `<button type="button" class="mini" data-brk-noclave>Quitar la contraseña</button>` : ""}<button type="button" class="btn ghost" data-brk-cancel>Cancelar</button>${b.id ? `<button type="button" class="btn danger-ghost" data-brk-del="${esc(b.id)}">Quitar broker</button>` : ""}</div>
      <p class="hint">Para el Mosquitto de Home Assistant: su IP y un usuario de Home Assistant (o uno de la configuración del complemento Mosquitto).</p>
    </div>`;
}
function brokerLocalHTML() {
  const l = S.mqtt?.local;
  if (!l) return "";
  const dirs = l.direcciones.length ? l.direcciones : ["la IP de este equipo"];
  const usuarios = l.usuarios.length
    ? `<ul class="mq-us">${l.usuarios.map((u) => `<li><span>${esc(u.nombre)}</span><button type="button" class="mini" data-usr-del="${esc(u.nombre)}">Quitar</button></li>`).join("")}</ul>`
    : `<p class="hint">Todavía no hay ningún usuario: sin uno, ningún dispositivo puede conectarse.</p>`;
  return `<details class="mq-adv"${l.usuarios.length ? "" : " open"}><summary>Usuarios de este broker</summary>
      ${usuarios}
      <div class="mq-f">
        <label for="usrNombre">Usuario</label><input id="usrNombre" class="inp" autocomplete="off" spellcheck="false" placeholder="por ejemplo, shelly">
        <label for="usrClave">Contraseña</label><input id="usrClave" class="inp" type="password" autocomplete="new-password" placeholder="al menos 8 caracteres">
      </div>
      <p class="form-err" id="usrErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn ghost" data-usr-save>Guardar usuario</button></div>
      <p class="hint">Si el usuario ya existe, se cambia su contraseña. En un Shelly, Tasmota o zigbee2mqtt: servidor ${dirs.map(esc).join(" o ")}, puerto ${l.puerto}, y uno de estos usuarios.</p>
    </details>`;
}
function haHTML() {
  const h = { ...(S.mqtt?.ha || {}), ...(haBorrador || {}) };
  const brs = mqttBrokers();
  const opts = [`<option value=""${!h.broker ? " selected" : ""}>Elige un broker</option>`]
    .concat(brs.map((b) => `<option value="${esc(b.id)}"${h.broker === b.id ? " selected" : ""}>${esc(b.nombre)}</option>`)).join("");
  return `<h4 class="mq-h">Home Assistant</h4>
      <div class="set-row"><label class="sw" for="haOn"><input type="checkbox" id="haOn" ${h.activado ? "checked" : ""}><span class="sw-ui"></span><span>Publicar los nodos vigilados</span></label></div>
      <div class="set-row"><label for="haBroker">En el broker</label><select id="haBroker" class="inp sel">${opts}</select></div>
      <details class="mq-adv"><summary>Temas</summary><div class="mq-f">
        <label for="haBase">Tema de Vigía</label><input id="haBase" class="inp" autocomplete="off" spellcheck="false" value="${esc(h.base || "vigia")}">
        <label for="haPref">Prefijo de Home Assistant</label><input id="haPref" class="inp" autocomplete="off" spellcheck="false" value="${esc(h.prefijo || "homeassistant")}">
      </div><p class="hint">Normalmente no hay que tocarlos. Vigía publica en «vigia/…» y Home Assistant busca lo que se le anuncia en «homeassistant/…».</p></details>
      <p class="form-err" id="haErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-ha-save>Guardar</button></div>
      <p class="hint">En Home Assistant aparecen solos «Vigía servidor» y un dispositivo por cada nodo vigilado («Vigía · nombre»): sus lecturas, un sensor por cada alarma que le pongas, un botón de «Enterado» y un evento por cada alarma para notificar al móvil. Si el servidor se apaga, Home Assistant lo marca como no disponible.</p>`;
}
function mqttSection() {
  const brs = mqttBrokers();
  const lista = brs.map((b) => `<li class="mq-b">
      <div class="mq-bh"><strong>${esc(b.nombre)}</strong><span class="mq-u">${esc(b.local ? `puerto ${S.mqtt.local?.puerto ?? ""}` : b.url)}</span>${b.local ? "" : `<button type="button" class="mini" data-brk-edit="${esc(b.id)}">Cambiar</button>`}</div>
      <p class="hint" data-brk-estado="${esc(b.id)}">${brokerEstadoHTML(b)}</p>
      ${b.local ? brokerLocalHTML() : ""}
      ${brokerEdit?.id === b.id ? brokerEditorHTML() : ""}
    </li>`).join("");
  return `<section class="blk" id="mqttBox"><h3>MQTT</h3>
      <p class="hint">Los brokers a los que se conecta Vigía, a la vez. ${S.mqtt?.local ? "«Este servidor» es el Mosquitto de este equipo: los dispositivos de casa (Shelly, Tasmota, Zigbee…) pueden publicar ahí." : ""} Lo que llega de cada dispositivo se elige en su panel: «Añadir panel», en el tablero, o «Datos por MQTT» en la ficha de un nodo.</p>
      ${brs.length ? `<ul class="mq-l">${lista}</ul>` : `<p class="hint">Ninguno todavía.</p>`}
      ${brokerEdit && !brokerEdit.id ? brokerEditorHTML() : `<div class="btns"><button type="button" class="btn ghost" data-brk-nuevo>Añadir broker</button></div>`}
      ${haHTML()}
    </section>`;
}
/** Vuelve a pintar el apartado sin cerrar Ajustes. */
function renderMqtt() {
  const box = $("#mqttBox");
  if (box) box.outerHTML = mqttSection();
}
/** Lo que llega del servidor: si no se está escribiendo nada, todo el apartado; si no, solo los estados. */
function patchMqtt() {
  const box = $("#mqttBox");
  if (!box) return;
  const escribiendo = box.contains(document.activeElement) && document.activeElement.matches("input, select");
  if (!brokerEdit && !haBorrador && !escribiendo && !$("#usrNombre")?.value && !$("#usrClave")?.value) {
    const abiertos = [...box.querySelectorAll("details[open]")].map((d) => d.querySelector("summary")?.textContent);
    renderMqtt();
    for (const d of $("#mqttBox").querySelectorAll("details")) if (abiertos.includes(d.querySelector("summary")?.textContent)) d.open = true;
    return;
  }
  for (const b of mqttBrokers()) { const el = box.querySelector(`[data-brk-estado="${b.id}"]`); if (el) el.innerHTML = brokerEstadoHTML(b); }
}
async function guardarBroker() {
  const b = brokerEdit;
  const cambio = { nombre: (b.nombre || "").trim(), url: (b.url || "").trim(), usuario: (b.usuario || "").trim(), activado: b.activado !== false, ...(b.clave ? { clave: b.clave } : {}) };
  const res = await orden({ orden: "broker", id: b.id, cambio });
  if (!res.ok) return showErr($("#brkErr"), res.error || "No se pudo guardar.");
  brokerEdit = null;
  toast(res.toast);
  renderMqtt();
}
async function guardarHA() {
  const h = { ...(S.mqtt?.ha || {}), ...(haBorrador || {}) };
  const res = await orden({ orden: "homeAssistant", cambio: { activado: !!h.activado, broker: h.broker || null, base: (h.base || "").trim(), prefijo: (h.prefijo || "").trim() } });
  if (!res.ok) return showErr($("#haErr"), res.error || "No se pudo guardar.");
  haBorrador = null;
  toast(res.toast);
  renderMqtt();
}
async function guardarUsuarioBroker() {
  const nombre = $("#usrNombre").value.trim(), clave = $("#usrClave").value;
  const res = await orden({ orden: "usuarioBroker", nombre, clave });
  if (!res.ok) return showErr($("#usrErr"), res.error || "No se pudo guardar.");
  $("#usrNombre").value = "";
  $("#usrClave").value = "";
  toast(res.toast);
  renderMqtt();
  $("#mqttBox details.mq-adv").open = true;
}
/** Un cambio en el apartado MQTT: al borrador del broker o de Home Assistant. */
function editarMqtt(t) {
  const k = t.dataset.brk;
  if (k && brokerEdit) return void (brokerEdit[k] = t.type === "checkbox" ? t.checked : t.value);
  const HA = { haOn: "activado", haBroker: "broker", haBase: "base", haPref: "prefijo" };
  if (HA[t.id]) haBorrador = { ...(haBorrador || {}), [HA[t.id]]: t.type === "checkbox" ? t.checked : t.value };
}

/* ───────────── Paneles del servidor: nombre, datos por MQTT y lo que sale a la malla ───────────── */
// Cualquier panel (un nodo vigilado o uno sin nodo, de número negativo) se puede renombrar y llevar datos MQTT; los del
// receptor pueden salir además a la malla como su telemetría (ver servidor/src/paneles.js).
let datBorrador = null; // { num, datos, conexion }: los datos MQTT de un panel, cambiados y aún sin guardar
let mallaBorrador = null; // { activado, cada, canal, saltos }
let temasHallados = []; // lo encontrado con «Buscar temas»: [{ broker, tema, campo, v, unidad?, estado?, conexion? }]
let filtroTemas = "";
const HALLADOS_VISTOS = 40; // de lo encontrado, cuántos se enseñan (filtrando se llega al resto)
const MALLA_CADA_TXT = { 15: "15 minutos", 30: "30 minutos", 60: "1 hora", 180: "3 horas" };
const CADUCA_TXT = { 0: "Si deja de llegar, mandar el último", 60: "No mandarlo si lleva 1 h sin llegar", 180: "No mandarlo si lleva 3 h sin llegar", 720: "No mandarlo si lleva 12 h sin llegar", 1440: "No mandarlo si lleva 24 h sin llegar" };
const nom = (n) => n?.alias || n?.long || ""; // el nombre que se ve: el de Vigía, o el de Meshtastic
const panelCfg = (num) => S.paneles?.paneles?.[num] || null;
/** Para un dato nuevo: el broker que no es el de este servidor (de momento, el de HA) o el que haya. */
const brokerPorDefecto = () => { const b = mqttBrokers(); return (b.find((x) => !x.local) || b[0])?.id || ""; };
function brokerOpts(sel) {
  const b = mqttBrokers();
  let o = b.map((x) => `<option value="${esc(x.id)}"${x.id === sel ? " selected" : ""}>${esc(x.nombre)}</option>`).join("");
  if (sel && !b.some((x) => x.id === sel)) o += `<option value="${esc(sel)}" selected>(broker quitado)</option>`;
  return o || `<option value="">Añade un broker en Ajustes → MQTT</option>`;
}

/* ── nombre ── */
function nombreSection(num) {
  const n = node(num);
  const sinNodo = num < 0;
  const tipos = sinNodo ? `<div class="set-row"><label for="pnTipo">Qué es</label><select id="pnTipo" class="inp sel">${Object.entries(TIPOS_PANEL).map(([k, t]) => `<option value="${k}"${n.tipoPanel === k ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select></div>` : "";
  return `<section class="blk" id="nomBox"><h3>Nombre</h3>
      <div class="pn-f"><input id="pnNombre" class="inp" autocomplete="off" maxlength="40" value="${esc(sinNodo ? n.long : n.alias || "")}" placeholder="${esc(sinNodo ? "Nombre del panel" : n.long)}" aria-label="Nombre en Vigía"><button type="button" class="btn ghost" data-pn-nombre="${num}">Guardar</button></div>
      ${tipos}
      <p class="hint">${sinNodo ? "Es el nombre con el que sale en el tablero, en las alarmas y en los avisos por la malla." : `Su nombre en Meshtastic es «${esc(n.long)}». Aquí puedes ponerle otro, solo para Vigía (tablero, alarmas, avisos por la malla y Home Assistant). Vacío, vuelve al suyo.`}</p>
      <p class="form-err" id="pnErr" role="alert" hidden></p>
    </section>`;
}

/* ── datos por MQTT ── */
function datosCfg(num) {
  if (datBorrador?.num === num) return datBorrador.datos;
  const datos = (panelCfg(num)?.datos || []).map((d) => ({ ...d }));
  return datos.length ? datos : [datoNuevo(num)]; // sin datos, una fila vacía: que se vea dónde va el tema
}
/** El tema de conexión de un panel sin nodo (vacío si no tiene). */
function conexionCfg(num) {
  if (datBorrador?.num === num) return datBorrador.conexion;
  const c = panelCfg(num)?.conexion;
  return c ? { ...c } : { broker: brokerPorDefecto(), tema: "", campo: "", avisar: true };
}
function datosEditar(num) {
  if (datBorrador?.num !== num) datBorrador = { num, datos: datosCfg(num), conexion: conexionCfg(num) };
  return datBorrador.datos;
}
function conexionEditar(num) {
  datosEditar(num);
  return datBorrador.conexion;
}
const datoMismo = (a, b) => a && b && a.clave === b.clave && a.tipo === b.tipo && a.broker === b.broker && a.tema === b.tema && a.campo === b.campo && (a.unidad || "") === (b.unidad || "") && !!a.invertir === !!b.invertir;
const datoNuevo = (num, tipo = "temperature") => ({ nombre: "", tipo, broker: brokerPorDefecto(), tema: "", campo: "", unidad: unidades(tipo)[0] || "", caduca: 0, malla: false });
/** El último valor de un dato, si es el que está guardado (si se está cambiando, aún no hay). */
function datoValorHTML(num, d) {
  const g = (panelCfg(num)?.datos || []).find((x) => x.clave === d.clave);
  if (!d.clave || !datoMismo(d, g)) return d.tema ? "Guarda para ver lo que llega." : "";
  const x = S.paneles?.valores?.[d.clave];
  if (!x) return "Aún no ha llegado nada a ese tema.";
  const cuando = esc(ago(x.t));
  if (x.error) return `<span class="warn-t">${esc(x.error)}</span> · ${cuando}`;
  if (x.nulo) return `<span class="warn-t">No disponible</span> (el sensor no responde) · ${cuando}`;
  return `<strong>${esc(textoDato(d, x.v))}</strong>${x.u ? ` (${esc(fmtNum(x.b, 1))} ${esc(x.u)})` : ""} · ${cuando}`;
}
function datoHTML(num, d, i) {
  const receptor = num === S.myNode;
  const tipos = LISTA_TIPOS.map((t) => `<option value="${t}"${t === d.tipo ? " selected" : ""}>${esc(TIPOS[t].label)}</option>`).join("");
  const us = unidades(d.tipo);
  const estado = esEstado(d.tipo);
  const unidad = estado ? "" : d.tipo === "otro"
    ? `<input class="inp dat-u" data-dat-i="${i}" data-dat-k="unidad" autocomplete="off" maxlength="12" placeholder="unidad" aria-label="Unidad" value="${esc(d.unidad || "")}">`
    : us.length > 1
      ? `<select class="inp sel" data-dat-i="${i}" data-dat-k="unidad" aria-label="Unidad en que llega">${us.map((u) => `<option${u === (d.unidad || us[0]) ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>`
      : `<span class="est-u">${esc(us[0])}</span>`;
  const malla = receptor && tipoMalla(d.tipo)
    ? `<div class="dat-m"><label class="sw" for="datM${i}"><input type="checkbox" id="datM${i}" data-dat-i="${i}" data-dat-k="malla" ${d.malla ? "checked" : ""}><span class="sw-ui"></span><span>A la malla</span></label>
        ${d.malla ? `<select class="inp sel" data-dat-i="${i}" data-dat-k="caduca" aria-label="Si deja de llegar">${Object.entries(CADUCA_TXT).map(([k, t]) => `<option value="${k}"${Number(k) === (d.caduca || 0) ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>` : ""}</div>`
    : "";
  return `<div class="est-d">
      <div class="est-r"><select class="inp sel" data-dat-i="${i}" data-dat-k="tipo" aria-label="Qué tipo de dato es">${tipos}</select><button type="button" class="mini" data-dat-del="${i}">Quitar</button></div>
      <input class="inp" data-dat-i="${i}" data-dat-k="nombre" autocomplete="off" maxlength="40" placeholder="Nombre: ${esc(TIPOS[d.tipo].label)}" aria-label="Nombre del dato" value="${esc(d.nombre || "")}">
      <select class="inp sel" data-dat-i="${i}" data-dat-k="broker" aria-label="Broker MQTT">${brokerOpts(d.broker)}</select>
      <input class="inp" data-dat-i="${i}" data-dat-k="tema" list="temasMqtt" autocomplete="off" spellcheck="false" placeholder="Tema MQTT, p. ej. tele/enchufe/SENSOR" aria-label="Tema MQTT" value="${esc(d.tema || "")}">
      <div class="est-r"><input class="inp" data-dat-i="${i}" data-dat-k="campo" list="camposMqtt${i}" autocomplete="off" spellcheck="false" placeholder="Campo, si llega un JSON" aria-label="Campo del JSON" value="${esc(d.campo || "")}">${unidad}</div>
      ${estado ? `<div class="est-r"><select class="inp sel" data-dat-i="${i}" data-dat-k="nombres" aria-label="Cómo se llaman sus estados">${Object.entries(NOMBRES_ESTADO).map(([k, [on, off]]) => `<option value="${k}"${k === (d.nombres || "encendido") ? " selected" : ""}>${esc(on)} / ${esc(off)}</option>`).join("")}</select>
        <label class="sw" for="datR${i}"><input type="checkbox" id="datR${i}" data-dat-i="${i}" data-dat-k="invertir" ${d.invertir ? "checked" : ""}><span class="sw-ui"></span><span>Al revés</span></label></div>
      ${ordenHTML(d, i)}` : ""}
      ${malla}
      <p class="hint" data-dat-v="${i}">${datoValorHTML(num, d)}</p>
      <datalist id="camposMqtt${i}">${camposOpts(d.tema)}</datalist>
    </div>`;
}
/** Encender y apagar un estado desde Vigía: el tema de las órdenes y el mensaje de cada una. */
function ordenHTML(d, i) {
  const [on, off] = NOMBRES_ESTADO[d.nombres || "encendido"] || NOMBRES_ESTADO.encendido;
  const o = d.orden;
  return `<label class="sw" for="datO${i}"><input type="checkbox" id="datO${i}" data-dat-i="${i}" data-dat-k="control" ${o ? "checked" : ""}><span class="sw-ui"></span><span>Encender y apagar desde Vigía</span></label>
    ${o ? `<input class="inp" data-dat-i="${i}" data-dat-k="ordenTema" autocomplete="off" spellcheck="false" placeholder="Tema de las órdenes, p. ej. cmnd/enchufe/POWER" aria-label="Tema al que se mandan las órdenes" value="${esc(o.tema || "")}">
      <div class="est-r"><input class="inp" data-dat-i="${i}" data-dat-k="ordenOn" autocomplete="off" spellcheck="false" placeholder="Mensaje para «${esc(on)}»" aria-label="Mensaje para ${esc(on)}" value="${esc(o.on || "")}"><input class="inp" data-dat-i="${i}" data-dat-k="ordenOff" autocomplete="off" spellcheck="false" placeholder="Mensaje para «${esc(off)}»" aria-label="Mensaje para ${esc(off)}" value="${esc(o.off || "")}"></div>
      <p class="hint">Primero el mensaje para «${esc(on)}», después el de «${esc(off)}». Shelly (Plus, Pro, Gen3): …/command/switch:0, on y off. Tasmota: cmnd/…/POWER, ON y OFF. zigbee2mqtt: zigbee2mqtt/…/set, {"state":"ON"} y {"state":"OFF"}. Home Assistant no recibe órdenes por mqtt_statestream. Sin confirmación: se pulsa y se manda.</p>` : ""}`;
}

/** Nombre corto de un tema encontrado: de «ha_estados/sensor/entidad/state», la entidad; y el campo si es un JSON. */
function nombreHallado(x) {
  const p = x.tema.split("/").filter((q) => q && q !== "state");
  let n = p.length > 1 ? p.at(-1) : x.tema;
  if (n.length > 44) n = `…${n.slice(-43)}`;
  return x.campo ? `${n} · ${x.campo}` : n;
}
/** Qué parece lo encontrado: un tipo de dato, un estado o la conexión del dispositivo. */
const pareceTxt = (x, m) => (x.conexion ? "parece la conexión del dispositivo" : x.estado ? "parece un estado ON/OFF" : m ? `parece ${TIPOS[m].label.toLowerCase()}` : "");
/** Lo encontrado al buscar, filtrado, con lo que parece cada uno y un botón para usarlo. */
function halladosHTML(num) {
  if (!temasHallados.length) return "";
  const f = filtroTemas.trim().toLowerCase();
  const lista = temasHallados.map((x, i) => ({ x, i, m: x.estado ? "estado" : adivinarTipo(x.tema, x.campo) }))
    .filter(({ x }) => !f || `${x.tema} ${x.campo}`.toLowerCase().includes(f))
    .sort((a, b) => (a.m ? 0 : 1) - (b.m ? 0 : 1)); // primero lo que parece algo conocido
  const usados = new Set(datosCfg(num).map((d) => `${d.broker}\n${d.tema}\n${d.campo}`));
  const con = num < 0 ? conexionCfg(num) : null;
  if (con?.tema) usados.add(`${con.broker}\n${con.tema}\n${con.campo || ""}`);
  const varios = new Set(temasHallados.map((x) => x.broker)).size > 1;
  const boton = (x, i) => (usados.has(`${x.broker}\n${x.tema}\n${x.campo}`) ? `<span class="hint">ya está</span>`
    : x.conexion && num < 0 ? `<button type="button" class="mini" data-con-usar="${i}">Usar como conexión</button>`
      : `<button type="button" class="mini" data-dat-usar="${i}">Usar</button>`);
  const filas = lista.slice(0, HALLADOS_VISTOS).map(({ x, i, m }) => `<li><div class="est-hn"><span class="est-ht" title="${esc(x.tema)}${x.campo ? ` · ${esc(x.campo)}` : ""}">${esc(nombreHallado(x))}</span>
      <span class="hint">${esc(String(x.v))}${x.unidad ? ` ${esc(x.unidad)}` : ""}${pareceTxt(x, m) ? ` · ${esc(pareceTxt(x, m))}` : ""}${varios ? ` · en ${esc(nombreBroker(x.broker))}` : ""}</span></div>
      ${boton(x, i)}</li>`).join("");
  const mas = lista.length > HALLADOS_VISTOS ? `<p class="hint">Y ${lista.length - HALLADOS_VISTOS} más: escribe arriba para filtrar.</p>` : "";
  return `<input id="filtroTemas" class="inp" autocomplete="off" spellcheck="false" placeholder="Filtrar, p. ej. enchufe o temperature" aria-label="Filtrar lo encontrado" value="${esc(filtroTemas)}">
    ${lista.length ? `<ul class="est-hl">${filas}</ul>${mas}` : `<p class="hint">Nada con «${esc(filtroTemas)}».</p>`}`;
}
function temasOpts() {
  const por = new Map();
  for (const x of temasHallados) { if (!por.has(x.tema)) por.set(x.tema, []); por.get(x.tema).push(x); }
  return [...por].map(([t, xs]) => `<option value="${esc(t)}" label="${esc((xs.length === 1 && !xs[0].campo ? String(xs[0].v) : `JSON: ${xs.map((x) => x.campo).join(", ")}`).slice(0, 80))}"></option>`).join("");
}
const camposOpts = (tema) => temasHallados.filter((x) => x.tema === tema && x.campo).map((x) => `<option value="${esc(x.campo)}" label="${esc(String(x.v))}"></option>`).join("");
const datosFirma = (num) => JSON.stringify([panelCfg(num)?.datos || [], panelCfg(num)?.conexion || null, mqttBrokers().map((b) => [b.id, b.nombre]), num === S.myNode]);
const ENCONTRADOS = (n) => `Encontrados ${n} con números o estados. Pulsa «Usar» en los que quieras.`;
/** Lo último que dijo el tema de conexión (si es el guardado). */
function conexionValorHTML(num) {
  const c = conexionCfg(num), g = panelCfg(num)?.conexion;
  if (!c.tema.trim()) return "";
  if (!g || g.broker !== c.broker || g.tema !== c.tema.trim() || (g.campo || "") !== (c.campo || "").trim()) return "Guarda para ver lo que dice.";
  const x = S.paneles?.conexion?.[num];
  if (!x) return "Aún no ha dicho nada (no todos lo dejan guardado en el broker: espera a que se conecte o se desconecte).";
  const cuando = esc(ago(x.t));
  if (x.error) return `<span class="warn-t">${esc(x.error)}</span> · ${cuando}`;
  if (x.nulo) return `<span class="warn-t">No disponible</span> · ${cuando}`;
  return `${x.v ? `<strong class="okt">Conectado</strong>` : `<strong class="warn-t">Desconectado</strong>`} · ${cuando}`;
}
function conexionHTML(num) {
  const c = conexionCfg(num);
  return `<div class="con-b" id="conBox"><h4>Conexión del dispositivo</h4>
      <p class="hint">Opcional: el tema donde dice si está conectado. Tasmota: tele/…/LWT; Shelly: …/online; zigbee2mqtt: zigbee2mqtt/…/availability (campo state). Así el panel sabe al momento si se desconecta.</p>
      <select class="inp sel" data-con-k="broker" aria-label="Broker del tema de conexión">${brokerOpts(c.broker)}</select>
      <div class="est-r"><input class="inp" data-con-k="tema" list="temasMqtt" autocomplete="off" spellcheck="false" placeholder="Tema, p. ej. tele/enchufe/LWT" aria-label="Tema de conexión" value="${esc(c.tema || "")}"><input class="inp con-c" data-con-k="campo" autocomplete="off" spellcheck="false" placeholder="Campo" aria-label="Campo del JSON de conexión" value="${esc(c.campo || "")}"></div>
      <label class="sw" for="conAv"><input type="checkbox" id="conAv" data-con-k="avisar" ${c.avisar ? "checked" : ""}><span class="sw-ui"></span><span>Avisar si se desconecta</span></label>
      <p class="hint" id="conV">${conexionValorHTML(num)}</p>
    </div>`;
}
function datosSection(num) {
  const datos = datosCfg(num);
  const receptor = num === S.myNode;
  return `<section class="blk" id="datBox" data-cfg="${esc(datosFirma(num))}"><h3>Datos por MQTT</h3>
      <p class="hint">${num < 0 ? "Lo que publica el dispositivo en un broker MQTT." : "Datos de otros dispositivos que quieras ver en este panel, junto a los del nodo."} Números (una lectura por minuto como mucho) y estados ON/OFF (cada cambio), con sus gráficas y sus alarmas.${receptor ? " Los marcados «A la malla» salen además como telemetría de este receptor (abajo, cada cuánto)." : ""}</p>
      <div id="datLista">${datos.map((d, i) => datoHTML(num, d, i)).join("")}</div>
      ${num < 0 ? conexionHTML(num) : ""}
      <div class="btns"><button type="button" class="btn ghost" data-dat-add>Añadir dato</button><button type="button" class="btn ghost" data-dat-buscar>Buscar temas</button></div>
      <p class="hint" id="datBusca">${temasHallados.length ? ENCONTRADOS(temasHallados.length) : "«Buscar temas» enseña lo que publican los brokers con números o estados (ON/OFF), para elegirlo sin escribir el tema."}</p>
      <div id="datHallados" class="est-h">${halladosHTML(num)}</div>
      <datalist id="temasMqtt">${temasOpts()}</datalist>
      <p class="form-err" id="datErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-dat-save>Guardar los datos</button></div>
      <details class="mq-adv"><summary>Cómo sacar los datos de Home Assistant</summary>
        <p class="hint">Home Assistant no publica por MQTT sus sensores por su cuenta. Añade esto a configuration.yaml con los tuyos y reinícialo:</p>
        <pre class="est-pre">mqtt_statestream:
  base_topic: ha_estados
  publish_attributes: true
  include:
    entities:
      - sensor.estacion_temperatura
      - sensor.estacion_humedad</pre>
        <p class="hint">Cada sensor sale en «ha_estados/sensor/…/state» (y su unidad, en «…/unit_of_measurement»). Pulsa «Buscar temas» y elígelos. No incluyas los sensores «Vigía · …»: Vigía los rechaza, porque volvería a recibir lo que ya publica él.</p>
      </details>
    </section>`;
}
function renderDatos(num) {
  const box = $("#datBox");
  if (box) box.outerHTML = datosSection(num);
}
/** Pone un tema encontrado en la lista: el tipo que parece por el nombre, en la fila vacía si la hay. */
function datUsar(num, i) {
  const x = temasHallados[i];
  if (!x) return;
  const datos = datosEditar(num);
  const tipo = x.estado ? "estado" : adivinarTipo(x.tema, x.campo) || "otro";
  let d = datos.find((y) => !y.tema.trim());
  if (!d) { d = datoNuevo(num, tipo); datos.push(d); }
  if (tipo === "estado") {
    Object.assign(d, { tipo, broker: x.broker, tema: x.tema, campo: x.campo, unidad: "", malla: false, ...adivinarEstado(x.tema, x.campo) });
    renderDatos(num);
    const [on, off] = NOMBRES_ESTADO[d.nombres];
    return toast(`Añadido como estado «${on} / ${off}»${d.invertir ? ", al revés (en zigbee2mqtt, «contact» es true con la puerta cerrada)" : ""}. Cámbialo en su fila si no es así.`);
  }
  const us = unidades(tipo);
  const unidad = tipo === "otro" ? x.unidad || "" : unidadDe(tipo, x.unidad) || (us.includes("km/h") ? "km/h" : us[0]); // el viento en Home Assistant suele ir en km/h
  // En el receptor, a la malla si cabe y no hay ya otro de ese tipo.
  const malla = num === S.myNode && tipoMalla(tipo) && !datos.some((y) => y !== d && y.malla && y.tipo === tipo);
  Object.assign(d, { tipo, broker: x.broker, tema: x.tema, campo: x.campo, unidad, malla });
  delete d.nombres;
  delete d.invertir;
  renderDatos(num);
  const ojo = !x.unidad && tipo !== "otro" && unidad !== us[0] ? ` en ${unidad}: comprueba que llega en esa unidad` : "";
  toast(tipo === "otro" ? "Añadido como «Otro número»: elige qué es en su fila." : `Añadido como «${TIPOS[tipo].label}»${ojo}.`);
}
/** Pone un tema encontrado como el de conexión del panel. */
function conUsar(num, i) {
  const x = temasHallados[i];
  if (!x) return;
  Object.assign(conexionEditar(num), { broker: x.broker, tema: x.tema, campo: x.campo });
  renderDatos(num);
  toast("Puesto como tema de conexión. Guarda los datos para usarlo.");
}
async function guardarDatos(num) {
  const datos = datosCfg(num).filter((d) => d.tema.trim()).map((d) => ({ ...(d.clave ? { clave: d.clave } : {}), nombre: d.nombre || "", tipo: d.tipo, broker: d.broker || "", tema: d.tema, campo: d.campo || "", unidad: d.unidad || "", caduca: Number(d.caduca || 0), malla: !!d.malla,
    ...(esEstado(d.tipo) ? { nombres: d.nombres || "encendido", invertir: !!d.invertir, orden: d.orden ? { tema: d.orden.tema || "", on: d.orden.on || "", off: d.orden.off || "" } : null } : {}) }));
  const c = num < 0 ? conexionCfg(num) : null;
  const conexion = c?.tema.trim() ? { broker: c.broker || "", tema: c.tema.trim(), campo: (c.campo || "").trim(), avisar: !!c.avisar } : null;
  const res = await orden({ orden: "datosPanel", num, datos, ...(num < 0 ? { conexion } : {}) });
  if (!res.ok) return showErr($("#datErr"), res.error || "No se pudo guardar.");
  datBorrador = null;
  toast(res.toast);
  renderDatos(num);
}
async function buscarTemas(btn, num) {
  btn.disabled = true;
  btn.textContent = "Buscando…";
  const res = await orden({ orden: "buscarTemas" });
  btn.disabled = false;
  btn.textContent = "Buscar temas";
  if (!res.ok) return showErr($("#datErr"), res.error || "No se pudo buscar.");
  temasHallados = res.temas || [];
  $("#datErr").hidden = true;
  $("#temasMqtt").innerHTML = temasOpts();
  datosCfg(num).forEach((d, i) => { const dl = $(`#camposMqtt${i}`); if (dl) dl.innerHTML = camposOpts(d.tema); });
  $("#datBusca").textContent = temasHallados.length ? ENCONTRADOS(temasHallados.length) : "No ha llegado ningún tema con números ni estados. ¿Publica algo el broker? (Con Home Assistant, mira «Cómo sacar los datos».)";
  $("#datHallados").innerHTML = halladosHTML(num);
}
/** Un cambio en un dato: al borrador. */
function editarDato(num, t) {
  const k = t.dataset.datK;
  const d = datosEditar(num)[Number(t.dataset.datI)];
  if (!k || !d) return;
  if (k === "control") { // encender y apagar desde Vigía: con lo que suele usar ese dispositivo, si se sabe
    d.orden = t.checked ? proponerOrden(d.tema, d.campo) || { tema: "", on: "ON", off: "OFF" } : null;
    return renderDatos(num);
  }
  if (k === "ordenTema" || k === "ordenOn" || k === "ordenOff") {
    d.orden ||= { tema: "", on: "", off: "" };
    d.orden[{ ordenTema: "tema", ordenOn: "on", ordenOff: "off" }[k]] = t.value;
    return;
  }
  d[k] = k === "caduca" ? Number(t.value) : k === "malla" || k === "invertir" ? t.checked : t.value;
  if (k === "tipo") {
    d.unidad = unidades(d.tipo)[0] || "";
    if (!(num === S.myNode && tipoMalla(d.tipo))) d.malla = false;
    if (esEstado(d.tipo)) { d.nombres ||= "encendido"; d.invertir = !!d.invertir; } else d.orden = null;
    renderDatos(num);
  }
  if (k === "malla") renderDatos(num);
  if (k === "tema") { const dl = $(`#camposMqtt${t.dataset.datI}`); if (dl) dl.innerHTML = camposOpts(d.tema.trim()); }
}

/** Un cambio en el tema de conexión: al borrador. */
function editarConexion(num, t) {
  const k = t.dataset.conK;
  const c = conexionEditar(num);
  if (!k) return;
  c[k] = k === "avisar" ? t.checked : t.value;
}

/* ── a la malla (panel del receptor) ── */
function mallaCfg() {
  const m = S.paneles?.malla || {};
  return mallaBorrador || { activado: !!m.activado, cada: m.cada || 30, canal: m.canal ?? 0, saltos: m.saltos ?? null };
}
function mallaEstadoHTML() {
  const m = S.paneles?.malla;
  if (!m) return "";
  const out = [];
  if (!(panelCfg(S.myNode)?.datos || []).some((d) => d.malla)) out.push("Ningún dato marcado «A la malla» (arriba).");
  if (!m.activado) out.push("Apagado: no se manda nada a la malla.");
  else if (m.proximo) {
    out.push(`Próximo envío a las ${esc(hhmm.format(new Date(m.proximo)))}: ${m.previo?.texto ? `«${esc(m.previo.texto)}»` : "de momento, nada al día"}.`);
    if (m.previo?.faltan?.length) out.push(`<span class="warn-t">Sin</span> ${esc(m.previo.faltan.join(", "))}.`);
  }
  const u = m.ultimo;
  if (u) {
    const cls = u.ok === true ? "okt" : u.ok === false ? "warn-t" : "";
    out.push(`Último${u.manual ? " (a mano)" : ""}, a las ${esc(hhmm.format(new Date(u.t)))}${u.texto ? `: «${esc(u.texto)}» → ${esc(u.destino)}` : ""}: <strong class="${cls}">${esc(u.resultado)}</strong>.`);
  }
  return out.join("<br>");
}
const mallaFirma = () => JSON.stringify([S.paneles?.malla?.activado, S.paneles?.malla?.cada, S.paneles?.malla?.canal, S.paneles?.malla?.saltos, S.channels.map((c) => c.index)]);
function mallaSection() {
  const c = mallaCfg();
  const chs = S.channels;
  let chOpts = chs.map((ch) => `<option value="${ch.index}"${c.canal === ch.index ? " selected" : ""}>${ch.index} · ${esc(ch.name)}${ch.private ? "" : " — público"}</option>`).join("");
  if (c.canal != null && !chs.some((ch) => ch.index === c.canal)) chOpts += `<option value="${c.canal}" selected>Canal ${c.canal} (no está en el receptor)</option>`;
  const sel = chs.find((ch) => ch.index === c.canal);
  const chHint = !chs.length ? `<p class="hint">Conecta el receptor para ver sus canales.</p>`
    : sel && !sel.private ? `<p class="hint">Es un canal público (${esc(sel.why)}): lo verá cualquiera en la malla y puede acabar en los mapas de internet. Para una estación del barrio puede tener sentido; para datos de casa, mejor uno privado.</p>` : "";
  const hop = S.lora?.hopLimit;
  const hopOpts = [`<option value=""${c.saltos == null ? " selected" : ""}>Los del receptor${hop ? ` (${hop})` : ""}</option>`]
    .concat(Array.from({ length: MALLA_MAX_SALTOS }, (_, j) => j + 1).map((n) => `<option value="${n}"${c.saltos === n ? " selected" : ""}>${n}</option>`)).join("");
  return `<section class="blk" id="mallaBox" data-cfg="${esc(mallaFirma())}"><h3>Mandar a la malla</h3>
      <p class="hint">Los datos marcados «A la malla» salen como telemetría de ambiente de este receptor, como si tuviera esos sensores. Uno de cada tipo: la telemetría no lleva nombres, solo un hueco para cada dato.</p>
      <div class="set-row"><label class="sw" for="mallaOn"><input type="checkbox" id="mallaOn" ${c.activado ? "checked" : ""}><span class="sw-ui"></span><span>Mandarlos a la malla</span></label></div>
      <div class="set-row"><label for="mallaCada">Cada</label><select id="mallaCada" class="inp sel">${Object.entries(MALLA_CADA_TXT).map(([k, t]) => `<option value="${k}"${Number(k) === c.cada ? " selected" : ""}>${t}</option>`).join("")}</select></div>
      <div class="set-row"><label for="mallaCh">Por el canal</label><select id="mallaCh" class="inp sel">${chOpts || `<option value="">—</option>`}</select></div>
      ${chHint}
      <div class="set-row"><label for="mallaHop">Saltos</label><select id="mallaHop" class="inp sel">${hopOpts}</select></div>
      <p class="form-err" id="mallaErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-malla-save>Guardar</button><button type="button" class="btn ghost" data-malla-send>Enviar ahora</button></div>
      <p class="hint" id="mallaEstado">${mallaEstadoHTML()}</p>
    </section>`;
}
function renderMalla() {
  const box = $("#mallaBox");
  if (box) box.outerHTML = mallaSection();
}
async function guardarMalla() {
  const c = mallaCfg();
  const res = await orden({ orden: "envioMalla", cambio: { activado: !!c.activado, cada: Number(c.cada), canal: c.canal, saltos: c.saltos } });
  if (!res.ok) return showErr($("#mallaErr"), res.error || "No se pudo guardar.");
  mallaBorrador = null;
  toast(res.toast);
  renderMalla();
}
function editarMalla(t) {
  const c = (mallaBorrador ||= mallaCfg());
  if (t.id === "mallaOn") c.activado = t.checked;
  if (t.id === "mallaCada") c.cada = Number(t.value);
  if (t.id === "mallaCh") c.canal = t.value === "" ? null : Number(t.value);
  if (t.id === "mallaHop") c.saltos = t.value === "" ? null : Number(t.value);
}

/** Lo que llega del servidor (valores, configuración): sin pisar lo que se está escribiendo. */
function patchPaneles() {
  const num = S.detail?.num;
  if (num == null || !$("#detail").open) return;
  const dat = $("#datBox");
  if (dat) {
    if (!datBorrador && !dat.contains(document.activeElement) && dat.dataset.cfg !== datosFirma(num)) renderDatos(num);
    else {
      datosCfg(num).forEach((d, i) => { const el = dat.querySelector(`[data-dat-v="${i}"]`); if (el) el.innerHTML = datoValorHTML(num, d); });
      const cv = $("#conV");
      if (cv) cv.innerHTML = conexionValorHTML(num);
    }
  }
  const mal = $("#mallaBox");
  if (mal) {
    if (!mallaBorrador && !mal.contains(document.activeElement) && mal.dataset.cfg !== mallaFirma()) renderMalla();
    else $("#mallaEstado").innerHTML = mallaEstadoHTML();
  }
}

/* ── paneles nuevos (sin nodo) ── */
function nuevoPanel() {
  S.detail = null;
  $("#detail").innerHTML = `<div class="sheet-h"><span class="tag">MQTT</span><div class="sheet-t"><h2>Panel nuevo</h2><p class="meta">Para un dispositivo que publica por MQTT (Shelly, Tasmota, Zigbee…)</p></div><button class="icon-btn" data-close aria-label="Cerrar">${ICON.close}</button></div>
    <div class="sheet-b"><section class="blk">
      <div class="mq-f"><label for="npNombre">Nombre</label><input id="npNombre" class="inp" autocomplete="off" maxlength="40" placeholder="Enchufe del taller">
      <label for="npTipo">Qué es</label><select id="npTipo" class="inp sel">${Object.entries(TIPOS_PANEL).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join("")}</select></div>
      <p class="form-err" id="npErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-panel-crear>Crear el panel</button></div>
      <p class="hint">Después, en su ficha, añades sus datos: el broker, el tema y el campo de cada uno (con «Buscar temas» no hace falta escribirlos).</p>
    </section></div>`;
  const d = $("#detail");
  if (!d.open) d.showModal();
  $("#npNombre").focus();
}
async function crearPanel() {
  const res = await orden({ orden: "crearPanel", nombre: $("#npNombre").value, tipo: $("#npTipo").value });
  if (!res.ok) return showErr($("#npErr"), res.error || "No se pudo crear.");
  // Que llegue del servidor antes de abrir su ficha.
  for (let i = 0; i < 40 && !(S.nodes.has(res.num) && S.cfg.watched[res.num]); i++) await new Promise((r) => setTimeout(r, 50));
  toast(res.toast);
  render();
  if (!S.nodes.has(res.num)) return $("#detail").close();
  openDetail(res.num);
  $("#datBox")?.scrollIntoView({ block: "start" });
}

function meshSection() {
  const cfg = meshCfg();
  const chs = S.channels;
  const chOpts = [`<option value=""${cfg.channel == null ? " selected" : ""}>Ninguno</option>`]
    .concat(chs.map((c) => `<option value="${c.index}"${c.private ? "" : " disabled"}${cfg.channel === c.index ? " selected" : ""}>${c.index} · ${esc(c.name)}${c.private ? "" : " — público"}</option>`)).join("");
  const nodes = [...S.nodes.values()].filter((n) => n.num !== S.myNode && n.num >= 0).sort((a, b) => nom(a).localeCompare(nom(b), "es"));
  const pki = receptorUsesPki();
  const nodeOpts = [`<option value=""${cfg.node == null ? " selected" : ""}>Ninguno</option>`]
    .concat(nodes.map((n) => `<option value="${n.num}"${cfg.node === n.num ? " selected" : ""}>${esc(nom(n))} (${esc(n.short)})${pki && n.key === false ? " — sin clave" : ""}</option>`)).join("");
  let chHint = "";
  if (!chs.length) chHint = `<p class="hint">Conecta el receptor para ver sus canales.</p>`;
  const pub = chs.filter((c) => !c.private);
  if (chs.length && pub.length) chHint = `<p class="hint">Bloqueados por públicos: ${pub.map((c) => `${esc(c.name)} (${esc(c.why)})`).join(", ")}.</p>`;
  if (chs.length && !chs.some((c) => c.private)) chHint += `<p class="warn-t">Tu receptor no tiene ningún canal privado. Crea uno en la app de Meshtastic con una clave aleatoria y compártelo (con su código QR) con quien deba recibir los avisos.</p>`;
  const sel = cfg.channel != null ? chs.find((c) => c.index === cfg.channel) : null;
  if (sel && !sel.private) chHint += `<p class="warn-t">El canal guardado («${esc(sel.name)}») es público y no se usará.</p>`;
  const nsel = cfg.node != null ? S.nodes.get(cfg.node) : null;
  const nodeHint = nsel && pki && nsel.key === false
    ? `<p class="warn-t">Tu receptor no tiene la clave de ${esc(nom(nsel))}: pide su ficha en su tarjeta o el aviso no saldrá (error 39).</p>` : "";
  return `<section class="blk" id="meshBox"><h3>Avisos por la malla</h3>
      <div class="set-row"><label class="sw" for="meshOn"><input type="checkbox" id="meshOn" ${cfg.enabled ? "checked" : ""}><span class="sw-ui"></span><span>Mandar las alarmas por la malla</span></label></div>
      <div class="set-row"><label for="meshCh">A un canal privado</label><select id="meshCh" class="inp sel">${chOpts}</select></div>
      ${chHint}
      <div class="set-row"><label for="meshNode">A un nodo</label><select id="meshNode" class="inp sel">${nodeOpts}</select></div>
      ${nodeHint}
      <div class="set-row"><label class="sw" for="meshClear"><input type="checkbox" id="meshClear" ${cfg.onClear ? "checked" : ""}><span class="sw-ui"></span><span>Avisar también cuando se resuelve</span></label></div>
      <div class="btns"><button class="btn ghost" data-mesh-test>Enviar mensaje de prueba</button></div>
      <p class="hint" id="meshLast">${meshLastHTML()}</p>
      <p class="hint">Sale un mensaje al saltar cada alarma de umbral, cambio rápido, sin señal o fuera de su sitio: en un canal lo leen todos los que lo tengan; a un nodo, solo él, y se da por entregado cuando ese nodo lo confirma (que un vecino lo repita no basta). Como mucho uno cada 8 s y ${MESH_HOURLY} por hora, para no saturar la malla. ${SERVIDOR ? "Los manda el servidor, aunque no haya ninguna pantalla abierta." : "Solo con Vigía abierta y el receptor conectado."} Los canales públicos están bloqueados porque lo leería cualquiera.</p>
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
function chartSVG(series, metric, rule, from, to, W, H = 132) {
  const pl = 42, pr = 12, pt = 10, pb = 22;
  const ser = series.filter((p) => !(metric === "batteryLevel" && p.v > 100));
  const dom = yDomain(ser, metric, rule);
  if (!dom) return `<p class="empty-chart">Sin lecturas en este periodo.</p>`;
  const [lo, hi] = dom;
  const x = (t) => pl + ((t - from) / (to - from)) * (W - pl - pr);
  const y = (v) => pt + ((hi - v) / (hi - lo)) * (H - pt - pb);
  const m = metricMeta(metric);
  let g = "";
  const st = niceStep(hi - lo, H > 180 ? 5 : 3);
  for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) {
    const yy = y(v).toFixed(1);
    g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}"/><text class="tick" x="${pl - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle">${fmtNum(v, st < 1 ? 1 : 0)}</text>`;
  }
  const span = to - from;
  const xs = span <= 2 * DAY ? (W > 700 ? 3 * HOUR : 6 * HOUR) : span <= 8 * DAY ? DAY : 7 * DAY;
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  if (xs >= DAY) first.setHours(0);
  else first.setHours(Math.ceil(first.getHours() / 6) * 6);
  for (let t = first.getTime(); t <= to; t += xs) {
    if (t < from) continue;
    const xx = x(t).toFixed(1);
    const lab = xs === 7 * DAY ? dShort.format(new Date(t)) : xs === DAY ? wday.format(new Date(t)) : hhmm.format(new Date(t));
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

/* ── estados ON/OFF (servidor): una barra de tiempo en vez de una línea ── */
/**
 * Tramos de un estado entre from y to: [{ v, a, b }]. Cada lectura vale hasta la siguiente; la última, hasta ahora.
 * cur: el valor de ahora con su «desde» (los estados que no cambian no tienen lecturas recientes).
 */
function tramosEstado(series, from, to, cur) {
  const pts = [...series];
  if (cur?.desde != null) pts.push({ t: cur.desde, v: cur.v });
  pts.sort((a, b) => a.t - b.t);
  const out = [];
  let v = null, a = from;
  for (const p of pts) {
    if (p.t > to) break;
    if (p.t <= from) { v = p.v; continue; }
    if (v === null) { v = p.v; a = p.t; continue; }
    if (p.v !== v) { out.push({ v, a, b: p.t }); v = p.v; a = p.t; }
  }
  if (v !== null) out.push({ v, a, b: Math.min(to, Date.now()) });
  return out;
}
/** «Encendido 3 h 20 min» en ese periodo. */
function resumenEstado(metric, tramos) {
  const on = tramos.filter((x) => x.v).reduce((s, x) => s + x.b - x.a, 0);
  return tramos.length ? `${metricMeta(metric).estados[0]} en total: ${on && on < MIN ? "menos de 1 min" : dur(on)}` : "";
}
function estadoSVG(tramos, metric, from, to, W, H = 64) {
  if (!tramos.length) return `<p class="empty-chart">Sin lecturas en este periodo.</p>`;
  const m = metricMeta(metric);
  const pl = 8, pr = 12, pt = 6, pb = 22;
  const x = (t) => pl + ((t - from) / (to - from)) * (W - pl - pr);
  let g = "";
  const span = to - from;
  const xs = span <= 2 * DAY ? (W > 700 ? 3 * HOUR : 6 * HOUR) : span <= 8 * DAY ? DAY : 7 * DAY;
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  if (xs >= DAY) first.setHours(0);
  else first.setHours(Math.ceil(first.getHours() / 6) * 6);
  for (let t = first.getTime(); t <= to; t += xs) {
    if (t < from) continue;
    const xx = x(t).toFixed(1);
    const lab = xs === 7 * DAY ? dShort.format(new Date(t)) : xs === DAY ? wday.format(new Date(t)) : hhmm.format(new Date(t));
    g += `<line class="grid v" x1="${xx}" x2="${xx}" y1="${pt}" y2="${H - pb}"/><text class="tick" x="${xx}" y="${H - 6}" text-anchor="middle">${lab}</text>`;
  }
  const bars = tramos.map((s) => `<rect class="eb ${s.v ? "on" : "off"}" x="${x(s.a).toFixed(1)}" y="${pt}" width="${Math.max(1, x(s.b) - x(s.a)).toFixed(1)}" height="${H - pt - pb}"><title>${esc(m.estados[s.v ? 0 : 1])}: ${esc(stamp(s.a))} – ${esc(stamp(s.b))}</title></rect>`).join("");
  return `<svg class="chart-svg est-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.label)}">${bars}${g}</svg>
    <p class="est-ley"><span class="eb-k on"></span>${esc(m.estados[0])} <span class="eb-k off"></span>${esc(m.estados[1])}</p>`;
}
function sparkEstadoHTML(series, metric, cur) {
  const W = 300, H = 46, now = Date.now(), from = now - DAY;
  const tramos = tramosEstado(series, from, now, cur);
  if (!tramos.length) return `<div class="spark spark-empty"><span>Aún sin histórico</span></div>`;
  const x = (t) => ((t - from) / (now - from)) * W;
  return `<div class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${tramos.map((s) => `<rect class="eb ${s.v ? "on" : "off"}" x="${x(s.a).toFixed(1)}" y="8" width="${Math.max(0.5, x(s.b) - x(s.a)).toFixed(1)}" height="${H - 16}"/>`).join("")}</svg></div>`;
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
    if (S.full) refreshFull(null);
    const n = unacked().length;
    document.title = n ? `(${n}) Alarma · Vigía Mesh` : "Vigía Mesh";
  });
}

const ICON = {
  bt: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10-5 4V3l5 4L7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  usb: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v14M12 3l-2.5 3h5L12 3ZM12 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM12 14l-5-3V8M12 12l5-3V7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><rect x="5.5" y="6.5" width="3" height="2" rx=".5" fill="currentColor"/><circle cx="17" cy="6" r="1.4" fill="currentColor"/></svg>`,
  server: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="8" cy="7.25" r="1.1" fill="currentColor"/><circle cx="8" cy="16.75" r="1.1" fill="currentColor"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.4h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4-2-1.6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  grip: `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g></svg>`,
  up: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  down: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const STAGE_TEXT = { gatt: "Buscando el nodo…", service: "Abriendo canal…", notify: "Abriendo canal…", open: "Abriendo el puerto…" };
const LINK_TEXT = {
  idle: "Conectar receptor",
  connecting: "Conectando…",
  configuring: "Leyendo el nodo…",
  ready: "Receptor conectado",
  reconnecting: "Reconectando…",
};

function renderTop() {
  const b = $("#linkBtn");
  if (SERVIDOR) return renderTopServidor(b);
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
  b.innerHTML = `<span class="ld"></span>${!S.demo && linkKind() === "serial" ? ICON.usb : ICON.bt}<span class="lt">${esc(label)}</span>`;
  $("#demoBar").hidden = !S.demo;
}

/** Barra de arriba con servidor: primero, si hay conexión con él; después, cómo está su receptor. */
function renderTopServidor(b) {
  const st = !S.servidorOk ? "reconnecting" : S.link.state;
  let label;
  if (!S.servidorOk) label = "Sin conexión con el servidor";
  else if (st === "ready") label = `${S.nodes.get(S.myNode)?.short || "Receptor"} conectado`;
  else if (st === "configuring") label = S.link.extra?.packets ? `Leyendo el nodo · ${S.link.extra.packets}` : "Leyendo el nodo…";
  else if (st === "reconnecting" || st === "connecting") label = S.trouble?.kind === "unplugged" ? "Receptor desenchufado" : "Receptor sin conexión";
  else label = "Receptor parado";
  b.dataset.state = st;
  b.innerHTML = `<span class="ld"></span>${ICON.server}<span class="lt">${esc(label)}</span>`;
  $("#demoBar").hidden = true;
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
    const unplugged = S.link.state === "idle" && S.device?.kind === "serial" && canSerial() && !S.userIdle;
    const msg = unplugged
      ? `Enchufa el cable de tu receptor (${S.device.name}) y se conectará solo. Mientras tanto ves los últimos datos guardados y no puedo saber si un nodo deja de emitir.`
      : S.link.state === "idle"
      ? "Sin receptor conectado. Mientras tanto ves los últimos datos guardados y no puedo saber si un nodo deja de emitir."
      : "Esperando al receptor. Las alarmas de nodo sin señal están en pausa hasta que vuelva.";
    html += `<div class="notice"><p>${esc(msg)}</p>${S.link.state === "idle" ? `<div class="btns">${connectButtons()}</div>` : ""}</div>`;
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
// Por cable USB, otros fallos y otros remedios.
const TROUBLE_USB = {
  busy: {
    title: "No se puede abrir el puerto",
    lead: "Otro programa tiene abierto el puerto del nodo, o el nodo ya no está enchufado.",
    steps: [
      "Cierra la web o la app de Meshtastic, el flasheador, un monitor serie (Arduino, PlatformIO) o la línea de órdenes de Meshtastic si alguno lo está usando: el puerto solo admite un programa.",
      "Cierra otras pestañas o ventanas de Vigía conectadas por cable.",
      "Desenchufa el cable y vuelve a enchufarlo.",
    ],
  },
  noapi: {
    title: "El nodo no contesta por el cable",
    lead: "El puerto se abre, pero lo que hay al otro lado no contesta como un nodo Meshtastic.",
    steps: [
      "Comprueba que has elegido el puerto del nodo (en Windows, el COM que aparece al enchufarlo).",
      "Si el nodo se acaba de reiniciar al enchufarlo, espera unos segundos: se reintenta solo.",
      "Prueba con otro cable: algunos solo cargan y no llevan datos.",
      "Reinicia el nodo.",
    ],
  },
  lost: {
    title: "Se ha cortado la conexión por cable",
    lead: "El cable se ha soltado, el nodo se ha reiniciado o el ordenador ha apagado el puerto USB.",
    steps: [
      "Revisa el cable y el puerto USB del ordenador; mejor directo al ordenador que por un concentrador.",
      "Al volver a enchufarlo, Vigía se reconecta sola.",
      "En Windows, si pasa a menudo, quita el ahorro de energía del USB (Administrador de dispositivos → Concentrador raíz USB → Administración de energía).",
    ],
  },
};
TROUBLE_USB.other = TROUBLE_USB.lost;

function troubleHTML() {
  if (SERVIDOR) return troubleServidorHTML();
  const tr = S.trouble;
  if (S.demo || !tr || S.otherWindow || S.link.state === "ready") return "";
  const urgent = tr.kind === "pairing" || tr.kind === "service";
  if (!urgent && tr.count < 2) return "";
  const set = tr.link === "serial" ? TROUBLE_USB : TROUBLE;
  const g = set[tr.kind] || set.other;
  const name = tr.name || S.device?.name || "el nodo";
  const steps = g.steps.map((x) => `<li>${esc(x.replace("{name}", name))}</li>`).join("");
  const retry = S.link.state === "idle" ? connectButtons() : `<button class="btn primary" data-retry>Reintentar ahora</button>`;
  return `<div class="trouble" role="status"><h2>${esc(g.title)}</h2><p>${esc(g.lead)} <span class="tr-n">${tr.count === 1 ? "1 intento" : `${tr.count} intentos seguidos`}.</span></p><ol>${steps}</ol><div class="btns">${retry}<button class="btn ghost" data-diag>Ver diagnóstico</button></div></div>`;
}

function troubleServidorHTML() {
  if (!S.servidorOk) return `<div class="trouble" role="status"><h2>Sin conexión con el servidor</h2><p>Esta pantalla no llega al servidor de Vigía. Lo vuelve a intentar sola cada pocos segundos. Mientras tanto, el servidor sigue vigilando.</p><ol><li>Comprueba que este aparato está en la red de casa (o en Tailscale).</li><li>Si el servidor se ha reiniciado, espera un momento.</li></ol></div>`;
  const tr = S.trouble;
  if (!tr || S.link.state === "ready" || tr.count < 2) return "";
  return `<div class="trouble" role="status"><h2>El servidor no conecta con su receptor</h2><p>${esc(tr.detail || tr.kind)}. ${esc(tr.consejo || "")} <span class="tr-n">${tr.count} intentos seguidos.</span></p><div class="btns"><button class="btn primary" data-retry>Reintentar ahora</button><button class="btn ghost" data-diag>Ver diagnóstico</button></div></div>`;
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
    `Bluetooth web: ${navigator.bluetooth ? "sí" : "no"} · getDevices: ${navigator.bluetooth?.getDevices ? "sí" : "no"} · forget: ${typeof BluetoothDevice !== "undefined" && BluetoothDevice.prototype?.forget ? "sí" : "no"} · locks: ${navigator.locks ? "sí" : "no"} · serie web: ${navigator.serial ? "sí" : "no"} · enlace: ${linkKind() === "serial" ? "cable" : "Bluetooth"}`,
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
  if (al.some((a) => a.kind === "high" || a.kind === "low" || a.kind === "trend" || a.kind === "estado")) return ["crit", "Alarma"];
  const n = S.nodes.get(num);
  if (al.some((a) => a.kind === "conexion") || n?.conectado === false) return ["off", "Sin conexión"]; // lo dice el dispositivo
  if (al.some((a) => a.kind === "offline")) return ["off", num < 0 ? "Sin datos" : "Sin señal"];
  if (!n || !n.lastHeard) return ["none", "Sin datos"];
  return ["ok", "Normal"];
}

/** Cuándo se oyó por última vez (en un panel sin nodo, cuándo llegó su último dato por MQTT). */
const vistoTxt = (n) => (n.num < 0
  ? [n.conectado === false ? `desconectado ${ago(n.conectadoT)}` : "", n.lastHeard ? `último dato ${ago(n.lastHeard)}` : "sin datos todavía"].filter(Boolean).join(" · ")
  : n.lastHeard ? `visto ${ago(n.lastHeard)}` : "sin señal registrada");
/** El dato de un panel por su clave (para saber si se puede encender y apagar). */
const datoDe = (num, k) => panelCfg(num)?.datos?.find((d) => d.clave === k) || null;
/**
 * Interruptor de un estado que se puede encender y apagar desde Vigía (servidor): manda la orden al pulsar, sin
 * confirmación; «Enviando…» hasta que el dispositivo dice que lo ha hecho; si no contesta, lo dice.
 */
function interruptorHTML(num, k) {
  if (!SERVIDOR || !datoDe(num, k)?.orden) return "";
  const m = metricMeta(k), cur = S.nodes.get(num)?.metrics?.[k];
  const o = S.paneles?.ordenes?.[k];
  const on = cur?.v === 1;
  const txt = o?.enviando ? "Enviando…" : o?.error ? `${o.error}` : "";
  return `<span class="tgl-w" data-sw="${k}"><button type="button" class="tgl${on ? " on" : ""}${o?.enviando ? " env" : ""}" role="switch" aria-checked="${on}" data-orden="${k}" data-num="${num}"${o?.enviando ? " disabled" : ""} aria-label="${esc(m.label)}: ${esc(m.estados?.[on ? 1 : 0] ? `pasar a ${m.estados[on ? 1 : 0]}` : "cambiar")}"><span class="tgl-ui"></span></button>${txt ? `<span class="tgl-t${o?.error ? " warn-t" : ""}">${esc(txt)}</span>` : ""}</span>`;
}
async function mandarOrden(num, k) {
  const cur = S.nodes.get(num)?.metrics?.[k];
  const res = await orden({ orden: "mandar", num, clave: k, v: cur?.v === 1 ? 0 : 1 });
  if (!res.ok && res.error) toast(res.error);
}
/** Los interruptores de la ficha y de la pantalla completa, al día (sin redibujar lo demás). */
function patchInterruptores() {
  for (const el of $$("[data-sw]")) {
    const box = el.closest("[data-sw-num]");
    if (!box) continue;
    const html = interruptorHTML(Number(box.dataset.swNum), el.dataset.sw);
    if (html && el.outerHTML !== html) el.outerHTML = html;
  }
}

/** Lo que se ve de la alarma de un estado: «avisa: Abierta +10 min». */
const estadoReglaTxt = (k, r) => (r ? `avisa: ${metricMeta(k).estados[r.cuando ? 0 : 1]}${r.min ? ` +${dur(r.min * MIN)}` : ""}` : "");
function metaLine(n) {
  const bits = [vistoTxt(n)];
  if (isNum(n.hops)) bits.push(n.hops === 0 ? "directo" : `${n.hops} ${n.hops === 1 ? "salto" : "saltos"}`);
  if (isNum(n.snr) && n.snr !== 0) bits.push(`SNR ${fmtNum(n.snr, 1)} dB`);
  return bits.join(" · ");
}

/* ───────────── tarjetas de los nodos vigilados ───────────── */
function saveUi() { if (!S.demo) LS.set("vigia.cards", S.ui); }
/** Nodos vigilados en el orden elegido; los que aún no tienen sitio van al final, por nombre. */
function watchedOrder() {
  const pos = new Map(S.ui.order.map((n, i) => [n, i]));
  const at = (n) => (pos.has(n) ? pos.get(n) : Infinity);
  return Object.keys(S.cfg.watched).map(Number)
    .sort((a, b) => at(a) - at(b) || nom(S.nodes.get(a)).localeCompare(nom(S.nodes.get(b)), "es"));
}
/** Batería para la tarjeta contraída: «88 %», «USB» o nada. */
function batteryHTML(num) {
  const b = S.nodes.get(num)?.metrics?.batteryLevel;
  if (!b || !isNum(b.v)) return "";
  const usb = b.v > 100;
  const r = S.cfg.watched[num]?.rules?.batteryLevel || {};
  const low = !usb && ((isNum(r.min) && b.v < r.min) || b.v <= 15);
  const lvl = usb ? 1 : Math.max(0, Math.min(1, b.v / 100));
  const icon = `<svg viewBox="0 0 26 14" aria-hidden="true"><rect x=".75" y=".75" width="21.5" height="12.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="23" y="4.5" width="2.2" height="5" rx="1" fill="currentColor"/><rect x="2.75" y="2.75" width="${(17.5 * lvl).toFixed(1)}" height="8.5" rx="1" fill="currentColor"/></svg>`;
  return `<span class="bat${low ? " low" : ""}" title="Batería">${icon}${usb ? "USB" : `${fmtNum(b.v, 0)} %`}</span>`;
}
function cardHead(num, n, st, stLabel, min) {
  const meta = min ? vistoTxt(n) : metaLine(n);
  return `<header class="card-h"><span class="tag">${esc(n.short)}</span><h3><button type="button" class="name-btn" data-open="${num}" aria-label="Abrir ficha de ${esc(nom(n))}, estado ${stLabel}">${esc(nom(n))}</button></h3><p class="meta">${esc(meta)}${min ? batteryHTML(num) : ""}</p><span class="pill p-${st}">${stLabel}</span><button type="button" class="icon-btn tg" data-card-toggle="${num}" aria-expanded="${!min}" aria-label="${min ? "Expandir" : "Contraer"} ${esc(nom(n))}">${ICON.chevron}</button></header>`;
}

function renderCards() {
  const el = $("#cards");
  const nums = watchedOrder();
  $("#watchCount").textContent = nums.length ? String(nums.length) : "";
  const tools = $("#cardTools");
  tools.hidden = nums.length < 1 && !SERVIDOR;
  const allMin = nums.length > 0 && nums.every((n) => S.ui.collapsed[n]);
  const nuevo = SERVIDOR ? `<button type="button" class="btn ghost sm" data-panel-nuevo>Añadir panel</button>` : "";
  setHTML(tools, S.ordering
    ? `<button type="button" class="btn primary sm" data-order-done>Listo</button>`
    : `${nums.length ? `<button type="button" class="btn ghost sm" data-cards-all>${allMin ? "Expandir todas" : "Contraer todas"}</button>` : ""}${nums.length > 1 ? `<button type="button" class="btn ghost sm" data-order>Ordenar</button>` : ""}${nuevo}`);
  el.classList.toggle("ordering", S.ordering);
  if (!nums.length) {
    setHTML(el, `<div class="empty"><p><strong>Aquí aparecerán tus sensores.</strong> En “Resto de la malla” toca <em>Vigilar</em> en un nodo para fijarlo aquí y ponerle alarmas de umbral y de nodo sin señal.${SERVIDOR ? " Para un dispositivo que publica por MQTT (Shelly, Tasmota, Zigbee…), pulsa <em>Añadir panel</em>." : ""}</p></div>`);
    return;
  }
  if (S.ordering) {
    if (drag) return; // no se repinta mientras se arrastra
    setHTML(el, `<ol class="ord-list" aria-label="Orden de las tarjetas">${nums.map((num, i) => {
      const n = node(num);
      return `<li class="ord-row" data-num="${num}"><span class="ord-pos">${i + 1}</span><span class="tag sm">${esc(n.short)}</span><span class="ord-n">${esc(nom(n))}</span>
        <button type="button" class="icon-btn sm" data-move="${num}" data-dir="-1" aria-label="Subir ${esc(nom(n))}"${i === 0 ? " disabled" : ""}>${ICON.up}</button><button type="button" class="icon-btn sm" data-move="${num}" data-dir="1" aria-label="Bajar ${esc(nom(n))}"${i === nums.length - 1 ? " disabled" : ""}>${ICON.down}</button><span class="ord-grip" data-drag title="Arrastra para mover" aria-hidden="true">${ICON.grip}</span></li>`;
    }).join("")}</ol><p class="hint">Arrastra cada nodo por el asa o usa las flechas. El orden se guarda solo.</p>`);
    return;
  }
  setHTML(el, nums.map((num) => {
    const n = node(num);
    const w = S.cfg.watched[num];
    const [st, stLabel] = nodeState(num);
    if (S.ui.collapsed[num]) return `<article class="card min st-${st}" data-open="${num}">${cardHead(num, n, st, stLabel, true)}</article>`;
    const keys = sortMetrics(Object.keys(n.metrics).filter((k) => !metricMeta(k).minor));
    const readings = keys.map((k) => {
      const m = metricMeta(k), r = (w.rules || {})[k] || {};
      const v = n.metrics[k].v;
      if (m.estados) { // un estado ON/OFF: su nombre, y su aviso o desde cuándo está así
        const bad = S.active.has(estadoKey(num, k));
        const lim = estadoReglaTxt(k, r.estado) || (n.metrics[k].desde ? `desde las ${hhmm.format(new Date(n.metrics[k].desde))}` : "");
        return `<div class="rd${bad ? " bad" : ""}"><span class="rd-l">${esc(m.label)}</span><span class="rd-v est">${esc(fmtValue(k, v))}</span>${interruptorHTML(num, k)}<span class="rd-lim">${esc(lim) || "&nbsp;"}</span></div>`;
      }
      const bad = (isNum(r.max) && v > r.max) || (isNum(r.min) && v < r.min) || S.active.has(trendKey(num, k));
      const lim = [isNum(r.min) ? `mín ${fmtLimit(k, r.min)}` : "", isNum(r.max) ? `máx ${fmtLimit(k, r.max)}` : "", r.trend ? trendShort(k, r.trend) : ""].filter(Boolean).join(" · ");
      const unit = k === "batteryLevel" && v > 100 ? "" : m.unit;
      return `<div class="rd${bad ? " bad" : ""}"><span class="rd-l">${esc(m.label)}</span><span class="rd-v">${fmtValue(k, v)}${unit ? `<small>${esc(unit)}</small>` : ""}</span><span class="rd-lim">${lim || "&nbsp;"}</span></div>`;
    }).join("");
    const sparkMetric = ["temperature", "batteryLevel", "relativeHumidity"].find((k) => n.metrics[k]) || keys.find((k) => !metricMeta(k).estados) || keys[0];
    const fullBtn = `<button type="button" class="mini full-btn" data-full="${num}" title="Ver este nodo a pantalla completa">${ICON.expand}Pantalla completa</button>`;
    const sparkSer = S.recent.get(seriesKey(num, sparkMetric)) || [];
    const spark = sparkMetric
      ? `<div class="spark-wrap"><div class="spark-top"><span class="spark-cap">${esc(metricMeta(sparkMetric).label)} · 24 h</span>${fullBtn}</div>${metricMeta(sparkMetric).estados ? sparkEstadoHTML(sparkSer, sparkMetric, n.metrics[sparkMetric]) : sparkHTML(sparkSer, sparkMetric, (w.rules || {})[sparkMetric])}</div>`
      : `<div class="spark-top">${fullBtn}</div>`;
    return `<article class="card st-${st}" data-open="${num}">
      ${cardHead(num, n, st, stLabel, false)}
      ${readings ? `<div class="rds">${readings}</div>` : `<p class="no-rd">${num < 0 ? "Aún no ha llegado ningún dato. Añádelos en su ficha." : "Este nodo aún no ha mandado telemetría."}</p>`}
      ${n.pos ? `<div class="pos" data-pos-box="${num}">${posBlock(num)}</div>` : ""}
      ${spark}
      ${num < 0 ? "" : `<div class="ask" data-ask-box="${num}">${askBlock(num)}</div>`}
    </article>`;
  }).join(""));
}

function toggleCard(num) {
  if (S.ui.collapsed[num]) delete S.ui.collapsed[num]; else S.ui.collapsed[num] = true;
  saveUi();
  renderCards();
  $(`[data-card-toggle="${num}"]`)?.focus();
}
function toggleAllCards() {
  const nums = watchedOrder();
  const allMin = nums.every((n) => S.ui.collapsed[n]);
  S.ui.collapsed = allMin ? {} : Object.fromEntries(nums.map((n) => [n, true]));
  saveUi();
  renderCards();
}

/* ── ordenar: flechas y arrastre (ratón y dedo) ── */
let drag = null;
function setOrder(nums) {
  S.ui.order = nums;
  saveUi();
}
function moveCard(num, dir) {
  const nums = watchedOrder();
  const i = nums.indexOf(num), j = i + dir;
  if (i < 0 || j < 0 || j >= nums.length) return;
  [nums[i], nums[j]] = [nums[j], nums[i]];
  setOrder(nums);
  renderCards();
  const b = $(`[data-move="${num}"][data-dir="${dir}"]`);
  if (b && !b.disabled) b.focus(); else $(`[data-move="${num}"][data-dir="${-dir}"]`)?.focus();
}
function renumber(list) {
  [...list.children].forEach((row, i, all) => {
    row.querySelector(".ord-pos").textContent = String(i + 1);
    row.querySelector('[data-dir="-1"]').disabled = i === 0;
    row.querySelector('[data-dir="1"]').disabled = i === all.length - 1;
  });
}
document.addEventListener("pointerdown", (ev) => {
  const h = ev.target.closest?.("[data-drag]");
  if (!h || !S.ordering) return;
  const row = h.closest(".ord-row");
  ev.preventDefault();
  h.setPointerCapture(ev.pointerId);
  drag = { row, list: row.parentElement, y0: ev.clientY, h: h };
  row.classList.add("dragging");
});
document.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const { row, list } = drag;
  let dy = ev.clientY - drag.y0;
  // Al pasar la mitad de la fila vecina, se cambian de sitio.
  const next = row.nextElementSibling, prev = row.previousElementSibling;
  if (dy > 0 && next && dy > next.offsetHeight / 2) { list.insertBefore(next, row); drag.y0 += next.offsetHeight; dy = ev.clientY - drag.y0; renumber(list); }
  else if (dy < 0 && prev && -dy > prev.offsetHeight / 2) { list.insertBefore(row, prev); drag.y0 -= prev.offsetHeight; dy = ev.clientY - drag.y0; renumber(list); }
  row.style.transform = `translateY(${dy}px)`;
});
function endDrag() {
  if (!drag) return;
  const { row, list } = drag;
  row.style.transform = "";
  row.classList.remove("dragging");
  drag = null;
  setOrder([...list.children].map((r) => Number(r.dataset.num)));
  renderCards();
}
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

/* ───────────── un nodo a pantalla completa ───────────── */
const FULL_RANGES = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
let fullWake = null, fullT = null;
async function openFull(num) {
  S.full = { num, range: S.full?.num === num ? S.full.range : "24h" };
  const dlg = $("#nodeview");
  // Pantalla completa de verdad (sin barras del sistema). Se pide antes de abrir la vista: lo último que entra
  // en la capa superior queda encima, y si fuera al revés la página taparía la vista.
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    try { await document.documentElement.requestFullscreen({ navigationUI: "hide" }); } catch { /* no permitido: se ve igual, con las barras */ }
  }
  if (!S.full) return; // se cerró mientras se pedía la pantalla completa
  renderFull();
  if (!dlg.open) dlg.showModal();
  // Pantalla encendida mientras se mira.
  try { if (!fullWake && "wakeLock" in navigator) { fullWake = await navigator.wakeLock.request("screen"); fullWake.addEventListener("release", () => { fullWake = null; }); } } catch { /* sin permiso */ }
  drawFullCharts();
}
function closeFull() {
  S.full = null;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  fullWake?.release?.().catch(() => {});
  fullWake = null;
}
function fullTiles(num) {
  const n = node(num), w = S.cfg.watched[num] || {};
  const keys = sortMetrics(Object.keys(n.metrics).filter((k) => !metricMeta(k).minor));
  if (!keys.length) return `<p class="hint">${num < 0 ? "Aún no ha llegado ningún dato." : "Este nodo aún no ha mandado telemetría."}</p>`;
  return keys.map((k) => {
    const m = metricMeta(k), r = (w.rules || {})[k] || {}, cur = n.metrics[k];
    const bad = (isNum(r.max) && cur.v > r.max) || (isNum(r.min) && cur.v < r.min) || S.active.has(trendKey(num, k)) || S.active.has(estadoKey(num, k));
    const lim = m.estados ? estadoReglaTxt(k, r.estado) || (cur.desde ? `desde las ${hhmm.format(new Date(cur.desde))}` : "")
      : [isNum(r.min) ? `mín ${fmtLimit(k, r.min)}` : "", isNum(r.max) ? `máx ${fmtLimit(k, r.max)}` : "", r.trend ? trendShort(k, r.trend) : ""].filter(Boolean).join(" · ");
    const unit = k === "batteryLevel" && cur.v > 100 ? "" : m.unit;
    return `<div class="nv-tile${bad ? " bad" : ""}"><span class="nv-l">${esc(m.label)}</span>${m.estados ? interruptorHTML(num, k) : ""}<span class="nv-v${m.estados ? " est" : ""}">${esc(fmtValue(k, cur.v))}${unit ? `<small>${esc(unit)}</small>` : ""}</span><span class="nv-s">${lim ? `<span class="nv-lim">${esc(lim)}</span>` : ""}<span data-fmm="${k}"></span><span>${esc(ago(cur.t))}</span></span></div>`;
  }).join("");
}
function renderFull() {
  if (!S.full) return;
  const { num, range } = S.full;
  const n = node(num);
  const [st, stLabel] = nodeState(num);
  const alarms = fullAlarms(num);
  const keys = sortMetrics(Object.keys(n.metrics).filter((k) => !metricMeta(k).minor));
  const seg = Object.keys(FULL_RANGES).map((r) => `<button type="button" data-full-range="${r}" aria-pressed="${r === range}">${r === "24h" ? "24 h" : r === "7d" ? "7 días" : "30 días"}</button>`).join("");
  const charts = keys.map((k) => `<figure class="nv-chart" data-m="${k}"><figcaption><span>${esc(metricMeta(k).label)}</span><span class="mm" data-fmm2="${k}"></span></figcaption><div class="chart-box"></div></figure>`).join("");
  $("#nodeview").innerHTML = `<div class="nv-h">
      <button class="icon-btn" data-close aria-label="Cerrar pantalla completa">${ICON.close}</button>
      <span class="tag">${esc(n.short)}</span>
      <div class="nv-t"><h2>${esc(nom(n))}</h2><p class="meta" data-full-meta>${esc(metaLine(n))}</p></div>
      <span class="pill p-${st}" data-full-pill>${stLabel}</span>
      <div class="seg" role="group" aria-label="Periodo de las gráficas">${seg}</div>
    </div>
    <div class="nv-b"><div data-full-al>${alarms}</div><div class="nv-tiles" data-full-tiles>${fullTiles(num)}</div><div class="nv-charts">${charts}</div></div>`;
}
function fullAlarms(num) {
  const al = [...S.active.values()].filter((a) => a.num === num).sort((a, b) => (a.acked - b.acked) || (b.since - a.since));
  if (!al.length) return "";
  return `<ul class="nv-al">${al.map((a) => `<li class="${a.acked ? "acked" : ""}"><div><strong>${esc(alarmTitle(a))}</strong><span>${esc(alarmDetail(a))}</span></div>${a.acked ? `<span class="al-ok">Visto</span>` : `<button class="btn on-dark sm" data-ack="${esc(a.key)}">Enterado</button>`}</li>`).join("")}</ul>`;
}
/** Lecturas en vivo sin redibujar todo (las gráficas, como mucho cada 2 s). */
function refreshFull(num) {
  if (!S.full || (num != null && S.full.num !== num) || !$("#nodeview").open) return;
  const n = node(S.full.num);
  const [st, stLabel] = nodeState(S.full.num);
  const pill = $("[data-full-pill]");
  if (pill) { pill.className = `pill p-${st}`; pill.textContent = stLabel; }
  const meta = $("[data-full-meta]");
  if (meta) meta.textContent = metaLine(n);
  const tiles = $("[data-full-tiles]");
  if (tiles) setHTML(tiles, fullTiles(S.full.num));
  const al = $("[data-full-al]");
  if (al) setHTML(al, fullAlarms(S.full.num));
  if (num != null) { clearTimeout(fullT); fullT = setTimeout(drawFullCharts, 2000); }
}
async function drawFullCharts() {
  if (!S.full) return;
  const { num, range } = S.full;
  const to = Date.now(), from = to - FULL_RANGES[range];
  const rules = S.cfg.watched[num]?.rules || {};
  const figs = $$("#nodeview .nv-chart");
  // Alto según la pantalla: que quepan dos filas de gráficas sin desplazarse en un monitor o una tableta.
  const H = Math.round(Math.max(150, Math.min(300, (innerHeight - 330) / Math.max(1, Math.ceil(figs.length / (innerWidth >= 900 ? 2 : 1))))));
  for (const fig of figs) {
    const k = fig.dataset.m;
    const est = !!metricMeta(k).estados;
    const ser = await S.store.series(num, k, est ? from - 2 * HOUR : from, to); // un estado: también el de antes
    if (!S.full || S.full.num !== num) return;
    const box = $(".chart-box", fig);
    const W = Math.max(260, Math.floor(box.clientWidth || 600));
    if (est) {
      const tr = tramosEstado(ser, from, to, S.nodes.get(num)?.metrics?.[k]);
      box.innerHTML = estadoSVG(tr, k, from, to, W, Math.min(H, 90));
      $(`[data-fmm2="${k}"]`, fig).textContent = resumenEstado(k, tr);
      continue;
    }
    box.innerHTML = chartSVG(ser, k, rules[k], from, to, W, H);
    const vals = ser.map((p) => p.v).filter((v) => !(k === "batteryLevel" && v > 100));
    const mm = vals.length ? `mín ${fmtNum(Math.min(...vals), metricMeta(k).dec)} · máx ${fmtNum(Math.max(...vals), metricMeta(k).dec)}` : "";
    $(`[data-fmm2="${k}"]`, fig).textContent = mm;
  }
}

/* ───────────── resto de la malla y buscador ───────────── */
function setHTML(el, html) { if (el._h !== html) { el.innerHTML = html; el._h = html; } } // sin repintar si no cambia
const markHTML = (text, words) => highlight(text, words).map((p) => (p.hit ? `<mark>${esc(p.text)}</mark>` : esc(p.text))).join("");

/** Chips de filtro y orden. Se crean una vez y luego solo se cambia su estado, para no perder el foco. */
function renderMeshTools() {
  const v = S.meshView;
  const box = $("#meshFilters");
  if (box.children.length !== FILTERS.length) {
    box.innerHTML = FILTERS.map((f) => `<button type="button" class="fchip" data-mf="${f.key}" aria-pressed="false"${f.title ? ` title="${esc(f.title)}"` : ""}>${esc(f.label)}</button>`).join("");
  }
  for (const b of box.children) b.setAttribute("aria-pressed", String(v.filters.includes(b.dataset.mf)));
  const sel = $("#meshSort");
  const myPos = S.myNode != null ? S.nodes.get(S.myNode)?.pos : null;
  setHTML(sel, SORTS.map((o) => {
    const off = o.key === "dist" && !myPos;
    return `<option value="${o.key}"${off ? " disabled" : ""}>${esc(o.label)}${off ? " (tu receptor no tiene ubicación)" : ""}</option>`;
  }).join(""));
  if (sel.value !== v.sort) sel.value = v.sort;
}
function saveMeshView() { LS.set("vigia.meshView", S.meshView); }

function renderMesh() {
  const el = $("#mesh");
  const q = S.meshQ.trim();
  const words = tokens(q);
  const filters = new Set(S.meshView.filters);
  const searching = words.length > 0 || filters.size > 0;
  const malla = [...S.nodes.values()].filter((n) => n.num >= 0); // los paneles sin nodo no son de la malla
  const rest = malla.filter((n) => !isWatched(n.num));
  // Con texto también salen los vigilados, marcados: quien busca «DNN 4» espera encontrarlo esté donde esté.
  const pool = words.length ? malla : rest;
  const from = S.myNode != null ? S.nodes.get(S.myNode)?.pos : null;
  const res = searchNodes(pool, { q, filters, sort: S.meshView.sort, now: Date.now(), from });
  $("#meshTools").hidden = malla.length < 2;
  renderMeshTools();
  $("#meshCount").textContent = searching ? `${res.length} de ${pool.length}` : rest.length ? String(rest.length) : "";
  const limit = S.meshExpanded ? Infinity : searching ? 50 : 8;
  const shown = res.slice(0, limit);
  let html;
  if (!rest.length && !words.length) {
    html = `<li class="empty-row">${S.demo || S.link.state === "ready" ? "No hay más nodos en la base de datos del receptor." : "Conecta el receptor para ver los nodos que oye."}</li>`;
  } else if (!res.length) {
    const why = [q ? `con «${esc(q)}»` : "", filters.size ? "con esos filtros" : ""].filter(Boolean).join(" y ");
    html = `<li class="empty-row">Ningún nodo coincide ${why}. <button type="button" class="link-btn" data-mesh-clear>Quitar la búsqueda</button></li>`;
  } else {
    html = shown.map(({ n, dist, score }) => {
      const watched = isWatched(n.num);
      const tags = [watched ? "vigilado" : "", n.num === S.myNode ? "receptor" : "", n.hasEnv ? "sensores" : "", n.num !== S.myNode && n.key === false && receptorUsesPki() ? "sin clave" : ""].filter(Boolean);
      const chipCls = (t) => (t === "sin clave" ? " warn" : t === "vigilado" ? " watch" : "");
      // Lo que decide el orden va delante, para que se vea aunque la línea se corte en el móvil.
      const far = dist != null && n.num !== S.myNode ? `a ${fmtDist(dist)}` : "";
      const sort = S.meshView.sort;
      const lead = sort === "dist" ? far : sort === "snr" && isNum(n.snr) && n.snr !== 0 ? `SNR ${fmtNum(n.snr, 1)} dB` : "";
      const meta = [lead, metaLine(n).replace(lead && sort === "snr" ? ` · ${lead}` : "\u0000", ""), lead === far ? "" : far].filter(Boolean).join(" · ");
      // Si coincide solo por ID o modelo, se enseñan para que se vea por qué ha salido.
      const why = score === 4 ? ` · ${markHTML(hexId(n.num), words)}${n.hw ? ` · ${markHTML(n.hw.replaceAll("_", " "), words)}` : ""}` : "";
      const action = watched ? "" : `<button class="btn ghost" data-watch="${n.num}">Vigilar</button>`;
      return `<li class="row"><button class="row-main" data-open="${n.num}"><span class="tag sm">${markHTML(n.short, words)}</span><span class="row-t"><span class="row-n">${markHTML(nom(n), words)}${tags.map((t) => `<span class="chip${chipCls(t)}">${t}</span>`).join("")}</span><span class="meta">${esc(meta)}${why}</span></span></button>${action}</li>`;
    }).join("");
  }
  setHTML(el, html);
  const more = $("#meshMore");
  more.hidden = res.length <= (searching ? 50 : 8);
  more.textContent = S.meshExpanded ? "Ver menos" : `Ver los ${res.length} nodos`;
}

let meshQT = null;
function onMeshQuery(value) {
  clearTimeout(meshQT);
  meshQT = setTimeout(() => {
    S.meshQ = value;
    S.meshExpanded = false;
    renderMesh();
  }, 120);
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
  const bits = [SERVIDOR ? "Datos guardados en el servidor de Vigía, en tu red." : "Sin internet: los datos se guardan solo en este dispositivo."];
  if (wake) bits.push("Pantalla fija activada.");
  $("#foot").textContent = bits.join(" ");
  const v = $("#footVer");
  if (v) v.textContent = `Vigía Mesh ${APP_VERSION}`;
}

/* ───────────── mapa ───────────── */
const TILE_CACHE = "teselas-osm"; // el mismo nombre que en sw.js
let persistAsked = false;
/** focus: nodo en el que centrar el mapa (desde su tarjeta o su ficha). */
/** route: { to, fwd, back } para dibujar la ruta de un traceroute. */
function openMap(focus = null, route = null) {
  // Que el navegador no vacíe el fondo guardado cuando el móvil vaya justo de espacio.
  if (!persistAsked && window.__VIGIA_PWA) { persistAsked = true; navigator.storage?.persist?.().catch(() => {}); }
  if (!mapView) {
    mapView = createMapView({
      nodes: () => [...S.nodes.values()].filter((n) => n.num >= 0).map((n) => (n.alias ? { ...n, long: n.alias } : n)),
      myNode: () => S.myNode,
      esc, ago, stamp,
      sf: () => loraSf(S.lora),
      hopName, legHops,
      load: () => LS.get("vigia.map", {}),
      save: (v) => LS.set("vigia.map", v),
    });
  }
  const detail = $("#detail");
  // Desde la ficha: si el mapa ya estaba abierto debajo, se cierra la ficha para verlo;
  // si no, el mapa se abre encima y al cerrarlo se vuelve a la ficha.
  if (focus != null && detail.open && $("#map").open) detail.close();
  mapView.open(focus, route);
}

/* ───────────── detalle de nodo ───────────── */
function openDetail(num) {
  // Lo cambiado sin guardar se queda si se vuelve a abrir el mismo panel (al cerrar se avisa); con otro, no.
  if (datBorrador && datBorrador.num !== num) { datBorrador = null; filtroTemas = ""; }
  if (num !== S.myNode) mallaBorrador = null;
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
  const sinNodo = num < 0; // panel de un dispositivo MQTT: sin peticiones, ruta ni ubicación
  const tags = (sinNodo ? [`${TIPOS_PANEL[n.tipoPanel]?.label || "MQTT"}`, "datos por MQTT"]
    : [hexId(num), n.hw ? n.hw.replaceAll("_", " ") : "", n.num === S.myNode ? "tu receptor" : ""]).filter(Boolean).join(" · ");
  let body = "";
  if (!sinNodo) {
    body += `<section class="blk"><h3>Pedir datos ahora</h3><div class="ask in-sheet" data-ask-box="${num}" data-sheet="1">${askBlock(num, true)}</div>
    <p class="hint">La petición sale por LoRa desde tu receptor y el nodo contesta con una lectura recién tomada. Si está dormido para ahorrar batería o fuera de alcance, no contesta.</p></section>`;
    body += `<section class="blk"><div class="route-box" data-route-box="${num}">${routeBlock(num)}</div></section>`;
    body += `<section class="blk"><div class="pos in-sheet" data-pos-box="${num}" data-sheet="1">${posBlock(num, true)}</div></section>`;
  }
  if (w) {
    const off = isNum(w.offlineMin) ? w.offlineMin : S.settings.defaultOfflineMin;
    const rows = keys.filter((k) => !metricMeta(k).minor && !metricMeta(k).estados).map((k) => {
      const m = metricMeta(k), r = (w.rules || {})[k] || {};
      const cur = n.metrics[k];
      return `<tr><th scope="row">${esc(m.label)}${m.unit ? ` <small>${esc(m.unit)}</small>` : ""}</th><td class="now" data-now="${k}">${cur ? fmtValue(k, cur.v) : "—"}</td>
        <td><input id="r-${k}-min" class="inp" data-rule="${k}" data-side="min" inputmode="decimal" autocomplete="off" placeholder="—" value="${isNum(r.min) ? fmtLimit(k, r.min) : ""}" aria-label="${esc(m.label)} mínimo"></td>
        <td><input id="r-${k}-max" class="inp" data-rule="${k}" data-side="max" inputmode="decimal" autocomplete="off" placeholder="—" value="${isNum(r.max) ? fmtLimit(k, r.max) : ""}" aria-label="${esc(m.label)} máximo"></td></tr>`;
    }).join("");
    body += `<section class="blk"><h3>Alarmas de este ${sinNodo ? "panel" : "nodo"}</h3>
      <div class="off-row"><label for="r-off">${sinNodo ? "Avisar si no llega ningún dato en más de" : "Avisar si no da señal en más de"}</label><span class="inp-u"><input id="r-off" class="inp" inputmode="numeric" autocomplete="off" value="${off || ""}" placeholder="no"><span>min</span></span></div>
      <p class="hint">${sinNodo ? "Hay dispositivos que solo publican cuando algo cambia: ponlo solo si el tuyo publica cada poco (Tasmota, cada 5 min; Shelly, cada minuto). Vacío desactiva este aviso." : "Por defecto la telemetría sale cada 30 min. Deja margen para dos envíos perdidos; vacío desactiva este aviso."}${sinNodo && panelCfg(num)?.conexion?.avisar ? " Y avisa en cuanto el dispositivo diga que se ha desconectado (su tema de conexión, en «Datos por MQTT»)." : ""}</p>
      ${rows ? `<div class="tbl"><table class="thr-t"><thead><tr><th scope="col">Métrica</th><th scope="col">Ahora</th><th scope="col">Mín.</th><th scope="col">Máx.</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">Escribe el límite y sal de la casilla para guardarlo. Vacía la casilla para quitarlo.</p>` : `<p class="hint">${sinNodo ? "Cuando lleguen sus datos aparecerán aquí para ponerles límites." : "Cuando este nodo mande telemetría aparecerán aquí sus métricas para ponerles límites."}</p>`}
      ${estadosAlarmaHTML(num, keys)}
      <p class="form-err" id="ruleErr" role="alert" hidden></p>
      <div class="trend-box" id="trendBox">${trendBlock(num)}</div></section>`;
  } else {
    body += `<section class="blk cta"><p>Vigila este nodo para fijarlo arriba y ponerle alarmas de umbral y de nodo sin señal.</p><button class="btn primary" data-watch="${num}">Vigilar este nodo</button></section>`;
  }
  body += `<section class="blk"><div class="blk-h"><h3>Histórico</h3><div class="seg" role="group" aria-label="Periodo">
      <button type="button" data-range="24h" aria-pressed="${S.detail.range === "24h"}">24 h</button><button type="button" data-range="7d" aria-pressed="${S.detail.range === "7d"}">7 días</button></div></div>
      <div id="chartList" class="chart-list">${keys.length ? keys.map((k) => `<figure class="chart" data-m="${k}"><figcaption><span>${esc(metricMeta(k).label)}</span><b data-cur="${k}">${n.metrics[k] ? esc(fmtWithUnit(k, n.metrics[k].v)) : "—"}</b><span class="mm" data-mm="${k}"></span></figcaption><div class="chart-box"></div></figure>`).join("") : `<p class="hint">${sinNodo ? "Aún no ha llegado ningún dato." : "Sin telemetría de este nodo."}</p>`}</div></section>`;
  // Con servidor: el nombre en Vigía, los datos por MQTT y, en el receptor, lo que sale a la malla.
  if (SERVIDOR && w) body += nombreSection(num) + datosSection(num) + (num === S.myNode ? mallaSection() : "");
  if (w) {
    body += sinNodo
      ? `<section class="blk end"><button class="btn danger-ghost" data-panel-quitar="${num}">Quitar panel</button></section>`
      : `<section class="blk end"><button class="btn danger-ghost" id="unwatchBtn" data-unwatch="${num}">Dejar de vigilar</button></section>`;
  }

  $("#detail").innerHTML = `<div class="sheet-h"><span class="tag">${esc(n.short)}</span><div class="sheet-t"><h2>${esc(nom(n))}</h2><p class="meta">${esc(tags)}<br>${esc(metaLine(n))}</p></div><button class="icon-btn" data-full="${num}" aria-label="Ver a pantalla completa" title="Pantalla completa">${ICON.expand}</button><button class="icon-btn" data-close aria-label="Cerrar">${ICON.close}</button></div><div class="sheet-b">${body}</div>`;
}

async function drawCharts() {
  if (!S.detail) return;
  const { num, range } = S.detail;
  const to = Date.now(), from = to - (range === "7d" ? 7 * DAY : DAY);
  const rules = S.cfg.watched[num]?.rules || {};
  for (const fig of $$("#chartList .chart")) {
    const k = fig.dataset.m;
    const est = !!metricMeta(k).estados;
    const ser = await S.store.series(num, k, est ? from - 2 * HOUR : from, to); // un estado: también el de antes
    if (!S.detail || S.detail.num !== num) return;
    const box = $(".chart-box", fig);
    const W = Math.max(240, Math.floor(box.clientWidth || 320));
    if (est) {
      const tr = tramosEstado(ser, from, to, S.nodes.get(num)?.metrics?.[k]);
      box.innerHTML = estadoSVG(tr, k, from, to, W);
      $(`[data-mm="${k}"]`, fig).textContent = resumenEstado(k, tr);
      continue;
    }
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

async function saveRuleFromInput(inp) {
  const num = S.detail?.num;
  const w = S.cfg.watched[num];
  if (!w) return;
  const err = $("#ruleErr");
  if (inp.id === "r-off") {
    const v = parseNum(inp.value);
    if (SERVIDOR && Number.isNaN(v)) { showErr(err, "Pon un número de minutos (1 o más) o déjalo vacío."); inp.focus(); return; }
    const res = SERVIDOR ? await orden({ orden: "sinSenal", num, valor: v }) : acciones.ponerSinSenal(num, v);
    if (res.error) { showErr(err, res.error); inp.focus(); return; }
    err.hidden = true;
    render();
    toast(res.toast);
    return;
  }
  const k = inp.dataset.rule, side = inp.dataset.side;
  const v = parseNum(inp.value);
  if (Number.isNaN(v)) { showErr(err, `“${inp.value}” no es un número. Usa coma o punto para los decimales.`); inp.focus(); return; }
  const res = SERVIDOR ? await orden({ orden: "limite", num, metrica: k, lado: side, valor: v }) : acciones.ponerLimite(num, k, side, v);
  if (res.error) { showErr(err, res.error); inp.focus(); return; }
  err.hidden = true;
  render();
  drawCharts();
  toast(res.toast);
}
function showErr(el, msg) { el.textContent = msg; el.hidden = false; }

/** Alarmas de los estados ON/OFF de la ficha: cuándo avisar y, si se quiere, durante cuánto tiempo. */
function estadosAlarmaHTML(num, keys) {
  const w = S.cfg.watched[num], n = S.nodes.get(num);
  const ks = keys.filter((k) => metricMeta(k).estados);
  if (!ks.length) return "";
  return `<div class="est-al">${ks.map((k) => {
    const m = metricMeta(k), r = w?.rules?.[k]?.estado, cur = n?.metrics?.[k];
    const opt = (v) => `<option value="${v}"${r?.cuando === v ? " selected" : ""}>Avisar cuando: ${esc(m.estados[v ? 0 : 1])}</option>`;
    return `<div class="est-al-r${S.active.has(estadoKey(num, k)) ? " bad" : ""}" data-sw-num="${num}"><span class="est-al-n">${esc(m.label)} <b data-now="${k}">${cur ? esc(fmtValue(k, cur.v)) : "—"}</b>${interruptorHTML(num, k)}</span>
      <select class="inp sel" data-est-cuando="${k}" aria-label="Cuándo avisar de ${esc(m.label)}"><option value=""${r ? "" : " selected"}>No avisar</option>${opt(1)}${opt(0)}</select>
      <span class="inp-u"><span>más de</span><input class="inp" data-est-min="${k}" inputmode="numeric" autocomplete="off" placeholder="0" value="${r?.min || ""}" aria-label="Minutos que tiene que durar para avisar de ${esc(m.label)}"><span>min</span></span></div>`;
  }).join("")}</div>
    <p class="hint">Con minutos, avisa solo si sigue así ese tiempo (una puerta abierta más de 10 min); sin ellos, al momento.</p>`;
}
/** Guarda la alarma de un estado (la fila entera: cuándo y minutos). */
async function guardarEstado(el) {
  const num = S.detail?.num;
  const k = el.dataset.estCuando || el.dataset.estMin;
  const sel = $(`#detail [data-est-cuando="${k}"]`), inp = $(`#detail [data-est-min="${k}"]`);
  const err = $("#ruleErr");
  const min = parseNum(inp.value);
  if (Number.isNaN(min)) { showErr(err, "Pon los minutos como un número o déjalo vacío."); inp.focus(); return; }
  const cuando = sel.value === "" ? null : Number(sel.value);
  const res = await orden({ orden: "alarmaEstado", num, metrica: k, cuando, minutos: min === null ? null : Math.round(min) });
  if (res.error) { showErr(err, res.error); return; }
  err.hidden = true;
  if (res.toast) toast(res.toast);
}

/* ── cambio rápido: bloque de la ficha ── */
function trendMetrics(num) {
  const n = S.nodes.get(num), w = S.cfg.watched[num];
  return sortMetrics(new Set([...Object.keys(n?.metrics || {}), ...Object.keys(w?.rules || {})])).filter((k) => !metricMeta(k).minor && !metricMeta(k).estados);
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
  if (!ks.length) return h + `<p class="hint">${num < 0 ? "Cuando lleguen sus datos podrás ponerle este aviso." : "Cuando este nodo mande telemetría podrás ponerle este aviso."}</p>`;
  const pick = (sel && ks.includes(sel) && sel) || ks.find((k) => k === "barometricPressure" && !w.rules?.[k]?.trend) || ks.find((k) => !w.rules?.[k]?.trend) || ks[0];
  const d = w.rules?.[pick]?.trend || trendDefault(metricMeta(pick).tipo || pick); // un dato MQTT, como los de su tipo
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
  const d = cur || trendDefault(metricMeta(k).tipo || k);
  $("#tr-dir").value = d.dir;
  $("#tr-delta").value = fmtLimit(k, d.delta);
  $("#tr-hours").value = fmtNum(d.hours, d.hours % 1 ? 1 : 0);
  $("#tr-unit").textContent = metricMeta(k).unit;
  $("[data-trend-add]").textContent = cur ? "Guardar aviso" : "Añadir aviso";
  $("#trErr").hidden = true;
}
async function addTrend(num) {
  const w = S.cfg.watched[num];
  if (!w) return;
  const k = $("#tr-metric").value, err = $("#trErr");
  const delta = parseNum($("#tr-delta").value), hours = parseNum($("#tr-hours").value);
  const { rule, error } = parseTrendRule($("#tr-dir").value, delta ?? NaN, hours ?? NaN);
  if (error) { showErr(err, error); return; }
  const res = SERVIDOR ? await orden({ orden: "tendencia", num, metrica: k, regla: rule }) : acciones.ponerTendencia(num, k, rule);
  if (res.error) { showErr(err, res.error); return; }
  refreshTrend(num, k);
  render();
  toast(res.toast);
}
async function delTrend(num, k) {
  const res = SERVIDOR ? await orden({ orden: "quitarTendencia", num, metrica: k }) : acciones.quitarTendencia(num, k);
  if (!res.ok) return;
  refreshTrend(num);
  render();
  toast(res.toast);
}

async function watch(num) {
  const res = SERVIDOR ? await orden({ orden: "vigilar", num }) : acciones.vigilar(num);
  if (!res.ok) { if (res.error) toast(res.error); return; }
  res.recientes?.then(render);
  render();
  if (S.detail?.num === num && $("#detail").open) { renderDetail(); drawCharts(); }
  toast(res.toast);
}

async function unwatch(num) {
  if (SERVIDOR) await orden({ orden: "dejar", num }); else acciones.dejarDeVigilar(num);
  // Lo de la pantalla (tarjeta contraída, orden) es de este aparato.
  delete S.ui.collapsed[num];
  S.ui.order = S.ui.order.filter((n) => n !== num);
  saveUi();
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

function serialSupportMsg() {
  if (PREVIEW) return "Esta es la vista previa: aquí el navegador no deja usar el cable. Instala la app desde tu dirección https para conectar el nodo.";
  const s = Receptor.serialSupport();
  if (s === "insecure") return "El cable USB solo funciona en páginas seguras (https). Abre la app desde su dirección https.";
  if (s === "none") return "Este navegador no puede usar el cable USB. Hace falta Chrome o Edge en el ordenador.";
  return "";
}
const canSerial = () => !serialSupportMsg();
/** Cómo se conectó el receptor la última vez: "ble" o "serial". Sin Bluetooth web pero con cable, el cable. */
function linkKind() {
  const k = (S.device || LS.get("vigia.device", null))?.kind;
  if (k === "serial" || k === "ble") return k;
  return btSupportMsg() && canSerial() ? "serial" : "ble";
}
/** Botones para conectar: el último modo usado delante; el cable solo donde el navegador lo permite. */
function connectButtons() {
  if (!canSerial()) return `<button class="btn primary" data-connect>Conectar receptor</button>`;
  const usb = `<button class="btn ${linkKind() === "serial" ? "primary" : "ghost"}" data-connect-usb>${ICON.usb}Por cable USB</button>`;
  const bt = btSupportMsg() ? "" : `<button class="btn ${linkKind() === "ble" ? "primary" : "ghost"}" data-connect-bt>${ICON.bt}Por Bluetooth</button>`;
  return linkKind() === "serial" ? usb + bt : bt + usb;
}

function receptorServidorHTML() {
  if (!S.servidorOk) return `<p class="warn-t">Sin conexión con el servidor de Vigía. Esta pantalla lo vuelve a intentar sola.</p>`;
  const my = S.myNode != null ? S.nodes.get(S.myNode) : null;
  const via = S.device?.kind === "tcp" ? `por la red${S.device.direccion ? ` (${S.device.direccion})` : ""}` : "por cable USB";
  const txt = {
    ready: `El servidor está conectado ${via} a ${my ? `${my.short} · ${my.long}` : "su nodo"}.`,
    configuring: "El servidor está leyendo la base de datos de nodos de su receptor…",
    connecting: "El servidor está conectando con su receptor…",
    reconnecting: `El servidor no tiene conexión con su receptor${S.trouble?.detail ? `: ${S.trouble.detail}` : ""}. Lo vuelve a intentar solo.`,
    idle: "El receptor del servidor está parado.",
  }[S.link.state] || "";
  return `<p>${esc(txt)}</p>${S.link.state === "reconnecting" ? `${S.trouble?.consejo ? `<p class="hint">${esc(S.trouble.consejo)}</p>` : ""}<div class="btns"><button class="btn primary" data-retry>Reintentar ahora</button></div>` : ""}
    <p class="hint">Estás viendo Vigía desde el servidor: él tiene el receptor y vigila aunque cierres esta página. Los nodos vigilados, las alarmas, el «Enterado» y los avisos por la malla son los mismos en todos tus aparatos; el sonido y la pantalla encendida son de cada uno.</p>`;
}

function renderSettings() {
  const st = S.link.state;
  const dev = S.device || LS.get("vigia.device", null);
  const sup = btSupportMsg() && serialSupportMsg();
  const viaUsb = linkKind() === "serial";
  let rec = "";
  if (SERVIDOR) rec = receptorServidorHTML();
  else if (sup) rec = `<p class="warn-t">${esc(btSupportMsg())}</p>`;
  else if (S.demo) rec = `<p>Estás en la demo. Sal de ella para conectar tu nodo.</p><div class="btns"><button class="btn primary" data-demo-off>Salir de la demo y conectar</button></div>`;
  else {
    const my = S.myNode != null ? S.nodes.get(S.myNode) : null;
    const via = dev ? (dev.kind === "serial" ? " por cable USB" : " por Bluetooth") : "";
    const statusTxt = {
      idle: dev?.name ? `Desconectado. Último receptor: ${dev.name}${via}.` : "Ningún receptor emparejado todavía.",
      connecting: `Conectando${via} con ${dev?.name || "el nodo"}…`,
      configuring: `Conectado${via}. Leyendo la base de datos de nodos…`,
      ready: `Conectado${via} a ${my ? `${my.short} · ${my.long}` : dev?.name || "tu nodo"}.`,
      reconnecting: `Se ha perdido la conexión${via} con ${dev?.name || "el receptor"}. ${viaUsb ? "Se reconecta sola al volver a enchufarlo." : "Reintentando sola."}`,
    }[st];
    rec = `<p>${esc(statusTxt)}</p><div class="btns">`;
    if (st === "idle") rec += connectButtons();
    else rec += `${st === "reconnecting" ? `<button class="btn primary" data-retry>Reintentar ahora</button>` : ""}<button class="btn ghost" data-disconnect>Desconectar</button>`;
    rec += `${dev && st === "idle" ? `<button class="btn danger-ghost" data-forget>Olvidar este receptor</button>` : ""}</div>`;
    if (st === "idle") {
      const more = [btSupportMsg() ? "" : `<button type="button" class="link-btn" data-connect-all>todos los aparatos Bluetooth</button>`, canSerial() ? `<button type="button" class="link-btn" data-connect-usb-all>todos los puertos serie</button>` : ""].filter(Boolean);
      rec += `<p class="hint">¿Tu nodo no aparece en la lista? Busca entre ${more.join(" o entre ")}.</p>`;
    }
    rec += `<p class="hint">El receptor es el nodo que tienes al lado; los sensores le llegan por LoRa. ${canSerial() ? "Se conecta por Bluetooth o, en el ordenador, por cable USB: con cable no hay emparejamientos ni cortes, y si lo desenchufas y lo vuelves a enchufar se reconecta sola." : "El móvil se conecta a él por Bluetooth, sin internet."}</p>
      <details class="tips"><summary>Si no conecta</summary><ul>
        <li><strong>La app de Meshtastic lo tiene ocupado.</strong> En Android sigue conectada en segundo plano aunque no la abras. Ciérrala del todo o desconecta el nodo desde ella: el nodo solo admite un móvil.</li>
        <li><strong>Emparejamiento roto.</strong> Si se conecta y se corta enseguida, olvida el nodo en los ajustes de Bluetooth del móvil y vuelve a conectar; te pedirá el PIN que sale en su pantalla.</li>
        <li><strong>Otra ventana de Vigía.</strong> Si la tienes abierta en Chrome y también instalada, solo una puede conectarse.</li>
        <li><strong>Bluetooth del móvil atascado.</strong> Apagarlo y encenderlo arregla muchos fallos raros de Android.</li>
        ${canSerial() ? `<li><strong>Por cable: el puerto está ocupado.</strong> Solo un programa puede abrirlo: cierra la web de Meshtastic, el flasheador o cualquier monitor serie. Usa un cable de datos (algunos solo cargan).</li>` : ""}
      </ul></details>`;
  }
  const notifState = !("Notification" in window) ? "none" : SERVIDOR && !window.isSecureContext ? "http" : Notification.permission;
  const notif = notifState === "granted" ? `<span class="okt">Activadas</span>`
    : notifState === "http" ? `<span class="hint">El navegador solo las deja con https (llegarán con Tailscale)</span>`
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
      <p class="hint">${SERVIDOR ? "El servidor vigila siempre. Esta pantalla suena y avisa mientras está abierta; si das «Enterado» aquí, queda visto en todos tus aparatos." : "Las alarmas solo saltan con la app abierta y en pantalla. Con el móvil bloqueado, Chrome congela la página; al volver, recoge lo que guardó el receptor y avisa de lo que se perdió."}</p>
    </section>
    ${PREVIEW && !S.demo ? "" : meshSection()}
    ${SERVIDOR ? mqttSection() : ""}
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
      <div class="btns"><button class="btn ghost" data-copy-diag>Copiar diagnóstico</button><button class="btn ghost" data-report>Avisar del fallo en GitHub</button>${SERVIDOR ? "" : `<button class="btn ghost" data-clear-diag>Borrar</button>`}</div>
      <p class="hint">«Avisar del fallo» abre un aviso nuevo en GitHub con el diagnóstico ya pegado. Necesita internet y una cuenta de GitHub, y el aviso es público: revisa el texto antes de enviarlo.</p>
    </section>`}
    ${SERVIDOR ? "" : `<section class="blk"><h3>Demostración</h3>${S.demo ? `<p>Los datos que ves son inventados y no se guardan.</p>${PREVIEW ? "" : `<button class="btn ghost" data-demo-off>Salir de la demo</button>`}` : `<p>Prueba el panel con nodos inventados. Tus datos reales no se tocan.</p><button class="btn ghost" data-demo-on>Ver la demo</button>`}</section>`}
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

/* ───────────── Enterado y peticiones: aquí o en el servidor ───────────── */
function ackUI(key) {
  if (!SERVIDOR || key === "test") return ack(key); // la alarma de prueba es solo de este aparato
  orden({ orden: "ack", key });
}
function ackAllUI() {
  if (!SERVIDOR) return ackAll();
  if (S.active.has("test")) ack("test");
  orden({ orden: "ackAll" });
}
async function askUI(num, type) {
  if (!SERVIDOR) return ask(num, type);
  const r = await orden({ orden: "pedir", num, tipo: type });
  if (r.toast || r.error) toast(r.toast || r.error);
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
      if (dev.kind === "serial") {
        const same = S.device?.kind === "serial" && S.device.vid === dev.vid && S.device.pid === dev.pid;
        S.device = { kind: "serial", vid: dev.vid, pid: dev.pid, name: same && S.device.name ? S.device.name : "nodo por cable USB" };
      } else {
        S.device = { kind: "ble", id: dev.id, name: dev.name || "Nodo Meshtastic" };
      }
      LS.set("vigia.device", S.device);
    },
    onReady() {
      motor.resetClock();
      setTimeout(pumpMesh, 1500);
      S.trouble = null;
      S.otherWindow = null;
      LS.set("vigia.ever", true);
      clearAlarm("link", {});
      // Por cable el puerto no tiene nombre: se usa el del nodo.
      if (S.device?.kind === "serial" && S.myNode != null) { S.device.name = nodeName(S.myNode); LS.set("vigia.device", S.device); }
      addLog("info", `Receptor listo${S.device?.kind === "serial" ? " por cable" : ""}: ${S.myNode != null ? nodeName(S.myNode) : S.device?.name || "nodo"}`);
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
    // Lo que llega del receptor lo procesa el motor (el mismo que usa el servidor).
    onChannel: (c) => motor.recibir.channel(c),
    onLora: (l) => motor.recibir.lora(l),
    onNotice: (n) => motor.recibir.notice(n),
    onOtherWindow() { S.otherWindow = "busy"; render(); },
    onLockLost() { S.otherWindow = "lost"; addLog("info", "La conexión con el receptor ha pasado a otra ventana"); render(); },
    onMyNode: (num) => motor.recibir.myNode(num),
    onNodeInfo: (ni) => motor.recibir.nodeInfo(ni),
    onUser: (from, user, meta) => motor.recibir.user(from, user, meta),
    onPacket: (p) => motor.recibir.packet(p),
    onPosition: (p) => motor.recibir.position(p),
    onTelemetry: (p) => motor.recibir.telemetry(p),
  });
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

function serialErrorText(e) {
  const name = e?.name || "";
  const msg = String(e?.message || "");
  if (name === "NotFoundError") return ""; // cerró el selector sin elegir
  if (name === "SecurityError" || /permissions policy|disallowed/i.test(msg)) return "Esta página no tiene permiso para usar el cable. Abre la app instalada desde tu dirección https.";
  return `No se pudo abrir el puerto: ${msg || name || "error desconocido"}`;
}

/** kind: "ble" o "serial" (por defecto, el último usado). all: selector sin filtro. */
async function connectFlow(all = false, kind = linkKind()) {
  const serial = kind === "serial";
  const sup = serial ? serialSupportMsg() : btSupportMsg();
  if (sup) { toast(sup); openSettings(); return; }
  if (S.demo) stopDemo();
  if (!receptor) receptor = makeReceptor();
  // Un solo receptor a la vez: cambiar de Bluetooth a cable (o al revés) suelta el anterior.
  if (receptor.state !== "idle" && receptor.kind !== kind) await receptor.disconnect();
  S.userIdle = false;
  try {
    if (serial) await receptor.pickSerial(all);
    else await receptor.pick(all);
  } catch (e) {
    const t = serial ? serialErrorText(e) : btErrorText(e);
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
  S.traces = {};
  S.traceAt = 0;
  S.lora = { usePreset: true, modemPreset: 0, hopLimit: 3 };
  S.meshLast = null;
  S.cfg = { watched: JSON.parse(JSON.stringify(d.watched)) };
  S.ui = { collapsed: {}, order: [] };
  S.ordering = false;
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

const loadRecent = (nums) => acciones.cargarRecientes(nums);

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
  if ("ask" in ds) return askUI(Number(ds.num), ds.ask);
  if ("mapFocus" in ds) return openMap(Number(ds.mapFocus));
  if ("cardToggle" in ds) return toggleCard(Number(ds.cardToggle));
  if ("cardsAll" in ds) return toggleAllCards();
  if ("order" in ds) { S.ordering = true; renderCards(); return $("#cards .ord-row [data-move]")?.focus(); }
  if ("orderDone" in ds) { S.ordering = false; renderCards(); return toast("Orden guardado"); }
  if ("move" in ds) return moveCard(Number(ds.move), Number(ds.dir));
  if ("full" in ds) return openFull(Number(ds.full));
  if ("fullRange" in ds) {
    S.full.range = ds.fullRange;
    $$("#nodeview [data-full-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.fullRange === ds.fullRange)));
    return drawFullCharts();
  }
  if ("routeMap" in ds) { const num = Number(ds.routeMap); return S.traces[num] && openMap(num, { to: num, ...S.traces[num] }); }
  if ("copy" in ds) return copyText(ds.copy, t);
  if ("fenceSet" in ds) return setFence(Number(ds.fenceSet));
  if ("fenceDel" in ds) return delFence(Number(ds.fenceDel));
  if ("trendAdd" in ds) return addTrend(Number(ds.trendAdd));
  if ("trendDel" in ds) return S.detail && delTrend(S.detail.num, ds.trendDel);
  if ("ack" in ds) return ackUI(ds.ack);
  if ("ackall" in ds) return ackAllUI();
  if ("watch" in ds) return watch(Number(ds.watch));
  if ("close" in ds) return t.closest("dialog")?.close();
  if ("connect" in ds) { $("#settings").open && $("#settings").close(); return connectFlow(false); }
  if ("connectAll" in ds) { $("#settings").close(); return connectFlow(true, "ble"); }
  if ("connectBt" in ds) { $("#settings").open && $("#settings").close(); return connectFlow(false, "ble"); }
  if ("connectUsb" in ds) { $("#settings").open && $("#settings").close(); return connectFlow(false, "serial"); }
  if ("connectUsbAll" in ds) { $("#settings").open && $("#settings").close(); return connectFlow(true, "serial"); }
  if ("retry" in ds) return SERVIDOR ? orden({ orden: "reconectar" }) : receptor?.retryNow();
  if ("takeover" in ds) {
    if (!receptor) receptor = makeReceptor();
    if (!receptor.hasTarget) { S.otherWindow = null; render(); return connectFlow(false); }
    if (!(await receptor.takeOver())) return toast("No se pudo tomar la conexión. Cierra la otra ventana de Vigía.");
    S.otherWindow = null;
    return render();
  }
  if ("diag" in ds) { openSettings(); setTimeout(() => $("#diagBox")?.scrollIntoView({ block: "start" }), 50); return; }
  if ("brkNuevo" in ds) { brokerEdit = { id: null, nombre: "", url: "", usuario: "", clave: "", activado: true }; renderMqtt(); return $("#brkNombre")?.focus(); }
  if ("brkEdit" in ds) { const b = mqttBrokers().find((x) => x.id === ds.brkEdit); if (b) brokerEdit = { id: b.id, nombre: b.nombre, url: b.url, usuario: b.usuario, clave: "", activado: b.activado }; return renderMqtt(); }
  if ("brkCancel" in ds) { brokerEdit = null; return renderMqtt(); }
  if ("brkSave" in ds) return guardarBroker();
  if ("brkNoclave" in ds) { const r = await orden({ orden: "broker", id: brokerEdit.id, cambio: { clave: null } }); if (!r.ok) return showErr($("#brkErr"), r.error); return toast("Contraseña quitada"); }
  if ("brkDel" in ds) { const r = await orden({ orden: "quitarBroker", id: ds.brkDel }); if (!r.ok) return showErr($("#brkErr"), r.error); brokerEdit = null; toast(r.toast); return renderMqtt(); }
  if ("usrSave" in ds) return guardarUsuarioBroker();
  if ("usrDel" in ds) { const r = await orden({ orden: "quitarUsuarioBroker", nombre: ds.usrDel }); return toast(r.error || r.toast); }
  if ("haSave" in ds) return guardarHA();
  if ("orden" in ds) return mandarOrden(Number(ds.num), ds.orden);
  if ("panelNuevo" in ds) return nuevoPanel();
  if ("panelCrear" in ds) return crearPanel();
  if ("panelQuitar" in ds) {
    if (Date.now() - unwatchArmed > 4000) { unwatchArmed = Date.now(); t.textContent = "Toca otra vez para quitarlo con su histórico"; return; }
    unwatchArmed = 0;
    const r = await orden({ orden: "quitarPanel", num: Number(ds.panelQuitar) });
    if (!r.ok) return toast(r.error);
    $("#detail").close();
    return toast(r.toast);
  }
  if ("pnNombre" in ds) {
    const r = await orden({ orden: "renombrar", num: Number(ds.pnNombre), nombre: $("#pnNombre").value });
    if (!r.ok) return showErr($("#pnErr"), r.error);
    $("#pnErr").hidden = true;
    return toast(r.toast);
  }
  if (S.detail && ("datAdd" in ds || "datDel" in ds || "datUsar" in ds || "datBuscar" in ds || "datSave" in ds || "conUsar" in ds)) {
    const num = S.detail.num;
    if ("conUsar" in ds) return conUsar(num, Number(ds.conUsar));
    if ("datSave" in ds) return guardarDatos(num);
    if ("datBuscar" in ds) return buscarTemas(t, num);
    if ("datUsar" in ds) return datUsar(num, Number(ds.datUsar));
    if ("datDel" in ds) { datosEditar(num).splice(Number(ds.datDel), 1); return renderDatos(num); }
    const datos = datosEditar(num);
    datos.push(datoNuevo(num));
    renderDatos(num);
    return $(`#datLista .est-d:last-child [data-dat-k="tema"]`)?.focus();
  }
  if ("mallaSave" in ds) return guardarMalla();
  if ("mallaSend" in ds) { const r = await orden({ orden: "enviarMalla" }); return toast(r.error || r.toast); }
  if ("meshTest" in ds) {
    const res = SERVIDOR ? await orden({ orden: "pruebaMalla" }) : acciones.pruebaMalla();
    if (res.toast) toast(res.toast);
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
  if ("disconnect" in ds) { await receptor?.disconnect(); S.userIdle = true; S.trouble = null; addLog("info", "Receptor desconectado a mano"); clearAlarm("link", { silent: true }); render(); return; }
  if ("demoOn" in ds) { $("#settings").close(); startDemo(); return toast("Demo activada: datos inventados"); }
  if ("demoOff" in ds) { $("#settings").open && $("#settings").close(); if (PREVIEW) return toast(btSupportMsg()); stopDemo(); return connectFlow(false); }
  if ("notif" in ds) { try { await Notification.requestPermission(); } catch { /* nada */ } renderSettings(); return; }
  if ("test" in ds) { unlockAudio(); raise("test", { kind: "test", num: null, t: Date.now() }); $("#settings").close(); return; }
  if ("export" in ds) return SERVIDOR ? location.assign("api/lecturas.csv") : exportCsv();
  if ("wipe" in ds) {
    if (Date.now() - wipeArmed > 4000) { wipeArmed = Date.now(); t.textContent = "Toca otra vez para borrar"; return; }
    wipeArmed = 0;
    const res = SERVIDOR ? await orden({ orden: "borrarHistorico" }) : await acciones.borrarHistorico();
    renderSettings();
    render();
    return toast(res.toast);
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
  if (t.id === "linkBtn") { if (SERVIDOR) return openSettings(); if (!S.demo && S.link.state === "idle" && !(linkKind() === "serial" ? serialSupportMsg() : btSupportMsg())) return connectFlow(false); return openSettings(); }
  if (t.id === "setBtn") return openSettings();
  if (t.id === "mapBtn") return openMap();
  if (t.id === "meshMore") { S.meshExpanded = !S.meshExpanded; return renderMesh(); }
  if ("mf" in ds) {
    const f = new Set(S.meshView.filters);
    if (f.has(ds.mf)) f.delete(ds.mf); else f.add(ds.mf);
    S.meshView.filters = FILTERS.map((x) => x.key).filter((k) => f.has(k));
    S.meshExpanded = false;
    saveMeshView();
    return renderMesh();
  }
  if ("meshClear" in ds) {
    S.meshQ = "";
    $("#meshQ").value = "";
    S.meshView.filters = [];
    saveMeshView();
    renderMesh();
    return $("#meshQ").focus();
  }
  if (t.id === "logMore") { S.logExpanded = !S.logExpanded; return renderLog(); }
  if ("open" in ds) return openDetail(Number(ds.open));
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.target.id === "pnNombre" || ev.target.id === "npNombre")) {
    ev.preventDefault(); // Intro guarda el nombre (o crea el panel)
    $(ev.target.id === "pnNombre" ? "[data-pn-nombre]" : "[data-panel-crear]")?.click();
    return;
  }
  // «/» lleva al buscador, salvo escribiendo en otra casilla o con una ficha abierta.
  if (ev.key === "/" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.target.closest?.("input, textarea, select, [contenteditable]") && !document.querySelector("dialog[open]") && !$("#meshTools").hidden) {
    ev.preventDefault();
    $("#meshQ").focus();
    $("#meshQ").scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  if (ev.key === "Escape" && ev.target.id === "meshQ") {
    if (ev.target.value) { ev.preventDefault(); ev.target.value = ""; onMeshQuery(""); } else ev.target.blur();
    return;
  }
  if (ev.key === "Enter" && ev.target.id === "meshQ") {
    // Intro abre el primer resultado.
    ev.preventDefault();
    clearTimeout(meshQT);
    S.meshQ = ev.target.value;
    renderMesh();
    const first = $("#mesh .row-main");
    if (first && S.meshQ.trim()) openDetail(Number(first.dataset.open));
    return;
  }
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.(".card[data-open]")) { ev.preventDefault(); openDetail(Number(ev.target.dataset.open)); }
  if (ev.key === "Enter" && ev.target.closest?.(".tr-form") && ev.target.matches("input")) { ev.preventDefault(); return S.detail && addTrend(S.detail.num); }
  if (ev.key === "Enter" && ev.target.matches?.("#detail .inp")) ev.target.blur();
});

document.addEventListener("input", (ev) => {
  if (ev.target.id === "meshQ") onMeshQuery(ev.target.value);
  if (ev.target.closest?.("#mqttBox")) editarMqtt(ev.target);
  if (ev.target.id === "filtroTemas") {
    filtroTemas = ev.target.value;
    const box = $("#datHallados");
    if (!box || !S.detail) return;
    // Solo la lista: el campo de filtrar se queda donde está (y con el foco).
    const tmp = document.createElement("div");
    tmp.innerHTML = halladosHTML(S.detail.num);
    box.querySelectorAll(":scope > .est-hl, :scope > p").forEach((el) => el.remove());
    box.append(...[...tmp.children].filter((el) => el.id !== "filtroTemas"));
    return;
  }
  if (S.detail && ev.target.closest?.("#conBox") && ev.target.matches("input:not([type=checkbox])[data-con-k]")) editarConexion(S.detail.num, ev.target);
  if (S.detail && ev.target.closest?.("#datBox") && ev.target.matches("input:not([type=checkbox])[data-dat-k]")) editarDato(S.detail.num, ev.target);
});

document.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (t.closest?.("#conBox")) return S.detail && t.dataset.conK && editarConexion(S.detail.num, t);
  if (t.closest?.("#datBox")) return S.detail && t.dataset.datK && editarDato(S.detail.num, t);
  if (t.closest?.("#mallaBox")) return editarMalla(t);
  if (t.closest?.("#nomBox")) {
    if (t.id !== "pnTipo" || !S.detail) return; // el nombre se guarda con su botón
    const r = await orden({ orden: "tipoPanel", num: S.detail.num, tipo: t.value });
    return r.ok ? toast("Guardado") : toast(r.error);
  }
  if (t.id === "npTipo" || t.id === "npNombre") return;
  if (t.closest?.("#mqttBox")) return editarMqtt(t);
  if (t.id === "meshSort") { S.meshView.sort = t.value; S.meshExpanded = false; saveMeshView(); return renderMesh(); }
  if (t.id === "fence-r") return S.detail && setFenceRadius(S.detail.num, t);
  if (t.id === "tr-metric") return trendFormFill();
  if (t.closest(".tr-form")) return; // se guarda con el botón
  if (t.matches("[data-est-cuando], [data-est-min]")) return guardarEstado(t);
  if (t.matches("#detail .inp")) return saveRuleFromInput(t);
  if (t.id === "setSound") { S.settings.sound = t.checked; saveSettings(); if (t.checked) { unlockAudio(); beep(); } return; }
  if (t.id === "setWake") { S.settings.wake = t.checked; saveSettings(); return applyWake(); }
  if (t.id === "setOff") {
    const v = parseNum(t.value);
    const res = SERVIDOR ? await orden({ orden: "sinSenalDefecto", valor: Number.isNaN(v) ? null : v }) : acciones.sinSenalPorDefecto(v);
    if (res.error) { t.value = res.valor; return toast(res.error); }
    return toast(res.toast);
  }
  if (t.id === "meshOn" || t.id === "meshClear") {
    const cambio = t.id === "meshOn" ? { enabled: t.checked } : { onClear: t.checked };
    const res = SERVIDOR ? await orden({ orden: "malla", cambio }) : acciones.avisosMalla(cambio);
    if (res.toast) toast(res.toast);
    return;
  }
  if (t.id === "meshCh" || t.id === "meshNode") {
    const v = t.value === "" ? null : Number(t.value);
    const cambio = t.id === "meshCh" ? { channel: v } : { node: v };
    const res = SERVIDOR ? await orden({ orden: "malla", cambio }) : acciones.avisosMalla(cambio);
    if (!res.ok) { t.value = ""; return toast(res.toast); }
    return renderSettings();
  }
  if (t.id === "setRet") {
    if (SERVIDOR) { await orden({ orden: "retencion", dias: Number(t.value) }); return renderSettings(); }
    acciones.retencion(Number(t.value)).poda.then(renderSettings);
  }
});

$("#nodeview").addEventListener("close", closeFull);
// Al girar el móvil o cambiar el tamaño, las gráficas se rehacen a la medida nueva.
window.addEventListener("resize", () => { if (S.full) { clearTimeout(fullT); fullT = setTimeout(drawFullCharts, 250); } });
$("#detail").addEventListener("close", () => {
  if ($("#detail").open) return;
  if (S.detail && (datBorrador?.num === S.detail.num || (mallaBorrador && S.detail.num === S.myNode))) toast("Hay cambios sin guardar en la ficha: vuelve a abrirla y pulsa «Guardar».");
  S.detail = null;
  unwatchArmed = 0;
});
window.addEventListener("resize", () => { clearTimeout(liveT); liveT = setTimeout(drawCharts, 200); });

/* ───────────── modo «Servidor» ───────────── */
/** Lecturas nuevas del servidor: a las series de las últimas 26 h, como hace el motor al recibirlas. */
function anadirReciente(r) {
  const key = seriesKey(r.node, r.metric);
  const arr = S.recent.get(key) || [];
  const i = arr.findIndex((p) => p.t === r.t);
  if (i >= 0) arr[i] = { t: r.t, v: r.v }; // ya venía en la foto
  else arr.push({ t: r.t, v: r.v });
  if (arr.length > 1 && arr[arr.length - 2].t > r.t) arr.sort((a, b) => a.t - b.t);
  while (arr.length && arr[0].t < Date.now() - 26 * HOUR) arr.shift();
  S.recent.set(key, arr);
}
function aplicarPartes(p) {
  if ("cfg" in p) S.cfg = p.cfg;
  if ("active" in p) {
    const prueba = S.active.get("test"); // la alarma de prueba es solo de este aparato
    S.active = new Map(p.active.map((a) => [a.key, a]));
    if (prueba) S.active.set("test", prueba);
  }
  for (const k of ["log", "channels", "myNode", "myUser", "lora", "traces", "meshLast", "link", "device", "trouble", "diag", "mqtt"]) if (k in p) S[k] = p[k];
  if ("paneles" in p) {
    S.paneles = p.paneles;
    registrarMetricas(metasDe(S.paneles?.paneles)); // los datos MQTT, como métricas con su nombre y su unidad
  }
  if ("req" in p) S.req = new Map(p.req.map((r) => [askKey(r.num, r.type), r]));
  if ("settings" in p) Object.assign(S.settings, p.settings); // sonido y pantalla encendida siguen siendo de este aparato
  if ("recent" in p) S.recent = new Map(Object.entries(p.recent));
  if (p.nodes) for (const n of p.nodes) S.nodes.set(n.num, n);
  if (p.rows) for (const r of p.rows) anadirReciente(r);
}
/** Refresca lo que esté abierto según lo que haya cambiado, sin pisar lo que se esté escribiendo. */
function refrescarAbiertos(p) {
  const escribiendo = (sel) => document.activeElement?.matches?.(sel);
  const num = S.detail?.num;
  if (num != null && $("#detail").open) {
    if (("cfg" in p || "active" in p || "traces" in p) && !escribiendo("#detail input, #detail select")) { renderDetail(); drawCharts(); }
    else if (p.nodes?.some((n) => n.num === num) && Object.keys(S.nodes.get(num)?.metrics || {}).some((k) => !$(`#detail [data-cur="${k}"]`)) && !escribiendo("#detail input, #detail select")) {
      renderDetail(); // una métrica nueva (el primer dato que llega): su fila de límites y su gráfica
      drawCharts();
    } else {
      if (p.nodes?.some((n) => n.num === num) || p.rows?.some((r) => r.node === num)) refreshDetailLive();
      if ("req" in p || "traces" in p) { refreshAsk(num); refreshPos(num); }
    }
    if ("paneles" in p || "mqtt" in p || "channels" in p) patchPaneles(); // valores, nombres de los brokers, canales
    if ("paneles" in p || p.nodes?.some((n) => n.num === num)) patchInterruptores();
  }
  if (S.full && (p.nodes || p.rows || "active" in p)) refreshFull(S.full.num);
  if ($("#settings").open) {
    if ("meshLast" in p) patchMeshLast();
    if ("mqtt" in p) patchMqtt();
    if (("link" in p || "diag" in p || "settings" in p || "channels" in p || "trouble" in p) && !escribiendo("#settings input, #settings select")) renderSettings();
  }
  if (mapView && $("#map").open && (p.nodes || "traces" in p)) mapView.update();
}
function bootServidor() {
  S.settings = { ...DEFAULT_SETTINGS, ...LS.get("vigia.settings", {}) };
  S.ui = { collapsed: {}, order: [], ...(LS.get("vigia.cards", {}) || {}) };
  S.meshView = { filters: [], sort: "auto", ...(LS.get("vigia.meshView", {}) || {}) };
  S.link = { state: "connecting", extra: null };
  render();
  servidor = conectarServidor({
    onConexion(ok) {
      if (ok === S.servidorOk) return;
      S.servidorOk = ok;
      if (!ok) addLogLocal("Sin conexión con el servidor; reintentando…");
      render();
      if ($("#settings").open) renderSettings();
    },
    onEstado(foto) {
      S.nodes = new Map(foto.nodes.map((n) => [n.num, n]));
      aplicarPartes({ ...foto, nodes: null });
      render();
      refrescarAbiertos(foto);
    },
    onCambio(p) {
      aplicarPartes(p);
      render();
      refrescarAbiertos(p);
    },
    onAlarma({ al }) { if (!al.acked) fireAlarm(al); },
  });
  S.store = crearStoreRemoto(orden);
  applyWake();
  // Service worker y notificaciones solo con https (Tailscale); por http en la red de casa, el navegador no los deja.
  if (window.isSecureContext && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").then((r) => { swReg = r; }).catch(() => {});
  }
  setInterval(render, 15000); // «hace X min»
}
/** Una línea en el diagnóstico de esta pantalla (el del servidor viene con su estado). */
function addLogLocal(msg) { S.diag = [...(S.diag || []), { t: Date.now(), msg }].slice(-60); }

/* ───────────── arranque ───────────── */
async function boot() {
  if (SERVIDOR) return bootServidor();
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
    if (dev?.kind === "serial" && canSerial()) {
      receptor = makeReceptor();
      S.device = dev;
      receptor.restoreSerial(dev).catch(() => {});
    } else if (dev && dev.kind !== "serial" && !btSupportMsg()) {
      receptor = makeReceptor();
      S.device = dev;
      receptor.restore(dev.id).catch(() => {});
    }
  }
  // Cable: al enchufar el nodo (con permiso ya dado) se conecta solo, salvo que se desconectara a mano.
  navigator.serial?.addEventListener?.("connect", () => {
    if (S.demo || S.userIdle || S.device?.kind !== "serial") return;
    if (receptor?.kind === "serial" && receptor.state === "reconnecting") return receptor.retryNow();
    if (receptor && receptor.state !== "idle") return;
    if (!receptor) receptor = makeReceptor();
    receptor.restoreSerial(S.device).catch(() => {});
  });
  applyWake();
  if (window.__VIGIA_PWA && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").then((r) => { swReg = r; }).catch(() => {});
  }
  setInterval(() => { evalOffline(); render(); }, 15000);
  setInterval(() => { if (S.link.state === "reconnecting") renderTop(); }, 1000);
}
boot();
