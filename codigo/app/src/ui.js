// Small things every section uses: DOM shortcuts, escaping, per-device storage, numbers typed by hand and icons.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Sets innerHTML only when it changes (no repaint, no lost focus or scroll). */
export function setHTML(el, html) { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } }

/**
 * Every `sel` inside `box` fits its own width, all of them at the same size: their CSS size is the largest, and if
 * one doesn't fit, all get smaller by the same factor (the CSS variable `name` on `box`, a multiplier their
 * font-size uses). Hidden ones (no width yet) don't count. Returns that factor (1: they all fit as they are).
 */
export function fitSame(box, sel, name = "--fit") {
  if (!box) return 1;
  box.style.removeProperty(name);
  const els = [...box.querySelectorAll(sel)];
  let f = 1;
  // Measured again after shrinking: what doesn't shrink in proportion (a minimum size, a fixed gap) may still stick out.
  for (let i = 0; i < 3; i++) {
    let g = 1;
    for (const el of els) if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth) g = Math.min(g, el.clientWidth / el.scrollWidth);
    if (g >= 1) break;
    f = Math.floor(f * g * 0.98 * 1000) / 1000;
    box.style.setProperty(name, String(f));
  }
  return f;
}

/** localStorage of this device: never throws (private window, blocked storage…). */
export const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* no storage */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nothing */ } },
};

/** A number typed by hand: comma or point; "" → null; nonsense → NaN. */
export function parseNum(s) {
  const x = String(s ?? "").trim().replace(",", ".");
  if (x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const ICON = {
  server: svg(`<rect x="4" y="4" width="16" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="8" cy="7.25" r="1.1" fill="currentColor"/><circle cx="8" cy="16.75" r="1.1" fill="currentColor"/>`),
  close: svg(`<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
  chevron: svg(`<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  expand: svg(`<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  grip: svg(`<g fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g>`),
  up: svg(`<path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  down: svg(`<path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
  plus: svg(`<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
};
