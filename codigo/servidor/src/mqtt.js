// Conexión MQTT del servidor (MQTT.js, JavaScript puro: no compila nada en la Pi).
// La usan la salida a Home Assistant y la estación (datos que llegan por MQTT y salen a la malla), que se suscribe a
// sus temas con suscribir(). Una conexión = un broker.
import { EventEmitter } from "node:events";
import mqtt from "mqtt";

/** La configuración que se guarda (en SQLite, clave «mqtt»). */
export const MQTT_DEFECTO = {
  activado: false,
  url: "", // «192.168.1.20», «192.168.1.20:1883», «mqtt://…» o «mqtts://…» (con cifrado)
  usuario: "",
  clave: "",
  base: "vigia", // tema raíz de lo que publica Vigía: vigia/estado, vigia/nodo/…
  ha: { activado: true, prefijo: "homeassistant" }, // autodescubrimiento de Home Assistant
};

const TEMA_OK = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

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

/** Comprueba y completa una configuración nueva. Devuelve { cfg } o { error } con el motivo en español. */
export function comprobarMqtt(dada, antes = MQTT_DEFECTO) {
  const c = { ...MQTT_DEFECTO, ...antes, ...dada, ha: { ...MQTT_DEFECTO.ha, ...(antes.ha || {}), ...(dada.ha || {}) } };
  // La contraseña: sin dar, se queda la que había; null la borra.
  c.clave = dada.clave === undefined ? antes.clave || "" : dada.clave === null ? "" : String(dada.clave);
  c.activado = !!c.activado;
  c.ha.activado = !!c.ha.activado;
  c.usuario = String(c.usuario || "").trim();
  c.url = String(c.url || "").trim();
  if (c.url && !normalizarUrl(c.url)) return { error: "No entiendo la dirección del broker. Pon la IP o el nombre, por ejemplo 192.168.1.20 (o 192.168.1.20:1883)." };
  if (c.activado && !c.url) return { error: "Falta la dirección del broker MQTT." };
  if (c.clave && !c.usuario) return { error: "Con contraseña hace falta también el usuario (MQTT no admite una sin el otro)." };
  if (!TEMA_OK.test(c.base)) return { error: "El tema base solo puede llevar letras, números, «-», «_» y «/» (por ejemplo, vigia)." };
  if (!TEMA_OK.test(c.ha.prefijo)) return { error: "El prefijo de Home Assistant solo puede llevar letras, números, «-», «_» y «/» (normalmente, homeassistant)." };
  if (c.url.length > 200 || c.usuario.length > 100 || c.clave.length > 200) return { error: "Algún dato es demasiado largo." };
  return { cfg: c };
}

/** Lo que se cuenta a las pantallas: nunca la contraseña, solo si hay una guardada. */
export const configPublica = (c) => ({ activado: c.activado, url: c.url, usuario: c.usuario, hayClave: !!c.clave, base: c.base, ha: { ...c.ha } });

