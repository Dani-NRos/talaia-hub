import { metricMeta, sortMetrics, fmtValue, fmtWithUnit, fmtNum, fmtLimit, registrarMetricas } from "@vigia/nucleo/metrics.js";
import { createMapView } from "./map.js";
import { ctx } from "./ctx.js";
import { $, $$, esc, setHTML, LS, parseNum, ICON } from "./ui.js";
import { requestBlock, requestStatus, positionBlock, refreshPosition, copyText, switchHTML, patchSwitches } from "./views/node-parts.js";
import { renderNodes, onNodesQuery, saveNodesView } from "./views/nodes.js";
import { renderLog } from "./views/alarms.js";
import { boardHTML, renderCards, toggleCard, toggleAllCards, moveCard, panelState, metaLine, stateRuleText, trendShort, displayName, saveCardUi } from "./views/dashboard.js";
import { relays, snrQuality, loraSf, weakest, UNKNOWN_NODE, PRESET_NAME } from "@vigia/nucleo/route.js";
import { trendDefault, parseTrendRule } from "@vigia/nucleo/trend.js";
import { FILTERS } from "./meshsearch.js";
import { conectarServidor, crearStoreRemoto } from "./remoto.js";
import { t as tr, setLang, getLang, LANGS } from "./i18n.js";
import { initShell, go, isView, setAlarms, relabel, getTheme, setTheme } from "./shell.js";
import { MIN, HOUR, DAY, isNum, hhmm, dShort, ago, stamp, dur, trendDec, fmtTrend, trendVerb, hoursText, lastWindow } from "@vigia/nucleo/textos.js";
import { TIPOS, LISTA_TIPOS, TIPOS_PANEL, NOMBRES_ESTADO, tipoMalla, esEstado, unidades, adivinarTipo, adivinarEstado, proponerOrden, unidadDe, textoDato, metasDe, MALLA_MAX_SALTOS } from "@vigia/nucleo/mqtt-datos.js";
import { crearMotor, estadoInicial, MESH_HOURLY, askKey, seriesKey, trendKey, estadoKey, hexId } from "@vigia/nucleo/motor.js";

/* ───────────── utilidades ───────────── */
const APP_VERSION = "1.20.0";
const REPO_URL = "https://github.com/Dani-NRos/talaia-hub";
const ISSUES_URL = `${REPO_URL}/issues`;


const wday = new Intl.DateTimeFormat("es-ES", { weekday: "short" });


