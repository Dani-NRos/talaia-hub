// Dashboard: the alarm notice (or "all clear") and the cards of the watched panels, which can be collapsed,
// reordered (arrows or dragging) and opened (sheet or full screen).
import { ctx } from "../ctx.js";
import { t } from "../i18n.js";
import { $, esc, setHTML, LS, ICON } from "../ui.js";
import { requestBlock, positionBlock, switchHTML } from "./node-parts.js";
import { metricMeta, sortMetrics, fmtValue, fmtNum, fmtLimit } from "@vigia/nucleo/metrics.js";
import { seriesKey, trendKey, estadoKey } from "@vigia/nucleo/motor.js";
import { MIN, hhmm, ago, stamp, dur, isNum, hoursText } from "@vigia/nucleo/textos.js";

/** The name shown: the one given here, or Meshtastic's. */
export const displayName = (n) => n?.alias || n?.long || "";

/* ── state of a panel ── */

/** [class, label] of a watched node or panel: alarm, out of place, disconnected, no signal, no data or normal. */
export function panelState(num) {
  const { S } = ctx;
  const al = [...S.active.values()].filter((a) => a.num === num);
  if (al.some((a) => a.kind === "moved")) return ["crit", t("state.moved")];
  if (al.some((a) => ["high", "low", "trend", "estado"].includes(a.kind))) return ["crit", t("state.alarm")];
  const n = S.nodes.get(num);
  if (al.some((a) => a.kind === "conexion") || n?.conectado === false) return ["off", t("state.disconnected")]; // the device says so
  if (al.some((a) => a.kind === "offline")) return ["off", t(num < 0 ? "state.noData" : "state.noSignal")];
  if (!n || !n.lastHeard) return ["none", t("state.noData")];
  return ["ok", t("state.normal")];
}

/** When it was last heard (for a panel without a node, when its last MQTT datum arrived). */
export function seenText(n) {
  if (n.num < 0) {
    return [n.conectado === false ? t("seen.disconnected", { ago: ago(n.conectadoT) }) : "", n.lastHeard ? t("seen.lastData", { ago: ago(n.lastHeard) }) : t("seen.noDataYet")].filter(Boolean).join(" · ");
  }
  return n.lastHeard ? t("seen.heard", { ago: ago(n.lastHeard) }) : t("seen.never");
}

export function metaLine(n) {
  const bits = [seenText(n)];
  if (isNum(n.hops)) bits.push(n.hops === 0 ? t("seen.direct") : t(n.hops === 1 ? "seen.hop" : "seen.hops", { n: n.hops }));
  if (isNum(n.snr) && n.snr !== 0) bits.push(`SNR ${fmtNum(n.snr, 1)} dB`);
  return bits.join(" · ");
}

/** The alarm set on a state, as shown on the card: "warns: Open +10 min". */
export const stateRuleText = (k, r) => (r ? t("rule.state", { state: metricMeta(k).estados[r.cuando ? 0 : 1], extra: r.min ? ` +${dur(r.min * MIN)}` : "" }) : "");
/** A fast-change rule, short: "↓3/3 h". */
export const trendShort = (k, rule) => `${rule.dir === "down" ? "↓" : "↑"}${fmtLimit(k, rule.delta)}/${hoursText(rule.hours)}`;

/* ── the alarm notice ── */

