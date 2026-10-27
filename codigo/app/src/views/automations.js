// Automations (2.1): the list («if … then …», on or off, what each one is waiting for, when it last ran) and the
// editor, in a sheet. «If» a datum or a state, a time of day, or an order over the mesh (Settings → Mesh). The server runs them and checks what is saved (servidor/src/automations.js): here they are
// only drawn and edited. While one is being edited, the changes are a draft until saved, kept if it is reopened.
import { ctx } from "../ctx.js";
import { t, locale, getLang } from "../i18n.js";
import { $, esc, ICON, parseNum, setHTML } from "../ui.js";
import { isView } from "../shell.js";
import { displayName, watchedOrder } from "./dashboard.js";
import { datumOf } from "./node-parts.js";
import { metricMeta, fmtLimit, sortMetrics, METRICS } from "@talaia/nucleo/metrics.js";
import { esEstado, esClaveMqtt } from "@talaia/nucleo/mqtt-datos.js";
import { ASK_ALL } from "@talaia/nucleo/motor.js";
import { MIN, dur, ago, hhmm } from "@talaia/nucleo/textos.js";

const ASKABLE = ["env", "device", "air", "power", "pos"]; // the same as the server's (no node info, no traceroute)
const TEXT_MAX = 200;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const te8 = new TextEncoder();

const S = () => ctx.S;
const box = () => $("#automations");
const dlg = () => $("#autoEd");
let draft = null; // { key: id | "new", a: the automation as typed }
let armed = null; // { what: "run" | "del", id, t }: a second press within 4 s confirms

/* ── names ── */
const list = () => S().automations?.list || [];
const panelName = (num) => displayName(S().nodes.get(num)) || t("au.gone");
const datumName = (num, k) => `${panelName(num)} · ${metricMeta(k).label}`;
const stateNames = (k) => metricMeta(k).estados || ["ON", "OFF"];
const stateName = (k, v) => stateNames(k)[v ? 0 : 1];
const nodeName = (num) => { const n = S().nodes.get(num); return n ? displayName(n) : `!${(num >>> 0).toString(16).padStart(8, "0")}`; };
const channelOf = (i) => S().channels.find((c) => c.index === i);
function dayNames(style) {
  const f = new Intl.DateTimeFormat(locale(), { weekday: style, timeZone: "UTC" });
  return ALL_DAYS.map((d) => f.format(new Date(Date.UTC(2024, 0, d)))); // 1 Jan 2024 was a Monday
}
function daysText(days) {
  const k = days.join("");
  if (k === "1234567") return t("au.days.all");
  if (k === "12345") return t("au.days.week");
  if (k === "67") return t("au.days.weekend");
  const n = dayNames("short");
  return days.map((d) => n[d - 1]).join(", ");
}
function secondsText(s) {
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  return s % 3600 ? dur(s * 1000) : `${s / 3600} h`;
}

/* ── what can be chosen ── */
/** A watched panel's data: the Meshtastic readings it has, then its MQTT data. */
function dataOf(num) {
  const n = S().nodes.get(num);
  const mesh = num >= 0 ? Object.keys(n?.metrics || {}).filter((k) => !esClaveMqtt(k) && Object.hasOwn(METRICS, k)) : [];
  return [...sortMetrics(mesh), ...(S().paneles?.paneles?.[num]?.datos || []).map((d) => d.clave)];
}
const isState = (num, k) => esClaveMqtt(k) && esEstado(datumOf(num, k)?.tipo);
function switches() {
  const out = [];
  for (const num of watchedOrder()) for (const d of S().paneles?.paneles?.[num]?.datos || []) if (d.orden) out.push(`${num}|${d.clave}`);
  return out;
}
/** Nodes to write to or ask: the ones on the dashboard first, then the rest of the mesh. */
function nodeOptions(sel) {
  const s = S();
  const all = [...s.nodes.values()].filter((n) => n.num >= 0 && n.num !== s.myNode);
  const byName = (a, b) => displayName(a).localeCompare(displayName(b), locale());
  const watched = all.filter((n) => s.cfg.watched[n.num]).sort(byName), rest = all.filter((n) => !s.cfg.watched[n.num]).sort(byName);
  const o = (n) => `<option value="${n.num}"${n.num === sel ? " selected" : ""}>${esc(displayName(n))} (${esc(n.short)})</option>`;
  return `<option value=""${sel == null ? " selected" : ""}>${esc(t("au.choose"))}</option>`
    + (watched.length ? `<optgroup label="${esc(t("au.onBoard"))}">${watched.map(o).join("")}</optgroup>` : "")
    + (rest.length ? `<optgroup label="${esc(t("au.restMesh"))}">${rest.map(o).join("")}</optgroup>` : "");
}

