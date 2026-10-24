// Orders over the mesh (2.1b): switches and automations from a Meshtastic node, with the answer back the same way.
//
//  - Who: a direct message to the receiver, encrypted with its key (PKI), from a node on the list, whose public key
//    is the one pinned when it was added (a node that changes its key, or one that pretends to be it, is refused);
//    and, if one is chosen, anyone on a private channel (its key is the protection: all who have it can give orders).
//  - What: «word on», «word off», «word ?» for the switches that have a word (also encender/apagar, 1/0, estado);
//    the text of an automation «if «…» arrives over the mesh»; «ayuda» / «help» / «?» for the list. Upper and lower
//    case and accents don't matter. Nothing an answer says reads as an order (two servers on a channel).
//  - The answer goes back the way the order came (a direct message, or the channel), in the alerts' queue (8 s apart,
//    20 an hour): «Bomba: Encendido» once the device says so, its state for «?», «Riego: en marcha».
//  - Not taken: messages that were waiting in the receiver while the server wasn't connected (the first seconds after
//    it connects, or older than 10 min by the receiver's clock, which may be a few minutes off), the same packet twice,
//    more than 20 orders in 10 min from the same sender. Refusals that look like an order go to the log; nothing is
//    answered to whoever isn't allowed.
//
// Configuration in SQLite («meshOrders»): { on, nodes: [{ num, key (hex) }], channel, words: { "num|key": word } }.
// The screens see S.meshOrders (part «meshOrders»), with only the start of each key.
import { Protobuf } from "@meshtastic/core";
import { metricMeta, fmtValue } from "@talaia/nucleo/metrics.js";
import { MIN, dur } from "@talaia/nucleo/textos.js";
import { tx } from "@talaia/nucleo/idioma.js";
import "./textos.js";

const TEXT_APP = Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP;
const BROADCAST = 0xffffffff;
const AFTER_READY = 10000; // what arrives this soon after connecting was waiting in the receiver: not an order now
const MAX_AGE = 10 * MIN; // by the receiver's clock (a few minutes off is usual)
const SENDER_MAX = 20, SENDER_WINDOW = 10 * MIN;
const WORD_MAX = 20;
export const HELP = new Set(["ayuda", "help", "?", "ordenes", "orders"]);
const ON = new Set(["on", "encender", "enciende", "1"]);
const OFF = new Set(["off", "apagar", "apaga", "0"]);
const ASK = new Set(["?", "estado", "status", ""]);
const DEFAULT = () => ({ on: false, nodes: [], channel: null, words: {} });

