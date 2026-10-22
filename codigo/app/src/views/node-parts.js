// Pieces of a node that show both on its dashboard card and in its sheet: asking it for data now, its location
// (with the anti-theft fence in the sheet) and the switch of an ON/OFF datum that can be turned on and off.
import { ctx } from "../ctx.js";
import { t } from "../i18n.js";
import { $$, esc } from "../ui.js";
import { ASK, ASK_ALL, askKey, RE } from "@vigia/nucleo/motor.js";
import { metricMeta, fmtNum } from "@vigia/nucleo/metrics.js";
import { hhmm, ago, stamp, isNum } from "@vigia/nucleo/textos.js";
import { distM, compass, precisionM, fmtDist, coordText, mapsUrl } from "@vigia/nucleo/geo.js";

const time = (ms) => hhmm.format(new Date(ms));

/* ── asking for data now ── */

function requestChips(num) {
  const { S, motor } = ctx;
  const ok = motor.canAsk();
  return Object.entries(ASK).map(([type, a]) => {
    const r = S.req.get(askKey(num, type));
    const st = motor.askVisible(r) && !motor.staleKeyFail(r) ? r.state : "";
    return `<button type="button" class="ask-b${st ? ` is-${st}` : ""}" data-ask="${type}" data-num="${num}" title="${esc(a.what)}"${!ok || st === "wait" ? " disabled" : ""}>${esc(a.label)}</button>`;
  }).join("");
}

/** What happened with the latest requests of these types: waiting, received or why not. */
export function requestStatus(num, types = Object.keys(ASK_ALL).filter((x) => x !== "pos" && x !== "route")) {
  const { S, motor } = ctx;
  return types.map((type) => S.req.get(askKey(num, type))).filter((r) => motor.askVisible(r) && !motor.staleKeyFail(r)).sort((a, b) => b.t0 - a.t0).map((r) => {
    const label = ASK_ALL[r.type].label;
    const s = Math.round((Date.now() - r.t0) / 1000);
    if (r.state === "wait" && r.type === "route") return `<span class="s-wait">${esc(t("req.tracing", { s }))}</span>`;
    if (r.state === "wait") return `<span class="s-wait">${esc(t(r.acked ? "req.waitAcked" : "req.wait", { label, s }))}</span>`;
    if (r.state === "ok" && r.type === "route") return "";
    if (r.state === "ok" && r.type === "pos") return `<span class="s-ok">${esc(r.noLoc ? t("req.posNone", { label }) : t("req.posOk", { label, time: time(r.tDone) }))}</span>`;
    if (r.state === "ok" && r.type === "info") return `<span class="s-ok">${esc(t(r.gotKey ? "req.infoKey" : "req.infoNoKey", { label, time: time(r.tDone) }))}</span>`;
    if (r.state === "ok") return `<span class="s-ok">${esc(t("req.ok", { label, time: time(r.tDone), s: Math.max(1, Math.round((r.tDone - r.t0) / 1000)) }))}</span>`;
    return `<span class="s-fail">${esc(`${label}: ${motor.askFailText(r.why, r)}`)}</span>`;
  }).join("");
}

/** Whether the receiver and the node have each other's key (needed for requests since firmware 2.5). */
function keyRow(num, sheet) {
  const { S, motor } = ctx;
  if (num === S.myNode) return "";
  const need = motor.keyNeeded(num);
  if (!sheet && !need) return "";
  const n = S.nodes.get(num);
  const waiting = S.req.get(askKey(num, "info"))?.state === "wait";
  const theyLack = Object.keys(ASK).some((x) => {
    const q = S.req.get(askKey(num, x));
    return motor.askVisible(q) && q.state === "fail" && q.why === RE.PKI_UNKNOWN_PUBKEY && !motor.staleKeyFail(q);
  });
  const txt = need && theyLack ? t("req.keyTheyLack") : need ? t("req.keyWeLack") : n?.key ? t("req.keyOk") : t("req.keyAbout");
  return `<div class="key-row${need ? " need" : ""}"><span>${esc(txt)}</span><button type="button" class="btn ghost sm" data-ask="info" data-num="${num}"${!motor.canAsk() || waiting ? " disabled" : ""}>${esc(t(waiting ? "req.infoAsking" : "req.infoAsk"))}</button></div>`;
}

