// The scroll must stay where it is: in a node's sheet (inside its dialog) and in Settings (the page), whatever the
// server sends meanwhile. With a simulated node and the real server; nothing reaches a real mesh.
// Usage: npm run build && node herramientas/scroll.mjs     (exit code 1 if something fails)
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
const datos = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-scroll-"));
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
nodo.ambiente(CASETA, { temperature: 22.1, relativeHumidity: 63 });
nodo.ambiente(ME, { temperature: 19.6, relativeHumidity: 55, barometricPressure: 1014.8 });
await sleep(400);
// An alarm on the other node: each of its readings sends `active` again, to every screen.
await orden({ orden: "limite", num: ME, metrica: "temperature", lado: "max", valor: 10 });
nodo.ambiente(ME, { temperature: 19.7 });
await sleep(500);

const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

const browser = await pw.chromium.launch();
// A small window, so there is something to scroll.
const ctx = await browser.newContext({ viewport: { width: 390, height: 520 }, locale: "es-ES" });
await ctx.addCookies([{ name: "talaia_sesion", value: SESION, url: URL0 }]);
await ctx.addInitScript(() => { try { localStorage.setItem("talaia.lang", "es"); } catch { /* none */ } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(URL0);
await sleep(900);

// ── The sheet ──
await page.evaluate(() => { location.hash = "#/dashboard"; });
await sleep(200);
await page.click(`#cards .name-btn[data-open="${CASETA}"]`);
await sleep(600);
const body = () => page.evaluate(() => { const b = document.querySelector("#detail .sheet-b"); return { top: b.scrollTop, mark: b.dataset.mark }; });
const scrollTo400 = () => page.evaluate(() => { const b = document.querySelector("#detail .sheet-b"); b.dataset.mark = "x"; b.scrollTop = 400; return b.scrollTop; });
check((await scrollTo400()) === 400, "the sheet is long enough to scroll");

for (let i = 0; i < 3; i++) { nodo.ambiente(ME, { temperature: 20 + i }); await sleep(450); }
let s = await body();
check(s.top === 400, `another node's readings (alarm on) leave the scroll where it was (${s.top})`);
check(s.mark === "x", "…and don't repaint the sheet");

for (let i = 0; i < 2; i++) { nodo.ambiente(CASETA, { temperature: 23 + i }); await sleep(450); }
s = await body();
check(s.top === 400, `its own readings leave the scroll where it was (${s.top})`);

await orden({ orden: "limite", num: CASETA, metrica: "temperature", lado: "max", valor: 40 });
await sleep(600);
s = await body();
check(s.mark !== "x", "a change in its own limits repaints the sheet");
check(s.top === 400, `…and the scroll stays (${s.top})`);
await page.keyboard.press("Escape");
await sleep(200);

// Opening it again starts at the top.
await page.click(`#cards .name-btn[data-open="${CASETA}"]`);
await sleep(600);
s = await body();
check(s.top === 0, `opening the sheet again starts at the top (${s.top})`);
await page.keyboard.press("Escape");
await sleep(200);

// ── Settings: the page ──
for (const [tab, trigger] of [
  ["system", () => orden({ orden: "retencion", dias: 301 })],
  ["receiver", () => orden({ orden: "renombrar", num: ME, nombre: "Rx" })],
]) {
  await page.evaluate((x) => { location.hash = `#/settings/${x}`; }, tab);
  await sleep(500);
  const before = await page.evaluate(() => { document.querySelector("#settings .tab-b").dataset.mark = "x"; window.scrollTo(0, 250); return window.scrollY; });
  await trigger();
  await sleep(700);
  const after = await page.evaluate(() => ({ y: window.scrollY, repainted: document.querySelector("#settings .tab-b").dataset.mark !== "x" }));
  check(before === 250 && after.y === 250, `Settings → ${tab}: scroll stays (${before} → ${after.y})${after.repainted ? "" : " (it was not repainted)"}`);
}

check(errors.length === 0, `no errors on the page${errors.length ? `: ${errors.join(" | ")}` : ""}`);
await browser.close();
srv.kill();
process.exit(fails.length ? 1 : 0);
