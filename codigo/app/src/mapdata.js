// Datos y escalas del mapa: qué nodos se pintan, con qué valor, color y opacidad.
// Sin Leaflet ni DOM, para poder probarlo con node --test.
import { metricMeta, sortMetrics, fmtValue } from "@vigia/nucleo/metrics.js";
import { readingPlace, placeFromPos, precisionM } from "@vigia/nucleo/geo.js";

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/* ── periodos del filtro de antigüedad ── */
export const AGES = [
  { key: "3h", ms: 3 * HOUR }, // names in i18n.js: map.age.3h…
  { key: "24h", ms: DAY },
  { key: "7d", ms: 7 * DAY },
  { key: "all", ms: Infinity },
];
export const ageMs = (key) => (AGES.find((a) => a.key === key) || AGES[1]).ms;

/** Métricas que tienen sentido en el mapa: las de sensor y batería, no las de uso del canal. */
const mappable = (k) => !metricMeta(k).minor;

/** Lectura de la métrica k del nodo n si cae dentro del periodo, o null. */
function readingOf(n, k, maxAge, now) {
  const m = n.metrics?.[k];
  if (!m || typeof m.v !== "number" || !Number.isFinite(m.v)) return null;
  return now - m.t <= maxAge ? m : null;
}

/** Cuántos nodos con ubicación tienen cada métrica en el periodo, ordenadas como en el panel. */
export function metricCounts(nodes, maxAge, now = Date.now()) {
  const c = new Map();
  for (const n of nodes) {
    if (!n.pos) continue;
    for (const k of Object.keys(n.metrics || {})) {
      if (mappable(k) && readingOf(n, k, maxAge, now)) c.set(k, (c.get(k) || 0) + 1);
    }
  }
  return new Map(sortMetrics([...c.keys()]).map((k) => [k, c.get(k)]));
}

/** Métrica que se enseña si el usuario no ha elegido otra: temperatura si la hay, si no la más extendida. */
export function defaultMetric(counts, wanted = null) {
  if (wanted && counts.get(wanted)) return wanted;
  if (counts.get("temperature")) return "temperature";
  let best = null, bestN = 0;
  for (const [k, v] of counts) if (v > bestN) { best = k; bestN = v; }
  return best;
}

/**
 * Puntos del mapa para la métrica elegida. focus: nodo que se ha pedido ver desde su ficha (y extra, un Set con
 * los nodos de una ruta trazada); sale siempre,
 * con su última lectura aunque sea más vieja que el periodo, o como punto gris si no tiene esa métrica.
 * Cada punto: { num, lat, lon, v, t, far, acc } — far: la lectura se midió antes de que el nodo llegara a donde está;
 * acc: radio en metros de la zona donde puede estar el nodo (posición recortada por el canal), o null si es exacta o no se sabe.
 * Los nodos con ubicación oídos en el periodo pero sin esa métrica van aparte, en «others».
 */
export function mapPoints(nodes, metric, maxAge, now = Date.now(), focus = null, extra = null) {
  const points = [], others = [];
  for (const n of nodes) {
    if (!n.pos) continue;
    const isFocus = n.num === focus || !!extra?.has(n.num); // extra: nodos de la ruta que se está viendo
    const r = metric ? readingOf(n, metric, isFocus ? Infinity : maxAge, now) : null;
    if (r) {
      const place = n.place || placeFromPos(n.pos);
      points.push({ num: n.num, lat: n.pos.lat, lon: n.pos.lon, v: r.v, t: r.t, far: readingPlace(place, r.t) === "elsewhere", acc: precisionM(n.pos.bits) });
    } else if (isFocus || now - (n.lastHeard || n.pos.t || 0) <= maxAge) {
      others.push({ num: n.num, lat: n.pos.lat, lon: n.pos.lon, acc: precisionM(n.pos.bits) });
    }
  }
  return { points, others };
}

/**
 * Coloca las píldoras sin que se pisen: con varios nodos en un pueblo (o todos en la misma celda del canal
 * público) se taparían, y la que queda debajo puede ser justo la de la alarma.
 * items: [{ key, x, y, w, h }] en píxeles de pantalla y por prioridad (la primera se queda en su sitio).
 * Las demás se desplazan en vertical, arriba y abajo alternando, a escalones de su alto.
 * Devuelve Map key → desplazamiento vertical en px.
 */
