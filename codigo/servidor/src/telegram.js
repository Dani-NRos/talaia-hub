// Telegram: a bot that tells the alarms and takes orders, in private chats and groups.
//
//  - The server asks Telegram for what is new (long polling: no port to open, no public HTTPS, it works behind
//    Tailscale and any router). The bot's token (from @BotFather) is kept in SQLite and never leaves through the API.
//  - Who: a chat has to be paired with a code that Settings shows (one code, one chat); an unknown chat is told
//    so once and then ignored. Paired chats are listed in Settings and can be removed there.
//  - Out: every alarm when it fires (also the MQTT data's and the receiver's), with an «Enterado» button that marks
//    it seen in Talaia (the log says who). The message is edited when the alarm is seen or clears elsewhere.
//  - In: /ayuda, /paneles (buttons, one per watched panel → its readings now and its alarms), /alarmas (the active
//    ones, with their buttons), and the orders over the mesh's words («riego on», also as /riego on: in a group the
//    bot only sees what starts with «/» or mentions it) and the automations' texts, through mesh-orders.js.
//  - Nothing is sent while the bot is off; what Telegram refuses (a chat that blocked the bot) is dropped from the
//    list with a line in the log.
//
// Configuration in SQLite («telegram»): { on, token, chats: [{ id, name, kind, since }], code, offset }. The screens
// see S.telegram (part «telegram»): { on, hasToken, bot, chats, code, state, error }.
import crypto from "node:crypto";
import { metricMeta, fmtWithUnit, sortMetrics } from "@talaia/nucleo/metrics.js";
import { MIN, ago } from "@talaia/nucleo/textos.js";
import { tx } from "@talaia/nucleo/idioma.js";
import "./textos.js";

const API = "https://api.telegram.org";
const POLL_TIMEOUT = 30; // s, Telegram holds the request until something arrives
const RETRY = [5000, 15000, 60000]; // after an error, before asking again
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const UNKNOWN_EVERY = 10 * MIN; // how often an unpaired chat is told it needs a code
const TRACKED_MAX = 200; // alarm messages whose buttons are kept up to date
const DEFAULT = () => ({ on: false, token: null, chats: [], code: null, offset: 0 });

const newCode = () => [...crypto.randomBytes(8)].map((x) => ALFABETO[x % ALFABETO.length]).join("").replace(/^(.{4})/, "$1-");
const normCode = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const COMMANDS = ["start", "ayuda", "help", "paneles", "panels", "alarmas", "alarms"];

/**
 * talaia: { S, motor, paneles, meshOrders, almacen, eventos, registro }. opts: { api } the Bot API's base (the tests
 * point it at a fake one), { timing: { poll, retry } }.
 */
