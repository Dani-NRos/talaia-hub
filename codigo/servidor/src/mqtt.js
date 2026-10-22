// MQTT del servidor (MQTT.js, JavaScript puro: no compila nada en la Pi). Varios brokers a la vez: el de este equipo
// (Mosquitto, si lo instaló el instalador; ver mosquitto.js) y los que se añadan (el de Home Assistant…). Cada broker es
// una conexión; la usan la salida a Home Assistant (en el broker que se elija) y lo que escucha temas (la estación),
// que se suscribe con suscribir().
import { EventEmitter } from "node:events";
import mqtt from "mqtt";
import { direccionesLocales } from "./mosquitto.js";
import { tx } from "@vigia/nucleo/idioma.js";
import "./textos.js";

/** El broker de este equipo: no se guarda en la lista, sale de la configuración del servidor. */
export const BROKER_LOCAL = "local";

/** La configuración que se guarda (en SQLite, clave «mqtt»). */
export const MQTT_DEFECTO = {
  brokers: [], // [{ id, nombre, url, usuario, clave, activado }]
  ha: { activado: false, broker: null, base: "vigia", prefijo: "homeassistant" }, // salida a Home Assistant
};

const TEMA_OK = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/**
 * La configuración de la 1.14–1.16 (un solo broker, con Home Assistant) pasa a la de varios: ese broker queda como el
 * primero («b1»), con el mismo nombre que tenía Home Assistant.
 */
export function migrarMqtt(c) {
  if (!c || Array.isArray(c.brokers)) return c;
  const b = c.url ? [{ id: "b1", nombre: "Home Assistant", url: c.url, usuario: c.usuario || "", clave: c.clave || "", activado: !!c.activado }] : [];
  return {
    brokers: b,
    ha: { activado: !!(c.activado && c.url && (c.ha?.activado ?? true)), broker: b[0]?.id ?? null, base: c.base || "vigia", prefijo: c.ha?.prefijo || "homeassistant" },
  };
}

/** Al arrancar: la configuración vieja a la nueva, y los datos de la estación al broker que usaban. */
export function migrar(almacen) {
  const viejo = almacen.leer("mqtt", null);
  const nuevo = migrarMqtt(viejo);
  if (nuevo === viejo) return;
  almacen.guardar("mqtt", nuevo);
  const est = almacen.leer("estacion", null);
  if (est?.datos?.some((d) => !d.broker) && nuevo.brokers[0]) {
    for (const d of est.datos) d.broker ||= nuevo.brokers[0].id;
    almacen.guardar("estacion", est);
  }
}

/** «192.168.1.20» → «mqtt://192.168.1.20:1883». Devuelve null si no se entiende. */
export function normalizarUrl(txt) {
  let s = String(txt || "").trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `mqtt://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(u.protocol) || !u.hostname) return null;
  if (!u.port) u.port = { "mqtt:": "1883", "mqtts:": "8883", "ws:": "80", "wss:": "443" }[u.protocol];
  return `${u.protocol}//${u.hostname.includes(":") ? `[${u.hostname}]` : u.hostname}:${u.port}${u.pathname === "/" ? "" : u.pathname}`;
}

/**
 * Comprueba y completa un broker (nuevo o cambiado: lo que no venga se queda). La contraseña: sin dar, se queda la que
 * había; null la borra. Devuelve { broker } o { error } con el motivo en español.
 */
export function comprobarBroker(dado, antes = {}) {
  const b = { activado: true, nombre: "", url: "", usuario: "", clave: "", ...antes, ...dado };
  b.clave = dado.clave === undefined ? antes.clave || "" : dado.clave === null ? "" : String(dado.clave);
  b.activado = !!b.activado;
  b.nombre = String(b.nombre || "").trim();
  b.usuario = String(b.usuario || "").trim();
  b.url = String(b.url || "").trim();
  if (!b.nombre) return { error: tx("s.mqtt.noName") };
  if (!b.url) return { error: tx("s.mqtt.noUrl") };
  if (!normalizarUrl(b.url)) return { error: tx("s.mqtt.badUrl") };
  if (b.clave && !b.usuario) return { error: tx("s.mqtt.passNoUser") };
  if (b.nombre.length > 40 || b.url.length > 200 || b.usuario.length > 100 || b.clave.length > 200) return { error: tx("s.mqtt.tooLong") };
  return { broker: { id: antes.id ?? dado.id, nombre: b.nombre, url: b.url, usuario: b.usuario, clave: b.clave, activado: b.activado } };
}

