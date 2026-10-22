// Charts drawn as SVG: the full chart with axes (sheet and full screen), the sparkline of a card, and ON/OFF states
// as a time bar instead of a line.
import { t, locale } from "./i18n.js";
import { esc } from "./ui.js";
import { metricMeta, fmtNum, fmtLimit } from "@vigia/nucleo/metrics.js";
import { MIN, HOUR, DAY, isNum, hhmm, dShort, dur, stamp } from "@vigia/nucleo/textos.js";

const WEEKDAY = new Map();
const weekday = (d) => {
  if (!WEEKDAY.has(locale())) WEEKDAY.set(locale(), new Intl.DateTimeFormat(locale(), { weekday: "short" }));
  return WEEKDAY.get(locale()).format(d);
};

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}
/** A gap in the readings longer than this breaks the line (three times the usual interval, at least 20 min). */
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
/** Time axis: grid lines and labels every 3 or 6 hours, each day or each week, depending on the span. */
function timeAxis(from, to, W, x, top, bottom, H) {
  let g = "";
  const span = to - from;
  const xs = span <= 2 * DAY ? (W > 700 ? 3 * HOUR : 6 * HOUR) : span <= 8 * DAY ? DAY : 7 * DAY;
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  if (xs >= DAY) first.setHours(0);
  else first.setHours(Math.ceil(first.getHours() / 6) * 6);
  for (let ts = first.getTime(); ts <= to; ts += xs) {
    if (ts < from) continue;
    const xx = x(ts).toFixed(1);
    const lab = xs === 7 * DAY ? dShort.format(new Date(ts)) : xs === DAY ? weekday(new Date(ts)) : hhmm.format(new Date(ts));
    g += `<line class="grid v" x1="${xx}" x2="${xx}" y1="${top}" y2="${bottom}"/><text class="tick" x="${xx}" y="${H - 6}" text-anchor="middle">${lab}</text>`;
  }
  return g;
}

/** Full chart with axes, in real pixels. */
export function chartSVG(series, metric, rule, from, to, W, H = 132) {
  const pl = 42, pr = 12, pt = 10, pb = 22;
  const ser = series.filter((p) => !(metric === "batteryLevel" && p.v > 100));
  const dom = yDomain(ser, metric, rule);
  if (!dom) return `<p class="empty-chart">${esc(t("chart.empty"))}</p>`;
  const [lo, hi] = dom;
  const x = (ts) => pl + ((ts - from) / (to - from)) * (W - pl - pr);
  const y = (v) => pt + ((hi - v) / (hi - lo)) * (H - pt - pb);
  const m = metricMeta(metric);
  let g = "";
  const st = niceStep(hi - lo, H > 180 ? 5 : 3);
  for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) {
    const yy = y(v).toFixed(1);
    g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}"/><text class="tick" x="${pl - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle">${fmtNum(v, st < 1 ? 1 : 0)}</text>`;
  }
  g += timeAxis(from, to, W, x, pt, H - pb, H);
  let thr = "";
  for (const [key, val] of [["card.max", rule?.max], ["card.min", rule?.min]]) {
    if (!isNum(val)) continue;
    const yy = y(val).toFixed(1);
    const above = +yy - pt > 14;
    thr += `<line class="thr" x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}"/><text class="thr-l" x="${pl + 4}" y="${(above ? +yy - 4 : +yy + 12).toFixed(1)}">${esc(t(key, { v: fmtLimit(metric, val) }))}</text>`;
  }
  let area = "", line = "";
  for (const s of segmentsOf(ser, gapOf(ser))) {
    const pts = s.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
    line += `<polyline class="ln" points="${pts.join(" ")}"/>`;
    if (s.length > 1) area += `<path class="ar" d="M${pts[0]} L${pts.join(" L")} L${x(s[s.length - 1].t).toFixed(1)},${H - pb} L${x(s[0].t).toFixed(1)},${H - pb} Z"/>`;
  }
  const last = ser[ser.length - 1];
  const out = (isNum(rule?.max) && last.v > rule.max) || (isNum(rule?.min) && last.v < rule.min);
  const dot = `<circle class="end-ring${out ? " bad" : ""}" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="6"/><circle class="end${out ? " bad" : ""}" cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="3.2"/>`;
  return `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.label)}">${g}${area}${line}${thr}${dot}</svg>`;
}

/* ── ON/OFF states: a time bar instead of a line ── */

/**
 * Spans of a state between from and to: [{ v, a, b }]. Each reading holds until the next; the last, until now.
 * cur: the current value with its "since" (a state that doesn't change has no recent readings).
 */
export function stateSpans(series, from, to, cur) {
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
/** "On in total: 3 h 20 min" in that period. */
export function stateSummary(metric, spans) {
  const on = spans.filter((x) => x.v).reduce((s, x) => s + x.b - x.a, 0);
  return spans.length ? t("chart.stateTotal", { state: metricMeta(metric).estados[0], d: on && on < MIN ? t("chart.underMin") : dur(on) }) : "";
}
export function stateSVG(spans, metric, from, to, W, H = 64) {
  if (!spans.length) return `<p class="empty-chart">${esc(t("chart.empty"))}</p>`;
  const m = metricMeta(metric);
  const pl = 8, pr = 12, pt = 6, pb = 22;
  const x = (ts) => pl + ((ts - from) / (to - from)) * (W - pl - pr);
  const g = timeAxis(from, to, W, x, pt, H - pb, H);
  const bars = spans.map((s) => `<rect class="eb ${s.v ? "on" : "off"}" x="${x(s.a).toFixed(1)}" y="${pt}" width="${Math.max(1, x(s.b) - x(s.a)).toFixed(1)}" height="${H - pt - pb}"><title>${esc(m.estados[s.v ? 0 : 1])}: ${esc(stamp(s.a))} – ${esc(stamp(s.b))}</title></rect>`).join("");
  return `<svg class="chart-svg est-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.label)}">${bars}${g}</svg>
    <p class="est-ley"><span class="eb-k on"></span>${esc(m.estados[0])} <span class="eb-k off"></span>${esc(m.estados[1])}</p>`;
}

/* ── sparklines of the cards: stretched to the width; the end dot goes in HTML ── */

const noHistory = () => `<div class="spark spark-empty"><span>${esc(t("card.noHistory"))}</span></div>`;

export function sparkStateHTML(series, metric, cur) {
  const W = 300, H = 46, now = Date.now(), from = now - DAY;
  const spans = stateSpans(series, from, now, cur);
  if (!spans.length) return noHistory();
  const x = (ts) => ((ts - from) / (now - from)) * W;
  return `<div class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${spans.map((s) => `<rect class="eb ${s.v ? "on" : "off"}" x="${x(s.a).toFixed(1)}" y="8" width="${Math.max(0.5, x(s.b) - x(s.a)).toFixed(1)}" height="${H - 16}"/>`).join("")}</svg></div>`;
}

export function sparkHTML(series, metric, rule) {
  const W = 300, H = 46;
  const now = Date.now(), from = now - DAY;
  const ser = series.filter((p) => p.t >= from && !(metric === "batteryLevel" && p.v > 100));
  const dom = yDomain(ser, metric, rule);
  if (!dom || ser.length < 2 || ser[ser.length - 1].t - ser[0].t < 45 * MIN) return noHistory();
  const [lo, hi] = dom;
  const x = (ts) => ((ts - from) / (now - from)) * W;
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
