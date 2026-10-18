// Prueba por cable con un puerto serie virtual (un pseudoterminal) unido al nodo simulado: pasa por serialport de
// verdad, como con el DNN 5 enchufado. Necesita python3 (para crear el pseudoterminal); si no está, se salta.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { crearVigia } from "../src/vigia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { abrirSerie } from "../src/enlace.js";
import { NodoFalso, hasta, ME, CASETA } from "./nodo-falso.mjs";

const PUENTE = `
import os, pty, socket, sys, tty, select
m, s = pty.openpty()
tty.setraw(s)
print(os.ttyname(s), flush=True)
c = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
while True:
    r, _, _ = select.select([m, c], [], [])
    if m in r:
        try: d = os.read(m, 4096)
        except OSError: continue
        c.sendall(d)
    if c in r:
        d = c.recv(4096)
        if not d: break
        os.write(m, d)
`;
const hayPython = spawnSync("python3", ["-c", "import pty"]).status === 0;

async function puertoVirtual(t, nodo) {
  const tcp = await nodo.escucharTcp();
  const py = spawn("python3", ["-c", PUENTE, String(tcp)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { py.stdout.destroy(); py.kill(); });
  const ruta = await new Promise((resolve) => py.stdout.once("data", (d) => resolve(String(d).trim())));
  await hasta(() => nodo.flujo, 3000, "puente conectado");
  return ruta;
}

test("por cable: conecta, lee la configuración y guarda lecturas", { skip: !hayPython && "sin python3" }, async (t) => {
  const nodo = new NodoFalso();
  const ruta = await puertoVirtual(t, nodo);
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-"));
  const config = comprobar({ receptor: { tipo: "usb", puerto: ruta }, datos });
  const salida = [];
  const v = await crearVigia(config, crearRegistro({ nivel: "depurar", salida }), { almacen: abrirAlmacen(":memory:") });
  t.after(async () => { await v.detener(); await nodo.cerrar(); });
  v.arrancar();
  await hasta(() => v.S.link.state === "ready", 8000, "receptor listo por cable");
  assert.equal(v.S.myNode, ME);
  assert.equal(v.S.device.kind, "serial");
  assert.match(v.S.log[0].text, /^Receptor listo por cable: DNN 5$/);
  nodo.ambiente(CASETA, { temperature: 21.5 });
  await hasta(() => v.S.nodes.get(CASETA).metrics.temperature?.v === 21.5, 3000, "lectura");
  assert.equal((await v.almacen.lecturas.series(CASETA, "temperature", 0)).length, 1);
});

test("por cable: el puerto se abre en exclusiva (otro programa no puede abrirlo a la vez)", { skip: !hayPython && "sin python3" }, async (t) => {
  const nodo = new NodoFalso({ responder: false });
  const ruta = await puertoVirtual(t, nodo);
  const a = await abrirSerie(ruta);
  t.after(async () => { await new Promise((r) => a.close(() => r())); await nodo.cerrar(); });
  await assert.rejects(abrirSerie(ruta), /lock|busy|resource/i);
});
