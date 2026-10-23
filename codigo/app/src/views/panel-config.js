// Configuration of a watched panel, in its sheet: its name here, its MQTT data (numbers and ON/OFF states, with
// the topic, field and unit of each; switching from here; the device's connection topic) and, on the receiver's
// panel, what goes out to the mesh as its telemetry (see servidor/src/paneles.js). Also creating a panel without
// a node. Changes are kept as drafts until saved, and kept if the same sheet is reopened.
import { ctx } from "../ctx.js";
import { t } from "../i18n.js";
import { $, esc, ICON } from "../ui.js";
import { displayName } from "./dashboard.js";
import { fmtNum } from "@talaia/nucleo/metrics.js";
import { hhmm, ago } from "@talaia/nucleo/textos.js";
import { channelWhy } from "@talaia/nucleo/canales.js";
import { TIPOS, LISTA_TIPOS, TIPOS_PANEL, NOMBRES_ESTADO, tipoMalla, esEstado, unidades, adivinarTipo, adivinarEstado, proponerOrden, unidadDe, textoDato, MALLA_MAX_SALTOS } from "@talaia/nucleo/mqtt-datos.js";

let dataDraft = null; // { num, datos, conexion }: a panel's MQTT data, changed and not saved yet
let meshDraft = null; // { activado, cada, canal, saltos }
let found = []; // what "Find topics" found: [{ broker, tema, campo, v, unidad?, estado?, conexion? }]
let foundFilter = "";
const FOUND_SHOWN = 40; // of what was found, how many are listed (filtering reaches the rest)
const MESH_EVERY = [15, 30, 60, 180];
const STALE = [0, 60, 180, 720, 1440];

const S = () => ctx.S;
const panelCfg = (num) => S().paneles?.paneles?.[num] || null;
const brokers = () => S().mqtt?.brokers || [];
/** A broker's name on screen: this server's own, in the screen's language (its name comes from the server). */
export const brokerLabel = (b) => (b.local ? t("set.mqtt.localName") : b.nombre);
export const brokerName = (id) => { const b = brokers().find((x) => x.id === id); return b ? brokerLabel(b) : t("pc.brokerGone"); };
/** For a new datum: the broker that isn't this server's (for now, Home Assistant's) or whichever there is. */
const defaultBroker = () => { const b = brokers(); return (b.find((x) => !x.local) || b[0])?.id || ""; };
function brokerOptions(sel) {
  const b = brokers();
  let o = b.map((x) => `<option value="${esc(x.id)}"${x.id === sel ? " selected" : ""}>${esc(brokerLabel(x))}</option>`).join("");
  if (sel && !b.some((x) => x.id === sel)) o += `<option value="${esc(sel)}" selected>${esc(t("pc.brokerGone"))}</option>`;
  return o || `<option value="">${esc(t("pc.addBrokerFirst"))}</option>`;
}
function showErr(el, msg) { el.textContent = msg; el.hidden = false; }
const everyText = (m) => (m < 60 ? t("pc.mesh.everyMin", { n: m }) : m === 60 ? t("pc.mesh.everyHour") : t("pc.mesh.everyHours", { n: m / 60 }));

/** Drafts belong to one panel: opening another drops them (closing and reopening the same keeps them). */
export function forgetDraftsExcept(num) {
  if (dataDraft && dataDraft.num !== num) { dataDraft = null; foundFilter = ""; }
  if (num !== S().myNode) meshDraft = null;
}
export const hasDrafts = (num) => dataDraft?.num === num || (meshDraft && num === S().myNode);

