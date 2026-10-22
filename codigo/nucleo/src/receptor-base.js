// Conexión con el nodo receptor, sin depender del navegador: abre el enlace, pide la configuración (vigilando que
// llegue), reconecta con espera creciente y manda peticiones con el id del paquete capturado al momento.
// La app (Bluetooth y cable por Web Serial) y el servidor (cable y TCP en Node) la extienden con su enlace.
//
// Las subclases ponen:
//   get hasTarget        hay un nodo elegido al que (re)conectar
//   firstStage()         fase con la que empieza la conexión, para el estado («open», «gatt»…)
//   async openLink(h)    crea el enlace con los ganchos h ({ log, onStage, onFail, onPacket }) y lo devuelve; si no
//                        se puede ni intentar, llama a this._fail(err) y devuelve null
//   afterClose(link, p)  el enlace se está cerrando (p: promesa del cierre)
//   classify(err)        tipo de fallo para el usuario («busy», «lost», «pairing»…)
//   configError(msg)     el error a usar si la lectura inicial se atasca
//   reconfigure          true si el nodo puede no oír la primera petición de configuración (cable: se reinicia al
//                        abrir el puerto) y hay que repetirla
//   releaseTarget()      al desconectar a mano (la app suelta el bloqueo entre ventanas)
import { MeshDevice, Types, Protobuf } from "@meshtastic/core";
import { tx } from "./idioma.js";
import { fmtNum } from "./metrics.js";

const ST = Types.DeviceStatusEnum;
export const BACKOFF_S = [2, 5, 10, 20, 30, 60];
const TT = (typeof window !== "undefined" && window.__VIGIA_BLE_TIMEOUTS) || {};
export const CFG_IDLE_MS = TT.config || 30000; // sin ningún paquete durante la lectura inicial
export const CFG_MAX_MS = 180000; // lectura inicial completa, aunque lleguen paquetes

/** Error de un enlace: stage dice en qué paso falló (open, io, lost, config…); cause, el error original. */
export class LinkError extends Error {
  constructor(stage, cause, msg) {
    super(msg || cause?.message || String(cause));
    this.name = "LinkError";
    this.stage = stage;
    this.cause = cause;
    this.causeName = cause?.name || "";
  }
}

export class ReceptorBase {
  /**
   * h: { onStatus(state, extra), onReady, onLost(reason, wasReady), onTrouble({kind,link,count,detail,name}),
   *      onDiag(entry), onMyNode, onNodeInfo, onUser, onTelemetry, onPosition, onPacket, onChannel,
   *      onLora(loraConfig), onNotice(clientNotification) }
   */
  constructor(h) {
    this.h = h;
    this.kind = null;
    this.mesh = null;
    this.link = null;
    this.state = "idle";
    this.userClosed = true;
    this.everReady = false;
    this.retry = 0;
    this.fails = 0;
    this.lastKind = null;
    this.timer = null;
    this.cfgTimer = null;
  }

  /* ── lo que pone cada subclase ── */
  get hasTarget() { return false; }
  get reconfigure() { return false; }
  firstStage() { return "open"; }
  async openLink() { throw new Error("openLink sin implementar"); }
  afterClose() {}
  classify() { return "other"; }
  configError(msg) { return new LinkError("config", null, msg); }
  releaseTarget() {}
  /** Nombre del aparato para los avisos de fallo. */
  get targetName() { return ""; }

  diag(msg, extra = {}) { this.h.onDiag?.({ t: Date.now(), msg, ...extra }); }

  async connect() {
    if (!this.hasTarget || this.userClosed) return;
    clearTimeout(this.timer);
    this.timer = null;
    this._closeLink(); // restos del intento anterior, siempre antes de reintentar
    this._status(this.everReady ? "reconnecting" : "connecting", { stage: this.firstStage() });
    const hooks = {
      log: (m) => this.diag(m),
      onStage: (stage) => { if (link === this.link) this._status(this.state, { stage }); },
      onFail: (err) => { if (link === this.link) this._fail(err); },
      onPacket: () => { if (link === this.link && this.state === "configuring") this._cfgProgress(); },
    };
    let link = null;
    link = await this.openLink(hooks);
    if (!link) return;
    this.link = link;
    try {
      await link.open();
    } catch (err) {
      if (link === this.link && !this.userClosed) this._fail(err);
      return;
    }
    if (link !== this.link || this.userClosed) { link.disconnect(); return; }

    const mesh = new MeshDevice(link);
    try { mesh.log.settings.type = "hidden"; mesh.log.settings.minLevel = 6; } catch { /* logger distinto */ }
    this.mesh = mesh;
    this._wire(mesh);
    this.cfgPackets = 0;
    this.cfgStart = Date.now();
    this.cfgShown = 0;
    this._status("configuring", { stage: "config", packets: 0 });
    // Solo ahora, con los avisos ya activos, se pide la configuración (antes chocaban en Android).
    mesh.configure().catch(() => {});
    this._armCfgWatchdog();
    // Por cable, algunas placas se reinician al abrir el puerto y no oyen la primera petición: se repite.
    if (this.reconfigure) {
      for (const ms of [6000, 14000]) {
        setTimeout(() => {
          if (mesh !== this.mesh || this.state !== "configuring" || this.cfgPackets > 0) return;
          this.diag(tx("diag.cableRetry"));
          mesh.configure().catch(() => {});
        }, ms);
      }
    }
  }

