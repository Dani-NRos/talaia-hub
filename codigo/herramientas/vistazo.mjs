// A look at the screen: every section on a computer and on a phone, by day and at night, with a simulated node
// (a watched sensor with an alarm, the receiver, a neighbour). To review the design, not to test behaviour.
// Usage: npm run build && node herramientas/vistazo.mjs <output folder> [views…] [--en]
// Views: the sections (Settings, each of its parts), and also "sheet" (the sensor's sheet, whole), "receiver" (the
// receiver's sheet, with what it sends to the mesh), "full" (the sensor full screen), "automation" (the editor of an
// automation with every kind of step) and "signin" (making the first user, and signing in).
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
const ALL = ["dashboard", "alarms", "nodes", "map", "automations", "automation", "settings", "sheet", "receiver", "full", "signin"];
const out = args.find((a) => !a.startsWith("--") && !ALL.includes(a)) || "vistazo";
const views = args.filter((a) => ALL.includes(a));
const VIEWS = views.length ? views : ALL;
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
const srv = spawn(process.execPath, [`${REPO}/servidor/src/main.js`, "--config", cfgFile], { env: { ...process.env, TZ: "Europe/Madrid", LANG: "es_ES.UTF-8" }, stdio: "ignore" });
const URL0 = `http://127.0.0.1:${WEB}/`;
for (let i = 0; i < 100; i++) { try { if ((await (await fetch(`${URL0}api/salud`)).json()).receptor === "ready") break; } catch { /* not yet */ } await sleep(100); }
const browser = await pw.chromium.launch();
const SIZES = { pc: { width: 1280, height: 820 }, movil: { width: 390, height: 844 } };
const opciones = (size, scheme) => ({ viewport: SIZES[size], colorScheme: scheme, locale: lang === "en" ? "en-GB" : "es-ES", timezoneId: "Europe/Madrid", deviceScaleFactor: size === "movil" ? 2 : 1 });
// Before there are users: the screen that makes the first one.
if (VIEWS.includes("signin")) {
  for (const size of Object.keys(SIZES)) {
    const c = await browser.newContext(opciones(size, "light"));
    await c.addInitScript((l) => { try { localStorage.setItem("talaia.lang", l); } catch { /* none */ } }, lang);
    const p = await c.newPage();
    await p.goto(URL0);
    await sleep(700);
    await p.screenshot({ path: path.join(out, `${size}-light-first-user.png`) });
    await c.close();
  }
}
// A user, with the code the server wrote in its data folder; its session goes with everything that follows.
const codigo = fs.readFileSync(path.join(datos, "primer-usuario.txt"), "utf8").trim();
const alta = await fetch(`${URL0}api/primero`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codigo, nombre: "Dani", clave: "clave-de-prueba" }) });
const SESION = /talaia_sesion=([^;]+)/.exec(alta.headers.get("set-cookie") || "")?.[1];
if (!SESION) throw new Error(`no session: ${alta.status} ${await alta.text()}`);
const orden = (o) => fetch(`${URL0}api/orden`, { method: "POST", headers: { "content-type": "application/json", cookie: `talaia_sesion=${SESION}` }, body: JSON.stringify(o) }).then((r) => r.json());
await orden({ orden: "crearUsuario", nombre: "Ana", clave: "clave-de-ana-1" });

// Something to show: the receiver and a sensor watched, readings, and an alarm on the sensor.
await orden({ orden: "vigilar", num: CASETA });
await orden({ orden: "vigilar", num: ME });
for (const [t, h] of [[22.1, 63], [23.4, 61], [24.0, 60], [26.2, 58]]) { nodo.ambiente(CASETA, { temperature: t, relativeHumidity: h }); await sleep(150); }
// The receiver as a weather station: many readings, some long (they must fit in their boxes).
nodo.ambiente(ME, { temperature: 19.6, relativeHumidity: 55, barometricPressure: 1014.8, windSpeed: 3.4, windGust: 12.9, rainfall1h: 0.4, rainfall24h: 112.6, lux: 12450, voltage: 4.12 });
nodo.ambiente(AVISADO, { temperature: 17.2, relativeHumidity: 70 });
// Somewhere inland, for the map (an invented place).
nodo.posicion(ME, 39.1513, -3.4352);
nodo.posicion(CASETA, 39.1604, -3.4521);
nodo.posicion(AVISADO, 39.1388, -3.4189);
await orden({ orden: "limite", num: CASETA, metrica: "temperature", lado: "max", valor: 30 });
nodo.ambiente(CASETA, { temperature: 31.4, relativeHumidity: 57 });
await sleep(800);
// Two automations: one on a reading, one at a time of day (nothing reaches a real mesh: the node is simulated).
const es = lang === "es";
for (const auto of [
  { name: es ? "Calor en la caseta" : "Hot in the shed", when: { type: "value", num: CASETA, key: "temperature", op: "above", value: 30, for: 10 }, steps: [
    { type: "message", to: { channel: 1 }, text: es ? "Calor en la caseta: {valor}" : "Hot in the shed: {value}" }, { type: "wait", seconds: 900 }, { type: "ask", num: CASETA, what: "env" }] },
  { name: es ? "Datos de la mañana" : "Morning data", on: false, when: { type: "time", at: "07:30", days: [1, 2, 3, 4, 5] }, steps: [
    { type: "ask", num: CASETA, what: "device" }, { type: "message", to: { node: AVISADO }, text: es ? "Buenos días, son las {hora}" : "Good morning, it's {time}" }] },
]) {
  const r = await orden({ orden: "automation", auto });
  if (!r.ok) throw new Error(`automation: ${r.error}`);
}

