// Cálculos de posición: distancia, rumbo, precisión de Meshtastic y formato.

const R = 6371008.8; // radio medio de la Tierra, m
const rad = (d) => (d * Math.PI) / 180;

/** Distancia en metros entre dos puntos {lat, lon} (fórmula del haversine). */
export function distM(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const ROSE = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
/** Dirección de a hacia b en 8 puntos de la rosa de los vientos. */
export function compass(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return ROSE[Math.round(deg / 45) % 8];
}

/**
 * Precisión aproximada en metros según los bits que comparte el canal (tabla de Meshtastic:
 * 10 bits ≈ 23,3 km … 15 bits ≈ 729 m … 19 bits ≈ 45 m). 0 o 32 = desconocida o completa.
 */
export function precisionM(bits) {
  if (!bits || bits >= 32) return null;
  return 23300 / 2 ** (bits - 10);
}

const nf = (d) => new Intl.NumberFormat("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d });
const nf0 = nf(0), nf1 = nf(1);
export function fmtDist(m) {
  if (m < 1000) return `${nf0.format(m < 100 ? Math.round(m) : Math.round(m / 10) * 10)} m`;
  return `${(m < 10000 ? nf1 : nf0).format(m / 1000)} km`;
}

/** Coordenadas con punto decimal, como las entienden los mapas al pegarlas. */
export const coordText = (p) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
export const mapsUrl = (p) => `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

export const SOURCE = { 1: "fijada a mano", 2: "GPS del nodo", 3: "GPS externo o del móvil" };

/* ── Sitio actual del nodo, sin guardar recorrido ──
 * place = { lat, lon, since, moved, bits }
 *   lat/lon: primera posición recibida en este sitio (el ancla; no se arrastra con cada posición).
 *   bits:    precisión con que llegó el ancla.
 *   since:   hora de esa primera posición, es decir, desde cuándo consta que está aquí.
 *   moved:   true si llegó aquí desde otro sitio; un nodo que nunca se ha movido no tiene lecturas «de otro sitio».
 * Se compara siempre con el ancla, no con la posición anterior: así también se detecta a quien avanza a pasos cortos.
 */
export const MOVE_MIN_M = 200;
const SAME_PLACE_SLACK_MS = 60000; // desfase admitido entre la hora de la posición (GPS del nodo) y la de la lectura (móvil)

/** Distancia a partir de la cual dos posiciones son sitios distintos. Con la posición recortada del canal
 *  público (≈730 m) el ruido es de una celda entera, así que el umbral crece con la imprecisión. */
export function moveThreshold(bits) {
  const p = precisionM(bits);
  return Math.max(MOVE_MIN_M, p ? 1.5 * p : 0);
}

/** Sitio que corresponde tras recibir pos ({lat, lon, t, bits}). Devuelve el mismo objeto si no ha cambiado de sitio. */
export function nextPlace(place, pos) {
  if (!place) return placeFromPos(pos);
  const thr = Math.max(moveThreshold(pos.bits), moveThreshold(place.bits));
  if (distM(place, pos) <= thr) return place;
  return { lat: pos.lat, lon: pos.lon, since: pos.t, moved: true, bits: pos.bits || 0 };
}

/** Sitio inicial para un nodo guardado antes de que existiera place: lo que hay es su última posición. */
export function placeFromPos(pos) {
  return pos ? { lat: pos.lat, lon: pos.lon, since: pos.t, moved: false, bits: pos.bits || 0 } : null;
}

/**
 * ¿Dónde se midió una lectura de hora t respecto a la posición actual del nodo?
 *   "here"      → en el sitio donde está ahora (o el nodo no se ha movido nunca);
 *   "elsewhere" → antes de llegar aquí: se midió en otro sitio o por el camino.
 */
export function readingPlace(place, t) {
  if (!place || !place.moved) return "here";
  return t >= place.since - SAME_PLACE_SLACK_MS ? "here" : "elsewhere";
}
