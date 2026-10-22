// Talaia's mark: a forest fire lookout tower. The cab's window band lights up in the signal colour while
// there are unattended alarms (in the navigation and in the browser tab), like a lookout that has spotted smoke.
// The app icons (pwa/icon-*.png) are drawn from these same shapes by herramientas/iconos.mjs.

const ROOF = "M12 1.2 4.8 5.8h14.4z";
const CAB = "M6.4 6.5h11.2v5H6.4z";
const WINDOW = "M7.9 8h8.2v2H7.9z";
const DECK = "M4.6 12.6h14.8";
const LEGS = "M8.3 12.6 5.6 22.6M15.7 12.6l2.7 10M7.5 15.6 18.1 21.6M16.5 15.6 5.9 21.6";

export const COLORS = { forest: "#22372A", sand: "#E7E1CC", signal: "#E2531B" };

/** The tower inside a 24×24 box. ink: tower colour; lamp: colour of the window band (the background when off). */
export function towerShapes(ink = "currentColor", lamp = "var(--lamp)") {
  return `<path d="${ROOF}" fill="${ink}"/><path d="${CAB}" fill="${ink}"/><path class="lamp" d="${WINDOW}" fill="${lamp}"/>`
    + `<path d="${DECK}" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>`
    + `<path d="${LEGS}" stroke="${ink}" stroke-width="1.7" stroke-linecap="round" fill="none"/>`;
}

/** Inline mark for the page: takes the text colour; the window uses --lamp (set by CSS). */
export const logoSVG = (cls = "logo") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${towerShapes()}</svg>`;

/**
 * Square icon with the forest background. pad: empty margin as a share of the side (maskable icons need ~20 %).
 * lit: window in the signal colour.
 */
export function iconSVG({ size = 64, pad = 0.08, radius = 0.18, lit = false } = {}) {
  const inner = 24 * (1 - 2 * pad);
  const k = inner / 24;
  const off = 24 * pad;
  const r = 24 * radius;
  const lamp = lit ? COLORS.signal : COLORS.forest;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">`
    + `<rect width="24" height="24" rx="${r}" fill="${COLORS.forest}"/>`
    + `<g transform="translate(${off} ${off}) scale(${k})">${towerShapes(COLORS.sand, lamp)}</g></svg>`;
}

let faviconLit = null;
/** Browser tab icon: lit while there are unattended alarms. */
export function setFavicon(lit) {
  if (typeof document === "undefined" || faviconLit === lit) return;
  faviconLit = lit;
  let link = document.querySelector('link[rel="icon"][data-talaia]');
  if (!link) {
    for (const old of document.querySelectorAll('link[rel="icon"]')) old.remove();
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.dataset.talaia = "";
    document.head.append(link);
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(iconSVG({ pad: 0.02, radius: 0.16, lit }))}`;
}
