// The tabs of the sheet: which ones each kind of sheet has, the last one used is remembered on the device, what was
// typed in one survives going to another, the charts are drawn at their width, the bar stays put and the keyboard
// moves between them. With the real server and a simulated node; nothing reaches a real mesh.
// Usage: npm run build && node herramientas/pestanas.mjs [output folder for screenshots]   (exit 1 if something fails)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const pw = createRequire(process.env.PLAYWRIGHT_DIR || "/opt/npm-tools/node_modules/")("playwright");
const { NodoFalso, ME, CASETA, AVISADO } = await import(`${REPO}/servidor/test/nodo-falso.mjs`);
const { TIPOS_PANEL } = await import(`${REPO}/nucleo/src/mqtt-datos.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });

const nodo = new NodoFalso();
const tcp = await nodo.escucharTcp();
const datos = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-tabs-"));
const WEB = 40000 + Math.floor(Math.random() * 9000);
const cfgFile = path.join(datos, "servidor.json");
fs.writeFileSync(cfgFile, JSON.stringify({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: tcp }, web: { puerto: WEB }, datos, registro: "aviso" }));
const srv = spawn(process.execPath, [`${REPO}/servidor/src/main.js`, "--config", cfgFile], { env: { ...process.env, TZ: "Europe/Madrid", LANG: "es_ES.UTF-8" }, stdio: "ignore" });
const URL0 = `http://127.0.0.1:${WEB}/`;
for (let i = 0; i < 100; i++) { try { if ((await (await fetch(`${URL0}api/salud`)).json()).receptor === "ready") break; } catch { /* not yet */ } await sleep(100); }

const codigo = fs.readFileSync(path.join(datos, "primer-usuario.txt"), "utf8").trim();
const alta = await fetch(`${URL0}api/primero`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codigo, nombre: "Dani", clave: "clave-de-prueba" }) });
const SESION = /talaia_sesion=([^;]+)/.exec(alta.headers.get("set-cookie") || "")?.[1];
if (!SESION) throw new Error(`no session: ${alta.status} ${await alta.text()}`);
const orden = (o) => fetch(`${URL0}api/orden`, { method: "POST", headers: { "content-type": "application/json", cookie: `talaia_sesion=${SESION}` }, body: JSON.stringify(o) }).then((r) => r.json());

await orden({ orden: "vigilar", num: CASETA });
await orden({ orden: "vigilar", num: ME });
for (const [t, h] of [[22.1, 63], [23.4, 61], [24.0, 60]]) { nodo.ambiente(CASETA, { temperature: t, relativeHumidity: h }); await sleep(150); }
nodo.ambiente(ME, { temperature: 19.6, relativeHumidity: 55, barometricPressure: 1014.8 });
nodo.ambiente(AVISADO, { temperature: 17.2, relativeHumidity: 70 }); // heard but not watched
const panel = await orden({ orden: "crearPanel", nombre: "Panel de prueba", tipo: Object.keys(TIPOS_PANEL)[0] });
if (!panel.ok) throw new Error(`crearPanel: ${panel.error}`);
await sleep(600);

const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 640 }, locale: "es-ES" });
await ctx.addCookies([{ name: "talaia_sesion", value: SESION, url: URL0 }]);
await ctx.addInitScript(() => { try { localStorage.setItem("talaia.lang", "es"); } catch { /* none */ } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(URL0);
await sleep(900);

const snap = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const tabs = () => page.evaluate(() => [...document.querySelectorAll("#detail [role=tab]")].map((b) => b.dataset.sheetTab));
const selected = () => page.evaluate(() => document.querySelector("#detail [role=tab][aria-selected=true]")?.dataset.sheetTab);
const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }, sel);
const shownPanels = () => page.evaluate(() => [...document.querySelectorAll("#detail .sheet-p")].filter((p) => p.offsetParent !== null).map((p) => p.dataset.tabp));
const openFromBoard = async (num) => { await page.evaluate(() => { location.hash = "#/dashboard"; }); await sleep(200); await page.click(`#cards .name-btn[data-open="${num}"]`); await sleep(500); };
const closeSheet = async () => { await page.keyboard.press("Escape"); await sleep(200); };
const clickTab = async (k) => { await page.click(`#detail [data-sheet-tab="${k}"]`); await sleep(400); };

// ── A watched node ──
await openFromBoard(CASETA);
check(JSON.stringify(await tabs()) === JSON.stringify(["node", "alarms", "history", "settings"]), "a watched node: Node, Alarms, History, Settings");
check((await selected()) === "node" && JSON.stringify(await shownPanels()) === '["node"]', "the first one shows when nothing was chosen before");
await snap("node-tab");
await clickTab("alarms");
check((await selected()) === "alarms" && JSON.stringify(await shownPanels()) === '["alarms"]' && (await visible("#r-off")), "Alarms shows only its own panel");
await snap("alarms-tab");
await closeSheet();
await openFromBoard(ME);
check((await selected()) === "alarms", "the last one used is remembered when opening another sheet");
await page.reload();
await sleep(900);
await openFromBoard(CASETA);
check((await selected()) === "alarms", "…and after reloading the page (kept on this device)");