/** Alarm notice (or all clear), the server's connection problems and what is paused: for the dashboard and Alarms. */
export function boardHTML() {
  const { S, motor } = ctx;
  const list = [...S.active.values()].sort((a, b) => (a.acked - b.acked) || (b.since - a.since));
  const watchedN = Object.keys(S.cfg.watched).length;
  let html = "";
  if (list.length) {
    const open = list.filter((a) => !a.acked).length;
    const title = open ? t(open === 1 ? "board.open1" : "board.open", { n: open }) : t(list.length === 1 ? "board.seen1" : "board.seen", { n: list.length });
    html += `<div class="board ${open ? "crit" : "seen"}"><div class="board-h"><h2>${esc(title)}</h2>${open > 1 ? `<button class="btn on-dark" data-ackall>${esc(t("board.ackAll"))}</button>` : ""}</div><ul class="al-list">`;
    for (const a of list) {
      html += `<li class="al${a.acked ? " acked" : ""}" data-kind="${a.kind}"><div class="al-main"${a.num != null ? ` data-open="${a.num}"` : ""}><strong>${esc(motor.alarmTitle(a))}</strong><span>${esc(motor.alarmDetail(a))}${a.late ? ` ${esc(t("board.late"))}` : ""}</span></div><div class="al-side"><span class="al-t">${esc(t("board.since", { stamp: stamp(a.since) }))}</span>${a.acked ? `<span class="al-ok">${esc(t("board.seenTag"))}</span>` : `<button class="btn on-dark" data-ack="${esc(a.key)}">${esc(t("board.ack"))}</button>`}</div></li>`;
    }
    html += `</ul></div>`;
  } else {
    let lastT = 0;
    for (const num of Object.keys(S.cfg.watched)) lastT = Math.max(lastT, S.nodes.get(Number(num))?.lastHeard || 0);
    const parts = watchedN
      ? [t(watchedN === 1 ? "board.watched1" : "board.watched", { n: watchedN }), lastT ? t("board.lastData", { ago: ago(lastT) }) : t("board.noDataYet")]
      : [t("board.nothingWatched")];
    html += `<div class="board calm"><span class="calm-dot"></span><div><h2>${esc(t(watchedN ? "board.allClear" : "board.chooseWhat"))}</h2><p>${esc(parts.join(" · "))}</p></div></div>`;
  }
  const trouble = troubleHTML();
  html += trouble;
  if (!trouble && S.link.state !== "ready" && !S.active.has("link")) {
    html += `<div class="notice"><p>${esc(t(S.link.state === "idle" ? "board.noReceiver" : "board.waitingReceiver"))}</p></div>`;
  }
  return html;
}

/** When the screen can't reach the server, or the server can't reach its receiver. */
function troubleHTML() {
  const { S } = ctx;
  if (!S.servidorOk) return `<div class="trouble" role="status"><h2>${esc(t("trouble.noServer"))}</h2><p>${esc(t("trouble.noServerText"))}</p><ol><li>${esc(t("trouble.noServerStep1"))}</li><li>${esc(t("trouble.noServerStep2"))}</li></ol></div>`;
  const tr = S.trouble;
  if (!tr || S.link.state === "ready" || tr.count < 2) return "";
  return `<div class="trouble" role="status"><h2>${esc(t("trouble.receiver"))}</h2><p>${esc(tr.detail || tr.kind)}. ${esc(tr.consejo || "")} <span class="tr-n">${esc(t("trouble.tries", { n: tr.count }))}</span></p><div class="btns"><button class="btn primary" data-retry>${esc(t("trouble.retry"))}</button><button class="btn ghost" data-diag>${esc(t("trouble.diag"))}</button></div></div>`;
}

/* ── cards ── */

// Collapsed cards and chosen order: saved on this device (apart from the alarms, which are the server's).
export function saveCardUi() { LS.set("vigia.cards", ctx.S.ui); }

/** Watched panels in the chosen order; those without a place yet go last, by name. */
export function watchedOrder() {
  const { S } = ctx;
  const pos = new Map(S.ui.order.map((n, i) => [n, i]));
  const at = (n) => (pos.has(n) ? pos.get(n) : Infinity);
  return Object.keys(S.cfg.watched).map(Number)
    .sort((a, b) => at(a) - at(b) || displayName(S.nodes.get(a)).localeCompare(displayName(S.nodes.get(b))));
}

/** Battery for the collapsed card: "88 %", "USB" or nothing. */
function batteryHTML(num) {
  const { S } = ctx;
  const b = S.nodes.get(num)?.metrics?.batteryLevel;
  if (!b || !isNum(b.v)) return "";
  const usb = b.v > 100;
  const r = S.cfg.watched[num]?.rules?.batteryLevel || {};
  const low = !usb && ((isNum(r.min) && b.v < r.min) || b.v <= 15);
  const lvl = usb ? 1 : Math.max(0, Math.min(1, b.v / 100));
  const icon = `<svg viewBox="0 0 26 14" aria-hidden="true"><rect x=".75" y=".75" width="21.5" height="12.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="23" y="4.5" width="2.2" height="5" rx="1" fill="currentColor"/><rect x="2.75" y="2.75" width="${(17.5 * lvl).toFixed(1)}" height="8.5" rx="1" fill="currentColor"/></svg>`;
  return `<span class="bat${low ? " low" : ""}" title="${esc(t("card.battery"))}">${icon}${usb ? "USB" : `${fmtNum(b.v, 0)} %`}</span>`;
}

