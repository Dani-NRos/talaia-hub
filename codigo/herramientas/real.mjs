// Recorre la app en modo REAL con un nodo simulado por cable USB (Web Serial falso dentro de Chrome).
// El script hace de firmware: contesta a la configuración, manda telemetría y contesta a peticiones y avisos.
// Guarda capturas, textos, localStorage y lo que la app mandó al nodo, para comparar dos compilaciones.
// Uso: node real.mjs <carpeta dist/app> <carpeta de salida>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""); // codigo/
// Playwright no va en el repo: el que haya instalado (PLAYWRIGHT_DIR = carpeta node_modules que lo contiene).
const PW_DIR = process.env.PLAYWRIGHT_DIR || "/opt/npm-tools/node_modules/";
const pw = createRequire(PW_DIR)("playwright");
const { create, toBinary, fromBinary } = createRequire(`${REPO}/servidor/`)("@bufbuild/protobuf");
const { Protobuf } = await import(`${REPO}/node_modules/@meshtastic/core/dist/mod.js`);
const { createFramer, frame } = await import(`${REPO}/nucleo/src/tramas.js`);
const M = Protobuf.Mesh, PORT = Protobuf.Portnums.PortNum, TEL = Protobuf.Telemetry;

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

const T0 = new Date("2026-10-18T09:00:00+02:00").getTime();
const ME = 0xa1b2c3d4, CASETA = 0x3c6e19a2, AVISADO = 0x5d20b7f1, VECINO = 0x11223344;
const KEY = (b) => new Uint8Array(32).fill(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "es-ES", timezoneId: "Europe/Madrid", serviceWorkers: "block" });
await ctx.route(/openstreetmap\.org|fonts\.googleapis|fonts\.gstatic/, (r) => r.abort());
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`ERROR ${e.message}`));

/* ── lo que la app manda al nodo ── */
const framer = createFramer();
const tx = []; // ToRadio decodificados
let seen = 0;
await page.exposeFunction("__vigiaTx", (arr) => {
  for (const it of framer.push(new Uint8Array(arr))) {
    if (it.type !== "packet") continue;
    const m = fromBinary(M.ToRadioSchema, it.data);
    if (m.payloadVariant.case === "heartbeat") continue;
    tx.push(m);
  }
});
await page.addInitScript(() => {
  let rctrl = null;
  const port = {
    readable: null, writable: null,
    getInfo: () => ({ usbVendorId: 0x239a, usbProductId: 0x8029 }),
    async open() {
      this.readable = new ReadableStream({ start: (c) => { rctrl = c; } });
      this.writable = new WritableStream({ write: (chunk) => window.__vigiaTx(Array.from(chunk)) });
    },
    async close() { this.readable = null; this.writable = null; },
    addEventListener() {}, removeEventListener() {}, async forget() {},
  };
  window.__vigiaFeed = (arr) => rctrl?.enqueue(new Uint8Array(arr));
  Object.defineProperty(navigator, "serial", { value: { requestPort: async () => port, getPorts: async () => [port], addEventListener() {}, removeEventListener() {} } });
});
const saved = {
  "vigia.ever": true,
  "vigia.device": { kind: "serial", vid: 0x239a, pid: 0x8029, name: "DNN 5" },
  "vigia.settings": { sound: true, wake: false, retentionDays: 30, defaultOfflineMin: 75, mesh: { enabled: true, channel: 1, node: AVISADO, onClear: true } },
  "vigia.cfg": { watched: { [CASETA]: { offlineMin: 60, rules: { temperature: { max: 30 } } } } },
};
await page.addInitScript(`(() => { const s = ${JSON.stringify(saved)}; for (const [k, v] of Object.entries(s)) if (localStorage.getItem(k) == null) localStorage.setItem(k, JSON.stringify(v)); })()`);
await page.clock.install({ time: T0 - 1000 });
await page.clock.pauseAt(T0);

/* ── el «firmware» ── */
const feed = async (variant) => {
  const bytes = frame(toBinary(M.FromRadioSchema, create(M.FromRadioSchema, { payloadVariant: variant })));
  await page.evaluate((a) => window.__vigiaFeed(a), [...bytes]);
};
const now = () => page.evaluate(() => Date.now());
let pid = 9000;
const packet = async (p) => {
  const t = await now();
  await feed({ case: "packet", value: create(M.MeshPacketSchema, { id: ++pid, rxTime: Math.floor(t / 1000), rxSnr: 5.25, hopStart: 3, hopLimit: 2, to: ME, channel: 0, ...p }) });
};
const data = (portnum, payload, extra = {}) => ({ case: "decoded", value: create(M.DataSchema, { portnum, payload, ...extra }) });
const routing = (from, requestId, err = 0) => packet({ from, payloadVariant: data(PORT.ROUTING_APP, toBinary(M.RoutingSchema, create(M.RoutingSchema, { variant: { case: "errorReason", value: err } })), { requestId }) });
const telemetry = (from, kind, value, extra = {}) => packet({ from, to: 0xffffffff, payloadVariant: data(PORT.TELEMETRY_APP, toBinary(TEL.TelemetrySchema, create(TEL.TelemetrySchema, { time: 0, variant: { case: kind, value: create(TEL[kind[0].toUpperCase() + kind.slice(1) + "Schema"], value) } })), extra) });
const user = (num, longName, shortName, b) => create(M.UserSchema, { id: `!${num.toString(16).padStart(8, "0")}`, longName, shortName, hwModel: 43, publicKey: KEY(b) });