/* ───────────── estado ───────────── */
const DEFAULT_SETTINGS = { sound: true, wake: false, retentionDays: 30, defaultOfflineMin: 75, mesh: null };
// Lo que comparte con el servidor (nodos, alarmas, peticiones…) lo define el núcleo; aquí se añade lo de pantalla.
const S = {
  ...estadoInicial(),
  settings: { ...DEFAULT_SETTINGS },
  trouble: null, // último fallo de conexión clasificado
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
let swReg = null;
let mapView = null; // se crea al abrir el mapa por primera vez

/* ───────────── motor (núcleo común con el servidor) ───────────── */
const motor = crearMotor(S, {
  cambio: () => render(),
  lectura(num) { if (S.detail && S.detail.num === num) refreshDetailLive(); refreshFull(num); },
  posicion: (num) => refreshPosition(num),
  peticion: (num) => refreshAsk(num),
  peticionEstado: (num) => patchAskStatus(num),
  ruta() { if (mapView && isView("map")) mapView.update(); },
  avisoMalla: () => patchMeshLast(),
  registro: () => renderLog(),
  alarma: (al) => fireAlarm(al),
  toast: (msg) => toast(msg),
  diag: (e) => pushDiag(e),
  // El servidor lo guarda todo; aquí solo los ajustes de este aparato (sonido, pantalla encendida).
  guardar: (k) => { if (k === "settings") saveSettings(); },
  // El servidor tiene la radio: las peticiones le llegan como órdenes (askUI), nunca salen de aquí.
  radio: { listo: () => S.servidorOk },
});
const {
  node, trendNow, raise,
  ack, unacked, alarmTitle, alarmDetail, canAsk, receptorUsesPki, hopName, meshCfg,
} = motor;
let servidor = null; // modo «Servidor»: la conexión con él
const orden = (datos) => servidor.orden(datos);
Object.assign(ctx, { S, motor, orden, toast: (m) => toast(m), render: () => render(), sparkHTML, sparkStateHTML: sparkEstadoHTML });

/* ───────────── persistencia: solo lo de este aparato ───────────── */
function saveSettings() { LS.set("vigia.settings", S.settings); }

/* ───────────── cambio rápido (tendencia) ───────────── */
/** «ha bajado 1,2 hPa en las últimas 3 horas» con los datos de ahora, para la ficha. */
function trendNowText(num, k, rule) {
  const r = trendNow(num, k, rule);
  if (!r) return `Ahora: aún no hay lecturas de hace ${hoursText(rule.hours / 2)} o más para comparar.`;
  if (r.change <= 0) return `Ahora: no ${rule.dir === "down" ? "ha bajado" : "ha subido"} ${lastWindow(rule.hours)}.`;
  return `Ahora: ${rule.dir === "down" ? "ha bajado" : "ha subido"} ${fmtTrend(k, r.change, trendDec(k, r.change))} ${lastWindow(rule.hours)}.`;
}

/* ───────────── pedir datos a un nodo ───────────── */
function refreshAsk(num) {
  for (const el of $$(`[data-ask-box="${num}"]`)) el.innerHTML = requestBlock(num, el.dataset.sheet === "1");
  for (const el of $$(`[data-route-box="${num}"]`)) el.innerHTML = routeBlock(num);
}
function patchAskStatus(num) {
  for (const el of $$(`[data-ask-st="${num}"]`)) el.innerHTML = requestStatus(num);
  for (const el of $$(`[data-pos-st="${num}"]`)) el.innerHTML = requestStatus(num, ["pos"]);
  for (const el of $$(`[data-route-st="${num}"]`)) el.innerHTML = requestStatus(num, ["route"]);
}

/* ───────────── ruta por la malla (traceroute) ───────────── */
function legHops(leg) {
  const k = relays(leg).length;
  return k === 0 ? tr("route.direct") : tr(k === 1 ? "route.via1" : "route.via", { n: k });
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
  h += `<p class="ask-st" data-route-st="${num}">${requestStatus(num, ["route"])}</p>`;
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

async function setFence(num) {
  const r = parseNum($("#fence-r")?.value);
  const res = await orden({ orden: "valla", num, radio: r });
  if (res.error) return toast(res.error);
  if (!res.ok) return;
  refreshPosition(num);
  render();
  toast(res.toast);
}
async function setFenceRadius(num, input) {
  const r = parseNum(input.value);
  const res = await orden({ orden: "radioValla", num, radio: r });
  if (res.error) { if (res.radio != null) input.value = res.radio; return toast(res.error); }
  if (!res.ok) return;
  input.blur();
  refreshPosition(num);
  render();
  toast(res.toast);
}
async function delFence(num) {
  if (!(await orden({ orden: "quitarValla", num })).ok) return;
  refreshPosition(num);
  render();
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
const nom = displayName; // el nombre que se ve: el de Vigía, o el de Meshtastic
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
      <p class="hint">Sale un mensaje al saltar cada alarma de umbral, cambio rápido, sin señal o fuera de su sitio: en un canal lo leen todos los que lo tengan; a un nodo, solo él, y se da por entregado cuando ese nodo lo confirma (que un vecino lo repita no basta). Como mucho uno cada 8 s y ${MESH_HOURLY} por hora, para no saturar la malla. Los manda el servidor, aunque no haya ninguna pantalla abierta. Los canales públicos están bloqueados porque lo leería cualquiera.</p>
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
    return;
  }
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || wake) return;
  try {
    wake = await navigator.wakeLock.request("screen");
    wake.addEventListener("release", () => { wake = null; });
  } catch {
    toast("Este navegador no deja mantener la pantalla encendida.");
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    applyWake();
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
  if (!tramos.length) return `<div class="spark spark-empty"><span>${esc(tr("card.noHistory"))}</span></div>`;
  const x = (t) => ((t - from) / (now - from)) * W;
  return `<div class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${tramos.map((s) => `<rect class="eb ${s.v ? "on" : "off"}" x="${x(s.a).toFixed(1)}" y="8" width="${Math.max(0.5, x(s.b) - x(s.a)).toFixed(1)}" height="${H - 16}"/>`).join("")}</svg></div>`;
}

/** Mini gráfica de la tarjeta: se estira al ancho, el punto final va en HTML. */
function sparkHTML(series, metric, rule) {
  const W = 300, H = 46;
  const now = Date.now(), from = now - DAY;
  const ser = series.filter((p) => p.t >= from && !(metric === "batteryLevel" && p.v > 100));
  const dom = yDomain(ser, metric, rule);
  if (!dom || ser.length < 2 || ser[ser.length - 1].t - ser[0].t < 45 * MIN) return `<div class="spark spark-empty"><span>${esc(tr("card.noHistory"))}</span></div>`;
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
    renderNodes();
    renderLog();
    if (isView("map")) mapView?.update();
    if (S.full) refreshFull(null);
    setAlarms(unacked().length);
  });
}


