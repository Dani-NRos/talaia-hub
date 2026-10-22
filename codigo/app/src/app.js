import { fmtNum, registrarMetricas } from "@vigia/nucleo/metrics.js";
import { createMapView } from "./map.js";
import { ctx } from "./ctx.js";
import { sparkHTML, sparkStateHTML } from "./charts.js";
import { $, esc, setHTML, LS, parseNum, ICON } from "./ui.js";
import { refreshPosition, copyText, patchSwitches, setFence, setFenceRadius, removeFence, toggleSwitch } from "./views/node-parts.js";
import { renderNodes, onNodesQuery, saveNodesView } from "./views/nodes.js";
import { renderLog } from "./views/alarms.js";
import { boardHTML, renderCards, toggleCard, toggleAllCards, moveCard, displayName } from "./views/dashboard.js";
import { openSheet, onSheetClose, renderSheet, drawCharts, refreshSheetLive, refreshRequests, patchRequestStatus, legHops, setSheetRange, resizeSheet, trendFormFill, addTrend, removeTrend, saveStateAlarm, saveRuleFromInput, watch, unwatch, isSheetOpen } from "./views/sheet.js";
import { patchPanels, data, meshOut, newPanelSheet, createPanel } from "./views/panel-config.js";
import { openFull, closeFull, refreshFull, setFullRange, resizeFull } from "./views/fullscreen.js";
import { loraSf } from "@vigia/nucleo/route.js";
import { channelWhy } from "@vigia/nucleo/canales.js";
import { FILTERS } from "./meshsearch.js";
import { conectarServidor, crearStoreRemoto } from "./remoto.js";
import { t as tr, setLang, getLang, LANGS } from "./i18n.js";
import { initShell, go, isView, setAlarms, relabel, getTheme, setTheme } from "./shell.js";
import { HOUR, hhmm, ago, stamp } from "@vigia/nucleo/textos.js";
import { metasDe } from "@vigia/nucleo/mqtt-datos.js";
import { crearMotor, estadoInicial, MESH_HOURLY, askKey, seriesKey } from "@vigia/nucleo/motor.js";

/* ───────────── utilidades ───────────── */
const APP_VERSION = "1.20.0";
const REPO_URL = "https://github.com/Dani-NRos/talaia-hub";
const ISSUES_URL = `${REPO_URL}/issues`;




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
  lectura(num) { if (S.detail && S.detail.num === num) refreshSheetLive(); refreshFull(num); },
  posicion: (num) => refreshPosition(num),
  peticion: (num) => refreshRequests(num),
  peticionEstado: (num) => patchRequestStatus(num),
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
const { raise, ack, unacked, alarmTitle, alarmDetail, receptorUsesPki, hopName, meshCfg } = motor;
let servidor = null; // modo «Servidor»: la conexión con él
const orden = (datos) => servidor.orden(datos);
Object.assign(ctx, { S, motor, orden, toast: (m) => toast(m), render: () => render(), sparkHTML, sparkStateHTML });

/* ───────────── persistencia: solo lo de este aparato ───────────── */
function saveSettings() { LS.set("vigia.settings", S.settings); }

function showErr(el, msg) { el.textContent = msg; el.hidden = false; }

// Solo se reescribe el texto de estado cada segundo, para no robar toques a los botones.
setInterval(() => {
  const waiting = new Set([...S.req.values()].filter((r) => r.state === "wait").map((r) => r.num));
  for (const num of waiting) patchRequestStatus(num);
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

function meshSection() {
  const cfg = meshCfg();
  const chs = S.channels;
  const chOpts = [`<option value=""${cfg.channel == null ? " selected" : ""}>Ninguno</option>`]
    .concat(chs.map((c) => `<option value="${c.index}"${c.private ? "" : " disabled"}${cfg.channel === c.index ? " selected" : ""}>${c.index} · ${esc(c.name)}${c.private ? "" : " — público"}</option>`)).join("");
  const nodes = [...S.nodes.values()].filter((n) => n.num !== S.myNode && n.num >= 0).sort((a, b) => displayName(a).localeCompare(displayName(b), "es"));
  const pki = receptorUsesPki();
  const nodeOpts = [`<option value=""${cfg.node == null ? " selected" : ""}>Ninguno</option>`]
    .concat(nodes.map((n) => `<option value="${n.num}"${cfg.node === n.num ? " selected" : ""}>${esc(displayName(n))} (${esc(n.short)})${pki && n.key === false ? " — sin clave" : ""}</option>`)).join("");
  let chHint = "";
  if (!chs.length) chHint = `<p class="hint">Conecta el receptor para ver sus canales.</p>`;
  const pub = chs.filter((c) => !c.private);
  if (chs.length && pub.length) chHint = `<p class="hint">Bloqueados por públicos: ${pub.map((c) => `${esc(c.name)} (${esc(channelWhy(c))})`).join(", ")}.</p>`;
  if (chs.length && !chs.some((c) => c.private)) chHint += `<p class="warn-t">Tu receptor no tiene ningún canal privado. Crea uno en la app de Meshtastic con una clave aleatoria y compártelo (con su código QR) con quien deba recibir los avisos.</p>`;
  const sel = cfg.channel != null ? chs.find((c) => c.index === cfg.channel) : null;
  if (sel && !sel.private) chHint += `<p class="warn-t">El canal guardado («${esc(sel.name)}») es público y no se usará.</p>`;
  const nsel = cfg.node != null ? S.nodes.get(cfg.node) : null;
  const nodeHint = nsel && pki && nsel.key === false
    ? `<p class="warn-t">Tu receptor no tiene la clave de ${esc(displayName(nsel))}: pide su ficha en su tarjeta o el aviso no saldrá (error 39).</p>` : "";
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




/* ───────────── tarjetas de los nodos vigilados ───────────── */



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
  if ("fullRange" in ds) return setFullRange(ds.fullRange);
  if ("routeMap" in ds) { const num = Number(ds.routeMap); return S.traces[num] && openMap(num, { to: num, ...S.traces[num] }); }
  if ("copy" in ds) return copyText(ds.copy, t);
  if ("fenceSet" in ds) return setFence(Number(ds.fenceSet));
  if ("fenceDel" in ds) return removeFence(Number(ds.fenceDel));
  if ("trendAdd" in ds) return addTrend(Number(ds.trendAdd));
  if ("trendDel" in ds) return S.detail && removeTrend(S.detail.num, ds.trendDel);
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
  if ("orden" in ds) return toggleSwitch(Number(ds.num), ds.orden);
  if ("panelNuevo" in ds) return newPanelSheet();
  if ("panelCrear" in ds) return createPanel(openSheet);
  if ("panelQuitar" in ds) {
    if (Date.now() - unwatchArmed > 4000) { unwatchArmed = Date.now(); t.textContent = tr("sheet.removeArm"); return; }
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
    if ("conUsar" in ds) return data.useConn(num, Number(ds.conUsar));
    if ("datSave" in ds) return data.save(num);
    if ("datBuscar" in ds) return data.find(t, num);
    if ("datUsar" in ds) return data.use(num, Number(ds.datUsar));
    if ("datDel" in ds) return data.remove(num, Number(ds.datDel));
    return data.add(num);
  }
  if ("mallaSave" in ds) return meshOut.save();
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
    if (Date.now() - unwatchArmed > 4000) { unwatchArmed = Date.now(); t.textContent = tr("sheet.unwatchArm"); return; }
    unwatchArmed = 0;
    await unwatch(Number(ds.unwatch));
    if (isSheetOpen()) { renderSheet(); drawCharts(); }
    return;
  }
  if ("range" in ds) return setSheetRange(ds.range);
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
  if ("open" in ds) return openSheet(Number(ds.open));
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
    if (first && S.meshQ.trim()) openSheet(Number(first.dataset.open));
    return;
  }
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.(".card[data-open]")) { ev.preventDefault(); openSheet(Number(ev.target.dataset.open)); }
  if (ev.key === "Enter" && ev.target.closest?.(".tr-form") && ev.target.matches("input")) { ev.preventDefault(); return S.detail && addTrend(S.detail.num); }
  if (ev.key === "Enter" && ev.target.matches?.("#detail .inp")) ev.target.blur();
});