export function createTelegram({ S, motor, paneles, meshOrders, almacen, eventos, registro }, opts = {}) {
  const api = (opts.api || API).replace(/\/$/, "");
  const pollTimeout = opts.timing?.poll ?? POLL_TIMEOUT;
  const cfg = { ...DEFAULT(), ...(almacen.leer("telegram", null) || {}) };
  let bot = null; // { id, username } once the token is checked
  let state = "off", error = null; // off | ok | error
  let polling = null, stopped = true, abort = null, retries = 0;
  const unknownSaid = new Map(); // chat id → when it was last told it needs a code
  const tracked = new Map(); // "chat:message" → { key, chat, message } alarm messages with a button
  const queue = []; // what is being sent, one after another
  let sending = false;

  const chatName = (c) => c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || String(c.id);
  const paired = (id) => cfg.chats.find((c) => c.id === id);

  function publish() {
    S.telegram = {
      on: cfg.on, hasToken: !!cfg.token, bot: bot?.username || null, code: cfg.code,
      chats: cfg.chats.map((c) => ({ id: c.id, name: c.name, kind: c.kind, since: c.since })),
      state, error,
    };
    eventos.emit("parte", "telegram");
  }
  function save() { almacen.guardar("telegram", cfg); publish(); }
  function log(key, v) { motor.addLog("info", tx(key, v)); }

  /* ── the Bot API ── */
  async function call(method, body, { signal, timeout = 15000 } = {}) {
    const r = await fetch(`${api}/bot${cfg.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
      signal: signal || AbortSignal.timeout(timeout),
    });
    const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!j.ok) { const e = new Error(j.description || `HTTP ${r.status}`); e.code = j.error_code; throw e; }
    return j.result;
  }
  /** Sends go out one at a time: Telegram limits the pace, and a message must not overtake the one before it. */
  function send(method, body, done) {
    queue.push({ method, body, done });
    if (!sending) drain();
  }
  async function drain() {
    sending = true;
    while (queue.length && cfg.on && cfg.token) {
      const { method, body, done } = queue.shift();
      try {
        const r = await call(method, body);
        done?.(r, null);
      } catch (e) {
        done?.(null, e);
        // 403: the chat blocked the bot or the bot was thrown out of the group; 400 «chat not found»: it's gone.
        if ((e.code === 403 || e.code === 400) && body?.chat_id != null && paired(body.chat_id) && /blocked|kicked|not found|deactivated|not a member/i.test(e.message)) {
          const c = paired(body.chat_id);
          cfg.chats = cfg.chats.filter((x) => x.id !== c.id);
          save();
          log("s.log.tgChatGone", { name: c.name, e: e.message });
        } else if (e.code === 429) {
          await new Promise((r) => setTimeout(r, 3000));
          queue.unshift({ method, body, done });
        } else {
          registro.aviso(tx("s.j.tgSendFail", { what: method, e: e.message }));
        }
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    sending = false;
  }
  const tell = (chatId, text, extra = {}, done) => send("sendMessage", { chat_id: chatId, text, ...extra }, done);
  const tellAll = (text, extra, done) => { for (const c of cfg.chats) tell(c.id, text, extra, done && ((r, e) => done(c, r, e))); };

  /* ── polling ── */
  async function poll() {
    if (stopped || polling) return;
    polling = (async () => {
      while (!stopped && cfg.on && cfg.token) {
        const ac = (abort = new AbortController());
        try {
          const signal = AbortSignal.any([ac.signal, AbortSignal.timeout((pollTimeout + 15) * 1000)]); // a hung connection ends too
          const updates = await call("getUpdates", { offset: cfg.offset, timeout: pollTimeout, allowed_updates: ["message", "callback_query", "my_chat_member"] }, { signal });
          retries = 0;
          if (state !== "ok") { state = "ok"; error = null; publish(); }
          for (const u of updates) {
            cfg.offset = u.update_id + 1;
            try { await handle(u); } catch (e) { registro.aviso(tx("s.j.tgHandleFail", { e: e.message })); }
          }
          if (updates.length) almacen.guardar("telegram", cfg);
        } catch (e) {
          if (stopped || ac.signal.aborted) break;
          if (e.code === 401 || e.code === 404) { // a wrong token: no use asking again until it changes
            state = "error"; error = tx("s.tg.badToken"); publish();
            registro.aviso(tx("s.j.tgBadToken"));
            break;
          }
          if (e.code === 409) { // another program is asking with this token (two Talaias, or the old one still running)
            state = "error"; error = tx("s.tg.conflict"); publish();
          } else if (state !== "error" || error !== e.message) { state = "error"; error = e.message; publish(); }
          const wait = (opts.timing?.retry ?? RETRY)[Math.min(retries++, RETRY.length - 1)];
          await new Promise((r) => { const t = setTimeout(r, wait); ac.signal.addEventListener("abort", () => { clearTimeout(t); r(); }); });
        }
      }
      polling = null;
    })();
  }
  function stopPolling() { abort?.abort(); abort = null; }

  async function start() {
    stopped = false;
    if (!cfg.on || !cfg.token) { state = "off"; error = null; publish(); return; }
    try {
      bot = await call("getMe");
      await setCommands();
      state = "ok"; error = null;
    } catch (e) {
      bot = null;
      state = "error"; error = e.code === 401 || e.code === 404 ? tx("s.tg.badToken") : e.message;
      registro.aviso(tx(e.code === 401 || e.code === 404 ? "s.j.tgBadToken" : "s.j.tgStartFail", { e: e.message }));
    }
    publish();
    if (state === "ok" || !(error === tx("s.tg.badToken"))) poll();
    if (queue.length) drain();
  }
  async function setCommands() {
    const cmds = [["ayuda", tx("s.tg.cmd.help")], ["paneles", tx("s.tg.cmd.panels")], ["alarmas", tx("s.tg.cmd.alarms")]];
    await call("setMyCommands", { commands: cmds.map(([command, description]) => ({ command, description })) }).catch(() => {});
  }

  /* ── what arrives ── */
  async function handle(u) {
    if (u.my_chat_member) { // thrown out of a group, or the user blocked the bot
      const m = u.my_chat_member, st = m.new_chat_member?.status;
      if (["left", "kicked"].includes(st) && paired(m.chat.id)) {
        const c = paired(m.chat.id);
        cfg.chats = cfg.chats.filter((x) => x.id !== c.id);
        save();
        log("s.log.tgChatGone", { name: c.name, e: st });
      }
      return;
    }
    if (u.callback_query) return button(u.callback_query);
    const m = u.message;
    if (!m?.chat || typeof m.text !== "string") return;
    const who = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username || chatName(m.chat);
    // «/riego on@talaia_bot» → «riego on»; the «/» is how a group lets the bot see the message
    let text = m.text.trim();
    if (text.startsWith("/")) text = text.slice(1).replace(/^(\S+)@\S+/, "$1");
    const [first, ...rest] = text.split(/\s+/);
    const cmd = first.toLowerCase();
    const chat = paired(m.chat.id);
    if (!chat) return unpaired(m, cmd, rest.join(" "), who);
    const reply = (t, extra) => tell(m.chat.id, t, extra);
    if (cmd === "start" || cmd === "ayuda" || cmd === "help" || cmd === "?") return reply(helpText());
    if (cmd === "paneles" || cmd === "panels") return reply(...panelsList());
    if (cmd === "panel" && rest.length) { const num = findPanel(rest.join(" ")); return num == null ? reply(tx("s.tg.noPanel", { name: rest.join(" ") })) : reply(...panelText(num)); }
    if (cmd === "alarmas" || cmd === "alarms") return reply(...alarmsList());
    const by = tx("s.tg.by", { who });
    if (meshOrders.order(text, { who, by, send: (t) => reply(t), via: "telegram" })) {
      motor.addLog("info", tx("s.log.tgOrder", { who, text }), null);
      return;
    }
    if (m.chat.type === "private") reply(tx("s.tg.unknown", { text: text.slice(0, 40) }));
  }

  function unpaired(m, cmd, arg, who) {
    const code = normCode(cmd === "start" || cmd === "emparejar" || cmd === "pair" ? arg : `${cmd} ${arg}`);
    if (cfg.code && code === normCode(cfg.code)) {
      const c = { id: m.chat.id, name: chatName(m.chat), kind: m.chat.type === "private" ? "private" : "group", since: Date.now() };
      cfg.chats.push(c);
      cfg.code = newCode(); // one code, one chat
      save();
      log("s.log.tgPaired", { name: c.name, who });
      tell(m.chat.id, tx(c.kind === "group" ? "s.tg.pairedGroup" : "s.tg.paired", { bot: bot?.username || "" }));
      return;
    }
    // Told once in a while, not with every message (and nothing else: it is not ours to answer).
    if (Date.now() - (unknownSaid.get(m.chat.id) || 0) < UNKNOWN_EVERY) return;
    unknownSaid.set(m.chat.id, Date.now());
    tell(m.chat.id, tx("s.tg.needCode"));
  }

  async function button(q) {
    const chat = q.message?.chat?.id;
    const who = [q.from?.first_name, q.from?.last_name].filter(Boolean).join(" ") || q.from?.username || "?";
    const answer = (text) => send("answerCallbackQuery", { callback_query_id: q.id, text });
    if (chat == null || !paired(chat)) return answer(tx("s.tg.needCode"));
    const [kind, ...rest] = String(q.data || "").split(":");
    const arg = rest.join(":");
    if (kind === "ack") {
      const al = S.active.get(arg);
      if (!al) { answer(tx("s.tg.ackGone")); return refreshTracked(); }
      if (al.acked) { answer(tx("s.tg.ackAlready")); return refreshTracked(); }
      answer(tx("s.tg.ackDone")); // first: the finger is waiting
      S.actor = tx("s.tg.by", { who });
      try { motor.ack(arg); } finally { S.actor = null; } // (the «active» part refreshes the messages)
      return;
    }
    if (kind === "panel") {
      const num = Number(arg);
      answer("");
      if (S.cfg.watched[num]) tell(chat, ...panelText(num));
      return;
    }
    if (kind === "sw") { // «sw:<num>|<key>:<1|0>»: a switch pressed under a panel
      const m = /^(-?\d+)\|([^:]+):([01])$/.exec(arg);
      const d = m ? paneles.dato(Number(m[1]), m[2]) : null;
      if (!d?.orden) return answer(tx("s.tg.swGone"));
      const num = Number(m[1]), key = m[2], v = Number(m[3]);
      const name = metricMeta(key).label, state = fmtWithUnit(key, v);
      answer(tx("s.tg.swSent", { name, state }));
      motor.addLog("info", tx("s.log.tgOrder", { who, text: `${name} → ${state}` }), null);
      const r = await paneles.mandar(num, key, v, {
        by: tx("s.tg.by", { who }),
        done: (ok) => tell(chat, ok ? tx("s.mo.done", { name, state }) : tx("s.mo.noAnswer", { name, state })),
      });
      if (!r.ok) tell(chat, tx("s.mo.fail", { name, e: r.error }));
      return;
    }
    answer("");
  }

  /* ── texts ── */
  function helpText() {
    const orders = meshOrders.helpList("telegram");
    return [tx("s.tg.help"), orders.length ? tx("s.tg.helpOrders", { list: orders.join(", ") }) : tx("s.tg.helpNoOrders")].join("\n");
  }
  const watched = () => Object.keys(S.cfg.watched).map(Number).filter((n) => S.nodes.has(n)).sort((a, b) => motor.nodeName(a).localeCompare(motor.nodeName(b)));
  function findPanel(name) {
    const n = name.trim().toLowerCase();
    return watched().find((num) => motor.nodeName(num).toLowerCase() === n) ?? watched().find((num) => motor.nodeName(num).toLowerCase().includes(n)) ?? null;
  }
  function panelsList() {
    const nums = watched();
    if (!nums.length) return [tx("s.tg.noPanels")];
    const rows = [];
    for (let i = 0; i < nums.length; i += 2) rows.push(nums.slice(i, i + 2).map((num) => ({ text: motor.nodeName(num), callback_data: `panel:${num}` })));
    return [tx("s.tg.panels"), { reply_markup: { inline_keyboard: rows } }];
  }
  function panelText(num) {
    const n = S.nodes.get(num);
    if (!n) return [tx("s.tg.noPanel", { name: String(num) })];
    const lay = S.paneles?.paneles?.[num]?.layout || {};
    const keys = sortMetrics(Object.keys(n.metrics || {}).filter((k) => !metricMeta(k).minor), lay.data);
    const lines = [motor.nodeName(num)];
    for (const k of keys) lines.push(`${metricMeta(k).label}: ${fmtWithUnit(k, n.metrics[k].v)}`);
    if (!keys.length) lines.push(tx("s.tg.noData"));
    const last = num >= 0 ? n.lastHeard : Math.max(0, ...keys.map((k) => n.metrics[k].t || 0));
    if (last) lines.push(tx("s.tg.lastHeard", { ago: ago(last) }));
    const als = [...S.active.values()].filter((a) => a.num === num);
    for (const a of als) lines.push(`⚠ ${motor.alarmTitle(a)}${a.acked ? ` (${tx("s.tg.seen")})` : ""}`);
    // A row of buttons for each switch of the panel, then one per alarm not seen.
    const buttons = keys.filter((k) => paneles.dato(num, k)?.orden).map((k) => {
      const m = metricMeta(k);
      return [{ text: `${m.label}: ${m.estados[0]}`, callback_data: `sw:${num}|${k}:1` }, { text: `${m.label}: ${m.estados[1]}`, callback_data: `sw:${num}|${k}:0` }];
    }).concat(als.filter((a) => !a.acked).map((a) => [{ text: tx("s.tg.ackBtn", { title: motor.alarmTitle(a) }).slice(0, 60), callback_data: `ack:${a.key}` }]));
    return [lines.join("\n"), buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}];
  }
  function alarmsList() {
    const als = [...S.active.values()].sort((a, b) => (a.acked - b.acked) || (b.since - a.since));
    if (!als.length) return [tx("s.tg.noAlarms")];
    const lines = als.map((a) => `⚠ ${motor.alarmTitle(a)} · ${motor.alarmDetail(a)}${a.acked ? ` (${tx("s.tg.seen")})` : ""}`);
    const buttons = als.filter((a) => !a.acked).map((a) => [{ text: tx("s.tg.ackBtn", { title: motor.alarmTitle(a) }).slice(0, 60), callback_data: `ack:${a.key}` }]);
    return [lines.join("\n"), buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}];
  }

  /* ── alarms out ── */
  function alarm(al) {
    if (!cfg.on || !cfg.token || !cfg.chats.length) return;
    const text = `⚠ ${motor.alarmTitle(al)}\n${motor.alarmDetail(al)}`;
    tellAll(text, { reply_markup: { inline_keyboard: [[{ text: tx("s.tg.ack"), callback_data: `ack:${al.key}` }]] } }, (c, r) => {
      if (!r) return;
      tracked.set(`${c.id}:${r.message_id}`, { key: al.key, chat: c.id, message: r.message_id });
      if (tracked.size > TRACKED_MAX) tracked.delete(tracked.keys().next().value);
      const now = S.active.get(al.key);
      if (!now || now.acked) refreshTracked(); // seen or cleared before Telegram even answered
    });
  }
  /** The buttons of the alarm messages follow the alarms: seen or cleared elsewhere, the button goes with a note. */
  function refreshTracked() {
    for (const [id, t] of [...tracked]) {
      const al = S.active.get(t.key);
      if (al && !al.acked) continue;
      tracked.delete(id);
      const note = al ? tx("s.tg.noteSeen", { who: S.log.find((e) => e.type === "ack" && e.text.includes(motor.alarmTitle(al)))?.by || "" }).trim() : tx("s.tg.noteCleared");
      send("editMessageReplyMarkup", { chat_id: t.chat, message_id: t.message, reply_markup: { inline_keyboard: [[{ text: note, callback_data: "noop" }]] } });
    }
  }
  const listeners = {
    alarma: (al) => alarm(al),
    parte: (k) => { if (k === "active" && tracked.size) refreshTracked(); },
  };

  publish();
  return {
    start() { for (const [k, f] of Object.entries(listeners)) eventos.on(k, f); return start(); },
    async stop() { stopped = true; stopPolling(); for (const [k, f] of Object.entries(listeners)) eventos.off(k, f); if (polling) await polling.catch(() => {}); },
    /** { on, token }: whichever of them comes. A new token is checked with Telegram before it is kept. */
    async configure(change) {
      if ("token" in change) {
        const token = String(change.token ?? "").trim();
        if (token && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) return { ok: false, error: tx("s.tg.e.tokenFormat") };
        stopPolling();
        if (polling) await polling.catch(() => {});
        cfg.token = token || null;
        bot = null;
        if (!cfg.token) { cfg.on = false; state = "off"; error = null; }
        if (!cfg.code) cfg.code = newCode();
      }
      if ("on" in change) {
        if (change.on && !cfg.token) return { ok: false, error: tx("s.tg.e.noToken") };
        cfg.on = !!change.on;
        if (!cfg.on) { stopPolling(); state = "off"; error = null; }
      }
      save();
      if ("on" in change) log(cfg.on ? "s.log.tgOn" : "s.log.tgOff");
      if ("token" in change) log(cfg.token ? "s.log.tgToken" : "s.log.tgNoToken");
      if (!stopped) await start();
      if ("token" in change && cfg.token && state === "error") return { ok: false, error };
      return { ok: true, toast: tx("s.tg.saved") };
    },
    /** A new pairing code (the one shown goes out of use). */
    newCode() { cfg.code = newCode(); save(); return { ok: true, code: cfg.code }; },
    removeChat(id) {
      const c = paired(id);
      if (!c) return { ok: false, error: tx("s.tg.e.chat") };
      cfg.chats = cfg.chats.filter((x) => x.id !== id);
      save();
      log("s.log.tgChatOut", { name: c.name });
      tell(id, tx("s.tg.removed"));
      return { ok: true, toast: tx("s.tg.chatRemoved", { name: c.name }) };
    },
    /** A line to every paired chat, to see that it works. */
    test() {
      if (!cfg.on || !cfg.token) return { ok: false, error: tx("s.tg.e.off") };
      if (!cfg.chats.length) return { ok: false, error: tx("s.tg.e.noChats") };
      tellAll(tx("s.tg.testMsg"));
      return { ok: true, toast: tx("s.tg.testSent", { n: cfg.chats.length }) };
    },
    /** A message to every paired chat (the automations). */
    say(text, extra) { if (cfg.on && cfg.token) tellAll(text, extra); },
    /** A node's position as a pin on the map, to every paired chat. */
    location(lat, lon, title) {
      if (!cfg.on || !cfg.token) return;
      for (const c of cfg.chats) send("sendVenue", { chat_id: c.id, latitude: lat, longitude: lon, title, address: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
    },
    chats: () => cfg.chats.map((c) => ({ id: c.id, name: c.name })),
    /** The server's language changed: the commands' descriptions again. */
    relabel() { if (cfg.on && cfg.token && bot) setCommands(); },
    get on() { return cfg.on && !!cfg.token; },
  };
}