  _armCfgWatchdog() {
    clearTimeout(this.cfgTimer);
    this.cfgTimer = setTimeout(() => {
      if (this.state === "configuring") this._fail(this.configError(`el nodo dejó de mandar datos durante la lectura inicial (${this.cfgPackets} paquetes)`));
    }, CFG_IDLE_MS);
  }

  _cfgProgress() {
    this.cfgPackets++;
    if (Date.now() - this.cfgStart > CFG_MAX_MS) {
      this._fail(this.configError("la lectura inicial tarda demasiado"));
      return;
    }
    this._armCfgWatchdog();
    if (Date.now() - this.cfgShown > 250) {
      this.cfgShown = Date.now();
      this._status("configuring", { stage: "config", packets: this.cfgPackets });
    }
  }

  _wire(mesh) {
    const ev = mesh.events;
    const mine = () => mesh === this.mesh;
    ev.onDeviceStatus.subscribe((s) => {
      if (!mine() || s !== ST.DeviceConfigured) return;
      clearTimeout(this.cfgTimer);
      this.retry = 0;
      this.fails = 0;
      this.lastKind = null;
      this.everReady = true;
      this.diag(tx("diag.ready", { n: this.cfgPackets, s: fmtNum((Date.now() - this.cfgStart) / 1000, 1) }));
      this._status("ready");
      this.h.onReady?.();
    });
    ev.onMyNodeInfo.subscribe((i) => mine() && this.h.onMyNode?.(i.myNodeNum));
    ev.onNodeInfoPacket.subscribe((n) => mine() && this.h.onNodeInfo?.(n));
    ev.onUserPacket.subscribe((p) => mine() && this.h.onUser?.(p.from, p.data, p));
    ev.onTelemetryPacket.subscribe((p) => mine() && this.h.onTelemetry?.(p));
    ev.onPositionPacket.subscribe((p) => mine() && this.h.onPosition?.(p));
    ev.onMeshPacket.subscribe((p) => mine() && this.h.onPacket?.(p));
    ev.onChannelPacket.subscribe((c) => mine() && this.h.onChannel?.(c));
    // Configuración LoRa (preset y límite de saltos) y avisos del firmware (p. ej. traceroute limitado).
    ev.onConfigPacket.subscribe((c) => mine() && c?.payloadVariant?.case === "lora" && this.h.onLora?.(c.payloadVariant.value));
    ev.onClientNotificationPacket?.subscribe((n) => mine() && this.h.onNotice?.(n));
  }

  _closeLink() {
    const l = this.link;
    this.link = null;
    if (!l) return;
    const p = l.disconnect();
    this.afterClose(l, p);
  }

  _fail(err) {
    if (this.userClosed || this.timer) return;
    clearTimeout(this.cfgTimer);
    const wasReady = this.state === "ready";
    const kind = wasReady ? "lost" : this.classify(err);
    this.mesh = null;
    this._closeLink();
    const detail = `${err.causeName || ""} ${err.message || ""}`.trim();
    this.diag(tx("diag.fail", { stage: err.stage, kind, detail }), { kind, stage: err.stage });
    if (wasReady) {
      this.fails = 0;
      this.h.onLost?.(err.stage, true);
    } else {
      this.fails = this.lastKind === kind ? this.fails + 1 : 1;
      this.lastKind = kind;
      this.h.onTrouble?.({ kind, link: this.kind, count: this.fails, detail, name: this.targetName });
    }
    this._schedule(kind);
  }

