// Datos que llegan por MQTT a los paneles (Vigía servidor): una estación meteorológica de Home Assistant, un Shelly, un
// sensor de zigbee2mqtt… Cada dato es de un panel (el de un nodo Meshtastic o uno sin nodo), tiene su nombre y su tipo,
// y se guarda como una lectura más de ese panel con su propia clave («mq3»): gráficas, alarmas e histórico como las de
// un nodo. Los del panel del receptor pueden salir además a la malla como telemetría suya («Mandar a la malla»).
//
// Además de números, estados ON/OFF (un enchufe, una puerta, un detector de agua): se guardan como 1 y 0 y se enseñan
// con los nombres que se elijan («Abierta»/«Cerrada»). Y, en un panel sin nodo, el tema donde el dispositivo dice si
// está conectado (el LWT de Tasmota, el «online» de Shelly, el «availability» de zigbee2mqtt).
//
// Aquí, lo que comparten el servidor (que los recibe) y la pantalla (que los configura): los tipos, sus unidades, cómo
// se lee un valor, qué dato parece cada tema y cómo se comprueba la configuración. Sin dependencias.
import { fmtNum } from "./metrics.js";

/**
 * Tipos de dato. La unidad es la de Vigía (y la de Meshtastic, si sale a la malla); «otras», las que se convierten.
 * malla: el tipo es un campo de la telemetría de ambiente de Meshtastic (con el mismo nombre) y puede salir por ella.
 * rango: valores posibles, ya convertidos: lo de fuera suele ser una unidad equivocada (Pa por hPa…).
 */
const F = (v) => ((v - 32) * 5) / 9;
const KMH = (v) => v / 3.6, MPH = (v) => v * 0.44704, MIL = (v) => v / 1000, X1000 = (v) => v * 1000, X10 = (v) => v * 10, IGUAL = (v) => v;
export const TIPOS = {
  temperature:        { label: "Temperatura",   unit: "°C",    dec: 1, hyst: 0.3,  otras: { "°F": F }, rango: [-90, 400], malla: true },
  relativeHumidity:   { label: "Humedad",       unit: "%",     dec: 0, hyst: 2,    rango: [0, 100], malla: true },
  barometricPressure: { label: "Presión",       unit: "hPa",   dec: 0, hyst: 1,    otras: { mbar: IGUAL }, rango: [300, 1100], malla: true },
  windSpeed:          { label: "Viento",        unit: "m/s",   dec: 1, hyst: 0.5,  otras: { "km/h": KMH, mph: MPH }, rango: [0, 120], malla: true },
  windGust:           { label: "Racha",         unit: "m/s",   dec: 1, hyst: 0.5,  otras: { "km/h": KMH, mph: MPH }, rango: [0, 150], malla: true },
  rainfall1h:         { label: "Lluvia 1 h",    unit: "mm",    dec: 1, hyst: 0.2,  rango: [0, 500], malla: true },
  rainfall24h:        { label: "Lluvia 24 h",   unit: "mm",    dec: 1, hyst: 0.5,  rango: [0, 2000], malla: true },
  lux:                { label: "Luz",           unit: "lx",    dec: 0, hyst: 5,    rango: [0, 200000], malla: true },
  soilTemperature:    { label: "Temp. suelo",   unit: "°C",    dec: 1, hyst: 0.3,  otras: { "°F": F }, rango: [-40, 70], malla: true },
  soilMoisture:       { label: "Humedad suelo", unit: "%",     dec: 0, hyst: 2,    rango: [0, 100], malla: true },
  power:              { label: "Potencia",      unit: "W",     dec: 0, hyst: 5,    otras: { kW: X1000 }, rango: [-1e6, 1e6] },
  energy:             { label: "Energía",       unit: "kWh",   dec: 2, hyst: 0.01, otras: { Wh: MIL }, rango: [0, 1e9] },
  voltage:            { label: "Tensión",       unit: "V",     dec: 1, hyst: 1,    rango: [0, 1000] },
  currentA:           { label: "Corriente",     unit: "A",     dec: 2, hyst: 0.05, otras: { mA: MIL }, rango: [-1000, 1000] },
  batteryLevel:       { label: "Batería",       unit: "%",     dec: 0, hyst: 2,    rango: [0, 101] },
  co2:                { label: "CO₂",           unit: "ppm",   dec: 0, hyst: 20,   rango: [0, 50000] },
  pm25Standard:       { label: "PM2,5",         unit: "µg/m³", dec: 0, hyst: 2,    rango: [0, 2000] },
  distance:           { label: "Distancia",     unit: "mm",    dec: 0, hyst: 5,    otras: { cm: X10, m: X1000 }, rango: [0, 1e7], malla: true },
  weight:             { label: "Peso",          unit: "kg",    dec: 2, hyst: 0.05, otras: { g: MIL }, rango: [0, 1e5], malla: true },
  signal:             { label: "Señal",         unit: "dBm",   dec: 0, hyst: 3,    rango: [-150, 30] },
  estado:             { label: "Estado ON/OFF", unit: "",      dec: 0, hyst: 0, binario: true }, // 1 y 0, con nombres
  otro:               { label: "Otro número",   unit: "",      dec: 2, hyst: 0 }, // unidad libre, sin convertir
};
export const LISTA_TIPOS = Object.keys(TIPOS);
export const tipoMalla = (t) => !!TIPOS[t]?.malla;
export const esEstado = (t) => !!TIPOS[t]?.binario;
/** Unidades en que puede llegar un tipo: la primera es la de Vigía. «otro»: ninguna fija (la escribe el usuario). */
export const unidades = (t) => (t === "otro" ? [] : [TIPOS[t].unit, ...Object.keys(TIPOS[t].otras || {})]);