export function requestBlock(num, sheet = false) {
  return `<span class="ask-l">${esc(t("req.title"))}</span><div class="ask-row">${requestChips(num)}</div>${keyRow(num, sheet)}<p class="ask-st" data-ask-st="${num}">${requestStatus(num)}</p>`;
}

/* ── location and fence ── */

function fenceLine(num) {
  const { S } = ctx;
  const w = S.cfg.watched[num], n = S.nodes.get(num);
  if (!w?.fence || !n?.pos) return "";
  const d = distM(w.fence, n.pos);
  const v = { dist: fmtDist(d), dir: compass(w.fence, n.pos), r: fmtDist(w.fence.r) };
  if (S.active.has(`${num}||moved`)) return `<p class="fence bad">${esc(t("fence.out", v))}</p>`;
  if (d > w.fence.r) return `<p class="fence warn">${esc(t("fence.maybe", v))}</p>`;
  return `<p class="fence ok">${esc(t(d >= 1 ? "fence.inAt" : "fence.in", v))}</p>`;
}

function posMeta(p) {
  const pm = precisionM(p.bits);
  return [pm ? `±${fmtDist(pm)}` : p.bits >= 32 ? t("pos.fullPrecision") : "", ago(p.t)].filter(Boolean).join(" · ");
}

/** Location: coordinates, copy, map, ask for it. In the sheet, also where it comes from and the fence. */
export function positionBlock(num, sheet = false) {
  const { S, motor } = ctx;
  const n = S.nodes.get(num), p = n?.pos;
  const w = S.cfg.watched[num];
  const waiting = S.req.get(askKey(num, "pos"))?.state === "wait";
  const askBtn = `<button type="button" class="mini" data-ask="pos" data-num="${num}"${!motor.canAsk() || waiting ? " disabled" : ""}>${esc(t(waiting ? "pos.asking" : "pos.ask"))}</button>`;
  let h = `<div class="pos-top"><span class="pos-l">${esc(t("pos.title"))}</span>${p ? `<span class="pos-m">${esc(posMeta(p))}</span>` : ""}</div>`;
  if (p) {
    const c = coordText(p);
    h += `<code class="pos-c">${c}</code><div class="pos-row"><button type="button" class="mini" data-copy="${c}">${esc(t("pos.copy"))}</button><button type="button" class="mini" data-map-focus="${num}">${esc(t("pos.onMap"))}</button><a class="mini" href="${mapsUrl(p)}" target="_blank" rel="noopener" title="${esc(t("pos.gmapsHint"))}">Google Maps</a>${sheet ? askBtn : ""}</div>`;
  } else {
    h += `<div class="pos-row"><span class="hint">${esc(t("pos.none"))}</span>${askBtn}</div>`;
  }
  h += `<p class="ask-st" data-pos-st="${num}">${requestStatus(num, ["pos"])}</p>`;
  if (!sheet) return h + fenceLine(num);
  if (p) {
    const src = { 1: t("pos.src.manual"), 2: t("pos.src.gps"), 3: t("pos.src.external") }[p.src];
    const facts = [src ? t("pos.source", { src }) : "", isNum(p.alt) ? t("pos.altitude", { m: fmtNum(p.alt, 0) }) : "", t("pos.at", { stamp: stamp(p.t) })].filter(Boolean);
    h += `<p class="hint">${esc(facts.join(" · "))}</p>`;
  }
  if (!w) return h;
  // anti-theft fence (watched nodes only)
  const f = w.fence;
  const pm = p ? precisionM(p.bits) : null;
  const rVal = f ? f.r : Math.max(200, pm ? Math.ceil((pm * 2) / 50) * 50 : 0);
  h += `<div class="fence-box"><h4>${esc(t("fence.title"))}</h4>`;
  h += f ? fenceLine(num) + `<p class="hint">${esc(t("fence.place", { coords: coordText(f), stamp: stamp(f.at) }))}</p>`
    : `<p class="hint">${esc(t("fence.about"))}</p>`;
  h += `<div class="off-row"><label for="fence-r">${esc(t("fence.radius"))}</label><span class="inp-u"><input id="fence-r" class="inp" inputmode="numeric" autocomplete="off" value="${rVal}"><span>m</span></span></div>`;
  h += `<div class="btns"><button type="button" class="btn ${f ? "ghost" : "primary"} sm" data-fence-set="${num}"${p ? "" : " disabled"}>${esc(t(f ? "fence.move" : "fence.set"))}</button>${f ? `<button type="button" class="btn danger-ghost sm" data-fence-del="${num}">${esc(t("fence.remove"))}</button>` : ""}</div>`;
  if (p?.src === 1) h += `<p class="warn-t">${esc(t("fence.manualWarn"))}</p>`;
  if (pm && pm > (f ? f.r : rVal) / 2) h += `<p class="warn-t">${esc(t("fence.precisionWarn", { pm: fmtDist(pm) }))}</p>`;
  return h + `</div>`;
}

