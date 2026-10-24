// Settings, in six parts, each at its own address (#/settings/mesh…): the mesh (no-signal minutes for new nodes,
// alerts over the mesh, orders over the mesh: views/mesh-orders.js), MQTT (brokers, users of this server's broker,
// Home Assistant), the receiver (connection, radio, channels, diagnostics), the system (server language, history,
// about), users (views/users.js) and this screen (language, theme, sound, notifications, keeping the screen on, the
// map saved for offline use). This screen's part belongs to each device; the rest is the server's, the same on every
// screen.
import { ctx } from "../ctx.js";
import { t, getLang, setLang, locale, LANGS } from "../i18n.js";
import { $, esc, parseNum } from "../ui.js";
import { go, getTheme, setTheme } from "../shell.js";
import { displayName } from "./dashboard.js";
import { brokerLabel } from "./panel-config.js";
import { usersTab, usersClick } from "./users.js";
import { meshOrdersHTML, meshOrdersClick, meshOrdersChange, meshOrdersInput } from "./mesh-orders.js";
import { unlockAudio, beep, applyWake, notificationState } from "../alerts.js";
import { channelWhy } from "@talaia/nucleo/canales.js";
import { hexId, MESH_HOURLY } from "@talaia/nucleo/motor.js";
import { PRESET_NAME } from "@talaia/nucleo/route.js";
import { fmtNum } from "@talaia/nucleo/metrics.js";
import { hhmm, stamp } from "@talaia/nucleo/textos.js";

/* global __APP_VERSION__ */
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev"; // build.mjs puts it in
const REPO_URL = "https://github.com/Dani-NRos/talaia-hub";
const ISSUES_URL = `${REPO_URL}/issues`;
export const TILE_CACHE = "teselas-osm"; // the same name as in sw.js

export const TABS = ["mesh", "mqtt", "receiver", "system", "users", "screen"];
const TAB_KEY = "talaia.settingsTab";
let tab = null;
let hooks = { languageChanged() {}, saveDeviceSettings() {} };

const S = () => ctx.S;
const box = () => $("#settings");
function showErr(el, msg) { if (!el) return; el.textContent = msg; el.hidden = false; }
const typingIn = (sel) => !!document.activeElement?.matches?.(`${sel} input, ${sel} select`);

/**
 * hooks.languageChanged(): after a change of language, to redraw what is outside Settings.
 * hooks.saveDeviceSettings(): after changing what belongs to this device (sound, keeping the screen on).
 */
export function initSettings(h) {
  hooks = { ...hooks, ...h };
  const el = box();
  el.addEventListener("click", onClick);
  el.addEventListener("change", onChange);
  el.addEventListener("input", onInput);
}

/** Opens Settings at one of its parts (the one saved on this device if none). */
export function openSettings(part = null) { go("settings", part); }

/** Entering Settings (or another of its parts): sub is the part in the address. */
export function enterSettings(sub) {
  let stored = null;
  try { stored = localStorage.getItem(TAB_KEY); } catch { /* no storage */ }
  tab = TABS.includes(sub) ? sub : TABS.includes(stored) ? stored : TABS[0];
  if (sub !== tab) history.replaceState(null, "", `#/settings/${tab}`); // the address says which part is showing
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* no storage */ }
  renderSettings();
}

export function renderSettings() {
  if (!tab) return;
  const tabs = TABS.map((k) => `<a href="#/settings/${k}" class="tab"${k === tab ? ' aria-current="page"' : ""}>${esc(t(`set.tab.${k}`))}</a>`).join("");
  const body = { mesh: meshTab, mqtt: mqttTab, receiver: receiverTab, system: systemTab, users: usersTab, screen: screenTab }[tab]();
  box().innerHTML = `<nav class="tabs" aria-label="${esc(t("set.tabs"))}">${tabs}</nav><div class="tab-b" data-tab="${tab}">${body}</div>`;
  // On a phone not all the tabs fit: the row slides so the current one shows (without moving the page).
  const nav = box().querySelector(".tabs"), cur = nav.querySelector("[aria-current]");
  if (cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2);
  if (tab === "system") countReadings();
  if (tab === "screen") tileInfo();
}

/** What arrives from the server: the part on screen again, without overwriting what is being typed. */
export function patchSettings(p) {
  if (!tab || !document.querySelector("#v-settings:not([hidden])")) return;
  if (tab === "mesh" && "meshLast" in p) patchMeshLast();
  if (tab === "mqtt" && "mqtt" in p) patchMqtt();
  const redraw = {
    mesh: ["settings", "channels", "myNode", "meshOrders"],
    mqtt: [],
    receiver: ["link", "trouble", "device", "lora", "channels", "myNode", "myUser"],
    system: ["settings"],
    users: ["usuarios"],
    screen: [],
  }[tab];
  if (redraw.some((k) => k in p) && !typingIn("#settings")) renderSettings();
  if (tab === "receiver" && "diag" in p) patchDiag();
}

