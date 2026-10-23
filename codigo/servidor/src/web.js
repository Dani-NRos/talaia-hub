// Servidor web: la app de Talaia (la misma de siempre) y su API, para verla y manejarla desde el móvil o el PC.
//
//   GET  /                     la app, que al venir de aquí arranca en modo «Servidor»
//   GET  /api/eventos          estado al conectar y después solo lo que cambia (server-sent events)
//   GET  /api/estado           el estado completo, de una vez
//   POST /api/orden            lo que se pulsa en una pantalla: { orden, … } → { ok, toast?, error? }
//   GET  /api/serie?nodo=&metrica=&desde=&hasta=    lecturas de un sensor
//   GET  /api/lecturas.csv     todo el histórico, para la hoja de cálculo
//   GET  /api/salud            si está vivo y conectado (para vigilar el propio servidor; sin entrar, solo eso)
//   GET  /api/sesion           who this screen is signed in as (401 if nobody; it says if the first user is missing)
//   POST /api/entrar           sign in { nombre, clave }: the session goes in an HttpOnly cookie
//   POST /api/primero          the first user { codigo, nombre, clave }, with the code from the journal/installer
//   POST /api/salir            sign out
//
// Everything but the app's files, /api/salud and signing in needs a session (usuarios.js), also at home. And a page
// from elsewhere can't send orders from the browser of whoever visits it: POSTs are only taken as JSON and from this
// same page, and public domain names are not served (what "DNS rebinding" attacks against home devices use).
//
// Desde fuera de casa, por Tailscale: directamente (http://100.x.y.z:4404, http://bmax:4404) o con «tailscale serve»
// (https://bmax.<red>.ts.net), que deja el nombre tal cual (Host) y así valen las mismas comprobaciones. Lo que llega
// por Tailscale Funnel (abierto a internet) se rechaza.
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { esClaveMqtt } from "@talaia/nucleo/mqtt-datos.js";
import { ASK_ALL } from "@talaia/nucleo/motor.js";
import { metricMeta } from "@talaia/nucleo/metrics.js";
import { crearSincro, instantanea } from "./sincro.js";
import { aparatoDe, llaveDe, SESION_MS } from "./usuarios.js";
import { tx, getLanguage } from "@talaia/nucleo/idioma.js";
import "./textos.js";

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const DOMINIOS_CASA = /\.(local|lan|home|internal|home\.arpa|ts\.net)$/;
const MAX_CUERPO = 16 * 1024;
const CSV_BLOQUE = 5000; // filas por bloque al exportar el histórico
const COOKIE = "talaia_sesion";

export class ErrorOrden extends Error {}

/* ── comprobaciones de lo que llega ── */
const esNodo = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff; // un nodo Meshtastic
const esPanel = (n) => esNodo(n) || (Number.isInteger(n) && n < 0 && n >= -1e6); // o un panel sin nodo (negativo)
const esMetrica = (k) => typeof k === "string" && /^[A-Za-z0-9]{1,40}$/.test(k);
const esValor = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
function exigir(cond, que) { if (!cond) throw new ErrorOrden(tx("s.web.badOrder", { what: que })); }

