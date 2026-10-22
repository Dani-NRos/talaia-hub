// De punta a punta: nodo simulado por TCP ← servidor real (main.js) ← dos pantallas de Chrome.
// Uso: npm run build && node herramientas/pantalla-servidor.mjs <carpeta de salida> [IP]
// Con la IP de la máquina (no 127.0.0.1), el navegador la trata como en la red de casa: sin https.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""); // codigo/
// Playwright no va en el repo: el que haya instalado (PLAYWRIGHT_DIR = carpeta node_modules que lo contiene).
const PW_DIR = process.env.PLAYWRIGHT_DIR || "/opt/npm-tools/node_modules/";
const pw = createRequire(PW_DIR)("playwright");
const { NodoFalso, ME, CASETA, VECINO, PORT } = await import(`${REPO}/servidor/test/nodo-falso.mjs`);
const req = createRequire(`${REPO}/servidor/`);
const { create, toBinary, fromBinary } = req("@bufbuild/protobuf");
const { Protobuf } = await import(`${REPO}/node_modules/@meshtastic/core/dist/mod.js`);
const M = Protobuf.Mesh, TEL = Protobuf.Telemetry;
const { pathToFileURL } = await import("node:url");
const { Aedes } = await import(pathToFileURL(req.resolve("aedes")).href);
const mqttLib = (await import(pathToFileURL(req.resolve("mqtt")).href)).default;
const net = await import("node:net");

const out = process.argv[2] || "salida";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const nodo = new NodoFalso();
const tcp = await nodo.escucharTcp();
const datos = fs.mkdtempSync(path.join(os.tmpdir(), "vigia-"));
const WEB = 40000 + Math.floor(Math.random() * 9000);
const cfgFile = path.join(datos, "servidor.json");
// El broker de este equipo: un Mosquitto de verdad (hace falta tenerlo instalado), como el que pone el instalador.
const MQ_LOCAL = 41000 + Math.floor(Math.random() * 9000);
fs.writeFileSync(cfgFile, JSON.stringify({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: tcp }, web: { puerto: WEB }, datos, registro: "info", mosquitto: { puerto: MQ_LOCAL } }));
let serverLog = "";
function arrancarServidor() {
  const p = spawn(process.execPath, [`${REPO}/servidor/src/main.js`, "--config", cfgFile], { env: { ...process.env, TZ: "Europe/Madrid" } });
  p.stdout.on("data", (d) => { serverLog += d; });
  p.stderr.on("data", (d) => { serverLog += d; });
  return p;
}
let srv = arrancarServidor();
const URL0 = `http://${process.argv[3] || "127.0.0.1"}:${WEB}/`;
for (let i = 0; i < 100; i++) { try { const r = await fetch(`${URL0}api/salud`); if ((await r.json()).receptor === "ready") break; } catch { /* aún no */ } await sleep(100); }
log("salud:", await (await fetch(`${URL0}api/salud`)).text());
// Mosquitto lee los usuarios que escribe Vigía; en el BMAX los copia y lo recarga vigia-mosquitto.path, aquí esto.
const PASSWD = path.join(datos, "mosquitto", "passwd");
for (let i = 0; i < 50 && !fs.existsSync(PASSWD); i++) await sleep(100);
fs.writeFileSync(path.join(datos, "mosquitto.conf"), `listener ${MQ_LOCAL} 127.0.0.1\nallow_anonymous false\npassword_file ${PASSWD}\npersistence false\nuser ${os.userInfo().username}\n`);
const mosquitto = spawn("mosquitto", ["-c", path.join(datos, "mosquitto.conf")], { stdio: "ignore" });
mosquitto.on("error", () => { console.error("Hace falta Mosquitto instalado (apt install mosquitto)."); process.exit(1); });
fs.watchFile(PASSWD, { interval: 200 }, () => mosquitto.kill("SIGHUP"));

