// Nodes: every node of the mesh the receiver knows (about 1100 at Dani's), with a search box, filters and order.
// Watched ones are listed too, marked. Panels without a node are not part of the mesh and are not here.
import { ctx } from "../ctx.js";
import { t } from "../i18n.js";
import { $, esc, setHTML, LS } from "../ui.js";
import { searchNodes, highlight, tokens, FILTERS, SORTS } from "../meshsearch.js";
import { metaLine, displayName } from "./dashboard.js";
import { hexId } from "@talaia/nucleo/motor.js";
import { fmtNum } from "@talaia/nucleo/metrics.js";
import { fmtDist } from "@talaia/nucleo/geo.js";
import { isNum } from "@talaia/nucleo/textos.js";

const PAGE = 50;
const markHTML = (text, words) => highlight(text, words).map((p) => (p.hit ? `<mark>${esc(p.text)}</mark>` : esc(p.text))).join("");

export function saveNodesView() { LS.set("talaia.meshView", ctx.S.meshView); }

function renderTools() {
  const { S } = ctx;
  const v = S.meshView;
  const q = $("#meshQ");
  q.placeholder = t("nodes.search");
  q.setAttribute("aria-label", t("nodes.searchLabel"));
  $("label[for=meshSort]").textContent = t("nodes.sortLabel");
  const box = $("#meshFilters");
  box.setAttribute("aria-label", t("nodes.filters"));
  setHTML(box, FILTERS.map((f) => `<button type="button" class="fchip" data-mf="${f.key}" aria-pressed="${v.filters.includes(f.key)}"${f.key === "near" ? ` title="${esc(t("nodes.f.nearHint"))}"` : ""}>${esc(t(`nodes.f.${f.key}`))}</button>`).join(""));
  const sel = $("#meshSort");
  const myPos = S.myNode != null ? S.nodes.get(S.myNode)?.pos : null;
  setHTML(sel, SORTS.map((o) => {
    const off = o.key === "dist" && !myPos;
    return `<option value="${o.key}"${off ? " disabled" : ""}>${esc(t(`nodes.sort.${o.key}`))}${off ? esc(t("nodes.sort.distOff")) : ""}</option>`;
  }).join(""));
  if (sel.value !== v.sort) sel.value = v.sort;
}

function rowHTML({ n, dist, score }, words) {
  const { S, motor } = ctx;
  const watched = motor.isWatched(n.num);
  const tags = [
    watched ? ["watch", t("nodes.tag.watched")] : null,
    n.num === S.myNode ? ["", t("nodes.tag.receiver")] : null,
    n.hasEnv ? ["", t("nodes.tag.sensors")] : null,
    n.num !== S.myNode && n.key === false && motor.receptorUsesPki() ? ["warn", t("nodes.tag.noKey")] : null,
  ].filter(Boolean);
  // What decides the order goes first, so it shows even if the line is cut on a phone.
  const far = dist != null && n.num !== S.myNode ? t("nodes.far", { dist: fmtDist(dist) }) : "";
  const sort = S.meshView.sort;
  const snr = isNum(n.snr) && n.snr !== 0 ? `SNR ${fmtNum(n.snr, 1)} dB` : "";
  const lead = sort === "dist" ? far : sort === "snr" ? snr : "";
  let meta = metaLine(n);
  if (lead && sort === "snr") meta = meta.replace(` · ${lead}`, "");
  meta = [lead, meta, lead === far ? "" : far].filter(Boolean).join(" · ");
  // Matched only by ID or model: show them, so it's clear why it came up.
  const why = score === 4 ? ` · ${markHTML(hexId(n.num), words)}${n.hw ? ` · ${markHTML(n.hw.replaceAll("_", " "), words)}` : ""}` : "";
  const action = watched ? "" : `<button class="btn ghost sm" data-watch="${n.num}">${esc(t("nodes.watch"))}</button>`;
  return `<li class="row"><button class="row-main" data-open="${n.num}"><span class="tag sm">${markHTML(n.short, words)}</span><span class="row-t"><span class="row-n">${markHTML(displayName(n), words)}${tags.map(([c, x]) => `<span class="chip${c ? ` ${c}` : ""}">${esc(x)}</span>`).join("")}</span><span class="meta">${esc(meta)}${why}</span></span></button>${action}</li>`;
}

export function renderNodes() {
  const { S } = ctx;
  $("#h-mesh").textContent = t("nodes.heading");
  const q = S.meshQ.trim();
  const words = tokens(q);
  const filters = new Set(S.meshView.filters);
  const searching = words.length > 0 || filters.size > 0;
  const mesh = [...S.nodes.values()].filter((n) => n.num >= 0); // panels without a node are not part of the mesh
  const from = S.myNode != null ? S.nodes.get(S.myNode)?.pos : null;
  const res = searchNodes(mesh, { q, filters, sort: S.meshView.sort, now: Date.now(), from });
  $("#meshTools").hidden = mesh.length < 2;
  renderTools();
  $("#meshCount").textContent = searching ? t("nodes.countOf", { n: res.length, total: mesh.length }) : mesh.length ? String(mesh.length) : "";
  const shown = S.meshExpanded ? res : res.slice(0, PAGE);
  let html;
  if (!mesh.length) {
    html = `<li class="empty-row">${esc(t("nodes.none"))}</li>`;
  } else if (!res.length) {
    const why = [q ? t("nodes.whyText", { q }) : "", filters.size ? t("nodes.whyFilters") : ""].filter(Boolean).join(t("nodes.and"));
    html = `<li class="empty-row">${esc(t("nodes.noMatch", { why }))} <button type="button" class="link-btn" data-mesh-clear>${esc(t("nodes.clear"))}</button></li>`;
  } else {
    html = shown.map((r) => rowHTML(r, words)).join("");
  }
  setHTML($("#mesh"), html);
  const more = $("#meshMore");
  more.hidden = res.length <= PAGE;
  more.textContent = S.meshExpanded ? t("nodes.less") : t("nodes.all", { n: res.length });
}

let queryTimer = null;
/** Typing in the search box: the list follows a moment later (now = at once, for Enter). */
export function onNodesQuery(value, now = false) {
  clearTimeout(queryTimer);
  const run = () => {
    ctx.S.meshQ = value;
    ctx.S.meshExpanded = false;
    renderNodes();
  };
  if (now) run(); else queryTimer = setTimeout(run, 120);
}