/** Las órdenes que puede mandar una pantalla. Cada una devuelve { ok, toast?, error? }. */
function crearOrdenes(talaia) {
  const { motor, acciones } = talaia;
  return {
    ack: ({ key }) => { exigir(typeof key === "string", "key"); motor.ack(key); return { ok: true }; },
    ackAll: () => { motor.ackAll(); return { ok: true }; },
    pedir: ({ num, tipo }) => { exigir(esNodo(num), "num"); exigir(Object.hasOwn(ASK_ALL, tipo), "tipo"); motor.ask(num, tipo); return { ok: true }; },
    vigilar: ({ num }) => {
      exigir(esNodo(num), "num");
      const r = acciones.vigilar(num);
      r.recientes?.then(() => talaia.eventos.emit("parte", "recent"));
      return { ok: r.ok, toast: r.toast };
    },
    dejar: ({ num }) => { exigir(esNodo(num), "num"); return acciones.dejarDeVigilar(num); },
    sinSenal: ({ num, valor }) => { exigir(esPanel(num), "num"); exigir(esValor(valor), "valor"); return acciones.ponerSinSenal(num, valor); },
    limite: ({ num, metrica, lado, valor }) => {
      exigir(esPanel(num), "num"); exigir(esMetrica(metrica), "metrica"); exigir(lado === "min" || lado === "max", "lado"); exigir(esValor(valor), "valor");
      return acciones.ponerLimite(num, metrica, lado, valor);
    },
    tendencia: ({ num, metrica, regla }) => { exigir(esPanel(num), "num"); exigir(esMetrica(metrica), "metrica"); exigir(regla && typeof regla === "object", "regla"); return acciones.ponerTendencia(num, metrica, regla); },
    quitarTendencia: ({ num, metrica }) => { exigir(esPanel(num), "num"); exigir(esMetrica(metrica), "metrica"); return acciones.quitarTendencia(num, metrica); },
    valla: ({ num, radio }) => { exigir(esNodo(num), "num"); exigir(esValor(radio), "radio"); return acciones.fijarValla(num, radio); },
    radioValla: ({ num, radio }) => { exigir(esNodo(num), "num"); exigir(esValor(radio), "radio"); return acciones.radioValla(num, radio); },
    quitarValla: ({ num }) => { exigir(esNodo(num), "num"); return acciones.quitarValla(num); },
    sinSenalDefecto: ({ valor }) => { exigir(esValor(valor), "valor"); return acciones.sinSenalPorDefecto(valor); },
    retencion: ({ dias }) => { exigir(typeof dias === "number", "dias"); const r = acciones.retencion(dias); return { ok: r.ok }; },
    idioma: ({ idioma }) => { exigir(typeof idioma === "string", "idioma"); return talaia.idioma(idioma); },
    malla: ({ cambio }) => {
      exigir(cambio && typeof cambio === "object", "cambio");
      const ks = Object.keys(cambio);
      exigir(ks.length === 1 && ["enabled", "onClear", "channel", "node"].includes(ks[0]), "cambio");
      if (ks[0] === "channel" || ks[0] === "node") exigir(cambio[ks[0]] === null || Number.isInteger(cambio[ks[0]]), ks[0]);
      return acciones.avisosMalla(cambio);
    },
    pruebaMalla: () => acciones.pruebaMalla(),
    borrarHistorico: () => acciones.borrarHistorico(),
    reconectar: () => { talaia.receptor.retryNow(); return { ok: true }; },
    broker: async ({ id, cambio }) => {
      exigir(id == null || typeof id === "string", "id");
      exigir(cambio && typeof cambio === "object" && !Array.isArray(cambio), "cambio");
      exigir(Object.keys(cambio).every((k) => ["nombre", "url", "usuario", "clave", "activado"].includes(k)), "cambio");
      for (const k of ["nombre", "url", "usuario"]) if (k in cambio) exigir(typeof cambio[k] === "string", k);
      if ("clave" in cambio) exigir(cambio.clave === null || typeof cambio.clave === "string", "clave");
      if ("activado" in cambio) exigir(typeof cambio.activado === "boolean", "activado");
      return talaia.mqtt.configurarBroker(id ?? null, cambio);
    },
    quitarBroker: ({ id }) => { exigir(typeof id === "string", "id"); return talaia.mqtt.quitarBroker(id); },
    homeAssistant: ({ cambio }) => {
      exigir(cambio && typeof cambio === "object" && !Array.isArray(cambio), "cambio");
      exigir(Object.keys(cambio).every((k) => ["activado", "broker", "base", "prefijo"].includes(k)), "cambio");
      if ("activado" in cambio) exigir(typeof cambio.activado === "boolean", "activado");
      if ("broker" in cambio) exigir(cambio.broker === null || typeof cambio.broker === "string", "broker");
      for (const k of ["base", "prefijo"]) if (k in cambio) exigir(typeof cambio[k] === "string", k);
      return talaia.mqtt.configurarHA(cambio);
    },
    usuarioBroker: ({ nombre, clave }) => { exigir(typeof nombre === "string" && typeof clave === "string", "usuario"); return talaia.mqtt.ponerUsuario(nombre, clave); },
    quitarUsuarioBroker: ({ nombre }) => { exigir(typeof nombre === "string", "nombre"); return talaia.mqtt.quitarUsuario(nombre); },
    crearPanel: ({ nombre, tipo }) => { exigir(typeof nombre === "string" && typeof tipo === "string", "panel"); return talaia.paneles.crearPanel({ nombre, tipo }); },
    quitarPanel: ({ num }) => { exigir(esPanel(num), "num"); return talaia.paneles.quitarPanel(num); },
    renombrar: ({ num, nombre }) => { exigir(esPanel(num), "num"); exigir(typeof nombre === "string", "nombre"); return talaia.paneles.renombrar(num, nombre); },
    tipoPanel: ({ num, tipo }) => { exigir(esPanel(num), "num"); exigir(typeof tipo === "string", "tipo"); return talaia.paneles.tipoPanel(num, tipo); },
    datosPanel: ({ num, datos, conexion }) => {
      exigir(esPanel(num), "num");
      exigir(Array.isArray(datos) && datos.length <= 40, "datos");
      for (const d of datos) {
        exigir(d && typeof d === "object" && Object.keys(d).every((k) => ["clave", "nombre", "tipo", "broker", "tema", "campo", "unidad", "caduca", "malla", "nombres", "invertir", "orden"].includes(k)), "dato");
        if (d.orden != null) {
          exigir(typeof d.orden === "object" && Object.keys(d.orden).every((k) => ["tema", "on", "off"].includes(k)), "dato.orden");
          for (const k of ["tema", "on", "off"]) if (k in d.orden) exigir(typeof d.orden[k] === "string", `dato.orden.${k}`);
        }
        for (const k of ["clave", "nombre", "tipo", "broker", "tema", "campo", "unidad", "nombres"]) if (k in d) exigir(typeof d[k] === "string", `dato.${k}`);
        if ("caduca" in d) exigir(Number.isInteger(d.caduca), "dato.caduca");
        for (const k of ["malla", "invertir"]) if (k in d) exigir(typeof d[k] === "boolean", `dato.${k}`);
      }
      if (conexion != null) {
        exigir(typeof conexion === "object" && Object.keys(conexion).every((k) => ["broker", "tema", "campo", "avisar"].includes(k)), "conexion");
        for (const k of ["broker", "tema", "campo"]) if (k in conexion) exigir(typeof conexion[k] === "string", `conexion.${k}`);
        if ("avisar" in conexion) exigir(typeof conexion.avisar === "boolean", "conexion.avisar");
      }
      return talaia.paneles.guardarDatos(num, datos, conexion);
    },
    mandar: ({ num, clave, v }) => {
      exigir(esPanel(num), "num"); exigir(typeof clave === "string" && /^mq\d+$/.test(clave), "clave"); exigir(v === 0 || v === 1, "v");
      return talaia.paneles.mandar(num, clave, v);
    },
    alarmaEstado: ({ num, metrica, cuando, minutos }) => {
      exigir(esPanel(num), "num"); exigir(esMetrica(metrica), "metrica");
      exigir(cuando === null || cuando === 0 || cuando === 1, "cuando"); exigir(esValor(minutos), "minutos");
      return acciones.ponerEstado(num, metrica, cuando, minutos);
    },
    envioMalla: ({ cambio }) => {
      exigir(cambio && typeof cambio === "object" && !Array.isArray(cambio), "cambio");
      exigir(Object.keys(cambio).every((k) => ["activado", "cada", "canal", "saltos"].includes(k)), "cambio");
      if ("activado" in cambio) exigir(typeof cambio.activado === "boolean", "activado");
      for (const k of ["cada", "canal", "saltos"]) if (k in cambio) exigir(cambio[k] === null || Number.isInteger(cambio[k]), k);
      return talaia.paneles.configurarMalla(cambio);
    },
    buscarTemas: () => talaia.paneles.buscarTemas(),
    enviarMalla: () => talaia.paneles.enviarAhora(),

    /* ── users: everyone can do everything (one kind of user) ── */
    crearUsuario: ({ nombre, clave }, quien) => { exigir(typeof nombre === "string" && typeof clave === "string", "usuario"); return talaia.usuarios.crear(nombre, clave, { por: quien.nombre }); },
    claveUsuario: ({ nombre, clave, actual }, quien) => {
      exigir(typeof nombre === "string" && typeof clave === "string", "usuario"); exigir(actual == null || typeof actual === "string", "actual");
      const propia = llaveDe(nombre) === quien.llave; // one's own needs the current one; it keeps this session
      return talaia.usuarios.cambiarClave(nombre, clave, { actual, propia, menos: propia ? quien.id : null, por: quien.nombre });
    },
    quitarUsuario: ({ nombre }, quien) => { exigir(typeof nombre === "string", "nombre"); return talaia.usuarios.quitar(nombre, { yo: quien.llave, por: quien.nombre }); },
    cerrarSesiones: ({ nombre }, quien) => {
      exigir(typeof nombre === "string", "nombre");
      return talaia.usuarios.cerrarSesiones(nombre, { menos: llaveDe(nombre) === quien.llave ? quien.id : null });
    },
    cerrarSesion: ({ id }) => { exigir(typeof id === "string", "id"); return talaia.usuarios.cerrarUna(id); },
  };
}

