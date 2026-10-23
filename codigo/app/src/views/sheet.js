// A node's (or panel's) sheet: asking for data, route through the mesh, location and fence, its alarms (limits,
// no signal, ON/OFF states, fast change), history charts and, for watched panels, their configuration (name,
// MQTT data and, on the receiver, what goes out to the mesh: panel-config.js).
import { ctx } from "../ctx.js";
import { t } from "../i18n.js";
import { $, $$, esc, parseNum, ICON } from "../ui.js";
import { chartSVG, stateSpans, stateSummary, stateSVG } from "../charts.js";
import { requestBlock, requestStatus, positionBlock, switchHTML } from "./node-parts.js";
import { metaLine, displayName, saveCardUi } from "./dashboard.js";
import { panelSections, forgetDraftsExcept, hasDrafts } from "./panel-config.js";
import { metricMeta, sortMetrics, fmtValue, fmtWithUnit, fmtNum, fmtLimit } from "@vigia/nucleo/metrics.js";
import { askKey, hexId, trendKey, estadoKey } from "@vigia/nucleo/motor.js";
import { relays, snrQuality, loraSf, weakest, UNKNOWN_NODE, PRESET_NAME } from "@vigia/nucleo/route.js";
import { trendDefault, parseTrendRule } from "@vigia/nucleo/trend.js";
import { HOUR, DAY, isNum, ago, stamp, trendDec, fmtTrend, trendVerb, hoursText, lastWindow } from "@vigia/nucleo/textos.js";
import { TIPOS_PANEL } from "@vigia/nucleo/mqtt-datos.js";

const sheet = () => $("#detail");
export const isSheetOpen = () => sheet().open;
function showErr(el, msg) { el.textContent = msg; el.hidden = false; }

/* ── route through the mesh (traceroute) ── */

export function legHops(leg) {
  const k = relays(leg).length;
  return k === 0 ? t("route.direct") : t(k === 1 ? "route.via1" : "route.via", { n: k });
}
const fmtSnr = (s) => `${fmtNum(s, Number.isInteger(s) ? 0 : Number.isInteger(s * 2) ? 1 : 2)} dB`;

function legHTML(title, leg, sf) {
  const { S, motor } = ctx;
  let h = `<div class="rt"><h4>${esc(title)} <span>${esc(legHops(leg))}</span></h4><ol class="rt-l">`;
  leg.nodes.forEach((num, i) => {
    if (i > 0) {
      const s = leg.snr[i - 1], q = snrQuality(s, sf);
      h += `<li class="rt-s${q ? ` q-${q}` : ""}" aria-label="${esc(s == null ? t("route.hopUnknown") : t("route.hop", { snr: fmtSnr(s) }))}"><span>${s == null ? "SNR ?" : fmtSnr(s)}</span></li>`;
    }
    const n = S.nodes.get(num);
    const unk = num === UNKNOWN_NODE;
    const tag = unk ? "?" : n?.short || "";
    const name = esc(motor.hopName(num));
    const canOpen = !unk && n && num !== S.detail?.num;
    h += `<li class="rt-n${unk ? " unk" : ""}">${tag ? `<span class="tag sm">${esc(tag)}</span>` : ""}${canOpen ? `<button type="button" class="link-btn" data-open="${num}">${name}</button>` : `<span>${name}</span>`}</li>`;
  });
  return h + `</ol></div>`;
}