const browser = await pw.chromium.launch();
const errores = [];
async function pantalla(nombre, viewport) {
  const ctx = await browser.newContext({ viewport, locale: "es-ES", timezoneId: "Europe/Madrid" });
  await ctx.route(/openstreetmap\.org|fonts\.googleapis|fonts\.gstatic/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errores.push(`[${nombre}] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errores.push(`[${nombre}] consola: ${m.text()}`); });
  await page.goto(URL0);
  return page;
}
let n = 0;
async function foto(page, nombre) {
  await sleep(400);
  const f = path.join(out, `${String(++n).padStart(2, "0")}-${nombre}`);
  await page.screenshot({ path: `${f}.png`, fullPage: true });
  const txt = await page.evaluate(() => `${document.body.innerText}\n${[...document.querySelectorAll("dialog[open]")].map((d) => `## dialog#${d.id}\n${d.innerText}`).join("\n")}`);
  fs.writeFileSync(`${f}.txt`, txt);
  return txt;
}
// Lo visible, más el estado del servidor de la barra de arriba (en el móvil se ve abreviado).
const texto = (page) => page.evaluate(() => `${document.body.innerText}\n${document.querySelector("#linkBtn")?.getAttribute("aria-label") || ""}`);
/** Goes to a section of the screen (#/dashboard, #/nodes, #/settings…): only the one showing is read. */
const ir = async (page, view) => { await page.evaluate((v) => { location.hash = `#/${v}`; }, view); await sleep(300); };
async function esperarTexto(page, re, que, ms = 8000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (re.test(await texto(page))) return; await sleep(100); }
  throw new Error(`no apareció en pantalla: ${que}`);
}
const paso = async (que, f) => {
  try { await f(); log(`✓ ${que}`); } catch (e) {
    log(`✗ ${que}: ${e.message}`);
    errores.push(`${que}: ${e.message}`);
    for (const [nombre, page] of [["pc", pc], ["movil", movil]]) await foto(page, `fallo-${nombre}`).catch(() => {}); // cómo estaba cada pantalla
  }
};

const movil = await pantalla("móvil", { width: 400, height: 860 });
const pc = await pantalla("pc", { width: 1200, height: 900 });

await paso("las dos pantallas ven el receptor conectado", async () => {
  await esperarTexto(movil, /DNN5 conectado/, "DNN5 conectado (móvil)");
  await esperarTexto(pc, /DNN5 conectado/, "DNN5 conectado (pc)");
});
await foto(movil, "movil-inicio");

await paso("vigilar un nodo desde el PC aparece en el móvil", async () => {
  await ir(pc, "nodes");
  await pc.click(`[data-watch="${CASETA}"]`);
  await ir(pc, "dashboard");
  await esperarTexto(movil, /Paneles[\s\S]*Caseta huerto/i, "Caseta vigilada en el móvil");
});

await paso("límite de temperatura desde el móvil", async () => {
  // Hace falta que la caseta tenga temperatura para que salga su fila de límites: llega una lectura normal.
  nodo.ambiente(CASETA, { temperature: 24.5, relativeHumidity: 60 });
  await esperarTexto(movil, /24,5/, "lectura 24,5 en el móvil");
  await movil.click(`.card[data-open="${CASETA}"] .name-btn`);
  await sleep(500);
  const inp = movil.locator('#detail input[data-rule="temperature"][data-side="max"]');
  await inp.fill("30");
  await inp.press("Enter");
  await sleep(300);
  await movil.keyboard.press("Escape");
  await sleep(500);
  const cfg = (await (await fetch(`${URL0}api/estado`)).json()).cfg;
  if (cfg.watched[CASETA]?.rules?.temperature?.max !== 30) throw new Error(`cfg: ${JSON.stringify(cfg.watched[CASETA])}`);
});

await paso("alarma: salta en las dos pantallas", async () => {
  nodo.ambiente(CASETA, { temperature: 31.4, relativeHumidity: 61 });
  await esperarTexto(movil, /Temperatura por encima de 30/, "alarma en el móvil");
  await esperarTexto(pc, /Temperatura por encima de 30/, "alarma en el PC");
});
await foto(movil, "movil-alarma");

await paso("Enterado en el PC queda visto en el móvil", async () => {
  const btn = pc.locator("#board [data-ack]").first();
  log("   botón:", await btn.getAttribute("data-ack"), await btn.isVisible());
  const r = pc.waitForResponse((x) => x.url().includes("api/orden"));
  await btn.click();
  const resp = await r;
  log("   respuesta:", resp.status(), await resp.text());
  await sleep(600);
  log("   en el servidor:", JSON.stringify((await (await fetch(`${URL0}api/estado`)).json()).active.map((a) => [a.key, a.acked])));
  await esperarTexto(movil, /alarma vista, sigue activa/i, "Visto en el móvil");
});

await paso("pedir ambiente desde el móvil: acuse del nodo y respuesta", async () => {
  await movil.click(`.card[data-open="${CASETA}"] .name-btn`);
  await sleep(400);
  const antes = nodo.paquetes(PORT.TELEMETRY_APP).length;
  await movil.click(`#detail [data-ask="env"][data-num="${CASETA}"]`);
  await nodo.esperar(() => nodo.paquetes(PORT.TELEMETRY_APP).length > antes, 5000, "petición de telemetría");
  const q = nodo.paquetes(PORT.TELEMETRY_APP).at(-1);
  const rout = toBinary(M.RoutingSchema, create(M.RoutingSchema, { variant: { case: "errorReason", value: 0 } }));
  nodo.paquete({ from: VECINO, payloadVariant: { case: "decoded", value: create(M.DataSchema, { portnum: PORT.ROUTING_APP, payload: rout, requestId: q.id }) } });
  await sleep(300);
  nodo.paquete({ from: CASETA, payloadVariant: { case: "decoded", value: create(M.DataSchema, { portnum: PORT.ROUTING_APP, payload: rout, requestId: q.id }) } });
  await esperarTexto(movil, /la petición llegó, esperando respuesta/, "acuse del nodo en el móvil");
  const tel = create(TEL.TelemetrySchema, { variant: { case: "environmentMetrics", value: create(TEL.EnvironmentMetricsSchema, { temperature: 29.2, relativeHumidity: 63 }) } });
  nodo.paquete({ from: CASETA, payloadVariant: { case: "decoded", value: create(M.DataSchema, { portnum: PORT.TELEMETRY_APP, payload: toBinary(TEL.TelemetrySchema, tel), requestId: q.id }) } });
  await esperarTexto(movil, /Ambiente: recibido a las/, "respuesta en el móvil");
  await ir(pc, "alarms");
  await esperarTexto(pc, /de vuelta en rango/, "alarma resuelta en el PC (registro)");
  await ir(pc, "dashboard");
});
await foto(movil, "movil-peticion");
await movil.keyboard.press("Escape");

await paso("avisos por la malla desde el servidor: canal privado", async () => {
  await ir(pc, "settings/mesh");
  await pc.check("#meshOn", { force: true });
  await sleep(300);
  await pc.selectOption("#meshCh", "1");
  await sleep(300);
  await pc.check("#meshClear", { force: true });
  await sleep(300);
  await ir(pc, "dashboard");
  const antes = nodo.paquetes(PORT.TEXT_MESSAGE_APP).length;
  nodo.ambiente(CASETA, { temperature: 33, relativeHumidity: 60 });
  await nodo.esperar(() => nodo.paquetes(PORT.TEXT_MESSAGE_APP).length > antes, 6000, "aviso por la malla");
  const p = nodo.paquetes(PORT.TEXT_MESSAGE_APP).at(-1);
  log("   aviso:", p.to.toString(16), "canal", p.channel, JSON.stringify(new TextDecoder().decode(p.payloadVariant.value.payload)));
  const rout = toBinary(M.RoutingSchema, create(M.RoutingSchema, { variant: { case: "errorReason", value: 0 } }));
  nodo.paquete({ from: ME, payloadVariant: { case: "decoded", value: create(M.DataSchema, { portnum: PORT.ROUTING_APP, payload: rout, requestId: p.id }) } });
  await sleep(800);
  await ir(movil, "settings/mesh");
  await esperarTexto(movil, /Último: «⚠ Vigía: Caseta huerto · Temperatura 33,0 °C[\s\S]*repetido por la malla/, "último aviso en ajustes del móvil");
});
await foto(movil, "movil-ajustes");
await ir(movil, "dashboard");

// Broker MQTT con usuario y contraseña, y un «Home Assistant» que mira lo que se publica y pulsa botones.
const broker = await Aedes.createBroker();
broker.authenticate = (c, u, p, cb) => cb(null, u === "vigia" && p?.toString() === "clave-secreta");
const srvMqtt = net.createServer(broker.handle);
await new Promise((r) => srvMqtt.listen(0, "127.0.0.1", r));
const MQTT_PUERTO = srvMqtt.address().port;
const ha = await mqttLib.connectAsync(`mqtt://127.0.0.1:${MQTT_PUERTO}`, { username: "vigia", password: "clave-secreta" });
const visto = new Map();
const estados = []; // lo que va pasando por vigia/estado (online / offline)
ha.on("message", (t, c) => { visto.set(t, c.toString()); if (t === "vigia/estado") estados.push(c.toString()); });
await ha.subscribeAsync("#");
const ID = CASETA.toString(16).padStart(8, "0");
const esperarMqtt = async (f, que, ms = 8000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (f()) return; await sleep(100); } throw new Error(`MQTT no vio: ${que}`); };

/** Foto de un apartado de Ajustes entero: la ventana, alta para que quepa (Ajustes tiene su propio desplazamiento). */
async function fotoApartado(page, sel, nombre) {
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.width, height: 4000 });
  await sleep(300);
  await page.locator(sel).screenshot({ path: path.join(out, `${nombre}.png`) });
  await page.setViewportSize(vp);
}

