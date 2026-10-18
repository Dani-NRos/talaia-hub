// El servidor por dentro: el motor del núcleo (el mismo que la app) conectado al receptor y a SQLite.
// Funciona 24/7: alarmas, histórico y registro aunque no haya nadie mirando.
import path from "node:path";
import { EventEmitter } from "node:events";
import { crearMotor, estadoInicial, INFO_SUPPRESS, seriesKey } from "@vigia/nucleo/motor.js";
import { HOUR, DAY } from "@vigia/nucleo/textos.js";
import { abrirAlmacen } from "./almacen.js";
import { ReceptorNodo, CONSEJO } from "./receptor.js";
import { describirReceptor } from "./config.js";

const GUARDAR_NODOS_MS = 30000; // la lista de nodos (cientos) se guarda como mucho cada 30 s
const DIAG_MAX = 200;

/**
 * config: la de config.js. registro: el de registro.js.
 * opts: { almacen, receptorOpts } para las pruebas (almacén en memoria, enlace simulado).
 */
export async function crearVigia(config, registro, opts = {}) {
  const almacen = opts.almacen || abrirAlmacen(path.join(config.datos, "vigia.db"));
  const eventos = new EventEmitter();
  const S = estadoInicial();
  S.diag = [];

  /* ── estado guardado ── */
  S.settings = { ...S.settings, retentionDays: config.retencionDias, ...almacen.leer("settings", {}) };
  S.cfg = almacen.leer("cfg", { watched: {} }) || { watched: {} };
  if (!S.cfg.watched) S.cfg.watched = {};
  S.nodes = new Map((almacen.leer("nodes", []) || []).map((n) => [n.num, n]));
  S.log = almacen.leer("log", []) || [];
  S.active = new Map((almacen.leer("active", []) || []).map((a) => [a.key, a]));
  S.myNode = almacen.leer("my", null);
  S.channels = almacen.leer("channels", []) || [];
  S.infoAsked = almacen.leer("infoAsk", {}) || {};
  S.traces = almacen.leer("traces", {}) || {};
  S.lora = almacen.leer("lora", null);
  // Si el disco falla, se apunta y se sigue vigilando.
  S.store = { ...almacen.lecturas, add: (rows) => (cerrado ? Promise.resolve() : almacen.lecturas.add(rows).catch((e) => registro.error(`No se pudo guardar una lectura: ${e.message}`))) };

  /* ── guardado ── */
  let cerrado = false;
  let nodosT = null;
  const guardarNodos = () => { clearTimeout(nodosT); nodosT = null; almacen.guardar("nodes", [...S.nodes.values()]); };
  const GUARDAR = {
    cfg: () => almacen.guardar("cfg", S.cfg),
    nodes: () => { if (!nodosT) nodosT = setTimeout(guardarNodos, GUARDAR_NODOS_MS); },
    log: () => { almacen.guardar("log", S.log.slice(0, 200)); contarRegistro(); },
    active: () => almacen.guardar("active", [...S.active.values()]),
    infoAsk: () => almacen.guardar("infoAsk", Object.fromEntries(Object.entries(S.infoAsked).filter(([, t]) => Date.now() - t < INFO_SUPPRESS))),
    traces: () => almacen.guardar("traces", S.traces),
    channels: () => almacen.guardar("channels", S.channels),
    lora: () => almacen.guardar("lora", S.lora),
    my: () => almacen.guardar("my", S.myNode),
    settings: () => almacen.guardar("settings", S.settings),
  };
  // Lo que entra en el registro de Vigía (alarmas, Enterado, peticiones, avisos) va también al del sistema.
  let ultimo = S.log[0] || null;
  function contarRegistro() {
    const nuevas = [];
    for (const e of S.log) { if (e === ultimo) break; nuevas.push(e); }
    ultimo = S.log[0] || null;
    for (const e of nuevas.reverse()) (e.type === "raise" ? registro.aviso : registro.info)(`${e.type === "raise" ? "Alarma" : e.type === "clear" ? "Resuelta" : e.type === "ack" ? "Vista" : "Registro"}: ${e.text}`);
  }

  /* ── motor ── */
  let receptor = null;
  const motor = crearMotor(S, {
    cambio: () => eventos.emit("cambio"),
    lectura: (num) => eventos.emit("lectura", num),
    posicion: (num) => eventos.emit("posicion", num),
    peticion: (num) => eventos.emit("peticion", num),
    peticionEstado: (num) => eventos.emit("peticion", num),
    ruta: (num) => eventos.emit("ruta", num),
    avisoMalla: () => eventos.emit("avisoMalla"),
    registro: () => eventos.emit("registro"),
    alarma: (al) => eventos.emit("alarma", al),
    toast: (msg) => { registro.info(msg); eventos.emit("toast", msg); },
    diag: (e) => diag(e),
    guardar: (k) => { if (!cerrado) GUARDAR[k]?.(); },
    radio: {
      listo: () => !!receptor?.mesh,
      requestTelemetry: (...a) => receptor.requestTelemetry(...a),
      requestNodeInfo: (...a) => receptor.requestNodeInfo(...a),
      requestPosition: (...a) => receptor.requestPosition(...a),
      requestTraceroute: (...a) => receptor.requestTraceroute(...a),
      sendText: (...a) => receptor.sendText(...a),
    },
  });

  function diag(e) {
    S.diag.unshift(e);
    if (S.diag.length > DIAG_MAX) S.diag.length = DIAG_MAX;
    // Cada fallo ya lo cuenta onTrouble (y no en cada reintento): aquí, solo con el nivel «depurar».
    (/^Fallo en fase/.test(e.msg) ? registro.depurar : registro.info)(`Receptor: ${e.msg}`);
    eventos.emit("diag", e);
  }

  /* ── histórico reciente de los nodos vigilados (para el cambio rápido) ── */
  const desde = Date.now() - 26 * HOUR;
  for (const num of Object.keys(S.cfg.watched).map(Number)) {
    const n = S.nodes.get(num);
    if (!n) continue;
    for (const k of Object.keys(n.metrics || {})) {
      const ser = await S.store.series(num, k, desde);
      if (ser.length) S.recent.set(seriesKey(num, k), ser);
    }
  }

  /* ── receptor ── */
  let avisados = 0;
  receptor = new ReceptorNodo({
    onStatus(state, extra) {
      const antes = S.link.state;
      S.link = { state, extra: extra || null };
      if (state !== antes) registro.depurar(`Receptor: ${state}`);
      eventos.emit("cambio");
    },
    onDevice(dev) { S.device = dev; },
    onReady() {
      motor.resetClock();
      setTimeout(motor.pumpMesh, 1500);
      avisados = 0;
      motor.clearAlarm("link", {});
      if (S.myNode != null) S.device = { ...S.device, name: motor.nodeName(S.myNode) };
      motor.addLog("info", `Receptor listo ${receptor.kind === "tcp" ? "por la red" : "por cable"}: ${S.myNode != null ? motor.nodeName(S.myNode) : S.device?.name || "nodo"}`);
      motor.evalOffline();
      eventos.emit("cambio");
    },
    onLost() {
      motor.raise("link", { kind: "link", num: null, t: Date.now() });
      motor.evalOffline();
    },
    onTrouble(info) {
      S.trouble = info;
      // Al principio, cada fallo; luego, de vez en cuando, para no llenar el diario si el nodo está desenchufado.
      avisados++;
      if (avisados <= 3 || avisados % 20 === 0) {
        registro.aviso(`No se pudo conectar con el receptor ${describirReceptor(config.receptor)} (intento ${info.count}): ${info.detail || info.kind}. ${CONSEJO[info.kind] || ""}`.trim());
      }
      eventos.emit("cambio");
    },
    onDiag: (e) => diag(e),
    onChannel: (c) => motor.recibir.channel(c),
    onLora: (l) => motor.recibir.lora(l),
    onNotice: (n) => motor.recibir.notice(n),
    onMyNode: (num) => motor.recibir.myNode(num),
    onNodeInfo: (ni) => motor.recibir.nodeInfo(ni),
    onUser: (from, user, meta) => motor.recibir.user(from, user, meta),
    onPacket: (p) => motor.recibir.packet(p),
    onPosition: (p) => motor.recibir.position(p),
    onTelemetry: (p) => motor.recibir.telemetry(p),
  }, config.receptor, opts.receptorOpts);

  /* ── tareas periódicas ── */
  const offlineId = setInterval(() => motor.evalOffline(), 15000);
  async function podar() {
    const dias = S.settings.retentionDays || config.retencionDias;
    try {
      const n = await almacen.lecturas.prune(Date.now() - dias * DAY);
      const total = await almacen.lecturas.count();
      registro.info(`Histórico: ${total.toLocaleString("es-ES")} lecturas de los últimos ${dias} días${n ? ` (${n.toLocaleString("es-ES")} más antiguas borradas)` : ""}; base de datos de ${(almacen.tamano() / 1048576).toFixed(1)} MB`);
    } catch (e) {
      registro.error(`No se pudo podar el histórico: ${e.message}`);
    }
  }
  await podar();
  const podarId = setInterval(podar, 6 * HOUR);

  return {
    S, motor, almacen, eventos,
    get receptor() { return receptor; },
    /** Empieza a conectar con el receptor (y a reintentar mientras no se pare). */
    arrancar() {
      registro.info(`Receptor ${describirReceptor(config.receptor)}${config.receptor.tipo === "usb" && config.receptor.puerto === "auto" ? " (el nodo que haya enchufado)" : ""}`);
      registro.info(`Avisos por la malla: ${S.settings.mesh?.enabled ? "encendidos" : "apagados"}`);
      receptor.start();
    },
    async detener() {
      if (cerrado) return;
      clearInterval(offlineId);
      clearInterval(podarId);
      await receptor.disconnect();
      motor.resetAsks(); // peticiones a medias: sus temporizadores ya no deben tocar nada
      guardarNodos();
      cerrado = true;
      eventos.removeAllListeners();
      almacen.cerrar();
    },
  };
}
