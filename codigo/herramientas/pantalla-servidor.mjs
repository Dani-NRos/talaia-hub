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
fs.writeFileSync(cfgFile, JSON.stringify({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: tcp }, web: { puerto: WEB }, datos, registro: "info" }));
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
const texto = (page) => page.evaluate(() => document.body.innerText);
async function esperarTexto(page, re, que, ms = 8000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (re.test(await texto(page))) return; await sleep(100); }
  throw new Error(`no apareció en pantalla: ${que}`);
}
const paso = async (que, f) => { try { await f(); log(`✓ ${que}`); } catch (e) { log(`✗ ${que}: ${e.message}`); errores.push(`${que}: ${e.message}`); } };

const movil = await pantalla("móvil", { width: 400, height: 860 });
const pc = await pantalla("pc", { width: 1200, height: 900 });

await paso("las dos pantallas ven el receptor conectado", async () => {
  await esperarTexto(movil, /DNN5 conectado/, "DNN5 conectado (móvil)");
  await esperarTexto(pc, /DNN5 conectado/, "DNN5 conectado (pc)");
});
await foto(movil, "movil-inicio");

await paso("vigilar un nodo desde el PC aparece en el móvil", async () => {
  await pc.click(`[data-watch="${CASETA}"]`);
  await esperarTexto(movil, /SENSORES VIGILADOS[\s\S]*Caseta huerto/i, "Caseta vigilada en el móvil");
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
  await esperarTexto(pc, /de vuelta en rango/, "alarma resuelta en el PC");
});
await foto(movil, "movil-peticion");
await movil.keyboard.press("Escape");

await paso("avisos por la malla desde el servidor: canal privado", async () => {
  await pc.click("#setBtn");
  await sleep(400);
  await pc.check("#meshOn", { force: true });
  await sleep(300);
  await pc.selectOption("#meshCh", "1");
  await sleep(300);
  await pc.check("#meshClear", { force: true });
  await sleep(300);
  await pc.keyboard.press("Escape");
  const antes = nodo.paquetes(PORT.TEXT_MESSAGE_APP).length;
  nodo.ambiente(CASETA, { temperature: 33, relativeHumidity: 60 });
  await nodo.esperar(() => nodo.paquetes(PORT.TEXT_MESSAGE_APP).length > antes, 6000, "aviso por la malla");
  const p = nodo.paquetes(PORT.TEXT_MESSAGE_APP).at(-1);
  log("   aviso:", p.to.toString(16), "canal", p.channel, JSON.stringify(new TextDecoder().decode(p.payloadVariant.value.payload)));
  const rout = toBinary(M.RoutingSchema, create(M.RoutingSchema, { variant: { case: "errorReason", value: 0 } }));
  nodo.paquete({ from: ME, payloadVariant: { case: "decoded", value: create(M.DataSchema, { portnum: PORT.ROUTING_APP, payload: rout, requestId: p.id }) } });
  await sleep(800);
  await movil.click("#setBtn");
  await esperarTexto(movil, /Último: «⚠ Vigía: Caseta huerto · Temperatura 33,0 °C[\s\S]*repetido por la malla/, "último aviso en ajustes del móvil");
});
await foto(movil, "movil-ajustes");
await movil.keyboard.press("Escape");

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