/** Barra de arriba: primero, si hay conexión con el servidor; después, cómo está su receptor. */
function renderTop() {
  const b = $("#linkBtn");
  const st = !S.servidorOk ? "noserver" : S.link.state;
  // On a phone the short label leaves room for the section's name.
  let label, short;
  const name = S.nodes.get(S.myNode)?.short || tr("link.receiver");
  if (!S.servidorOk) [label, short] = [tr("link.noServer"), tr("link.short.noServer")];
  else if (st === "ready") [label, short] = [tr("link.ready", { name }), name];
  else if (st === "configuring") [label, short] = [S.link.extra?.packets ? tr("link.readingN", { n: S.link.extra.packets }) : tr("link.reading"), tr("link.short.reading")];
  else if (st === "reconnecting" || st === "connecting") [label, short] = S.trouble?.kind === "unplugged" ? [tr("link.unplugged"), tr("link.short.unplugged")] : [tr("link.lost"), tr("link.short.lost")];
  else [label, short] = [tr("link.stopped"), tr("link.short.stopped")];
  b.dataset.state = st;
  b.setAttribute("aria-label", label);
  setHTML(b, `<span class="ld"></span>${ICON.server}<span class="lt">${esc(label)}</span><span class="lt-s" aria-hidden="true">${esc(short)}</span>`);
}

function renderBoard() {
  const html = boardHTML();
  setHTML($("#board"), html);
  setHTML($("#alarmBoard"), html);
}

/* ───────────── cuando el servidor o su receptor no conectan ───────────── */

