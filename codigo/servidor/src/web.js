// Servidor web: la app de Vigía (la misma de siempre) y su API, para verla y manejarla desde el móvil o el PC.
//
//   GET  /                     la app, que al venir de aquí arranca en modo «Servidor»
//   GET  /api/eventos          estado al conectar y después solo lo que cambia (server-sent events)
//   GET  /api/estado           el estado completo, de una vez
//   POST /api/orden            lo que se pulsa en una pantalla: { orden, … } → { ok, toast?, error? }
//   GET  /api/serie?nodo=&metrica=&desde=&hasta=    lecturas de un sensor
//   GET  /api/lecturas.csv     todo el histórico, para la hoja de cálculo
//   GET  /api/salud            si está vivo y conectado (para vigilar el propio servidor)
//
// Sin contraseña (la red de casa es la protección), pero sin dejar que una web ajena mande órdenes desde el
// navegador de quien la visita: las órdenes solo se aceptan en JSON y desde la propia página, y no se atienden
// nombres de dominio públicos (lo que usan los ataques de «DNS rebinding» contra aparatos de la red local).
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { ASK_ALL } from "@vigia/nucleo/motor.js";
import { metricMeta } from "@vigia/nucleo/metrics.js";
import { crearSincro, instantanea } from "./sincro.js";

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const DOMINIOS_CASA = /\.(local|lan|home|internal|home\.arpa|ts\.net)$/;
const MAX_CUERPO = 16 * 1024;
const CSV_BLOQUE = 5000; // filas por bloque al exportar el histórico

export class ErrorOrden extends Error {}

/* ── comprobaciones de lo que llega ── */
const esNodo = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const esMetrica = (k) => typeof k === "string" && /^[A-Za-z0-9]{1,40}$/.test(k);
const esValor = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
function exigir(cond, que) { if (!cond) throw new ErrorOrden(`orden no válida: ${que}`); }

/** Las órdenes que puede mandar una pantalla. Cada una devuelve { ok, toast?, error? }. */
function crearOrdenes(vigia) {
  const { motor, acciones } = vigia;
  return {
    ack: ({ key }) => { exigir(typeof key === "string", "key"); motor.ack(key); return { ok: true }; },
    ackAll: () => { motor.ackAll(); return { ok: true }; },
    pedir: ({ num, tipo }) => { exigir(esNodo(num), "num"); exigir(Object.hasOwn(ASK_ALL, tipo), "tipo"); motor.ask(num, tipo); return { ok: true }; },
    vigilar: ({ num }) => {
      exigir(esNodo(num), "num");
      const r = acciones.vigilar(num);
      r.recientes?.then(() => vigia.eventos.emit("parte", "recent"));
      return { ok: r.ok, toast: r.toast };
    },
    dejar: ({ num }) => { exigir(esNodo(num), "num"); return acciones.dejarDeVigilar(num); },
    sinSenal: ({ num, valor }) => { exigir(esNodo(num), "num"); exigir(esValor(valor), "valor"); return acciones.ponerSinSenal(num, valor); },
    limite: ({ num, metrica, lado, valor }) => {
      exigir(esNodo(num), "num"); exigir(esMetrica(metrica), "metrica"); exigir(lado === "min" || lado === "max", "lado"); exigir(esValor(valor), "valor");
      return acciones.ponerLimite(num, metrica, lado, valor);
    },
    tendencia: ({ num, metrica, regla }) => { exigir(esNodo(num), "num"); exigir(esMetrica(metrica), "metrica"); exigir(regla && typeof regla === "object", "regla"); return acciones.ponerTendencia(num, metrica, regla); },
    quitarTendencia: ({ num, metrica }) => { exigir(esNodo(num), "num"); exigir(esMetrica(metrica), "metrica"); return acciones.quitarTendencia(num, metrica); },
    valla: ({ num, radio }) => { exigir(esNodo(num), "num"); exigir(esValor(radio), "radio"); return acciones.fijarValla(num, radio); },
    radioValla: ({ num, radio }) => { exigir(esNodo(num), "num"); exigir(esValor(radio), "radio"); return acciones.radioValla(num, radio); },
    quitarValla: ({ num }) => { exigir(esNodo(num), "num"); return acciones.quitarValla(num); },
    sinSenalDefecto: ({ valor }) => { exigir(esValor(valor), "valor"); return acciones.sinSenalPorDefecto(valor); },
    retencion: ({ dias }) => { exigir(typeof dias === "number", "dias"); const r = acciones.retencion(dias); return { ok: r.ok }; },
    malla: ({ cambio }) => {
      exigir(cambio && typeof cambio === "object", "cambio");
      const ks = Object.keys(cambio);
      exigir(ks.length === 1 && ["enabled", "onClear", "channel", "node"].includes(ks[0]), "cambio");
      if (ks[0] === "channel" || ks[0] === "node") exigir(cambio[ks[0]] === null || Number.isInteger(cambio[ks[0]]), ks[0]);
      return acciones.avisosMalla(cambio);
    },
    pruebaMalla: () => acciones.pruebaMalla(),
    borrarHistorico: () => acciones.borrarHistorico(),
    reconectar: () => { vigia.receptor.retryNow(); return { ok: true }; },
    mqtt: async ({ cambio }) => {
      exigir(cambio && typeof cambio === "object" && !Array.isArray(cambio), "cambio");
      exigir(Object.keys(cambio).every((k) => ["activado", "url", "usuario", "clave", "base", "ha"].includes(k)), "cambio");
      if ("activado" in cambio) exigir(typeof cambio.activado === "boolean", "activado");
      for (const k of ["url", "usuario", "base"]) if (k in cambio) exigir(typeof cambio[k] === "string", k);
      if ("clave" in cambio) exigir(cambio.clave === null || typeof cambio.clave === "string", "clave");
      if ("ha" in cambio) {
        const h = cambio.ha;
        exigir(h && typeof h === "object" && Object.keys(h).every((k) => ["activado", "prefijo"].includes(k)), "ha");
        if ("activado" in h) exigir(typeof h.activado === "boolean", "ha.activado");
        if ("prefijo" in h) exigir(typeof h.prefijo === "string", "ha.prefijo");
      }
      return vigia.mqtt.configurar(cambio);
    },
  };
}

