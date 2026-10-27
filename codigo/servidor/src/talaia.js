// El servidor por dentro: el motor del núcleo (el mismo que la app) conectado al receptor y a SQLite.
// Funciona 24/7: alarmas, histórico y registro aunque no haya nadie mirando.
import { EventEmitter } from "node:events";
import { crearMotor, estadoInicial, INFO_SUPPRESS } from "@talaia/nucleo/motor.js";
import { crearAcciones } from "@talaia/nucleo/acciones.js";
import { HOUR, DAY } from "@talaia/nucleo/textos.js";
import { abrirAlmacen, rutaAlmacen } from "./almacen.js";
import { ReceptorNodo, consejo } from "./receptor.js";
import { describirReceptor } from "./config.js";
import os from "node:os";
import { crearServicioMqtt, migrar as migrarMqtt } from "./mqtt.js";
import { crearSalidaHA } from "./homeassistant.js";
import { crearPaneles, migrarEstacion } from "./paneles.js";
import { createTelegram } from "./telegram.js";
import { createAutomations } from "./automations.js";
import { createMeshOrders } from "./mesh-orders.js";
import { crearBrokerLocal } from "./mosquitto.js";
import { crearUsuarios } from "./usuarios.js";
import { tx, setLanguage, localeOf, LANGUAGES } from "@talaia/nucleo/idioma.js";
import "./textos.js";

const GUARDAR_NODOS_MS = 30000; // la lista de nodos (cientos) se guarda como mucho cada 30 s
const DIAG_MAX = 200;

/**
 * config: la de config.js. registro: el de registro.js.
 * opts: { almacen, receptorOpts, automations, meshOrders, meshGap } para las pruebas (almacén en memoria, enlace simulado, tiempos
 * cortos).
 */