/* ── the list ── */
function whenText(w) {
  if (w.type === "time") return t("au.s.time", { at: w.at, days: daysText(w.days) });
  if (w.type === "mesh") return t("au.s.mesh", { text: w.text, via: t(`au.via.${w.via ?? "any"}`) });
  const what = datumName(w.num, w.key), d = w.for ? t("au.s.for", { d: dur(w.for * MIN) }) : "";
  if (w.op === "is") return t("au.s.is", { what, state: stateName(w.key, w.value), for: d });
  return t(w.op === "above" ? "au.s.above" : "au.s.below", { what, limit: fmtLimit(w.key, w.value, true).replace(" ", "\u00a0"), for: d }); // «30,0 °C» on one line
}
function stepText(s) {
  if (s.type === "switch") return t("au.s.switch", { what: datumName(s.num, s.key), state: stateName(s.key, s.value), for: s.for ? t("au.s.during", { d: dur(s.for * MIN) }) : "" });
  if (s.type === "wait") return t("au.s.wait", { d: secondsText(s.seconds) });
  if (s.type === "message") return t("au.s.msg", { to: s.to.channel != null ? t("au.channel", { name: channelOf(s.to.channel)?.name ?? s.to.channel }) : nodeName(s.to.node), text: s.text });
  if (s.type === "ask") return t("au.s.ask", { what: ASK_ALL[s.what]?.label || s.what, node: nodeName(s.num) });
  if (s.type === "telegram") return t("au.s.tg", { text: s.text, pos: s.pos != null ? t("au.s.tgPos", { node: nodeName(s.pos) }) : "" });
  return "?";
}
/** What it points at that isn't there any more (a panel, a datum, a switch, a channel). */
function problems(a) {
  const s = S(), out = [];
  const w = a.when;
  if (w.type === "value" && (!s.cfg.watched[w.num] || !dataOf(w.num).includes(w.key))) out.push(t("au.p.when"));
  if (w.type === "mesh" && (w.via ?? "any") !== "telegram" && !s.meshOrders?.on) out.push(t("au.p.meshOff"));
  if (w.type === "mesh" && (w.via ?? "any") !== "mesh" && !s.telegram?.on) out.push(t("au.p.tgOff"));
  a.steps.forEach((x, i) => {
    if (x.type === "telegram" && !s.telegram?.on) out.push(t("au.p.tgStep", { n: i + 1 }));
    if (x.type === "switch" && !datumOf(x.num, x.key)?.orden) out.push(t("au.p.step", { n: i + 1 }));
    if (x.type === "message" && x.to.channel != null && s.channels.length && !channelOf(x.to.channel)?.private) out.push(t("au.p.channel", { n: i + 1 }));
  });
  return out;
}
function statusHTML(a) {
  const au = S().automations || {};
  const parts = [];
  if (a.paused) parts.push(`<span class="warn-t">${esc(t("au.paused"))}</span>`);
  for (const p of problems(a)) parts.push(`<span class="warn-t">${esc(p)}</span>`);
  const r = au.runs?.[a.id];
  if (r) parts.push(esc(t("au.waiting", { time: hhmm.format(new Date(r.at)) })));
  for (const b of (au.backs || []).filter((x) => x.id === a.id)) parts.push(esc(t("au.back", { what: datumName(b.num, b.key), state: stateName(b.key, b.value), time: hhmm.format(new Date(b.at)) })));
  const l = au.last?.[a.id];
  parts.push(esc(l ? t("au.last", { when: ago(l.t) }) : t("au.never")));
  return parts.join(" · ");
}
function itemHTML(a) {
  const run = armed?.what === "run" && armed.id === a.id;
  return `<li class="au${a.on ? "" : " off"}">
    <div class="au-h">
      <label class="sw" for="auOn${a.id}"><input type="checkbox" id="auOn${a.id}" data-au-on="${a.id}"${a.on ? " checked" : ""}><span class="sw-ui"></span><span class="vh">${esc(t(a.on ? "au.isOn" : "au.isOff", { name: a.name }))}</span></label>
      <h3 class="au-n">${esc(a.name)}</h3>
    </div>
    <p class="au-s"><span class="au-k">${esc(t("au.if"))}</span> ${esc(whenText(a.when))}</p>
    <ol class="au-do">${a.steps.map((s) => `<li>${esc(stepText(s))}</li>`).join("")}</ol>
    <div class="au-f"><p class="meta au-m">${statusHTML(a)}</p>
      <span class="au-tools"><button type="button" class="mini" data-au-run="${a.id}">${esc(t(run ? "au.runArm" : "au.run"))}</button><button type="button" class="mini" data-au-edit="${a.id}">${esc(t("au.editBtn"))}</button></span></div>
  </li>`;
}

