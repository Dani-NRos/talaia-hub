// The cursor of the charts: the value and the time under the mouse or the finger, on a line chart and on an ON/OFF
// bar, in the sheet and in full screen; it follows the pointer, survives the chart being drawn again and goes away on
// leaving (mouse) or tapping elsewhere (finger). With the real server, a simulated node and an MQTT broker in memory;
// nothing reaches a real mesh. Usage: npm run build && node herramientas/cursor.mjs [output folder for screenshots]
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const req = createRequire(`${REPO}/servidor/package.json`);
const pw = createRequire(process.env.PLAYWRIGHT_DIR || "/opt/npm-tools/node_modules/")("playwright");
const { Aedes } = req("aedes");
const mqtt = req("mqtt");
const { NodoFalso, ME } = await import(`${REPO}/servidor/test/nodo-falso.mjs`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });

// A broker in memory, for an ON/OFF datum.
const aedes = await Aedes.createBroker();
const bsrv = net.createServer(aedes.handle);
await new Promise((r) => bsrv.listen(0, "127.0.0.1", r));
const BPORT = bsrv.address().port;

const nodo = new NodoFalso();
const tcp = await nodo.escucharTcp();
const datos = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-cursor-"));
const WEB = 40000 + Math.floor(Math.random() * 9000);
const cfgFile = path.join(datos, "servidor.json");
fs.writeFileSync(cfgFile, JSON.stringify({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: tcp }, web: { puerto: WEB }, datos, registro: "aviso" }));
const srv = spawn(process.execPath, [`${REPO}/servidor/src/main.js`, "--config", cfgFile], { env: { ...process.env, TZ: "Europe/Madrid", LANG: "es_ES.UTF-8" }, stdio: "ignore" });
const URL0 = `http://127.0.0.1:${WEB}/`;
for (let i = 0; i < 100; i++) { try { if ((await (await fetch(`${URL0}api/salud`)).json()).receptor === "ready") break; } catch { /* not yet */ } await sleep(100); }

const codigo = fs.readFileSync(path.join(datos, "primer-usuario.txt"), "utf8").trim();
const alta = await fetch(`${URL0}api/primero`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codigo, nombre: "Dani", clave: "clave-de-prueba" }) });
const SESION = /talaia_sesion=([^;]+)/.exec(alta.headers.get("set-cookie") || "")?.[1];
const orden = (o) => fetch(`${URL0}api/orden`, { method: "POST", headers: { "content-type": "application/json", cookie: `talaia_sesion=${SESION}` }, body: JSON.stringify(o) }).then((r) => r.json());

await orden({ orden: "vigilar", num: ME });
for (const t of [18.4, 19.2, 19.6]) { nodo.ambiente(ME, { temperature: t, relativeHumidity: 55 }); await sleep(200); }
// A panel with a switch: on, then off.
let r = await orden({ orden: "broker", cambio: { nombre: "Local", url: `127.0.0.1:${BPORT}` } });
if (!r.ok) throw new Error(`broker: ${r.error}`);
const panel = await orden({ orden: "crearPanel", nombre: "Bomba del pozo", tipo: "tasmota" });
const bid = "b1";
r = await orden({ orden: "datosPanel", num: panel.num, datos: [{ tipo: "estado", nombre: "Bomba", broker: bid, tema: "pozo/bomba", nombres: "encendido" }] });
if (!r.ok) throw new Error(`datosPanel: ${r.error}`);
const pub = await mqtt.connectAsync(`mqtt://127.0.0.1:${BPORT}`);
await sleep(800);
await pub.publishAsync("pozo/bomba", "1", { retain: true });
await sleep(1500);
await pub.publishAsync("pozo/bomba", "0", { retain: true });
await sleep(1500);

const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const browser = await pw.chromium.launch();
async function newPage(opts) {
  const c = await browser.newContext({ locale: "es-ES", ...opts });
  await c.addCookies([{ name: "talaia_sesion", value: SESION, url: URL0 }]);
  await c.addInitScript(() => { try { localStorage.setItem("talaia.lang", "es"); localStorage.setItem("talaia.sheetTab", JSON.stringify("history")); } catch { /* none */ } });
  const p = await c.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.goto(URL0);
  await sleep(900);
  return p;
}
const tip = (p, sel) => p.evaluate((s) => { const e = document.querySelector(`${s} .hv-tip`); return e ? { text: e.innerText.replace(/\s+/g, " ").trim(), line: !!document.querySelector(`${s} .hv line`), dot: !!document.querySelector(`${s} .hv circle`) } : null; }, sel);