/** Direcciones IPv4 de la red de casa, para decir dónde abrir la app. */
export function direcciones(puerto) {
  const out = [];
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const d of lista || []) if (d.family === "IPv4" && !d.internal) out.push(`http://${d.address}:${puerto}`);
  }
  return out;
}

/**
 * vigia: lo de crearVigia. opts: { appDir } carpeta de la app compilada (por defecto, codigo/dist/app).
 */
export function crearWeb(vigia, config, registro, opts = {}) {
  const { S, eventos } = vigia;
  const appDir = opts.appDir || config.web.app || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist/app");
  const nombres = new Set((config.web.nombres || []).map((n) => String(n).toLowerCase()));
  const ordenes = crearOrdenes(vigia);
  const clientes = new Set();

  /* ── eventos a las pantallas ── */
  const emitir = (tipo, datos) => {
    const msg = `event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`;
    for (const res of clientes) res.write(msg);
  };
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
    alarma: (al) => emitir("alarma", { al, titulo: vigia.motor.alarmTitle(al), detalle: vigia.motor.alarmDetail(al) }),
  };
  for (const [ev, f] of Object.entries(escuchas)) eventos.on(ev, f);
  // Cada 25 s algo por cada conexión abierta: los intermediarios no la cortan y se nota si la pantalla se fue.
  const latido = setInterval(() => { for (const res of clientes) res.write(": vivo\n\n"); }, 25000);

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

  const json = (res, code, datos) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(datos));
  };
  const leerCuerpo = (req) => new Promise((resolve, reject) => {
    let n = 0;
    const partes = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_CUERPO) { reject(new ErrorOrden("orden demasiado grande")); req.destroy(); } else partes.push(c); });
    req.on("end", () => resolve(Buffer.concat(partes).toString("utf8")));
    req.on("error", reject);
  });

  /* ── rutas ── */
  async function orden(req, res) {
    if (!mismoOrigen(req)) return json(res, 403, { ok: false, error: "orden desde otra página" });
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return json(res, 415, { ok: false, error: "las órdenes van en JSON" });
    let cuerpo;
    try { cuerpo = JSON.parse(await leerCuerpo(req)); } catch (e) { return json(res, 400, { ok: false, error: e instanceof ErrorOrden ? e.message : "JSON no válido" }); }
    const f = ordenes[cuerpo?.orden];
    if (!f) return json(res, 400, { ok: false, error: `orden desconocida: ${cuerpo?.orden}` });
    // Los avisos cortos del motor durante la orden (p. ej. «espera 20 s») vuelven a quien la mandó.
    const avisos = [];
    const oir = (m) => avisos.push(m);
    eventos.on("toast", oir);
    try {
      const r = await f(cuerpo);
      sincro.vaciar(); // que las pantallas vean el cambio ya, antes de la respuesta
      json(res, 200, { ok: !!r?.ok, toast: r?.toast || avisos[0], error: r?.error, ...(r?.radio != null ? { radio: r.radio } : {}), ...(r?.valor != null ? { valor: r.valor } : {}) });
    } catch (e) {
      if (e instanceof ErrorOrden) return json(res, 400, { ok: false, error: e.message });
      registro.error(`Orden «${cuerpo.orden}»: ${e.stack || e}`);
      json(res, 500, { ok: false, error: "fallo del servidor" });
    } finally {
      eventos.off("toast", oir);
    }
  }

  function eventosSse(req, res) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    res.write(`event: estado\ndata: ${JSON.stringify(instantanea(S))}\n\n`);
    clientes.add(res);
    req.on("close", () => clientes.delete(res));
  }

  async function serie(url, res) {
    const num = Number(url.searchParams.get("nodo")), k = url.searchParams.get("metrica");
    const desde = Number(url.searchParams.get("desde") || 0), hasta = Number(url.searchParams.get("hasta") || Number.MAX_SAFE_INTEGER);
    if (!esNodo(num) || !esMetrica(k) || !Number.isFinite(desde) || !Number.isFinite(hasta)) return json(res, 400, { error: "nodo, metrica, desde y hasta" });
    json(res, 200, await S.store.series(num, k, desde, hasta));
  }

  /**
   * Todo el histórico en CSV. Con un año de todos los nodos pueden ser millones de filas: va por bloques (cada uno,
   * una consulta cerrada que sigue donde acabó la anterior), esperando a que el navegador lea y dejando correr al
   * resto del servidor entre bloque y bloque, para no parar las alarmas ni llenar la memoria.
   */
  async function csv(req, res) {
    // El mismo formato que la exportación de la app: punto y coma, coma decimal y BOM para Excel.
    const fecha = new Date().toISOString().slice(0, 10);
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="vigia-servidor-${fecha}.csv"` });
    const nombre = (n) => `"${vigia.motor.nodeName(n).replaceAll('"', "'")}"`;
    const bloque = vigia.almacen.db.prepare("SELECT nodo, metrica, t, v FROM lecturas WHERE (t, nodo, metrica) > (?, ?, ?) ORDER BY t, nodo, metrica LIMIT ?");
    let cortado = false;
    req.on("close", () => { cortado = true; });
    let txt = "\ufefffecha;nodo;nombre;metrica;valor;unidad\n";
    let ultimo = [-1, -1, ""];
    for (;;) {
      const filas = bloque.all(...ultimo, CSV_BLOQUE);
      for (const r of filas) {
        txt += [new Date(r.t).toISOString(), `!${(r.nodo >>> 0).toString(16).padStart(8, "0")}`, nombre(r.nodo), r.metrica, String(r.v).replace(".", ","), metricMeta(r.metrica).unit].join(";") + "\n";
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
    if (!f.startsWith(path.resolve(appDir) + path.sep)) return json(res, 404, { error: "no existe" });
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) {
      if (rel === "/index.html") {
        res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><meta charset="utf-8"><title>Vigía servidor</title><p>El servidor está en marcha, pero la pantalla no está compilada (falta ${appDir}). Vuelve a ejecutar el instalador.</p>`);
      }
      return json(res, 404, { error: "no existe" });
    }
    const tipo = TIPOS[path.extname(f)] || "application/octet-stream";
    if (rel === "/index.html") {
      // Marca para que la app arranque en modo «Servidor».
      const html = fs.readFileSync(f, "utf8").replace("<head>", "<head>\n<script>window.__VIGIA_SERVIDOR = true;</script>");
      res.writeHead(200, { "content-type": tipo, "cache-control": "no-cache" });
      return res.end(html);
    }
    res.writeHead(200, { "content-type": tipo, "cache-control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  }

  const servidor = http.createServer(async (req, res) => {
    try {
      if (!hostValido(req.headers.host)) return json(res, 421, { error: "nombre de servidor no admitido; añádelo a web.nombres en la configuración" });
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
      if (req.method === "POST" && p === "/api/orden") return await orden(req, res);
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "método no admitido" });
      if (p === "/api/eventos") return eventosSse(req, res);
      if (p === "/api/estado") return json(res, 200, instantanea(S));
      if (p === "/api/serie") return await serie(url, res);
      if (p === "/api/lecturas.csv") return await csv(req, res);
      if (p === "/api/salud") return json(res, 200, { ok: true, receptor: S.link.state, nodos: S.nodes.size, alarmas: S.active.size, lecturas: await S.store.count() });
      if (p.startsWith("/api/")) return json(res, 404, { error: "no existe" });
      return estatico(url, res);
    } catch (e) {
      registro.error(`Web: ${e.stack || e}`);
      if (!res.headersSent) json(res, 500, { error: "fallo del servidor" });
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
      for (const res of clientes) res.end();
      clientes.clear();
      await new Promise((r) => servidor.close(() => r()));
    },
  };
}
