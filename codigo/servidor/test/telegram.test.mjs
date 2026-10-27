// Telegram: a bot that tells the alarms and takes orders. Against a fake Bot API (an HTTP server here: getMe,
// getUpdates with long polling, sendMessage, answerCallbackQuery, editMessageReplyMarkup, setMyCommands), a fake
// Shelly on a broker in memory for the switch orders, and the usual simulated node for an alarm.
process.env.TZ = "Europe/Madrid";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { Aedes } from "aedes";
import mqtt from "mqtt";
import { crearTalaia } from "../src/talaia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { instantanea } from "../src/sincro.js";
import { NodoFalso, hasta, CASETA } from "./nodo-falso.mjs";

const TOKEN = "123456789:AAHfakeTOKENfakeTOKENfakeTOKEN01";
const ORDEN = { tema: "shellyplug01/command/switch:0", on: "on", off: "off" };

/** A fake Telegram Bot API: queues updates for the bot and keeps what it sends. */
async function telegramFalso(t, { badToken = false } = {}) {
  const sent = []; // every call: { method, body }
  let pending = [], waiter = null, nextId = 1, nextMsg = 100;
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
      const reply = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      if (!m || m[1] !== TOKEN || badToken) return reply({ ok: false, error_code: 401, description: "Unauthorized" });
      const method = m[2], body = raw ? JSON.parse(raw) : {};
      sent.push({ method, body });
      if (method === "getMe") return reply({ ok: true, result: { id: 1, is_bot: true, username: "talaia_test_bot" } });
      if (method === "getUpdates") {
        const give = () => { if (res.writableEnded) return; const out = pending.filter((u) => u.update_id >= (body.offset || 0)); pending = []; reply({ ok: true, result: out }); };
        if (pending.length) return give();
        waiter = give;
        setTimeout(() => { if (waiter === give) { waiter = null; give(); } }, (body.timeout || 1) * 1000);
        return;
      }
      if (method === "sendMessage") {
        if (body.chat_id === 666) return reply({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
        return reply({ ok: true, result: { message_id: nextMsg++, chat: { id: body.chat_id }, text: body.text } });
      }
      reply({ ok: true, result: true });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  // Talaia keeps asking (long polling), so the connection is never idle: cut it to close.
  t.after(() => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }));
  const push = (u) => { pending.push({ update_id: nextId++, ...u }); if (waiter) { const w = waiter; waiter = null; w(); } };
  const from = { id: 42, first_name: "Ana", last_name: "Pérez" };
  const api = {
    url: `http://127.0.0.1:${srv.address().port}`, sent,
    /** A text from a private chat or a group. */
    text: (chat, text, who = from) => push({ message: { message_id: nextMsg++, from: who, chat: chat.id === undefined ? { id: chat, type: "private", first_name: "Ana" } : chat, text } }),
    button: (chatId, data, who = from) => push({ callback_query: { id: `cb${nextId}`, from: who, message: { message_id: 1, chat: { id: chatId } }, data } }),
    left: (chatId) => push({ my_chat_member: { chat: { id: chatId, type: "group" }, new_chat_member: { status: "left" } } }),
    msgs: (chatId) => sent.filter((x) => x.method === "sendMessage" && (chatId == null || x.body.chat_id === chatId)).map((x) => x.body),
    last: (chatId) => api.msgs(chatId).at(-1),
    calls: (method) => sent.filter((x) => x.method === method).map((x) => x.body),
  };
  return api;
}