function cardHead(num, n, st, stLabel, min) {
  const name = displayName(n);
  const meta = min ? seenText(n) : metaLine(n);
  return `<header class="card-h"><span class="tag">${esc(n.short)}</span><h3><button type="button" class="name-btn" data-open="${num}" aria-label="${esc(t("card.open", { name, state: stLabel }))}">${esc(name)}</button></h3><p class="meta">${esc(meta)}${min ? batteryHTML(num) : ""}</p><span class="st st-${st}">${esc(stLabel)}</span><button type="button" class="icon-btn tg" data-card-toggle="${num}" aria-expanded="${!min}" aria-label="${esc(t(min ? "card.expand" : "card.collapse", { name }))}">${ICON.chevron}</button></header>`;
}

function readingHTML(num, n, k, rules) {
  const { S } = ctx;
  const m = metricMeta(k), r = rules[k] || {};
  const v = n.metrics[k].v;
  if (m.estados) { // an ON/OFF state: its name, and its alarm or since when it is like that
    const bad = S.active.has(estadoKey(num, k));
    const lim = stateRuleText(k, r.estado) || (n.metrics[k].desde ? t("card.since", { time: hhmm.format(new Date(n.metrics[k].desde)) }) : "");
    return `<div class="rd${bad ? " bad" : ""}"><span class="rd-l">${esc(m.label)}</span><span class="rd-v est">${esc(fmtValue(k, v))}</span>${switchHTML(num, k)}<span class="rd-lim">${esc(lim) || "&nbsp;"}</span></div>`;
  }
  const bad = (isNum(r.max) && v > r.max) || (isNum(r.min) && v < r.min) || S.active.has(trendKey(num, k));
  const lim = [isNum(r.min) ? t("card.min", { v: fmtLimit(k, r.min) }) : "", isNum(r.max) ? t("card.max", { v: fmtLimit(k, r.max) }) : "", r.trend ? trendShort(k, r.trend) : ""].filter(Boolean).join(" · ");
  const unit = k === "batteryLevel" && v > 100 ? "" : m.unit;
  return `<div class="rd${bad ? " bad" : ""}"><span class="rd-l">${esc(m.label)}</span><span class="rd-v">${fmtValue(k, v)}${unit ? `<small>${esc(unit)}</small>` : ""}</span><span class="rd-lim">${esc(lim) || "&nbsp;"}</span></div>`;
}

function cardHTML(num) {
  const { S } = ctx;
  const n = ctx.motor.node(num);
  const rules = S.cfg.watched[num]?.rules || {};
  const [st, stLabel] = panelState(num);
  if (S.ui.collapsed[num]) return `<article class="card min st-${st}" data-open="${num}">${cardHead(num, n, st, stLabel, true)}</article>`;
  const keys = sortMetrics(Object.keys(n.metrics).filter((k) => !metricMeta(k).minor));
  const readings = keys.map((k) => readingHTML(num, n, k, rules)).join("");
  const sparkMetric = ["temperature", "batteryLevel", "relativeHumidity"].find((k) => n.metrics[k]) || keys.find((k) => !metricMeta(k).estados) || keys[0];
  const fullBtn = `<button type="button" class="mini full-btn" data-full="${num}" title="${esc(t("card.fullHint"))}">${ICON.expand}${esc(t("card.full"))}</button>`;
  const series = S.recent.get(seriesKey(num, sparkMetric)) || [];
  const spark = sparkMetric
    ? `<div class="spark-wrap"><div class="spark-top"><span class="spark-cap">${esc(t("card.spark", { label: metricMeta(sparkMetric).label }))}</span>${fullBtn}</div>${metricMeta(sparkMetric).estados ? ctx.sparkStateHTML(series, sparkMetric, n.metrics[sparkMetric]) : ctx.sparkHTML(series, sparkMetric, rules[sparkMetric])}</div>`
    : `<div class="spark-top">${fullBtn}</div>`;
  return `<article class="card st-${st}" data-open="${num}">
      ${cardHead(num, n, st, stLabel, false)}
      ${readings ? `<div class="rds">${readings}</div>` : `<p class="no-rd">${esc(t(num < 0 ? "card.noDataPanel" : "card.noDataNode"))}</p>`}
      ${n.pos ? `<div class="pos" data-pos-box="${num}">${positionBlock(num)}</div>` : ""}
      ${spark}
      ${num < 0 ? "" : `<div class="ask" data-ask-box="${num}">${requestBlock(num)}</div>`}
    </article>`;
}

