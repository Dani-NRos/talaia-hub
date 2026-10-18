// La estación: datos de fuera (una estación meteorológica en Home Assistant, un sensor de zigbee2mqtt…) que llegan por
// MQTT y que el receptor manda a la malla como telemetría de ambiente suya, como si tuviera esos sensores. Vigía los
// guarda además como lecturas del receptor (gráficas, alarmas, histórico).
//
// Aquí, lo que comparten el servidor (que los recibe y los manda) y la pantalla (Ajustes): qué datos caben, en qué
// unidades pueden llegar, cómo se lee un valor y cómo se comprueba la configuración. Sin dependencias.
import { metricMeta, fmtWithUnit } from "./metrics.js";

/**
 * Lo que se puede mandar: campos de la telemetría de ambiente que Vigía entiende, en el orden del panel. La telemetría
 * no lleva nombres: hay un hueco por tipo de dato, así que cada uno va una vez como mucho.
 */
export const METRICAS_ESTACION = ["temperature", "relativeHumidity", "barometricPressure", "windSpeed", "windGust",
  "rainfall1h", "rainfall24h", "lux", "soilTemperature", "soilMoisture", "distance", "weight"];

/** Unidades en que puede llegar cada dato: la primera es la de Meshtastic; las otras se convierten. */
const OTRAS = {
  temperature: ["°F"], soilTemperature: ["°F"],
  windSpeed: ["km/h", "mph"], windGust: ["km/h", "mph"],
};
const A_MESHTASTIC = { "°F": (v) => ((v - 32) * 5) / 9, "km/h": (v) => v / 3.6, mph: (v) => v * 0.44704 };
export const unidades = (m) => [metricMeta(m).unit, ...(OTRAS[m] || [])];

/** Valores posibles, ya en la unidad de Meshtastic: lo de fuera suele ser una unidad equivocada (Pa por hPa…). */
const RANGO = {
  temperature: [-60, 70], soilTemperature: [-40, 70], relativeHumidity: [0, 100], barometricPressure: [300, 1100],
  windSpeed: [0, 120], windGust: [0, 150], rainfall1h: [0, 500], rainfall24h: [0, 2000], lux: [0, 200000],
  soilMoisture: [0, 100], distance: [0, 1e6], weight: [0, 1e5],
};

/**
 * Qué dato parece un tema por su nombre (el de la entidad de Home Assistant, el campo de zigbee2mqtt…): para
 * proponerlo al elegir lo encontrado en el broker. null si no se sabe o no es de los que caben (punto de rocío,
 * dirección del viento, batería…). El orden importa: la racha antes que el viento, el suelo antes que el aire.
 */
const B = "(^|[^a-z0-9])", E = "([^a-z]|$)"; // límites de palabra (el «_» de los nombres de entidad también separa)
const PISTAS = [
  [`dew|rocio|feels|apparent|sensaci|heat_?index|chill|bearing|direc|batter|linkquality|signal|rssi|${B}uv${E}`, null],
  ["gust|racha|rafaga|max_?wind|wind_?max", "windGust"],
  [`wind|viento|${B}vent${E}`, "windSpeed"],
  [`rain_?rate|precip(itation)?_?rate|${B}1_?h${E}|hourly|lluvia_?hora`, "rainfall1h"],
  ["precip|rain|lluvia|pluja|pluvi", "rainfall24h"],
  ["soil.*temp|temp.*soil|suelo.*temp|temp.*suelo", "soilTemperature"],
  ["soil|moisture|suelo", "soilMoisture"],
  ["humid|humedad|humitat", "relativeHumidity"],
  ["press|presi", "barometricPressure"],
  ["temp", "temperature"],
  [`illumin|lux|luminos|light|${B}luz${E}`, "lux"],
  ["distance|distancia", "distance"],
  ["weight|peso", "weight"],
].map(([re, m]) => [new RegExp(re), m]);
export function adivinarMetrica(tema, campo = "") {
  // Si llega un JSON, manda el campo (zigbee2mqtt: «humidity»); si no, lo último del tema que no sea «state»
  // (mqtt_statestream: base/sensor/entidad/state).
  const partes = String(tema).toLowerCase().split("/").filter((p) => p && p !== "state");
  const txt = (campo ? String(campo) : partes.at(-1) || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const [re, m] of PISTAS) if (re.test(txt)) return m;
  return null;
}
/** La unidad tal como la escribe Home Assistant, si es una de las que entiende ese dato (mbar es lo mismo que hPa). */
export function unidadDe(metrica, txt) {
  const u = String(txt || "").trim().replace(/^mbar$/i, "hPa").replace(/^km\/h$/i, "km/h");
  return unidades(metrica).includes(u) ? u : null;
}

export const ESTACION_CADA = [15, 30, 60, 180]; // minutos entre envíos
export const ESTACION_CADUCA = [0, 60, 180, 720, 1440]; // minutos sin llegar nada nuevo para no mandarlo (0: nunca)
export const ESTACION_DEFECTO = { activado: false, cada: 30, canal: 0, saltos: null, datos: [] };
export const ESTACION_MAX_SALTOS = 7;

const NO_DISPONIBLE = /^(unavailable|unknown|none|null|nan|)$/i;

/**
 * El número que trae un mensaje MQTT. Sin campo, el mensaje entero («21.4», como lo publica Home Assistant); con
 * campo, el de ese JSON («temperature» o «a.b» si va dentro de otro, como zigbee2mqtt o Shelly).
 * Devuelve { v }, { nulo: true } (no disponible: Home Assistant manda «unavailable» si el sensor no responde) o { error }.
 */