/** Comprueba la salida a Home Assistant. existe(id): si ese broker está. Devuelve { ha } o { error }. */
export function comprobarHA(dado, antes = MQTT_DEFECTO.ha, existe = () => true) {
  const h = { ...MQTT_DEFECTO.ha, ...antes, ...dado };
  h.activado = !!h.activado;
  if (h.activado && !h.broker) return { error: tx("s.mqtt.haBroker") };
  if (h.broker != null && !existe(h.broker)) return { error: tx("s.mqtt.gone") };
  if (!TEMA_OK.test(h.base)) return { error: tx("s.mqtt.badBase") };
  if (!TEMA_OK.test(h.prefijo)) return { error: tx("s.mqtt.badPrefix") };
  return { ha: { activado: h.activado, broker: h.broker ?? null, base: h.base, prefijo: h.prefijo } };
}

/** Lo que se cuenta a las pantallas de un broker: nunca la contraseña, solo si hay una guardada. */
export const brokerPublico = (b) => ({ id: b.id, nombre: b.nombre, url: b.url, usuario: b.local ? "" : b.usuario, hayClave: !b.local && !!b.clave, activado: b.activado, local: !!b.local });

/** Fallo de conexión en palabras de casa. */
export function textoError(err) {
  const code = err?.code;
  const msg = String(err?.message || "");
  // Mosquitto contesta «no autorizado» (5) también cuando la contraseña está mal.
  if ([4, 5, 134, 135].includes(code) || /bad user ?name or password|not authori[sz]ed/i.test(msg)) return tx("s.mqtt.e.auth");
  if (code === "ECONNREFUSED") return tx("s.mqtt.e.refused");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return tx("s.mqtt.e.notFound");
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || /timeout/i.test(msg)) return tx("s.mqtt.e.unreachable");
  if (/certificate|self.signed|tls|ssl/i.test(msg)) return tx("s.mqtt.e.tls", { msg });
  return msg || String(code || tx("s.mqtt.e.unknown"));
}

/** La promesa, o valor si tarda más de ms. */
function conTiempo(p, ms, valor) {
  let t;
  return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(valor), ms); })]).finally(() => clearTimeout(t));
}