/** Readings that don't fit in their box: the figure wider than its box, or sticking out of it. */
function overflow(page, box, val) {
  return page.evaluate(([box, val]) => [...document.querySelectorAll(val)].flatMap((v) => {
    const b = v.closest(box).getBoundingClientRect(), r = v.getBoundingClientRect();
    return v.scrollWidth > v.clientWidth + 1 || r.right > b.right + 0.5 ? [`«${v.textContent}» does not fit (${Math.round(v.scrollWidth)} > ${Math.round(v.clientWidth)} px)`] : [];
  }), [box, val]);
}

const errors = [];
for (const size of Object.keys(SIZES)) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext(opciones(size, scheme));
    await ctx.addCookies([{ name: "talaia_sesion", value: SESION, url: URL0 }]);
    await ctx.route(/openstreetmap\.org/, (r) => r.abort());
    await ctx.addInitScript((l) => { try { localStorage.setItem("talaia.lang", l); } catch { /* none */ } }, lang);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${size}/${scheme}: ${e.message}`));
    await page.goto(URL0);
    await sleep(900);
    for (const v of VIEWS) {
      const file = path.join(out, `${size}-${scheme}-${v}.png`);
      if (v === "signin") {
        const c = await browser.newContext(opciones(size, scheme)); // without the session
        await c.addInitScript((l) => { try { localStorage.setItem("talaia.lang", l); } catch { /* none */ } }, lang);
        const p = await c.newPage();
        await p.goto(URL0);
        await sleep(600);
        await p.screenshot({ path: file });
        await c.close();
        continue;
      }
      if (v === "sheet" || v === "receiver") {
        // The whole sheet: without its height limit, so one picture shows all of it.
        await page.evaluate(() => { location.hash = "#/dashboard"; });
        await sleep(200);
        await page.click(`#cards .name-btn[data-open="${v === "sheet" ? CASETA : ME}"]`);
        await sleep(600);
        await page.addStyleTag({ content: "dialog.sheet { max-height: none !important; } .sheet-b { overflow: visible !important; }" });
        await page.locator("#detail").screenshot({ path: file });
        await page.keyboard.press("Escape");
        await sleep(200);
        continue;
      }
      if (v === "automation") {
        await page.evaluate(() => { location.hash = "#/automations"; });
        await sleep(300);
        await page.click("[data-au-edit]");
        await sleep(400);
        await page.click('[data-au-add="switch"]');
        await sleep(200);
        await page.addStyleTag({ content: "dialog.sheet { max-height: none !important; } .sheet-b { overflow: visible !important; }" });
        await page.locator("#autoEd").screenshot({ path: file });
        await page.keyboard.press("Escape");
        await sleep(200);
        continue;
      }
      if (v === "full") {
        for (const [num, name] of [[CASETA, "full"], [ME, "full-receiver"]]) {
          await page.evaluate((x) => { location.hash = "#/dashboard"; document.querySelector(`#cards [data-full="${x}"]`)?.click(); }, num);
          await sleep(800);
          errors.push(...(await overflow(page, ".nv-tile", ".nv-v")).map((e) => `${size}/${scheme}/${name}: ${e}`));
          await page.screenshot({ path: path.join(out, `${size}-${scheme}-${name}.png`) });
          await page.keyboard.press("Escape");
          await sleep(200);
        }
        continue;
      }
      if (v === "settings") {
        for (const part of ["mesh", "mqtt", "receiver", "system", "users", "screen"]) {
          await page.evaluate((x) => { location.hash = `#/settings/${x}`; }, part);
          await sleep(400);
          await page.screenshot({ path: path.join(out, `${size}-${scheme}-settings-${part}.png`), fullPage: true });
        }
        continue;
      }
      await page.evaluate((x) => { location.hash = `#/${x}`; }, v);
      await sleep(v === "map" ? 900 : 350);
      if (v === "dashboard") {
        errors.push(...(await overflow(page, ".rd", ".rd-v")).map((e) => `${size}/${scheme}/dashboard: ${e}`));
        // and with every card collapsed
        await page.click("[data-cards-all]");
        await sleep(300);
        await page.screenshot({ path: path.join(out, `${size}-${scheme}-dashboard-collapsed.png`), fullPage: true });
        await page.click("[data-cards-all]");
        await sleep(300);
      }
      await page.screenshot({ path: file, fullPage: v !== "map" });
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
