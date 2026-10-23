// Pruebas de las piezas del servidor: puertos USB, almacén SQLite, configuración y enlace (latido, despedida).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { listarPuertos, elegirPuerto } from "../src/puertos.js";
import { abrirAlmacen, rutaAlmacen, leerGuardado } from "../src/almacen.js";
import { comprobar, ErrorConfig, leerConfig, desdeEntorno, idiomaDelEntorno } from "../src/config.js";
import { EnlaceFlujo } from "../src/enlace.js";
import { clasificar } from "../src/receptor.js";
import { LinkError } from "@talaia/nucleo/receptor-base.js";
import { setLanguage } from "@talaia/nucleo/idioma.js";

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
    fs.mkdirSync(dev, { recursive: true });
    if (tty !== "ttyACM1") fs.writeFileSync(path.join(dev, tty), ""); // ttyACM1: in /sys, not passed to the container
  };
  aparato("1-1", "239a", "8029", "DNN 5", "ttyACM0");
  aparato("1-2", "0bda", "5411", "Lector de tarjetas", "ttyUSB0");
  aparato("1-3", "239a", "8029", "DNN 5 de otro", "ttyACM1");
  fs.mkdirSync(path.join(sys, "class/tty/ttyS0"), { recursive: true }); // puerto de la placa: no cuenta
  fs.mkdirSync(path.join(dev, "serial/by-id"), { recursive: true });
  fs.symlinkSync("../../ttyACM0", path.join(dev, "serial/by-id/usb-Adafruit_DNN_5_ABC123-if00"));
  return { sys, dev };
}

test("puertos: lee fabricante y producto USB de /sys y el nombre estable de /dev/serial/by-id", () => {
  const raices = sysFalso();
  const l = listarPuertos(raices);
  assert.equal(l.length, 2); // ttyACM1 is in /sys but not in /dev (a container that hasn't got it)
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
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "talaia-")), "datos/talaia.db");
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
  assert.throws(() => comprobar({ receptor: { tipo: "tcp" } }), (e) => e instanceof ErrorConfig && /falta «host»/.test(e.message));
  assert.throws(() => comprobar({ receptor: { tipo: "bluetooth" } }), /«usb» o «tcp»/);
  assert.throws(() => comprobar({ receptor: { puerto: "COM3" } }), /«auto», una ruta/);
  assert.throws(() => comprobar({ web: { puerto: 99999 } }), /web.puerto/);
});

test("configuración: con Docker, el entorno manda sobre el fichero", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  const f = path.join(dir, "config.json");
  fs.writeFileSync(f, JSON.stringify({ receptor: { tipo: "tcp", host: "nodo.local" }, web: { puerto: 5000, escuchar: "127.0.0.1" }, mosquitto: { puerto: 1883 } }));
  assert.deepEqual(leerConfig(f, { entorno: {} }).mosquitto, { puerto: 1883, host: "127.0.0.1" });
  const c = leerConfig(f, { entorno: { TALAIA_RECEIVER: "usb", TALAIA_WEB_PORT: "4405", TALAIA_DATA: "/data", TALAIA_BROKER: "mosquitto", TALAIA_RETENTION_DAYS: "30", TALAIA_LOG_LEVEL: "debug" } });
  assert.deepEqual(c.receptor, { tipo: "usb", puerto: "auto" });
  assert.deepEqual(c.web, { puerto: 4405, escuchar: "127.0.0.1" });
  assert.deepEqual([c.datos, c.retencionDias, c.registro], ["/data", 30, "depurar"]);
  assert.deepEqual(c.mosquitto, { puerto: 1883, host: "mosquitto" });
  // Without a file, from the environment only.
  const sin = path.join(dir, "no-hay.json");
  assert.deepEqual(leerConfig(sin, { entorno: { TALAIA_RECEIVER: "tcp:192.168.1.60" } }).receptor, { tipo: "tcp", puerto: 4403, host: "192.168.1.60" });
  assert.deepEqual(leerConfig(sin, { entorno: { TALAIA_RECEIVER: "tcp:[fe80::1]:4500" } }).receptor, { tipo: "tcp", puerto: 4500, host: "fe80::1" });
  assert.deepEqual(leerConfig(sin, { entorno: { TALAIA_RECEIVER: "usb:239a:8029" } }).receptor, { tipo: "usb", puerto: "239a:8029" });
  assert.deepEqual(leerConfig(sin, { entorno: { TALAIA_RECEIVER: "usb:/dev/ttyACM0" } }).receptor, { tipo: "usb", puerto: "/dev/ttyACM0" });
  assert.deepEqual(leerConfig(sin, { entorno: { TALAIA_BROKER: "broker.casa:1884" } }).mosquitto, { puerto: 1884, host: "broker.casa" });
  assert.equal(leerConfig(f, { entorno: { TALAIA_BROKER: "off" } }).mosquitto, null);
  assert.deepEqual(desdeEntorno({ TALAIA_RECEIVER: " ", OTRA: "x" }), {});
  // Clear errors, naming the variable.
  assert.throws(() => desdeEntorno({ TALAIA_RECEIVER: "bluetooth" }), /TALAIA_RECEIVER tiene que ser/);
  assert.throws(() => desdeEntorno({ TALAIA_RECEIVER: "tcp:" }), /TALAIA_RECEIVER: falta el nombre/);
  assert.throws(() => desdeEntorno({ TALAIA_WEB_PORT: "80a" }), /TALAIA_WEB_PORT tiene que ser un número/);
  assert.throws(() => desdeEntorno({ TALAIA_LOG_LEVEL: "loud" }), /TALAIA_LOG_LEVEL/);
  assert.throws(() => leerConfig(sin, { entorno: { TALAIA_WEB_PORT: "99999" } }), /web.puerto/);
});