/* ── name ── */
function nameSection(num) {
  const n = ctx.motor.node(num);
  const noNode = num < 0;
  const types = noNode ? `<div class="set-row"><label for="pnTipo">${esc(t("pc.whatIsIt"))}</label><select id="pnTipo" class="inp sel">${Object.entries(TIPOS_PANEL).map(([k, x]) => `<option value="${k}"${n.tipoPanel === k ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select></div>` : "";
  return `<section class="blk" id="nomBox"><h3>${esc(t("pc.name"))}</h3>
      <div class="pn-f"><input id="pnNombre" class="inp" autocomplete="off" maxlength="40" value="${esc(noNode ? n.long : n.alias || "")}" placeholder="${esc(noNode ? t("pc.namePanel") : n.long)}" aria-label="${esc(t("pc.nameHere"))}"><button type="button" class="btn ghost" data-pn-nombre="${num}">${esc(t("pc.save"))}</button></div>
      ${types}
      <p class="hint">${esc(noNode ? t("pc.nameHintPanel") : t("pc.nameHintNode", { name: n.long }))}</p>
      <p class="form-err" id="pnErr" role="alert" hidden></p>
    </section>`;
}

/* ── MQTT data ── */
function dataCfg(num) {
  if (dataDraft?.num === num) return dataDraft.datos;
  const datos = (panelCfg(num)?.datos || []).map((d) => ({ ...d }));
  return datos.length ? datos : [newDatum(num)]; // no data: an empty row, so it's clear where the topic goes
}
/** The connection topic of a panel without a node (empty if it has none). */
function connCfg(num) {
  if (dataDraft?.num === num) return dataDraft.conexion;
  const c = panelCfg(num)?.conexion;
  return c ? { ...c } : { broker: defaultBroker(), tema: "", campo: "", avisar: true };
}
function editableData(num) {
  if (dataDraft?.num !== num) dataDraft = { num, datos: dataCfg(num), conexion: connCfg(num) };
  return dataDraft.datos;
}
function editableConn(num) {
  editableData(num);
  return dataDraft.conexion;
}
const sameDatum = (a, b) => a && b && a.clave === b.clave && a.tipo === b.tipo && a.broker === b.broker && a.tema === b.tema && a.campo === b.campo && (a.unidad || "") === (b.unidad || "") && !!a.invertir === !!b.invertir;
const newDatum = (num, tipo = "temperature") => ({ nombre: "", tipo, broker: defaultBroker(), tema: "", campo: "", unidad: unidades(tipo)[0] || "", caduca: 0, malla: false });

/** The latest value of a datum, if it is the saved one (while it's being changed, there is none yet). */
function datumValueHTML(num, d) {
  const saved = (panelCfg(num)?.datos || []).find((x) => x.clave === d.clave);
  if (!d.clave || !sameDatum(d, saved)) return d.tema ? esc(t("pc.saveToSee")) : "";
  const x = S().paneles?.valores?.[d.clave];
  if (!x) return esc(t("pc.nothingYet"));
  const when = esc(ago(x.t));
  if (x.error) return `<span class="warn-t">${esc(x.error)}</span> · ${when}`;
  if (x.nulo) return `<span class="warn-t">${esc(t("pc.unavailable"))}</span> ${esc(t("pc.sensorSilent"))} · ${when}`;
  return `<strong>${esc(textoDato(d, x.v))}</strong>${x.u ? ` (${esc(fmtNum(x.b, 1))} ${esc(x.u)})` : ""} · ${when}`;
}

function datumHTML(num, d, i) {
  const receiver = num === S().myNode;
  const types = LISTA_TIPOS.map((k) => `<option value="${k}"${k === d.tipo ? " selected" : ""}>${esc(TIPOS[k].label)}</option>`).join("");
  const us = unidades(d.tipo);
  const isState = esEstado(d.tipo);
  const unit = isState ? "" : d.tipo === "otro"
    ? `<input class="inp dat-u" data-dat-i="${i}" data-dat-k="unidad" autocomplete="off" maxlength="12" placeholder="${esc(t("pc.unit"))}" aria-label="${esc(t("pc.unitLabel"))}" value="${esc(d.unidad || "")}">`
    : us.length > 1
      ? `<select class="inp sel" data-dat-i="${i}" data-dat-k="unidad" aria-label="${esc(t("pc.unitArrives"))}">${us.map((u) => `<option${u === (d.unidad || us[0]) ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>`
      : `<span class="est-u">${esc(us[0])}</span>`;
  const mesh = receiver && tipoMalla(d.tipo)
    ? `<div class="dat-m"><label class="sw" for="datM${i}"><input type="checkbox" id="datM${i}" data-dat-i="${i}" data-dat-k="malla" ${d.malla ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("pc.toMesh"))}</span></label>
        ${d.malla ? `<select class="inp sel" data-dat-i="${i}" data-dat-k="caduca" aria-label="${esc(t("pc.staleLabel"))}">${STALE.map((k) => `<option value="${k}"${k === (d.caduca || 0) ? " selected" : ""}>${esc(k ? t("pc.stale", { h: k / 60 }) : t("pc.staleKeep"))}</option>`).join("")}</select>` : ""}</div>`
    : "";
  return `<div class="est-d">
      <div class="est-r"><select class="inp sel" data-dat-i="${i}" data-dat-k="tipo" aria-label="${esc(t("pc.typeLabel"))}">${types}</select><button type="button" class="mini" data-dat-del="${i}">${esc(t("pc.remove"))}</button></div>
      <input class="inp" data-dat-i="${i}" data-dat-k="nombre" autocomplete="off" maxlength="40" placeholder="${esc(t("pc.datumName", { type: TIPOS[d.tipo].label }))}" aria-label="${esc(t("pc.datumNameLabel"))}" value="${esc(d.nombre || "")}">
      <select class="inp sel" data-dat-i="${i}" data-dat-k="broker" aria-label="${esc(t("pc.broker"))}">${brokerOptions(d.broker)}</select>
      <input class="inp" data-dat-i="${i}" data-dat-k="tema" list="temasMqtt" autocomplete="off" spellcheck="false" placeholder="${esc(t("pc.topic"))}" aria-label="${esc(t("pc.topicLabel"))}" value="${esc(d.tema || "")}">
      <div class="est-r"><input class="inp" data-dat-i="${i}" data-dat-k="campo" list="camposMqtt${i}" autocomplete="off" spellcheck="false" placeholder="${esc(t("pc.field"))}" aria-label="${esc(t("pc.fieldLabel"))}" value="${esc(d.campo || "")}">${unit}</div>
      ${isState ? `<div class="est-r"><select class="inp sel" data-dat-i="${i}" data-dat-k="nombres" aria-label="${esc(t("pc.stateNames"))}">${Object.entries(NOMBRES_ESTADO).map(([k, [on, off]]) => `<option value="${k}"${k === (d.nombres || "encendido") ? " selected" : ""}>${esc(on)} / ${esc(off)}</option>`).join("")}</select>
        <label class="sw" for="datR${i}"><input type="checkbox" id="datR${i}" data-dat-i="${i}" data-dat-k="invertir" ${d.invertir ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("pc.reversed"))}</span></label></div>
      ${commandHTML(d, i)}` : ""}
      ${mesh}
      <p class="hint" data-dat-v="${i}">${datumValueHTML(num, d)}</p>
      <datalist id="camposMqtt${i}">${fieldOptions(d.tema)}</datalist>
    </div>`;
}

/** Switching a state from here: the topic for the orders and the message of each one. */
function commandHTML(d, i) {
  const [on, off] = NOMBRES_ESTADO[d.nombres || "encendido"] || NOMBRES_ESTADO.encendido;
  const o = d.orden;
  return `<label class="sw" for="datO${i}"><input type="checkbox" id="datO${i}" data-dat-i="${i}" data-dat-k="control" ${o ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("pc.cmd.toggle"))}</span></label>
    ${o ? `<input class="inp" data-dat-i="${i}" data-dat-k="ordenTema" autocomplete="off" spellcheck="false" placeholder="${esc(t("pc.cmd.topic"))}" aria-label="${esc(t("pc.cmd.topicLabel"))}" value="${esc(o.tema || "")}">
      <div class="est-r"><input class="inp" data-dat-i="${i}" data-dat-k="ordenOn" autocomplete="off" spellcheck="false" placeholder="${esc(t("pc.cmd.msgFor", { state: on }))}" aria-label="${esc(t("pc.cmd.msgFor", { state: on }))}" value="${esc(o.on || "")}"><input class="inp" data-dat-i="${i}" data-dat-k="ordenOff" autocomplete="off" spellcheck="false" placeholder="${esc(t("pc.cmd.msgFor", { state: off }))}" aria-label="${esc(t("pc.cmd.msgFor", { state: off }))}" value="${esc(o.off || "")}"></div>
      <p class="hint">${esc(t("pc.cmd.hint", { on, off }))}</p>` : ""}`;
}

/** Short name of a found topic: from "ha_estados/sensor/entity/state", the entity; and the field if it's a JSON. */
function foundName(x) {
  const p = x.tema.split("/").filter((q) => q && q !== "state");
  let n = p.length > 1 ? p.at(-1) : x.tema;
  if (n.length > 44) n = `…${n.slice(-43)}`;
  return x.campo ? `${n} · ${x.campo}` : n;
}
/** What a found topic looks like: a type of datum, a state or the device's connection. */
const looksText = (x, m) => (x.conexion ? t("pc.looks.conn") : x.estado ? t("pc.looks.state") : m ? t("pc.looks.type", { type: TIPOS[m].label.toLowerCase() }) : "");
/** What was found, filtered, with what each looks like and a button to use it. */
function foundHTML(num) {
  if (!found.length) return "";
  const f = foundFilter.trim().toLowerCase();
  const list = found.map((x, i) => ({ x, i, m: x.estado ? "estado" : adivinarTipo(x.tema, x.campo) }))
    .filter(({ x }) => !f || `${x.tema} ${x.campo}`.toLowerCase().includes(f))
    .sort((a, b) => (a.m ? 0 : 1) - (b.m ? 0 : 1)); // first, what looks like something known
  const used = new Set(dataCfg(num).map((d) => `${d.broker}\n${d.tema}\n${d.campo}`));
  const con = num < 0 ? connCfg(num) : null;
  if (con?.tema) used.add(`${con.broker}\n${con.tema}\n${con.campo || ""}`);
  const several = new Set(found.map((x) => x.broker)).size > 1;
  const button = (x, i) => (used.has(`${x.broker}\n${x.tema}\n${x.campo}`) ? `<span class="hint">${esc(t("pc.found.already"))}</span>`
    : x.conexion && num < 0 ? `<button type="button" class="mini" data-con-usar="${i}">${esc(t("pc.found.useConn"))}</button>`
      : `<button type="button" class="mini" data-dat-usar="${i}">${esc(t("pc.found.use"))}</button>`);
  const rows = list.slice(0, FOUND_SHOWN).map(({ x, i, m }) => `<li><div class="est-hn"><span class="est-ht" title="${esc(x.tema)}${x.campo ? ` · ${esc(x.campo)}` : ""}">${esc(foundName(x))}</span>
      <span class="hint">${esc(String(x.v))}${x.unidad ? ` ${esc(x.unidad)}` : ""}${looksText(x, m) ? ` · ${esc(looksText(x, m))}` : ""}${several ? ` · ${esc(t("pc.found.in", { broker: brokerName(x.broker) }))}` : ""}</span></div>
      ${button(x, i)}</li>`).join("");
  const more = list.length > FOUND_SHOWN ? `<p class="hint">${esc(t("pc.found.more", { n: list.length - FOUND_SHOWN }))}</p>` : "";
  return `<input id="filtroTemas" class="inp" autocomplete="off" spellcheck="false" placeholder="${esc(t("pc.found.filter"))}" aria-label="${esc(t("pc.found.filterLabel"))}" value="${esc(foundFilter)}">
    ${list.length ? `<ul class="est-hl">${rows}</ul>${more}` : `<p class="hint">${esc(t("pc.found.none", { q: foundFilter }))}</p>`}`;
}
function topicOptions() {
  const by = new Map();
  for (const x of found) { if (!by.has(x.tema)) by.set(x.tema, []); by.get(x.tema).push(x); }
  return [...by].map(([tema, xs]) => `<option value="${esc(tema)}" label="${esc((xs.length === 1 && !xs[0].campo ? String(xs[0].v) : `JSON: ${xs.map((x) => x.campo).join(", ")}`).slice(0, 80))}"></option>`).join("");
}
const fieldOptions = (tema) => found.filter((x) => x.tema === tema && x.campo).map((x) => `<option value="${esc(x.campo)}" label="${esc(String(x.v))}"></option>`).join("");
const dataSignature = (num) => JSON.stringify([panelCfg(num)?.datos || [], panelCfg(num)?.conexion || null, brokers().map((b) => [b.id, b.nombre]), num === S().myNode]);

/** What the connection topic said last (if it's the saved one). */
function connValueHTML(num) {
  const c = connCfg(num), g = panelCfg(num)?.conexion;
  if (!c.tema.trim()) return "";
  if (!g || g.broker !== c.broker || g.tema !== c.tema.trim() || (g.campo || "") !== (c.campo || "").trim()) return esc(t("pc.conn.saveToSee"));
  const x = S().paneles?.conexion?.[num];
  if (!x) return esc(t("pc.conn.nothingYet"));
  const when = esc(ago(x.t));
  if (x.error) return `<span class="warn-t">${esc(x.error)}</span> · ${when}`;
  if (x.nulo) return `<span class="warn-t">${esc(t("pc.unavailable"))}</span> · ${when}`;
  return `${x.v ? `<strong class="okt">${esc(t("pc.conn.on"))}</strong>` : `<strong class="warn-t">${esc(t("pc.conn.off"))}</strong>`} · ${when}`;
}
function connHTML(num) {
  const c = connCfg(num);
  return `<div class="con-b" id="conBox"><h4>${esc(t("pc.conn.title"))}</h4>
      <p class="hint">${esc(t("pc.conn.hint"))}</p>
      <select class="inp sel" data-con-k="broker" aria-label="${esc(t("pc.conn.broker"))}">${brokerOptions(c.broker)}</select>
      <div class="est-r"><input class="inp" data-con-k="tema" list="temasMqtt" autocomplete="off" spellcheck="false" placeholder="${esc(t("pc.conn.topic"))}" aria-label="${esc(t("pc.conn.topicLabel"))}" value="${esc(c.tema || "")}"><input class="inp con-c" data-con-k="campo" autocomplete="off" spellcheck="false" placeholder="${esc(t("pc.conn.field"))}" aria-label="${esc(t("pc.conn.fieldLabel"))}" value="${esc(c.campo || "")}"></div>
      <label class="sw" for="conAv"><input type="checkbox" id="conAv" data-con-k="avisar" ${c.avisar ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("pc.conn.warn"))}</span></label>
      <p class="hint" id="conV">${connValueHTML(num)}</p>
    </div>`;
}
const foundCount = (n) => t("pc.found.count", { n });

function dataSection(num) {
  const datos = dataCfg(num);
  const receiver = num === S().myNode;
  const lead = [t(num < 0 ? "pc.data.leadPanel" : "pc.data.leadNode"), t("pc.data.kinds"), receiver ? t("pc.data.meshNote") : ""].filter(Boolean).join(" ");
  return `<section class="blk" id="datBox" data-cfg="${esc(dataSignature(num))}"><h3>${esc(t("pc.data.title"))}</h3>
      <p class="hint">${esc(lead)}</p>
      <div id="datLista">${datos.map((d, i) => datumHTML(num, d, i)).join("")}</div>
      ${num < 0 ? connHTML(num) : ""}
      <div class="btns"><button type="button" class="btn ghost" data-dat-add>${ICON.plus}${esc(t("pc.data.add"))}</button><button type="button" class="btn ghost" data-dat-buscar>${esc(t("pc.data.find"))}</button></div>
      <p class="hint" id="datBusca">${esc(found.length ? foundCount(found.length) : t("pc.data.findHint"))}</p>
      <div id="datHallados" class="est-h">${foundHTML(num)}</div>
      <datalist id="temasMqtt">${topicOptions()}</datalist>
      <p class="form-err" id="datErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-dat-save>${esc(t("pc.data.save"))}</button></div>
      <details class="mq-adv"><summary>${esc(t("pc.ha.title"))}</summary>
        <p class="hint">${esc(t("pc.ha.lead"))}</p>
        <pre class="est-pre">mqtt_statestream:
  base_topic: ha_estados
  publish_attributes: true
  include:
    entities:
      - sensor.estacion_temperatura
      - sensor.estacion_humedad</pre>
        <p class="hint">${esc(t("pc.ha.after"))}</p>
      </details>
    </section>`;
}
function renderData(num) {
  const box = $("#datBox");
  if (box) box.outerHTML = dataSection(num);
}

/* ── what goes out to the mesh (receiver's panel) ── */
function meshCfg() {
  const m = S().paneles?.malla || {};
  return meshDraft || { activado: !!m.activado, cada: m.cada || 30, canal: m.canal ?? 0, saltos: m.saltos ?? null };
}
function meshStateHTML() {
  const m = S().paneles?.malla;
  if (!m) return "";
  const out = [];
  if (!(panelCfg(S().myNode)?.datos || []).some((d) => d.malla)) out.push(esc(t("pc.mesh.noneMarked")));
  if (!m.activado) out.push(esc(t("pc.mesh.off")));
  else if (m.proximo) {
    out.push(esc(t("pc.mesh.next", { time: hhmm.format(new Date(m.proximo)), what: m.previo?.texto ? t("pc.mesh.quoted", { text: m.previo.texto }) : t("pc.mesh.nothingFresh") })));
    if (m.previo?.faltan?.length) out.push(`<span class="warn-t">${esc(t("pc.mesh.missing"))}</span> ${esc(m.previo.faltan.join(", "))}.`);
  }
  const u = m.ultimo;
  if (u) {
    const cls = u.ok === true ? "okt" : u.ok === false ? "warn-t" : "";
    const what = u.texto ? `: ${t("pc.mesh.quoted", { text: u.texto })} → ${u.destino}` : "";
    out.push(`${esc(t(u.manual ? "pc.mesh.lastManual" : "pc.mesh.last", { time: hhmm.format(new Date(u.t)), what }))}: <strong class="${cls}">${esc(u.resultado)}</strong>.`);
  }
  return out.join("<br>");
}
const meshSignature = () => { const m = S().paneles?.malla; return JSON.stringify([m?.activado, m?.cada, m?.canal, m?.saltos, S().channels.map((c) => c.index)]); };
function meshSection() {
  const c = meshCfg();
  const chs = S().channels;
  let chOpts = chs.map((ch) => `<option value="${ch.index}"${c.canal === ch.index ? " selected" : ""}>${ch.index} · ${esc(ch.name)}${ch.private ? "" : esc(t("pc.mesh.public"))}</option>`).join("");
  if (c.canal != null && !chs.some((ch) => ch.index === c.canal)) chOpts += `<option value="${c.canal}" selected>${esc(t("pc.mesh.chGone", { n: c.canal }))}</option>`;
  const sel = chs.find((ch) => ch.index === c.canal);
  const chHint = !chs.length ? `<p class="hint">${esc(t("pc.mesh.connectFirst"))}</p>`
    : sel && !sel.private ? `<p class="hint">${esc(t("pc.mesh.publicHint", { why: channelWhy(sel) }))}</p>` : "";
  const hop = S().lora?.hopLimit;
  const hopOpts = [`<option value=""${c.saltos == null ? " selected" : ""}>${esc(hop ? t("pc.mesh.receiverHopsN", { n: hop }) : t("pc.mesh.receiverHops"))}</option>`]
    .concat(Array.from({ length: MALLA_MAX_SALTOS }, (_, j) => j + 1).map((n) => `<option value="${n}"${c.saltos === n ? " selected" : ""}>${n}</option>`)).join("");
  return `<section class="blk" id="mallaBox" data-cfg="${esc(meshSignature())}"><h3>${esc(t("pc.mesh.title"))}</h3>
      <p class="hint">${esc(t("pc.mesh.lead"))}</p>
      <div class="set-row"><label class="sw" for="mallaOn"><input type="checkbox" id="mallaOn" ${c.activado ? "checked" : ""}><span class="sw-ui"></span><span>${esc(t("pc.mesh.on"))}</span></label></div>
      <div class="set-row"><label for="mallaCada">${esc(t("pc.mesh.every"))}</label><select id="mallaCada" class="inp sel">${MESH_EVERY.map((k) => `<option value="${k}"${k === c.cada ? " selected" : ""}>${esc(everyText(k))}</option>`).join("")}</select></div>
      <div class="set-row"><label for="mallaCh">${esc(t("pc.mesh.channel"))}</label><select id="mallaCh" class="inp sel">${chOpts || `<option value="">—</option>`}</select></div>
      ${chHint}
      <div class="set-row"><label for="mallaHop">${esc(t("pc.mesh.hops"))}</label><select id="mallaHop" class="inp sel">${hopOpts}</select></div>
      <p class="form-err" id="mallaErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-malla-save>${esc(t("pc.save"))}</button><button type="button" class="btn ghost" data-malla-send>${esc(t("pc.mesh.sendNow"))}</button></div>
      <p class="hint" id="mallaEstado">${meshStateHTML()}</p>
    </section>`;
}
function renderMesh() {
  const box = $("#mallaBox");
  if (box) box.outerHTML = meshSection();
}

/** The configuration sections of a watched panel's sheet. */
export function panelSections(num) {
  return nameSection(num) + dataSection(num) + (num === S().myNode ? meshSection() : "");
}

/** What arrives from the server (values, configuration): without overwriting what is being typed. */
export function patchPanels() {
  const num = S().detail?.num;
  if (num == null || !$("#detail").open) return;
  const dat = $("#datBox");
  if (dat) {
    if (!dataDraft && !dat.contains(document.activeElement) && dat.dataset.cfg !== dataSignature(num)) renderData(num);
    else {
      dataCfg(num).forEach((d, i) => { const el = dat.querySelector(`[data-dat-v="${i}"]`); if (el) el.innerHTML = datumValueHTML(num, d); });
      const cv = $("#conV");
      if (cv) cv.innerHTML = connValueHTML(num);
    }
  }
  const mesh = $("#mallaBox");
  if (mesh) {
    if (!meshDraft && !mesh.contains(document.activeElement) && mesh.dataset.cfg !== meshSignature()) renderMesh();
    else $("#mallaEstado").innerHTML = meshStateHTML();
  }
}

/* ── editing the data ── */
export const data = {
  add(num) {
    editableData(num).push(newDatum(num));
    renderData(num);
    $(`#datLista .est-d:last-child [data-dat-k="tema"]`)?.focus();
  },
  remove(num, i) {
    editableData(num).splice(i, 1);
    renderData(num);
  },
  /** Puts a found topic in the list: the type it looks like by its name, in the empty row if there is one. */
  use(num, i) {
    const x = found[i];
    if (!x) return;
    const datos = editableData(num);
    const tipo = x.estado ? "estado" : adivinarTipo(x.tema, x.campo) || "otro";
    let d = datos.find((y) => !y.tema.trim());
    if (!d) { d = newDatum(num, tipo); datos.push(d); }
    if (tipo === "estado") {
      Object.assign(d, { tipo, broker: x.broker, tema: x.tema, campo: x.campo, unidad: "", malla: false, ...adivinarEstado(x.tema, x.campo) });
      renderData(num);
      const [on, off] = NOMBRES_ESTADO[d.nombres];
      return ctx.toast(t(d.invertir ? "pc.used.stateReversed" : "pc.used.state", { on, off }));
    }
    const us = unidades(tipo);
    const unidad = tipo === "otro" ? x.unidad || "" : unidadDe(tipo, x.unidad) || (us.includes("km/h") ? "km/h" : us[0]); // wind in Home Assistant is usually km/h
    // On the receiver, to the mesh if it fits and there isn't another of that type already.
    const malla = num === S().myNode && tipoMalla(tipo) && !datos.some((y) => y !== d && y.malla && y.tipo === tipo);
    Object.assign(d, { tipo, broker: x.broker, tema: x.tema, campo: x.campo, unidad, malla });
    delete d.nombres;
    delete d.invertir;
    renderData(num);
    const check = !x.unidad && tipo !== "otro" && unidad !== us[0];
    ctx.toast(tipo === "otro" ? t("pc.used.other", { type: TIPOS.otro.label }) : t(check ? "pc.used.typeUnit" : "pc.used.type", { type: TIPOS[tipo].label, unit: unidad }));
  },
  /** Puts a found topic as the panel's connection topic. */
  useConn(num, i) {
    const x = found[i];
    if (!x) return;
    Object.assign(editableConn(num), { broker: x.broker, tema: x.tema, campo: x.campo });
    renderData(num);
    ctx.toast(t("pc.used.conn"));
  },
  async save(num) {
    const datos = dataCfg(num).filter((d) => d.tema.trim()).map((d) => ({ ...(d.clave ? { clave: d.clave } : {}), nombre: d.nombre || "", tipo: d.tipo, broker: d.broker || "", tema: d.tema, campo: d.campo || "", unidad: d.unidad || "", caduca: Number(d.caduca || 0), malla: !!d.malla,
      ...(esEstado(d.tipo) ? { nombres: d.nombres || "encendido", invertir: !!d.invertir, orden: d.orden ? { tema: d.orden.tema || "", on: d.orden.on || "", off: d.orden.off || "" } : null } : {}) }));
    const c = num < 0 ? connCfg(num) : null;
    const conexion = c?.tema.trim() ? { broker: c.broker || "", tema: c.tema.trim(), campo: (c.campo || "").trim(), avisar: !!c.avisar } : null;
    const res = await ctx.orden({ orden: "datosPanel", num, datos, ...(num < 0 ? { conexion } : {}) });
    if (!res.ok) return showErr($("#datErr"), res.error || t("pc.saveFailed"));
    dataDraft = null;
    ctx.toast(res.toast);
    renderData(num);
  },
  async find(btn, num) {
    btn.disabled = true;
    btn.textContent = t("pc.data.finding");
    const res = await ctx.orden({ orden: "buscarTemas" });
    btn.disabled = false;
    btn.textContent = t("pc.data.find");
    if (!res.ok) return showErr($("#datErr"), res.error || t("pc.findFailed"));
    found = res.temas || [];
    $("#datErr").hidden = true;
    $("#temasMqtt").innerHTML = topicOptions();
    dataCfg(num).forEach((d, i) => { const dl = $(`#camposMqtt${i}`); if (dl) dl.innerHTML = fieldOptions(d.tema); });
    $("#datBusca").textContent = found.length ? foundCount(found.length) : t("pc.data.foundNothing");
    $("#datHallados").innerHTML = foundHTML(num);
  },
  /** Typing in the filter of what was found: only the list changes (the box keeps its place and focus). */
  filter(value, num) {
    foundFilter = value;
    const box = $("#datHallados");
    if (!box) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = foundHTML(num);
    box.querySelectorAll(":scope > .est-hl, :scope > p").forEach((el) => el.remove());
    box.append(...[...tmp.children].filter((el) => el.id !== "filtroTemas"));
  },
  /** A change in a datum: to the draft. */
  change(num, el) {
    const k = el.dataset.datK;
    const d = editableData(num)[Number(el.dataset.datI)];
    if (!k || !d) return;
    if (k === "control") { // switching from here: with what that device usually uses, if known
      d.orden = el.checked ? proponerOrden(d.tema, d.campo) || { tema: "", on: "ON", off: "OFF" } : null;
      return renderData(num);
    }
    if (k === "ordenTema" || k === "ordenOn" || k === "ordenOff") {
      d.orden ||= { tema: "", on: "", off: "" };
      d.orden[{ ordenTema: "tema", ordenOn: "on", ordenOff: "off" }[k]] = el.value;
      return;
    }
    d[k] = k === "caduca" ? Number(el.value) : k === "malla" || k === "invertir" ? el.checked : el.value;
    if (k === "tipo") {
      d.unidad = unidades(d.tipo)[0] || "";
      if (!(num === S().myNode && tipoMalla(d.tipo))) d.malla = false;
      if (esEstado(d.tipo)) { d.nombres ||= "encendido"; d.invertir = !!d.invertir; } else d.orden = null;
      renderData(num);
    }
    if (k === "malla") renderData(num);
    if (k === "tema") { const dl = $(`#camposMqtt${el.dataset.datI}`); if (dl) dl.innerHTML = fieldOptions(d.tema.trim()); }
  },
  /** A change in the connection topic: to the draft. */
  changeConn(num, el) {
    const k = el.dataset.conK;
    if (!k) return;
    editableConn(num)[k] = k === "avisar" ? el.checked : el.value;
  },
};

/* ── editing what goes out to the mesh ── */
export const meshOut = {
  async save() {
    const c = meshCfg();
    const res = await ctx.orden({ orden: "envioMalla", cambio: { activado: !!c.activado, cada: Number(c.cada), canal: c.canal, saltos: c.saltos } });
    if (!res.ok) return showErr($("#mallaErr"), res.error || t("pc.saveFailed"));
    meshDraft = null;
    ctx.toast(res.toast);
    renderMesh();
  },
  change(el) {
    const c = (meshDraft ||= meshCfg());
    if (el.id === "mallaOn") c.activado = el.checked;
    if (el.id === "mallaCada") c.cada = Number(el.value);
    if (el.id === "mallaCh") c.canal = el.value === "" ? null : Number(el.value);
    if (el.id === "mallaHop") c.saltos = el.value === "" ? null : Number(el.value);
  },
};

/* ── new panels (without a node) ── */
export function newPanelSheet() {
  S().detail = null;
  $("#detail").setAttribute("aria-label", t("pc.new.title"));
  $("#detail").innerHTML = `<div class="sheet-h"><span class="tag">MQTT</span><div class="sheet-t"><h2>${esc(t("pc.new.title"))}</h2><p class="meta">${esc(t("pc.new.lead"))}</p></div><button class="icon-btn" data-close aria-label="${esc(t("sheet.close"))}">${ICON.close}</button></div>
    <div class="sheet-b"><section class="blk">
      <div class="mq-f"><label for="npNombre">${esc(t("pc.name"))}</label><input id="npNombre" class="inp" autocomplete="off" maxlength="40" placeholder="${esc(t("pc.new.example"))}">
      <label for="npTipo">${esc(t("pc.whatIsIt"))}</label><select id="npTipo" class="inp sel">${Object.entries(TIPOS_PANEL).map(([k, x]) => `<option value="${k}">${esc(x.label)}</option>`).join("")}</select></div>
      <p class="form-err" id="npErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-panel-crear>${esc(t("pc.new.create"))}</button></div>
      <p class="hint">${esc(t("pc.new.after"))}</p>
    </section></div>`;
  const d = $("#detail");
  if (!d.open) d.showModal();
  $("#npNombre").focus();
}
/** Creates it and opens its sheet once the server has sent it. openSheet: app.js's (it draws the charts too). */
export async function createPanel(openSheet) {
  const res = await ctx.orden({ orden: "crearPanel", nombre: $("#npNombre").value, tipo: $("#npTipo").value });
  if (!res.ok) return showErr($("#npErr"), res.error || t("pc.new.failed"));
  for (let i = 0; i < 40 && !(S().nodes.has(res.num) && S().cfg.watched[res.num]); i++) await new Promise((r) => setTimeout(r, 50));
  ctx.toast(res.toast);
  ctx.render();
  if (!S().nodes.has(res.num)) return $("#detail").close();
  openSheet(res.num);
  $("#datBox")?.scrollIntoView({ block: "start" });
}

export { displayName };
