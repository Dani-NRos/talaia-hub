// Recorre la app en modo demo con el reloj congelado y guarda capturas y textos, para comparar antes y después.
// Uso: node capturar.mjs <carpeta dist/app> <carpeta de salida>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""); // codigo/
// Playwright no va en el repo: el que haya instalado (PLAYWRIGHT_DIR = carpeta node_modules que lo contiene).
const PW_DIR = process.env.PLAYWRIGHT_DIR || "/opt/npm-tools/node_modules/";
const require = createRequire(PW_DIR);
const { chromium } = require("playwright");

const [dist, out] = process.argv.slice(2);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const srv = http.createServer((req, res) => {
  const p = path.join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
}).listen(0);
const port = srv.address().port;

const T0 = new Date("2026-10-18T09:00:00+02:00").getTime();
const browser = await chromium.launch();
const log = [];

async function run(name, setup, steps) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "es-ES", timezoneId: "Europe/Madrid", serviceWorkers: "block" });
  await ctx.route(/openstreetmap\.org|fonts\.googleapis|fonts\.gstatic/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log.push(`[${name}] ERROR ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") log.push(`[${name}] console ${m.text()}`); });
  await page.clock.install({ time: T0 - 1000 });
  await page.clock.pauseAt(T0);
  if (setup) await page.addInitScript(setup);
  await page.goto(`http://localhost:${port}/`);
  for (let k = 0; k < 100 && !(await page.$(".card")); k++) { await page.clock.runFor(50); await new Promise((r) => setTimeout(r, 50)); }
  await new Promise((r) => setTimeout(r, 300));
  await page.clock.runFor(500);
  let i = 0;
  const shot = async (label) => {
    await new Promise((r) => setTimeout(r, 150)); // promesas e IndexedDB, que no dependen del reloj
    const f = `${name}-${String(++i).padStart(2, "0")}-${label}`;
    await page.screenshot({ path: path.join(out, `${f}.png`), fullPage: true, animations: "disabled", caret: "hide" });
    const txt = await page.evaluate(() => {
      const open = [...document.querySelectorAll("dialog[open]")].map((d) => `## dialog#${d.id}\n${d.innerText}`);
      return `${document.querySelector("main, body").innerText}\n${open.join("\n")}`;
    });
    fs.writeFileSync(path.join(out, `${f}.txt`), txt);
  };
  await steps(page, shot);
  const ls = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])));
  fs.writeFileSync(path.join(out, `${name}-localStorage.json`), JSON.stringify(ls, null, 1));
  await ctx.close();
}

const CASETA = 0x3c6e19a2, GARAJE = 0x5d20b7f1, MONTE = 0x7e4410c8;

// 1. Demo: panel, ficha, peticiones, ruta, ajustes, avisos por la malla, enterado, mapa, pantalla completa.
await run("demo", null, async (page, shot) => {
  await shot("panel");
  await page.click(`.card [data-open="${CASETA}"] , .card[data-open="${CASETA}"] .name-btn`);
  await page.clock.runFor(300);
  await shot("ficha-caseta");
  await page.click(`#detail [data-ask="env"][data-num="${CASETA}"]`);
  await page.clock.runFor(200);
  await shot("pidiendo-ambiente");
  await page.clock.runFor(8000);
  await shot("ambiente-recibido");
  await page.click(`#detail [data-ask="route"][data-num="${CASETA}"]`);
  await page.clock.runFor(15000);
  await shot("ruta");
  await page.click(`#detail [data-ask="route"][data-num="${CASETA}"]`);
  await page.clock.runFor(300);
  await shot("ruta-antes-de-30s");
  await page.click(`#detail [data-ask="info"][data-num="${CASETA}"]`);
  await page.clock.runFor(8000);
  await shot("ficha-pedida");
  await page.click(`#detail [data-ask="info"][data-num="${CASETA}"]`);
  await page.clock.runFor(300);
  await shot("ficha-repetida-aviso");
  await page.click(`#detail [data-ask="pos"][data-num="${CASETA}"]`);
  await page.clock.runFor(8000);
  await shot("posicion");
  await page.keyboard.press("Escape");
  await page.clock.runFor(300);
  // Ajustes y avisos por la malla
  await page.click("#setBtn");
  await page.clock.runFor(300);
  await shot("ajustes");
  await page.check("#meshOn", { force: true });
  await page.selectOption("#meshCh", "1");
  await page.selectOption("#meshNode", String(GARAJE));
  await page.check("#meshClear", { force: true });
  await page.clock.runFor(300);
  await page.click("[data-mesh-test]");
  await page.clock.runFor(1500);
  await shot("aviso-prueba-1");
  await page.clock.runFor(10000);
  await shot("aviso-prueba-2");
  await page.keyboard.press("Escape");
  await page.clock.runFor(300);
  // Pasa el tiempo: lecturas nuevas de la demo, alarmas que saltan o se cierran, avisos por la malla.
  for (let k = 0; k < 30; k++) await page.clock.runFor(12000);
  await shot("tras-6-min");
  const ack = await page.$("[data-ackall]") || await page.$("[data-ack]");
  if (ack) { await ack.click(); await page.clock.runFor(300); }
  await shot("enterado");
  for (let k = 0; k < 150; k++) await page.clock.runFor(12000);
  await shot("tras-36-min");
  await page.click("#setBtn");
  await page.clock.runFor(300);
  await shot("ajustes-registro");
  await page.keyboard.press("Escape");
  await page.click("#mapBtn");
  await page.clock.runFor(1500);
  await shot("mapa");
  await page.keyboard.press("Escape");
  await page.clock.runFor(300);
  await page.click(`.card[data-open="${MONTE}"] .name-btn, [data-open="${MONTE}"]`);
  await page.clock.runFor(300);
  await shot("ficha-monte");
});

