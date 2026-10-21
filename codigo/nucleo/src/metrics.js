// Métricas de telemetría Meshtastic que entiende el panel.
// order: posición en la tarjeta; minor: solo se ve en el detalle.
export const METRICS = {
  temperature:        { label: "Temperatura",    unit: "°C",    dec: 1, hyst: 0.3,  order: 1 },
  relativeHumidity:   { label: "Humedad",        unit: "%",     dec: 0, hyst: 2,    order: 2 },
  barometricPressure: { label: "Presión",        unit: "hPa",   dec: 0, hyst: 1,    order: 3 },
  batteryLevel:       { label: "Batería",        unit: "%",     dec: 0, hyst: 2,    order: 4 },
  voltage:            { label: "Tensión",        unit: "V",     dec: 2, hyst: 0.05, order: 5 },
  soilMoisture:       { label: "Humedad suelo",  unit: "%",     dec: 0, hyst: 2,    order: 6 },
  soilTemperature:    { label: "Temp. suelo",    unit: "°C",    dec: 1, hyst: 0.3,  order: 7 },
  lux:                { label: "Luz",            unit: "lx",    dec: 0, hyst: 5,    order: 8 },
  iaq:                { label: "Calidad aire",   unit: "IAQ",   dec: 0, hyst: 5,    order: 9 },
  co2:                { label: "CO₂",            unit: "ppm",   dec: 0, hyst: 20,   order: 10 },
  pm10Standard:       { label: "PM1,0",          unit: "µg/m³", dec: 0, hyst: 2,    order: 11 },
  pm25Standard:       { label: "PM2,5",          unit: "µg/m³", dec: 0, hyst: 2,    order: 11.1 },
  pm100Standard:      { label: "PM10",           unit: "µg/m³", dec: 0, hyst: 2,    order: 11.2 },
  ch1Voltage:         { label: "Tensión c1",     unit: "V",     dec: 2, hyst: 0.05, order: 21 },
  ch1Current:         { label: "Corriente c1",   unit: "mA",    dec: 0, hyst: 5,    order: 22 },
  ch2Voltage:         { label: "Tensión c2",     unit: "V",     dec: 2, hyst: 0.05, order: 23 },
  ch2Current:         { label: "Corriente c2",   unit: "mA",    dec: 0, hyst: 5,    order: 24 },
  ch3Voltage:         { label: "Tensión c3",     unit: "V",     dec: 2, hyst: 0.05, order: 25 },
  ch3Current:         { label: "Corriente c3",   unit: "mA",    dec: 0, hyst: 5,    order: 26 },
  gasResistance:      { label: "Resist. gas",    unit: "MΩ",    dec: 1, hyst: 0.1,  order: 12 },
  windSpeed:          { label: "Viento",         unit: "m/s",   dec: 1, hyst: 0.5,  order: 13 },
  windGust:           { label: "Racha",          unit: "m/s",   dec: 1, hyst: 0.5,  order: 14 },
  rainfall1h:         { label: "Lluvia 1 h",     unit: "mm",    dec: 1, hyst: 0.2,  order: 15 },
  rainfall24h:        { label: "Lluvia 24 h",    unit: "mm",    dec: 1, hyst: 0.5,  order: 16 },
  distance:           { label: "Distancia",      unit: "mm",    dec: 0, hyst: 5,    order: 17 },
  weight:             { label: "Peso",           unit: "kg",    dec: 2, hyst: 0.05, order: 18 },
  sensorVoltage:      { label: "Tensión sensor", unit: "V",     dec: 2, hyst: 0.05, order: 19 },
  current:            { label: "Corriente",      unit: "mA",    dec: 0, hyst: 5,    order: 20 },
  channelUtilization: { label: "Uso del canal",  unit: "%",     dec: 1, hyst: 1,    order: 30, minor: true },
  airUtilTx:          { label: "Emisión propia", unit: "%",     dec: 1, hyst: 0.5,  order: 31, minor: true },
};

const ENV_FIELDS = ["temperature", "relativeHumidity", "barometricPressure", "gasResistance", "iaq", "distance",
  "lux", "windSpeed", "windGust", "rainfall1h", "rainfall24h", "soilMoisture", "soilTemperature", "weight"];

