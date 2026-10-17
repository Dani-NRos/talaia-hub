// Alarma de tendencia: un valor que baja o sube mucho en poco tiempo (p. ej. la presión antes de una tormenta).
// Sin DOM, para poder probarlo con node --test.

const HOUR = 3600000;

/** Valores por defecto al elegir una métrica: dirección, cantidad y horas. */
export const TREND_DEFAULTS = {
  barometricPressure: { dir: "down", delta: 3, hours: 3 }, // bajada de 3 hPa en 3 h: suele anunciar tormenta
  temperature: { dir: "up", delta: 5, hours: 1 },
  soilTemperature: { dir: "up", delta: 5, hours: 1 },
  relativeHumidity: { dir: "up", delta: 20, hours: 2 },
  soilMoisture: { dir: "down", delta: 10, hours: 6 },
  batteryLevel: { dir: "down", delta: 15, hours: 6 },
  voltage: { dir: "down", delta: 0.2, hours: 6 },
  rainfall1h: { dir: "up", delta: 5, hours: 1 },
  windSpeed: { dir: "up", delta: 8, hours: 1 },
  distance: { dir: "down", delta: 100, hours: 1 }, // sensor de nivel: el agua sube y la distancia baja
};
export const trendDefault = (metric) => TREND_DEFAULTS[metric] || { dir: "down", delta: 5, hours: 3 };

/** Una vez saltada, la alarma se cierra cuando el cambio vuelve por debajo del 70 % del límite. */
export const TREND_CLEAR = 0.7;
export const TREND_MAX_HOURS = 24;

/**
 * Cambio en la ventana de `hours` horas que acaba en `t` (series: [{t, v}] ordenada por t).
 * drop: cuánto ha bajado desde el máximo de la ventana hasta la última lectura; rise: cuánto ha subido desde el mínimo.
 * Devuelve null si no hay historia suficiente: hace falta una lectura de al menos media ventana atrás,
 * para no dar la alarma (ni cerrarla) con dos lecturas seguidas.
 */
export function trendOf(series, t, hours) {
  const from = t - hours * HOUR;
  const win = [];
  for (const p of series) if (p.t >= from && p.t <= t && Number.isFinite(p.v)) win.push(p);
  if (win.length < 2 || win[0].t > t - hours * HOUR * 0.5) return null;
  const last = win[win.length - 1];
  let max = win[0], min = win[0];
  for (const p of win) {
    if (p.v > max.v) max = p;
    if (p.v < min.v) min = p;
  }
  return { drop: max.v - last.v, rise: last.v - min.v, max, min, last };
}

/**
 * Estado de una regla de tendencia { dir, delta, hours } con la serie actual.
 * Devuelve { change, fire, clear, from, to } o null sin historia suficiente.
 * fire: supera el límite; clear: ha vuelto por debajo del 70 % (para cerrar una alarma abierta).
 */
export function trendCheck(series, t, rule) {
  const c = trendOf(series, t, rule.hours);
  if (!c) return null;
  const down = rule.dir === "down";
  const change = down ? c.drop : c.rise;
  return {
    change,
    fire: change >= rule.delta,
    clear: change < rule.delta * TREND_CLEAR,
    from: down ? c.max : c.min,
    to: c.last,
  };
}

/** Valida lo que escribe el usuario. Devuelve { rule } o { error }. */
export function parseTrendRule(dir, delta, hours) {
  if (dir !== "down" && dir !== "up") return { error: "Elige si avisa al bajar o al subir." };
  if (!Number.isFinite(delta) || delta <= 0) return { error: "Pon cuánto tiene que cambiar (un número mayor que 0)." };
  if (!Number.isFinite(hours) || hours < 0.5 || hours > TREND_MAX_HOURS) return { error: `Pon un tiempo entre media hora y ${TREND_MAX_HOURS} horas.` };
  return { rule: { dir, delta, hours } };
}