/** Direcciones IPv4 de la red de casa, para decir dónde abrir la app (in a container, Docker's own: none). */
export function direcciones(puerto) {
  if (process.env.TALAIA_DOCKER) return [];
  const out = [];
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const d of lista || []) if (d.family === "IPv4" && !d.internal) out.push(`http://${d.address}:${puerto}`);
  }
  return out;
}

/**
 * talaia: lo de crearTalaia. opts: { appDir } carpeta de la app compilada (por defecto, codigo/dist/app).
 */
export function crearWeb(talaia, config, registro, opts = {}) {
  const { S, eventos } = talaia;
  const appDir = opts.appDir || config.web.app || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist/app");
  const nombres = new Set((config.web.nombres || []).map((n) => String(n).toLowerCase()));
  const ordenes = crearOrdenes(talaia);
  const { usuarios } = talaia;
  const clientes = new Map(); // open screens (server-sent events) → their session
  let avisadoFunnel = false;

  /* ── eventos a las pantallas ── */
  const emitir = (tipo, datos) => {
    const msg = `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;
    for (const res of clientes.keys()) res.write(msg);
  };
  /** Screens whose session has ended stop getting anything: they go back to signing in. */
  function cortar(ids) {
    const fuera = new Set(ids);
    for (const [res, id] of clientes) if (fuera.has(id)) { clientes.delete(res); res.end(); }
  }
  const sincro = crearSincro(S, (p) => emitir("cambio", p));
  const escuchas = {
    cambio: () => { sincro.marcar("link"); sincro.marcar("device"); sincro.marcar("trouble"); sincro.marcar("myUser"); },
    parte: (k) => sincro.marcar(k),
    peticion: () => sincro.marcar("req"),
    posicion: () => sincro.marcar("req"),
    avisoMalla: () => sincro.marcar("meshLast"),
    registro: () => sincro.marcar("log"),
    diag: () => sincro.marcar("diag"),
    filas: (rows) => sincro.filas(rows),
    sesionesCerradas: (ids) => cortar(ids),
    alarma: (al) => emitir("alarma", { al, titulo: talaia.motor.alarmTitle(al), detalle: talaia.motor.alarmDetail(al) }),
  };
  for (const [ev, f] of Object.entries(escuchas)) eventos.on(ev, f);
  // Cada 25 s algo por cada conexión abierta: los intermediarios no la cortan y se nota si la pantalla se fue. And
  // each open screen's session is looked at again: still there (ended from the terminal?) and in use (renewed).
  const latido = setInterval(() => {
    for (const [res, id] of clientes) {
      if (!usuarios.sigue(id)) { clientes.delete(res); res.end(); } else res.write(": vivo\n\n");
    }
  }, 25000);

  /* ── comprobaciones ── */
  function hostValido(host) {
    if (!host) return true;
    const h = host.toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
    if (net.isIP(h) || h === "localhost") return true;
    if (!h.includes(".")) return true; // el nombre de la máquina en la red de casa («bmax»)
    return DOMINIOS_CASA.test(h) || nombres.has(h);
  }
  function mismoOrigen(req) {
    const o = req.headers.origin;
    if (!o) return true; // sin Origin: no es un navegador desde otra web
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  }

  /* ── sessions: a cookie only the browser keeps (the page's code can't read it) ── */
  function token(req) {
    const m = /(?:^|;\s*)talaia_sesion=([^;]*)/.exec(req.headers.cookie || "");
    return m ? m[1] : null;
  }
  const sesionDe = (req) => usuarios.sesion(token(req));
  // Over https (tailscale serve) the cookie only travels encrypted; over plain http at home it couldn't be set so.
  const seguro = (req) => /\.ts\.net(:\d+)?$/i.test(req.headers.host || "") || req.headers["x-forwarded-proto"] === "https";
  const galleta = (req, res, valor, s) =>
    res.setHeader("set-cookie", `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${s}${seguro(req) ? "; Secure" : ""}`);
  const renovar = (req, res) => galleta(req, res, token(req), Math.floor(SESION_MS / 1000)); // 30 days more from now

  const json = (res, code, datos) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(datos));
  };
  const leerCuerpo = (req) => new Promise((resolve, reject) => {
    let n = 0;
    const partes = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_CUERPO) { reject(new ErrorOrden(tx("s.web.tooBig"))); req.destroy(); } else partes.push(c); });
    req.on("end", () => resolve(Buffer.concat(partes).toString("utf8")));
    req.on("error", reject);
  });

  /** The body of a POST from this same page, as JSON; null if it was refused (the answer is already sent). */
  async function cuerpoDe(req, res) {
    if (!mismoOrigen(req)) { json(res, 403, { ok: false, error: tx("s.web.otherPage") }); return null; }
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) { json(res, 415, { ok: false, error: tx("s.web.json") }); return null; }
    try {
      const c = JSON.parse(await leerCuerpo(req));
      if (c && typeof c === "object" && !Array.isArray(c)) return c;
    } catch (e) {
      if (e instanceof ErrorOrden) { json(res, 400, { ok: false, error: e.message }); return null; }
    }
    json(res, 400, { ok: false, error: "JSON no válido" });
    return null;
  }

  /* ── signing in and out ── */
  async function entrar(req, res, primero) {
    const c = await cuerpoDe(req, res);
    if (!c) return;
    const aparato = aparatoDe(req.headers["user-agent"]);
    const r = primero
      ? await usuarios.primero(String(c.codigo ?? ""), c.nombre, c.clave, { aparato })
      : await usuarios.entrar(c.nombre, c.clave, { aparato });
    if (!r.ok) return json(res, r.espera ? 429 : primero && usuarios.hay() ? 409 : 401, { ok: false, error: r.error, espera: r.espera });
    galleta(req, res, r.token, Math.floor(SESION_MS / 1000));
    json(res, 200, { ok: true, nombre: r.nombre });
  }
  async function salir(req, res) {
    if (!mismoOrigen(req)) return json(res, 403, { ok: false, error: tx("s.web.otherPage") });
    const s = sesionDe(req);
    if (s) usuarios.salir(s.id);
    galleta(req, res, "", 0);
    json(res, 200, { ok: true });
  }

  /* ── rutas ── */
  async function orden(req, res, quien) {
    const cuerpo = await cuerpoDe(req, res);
    if (!cuerpo) return;
    const f = Object.hasOwn(ordenes, cuerpo.orden) ? ordenes[cuerpo.orden] : null;
    if (!f) return json(res, 400, { ok: false, error: tx("s.web.unknownOrder", { what: cuerpo?.orden }) });
    // Los avisos cortos del motor durante la orden (p. ej. «espera 20 s») vuelven a quien la mandó.
    const avisos = [];
    const oir = (m) => avisos.push(m);
    eventos.on("toast", oir);
    try {
      // Who did it goes with what it writes in the log: only while the order itself runs, not while it waits.
      S.actor = quien.nombre;
      let p;
      try { p = f(cuerpo, quien); } finally { S.actor = null; }
      const r = await p;
      sincro.vaciar(); // que las pantallas vean el cambio ya, antes de la respuesta
      json(res, 200, { ok: !!r?.ok, toast: r?.toast || avisos[0], error: r?.error, ...(r?.radio != null ? { radio: r.radio } : {}), ...(r?.valor != null ? { valor: r.valor } : {}), ...(r?.temas ? { temas: r.temas } : {}), ...(r?.num != null ? { num: r.num } : {}) });
    } catch (e) {
      if (e instanceof ErrorOrden) return json(res, 400, { ok: false, error: e.message });
      registro.error(tx("s.j.orderFail", { what: cuerpo.orden, e: e.stack || e }));
      json(res, 500, { ok: false, error: tx("s.web.fail") });
    } finally {
      eventos.off("toast", oir);
    }
  }

  function eventosSse(req, res, quien) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    res.write(`event: estado\ndata: ${JSON.stringify(instantanea(S))}\n\n`);
    clientes.set(res, quien.id);
    req.on("close", () => clientes.delete(res));
  }

  async function serie(url, res) {
    const num = Number(url.searchParams.get("nodo")), k = url.searchParams.get("metrica");
    const desde = Number(url.searchParams.get("desde") || 0), hasta = Number(url.searchParams.get("hasta") || Number.MAX_SAFE_INTEGER);
    if (!esPanel(num) || !esMetrica(k) || !Number.isFinite(desde) || !Number.isFinite(hasta)) return json(res, 400, { error: tx("s.web.seriesArgs") });
    json(res, 200, await S.store.series(num, k, desde, hasta));
  }

  /**
   * Todo el histórico en CSV. Con un año de todos los nodos pueden ser millones de filas: va por bloques (cada uno,
   * una consulta cerrada que sigue donde acabó la anterior), esperando a que el navegador lea y dejando correr al
   * resto del servidor entre bloque y bloque, para no parar las alarmas ni llenar la memoria.
   */
  async function csv(req, res) {
    // For a spreadsheet in the server's language: in Spanish, semicolons and decimal comma; in English, commas and
    // decimal point. With a BOM, so Excel reads the accents.
    const fecha = new Date().toISOString().slice(0, 10);
    const es = getLanguage() === "es", sep = es ? ";" : ",", dec = (v) => (es ? String(v).replace(".", ",") : String(v));
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="talaia-${fecha}.csv"` });
    const nombre = (n) => `"${talaia.motor.nodeName(n).replaceAll('"', "'")}"`;
    const bloque = talaia.almacen.db.prepare("SELECT nodo, metrica, t, v FROM lecturas WHERE (t, nodo, metrica) > (?, ?, ?) ORDER BY t, nodo, metrica LIMIT ?");
    let cortado = false;
    req.on("close", () => { cortado = true; });
    let txt = `\ufeff${tx("s.csv.head").split(",").join(sep)}\n`;
    let ultimo = [-1, -1, ""];
    for (;;) {
      const filas = bloque.all(...ultimo, CSV_BLOQUE);
      for (const r of filas) {
        const id = r.nodo < 0 ? `panel${-r.nodo}` : `!${(r.nodo >>> 0).toString(16).padStart(8, "0")}`;
        // Los datos MQTT, con su nombre («Temperatura nevera») en vez de su clave interna («mq3»).
        const met = esClaveMqtt(r.metrica) ? `"${metricMeta(r.metrica).label.replaceAll('"', "'")}"` : r.metrica;
        txt += [new Date(r.t).toISOString(), id, nombre(r.nodo), met, dec(r.v), metricMeta(r.metrica).unit].join(sep) + "\n";
      }
      if (filas.length < CSV_BLOQUE) break;
      const u = filas[filas.length - 1];
      ultimo = [u.t, u.nodo, u.metrica];
      if (!res.write(txt)) await new Promise((r) => { res.once("drain", r); res.once("close", r); });
      txt = "";
      await new Promise((r) => setImmediate(r));
      if (cortado || res.destroyed) return;
    }
    res.end(txt);
  }

  function estatico(url, res) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const f = path.resolve(appDir, `.${rel}`);
    if (!f.startsWith(path.resolve(appDir) + path.sep)) return json(res, 404, { error: tx("s.web.notFound") });
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) {
      if (rel === "/index.html") {
        res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><meta charset="utf-8"><title>Talaia</title><p>${tx("s.web.noApp", { dir: appDir })}</p>`);
      }
      return json(res, 404, { error: tx("s.web.notFound") });
    }
    const tipo = TIPOS[path.extname(f)] || "application/octet-stream";
    res.writeHead(200, { "content-type": tipo, "cache-control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  }

  const servidor = http.createServer(async (req, res) => {
    try {
      if (req.headers["tailscale-funnel-request"]) {
        if (!avisadoFunnel) { avisadoFunnel = true; registro.aviso(tx("s.j.funnel")); }
        return json(res, 403, { error: tx("s.web.funnel") });
      }
      if (!hostValido(req.headers.host)) return json(res, 421, { error: tx("s.web.host") });
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
      if (req.method === "POST" && p === "/api/entrar") return await entrar(req, res, false);
      if (req.method === "POST" && p === "/api/primero") return await entrar(req, res, true);
      if (req.method === "POST" && p === "/api/salir") return await salir(req, res);
      if (!p.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: tx("s.web.method") });
        return estatico(url, res); // the app itself: anyone, so it can show how to sign in
      }
      const quien = sesionDe(req);
      if (p === "/api/salud" && req.method === "GET") {
        if (!quien) return json(res, 200, { ok: true, receptor: S.link.state }); // alive, and nothing else
        return json(res, 200, { ok: true, receptor: S.link.state, nodos: S.nodes.size, alarmas: S.active.size, lecturas: await S.store.count() });
      }
      if (p === "/api/sesion" && req.method === "GET") {
        if (!quien) return json(res, 401, { ok: false, primero: !usuarios.hay(), ...(process.env.TALAIA_DOCKER ? { docker: true } : {}) });
        renovar(req, res);
        return json(res, 200, { ok: true, nombre: quien.nombre, sesion: quien.id.slice(0, 12) });
      }
      if (!quien) return json(res, 401, { ok: false, entrar: true, primero: !usuarios.hay(), error: tx("s.web.signIn") });
      if (req.method === "POST" && p === "/api/orden") return await orden(req, res, quien);
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: tx("s.web.method") });
      if (p === "/api/eventos") { renovar(req, res); return eventosSse(req, res, quien); }
      if (p === "/api/estado") return json(res, 200, instantanea(S));
      if (p === "/api/serie") return await serie(url, res);
      if (p === "/api/lecturas.csv") return await csv(req, res);
      return json(res, 404, { error: tx("s.web.notFound") });
    } catch (e) {
      registro.error(`Web: ${e.stack || e}`);
      if (!res.headersSent) json(res, 500, { error: tx("s.web.fail") });
      else res.end();
    }
  });

  return {
    servidor,
    get clientes() { return clientes.size; },
    escuchar() {
      return new Promise((resolve, reject) => {
        servidor.once("error", reject);
        servidor.listen(config.web.puerto, config.web.escuchar, () => { servidor.off("error", reject); resolve(servidor.address().port); });
      });
    },
    async cerrar() {
      clearInterval(latido);
      sincro.parar();
      for (const [ev, f] of Object.entries(escuchas)) eventos.off(ev, f);
      for (const res of clientes.keys()) res.end();
      clientes.clear();
      const cerrado = new Promise((r) => servidor.close(() => r()));
      // Sin esperar a las conexiones que quedan abiertas (las de las pantallas, de «keep-alive»): se para ya.
      servidor.closeAllConnections();
      await cerrado;
    },
  };
}