function routeBlock(num) {
  const { S, motor } = ctx;
  if (num === S.myNode) return `<h3>${esc(t("route.title"))}</h3><p class="hint">${esc(t("route.mine"))}</p>`;
  const waiting = S.req.get(askKey(num, "route"))?.state === "wait";
  const tr = S.traces[num];
  const sf = loraSf(S.lora);
  let h = `<div class="blk-h"><h3>${esc(t("route.title"))}</h3><button type="button" class="mini" data-ask="route" data-num="${num}"${!motor.canAsk() || waiting ? " disabled" : ""}>${esc(t(waiting ? "route.tracing" : tr ? "route.again" : "route.trace"))}</button></div>`;
  h += `<p class="ask-st" data-route-st="${num}">${requestStatus(num, ["route"])}</p>`;
  if (tr) {
    h += `<p class="meta">${esc(t("route.traced", { ago: ago(tr.t), stamp: stamp(tr.t), s: Math.max(1, Math.round(tr.ms / 1000)) }))}</p>`;
    h += `<div class="rt-cols">${legHTML(t("route.out"), tr.fwd, sf)}${tr.back ? legHTML(t("route.back"), tr.back, sf) : `<div class="rt"><h4>${esc(t("route.back"))}</h4><p class="hint">${esc(t("route.noBack"))}</p></div>`}</div>`;
    const w = weakest(tr);
    if (w && snrQuality(w.snr, sf) !== "ok") h += `<p class="hint">${esc(t("route.weakest", { from: motor.hopName(w.from), to: motor.hopName(w.to), snr: fmtSnr(w.snr) }))}</p>`;
    const located = new Set([...tr.fwd.nodes, ...(tr.back?.nodes || [])].filter((x) => S.nodes.get(x)?.pos));
    if (located.size >= 2) h += `<div class="pos-row"><button type="button" class="mini" data-route-map="${num}">${esc(t("route.onMap"))}</button></div>`;
  }
  const preset = S.lora && (S.lora.usePreset !== false ? PRESET_NAME[S.lora.modemPreset ?? 0] : `SF${S.lora.spreadFactor}`);
  const q = (cls, key) => `<b class="q-${cls}">${esc(t(key))}</b>`;
  h += `<p class="hint">${t("route.hint", { ok: q("ok", "route.q.ok"), warn: q("warn", "route.q.warn"), bad: q("bad", "route.q.bad"), preset: preset ? esc(t("route.preset", { name: preset })) : "" })}</p>`;
  return h;
}

/** Requests and route of a node, redrawn (after a change in its requests). */
export function refreshRequests(num) {
  for (const el of $$(`[data-ask-box="${num}"]`)) el.innerHTML = requestBlock(num, el.dataset.sheet === "1");
  for (const el of $$(`[data-route-box="${num}"]`)) el.innerHTML = routeBlock(num);
}
/** Only the status lines (every second while waiting: redrawing buttons would steal taps). */
export function patchRequestStatus(num) {
  for (const el of $$(`[data-ask-st="${num}"]`)) el.innerHTML = requestStatus(num);
  for (const el of $$(`[data-pos-st="${num}"]`)) el.innerHTML = requestStatus(num, ["pos"]);
  for (const el of $$(`[data-route-st="${num}"]`)) el.innerHTML = requestStatus(num, ["route"]);
}

/* ── fast change ── */

/** "it has dropped 1.2 hPa in the last 3 hours" with the current data. */
export function trendNowText(num, k, rule) {
  const r = ctx.motor.trendNow(num, k, rule);
  if (!r) return t("trend.now.noData", { h: hoursText(rule.hours / 2) });
  if (r.change <= 0) return t(rule.dir === "down" ? "trend.now.noneDown" : "trend.now.noneUp", { window: lastWindow(rule.hours) });
  return t(rule.dir === "down" ? "trend.now.down" : "trend.now.up", { change: fmtTrend(k, r.change, trendDec(k, r.change)), window: lastWindow(rule.hours) });
}

function trendMetrics(num) {
  const { S } = ctx;
  const n = S.nodes.get(num), w = S.cfg.watched[num];
  return sortMetrics(new Set([...Object.keys(n?.metrics || {}), ...Object.keys(w?.rules || {})])).filter((k) => !metricMeta(k).minor && !metricMeta(k).estados);
}