let drag = null; // a card being dragged while ordering

export function renderCards() {
  const { S } = ctx;
  const el = $("#cards");
  const nums = watchedOrder();
  $("#watchCount").textContent = nums.length ? String(nums.length) : "";
  $("#h-watch").textContent = t("dash.panels");
  const allMin = nums.length > 0 && nums.every((n) => S.ui.collapsed[n]);
  setHTML($("#cardTools"), S.ordering
    ? `<button type="button" class="btn primary sm" data-order-done>${esc(t("dash.done"))}</button>`
    : `${nums.length ? `<button type="button" class="btn ghost sm" data-cards-all>${esc(t(allMin ? "dash.expandAll" : "dash.collapseAll"))}</button>` : ""}${nums.length > 1 ? `<button type="button" class="btn ghost sm" data-order>${esc(t("dash.order"))}</button>` : ""}<button type="button" class="btn ghost sm" data-panel-nuevo>${ICON.plus}${esc(t("dash.addPanel"))}</button>`);
  $("#cardTools").hidden = false;
  el.classList.toggle("ordering", S.ordering);
  if (!nums.length) {
    setHTML(el, `<div class="empty"><p><strong>${esc(t("dash.emptyTitle"))}</strong> ${esc(t("dash.emptyText"))}</p></div>`);
    return;
  }
  if (S.ordering) {
    if (drag) return; // not repainted while dragging
    setHTML(el, `<ol class="ord-list" aria-label="${esc(t("dash.orderList"))}">${nums.map((num, i) => {
      const n = ctx.motor.node(num), name = displayName(n);
      return `<li class="ord-row" data-num="${num}"><span class="ord-pos">${i + 1}</span><span class="tag sm">${esc(n.short)}</span><span class="ord-n">${esc(name)}</span>
        <button type="button" class="icon-btn sm" data-move="${num}" data-dir="-1" aria-label="${esc(t("dash.up", { name }))}"${i === 0 ? " disabled" : ""}>${ICON.up}</button><button type="button" class="icon-btn sm" data-move="${num}" data-dir="1" aria-label="${esc(t("dash.down", { name }))}"${i === nums.length - 1 ? " disabled" : ""}>${ICON.down}</button><span class="ord-grip" data-drag title="${esc(t("dash.drag"))}" aria-hidden="true">${ICON.grip}</span></li>`;
    }).join("")}</ol><p class="hint">${esc(t("dash.orderHint"))}</p>`);
    return;
  }
  setHTML(el, nums.map(cardHTML).join(""));
}

export function toggleCard(num) {
  const { S } = ctx;
  if (S.ui.collapsed[num]) delete S.ui.collapsed[num]; else S.ui.collapsed[num] = true;
  saveCardUi();
  renderCards();
  $(`[data-card-toggle="${num}"]`)?.focus();
}
export function toggleAllCards() {
  const { S } = ctx;
  const nums = watchedOrder();
  const allMin = nums.every((n) => S.ui.collapsed[n]);
  S.ui.collapsed = allMin ? {} : Object.fromEntries(nums.map((n) => [n, true]));
  saveCardUi();
  renderCards();
}

/* ── ordering: arrows and dragging (mouse and finger) ── */
function setOrder(nums) {
  ctx.S.ui.order = nums;
  saveCardUi();
}
export function moveCard(num, dir) {
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
  if (!h || !ctx.S?.ordering) return;
  const row = h.closest(".ord-row");
  ev.preventDefault();
  h.setPointerCapture(ev.pointerId);
  drag = { row, list: row.parentElement, y0: ev.clientY };
  row.classList.add("dragging");
});
document.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const { row, list } = drag;
  let dy = ev.clientY - drag.y0;
  // Past half of the neighbouring row, they swap places.
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