/* ── the mesh ── */

function meshLastHTML() {
  const l = S().meshLast;
  if (!l) return esc(t("set.mesh.noneYet"));
  const cls = l.ok === true ? "okt" : l.ok === false ? "warn-t" : "";
  return `${esc(t("set.mesh.last", { text: l.text, to: l.tg?.label || l.label }))}: <strong class="${cls}">${esc(l.result)}</strong> · ${esc(stamp(l.tDone || l.t))}`;
}
export function patchMeshLast() { const el = $("#meshLast"); if (el) el.innerHTML = meshLastHTML(); }

function meshTab() {
  const { motor } = ctx;
  const s = S();
  const cfg = motor.meshCfg();
  const chs = s.channels;
  const chOpts = [`<option value=""${cfg.channel == null ? " selected" : ""}>${esc(t("set.mesh.none"))}</option>`]
    .concat(chs.map((c) => `<option value="${c.index}"${c.private ? "" : " disabled"}${cfg.channel === c.index ? " selected" : ""}>${c.index} · ${esc(c.name)}${c.private ? "" : esc(t("pc.mesh.public"))}</option>`)).join("");
  const nodes = [...s.nodes.values()].filter((n) => n.num !== s.myNode && n.num >= 0).sort((a, b) => displayName(a).localeCompare(displayName(b), locale()));
  const pki = motor.receptorUsesPki();
  const nodeOpts = [`<option value=""${cfg.node == null ? " selected" : ""}>${esc(t("set.mesh.none"))}</option>`]
    .concat(nodes.map((n) => `<option value="${n.num}"${cfg.node === n.num ? " selected" : ""}>${esc(displayName(n))} (${esc(n.short)})${pki && n.key === false ? esc(t("set.mesh.noKey")) : ""}</option>`)).join("");
  let chHint = "";
  if (!chs.length) chHint = `<p class="hint">${esc(t("pc.mesh.connectFirst"))}</p>`;
  const pub = chs.filter((c) => !c.private);
  if (chs.length && pub.length) chHint = `<p class="hint">${esc(t("set.mesh.blocked", { list: pub.map((c) => `${c.name} (${channelWhy(c)})`).join(", ") }))}</p>`;
  if (chs.length && !chs.some((c) => c.private)) chHint += `<p class="warn-t">${esc(t("set.mesh.noPrivate"))}</p>`;
  const sel = cfg.channel != null ? chs.find((c) => c.index === cfg.channel) : null;
  if (sel && !sel.private) chHint += `<p class="warn-t">${esc(t("set.mesh.savedPublic", { name: sel.name }))}</p>`;
  const nsel = cfg.node != null ? s.nodes.get(cfg.node) : null;
  const nodeHint = nsel && pki && nsel.key === false ? `<p class="warn-t">${esc(t("set.mesh.nodeNoKey", { name: displayName(nsel) }))}</p>` : "";
  return `<section class="blk"><h3>${esc(t("set.off.title"))}</h3>
      <div class="set-row"><label for="setOff">${esc(t("set.off.label"))}</label><span class="inp-u"><input id="setOff" class="inp" inputmode="numeric" autocomplete="off" value="${s.settings.defaultOfflineMin}"><span>min</span></span></div>
      <p class="hint">${esc(t("set.off.hint"))}</p>
    </section>
    <section class="blk" id="meshBox"><h3>${esc(t("set.mesh.title"))}</h3>
      <div class="set-row"><label class="sw" for="meshOn"><input type="checkbox" id="meshOn" ${cfg.enabled ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("set.mesh.on"))}</span></label></div>
      <div class="set-row"><label for="meshCh">${esc(t("set.mesh.channel"))}</label><select id="meshCh" class="inp sel">${chOpts}</select></div>
      ${chHint}
      <div class="set-row"><label for="meshNode">${esc(t("set.mesh.node"))}</label><select id="meshNode" class="inp sel">${nodeOpts}</select></div>
      ${nodeHint}
      <div class="set-row"><label class="sw" for="meshClear"><input type="checkbox" id="meshClear" ${cfg.onClear ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("set.mesh.onClear"))}</span></label></div>
      <div class="btns"><button type="button" class="btn ghost" data-mesh-test>${esc(t("set.mesh.test"))}</button></div>
      <p class="hint" id="meshLast">${meshLastHTML()}</p>
      <p class="hint">${esc(t("set.mesh.hint", { n: MESH_HOURLY }))}</p>
    </section>
    ${meshOrdersHTML()}`;
}

