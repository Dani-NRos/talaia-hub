// Conexión Bluetooth con el nodo receptor Meshtastic, reconexión automática y diagnóstico.
import { MeshDevice, Types, Protobuf } from "@meshtastic/core";
import { BleLink, BleError, SERVICE, classify } from "./ble.js";

const ST = Types.DeviceStatusEnum;
const BACKOFF_S = [2, 5, 10, 20, 30, 60];
const LOCK = "vigia-receptor";
const TT = (typeof window !== "undefined" && window.__VIGIA_BLE_TIMEOUTS) || {};
const CFG_IDLE_MS = TT.config || 30000; // sin ningún paquete durante la lectura inicial
const CFG_MAX_MS = 180000; // lectura inicial completa, aunque lleguen paquetes

export class Receptor {
  /**
   * h: { onStatus(state, extra), onDevice, onReady, onLost(reason, wasReady), onTrouble({kind,count,err,name}),
   *      onDiag(entry), onOtherWindow(), onLockLost(), onMyNode, onNodeInfo, onUser, onTelemetry, onPosition, onPacket }
   */
  constructor(h) {
    this.h = h;
    this.device = null;
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

  /** Quita el receptor a otra ventana de Vigía y conecta aquí. */
  async takeOver() {
    if (!this.device) return false;
    if (!(await this.acquireLock(true))) return false;
    this.userClosed = false;
    this.retry = 0;
    this.connect();
    return true;
  }

  _adopt(dev) {
    this.device = dev;
    this.userClosed = false;
    this.retry = 0;
    this.fails = 0;
    this.lastKind = null;
    this.h.onDevice?.(dev);
  }

  async connect() {
    if (!this.device || this.userClosed) return;
    clearTimeout(this.timer);
    this.timer = null;
    this._closeLink(); // restos del intento anterior, siempre antes de reintentar
    this._status(this.everReady ? "reconnecting" : "connecting", { stage: "gatt" });
    const link = new BleLink(this.device, {
      log: (m) => this.diag(m),
      onStage: (stage) => { if (link === this.link) this._status(this.state, { stage }); },
      onFail: (err) => { if (link === this.link) this._fail(err); },
      onPacket: () => { if (link === this.link && this.state === "configuring") this._cfgProgress(); },
    });
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
  }

  _closeLink() {
    const l = this.link;
    this.link = null;
    if (l) l.disconnect();
  }

  _fail(err) {
    if (this.userClosed || this.timer) return;
    clearTimeout(this.cfgTimer);
    const wasReady = this.state === "ready";
    const kind = wasReady ? "lost" : classify(err);
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
      this.h.onTrouble?.({ kind, count: this.fails, detail, name: this.device?.name || "" });
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
    const mesh = this.mesh;
    if (!mesh || this.state !== "ready") return Promise.reject({ error: "send" });
    const payload = new Uint8Array([(field << 3) | 2, 0]);
    return mesh.sendPacket(payload, Protobuf.Portnums.PortNum.TELEMETRY_APP, dest, channel, true, true, false);
  }

  /**
   * Pide la ficha (NodeInfo) de un nodo mandándole la nuestra con want_response, como hace la app oficial.
   * NodeInfo nunca va cifrado con PKI, así que funciona aunque falte la clave del nodo, y de paso
   * el nodo aprende la clave de nuestro receptor. userBytes: nuestro User ya codificado.
   */
  requestNodeInfo(dest, userBytes, channel = 0) {
    const mesh = this.mesh;
    if (!mesh || this.state !== "ready") return Promise.reject({ error: "send" });
    return mesh.sendPacket(userBytes, Protobuf.Portnums.PortNum.NODEINFO_APP, dest, channel, true, true, false);
  }

  /**
   * Pide la posición a un nodo (Position vacío con want_response, como la librería oficial).
   * Las posiciones no van cifradas con clave, así que no da el error 39.
   */
  requestPosition(dest, channel = 0) {
    const mesh = this.mesh;
    if (!mesh || this.state !== "ready") return Promise.reject({ error: "send" });
    return mesh.sendPacket(new Uint8Array(), Protobuf.Portnums.PortNum.POSITION_APP, dest, channel, true, true, false);
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
    if (!this.device || this.userClosed) return;
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
    const d = this.device;
    await this.disconnect();
    try { await d?.forget?.(); } catch { /* sin soporte */ }
    this.device = null;
  }

  _status(s, extra) {
    this.state = s;
    this.h.onStatus?.(s, extra);
  }
}
