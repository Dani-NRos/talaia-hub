// Tiempos y textos comunes de Vigía (español de España), sin pantalla: los usan la app y el servidor.
import { metricMeta, fmtNum } from "./metrics.js";

export const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const isNum = (x) => typeof x === "number" && Number.isFinite(x);
/** Hora válida: después de 2020 y no más de 5 min en el futuro (un reloj sin hora da 1970). */
export const validT = (t) => isNum(t) && t > 1.6e12 && t < Date.now() + 5 * MIN;

export const hhmm = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit" });
export const dShort = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });

export function dur(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 día" : `${d} días`;
}
export function ago(t) {
  if (!t) return "nunca";
  const ms = Date.now() - t;
  if (ms < 60000) return "ahora mismo";
  return `hace ${dur(ms)}`;
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
export const trendVerb = (dir) => (dir === "down" ? "baja" : "sube");
/** «30 min», «1,5 h», «3 h». */
export const hoursText = (h) => (h < 1 ? `${Math.round(h * 60)} min` : `${fmtNum(h, h % 1 ? 1 : 0)} h`);
/** «en las últimas 3 horas», «en la última hora», «en los últimos 30 min». */
export function lastWindow(h) {
  if (h < 1) return `en los últimos ${Math.round(h * 60)} min`;
  if (h === 1) return "en la última hora";
  return `en las últimas ${fmtNum(h, h % 1 ? 1 : 0)} horas`;
}