await paso("MQTT desde Ajustes: añadir el broker de Home Assistant (con contraseña mal y bien) y publicar en él", async () => {
  await ir(pc, "settings/mqtt");
  await esperarTexto(pc, /Este servidor[\s\S]*Conectado desde las/, "el broker de este servidor, conectado");
  await pc.locator("#mqttBox").screenshot({ path: path.join(out, "mqtt-inicio.png") });
  await pc.click("[data-brk-nuevo]");
  await pc.fill("#brkNombre", "Home Assistant");
  await pc.fill("#brkUrl", `127.0.0.1:${MQTT_PUERTO}`);
  await pc.fill("#brkUser", "vigia");
  await pc.fill("#brkPass", "otra");
  await pc.click("[data-brk-save]");
  await esperarTexto(pc, /Home Assistant[\s\S]*No se puede conectar: usuario o contraseña incorrectos/, "error de contraseña en Ajustes");
  await pc.locator("#mqttBox").screenshot({ path: path.join(out, "mqtt-error.png") });
  await pc.click('[data-brk-edit="b1"]');
  if ((await pc.inputValue("#brkUser")) !== "vigia" || (await pc.inputValue("#brkPass")) !== "") throw new Error("el editor no trae el usuario o trae la contraseña");
  await pc.fill("#brkPass", "clave-secreta");
  await pc.click("[data-brk-save]");
  await esperarTexto(pc, /Home Assistant[\s\S]*Conectado desde las/, "Home Assistant conectado");
  // Publicar para Home Assistant en ese broker.
  await pc.check("#haOn", { force: true });
  await pc.selectOption("#haBroker", "b1");
  await pc.click("[data-ha-save]");
  await esperarMqtt(() => visto.get("vigia/estado") === "online", "online");
  await esperarMqtt(() => visto.get(`homeassistant/sensor/vigia_${ID}/temperature/config`), "sensor de temperatura");
  const cfg = JSON.parse(visto.get(`homeassistant/sensor/vigia_${ID}/temperature/config`));
  if (cfg.device.name !== "Vigía · Caseta huerto") throw new Error(`nombre del dispositivo: ${cfg.device.name}`);
  if (/clave-secreta/.test(await (await fetch(`${URL0}api/estado`)).text())) throw new Error("la contraseña sale en /api/estado");
});