test("fallos: qué decir según el caso", () => {
  assert.equal(clasificar(new LinkError("open", Object.assign(new Error("Error: Permission denied, cannot open /dev/ttyACM0"), { code: "EACCES" })), "serial"), "permiso");
  assert.equal(clasificar(new LinkError("open", new Error("Error Resource temporarily unavailable Cannot lock port")), "serial"), "busy");
  assert.equal(clasificar(new LinkError("open", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), "tcp"), "red");
  assert.equal(clasificar(new LinkError("unplugged", null, "no hay ningún nodo enchufado"), "serial"), "unplugged");
  assert.equal(clasificar(new LinkError("config", null, "el nodo dejó de mandar datos"), "serial"), "noapi");
});

test("configuración: las claves también en inglés; los errores, en el idioma del servidor", () => {
  const c = comprobar({ receiver: { type: "tcp", host: "192.168.1.60", port: 4500 }, web: { port: 4405, listen: "127.0.0.1" }, data: "/srv/talaia", retentionDays: 30, logLevel: "debug", broker: { port: 1884 } });
  assert.deepEqual(c.receptor, { tipo: "tcp", puerto: 4500, host: "192.168.1.60" });
  assert.deepEqual(c.web, { puerto: 4405, escuchar: "127.0.0.1" });
  assert.deepEqual([c.datos, c.retencionDias, c.registro], ["/srv/talaia", 30, "depurar"]);
  assert.deepEqual(c.mosquitto, { puerto: 1884, host: "127.0.0.1" });
  // The Spanish key wins if both are there.
  assert.equal(comprobar({ datos: "/a", data: "/b" }).datos, "/a");
  setLanguage("en");
  try {
    assert.throws(() => comprobar({ receiver: { type: "tcp" } }), /the TCP receiver needs a “host”/);
    assert.throws(() => desdeEntorno({ TALAIA_WEB_PORT: "x" }), /TALAIA_WEB_PORT has to be a number/);
  } finally {
    setLanguage("es");
  }
});

test("idioma de la terminal: por LANG (es también para ca, eu y gl), nada si no dice ninguno", () => {
  assert.equal(idiomaDelEntorno({ LANG: "es_ES.UTF-8" }), "es");
  assert.equal(idiomaDelEntorno({ LANG: "ca_ES.UTF-8" }), "es");
  assert.equal(idiomaDelEntorno({ LANG: "en_GB.UTF-8" }), "en");
  assert.equal(idiomaDelEntorno({ LANG: "de_DE.UTF-8" }), "en");
  assert.equal(idiomaDelEntorno({ LANG: "es_ES.UTF-8", LC_ALL: "en_US.UTF-8" }), "en");
  assert.equal(idiomaDelEntorno({ LANG: "estonian" }), "en"); // not «es»
  assert.equal(idiomaDelEntorno({ LANG: "C.UTF-8" }), null);
  assert.equal(idiomaDelEntorno({ LANG: "POSIX" }), null);
  assert.equal(idiomaDelEntorno({}), null);
});

test("almacén: leer un valor sin abrirlo para escribir", () => {
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "alm-")), "talaia.db");
  assert.equal(leerGuardado(ruta, "settings"), null);
  assert.equal(fs.existsSync(ruta), false, "no file is made");
  const a = abrirAlmacen(ruta);
  a.guardar("settings", { language: "en" });
  assert.deepEqual(leerGuardado(ruta, "settings"), { language: "en" });
  assert.equal(leerGuardado(ruta, "otra"), null);
  a.cerrar();
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

test("the database of before 2.0 (vigia.db): the terminal uses it as it is; the service renames it, journal included", () => {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-"));
  assert.equal(rutaAlmacen(datos), path.join(datos, "talaia.db")); // nothing yet: the new name
  fs.writeFileSync(path.join(datos, "vigia.db"), "base");
  fs.writeFileSync(path.join(datos, "vigia.db-wal"), "diario");
  assert.equal(rutaAlmacen(datos), path.join(datos, "vigia.db"));
  assert.equal(rutaAlmacen(datos, { mover: true }), path.join(datos, "talaia.db"));
  assert.deepEqual(fs.readdirSync(datos).sort(), ["talaia.db", "talaia.db-wal"]);
  assert.equal(fs.readFileSync(path.join(datos, "talaia.db-wal"), "utf8"), "diario");
});
