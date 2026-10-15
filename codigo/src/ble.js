// Enlace Bluetooth con un nodo Meshtastic, pensado para Android.
//
// Por qué no se usa el transporte oficial (@meshtastic/transport-web-bluetooth):
//  - En Android solo puede haber UNA operación GATT en curso. El oficial solapa lecturas, escrituras y
//    la activación de avisos, y la segunda falla ("GATT operation already in progress"), lo que tumba
//    la conexión al azar. Aquí todas las operaciones pasan por una sola cola.
//  - gatt.connect() puede quedarse colgado para siempre en Android. Aquí tiene tiempo límite.
//  - El firmware espera que el cliente lea FromRadio también de vez en cuando, no solo tras un aviso
//    (los avisos se pierden a veces). Aquí hay una lectura de respaldo periódica.
//  - Cada fallo se etiqueta con la fase en que ocurrió, para poder decir al usuario qué hacer.

import { Types } from "@meshtastic/core";

export const SERVICE = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";
const TO_RADIO = "f75c76d2-129e-4dad-a1dd-7866124401e7";
const FROM_RADIO = "2c55e69e-4993-11ed-b878-0242ac120002";
const FROM_NUM = "ed9da18c-a800-4f66-a670-aa7547e34453";
const ST = Types.DeviceStatusEnum;