await paso("broker de este servidor: un usuario creado desde Ajustes deja entrar a un Shelly; la contraseña mal, no", async () => {
  await pc.fill("#usrNombre", "shelly");
  await pc.fill("#usrClave", "corta");
  await pc.click("[data-usr-save]");
  await esperarTexto(pc, /al menos 8 caracteres/, "contraseña corta rechazada");
  await pc.fill("#usrClave", "clave-del-shelly");
  await pc.click("[data-usr-save]");
  await esperarTexto(pc, /Usuarios de este broker[\s\S]*shelly[\s\S]*Quitar/, "usuario en la lista");
  let shelly = null;
  for (let i = 0; i < 30 && !shelly; i++) {
    shelly = await mqttLib.connectAsync(`mqtt://127.0.0.1:${MQ_LOCAL}`, { username: "shelly", password: "clave-del-shelly", reconnectPeriod: 0 }).catch(() => null);
    if (!shelly) await sleep(200);
  }
  if (!shelly) throw new Error("el Shelly no entra en el broker de este servidor");
  await shelly.publishAsync("shellies/shellyht-1/sensor/humidity", "58", { retain: true });
  await shelly.endAsync();
  const mala = await mqttLib.connectAsync(`mqtt://127.0.0.1:${MQ_LOCAL}`, { username: "shelly", password: "otra-mala-1", reconnectPeriod: 0 }).catch(() => null);
  if (mala) { await mala.endAsync(); throw new Error("entra con la contraseña mal"); }
  await fotoApartado(pc, "#mqttBox", "mqtt-pc");
});
await ir(pc, "dashboard");

await paso("el móvil ve los mismos brokers (sin contraseñas)", async () => {
  await ir(movil, "settings/mqtt");
  await esperarTexto(movil, /Home Assistant[\s\S]*Conectado desde las/, "Home Assistant en el móvil");
  await movil.click("#mqttBox summary:text('Usuarios de este broker')");
  await esperarTexto(movil, /Usuarios de este broker[\s\S]*shelly/, "el usuario en el móvil");
  await fotoApartado(movil, "#mqttBox", "mqtt-movil");
  await ir(movil, "dashboard");
});

await paso("Enterado desde Home Assistant queda visto en las pantallas", async () => {
  await esperarMqtt(() => JSON.parse(visto.get(`vigia/nodo/${ID}/estado`) || "{}").a?.temperature_alta === "ON", "alarma encendida en HA");
  await ha.publishAsync(`vigia/nodo/${ID}/enterado`, "temperature_alta");
  await esperarTexto(movil, /alarma vista, sigue activa/i, "vista en el móvil");
  await esperarMqtt(() => JSON.parse(visto.get(`vigia/nodo/${ID}/estado`) || "{}").d?.temperature_alta?.visto === true, "vista en HA");
  const act = (await (await fetch(`${URL0}api/estado`)).json()).active;
  if (!act.some((a) => a.acked)) throw new Error(`en el servidor: ${JSON.stringify(act.map((a) => [a.key, a.acked]))}`);
});

// La estación, en el panel del receptor: lo que Home Assistant publica con mqtt_statestream (los nombres largos de
// Meteoclimatic de Dani) sale a la malla como del receptor. La unidad del viento, con publish_attributes.
const MC = (x) => `ha_estados/sensor/meteoclimatic_weather_for_alzira_ajuntament_valencia_espva4600000046600b_alzira_ajuntament_valencia_${x}`;
for (const [x, v, u] of [["temperature", "19.6", "°C"], ["humidity", "64", "%"], ["pressure", "1014.8", "hPa"], ["wind_speed", "18", "km/h"], ["dew_point", "12.4", "°C"]]) {
  await ha.publishAsync(MC(`${x}/state`), v, { retain: true });
  await ha.publishAsync(MC(`${x}/unit_of_measurement`), JSON.stringify(u), { retain: true });
}
await ha.publishAsync("zigbee2mqtt/Salón", JSON.stringify({ temperature: 22.1, battery: 90 }), { retain: true });
await ha.publishAsync("tele/enchufe/SENSOR", JSON.stringify({ Time: "2026-10-21T10:00:00", ENERGY: { Total: 12.5, Power: 45, Voltage: 231 } }), { retain: true });
const fila = (page, i, k) => page.locator(`#datLista .est-d:nth-child(${i + 1}) [data-dat-k="${k}"]`);
const estado = async () => (await fetch(`${URL0}api/estado`)).json();
const usarEn = (page) => async (tema, campo = "") => {
  await page.locator(`#datHallados li:has(.est-ht[title="${campo ? `${tema} · ${campo}` : tema}"]) [data-dat-usar]`).click();
  await sleep(150);
};

