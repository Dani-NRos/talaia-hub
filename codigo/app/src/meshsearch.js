// Buscador de «Resto de la malla»: texto, filtros y orden. Sin DOM, para poder probarlo con node --test.
import { distM } from "@vigia/nucleo/geo.js";

const HOUR = 3600000;

/** Minúsculas y sin tildes, carácter a carácter (para poder resaltar en el texto original). */
function normChar(c) {
  return c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
export function normalize(s) {
  let out = "";
  for (const c of String(s ?? "")) out += normChar(c);
  return out;
}
/** Texto normalizado y, para cada carácter suyo, en qué posición del original empieza. */
function normMap(s) {
  let norm = "";
  const at = [];
  let i = 0;
  for (const c of String(s ?? "")) {
    const n = normChar(c);
    for (let k = 0; k < n.length; k++) at.push(i);
    norm += n;
    i += c.length;
  }
  at.push(i);
  return { norm, at };
}

export const tokens = (q) => normalize(q).trim().split(/\s+/).filter(Boolean);
const hex = (num) => (num >>> 0).toString(16).padStart(8, "0");

/**
 * ¿Coincide el nodo con todas las palabras? Busca en nombre largo, corto, ID (!abcd1234) y modelo (HELTEC_V3).
 * Devuelve null si no, o una puntuación (menos es mejor): 0 nombre exacto, 1 el nombre empieza así,
 * 2 alguna palabra del nombre empieza así, 3 lo contiene, 4 solo por ID o modelo.
 */
export function matchScore(n, words, whole = words.join(" ")) {
  if (!words.length) return 0;
  if (n.alias) {
    // Renombrado en Vigía (servidor): vale tanto el nombre de Vigía como el de Meshtastic.
    const a = matchScore({ ...n, long: n.alias, alias: null }, words, whole), b = matchScore({ ...n, alias: null }, words, whole);
    return a == null ? b : b == null ? a : Math.min(a, b);
  }
  const long = normalize(n.long), short = normalize(n.short);
  const id = `!${hex(n.num)}`;
  const hw = normalize(String(n.hw || "").replace(/_/g, " "));
  // El ID solo cuenta con 3 cifras hexadecimales o más (si no, «a» coincidiría con casi todos).
  const inId = (w) => /^!?[0-9a-f]{3,8}$/.test(w) && id.includes(w.replace(/^!/, ""));
  let nameHit = true;
  for (const w of words) {
    if (long.includes(w) || short.includes(w)) continue;
    if (inId(w) || hw.includes(w)) { nameHit = false; continue; }
    return null;
  }
  if (!nameHit) return 4;
  if (long.trim() === whole || short === whole) return 0;
  if (long.startsWith(whole) || short.startsWith(whole)) return 1;
  const startsWord = (s) => s.split(/[\s\-_|·.,/()]+/).some((p) => p.startsWith(words[0]));
  return startsWord(long) || startsWord(short) ? 2 : 3;
}

/** Filtros rápidos. «Cerca»: directo o a un salto. */
export const FILTERS = [
  { key: "env", label: "Con sensores", test: (n) => !!n.hasEnv },
  { key: "pos", label: "Con ubicación", test: (n) => !!n.pos },
  { key: "near", label: "Cerca", title: "Directos o a un salto", test: (n) => Number.isFinite(n.hops) && n.hops <= 1 },
  { key: "day", label: "Últimas 24 h", test: (n, now) => now - (n.lastHeard || 0) <= 24 * HOUR },
];

export const SORTS = [
  { key: "auto", label: "Recomendado" },
  { key: "recent", label: "Oídos hace menos" },
  { key: "hops", label: "Menos saltos" },
  { key: "dist", label: "Más cerca de ti" },
  { key: "snr", label: "Mejor señal" },
  { key: "name", label: "Nombre" },
];

const byRecent = (a, b) => (b.n.lastHeard || 0) - (a.n.lastHeard || 0);
const last = (v) => (Number.isFinite(v) ? v : Infinity);
const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

/**
 * nodes: nodos a mostrar. opts: { q, filters: Set, sort, now, from: posición del receptor o null }.
 * Devuelve [{ n, dist, score }] ya filtrado y ordenado. dist: metros al receptor si se conocen las dos posiciones.
 * Orden «auto»: con texto, los que mejor coinciden; sin texto, primero los que tienen sensores y luego los oídos hace menos.
 */
export function searchNodes(nodes, { q = "", filters = new Set(), sort = "auto", now = Date.now(), from = null } = {}) {
  const words = tokens(q);
  const whole = words.join(" ");
  const active = FILTERS.filter((f) => filters.has(f.key));
  const out = [];
  for (const n of nodes) {
    if (!active.every((f) => f.test(n, now))) continue;
    const score = matchScore(n, words, whole);
    if (score == null) continue;
    const dist = from && n.pos ? distM(from, n.pos) : null;
    out.push({ n, dist, score });
  }
  const cmp = {
    auto: words.length ? (a, b) => a.score - b.score || byRecent(a, b) : (a, b) => (b.n.hasEnv ? 1 : 0) - (a.n.hasEnv ? 1 : 0) || byRecent(a, b),
    recent: byRecent,
    hops: (a, b) => last(a.n.hops) - last(b.n.hops) || byRecent(a, b),
    dist: (a, b) => last(a.dist) - last(b.dist) || byRecent(a, b),
    snr: (a, b) => last(a.n.snr == null ? null : -a.n.snr) - last(b.n.snr == null ? null : -b.n.snr) || byRecent(a, b),
    name: (a, b) => collator.compare(a.n.alias || a.n.long || "", b.n.alias || b.n.long || ""),
  }[sort] || byRecent;
  return out.sort(cmp);
}

/**
 * Marca en el texto original los trozos que coinciden con las palabras (sin tildes ni mayúsculas).
 * Devuelve [{ text, hit }] para que quien pinte escape cada trozo.
 */
export function highlight(text, words) {
  const s = String(text ?? "");
  if (!words.length || !s) return [{ text: s, hit: false }];
  const { norm, at } = normMap(s);
  const marks = new Array(s.length).fill(false);
  for (const w of words) {
    let i = norm.indexOf(w);
    while (i >= 0) {
      for (let k = at[i]; k < at[i + w.length]; k++) marks[k] = true;
      i = norm.indexOf(w, i + w.length);
    }
  }
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    const hit = marks[i];
    if (parts.length && parts[parts.length - 1].hit === hit) parts[parts.length - 1].text += s[i];
    else parts.push({ text: s[i], hit });
  }
  return parts;
}
