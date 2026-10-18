// Nodo Meshtastic simulado para las pruebas: habla protobuf de verdad sobre cualquier flujo (TCP o puerto serie
// virtual). Contesta a la petición de configuración con una base de nodos, canales y LoRa; apunta lo que le mandan;
// y deja mandar paquetes (telemetría, acuses…) como si llegaran por la malla.
import net from "node:net";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import { createFramer, frame } from "@vigia/nucleo/tramas.js";

const M = Protobuf.Mesh, PORT = Protobuf.Portnums.PortNum, TEL = Protobuf.Telemetry, CH = Protobuf.Channel, CFG = Protobuf.Config;
export { PORT };
export const ME = 0xa1b2c3d4, CASETA = 0x3c6e19a2, AVISADO = 0x5d20b7f1, VECINO = 0x11223344;
const KEY = (b) => new Uint8Array(32).fill(b);
const user = (num, longName, shortName, b) => create(M.UserSchema, { id: `!${num.toString(16).padStart(8, "0")}`, longName, shortName, hwModel: 43, publicKey: KEY(b) });

export class NodoFalso {
  constructor({ responder = true } = {}) {
    this.responder = responder; // contestar solo a la configuración
    this.recibido = []; // ToRadio decodificados (sin latidos)
    this.latidos = 0;
    this.textos = []; // texto suelto que le llega (debería ser solo el despertar)
    this.conexiones = 0;
    this.flujo = null;
    this.pid = 9000;
    this.esperas = [];
  }

  /** Atiende un flujo (un socket TCP o el lado maestro de un puerto virtual). */
  atender(flujo) {
    this.flujo = flujo;
    this.conexiones++;
    const framer = createFramer();
    flujo.on("data", (chunk) => {
      for (const it of framer.push(new Uint8Array(chunk))) {
        if (it.type === "text") { this.textos.push(it.data); continue; }
        const m = fromBinary(M.ToRadioSchema, it.data);
        if (m.payloadVariant.case === "heartbeat") { this.latidos++; continue; }
        this.recibido.push(m);
        if (m.payloadVariant.case === "wantConfigId" && this.responder) this.configuracion(m.payloadVariant.value);
        for (const w of this.esperas.splice(0)) w();
      }
    });
    flujo.on("error", () => {});
  }

  /** Servidor TCP en un puerto libre de localhost. */
  async escucharTcp() {
    this.tcp = net.createServer((s) => { this.cerrarFlujo(); this.atender(s); });
    await new Promise((r) => this.tcp.listen(0, "127.0.0.1", r));
    return this.tcp.address().port;
  }

  cerrarFlujo() { try { this.flujo?.destroy(); } catch { /* ya cerrado */ } this.flujo = null; }
  async cerrar() { this.cerrarFlujo(); await new Promise((r) => (this.tcp ? this.tcp.close(r) : r())); }

  enviar(variant) {
    const bytes = frame(toBinary(M.FromRadioSchema, create(M.FromRadioSchema, { payloadVariant: variant })));
    this.flujo?.write(Buffer.from(bytes));
  }

  configuracion(id) {
    const t = Math.floor(Date.now() / 1000);
    this.enviar({ case: "myInfo", value: create(M.MyNodeInfoSchema, { myNodeNum: ME }) });
    this.enviar({ case: "nodeInfo", value: create(M.NodeInfoSchema, { num: ME, user: user(ME, "DNN 5", "DNN5", 1), lastHeard: t }) });
    this.enviar({ case: "nodeInfo", value: create(M.NodeInfoSchema, { num: CASETA, user: user(CASETA, "Caseta huerto", "CAS", 2), lastHeard: t - 600, snr: 4.5, hopsAway: 1, deviceMetrics: create(TEL.DeviceMetricsSchema, { batteryLevel: 87, voltage: 4.01 }) }) });
    this.enviar({ case: "nodeInfo", value: create(M.NodeInfoSchema, { num: AVISADO, user: user(AVISADO, "Garaje", "GAR", 3), lastHeard: t - 1200, snr: 7, hopsAway: 0 }) });
    this.enviar({ case: "channel", value: create(CH.ChannelSchema, { index: 0, role: CH.Channel_Role.PRIMARY, settings: create(CH.ChannelSettingsSchema, { name: "SFNarrow", psk: new Uint8Array([1]) }) }) });
    this.enviar({ case: "channel", value: create(CH.ChannelSchema, { index: 1, role: CH.Channel_Role.SECONDARY, settings: create(CH.ChannelSettingsSchema, { name: "avisos", psk: KEY(9) }) }) });
    this.enviar({ case: "config", value: create(CFG.ConfigSchema, { payloadVariant: { case: "lora", value: create(CFG.Config_LoRaConfigSchema, { usePreset: false, spreadFactor: 7, hopLimit: 6 }) } }) });
    this.enviar({ case: "configCompleteId", value: id });
  }

  paquete(p) {
    this.enviar({ case: "packet", value: create(M.MeshPacketSchema, { id: ++this.pid, rxTime: Math.floor(Date.now() / 1000), rxSnr: 5.25, hopStart: 3, hopLimit: 2, to: ME, channel: 0, ...p }) });
  }

  /** Telemetría de ambiente de un nodo, a todos. */
  ambiente(from, valores) {
    const tel = create(TEL.TelemetrySchema, { variant: { case: "environmentMetrics", value: create(TEL.EnvironmentMetricsSchema, valores) } });
    this.paquete({ from, to: 0xffffffff, payloadVariant: { case: "decoded", value: create(M.DataSchema, { portnum: PORT.TELEMETRY_APP, payload: toBinary(TEL.TelemetrySchema, tel) }) } });
  }

  /** Paquetes de malla que le han mandado (sin la petición de configuración). */
  paquetes(port = null) {
    return this.recibido.filter((m) => m.payloadVariant.case === "packet").map((m) => m.payloadVariant.value)
      .filter((p) => port == null || p.payloadVariant.value?.portnum === port);
  }

  /** Espera a que llegue algo que cumpla cond (o se acabe el tiempo). */
  async esperar(cond, ms = 5000, que = "condición") {
    const fin = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > fin) throw new Error(`el nodo falso no vio: ${que}`);
      await new Promise((r) => { this.esperas.push(r); setTimeout(r, 25); });
    }
  }
}

/** Espera a que una condición sobre el servidor se cumpla (sondeo cada 20 ms). */
export async function hasta(cond, ms = 5000, que = "condición") {
  const fin = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fin) throw new Error(`no se cumplió: ${que}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