/** Cómo se llaman los dos estados (ON, OFF) de un dato ON/OFF. */
export const NOMBRES_ESTADO = {
  encendido: ["Encendido", "Apagado"],
  abierta: ["Abierta", "Cerrada"],
  abierto: ["Abierto", "Cerrado"],
  agua: ["Hay agua", "Seco"],
  movimiento: ["Movimiento", "Sin movimiento"],
  si: ["Sí", "No"],
  on: ["ON", "OFF"],
};
export const nombresEstado = (clave) => NOMBRES_ESTADO[clave] || NOMBRES_ESTADO.encendido;
/** El nombre de un estado: 1 → «Abierta», 0 → «Cerrada». */
export const textoEstado = (clave, v) => nombresEstado(clave)[v ? 0 : 1];

/** Qué es un panel sin nodo: solo para la etiqueta (y, más adelante, para proponer temas). */
export const TIPOS_PANEL = {
  shelly: { label: "Shelly", corto: "SHLY" },
  tasmota: { label: "Tasmota", corto: "TASM" },
  sonoff: { label: "Sonoff", corto: "SONF" },
  zigbee: { label: "Zigbee", corto: "ZIGB" },
  esphome: { label: "ESPHome", corto: "ESPH" },
  homeassistant: { label: "Home Assistant", corto: "HA" },
  otro: { label: "MQTT", corto: "MQTT" },
};

/** Las claves de los datos MQTT en las lecturas, las alarmas y las gráficas: «mq1», «mq2»… */
export const esClaveMqtt = (k) => /^mq\d+$/.test(k);
export const nombreDato = (d) => d.nombre || TIPOS[d.tipo]?.label || "Dato";

/** Lo que necesita la pantalla para enseñar un dato como una métrica más (nombre, unidad, decimales). */
export function metaDato(d, i = 0) {
  const t = TIPOS[d.tipo] || TIPOS.otro;
  const m = { label: nombreDato(d), unit: d.tipo === "otro" ? d.unidad || "" : t.unit, dec: t.dec, hyst: t.hyst, order: 100 + i, tipo: d.tipo };
  if (t.binario) m.estados = nombresEstado(d.nombres); // así se enseña el valor: «Abierta» en vez de 1
  return m;
}
/** De la configuración de los paneles, la de todas sus métricas MQTT: { mq1: { label, unit… } }. */
export function metasDe(paneles) {
  const out = {};
  for (const p of Object.values(paneles || {})) (p.datos || []).forEach((d, i) => { out[d.clave] = metaDato(d, i); });
  return out;
}