export function leerValor(carga, campo = "") {
  const s = String(carga ?? "").trim();
  let x = s;
  if (campo) {
    let j;
    try { j = JSON.parse(s); } catch { return { error: "no llega un JSON" }; }
    for (const k of campo.split(".")) {
      if (j == null || typeof j !== "object" || Array.isArray(j) || !(k in j)) return { error: `el JSON no trae «${campo}»` };
      j = j[k];
    }
    if (j == null) return { nulo: true };
    if (typeof j === "number") return Number.isFinite(j) ? { v: j } : { nulo: true };
    if (typeof j !== "string") return { error: `«${campo}» no es un número` };
    x = j.trim();
  }
  if (NO_DISPONIBLE.test(x)) return { nulo: true };
  if (!campo && /^[{[]/.test(x)) return { error: "llega un JSON: indica el campo" };
  const n = Number(/^-?\d+,\d+$/.test(x) ? x.replace(",", ".") : x);
  return Number.isFinite(n) ? { v: n } : { error: `«${x.slice(0, 30)}» no es un número` };
}

/** Pasa un valor a la unidad de Meshtastic y comprueba que sea posible. Devuelve { v } o { error }. */
export function aMeshtastic(metrica, unidad, v) {
  const f = A_MESHTASTIC[unidad];
  const x = f ? f(v) : v;
  const [lo, hi] = RANGO[metrica] || [-Infinity, Infinity];
  if (!(x >= lo && x <= hi)) return { error: `${fmtWithUnit(metrica, x)} no es normal: ¿está bien la unidad?` };
  return { v: Math.round(x * 100) / 100 };
}

/** «Temperatura 21,4 °C · Humedad 60 %», en el orden del panel. */
export function textoValores(vals) {
  return METRICAS_ESTACION.filter((m) => m in vals).map((m) => `${metricMeta(m).label} ${fmtWithUnit(m, vals[m])}`).join(" · ");
}

/** Siguiente envío: múltiplos del intervalo desde la medianoche (cada 30 min, a las y media y en punto). */
export function proximoEnvio(ahora, cadaMin) {
  const d = new Date(ahora);
  d.setHours(0, 0, 0, 0);
  const paso = cadaMin * 60000;
  return d.getTime() + (Math.floor((ahora - d.getTime()) / paso) + 1) * paso;
}

const entero = (x) => Number.isInteger(x);

/**
 * Comprueba y completa una configuración nueva (lo que no venga se queda como estaba).
 * temaProhibido(tema): texto si ese tema no vale (lo que publica el propio Vigía, para no hacer un bucle).
 * Devuelve { cfg } o { error } con el motivo en español.
 */
export function comprobarEstacion(dada, antes = ESTACION_DEFECTO, temaProhibido = () => null) {
  const c = { ...ESTACION_DEFECTO, ...antes, ...dada };
  c.activado = !!c.activado;
  c.cada = Number(c.cada);
  if (!ESTACION_CADA.includes(c.cada)) return { error: "Elige cada cuánto se manda." };
  if (c.canal != null && !(entero(c.canal) && c.canal >= 0 && c.canal <= 7)) return { error: "El canal no es válido." };
  if (c.saltos != null && !(entero(c.saltos) && c.saltos >= 1 && c.saltos <= ESTACION_MAX_SALTOS)) return { error: "Los saltos no son válidos." };
  if (!Array.isArray(c.datos) || c.datos.length > METRICAS_ESTACION.length) return { error: "La lista de datos no es válida." };
  const vistos = new Set();
  const datos = [];
  for (const d of c.datos) {
    if (!d || typeof d !== "object") return { error: "La lista de datos no es válida." };
    const m = d.metrica;
    if (!METRICAS_ESTACION.includes(m)) return { error: "Elige qué dato es cada uno." };
    const nombre = metricMeta(m).label;
    if (vistos.has(m)) return { error: `«${nombre}» está dos veces: la telemetría solo tiene un hueco para cada dato.` };
    vistos.add(m);
    const tema = String(d.tema ?? "").trim();
    const campo = String(d.campo ?? "").trim();
    if (!tema) return { error: `Falta el tema MQTT de «${nombre}».` };
    if (/[+#\0]/.test(tema)) return { error: `El tema de «${nombre}» no puede llevar «+» ni «#»: tiene que ser uno concreto.` };
    if (tema.length > 250 || campo.length > 100) return { error: `El tema o el campo de «${nombre}» es demasiado largo.` };
    if (campo && campo.split(".").some((p) => !p)) return { error: `El campo de «${nombre}» no es válido (por ejemplo, temperature o datos.temperatura).` };
    const prohibido = temaProhibido(tema);
    if (prohibido) return { error: `«${nombre}»: ${prohibido}` };
    const unidad = d.unidad || unidades(m)[0];
    if (!unidades(m).includes(unidad)) return { error: `La unidad de «${nombre}» no es válida.` };
    const caduca = Number(d.caduca || 0);
    if (!ESTACION_CADUCA.includes(caduca)) return { error: `Elige cuándo deja de mandarse «${nombre}» si no llega nada nuevo.` };
    datos.push({ metrica: m, tema, campo, unidad, caduca });
  }
  c.datos = datos;
  if (c.activado && c.canal == null) return { error: "Elige por qué canal se manda." };
  if (c.activado && !datos.length) return { error: "Añade al menos un dato para mandar." };
  return { cfg: { activado: c.activado, cada: c.cada, canal: c.canal, saltos: c.saltos, datos } };
}