export function declutter(items, gap = 3, maxSteps = 6) {
  const placed = [], out = new Map();
  const rectAt = (it, dy) => ({ l: it.x - it.w / 2, r: it.x + it.w / 2, t: it.y + dy - it.h / 2, b: it.y + dy + it.h / 2 });
  const hits = (a) => placed.some((p) => a.l < p.r + gap && a.r > p.l - gap && a.t < p.b + gap && a.b > p.t - gap);
  for (const it of items) {
    let dy = 0;
    for (let s = 0; s <= maxSteps * 2; s++) {
      const k = Math.ceil(s / 2) * (s % 2 ? -1 : 1); // 0, −1, +1, −2, +2…
      if (!hits(rectAt(it, k * (it.h + gap)))) { dy = k * (it.h + gap); break; }
    }
    placed.push(rectAt(it, dy)); // si no hay hueco, se queda en su sitio aunque pise
    out.set(it.key, dy);
  }
  return out;
}

/** Opacidad según la antigüedad de la lectura: lo viejo se ve, pero apagado. */
export function ageOpacity(age) {
  if (age <= HOUR) return 1;
  if (age <= 6 * HOUR) return 0.85;
  if (age <= DAY) return 0.65;
  return 0.45;
}

/** Texto corto para la píldora: 18,4° · 66 % · 1012 · 3,91 V. */
export function pillText(metric, v) {
  const s = fmtValue(metric, v);
  if (s === "USB") return s;
  const u = metricMeta(metric).unit;
  if (u === "°C") return `${s}°`;
  if (u === "hPa" || !u) return s;
  return `${s} ${u}`;
}

/* ── color ──
 * Diverging (temperatura: frío ↔ calor, gris neutro en medio) y secuencial (un solo tono, claro → oscuro).
 * Pasos de azul de la paleta de referencia; el brazo rojo, con la misma luminosidad OKLCH que el azul.
 * Se interpola en OKLab para que los pasos se vean iguales de separados.
 */
const BLUE = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]; // 100…700 de dos en dos
// Rojo con el tono de #e34948 y la luminosidad OKLCH de los pasos 300/500/700 del azul (brazos simétricos).
const DIVERGING = ["#0d366b", "#256abf", "#6da7ec", "#f0efec", "#e7837c", "#b43b3a", "#641819"];

/** Rangos fijos donde el valor tiene un significado absoluto; el resto se ajusta a lo que hay en el mapa. */
const FIXED = {
  temperature: { kind: "div", lo: -2, mid: 18, hi: 38 },
  soilTemperature: { kind: "div", lo: -2, mid: 18, hi: 38 },
  relativeHumidity: { kind: "seq", lo: 0, hi: 100 },
  soilMoisture: { kind: "seq", lo: 0, hi: 100 },
  batteryLevel: { kind: "seq", lo: 0, hi: 100 },
};

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function rgb2lab([r, g, b]) {
  [r, g, b] = [r, g, b].map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function lab2rgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map((c) => Math.min(1, Math.max(0, toSrgb(c))));
}
const rgb2hex = (rgb) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
const LABS = new Map();
const lab = (h) => LABS.get(h) || (LABS.set(h, rgb2lab(hex2rgb(h))), LABS.get(h));

/** Color en la posición f (0…1) de una rampa de pasos hex. */
function ramp(stops, f) {
  const x = Math.min(1, Math.max(0, f)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), u = x - i;
  const a = lab(stops[i]), b = lab(stops[i + 1]);
  return rgb2hex(lab2rgb(a.map((v, j) => v + (b[j] - v) * u)));
}

/** Tinta legible sobre un fondo: oscura en los claros, blanca en los oscuros (contraste WCAG). */
export function inkFor(bg) {
  const Y = (h) => { const [r, g, b] = hex2rgb(h).map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const y = Y(bg);
  const dark = (y + 0.05) / (Y("#152320") + 0.05), light = 1.05 / (y + 0.05);
  return dark >= light ? "#152320" : "#ffffff";
}

/**
 * Escala de color para una métrica y los valores que se ven.
 * Devuelve { kind, lo, mid, hi, color(v), stops } — stops sirve para dibujar la leyenda.
 */
export function scaleFor(metric, values) {
  const vals = values.filter((v) => Number.isFinite(v)).map((v) => (metric === "batteryLevel" && v > 100 ? 100 : v));
  const fx = FIXED[metric];
  if (fx?.kind === "div") {
    const color = (v) => (v <= fx.mid ? ramp(DIVERGING.slice(0, 4), (v - fx.lo) / (fx.mid - fx.lo)) : ramp(DIVERGING.slice(3), (v - fx.mid) / (fx.hi - fx.mid)));
    return { kind: "div", lo: fx.lo, mid: fx.mid, hi: fx.hi, color, stops: DIVERGING };
  }
  let lo = fx ? fx.lo : Math.min(...vals), hi = fx ? fx.hi : Math.max(...vals);
  if (!vals.length) { lo = 0; hi = 1; }
  if (hi - lo < 1e-9) return { kind: "one", lo, hi, color: () => BLUE[3], stops: [BLUE[3], BLUE[3]] };
  return { kind: "seq", lo, hi, color: (v) => ramp(BLUE, (v - lo) / (hi - lo)), stops: BLUE };
}