/** Avanza el reloj de la página hasta que la app mande algo que cumpla pred (o se acabe el tiempo de página). */
async function waitTx(pred, label, maxMs = 30000) {
  for (let t = 0; t <= maxMs; t += 100) {
    for (let i = seen; i < tx.length; i++) if (pred(tx[i])) { seen = i + 1; return tx[i]; }
    await page.clock.runFor(100);
    await sleep(15);
  }
  throw new Error(`no llegó: ${label}`);
}
const isPkt = (port, to) => (m) => m.payloadVariant.case === "packet" && m.payloadVariant.value.payloadVariant.value?.portnum === port && (to == null || m.payloadVariant.value.to === to);
const pk = (m) => m.payloadVariant.value;
const run = async (ms) => { const st = ms > 10000 ? 1000 : 100; for (let t = 0; t < ms; t += st) { await page.clock.runFor(Math.min(st, ms - t)); await sleep(10); } await sleep(100); };

let shotN = 0;
async function shot(label) {
  await sleep(200);
  const f = `real-${String(++shotN).padStart(2, "0")}-${label}`;
  await page.screenshot({ path: path.join(out, `${f}.png`), fullPage: true, animations: "disabled", caret: "hide" });
  const txt = await page.evaluate(() => `${document.body.innerText}\n${[...document.querySelectorAll("dialog[open]")].map((d) => `## dialog#${d.id}\n${d.innerText}`).join("\n")}`);
  fs.writeFileSync(path.join(out, `${f}.txt`), txt);
}

await page.goto(`http://localhost:${srv.address().port}/`);
await sleep(500);

// 1. Configuración inicial, como la manda el firmware.
const want = await waitTx((m) => m.payloadVariant.case === "wantConfigId", "petición de configuración");
await feed({ case: "myInfo", value: create(M.MyNodeInfoSchema, { myNodeNum: ME }) });
const t = Math.floor((await now()) / 1000);
await feed({ case: "nodeInfo", value: create(M.NodeInfoSchema, { num: ME, user: user(ME, "DNN 5", "DNN5", 1), lastHeard: t }) });
await feed({ case: "nodeInfo", value: create(M.NodeInfoSchema, { num: CASETA, user: user(CASETA, "Caseta huerto", "CAS", 2), lastHeard: t - 600, snr: 4.5, hopsAway: 1, deviceMetrics: create(TEL.DeviceMetricsSchema, { batteryLevel: 87, voltage: 4.01 }) }) });
await feed({ case: "nodeInfo", value: create(M.NodeInfoSchema, { num: AVISADO, user: user(AVISADO, "Garaje", "GAR", 3), lastHeard: t - 1200, snr: 7, hopsAway: 0 }) });
await feed({ case: "nodeInfo", value: create(M.NodeInfoSchema, { num: VECINO, user: user(VECINO, "Repetidor monte", "REP", 4), lastHeard: t - 300, snr: -2, hopsAway: 0 }) });
const CH = Protobuf.Channel;
await feed({ case: "channel", value: create(CH.ChannelSchema, { index: 0, role: CH.Channel_Role.PRIMARY, settings: create(CH.ChannelSettingsSchema, { name: "SFNarrow", psk: new Uint8Array([1]) }) }) });
await feed({ case: "channel", value: create(CH.ChannelSchema, { index: 1, role: CH.Channel_Role.SECONDARY, settings: create(CH.ChannelSettingsSchema, { name: "avisos", psk: KEY(9) }) }) });
await feed({ case: "channel", value: create(CH.ChannelSchema, { index: 2, role: CH.Channel_Role.DISABLED }) });
const CFG = Protobuf.Config;
await feed({ case: "config", value: create(CFG.ConfigSchema, { payloadVariant: { case: "lora", value: create(CFG.Config_LoRaConfigSchema, { usePreset: false, spreadFactor: 7, hopLimit: 6 }) } }) });
await feed({ case: "configCompleteId", value: want.payloadVariant.value });
await run(2000);
await shot("conectado");

// 2. Lectura en vivo por encima del límite: alarma y avisos por la malla (canal privado y nodo).
await telemetry(CASETA, "environmentMetrics", { temperature: 31.4, relativeHumidity: 64 });
const a1 = await waitTx(isPkt(PORT.TEXT_MESSAGE_APP), "aviso 1");
await routing(ME, pk(a1).id); // el receptor oye a un vecino repetirlo
const a2 = await waitTx(isPkt(PORT.TEXT_MESSAGE_APP), "aviso 2 (8 s después)");
await routing(ME, pk(a2).id);
await run(500);
await routing(AVISADO, pk(a2).id);
await run(1000);
await shot("alarma-y-avisos");
await page.click("#setBtn");
await run(300);
await shot("ajustes-ultimo-aviso");
await page.keyboard.press("Escape");
await page.click("[data-ack]");
await run(300);
await shot("enterado");
await run(4 * 60000);

// 3. Pedir datos de ambiente: acuse de un vecino, del nodo y respuesta con el reloj del receptor atrasado.
await page.click(`.card[data-open="${CASETA}"] .name-btn`);
await run(300);
await page.click(`#detail [data-ask="env"][data-num="${CASETA}"]`);
const q = await waitTx(isPkt(PORT.TELEMETRY_APP, CASETA), "petición de ambiente");
await run(1000);
await routing(VECINO, pk(q).id);
await run(1000);
await shot("pidiendo-acuse-vecino");
await routing(CASETA, pk(q).id);
await run(2000);
await shot("pidiendo-acuse-nodo");
const t2 = await now();
await packet({ from: CASETA, rxTime: Math.floor((t2 - 60000) / 1000), payloadVariant: data(PORT.TELEMETRY_APP, toBinary(TEL.TelemetrySchema, create(TEL.TelemetrySchema, { variant: { case: "environmentMetrics", value: create(TEL.EnvironmentMetricsSchema, { temperature: 29.5, relativeHumidity: 66 }) } })), { requestId: pk(q).id }) });
const c1 = await waitTx(isPkt(PORT.TEXT_MESSAGE_APP), "aviso de resuelta 1");
await routing(ME, pk(c1).id);
const c2 = await waitTx(isPkt(PORT.TEXT_MESSAGE_APP), "aviso de resuelta 2");
await routing(ME, pk(c2).id);
await run(90500); // el destino no confirma: «sin confirmar»
await shot("respuesta-y-resuelta");

// 4. Traceroute.
await page.click(`#detail [data-ask="route"][data-num="${CASETA}"]`);
const r = await waitTx(isPkt(PORT.TRACEROUTE_APP, CASETA), "traceroute");
await run(6000);
const rd = toBinary(M.RouteDiscoverySchema, create(M.RouteDiscoverySchema, { route: [VECINO], snrTowards: [24, 20], routeBack: [VECINO], snrBack: [16, 12] }));
await packet({ from: CASETA, payloadVariant: data(PORT.TRACEROUTE_APP, rd, { requestId: pk(r).id }) });
await run(1000);
await shot("ruta");

// 5. Ficha del nodo y un error de la malla.
await page.click(`#detail [data-ask="info"][data-num="${CASETA}"]`);
await waitTx(isPkt(PORT.NODEINFO_APP, CASETA), "petición de ficha");
await run(4000);
await packet({ from: CASETA, payloadVariant: data(PORT.NODEINFO_APP, toBinary(M.UserSchema, user(CASETA, "Caseta huerto", "CAS", 2))) });
await run(1000);
await page.click(`#detail [data-ask="power"][data-num="${CASETA}"]`);
const e = await waitTx(isPkt(PORT.TELEMETRY_APP, CASETA), "petición de energía");
await run(2000);
await routing(CASETA, pk(e).id, M.Routing_Error.NO_RESPONSE);
await run(1000);
await shot("ficha-y-error");
await page.keyboard.press("Escape");
await run(300);
await shot("panel-final");

/* ── resultados ── */
const ids = new Map();
const nid = (v) => { if (!v) return v; if (!ids.has(v)) ids.set(v, `#${ids.size + 1}`); return ids.get(v); };
const txOut = tx.map((m) => {
  const v = m.payloadVariant;
  if (v.case !== "packet") return { [v.case]: v.case === "wantConfigId" ? "…" : v.value };
  const p = v.value, d = p.payloadVariant.value;
  return { id: nid(p.id), to: p.to.toString(16), channel: p.channel, wantAck: p.wantAck, port: PORT[d.portnum], wantResponse: d.wantResponse,
    payload: d.portnum === PORT.TEXT_MESSAGE_APP ? new TextDecoder().decode(d.payload) : Buffer.from(d.payload).toString("hex") };
});
fs.writeFileSync(path.join(out, "enviado-al-nodo.json"), JSON.stringify(txOut, null, 1));
const ls = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])));
fs.writeFileSync(path.join(out, "real-localStorage.json"), JSON.stringify(ls, null, 1));
fs.writeFileSync(path.join(out, "errores.txt"), errors.join("\n"));
await browser.close();
srv.close();
console.log(`${fs.readdirSync(out).length} ficheros · ${tx.length} mensajes al nodo · errores: ${errors.length}`);
