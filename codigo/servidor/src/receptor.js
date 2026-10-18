// Receptor del servidor: el nodo por cable USB o por TCP. Lo común (lectura inicial, reintentos, peticiones con id)
// está en el núcleo; aquí, cómo se abre cada enlace y qué decir cuando falla.
import { ReceptorBase, LinkError } from "@vigia/nucleo/receptor-base.js";
import { EnlaceFlujo, abrirSerie, abrirTcp } from "./enlace.js";
import { listarPuertos, elegirPuerto, describirPuerto } from "./puertos.js";

/**
 * Qué decir según el fallo. Además de los de la app (busy, noapi, lost):
 *  permiso    el usuario del servicio no puede abrir el puerto (no está en el grupo dialout)
 *  unplugged  no hay nodo enchufado
 *  red        no se llega al nodo por TCP (apagado, otra IP, otra red)
 *  ocupado    por TCP, otro cliente le quitó la conexión (el firmware solo admite uno)
 */
export function clasificar(err, tipo) {
  if (!err) return "other";
  const code = err.cause?.code || err.code || "";
  const msg = `${err.cause?.message || ""} ${err.message || ""}`;
  if (err.stage === "unplugged") return "unplugged";
  if (err.stage === "open") {
    if (tipo === "tcp") return "red";
    if (code === "EACCES" || /permission denied/i.test(msg)) return "permiso";
    if (code === "ENOENT" || /no such file/i.test(msg)) return "unplugged";
    return "busy";
  }
  if (err.stage === "config") return "noapi";
  if (err.stage === "lost" || err.stage === "io") return "lost";
  return "other";
}

export const CONSEJO = {
  permiso: "El servicio no tiene permiso para abrir el puerto: su usuario tiene que estar en el grupo «dialout» (el instalador lo hace; si lo cambiaste a mano, reinicia el servicio).",
  busy: "No se pudo abrir el puerto: otro programa lo tiene abierto (la web de Meshtastic, un monitor serie, otro servidor…). Ciérralo.",
  unplugged: "Al enchufarlo, el servidor conecta solo en menos de un minuto.",
  noapi: "El puerto se abre pero el nodo no contesta como Meshtastic: ¿es el puerto correcto? ¿Está arrancando o colgado? Prueba a reiniciarlo.",
  red: "No se llega al nodo por la red: comprueba la IP, que esté encendido y en la misma red, y que tenga el WiFi o Ethernet activado.",
  lost: "Se cortó la conexión con el nodo. Si es por TCP y pasa a menudo, otro cliente (la app de Meshtastic, Home Assistant…) puede estar conectándose al mismo nodo: el firmware solo admite uno y echa al anterior.",
};

export class ReceptorNodo extends ReceptorBase {
  /**
   * destino: { tipo: "usb", puerto: "auto" | "/dev/…" | "239a:8029" } o { tipo: "tcp", host, puerto }
   * opts.puertos: lista de puertos (para pruebas); opts.abrirSerie: para pruebas.
   */
  constructor(h, destino, opts = {}) {
    super(h);
    this.destino = destino;
    this.kind = destino?.tipo === "tcp" ? "tcp" : "serial";
    this.opts = opts;
    this.closingP = null;
    this.ruta = null;
  }

  get hasTarget() { return !!this.destino; }
  get reconfigure() { return this.kind === "serial"; }
  firstStage() { return "open"; }
  classify(err) { return clasificar(err, this.kind); }
  get targetName() {
    if (this.kind === "tcp") return `${this.destino.host}:${this.destino.puerto || 4403}`;
    return this.ruta || String(this.destino.puerto || "auto");
  }

  /** Empieza a conectar y sigue reintentando solo hasta que se llame a disconnect(). */
  start() {
    this.userClosed = false;
    this.retry = 0;
    this.connect();
  }

  async openLink(hooks) {
    if (this.closingP) await Promise.race([this.closingP, new Promise((r) => setTimeout(r, 2000))]);
    this.closingP = null;
    if (this.kind === "tcp") {
      const { host, puerto = 4403 } = this.destino;
      this.h.onDevice?.({ kind: "tcp", name: `${host}:${puerto}` });
      return new EnlaceFlujo(() => (this.opts.abrirTcp || abrirTcp)(host, puerto), hooks);
    }
    const lista = (this.opts.listarPuertos || listarPuertos)();
    const { puerto, nota, motivo } = elegirPuerto(this.destino.puerto, lista);
    if (this.userClosed) return null;
    if (!puerto) { this._fail(new LinkError("unplugged", null, motivo)); return null; }
    if (nota && this.ruta !== puerto.ruta) this.diag(nota);
    if (this.ruta !== puerto.ruta) this.diag(`Puerto: ${describirPuerto(puerto)}`);
    this.ruta = puerto.ruta;
    this.h.onDevice?.({ kind: "serial", name: puerto.producto || puerto.ruta, ruta: puerto.ruta, vid: puerto.vid, pid: puerto.pid });
    return new EnlaceFlujo(() => (this.opts.abrirSerie || abrirSerie)(puerto.ruta), hooks);
  }

  afterClose(link, p) {
    // El puerto tarda un momento en cerrarse: la siguiente apertura lo espera (ver openLink).
    this.closingP = Promise.resolve(p).catch(() => {});
  }
}
