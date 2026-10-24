// Settings → Mesh → «Orders over the mesh» (2.1b): on or off, the nodes that may give orders by a direct message
// (the server pins the key each one has when it's added), an optional private channel, and a word for each switch.
// The server checks and runs them (servidor/src/mesh-orders.js). Words typed and not saved stay if this is redrawn.
import { ctx } from "../ctx.js";
import { t, locale } from "../i18n.js";
import { $, esc } from "../ui.js";
import { displayName, watchedOrder } from "./dashboard.js";
import { metricMeta } from "@talaia/nucleo/metrics.js";

const S = () => ctx.S;
let words = null; // { "num|key": word } typed and not saved yet

function switches() {
  const out = [];
  for (const num of watchedOrder()) for (const d of S().paneles?.paneles?.[num]?.datos || []) if (d.orden) out.push({ ref: `${num}|${d.clave}`, num, key: d.clave });
  return out;
}
const word = (ref) => (words ? words[ref] : S().meshOrders?.words?.[ref]) ?? "";

export function meshOrdersHTML() {
  const s = S(), mo = s.meshOrders || { on: false, nodes: [], channel: null, words: {} };
  const listed = new Set(mo.nodes.map((n) => n.num));
  const nodes = mo.nodes.length
    ? `<ul class="mq-us mo-l">${mo.nodes.map((n) => {
      const node = s.nodes.get(n.num);
      const state = n.now === "changed" ? `<span class="warn-t">${esc(t("set.mo.keyChanged"))}</span>` : n.now === "unknown" ? `<span>${esc(t("set.mo.keyNotSeen"))}</span>` : "";
      return `<li><span>${esc(node ? `${displayName(node)} (${node.short})` : `!${(n.num >>> 0).toString(16)}`)} · <small>${esc(t("set.mo.key", { key: n.key }))}</small> ${state}</span><button type="button" class="mini" data-mo-del="${n.num}">${esc(t("pc.remove"))}</button></li>`;
    }).join("")}</ul>`
    : `<p class="hint">${esc(t("set.mo.noNodes"))}</p>`;
  const byName = (a, b) => displayName(a).localeCompare(displayName(b), locale());
  const can = [...s.nodes.values()].filter((n) => n.num >= 0 && n.num !== s.myNode && n.key === true && !listed.has(n.num));
  const opt = (n) => `<option value="${n.num}">${esc(displayName(n))} (${esc(n.short)})</option>`;
  const onBoard = can.filter((n) => s.cfg.watched[n.num]).sort(byName), rest = can.filter((n) => !s.cfg.watched[n.num]).sort(byName);
  const add = can.length
    ? `<div class="au-row"><select id="moNode" class="inp sel" aria-label="${esc(t("set.mo.addLabel"))}"><option value="">${esc(t("au.choose"))}</option>${onBoard.length ? `<optgroup label="${esc(t("au.onBoard"))}">${onBoard.map(opt).join("")}</optgroup>` : ""}${rest.length ? `<optgroup label="${esc(t("au.restMesh"))}">${rest.map(opt).join("")}</optgroup>` : ""}</select><button type="button" class="mini" data-mo-add>${esc(t("set.mo.add"))}</button></div>`
    : "";
  const chs = s.channels.filter((c) => c.private);
  const chOpts = `<option value=""${mo.channel == null ? " selected" : ""}>${esc(t("set.mo.noChannel"))}</option>`
    + chs.map((c) => `<option value="${c.index}"${c.index === mo.channel ? " selected" : ""}>${c.index} · ${esc(c.name)}</option>`).join("")
    + (mo.channel != null && !chs.some((c) => c.index === mo.channel) ? `<option value="${mo.channel}" selected>${esc(t("au.notPrivate"))}</option>` : "");
  const sw = switches();
  const rows = sw.length
    ? `<div class="mq-f mo-w">${sw.map((x, i) => `<label for="moW${i}">${esc(`${displayName(s.nodes.get(x.num))} · ${metricMeta(x.key).label}`)}</label><input id="moW${i}" class="inp" data-mo-word="${esc(x.ref)}" autocomplete="off" spellcheck="false" maxlength="20" placeholder="${esc(t("set.mo.noWord"))}" value="${esc(word(x.ref))}">`).join("")}</div>
      <div class="btns"><button type="button" class="btn ghost" data-mo-words>${esc(t("set.mo.saveWords"))}</button></div>
      <p class="form-err" id="moErr" role="alert" hidden></p>`
    : `<p class="hint">${esc(t("au.noSwitches"))}</p>`;
  const example = sw.find((x) => word(x.ref)) ? word(sw.find((x) => word(x.ref)).ref).toLowerCase() : t("set.mo.exWord");
  return `<section class="blk" id="moBox"><h3>${esc(t("set.mo.title"))}</h3>
      <p class="hint">${esc(t("set.mo.lead"))}</p>
      <div class="set-row"><label class="sw" for="moOn"><input type="checkbox" id="moOn"${mo.on ? " checked" : ""}><span class="sw-ui"></span><span>${esc(t("set.mo.on"))}</span></label></div>
      <h4>${esc(t("set.mo.nodes"))}</h4>
      ${nodes}${add}
      <p class="hint">${esc(t("set.mo.nodesHint"))}</p>
      <div class="set-row"><label for="moCh">${esc(t("set.mo.channel"))}</label><select id="moCh" class="inp sel">${chOpts}</select></div>
      <p class="hint">${esc(t("set.mo.channelHint"))}</p>
      <h4>${esc(t("set.mo.switches"))}</h4>
      ${rows}
      <p class="hint">${esc(t("set.mo.howTo", { w: example }))}</p>
    </section>`;
}

/** A button of this block: true if it was one. */
export async function meshOrdersClick(b, redraw) {
  const ds = b.dataset, { orden, toast } = ctx;
  if ("moAdd" in ds) {
    const v = $("#moNode")?.value;
    if (!v) return true;
    const r = await orden({ orden: "meshOrdersNode", num: Number(v) });
    toast(r.error || r.toast);
    if (r.ok) redraw();
    return true;
  }
  if ("moDel" in ds) {
    const r = await orden({ orden: "meshOrdersRemoveNode", num: Number(ds.moDel) });
    toast(r.error || r.toast);
    return true;
  }
  if ("moWords" in ds) {
    const all = Object.fromEntries(switches().map((x) => [x.ref, word(x.ref).trim()]).filter(([, w]) => w));
    const r = await orden({ orden: "meshOrders", cambio: { words: all } });
    if (!r.ok) { const e = $("#moErr"); if (e) { e.textContent = r.error; e.hidden = false; } return true; }
    words = null;
    toast(r.toast);
    redraw();
    return true;
  }
  return false;
}
/** A change in this block: true if it was one. */
export async function meshOrdersChange(el) {
  const { orden, toast } = ctx;
  if (el.id === "moOn") {
    const r = await orden({ orden: "meshOrders", cambio: { on: el.checked } });
    if (!r.ok) el.checked = !el.checked;
    toast(r.error || r.toast);
    return true;
  }
  if (el.id === "moCh") {
    const r = await orden({ orden: "meshOrders", cambio: { channel: el.value === "" ? null : Number(el.value) } });
    if (!r.ok) el.value = S().meshOrders?.channel ?? "";
    toast(r.error || r.toast);
    return true;
  }
  return meshOrdersInput(el);
}
export function meshOrdersInput(el) {
  if (!("moWord" in el.dataset)) return false;
  words ||= { ...(S().meshOrders?.words || {}) };
  words[el.dataset.moWord] = el.value;
  return true;
}
