// Conexión con el nodo receptor Meshtastic, por Bluetooth o por cable USB; reconexión automática y diagnóstico.
import { MeshDevice, Types, Protobuf } from "@meshtastic/core";
import { BleLink, BleError, SERVICE, classify } from "./ble.js";
import { SerialLink, LinkError, USB_FILTERS, classifySerial } from "./serial.js";

const ST = Types.DeviceStatusEnum;
const BACKOFF_S = [2, 5, 10, 20, 30, 60];
const LOCK = "vigia-receptor";
const TT = (typeof window !== "undefined" && window.__VIGIA_BLE_TIMEOUTS) || {};
const CFG_IDLE_MS = TT.config || 30000; // sin ningún paquete durante la lectura inicial
const CFG_MAX_MS = 180000; // lectura inicial completa, aunque lleguen paquetes

export class Receptor {
  /**
   * h: { onStatus(state, extra), onDevice, onReady, onLost(reason, wasReady), onTrouble({kind,count,err,name}),
   *      onDiag(entry), onOtherWindow(), onLockLost(), onMyNode, onNodeInfo, onUser, onTelemetry, onPosition, onPacket,
   *      onLora(loraConfig), onNotice(clientNotification) }
   */
  constructor(h) {
    this.h = h;
    this.device = null; // BluetoothDevice
    this.port = null; // SerialPort (cable USB)
    this.kind = "ble"; // "ble" | "serial"
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
    this.lockRelease = null;
  }

  /** Estado del Bluetooth web en este navegador. */
  static support() {
    if (!window.isSecureContext) return "insecure";
    if (!navigator.bluetooth || !navigator.bluetooth.requestDevice) return "none";
    return "ok";
  }

  /** Estado del puerto serie web (cable USB): Chrome y Edge de ordenador. */
  static serialSupport() {
    if (!window.isSecureContext) return "insecure";
    if (!navigator.serial || !navigator.serial.requestPort) return "none";
    return "ok";
  }

  /** Hay un receptor elegido (por Bluetooth o por cable) al que volver a conectar. */
  get hasTarget() { return !!(this.kind === "serial" ? this.port : this.device); }

  diag(msg, extra = {}) { this.h.onDiag?.({ t: Date.now(), msg, ...extra }); }