export async function crearTalaia(config, registro, opts = {}) {
  const almacen = opts.almacen || abrirAlmacen(rutaAlmacen(config.datos, { mover: true }));
  const eventos = new EventEmitter();
  const S = estadoInicial();
  S.diag = [];

  /* ── estado guardado ── */
  S.settings = { ...S.settings, retentionDays: config.retencionDias, ...almacen.leer("settings", {}) };
  // What the server writes (log, mesh alerts, Home Assistant, replies, the journal), in its language.
  // Without one: a new installation (nothing of the mesh saved yet), the one it's given (the machine's); one of
  // before 3.4, Spanish, as it was then.
  if (!LANGUAGES.includes(S.settings.language)) {
    const nueva = almacen.leer("nodes", null) == null && almacen.leer("cfg", null) == null;
    S.settings.language = nueva && LANGUAGES.includes(opts.idiomaNuevo) ? opts.idiomaNuevo : "es";
    almacen.guardar("settings", { ...almacen.leer("settings", {}), language: S.settings.language });
  }
  setLanguage(S.settings.language);
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
  migrarMqtt(almacen); // la configuración de la 1.16 (un broker)…
  migrarEstacion({ almacen, S, registro }); // …y su estación, que pasa al panel del receptor
  // Si el disco falla, se apunta y se sigue vigilando.
  S.store = {
    ...almacen.lecturas,
    add(rows) {
      if (cerrado) return Promise.resolve();
      eventos.emit("filas", rows);
      return almacen.lecturas.add(rows).catch((e) => registro.error(tx("s.j.saveFail", { e: e.message })));
    },
  };

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
    settings: () => almacen.guardar("settings", { defaultOfflineMin: S.settings.defaultOfflineMin, retentionDays: S.settings.retentionDays, mesh: S.settings.mesh, language: S.settings.language }),
  };
  // Lo que entra en el registro de Talaia (alarmas, Enterado, peticiones, avisos) va también al del sistema.
  let ultimo = S.log[0] || null;
  function contarRegistro() {
    const nuevas = [];
    for (const e of S.log) { if (e === ultimo) break; nuevas.push(e); }
    ultimo = S.log[0] || null;
    for (const e of nuevas.reverse()) (e.type === "raise" ? registro.aviso : registro.info)(tx(`s.j.log.${["raise", "clear", "ack"].includes(e.type) ? e.type : "info"}`, { text: e.text }) + (e.by ? ` (${e.by})` : ""));
  }

  /* ── motor ── */
  let receptor = null;
  let meshOrders = null; // orders over the mesh (2.1b), made once the panels and the automations are there
  const motor = crearMotor(S, {
    cambio: () => eventos.emit("cambio"),
    lectura: (num) => eventos.emit("lectura", num),
    valor: (num, k) => eventos.emit("valor", num, k), // the automations
    publicKey: (num, k) => meshOrders?.publicKey(num, k),
    meshGap: opts.meshGap,
    posicion: (num) => eventos.emit("posicion", num),
    peticion: (num) => eventos.emit("peticion", num),
    peticionEstado: (num) => eventos.emit("peticion", num),
    ruta: (num) => eventos.emit("ruta", num),
    avisoMalla: () => eventos.emit("avisoMalla"),
    registro: () => eventos.emit("registro"),
    alarma: (al) => eventos.emit("alarma", al),
    toast: (msg) => { registro.info(msg); eventos.emit("toast", msg); },
    diag: (e) => diag(e),
    guardar: (k) => {
      if (cerrado) return;
      GUARDAR[k]?.();
      eventos.emit("parte", k === "my" ? "myNode" : k);
      if (k === "cfg") eventos.emit("parte", "recent"); // vigilar o dejar de vigilar cambia qué series van
    },
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
    (e.stage ? registro.depurar : registro.info)(tx("s.j.receiver", { msg: e.msg }));
    eventos.emit("diag", e);
  }

  /* ── who can open the screens ── */
  const usuarios = crearUsuarios({ almacen, datos: opts.almacen ? null : config.datos, registro, apuntar: (texto, por) => motor.addLog("info", texto, null, por ? { by: por } : null), alCerrar: (ids) => eventos.emit("sesionesCerradas", ids) });
  S.usuarios = usuarios.lista();
  usuarios.alCambiar = () => { S.usuarios = usuarios.lista(); eventos.emit("parte", "usuarios"); };

  /* ── acciones del usuario (las mismas que en la app) y lecturas recientes de los vigilados ── */
  const acciones = crearAcciones(motor);
  await acciones.cargarRecientes();

  /* ── receptor ── */
  let avisados = 0;
  receptor = new ReceptorNodo({
    onStatus(state, extra) {
      const antes = S.link.state;
      S.link = { state, extra: extra || null };
      if (state !== antes) registro.depurar(tx("s.j.receiver", { msg: state }));
      eventos.emit("cambio");
    },
    onDevice(dev) { S.device = dev; },
    onReady() {
      S.trouble = null;
      meshOrders?.ready();
      motor.resetClock();
      setTimeout(motor.pumpMesh, 1500);
      avisados = 0;
      motor.clearAlarm("link", {});
      if (S.myNode != null) S.device = { ...S.device, name: motor.nodeName(S.myNode) };
      motor.addLog("info", tx(receptor.kind === "tcp" ? "s.log.readyNet" : "s.log.readyUsb", { name: S.myNode != null ? motor.nodeName(S.myNode) : S.device?.name || tx("s.node") }));
      registro.info(tx("s.j.nodes", { n: S.nodes.size.toLocaleString(localeOf()), watched: Object.keys(S.cfg.watched).length }));
      motor.evalOffline();
      eventos.emit("cambio");
    },
    onLost() {
      motor.raise("link", { kind: "link", num: null, t: Date.now() });
      motor.evalOffline();
    },
    onTrouble(info) {
      S.trouble = { ...info, consejo: consejo(info.kind) };
      // Al principio, cada fallo; luego, de vez en cuando, para no llenar el diario si el nodo está desenchufado.
      avisados++;
      if (avisados <= 3 || avisados % 20 === 0) {
        registro.aviso(tx("s.j.rxFail", { how: describirReceptor(config.receptor), n: info.count, why: info.detail || info.kind, tip: consejo(info.kind) }).trim());
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
    onPacket: (p) => { motor.recibir.packet(p); meshOrders?.packet(p); },
    onPosition: (p) => motor.recibir.position(p),
    onTelemetry: (p) => motor.recibir.telemetry(p),
  }, config.receptor, opts.receptorOpts);

  /* ── MQTT: varios brokers (el de este equipo, si lo hay, y los que se añadan), Home Assistant y la estación ── */
  const local = config.mosquitto ? crearBrokerLocal({ config, almacen, registro }) : null;
  let mqtt = null;
  const paneles = crearPaneles({ S, motor, eventos, almacen, registro, receptor: () => receptor, brokers: () => mqtt?.brokers() || [] });
  mqtt = await crearServicioMqtt({ S, motor, eventos, almacen, registro }, {
    crearSalidaHA, clienteId: `talaia-${os.hostname()}`, enganches: [paneles.enganchar, ...(local ? [local.enganchar] : [])], local, usos: paneles.usos,
  });

  /* ── automations (2.1): «if … then …» ── */
  const automations = createAutomations({ S, motor, paneles, almacen, eventos, registro, timing: opts.automations, orderWords: () => meshOrders?.words() ?? new Set() });
  meshOrders = createMeshOrders({ S, motor, paneles, automations, almacen, eventos, timing: opts.meshOrders });
  /* ── Telegram: the alarms to a bot, and orders from it ── */
  // (TALAIA_TELEGRAM_API points the bot at a fake Bot API: only the tools in herramientas/ use it)
  const telegram = createTelegram({ S, motor, paneles, meshOrders, almacen, eventos, registro }, opts.telegram ?? (process.env.TALAIA_TELEGRAM_API ? { api: process.env.TALAIA_TELEGRAM_API, timing: { poll: 1 } } : undefined));

  /* ── tareas periódicas ── */
  // Sin señal y los estados que tienen que durar un tiempo («abierta más de 10 min»).
  const offlineId = setInterval(() => { motor.evalOffline(); motor.evalEstados(); }, 15000);
  async function podar() {
    const dias = S.settings.retentionDays || config.retencionDias;
    try {
      const n = await almacen.lecturas.prune(Date.now() - dias * DAY);
      const total = await almacen.lecturas.count();
      registro.info(tx("s.j.history", { total: total.toLocaleString(localeOf()), days: dias, pruned: n ? tx("s.j.historyPruned", { n: n.toLocaleString(localeOf()) }) : "", mb: (almacen.tamano() / 1048576).toLocaleString(localeOf(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }));
    } catch (e) {
      registro.error(tx("s.j.pruneFail", { e: e.message }));
    }
  }
  await podar();
  const podarId = setInterval(podar, 6 * HOUR);
  const sesionesId = setInterval(() => usuarios.podar(), HOUR); // sessions unused for 30 days
  // Resumen cada hora en el diario: para ver de un vistazo que sigue vivo y oyendo la malla.
  async function resumen() {
    const hace = Date.now() - HOUR;
    const oidos = [...S.nodes.values()].filter((n) => n.num >= 0 && n.lastHeard >= hace).length;
    const lecturas = await almacen.lecturas.count(hace).catch(() => 0);
    const activas = [...S.active.values()];
    const estado = tx(S.link.state === "ready" ? "s.j.sum.up" : S.link.state === "idle" ? "s.j.sum.idle" : "s.j.sum.down");
    const alarmas = activas.length ? tx("s.j.sum.alarms", { n: activas.length, unseen: activas.filter((a) => !a.acked).length }) : tx("s.j.sum.noAlarms");
    registro.info(tx("s.j.summary", { state: estado, heard: oidos, readings: lecturas, alarms: alarmas }));
  }
  const resumenId = setInterval(resumen, HOUR);

  return {
    S, motor, acciones, almacen, eventos, mqtt, paneles, usuarios, automations, meshOrders, telegram,
    get receptor() { return receptor; },
    /** The server's language: what it writes from now on (what is already in the log stays as it was). */
    idioma(l) {
      if (!LANGUAGES.includes(l)) return { ok: false };
      if (l !== S.settings.language) {
        S.settings.language = l;
        setLanguage(l);
        paneles.reetiquetar();
        telegram.relabel();
        motor.guardar("settings"); // to the screens; Home Assistant gets its names again
        registro.info(tx("s.j.language", { name: tx(`s.lang.${l}`) }));
      }
      return { ok: true, toast: tx("s.lang.saved") };
    },
    /** Empieza a conectar con el receptor (y a reintentar mientras no se pare). */
    arrancar() {
      registro.info(tx("s.j.rxStart", { how: describirReceptor(config.receptor), auto: config.receptor.tipo === "usb" && config.receptor.puerto === "auto" ? tx("s.j.rxAuto") : "" }));
      registro.info(tx(S.settings.mesh?.enabled ? "s.j.alertsOn" : "s.j.alertsOff"));
      receptor.start();
      mqtt.arrancar();
      paneles.arrancar();
      automations.start();
      telegram.start();
    },
    async detener() {
      if (cerrado) return;
      clearInterval(offlineId);
      clearInterval(podarId);
      clearInterval(sesionesId);
      clearInterval(resumenId);
      automations.stop();
      await telegram.stop();
      paneles.parar();
      await mqtt.parar(); // antes de cerrar: deja dicho «offline» a Home Assistant
      await receptor.disconnect();
      motor.resetAsks(); // peticiones a medias: sus temporizadores ya no deben tocar nada
      guardarNodos();
      cerrado = true;
      eventos.removeAllListeners();
      almacen.cerrar();
    },
  };
}