// The charts, drawn at their width when History shows.
await clickTab("history");
const measure = () => page.evaluate(() => [...document.querySelectorAll("#chartList .chart")].map((f) => { const b = f.querySelector(".chart-box"), s = b.querySelector("svg"); return { box: b.clientWidth, svg: s ? s.getBoundingClientRect().width : 0, drawn: !!s || !!b.querySelector(".empty-chart") }; }));
let charts = await measure();
for (let i = 0; i < 40 && !charts.every((c) => c.drawn); i++) { await sleep(100); charts = await measure(); } // they are drawn one after another
const withData = charts.filter((c) => c.svg > 0); // a metric with no readings in the period says so instead of drawing
check(charts.every((c) => c.drawn) && withData.length > 0 && withData.every((c) => Math.abs(c.svg - c.box) <= 2), `History draws its charts at the width of their boxes (${withData.map((c) => `${Math.round(c.svg)}/${c.box}`).join(", ")})`);
await snap("history-tab");

// The bar stays where it is while the body scrolls; each tab starts at its top.
await clickTab("settings");
const bar0 = await page.evaluate(() => { const b = document.querySelector("#detail .sheet-b"); b.scrollTop = 150; return { top: document.querySelector("#detail .sheet-tabs").getBoundingClientRect().top, scrolled: b.scrollTop }; });
const bar1 = await page.evaluate(() => document.querySelector("#detail .sheet-tabs").getBoundingClientRect().top);
check(bar0.scrolled > 0 && Math.abs(bar0.top - bar1) < 0.5, `the bar stays put while the body scrolls (${bar0.scrolled} px)`);
await snap("settings-tab");
await clickTab("alarms");
check((await page.evaluate(() => document.querySelector("#detail .sheet-b").scrollTop)) === 0, "going to another tab starts at its top");

// Keyboard: arrows move between tabs.
await page.focus("#detail [role=tab][aria-selected=true]");
await page.keyboard.press("ArrowRight");
await sleep(300);
check((await selected()) === "history", "ArrowRight moves to the next tab");
await page.keyboard.press("End");
await sleep(300);
check((await selected()) === "settings", "End moves to the last one");
await closeSheet();

// ── A panel without a node: no Node tab; what was typed survives going to another tab ──
await openFromBoard(panel.num);
check(JSON.stringify(await tabs()) === JSON.stringify(["alarms", "history", "settings"]), "a panel without a node: Alarms, History, Settings");
await clickTab("settings");
await page.fill("#pnNombre", "Nombre sin guardar");
await page.click("[data-dat-add]");
await sleep(200);
const topic = "#datLista [data-dat-k=\"tema\"]";
await page.fill(`${topic} >> nth=-1`, "casa/prueba/temperatura");
await clickTab("alarms");
await clickTab("history");
await clickTab("settings");
check((await page.inputValue("#pnNombre")) === "Nombre sin guardar", "the name typed and not saved is still there after changing tabs");
check((await page.inputValue(`${topic} >> nth=-1`)) === "casa/prueba/temperatura", "the MQTT datum in the draft is still there too");
await closeSheet();

// ── A node that is not watched: Node and History, with the button to watch it ──
await page.evaluate(() => { location.hash = "#/nodes"; });
await sleep(400);
await page.click(`#mesh [data-open="${AVISADO}"]`);
await sleep(500);
check(JSON.stringify(await tabs()) === JSON.stringify(["node", "history"]), "a node not watched: Node and History");
check((await selected()) === "node", "the one remembered (Settings) isn't there, so it starts at the first");
check((await visible("#sp-node [data-watch]")), "the button to watch it is in Node");
await clickTab("history");
check((await visible("#sp-history [data-watch]")), "…and in History");
await closeSheet();

// ── «Add panel» opens the new panel on Settings, where its data go ──
await page.evaluate(() => { location.hash = "#/dashboard"; });
await sleep(300);
await page.click("[data-panel-nuevo]");
await sleep(300);
await page.fill("#npNombre", "Otro panel");
await page.click("[data-panel-crear]");
await sleep(1200);
check((await selected()) === "settings" && (await visible("#datBox")), "a panel just created opens on Settings, with its data in view");
await closeSheet();

check(errors.length === 0, `no errors on the page${errors.length ? `: ${errors.join(" | ")}` : ""}`);
await browser.close();
srv.kill();
process.exit(fails.length ? 1 : 0);