export function renderAutomations() {
  const el = box();
  if (!el || !isView("automations")) return;
  const items = list();
  const head = `<div class="sec-h has-tools"><h2>${esc(t("au.title"))}</h2><span class="count">${items.length || ""}</span><div class="sec-tools"><button type="button" class="btn sm primary" data-au-new>${ICON.plus}${esc(t("au.newBtn"))}</button></div></div>`;
  const body = items.length
    ? `<ul class="au-l">${items.map(itemHTML).join("")}</ul><p class="hint au-foot">${esc(t("au.foot"))}</p>`
    : `<div class="empty"><p><strong>${esc(t("au.empty"))}</strong></p><p>${esc(t("au.emptyLead"))}</p><p>${esc(t("au.emptyExample"))}</p></div>`;
  setHTML(el, `<section class="sec au-sec">${head}${body}</section>`);
}

/* ── the editor ── */
/** A saved automation as the editor holds it (numbers as typed, a wait in its unit). */
function toDraft(a) {
  const w = a.when;
  const when = w.type === "time" ? { type: "time", at: w.at, days: [...w.days] }
    : w.type === "mesh" ? { type: "mesh", text: w.text, via: w.via ?? "any" }
    : { type: "value", num: w.num, key: w.key, op: w.op, value: w.op === "is" ? w.value : String(w.value).replace(".", locale() === "es-ES" ? "," : "."), for: w.for ? String(w.for) : "" };
  const steps = a.steps.map((s) => {
    if (s.type === "switch") return { type: "switch", ref: `${s.num}|${s.key}`, value: s.value, for: s.for ? String(s.for) : "" };
    if (s.type === "wait") { const unit = s.seconds % 3600 === 0 ? "h" : s.seconds % 60 === 0 ? "min" : "s"; return { type: "wait", n: String(s.seconds / { s: 1, min: 60, h: 3600 }[unit]), unit }; }
    if (s.type === "message") return { type: "message", to: s.to.channel != null ? `c:${s.to.channel}` : `n:${s.to.node}`, text: s.text };
    if (s.type === "telegram") return { type: "telegram", text: s.text, pos: s.pos ?? null };
    return { type: "ask", num: s.num, what: s.what };
  });
  return { id: a.id, name: a.name, on: a.on, when, steps };
}
function newDraft() {
  const first = watchedOrder()[0];
  const key = first != null ? dataOf(first)[0] : null;
  return { name: "", on: true, when: valueWhen(first ?? null, key), steps: [] };
}
function valueWhen(num, key) {
  const st = num != null && key ? isState(num, key) : false;
  return { type: "value", num, key, op: st ? "is" : "above", value: st ? 1 : "", for: "" };
}
function newStep(type) {
  if (type === "switch") return { type, ref: switches()[0] || "", value: 1, for: "" };
  if (type === "wait") return { type, n: "30", unit: "s" };
  if (type === "message") { const ch = S().channels.find((c) => c.private); return { type, to: ch ? `c:${ch.index}` : "", text: "" }; }
  if (type === "telegram") return { type, text: "", pos: null };
  return { type: "ask", num: null, what: "env" };
}
/** What goes to the server: numbers as numbers (what can't be read goes as it is, and the server says what's wrong). */
function payload(d) {
  const num = (s) => { const v = parseNum(s); return v === null ? null : Number.isNaN(v) ? s : v; };
  const w = d.when;
  const when = w.type === "time" ? { type: "time", at: w.at, days: w.days }
    : w.type === "mesh" ? { type: "mesh", text: w.text, via: w.via }
    : { type: "value", num: w.num, key: w.key, op: w.op, value: w.op === "is" ? w.value : num(w.value), for: num(w.for) ?? 0 };
  const steps = d.steps.map((s) => {
    if (s.type === "switch") { const [n, k] = s.ref.split("|"); return { type: "switch", num: Number(n), key: k, value: s.value, for: num(s.for) }; }
    if (s.type === "wait") { const n = num(s.n); return { type: "wait", seconds: typeof n === "number" ? Math.round(n * { s: 1, min: 60, h: 3600 }[s.unit]) : n }; }
    if (s.type === "message") { const [k, v] = s.to.split(":"); return { type: "message", to: k === "c" ? { channel: Number(v) } : k === "n" ? { node: Number(v) } : {}, text: s.text }; }
    if (s.type === "telegram") return { type: "telegram", text: s.text, pos: s.pos };
    return { type: "ask", num: s.num, what: s.what };
  });
  return { ...(d.id != null ? { id: d.id } : {}), name: d.name, on: d.on, when, steps };
}