// 2. Modo real con datos guardados (sin receptor): se cargan igual y se ven igual.
const saved = {
  "vigia.ever": true,
  "vigia.my": 0xa1b2c3d4,
  "vigia.settings": { sound: true, wake: false, retentionDays: 30, defaultOfflineMin: 75, mesh: { enabled: true, channel: 1, node: null, onClear: false } },
  "vigia.cfg": { watched: { [CASETA]: { rules: { temperature: { min: 2, max: 30, trend: { dir: "up", delta: 5, hours: 1 } }, batteryLevel: { min: 20 } }, offlineMin: 60, fence: { lat: 39.15, lon: -0.44, r: 300, at: T0 - 86400000 } } } },
  "vigia.nodes": [
    { num: 0xa1b2c3d4, short: "RX", long: "Receptor casa", hw: "RAK4631", lastHeard: T0 - 60000, hops: 0, snr: null, metrics: {}, hasEnv: false },
    { num: CASETA, short: "CAS", long: "Caseta", hw: "HELTEC_V3", lastHeard: T0 - 20 * 60000, hops: 2, snr: 4.5, channel: 1, key: true, hasEnv: true,
      metrics: { temperature: { v: 31.2, t: T0 - 20 * 60000 }, relativeHumidity: { v: 55, t: T0 - 20 * 60000 }, batteryLevel: { v: 18, t: T0 - 20 * 60000 } },
      pos: { lat: 39.1551, lon: -0.4412, t: T0 - 3600000, alt: 40, bits: 32, src: 2 } },
    { num: GARAJE, short: "GAR", long: "Garaje", hw: "RAK4631", lastHeard: T0 - 5 * 60000, hops: 1, snr: 6, channel: 0, key: true, hasEnv: true,
      metrics: { temperature: { v: 19.5, t: T0 - 5 * 60000 }, barometricPressure: { v: 1013, t: T0 - 5 * 60000 } },
      pos: { lat: 39.16, lon: -0.43, t: T0 - 3600000, bits: 32, src: 2 } },
  ],
  "vigia.active": [
    { key: `${CASETA}|temperature|high`, num: CASETA, metric: "temperature", kind: "high", value: 31.2, limit: 30, t: T0 - 20 * 60000, since: T0 - 20 * 60000, acked: false, late: false },
    { key: `${CASETA}|batteryLevel|low`, num: CASETA, metric: "batteryLevel", kind: "low", value: 18, limit: 20, t: T0 - 20 * 60000, since: T0 - 20 * 60000, acked: true, late: true },
  ],
  "vigia.log": [{ t: T0 - 20 * 60000, type: "raise", text: "Caseta · Temperatura por encima de 30 °C", num: CASETA }],
  "vigia.channels": [{ index: 0, name: "SFNarrow", primary: true, private: false, why: "clave pública por defecto" }, { index: 1, name: "avisos", primary: false, private: true, why: "" }],
  "vigia.lora": { usePreset: false, modemPreset: 0, spreadFactor: 7, hopLimit: 6 },
  "vigia.traces": { [CASETA]: { t: T0 - 7200000, ms: 9000, fwd: { nodes: [0xa1b2c3d4, 0x11223344, CASETA], snr: [6.25, -3] }, back: { nodes: [CASETA, 0xa1b2c3d4], snr: [-12.5] } } },
};
await run("real", `(() => { const s = ${JSON.stringify(saved)}; for (const [k, v] of Object.entries(s)) if (localStorage.getItem(k) == null) localStorage.setItem(k, JSON.stringify(v)); })()`, async (page, shot) => {
  await shot("panel");
  await page.click(`.card[data-open="${CASETA}"] .name-btn`);
  await page.clock.runFor(500);
  await shot("ficha");
  await page.keyboard.press("Escape");
  await page.click("[data-ack]");
  await page.clock.runFor(300);
  await shot("enterado");
  await page.click("#setBtn");
  await page.clock.runFor(300);
  await shot("ajustes");
  // Ajustes que cambian el estado guardado.
  const cambia = async (sel, val) => { await page.fill(sel, val); await page.dispatchEvent(sel, "change"); await page.clock.runFor(300); };
  await cambia("#setOff", "0");
  await cambia("#setOff", "90");
  await page.check("#meshOn", { force: true }); await page.clock.runFor(200);
  await page.selectOption("#meshCh", "1"); await page.clock.runFor(200);
  await page.selectOption("#meshNode", String(GARAJE)); await page.clock.runFor(200);
  await page.check("#meshClear", { force: true }); await page.clock.runFor(200);
  await shot("ajustes-cambiados");
  await page.keyboard.press("Escape");
  await page.clock.runFor(300);
  // Ficha de un nodo vigilado: sin señal, límites, cambio rápido, valla.
  await page.click(`.card[data-open="${CASETA}"] .name-btn`);
  await page.clock.runFor(500);
  await cambia("#r-off", "30");
  await shot("sin-senal-30");
  await cambia("#r-temperature-max", "abc");
  await shot("limite-no-numero");
  await cambia("#r-temperature-max", "25");
  await cambia("#r-temperature-min", "26");
  await shot("limite-min-mayor");
  await cambia("#r-temperature-min", "5");
  await cambia("#r-relativeHumidity-max", "80,5");
  await shot("limites-guardados");
  await page.selectOption("#tr-metric", "temperature"); await page.clock.runFor(100);
  await page.selectOption("#tr-dir", "up");
  await page.fill("#tr-delta", "3"); await page.fill("#tr-hours", "2");
  await page.click("[data-trend-add]"); await page.clock.runFor(300);
  await shot("tendencia-anadida");
  await page.click('[data-trend-del="temperature"]'); await page.clock.runFor(300);
  await shot("tendencia-quitada");
  await cambia("#fence-r", "10");
  await page.click(`[data-fence-del="${CASETA}"]`); await page.clock.runFor(300);
  await shot("valla-quitada");
  await page.fill("#fence-r", "10"); await page.click(`[data-fence-set="${CASETA}"]`); await page.clock.runFor(300);
  await page.fill("#fence-r", "150"); await page.click(`[data-fence-set="${CASETA}"]`); await page.clock.runFor(300);
  await shot("valla-fijada");
  await cambia("#fence-r", "250");
  await shot("valla-radio");
  await page.click(`[data-unwatch="${CASETA}"]`); await page.clock.runFor(200);
  await page.click(`[data-unwatch="${CASETA}"]`); await page.clock.runFor(500);
  await shot("dejar-de-vigilar");
  await page.keyboard.press("Escape");
  await page.clock.runFor(300);
  await page.click(`[data-watch="${GARAJE}"]`); await page.clock.runFor(800);
  await shot("vigilar-garaje");
});

fs.writeFileSync(path.join(out, "errores.txt"), log.join("\n"));
await browser.close();
srv.close();
console.log(`${fs.readdirSync(out).length} ficheros · errores: ${log.length}`);