/** Fallo de conexión en palabras de casa. */
export function textoError(err) {
  const code = err?.code;
  const msg = String(err?.message || "");
  // Mosquitto contesta «no autorizado» (5) también cuando la contraseña está mal.
  if ([4, 5, 134, 135].includes(code) || /bad user ?name or password|not authori[sz]ed/i.test(msg)) return "usuario o contraseña incorrectos, o el broker no deja entrar sin ellos";
  if (code === "ECONNREFUSED") return "no hay ningún broker escuchando en esa dirección y puerto (¿está Mosquitto en marcha? ¿es el puerto 1883?)";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "no se encuentra ese nombre en la red; prueba con la IP";
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || /timeout/i.test(msg)) return "no se llega a esa dirección (¿encendido? ¿en la misma red?)";
  if (/certificate|self.signed|tls|ssl/i.test(msg)) return `problema con el cifrado (mqtts): ${msg}`;
  return msg || String(code || "fallo desconocido");
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
 * opts: { url, usuario, clave, clienteId, testamento: { tema, carga } }; registro: el del servidor.
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
      this.r.info(`MQTT: conectado a ${url}`);
      this._fase("conectada");
      for (const s of this.subs) c.subscribe(s.patron, { qos: 0 });
      this.emit("conectada");
    });
    c.on("reconnect", () => { if (mia() && this.estado.fase !== "error") this._fase("conectando"); });
    c.on("close", () => {
      if (mia() && this.estado.fase === "conectada") { this.r.aviso(`MQTT: se ha cortado la conexión con ${url}; reintentando`); this._fase("conectando"); }
    });
    c.on("error", (e) => {
      if (!mia()) return;
      const txt = textoError(e);
      // El mismo fallo se cuenta una vez, no en cada reintento (cada 5 s).
      if (txt !== this.ultimoError) this.r.aviso(`MQTT: no se pudo conectar con ${url}: ${txt}`);
      this.ultimoError = txt;
      this._fase("error", txt);
    });
    c.on("message", (tema, carga, paquete) => {
      for (const s of this.subs) {
        if (!coincide(s.patron, tema)) continue;
        try { s.fn(tema, carga, paquete); } catch (e) { this.r.error(`MQTT: al atender ${tema}: ${e.stack || e}`); }
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
 * MQTT del servidor: guarda la configuración (SQLite, «mqtt»), mantiene la conexión y engancha lo que la usa: la
 * salida a Home Assistant y los enganches (f(conexion) → cómo soltarla), como la estación, que escucha sus temas.
 * Deja en S.mqtt lo que ven las pantallas (sin contraseña) y avisa con la parte «mqtt».
 * vigia: { S, motor, eventos, almacen, registro }.
 */
export async function crearServicioMqtt(vigia, { crearSalidaHA, clienteId, enganches = [] } = {}) {
  const { S, eventos, almacen, registro } = vigia;
  let cfg = comprobarMqtt(almacen.leer("mqtt", {}) || {}).cfg || { ...MQTT_DEFECTO };
  let conexion = null, ha = null, soltar = [];
  const despedida = () => ({ tema: `${cfg.base}/estado`, carga: "offline" });

  function contar() {
    S.mqtt = { ...configPublica(cfg), estado: conexion ? { ...conexion.estado } : { fase: "parada", desde: Date.now(), error: null } };
    eventos.emit("parte", "mqtt");
  }

  function arrancar() {
    if (cfg.activado && cfg.url) {
      conexion = new ConexionMqtt({ url: cfg.url, usuario: cfg.usuario, clave: cfg.clave, clienteId, testamento: despedida() }, registro);
      conexion.on("estado", contar);
      if (cfg.ha.activado && crearSalidaHA) ha = crearSalidaHA(vigia, conexion, { base: cfg.base, prefijo: cfg.ha.prefijo });
      soltar = enganches.map((f) => f(conexion)); // lo que escucha temas (la estación)
      conexion.arrancar();
    }
    contar();
  }

  async function parar({ retirarHA = false } = {}) {
    if (ha && retirarHA && conexion?.conectada) await ha.retirar();
    ha?.parar();
    ha = null;
    for (const f of soltar.splice(0)) f?.();
    await conexion?.parar(despedida());
    conexion = null;
  }

  contar();
  return {
    get conexion() { return conexion; },
    /** Conecta (si está activado). Lo llama el servidor al arrancar. */
    arrancar: () => { if (!conexion) arrancar(); },
    /** Cambia la configuración (lo que no venga se queda; clave null la borra). Devuelve { ok, toast?, error? }. */
    async configurar(dada) {
      const { cfg: nueva, error } = comprobarMqtt(dada, cfg);
      if (error) return { ok: false, error };
      // Si cambia dónde se publica o se apaga Home Assistant, se quita de HA lo de antes para no dejar entidades huérfanas.
      const haAntes = cfg.activado && cfg.ha.activado;
      const haDespues = nueva.activado && nueva.ha.activado;
      const otroSitio = normalizarUrl(nueva.url) !== normalizarUrl(cfg.url) || nueva.base !== cfg.base || nueva.ha.prefijo !== cfg.ha.prefijo;
      await parar({ retirarHA: haAntes && (!haDespues || otroSitio) });
      cfg = nueva;
      almacen.guardar("mqtt", cfg);
      registro.info(`MQTT: ${cfg.activado ? `conectando con ${normalizarUrl(cfg.url)}${cfg.ha.activado ? ", con Home Assistant" : ""}` : "apagado"}`);
      arrancar();
      return { ok: true, toast: cfg.activado ? "Guardado. Conectando con el broker…" : "Guardado. MQTT apagado." };
    },
    parar: () => parar(),
  };
}