/** Opens the editor: id of a saved one, or null for a new one. A draft of the same one is kept. */
export function openAutomation(id = null) {
  const key = id ?? "new";
  if (draft?.key !== key) {
    const a = id != null ? list().find((x) => x.id === id) : null;
    if (id != null && !a) return;
    draft = { key, a: a ? toDraft(a) : newDraft() };
  }
  armed = null;
  dlg().setAttribute("aria-label", t(key === "new" ? "au.new" : "au.edit"));
  dlg().innerHTML = `<div class="sheet-h"><div class="sheet-t"><h2>${esc(t(key === "new" ? "au.new" : "au.edit"))}</h2><p class="meta">${esc(t("au.edLead"))}</p></div><button class="icon-btn" data-close aria-label="${esc(t("sheet.close"))}">${ICON.close}</button></div><div class="sheet-b" id="auBody"></div>`;
  drawEditor();
  if (!dlg().open) dlg().showModal();
}

function drawEditor() {
  const b = $("#auBody");
  if (!b) return;
  const top = b.scrollTop;
  const a = draft.a;
  b.innerHTML = `<section class="blk"><label for="auName"><h3>${esc(t("au.name"))}</h3></label>
      <input id="auName" class="inp" data-au="name" autocomplete="off" maxlength="40" value="${esc(a.name)}" placeholder="${esc(t("au.namePh"))}"></section>
    <section class="blk"><h3>${esc(t("au.when"))}</h3>${whenHTML(a.when)}</section>
    <section class="blk"><h3>${esc(t("au.then"))}</h3>
      ${a.steps.length ? `<ol class="au-st-l">${a.steps.map(stepHTML).join("")}</ol>` : `<p class="hint">${esc(t("au.noSteps"))}</p>`}
      <div class="btns au-add">${["switch", "wait", "message", "telegram", "ask"].map((k) => `<button type="button" class="mini" data-au-add="${k}">${ICON.plus}${esc(t(`au.add.${k}`))}</button>`).join("")}</div>
    </section>
    <section class="blk end">
      <label class="sw" for="auOnEd"><input type="checkbox" id="auOnEd" data-au="on"${a.on ? " checked" : ""}><span class="sw-ui"></span><span>${esc(t("au.onLabel"))}</span></label>
      <p class="form-err" id="auErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-au-save>${esc(t("au.save"))}</button>${draft.key !== "new" ? `<button type="button" class="btn danger-ghost" data-au-del>${esc(t(armed?.what === "del" ? "au.delArm" : "au.del"))}</button>` : ""}</div>
    </section>`;
  b.scrollTop = top;
}