  _schedule(kind) {
    // Un emparejamiento roto no se arregla reintentando: se espacian más los intentos.
    const base = BACKOFF_S[Math.min(this.retry, BACKOFF_S.length - 1)];
    const s = kind === "pairing" ? Math.max(base, 30) : base;
    this.retry++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, s * 1000);
    this._status("reconnecting", { inSeconds: s, at: Date.now() + s * 1000 });
  }

  /**
   * Pide telemetría a un nodo: un mensaje Telemetry con solo el campo pedido (vacío) y want_response.
   * field: 2 dispositivo, 3 ambiente, 4 calidad del aire, 5 energía.
   * Con want_ack el receptor reintenta si no hay respuesta y avisa con MAX_RETRANSMIT; el nodo
   * contesta NO_RESPONSE si no tiene ese tipo de sensor. La respuesta en sí llega como telemetría normal.
   */
  requestTelemetry(dest, field, channel = 0) {
    const payload = new Uint8Array([(field << 3) | 2, 0]);
    return this._sendTracked(payload, Protobuf.Portnums.PortNum.TELEMETRY_APP, dest, channel);
  }

  /**
   * Manda una petición (want_ack + want_response) y devuelve { id, done } con el id del paquete al momento.
   * La librería solo resuelve con el primer acuse, que en una malla con repetidores suele ser el «implícito»
   * de tu propio receptor al oír que otro nodo la repite; el acuse o el error del nodo destino llegan después
   * y la librería ya no los atiende. Con el id, el motor los casa él mismo (ver recibir.packet en motor.js).
   */
  _sendTracked(payload, port, dest, channel, wantResponse = true) {
    const mesh = this.mesh;
    if (!mesh || this.state !== "ready") return { id: null, done: Promise.reject({ error: "send" }) };
    let id = null;
    const own = Object.prototype.hasOwnProperty.call(mesh, "generateRandId");
    const gen = mesh.generateRandId;
    // sendPacket genera el id antes de su primer await: se captura y se deja la función como estaba.
    mesh.generateRandId = function () { id = gen.call(this); return id; };
    let done;
    try {
      done = mesh.sendPacket(payload, port, dest, channel, true, wantResponse, false);
    } finally {
      if (own) mesh.generateRandId = gen;
      else delete mesh.generateRandId;
    }
    return { id, done };
  }

  /**
   * Pide la ficha (NodeInfo) de un nodo mandándole la nuestra con want_response, como hace la app oficial.
   * NodeInfo nunca va cifrado con PKI, así que funciona aunque falte la clave del nodo, y de paso
   * el nodo aprende la clave de nuestro receptor. userBytes: nuestro User ya codificado.
   */
  requestNodeInfo(dest, userBytes, channel = 0) {
    return this._sendTracked(userBytes, Protobuf.Portnums.PortNum.NODEINFO_APP, dest, channel);
  }

  /**
   * Pide la posición a un nodo (Position vacío con want_response, como la librería oficial).
   * Las posiciones no van cifradas con clave, así que no da el error 39.
   */
  requestPosition(dest, channel = 0) {
    return this._sendTracked(new Uint8Array(), Protobuf.Portnums.PortNum.POSITION_APP, dest, channel);
  }

  /**
   * Traceroute: un RouteDiscovery vacío (0 bytes) con want_ack y want_response. Cada nodo que lo repite y tiene
   * la clave del canal se apunta en la ruta con el SNR con que lo oyó; el destino contesta por el mismo canal y
   * la vuelta se apunta igual. Nunca va cifrado con PKI. El firmware solo deja uno cada 30 s (a cualquier nodo).
   */
  requestTraceroute(dest, channel = 0) {
    return this._sendTracked(new Uint8Array(), Protobuf.Portnums.PortNum.TRACEROUTE_APP, dest, channel);
  }

  /**
   * Manda un mensaje de texto a la malla. dest: "broadcast" (a un canal) o el número de un nodo.
   * Devuelve { id, done } como las peticiones: en directo, la librería resuelve con el primer acuse, que suele
   * ser el implícito de tu receptor (un vecino lo repitió); el del destino llega después y lo casa el motor por id.
   * En un canal, el acuse solo dice que algún nodo lo ha repetido.
   */
  sendText(dest, channel, text) {
    return this._sendTracked(new TextEncoder().encode(text), Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP, dest, channel, false);
  }

  /** Reintenta ya, sin esperar al siguiente intervalo. */
  retryNow() {
    if (!this.hasTarget || this.userClosed) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.retry = 0;
    this.connect();
  }

  /** Última vez que llegó algo del receptor (ms), para el diagnóstico. */
  get lastRx() { return this.link?.lastRx || 0; }

  async disconnect() {
    this.userClosed = true;
    clearTimeout(this.timer);
    clearTimeout(this.cfgTimer);
    this.timer = null;
    this.mesh = null;
    this._closeLink();
    this.releaseTarget();
    this._status("idle");
  }

  _status(s, extra) {
    this.state = s;
    this.h.onStatus?.(s, extra);
  }
}
