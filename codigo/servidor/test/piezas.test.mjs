// Pruebas de las piezas del servidor: puertos USB, almacén SQLite, configuración y enlace (latido, despedida).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { listarPuertos, elegirPuerto } from "../src/puertos.js";
import { abrirAlmacen } from "../src/almacen.js";
import { comprobar, ErrorConfig } from "../src/config.js";
import { EnlaceFlujo } from "../src/enlace.js";
import { clasificar } from "../src/receptor.js";
import { LinkError } from "@vigia/nucleo/receptor-base.js";

/* ── puertos ── */
function sysFalso() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "sys-"));
  const sys = path.join(r, "sys"), dev = path.join(r, "dev");
  const aparato = (bus, vid, pid, producto, tty) => {
    const usb = path.join(sys, "devices/pci0000:00/usb1", bus);
    const intf = path.join(usb, `${bus}:1.0`);
    fs.mkdirSync(path.join(intf, "tty", tty), { recursive: true });
    fs.writeFileSync(path.join(usb, "idVendor"), `${vid}\n`);
    fs.writeFileSync(path.join(usb, "idProduct"), `${pid}\n`);
    fs.writeFileSync(path.join(usb, "product"), `${producto}\n`);
    fs.writeFileSync(path.join(usb, "manufacturer"), "Fabricante\n");
    fs.mkdirSync(path.join(sys, "class/tty", tty), { recursive: true });
    fs.symlinkSync(intf, path.join(sys, "class/tty", tty, "device"));
  };
  aparato("1-1", "239a", "8029", "DNN 5", "ttyACM0");
  aparato("1-2", "0bda", "5411", "Lector de tarjetas", "ttyUSB0");
  fs.mkdirSync(path.join(sys, "class/tty/ttyS0"), { recursive: true }); // puerto de la placa: no cuenta
  fs.mkdirSync(path.join(dev, "serial/by-id"), { recursive: true });
  fs.symlinkSync("../../ttyACM0", path.join(dev, "serial/by-id/usb-Adafruit_DNN_5_ABC123-if00"));
  return { sys, dev };
}

test("puertos: lee fabricante y producto USB de /sys y el nombre estable de /dev/serial/by-id", () => {
  const raices = sysFalso();
  const l = listarPuertos(raices);
  assert.equal(l.length, 2);
  assert.deepEqual([l[0].vid, l[0].pid, l[0].producto, l[0].conocido], [0x239a, 0x8029, "DNN 5", true]);
  assert.equal(l[0].porId, path.join(raices.dev, "serial/by-id/usb-Adafruit_DNN_5_ABC123-if00"));
  assert.equal(l[1].conocido, false);
});

test("puertos: auto elige el nodo; por id USB; por ruta; y explica por qué no hay ninguno", () => {
  const l = listarPuertos(sysFalso());
  assert.equal(elegirPuerto("auto", l).puerto.producto, "DNN 5");
  assert.equal(elegirPuerto("239a:8029", l).puerto.producto, "DNN 5");
  assert.match(elegirPuerto("303a:1001", l).motivo, /ningún aparato USB 303a:1001/);
  assert.equal(elegirPuerto(l[0].porId, l).puerto.ruta, l[0].porId);
  assert.match(elegirPuerto("auto", l.filter((p) => !p.conocido)).motivo, /ninguno parece un nodo Meshtastic/);
  assert.match(elegirPuerto("auto", []).motivo, /no hay ningún nodo enchufado/);
  assert.match(elegirPuerto("auto", [l[0], { ...l[0], ruta: "/dev/ttyACM1" }]).nota, /hay 2 nodos enchufados/);
});

/* ── almacén ── */
test("almacén: lecturas sin duplicados, series ordenadas, poda y estado", async () => {
  const a = abrirAlmacen(":memory:");
  await a.lecturas.add([{ node: 1, metric: "temperature", t: 2000, v: 20 }, { node: 1, metric: "temperature", t: 1000, v: 19 }]);
  await a.lecturas.add([{ node: 1, metric: "temperature", t: 2000, v: 20.5 }]); // la misma lectura otra vez
  assert.deepEqual(await a.lecturas.series(1, "temperature", 0), [{ t: 1000, v: 19 }, { t: 2000, v: 20.5 }]);
  assert.equal(await a.lecturas.count(), 2);
  assert.equal(await a.lecturas.prune(1500), 1);
  assert.equal(await a.lecturas.count(), 1);
  a.guardar("cfg", { watched: { 1: { rules: {} } } });
  assert.deepEqual(a.leer("cfg"), { watched: { 1: { rules: {} } } });
  assert.equal(a.leer("nada", "d"), "d");
});

