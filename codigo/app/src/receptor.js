// Conexión con el nodo receptor Meshtastic desde el navegador, por Bluetooth o por cable USB (Web Serial).
// Lo común con el servidor (ciclo de conexión, lectura inicial, reintentos, peticiones con id) está en el núcleo:
// @vigia/nucleo/receptor-base.js. Aquí queda lo del navegador: selectores, permisos y una sola ventana conectada.
import { ReceptorBase } from "@vigia/nucleo/receptor-base.js";
import { BleLink, BleError, SERVICE, classify } from "./ble.js";
import { SerialLink, LinkError, USB_FILTERS, classifySerial } from "./serial.js";

const LOCK = "vigia-receptor";

export class Receptor extends ReceptorBase {
  /**
   * h: { onStatus(state, extra), onDevice, onReady, onLost(reason, wasReady), onTrouble({kind,count,err,name}),
   *      onDiag(entry), onOtherWindow(), onLockLost(), onMyNode, onNodeInfo, onUser, onTelemetry, onPosition, onPacket,
   *      onLora(loraConfig), onNotice(clientNotification) }
   */
  constructor(h) {
    super(h);
    this.device = null; // BluetoothDevice
    this.port = null; // SerialPort (cable USB)
    this.kind = "ble"; // "ble" | "serial"
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

  /* ── lo que la base pide a cada enlace ── */
  get reconfigure() { return this.kind === "serial"; }
  firstStage() { return this.kind === "serial" ? "open" : "gatt"; }
  classify(err) { return this.kind === "serial" ? classifySerial(err) : classify(err); }
  configError(msg) { return new BleError("config", null, msg); }
  get targetName() { return this.device?.name || ""; }
  releaseTarget() { this.releaseLock(); }

  async openLink(hooks) {
    if (this.kind !== "serial") return new BleLink(this.device, hooks);
    if (this.serialClosing) await Promise.race([this.serialClosing, new Promise((r) => setTimeout(r, 2000))]);
    this.serialClosing = null;
    const port = await this._serialPort();
    if (this.userClosed) return null;
    // Desenchufado: no se intenta abrir; al volver a enchufarlo, el aviso «connect» de Chrome reconecta.
    if (!port) { this._fail(new LinkError("unplugged", null, "el nodo no está enchufado")); return null; }
    this.port = port;
    return new SerialLink(port, hooks);
  }

  afterClose(link, p) {
    // Por cable, el puerto tarda un momento en cerrarse: la siguiente apertura lo espera (ver openLink).
    if (link instanceof SerialLink) this.serialClosing = Promise.resolve(p).catch(() => {});
  }


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

  /** Olvida el receptor en este navegador (no borra el emparejamiento del sistema). */
  async forget() {
    const d = this.device, p = this.port;
    await this.disconnect();
    try { await d?.forget?.(); } catch { /* sin soporte */ }
    try { await p?.forget?.(); } catch { /* sin soporte */ }
    this.device = null;
    this.port = null;
  }
}