const num = (x) => typeof x === "number" && Number.isFinite(x);

/** Saca las métricas numéricas de un paquete Telemetry (protobuf ya decodificado). */
export function extractMetrics(tel) {
  const out = raw(tel);
  // Los float32 del protobuf llegan como 21.700000762939453: se redondean para guardar y exportar limpio.
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 1e4) / 1e4;
  return out;
}

function raw(tel) {
  const out = {};
  const v = tel && tel.variant;
  if (!v || !v.value) return out;
  const s = v.value;
  if (v.case === "deviceMetrics") {
    for (const k of ["batteryLevel", "voltage", "channelUtilization", "airUtilTx"]) if (num(s[k])) out[k] = s[k];
    // Algunos firmwares mandan 0 V cuando no miden: no es un dato.
    if (out.voltage === 0) delete out.voltage;
  } else if (v.case === "environmentMetrics") {
    for (const k of ENV_FIELDS) if (num(s[k])) out[k] = s[k];
    if (num(s.voltage) && s.voltage !== 0) out.sensorVoltage = s.voltage;
    if (num(s.current) && s.current !== 0) out.current = s.current;
  } else if (v.case === "airQualityMetrics") {
    if (num(s.co2) && s.co2 > 0) out.co2 = s.co2;
    for (const k of ["pm10Standard", "pm25Standard", "pm100Standard"]) if (num(s[k])) out[k] = s[k];
  } else if (v.case === "powerMetrics") {
    // Los canales sin sensor llegan vacíos o a 0 V: se descartan.
    for (const c of [1, 2, 3]) {
      const vv = s[`ch${c}Voltage`], ii = s[`ch${c}Current`];
      if (num(vv) && vv !== 0) out[`ch${c}Voltage`] = vv;
      if (num(ii) && (ii !== 0 || out[`ch${c}Voltage`] !== undefined)) out[`ch${c}Current`] = ii;
    }
  }
  return out;
}

// Métricas que no son de Meshtastic: los datos MQTT de los paneles del servidor («mq3» → Temperatura nevera, °C…).
// Las pone el servidor (y la pantalla, con lo que le cuenta él); en la app sin servidor está vacío.
const EXTRA = new Map();
export function registrarMetricas(metas) {
  EXTRA.clear();
  for (const [k, m] of Object.entries(metas || {})) EXTRA.set(k, m);
}

export const metricMeta = (k) => EXTRA.get(k) || METRICS[k] || { label: k, unit: "", dec: 1, hyst: 0, order: 99 };

export const sortMetrics = (keys) => [...keys].sort((a, b) => metricMeta(a).order - metricMeta(b).order);

const NF = new Map();
export function fmtNum(v, dec) {
  if (!num(v)) return "—";
  const key = dec;
  if (!NF.has(key)) NF.set(key, new Intl.NumberFormat("es-ES", { minimumFractionDigits: dec, maximumFractionDigits: dec }));
  return NF.get(key).format(v);
}

/** Valor formateado sin unidad. La batería 101 significa alimentada por USB/externa. */
export function fmtValue(metric, v) {
  if (metric === "batteryLevel" && v > 100) return "USB";
  const m = metricMeta(metric);
  if (m.estados) return m.estados[v ? 0 : 1]; // un dato ON/OFF del servidor: «Abierta», «Cerrada»
  return fmtNum(v, m.dec);
}

/** Límite puesto por el usuario: respeta sus decimales (25,5 no se muestra como 26). */
export function fmtLimit(metric, v, withUnit = false) {
  const dec = Math.min(2, Math.max(metricMeta(metric).dec, (String(v).split(".")[1] || "").length));
  const s = fmtNum(v, dec);
  const u = metricMeta(metric).unit;
  return withUnit && u ? `${s} ${u}` : s;
}

export function fmtWithUnit(metric, v) {
  const m = metricMeta(metric);
  if (metric === "batteryLevel" && v > 100) return "USB";
  if (m.estados) return m.estados[v ? 0 : 1];
  return m.unit ? `${fmtNum(v, m.dec)} ${m.unit}` : fmtNum(v, m.dec);
}