await paso("datos MQTT en el panel del receptor: buscar, filtrar y «Usar»; dos temperaturas, solo una a la malla", async () => {
  await ir(pc, "nodes");
  await pc.click(`[data-watch="${ME}"]`);
  await ir(pc, "dashboard");
  await esperarTexto(pc, /Paneles[\s\S]*DNN5/i, "el receptor vigilado");
  await pc.click(`#cards .name-btn[data-open="${ME}"]`);
  await sleep(400);
  await fotoApartado(pc, "#datBox", "datos-vacio");
  await pc.click("[data-dat-buscar]");
  await esperarTexto(pc, /Encontrados \d+ con números/, "temas encontrados");
  await pc.fill("#filtroTemas", "meteoclimatic");
  await sleep(200);
  const n = await pc.locator("#datHallados li").count();
  if (n !== 5) throw new Error(`con el filtro salen ${n}, no 5`);
  await fotoApartado(pc, "#datBox", "datos-encontrados");
  const usar = usarEn(pc);
  await usar(MC("temperature/state"));
  // La humedad, la del Shelly, que publica en el broker de este servidor.
  await pc.fill("#filtroTemas", "shellies");
  await esperarTexto(pc, /humidity\s*58 · parece humedad · en Este servidor/, "el Shelly, en el broker de este servidor");
  await usar("shellies/shellyht-1/sensor/humidity");
  await pc.fill("#filtroTemas", "meteoclimatic");
  await sleep(150);
  for (const x of ["pressure", "wind_speed"]) await usar(MC(`${x}/state`));
  // Otra temperatura, la del salón (zigbee2mqtt): con su nombre, y no a la malla (ya hay una).
  await pc.fill("#filtroTemas", "Salón");
  await sleep(150);
  await usar("zigbee2mqtt/Salón", "temperature");
  await fila(pc, 4, "nombre").fill("Salón");
  const tipos = [], malla = [];
  for (let i = 0; i < 5; i++) { tipos.push(await fila(pc, i, "tipo").inputValue()); malla.push(await fila(pc, i, "malla").isChecked()); }
  if (tipos.join() !== "temperature,relativeHumidity,barometricPressure,windSpeed,temperature") throw new Error(`datos: ${tipos}`);
  if (malla.join() !== "true,true,true,true,false") throw new Error(`a la malla: ${malla}`);
  if ((await fila(pc, 3, "unidad").inputValue()) !== "km/h") throw new Error("el viento no quedó en km/h");
  if ((await fila(pc, 0, "tema").inputValue()) !== MC("temperature/state")) throw new Error("tema de la temperatura");
  if ((await fila(pc, 0, "broker").inputValue()) !== "b1" || (await fila(pc, 1, "broker").inputValue()) !== "local") throw new Error("brokers de los datos");
  // Marcar también la del salón: dos del mismo tipo a la malla no puede ser.
  await fila(pc, 4, "malla").check({ force: true });
  await pc.click("[data-dat-save]");
  await esperarTexto(pc, /dos datos de temperatura|una sola temperatura|Solo puede ir a la malla un/i, "error de dos temperaturas a la malla");
  await fila(pc, 4, "malla").uncheck({ force: true });
  await pc.click("[data-dat-save]");
  await esperarTexto(pc, /19,6 °C · ahora mismo/, "temperatura en la ficha");
  await esperarTexto(pc, /5,0 m\/s \(18,0 km\/h\)/, "viento convertido");
  await esperarTexto(pc, /22,1 °C · ahora mismo/, "la del salón");
  await pc.selectOption("#mallaCh", "1");
  await pc.check("#mallaOn", { force: true });
  await pc.click("[data-malla-save]");
  await esperarTexto(pc, /Próximo envío a las \d\d:\d\d: «Temperatura 19,6 °C · Humedad 58 % · Presión 1015 hPa · Viento 5,0 m\/s»/, "próximo envío");
  await fotoApartado(pc, "#datBox", "datos-receptor");
  await fotoApartado(pc, "#mallaBox", "malla-receptor");
  // En la tarjeta del receptor, como lecturas suyas (con su nombre la del salón).
  await pc.keyboard.press("Escape");
  await esperarTexto(pc, /DNN5[\s\S]*Salón\s*22,1/i, "la del salón en la tarjeta"); // las etiquetas, en mayúsculas
});