test("almacén: el total de lecturas se lleva en memoria y cuadra con SQLite", async () => {
  const a = abrirAlmacen(":memory:");
  const real = () => a.db.prepare("SELECT COUNT(*) AS n FROM lecturas").get().n;
  assert.equal(await a.lecturas.count(), 0);
  await a.lecturas.add([{ node: 1, metric: "temperature", t: 1000, v: 19 }, { node: 2, metric: "voltage", t: 1000, v: 4.1 }]);
  await a.lecturas.add([{ node: 1, metric: "temperature", t: 1000, v: 19.5 }, { node: 1, metric: "temperature", t: 3000, v: 21 }]); // una repetida
  assert.equal(await a.lecturas.count(), 3);
  assert.equal(await a.lecturas.count(), real());
  assert.deepEqual(await a.lecturas.series(1, "temperature", 0), [{ t: 1000, v: 19.5 }, { t: 3000, v: 21 }]);
  await a.lecturas.prune(2000);
  assert.equal(await a.lecturas.count(), real());
  await a.lecturas.clear();
  assert.equal(await a.lecturas.count(), 0);
});

test("almacén: en fichero, con WAL", () => {
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vigia-")), "datos/vigia.db");
  const a = abrirAlmacen(ruta);
  assert.equal(a.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  a.guardar("my", 7);
  a.cerrar();
  assert.equal(abrirAlmacen(ruta).leer("my"), 7);
});

/* ── configuración ── */
test("configuración: valores por defecto y errores claros", () => {
  const c = comprobar({});
  assert.deepEqual(c.receptor, { tipo: "usb", puerto: "auto" });
  assert.equal(c.web.puerto, 4404);
  assert.equal(c.retencionDias, 365); // todos los nodos, un año
  assert.deepEqual(comprobar({ receptor: { tipo: "tcp", host: "nodo.local" } }).receptor, { tipo: "tcp", puerto: 4403, host: "nodo.local" });
  assert.throws(() => comprobar({ receptor: { tipo: "tcp" } }), (e) => e instanceof ErrorConfig && /falta "host"/.test(e.message));
  assert.throws(() => comprobar({ receptor: { tipo: "bluetooth" } }), /"usb" o "tcp"/);
  assert.throws(() => comprobar({ receptor: { puerto: "COM3" } }), /"auto", una ruta/);
  assert.throws(() => comprobar({ web: { puerto: 99999 } }), /web.puerto/);
});

test("fallos: qué decir según el caso", () => {
  assert.equal(clasificar(new LinkError("open", Object.assign(new Error("Error: Permission denied, cannot open /dev/ttyACM0"), { code: "EACCES" })), "serial"), "permiso");
  assert.equal(clasificar(new LinkError("open", new Error("Error Resource temporarily unavailable Cannot lock port")), "serial"), "busy");
  assert.equal(clasificar(new LinkError("open", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), "tcp"), "red");
  assert.equal(clasificar(new LinkError("unplugged", null, "no hay ningún nodo enchufado"), "serial"), "unplugged");
  assert.equal(clasificar(new LinkError("config", null, "el nodo dejó de mandar datos"), "serial"), "noapi");
});

/* ── enlace ── */
function duplexFalso() {
  const escrito = [];
  const d = new Duplex({ read() {}, write(chunk, _enc, cb) { escrito.push(...chunk); cb(); } });
  d.escrito = escrito;
  return d;
}

test("enlace: despierta al nodo, manda latido cada 5 min y se despide al cerrar", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const d = duplexFalso();
  const link = new EnlaceFlujo(async () => d);
  await link.open();
  assert.deepEqual(d.escrito.slice(0, 32), new Array(32).fill(0xc3));
  d.escrito.length = 0;
  t.mock.timers.tick(5 * 60000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(d.escrito, [0x94, 0xc3, 0, 2, 0x3a, 0x00]); // ToRadio { heartbeat }
  d.escrito.length = 0;
  await link.disconnect();
  assert.deepEqual(d.escrito, [0x94, 0xc3, 0, 2, 0x20, 0x01]); // ToRadio { disconnect: true }
});

test("enlace: entrega los paquetes aunque lleguen troceados y con texto entre medias", async () => {
  const d = duplexFalso();
  const paquetes = [];
  const link = new EnlaceFlujo(async () => d, { onPacket: () => {} });
  await link.open();
  const lector = link.fromDevice.getReader();
  d.push(Buffer.from("INFO | arranque\n"));
  d.push(Buffer.from([0x94, 0xc3, 0, 3, 1]));
  d.push(Buffer.from([2, 3]));
  for (let i = 0; i < 2; i++) paquetes.push((await lector.read()).value);
  assert.equal(paquetes[0].type, "status");
  assert.deepEqual([...paquetes[1].data], [1, 2, 3]);
  await link.disconnect();
});

test("enlace: si el otro lado cierra, avisa una vez con «lost»", async () => {
  const d = duplexFalso();
  const fallos = [];
  const link = new EnlaceFlujo(async () => d, { onFail: (e) => fallos.push(e) });
  await link.open();
  d.destroy();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fallos.length, 1);
  assert.equal(fallos[0].stage, "lost");
});