document.addEventListener("input", (ev) => {
  if (ev.target.id === "meshQ") onNodesQuery(ev.target.value);
  if (ev.target.closest?.("#mqttBox")) editarMqtt(ev.target);
  if (ev.target.id === "filtroTemas") return S.detail && data.filter(ev.target.value, S.detail.num);
  if (S.detail && ev.target.closest?.("#conBox") && ev.target.matches("input:not([type=checkbox])[data-con-k]")) data.changeConn(S.detail.num, ev.target);
  if (S.detail && ev.target.closest?.("#datBox") && ev.target.matches("input:not([type=checkbox])[data-dat-k]")) data.change(S.detail.num, ev.target);
});

document.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (t.closest?.("#conBox")) return S.detail && t.dataset.conK && data.changeConn(S.detail.num, t);
  if (t.closest?.("#datBox")) return S.detail && t.dataset.datK && data.change(S.detail.num, t);
  if (t.closest?.("#mallaBox")) return meshOut.change(t);
  if (t.closest?.("#nomBox")) {
    if (t.id !== "pnTipo" || !S.detail) return; // el nombre se guarda con su botón
    const r = await orden({ orden: "tipoPanel", num: S.detail.num, tipo: t.value });
    return toast(r.ok ? tr("sheet.saved") : r.error);
  }
  if (t.id === "npTipo" || t.id === "npNombre") return;
  if (t.closest?.("#mqttBox")) return editarMqtt(t);
  if (t.id === "meshSort") { S.meshView.sort = t.value; S.meshExpanded = false; saveNodesView(); return renderNodes(); }
  if (t.id === "fence-r") return S.detail && setFenceRadius(S.detail.num, t);
  if (t.id === "tr-metric") return trendFormFill();
  if (t.closest(".tr-form")) return; // se guarda con el botón
  if (t.matches("[data-est-cuando], [data-est-min]")) return saveStateAlarm(t);
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
$("#detail").addEventListener("close", () => { onSheetClose(); unwatchArmed = 0; });
// On rotating the phone or resizing, the charts are redrawn at the new size.
window.addEventListener("resize", () => { resizeFull(); resizeSheet(); });

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
    if (("cfg" in p || "active" in p || "traces" in p) && !escribiendo("#detail input, #detail select")) { renderSheet(); drawCharts(); }
    else if (p.nodes?.some((n) => n.num === num) && Object.keys(S.nodes.get(num)?.metrics || {}).some((k) => !$(`#detail [data-cur="${k}"]`)) && !escribiendo("#detail input, #detail select")) {
      renderSheet(); // a new metric (its first datum): its row of limits and its chart
      drawCharts();
    } else {
      if (p.nodes?.some((n) => n.num === num) || p.rows?.some((r) => r.node === num)) refreshSheetLive();
      if ("req" in p || "traces" in p) { refreshRequests(num); refreshPosition(num); }
    }
    if ("paneles" in p || "mqtt" in p || "channels" in p) patchPanels(); // values, names of the brokers, channels
  }
  if (S.full && (p.nodes || p.rows || "active" in p)) refreshFull(S.full.num);
  if ((S.detail || S.full) && ("paneles" in p || p.nodes)) patchSwitches();
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
