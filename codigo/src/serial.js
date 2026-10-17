// Enlace por cable USB con un nodo Meshtastic (Web Serial, Chrome y Edge de ordenador).
//
// Por el puerto serie el firmware manda cada FromRadio en una trama: 0x94 0xC3, longitud (2 bytes, primero el
// alto) y el protobuf. Entre trama y trama puede colar texto: el registro de arranque del nodo, que sale por el
// mismo puerto hasta que el cliente pide la configuración. Lo que mandamos va con la misma cabecera.
//
// Por qué no se usa el troceado de @meshtastic/core: descarta un paquete si dentro aparecen los bytes 0x94 0xC3
// (puede pasar en un id de nodo o en datos cifrados) y no se recupera de una cabecera falsa con longitud imposible.

import { Types } from "@meshtastic/core";

const ST = Types.DeviceStatusEnum;
const START1 = 0x94, START2 = 0xc3, MAX_LEN = 512;
const BAUD = 115200;
// Sin un latido el firmware deja el modo API del puerto a los 15 min sin tráfico del cliente.
const HEARTBEAT_MS = 5 * 60000;
const HEARTBEAT = new Uint8Array([0x3a, 0x00]); // ToRadio { heartbeat: {} } (campo 7)
const DISCONNECT = new Uint8Array([0x20, 0x01]); // ToRadio { disconnect: true } (campo 4)

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

/** Pone la cabecera de trama a un protobuf ToRadio. */
export function frame(bytes) {
  const out = new Uint8Array(bytes.length + 4);
  out.set([START1, START2, (bytes.length >> 8) & 0xff, bytes.length & 0xff]);
  out.set(bytes, 4);
  return out;
}

/**
 * Troceador de lo que llega por el puerto. push(bytes) devuelve [{ type: "packet", data } | { type: "text", data }]
 * en orden. Guarda los trozos incompletos para la siguiente llamada.
 */
export function createFramer() {
  let buf = new Uint8Array(0);
  return {
    push(chunk) {
      if (chunk?.length) {
        const n = new Uint8Array(buf.length + chunk.length);
        n.set(buf);
        n.set(chunk, buf.length);
        buf = n;
      }
      const out = [];
      let i = 0;
      for (;;) {
        let s = -1;
        for (let k = i; k + 1 < buf.length; k++) if (buf[k] === START1 && buf[k + 1] === START2) { s = k; break; }
        if (s < 0) {
          // Sin cabecera: todo es texto, menos un 0x94 final que puede ser media cabecera.
          const keep = buf.length > i && buf[buf.length - 1] === START1 ? buf.length - 1 : buf.length;
          if (keep > i) out.push({ type: "text", data: buf.slice(i, keep) });
          buf = buf.slice(keep);
          return out;
        }
        if (s > i) out.push({ type: "text", data: buf.slice(i, s) });
        if (s + 4 > buf.length) { buf = buf.slice(s); return out; }
        const len = (buf[s + 2] << 8) | buf[s + 3];
        if (len > MAX_LEN) { // cabecera falsa: se sigue buscando desde el byte siguiente
          out.push({ type: "text", data: buf.slice(s, s + 1) });
          i = s + 1;
          continue;
        }
        if (s + 4 + len > buf.length) { buf = buf.slice(s); return out; }
        out.push({ type: "packet", data: buf.slice(s + 4, s + 4 + len) });
        i = s + 4 + len;
      }
    },
  };
}

/** Texto del registro del nodo en líneas completas; guarda la línea a medias. */
function createLines(onLine) {
  const td = new TextDecoder();
  let part = "";
  return (bytes) => {
    part += td.decode(bytes, { stream: true });
    const lines = part.split(/\r?\n/);
    part = lines.pop();
    if (part.length > 400) { lines.push(part); part = ""; }
    for (const l of lines) if (l.trim()) onLine(l.replace(/\x1b\[[0-9;]*m/g, "").trim()); // sin colores ANSI
  };
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
    try { await this.writeRaw(new Uint8Array(32).fill(START2)); } catch { /* lo dirá la lectura */ }
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

  /** Suelta lectores y escritores y cierra el puerto (en segundo plano: nunca se queda colgado). */
  cleanup() {
    clearInterval(this.hbId);
    this.hbId = null;
    this.port.removeEventListener?.("disconnect", this.onDisc);
    const reader = this.reader, writer = this.writer, port = this.port;
    this.reader = null;
    this.writer = null;
    (async () => {
      try { await reader?.cancel(); } catch { /* nada */ }
      try { reader?.releaseLock(); } catch { /* nada */ }
      try { writer?.releaseLock(); } catch { /* nada */ }
      try { await port.close(); } catch { /* ya cerrado o desenchufado */ }
    })();
  }

  async disconnect() {
    if (this.closing) return;
    // Avisa al nodo de que el cliente se va (vuelve a sacar su registro por el puerto). Sin esperar mucho.
    if (!this.failed && this.writer) {
      await Promise.race([this.writeRaw(frame(DISCONNECT)).catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    }
    this.closing = true;
    try { this.ctrl?.enqueue({ type: "status", data: { status: ST.DeviceDisconnected, reason: "user" } }); } catch { /* cerrado */ }
    this.cleanup();
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