/** sel: the metric left chosen in the form (the one just saved). */
function trendBlock(num, sel = null) {
  const w = ctx.S.cfg.watched[num];
  if (!w) return "";
  const ks = trendMetrics(num);
  let h = `<h4>${esc(t("trend.title"))}</h4><p class="hint">${esc(t("trend.hint"))}</p>`;
  const set = ks.filter((k) => w.rules?.[k]?.trend);
  if (set.length) {
    h += `<ul class="tr-list">${set.map((k) => {
      const rule = w.rules[k].trend, on = ctx.S.active.has(trendKey(num, k)), label = metricMeta(k).label;
      return `<li${on ? ` class="bad"` : ""}><span class="tr-t"><span><b>${esc(label)}</b>: ${esc(t("trend.ruleText", { verb: trendVerb(rule.dir), limit: fmtLimit(k, rule.delta, true), hours: hoursText(rule.hours) }))}</span><small data-trend-now="${k}">${esc(trendNowText(num, k, rule))}</small></span><button type="button" class="mini" data-trend-del="${k}" aria-label="${esc(t("trend.removeAria", { label }))}">${esc(t("trend.remove"))}</button></li>`;
    }).join("")}</ul>`;
  }
  if (!ks.length) return h + `<p class="hint">${esc(t(num < 0 ? "trend.noMetricsPanel" : "trend.noMetricsNode"))}</p>`;
  const pick = (sel && ks.includes(sel) && sel) || ks.find((k) => k === "barometricPressure" && !w.rules?.[k]?.trend) || ks.find((k) => !w.rules?.[k]?.trend) || ks[0];
  const d = w.rules?.[pick]?.trend || trendDefault(metricMeta(pick).tipo || pick); // an MQTT datum, like those of its type
  h += `<div class="tr-form"><span>${esc(t("trend.warnIf"))}</span>
    <select id="tr-metric" class="inp sel" aria-label="${esc(t("trend.metric"))}">${ks.map((k) => `<option value="${k}"${k === pick ? " selected" : ""}>${esc(metricMeta(k).label)}</option>`).join("")}</select>
    <select id="tr-dir" class="inp sel" aria-label="${esc(t("trend.dir"))}"><option value="down"${d.dir === "down" ? " selected" : ""}>${esc(t("trend.down"))}</option><option value="up"${d.dir === "up" ? " selected" : ""}>${esc(t("trend.up"))}</option></select>
    <span class="inp-u"><input id="tr-delta" class="inp" inputmode="decimal" autocomplete="off" value="${fmtLimit(pick, d.delta)}" aria-label="${esc(t("trend.howMuch"))}"><span id="tr-unit">${esc(metricMeta(pick).unit)}</span></span>
    <span>${esc(t("trend.orMoreIn"))}</span>
    <span class="inp-u"><input id="tr-hours" class="inp" inputmode="decimal" autocomplete="off" value="${fmtNum(d.hours, d.hours % 1 ? 1 : 0)}" aria-label="${esc(t("trend.hours"))}"><span>h</span></span></div>
    <p class="form-err" id="trErr" role="alert" hidden></p>
    <div class="btns"><button type="button" class="btn primary sm" data-trend-add="${num}">${esc(t(w.rules?.[pick]?.trend ? "trend.save" : "trend.add"))}</button></div>`;
  return h;
}
function refreshTrend(num, sel = null) {
  const box = $("#trendBox");
  if (box && ctx.S.detail?.num === num) box.innerHTML = trendBlock(num, sel);
}
/** On changing the metric in the form: its values (the saved ones or the recommended ones). */
export function trendFormFill() {
  const num = ctx.S.detail?.num, k = $("#tr-metric")?.value;
  if (!k) return;
  const cur = ctx.S.cfg.watched[num]?.rules?.[k]?.trend;
  const d = cur || trendDefault(metricMeta(k).tipo || k);
  $("#tr-dir").value = d.dir;
  $("#tr-delta").value = fmtLimit(k, d.delta);
  $("#tr-hours").value = fmtNum(d.hours, d.hours % 1 ? 1 : 0);
  $("#tr-unit").textContent = metricMeta(k).unit;
  $("[data-trend-add]").textContent = t(cur ? "trend.save" : "trend.add");
  $("#trErr").hidden = true;
}
export async function addTrend(num) {
  if (!ctx.S.cfg.watched[num]) return;
  const k = $("#tr-metric").value, err = $("#trErr");
  const delta = parseNum($("#tr-delta").value), hours = parseNum($("#tr-hours").value);
  const { rule, error } = parseTrendRule($("#tr-dir").value, delta ?? NaN, hours ?? NaN);
  if (error) return showErr(err, error);
  const res = await ctx.orden({ orden: "tendencia", num, metrica: k, regla: rule });
  if (res.error) return showErr(err, res.error);
  refreshTrend(num, k);
  ctx.render();
  ctx.toast(res.toast);
}
export async function removeTrend(num, k) {
  const res = await ctx.orden({ orden: "quitarTendencia", num, metrica: k });
  if (!res.ok) return;
  refreshTrend(num);
  ctx.render();
  ctx.toast(res.toast);
}

/* ── alarms of ON/OFF states: when to warn and, if wanted, for how long ── */

