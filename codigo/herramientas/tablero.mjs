// The alarm notice of the dashboard: with an unseen alarm it can't be folded; once every alarm is seen it folds to
// one line (the size of «all clear»), the device remembers it, a new alarm unfolds it, and Alarms keeps the whole
// list. With the real server and a simulated node; nothing reaches a real mesh.
// Usage: npm run build && node herramientas/tablero.mjs [output folder for screenshots]   (exit 1 if something fails)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const pw = createRequire(process.env.PLAYWRIGHT_DIR || "/opt/npm-tools/node_modules/")("playwright");
const { NodoFalso, ME, CASETA } = await import(`${REPO}/servidor/test/nodo-falso.mjs`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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


await orden({ orden: "vigilar", num: CASETA });
await orden({ orden: "limite", num: CASETA, metrica: "temperature", lado: "max", valor: 30 });
nodo.ambiente(CASETA, { temperature: 33, relativeHumidity: 50 });
await sleep(800);
const browser = await pw.chromium.launch();
const out = process.argv[2];
if (out) fs.mkdirSync(out, { recursive: true });
const snap = (page, name) => (out ? page.screenshot({ path: path.join(out, `${name}.png`) }) : Promise.resolve());
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
for (const [name, viewport] of [["pc", { width: 1100, height: 700 }], ["movil", { width: 390, height: 800 }]]) {
  const ctx = await browser.newContext({ viewport, locale: "es-ES" });
  await ctx.addCookies([{ name: "talaia_sesion", value: SESION, url: URL0 }]);
  await ctx.addInitScript(() => { try { localStorage.setItem("talaia.lang", JSON.stringify("es")); } catch {} });
  await orden({ orden: "limite", num: CASETA, metrica: "temperature", lado: "max", valor: 30 });
  nodo.ambiente(CASETA, { temperature: 33, relativeHumidity: 50 });
  await sleep(800);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => fails.push(e.message));
  await page.goto(URL0);
  await sleep(900);
  const h = async (sel) => page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().height ?? 0, sel);
  check(!(await page.$("#board [data-board-toggle]")), `${name}: an unseen alarm has no fold button`);
  await snap(page, `${name}-1-crit`);
  await page.click("#board [data-ack]");
  await sleep(500);
  check(!!(await page.$("#board [data-board-toggle]")), `${name}: once seen, the fold button shows`);
  const tall = await h("#board .board");
  await snap(page, `${name}-2-seen`);
  await page.click("#board [data-board-toggle]");
  await sleep(400);
  const folded = await h("#board .board");
  await snap(page, `${name}-3-folded`);
  check(folded < tall && (await page.$("#board .board.min")), `${name}: folded to one line (${Math.round(tall)} → ${Math.round(folded)} px)`);
  check(!(await page.$("#alarmBoard .board.min")), `${name}: Alarms keeps the whole list`);
  // A new unseen alarm unfolds it; after seeing it, it is folded again (the device remembers).
  nodo.ambiente(ME, { temperature: 19 });
  await orden({ orden: "limite", num: ME, metrica: "temperature", lado: "max", valor: 10 });
  await sleep(900);
  check(!!(await page.$("#board .board.crit")) && !(await page.$("#board .board.min")), `${name}: a new alarm unfolds it`);
  await page.click("#board [data-ackall], #board [data-ack]");
  await sleep(600);
  const again = await page.$("#board .board.min");
  check(!!again, `${name}: seen again, it is folded as this device left it`);
  // All clear: the calm board has the same height as the folded one.
  await orden({ orden: "limite", num: ME, metrica: "temperature", lado: "max", valor: null });
  await orden({ orden: "limite", num: CASETA, metrica: "temperature", lado: "max", valor: null });
  await sleep(900);
  const calm = await h("#board .board.calm:not(.min)");
  check(Math.abs(calm - folded) <= 2, `${name}: «all clear» and the folded notice take the same space (${Math.round(calm)} / ${Math.round(folded)} px)`);
  await snap(page, `${name}-4-calm`);
  await ctx.close();
}
await browser.close();
srv.kill();
process.exit(fails.length ? 1 : 0);