function whenHTML(w) {
  const type = `<div class="set-row"><label for="auType">${esc(t("au.whenType"))}</label><select id="auType" class="inp sel" data-au="whenType">
      <option value="value"${w.type === "value" ? " selected" : ""}>${esc(t("au.w.value"))}</option>
      <option value="time"${w.type === "time" ? " selected" : ""}>${esc(t("au.w.time"))}</option>
      <option value="mesh"${w.type === "mesh" ? " selected" : ""}>${esc(t("au.w.mesh"))}</option></select></div>`;
  if (w.type === "mesh") {
    const via = w.via ?? "any";
    const meshOff = via !== "telegram" && !S().meshOrders?.on, tgOff = via !== "mesh" && !S().telegram?.on;
    return `${type}<div class="au-row"><label for="auOrder">${esc(t("au.order"))}</label><input id="auOrder" class="inp au-order" data-au="order" autocomplete="off" spellcheck="false" maxlength="40" value="${esc(w.text)}" placeholder="${esc(t("au.orderPh"))}"></div>
      <div class="set-row"><label for="auVia">${esc(t("au.via"))}</label><select id="auVia" class="inp sel" data-au="via">${["any", "mesh", "telegram"].map((k) => `<option value="${k}"${k === via ? " selected" : ""}>${esc(t(`au.via.${k}`))}</option>`).join("")}</select></div>
      <p class="hint">${esc(t("au.orderHint"))}</p>${meshOff ? `<p class="warn-t">${esc(t("au.p.meshOff"))}</p>` : ""}${tgOff ? `<p class="warn-t">${esc(t("au.p.tgOff"))}</p>` : ""}`;
  }
  if (w.type === "time") {
    const short = dayNames("narrow"), long = dayNames("long");
    return `${type}<div class="au-row"><label for="auAt">${esc(t("au.at"))}</label><input id="auAt" class="inp au-time" type="time" data-au="at" value="${esc(w.at || "")}" required></div>
      <div class="fchips au-days" role="group" aria-label="${esc(t("au.daysLabel"))}">${ALL_DAYS.map((d) => `<button type="button" class="fchip" data-au-day="${d}" aria-pressed="${w.days.includes(d)}" aria-label="${esc(long[d - 1])}" title="${esc(long[d - 1])}">${esc(short[d - 1])}</button>`).join("")}</div>
      <p class="hint">${esc(t("au.timeHint"))}</p>`;
  }
  const panels = watchedOrder();
  if (!panels.length) return `${type}<p class="hint">${esc(t("au.noPanels"))}</p>`;
  const pOpts = (w.num == null || !panels.includes(w.num) ? `<option value=""${w.num == null ? " selected" : ""}>${esc(w.num == null ? t("au.choose") : t("au.gone"))}</option>` : "")
    + panels.map((n) => `<option value="${n}"${n === w.num ? " selected" : ""}>${esc(panelName(n))}</option>`).join("");
  const keys = w.num != null ? dataOf(w.num) : [];
  const kOpts = (w.key && !keys.includes(w.key) ? `<option value="${esc(w.key)}" selected>${esc(t("au.gone"))}</option>` : "")
    + (keys.length ? keys.map((k) => `<option value="${esc(k)}"${k === w.key ? " selected" : ""}>${esc(metricMeta(k).label)}</option>`).join("") : `<option value="">${esc(t("au.noData"))}</option>`);
  let cond = "";
  if (w.key) {
    if (w.op === "is") {
      const [on, off] = stateNames(w.key);
      cond = `<select class="inp sel" data-au="stateValue" aria-label="${esc(t("au.stateLabel"))}"><option value="1"${w.value === 1 ? " selected" : ""}>${esc(t("au.becomes", { state: on }))}</option><option value="0"${w.value === 0 ? " selected" : ""}>${esc(t("au.becomes", { state: off }))}</option></select>`;
    } else {
      const u = metricMeta(w.key).unit;
      cond = `<select class="inp sel" data-au="op" aria-label="${esc(t("au.opLabel"))}"><option value="above"${w.op === "above" ? " selected" : ""}>${esc(t("au.above"))}</option><option value="below"${w.op === "below" ? " selected" : ""}>${esc(t("au.below"))}</option></select>
        <span class="inp-u"><input class="inp" data-au="value" inputmode="decimal" autocomplete="off" value="${esc(w.value)}" aria-label="${esc(t("au.valueLabel"))}">${u ? `<span>${esc(u)}</span>` : ""}</span>`;
    }
  }
  return `${type}<div class="au-row"><select class="inp sel" data-au="whenNum" aria-label="${esc(t("au.panel"))}">${pOpts}</select><select class="inp sel" data-au="whenKey" aria-label="${esc(t("au.datum"))}">${kOpts}</select></div>
    ${cond ? `<div class="au-row">${cond}</div>` : ""}
    ${w.key ? `<div class="au-row"><label for="auFor">${esc(t("au.forLabel"))}</label><span class="inp-u"><input id="auFor" class="inp" data-au="for" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(w.for)}"><span>min</span></span></div>` : ""}
    <p class="hint">${esc(t(w.op === "is" ? "au.stateHint" : "au.valueHint"))}</p>`;
}

function stepHTML(s, i) {
  const n = draft.a.steps.length;
  const f = (k) => `data-au-i="${i}" data-au-k="${k}"`;
  let body = "";
  if (s.type === "switch") {
    const sw = switches();
    const opts = (s.ref && !sw.includes(s.ref) ? `<option value="${esc(s.ref)}" selected>${esc(t("au.gone"))}</option>` : "")
      + sw.map((r) => { const [num, k] = r.split("|"); return `<option value="${esc(r)}"${r === s.ref ? " selected" : ""}>${esc(datumName(Number(num), k))}</option>`; }).join("");
    const k = s.ref.split("|")[1] || "";
    const [on, off] = k ? stateNames(k) : ["ON", "OFF"];
    body = sw.length || s.ref
      ? `<div class="au-row"><select class="inp sel" ${f("ref")} aria-label="${esc(t("au.switch"))}">${opts}</select>
          <select class="inp sel" ${f("value")} aria-label="${esc(t("au.toState"))}"><option value="1"${s.value === 1 ? " selected" : ""}>${esc(on)}</option><option value="0"${s.value === 0 ? " selected" : ""}>${esc(off)}</option></select></div>
        <div class="au-row"><label for="auSf${i}">${esc(t("au.during"))}</label><span class="inp-u"><input id="auSf${i}" class="inp" ${f("for")} inputmode="numeric" autocomplete="off" placeholder="—" value="${esc(s.for)}"><span>min</span></span></div>
        <p class="hint">${esc(t("au.duringHint", { state: s.value ? off : on }))}</p>`
      : `<p class="hint">${esc(t("au.noSwitches"))}</p>`;
  } else if (s.type === "wait") {
    body = `<div class="au-row"><input class="inp au-num" ${f("n")} inputmode="numeric" autocomplete="off" value="${esc(s.n)}" aria-label="${esc(t("au.waitLabel"))}">
      <select class="inp sel" ${f("unit")} aria-label="${esc(t("au.unit"))}">${["s", "min", "h"].map((u) => `<option value="${u}"${u === s.unit ? " selected" : ""}>${esc(t(`au.unit.${u}`))}</option>`).join("")}</select></div>`;
  } else if (s.type === "message") {
    const chs = S().channels.filter((c) => c.private);
    const cur = s.to;
    const chOpts = chs.map((c) => `<option value="c:${c.index}"${cur === `c:${c.index}` ? " selected" : ""}>${esc(t("au.channel", { name: c.name }))}</option>`).join("");
    const nodeSel = cur.startsWith("n:") ? Number(cur.slice(2)) : null;
    const nOpts = nodeOptions(nodeSel).replace(/<option value="(\d+)"/g, '<option value="n:$1"').replace(/^<option value=""[^<]*<\/option>/, "");
    const lost = cur.startsWith("c:") && !chs.some((c) => `c:${c.index}` === cur) ? `<option value="${esc(cur)}" selected>${esc(t("au.notPrivate"))}</option>` : "";
    body = `<div class="au-row"><select class="inp sel" ${f("to")} aria-label="${esc(t("au.to"))}"><option value=""${cur ? "" : " selected"}>${esc(t("au.choose"))}</option>${lost}${chOpts ? `<optgroup label="${esc(t("au.privateChannels"))}">${chOpts}</optgroup>` : ""}${nOpts}</select></div>
      <input class="inp" ${f("text")} autocomplete="off" value="${esc(s.text)}" placeholder="${esc(t("au.textPh", TOKENS()))}" aria-label="${esc(t("au.text"))}">
      <p class="hint"><span data-au-bytes="${i}">${esc(bytesText(s.text))}</span> · ${esc(t("au.textHint", TOKENS()))}</p>`;
  } else if (s.type === "telegram") {
    const tgOff = !S().telegram?.on;
    body = `<input class="inp" ${f("text")} autocomplete="off" value="${esc(s.text)}" placeholder="${esc(t("au.textPh", TOKENS()))}" aria-label="${esc(t("au.text"))}">
      <div class="au-row"><label for="auTp${i}">${esc(t("au.pos"))}</label><select id="auTp${i}" class="inp sel" ${f("pos")}>${nodeOptions(s.pos).replace(/^<option value=""[^<]*<\/option>/, `<option value=""${s.pos == null ? " selected" : ""}>${esc(t("au.posNone"))}</option>`)}</select></div>
      <p class="hint">${esc(t("au.tgHint", TOKENS()))}</p>${tgOff ? `<p class="warn-t">${esc(t("au.p.tgOff"))}</p>` : ""}`;
  } else {
    body = `<div class="au-row"><select class="inp sel" ${f("num")} aria-label="${esc(t("au.node"))}">${nodeOptions(s.num)}</select>
      <select class="inp sel" ${f("what")} aria-label="${esc(t("au.what"))}">${ASKABLE.map((k) => `<option value="${k}"${k === s.what ? " selected" : ""}>${esc(ASK_ALL[k].label)}</option>`).join("")}</select></div>`;
  }
  return `<li class="au-st"><div class="au-st-h"><b>${i + 1}</b><span>${esc(t(`au.add.${s.type}`))}</span>
      <span class="au-st-t"><button type="button" class="mini" data-au-up="${i}"${i === 0 ? " disabled" : ""} aria-label="${esc(t("au.up"))}">${ICON.up}</button><button type="button" class="mini" data-au-down="${i}"${i === n - 1 ? " disabled" : ""} aria-label="${esc(t("au.down"))}">${ICON.down}</button><button type="button" class="mini" data-au-rm="${i}">${esc(t("au.rm"))}</button></span></div>
    ${body}</li>`;
}
// What a message can carry, in each language's words (the server takes both).
const TOKENS = () => (getLang() === "es" ? { v: "{valor}", h: "{hora}" } : { v: "{value}", h: "{time}" });
const bytesText = (s) => t("au.bytes", { n: te8.encode(s.trim()).length, max: TEXT_MAX });

/* ── what is pressed and typed ── */
function onEditorInput(ev) {
  const el = ev.target;
  if (!draft) return;
  const a = draft.a;
  if (el.dataset.au) {
    const k = el.dataset.au;
    if (k === "name") a.name = el.value;
    else if (k === "value") a.when.value = el.value;
    else if (k === "for") a.when.for = el.value;
    else if (k === "at") a.when.at = el.value;
    else if (k === "order") a.when.text = el.value;
    return;
  }
  const i = Number(el.dataset.auI), s = a.steps[i];
  if (!s || !el.dataset.auK) return;
  const k = el.dataset.auK;
  if (["for", "n", "text"].includes(k)) s[k] = el.value;
  if (k === "text") { const b = $(`[data-au-bytes="${i}"]`); if (b) b.textContent = bytesText(el.value); }
}
function onEditorChange(ev) {
  const el = ev.target;
  if (!draft) return;
  const a = draft.a;
  if (el.dataset.au) {
    const k = el.dataset.au;
    if (k === "on") a.on = el.checked;
    else if (k === "whenType") a.when = el.value === "time" ? { type: "time", at: "08:00", days: [...ALL_DAYS] } : el.value === "mesh" ? { type: "mesh", text: "" } : valueWhen(watchedOrder()[0] ?? null, watchedOrder()[0] != null ? dataOf(watchedOrder()[0])[0] : null);
    else if (k === "whenNum") { const num = el.value === "" ? null : Number(el.value); a.when = valueWhen(num, num != null ? dataOf(num)[0] : null); }
    else if (k === "whenKey") a.when = { ...valueWhen(a.when.num, el.value || null), for: a.when.for };
    else if (k === "op") a.when.op = el.value;
    else if (k === "via") { a.when.via = el.value; drawEditor(); return; }
    else if (k === "stateValue") a.when.value = Number(el.value);
    else return onEditorInput(ev);
    if (["whenType", "whenNum", "whenKey"].includes(k)) drawEditor();
    return;
  }
  const i = Number(el.dataset.auI), s = a.steps[i];
  if (!s || !el.dataset.auK) return;
  const k = el.dataset.auK;
  if (k === "ref" || k === "to" || k === "unit" || k === "what") s[k] = el.value;
  else if (k === "value") s.value = Number(el.value);
  else if (k === "num" || k === "pos") s[k] = el.value === "" ? null : Number(el.value);
  else return onEditorInput(ev);
  if (k === "ref" || k === "value") drawEditor(); // the names of its states, the hint
}
async function onEditorClick(ev) {
  const b = ev.target.closest("button");
  if (!b || !draft) return;
  const ds = b.dataset, a = draft.a;
  if ("auDay" in ds) {
    const d = Number(ds.auDay);
    a.when.days = a.when.days.includes(d) ? a.when.days.filter((x) => x !== d) : [...a.when.days, d].sort((x, y) => x - y);
    b.setAttribute("aria-pressed", String(a.when.days.includes(d)));
    return;
  }
  if ("auAdd" in ds) { a.steps.push(newStep(ds.auAdd)); drawEditor(); return $(`#auBody .au-st:last-child select, #auBody .au-st:last-child input`)?.focus(); }
  if ("auRm" in ds) { a.steps.splice(Number(ds.auRm), 1); return drawEditor(); }
  if ("auUp" in ds || "auDown" in ds) {
    const i = Number(ds.auUp ?? ds.auDown), j = "auUp" in ds ? i - 1 : i + 1;
    if (j < 0 || j >= a.steps.length) return;
    [a.steps[i], a.steps[j]] = [a.steps[j], a.steps[i]];
    drawEditor();
    return $(`#auBody [data-au-${"auUp" in ds ? "up" : "down"}="${j}"]:not(:disabled)`)?.focus();
  }
  if ("auSave" in ds) return save();
  if ("auDel" in ds) {
    if (!(armed?.what === "del" && Date.now() - armed.t < 4000)) { armed = { what: "del", id: a.id, t: Date.now() }; b.textContent = t("au.delArm"); return; }
    armed = null;
    const r = await ctx.orden({ orden: "removeAutomation", id: a.id });
    if (!r.ok) return showErr(r.error);
    draft = null;
    dlg().close();
    return ctx.toast(r.toast);
  }
}
function showErr(msg) { const e = $("#auErr"); if (e) { e.textContent = msg || t("au.failed"); e.hidden = false; } }
async function save() {
  const r = await ctx.orden({ orden: "automation", auto: payload(draft.a) });
  if (!r.ok) return showErr(r.error);
  draft = null;
  dlg().close();
  ctx.toast(r.toast);
}

