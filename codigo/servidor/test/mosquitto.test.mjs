// El broker de este equipo: Vigía escribe los usuarios de Mosquitto (contraseñas cifradas como mosquitto_passwd) y se
// conecta a él con su usuario interno. Con un Mosquitto de verdad si está instalado (si no, solo las piezas).
// Lo que en el BMAX hace el servicio vigia-mosquitto.path (copiar el fichero y recargar Mosquitto), aquí lo hace la
// prueba: Mosquitto lee directamente el fichero de Vigía y se recarga con SIGHUP.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import mqtt from "mqtt";
import { cifrarClave, claveValida, comprobarUsuario, USUARIO_INTERNO } from "../src/mosquitto.js";
import { crearVigia } from "../src/vigia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { instantanea } from "../src/sincro.js";
import { NodoFalso, hasta } from "./nodo-falso.mjs";

const hay = (orden) => spawnSync("sh", ["-c", `command -v ${orden}`]).status === 0;
const MOSQUITTO = hay("mosquitto");

test("contraseñas cifradas como las de mosquitto_passwd; usuarios válidos", () => {
  const c = cifrarClave("Clave secreta ñ");
  assert.match(c, /^\$7\$101\$[A-Za-z0-9+/]{16}\$[A-Za-z0-9+/]{86}==$/);
  assert.ok(claveValida("Clave secreta ñ", c));
  assert.ok(!claveValida("otra", c));
  if (hay("mosquitto_passwd")) {
    // Una hecha por mosquitto_passwd se reconoce igual.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-pw-"));
    const f = path.join(dir, "pw");
    fs.writeFileSync(f, "", { mode: 0o600 });
    spawnSync("mosquitto_passwd", ["-b", f, "shelly", "Clave secreta ñ"]);
    const linea = fs.readFileSync(f, "utf8").trim();
    assert.ok(claveValida("Clave secreta ñ", linea.split(":").slice(1).join(":")));
  }
  assert.equal(comprobarUsuario("shelly_salon", "12345678"), null);
  assert.match(comprobarUsuario("con espacio", "12345678"), /solo puede llevar/);
  assert.match(comprobarUsuario(USUARIO_INTERNO, "12345678"), /es el usuario de Vigía/);
  assert.match(comprobarUsuario("shelly", "corta"), /al menos 8/);
});

const puertoLibre = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
/** ¿Entra ese usuario? true, o el error. */
async function entra(puerto, usuario, clave) {
  try {
    const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { username: usuario, password: clave, reconnectPeriod: 0, connectTimeout: 3000 });
    await c.endAsync();
    return true;
  } catch (e) {
    return e.code ?? e.message;
  }
}

test("con un Mosquitto de verdad: Vigía entra con su usuario, y los usuarios se añaden, cambian y quitan", { skip: !MOSQUITTO && "no hay Mosquitto instalado" }, async (t) => {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-mq-"));
  const puerto = await puertoLibre();
  const nodo = new NodoFalso();
  const puertoNodo = await nodo.escucharTcp();
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, datos, mosquitto: { puerto } });
  const vigia = await crearVigia(config, crearRegistro({ nivel: "error", salida: [] }), { almacen: abrirAlmacen(":memory:") });
  vigia.arrancar(); // escribe los usuarios
  const fichero = path.join(datos, "mosquitto", "passwd");
  assert.match(fs.readFileSync(fichero, "utf8"), new RegExp(`^${USUARIO_INTERNO}:\\$7\\$`));
  assert.equal(fs.statSync(fichero).mode & 0o777, 0o600);
  // Mosquitto como en el BMAX: con usuario y contraseña, sin entrar sin ellos. (Como root en las pruebas, para que
  // pueda leer el fichero de Vigía sin el servicio que lo copia.)
  const conf = path.join(datos, "mosquitto.conf");
  fs.writeFileSync(conf, `listener ${puerto} 127.0.0.1\nallow_anonymous false\npassword_file ${fichero}\npersistence false\nuser ${os.userInfo().username}\n`);
  const mq = spawn("mosquitto", ["-c", conf], { stdio: "ignore" });
  const recargar = () => mq.kill("SIGHUP");
  t.after(async () => { await vigia.detener(); await nodo.cerrar(); mq.kill(); });

  const local = () => vigia.S.mqtt.brokers.find((b) => b.id === "local");
  assert.equal(local().nombre, "Este servidor");
  await hasta(() => local().estado.fase === "conectada", 15000, "Vigía conectado a su broker");
  assert.notEqual(await entra(puerto, null, null), true, "sin usuario no se entra");

  // Un usuario para un Shelly.
  assert.match(vigia.mqtt.ponerUsuario("shelly", "corta").error, /al menos 8/);
  assert.equal(vigia.mqtt.ponerUsuario("shelly", "clave-del-shelly").ok, true);
  recargar();
  await hasta(async () => (await entra(puerto, "shelly", "clave-del-shelly")) === true, 5000, "entra el Shelly");
  assert.notEqual(await entra(puerto, "shelly", "otra-clave-mala"), true);
  // Cambiar la contraseña: la vieja ya no vale.
  assert.match(vigia.mqtt.ponerUsuario("shelly", "clave-nueva-1").toast, /Contraseña de «shelly» cambiada/);
  recargar();
  await hasta(async () => (await entra(puerto, "shelly", "clave-nueva-1")) === true, 5000, "entra con la nueva");
  assert.notEqual(await entra(puerto, "shelly", "clave-del-shelly"), true);
  // Lo que ven las pantallas: los usuarios, sin contraseñas ni cifrados.
  assert.deepEqual(vigia.S.mqtt.local.usuarios, [{ nombre: "shelly" }]);
  assert.equal(vigia.S.mqtt.local.puerto, puerto);
  const foto = JSON.stringify(instantanea(vigia.S));
  assert.doesNotMatch(foto, /\$7\$|clave-nueva/);
  assert.ok(!foto.includes(vigia.mqtt.brokers().find((b) => b.id === "local").clave), "la contraseña interna no sale");

  // Home Assistant en el broker de este equipo: «online» lo ve quien entra.
  assert.equal((await vigia.mqtt.configurarHA({ activado: true, broker: "local" })).ok, true);
  const espia = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { username: "shelly", password: "clave-nueva-1" });
  const visto = new Map();
  espia.on("message", (tema, c) => visto.set(tema, c.toString()));
  await espia.subscribeAsync("vigia/#");
  await hasta(() => visto.get("vigia/estado") === "online", 15000, "online en el broker local");
  await espia.endAsync();
  assert.match((await vigia.mqtt.quitarBroker("local")).error, /no se puede quitar/);

  // Quitar el usuario: ya no entra.
  assert.equal(vigia.mqtt.quitarUsuario("shelly").ok, true);
  recargar();
  await hasta(async () => (await entra(puerto, "shelly", "clave-nueva-1")) !== true, 5000, "ya no entra");
  // Vigía sigue dentro.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(local().estado.fase, "conectada");
});