// ── Mouse, in the sheet ──
const page = await newPage({ viewport: { width: 1100, height: 800 } });
await page.click(`#cards .card[data-open="${ME}"] .name-btn`);
await sleep(900);
const tempBox = '#chartList .chart[data-m="temperature"] .chart-box';
const svg = await page.locator(`${tempBox} .chart-svg`).boundingBox();
await page.mouse.move(svg.x + svg.width - 2, svg.y + svg.height / 2); // the right edge: now
await sleep(200);
let t = await tip(page, tempBox);
check(t && /19,6 °C/.test(t.text) && /\d\d:\d\d/.test(t.text) && t.line && t.dot, `the mouse at the end of the line shows the last reading and its time (${t?.text})`);
if (shots) await page.screenshot({ path: path.join(shots, "sheet-mouse.png") });
const inBox = await page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(), e = document.querySelector(`${s} .hv-tip`).getBoundingClientRect(); return e.left >= b.left - 1 && e.right <= b.right + 1; }, tempBox);
const onTop = await page.evaluate((s) => { const v = document.querySelector(`${s} .chart-svg`).getBoundingClientRect(), e = document.querySelector(`${s} .hv-tip`).getBoundingClientRect(); return e.top >= v.top - 1 && e.bottom <= v.bottom + 1; }, tempBox);
check(inBox && onTop, "the label stays over its own chart, inside it near the right edge");
// Drawn again with a new reading: the cursor is still there, with the new value.
nodo.ambiente(ME, { temperature: 20.4, relativeHumidity: 54 });
let again = false;
for (let i = 0; i < 40 && !again; i++) { await sleep(150); t = await tip(page, tempBox); again = !!t && /20,4 °C/.test(t.text); }
check(again, "when the chart is drawn again, the cursor comes back (with the new reading)");
// The ON/OFF bar of the switch panel.
await page.keyboard.press("Escape");
await sleep(300);
await page.click(`#cards .card[data-open="${panel.num}"] .name-btn`);
await sleep(900);
const estBox = '#chartList .chart .chart-box:has(.est-svg)';
const est = await page.locator(`${estBox} .chart-svg`).boundingBox();
await page.mouse.move(est.x + est.width - 14, est.y + 10); // a few pixels off a short span still finds it
await sleep(200);
t = await tip(page, estBox);
check(t && /Encendido|Apagado/.test(t.text) && / – /.test(t.text) && t.line && !t.dot, `over an ON/OFF bar: the state, from when to when and how long (${t?.text})`);
await page.mouse.move(5, 5);
await sleep(200);
check(!(await tip(page, estBox)), "moving the mouse away clears it");
await page.keyboard.press("Escape");
await sleep(300);

// ── Full screen ──
await page.click(`#cards .card[data-open="${ME}"] [data-full]`);
await sleep(900);
const fullBox = '#nodeview .nv-chart[data-m="temperature"] .chart-box';
const fsvg = await page.locator(`${fullBox} .chart-svg`).boundingBox();
await page.mouse.move(fsvg.x + fsvg.width - 2, fsvg.y + fsvg.height / 2);
await sleep(200);
t = await tip(page, fullBox);
check(t && /20,4 °C/.test(t.text), `in full screen too (${t?.text})`);
if (shots) await page.screenshot({ path: path.join(shots, "full-mouse.png") });

// ── A finger, on a phone ──
const phone = await newPage({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
await phone.click(`#cards .card[data-open="${ME}"] .name-btn`);
await sleep(900);
const psvg = await phone.locator(`${tempBox} .chart-svg`).boundingBox();
await phone.touchscreen.tap(psvg.x + psvg.width - 2, psvg.y + psvg.height / 2);
await sleep(300);
t = await tip(phone, tempBox);
check(t && /20,4 °C/.test(t.text), `a tap shows it, and it stays after lifting the finger (${t?.text})`);
if (shots) await phone.screenshot({ path: path.join(shots, "phone-tap.png") });
check((await phone.evaluate((s) => getComputedStyle(document.querySelector(`${s} .chart-svg`)).touchAction, tempBox)) === "pan-y", "the page still scrolls up and down over a chart");
await phone.touchscreen.tap(30, psvg.y - 60);
await sleep(300);
check(!(await tip(phone, tempBox)), "tapping elsewhere clears it");

check(page.errors.length + phone.errors.length === 0, `no errors on the pages${page.errors.length + phone.errors.length ? `: ${[...page.errors, ...phone.errors].join(" | ")}` : ""}`);
await browser.close();
await pub.endAsync();
srv.kill();
await new Promise((r) => aedes.close(r));
bsrv.close();
process.exit(fails.length ? 1 : 0);
