// The Docker image, end to end with docker/compose.yaml (Talaia + its Mosquitto) and a simulated node over TCP:
// health check, receiver ready, the first user with the code from `talaia --codigo`, a broker user made from the API
// that lets a «Shelly» in (and the wrong password, not), who owns what, the time zone, and that everything stays after
// restarting both. Runs in CI; by hand: npm ci, docker build -t talaia-hub:prueba ., then
//   node codigo/herramientas/docker-prueba.mjs talaia-hub:prueba
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import mqtt from "mqtt";
import { NodoFalso } from "../servidor/test/nodo-falso.mjs";

const IMAGEN = process.argv[2] || "talaia-hub:prueba";
const RAIZ = path.resolve(new URL("../..", import.meta.url).pathname);
const WEB = "http://127.0.0.1:4404";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const nodo = new NodoFalso();
const puertoNodo = await nodo.escucharTcp("0.0.0.0");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-docker-"));
const encima = path.join(dir, "prueba.yaml");
// The compose as it's published, with this image, the node over the network instead of USB.
fs.writeFileSync(encima, `services:
  talaia:
    image: ${IMAGEN}
    devices: !reset []
    extra_hosts: ["host.docker.internal:host-gateway"]
    environment:
      TALAIA_RECEIVER: tcp:host.docker.internal:${puertoNodo}
`);
const compose = (...a) => execFileSync("docker", ["compose", "-p", "talaia-prueba", "-f", path.join(RAIZ, "docker/compose.yaml"), "-f", encima, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const enTalaia = (...a) => compose("exec", "-T", "talaia", ...a).trim();

let fallos = 0;
async function paso(nombre, f) {
  try { await f(); log(`✓ ${nombre}`); } catch (e) { fallos++; log(`✗ ${nombre}\n  ${e.stack || e}`); }
}
async function hasta(cond, ms, que) {
  const fin = Date.now() + ms;
  for (;;) {
    try { if (await cond()) return; } catch { /* not yet */ }
    if (Date.now() > fin) throw new Error(`no se cumplió: ${que}`);
    await sleep(500);
  }
}
function igual(a, b, que) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${que}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }
async function entra(usuario, clave) {
  try {
    const c = await mqtt.connectAsync("mqtt://127.0.0.1:1883", { username: usuario, password: clave, reconnectPeriod: 0, connectTimeout: 4000 });
    await c.endAsync();
    return true;
  } catch {
    return false;
  }
}

let galleta = "";
const api = async (ruta, cuerpo) => {
  const r = await fetch(`${WEB}${ruta}`, cuerpo ? { method: "POST", headers: { "content-type": "application/json", cookie: galleta }, body: JSON.stringify(cuerpo) } : { headers: { cookie: galleta } });
  return { status: r.status, headers: r.headers, j: await r.json().catch(() => null) };
};

try {
  await paso("arranca con compose: Talaia sana y su Mosquitto en marcha", async () => {
    compose("up", "-d", "--wait", "--wait-timeout", "180");
    igual(JSON.parse(compose("ps", "--format", "json", "talaia").split("\n")[0]).Health, "healthy", "salud");
  });
  await paso("el receptor por TCP, listo; la versión, la del programa", async () => {
    await hasta(async () => (await api("/api/salud")).j?.receptor === "ready", 60000, "receptor listo");
    const version = JSON.parse(fs.readFileSync(path.join(RAIZ, "codigo/servidor/package.json"), "utf8")).version;
    if (!enTalaia("talaia", "--version").includes(version)) throw new Error("versión");
  });
  await paso("la pantalla dice los comandos de Docker y el primer usuario se crea con el código de `talaia --codigo`", async () => {
    igual((await api("/api/sesion")).j, { ok: false, primero: true, docker: true }, "sesión");
    const codigo = /: (\S+)$/.exec(enTalaia("talaia", "--codigo"))?.[1];
    if (!codigo) throw new Error("sin código");
    const r = await api("/api/primero", { codigo, nombre: "Prueba", clave: "clave-de-prueba-1" });
    igual(r.status, 200, "primero");
    galleta = String(r.headers.get("set-cookie")).split(";")[0];
    igual((await api("/api/sesion")).j.nombre, "Prueba", "con sesión");
  });
  const local = async () => (await api("/api/estado")).j.mqtt;
  await paso("Talaia entra en su Mosquitto y un usuario creado desde la API deja entrar a un Shelly", async () => {
    await hasta(async () => (await local()).brokers.find((b) => b.id === "local").estado.fase === "conectada", 60000, "conectada al broker");
    igual((await local()).local.direcciones, [], "en Docker no dice sus IP de dentro");
    igual((await api("/api/orden", { orden: "usuarioBroker", nombre: "shelly", clave: "clave-del-shelly" })).j.ok, true, "usuario creado");
    igual((await local()).local.usuarios, [{ nombre: "shelly" }], "lista");
    if (!(await entra("shelly", "clave-del-shelly"))) throw new Error("el Shelly no entra");
    if (await entra("shelly", "otra-clave-mala")) throw new Error("entra con la contraseña mal");
    if (await entra(undefined, undefined)) throw new Error("entra sin usuario");
  });
  await paso("cada cosa es de quien debe: Talaia como 4404, sus datos suyos; los del broker, de Mosquitto (1883)", async () => {
    igual(enTalaia("sh", "-c", "grep -E '^(Uid|Gid):' /proc/1/status | awk '{print $2}'").split("\n"), ["4404", "4404"], "proceso");
    igual(enTalaia("stat", "-c", "%u:%g %a", "/data"), "4404:4404 750", "carpeta de datos");
    igual(enTalaia("stat", "-c", "%u:%g", "/data/talaia.db"), "4404:4404", "base de datos");
    igual(enTalaia("stat", "-c", "%u:%g %a", "/broker/talaia-dynamic-security.json"), "1883:1883 600", "usuarios del broker");
    if (enTalaia("ls", "-A", "/broker").includes(".inicial")) throw new Error("se quedó el temporal");
  });
  await paso("la hora, la de TZ (Europe/Madrid)", async () => {
    igual(enTalaia("node", "-e", "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone, new Date().getTimezoneOffset() !== 0)"), "Europe/Madrid true", "zona");
  });
  await paso("al reiniciar los dos, todo sigue: sesión, usuario del broker y el Shelly entra", async () => {
    const antes = enTalaia("sha256sum", "/broker/mosquitto.conf");
    compose("restart");
    compose("up", "-d", "--wait", "--wait-timeout", "180");
    await hasta(async () => (await local()).brokers.find((b) => b.id === "local").estado.fase === "conectada", 60000, "conectada otra vez");
    igual((await local()).local.usuarios, [{ nombre: "shelly" }], "lista");
    if (!(await entra("shelly", "clave-del-shelly"))) throw new Error("el Shelly no entra tras reiniciar");
    igual(enTalaia("sha256sum", "/broker/mosquitto.conf"), antes, "la configuración de Mosquitto");
  });
  await paso("en el diario: nada de «no deja gestionar sus usuarios» ni errores", async () => {
    const diario = compose("logs", "--no-color", "talaia");
    if (/no deja gestionar| ERROR: |Excepción/.test(diario)) throw new Error(diario);
  });
} finally {
  if (fallos) {
    try { log(compose("logs", "--no-color")); } catch { /* nothing more to show */ }
  }
  try { compose("down", "-v"); } catch (e) { log(`down: ${e.message}`); }
  await nodo.cerrar();
}
log(fallos ? `\n${fallos} fallos` : "\n0 fallos");
process.exit(fallos ? 1 : 0);