/** An order as it is compared: lower case, without accents nor punctuation around, single spaces. */
export function normOrder(s) {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[¡!¿.,;:"'«»“”]+/g, " ").replace(/\s+/g, " ").trim();
}
const hex = (bytes) => Buffer.from(bytes).toString("hex");
/** What the screens see of a key: its first 8 characters, enough to tell two apart. */
const short = (k) => (k ? k.slice(0, 8) : null);

/**
 * paneles: the switches (mandar, dato). automations: meshFire(text, who) and meshTexts(). motor: names, the log and
 * meshSay for the answers. eventos: emits «parte» «meshOrders». timing: { afterReady } shorter for the tests.
 */
export function createMeshOrders({ S, motor, paneles, automations, almacen, eventos, timing = {} }) {
  const afterReady = timing.afterReady ?? AFTER_READY;
  const cfg = { ...DEFAULT(), ...(almacen.leer("meshOrders", null) || {}) };
  const keys = new Map(); // num → public key (hex), as the receiver says
  const seen = new Set(); // "from:id" of the latest packets: one heard twice is one order
  const bySender = new Map(); // from → times of its latest orders
  let readyAt = 0;
  const refusedSaid = new Map(); // from → when its refusal was last logged (not every message)

  const nodeName = (num) => motor.nodeName(num);
  const switches = () => Object.entries(cfg.words).map(([ref, word]) => { const [num, key] = ref.split("|"); return { ref, num: Number(num), key, word: normOrder(word) }; });
  const datum = (num, key) => paneles.dato(num, key);
  const label = (key) => metricMeta(key).label;

  function publish() {
    S.meshOrders = {
      on: cfg.on, channel: cfg.channel, words: cfg.words,
      nodes: cfg.nodes.map((n) => ({ num: n.num, key: short(n.key), now: keys.has(n.num) ? (keys.get(n.num) === n.key ? "same" : "changed") : "unknown" })),
    };
    eventos.emit("parte", "meshOrders");
  }
  function save() { almacen.guardar("meshOrders", cfg); publish(); }

  /* ── what arrives ── */
  /** Where a text came from and how it can be answered; null if it isn't for us. */
  function route(p) {
    if (p.to === S.myNode && p.pkiEncrypted) return { dm: true, reply: { node: p.from } };
    const ch = cfg.channel != null ? S.channels.find((c) => c.index === cfg.channel) : null;
    if (ch?.private && p.channel === ch.index && (p.to === BROADCAST || p.to === S.myNode)) return { dm: false, reply: { channel: ch.index } };
    if (p.to === S.myNode) return { dm: true, reply: null, plain: true }; // direct, but not encrypted with its key
    return null; // the mesh's own chat on other channels
  }

  function parse(text) {
    const t = normOrder(text);
    if (!t) return null;
    if (HELP.has(t)) return { kind: "help" };
    if (automations.meshTexts().has(t)) return { kind: "auto", text: t };
    const [word, ...rest] = t.split(" ");
    const sw = switches().find((x) => x.word === word);
    if (!sw) return null;
    // Not the names of its states («Encendido»): an answer («Bomba: Encendido») must never read as an order.
    const a = rest.join(" ");
    if (ON.has(a)) return { kind: "switch", sw, v: 1 };
    if (OFF.has(a)) return { kind: "switch", sw, v: 0 };
    if (ASK.has(a)) return { kind: "state", sw };
    return { kind: "bad", sw };
  }

  /** Whether that node may give orders by a direct message: on the list, and with the key pinned then. */
  function allowed(p) {
    const n = cfg.nodes.find((x) => x.num === p.from);
    if (!n) return "notListed";
    const k = p.publicKey?.length === 32 ? hex(p.publicKey) : keys.get(p.from);
    if (k !== n.key) return "keyChanged";
    return null;
  }

  function refuse(p, why) {
    // Once every 10 min per sender is enough to see it (and not a log full of them).
    if (Date.now() - (refusedSaid.get(p.from) || 0) < 10 * MIN) return;
    refusedSaid.set(p.from, Date.now());
    motor.addLog("info", tx("s.log.moRefused", { who: nodeName(p.from), why: tx(`s.mo.why.${why}`) }), p.from >= 0 ? p.from : null);
  }

  function answer(path, text) { if (path.reply) motor.meshSay(path.reply, text); }

  function packet(p) {
    const dec = p.payloadVariant?.case === "decoded" ? p.payloadVariant.value : null;
    if (!dec || dec.portnum !== TEXT_APP || !cfg.on || p.from === S.myNode) return;
    const path = route(p);
    if (!path) return;
    const text = new TextDecoder().decode(dec.payload).trim();
    const cmd = parse(text);
    if (!cmd) {
      // An authorised direct message that isn't an order: say how to get the list (not on a channel, it's a chat).
      if (path.dm && path.reply && !allowed(p) && fresh(p)) answer(path, tx("s.mo.unknown", { text: text.slice(0, 40) }));
      return;
    }
    if (!fresh(p)) return;
    if (path.plain) return refuse(p, "plain");
    if (path.dm) { const why = allowed(p); if (why) return refuse(p, why); }
    const ts = (bySender.get(p.from) || []).filter((t) => Date.now() - t < SENDER_WINDOW);
    if (ts.length >= SENDER_MAX) return refuse(p, "tooMany");
    ts.push(Date.now());
    bySender.set(p.from, ts);
    const who = path.dm ? nodeName(p.from) : tx("s.mo.onChannel", { name: nodeName(p.from), ch: S.channels.find((c) => c.index === path.reply.channel)?.name ?? path.reply.channel });
    motor.addLog("info", tx("s.log.moOrder", { who, text }), null);
    run(cmd, path, who);
  }
  /** Not a packet seen already, nor one that was waiting in the receiver while the server wasn't connected. */
  function fresh(p) {
    const id = `${p.from}:${p.id}`;
    if (p.id && seen.has(id)) return false;
    if (p.id) { seen.add(id); if (seen.size > 300) seen.delete(seen.values().next().value); }
    if (!readyAt || Date.now() - readyAt < afterReady) return false;
    const rx = p.rxTime ? p.rxTime * 1000 : 0;
    return !(rx > 1.6e12 && Date.now() - rx > MAX_AGE);
  }

  async function run(cmd, path, who) {
    if (cmd.kind === "help") return answer(path, helpText());
    if (cmd.kind === "auto") {
      const done = automations.meshFire(cmd.text, who);
      return answer(path, done.map((x) => tx(`s.mo.auto.${x.state}`, { name: x.name })).join(" · "));
    }
    const { sw } = cmd;
    const d = datum(sw.num, sw.key);
    const name = label(sw.key);
    if (!d?.orden) return answer(path, tx("s.mo.gone", { word: sw.word }));
    // (on a channel, not even this: two servers on it would answer each other)
    if (cmd.kind === "bad") return path.dm && answer(path, tx("s.mo.how", { word: sw.word }));
    if (cmd.kind === "state") return answer(path, stateText(sw, name));
    const r = await paneles.mandar(sw.num, sw.key, cmd.v, {
      by: tx("s.mo.by", { who }),
      done: (ok) => answer(path, ok ? tx("s.mo.done", { name, state: fmtValue(sw.key, cmd.v) }) : tx("s.mo.noAnswer", { name, state: fmtValue(sw.key, cmd.v) })),
    });
    if (!r.ok) answer(path, tx("s.mo.fail", { name, e: r.error }));
  }
  function stateText(sw, name) {
    const m = S.nodes.get(sw.num)?.metrics?.[sw.key];
    if (!m) return tx("s.mo.noData", { name });
    const since = Date.now() - (m.desde ?? m.t);
    return since < MIN ? tx("s.mo.stateNew", { name, state: fmtValue(sw.key, m.v) }) : tx("s.mo.state", { name, state: fmtValue(sw.key, m.v), d: dur(since) });
  }
  function helpText() {
    const list = switches().filter((x) => datum(x.num, x.key)?.orden).map((x) => `${x.word} on/off/?`)
      .concat([...automations.meshTexts()]);
    return list.length ? tx("s.mo.help", { list: list.join(", ") }) : tx("s.mo.helpNone");
  }

  /* ── settings ── */
  /** A word for a switch: one word, not one of the reserved ones, not another switch's nor an automation's. */
  function checkWords(words) {
    const out = {}, used = new Map();
    const autos = new Set([...automations.meshTexts()].map((t) => t.split(" ")[0]));
    for (const [ref, raw] of Object.entries(words || {})) {
      const word = String(raw ?? "").trim();
      if (!word) continue;
      const [num, key] = ref.split("|");
      const d = datum(Number(num), key);
      if (!d?.orden) return { error: tx("s.mo.e.notSwitch") };
      const n = normOrder(word);
      if (!/^[a-z0-9_-]+$/.test(n) || word.length > WORD_MAX) return { error: tx("s.mo.e.word", { word, n: WORD_MAX }) };
      if (HELP.has(n) || ON.has(n) || OFF.has(n) || ASK.has(n)) return { error: tx("s.mo.e.reserved", { word }) };
      if (used.has(n)) return { error: tx("s.mo.e.twice", { word }) };
      if (autos.has(n)) return { error: tx("s.mo.e.auto", { word }) };
      used.set(n, ref);
      out[ref] = word;
    }
    return { words: out };
  }

  publish();
  return {
    packet,
    /** The receiver is ready: what arrives in the next seconds was waiting in it. */
    ready() { readyAt = Date.now(); },
    publicKey(num, key) {
      const k = hex(key);
      if (keys.get(num) === k) return;
      keys.set(num, k);
      if (cfg.nodes.some((n) => n.num === num)) publish();
    },
    /** Normalised words of the switches (for the automations' «if «…» arrives over the mesh»). */
    words: () => new Set(switches().map((x) => x.word)),
    /** { on, channel, words }: whichever of them comes. */
    configure(change) {
      if ("channel" in change && change.channel != null) {
        const ch = S.channels.find((c) => c.index === change.channel);
        if (!ch) return { ok: false, error: tx("s.mo.e.channel") };
        if (!ch.private) return { ok: false, error: tx("s.mo.e.public", { name: ch.name }) };
      }
      let words = null;
      if ("words" in change) {
        const r = checkWords(change.words);
        if (r.error) return { ok: false, error: r.error };
        words = r.words;
      }
      if ("on" in change) cfg.on = !!change.on;
      if ("channel" in change) cfg.channel = change.channel;
      if (words) cfg.words = words;
      save();
      if ("on" in change) motor.addLog("info", tx(cfg.on ? "s.log.moOn" : "s.log.moOff"));
      if ("channel" in change) motor.addLog("info", cfg.channel == null ? tx("s.log.moNoChannel") : tx("s.log.moChannel", { name: S.channels.find((c) => c.index === cfg.channel)?.name }));
      if (words) motor.addLog("info", tx("s.log.moWords", { list: Object.values(words).join(", ") || "—" }));
      return { ok: true, toast: tx("s.mo.saved") };
    },
    /** A node that may give orders by direct message, with the key it has now (pinned). */
    addNode(num) {
      if (num === S.myNode || !S.nodes.has(num)) return { ok: false, error: tx("s.mo.e.node") };
      const key = keys.get(num);
      if (!key) return { ok: false, error: tx("s.mo.e.noKey", { name: nodeName(num) }) };
      cfg.nodes = cfg.nodes.filter((n) => n.num !== num).concat({ num, key });
      save();
      motor.addLog("info", tx("s.log.moNode", { name: nodeName(num), key: short(key) }));
      return { ok: true, toast: tx("s.mo.nodeAdded", { name: nodeName(num) }) };
    },
    removeNode(num) {
      if (!cfg.nodes.some((n) => n.num === num)) return { ok: false, error: tx("s.mo.e.node") };
      cfg.nodes = cfg.nodes.filter((n) => n.num !== num);
      save();
      motor.addLog("info", tx("s.log.moNodeOut", { name: nodeName(num) }));
      return { ok: true, toast: tx("s.mo.nodeRemoved", { name: nodeName(num) }) };
    },
  };
}