await paso("Enviar ahora: el nodo recibe la telemetría por el canal 1; las dos pantallas ven «repetido por la malla»", async () => {
  await pc.click(`#cards .name-btn[data-open="${ME}"]`);
  await sleep(300);
  const antes = nodo.paquetes(PORT.TELEMETRY_APP).length;
  await pc.click("[data-malla-send]");
  await nodo.esperar(() => nodo.paquetes(PORT.TELEMETRY_APP).length > antes, 5000, "telemetría de la estación");
  const p = nodo.paquetes(PORT.TELEMETRY_APP).at(-1);
  const tel = fromBinary(TEL.TelemetrySchema, p.payloadVariant.value.payload);
  const e = tel.variant.value;
  log("   telemetría:", p.channel, p.to.toString(16), JSON.stringify({ t: e.temperature, h: e.relativeHumidity, p: e.barometricPressure, v: e.windSpeed }));
  if (p.channel !== 1 || p.to !== 0xffffffff || Math.abs(e.temperature - 19.6) > 1e-3 || e.relativeHumidity !== 58 || Math.abs(e.windSpeed - 5) > 1e-3) throw new Error("paquete equivocado");
  const rout = toBinary(M.RoutingSchema, create(M.RoutingSchema, { variant: { case: "errorReason", value: 0 } }));
  nodo.paquete({ from: ME, payloadVariant: { case: "decoded", value: create(M.DataSchema, { portnum: PORT.ROUTING_APP, payload: rout, requestId: p.id }) } });
  await esperarTexto(pc, /Último \(a mano\), a las \d\d:\d\d: «Temperatura 19,6 °C[^»]*» → canal «avisos»: repetido por la malla/, "último envío en el PC");
  await movil.click(`#cards .name-btn[data-open="${ME}"]`);
  await esperarTexto(movil, /repetido por la malla\./, "último envío en el móvil");
  await fotoApartado(movil, "#mallaBox", "malla-movil");
  await movil.keyboard.press("Escape");
  await pc.keyboard.press("Escape");
  // Y son lecturas del receptor (con su clave de dato MQTT).
  const st = await estado();
  const d = st.paneles.paneles[ME].datos.find((x) => x.tipo === "temperature" && x.malla);
  const yo = st.nodes.find((x) => x.num === ME);
  if (yo?.metrics?.[d.clave]?.v !== 19.6) throw new Error(`receptor: ${JSON.stringify(yo?.metrics)}`);
});

await paso("renombrar un nodo desde el móvil: sale con su nombre nuevo en el PC y en Home Assistant", async () => {
  await movil.click(`#cards .name-btn[data-open="${CASETA}"]`);
  await sleep(300);
  await esperarTexto(movil, /Su nombre en Meshtastic es «Caseta huerto»/, "su nombre de Meshtastic");
  await movil.fill("#pnNombre", "Huerto");
  await movil.click("[data-pn-nombre]");
  await esperarTexto(movil, /Ahora se llama «Huerto»/, "aviso del nombre");
  await movil.keyboard.press("Escape");
  await esperarTexto(pc, /Paneles[\s\S]*Huerto/i, "el nombre nuevo en el PC");
  await esperarMqtt(() => JSON.parse(visto.get(`homeassistant/sensor/vigia_${ID}/temperature/config`) || "{}").device?.name === "Vigía · Huerto", "dispositivo renombrado en HA");
});

await paso("panel nuevo sin nodo (Tasmota): sus datos, una alarma y nada a Home Assistant", async () => {
  await pc.click("[data-panel-nuevo]");
  await pc.fill("#npNombre", "Enchufe del taller");
  await pc.selectOption("#npTipo", "tasmota");
  await pc.click("[data-panel-crear]");
  await esperarTexto(pc, /Enchufe del taller[\s\S]*Tasmota · datos por MQTT/, "su ficha");
  if (await pc.locator("#detail [data-ask-box]").count()) throw new Error("un panel sin nodo no pide datos por la malla");
  await pc.click("[data-dat-buscar]");
  await esperarTexto(pc, /Encontrados \d+ con números/, "temas encontrados");
  await pc.fill("#filtroTemas", "enchufe");
  await esperarTexto(pc, /Power\s*45 · parece potencia/, "la potencia del enchufe");
  const usar = usarEn(pc);
  await usar("tele/enchufe/SENSOR", "ENERGY.Power");
  await usar("tele/enchufe/SENSOR", "ENERGY.Total");
  if (await pc.locator("#datBox [data-dat-k=malla]").count()) throw new Error("solo el receptor manda a la malla");
  await pc.click("[data-dat-save]");
  await esperarTexto(pc, /45 W · ahora mismo/, "la potencia en la ficha");
  await fotoApartado(pc, "#detail .sheet-b", "panel-enchufe");
  // Límite de potencia: la alarma, con el nombre del panel.
  await pc.locator('#detail tr:has(th:text("Potencia")) [data-side="max"]').fill("40");
  await pc.keyboard.press("Tab");
  await esperarTexto(movil, /Enchufe del taller · Potencia por encima de 40 W/, "la alarma en el móvil");
  await pc.keyboard.press("Escape");
  await esperarTexto(movil, /Enchufe del taller[\s\S]*Potencia\s*45/i, "la tarjeta en el móvil");
  await foto(movil, "movil-paneles");
  const temas = [...visto.keys()];
  if (temas.some((t) => /mq\d/.test(t))) throw new Error(`a Home Assistant van datos MQTT: ${temas.filter((t) => /mq\d/.test(t))}`);
  if ([...visto.values()].some((c) => c.includes("Enchufe del taller"))) throw new Error("el panel sin nodo (o su alarma) ha ido a Home Assistant");
  const sv = JSON.parse(visto.get("vigia/servidor/estado"));
  if (sv.activas !== 1) throw new Error(`Home Assistant cuenta ${sv.activas} alarmas activas, no 1 (la del huerto)`);
});

