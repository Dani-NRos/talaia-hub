// A panel full screen: big readings, its alarms and its charts, for a screen left beside the receiver or on a wall.
// It asks the browser for real full screen (no system bars) and keeps the screen on while it is open.
import { ctx } from "../ctx.js";
import { t } from "../i18n.js";
import { $, $$, esc, setHTML, fitSame, ICON } from "../ui.js";
import { chartSVG, stateSpans, stateSummary, stateSVG } from "../charts.js";
import { switchHTML } from "./node-parts.js";
import { panelState, metaLine, stateRuleText, trendShort, displayName } from "./dashboard.js";
import { metricMeta, sortMetrics, fmtValue, fmtNum, fmtLimit } from "@talaia/nucleo/metrics.js";
import { trendKey, estadoKey } from "@talaia/nucleo/motor.js";
import { HOUR, DAY, isNum, hhmm, ago } from "@talaia/nucleo/textos.js";

const RANGES = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
const rangeLabel = (r) => (r === "24h" ? "24 h" : t("sheet.days", { n: r === "7d" ? 7 : 30 }));
const view = () => $("#nodeview");
let wakeLock = null, chartsTimer = null;

export async function openFull(num) {
  const { S } = ctx;
  S.full = { num, range: S.full?.num === num ? S.full.range : "24h" };
  // Real full screen (without the system bars). Asked for before opening the view: whatever enters the top layer
  // last stays on top, and the other way round the page would cover the view.
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    try { await document.documentElement.requestFullscreen({ navigationUI: "hide" }); } catch { /* not allowed: it looks the same, with the bars */ }
  }
  if (!S.full) return; // closed while asking for full screen
  renderFull();
  if (!view().open) view().showModal();
  fitTiles();
  // The screen stays on while it is being looked at.
  try { if (!wakeLock && "wakeLock" in navigator) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch { /* no permission */ }
  drawFullCharts();
}

