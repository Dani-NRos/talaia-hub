// Conexión Bluetooth con el nodo receptor Meshtastic y reconexión automática.
import { MeshDevice, Types, Protobuf } from "@meshtastic/core";
import { TransportWebBluetooth } from "@meshtastic/transport-web-bluetooth";

const SERVICE = TransportWebBluetooth.ServiceUuid;
const ST = Types.DeviceStatusEnum;
const BACKOFF_S = [2, 5, 10, 20, 30, 60];

export class Receptor {
  /** h: { onStatus, onDevice, onReady, onLost, onError, onMyNode, onNodeInfo, onUser, onTelemetry, onPacket } */
  constructor(h) {
    this.h = h;
    this.device = null;
    this.mesh = null;
    this.state = "idle";
    this.userClosed = true;
    this.everReady = false;
    this.retry = 0;
    this.timer = null;
    this.cfgTimer = null;
    this.onGattDisc = () => this._lost("gatt");
  }

  /** Estado del Bluetooth web en este navegador. */
  static support() {
    if (!window.isSecureContext) return "insecure";
    if (!navigator.bluetooth || !navigator.bluetooth.requestDevice) return "none";
    return "ok";
  }

  /** Abre el selector de Chrome. all=true enseña todos los dispositivos, no solo los que anuncian Meshtastic. */
  async pick(all = false) {
    const opts = all
      ? { acceptAllDevices: true, optionalServices: [SERVICE] }
      : { filters: [{ services: [SERVICE] }], optionalServices: [SERVICE] };
    const dev = await navigator.bluetooth.requestDevice(opts);
    this._adopt(dev);
    await this.connect();
  }

  /** Reconecta sin selector a un dispositivo ya autorizado (si el navegador lo permite). */
  async restore(id) {
    if (!id || !navigator.bluetooth || !navigator.bluetooth.getDevices) return false;
    let list = [];
    try { list = await navigator.bluetooth.getDevices(); } catch { return false; }
    const dev = list.find((d) => d.id === id);
    if (!dev) return false;
    this._adopt(dev);
    this.connect();
    return true;
  }

  _adopt(dev) {
    if (this.device && this.device !== dev) this.device.removeEventListener("gattserverdisconnected", this.onGattDisc);
    this.device = dev;
    dev.addEventListener("gattserverdisconnected", this.onGattDisc);
    this.userClosed = false;
    this.retry = 0;
    this.h.onDevice?.(dev);
  }

  async connect() {
    if (!this.device || this.userClosed) return;
    clearTimeout(this.timer);
    this.timer = null;
    this._status(this.everReady ? "reconnecting" : "connecting");
    try {
      const transport = await TransportWebBluetooth.createFromDevice(this.device);
      if (this.userClosed) { this._dropGatt(); return; }
      const mesh = new MeshDevice(transport);
      try { mesh.log.settings.type = "hidden"; mesh.log.settings.minLevel = 6; } catch { /* logger distinto */ }
      this.mesh = mesh;
      this._wire(mesh);
      this._status("configuring");
      mesh.configure().catch(() => {});
      clearTimeout(this.cfgTimer);
      this.cfgTimer = setTimeout(() => { if (this.state !== "ready") this._lost("timeout"); }, 45000);
    } catch (e) {
      if (this.userClosed) return;
      this.h.onError?.(e);
      this._schedule();
    }
  }

  _wire(mesh) {
    const ev = mesh.events;
    const mine = () => mesh === this.mesh;
    ev.onDeviceStatus.subscribe((s) => {
      if (!mine()) return;
      if (s === ST.DeviceConfigured) {
        clearTimeout(this.cfgTimer);
        this.retry = 0;
        this.everReady = true;
        this._status("ready");
        this.h.onReady?.();
      } else if (s === ST.DeviceDisconnected) {
        this._lost("status");
      }
    });
    ev.onMyNodeInfo.subscribe((i) => mine() && this.h.onMyNode?.(i.myNodeNum));
    ev.onNodeInfoPacket.subscribe((n) => mine() && this.h.onNodeInfo?.(n));
    ev.onUserPacket.subscribe((p) => mine() && this.h.onUser?.(p.from, p.data));
    ev.onTelemetryPacket.subscribe((p) => mine() && this.h.onTelemetry?.(p));
    ev.onMeshPacket.subscribe((p) => mine() && this.h.onPacket?.(p));
  }

  _dropGatt() {
    try { if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect(); } catch { /* ya cerrado */ }
  }

  _lost(reason) {
    if (this.userClosed || this.timer) return;
    clearTimeout(this.cfgTimer);
    const wasReady = this.state === "ready";
    this.mesh = null;
    this._dropGatt();
    this.h.onLost?.(reason, wasReady);
    this._schedule();
  }

  _schedule() {
    const s = BACKOFF_S[Math.min(this.retry, BACKOFF_S.length - 1)];
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

  /** Reintenta ya, sin esperar al siguiente intervalo. */
  retryNow() {
    if (!this.device || this.userClosed) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.retry = 0;
    this.connect();
  }

  async disconnect() {
    this.userClosed = true;
    clearTimeout(this.timer);
    clearTimeout(this.cfgTimer);
    this.timer = null;
    const m = this.mesh;
    this.mesh = null;
    try { await m?.disconnect(); } catch { /* ya cerrado */ }
    this._dropGatt();
    this._status("idle");
  }

  _status(s, extra) {
    this.state = s;
    this.h.onStatus?.(s, extra);
  }
}
