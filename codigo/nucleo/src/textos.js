// Tiempos y textos comunes, sin pantalla: los usan la app y el servidor. In the core's language (idioma.js).
import { metricMeta, fmtNum } from "./metrics.js";
import { tx, localeOf, getLanguage } from "./idioma.js";

export const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const isNum = (x) => typeof x === "number" && Number.isFinite(x);
/** Hora válida: después de 2020 y no más de 5 min en el futuro (un reloj sin hora da 1970). */
export const validT = (t) => isNum(t) && t > 1.6e12 && t < Date.now() + 5 * MIN;

// Date formats in the current language: used as hhmm.format(date), like an Intl.DateTimeFormat.
const DTF = new Map();
const dtf = (name, opts) => {
  const key = `${getLanguage()}:${name}`;
  if (!DTF.has(key)) DTF.set(key, new Intl.DateTimeFormat(localeOf(), opts));
  return DTF.get(key);
};
export const hhmm = { format: (d) => dtf("hhmm", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d) };
export const dShort = { format: (d) => dtf("dShort", { day: "numeric", month: "short" }).format(d) };

export function dur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return tx("t.min", { n: m });
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? tx("t.hmin", { h, m: r }) : tx("t.h", { h });
  const d = Math.floor(h / 24);
  return d === 1 ? tx("t.day") : tx("t.days", { n: d });
}
export function ago(t) {
  if (!t) return tx("t.never");
  const ms = Date.now() - t;
  if (ms < 60000) return tx("t.now");
  return tx("t.ago", { d: dur(ms) });
}
export function stamp(t) {
  const d = new Date(t), today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? hhmm.format(d) : `${dShort.format(d)} ${hhmm.format(d)}`;
}

/* ── cambio rápido ── */
/** Decimales para un cambio: los pequeños llevan uno más (3,4 hPa, no 3 hPa). */
export const trendDec = (k, change) => Math.max(metricMeta(k).dec, Math.abs(change) < 10 ? 1 : 0);
export function fmtTrend(k, v, dec) {
  const u = metricMeta(k).unit;
  return u ? `${fmtNum(v, dec)} ${u}` : fmtNum(v, dec);
}
export const trendVerb = (dir) => tx(dir === "down" ? "t.drops" : "t.rises");
/** «30 min», «1,5 h», «3 h». */
export const hoursText = (h) => (h < 1 ? `${Math.round(h * 60)} min` : `${fmtNum(h, h % 1 ? 1 : 0)} h`);
/** «en las últimas 3 horas», «en la última hora», «en los últimos 30 min». */
export function lastWindow(h) {
  if (h < 1) return tx("t.lastMin", { n: Math.round(h * 60) });
  if (h === 1) return tx("t.lastHour");
  return tx("t.lastHours", { h: fmtNum(h, h % 1 ? 1 : 0) });
}