async function broker(t) {
  const aedes = await Aedes.createBroker();
  const srv = net.createServer(aedes.handle);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise((r) => aedes.close(r)); await new Promise((r) => srv.close(r)); });
  return srv.address().port;
}
async function shellyFalso(t, puerto, prefijo = "shellyplug01") {
  const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${puerto}`, { clientId: `shelly-${Math.random()}` });
  t.after(() => c.endAsync());
  await c.subscribeAsync(`${prefijo}/command/switch:0`);
  c.on("message", (tema, carga) => {
    const s = carga.toString();
    if (s === "on" || s === "off") c.publish(`${prefijo}/status/switch:0`, JSON.stringify({ id: 0, source: "MQTT", output: s === "on" }));
  });
  await c.publishAsync(`${prefijo}/status/switch:0`, JSON.stringify({ id: 0, output: false }), { retain: true });
}

async function montar(t, { tg, almacen = abrirAlmacen(":memory:") } = {}) {
  const puerto = await broker(t);
  await shellyFalso(t, puerto);
  const nodo = new NodoFalso();
  const puertoNodo = await nodo.escucharTcp();
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, datos: os.tmpdir() });
  const talaia = await crearTalaia(config, crearRegistro({ nivel: "error", salida: [] }), { almacen, telegram: { api: tg.url, timing: { poll: 1, retry: [50, 50, 50] } } });
  t.after(async () => { await talaia.detener(); await nodo.cerrar(); });
  talaia.arrancar();
  await hasta(() => talaia.S.link.state === "ready", 8000, "receiver ready");
  assert.equal((await talaia.mqtt.configurarBroker(null, { nombre: "Casa", url: `127.0.0.1:${puerto}` })).ok, true);
  await hasta(() => talaia.mqtt.conexion("b1")?.conectada, 5000, "MQTT connected");
  const taller = talaia.paneles.crearPanel({ nombre: "Taller", tipo: "shelly" }).num;
  assert.equal(talaia.paneles.guardarDatos(taller, [{ tipo: "estado", nombre: "Bomba", broker: "b1", tema: "shellyplug01/status/switch:0", campo: "output", orden: ORDEN }]).ok, true);
  await hasta(() => talaia.S.nodes.get(taller).metrics.mq1?.v === 0, 3000, "the Shelly says it's off");
  assert.equal(talaia.meshOrders.configure({ words: { [`${taller}|mq1`]: "Bomba" } }).ok, true);
  return { talaia, nodo, taller };
}

/** Pairs a chat with the code Settings shows. */
async function emparejar(tg, talaia, chat) {
  const code = talaia.S.telegram.code;
  tg.text(chat, `/start ${code}`);
  await hasta(() => talaia.S.telegram.chats.some((c) => c.id === (chat.id ?? chat)), 3000, "paired");
}

test("the token: checked with Telegram; the screens never see it; a wrong one says so", async (t) => {
  const tg = await telegramFalso(t);
  const { talaia } = await montar(t, { tg });
  const { telegram, S } = talaia;
  assert.deepEqual(S.telegram, { on: false, hasToken: false, bot: null, code: null, chats: [], state: "off", error: null });
  assert.match((await telegram.configure({ on: true })).error, /token/i);
  assert.match((await telegram.configure({ token: "hola" })).error, /BotFather/);
  assert.equal((await telegram.configure({ token: TOKEN })).ok, true);
  assert.equal(S.telegram.hasToken, true);
  assert.match(S.telegram.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(S.telegram.on, false, "a token alone doesn't switch it on");
  assert.equal((await telegram.configure({ on: true })).ok, true);
  await hasta(() => S.telegram.state === "ok", 3000, "connected");
  assert.equal(S.telegram.bot, "talaia_test_bot");
  assert.equal(tg.calls("setMyCommands").length, 1);
  assert.equal(JSON.stringify(instantanea(S)).includes(TOKEN), false, "the token never goes to the screens");
  assert.equal(JSON.stringify(S.telegram).includes("AAHfake"), false);
  // A wrong token (Telegram answers 401): off with the reason, and nothing asked again until it changes.
  const bad = await telegramFalso(t, { badToken: true });
  const t2 = await montar(t, { tg: bad });
  const r = await t2.talaia.telegram.configure({ token: TOKEN, on: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /no reconoce/);
  assert.equal(t2.talaia.S.telegram.state, "error");
});

test("pairing: an unknown chat is told once; the code pairs one chat (private or group) and changes; removing a chat", async (t) => {
  const tg = await telegramFalso(t);
  const { talaia } = await montar(t, { tg });
  const { telegram, S } = talaia;
  await telegram.configure({ token: TOKEN, on: true });
  await hasta(() => S.telegram.state === "ok", 3000, "connected");
  tg.text(42, "hola");
  await hasta(() => tg.msgs(42).length === 1, 3000, "told it needs a code");
  assert.match(tg.last(42).text, /código/);
  tg.text(42, "/paneles");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(tg.msgs(42).length, 1, "not told again (nor answered)");
  tg.text(42, "ZZZZ-ZZZZ");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(S.telegram.chats.length, 0, "a wrong code doesn't pair");
  const code = S.telegram.code;
  tg.text(42, code.toLowerCase());
  await hasta(() => S.telegram.chats.length === 1, 3000, "paired with the bare code");
  assert.deepEqual(S.telegram.chats.map((c) => [c.id, c.name, c.kind]), [[42, "Ana", "private"]]);
  assert.match(tg.last(42).text, /Listo/);
  assert.notEqual(S.telegram.code, code, "one code, one chat");
  assert.match(S.log[0].text, /chat «Ana» emparejado \(por Ana Pérez\)/);
  // The old code no longer works for another chat; the new one pairs a group.
  const group = { id: -1001, type: "supergroup", title: "Finca" };
  tg.text(group, `/start@talaia_test_bot ${code}`);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(S.telegram.chats.length, 1);
  tg.text(group, `/start@talaia_test_bot ${S.telegram.code}`);
  await hasta(() => S.telegram.chats.length === 2, 3000, "the group paired");
  assert.deepEqual(S.telegram.chats[1].kind, "group");
  assert.match(tg.last(-1001).text, /grupo/);
  // A new code from Settings; removing a chat tells it and the chat is out.
  const before = S.telegram.code;
  assert.notEqual(telegram.newCode().code, before);
  assert.equal(telegram.removeChat(-1001).ok, true);
  assert.equal(S.telegram.chats.length, 1);
  await hasta(() => /ya no recibe/.test(tg.last(-1001)?.text), 3000, "the group was told");
  assert.match(telegram.removeChat(-1001).error, /no está/);
  // Thrown out of a group: out of the list by itself.
  tg.text(group, `/start ${S.telegram.code}`);
  await hasta(() => S.telegram.chats.length === 2, 3000, "paired again");
  tg.left(-1001);
  await hasta(() => S.telegram.chats.length === 1, 3000, "out when thrown out");
  // It survives a restart (in SQLite), and the token with it.
  const almacen = talaia.almacen;
  const saved = almacen.leer("telegram", null);
  assert.equal(saved.token, TOKEN);
  assert.equal(saved.chats.length, 1);
});

test("alarms go to every paired chat with an «Enterado» button; the button marks it seen (by whom); messages follow the alarm", async (t) => {
  const tg = await telegramFalso(t);
  const { talaia, nodo } = await montar(t, { tg });
  const { telegram, S, acciones } = talaia;
  await telegram.configure({ token: TOKEN, on: true });
  await hasta(() => S.telegram.state === "ok", 3000, "connected");
  await emparejar(tg, talaia, 42);
  await emparejar(tg, talaia, { id: -1001, type: "supergroup", title: "Finca" });
  acciones.vigilar(CASETA);
  acciones.ponerLimite(CASETA, "temperature", "max", 30);
  nodo.ambiente(CASETA, { temperature: 33 });
  await hasta(() => tg.msgs(42).some((m) => /⚠/.test(m.text)) && tg.msgs(-1001).some((m) => /⚠/.test(m.text)), 4000, "the alarm reached both chats");
  const al = tg.msgs(42).find((m) => /⚠/.test(m.text));
  assert.match(al.text, /^⚠ Caseta huerto · Temperatura por encima de 30,0 °C\n/);
  assert.match(al.text, /Ahora 33,0 °C/);
  const key = `${CASETA}|temperature|high`;
  assert.deepEqual(al.reply_markup.inline_keyboard, [[{ text: "Enterado", callback_data: `ack:${key}` }]]);
  // «Enterado» from the group: seen in Talaia, the log says who, both messages lose the button.
  tg.button(-1001, `ack:${key}`, { id: 7, first_name: "Luis" });
  await hasta(() => S.active.get(key)?.acked, 3000, "acknowledged");
  assert.equal(S.log.find((e) => e.type === "ack")?.by, "Luis, por Telegram");
  await hasta(() => tg.calls("editMessageReplyMarkup").length === 2, 3000, "both messages edited");
  assert.match(tg.calls("editMessageReplyMarkup")[0].reply_markup.inline_keyboard[0][0].text, /Vista Luis, por Telegram/);
  assert.match(tg.calls("answerCallbackQuery").at(-1).text, /Vista/);
  tg.button(42, `ack:${key}`);
  await hasta(() => tg.calls("answerCallbackQuery").length === 2, 3000, "answered");
  assert.match(tg.calls("answerCallbackQuery").at(-1).text, /Ya estaba vista/);
  // /alarmas lists it as seen; when it clears, the message is edited again… no: it was already edited (seen).
  tg.text(42, "/alarmas");
  await hasta(() => /vista/.test(tg.last(42)?.text), 3000, "listed");
  assert.equal(tg.last(42).reply_markup, undefined, "no button for a seen alarm");
  // A second alarm clears by itself: its message says so.
  nodo.ambiente(CASETA, { temperature: 29 });
  await hasta(() => !S.active.has(key), 4000, "cleared");
  nodo.ambiente(CASETA, { temperature: 34 });
  await hasta(() => tg.msgs(42).filter((m) => /⚠/.test(m.text)).length === 2, 4000, "fired again");
  nodo.ambiente(CASETA, { temperature: 28 });
  await hasta(() => tg.calls("editMessageReplyMarkup").length === 4, 4000, "edited when cleared");
  assert.match(tg.calls("editMessageReplyMarkup").at(-1).reply_markup.inline_keyboard[0][0].text, /Resuelta/);
  // A chat that blocked the bot (403) drops out with a line in the log.
  S.telegram; // (the fake answers 403 to chat 666)
  tg.text(666, `/start ${S.telegram.code}`);
  await hasta(() => S.telegram.chats.some((c) => c.id === 666), 3000, "paired 666");
  await hasta(() => !S.telegram.chats.some((c) => c.id === 666), 4000, "dropped after the 403 of its welcome");
  assert.match(S.log[0].text, /ya no recibe nada/);
});

test("commands and orders: /ayuda, /paneles with buttons, /panel, the switch words (with or without «/») and the test message", async (t) => {
  const tg = await telegramFalso(t);
  const { talaia, nodo, taller } = await montar(t, { tg });
  const { telegram, S, acciones } = talaia;
  await telegram.configure({ token: TOKEN, on: true });
  await hasta(() => S.telegram.state === "ok", 3000, "connected");
  assert.match(telegram.test().error, /chat/);
  await emparejar(tg, talaia, 42);
  acciones.vigilar(CASETA);
  nodo.ambiente(CASETA, { temperature: 21.5, relativeHumidity: 60 });
  await hasta(() => S.nodes.get(CASETA)?.metrics?.temperature, 3000, "a reading");
  tg.text(42, "/ayuda");
  await hasta(() => /Soy Talaia/.test(tg.last(42)?.text), 3000, "help");
  assert.match(tg.last(42).text, /bomba on\/off\/\?/);
  tg.text(42, "/paneles");
  await hasta(() => /¿Qué panel\?/.test(tg.last(42)?.text), 3000, "panels");
  const kb = tg.last(42).reply_markup.inline_keyboard.flat();
  assert.deepEqual(kb.map((b) => b.text).sort(), ["Caseta huerto", "Taller"]);
  tg.button(42, kb.find((b) => b.text === "Caseta huerto").callback_data);
  await hasta(() => /^Caseta huerto\n/.test(tg.last(42)?.text), 3000, "the panel's readings");
  assert.match(tg.last(42).text, /Temperatura: 21,5 °C\nHumedad: 60 %\n[\s\S]*Último dato: ahora mismo$/);
  tg.text(42, "/panel taller");
  await hasta(() => /^Taller\nBomba: Apagado/.test(tg.last(42)?.text), 3000, "by name");
  tg.text(42, "/panel nada");
  await hasta(() => /No hay ningún panel que se llame «nada»/.test(tg.last(42)?.text), 3000, "unknown panel");
  // An order with the mesh's word: the Shelly answers and so does the bot; the log says who.
  tg.text(42, "/bomba on");
  await hasta(() => /Bomba: Encendido/.test(tg.last(42)?.text), 4000, "switched on");
  assert.equal(S.nodes.get(taller).metrics.mq1.v, 1);
  assert.ok(S.log.some((e) => /Orden por Telegram de Ana Pérez: «bomba on»/.test(e.text)));
  assert.ok(S.log.some((e) => e.by === "Ana Pérez, por Telegram" && /Bomba/.test(e.text)), "the switch's line says who");
  tg.text(42, "Bomba ?");
  await hasta(() => /Bomba: Encendido \(acaba de cambiar\)|Bomba: Encendido desde hace/.test(tg.last(42)?.text), 3000, "its state");
  tg.text(42, "qué tal");
  await hasta(() => /No conozco «qué tal»/.test(tg.last(42)?.text), 3000, "unknown text in a private chat");
  // In a group, what isn't an order gets no answer (a chat is a chat).
  await emparejar(tg, talaia, { id: -1001, type: "supergroup", title: "Finca" });
  await hasta(() => /grupo/.test(tg.last(-1001)?.text), 3000, "welcomed");
  const n = tg.msgs(-1001).length;
  tg.text({ id: -1001, type: "supergroup", title: "Finca" }, "buenos días");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(tg.msgs(-1001).length, n);
  assert.equal(telegram.test().ok, true);
  await hasta(() => /Prueba desde Talaia/.test(tg.last(-1001)?.text), 3000, "the test message");
  // Switched off: nothing is sent nor asked.
  await telegram.configure({ on: false });
  assert.equal(S.telegram.state, "off");
  const sends = tg.msgs().length;
  nodo.ambiente(CASETA, { temperature: 50 });
  acciones.ponerLimite(CASETA, "temperature", "max", 30);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(tg.msgs().length, sends, "nothing while off");
});

test("automations: a Telegram step (with a node's position), and orders by Telegram only, by the mesh only or by either", async (t) => {
  const tg = await telegramFalso(t);
  const { talaia, nodo } = await montar(t, { tg });
  const { telegram, S, automations, acciones } = talaia;
  acciones.vigilar(CASETA);
  nodo.posicion(CASETA, 39.1, -0.44);
  await hasta(() => S.nodes.get(CASETA)?.pos, 3000, "a position");
  // Saved with Telegram off: it is kept, but running it says why it couldn't send.
  let r = automations.save({ name: "Aviso", on: true, when: { type: "time", at: "08:00", days: [1] }, steps: [{ type: "telegram", text: "Hola {hora}", pos: CASETA }] });
  assert.equal(r.ok, true, r.error);
  const id = r.id ?? automations.list.at(-1).id;
  assert.match(automations.save({ name: "x", on: true, when: { type: "time", at: "08:00", days: [1] }, steps: [{ type: "telegram", text: "", pos: null }] }).error, /mensaje/);
  assert.match(automations.save({ name: "x", on: true, when: { type: "time", at: "08:00", days: [1] }, steps: [{ type: "telegram", text: "a", pos: 12345 }] }).error, /nodo/i);
  assert.equal(automations.runNow(id).ok, true);
  await hasta(() => S.log.some((e) => /Telegram está apagado/.test(e.text)), 3000, "the log says Telegram is off");
  // On and paired: the text (with the time in) and the pin.
  await telegram.configure({ token: TOKEN, on: true });
  await hasta(() => S.telegram.state === "ok", 3000, "connected");
  await emparejar(tg, talaia, 42);
  assert.equal(automations.runNow(id).ok, true);
  await hasta(() => tg.msgs(42).some((m) => /^Hola \d\d:\d\d$/.test(m.text)) && tg.calls("sendVenue").length === 1, 4000, "the message and the pin");
  const venue = tg.calls("sendVenue")[0];
  assert.equal(venue.chat_id, 42);
  assert.equal(venue.latitude, 39.1);
  assert.equal(venue.title, "Caseta huerto");
  // Orders: «riego» by either way, «cerrar» only over the mesh, «abrir» only by Telegram.
  for (const [text, via] of [["riego", "any"], ["cerrar", "mesh"], ["abrir", "telegram"]]) {
    r = automations.save({ name: text, on: true, when: { type: "mesh", text, via }, steps: [{ type: "telegram", text: `ok ${text}`, pos: null }] });
    assert.equal(r.ok, true, r.error);
  }
  assert.match(automations.save({ name: "x", on: true, when: { type: "mesh", text: "y", via: "fax" }, steps: [{ type: "telegram", text: "z", pos: null }] }).error, /por dónde/);
  assert.deepEqual([...automations.meshTexts("mesh")].sort(), ["cerrar", "riego"]);
  assert.deepEqual([...automations.meshTexts("telegram")].sort(), ["abrir", "riego"]);
  tg.text(42, "/ayuda");
  await hasta(() => /Soy Talaia/.test(tg.last(42)?.text), 3000, "help");
  assert.match(tg.last(42).text, /abrir/);
  assert.doesNotMatch(tg.last(42).text, /cerrar/);
  tg.text(42, "abrir");
  await hasta(() => /abrir: en marcha/.test(tg.last(42)?.text), 3000, "started by Telegram");
  assert.ok(S.log.some((e) => /«abrir» por Telegram, de Ana Pérez/.test(e.text)), "the log says who and how");
  tg.text(42, "cerrar");
  await hasta(() => /No conozco «cerrar»/.test(tg.last(42)?.text), 3000, "a mesh-only order isn't one by Telegram");
  tg.text(42, "riego");
  await hasta(() => /riego: en marcha/.test(tg.last(42)?.text), 3000, "either way");
  // A switch's buttons under a panel: pressed, the Shelly answers and so does the bot.
  tg.text(42, "/panel taller");
  await hasta(() => /^Taller\nBomba: Apagado/.test(tg.last(42)?.text), 3000, "the panel");
  const kb = tg.last(42).reply_markup.inline_keyboard.flat();
  assert.deepEqual(kb.map((b) => b.text), ["Bomba: Encendido", "Bomba: Apagado"]);
  tg.button(42, kb[0].callback_data);
  await hasta(() => /^Bomba: Encendido$/.test(tg.last(42)?.text), 4000, "switched on from the button");
  assert.match(tg.calls("answerCallbackQuery").at(-1).text, /enviado/);
  assert.ok(S.log.some((e) => e.by === "Ana Pérez, por Telegram" && /Bomba/.test(e.text)));
});