// notify y read dejan tiempo a teclear el PIN: Android pide emparejar en la primera operación cifrada.
const T = Object.assign(
  { connect: 15000, discover: 12000, notify: 40000, read: 40000, write: 10000, settle: 400, poll: 5000 },
  (typeof window !== "undefined" && window.__VIGIA_BLE_TIMEOUTS) || {},
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BleError extends Error {
  /** stage: gatt | service | notify | io | lost ; cause: error original */
  constructor(stage, cause, msg) {
    super(msg || cause?.message || String(cause));
    this.name = "BleError";
    this.stage = stage;
    this.cause = cause;
    this.causeName = cause?.name || "";
  }
}

function withTimeout(p, ms, label) {
  let id;
  const t = new Promise((_, rej) => { id = setTimeout(() => rej(Object.assign(new Error(`${label}: sin respuesta en ${Math.round(ms / 1000)} s`), { name: "TimeoutError" })), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(id));
}

/**
 * Uso:
 *   const link = new BleLink(device, { log, onFail, onPacket });
 *   await link.open();          // conecta, descubre y activa avisos (lanza BleError)
 *   new MeshDevice(link);       // cumple el contrato Transport: toDevice, fromDevice, disconnect()
 */
export class BleLink {
  constructor(device, hooks = {}) {
    this.device = device;
    this.h = hooks;
    this.chain = Promise.resolve();
    this.closing = false;
    this.failed = false;
    this.draining = false;
    this.drainAgain = false;
    this.lastOp = 0;
    this.lastRx = 0;
    this.rxCount = 0;
    this.pollId = null;
    this.ctrl = null;
    this.opened = false;
    this.discDuringOpen = false;
    this.onDisc = () => {
      if (!this.opened) { this.discDuringOpen = true; return; } // open() lo convierte en error de su fase
      this.fail(new BleError("lost", null, "el nodo cerró la conexión Bluetooth"));
    };
    this.onNotify = () => { this.drain(); };
  }

  log(msg, extra) { this.h.log?.(msg, extra); }

  /** Pone una operación GATT en la cola única; nunca hay dos a la vez. */
  op(label, fn, ms) {
    const run = async () => {
      if (this.failed || this.closing) throw new BleError("io", null, "conexión cerrada");
      this.lastOp = Date.now();
      try {
        return await withTimeout(fn(), ms, label);
      } finally {
        this.lastOp = Date.now();
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async open() {
    try {
      return await this._open();
    } catch (e) {
      this.cleanup();
      throw e instanceof BleError ? e : new BleError("other", e);
    }
  }

  async _open() {
    const dev = this.device;
    const dropped = (stage) => { if (this.discDuringOpen) throw new BleError(stage, null, "el nodo cortó la conexión nada más abrirla"); };
    if (!dev.gatt) throw new BleError("gatt", null, "el dispositivo no tiene GATT");
    dev.addEventListener("gattserverdisconnected", this.onDisc);
    const t0 = Date.now();

    // 1. Enlace. En Android un primer intento puede fallar justo al despertar el nodo: se reintenta una vez.
    let server;
    this.h.onStage?.("gatt");
    for (let attempt = 1; ; attempt++) {
      this.log(`Conectando (intento ${attempt})`);
      try {
        server = await withTimeout(dev.gatt.connect(), T.connect, "connect");
        break;
      } catch (e) {
        this.safeDisconnect();
        if (attempt >= 2 || this.closing) throw new BleError("gatt", e);
        this.log(`Primer intento fallido: ${e.name || ""} ${e.message || e}`);
        await sleep(800);
      }
    }
    this.server = server;
    this.log(`Enlace abierto en ${Date.now() - t0} ms`);
    await sleep(T.settle); // Android: descubrir servicios nada más conectar falla a veces
    dropped("service");

    // 2. Servicio y características.
    this.h.onStage?.("service");
    try {
      const svc = await withTimeout(server.getPrimaryService(SERVICE), T.discover, "servicio");
      this.toRadio = await svc.getCharacteristic(TO_RADIO);
      this.fromRadio = await svc.getCharacteristic(FROM_RADIO);
      this.fromNum = await svc.getCharacteristic(FROM_NUM);
    } catch (e) {
      throw new BleError("service", e);
    }
    dropped("service");

    // 3. Avisos de datos nuevos. Aquí es donde se nota un emparejamiento roto (las características van cifradas).
    this.h.onStage?.("notify");
    try {
      await this.op("avisos", () => this.fromNum.startNotifications(), T.notify);
      this.fromNum.addEventListener("characteristicvaluechanged", this.onNotify);
    } catch (e) {
      throw new BleError("notify", e);
    }
    dropped("notify");
    this.opened = true;
    this.log(`Listo en ${Date.now() - t0} ms`);

    this._fromDevice = new ReadableStream({
      start: (c) => {
        this.ctrl = c;
        c.enqueue({ type: "status", data: { status: ST.DeviceConnected } });
      },
    });
    this._toDevice = new WritableStream({
      write: async (chunk) => {
        try {
          await this.write(chunk);
        } catch (e) {
          // ECONNRESET hace que la cola de la librería deje de reintentar en bucle.
          throw Object.assign(new Error(e.message || "escritura fallida"), { code: "ECONNRESET" });
        }
      },
    });
    this.pollId = setInterval(() => {
      if (Date.now() - this.lastOp > T.poll - 500) this.drain();
    }, T.poll);
    this.drain();
    return this;
  }

  get toDevice() { return this._toDevice; }
  get fromDevice() { return this._fromDevice; }

  async write(bytes) {
    const ab = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    try {
      await this.op("escritura", () => (this.toRadio.writeValueWithResponse ? this.toRadio.writeValueWithResponse(ab) : this.toRadio.writeValue(ab)), T.write);
    } catch (e) {
      this.fail(e instanceof BleError ? e : new BleError("io", e));
      throw e;
    }
    this.drain();
  }

  /** Lee FromRadio hasta vaciarlo. Si llega otro aviso mientras tanto, vuelve a leer al terminar. */
  async drain() {
    if (this.failed || this.closing || !this.fromRadio) return;
    if (this.draining) { this.drainAgain = true; return; }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        for (let guard = 0; guard < 2000; guard++) {
          const v = await this.op("lectura", () => this.fromRadio.readValue(), T.read);
          if (!v || v.byteLength === 0) break;
          this.lastRx = Date.now();
          this.rxCount++;
          this.ctrl?.enqueue({ type: "packet", data: new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice() });
          this.h.onPacket?.();
        }
      } while (this.drainAgain && !this.failed && !this.closing);
    } catch (e) {
      this.fail(e instanceof BleError ? e : new BleError("io", e));
    } finally {
      this.draining = false;
    }
  }

  fail(err) {
    if (this.failed || this.closing) return;
    this.failed = true;
    this.cleanup();
    try { this.ctrl?.enqueue({ type: "status", data: { status: ST.DeviceDisconnected, reason: err.stage } }); } catch { /* cerrado */ }
    this.h.onFail?.(err);
  }

  cleanup() {
    clearInterval(this.pollId);
    this.pollId = null;
    try { this.fromNum?.removeEventListener("characteristicvaluechanged", this.onNotify); } catch { /* nada */ }
    this.device.removeEventListener("gattserverdisconnected", this.onDisc);
    this.safeDisconnect();
  }

  safeDisconnect() {
    // Siempre, aunque gatt.connected diga false: en Android puede quedar un enlace a medias.
    try { this.device.gatt?.disconnect(); } catch { /* ya cerrado */ }
  }

  async disconnect() {
    if (this.closing) return;
    this.closing = true;
    try { this.ctrl?.enqueue({ type: "status", data: { status: ST.DeviceDisconnected, reason: "user" } }); } catch { /* cerrado */ }
    this.cleanup();
  }
}

/**
 * Clasifica un fallo para decir al usuario qué hacer.
 *  busy     → no se pudo abrir el enlace: fuera de alcance, apagado u ocupado por otro cliente
 *  pairing  → enlace abierto pero falla lo cifrado: emparejamiento roto
 *  service  → no tiene el servicio Meshtastic (otro aparato o caché de Android tras actualizar firmware)
 *  lost     → se cortó estando conectado
 *  other
 */
export function classify(err) {
  if (!err) return "other";
  const msg = `${err.causeName || ""} ${err.message || ""}`;
  if (err.stage === "gatt") return "busy";
  // Un corte justo tras conectar suele ser el cifrado: Android intenta usar un emparejamiento que el nodo ya no tiene.
  if (err.stage === "service") return /NotFound|No Services|No Characteristics/i.test(msg) ? "service" : "pairing";
  if (err.stage === "notify") return "pairing";
  if (/auth|encrypt|insufficient|pair|bond|NotSupported|NotAllowed/i.test(msg)) return "pairing";
  if (err.stage === "lost" || err.stage === "io" || err.stage === "config") return "lost";
  return "other";
}