function stateAlarmsHTML(num, keys) {
  const { S } = ctx;
  const w = S.cfg.watched[num], n = S.nodes.get(num);
  const ks = keys.filter((k) => metricMeta(k).estados);
  if (!ks.length) return "";
  return `<div class="est-al">${ks.map((k) => {
    const m = metricMeta(k), r = w?.rules?.[k]?.estado, cur = n?.metrics?.[k];
    const opt = (v) => `<option value="${v}"${r?.cuando === v ? " selected" : ""}>${esc(t("sheet.st.when", { state: m.estados[v ? 0 : 1] }))}</option>`;
    return `<div class="est-al-r${S.active.has(estadoKey(num, k)) ? " bad" : ""}" data-sw-num="${num}"><span class="est-al-n">${esc(m.label)} <b data-now="${k}">${cur ? esc(fmtValue(k, cur.v)) : "—"}</b>${switchHTML(num, k)}</span>
      <select class="inp sel" data-est-cuando="${k}" aria-label="${esc(t("sheet.st.whenAria", { label: m.label }))}"><option value=""${r ? "" : " selected"}>${esc(t("sheet.st.no"))}</option>${opt(1)}${opt(0)}</select>
      <span class="inp-u"><span>${esc(t("sheet.st.more"))}</span><input class="inp" data-est-min="${k}" inputmode="numeric" autocomplete="off" placeholder="0" value="${r?.min || ""}" aria-label="${esc(t("sheet.st.minAria", { label: m.label }))}"><span>min</span></span></div>`;
  }).join("")}</div>
    <p class="hint">${esc(t("sheet.st.hint"))}</p>`;
}
/** Saves the alarm of a state (the whole row: when and minutes). */
export async function saveStateAlarm(el) {
  const num = ctx.S.detail?.num;
  const k = el.dataset.estCuando || el.dataset.estMin;
  const sel = $(`#detail [data-est-cuando="${k}"]`), inp = $(`#detail [data-est-min="${k}"]`);
  const err = $("#ruleErr");
  const min = parseNum(inp.value);
  if (Number.isNaN(min)) { showErr(err, t("sheet.errStateMin")); inp.focus(); return; }
  const cuando = sel.value === "" ? null : Number(sel.value);
  const res = await ctx.orden({ orden: "alarmaEstado", num, metrica: k, cuando, minutos: min === null ? null : Math.round(min) });
  if (res.error) return showErr(err, res.error);
  err.hidden = true;
  if (res.toast) ctx.toast(res.toast);
}

/** A limit or the no-signal minutes, saved when leaving the box. */
export async function saveRuleFromInput(inp) {
  const { S } = ctx;
  const num = S.detail?.num;
  if (!S.cfg.watched[num]) return;
  const err = $("#ruleErr");
  if (inp.id === "r-off") {
    const v = parseNum(inp.value);
    if (Number.isNaN(v)) { showErr(err, t("sheet.errMinutes")); inp.focus(); return; }
    const res = await ctx.orden({ orden: "sinSenal", num, valor: v });
    if (res.error) { showErr(err, res.error); inp.focus(); return; }
    err.hidden = true;
    ctx.render();
    ctx.toast(res.toast);
    return;
  }
  const k = inp.dataset.rule, side = inp.dataset.side;
  const v = parseNum(inp.value);
  if (Number.isNaN(v)) { showErr(err, t("sheet.errNumber", { v: inp.value })); inp.focus(); return; }
  const res = await ctx.orden({ orden: "limite", num, metrica: k, lado: side, valor: v });
  if (res.error) { showErr(err, res.error); inp.focus(); return; }
  err.hidden = true;
  ctx.render();
  drawCharts();
  ctx.toast(res.toast);
}

/* ── the sheet ── */

