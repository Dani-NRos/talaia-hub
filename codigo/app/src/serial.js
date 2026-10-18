// Enlace por cable USB con un nodo Meshtastic (Web Serial, Chrome y Edge de ordenador).
// Las tramas (cabecera 0x94 0xC3 y troceado propio) están en el núcleo: @vigia/nucleo/tramas.js.

import { Types } from "@meshtastic/core";
import { frame, createFramer, createLines, HEARTBEAT, HEARTBEAT_MS, DISCONNECT, wakeBytes } from "@vigia/nucleo/tramas.js";

export { frame, createFramer };

const ST = Types.DeviceStatusEnum;
const BAUD = 115200;

/**
 * Fabricantes USB de los conversores y placas que llevan los nodos Meshtastic, para el selector de Chrome.
 * Si el nodo no sale, «Ver todos los puertos» abre el selector sin filtro.
 */
export const USB_FILTERS = [
  0x303a, // Espressif, USB del propio ESP32-S3/C3 (Heltec V4, T-Beam S3, Station G2…)
  0x10c4, // Silicon Labs CP210x (Heltec V3, T-Beam…)
  0x1a86, // WCH CH340 / CH9102 (TTGO, LilyGO…)
  0x0403, // FTDI
  0x239a, // Adafruit: nRF52 con su cargador (RAK4631, T-Echo…)
  0x2886, // Seeed (XIAO, T1000-E, Wio Tracker)
  0x1915, // Nordic
  0x2e8a, // Raspberry Pi (RP2040)
].map((usbVendorId) => ({ usbVendorId }));

export class LinkError extends Error {
  /** stage: open (no se pudo abrir el puerto) | io | lost ; cause: error original */
  constructor(stage, cause, msg) {
    super(msg || cause?.message || String(cause));
    this.name = "LinkError";
    this.stage = stage;
    this.cause = cause;
    this.causeName = cause?.name || "";
  }
}

/**
 * Uso (igual que BleLink):
 *   const link = new SerialLink(port, { log, onFail, onPacket, onStage });
 *   await link.open();          // abre el puerto (lanza LinkError)
 *   new MeshDevice(link);       // cumple el contrato Transport: toDevice, fromDevice, disconnect()
 */
export class SerialLink {
  constructor(port, hooks = {}) {
    this.port = port;
    this.h = hooks;
    this.closing = false;
    this.failed = false;
    this.lastRx = 0;
    this.rxCount = 0;
    this.ctrl = null;
    this.reader = null;
    this.writer = null;
    this.chain = Promise.resolve();
    this.hbId = null;
    this.framer = createFramer();
    this.textTail = []; // últimas líneas de texto del nodo, para el diagnóstico si no contesta
    this.lines = createLines((l) => {
      this.textTail.push(l);
      if (this.textTail.length > 6) this.textTail.shift();
    });
    this.onDisc = () => this.fail(new LinkError("lost", null, "se ha desconectado el cable o el nodo"));
  }

  log(msg) { this.h.log?.(msg); }

  async open() {
    const t0 = Date.now();
    this.h.onStage?.("open");
    const info = this.port.getInfo?.() || {};
    try {
      // Un cierre a medias anterior deja el puerto abierto: se cierra antes de volver a abrirlo.
      if (this.port.readable || this.port.writable) { try { await this.port.close(); } catch { /* nada */ } }
      await this.port.open({ baudRate: BAUD });
    } catch (e) {
      throw new LinkError("open", e);
    }
    this.port.addEventListener?.("disconnect", this.onDisc);
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    const hex = (n) => (n == null ? "?" : n.toString(16).padStart(4, "0"));
    this.log(`Puerto abierto en ${Date.now() - t0} ms (USB ${hex(info.usbVendorId)}:${hex(info.usbProductId)}, ${BAUD} baudios)`);
    this._fromDevice = new ReadableStream({
      start: (c) => {
        this.ctrl = c;
        c.enqueue({ type: "status", data: { status: ST.DeviceConnected } });
      },
    });
    this._toDevice = new WritableStream({
      write: async (chunk) => {
        try {
          await this.writeRaw(frame(chunk));
        } catch (e) {
          // ECONNRESET hace que la cola de la librería deje de reintentar en bucle.
          throw Object.assign(new Error(e.message || "escritura fallida"), { code: "ECONNRESET" });
        }
      },
    });
    this.readLoop();
    // Despertar: 32 bytes 0xC3, como la librería de Python. El nodo los ignora si ya está despierto.
    try { await this.writeRaw(wakeBytes()); } catch { /* lo dirá la lectura */ }
    this.hbId = setInterval(() => { this.writeRaw(frame(HEARTBEAT)).catch(() => {}); }, HEARTBEAT_MS);
    return this;
  }