await paso("MQTT desde Ajustes: con usuario y contraseña conecta y Home Assistant recibe los dispositivos", async () => {
  await pc.click("#setBtn");
  await sleep(400);
  await pc.locator("#mqttBox").screenshot({ path: path.join(out, "mqtt-apagado.png") });
  await pc.fill("#mqttUrl", `127.0.0.1:${MQTT_PUERTO}`);
  await pc.fill("#mqttUser", "vigia");
  await pc.fill("#mqttPass", "otra");
  await pc.check("#mqttOn", { force: true });
  await pc.click("[data-mqtt-save]");
  await esperarTexto(pc, /No se puede conectar con mqtt:\/\/127\.0\.0\.1:\d+: usuario o contraseña incorrectos/, "error de contraseña en Ajustes");
  await pc.locator("#mqttBox").screenshot({ path: path.join(out, "mqtt-error.png") });
  await pc.fill("#mqttPass", "clave-secreta");
  await pc.click("[data-mqtt-save]");
  await esperarTexto(pc, new RegExp(`Conectado a mqtt://127\\.0\\.0\\.1:${MQTT_PUERTO}`), "Conectado en Ajustes");
  await esperarMqtt(() => visto.get("vigia/estado") === "online", "online");
  await esperarMqtt(() => visto.get(`homeassistant/sensor/vigia_${ID}/temperature/config`), "sensor de temperatura");
  const cfg = JSON.parse(visto.get(`homeassistant/sensor/vigia_${ID}/temperature/config`));
  if (cfg.device.name !== "Vigía · Caseta huerto") throw new Error(`nombre del dispositivo: ${cfg.device.name}`);
  if (/clave-secreta/.test(await (await fetch(`${URL0}api/estado`)).text())) throw new Error("la contraseña sale en /api/estado");
  if (await pc.inputValue("#mqttPass")) throw new Error("la contraseña se queda escrita en la pantalla");
});
await foto(pc, "pc-ajustes-mqtt");
await pc.keyboard.press("Escape");

await paso("el móvil ve la misma configuración MQTT (sin la contraseña)", async () => {
  await movil.click("#setBtn");
  await esperarTexto(movil, /Conectado a mqtt:/, "Conectado en el móvil");
  if ((await movil.inputValue("#mqttUser")) !== "vigia") throw new Error("usuario");
  if (await movil.inputValue("#mqttPass")) throw new Error("la contraseña aparece en el móvil");
  await movil.locator("#mqttBox").screenshot({ path: path.join(out, "mqtt-conectado-movil.png") });
  await movil.keyboard.press("Escape");
});

await paso("Enterado desde Home Assistant queda visto en las pantallas", async () => {
  await esperarMqtt(() => JSON.parse(visto.get(`vigia/nodo/${ID}/estado`) || "{}").a?.temperature_alta === "ON", "alarma encendida en HA");
  await ha.publishAsync(`vigia/nodo/${ID}/enterado`, "temperature_alta");
  await esperarTexto(movil, /alarma vista, sigue activa/i, "vista en el móvil");
  await esperarMqtt(() => JSON.parse(visto.get(`vigia/nodo/${ID}/estado`) || "{}").d?.temperature_alta?.visto === true, "vista en HA");
  const act = (await (await fetch(`${URL0}api/estado`)).json()).active;
  if (!act.some((a) => a.acked)) throw new Error(`en el servidor: ${JSON.stringify(act.map((a) => [a.key, a.acked]))}`);
});

// La estación: lo que Home Assistant (mqtt_statestream) y zigbee2mqtt publican sale a la malla como del receptor.
const T_TEMP = "ha_estados/sensor/estacion_temperatura/state", T_VIENTO = "ha_estados/sensor/estacion_viento/state", T_Z2M = "zigbee2mqtt/Estación";
await ha.publishAsync(T_TEMP, "19.6", { retain: true });
await ha.publishAsync(T_VIENTO, "18", { retain: true });
await ha.publishAsync(T_Z2M, JSON.stringify({ humidity: 64, pressure: 1014.8, battery: 90 }), { retain: true });
const fila = (page, i, k) => page.locator(`#estDatos .est-d:nth-child(${i + 1}) [data-est-k="${k}"]`);
/** Foto de un apartado de Ajustes entero: la ventana, alta para que quepa (Ajustes tiene su propio desplazamiento). */
async function fotoApartado(page, sel, nombre) {
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.width, height: 4000 });
  await sleep(300);
  await page.locator(sel).screenshot({ path: path.join(out, `${nombre}.png`) });
  await page.setViewportSize(vp);
}