/**
 * Qué tipo parece un tema por su nombre (el de la entidad de Home Assistant, el campo de zigbee2mqtt o Tasmota…),
 * para proponerlo al elegir lo encontrado en el broker. null si no se sabe o no es de los que hay (punto de rocío,
 * dirección del viento, factor de potencia…). El orden importa: la racha antes que el viento, el suelo antes que el aire.
 */
const B = "(^|[^a-z0-9])", E = "([^a-z]|$)"; // límites de palabra (el «_» de los nombres de entidad también separa)
const PISTAS = [
  [`dew|rocio|feels|apparent|sensaci|heat_?index|chill|bearing|direc|factor|linkquality|${B}uv${E}|${B}pf${E}`, null],
  ["gust|racha|rafaga|max_?wind|wind_?max", "windGust"],
  [`wind|viento|${B}vent${E}`, "windSpeed"],
  [`rain_?rate|precip(itation)?_?rate|${B}1_?h${E}|hourly|lluvia_?hora`, "rainfall1h"],
  ["precip|rain|lluvia|pluja|pluvi", "rainfall24h"],
  ["soil.*temp|temp.*soil|suelo.*temp|temp.*suelo", "soilTemperature"],
  ["soil|moisture|suelo", "soilMoisture"],
  ["humid|humedad|humitat", "relativeHumidity"],
  ["press|presi", "barometricPressure"],
  ["temp", "temperature"],
  [`energy|energia|kwh|${B}total${E}`, "energy"],
  [`power|potencia|watt|${B}apower${E}`, "power"],
  ["volt|tension", "voltage"],
  ["current|corriente|amper", "currentA"],
  ["batter|bateria", "batteryLevel"],
  ["co2", "co2"],
  ["pm2|pm25", "pm25Standard"],
  ["rssi|signal|senal", "signal"],
  [`illumin|lux|luminos|light|${B}luz${E}`, "lux"],
  ["distance|distancia", "distance"],
  ["weight|peso", "weight"],
].map(([re, m]) => [new RegExp(re), m]);
const limpio = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
function pista(txt) {
  for (const [re, m] of PISTAS) if (re.test(txt)) return { m };
  return null;
}
export function adivinarTipo(tema, campo = "") {
  // Con un JSON manda el campo: primero su última parte («ENERGY.Power» → power), luego entero («aenergy.total»).
  // Sin JSON, lo último del tema que no sea «state» (mqtt_statestream: base/sensor/entidad/state).
  if (campo) return (pista(limpio(String(campo).split(".").at(-1))) || pista(limpio(campo)))?.m ?? null;
  const partes = String(tema).toLowerCase().split("/").filter((p) => p && p !== "state");
  return pista(limpio(partes.at(-1)))?.m ?? null;
}
/** La unidad tal como la escribe Home Assistant, si es una de las de ese tipo. */
export function unidadDe(tipo, txt) {
  const u = String(txt || "").trim();
  return unidades(tipo).find((x) => x.toLowerCase() === u.toLowerCase()) || null;
}

/**
 * Para un estado encontrado en el broker: qué nombres le van por el tema o el campo y si va al revés. El «contact» de
 * zigbee2mqtt es true cuando la puerta está cerrada (hay contacto): al revés. El de Home Assistant («on»: abierta), no.
 */
export function adivinarEstado(tema, campo = "") {
  const txt = limpio(campo ? String(campo).split(".").at(-1) : String(tema).split("/").filter((p) => p && p !== "state").at(-1));
  if (/^contact$/.test(txt)) return { nombres: "abierta", invertir: true };
  if (/door|puerta|window|ventana|contact|garage|garaje|gate|portal/.test(txt)) return { nombres: "abierta", invertir: false };
  if (/leak|water|agua|flood|inunda|moist/.test(txt)) return { nombres: "agua", invertir: false };
  if (/occupan|motion|presen|movim|pir/.test(txt)) return { nombres: "movimiento", invertir: false };
  return { nombres: "encendido", invertir: false };
}