  get toDevice() { return this._toDevice; }
  get fromDevice() { return this._fromDevice; }

  /** Escrituras en fila: el latido no se cruza con un paquete. */
  writeRaw(bytes) {
    const run = async () => {
      if (this.failed || this.closing || !this.writer) throw new LinkError("io", null, "conexión cerrada");
      try {
        await this.writer.write(bytes);
      } catch (e) {
        this.fail(new LinkError("io", e));
        throw e;
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async readLoop() {
    for (;;) {
      let r;
      try {
        r = await this.reader.read();
      } catch (e) {
        if (!this.closing) this.fail(new LinkError("lost", e));
        return;
      }
      if (r.done) {
        if (!this.closing) this.fail(new LinkError("lost", null, "el puerto se ha cerrado"));
        return;
      }
      for (const part of this.framer.push(r.value)) {
        if (part.type === "text") { this.lines(part.data); continue; }
        this.lastRx = Date.now();
        this.rxCount++;
        try { this.ctrl?.enqueue({ type: "packet", data: part.data }); } catch { /* cerrado */ }
        this.h.onPacket?.();
      }
    }
  }

  fail(err) {
    if (this.failed || this.closing) return;
    this.failed = true;
    if (this.textTail.length && !this.rxCount) this.log(`Último texto del nodo: ${this.textTail.join(" | ").slice(0, 300)}`);
    try { this.ctrl?.enqueue({ type: "status", data: { status: ST.DeviceDisconnected, reason: err.stage } }); } catch { /* cerrado */ }
    this.cleanup();
    this.h.onFail?.(err);
  }

  /**
   * Suelta lectores y escritores y cierra el puerto. Devuelve (y guarda en closedP) la promesa del cierre:
   * quien vuelva a abrir el mismo puerto tiene que esperarla, o Chrome dice que sigue abierto.
   */
  cleanup() {
    if (this.closedP) return this.closedP;
    clearInterval(this.hbId);
    this.hbId = null;
    this.port.removeEventListener?.("disconnect", this.onDisc);
    const reader = this.reader, writer = this.writer, port = this.port;
    this.reader = null;
    this.writer = null;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    this.closedP = (async () => {
      try { await Promise.race([reader?.cancel(), wait(500)]); } catch { /* nada */ }
      try { reader?.releaseLock(); } catch { /* nada */ }
      try { await Promise.race([writer?.close(), wait(500)]); } catch { /* desenchufado */ }
      try { writer?.releaseLock(); } catch { /* nada */ }
      try { await port.close(); } catch { /* ya cerrado o desenchufado */ }
    })();
    return this.closedP;
  }

  async disconnect() {
    if (this.closing || this.failed) { this.closing = true; return this.cleanup(); }
    // Avisa al nodo de que el cliente se va (vuelve a sacar su registro por el puerto). Sin esperar mucho.
    if (!this.failed && this.writer) {
      await Promise.race([this.writeRaw(frame(DISCONNECT)).catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    }
    this.closing = true;
    try { this.ctrl?.enqueue({ type: "status", data: { status: ST.DeviceDisconnected, reason: "user" } }); } catch { /* cerrado */ }
    await this.cleanup();
  }
}

/**
 * Clasifica un fallo del cable para decir al usuario qué hacer.
 *  busy   → no se pudo abrir el puerto: otro programa lo tiene abierto, o el nodo ya no está enchufado
 *  noapi  → el puerto se abre pero el nodo no contesta como Meshtastic (otro puerto, nodo arrancando o colgado)
 *  lost   → se cortó o no está enchufado: cable fuera, nodo reiniciado
 */
export function classifySerial(err) {
  if (!err) return "other";
  if (err.stage === "open") return "busy";
  if (err.stage === "config") return "noapi";
  if (err.stage === "lost" || err.stage === "io" || err.stage === "unplugged") return "lost";
  return "other";
}