  /* ── una sola ventana conectada al receptor ── */
  acquireLock(steal = false) {
    if (this.lockRelease) return Promise.resolve(true);
    if (!navigator.locks?.request) return Promise.resolve(true);
    return new Promise((resolve) => {
      navigator.locks.request(LOCK, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise((release) => { this.lockRelease = release; });
      }).catch(() => {
        // Otra ventana ha tomado el receptor (steal): soltamos aquí.
        if (this.lockRelease) {
          this.lockRelease = null;
          this.diag("Otra ventana de Vigía ha tomado el receptor");
          this.disconnect();
          this.h.onLockLost?.();
        }
        resolve(false);
      });
    });
  }
  releaseLock() {
    const r = this.lockRelease;
    this.lockRelease = null;
    r?.();
  }

  /** Abre el selector de Chrome. all=true enseña todos los dispositivos, no solo los que anuncian Meshtastic. */
  async pick(all = false) {
    const opts = all
      ? { acceptAllDevices: true, optionalServices: [SERVICE] }
      : { filters: [{ services: [SERVICE] }], optionalServices: [SERVICE] };
    const dev = await navigator.bluetooth.requestDevice(opts); // primero, mientras dura el gesto del usuario
    this._adopt(dev);
    if (!(await this.acquireLock())) { this.userClosed = true; this._status("idle"); this.h.onOtherWindow?.(); return "locked"; }
    this.connect();
    return "ok";
  }

  /** Reconecta sin selector a un dispositivo ya autorizado (si el navegador lo permite). */
  async restore(id) {
    if (!id || !navigator.bluetooth || !navigator.bluetooth.getDevices) return false;
    let list = [];
    try { list = await navigator.bluetooth.getDevices(); } catch { return false; }
    const dev = list.find((d) => d.id === id);
    if (!dev) return false;
    this._adopt(dev);
    if (!(await this.acquireLock())) { this.userClosed = true; this._status("idle"); this.h.onOtherWindow?.(); return false; }
    this.diag("Reconectando al receptor guardado");
    this.connect();
    return true;
  }

  /** Abre el selector de puertos de Chrome. all=true enseña todos, no solo los de conversores USB conocidos. */
  async pickSerial(all = false) {
    const port = await navigator.serial.requestPort(all ? {} : { filters: USB_FILTERS });
    // Mientras el selector estaba abierto puede haberse conectado solo al enchufarlo: si es el mismo, nada que hacer.
    if (port === this.port && this.kind === "serial" && !this.userClosed && this.state !== "idle") return "ok";
    this._adoptSerial(port);
    if (!(await this.acquireLock())) { this.userClosed = true; this._status("idle"); this.h.onOtherWindow?.(); return "locked"; }
    this.connect();
    return "ok";
  }

  /**
   * Reconecta sin selector a un puerto ya autorizado (Chrome recuerda el permiso).
   * info: { vid, pid } del último cable usado. Si no está enchufado, devuelve false.
   */
  async restoreSerial(info) {
    if (!navigator.serial?.getPorts) return false;
    let list = [];
    try { list = await navigator.serial.getPorts(); } catch { return false; }
    const port = list.find((p) => { const i = p.getInfo?.() || {}; return i.usbVendorId === info?.vid && i.usbProductId === info?.pid; }) || (list.length === 1 ? list[0] : null);
    if (!port) return false;
    this._adoptSerial(port);
    if (!(await this.acquireLock())) { this.userClosed = true; this._status("idle"); this.h.onOtherWindow?.(); return false; }
    this.diag("Reconectando al receptor por cable");
    this.connect();
    return true;
  }

  /** Quita el receptor a otra ventana de Vigía y conecta aquí. */
  async takeOver() {
    if (!this.hasTarget) return false;
    if (!(await this.acquireLock(true))) return false;
    this.userClosed = false;
    this.retry = 0;
    this.connect();
    return true;
  }

  _adopt(dev) {
    this.kind = "ble";
    this.device = dev;
    this.port = null;
    this.userClosed = false;
    this.retry = 0;
    this.fails = 0;
    this.lastKind = null;
    this.h.onDevice?.(dev);
  }

  _adoptSerial(port) {
    this.kind = "serial";
    this.port = port;
    this.device = null;
    this.userClosed = false;
    this.retry = 0;
    this.fails = 0;
    this.lastKind = null;
    const i = port.getInfo?.() || {};
    this.h.onDevice?.({ kind: "serial", vid: i.usbVendorId ?? null, pid: i.usbProductId ?? null });
  }

  /**
   * El puerto puede cambiar de objeto al desenchufar y volver a enchufar: se busca otra vez entre los autorizados.
   * null si no está enchufado (Chrome solo lista los puertos presentes).
   */
  async _serialPort() {
    try {
      const list = await navigator.serial.getPorts();
      if (list.includes(this.port)) return this.port;
      const i = this.port?.getInfo?.() || {};
      if (i.usbVendorId == null) return this.port; // puerto sin datos USB: no se puede buscar otro
      return list.find((p) => { const j = p.getInfo?.() || {}; return j.usbVendorId === i.usbVendorId && j.usbProductId === i.usbProductId; }) || null;
    } catch { return this.port; }
  }

  async connect() {
    if (!this.hasTarget || this.userClosed) return;
    clearTimeout(this.timer);
    this.timer = null;
    this._closeLink(); // restos del intento anterior, siempre antes de reintentar
    const serial = this.kind === "serial";
    this._status(this.everReady ? "reconnecting" : "connecting", { stage: serial ? "open" : "gatt" });
    const hooks = {
      log: (m) => this.diag(m),
      onStage: (stage) => { if (link === this.link) this._status(this.state, { stage }); },
      onFail: (err) => { if (link === this.link) this._fail(err); },
      onPacket: () => { if (link === this.link && this.state === "configuring") this._cfgProgress(); },
    };
    let link;
    if (serial) {
      if (this.serialClosing) await Promise.race([this.serialClosing, new Promise((r) => setTimeout(r, 2000))]);
      this.serialClosing = null;
      const port = await this._serialPort();
      if (this.userClosed) return;
      // Desenchufado: no se intenta abrir; al volver a enchufarlo, el aviso «connect» de Chrome reconecta.
      if (!port) { this._fail(new LinkError("unplugged", null, "el nodo no está enchufado")); return; }
      this.port = port;
      link = new SerialLink(port, hooks);
    } else {
      link = new BleLink(this.device, hooks);
    }
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
    if (serial) {
      for (const ms of [6000, 14000]) {
        setTimeout(() => {
          if (mesh !== this.mesh || this.state !== "configuring" || this.cfgPackets > 0) return;
          this.diag("El nodo aún no contesta por el cable; se le vuelve a pedir la configuración");
          mesh.configure().catch(() => {});
        }, ms);
      }
    }
  }

  _armCfgWatchdog() {
    clearTimeout(this.cfgTimer);
    this.cfgTimer = setTimeout(() => {
      if (this.state === "configuring") this._fail(new BleError("config", null, `el nodo dejó de mandar datos durante la lectura inicial (${this.cfgPackets} paquetes)`));
    }, CFG_IDLE_MS);
  }

  _cfgProgress() {
    this.cfgPackets++;
    if (Date.now() - this.cfgStart > CFG_MAX_MS) {
      this._fail(new BleError("config", null, "la lectura inicial tarda demasiado"));
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
      this.diag(`Receptor listo: ${this.cfgPackets} paquetes en ${((Date.now() - this.cfgStart) / 1000).toFixed(1)} s`);
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
    // Por cable, el puerto tarda un momento en cerrarse: la siguiente apertura lo espera (ver connect).
    if (l instanceof SerialLink) this.serialClosing = Promise.resolve(p).catch(() => {});
  }

  _fail(err) {
    if (this.userClosed || this.timer) return;
    clearTimeout(this.cfgTimer);
    const wasReady = this.state === "ready";
    const kind = wasReady ? "lost" : this.kind === "serial" ? classifySerial(err) : classify(err);
    this.mesh = null;
    this._closeLink();
    const detail = `${err.causeName || ""} ${err.message || ""}`.trim();
    this.diag(`Fallo en fase «${err.stage}» (${kind}): ${detail}`, { kind, stage: err.stage });
    if (wasReady) {
      this.fails = 0;
      this.h.onLost?.(err.stage, true);
    } else {
      this.fails = this.lastKind === kind ? this.fails + 1 : 1;
      this.lastKind = kind;
      this.h.onTrouble?.({ kind, link: this.kind, count: this.fails, detail, name: this.device?.name || "" });
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
   * y la librería ya no los atiende. Con el id, la app los casa ella misma (ver onPacket en app.js).
   */
  _sendTracked(payload, port, dest, channel) {
    const mesh = this.mesh;
    if (!mesh || this.state !== "ready") return { id: null, done: Promise.reject({ error: "send" }) };
    let id = null;
    const own = Object.prototype.hasOwnProperty.call(mesh, "generateRandId");
    const gen = mesh.generateRandId;
    // sendPacket genera el id antes de su primer await: se captura y se deja la función como estaba.
    mesh.generateRandId = function () { id = gen.call(this); return id; };
    let done;
    try {
      done = mesh.sendPacket(payload, port, dest, channel, true, true, false);
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
   * Con want_ack: en directo confirma el destino; en un canal, que algún nodo lo ha repetido.
   */
  sendText(dest, channel, text) {
    const mesh = this.mesh;
    if (!mesh || this.state !== "ready") return Promise.reject({ error: "send" });
    return mesh.sendPacket(new TextEncoder().encode(text), Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP, dest, channel, true, false, false);
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
    this.releaseLock();
    this._status("idle");
  }

  /** Olvida el receptor en este navegador (no borra el emparejamiento del sistema). */
  async forget() {
    const d = this.device, p = this.port;
    await this.disconnect();
    try { await d?.forget?.(); } catch { /* sin soporte */ }
    try { await p?.forget?.(); } catch { /* sin soporte */ }
    this.device = null;
    this.port = null;
  }

  _status(s, extra) {
    this.state = s;
    this.h.onStatus?.(s, extra);
  }
}