await paso("estación desde Ajustes: buscar temas, cuatro datos (viento en km/h), canal privado; se ven los valores", async () => {
  await pc.click("#setBtn");
  await sleep(400);
  await fotoApartado(pc, "#estBox", "estacion-vacia");
  await pc.click("[data-est-buscar]");
  await esperarTexto(pc, /Encontrados \d+/, "temas encontrados");
  const n = await pc.locator("#estTemas option").count();
  if (n < 2) throw new Error(`solo ${n} temas en la lista`);
  const datos = [["temperature", T_TEMP, ""], ["relativeHumidity", T_Z2M, "humidity"], ["barometricPressure", T_Z2M, "pressure"], ["windSpeed", T_VIENTO, ""]];
  for (const [i, [m, tema, campo]] of datos.entries()) {
    await pc.click("[data-est-add]");
    await fila(pc, i, "metrica").selectOption(m);
    await fila(pc, i, "tema").fill(tema);
    if (campo) await fila(pc, i, "campo").fill(campo);
  }
  await fila(pc, 3, "unidad").selectOption("km/h");
  await pc.selectOption("#estCh", "1");
  await pc.check("#estOn", { force: true });
  await pc.click("[data-est-save]");
  await esperarTexto(pc, /19,6 °C · ahora mismo/, "temperatura en Ajustes");
  await esperarTexto(pc, /5,0 m\/s \(18,0 km\/h\)/, "viento convertido");
  await esperarTexto(pc, /Próximo envío a las \d\d:\d\d: «Temperatura 19,6 °C · Humedad 64 % · Presión 1015 hPa · Viento 5,0 m\/s»/, "próximo envío");
  await fotoApartado(pc, "#estBox", "estacion-pc");
});

await paso("Enviar ahora: el nodo recibe la telemetría por el canal 1; las dos pantallas ven «repetido por la malla»", async () => {
  const antes = nodo.paquetes(PORT.TELEMETRY_APP).length;
  await pc.click("[data-est-send]");
  await nodo.esperar(() => nodo.paquetes(PORT.TELEMETRY_APP).length > antes, 5000, "telemetría de la estación");
  const p = nodo.paquetes(PORT.TELEMETRY_APP).at(-1);
  const tel = fromBinary(TEL.TelemetrySchema, p.payloadVariant.value.payload);
  const e = tel.variant.value;
  log("   telemetría:", p.channel, p.to.toString(16), JSON.stringify({ t: e.temperature, h: e.relativeHumidity, p: e.barometricPressure, v: e.windSpeed }));
  if (p.channel !== 1 || p.to !== 0xffffffff || Math.abs(e.temperature - 19.6) > 1e-3 || Math.abs(e.windSpeed - 5) > 1e-3) throw new Error("paquete equivocado");
  const rout = toBinary(M.RoutingSchema, create(M.RoutingSchema, { variant: { case: "errorReason", value: 0 } }));
  nodo.paquete({ from: ME, payloadVariant: { case: "decoded", value: create(M.DataSchema, { portnum: PORT.ROUTING_APP, payload: rout, requestId: p.id }) } });
  await esperarTexto(pc, /Último \(a mano\), a las \d\d:\d\d: «Temperatura 19,6 °C[^»]*» → canal «avisos»: repetido por la malla/, "último envío en el PC");
  await movil.click("#setBtn");
  await esperarTexto(movil, /repetido por la malla\./, "último envío en el móvil");
  await fotoApartado(movil, "#estBox", "estacion-movil");
  await movil.keyboard.press("Escape");
  await pc.keyboard.press("Escape");
  // Y es una lectura del receptor.
  const yo = (await (await fetch(`${URL0}api/estado`)).json()).nodes.find((x) => x.num === ME);
  if (yo?.metrics?.temperature?.v !== 19.6) throw new Error(`receptor: ${JSON.stringify(yo?.metrics)}`);
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
  if (!/Caseta huerto/.test(t) || !/por encima de 30/.test(t)) throw new Error("se ha perdido el vigilado o la alarma");
});
await foto(movil, "movil-tras-reinicio");
await paso("al pararse avisa a Home Assistant (offline) y al volver se conecta solo (online)", async () => {
  await esperarMqtt(() => estados.lastIndexOf("offline") >= 0 && estados.lastIndexOf("online") > estados.lastIndexOf("offline"), "offline y luego online", 15000);
});
await foto(pc, "pc-final");

fs.writeFileSync(path.join(out, "servidor.log"), serverLog);
fs.writeFileSync(path.join(out, "errores.txt"), errores.join("\n"));
await browser.close();
await ha.endAsync();
broker.close();
srvMqtt.close();
srv.kill("SIGTERM");
await nodo.cerrar();
log(`\n${errores.length} errores`);
for (const e of errores) log(" -", e);
process.exit(0);
