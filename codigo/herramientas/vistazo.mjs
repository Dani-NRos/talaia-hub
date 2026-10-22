// A look at the screen: every section on a computer and on a phone, by day and at night, with a simulated node
// (a watched sensor with an alarm, the receiver, a neighbour). To review the design, not to test behaviour.
// Usage: npm run build && node herramientas/vistazo.mjs <output folder> [views…] [--en]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const pw = createRequire(process.env.PLAYWRIGHT_DIR || "/opt/npm-tools/node_modules/")("playwright");
const { NodoFalso, ME, CASETA, AVISADO } = await import(`${REPO}/servidor/test/nodo-falso.mjs`);

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--") && !["dashboard", "alarms", "nodes", "map", "automations", "settings"].includes(a)) || "vistazo";
const views = args.filter((a) => ["dashboard", "alarms", "nodes", "map", "automations", "settings"].includes(a));
const VIEWS = views.length ? views : ["dashboard", "alarms", "nodes", "map", "automations", "settings"];
const lang = args.includes("--en") ? "en" : "es";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nodo = new NodoFalso();
const tcp = await nodo.escucharTcp();
const datos = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-vistazo-"));
const WEB = 40000 + Math.floor(Math.random() * 9000);
const cfgFile = path.join(datos, "servidor.json");
fs.writeFileSync(cfgFile, JSON.stringify({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: tcp }, web: { puerto: WEB }, datos, registro: "aviso" }));
const srv = spawn(process.execPath, [`${REPO}/servidor/src/main.js`, "--config", cfgFile], { env: { ...process.env, TZ: "Europe/Madrid" }, stdio: "ignore" });
const URL0 = `http://127.0.0.1:${WEB}/`;
for (let i = 0; i < 100; i++) { try { if ((await (await fetch(`${URL0}api/salud`)).json()).receptor === "ready") break; } catch { /* not yet */ } await sleep(100); }
const orden = (o) => fetch(`${URL0}api/orden`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) }).then((r) => r.json());

// Something to show: the receiver and a sensor watched, readings, and an alarm on the sensor.
await orden({ orden: "vigilar", num: CASETA });
await orden({ orden: "vigilar", num: ME });
for (const [t, h] of [[22.1, 63], [23.4, 61], [24.0, 60], [26.2, 58]]) { nodo.ambiente(CASETA, { temperature: t, relativeHumidity: h }); await sleep(150); }
nodo.ambiente(ME, { temperature: 19.6, relativeHumidity: 55, barometricPressure: 1014.8 });
nodo.ambiente(AVISADO, { temperature: 17.2, relativeHumidity: 70 });
// Around Alzira, for the map.
nodo.posicion(ME, 39.1513, -0.4352);
nodo.posicion(CASETA, 39.1604, -0.4521);
nodo.posicion(AVISADO, 39.1388, -0.4189);
await orden({ orden: "limite", num: CASETA, metrica: "temperature", lado: "max", valor: 30 });
nodo.ambiente(CASETA, { temperature: 31.4, relativeHumidity: 57 });
await sleep(800);

const browser = await pw.chromium.launch();
const SIZES = { pc: { width: 1280, height: 820 }, movil: { width: 390, height: 844 } };
const errors = [];
for (const [size, viewport] of Object.entries(SIZES)) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, locale: lang === "en" ? "en-GB" : "es-ES", timezoneId: "Europe/Madrid", deviceScaleFactor: size === "movil" ? 2 : 1 });
    await ctx.route(/openstreetmap\.org/, (r) => r.abort());
    await ctx.addInitScript((l) => { try { localStorage.setItem("talaia.lang", l); } catch { /* none */ } }, lang);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${size}/${scheme}: ${e.message}`));
    await page.goto(URL0);
    await sleep(900);
    for (const v of VIEWS) {
      await page.evaluate((x) => { location.hash = `#/${x}`; }, v);
      await sleep(v === "map" ? 900 : 350);
      await page.screenshot({ path: path.join(out, `${size}-${scheme}-${v}.png`), fullPage: v !== "map" });
    }
    await ctx.close();
  }
}
await browser.close();
srv.kill();
await nodo.cerrar();
fs.rmSync(datos, { recursive: true, force: true });
console.log(errors.length ? errors.join("\n") : "sin errores en la página");
console.log(`capturas en ${out}`);
