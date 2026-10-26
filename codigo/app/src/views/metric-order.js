// How a panel shows its data, chosen on any screen and kept by the server: the order of its readings (card, sheet and
// full screen), the order of its charts (sheet and full screen) and the chart that goes on its card. The editor is a
// list of each with arrows and a handle, like the order of the panels on the board.
import { ctx } from "../ctx.js";
import { t } from "../i18n.js";
import { $, esc, ICON } from "../ui.js";
import { metricMeta, sortMetrics } from "@talaia/nucleo/metrics.js";
import { enableDrag } from "../order-drag.js";

/** What the server has saved for a panel: { data, charts, card }. */
export const layoutOf = (num) => ctx.S.paneles?.paneles?.[num]?.layout || {};
/** `keys` in the order the panel chose for its readings ("data") or its charts ("charts"). */
export const orderedKeys = (num, keys, which = "data") => sortMetrics(keys, layoutOf(num)[which]);
/** The metric chosen for the card, if there is one and the panel still has it. */
export const cardMetric = (num, keys) => { const k = layoutOf(num).card; return k && keys.includes(k) ? k : null; };

/** The readings a panel shows (the ones with a place in the editor), in its order. */
export function shownKeys(num, which = "data") {
  const n = ctx.motor.node(num);
  return orderedKeys(num, Object.keys(n.metrics).filter((k) => !metricMeta(k).minor), which);
}

/** Whether the editor is open for this panel (on its sheet or full screen). */
export const ordering = (num) => ctx.S.metricOrder === num;
export function setOrdering(num) {
  ctx.S.metricOrder = num;
  ctx.repaintMetrics();
}

function row(which, k, i, all) {
  const name = metricMeta(k).label;
  return `<li class="ord-row" data-key="${esc(k)}"><span class="ord-pos">${i + 1}</span><span class="ord-n">${esc(name)}</span>
    <button type="button" class="icon-btn sm" data-mo-move="${which}" data-key="${esc(k)}" data-dir="-1" aria-label="${esc(t("dash.up", { name }))}"${i === 0 ? " disabled" : ""}>${ICON.up}</button><button type="button" class="icon-btn sm" data-mo-move="${which}" data-key="${esc(k)}" data-dir="1" aria-label="${esc(t("dash.down", { name }))}"${i === all.length - 1 ? " disabled" : ""}>${ICON.down}</button><span class="ord-grip" data-mo-drag title="${esc(t("dash.drag"))}" aria-hidden="true">${ICON.grip}</span></li>`;
}

/** The editor: the readings and the charts, each in its order. */
export function editorHTML(num) {
  const list = (which, title) => {
    const keys = shownKeys(num, which);
    return `<h3>${esc(t(title))}</h3><ol class="ord-list" data-mo-list="${which}" aria-label="${esc(t(title))}">${keys.map((k, i) => row(which, k, i, keys)).join("")}</ol>`;
  };
  return `<div class="mo" data-mo="${num}"><p class="hint">${esc(t("mo.hint"))}</p>${list("data", "mo.data")}${list("charts", "mo.charts")}
    <div class="mo-end"><button type="button" class="btn primary sm" data-mo-done>${esc(t("dash.done"))}</button></div></div>`;
}

/** The button of a chart that puts it on the card (pressed if it is the one there). */
export function cardButton(num, k) {
  const cur = cardMetric(num, shownKeys(num));
  return `<button type="button" class="chip-btn" data-card-chart="${esc(k)}" aria-pressed="${cur === k}" title="${esc(t("mo.cardHint"))}">${esc(t("mo.card"))}</button>`;
}

/** The "Reorder" button next to a panel's charts. */
export const orderButton = (num) => `<button type="button" class="btn ghost sm" data-mo-open="${num}">${esc(t("dash.order"))}</button>`;

/** Saves a change of the layout: this screen shows it at once and the server keeps it (every screen gets it back). */
export async function saveLayout(num, patch) {
  const { S } = ctx;
  if (!S.paneles) return;
  const p = ((S.paneles.paneles ||= {})[num] ||= { datos: [] });
  const lay = { ...(p.layout || {}), ...patch };
  for (const k of ["data", "charts", "card"]) if (!lay[k]?.length) delete lay[k];
  if (Object.keys(lay).length) p.layout = lay; else delete p.layout;
  ctx.repaintMetrics();
  const r = await ctx.orden({ orden: "panelLayout", num, ...patch });
  if (r && r.ok === false) ctx.toast(r.error);
}

export function moveMetric(num, which, key, dir) {
  const keys = shownKeys(num, which);
  const i = keys.indexOf(key), j = i + dir;
  if (i < 0 || j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  saveLayout(num, { [which]: keys });
  // The same button again, or the other arrow if it was the last step.
  const sel = (d) => `[data-mo-move="${which}"][data-key="${CSS.escape(key)}"][data-dir="${d}"]`;
  const b = $(sel(dir));
  if (b && !b.disabled) b.focus(); else $(sel(-dir))?.focus();
}

export function setCardChart(num, key) {
  saveLayout(num, { card: layoutOf(num).card === key ? null : key });
}

enableDrag({
  handle: "[data-mo-drag]",
  active: () => ctx.S?.metricOrder != null,
  onDrop(list) {
    const num = Number(list.closest("[data-mo]").dataset.mo);
    saveLayout(num, { [list.dataset.moList]: [...list.children].map((r) => r.dataset.key) });
  },
});