await paso("estados ON/OFF y conexión en el panel del enchufe: «Usar», al revés, alarma «cuando: Apagado» y «Sin conexión»", async () => {
  await ha.publishAsync("stat/enchufe/POWER", "ON", { retain: true });
  await ha.publishAsync("tele/enchufe/LWT", "Online", { retain: true });
  await ha.publishAsync("zigbee2mqtt/Puerta taller", JSON.stringify({ contact: true, battery: 80 }), { retain: true });
  await pc.click("#cards .name-btn:text('Enchufe del taller')");
  await sleep(300);
  await pc.click("[data-dat-buscar]");
  await esperarTexto(pc, /Encontrados \d+ con números o estados/, "temas encontrados");
  await pc.fill("#filtroTemas", "enchufe");
  await esperarTexto(pc, /POWER\s*ON · parece un estado ON\/OFF/, "el estado del enchufe");
  await esperarTexto(pc, /LWT\s*Online · parece la conexión del dispositivo/, "su conexión");
  const usar = usarEn(pc);
  await usar("stat/enchufe/POWER");
  await pc.locator('#datHallados li:has(.est-ht[title="tele/enchufe/LWT"]) [data-con-usar]').click();
  await sleep(150);
  await pc.fill("#filtroTemas", "Puerta");
  await sleep(150);
  await usar("zigbee2mqtt/Puerta taller", "contact");
  if ((await fila(pc, 2, "tipo").inputValue()) !== "estado" || (await fila(pc, 3, "nombres").inputValue()) !== "abierta" || !(await fila(pc, 3, "invertir").isChecked())) throw new Error("los estados no quedaron bien");
  if ((await pc.inputValue('#conBox [data-con-k="tema"]')) !== "tele/enchufe/LWT") throw new Error("el tema de conexión");
  await pc.click("[data-dat-save]");
  await esperarTexto(pc, /Hay dos «Estado ON\/OFF»/, "nombres repetidos");
  await fila(pc, 2, "nombre").fill("Enchufe");
  await fila(pc, 3, "nombre").fill("Puerta");
  await pc.click("[data-dat-save]");
  await esperarTexto(pc, /Encendido · ahora mismo/, "el estado en la ficha");
  await esperarTexto(pc, /Cerrada · ahora mismo/, "la puerta, al revés");
  await esperarTexto(pc, /Conectado · ahora mismo/, "conectado");
  const st = await estado();
  const num = Number(Object.keys(st.paneles.paneles).find((k) => st.paneles.paneles[k].nombre === "Enchufe del taller"));
  const k = st.paneles.paneles[num].datos.find((d) => d.nombre === "Enchufe").clave;
  await fotoApartado(pc, "#datBox", "datos-estados");
  // Alarma cuando esté apagado, al momento.
  await pc.selectOption(`#detail [data-est-cuando="${k}"]`, "0");
  await esperarTexto(pc, /Avisará con «Apagado»/, "aviso guardado");
  await ha.publishAsync("stat/enchufe/POWER", "OFF", { retain: true });
  await esperarTexto(movil, /Enchufe del taller · Enchufe: Apagado/, "la alarma en el móvil");
  await fotoApartado(pc, "#detail .sheet-b", "panel-estados");
  await pc.locator("#chartList").scrollIntoViewIfNeeded();
  await sleep(600);
  await pc.locator("#chartList").screenshot({ path: path.join(out, "graficas-estados.png") });
  // El dispositivo se desconecta: lo dice su LWT.
  await ha.publishAsync("tele/enchufe/LWT", "Offline", { retain: true });
  await esperarTexto(movil, /Enchufe del taller · Sin conexión/, "sin conexión en el móvil");
  await esperarTexto(movil, /Enchufe del taller\s*desconectado ahora mismo/i, "en la tarjeta");
  await foto(movil, "movil-estados");
  await ha.publishAsync("tele/enchufe/LWT", "Online", { retain: true });
  await ha.publishAsync("stat/enchufe/POWER", "ON", { retain: true });
  await ir(movil, "alarms");
  await esperarTexto(movil, /Enchufe del taller · Conectado otra vez/, "conectado otra vez (registro)");
  await ir(movil, "dashboard");
  await pc.keyboard.press("Escape");
  // A Home Assistant no va nada del panel: solo el texto del último aviso por la malla, que es lo que salió por ella.
  const fugas = [...visto].filter(([tema, c]) => c.includes("Enchufe del taller") && tema !== "vigia/servidor/estado").map(([tema]) => tema);
  if (fugas.length) throw new Error(`el panel sin nodo (o su alarma) ha ido a Home Assistant: ${fugas}`);
  const sv = JSON.parse(visto.get("vigia/servidor/estado"));
  if (JSON.stringify({ ...sv, aviso: null }).includes("Enchufe del taller")) throw new Error("el panel sin nodo está en el estado del servidor");
});