/* ───────────── diagnóstico de conexión ───────────── */
function pushDiag(e) {
  S.diag.push(e);
  if (S.diag.length > 150) S.diag.splice(0, S.diag.length - 150);
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
    "",
  ];
  return head.join("\n") + S.diag.map(diagLine).join("\n");
}
/** Enlace a un aviso nuevo en GitHub con el diagnóstico ya pegado (recortado para que quepa en la URL). */
function issueUrl() {
  const intro = "**Qué pasó:**\n\n\n**Modelo del nodo receptor y versión de firmware:**\n\n\n**Diagnóstico** (revísalo antes de enviar: el aviso es público)\n";
  const lines = diagText().split("\n");
  const keep = 3; // cabecera: versión, navegador y receptor
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


async function mandarOrden(num, k) {
  const cur = S.nodes.get(num)?.metrics?.[k];
  const res = await orden({ orden: "mandar", num, clave: k, v: cur?.v === 1 ? 0 : 1 });
  if (!res.ok && res.error) toast(res.error);
}


/* ───────────── tarjetas de los nodos vigilados ───────────── */



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
    const lim = m.estados ? stateRuleText(k, r.estado) || (cur.desde ? `desde las ${hhmm.format(new Date(cur.desde))}` : "")
      : [isNum(r.min) ? `mín ${fmtLimit(k, r.min)}` : "", isNum(r.max) ? `máx ${fmtLimit(k, r.max)}` : "", r.trend ? trendShort(k, r.trend) : ""].filter(Boolean).join(" · ");
    const unit = k === "batteryLevel" && cur.v > 100 ? "" : m.unit;
    return `<div class="nv-tile${bad ? " bad" : ""}"><span class="nv-l">${esc(m.label)}</span>${m.estados ? switchHTML(num, k) : ""}<span class="nv-v${m.estados ? " est" : ""}">${esc(fmtValue(k, cur.v))}${unit ? `<small>${esc(unit)}</small>` : ""}</span><span class="nv-s">${lim ? `<span class="nv-lim">${esc(lim)}</span>` : ""}<span data-fmm="${k}"></span><span>${esc(ago(cur.t))}</span></span></div>`;
  }).join("");
}
function renderFull() {
  if (!S.full) return;
  const { num, range } = S.full;
  const n = node(num);
  const [st, stLabel] = panelState(num);
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
  const [st, stLabel] = panelState(S.full.num);
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






/* ───────────── mapa ───────────── */
const TILE_CACHE = "teselas-osm"; // el mismo nombre que en sw.js
let persistAsked = false;
let mapWanted = null; // what the Map section has to show when it opens: { focus, route }
/** focus: nodo en el que centrar el mapa (desde su tarjeta o su ficha). route: { to, fwd, back } de un traceroute. */
function openMap(focus = null, route = null) {
  if ($("#detail").open) $("#detail").close();
  if ($("#nodeview").open) $("#nodeview").close();
  mapWanted = { focus, route };
  go("map");
}
function enterMap() {
  // Que el navegador no vacíe el fondo guardado cuando el móvil vaya justo de espacio.
  if (!persistAsked) { persistAsked = true; navigator.storage?.persist?.().catch(() => {}); }
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
  const w = mapWanted || { focus: null, route: null };
  mapWanted = null;
  mapView.open(w.focus, w.route);
}

/* ───────────── detalle de nodo ───────────── */
function openDetail(num) {
  // Lo cambiado sin guardar se queda si se vuelve a abrir el mismo panel (al cerrar se avisa); con otro, no.
  if (datBorrador && datBorrador.num !== num) { datBorrador = null; filtroTemas = ""; }
  if (num !== S.myNode) mallaBorrador = null;
  S.detail = { num, range: S.detail?.num === num ? S.detail.range : "24h" };
  renderDetail();
  const d = $("#detail");
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
    body += `<section class="blk"><h3>Pedir datos ahora</h3><div class="ask in-sheet" data-ask-box="${num}" data-sheet="1">${requestBlock(num, true)}</div>
    <p class="hint">La petición sale por LoRa desde tu receptor y el nodo contesta con una lectura recién tomada. Si está dormido para ahorrar batería o fuera de alcance, no contesta.</p></section>`;
    body += `<section class="blk"><div class="route-box" data-route-box="${num}">${routeBlock(num)}</div></section>`;
    body += `<section class="blk"><div class="pos in-sheet" data-pos-box="${num}" data-sheet="1">${positionBlock(num, true)}</div></section>`;
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
  if (w) body += nombreSection(num) + datosSection(num) + (num === S.myNode ? mallaSection() : "");
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
    if (Number.isNaN(v)) { showErr(err, "Pon un número de minutos (1 o más) o déjalo vacío."); inp.focus(); return; }
    const res = await orden({ orden: "sinSenal", num, valor: v });
    if (res.error) { showErr(err, res.error); inp.focus(); return; }
    err.hidden = true;
    render();
    toast(res.toast);
    return;
  }
  const k = inp.dataset.rule, side = inp.dataset.side;
  const v = parseNum(inp.value);
  if (Number.isNaN(v)) { showErr(err, `“${inp.value}” no es un número. Usa coma o punto para los decimales.`); inp.focus(); return; }
  const res = await orden({ orden: "limite", num, metrica: k, lado: side, valor: v });
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
    return `<div class="est-al-r${S.active.has(estadoKey(num, k)) ? " bad" : ""}" data-sw-num="${num}"><span class="est-al-n">${esc(m.label)} <b data-now="${k}">${cur ? esc(fmtValue(k, cur.v)) : "—"}</b>${switchHTML(num, k)}</span>
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
  const res = await orden({ orden: "tendencia", num, metrica: k, regla: rule });
  if (res.error) { showErr(err, res.error); return; }
  refreshTrend(num, k);
  render();
  toast(res.toast);
}
async function delTrend(num, k) {
  const res = await orden({ orden: "quitarTendencia", num, metrica: k });
  if (!res.ok) return;
  refreshTrend(num);
  render();
  toast(res.toast);
}

async function watch(num) {
  const res = await orden({ orden: "vigilar", num });
  if (!res.ok) { if (res.error) toast(res.error); return; }
  res.recientes?.then(render);
  render();
  if (S.detail?.num === num && $("#detail").open) { renderDetail(); drawCharts(); }
  toast(res.toast);
}

async function unwatch(num) {
  await orden({ orden: "dejar", num });
  // Lo de la pantalla (tarjeta contraída, orden) es de este aparato.
  delete S.ui.collapsed[num];
  S.ui.order = S.ui.order.filter((n) => n !== num);
  saveCardUi();
  render();
}

/* ───────────── ajustes ───────────── */
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
  const rec = receptorServidorHTML();
  const notifState = !("Notification" in window) ? "none" : !window.isSecureContext ? "http" : Notification.permission;
  const notif = notifState === "granted" ? `<span class="okt">Activadas</span>`
    : notifState === "http" ? `<span class="hint">El navegador solo las deja con https (llegarán con Tailscale)</span>`
    : notifState === "denied" ? `<span class="warn-t">Bloqueadas en los ajustes del navegador</span>`
    : notifState === "none" ? `<span class="hint">No disponibles aquí</span>`
    : `<button class="btn ghost" data-notif>Activar</button>`;
  $("#settings").innerHTML = `
    ${screenSection()}
    <section class="blk"><h3>Receptor</h3>${rec}</section>
    <section class="blk"><h3>Avisos</h3>
      <div class="set-row"><label class="sw" for="setSound"><input type="checkbox" id="setSound" ${S.settings.sound ? "checked" : ""}><span class="sw-ui"></span><span>Sonido de alarma</span></label><button class="btn ghost" data-test>Probar alarma</button></div>
      <div class="set-row"><label class="sw" for="setWake"><input type="checkbox" id="setWake" ${S.settings.wake ? "checked" : ""}><span class="sw-ui"></span><span>Mantener la pantalla encendida</span></label></div>
      <div class="set-row"><span>Notificaciones del sistema</span>${notif}</div>
      <div class="set-row"><label for="setOff">Sin señal, valor para nodos nuevos</label><span class="inp-u"><input id="setOff" class="inp" inputmode="numeric" autocomplete="off" value="${S.settings.defaultOfflineMin}"><span>min</span></span></div>
      <p class="hint">El servidor vigila siempre. Esta pantalla suena y avisa mientras está abierta; si das «Enterado» aquí, queda visto en todos tus aparatos.</p>
    </section>
    ${meshSection()}
    ${mqttSection()}
    <section class="blk"><h3>Histórico</h3>
      <div class="set-row"><span id="histCount">Contando lecturas…</span><select id="setRet" class="inp sel" aria-label="Tiempo que se guardan las lecturas">${[7, 30, 90, 365].map((d) => `<option value="${d}"${S.settings.retentionDays === d ? " selected" : ""}>Guardar ${d} días</option>`).join("")}</select></div>
      <div class="btns"><button class="btn ghost" data-export>Exportar CSV</button><button class="btn danger-ghost" data-wipe>Borrar histórico</button></div>
    </section>
    <section class="blk"><h3>Mapa sin internet</h3>
      <div class="set-row"><span id="tileCount">Contando el fondo guardado…</span><button class="btn ghost" data-wipe-tiles>Borrar fondo guardado</button></div>
      <p class="hint">El fondo del mapa se guarda solo de las zonas que ves con conexión y en los zooms que usas, hasta unas 2.000 teselas (unos 40 MB). Antes de ir a un sitio sin cobertura, recórrelo en el mapa con internet.</p>
      <p class="hint" id="tilePersist"></p>
    </section>
    <section class="blk" id="diagBox"><h3>Diagnóstico de conexión</h3>
      <p class="hint">Cada paso de la conexión queda apuntado aquí. Si falla, copia el diagnóstico: dice en qué paso se corta.</p>
      <pre class="diag" id="diagList">${esc(diagLines(40))}</pre>
      <div class="btns"><button class="btn ghost" data-copy-diag>Copiar diagnóstico</button><button class="btn ghost" data-report>Avisar del fallo en GitHub</button></div>
      <p class="hint">«Avisar del fallo» abre un aviso nuevo en GitHub con el diagnóstico ya pegado. Necesita internet y una cuenta de GitHub, y el aviso es público: revisa el texto antes de enviarlo.</p>
    </section>
    <section class="blk about"><h3>Acerca de</h3>
      <p><strong>Talaia ${APP_VERSION}</strong>. Vigilancia de una malla Meshtastic y de dispositivos MQTT, en tu red. Antes, Vigía. Hecho por Dani-NRos.</p>
      <div class="btns"><a class="btn ghost" href="${REPO_URL}" target="_blank" rel="noopener">Código en GitHub</a><a class="btn ghost" href="${ISSUES_URL}" target="_blank" rel="noopener">Avisos y sugerencias</a></div>
      <p class="hint">Para abrir los enlaces hace falta internet. Si algo falla o echas algo en falta, cuéntalo en los avisos de GitHub.</p>
      <p class="hint">Código abierto con licencia GPL-3.0. Proyecto independiente, no afiliado a Meshtastic. Meshtastic® es una marca registrada de Meshtastic LLC.</p>
    </section>`;
  S.store.count().then((c) => { const el = $("#histCount"); if (el) el.textContent = `${c.toLocaleString("es-ES")} lecturas`; });
  tileInfo();
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
function openSettings() { go("settings"); }

/** Language and theme of this screen. */
function screenSection() {
  const langs = LANGS.map((l) => `<option value="${l.code}"${l.code === getLang() ? " selected" : ""}>${l.name}</option>`).join("");
  const themes = ["auto", "light", "dark"].map((v) => `<option value="${v}"${v === getTheme() ? " selected" : ""}>${esc(tr(`screen.theme.${v}`))}</option>`).join("");
  return `<section class="blk"><h3>${esc(tr("screen.title"))}</h3>
      <div class="set-row"><label for="setLang">${esc(tr("screen.lang"))}</label><select id="setLang" class="inp sel lang">${langs}</select></div>
      <div class="set-row"><label for="setTheme">${esc(tr("screen.theme"))}</label><select id="setTheme" class="inp sel theme">${themes}</select></div>
      <p class="hint">${esc(tr("screen.hint"))}</p>
    </section>`;
}

/** Automations: what they will be, until 2.1. */
function renderSoon() {
  $("#soon").innerHTML = `<span class="soon-tag">${esc(tr("auto.soon"))}</span><p>${esc(tr("auto.lead"))}</p><p>${esc(tr("auto.example"))}</p>`;
}

/* ───────────── Enterado y peticiones: van al servidor ───────────── */
function ackUI(key) {
  if (key === "test") return ack(key); // la alarma de prueba es solo de este aparato
  orden({ orden: "ack", key });
}
function ackAllUI() {
  if (S.active.has("test")) ack("test");
  orden({ orden: "ackAll" });
}
async function askUI(num, type) {
  const r = await orden({ orden: "pedir", num, tipo: type });
  if (r.toast || r.error) toast(r.toast || r.error);
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
let wipeArmed = 0, unwatchArmed = 0;
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
  if ("orderDone" in ds) { S.ordering = false; renderCards(); return toast(tr("dash.orderSaved")); }
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
  if ("retry" in ds) return orden({ orden: "reconectar" });
  if ("diag" in ds) { openSettings(); setTimeout(() => $("#diagBox")?.scrollIntoView({ block: "start" }), 80); return; }
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
    const res = await orden({ orden: "pruebaMalla" });
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
  if ("notif" in ds) { try { await Notification.requestPermission(); } catch { /* nada */ } renderSettings(); return; }
  if ("test" in ds) { unlockAudio(); raise("test", { kind: "test", num: null, t: Date.now() }); go("dashboard"); return; }
  if ("export" in ds) return location.assign("api/lecturas.csv");
  if ("wipe" in ds) {
    if (Date.now() - wipeArmed > 4000) { wipeArmed = Date.now(); t.textContent = "Toca otra vez para borrar"; return; }
    wipeArmed = 0;
    const res = await orden({ orden: "borrarHistorico" });
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
  if (t.id === "linkBtn") return openSettings();
  if (t.id === "meshMore") { S.meshExpanded = !S.meshExpanded; return renderNodes(); }
  if ("mf" in ds) {
    const f = new Set(S.meshView.filters);
    if (f.has(ds.mf)) f.delete(ds.mf); else f.add(ds.mf);
    S.meshView.filters = FILTERS.map((x) => x.key).filter((k) => f.has(k));
    S.meshExpanded = false;
    saveNodesView();
    return renderNodes();
  }
  if ("meshClear" in ds) {
    S.meshQ = "";
    $("#meshQ").value = "";
    S.meshView.filters = [];
    saveNodesView();
    renderNodes();
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
  // «/» lleva al buscador de Nodos desde cualquier sección.
  if (ev.key === "/" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.target.closest?.("input, textarea, select, [contenteditable]") && !document.querySelector("dialog[open]") && !$("#meshTools").hidden) {
    ev.preventDefault();
    if (!isView("nodes")) go("nodes");
    setTimeout(() => $("#meshQ").focus(), 0);
    return;
  }
  if (ev.key === "Escape" && ev.target.id === "meshQ") {
    if (ev.target.value) { ev.preventDefault(); ev.target.value = ""; onNodesQuery(""); } else ev.target.blur();
    return;
  }
  if (ev.key === "Enter" && ev.target.id === "meshQ") {
    // Intro abre el primer resultado.
    ev.preventDefault();
    onNodesQuery(ev.target.value, true);
    const first = $("#mesh .row-main");
    if (first && S.meshQ.trim()) openDetail(Number(first.dataset.open));
    return;
  }
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.(".card[data-open]")) { ev.preventDefault(); openDetail(Number(ev.target.dataset.open)); }
  if (ev.key === "Enter" && ev.target.closest?.(".tr-form") && ev.target.matches("input")) { ev.preventDefault(); return S.detail && addTrend(S.detail.num); }
  if (ev.key === "Enter" && ev.target.matches?.("#detail .inp")) ev.target.blur();
});

document.addEventListener("input", (ev) => {
  if (ev.target.id === "meshQ") onNodesQuery(ev.target.value);
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
  if (t.id === "meshSort") { S.meshView.sort = t.value; S.meshExpanded = false; saveNodesView(); return renderNodes(); }
  if (t.id === "fence-r") return S.detail && setFenceRadius(S.detail.num, t);
  if (t.id === "tr-metric") return trendFormFill();
  if (t.closest(".tr-form")) return; // se guarda con el botón
  if (t.matches("[data-est-cuando], [data-est-min]")) return guardarEstado(t);
  if (t.matches("#detail .inp")) return saveRuleFromInput(t);
  if (t.id === "setLang") {
    setLang(t.value);
    registrarMetricas(metasDe(S.paneles?.paneles)); // names of the MQTT data and of their states, in the new language
    relabel(); renderSoon(); render();
    return renderSettings();
  }
  if (t.id === "setTheme") return setTheme(t.value);
  if (t.id === "setSound") { S.settings.sound = t.checked; saveSettings(); if (t.checked) { unlockAudio(); beep(); } return; }
  if (t.id === "setWake") { S.settings.wake = t.checked; saveSettings(); return applyWake(); }
  if (t.id === "setOff") {
    const v = parseNum(t.value);
    const res = await orden({ orden: "sinSenalDefecto", valor: Number.isNaN(v) ? null : v });
    if (res.error) { t.value = res.valor; return toast(res.error); }
    return toast(res.toast);
  }
  if (t.id === "meshOn" || t.id === "meshClear") {
    const cambio = t.id === "meshOn" ? { enabled: t.checked } : { onClear: t.checked };
    const res = await orden({ orden: "malla", cambio });
    if (res.toast) toast(res.toast);
    return;
  }
  if (t.id === "meshCh" || t.id === "meshNode") {
    const v = t.value === "" ? null : Number(t.value);
    const cambio = t.id === "meshCh" ? { channel: v } : { node: v };
    const res = await orden({ orden: "malla", cambio });
    if (!res.ok) { t.value = ""; return toast(res.toast); }
    return renderSettings();
  }
  if (t.id === "setRet") { await orden({ orden: "retencion", dias: Number(t.value) }); return renderSettings(); }
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

/* ───────────── estado del servidor ───────────── */
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
      if ("req" in p || "traces" in p) { refreshAsk(num); refreshPosition(num); }
    }
    if ("paneles" in p || "mqtt" in p || "channels" in p) patchPaneles(); // valores, nombres de los brokers, canales
    if ("paneles" in p || p.nodes?.some((n) => n.num === num)) patchSwitches();
  }
  if (S.full && (p.nodes || p.rows || "active" in p)) refreshFull(S.full.num);
  if (isView("settings")) {
    if ("meshLast" in p) patchMeshLast();
    if ("mqtt" in p) patchMqtt();
    if (("link" in p || "diag" in p || "settings" in p || "channels" in p || "trouble" in p) && !escribiendo("#settings input, #settings select")) renderSettings();
  }
  if (mapView && isView("map") && (p.nodes || "traces" in p)) mapView.update();
}
/** Entering a section: the map is drawn when it shows; Settings, with what it has now. */
function enterView(view) {
  if (view === "map") enterMap();
  else if (view === "settings") renderSettings();
}
function leaveView(view) {
  if (view === "map") mapView?.leave();
}

function boot() {
  document.documentElement.lang = getLang();
  renderSoon();
  initShell({ enter: enterView, leave: leaveView });
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
      if (isView("settings")) renderSettings();
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

boot();
