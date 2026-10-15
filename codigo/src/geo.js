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