/** ¿Es el tema donde un dispositivo dice si está conectado? (Tasmota: …/LWT; Shelly: …/online; zigbee2mqtt: …/availability) */
export function pareceConexion(tema, campo = "", texto = "") {
  const x = String(texto).trim().toLowerCase();
  if (/^(online|offline|connected|disconnected)$/.test(x)) return true;
  const ultimo = String(tema).toLowerCase().split("/").filter(Boolean).at(-1) || "";
  return /^(lwt|online|availability|available|status|connected)$/.test(ultimo) && /^(true|false|1|0|on|off)$/.test(x) && !campo;
}

const NO_DISPONIBLE = /^(unavailable|unknown|none|null|nan|)$/i;

/**
 * El número que trae un mensaje MQTT. Sin campo, el mensaje entero («21.4», como lo publica Home Assistant); con
 * campo, el de ese JSON («temperature» o «a.b» si va dentro de otro, como zigbee2mqtt, Tasmota o Shelly).
 * Devuelve { v }, { nulo: true } (no disponible: Home Assistant manda «unavailable» si el sensor no responde) o { error }.
 * Si el JSON no trae el campo, { error, falta: true }: hay temas con mensajes de varias clases (el «events/rpc» de los
 * Shelly manda a veces solo la potencia), y ese mensaje no es para este dato.
 */
