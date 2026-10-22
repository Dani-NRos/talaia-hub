// The frame around the sections: navigation, top bar, which view is showing (by the address: #/dashboard,
// #/alarms…, and a part of it after another slash: #/settings/mqtt), the browser tab and the theme. The sections
// themselves are drawn by app.js and views/.
import { t } from "./i18n.js";
import { logoSVG, setFavicon } from "./logo.js";

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const NAV_ICONS = {
  dashboard: svg(`<rect x="3.5" y="4.5" width="7.5" height="7" rx="1"/><rect x="13" y="4.5" width="7.5" height="15" rx="1"/><rect x="3.5" y="13.5" width="7.5" height="6" rx="1"/>`),
  alarms: svg(`<path d="M7 18.5V13a5 5 0 0 1 10 0v5.5"/><path d="M4.5 18.5h15M12 3.5v2M5.4 6.4l1.4 1.4M18.6 6.4l-1.4 1.4M12 13v2.5"/>`),
  nodes: svg(`<circle cx="6" cy="7" r="2.3"/><circle cx="18" cy="7" r="2.3"/><circle cx="12" cy="17.5" r="2.3"/><path d="M8.3 7h7.4M7.2 9 10.8 15.5M16.8 9l-3.6 6.5"/>`),
  map: svg(`<path d="M9 4.5 3.5 6.6v13l5.5-2.1 6 2.1 5.5-2.1v-13L15 6.6 9 4.5Z"/><path d="M9 4.5v13M15 6.6v13"/>`),
  automations: svg(`<path d="M8 6.5 12.5 11 8 15.5 3.5 11z"/><path d="M12.5 11h7.5M17 8l3 3-3 3"/>`),
  settings: svg(`<path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.4h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4-2-1.6Z"/>`),
};

// In the order of the navigation (Dani, 22 Oct 2026). Settings: at the bottom of the rail, or the gear on phones.
export const VIEWS = ["dashboard", "map", "nodes", "automations", "alarms", "settings"];
const LABEL = { dashboard: "nav.dashboard", alarms: "nav.alarms", nodes: "nav.nodes", map: "nav.map", automations: "nav.automations", settings: "nav.settings" };

const $ = (s) => document.querySelector(s);
let current = null;
let hooks = { enter() {}, leave() {} };
let alarms = 0;

/** The view in the address (#/alarms), or the dashboard. */
export function viewFromHash(hash = location.hash) {
  const v = /^#\/([a-z]+)/.exec(hash)?.[1];
  return VIEWS.includes(v) ? v : "dashboard";
}
/** The part of the view in the address (#/settings/mqtt → "mqtt"), or null. */
export const subFromHash = (hash = location.hash) => /^#\/[a-z]+\/([a-z]+)/.exec(hash)?.[1] || null;
export const currentView = () => current;
export const isView = (v) => current === v;
let currentSub = null;

/** Goes to a view (and a part of it). If it is already showing, its enter hook runs again (a new focus, say). */
export function go(view, sub = null) {
  const hash = sub ? `#/${view}/${sub}` : `#/${view}`;
  if (current === view && (location.hash === hash || (!sub && viewFromHash() === view))) return hooks.enter(view, { again: true, sub: sub ?? subFromHash() });
  location.hash = hash;
}

function show() {
  const next = viewFromHash(), sub = subFromHash();
  if (next === current) {
    // Another part of the same view (or the same one again): only its enter hook.
    if (sub !== currentSub) { currentSub = sub; window.scrollTo(0, 0); hooks.enter(next, { again: true, sub }); }
    return;
  }
  const prev = current;
  current = next;
  currentSub = sub;
  for (const el of document.querySelectorAll("[data-view]")) el.hidden = el.dataset.view !== next;
  renderNav();
  $("#topTitle").textContent = t(LABEL[next]);
  if (prev) hooks.leave(prev);
  window.scrollTo(0, 0);
  hooks.enter(next, { again: false, sub });
}

export function renderNav() {
  // Icons only (the section's name is in the top bar); the name goes in the tooltip and for screen readers.
  const items = VIEWS.map((v) => {
    const badge = v === "alarms" ? `<span class="badge" aria-hidden="true">${alarms || ""}</span>` : "";
    const label = v === "alarms" && alarms ? `${t(LABEL[v])}: ${t("nav.alarmsBadge", { n: alarms })}` : t(LABEL[v]);
    return `<a class="nav-i" href="#/${v}" data-nav="${v}"${v === current ? ' aria-current="page"' : ""} title="${label}" aria-label="${label}">${NAV_ICONS[v]}${badge}</a>`;
  });
  const nav = $("#nav");
  nav.setAttribute("aria-label", t("nav.label"));
  nav.innerHTML = `<a class="nav-brand" href="#/dashboard" title="${t("app.name")}" aria-label="${t("app.name")}">${logoSVG()}</a>${items.join("")}`;
}

/** Unattended alarms: badge on Alarms, the lamp of the mark lit, and the count in the tab. */
export function setAlarms(n) {
  document.documentElement.toggleAttribute("data-alarm", n > 0);
  setFavicon(n > 0);
  document.title = n ? t("title.alarm", { n }) : t("app.name");
  if (n === alarms) return;
  alarms = n;
  renderNav();
}

/* theme: "auto" follows the system; "light" (day) and "dark" (night watch) are fixed */
const THEME_KEY = "talaia.theme";
export function getTheme() {
  try { const v = localStorage.getItem(THEME_KEY); return v === "light" || v === "dark" ? v : "auto"; } catch { return "auto"; }
}
export function setTheme(v) {
  try { if (v === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, v); } catch { /* no storage */ }
  applyTheme();
}
function applyTheme() {
  const v = getTheme();
  if (v === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = v;
}

/** Labels that depend on the language (after changing it). */
export function relabel() {
  renderNav();
  if (current) $("#topTitle").textContent = t(LABEL[current]);
  $("#topMark").setAttribute("aria-label", t("app.name"));
  $("#gearBtn").setAttribute("aria-label", t("nav.settings"));
  $("#linkBtn").title = t("link.open");
  document.title = alarms ? t("title.alarm", { n: alarms }) : t("app.name");
}

/** hooks: { enter(view, { again, sub }), leave(view) }. */
export function initShell(h) {
  hooks = { ...hooks, ...h };
  applyTheme();
  $("#topMark").innerHTML = logoSVG();
  $("#gearBtn").innerHTML = NAV_ICONS.settings;
  relabel();
  setFavicon(false);
  window.addEventListener("hashchange", show);
  show();
}