await paso("encender y apagar un Shelly desde la tarjeta del móvil: propone el tema de las órdenes, espera a que conteste", async () => {
  // Un Shelly Plug de mentira en el broker de Home Assistant: contesta a on/off y a status_update con su estado.
  const shelly = await mqttLib.connectAsync(`mqtt://127.0.0.1:${MQTT_PUERTO}`, { username: "vigia", password: "clave-secreta" });
  let output = false;
  const recibidas = [];
  const publicaEstado = () => shelly.publishAsync("shellyplug01/status/switch:0", JSON.stringify({ id: 0, source: "button", output, apower: output ? 45 : 0 }));
  shelly.on("message", (tema, c) => {
    const m = c.toString();
    recibidas.push(`${tema} ${m}`);
    if (m === "on" || m === "off") output = m === "on";
    if (["on", "off", "status_update"].includes(m)) publicaEstado();
  });
  await shelly.subscribeAsync("shellyplug01/command/#");
  await pc.click("#cards .name-btn:text('Enchufe del taller')");
  await sleep(300);
  await pc.click("[data-dat-add]");
  const i = (await pc.locator("#datLista .est-d").count()) - 1;
  await fila(pc, i, "tipo").selectOption("estado");
  await fila(pc, i, "nombre").fill("Shelly");
  await fila(pc, i, "tema").fill("shellyplug01/status/switch:0");
  await fila(pc, i, "campo").fill("output");
  await fila(pc, i, "control").check({ force: true });
  if ((await fila(pc, i, "ordenTema").inputValue()) !== "shellyplug01/command/switch:0" || (await fila(pc, i, "ordenOn").inputValue()) !== "on") throw new Error("no propone el tema de las órdenes del Shelly");
  await fotoApartado(pc, "#datBox", "datos-orden");
  await pc.click("[data-dat-save]");
  // Al guardar, Vigía le pide el estado (solo información) y el Shelly contesta: Apagado.
  await esperarTexto(pc, /Apagado · ahora mismo/, "el estado pedido al guardar");
  if (!recibidas.includes("shellyplug01/command/switch:0 status_update") || output) throw new Error(`le ha mandado: ${recibidas}`);
  await pc.keyboard.press("Escape");
  const st = await estado();
  const num = Number(Object.keys(st.paneles.paneles).find((k) => st.paneles.paneles[k].nombre === "Enchufe del taller"));
  const k = st.paneles.paneles[num].datos.find((d) => d.nombre === "Shelly").clave;
  const sw = movil.locator(`#cards [data-orden="${k}"]`);
  await sw.waitFor();
  await sw.click();
  await esperarTexto(movil, /SHELLY\s*Encendido/i, "encendido en la tarjeta del móvil");
  if (!output) throw new Error("el Shelly no se ha encendido");
  await ir(pc, "alarms");
  await esperarTexto(pc, /Shelly: Encendido \(orden desde Vigía\)/, "en el registro del PC");
  await ir(pc, "dashboard");
  if ((await sw.getAttribute("aria-checked")) !== "true") throw new Error("el interruptor no está encendido");
  await foto(movil, "movil-interruptor");
  await sw.click();
  await esperarTexto(movil, /SHELLY\s*Apagado/i, "apagado en la tarjeta del móvil");
  if (output) throw new Error("el Shelly no se ha apagado");
  await shelly.endAsync();
});

await paso("gráfica: serie desde el servidor", async () => {
  const r = await (await fetch(`${URL0}api/serie?nodo=${CASETA}&metrica=temperature&desde=0`)).json();
  if (r.length < 4) throw new Error(`serie con ${r.length} puntos`);
});

await paso("al reiniciar el servidor se acuerda de todo y las pantallas vuelven solas", async () => {
  srv.kill("SIGTERM");
  await new Promise((r) => srv.once("exit", r));
  await esperarTexto(movil, /Sin conexión con el servidor/, "aviso de sin conexión en el móvil");
  await foto(movil, "movil-sin-servidor");
  srv = arrancarServidor();
  await esperarTexto(movil, /DNN5 conectado/, "reconectado", 20000);
  const t = await texto(movil);
  if (!/Huerto/.test(t) || !/por encima de 30/.test(t)) throw new Error("se ha perdido el vigilado o la alarma");
  if (!/Enchufe del taller[\s\S]*Potencia/i.test(t)) throw new Error("se ha perdido el panel del enchufe");
});
await paso("quitar el panel del enchufe desde el móvil", async () => {
  await movil.click("#cards .name-btn:text('Enchufe del taller')");
  await sleep(300);
  await movil.click("[data-panel-quitar]");
  await movil.click("[data-panel-quitar]");
  await esperarTexto(movil, /Panel «Enchufe del taller» quitado/, "aviso");
  await sleep(500);
  if (await pc.locator("#cards .name-btn:text('Enchufe del taller')").count()) throw new Error("sigue en el PC");
  const st = await estado();
  if (st.nodes.some((x) => x.num < 0) || Object.keys(st.cfg.watched).some((k) => Number(k) < 0)) throw new Error("sigue en el servidor");
  if (st.active.some((a) => a.num < 0)) throw new Error("su alarma sigue activa");
});
await foto(movil, "movil-tras-reinicio");
await paso("al pararse avisa a Home Assistant (offline) y al volver se conecta solo (online)", async () => {
  await esperarMqtt(() => estados.lastIndexOf("offline") >= 0 && estados.lastIndexOf("online") > estados.lastIndexOf("offline"), "offline y luego online", 15000);
});
await foto(pc, "pc-final");

fs.writeFileSync(path.join(out, "servidor.log"), serverLog);
fs.writeFileSync(path.join(out, "errores.txt"), errores.join("\n"));
await browser.close();
fs.unwatchFile(PASSWD);
mosquitto.kill();
await ha.endAsync();
broker.close();
srvMqtt.close();
srv.kill("SIGTERM");
await nodo.cerrar();
log(`\n${errores.length} errores`);
for (const e of errores) log(" -", e);
process.exit(0);