/** On closing the view (its "close" event). */
export function closeFull() {
  ctx.S.full = null;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

function tiles(num) {
  const { S, motor } = ctx;
  const n = motor.node(num), w = S.cfg.watched[num] || {};
  const keys = sortMetrics(Object.keys(n.metrics).filter((k) => !metricMeta(k).minor));
  if (!keys.length) return `<p class="hint">${esc(t(num < 0 ? "sheet.noDataPanel" : "card.noDataNode"))}</p>`;
  return keys.map((k) => {
    const m = metricMeta(k), r = (w.rules || {})[k] || {}, cur = n.metrics[k];
    const bad = (isNum(r.max) && cur.v > r.max) || (isNum(r.min) && cur.v < r.min) || S.active.has(trendKey(num, k)) || S.active.has(estadoKey(num, k));
    const lim = m.estados ? stateRuleText(k, r.estado) || (cur.desde ? t("card.since", { time: hhmm.format(new Date(cur.desde)) }) : "")
      : [isNum(r.min) ? t("card.min", { v: fmtLimit(k, r.min) }) : "", isNum(r.max) ? t("card.max", { v: fmtLimit(k, r.max) }) : "", r.trend ? trendShort(k, r.trend) : ""].filter(Boolean).join(" · ");
    const unit = k === "batteryLevel" && cur.v > 100 ? "" : m.unit;
    return `<div class="nv-tile${bad ? " bad" : ""}" data-sw-num="${num}"><span class="nv-l">${esc(m.label)}</span>${m.estados ? switchHTML(num, k) : ""}<span class="nv-v${m.estados ? " est" : ""}">${esc(fmtValue(k, cur.v))}${unit ? `<small>${esc(unit)}</small>` : ""}</span><span class="nv-s">${lim ? `<span class="nv-lim">${esc(lim)}</span>` : ""}<span>${esc(ago(cur.t))}</span></span></div>`;
  }).join("");
}

function alarms(num) {
  const { S, motor } = ctx;
  const al = [...S.active.values()].filter((a) => a.num === num).sort((a, b) => (a.acked - b.acked) || (b.since - a.since));
  if (!al.length) return "";
  return `<ul class="nv-al">${al.map((a) => `<li class="${a.acked ? "acked" : ""}"><div><strong>${esc(motor.alarmTitle(a))}</strong><span>${esc(motor.alarmDetail(a))}</span></div>${a.acked ? `<span class="al-ok">${esc(t("board.seenTag"))}</span>` : `<button class="btn on-dark sm" data-ack="${esc(a.key)}">${esc(t("board.ack"))}</button>`}</li>`).join("")}</ul>`;
}

export function renderFull() {
  const { S, motor } = ctx;
  if (!S.full) return;
  const { num, range } = S.full;
  const n = motor.node(num);
  const [st, stLabel] = panelState(num);
  const keys = sortMetrics(Object.keys(n.metrics).filter((k) => !metricMeta(k).minor));
  const seg = Object.keys(RANGES).map((r) => `<button type="button" data-full-range="${r}" aria-pressed="${r === range}">${esc(rangeLabel(r))}</button>`).join("");
  const charts = keys.map((k) => `<figure class="nv-chart" data-m="${k}"><figcaption><span>${esc(metricMeta(k).label)}</span><span class="mm" data-fmm="${k}"></span></figcaption><div class="chart-box"></div></figure>`).join("");
  view().setAttribute("aria-label", `${displayName(n)} · ${t("card.full")}`);
  view().innerHTML = `<div class="nv-h">
      <button class="icon-btn" data-close aria-label="${esc(t("full.close"))}">${ICON.close}</button>
      <span class="tag">${esc(n.short)}</span>
      <div class="nv-t"><h2>${esc(displayName(n))}</h2><p class="meta" data-full-meta>${esc(metaLine(n))}</p></div>
      <span class="st st-${st}" data-full-st>${esc(stLabel)}</span>
      <div class="seg" role="group" aria-label="${esc(t("full.period"))}">${seg}</div>
    </div>
    <div class="nv-b"><div data-full-al>${alarms(num)}</div><div class="nv-tiles" data-full-tiles>${tiles(num)}</div><div class="nv-charts">${charts}</div></div>`;
}

/** Big readings that fit in their tiles: all the figures at the same size, and the ON/OFF states at theirs. */
function fitTiles() {
  const tl = $("[data-full-tiles]");
  fitSame(tl, ".nv-v:not(.est)");
  fitSame(tl, ".nv-v.est", "--fit-est");
}
document.fonts?.ready.then(() => { if (ctx.S?.full) fitTiles(); });

/** Live readings without redrawing everything (the charts, at most every 2 s). num null: only what's on screen. */
export function refreshFull(num) {
  const { S, motor } = ctx;
  if (!S.full || (num != null && S.full.num !== num) || !view().open) return;
  const n = motor.node(S.full.num);
  const [st, stLabel] = panelState(S.full.num);
  const chip = $("[data-full-st]");
  if (chip) { chip.className = `st st-${st}`; chip.textContent = stLabel; }
  const meta = $("[data-full-meta]");
  if (meta) meta.textContent = metaLine(n);
  const tl = $("[data-full-tiles]");
  if (tl) { setHTML(tl, tiles(S.full.num)); fitTiles(); }
  const al = $("[data-full-al]");
  if (al) setHTML(al, alarms(S.full.num));
  if (num != null) { clearTimeout(chartsTimer); chartsTimer = setTimeout(drawFullCharts, 2000); }
}

export function setFullRange(range) {
  ctx.S.full.range = range;
  $$("#nodeview [data-full-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.fullRange === range)));
  drawFullCharts();
}

/** On rotating the phone or resizing: the charts again, at the new size. */
export function resizeFull() {
  if (!ctx.S.full) return;
  fitTiles();
  clearTimeout(chartsTimer);
  chartsTimer = setTimeout(drawFullCharts, 250);
}

export async function drawFullCharts() {
  const { S } = ctx;
  if (!S.full) return;
  const { num, range } = S.full;
  const to = Date.now(), from = to - RANGES[range];
  const rules = S.cfg.watched[num]?.rules || {};
  const figs = $$("#nodeview .nv-chart");
  // Height to fit the screen: two rows of charts without scrolling on a monitor or a tablet.
  const H = Math.round(Math.max(150, Math.min(300, (innerHeight - 330) / Math.max(1, Math.ceil(figs.length / (innerWidth >= 900 ? 2 : 1))))));
  for (const fig of figs) {
    const k = fig.dataset.m;
    const isState = !!metricMeta(k).estados;
    const ser = await S.store.series(num, k, isState ? from - 2 * HOUR : from, to); // a state: also the one before
    if (!S.full || S.full.num !== num) return;
    const box = $(".chart-box", fig);
    const W = Math.max(260, Math.floor(box.clientWidth || 600));
    if (isState) {
      const spans = stateSpans(ser, from, to, S.nodes.get(num)?.metrics?.[k]);
      box.innerHTML = stateSVG(spans, k, from, to, W, Math.min(H, 90));
      $(`[data-fmm="${k}"]`, fig).textContent = stateSummary(k, spans);
      continue;
    }
    box.innerHTML = chartSVG(ser, k, rules[k], from, to, W, H);
    const vals = ser.map((p) => p.v).filter((v) => !(k === "batteryLevel" && v > 100));
    $(`[data-fmm="${k}"]`, fig).textContent = vals.length ? t("sheet.minmax", { min: fmtNum(Math.min(...vals), metricMeta(k).dec), max: fmtNum(Math.max(...vals), metricMeta(k).dec) }) : "";
  }
}
