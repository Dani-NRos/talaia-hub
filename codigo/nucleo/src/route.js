// Traceroute: lectura de la ruta que devuelve un nodo y calidad de cada salto.
// Sin DOM, para poder probarlo con node --test.

/** Nodo que repite sin tener la clave del canal: no puede apuntarse, el firmware deja este hueco. */
export const UNKNOWN_NODE = 0xffffffff;
const UNK_SNR = -128;

/**
 * Ruta de ida y vuelta a partir del RouteDiscovery de la respuesta.
 * origin: nuestro receptor (to de la respuesta); dest: el nodo trazado (from de la respuesta).
 * Cada tramo: { nodes: [num…] de punta a punta, snr: [dB|null] por salto, medido por el nodo que recibe }.
 * back es null si la vuelta no viene completa (algún nodo con firmware anterior a 2.5, o sin hop_start).
 */
export function readTrace(rd, origin, dest, hasHopStart = true) {
  const leg = (mid, snrs, from, to) => {
    const nodes = [from, ...mid, to];
    const ok = snrs.length === mid.length + 1;
    return { nodes, snr: nodes.slice(1).map((_, i) => (ok && snrs[i] !== UNK_SNR ? snrs[i] / 4 : null)) };
  };
  const fwd = leg(rd.route, rd.snrTowards, origin, dest);
  const back = hasHopStart && rd.snrBack.length === rd.routeBack.length + 1 ? leg(rd.routeBack, rd.snrBack, dest, origin) : null;
  return { fwd, back };
}

/** Nodos intermedios de un tramo (sin las puntas). */
export const relays = (leg) => leg.nodes.slice(1, -1);

/* ── calidad del enlace ──
 * El SNR mínimo que se descodifica depende del factor de dispersión (SF) del preset: con LongFast (SF11),
 * −17,5 dB. Margen de 10 dB o más: buena; de 4 a 10: justa; menos de 4: al límite.
 */
const SF_LIMIT = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };
const PRESET_SF = { 0: 11, 1: 12, 2: 12, 3: 10, 4: 9, 5: 8, 6: 7, 7: 11, 8: 7 };
export const PRESET_NAME = { 0: "LongFast", 1: "LongSlow", 2: "VeryLongSlow", 3: "MediumSlow", 4: "MediumFast", 5: "ShortSlow", 6: "ShortFast", 7: "LongModerate", 8: "ShortTurbo" };

/** SF de la configuración LoRa del receptor ({ usePreset, modemPreset, spreadFactor }); 11 si no se sabe. */
export function loraSf(lora) {
  if (!lora) return 11;
  if (lora.usePreset === false && lora.spreadFactor >= 7 && lora.spreadFactor <= 12) return lora.spreadFactor;
  return PRESET_SF[lora.modemPreset ?? 0] ?? 11;
}

/** "ok" | "warn" | "bad" | null (sin dato). */
export function snrQuality(snr, sf = 11) {
  if (snr == null || !Number.isFinite(snr)) return null;
  const margin = snr - (SF_LIMIT[sf] ?? SF_LIMIT[11]);
  if (margin >= 10) return "ok";
  if (margin >= 4) return "warn";
  return "bad";
}

/** El enlace más flojo de la ida y la vuelta: { snr, from, to, leg } o null. */
export function weakest(trace) {
  let w = null;
  for (const [name, leg] of [["fwd", trace.fwd], ["back", trace.back]]) {
    if (!leg) continue;
    leg.snr.forEach((s, i) => {
      if (s != null && (!w || s < w.snr)) w = { snr: s, from: leg.nodes[i], to: leg.nodes[i + 1], leg: name };
    });
  }
  return w;
}

/** Espera máxima según los saltos que se le conocen al nodo (los traceroutes largos tardan). */
export const traceTimeout = (hops) => Math.min(150000, 60000 + 20000 * (Number.isFinite(hops) ? Math.max(0, hops) : 2));
