// Settings → Telegram from the screen, against a fake Bot API: the token is saved and checked, the pairing code shows,
// a chat pairs with it and appears in the list, the test message goes out, a chat is removed and the token too.
// Usage: npm run build && node herramientas/telegram.mjs [output folder for screenshots]   (exit 1 if something fails)
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const pw = createRequire(process.env.PLAYWRIGHT_DIR || "/opt/npm-tools/node_modules/")("playwright");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });
const TOKEN = "123456789:AAHfakeTOKENfakeTOKENfakeTOKEN01";

// The fake Bot API (see servidor/test/telegram.test.mjs for the full one).
const sent = [];
let pending = [], waiter = null, nextId = 1;
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
    const reply = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (!m || m[1] !== TOKEN) return reply({ ok: false, error_code: 401, description: "Unauthorized" });
    const method = m[2], body = raw ? JSON.parse(raw) : {};
    sent.push({ method, body });
    if (method === "getMe") return reply({ ok: true, result: { id: 1, is_bot: true, username: "talaia_demo_bot" } });
    if (method === "getUpdates") {
      const give = () => { if (res.writableEnded) return; const out = pending.filter((u) => u.update_id >= (body.offset || 0)); pending = []; reply({ ok: true, result: out }); };
      if (pending.length) return give();
      waiter = give;
      setTimeout(() => { if (waiter === give) { waiter = null; give(); } }, (body.timeout || 1) * 1000);
      return;
    }
    if (method === "sendMessage") return reply({ ok: true, result: { message_id: nextId++, chat: { id: body.chat_id } } });
    reply({ ok: true, result: true });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const push = (u) => { pending.push({ update_id: nextId++, ...u }); if (waiter) { const w = waiter; waiter = null; w(); } };
const msgs = (chatId) => sent.filter((x) => x.method === "sendMessage" && x.body.chat_id === chatId).map((x) => x.body.text);

const datos = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-tg-"));
const WEB = 40000 + Math.floor(Math.random() * 9000);
const cfgFile = path.join(datos, "servidor.json");
fs.writeFileSync(cfgFile, JSON.stringify({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: 1 }, web: { puerto: WEB }, datos, registro: "aviso" }));
const srv = spawn(process.execPath, [`${REPO}/servidor/src/main.js`, "--config", cfgFile], { env: { ...process.env, TZ: "Europe/Madrid", LANG: "es_ES.UTF-8", TALAIA_TELEGRAM_API: `http://127.0.0.1:${fake.address().port}` }, stdio: "ignore" });
const URL0 = `http://127.0.0.1:${WEB}/`;
for (let i = 0; i < 100; i++) { try { if ((await (await fetch(`${URL0}api/salud`)).json()).ok) break; } catch { /* not yet */ } await sleep(100); }
const codigo = fs.readFileSync(path.join(datos, "primer-usuario.txt"), "utf8").trim();
const alta = await fetch(`${URL0}api/primero`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codigo, nombre: "Dani", clave: "clave-de-prueba" }) });
const SESION = /talaia_sesion=([^;]+)/.exec(alta.headers.get("set-cookie") || "")?.[1];
if (!SESION) throw new Error(`no session: ${alta.status}`);

const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: "es-ES" });
await ctx.addCookies([{ name: "talaia_sesion", value: SESION, url: URL0 }]);
await ctx.addInitScript(() => { try { localStorage.setItem("talaia.lang", JSON.stringify("es")); } catch { /* none */ } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${URL0}#/settings/telegram`);
await sleep(900);
const snap = async (n) => { if (shots) await page.screenshot({ path: path.join(shots, `${n}.png`), fullPage: true }); };
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent || "", sel);
const wait = async (f, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(100); } return false; };

check(/Sin bot todavía/.test(await text("#tgState")) && (await page.isDisabled("#tgOn")), "without a token: off, and the switch can't be turned on");
await snap("1-sin-bot");
// A wrong token is refused with the reason, and nothing is kept.
await page.fill("#tgToken", "hola");
await page.click("[data-tg-save]");
await wait(async () => /BotFather/.test(await text("#tgErr")));
check(/BotFather/.test(await text("#tgErr")), "a token that doesn't look like one is refused");
await page.fill("#tgToken", TOKEN);
await page.click("[data-tg-save]");
check(await wait(async () => /Conectado como @talaia_demo_bot/.test(await text("#tgState"))), "a good token: saved, checked with Telegram and on");
check((await page.inputValue("#tgToken")) === "" && /guardado/.test(await page.getAttribute("#tgToken", "placeholder")), "the token is not shown back");
const code = (await text("#tgCode")).trim();
check(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), `the pairing code shows (${code})`);
check(await page.isDisabled("[data-tg-test]"), "no test message without a chat");
await snap("2-con-bot");
// Another code; then a chat pairs with it and shows up in the list by itself.
await page.click("[data-tg-code]");
await wait(async () => (await text("#tgCode")).trim() !== code);
const code2 = (await text("#tgCode")).trim();
check(code2 !== code, "«Another code» gives a new one");
push({ message: { message_id: 1, from: { id: 42, first_name: "Ana" }, chat: { id: 42, type: "private", first_name: "Ana" }, text: `/start ${code2}` } });
check(await wait(async () => /Ana/.test(await text("#tgBox .tg-l"))), "the chat that sent the code appears in the list");
check(await wait(async () => (await text("#tgCode")).trim() !== code2), "…and the code changed");
push({ message: { message_id: 2, from: { id: 7, first_name: "Luis" }, chat: { id: -1001, type: "supergroup", title: "Finca" }, text: `/start@talaia_demo_bot ${(await text("#tgCode")).trim()}` } });
check(await wait(async () => /Finca.*grupo/.test(await text("#tgBox .tg-l"))), "a group too, marked as such");
await snap("3-chats");
await page.click("[data-tg-test]");
check(await wait(async () => msgs(42).some((t) => /Prueba desde Talaia/.test(t)) && msgs(-1001).some((t) => /Prueba desde Talaia/.test(t))), "the test message reaches both");
await page.click('[data-tg-del="42"]');
check(await wait(async () => !/Ana/.test(await text("#tgBox .tg-l"))), "a chat can be removed");
// Off and on with the switch; removing the bot clears it all.
await page.click("label[for=tgOn]");
const off = await wait(async () => /Apagado/.test(await text("#tgState")));
check(off, "the switch turns it off");
await page.click("label[for=tgOn]");
check(await wait(async () => /Conectado/.test(await text("#tgState"))), "…and on again");
await page.click("[data-tg-notoken]");
check(await wait(async () => /Sin bot todavía/.test(await text("#tgState"))), "«Remove the bot» leaves it without a token");
check(errors.length === 0, `no errors on the page${errors.length ? `: ${errors.join(" | ")}` : ""}`);
await browser.close();
srv.kill();
fake.close();
fake.closeAllConnections();
process.exit(fails.length ? 1 : 0);
