// The order of a panel's readings and charts and the chart on its card: chosen with the editor (arrows and dragging) in
// full screen and in the sheet, seen on the card, the sheet and full screen, kept by the server and seen by another
// screen. With the real server and a simulated node; nothing reaches a real mesh.
// Usage: npm run build && node herramientas/orden.mjs [output folder for screenshots]   (exit 1 if something fails)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const pw = createRequire(process.env.PLAYWRIGHT_DIR || "/opt/npm-tools/node_modules/")("playwright");
const { NodoFalso, ME } = await import(`${REPO}/servidor/test/nodo-falso.mjs`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });

const nodo = new NodoFalso();
const tcp = await nodo.escucharTcp();
const datos = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-orden-"));
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

await orden({ orden: "vigilar", num: ME });
for (const [t, h, p] of [[19.2, 56, 1012.1], [19.6, 55, 1014.8]]) { nodo.ambiente(ME, { temperature: t, relativeHumidity: h, barometricPressure: p }); await sleep(150); }
await sleep(700);

const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

const browser = await pw.chromium.launch();
const newPage = async (viewport) => {
  const ctx = await browser.newContext({ viewport, locale: "es-ES" });
  await ctx.addCookies([{ name: "talaia_sesion", value: SESION, url: URL0 }]);
  await ctx.addInitScript(() => { try { localStorage.setItem("talaia.lang", "es"); } catch { /* none */ } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(URL0);
  await sleep(900);
  return page;
};
const [VW, VH] = (process.env.VIEW || "1100x800").split("x").map(Number); // e.g. VIEW=390x800 for a phone
const page = await newPage({ width: VW, height: VH });
const other = await newPage({ width: VW, height: VH }); // another screen, to see it arrive
const snap = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

const cardLabels = (p) => p.evaluate((n) => [...document.querySelectorAll(`#cards .card[data-open="${n}"] .rd-l`)].map((e) => e.textContent), ME);
const cardSpark = (p) => p.evaluate((n) => document.querySelector(`#cards .card[data-open="${n}"] .spark-cap`)?.textContent || "", ME);
const fullTiles = (p) => p.evaluate(() => [...document.querySelectorAll("#nodeview .nv-tiles .nv-l")].map((e) => e.textContent));
const fullCharts = (p) => p.evaluate(() => [...document.querySelectorAll("#nodeview .nv-chart figcaption > span:first-child")].map((e) => e.textContent));
const editor = (p, which) => p.evaluate((w) => [...document.querySelectorAll(`[data-mo-list="${w}"] .ord-n`)].map((e) => e.textContent), which);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const wait = async (f, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(100); } return false; };

// ── By default: the fixed order, and the card picks the temperature ──
check(same(await cardLabels(page), ["Temperatura", "Humedad", "Presión"]), "by default the card shows the fixed order");
check(/Temperatura/.test(await cardSpark(page)), "…and the temperature chart");

// ── Full screen: the editor ──
await page.click(`#cards .card[data-open="${ME}"] [data-full]`);
await sleep(600);
check(same(await fullTiles(page), ["Temperatura", "Humedad", "Presión"]), "full screen: the readings in the fixed order");
await page.click("#nodeview [data-mo-open]");
await sleep(300);
check(same(await editor(page, "data"), ["Temperatura", "Humedad", "Presión"]) && same(await editor(page, "charts"), ["Temperatura", "Humedad", "Presión"]), "«Reorder» opens the editor with the two lists");
await snap("editor-full");
// Arrows: pressure up twice in the readings; the focus stays on the same arrow.
await page.click('[data-mo-list="data"] [data-key="barometricPressure"][data-dir="-1"]');
await sleep(300);
check(same(await editor(page, "data"), ["Temperatura", "Presión", "Humedad"]), "the up arrow moves a reading");
check(await page.evaluate(() => document.activeElement?.dataset?.dir === "-1" && document.activeElement?.dataset?.key === "barometricPressure"), "…and the focus stays on that arrow, to press it again");
await page.keyboard.press("Enter");
await sleep(300);
check(same(await editor(page, "data"), ["Presión", "Temperatura", "Humedad"]), "…again with the keyboard");
check(same(await editor(page, "charts"), ["Temperatura", "Humedad", "Presión"]), "the order of the charts is its own");

// Dragging by the handle: the humidity chart above the temperature one.
const grip = await page.locator('[data-mo-list="charts"] [data-key="relativeHumidity"] .ord-grip').boundingBox();
const up = await page.locator('[data-mo-list="charts"] [data-key="temperature"] .ord-n').boundingBox();
await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
await page.mouse.down();
await page.mouse.move(grip.x + grip.width / 2, up.y - 4, { steps: 8 });
await page.mouse.up();
await sleep(400);
check(same(await editor(page, "charts"), ["Humedad", "Temperatura", "Presión"]), "dragging by the handle moves a chart");
await page.click("#nodeview [data-mo-done]");
await sleep(500);
check(same(await fullTiles(page), ["Presión", "Temperatura", "Humedad"]), "closing the editor: the readings in the new order");
check(same(await fullCharts(page), ["Humedad", "Temperatura", "Presión"]), "…and the charts in theirs");
await snap("full-ordered");

// ── The chart on the card ──
await page.click('#nodeview .nv-chart[data-m="barometricPressure"] [data-card-chart]');
await sleep(400);
check((await page.getAttribute('#nodeview .nv-chart[data-m="barometricPressure"] [data-card-chart]', "aria-pressed")) === "true", "«On the card» is pressed on the chosen chart");
await page.click("#nodeview [data-close]");
await sleep(400);
check(same(await cardLabels(page), ["Presión", "Temperatura", "Humedad"]), "the card shows the readings in the new order");
check(/Presión/.test(await cardSpark(page)), "…and the chart chosen");
await snap("card-ordered");

// ── Another screen gets it, and so does a reload (the server keeps it) ──
check(await wait(async () => same(await cardLabels(other), ["Presión", "Temperatura", "Humedad"]) && /Presión/.test(await cardSpark(other))), "another screen sees the order and the chart at once");
await page.reload();
await sleep(900);
check(same(await cardLabels(page), ["Presión", "Temperatura", "Humedad"]) && /Presión/.test(await cardSpark(page)), "after reloading the page it is the same (kept by the server)");

// ── The sheet: the readings and the charts follow the order; the editor is in History ──
await page.click(`#cards .card[data-open="${ME}"] .name-btn`);
await sleep(500);
await page.click('#detail [data-sheet-tab="alarms"]');
await sleep(300);
const rows = await page.evaluate(() => [...document.querySelectorAll("#sp-alarms tr th")].map((e) => e.firstChild.textContent.trim()).filter((s) => ["Temperatura", "Humedad", "Presión"].includes(s)));
check(same(rows, ["Presión", "Temperatura", "Humedad"]), `the sheet's alarms follow the readings' order (${rows.join(", ")})`);
await page.click('#detail [data-sheet-tab="history"]');
await sleep(500);
const sheetCharts = () => page.evaluate(() => [...document.querySelectorAll("#chartList .chart figcaption > span:first-child")].map((e) => e.textContent));
check(same(await sheetCharts(), ["Humedad", "Temperatura", "Presión"]), "the sheet's charts follow the charts' order");
check((await page.getAttribute('#chartList .chart[data-m="barometricPressure"] [data-card-chart]', "aria-pressed")) === "true", "…and show which one is on the card");
await page.click("#detail [data-mo-open]");
await sleep(300);
check(same(await editor(page, "charts"), ["Humedad", "Temperatura", "Presión"]) && !(await page.isVisible("#chartList")), "the editor opens in History, in place of the charts");
await snap("editor-sheet");
await page.click('#detail [data-mo-list="charts"] [data-key="temperature"][data-dir="-1"]');
await sleep(300);
await page.click("#detail [data-mo-done]");
await sleep(500);
check(same(await sheetCharts(), ["Temperatura", "Humedad", "Presión"]), "the sheet's editor changes the charts too");
// Pressing the chosen one again: back to the automatic chart.
await page.click('#chartList .chart[data-m="barometricPressure"] [data-card-chart]');
await sleep(400);
await page.click("#detail [data-close]");
await sleep(300);
check(/Temperatura/.test(await cardSpark(page)), "pressing «On the card» again goes back to the automatic chart");
check(await wait(async () => /Temperatura/.test(await cardSpark(other))), "…on the other screen too");

check(page.errors.length === 0 && other.errors.length === 0, `no errors on the pages${page.errors.length + other.errors.length ? `: ${[...page.errors, ...other.errors].join(" | ")}` : ""}`);
await browser.close();
srv.kill();
process.exit(fails.length ? 1 : 0);