function alarmsSection(num, n, keys) {
  const { S } = ctx;
  const w = S.cfg.watched[num];
  const noNode = num < 0;
  const off = isNum(w.offlineMin) ? w.offlineMin : S.settings.defaultOfflineMin;
  const rows = keys.filter((k) => !metricMeta(k).minor && !metricMeta(k).estados).map((k) => {
    const m = metricMeta(k), r = (w.rules || {})[k] || {};
    const cur = n.metrics[k];
    return `<tr><th scope="row">${esc(m.label)}${m.unit ? ` <small>${esc(m.unit)}</small>` : ""}</th><td class="now" data-now="${k}">${cur ? fmtValue(k, cur.v) : "—"}</td>
        <td><input id="r-${k}-min" class="inp" data-rule="${k}" data-side="min" inputmode="decimal" autocomplete="off" placeholder="—" value="${isNum(r.min) ? fmtLimit(k, r.min) : ""}" aria-label="${esc(t("sheet.minOf", { label: m.label }))}"></td>
        <td><input id="r-${k}-max" class="inp" data-rule="${k}" data-side="max" inputmode="decimal" autocomplete="off" placeholder="—" value="${isNum(r.max) ? fmtLimit(k, r.max) : ""}" aria-label="${esc(t("sheet.maxOf", { label: m.label }))}"></td></tr>`;
  }).join("");
  const connHint = noNode && S.paneles?.paneles?.[num]?.conexion?.avisar ? ` ${t("sheet.offHintConn")}` : "";
  return `<section class="blk"><h3>${esc(t(noNode ? "sheet.alarmsPanel" : "sheet.alarmsNode"))}</h3>
      <div class="off-row"><label for="r-off">${esc(t(noNode ? "sheet.offPanel" : "sheet.offNode"))}</label><span class="inp-u"><input id="r-off" class="inp" inputmode="numeric" autocomplete="off" value="${off || ""}" placeholder="${esc(t("sheet.offNone"))}"><span>min</span></span></div>
      <p class="hint">${esc(t(noNode ? "sheet.offHintPanel" : "sheet.offHintNode") + connHint)}</p>
      ${rows ? `<div class="tbl"><table class="thr-t"><thead><tr><th scope="col">${esc(t("sheet.th.metric"))}</th><th scope="col">${esc(t("sheet.th.now"))}</th><th scope="col">${esc(t("sheet.th.min"))}</th><th scope="col">${esc(t("sheet.th.max"))}</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">${esc(t("sheet.limitsHint"))}</p>` : `<p class="hint">${esc(t(noNode ? "sheet.noMetricsPanel" : "sheet.noMetricsNode"))}</p>`}
      ${stateAlarmsHTML(num, keys)}
      <p class="form-err" id="ruleErr" role="alert" hidden></p>
      <div class="trend-box" id="trendBox">${trendBlock(num)}</div></section>`;
}

/** Opens a node's (or panel's) sheet. What was changed and not saved stays if the same one is reopened. */
export function openSheet(num) {
  const { S } = ctx;
  forgetDraftsExcept(num);
  S.detail = { num, range: S.detail?.num === num ? S.detail.range : "24h" };
  renderSheet();
  if (!isSheetOpen()) sheet().showModal();
  drawCharts();
}
/** On closing it (its "close" event): a warning if something was left unsaved. */
export function onSheetClose() {
  const { S } = ctx;
  if (isSheetOpen()) return;
  if (S.detail && hasDrafts(S.detail.num)) ctx.toast(t("sheet.unsaved"));
  S.detail = null;
}
export function setSheetRange(range) {
  ctx.S.detail.range = range;
  $$("#detail [data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === range)));
  drawCharts();
}

export function renderSheet() {
  const { S } = ctx;
  const { num } = S.detail;
  const n = ctx.motor.node(num);
  const w = S.cfg.watched[num];
  const keys = sortMetrics(new Set([...Object.keys(n.metrics), ...Object.keys(w?.rules || {})]));
  const noNode = num < 0; // a panel of an MQTT device: no requests, route or location
  const tags = (noNode ? [`${TIPOS_PANEL[n.tipoPanel]?.label || "MQTT"}`, t("sheet.tag.mqtt")]
    : [hexId(num), n.hw ? n.hw.replaceAll("_", " ") : "", n.num === S.myNode ? t("sheet.tag.receiver") : ""]).filter(Boolean).join(" · ");
  let body = "";
  if (!noNode) {
    body += `<section class="blk"><h3>${esc(t("req.title"))}</h3><div class="ask in-sheet" data-ask-box="${num}" data-sheet="1">${requestBlock(num, true)}</div>
    <p class="hint">${esc(t("sheet.askHint"))}</p></section>`;
    body += `<section class="blk"><div class="route-box" data-route-box="${num}">${routeBlock(num)}</div></section>`;
    body += `<section class="blk"><div class="pos in-sheet" data-pos-box="${num}" data-sheet="1">${positionBlock(num, true)}</div></section>`;
  }
  body += w ? alarmsSection(num, n, keys)
    : `<section class="blk cta"><p>${esc(t("sheet.watchCta"))}</p><button class="btn primary" data-watch="${num}">${esc(t("sheet.watchBtn"))}</button></section>`;
  const range = S.detail.range;
  body += `<section class="blk"><div class="blk-h"><h3>${esc(t("sheet.history"))}</h3><div class="seg" role="group" aria-label="${esc(t("sheet.period"))}">
      <button type="button" data-range="24h" aria-pressed="${range === "24h"}">24 h</button><button type="button" data-range="7d" aria-pressed="${range === "7d"}">${esc(t("sheet.days", { n: 7 }))}</button></div></div>
      <div id="chartList" class="chart-list">${keys.length ? keys.map((k) => `<figure class="chart" data-m="${k}"><figcaption><span>${esc(metricMeta(k).label)}</span><b data-cur="${k}">${n.metrics[k] ? esc(fmtWithUnit(k, n.metrics[k].v)) : "—"}</b><span class="mm" data-mm="${k}"></span></figcaption><div class="chart-box"></div></figure>`).join("") : `<p class="hint">${esc(t(noNode ? "sheet.noDataPanel" : "sheet.noTelemetry"))}</p>`}</div></section>`;
  // Watched: its name here, its MQTT data and, on the receiver, what goes out to the mesh.
  if (w) {
    body += panelSections(num);
    body += noNode
      ? `<section class="blk end"><button class="btn danger-ghost" data-panel-quitar="${num}">${esc(t("sheet.removePanel"))}</button></section>`
      : `<section class="blk end"><button class="btn danger-ghost" id="unwatchBtn" data-unwatch="${num}">${esc(t("sheet.unwatch"))}</button></section>`;
  }
  sheet().setAttribute("aria-label", displayName(n));
  sheet().innerHTML = `<div class="sheet-h"><span class="tag">${esc(n.short)}</span><div class="sheet-t"><h2>${esc(displayName(n))}</h2><p class="meta">${esc(tags)}<br>${esc(metaLine(n))}</p></div><button class="icon-btn" data-full="${num}" aria-label="${esc(t("card.fullHint", { name: displayName(n) }))}" title="${esc(t("card.full"))}">${ICON.expand}</button><button class="icon-btn" data-close aria-label="${esc(t("sheet.close"))}">${ICON.close}</button></div><div class="sheet-b">${body}</div>`;
}

export async function drawCharts() {
  const { S } = ctx;
  if (!S.detail) return;
  const { num, range } = S.detail;
  const to = Date.now(), from = to - (range === "7d" ? 7 * DAY : DAY);
  const rules = S.cfg.watched[num]?.rules || {};
  for (const fig of $$("#chartList .chart")) {
    const k = fig.dataset.m;
    const isState = !!metricMeta(k).estados;
    const ser = await S.store.series(num, k, isState ? from - 2 * HOUR : from, to); // a state: also the one before
    if (!S.detail || S.detail.num !== num) return;
    const box = $(".chart-box", fig);
    const W = Math.max(240, Math.floor(box.clientWidth || 320));
    if (isState) {
      const spans = stateSpans(ser, from, to, S.nodes.get(num)?.metrics?.[k]);
      box.innerHTML = stateSVG(spans, k, from, to, W);
      $(`[data-mm="${k}"]`, fig).textContent = stateSummary(k, spans);
      continue;
    }
    box.innerHTML = chartSVG(ser, k, rules[k], from, to, W);
    const vals = ser.map((p) => p.v).filter((v) => !(k === "batteryLevel" && v > 100));
    $(`[data-mm="${k}"]`, fig).textContent = vals.length ? t("sheet.minmax", { min: fmtNum(Math.min(...vals), metricMeta(k).dec), max: fmtNum(Math.max(...vals), metricMeta(k).dec) }) : "";
  }
}

let liveTimer = null;
/** The charts again, at the new size (on rotating the phone or resizing the window). */
export function resizeSheet() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(drawCharts, 200);
}
/** New readings: the figures at once, the charts a moment later. */
export function refreshSheetLive() {
  const { S } = ctx;
  if (!S.detail || !isSheetOpen()) return;
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
  clearTimeout(liveTimer);
  liveTimer = setTimeout(drawCharts, 400);
}

/* ── watching ── */

export async function watch(num) {
  const res = await ctx.orden({ orden: "vigilar", num });
  if (!res.ok) { if (res.error) ctx.toast(res.error); return; }
  ctx.render();
  if (ctx.S.detail?.num === num && isSheetOpen()) { renderSheet(); drawCharts(); }
  ctx.toast(res.toast);
}
export async function unwatch(num) {
  const { S } = ctx;
  await ctx.orden({ orden: "dejar", num });
  // What the screen keeps (collapsed card, order) belongs to this device.
  delete S.ui.collapsed[num];
  S.ui.order = S.ui.order.filter((n) => n !== num);
  saveCardUi();
  ctx.render();
}
