// Registro del servidor: una línea por suceso en la salida estándar. Con systemd va al diario
// (journalctl -u talaia), que ya pone la hora; fuera de systemd se añade aquí.

import { getLanguage } from "@talaia/nucleo/idioma.js";

const NIVELES = { depurar: 10, info: 20, aviso: 30, error: 40 };
// Outside systemd (Docker, by hand), each line says its level, in the server's language.
const ETIQUETA = {
  es: { depurar: "depurar", info: "info", aviso: "AVISO", error: "ERROR" },
  en: { depurar: "debug", info: "info", aviso: "WARN", error: "ERROR" },
};
// systemd pone JOURNAL_STREAM cuando la salida va al diario.
const CON_HORA = !process.env.JOURNAL_STREAM;
// Prioridad para el diario (formato <n> de sd-daemon): 7 depurar, 6 info, 4 aviso, 3 error.
const PRIO = { depurar: 7, info: 6, aviso: 4, error: 3 };

const dos = (n) => String(n).padStart(2, "0");
/** «2026-10-18 18:01:57», en hora local. */
function hora(d = new Date()) {
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}

/** nivel: «depurar», «info», «aviso» o «error». salida: para las pruebas. */
export function crearRegistro({ nivel = "info", salida = null } = {}) {
  const min = NIVELES[nivel] ?? NIVELES.info;
  const escribir = (n, msg) => {
    if (NIVELES[n] < min) return;
    const linea = CON_HORA ? `${hora()} ${(ETIQUETA[getLanguage()] || ETIQUETA.es)[n]}: ${msg}` : `<${PRIO[n]}>${msg}`;
    if (salida) salida.push({ nivel: n, msg });
    else (n === "error" || n === "aviso" ? process.stderr : process.stdout).write(linea + "\n");
  };
  return {
    depurar: (m) => escribir("depurar", m),
    info: (m) => escribir("info", m),
    aviso: (m) => escribir("aviso", m),
    error: (m) => escribir("error", m),
  };
}
