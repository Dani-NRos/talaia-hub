// Pruebas de las peticiones a nodos: lectura de acuses/errores, captura del id del paquete y traceroute. Ejecutar: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { routingErrorReason } from "@vigia/nucleo/pb.js";
import { Receptor } from "../src/receptor.js";

test("acuse y errores de enrutado", () => {
  assert.equal(routingErrorReason(new Uint8Array([0x18, 0x00])), 0);   // acuse
  assert.equal(routingErrorReason(new Uint8Array([0x18, 0x08])), 8);   // NO_RESPONSE
  assert.equal(routingErrorReason(new Uint8Array([0x18, 0x23])), 35);  // PKI_UNKNOWN_PUBKEY
  assert.equal(routingErrorReason(new Uint8Array([0x0a, 0x02, 0x0d, 0x01])), null); // route_request
  assert.equal(routingErrorReason(new Uint8Array([])), null);
  assert.equal(routingErrorReason(new Uint8Array([0x18])), null);       // cortado
});

test("el id de la petición se conoce al enviarla, y la librería queda como estaba", async () => {
  class FakeMesh {
    generateRandId() { return 123456789; }
    async sendPacket(payload, port, dest, channel, wantAck, wantResponse) {
      const id = this.generateRandId(); // como @meshtastic/core: antes de su primer await
      this.last = { payload: [...payload], port, dest, channel, wantAck, wantResponse, id };
      await new Promise((r) => setTimeout(r, 5));
      return id;
    }
  }
  const rc = new Receptor({});
  rc.mesh = new FakeMesh();
  rc.state = "ready";
  const sent = rc.requestTelemetry(0xaa62b264, 2, 0);
  assert.equal(sent.id, 123456789);
  assert.equal(Object.prototype.hasOwnProperty.call(rc.mesh, "generateRandId"), false);
  assert.equal(await sent.done, 123456789);
  assert.deepEqual(rc.mesh.last.payload, [0x12, 0x00]); // Telemetry { device_metrics: {} }
  assert.equal(rc.mesh.last.wantAck, true);
  assert.equal(rc.mesh.last.wantResponse, true);
  // Sin receptor listo: se rechaza sin id.
  rc.state = "idle";
  const no = rc.requestPosition(1);
  assert.equal(no.id, null);
  await assert.rejects(no.done);
});

const DNN4 = 0xaa62b264;

test("el receptor manda el traceroute vacío, con acuse y respuesta, y da el id al momento", async () => {
  class FakeMesh {
    generateRandId() { return 987654321; }
    async sendPacket(payload, port, dest, channel, wantAck, wantResponse) {
      const id = this.generateRandId();
      this.last = { payload: [...payload], port, dest, channel, wantAck, wantResponse };
      return id;
    }
  }
  const rc = new Receptor({});
  rc.mesh = new FakeMesh();
  rc.state = "ready";
  const sent = rc.requestTraceroute(DNN4, 1);
  assert.equal(sent.id, 987654321);
  assert.equal(await sent.done, 987654321);
  assert.deepEqual(rc.mesh.last, { payload: [], port: 70, dest: DNN4, channel: 1, wantAck: true, wantResponse: true });
});