/* ── MQTT: brokers, users of this server's broker, Home Assistant ── */

// What has been typed and not saved: if the part is redrawn (a state arrives…), it isn't lost.
let brokerEdit = null; // the broker being added (id null) or changed: { id, nombre, url, usuario, clave, activado }
let haDraft = null; // { activado, broker, base, prefijo }
const brokers = () => S().mqtt?.brokers || [];

function brokerStateHTML(b) {
  const e = b.estado || {};
  if (!b.activado) return esc(t("set.mqtt.off"));
  if (e.fase === "conectada") return `<span class="okt">${esc(t("set.mqtt.connected"))}</span> ${esc(t("set.mqtt.since", { time: hhmm.format(new Date(e.desde)) }))}`;
  if (e.fase === "error") return `<span class="warn-t">${esc(t("set.mqtt.cant"))}</span>: ${esc(t("set.mqtt.error", { error: e.error || "" }))}`;
  return esc(t("set.mqtt.connecting"));
}
function brokerEditorHTML() {
  const b = brokerEdit;
  const saved = b.id ? brokers().find((x) => x.id === b.id) : null;
  return `<div class="mq-ed">
      <div class="mq-f">
        <label for="brkNombre">${esc(t("set.mqtt.name"))}</label><input id="brkNombre" class="inp" data-brk="nombre" autocomplete="off" placeholder="Home Assistant" value="${esc(b.nombre || "")}">
        <label for="brkUrl">${esc(t("set.mqtt.address"))}</label><input id="brkUrl" class="inp" data-brk="url" autocomplete="off" spellcheck="false" placeholder="${esc(t("set.mqtt.addressEx"))}" value="${esc(b.url || "")}">
        <label for="brkUser">${esc(t("set.mqtt.user"))}</label><input id="brkUser" class="inp" data-brk="usuario" autocomplete="off" spellcheck="false" placeholder="${esc(t("set.mqtt.noUser"))}" value="${esc(b.usuario || "")}">
        <label for="brkPass">${esc(t("set.mqtt.password"))}</label><input id="brkPass" class="inp" data-brk="clave" type="password" autocomplete="new-password" placeholder="${esc(t(saved?.hayClave ? "set.mqtt.passSaved" : "set.mqtt.noPass"))}" value="${esc(b.clave || "")}">
      </div>
      <div class="set-row"><label class="sw" for="brkOn"><input type="checkbox" id="brkOn" data-brk="activado" ${b.activado !== false ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("set.mqtt.connected"))}</span></label></div>
      <p class="form-err" id="brkErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-brk-save>${esc(t("pc.save"))}</button>${saved?.hayClave ? `<button type="button" class="mini" data-brk-noclave>${esc(t("set.mqtt.removePass"))}</button>` : ""}<button type="button" class="btn ghost" data-brk-cancel>${esc(t("set.cancel"))}</button>${b.id ? `<button type="button" class="btn danger-ghost" data-brk-del="${esc(b.id)}">${esc(t("set.mqtt.remove"))}</button>` : ""}</div>
      <p class="hint">${esc(t("set.mqtt.editorHint"))}</p>
    </div>`;
}
function localBrokerHTML() {
  const l = S().mqtt?.local;
  if (!l) return "";
  const addrs = l.direcciones.length ? l.direcciones : [t("set.mqtt.thisIp")];
  const users = l.usuarios.length
    ? `<ul class="mq-us">${l.usuarios.map((u) => `<li><span>${esc(u.nombre)}</span><button type="button" class="mini" data-usr-del="${esc(u.nombre)}">${esc(t("pc.remove"))}</button></li>`).join("")}</ul>`
    : `<p class="hint">${esc(t("set.mqtt.noUsers"))}</p>`;
  return `<details class="mq-adv"${l.usuarios.length ? "" : " open"}><summary>${esc(t("set.mqtt.users"))}</summary>
      ${users}
      <div class="mq-f">
        <label for="usrNombre">${esc(t("set.mqtt.user"))}</label><input id="usrNombre" class="inp" autocomplete="off" spellcheck="false" placeholder="${esc(t("set.mqtt.userEx"))}">
        <label for="usrClave">${esc(t("set.mqtt.password"))}</label><input id="usrClave" class="inp" type="password" autocomplete="new-password" placeholder="${esc(t("set.mqtt.passMin"))}">
      </div>
      <p class="form-err" id="usrErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn ghost" data-usr-save>${esc(t("set.mqtt.saveUser"))}</button></div>
      <p class="hint">${esc(t("set.mqtt.usersHint", { addrs: addrs.join(t("set.or")), port: l.puerto }))}</p>
    </details>`;
}
function haHTML() {
  const h = { ...(S().mqtt?.ha || {}), ...(haDraft || {}) };
  const opts = [`<option value=""${!h.broker ? " selected" : ""}>${esc(t("set.ha.choose"))}</option>`]
    .concat(brokers().map((b) => `<option value="${esc(b.id)}"${h.broker === b.id ? " selected" : ""}>${esc(brokerLabel(b))}</option>`)).join("");
  return `<section class="blk" id="haBox"><h3>Home Assistant</h3>
      <div class="set-row"><label class="sw" for="haOn"><input type="checkbox" id="haOn" ${h.activado ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("set.ha.on"))}</span></label></div>
      <div class="set-row"><label for="haBroker">${esc(t("set.ha.broker"))}</label><select id="haBroker" class="inp sel">${opts}</select></div>
      <details class="mq-adv"><summary>${esc(t("set.ha.topics"))}</summary><div class="mq-f">
        <label for="haBase">${esc(t("set.ha.base"))}</label><input id="haBase" class="inp" autocomplete="off" spellcheck="false" value="${esc(h.base || "talaia")}">
        <label for="haPref">${esc(t("set.ha.prefix"))}</label><input id="haPref" class="inp" autocomplete="off" spellcheck="false" value="${esc(h.prefijo || "homeassistant")}">
      </div><p class="hint">${esc(t("set.ha.topicsHint"))}</p></details>
      <p class="form-err" id="haErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-ha-save>${esc(t("pc.save"))}</button></div>
      <p class="hint">${esc(t("set.ha.hint"))}</p>
    </section>`;
}
function mqttHTML() {
  const brs = brokers();
  const list = brs.map((b) => `<li class="mq-b">
      <div class="mq-bh"><strong>${esc(brokerLabel(b))}</strong><span class="mq-u">${esc(b.local ? t("set.mqtt.port", { port: S().mqtt.local?.puerto ?? "" }) : b.url)}</span>${b.local ? "" : `<button type="button" class="mini" data-brk-edit="${esc(b.id)}">${esc(t("set.mqtt.change"))}</button>`}</div>
      <p class="hint" data-brk-estado="${esc(b.id)}">${brokerStateHTML(b)}</p>
      ${b.local ? localBrokerHTML() : ""}
      ${brokerEdit?.id === b.id ? brokerEditorHTML() : ""}
    </li>`).join("");
  const lead = [t("set.mqtt.lead"), S().mqtt?.local ? t("set.mqtt.leadLocal") : "", t("set.mqtt.leadPanels")].filter(Boolean).join(" ");
  return `<div id="mqttBox"><section class="blk"><h3>${esc(t("set.mqtt.title"))}</h3>
      <p class="hint">${esc(lead)}</p>
      ${brs.length ? `<ul class="mq-l">${list}</ul>` : `<p class="hint">${esc(t("set.mqtt.noneYet"))}</p>`}
      ${brokerEdit && !brokerEdit.id ? brokerEditorHTML() : `<div class="btns"><button type="button" class="btn ghost" data-brk-nuevo>${esc(t("set.mqtt.add"))}</button></div>`}
    </section>
    ${haHTML()}</div>`;
}
const mqttTab = () => mqttHTML();
/** The MQTT part again, keeping the details that were open. */
function renderMqtt() {
  const b = $("#mqttBox");
  if (!b) return;
  const open = [...b.querySelectorAll("details[open]")].map((d) => d.querySelector("summary")?.textContent);
  b.outerHTML = mqttHTML();
  for (const d of $("#mqttBox").querySelectorAll("details")) if (open.includes(d.querySelector("summary")?.textContent)) d.open = true;
}
/** What arrives from the server: the whole part if nothing is being typed; if something is, only the states. */
function patchMqtt() {
  const b = $("#mqttBox");
  if (!b) return;
  const typing = b.contains(document.activeElement) && document.activeElement.matches("input, select");
  if (!brokerEdit && !haDraft && !typing && !$("#usrNombre")?.value && !$("#usrClave")?.value) return renderMqtt();
  for (const x of brokers()) { const el = b.querySelector(`[data-brk-estado="${x.id}"]`); if (el) el.innerHTML = brokerStateHTML(x); }
}
async function saveBroker() {
  const b = brokerEdit;
  const cambio = { nombre: (b.nombre || "").trim(), url: (b.url || "").trim(), usuario: (b.usuario || "").trim(), activado: b.activado !== false, ...(b.clave ? { clave: b.clave } : {}) };
  const res = await ctx.orden({ orden: "broker", id: b.id, cambio });
  if (!res.ok) return showErr($("#brkErr"), res.error || t("pc.saveFailed"));
  brokerEdit = null;
  ctx.toast(res.toast);
  renderMqtt();
}
async function saveHA() {
  const h = { ...(S().mqtt?.ha || {}), ...(haDraft || {}) };
  const res = await ctx.orden({ orden: "homeAssistant", cambio: { activado: !!h.activado, broker: h.broker || null, base: (h.base || "").trim(), prefijo: (h.prefijo || "").trim() } });
  if (!res.ok) return showErr($("#haErr"), res.error || t("pc.saveFailed"));
  haDraft = null;
  ctx.toast(res.toast);
  renderMqtt();
}
async function saveBrokerUser() {
  const nombre = $("#usrNombre").value.trim(), clave = $("#usrClave").value;
  const res = await ctx.orden({ orden: "usuarioBroker", nombre, clave });
  if (!res.ok) return showErr($("#usrErr"), res.error || t("pc.saveFailed"));
  $("#usrNombre").value = "";
  $("#usrClave").value = "";
  ctx.toast(res.toast);
  renderMqtt();
  $("#mqttBox details.mq-adv").open = true;
}
/** A change in the MQTT part: to the draft of the broker or of Home Assistant. */
function editMqtt(el) {
  const k = el.dataset.brk;
  if (k && brokerEdit) return void (brokerEdit[k] = el.type === "checkbox" ? el.checked : el.value);
  const HA = { haOn: "activado", haBroker: "broker", haBase: "base", haPref: "prefijo" };
  if (HA[el.id]) haDraft = { ...(haDraft || {}), [HA[el.id]]: el.type === "checkbox" ? el.checked : el.value };
}

