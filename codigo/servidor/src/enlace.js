// Enlace con el nodo sobre un flujo de Node: puerto serie (serialport) o conexión TCP (puerto 4403).
// Por los dos va lo mismo que por el cable en la app: tramas 0x94 0xC3 + longitud, con texto del registro del nodo
// entre medias (solo por cable). Cumple el contrato Transport de @meshtastic/core: toDevice, fromDevice, disconnect().
import net from "node:net";
import { Types } from "@meshtastic/core";
import { LinkError } from "@vigia/nucleo/receptor-base.js";
import { frame, createFramer, createLines, HEARTBEAT, HEARTBEAT_MS, DISCONNECT, wakeBytes } from "@vigia/nucleo/tramas.js";

const ST = Types.DeviceStatusEnum;
const BAUD = 115200;

/**
 * Uso:
 *   const link = new EnlaceFlujo(() => abrirSerie("/dev/ttyACM0"), { log, onFail, onPacket, onStage });
 *   await link.open();          // abre (lanza LinkError con stage «open»)
 *   new MeshDevice(link);
 * abrir: función async que devuelve un Duplex de Node ya abierto.
 */
export class EnlaceFlujo {
  constructor(abrir, hooks = {}) {
    this.abrir = abrir;
    this.h = hooks;
    this.s = null;
    this.closing = false;
    this.failed = false;
    this.lastRx = 0;
    this.rxCount = 0;
    this.ctrl = null;
    this.chain = Promise.resolve();
    this.hbId = null;
    this.framer = createFramer();
    this.textTail = []; // últimas líneas de texto del nodo, para el diagnóstico si no contesta
    this.lines = createLines((l) => {
      this.textTail.push(l);
      if (this.textTail.length > 6) this.textTail.shift();
    });
  }

  log(msg) { this.h.log?.(msg); }

  async open() {
    const t0 = Date.now();
    this.h.onStage?.("open");
    let s;
    try {
      s = await this.abrir();
    } catch (e) {
      throw new LinkError("open", e);
    }
    this.s = s;
    s.on("data", (chunk) => this._rx(chunk));
    s.on("error", (e) => this.fail(new LinkError("io", e)));
    s.on("close", () => { if (!this.closing) this.fail(new LinkError("lost", null, "se ha cerrado la conexión con el nodo")); });
    this.log(`Conexión abierta en ${Date.now() - t0} ms`);
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
    // Despertar: 32 bytes 0xC3, como la librería de Python. El nodo los ignora si ya está despierto.
    try { await this.writeRaw(wakeBytes()); } catch { /* lo dirá la lectura */ }
    // Sin un latido, el nodo deja el modo API a los 15 min sin tráfico del cliente (por cable y por TCP).
    this.hbId = setInterval(() => { this.writeRaw(frame(HEARTBEAT)).catch(() => {}); }, HEARTBEAT_MS);
    this.hbId.unref?.();
    return this;
  }

  get toDevice() { return this._toDevice; }
  get fromDevice() { return this._fromDevice; }

  /** Escrituras en fila: el latido no se cruza con un paquete. */
  writeRaw(bytes) {
    const run = () => new Promise((resolve, reject) => {
      if (this.failed || this.closing || !this.s) return reject(new LinkError("io", null, "conexión cerrada"));
      this.s.write(Buffer.from(bytes), (e) => {
        if (!e) return resolve();
        this.fail(new LinkError("io", e));
        reject(e);
      });
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  _rx(chunk) {
    for (const part of this.framer.push(new Uint8Array(chunk))) {
      if (part.type === "text") { this.lines(part.data); continue; }
      this.lastRx = Date.now();
      this.rxCount++;
      try { this.ctrl?.enqueue({ type: "packet", data: part.data }); } catch { /* cerrado */ }
      this.h.onPacket?.();
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

  /** Cierra el flujo. Devuelve (y guarda en closedP) la promesa del cierre: quien reabra el puerto la espera. */
  cleanup() {
    if (this.closedP) return this.closedP;
    clearInterval(this.hbId);
    this.hbId = null;
    const s = this.s;
    this.s = null;
    this.closedP = new Promise((resolve) => {
      if (!s || s.destroyed) return resolve();
      const t = setTimeout(resolve, 1000);
      s.once("close", () => { clearTimeout(t); resolve(); });
      try {
        if (typeof s.close === "function" && s.isOpen) s.close(() => {}); // serialport
        else s.destroy();
      } catch { clearTimeout(t); resolve(); }
    });
    return this.closedP;
  }

  async disconnect() {
    if (this.closing || this.failed) { this.closing = true; return this.cleanup(); }
    // Avisa al nodo de que el cliente se va (vuelve a sacar su registro por el puerto). Sin esperar mucho.
    if (this.s) {
      await Promise.race([this.writeRaw(frame(DISCONNECT)).catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    }
    this.closing = true;
    try { this.ctrl?.enqueue({ type: "status", data: { status: ST.DeviceDisconnected, reason: "user" } }); } catch { /* cerrado */ }
    await this.cleanup();
  }
}

/** Abre un puerto serie a 115200 baudios, en exclusiva (otro programa no podrá abrirlo a la vez). */
export async function abrirSerie(ruta) {
  const { SerialPort } = await import("serialport");
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path: ruta, baudRate: BAUD, autoOpen: false, lock: true });
    p.open((e) => (e ? reject(e) : resolve(p)));
  });
}

/** Conecta por TCP al nodo (WiFi o Ethernet) o a meshtasticd. */
export function abrirTcp(host, puerto = 4403, esperaMs = 10000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port: puerto });
    const t = setTimeout(() => s.destroy(Object.assign(new Error(`sin respuesta de ${host}:${puerto} en ${esperaMs / 1000} s`), { code: "ETIMEDOUT" })), esperaMs);
    s.once("error", (e) => { clearTimeout(t); reject(e); });
    s.once("connect", () => {
      clearTimeout(t);
      s.removeAllListeners("error");
      s.setNoDelay(true);
      s.setKeepAlive(true, 30000);
      resolve(s);
    });
  });
}
