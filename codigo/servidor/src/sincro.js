// Estado del servidor para las pantallas conectadas: una foto al conectar y, después, solo lo que cambia.
// Las pantallas guardan lo recibido en su S y dibujan igual que si fuera suyo.
import { seriesKey } from "@talaia/nucleo/motor.js";

const LOG_MAX = 200, DIAG_MAX = 60;

/** Petición a un nodo sin sus temporizadores. */
const peticion = (r) => ({ num: r.num, type: r.type, state: r.state, t0: r.t0, tDone: r.tDone, why: r.why, acked: r.acked,
  gotKey: r.gotKey, noLoc: r.noLoc, trace: r.trace, limit: r.limit, notice: r.notice, id: r.id ?? null });
const avisoMalla = (m) => (m ? { tg: m.tg, text: m.text, tq: m.tq, t: m.t, result: m.result, ok: m.ok, tDone: m.tDone ?? null } : null);
/** Ficha del receptor: lo que necesita la pantalla (la clave pública como lista de números). */
const miFicha = (u) => (u ? { longName: u.longName, shortName: u.shortName, isLicensed: !!u.isLicensed, publicKey: u.publicKey ? [...u.publicKey] : [] } : null);
const ajustes = (s) => ({ defaultOfflineMin: s.defaultOfflineMin, retentionDays: s.retentionDays, mesh: s.mesh ?? null, language: s.language || "es" });

/** Cada parte del estado y cómo se manda. */
export const PARTES = {
  cfg: (S) => S.cfg,
  active: (S) => [...S.active.values()],
  log: (S) => S.log.slice(0, LOG_MAX),
  channels: (S) => S.channels,
  myNode: (S) => S.myNode,
  myUser: (S) => miFicha(S.myUser),
  lora: (S) => S.lora,
  traces: (S) => S.traces,
  req: (S) => [...S.req.values()].map(peticion),
  meshLast: (S) => avisoMalla(S.meshLast),
  link: (S) => S.link,
  device: (S) => S.device,
  trouble: (S) => S.trouble ?? null,
  diag: (S) => S.diag.slice(0, DIAG_MAX).reverse(), // en la app va del más antiguo al más reciente
  settings: (S) => ajustes(S.settings),
  recent: (S) => recientes(S),
  mqtt: (S) => S.mqtt ?? null, // configuración (sin contraseña) y estado de la conexión
  paneles: (S) => S.paneles ?? null, // nombres, paneles sin nodo, datos MQTT (configuración y últimos valores), malla
  usuarios: (S) => S.usuarios ?? [], // users and their sessions (never a password)
  automations: (S) => S.automations ?? null, // the automations, what they are waiting for and when each last ran
  meshOrders: (S) => S.meshOrders ?? null, // orders over the mesh: on, the nodes allowed (start of their key), channel, words
};

/** Lecturas de las últimas 26 h de los nodos vigilados (gráficas de las tarjetas y cambio rápido). */
function recientes(S) {
  const out = {};
  for (const num of Object.keys(S.cfg.watched)) {
    for (const k of Object.keys(S.nodes.get(Number(num))?.metrics || {})) {
      const ser = S.recent.get(seriesKey(num, k));
      if (ser?.length) out[seriesKey(num, k)] = ser;
    }
  }
  return out;
}

/** Foto completa: los nodos y todas las partes. */
export function instantanea(S) {
  const out = { nodes: [...S.nodes.values()] };
  for (const [k, f] of Object.entries(PARTES)) out[k] = f(S);
  return out;
}

/**
 * Lleva la cuenta de lo que ha cambiado y lo junta en un parche cada poco (como mucho cada intervalo ms).
 * marcar(parte): esa parte ha cambiado. filas(rows): lecturas nuevas. enviar(parche) recibe lo que toque mandar.
 */
export function crearSincro(S, enviar, intervalo = 250) {
  const sucias = new Set();
  let filas = [];
  let nodosTodos = false;
  let timer = null;
  // Último JSON mandado de cada nodo: así solo viajan los que han cambiado (con 1000 nodos, la lista entera pesa).
  const enviados = new Map();
  for (const n of S.nodes.values()) enviados.set(n.num, JSON.stringify(n));

  function programar() {
    if (!timer) timer = setTimeout(vaciar, intervalo);
  }
  function vaciar() {
    timer = null;
    const p = {};
    for (const k of sucias) if (PARTES[k]) p[k] = PARTES[k](S);
    sucias.clear();
    if (nodosTodos) {
      nodosTodos = false;
      const cambiados = [];
      for (const n of S.nodes.values()) {
        const j = JSON.stringify(n);
        if (enviados.get(n.num) !== j) { enviados.set(n.num, j); cambiados.push(n); }
      }
      if (cambiados.length) p.nodes = cambiados;
    }
    if (filas.length) { p.rows = filas; filas = []; }
    if (Object.keys(p).length) enviar(p);
  }

  return {
    marcar(parte) {
      if (parte === "nodes") nodosTodos = true;
      else sucias.add(parte);
      programar();
    },
    filas(rows) {
      filas.push(...rows);
      programar();
    },
    /** Lo pendiente, ya (para las pruebas y al parar). */
    vaciar() { clearTimeout(timer); vaciar(); },
    parar() { clearTimeout(timer); timer = null; },
  };
}