export function refreshPosition(num) {
  for (const el of $$(`[data-pos-box="${num}"]`)) {
    if (el.contains(document.activeElement) && document.activeElement.matches("input")) continue; // don't overwrite typing
    el.innerHTML = positionBlock(num, el.dataset.sheet === "1");
  }
}

export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback: select the text so it can be copied by hand or with execCommand.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0;left:0;top:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* no clipboard */ }
    ta.remove();
    if (!ok) return ctx.toast(t("pos.copyFailed", { c: text }));
  }
  if (btn) { btn.textContent = t("pos.copied"); setTimeout(() => { if (btn.isConnected) btn.textContent = t("pos.copy"); }, 1600); }
  ctx.toast(t("pos.copiedToast"));
}

/* ── switch of an ON/OFF datum ── */

/** The datum of a panel by its key (to know whether it can be switched). */
export const datumOf = (num, k) => ctx.S.paneles?.paneles?.[num]?.datos?.find((d) => d.clave === k) || null;

/**
 * Switch for a state that can be turned on and off from here: sends the order on press, without confirmation;
 * "Sending…" until the device says it has done it; if it doesn't answer, it says so.
 */
export function switchHTML(num, k) {
  const { S } = ctx;
  if (!datumOf(num, k)?.orden) return "";
  const m = metricMeta(k), cur = S.nodes.get(num)?.metrics?.[k];
  const o = S.paneles?.ordenes?.[k];
  const on = cur?.v === 1;
  const txt = o?.enviando ? t("sw.sending") : o?.error ? `${o.error}` : "";
  const next = m.estados?.[on ? 1 : 0];
  const aria = `${m.label}: ${next ? t("sw.to", { state: next }) : t("sw.toggle")}`;
  return `<span class="tgl-w" data-sw="${k}"><button type="button" class="tgl${on ? " on" : ""}${o?.enviando ? " env" : ""}" role="switch" aria-checked="${on}" data-orden="${k}" data-num="${num}"${o?.enviando ? " disabled" : ""} aria-label="${esc(aria)}"><span class="tgl-ui"></span></button>${txt ? `<span class="tgl-t${o?.error ? " warn-t" : ""}">${esc(txt)}</span>` : ""}</span>`;
}

/** The switches in the sheet and the full screen, up to date (without redrawing the rest). */
export function patchSwitches() {
  for (const el of $$("[data-sw]")) {
    const box = el.closest("[data-sw-num]");
    if (!box) continue;
    const html = switchHTML(Number(box.dataset.swNum), el.dataset.sw);
    if (html && el.outerHTML !== html) el.outerHTML = html;
  }
}