/* ── the receiver ── */

function receiverStatusHTML() {
  const s = S();
  if (!s.servidorOk) return `<p class="warn-t">${esc(t("rx.noServer"))}</p>`;
  const my = s.myNode != null ? s.nodes.get(s.myNode) : null;
  const via = s.device?.kind === "tcp" ? t("rx.viaNet") : t("rx.viaUsb");
  const txt = {
    ready: t("rx.ready", { via, node: my ? `${my.short} · ${displayName(my)}` : t("rx.itsNode") }),
    configuring: t("rx.configuring"),
    connecting: t("rx.connecting"),
    reconnecting: t("rx.reconnecting", { detail: s.trouble?.detail ? `: ${s.trouble.detail}` : "" }),
    idle: t("rx.idle"),
  }[s.link.state] || "";
  const retry = s.link.state === "reconnecting"
    ? `${s.trouble?.consejo ? `<p class="hint">${esc(s.trouble.consejo)}</p>` : ""}<div class="btns"><button type="button" class="btn primary" data-retry>${esc(t("trouble.retry"))}</button></div>` : "";
  return `<p>${esc(txt)}</p>${retry}`;
}
/** What the receiver is: node, connection, radio and channels. */
function receiverFactsHTML() {
  const s = S();
  const my = s.myNode != null ? s.nodes.get(s.myNode) : null;
  const rows = [];
  if (my) rows.push([t("rx.node"), [`${my.short} · ${displayName(my)}`, hexId(my.num), my.hw ? my.hw.replaceAll("_", " ") : ""].filter(Boolean).join(" · ")]);
  const d = s.device;
  if (d) rows.push([t("rx.link"), d.kind === "tcp" ? t("rx.linkNet", { addr: d.direccion || d.name }) : t("rx.linkUsb", { port: d.ruta || d.name || "" })]);
  const l = s.lora;
  if (l) {
    const radio = l.usePreset !== false ? PRESET_NAME[l.modemPreset ?? 0] : t("rx.manualSf", { sf: l.spreadFactor });
    rows.push([t("rx.radio"), [radio, l.hopLimit ? t("rx.hops", { n: l.hopLimit }) : ""].filter(Boolean).join(" · ")]);
  }
  const facts = rows.length ? `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : "";
  const chs = s.channels;
  const list = chs.length
    ? `<ul class="ch-l">${chs.map((c) => `<li><span class="ch-n"><b>${c.index}</b> ${esc(c.name)}</span><span class="${c.private ? "okt" : "warn-t"}">${esc(c.private ? t("rx.private") : t("rx.public", { why: channelWhy(c) }))}</span></li>`).join("")}</ul>`
    : `<p class="hint">${esc(t("pc.mesh.connectFirst"))}</p>`;
  return `${facts}<h4>${esc(t("rx.channels"))}</h4>${list}`;
}

/* connection diagnostics: each step of the connection, to copy or report */
const diagFormat = () => new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const diagLine = (e, f = diagFormat()) => `${f.format(new Date(e.t))}  ${e.msg}`;
const diagLines = (n) => { const f = diagFormat(); return S().diag.slice(-n).map((e) => diagLine(e, f)).join("\n") || t("diag.empty"); };
function diagText() {
  const s = S();
  const head = [
    `Talaia ${APP_VERSION}`,
    navigator.userAgent,
    t("diag.head", { name: s.device?.name || "—", state: s.link.state, fail: s.trouble ? t("diag.lastFail", { kind: s.trouble.kind, n: s.trouble.count }) : "" }),
    "",
  ];
  const f = diagFormat();
  return head.join("\n") + s.diag.map((e) => diagLine(e, f)).join("\n");
}
/** A new issue on GitHub with the diagnostics already pasted (cut to fit in the address). */
function issueUrl() {
  const intro = t("diag.issueBody");
  const lines = diagText().split("\n");
  const keep = 3; // head: version, browser and receiver
  let cut = false;
  const build = () => `${ISSUES_URL}/new?title=${encodeURIComponent(t("diag.issueTitle"))}&body=${encodeURIComponent(`${intro}\n\`\`\`\n${[...lines.slice(0, keep), ...(cut ? [t("diag.cut")] : []), ...lines.slice(keep)].join("\n")}\n\`\`\`\n`)}`;
  let url = build();
  while (url.length > 7000 && lines.length > keep + 1) {
    lines.splice(keep, Math.max(1, Math.ceil((lines.length - keep) / 8)));
    cut = true;
    url = build();
  }
  return url;
}
function patchDiag() { const el = $("#diagList"); if (el) el.textContent = diagLines(40); }
/** A step of this screen's own connection (the server's come with its state). */
export function pushDiag(e) {
  const s = S();
  s.diag = [...(s.diag || []), e].slice(-150);
  patchDiag();
}

function receiverTab() {
  return `<section class="blk"><h3>${esc(t("rx.title"))}</h3>${receiverStatusHTML()}
      <p class="hint">${esc(t("rx.hint"))}</p></section>
    <section class="blk"><h3>${esc(t("rx.what"))}</h3>${receiverFactsHTML()}</section>
    <section class="blk" id="diagBox"><h3>${esc(t("diag.title"))}</h3>
      <p class="hint">${esc(t("diag.lead"))}</p>
      <pre class="diag" id="diagList">${esc(diagLines(40))}</pre>
      <div class="btns"><button type="button" class="btn ghost" data-copy-diag>${esc(t("diag.copy"))}</button><button type="button" class="btn ghost" data-report>${esc(t("diag.report"))}</button></div>
      <p class="hint">${esc(t("diag.reportHint"))}</p>
    </section>`;
}

/* ── the system ── */

const RETENTION = [7, 30, 90, 365];
function systemTab() {
  const s = S();
  const ret = RETENTION.map((d) => `<option value="${d}"${s.settings.retentionDays === d ? " selected" : ""}>${esc(d === 365 ? t("sys.keepYear") : t("sys.keepDays", { n: d }))}</option>`).join("");
  const srv = s.settings.language || "es";
  const langs = LANGS.map((l) => `<option value="${l.code}"${l.code === srv ? " selected" : ""}>${l.name}</option>`).join("");
  return `<section class="blk"><h3>${esc(t("sys.lang"))}</h3>
      <div class="set-row"><label for="srvLang">${esc(t("screen.lang"))}</label><select id="srvLang" class="inp sel lang">${langs}</select></div>
      <p class="hint">${esc(t("sys.langHint"))}</p>
    </section>
    <section class="blk"><h3>${esc(t("sys.history"))}</h3>
      <div class="set-row"><span id="histCount">${esc(t("sys.counting"))}</span><select id="setRet" class="inp sel" aria-label="${esc(t("sys.keepLabel"))}">${ret}</select></div>
      <p class="hint">${esc(t("sys.historyHint"))}</p>
      <div class="btns"><button type="button" class="btn ghost" data-export>${esc(t("sys.export"))}</button><button type="button" class="btn danger-ghost" data-wipe>${esc(t("sys.wipe"))}</button></div>
    </section>
    <section class="blk about"><h3>${esc(t("sys.about"))}</h3>
      <p><strong>Talaia ${APP_VERSION}</strong>. ${esc(t("sys.aboutText"))}</p>
      <div class="btns"><a class="btn ghost" href="${REPO_URL}/blob/main/docs/${getLang() === "es" ? "guide.es.md" : "guide.md"}" target="_blank" rel="noopener">${esc(t("sys.guide"))}</a><a class="btn ghost" href="${REPO_URL}" target="_blank" rel="noopener">${esc(t("sys.code"))}</a><a class="btn ghost" href="${ISSUES_URL}" target="_blank" rel="noopener">${esc(t("sys.issues"))}</a></div>
      <p class="hint">${esc(t("sys.linksHint"))}</p>
      <p class="hint">${esc(t("sys.license"))}</p>
    </section>`;
}
function countReadings() {
  S().store.count().then((c) => { const el = $("#histCount"); if (el) el.textContent = t(c === 1 ? "sys.reading1" : "sys.readings", { n: c.toLocaleString(locale()) }); });
}

/* ── this screen ── */

function notificationHTML() {
  const st = notificationState();
  if (st === "granted") return `<span class="okt">${esc(t("screen.notif.on"))}</span>`;
  if (st === "http") return `<span class="hint">${esc(t("screen.notif.http"))}</span>`;
  if (st === "denied") return `<span class="warn-t">${esc(t("screen.notif.denied"))}</span>`;
  if (st === "none") return `<span class="hint">${esc(t("screen.notif.none"))}</span>`;
  return `<button type="button" class="btn ghost" data-notif>${esc(t("screen.notif.ask"))}</button>`;
}
function screenTab() {
  const s = S();
  const langs = LANGS.map((l) => `<option value="${l.code}"${l.code === getLang() ? " selected" : ""}>${l.name}</option>`).join("");
  const themes = ["auto", "light", "dark"].map((v) => `<option value="${v}"${v === getTheme() ? " selected" : ""}>${esc(t(`screen.theme.${v}`))}</option>`).join("");
  return `<section class="blk"><h3>${esc(t("screen.look"))}</h3>
      <div class="set-row"><label for="setLang">${esc(t("screen.lang"))}</label><select id="setLang" class="inp sel lang">${langs}</select></div>
      <div class="set-row"><label for="setTheme">${esc(t("screen.theme"))}</label><select id="setTheme" class="inp sel theme">${themes}</select></div>
      <p class="hint">${esc(t("screen.hint"))}</p>
    </section>
    <section class="blk"><h3>${esc(t("screen.alerts"))}</h3>
      <div class="set-row"><label class="sw" for="setSound"><input type="checkbox" id="setSound" ${s.settings.sound ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("screen.sound"))}</span></label><button type="button" class="btn ghost" data-test>${esc(t("screen.test"))}</button></div>
      <div class="set-row"><label class="sw" for="setWake"><input type="checkbox" id="setWake" ${s.settings.wake ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("screen.wake"))}</span></label></div>
      <div class="set-row"><span>${esc(t("screen.notif"))}</span>${notificationHTML()}</div>
      <p class="hint">${esc(t("screen.alertsHint"))}</p>
    </section>
    <section class="blk"><h3>${esc(t("screen.tiles"))}</h3>
      <div class="set-row"><span id="tileCount">${esc(t("screen.tilesCounting"))}</span><button type="button" class="btn ghost" data-wipe-tiles>${esc(t("screen.tilesWipe"))}</button></div>
      <p class="hint">${esc(t("screen.tilesHint"))}</p>
      <p class="hint" id="tilePersist"></p>
    </section>
    <p class="hint set-foot">${esc(t("screen.foot"))}</p>`;
}
async function tileInfo() {
  let n = 0, mb = null, kept = null;
  try { n = (await (await caches.open(TILE_CACHE)).keys()).length; } catch { /* no cache */ }
  try { const e = await navigator.storage.estimate(); if (e.usageDetails?.caches != null) mb = e.usageDetails.caches / 1048576; } catch { /* no estimate */ }
  try { kept = await navigator.storage.persisted(); } catch { /* unknown */ }
  const el = $("#tileCount");
  if (el) el.textContent = n ? t(mb != null ? "screen.tilesMb" : "screen.tilesN", { n: n.toLocaleString(locale()), mb: fmtNum(mb ?? 0, mb < 10 ? 1 : 0) }) : t("screen.tilesNone");
  const p = $("#tilePersist");
  if (p) p.textContent = kept === true ? t("screen.tilesKept") : kept === false ? t("screen.tilesMayGo") : "";
}

/* ── what is pressed and changed ── */

let wipeArmed = 0;
async function onClick(ev) {
  const b = ev.target.closest("button");
  if (!b) return;
  const ds = b.dataset;
  const { orden, toast } = ctx;
  if (tab === "users" && (await usersClick(b, renderSettings))) return;
  if (tab === "mesh" && b.closest("#moBox") && (await meshOrdersClick(b, renderSettings))) return;
  if ("brkNuevo" in ds) { brokerEdit = { id: null, nombre: "", url: "", usuario: "", clave: "", activado: true }; renderMqtt(); return $("#brkNombre")?.focus(); }
  if ("brkEdit" in ds) { const x = brokers().find((y) => y.id === ds.brkEdit); if (x) brokerEdit = { id: x.id, nombre: x.nombre, url: x.url, usuario: x.usuario, clave: "", activado: x.activado }; return renderMqtt(); }
  if ("brkCancel" in ds) { brokerEdit = null; return renderMqtt(); }
  if ("brkSave" in ds) return saveBroker();
  if ("brkNoclave" in ds) { const r = await orden({ orden: "broker", id: brokerEdit.id, cambio: { clave: null } }); if (!r.ok) return showErr($("#brkErr"), r.error); return toast(t("set.mqtt.passRemoved")); }
  if ("brkDel" in ds) { const r = await orden({ orden: "quitarBroker", id: ds.brkDel }); if (!r.ok) return showErr($("#brkErr"), r.error); brokerEdit = null; toast(r.toast); return renderMqtt(); }
  if ("usrSave" in ds) return saveBrokerUser();
  if ("usrDel" in ds) { const r = await orden({ orden: "quitarUsuarioBroker", nombre: ds.usrDel }); return toast(r.error || r.toast); }
  if ("haSave" in ds) return saveHA();
  if ("meshTest" in ds) { const r = await orden({ orden: "pruebaMalla" }); return toast(r.toast); }
  if ("copyDiag" in ds) {
    const txt = diagText();
    try { await navigator.clipboard.writeText(txt); toast(t("diag.copied")); } catch {
      const el = $("#diagList");
      if (el) { el.textContent = txt; const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
      toast(t("diag.selectIt"));
    }
    return;
  }
  if ("report" in ds) {
    if (!navigator.onLine) return toast(t("diag.offline"));
    return void window.open(issueUrl(), "_blank", "noopener");
  }
  if ("notif" in ds) { try { await Notification.requestPermission(); } catch { /* nothing */ } return renderSettings(); }
  if ("test" in ds) { unlockAudio(); ctx.motor.raise("test", { kind: "test", num: null, t: Date.now() }); return go("dashboard"); }
  if ("export" in ds) return location.assign("api/lecturas.csv");
  if ("wipe" in ds) {
    if (Date.now() - wipeArmed > 4000) { wipeArmed = Date.now(); b.textContent = t("sys.wipeArm"); return; }
    wipeArmed = 0;
    const r = await orden({ orden: "borrarHistorico" });
    renderSettings();
    ctx.render();
    return toast(r.toast);
  }
  if ("wipeTiles" in ds) {
    try { await caches.delete(TILE_CACHE); } catch { /* nothing to delete */ }
    tileInfo();
    return toast(t("screen.tilesWiped"));
  }
}

async function onChange(ev) {
  const el = ev.target;
  const s = S();
  const { orden, toast } = ctx;
  if (el.closest("#mqttBox")) return editMqtt(el);
  if (el.closest("#moBox")) return meshOrdersChange(el);
  if (el.id === "setLang") {
    setLang(el.value);
    hooks.languageChanged();
    return renderSettings();
  }
  if (el.id === "setTheme") return setTheme(el.value);
  if (el.id === "setSound") { s.settings.sound = el.checked; hooks.saveDeviceSettings(); if (el.checked) { unlockAudio(); beep(); } return; }
  if (el.id === "setWake") { s.settings.wake = el.checked; hooks.saveDeviceSettings(); return applyWake(); }
  if (el.id === "setOff") {
    const v = parseNum(el.value);
    const r = await orden({ orden: "sinSenalDefecto", valor: Number.isNaN(v) ? null : v });
    if (r.error) { el.value = r.valor; return toast(r.error); }
    return toast(r.toast);
  }
  if (el.id === "meshOn" || el.id === "meshClear") {
    const r = await orden({ orden: "malla", cambio: el.id === "meshOn" ? { enabled: el.checked } : { onClear: el.checked } });
    return toast(r.toast);
  }
  if (el.id === "meshCh" || el.id === "meshNode") {
    const v = el.value === "" ? null : Number(el.value);
    const r = await orden({ orden: "malla", cambio: el.id === "meshCh" ? { channel: v } : { node: v } });
    if (!r.ok) { el.value = ""; return toast(r.toast); }
    return renderSettings();
  }
  if (el.id === "setRet") { await orden({ orden: "retencion", dias: Number(el.value) }); return renderSettings(); }
  if (el.id === "srvLang") {
    const r = await orden({ orden: "idioma", idioma: el.value });
    if (!r.ok) { el.value = s.settings.language || "es"; return toast(r.error); }
    return toast(r.toast);
  }
}

function onInput(ev) {
  if (ev.target.closest("#mqttBox")) editMqtt(ev.target);
  if (ev.target.closest("#moBox")) meshOrdersInput(ev.target);
}