/** ¿El tema cumple el patrón con comodines + y #? */
export function coincide(patron, tema) {
  const p = patron.split("/"), t = tema.split("/");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "#") return true;
    if (i >= t.length) return false;
    if (p[i] !== "+" && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

/**
 * Una conexión con un broker. Eventos: «estado» (cada cambio), «conectada» (también al reconectar).
 * opts: { url, usuario, clave, clienteId, nombre, testamento: { tema, carga } }; registro: el del servidor.
 */
export class ConexionMqtt extends EventEmitter {
  constructor(opts, registro) {
    super();
    this.opts = opts;
    this.r = registro;
    this.c = null;
    this.subs = []; // [{ patron, fn }]
    this.estado = { fase: "parada", desde: Date.now(), error: null, url: normalizarUrl(opts.url) };
    this.ultimoError = null;
    this.quien = opts.nombre ? `MQTT (${opts.nombre})` : "MQTT"; // para el registro
  }

  _fase(fase, error = null) {
    if (this.estado.fase === fase && this.estado.error === error) return;
    this.estado = { ...this.estado, fase, error, desde: Date.now() };
    this.emit("estado", this.estado);
  }

  arrancar() {
    const url = normalizarUrl(this.opts.url);
    this._fase("conectando");
    const t = this.opts.testamento;
    const c = mqtt.connect(url, {
      username: this.opts.usuario || undefined,
      password: this.opts.clave || undefined,
      clientId: this.opts.clienteId || `vigia-${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      keepalive: 30,
      connectTimeout: 10000,
      reconnectPeriod: 5000,
      // Si el servidor se apaga o se cuelga, el broker publica esto por él: Home Assistant marca todo «no disponible».
      will: t ? { topic: t.tema, payload: Buffer.from(t.carga), retain: true, qos: 1 } : undefined,
    });
    this.c = c;
    const mia = () => this.c === c; // tras parar(), lo que aún llegue de esta conexión ya no cuenta
    c.on("connect", () => {
      if (!mia()) return;
      this.ultimoError = null;
      this.r.info(tx("s.j.mqttUp", { who: this.quien, url }));
      this._fase("conectada");
      for (const s of this.subs) c.subscribe(s.patron, { qos: 0 });
      this.emit("conectada");
    });
    c.on("reconnect", () => { if (mia() && this.estado.fase !== "error") this._fase("conectando"); });
    c.on("close", () => {
      if (mia() && this.estado.fase === "conectada") { this.r.aviso(tx("s.j.mqttCut", { who: this.quien, url })); this._fase("conectando"); }
    });
    c.on("error", (e) => {
      if (!mia()) return;
      const txt = textoError(e);
      // El mismo fallo se cuenta una vez, no en cada reintento (cada 5 s).
      if (txt !== this.ultimoError) this.r.aviso(tx("s.j.mqttFail", { who: this.quien, url, why: txt }));
      this.ultimoError = txt;
      this._fase("error", txt);
    });
    c.on("message", (tema, carga, paquete) => {
      for (const s of this.subs) {
        if (!coincide(s.patron, tema)) continue;
        try { s.fn(tema, carga, paquete); } catch (e) { this.r.error(tx("s.j.mqttHandler", { topic: tema, e: e.stack || e })); }
      }
    });
  }

  get conectada() { return !!this.c?.connected; }

  /** Publica si hay conexión (si no, se descarta: al reconectar se vuelve a publicar todo lo que importa). */
  publicar(tema, carga, { retener = false, qos = 0 } = {}) {
    if (!this.conectada) return Promise.resolve(false);
    const datos = typeof carga === "string" || Buffer.isBuffer(carga) ? carga : JSON.stringify(carga);
    // Si el broker no confirma (la red se ha caído a medias), no se espera para siempre.
    return conTiempo(new Promise((resolve) => this.c.publish(tema, datos, { retain: retener, qos }, (e) => resolve(!e))), 5000, false);
  }

  /** fn(tema, carga Buffer, paquete). Se vuelve a suscribir sola al reconectar. Devuelve cómo quitarla. */
  suscribir(patron, fn) {
    const s = { patron, fn };
    this.subs.push(s);
    if (this.conectada) this.c.subscribe(patron, { qos: 0 });
    return () => {
      this.subs = this.subs.filter((x) => x !== s);
      if (this.conectada && !this.subs.some((x) => x.patron === patron)) this.c.unsubscribe(patron);
    };
  }

  /** Cierra la conexión; despedida: { tema, carga } que se publica antes (retenida), como el testamento. */
  async parar(despedida = null) {
    if (!this.c) return;
    const c = this.c;
    this.c = null;
    if (despedida && c.connected) {
      await conTiempo(new Promise((r) => c.publish(despedida.tema, despedida.carga, { retain: true, qos: 1 }, () => r())), 2000);
    }
    // Cierre ordenado; si el broker ya no contesta, a la fuerza.
    await conTiempo(new Promise((r) => c.end(false, {}, () => r())), 2000);
    if (!c.disconnected) c.end(true);
    this._fase("parada");
  }
}

/**
 * MQTT del servidor: guarda la configuración (SQLite, «mqtt»), mantiene una conexión por broker y engancha lo que la
 * usa: la salida a Home Assistant (en su broker) y los enganches (f(idBroker, conexion) → cómo soltarla), como la
 * estación. Deja en S.mqtt lo que ven las pantallas (sin contraseñas) y avisa con la parte «mqtt».
 * vigia: { S, motor, eventos, almacen, registro }. local: el broker de este equipo (mosquitto.js) o null.
 * usos(id): quién más usa un broker (para no quitar uno que se está usando).
 */
export async function crearServicioMqtt(vigia, { crearSalidaHA, clienteId = "vigia", enganches = [], local = null, usos = () => [] } = {}) {
  const { S, eventos, almacen, registro } = vigia;
  migrar(almacen);
  const leido = almacen.leer("mqtt", null) || MQTT_DEFECTO;
  let cfg = { brokers: Array.isArray(leido.brokers) ? leido.brokers : [], ha: comprobarHA(leido.ha || {}).ha || { ...MQTT_DEFECTO.ha } };
  const activas = new Map(); // id → { conexion, soltar: [], ha, testamento }

  const brokerLocal = () => (local ? { id: BROKER_LOCAL, nombre: tx("s.mqtt.localName"), url: local.url, usuario: local.interno.usuario, clave: local.interno.clave, activado: true, local: true } : null);
  const lista = () => [brokerLocal(), ...cfg.brokers].filter(Boolean);
  const buscar = (id) => lista().find((b) => b.id === id) || null;
  const despedida = () => ({ tema: `${cfg.ha.base}/estado`, carga: "offline" });
  const esHA = (id) => cfg.ha.activado && cfg.ha.broker === id;
  const guardar = () => almacen.guardar("mqtt", cfg);

  function contar() {
    S.mqtt = {
      brokers: lista().map((b) => ({ ...brokerPublico(b), estado: activas.get(b.id)?.conexion.estado ?? { fase: "parada", desde: Date.now(), error: null, url: normalizarUrl(b.url) } })),
      ha: { ...cfg.ha },
      local: local ? { puerto: local.puerto, direcciones: direccionesLocales(), usuarios: local.usuarios() } : null,
    };
    eventos.emit("parte", "mqtt");
  }

  function arrancarUno(b) {
    if (!b?.activado || activas.has(b.id)) return;
    const testamento = esHA(b.id) ? despedida() : null; // Home Assistant marca todo «no disponible» si el servidor cae
    const conexion = new ConexionMqtt({ url: b.url, usuario: b.usuario, clave: b.clave, clienteId: `${clienteId}-${b.id}`, nombre: b.nombre, testamento }, registro);
    const a = { conexion, soltar: [], ha: null, testamento };
    activas.set(b.id, a);
    conexion.on("estado", contar);
    if (esHA(b.id) && crearSalidaHA) a.ha = crearSalidaHA(vigia, conexion, { base: cfg.ha.base, prefijo: cfg.ha.prefijo });
    a.soltar = enganches.map((f) => f(b.id, conexion));
    conexion.arrancar();
  }

  async function pararUno(id, { retirarHA = false } = {}) {
    const a = activas.get(id);
    if (!a) return;
    activas.delete(id);
    if (a.ha && retirarHA && a.conexion.conectada) await a.ha.retirar();
    a.ha?.parar();
    for (const f of a.soltar) f?.();
    await a.conexion.parar(a.testamento);
  }

  const reiniciar = async (id, opts) => { await pararUno(id, opts); arrancarUno(buscar(id)); };

  contar();
  return {
    conexion: (id) => activas.get(id)?.conexion || null,
    /** Los brokers que hay (con contraseña: solo para el servidor). */
    brokers: () => lista(),
    nombre: (id) => buscar(id)?.nombre || null,
    /** Conecta con todos los brokers activados. Lo llama el servidor al arrancar. */
    arrancar() {
      local?.escribir();
      for (const b of lista()) arrancarUno(b);
      contar();
    },
    /** Añade (id null) o cambia un broker. Devuelve { ok, id?, toast?, error? }. */
    async configurarBroker(id, cambio) {
      if (id === BROKER_LOCAL) return { ok: false, error: tx("s.mqtt.localNoEdit") };
      const antes = id ? cfg.brokers.find((b) => b.id === id) : null;
      if (id && !antes) return { ok: false, error: tx("s.mqtt.gone") };
      const { broker, error } = comprobarBroker(cambio, antes || {});
      if (error) return { ok: false, error };
      if (!antes) {
        let n = cfg.brokers.length + 1;
        while (cfg.brokers.some((b) => b.id === `b${n}`)) n++;
        broker.id = `b${n}`;
      }
      // Si el de Home Assistant cambia de sitio o se apaga, se quita de HA lo publicado: si no, quedarían huérfanos.
      const otroSitio = antes && normalizarUrl(antes.url) !== normalizarUrl(broker.url);
      await pararUno(broker.id, { retirarHA: !!antes && esHA(broker.id) && (otroSitio || !broker.activado) });
      cfg.brokers = antes ? cfg.brokers.map((b) => (b.id === broker.id ? broker : b)) : [...cfg.brokers, broker];
      guardar();
      registro.info(tx(antes ? "s.j.brokerChanged" : "s.j.brokerAdded", { name: broker.nombre, url: normalizarUrl(broker.url), off: broker.activado ? "" : tx("s.j.brokerOff") }));
      arrancarUno(broker);
      contar();
      return { ok: true, id: broker.id, toast: broker.activado ? tx("s.mqtt.savedConnecting", { name: broker.nombre }) : tx("s.mqtt.savedOff") };
    },
    /** Quita un broker que no use nadie. */
    async quitarBroker(id) {
      if (id === BROKER_LOCAL) return { ok: false, error: tx("s.mqtt.localNoRemove") };
      const b = cfg.brokers.find((x) => x.id === id);
      if (!b) return { ok: false, error: tx("s.mqtt.gone") };
      const quien = [...(esHA(id) ? ["Home Assistant"] : []), ...usos(id)];
      if (quien.length) return { ok: false, error: tx("s.mqtt.inUse", { who: quien.join(", ") }) };
      await pararUno(id);
      cfg.brokers = cfg.brokers.filter((x) => x.id !== id);
      if (cfg.ha.broker === id) cfg.ha.broker = null;
      guardar();
      registro.info(tx("s.j.brokerRemoved", { name: b.nombre }));
      contar();
      return { ok: true, toast: tx("s.mqtt.removed", { name: b.nombre }) };
    },
    /** La salida a Home Assistant: si se publica y en qué broker. */
    async configurarHA(cambio) {
      const { ha, error } = comprobarHA(cambio, cfg.ha, (id) => !!buscar(id));
      if (error) return { ok: false, error };
      const antes = cfg.ha;
      const antesOn = antes.activado && antes.broker, ahoraOn = ha.activado && ha.broker;
      const otroSitio = antes.broker !== ha.broker || antes.base !== ha.base || antes.prefijo !== ha.prefijo;
      // El testamento va en la conexión: el broker de antes y el de ahora se vuelven a conectar.
      if (antesOn) await pararUno(antes.broker, { retirarHA: !ahoraOn || otroSitio });
      if (ahoraOn && ha.broker !== antes.broker) await pararUno(ha.broker);
      cfg.ha = ha;
      guardar();
      registro.info(ahoraOn ? tx("s.j.haOn", { name: buscar(ha.broker).nombre }) : tx("s.j.haOff"));
      if (antesOn) arrancarUno(buscar(antes.broker));
      if (ahoraOn) arrancarUno(buscar(ha.broker));
      contar();
      return { ok: true, toast: tx(ahoraOn ? "s.mqtt.haSaved" : "s.mqtt.haSavedOff") };
    },
    /** Usuarios del broker de este equipo. */
    ponerUsuario(nombre, clave) {
      if (!local) return { ok: false, error: tx("s.mqtt.noLocal") };
      const r = local.ponerUsuario(nombre, clave);
      contar();
      return r;
    },
    quitarUsuario(nombre) {
      if (!local) return { ok: false, error: tx("s.mqtt.noLocalShort") };
      const r = local.quitarUsuario(nombre);
      contar();
      return r;
    },
    /** Vuelve a conectar un broker (para las pruebas y por si se queda colgado). */
    reiniciar,
    async parar() { for (const id of [...activas.keys()]) await pararUno(id); },
  };
}