/* ── the list's buttons ── */
async function onListClick(ev) {
  const b = ev.target.closest("button");
  if (!b) return;
  const ds = b.dataset;
  if ("auNew" in ds) return openAutomation(null);
  if ("auEdit" in ds) return openAutomation(Number(ds.auEdit));
  if ("auRun" in ds) {
    const id = Number(ds.auRun);
    if (!(armed?.what === "run" && armed.id === id && Date.now() - armed.t < 4000)) {
      armed = { what: "run", id, t: Date.now() };
      b.textContent = t("au.runArm");
      setTimeout(() => { if (armed?.id === id && armed.what === "run" && Date.now() - armed.t >= 4000) { armed = null; renderAutomations(); } }, 4100);
      return;
    }
    armed = null;
    b.textContent = t("au.run");
    const r = await ctx.orden({ orden: "runAutomation", id });
    return ctx.toast(r.toast || r.error);
  }
}
async function onListChange(ev) {
  const el = ev.target;
  if (!("auOn" in el.dataset)) return;
  const r = await ctx.orden({ orden: "automationOn", id: Number(el.dataset.auOn), on: el.checked });
  if (!r.ok) { el.checked = !el.checked; return ctx.toast(r.error); }
  if (r.toast) ctx.toast(r.toast);
}

export function initAutomations() {
  box().addEventListener("click", onListClick);
  box().addEventListener("change", onListChange);
  const d = dlg();
  d.addEventListener("click", onEditorClick);
  d.addEventListener("input", onEditorInput);
  d.addEventListener("change", onEditorChange);
  d.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.matches("input:not([type=checkbox])")) { ev.preventDefault(); save(); } });
}