export function leerValor(carga, campo = "") {
  const s = String(carga ?? "").trim();
  let x = s;
  if (campo) {
    let j;
    try { j = JSON.parse(s); } catch { return { error: "no llega un JSON" }; }
    for (const k of campo.split(".")) {
      if (j == null || typeof j !== "object" || Array.isArray(j) || !(k in j)) return { error: `el JSON no trae «${campo}»`, falta: true };
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

const ES_ON = /^(on|true|1|yes|si|sí|open|opened|abierto|abierta|online|connected|conectado|detected|wet|occupied|motion|active|high|encendido|power_on|running)$/i;
const ES_OFF = /^(off|false|0|no|closed|close|cerrado|cerrada|offline|disconnected|desconectado|clear|dry|unoccupied|inactive|low|apagado|power_off|stopped)$/i;

/**
 * Un estado ON/OFF de un mensaje MQTT (sin campo, el mensaje entero: «ON», «on», «true», «1», «open», «online»…; con
 * campo, el de ese JSON, que también puede ser true/false o 1/0). invertir: el dispositivo dice ON cuando es OFF.
 * Devuelve { v: 1 | 0 }, { nulo: true } o { error }.
 */
export function leerEstado(carga, campo = "", invertir = false) {
  let x = String(carga ?? "").trim();
  if (campo) {
    let j;
    try { j = JSON.parse(x); } catch { return { error: "no llega un JSON" }; }
    for (const k of campo.split(".")) {
      if (j == null || typeof j !== "object" || Array.isArray(j) || !(k in j)) return { error: `el JSON no trae «${campo}»`, falta: true };
      j = j[k];
    }
    if (j == null) return { nulo: true };
    if (typeof j === "boolean") return { v: j !== invertir ? 1 : 0 };
    if (typeof j !== "string" && typeof j !== "number") return { error: `«${campo}» no es un estado ON/OFF` };
    x = String(j).trim();
  }
  if (NO_DISPONIBLE.test(x)) return { nulo: true };
  if (!campo && /^[{[]/.test(x)) return { error: "llega un JSON: indica el campo" };
  const on = ES_ON.test(x), off = !on && ES_OFF.test(x);
  if (!on && !off) return { error: `«${x.slice(0, 30)}» no es un estado ON/OFF` };
  return { v: on !== invertir ? 1 : 0 };
}
/** ¿Parece un estado (y no un número)? Para buscar temas. */
export const pareceEstado = (x) => typeof x === "boolean" || (typeof x === "string" && !/^-?\d/.test(x.trim()) && (ES_ON.test(x.trim()) || ES_OFF.test(x.trim())));

/** Un valor con su unidad, para los textos: «21,4 °C». */
export function textoValor(tipo, v, unidad = null) {
  const t = TIPOS[tipo] || TIPOS.otro;
  const u = tipo === "otro" ? unidad || "" : t.unit;
  return u ? `${fmtNum(v, t.dec)} ${u}` : fmtNum(v, t.dec);
}

/** El valor de un dato, para los textos: «21,4 °C» o, si es un estado, «Abierta». */
export const textoDato = (d, v) => (esEstado(d.tipo) ? textoEstado(d.nombres, v) : textoValor(d.tipo, v, d.unidad));

/** Pasa un valor a la unidad de Vigía y comprueba que sea posible. Devuelve { v } o { error }. */
export function convertir(tipo, unidad, v) {
  const t = TIPOS[tipo] || TIPOS.otro;
  const f = t.otras?.[unidad];
  const x = f ? f(v) : v;
  const [lo, hi] = t.rango || [-Infinity, Infinity];
  if (!(x >= lo && x <= hi)) return { error: `${textoValor(tipo, x, unidad)} no es normal: ¿está bien la unidad?` };
  return { v: Math.round(x * 1e4) / 1e4 };
}

/** «Temperatura 21,4 °C · Humedad 60 %» de lo que sale a la malla ({ tipo: valor }), en el orden de los tipos. */
export function textoValores(vals) {
  return LISTA_TIPOS.filter((t) => t in vals).map((t) => `${TIPOS[t].label} ${textoValor(t, vals[t])}`).join(" · ");
}

/** Siguiente envío a la malla: múltiplos del intervalo desde la medianoche (cada 30 min, en punto y a las y media). */
export function proximoEnvio(ahora, cadaMin) {
  const d = new Date(ahora);
  d.setHours(0, 0, 0, 0);
  const paso = cadaMin * 60000;
  return d.getTime() + (Math.floor((ahora - d.getTime()) / paso) + 1) * paso;
}

export const MALLA_CADA = [15, 30, 60, 180]; // minutos entre envíos
export const CADUCA = [0, 60, 180, 720, 1440]; // minutos sin llegar nada nuevo para no mandarlo a la malla (0: nunca)
export const MALLA_DEFECTO = { activado: false, cada: 30, canal: 0, saltos: null };
export const MALLA_MAX_SALTOS = 7;
export const MAX_DATOS = 40; // por panel

const entero = (x) => Number.isInteger(x);

/** Comprueba lo de mandar a la malla (lo que no venga se queda). Devuelve { malla } o { error }. */
export function comprobarMalla(dada, antes = MALLA_DEFECTO) {
  const c = { ...MALLA_DEFECTO, ...antes, ...dada };
  c.activado = !!c.activado;
  c.cada = Number(c.cada);
  if (!MALLA_CADA.includes(c.cada)) return { error: "Elige cada cuánto se manda." };
  if (c.canal != null && !(entero(c.canal) && c.canal >= 0 && c.canal <= 7)) return { error: "El canal no es válido." };
  if (c.saltos != null && !(entero(c.saltos) && c.saltos >= 1 && c.saltos <= MALLA_MAX_SALTOS)) return { error: "Los saltos no son válidos." };
  if (c.activado && c.canal == null) return { error: "Elige por qué canal se manda." };
  return { malla: { activado: c.activado, cada: c.cada, canal: c.canal, saltos: c.saltos } };
}

/**
 * Comprueba los datos MQTT de un panel. Devuelve { datos } o { error } con el motivo en español.
 * opts: temaProhibido(tema) → texto si no vale (lo que publica el propio Vigía, para no hacer un bucle);
 *       brokers: ids de los brokers que hay (null: no se comprueba); receptor: es el panel del receptor (malla).
 */
export function comprobarDatos(lista, { temaProhibido = () => null, brokers = null, receptor = false } = {}) {
  if (!Array.isArray(lista) || lista.length > MAX_DATOS) return { error: "La lista de datos no es válida." };
  const datos = [], nombres = new Set(), aLaMalla = new Set();
  for (const d of lista) {
    if (!d || typeof d !== "object") return { error: "La lista de datos no es válida." };
    const tipo = d.tipo;
    if (!TIPOS[tipo]) return { error: "Elige qué tipo de dato es cada uno." };
    const nombre = String(d.nombre ?? "").trim();
    if (nombre.length > 40) return { error: `El nombre «${nombre.slice(0, 20)}…» es demasiado largo (hasta 40 letras).` };
    const visto = nombreDato({ nombre, tipo });
    if (nombres.has(visto.toLowerCase())) return { error: `Hay dos «${visto}»: ponle un nombre distinto a cada uno.` };
    nombres.add(visto.toLowerCase());
    if (d.clave != null && !esClaveMqtt(d.clave)) return { error: "La lista de datos no es válida." };
    const tema = String(d.tema ?? "").trim();
    const campo = String(d.campo ?? "").trim();
    if (!tema) return { error: `Falta el tema MQTT de «${visto}».` };
    if (/[+#\0]/.test(tema)) return { error: `El tema de «${visto}» no puede llevar «+» ni «#»: tiene que ser uno concreto.` };
    if (tema.length > 250 || campo.length > 100) return { error: `El tema o el campo de «${visto}» es demasiado largo.` };
    if (campo && campo.split(".").some((p) => !p)) return { error: `El campo de «${visto}» no es válido (por ejemplo, temperature o ENERGY.Power).` };
    const broker = String(d.broker ?? "").trim();
    if (!broker) return { error: `Elige el broker de «${visto}».` };
    if (brokers && !brokers.has(broker)) return { error: `El broker de «${visto}» ya no está en la lista.` };
    const prohibido = temaProhibido(tema);
    if (prohibido) return { error: `«${visto}»: ${prohibido}` };
    let unidad = String(d.unidad ?? "").trim();
    const extra = {};
    if (esEstado(tipo)) {
      unidad = "";
      const nombres = d.nombres ?? "encendido";
      if (!NOMBRES_ESTADO[nombres]) return { error: `Elige cómo se llaman los estados de «${visto}».` };
      Object.assign(extra, { nombres, invertir: !!d.invertir });
    } else if (tipo === "otro") {
      if (unidad.length > 12) return { error: `La unidad de «${visto}» es demasiado larga (hasta 12 letras).` };
    } else {
      unidad ||= unidades(tipo)[0];
      if (!unidades(tipo).includes(unidad)) return { error: `La unidad de «${visto}» no es válida.` };
    }
    const caduca = Number(d.caduca || 0);
    if (!CADUCA.includes(caduca)) return { error: `Elige cuándo deja de mandarse «${visto}» si no llega nada nuevo.` };
    const malla = !!d.malla;
    if (malla) {
      if (!receptor) return { error: `«${visto}»: solo los datos del panel del receptor pueden salir a la malla.` };
      if (!tipoMalla(tipo)) return { error: `«${visto}»: la telemetría de Meshtastic no tiene hueco para ${TIPOS[tipo].label.toLowerCase()}.` };
      if (aLaMalla.has(tipo)) return { error: `Dos datos de ${TIPOS[tipo].label.toLowerCase()} van a la malla: la telemetría solo tiene un hueco para cada tipo.` };
      aLaMalla.add(tipo);
    }
    datos.push({ ...(d.clave ? { clave: d.clave } : {}), nombre, tipo, broker, tema, campo, unidad, caduca, malla, ...extra });
  }
  return { datos };
}

/**
 * Comprueba el tema de conexión de un panel sin nodo: { broker, tema, campo, avisar } o null (sin él).
 * Devuelve { conexion } (null si no hay tema) o { error }.
 */
export function comprobarConexion(c, { temaProhibido = () => null, brokers = null } = {}) {
  if (c == null) return { conexion: null };
  if (typeof c !== "object") return { error: "El tema de conexión no es válido." };
  const tema = String(c.tema ?? "").trim();
  if (!tema) return { conexion: null };
  const campo = String(c.campo ?? "").trim();
  if (/[+#\0]/.test(tema)) return { error: "El tema de conexión no puede llevar «+» ni «#»: tiene que ser uno concreto." };
  if (tema.length > 250 || campo.length > 100) return { error: "El tema o el campo de la conexión es demasiado largo." };
  if (campo && campo.split(".").some((p) => !p)) return { error: "El campo de la conexión no es válido (por ejemplo, state)." };
  const broker = String(c.broker ?? "").trim();
  if (!broker) return { error: "Elige el broker del tema de conexión." };
  if (brokers && !brokers.has(broker)) return { error: "El broker del tema de conexión ya no está en la lista." };
  const prohibido = temaProhibido(tema);
  if (prohibido) return { error: `Tema de conexión: ${prohibido}` };
  return { conexion: { broker, tema, campo, avisar: !!c.avisar } };
}
