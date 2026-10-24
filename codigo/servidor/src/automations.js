// Automations (2.1): «if … then …», run by the server.
//
//  - When: a datum of a panel goes above or below a number, or a state becomes ON or OFF (both, optionally, «for at
//    least N min»); or a time of day, on some days of the week (the server's clock). Only on the crossing: what
//    already held when the automation was saved, switched on or the server started doesn't count until it stops
//    holding (a state «for N min» counts from when it changed, which the server knows).
//  - Then: steps in order. Turn a switch on or off (optionally «for N min», and then back); wait; a message over the
//    mesh (the alerts' queue and limits: a private channel or a node); ask a node for data.
//  - A trigger while it's still running (in a wait) starts it again from the first step. A switch turned on «for
//    N min» is turned back even if the automation is switched off, changed or removed meanwhile: the last thing an
//    automation sends to a switch is what counts (a new command to it drops the pending one).
//  - Waits and «for N min» survive a restart (SQLite): what came due while the server was stopped runs shortly after
//    it starts (once the brokers have had time to connect). Turning a switch back is tried again for 10 min if its
//    broker isn't there.
//  - Brake: an automation that runs by itself 10 times in 10 min is paused, and the log says so.
//
// Configuration in SQLite («automations»: { next, list }); waits, switches to turn back and the last run of each one
// in «automationsRun». What the screens see goes in S.automations (part «automations»).
import { metricMeta, fmtWithUnit, fmtLimit, METRICS } from "@talaia/nucleo/metrics.js";
import { esClaveMqtt, esEstado, textoDato } from "@talaia/nucleo/mqtt-datos.js";
import { ASK_ALL } from "@talaia/nucleo/motor.js";
import { fitBytes } from "@talaia/nucleo/canales.js";
import { MIN, isNum, hhmm, dur } from "@talaia/nucleo/textos.js";
import { tx } from "@talaia/nucleo/idioma.js";
import "./textos.js";

export const MAX_STEPS = 20, MAX_AUTOMATIONS = 100, NAME_MAX = 40, TEXT_MAX = 200;
export const MAX_FOR = 1440, MAX_WAIT = 86400; // minutes (24 h) and seconds (24 h)
export const ASKABLE = ["env", "device", "air", "power", "pos"]; // not the node's info (12 h) nor traceroutes
const TICK = 5000; // times of day and «for N min» are looked at this often
const BRAKE_RUNS = 10, BRAKE_WINDOW = 10 * MIN;
const AFTER_START = 15000; // what came due while stopped, this long after starting (the brokers connect)
const BACK_RETRY = 30000, BACK_TRIES = 20; // turning a switch back: again every 30 s, for 10 min
const BUSY_WAIT = 11000; // a switch still waiting for the answer to another command (paneles: 10 s at most)
const te8 = new TextEncoder();
const bytes = (s) => te8.encode(s).length;

/** An automation's own word for each day: 1 Monday … 7 Sunday (ISO). */
export const isoDay = (d) => d.getDay() || 7;
const pad = (n) => String(n).padStart(2, "0");
const minuteKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/**
 * Checks what a screen sends and builds the automation from it (only the known fields). ctx: { S, paneles }.
 * Returns { auto } or { error } (in the server's language; «Step 2: …» for what is wrong in a step).
 */
export function checkAutomation(input, { S, paneles }) {
  const e = (k, v) => ({ error: tx(k, v) });
  if (!input || typeof input !== "object" || Array.isArray(input)) return e("s.auto.e.bad");
  const name = String(input.name ?? "").trim();
  if (!name) return e("s.auto.e.name");
  if (name.length > NAME_MAX) return e("s.auto.e.nameLong", { n: NAME_MAX });
  const when = checkWhen(input.when, { S, paneles });
  if (when.error) return when;
  if (!Array.isArray(input.steps) || !input.steps.length) return e("s.auto.e.steps");
  if (input.steps.length > MAX_STEPS) return e("s.auto.e.tooMany", { n: MAX_STEPS });
  const steps = [];
  for (const [i, raw] of input.steps.entries()) {
    const s = checkStep(raw, { S, paneles });
    if (s.error) return { error: tx("s.auto.e.step", { n: i + 1, e: s.error }) };
    steps.push(s.step);
  }
  if (steps.every((s) => s.type === "wait")) return e("s.auto.e.onlyWaits");
  const auto = { name, on: input.on !== false, when: when.when, steps };
  if (Number.isInteger(input.id)) auto.id = input.id;
  return { auto };
}

const watchedPanel = (S, num) => Number.isInteger(num) && !!S.cfg.watched[num];
/** What a panel's datum is: { state } for an ON/OFF one, { number } for the rest; null if it isn't there. */
function datumKind(S, paneles, num, key) {
  if (typeof key !== "string") return null;
  if (esClaveMqtt(key)) {
    const d = paneles.dato(num, key);
    return d ? { state: esEstado(d.tipo), d } : null;
  }
  return num >= 0 && Object.hasOwn(METRICS, key) ? { state: false } : null; // a Meshtastic node's reading
}
const minutes = (v, max) => (v == null || v === "" ? 0 : Number.isInteger(v) && v >= 0 && v <= max ? v : NaN);

function checkWhen(w, { S, paneles }) {
  const e = (k, v) => ({ error: tx(k, v) });
  if (!w || typeof w !== "object") return e("s.auto.e.when");
  if (w.type === "value") {
    if (!watchedPanel(S, w.num)) return e("s.auto.e.panel");
    const kind = datumKind(S, paneles, w.num, w.key);
    if (!kind) return e("s.auto.e.datum");
    const forMin = minutes(w.for, MAX_FOR);
    if (Number.isNaN(forMin)) return e("s.auto.e.for", { max: MAX_FOR });
    if (kind.state) {
      if (w.op !== "is" || (w.value !== 0 && w.value !== 1)) return e("s.auto.e.state");
      return { when: { type: "value", num: w.num, key: w.key, op: "is", value: w.value, for: forMin } };
    }
    if (w.op !== "above" && w.op !== "below") return e("s.auto.e.op");
    if (typeof w.value !== "number" || !Number.isFinite(w.value)) return e("s.auto.e.value");
    return { when: { type: "value", num: w.num, key: w.key, op: w.op, value: w.value, for: forMin } };
  }
  if (w.type === "time") {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(w.at ?? ""));
    if (!m) return e("s.auto.e.time");
    if (!Array.isArray(w.days) || !w.days.length || !w.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return e("s.auto.e.days");
    return { when: { type: "time", at: w.at, days: [...new Set(w.days)].sort((a, b) => a - b) } };
  }
  return e("s.auto.e.when");
}

function checkStep(s, { S, paneles }) {
  const e = (k, v) => ({ error: tx(k, v) });
  if (!s || typeof s !== "object") return e("s.auto.e.stepType");
  if (s.type === "switch") {
    const d = Number.isInteger(s.num) && typeof s.key === "string" ? paneles.dato(s.num, s.key) : null;
    if (!d || !watchedPanel(S, s.num) || !d.orden) return e("s.auto.e.switch");
    if (s.value !== 0 && s.value !== 1) return e("s.auto.e.onOff");
    const forMin = minutes(s.for, MAX_FOR);
    if (Number.isNaN(forMin)) return e("s.auto.e.for", { max: MAX_FOR });
    return { step: { type: "switch", num: s.num, key: s.key, value: s.value, for: forMin || null } };
  }
  if (s.type === "wait") {
    if (!Number.isInteger(s.seconds) || s.seconds < 1 || s.seconds > MAX_WAIT) return e("s.auto.e.wait");
    return { step: { type: "wait", seconds: s.seconds } };
  }
  if (s.type === "message") {
    const to = s.to && typeof s.to === "object" ? s.to : {};
    let spec;
    if (to.channel != null) {
      if (!S.channels.length) return e("s.auto.e.noChannels");
      const ch = S.channels.find((c) => c.index === to.channel);
      if (!ch) return e("s.auto.e.to");
      if (!ch.private) return e("s.auto.e.public", { name: ch.name });
      spec = { channel: ch.index };
    } else if (to.node != null) {
      if (!Number.isInteger(to.node) || to.node < 0 || to.node === S.myNode || !S.nodes.has(to.node)) return e("s.auto.e.to");
      spec = { node: to.node };
    } else return e("s.auto.e.to");
    const text = String(s.text ?? "").trim();
    if (!text) return e("s.auto.e.text");
    if (bytes(text) > TEXT_MAX) return e("s.auto.e.textLong", { n: TEXT_MAX });
    return { step: { type: "message", to: spec, text } };
  }
  if (s.type === "ask") {
    if (!Number.isInteger(s.num) || s.num < 0 || s.num === S.myNode || !S.nodes.has(s.num)) return e("s.auto.e.node");
    if (!ASKABLE.includes(s.what)) return e("s.auto.e.ask");
    return { step: { type: "ask", num: s.num, what: s.what } };
  }
  return e("s.auto.e.stepType");
}

/**
 * The server's automations. paneles: for the switches (mandar, dato). eventos: «valor» (num, key) when a datum of a
 * watched panel has a newer value; it emits «parte» «automations». timing: shorter times for the tests (ms in a
 * minute and in a second, and the other waits).
 */
export function createAutomations({ S, motor, paneles, almacen, eventos, registro, timing = {} }) {
  const T = { min: MIN, sec: 1000, tick: TICK, afterStart: AFTER_START, retry: BACK_RETRY, ...timing };
  const cfg = almacen.leer("automations", null) || { next: 1, list: [] };
  const run = { runs: {}, backs: {}, last: {}, ...(almacen.leer("automationsRun", null) || {}) };
  // In memory: whether each «value» one can fire (it has stopped holding since it last did) and since when it holds.
  const arm = new Map(); // id → { armed, since }
  const tokens = new Map(); // id → number: a new run (or a cancelled one) makes the old one stop where it is
  const fired = new Map(); // id → times it ran by itself lately (the brake)
  const timers = new Map(); // "run:<id>" | "back:<num>|<key>" → timeout
  let tickId = null;
  let alive = true;

  const byId = (id) => cfg.list.find((a) => a.id === id) || null;
  const by = (name) => tx("s.auto.by", { name });
  const panelDatum = (num, key) => `${motor.nodeName(num)} · ${metricMeta(key).label}`;

  function publish() {
    S.automations = {
      list: cfg.list,
      runs: Object.fromEntries(Object.entries(run.runs).map(([id, r]) => [id, { step: r.step, at: r.at }])),
      backs: Object.values(run.backs).map(({ id, num, key, value, at }) => ({ id, num, key, value, at })),
      last: run.last,
    };
    eventos.emit("parte", "automations");
  }
  const saveCfg = () => { almacen.guardar("automations", cfg); publish(); };
  const saveRun = () => { almacen.guardar("automationsRun", run); publish(); };
  const log = (text, num = null, extra = null) => motor.addLog("info", text, num, extra);

  /* ── when: a datum's value ── */
  const metric = (w) => S.nodes.get(w.num)?.metrics?.[w.key];
  function holds(w, m) {
    if (!m || !isNum(m.v)) return false;
    if (w.op === "is") return m.v === w.value;
    return w.op === "above" ? m.v > w.value : m.v < w.value;
  }
  /** Far enough from the line to be ready for the next crossing (a reading that wobbles on it doesn't fire again). */
  function clearlyNot(w, m) {
    if (!m || !isNum(m.v)) return true;
    if (w.op === "is") return m.v !== w.value;
    const hy = metricMeta(w.key).hyst || 0;
    return w.op === "above" ? m.v <= w.value - hy : m.v >= w.value + hy;
  }
  const sinceOf = (w, m) => (w.op === "is" ? m.desde ?? m.t : m.t);
  /** What holds now doesn't fire; a state «for N min» that isn't there yet still does when it gets there. */
  function baseline(a) {
    if (a.when.type !== "value") return;
    const w = a.when, m = metric(w);
    if (!holds(w, m)) return arm.set(a.id, { armed: true, since: null });
    const since = sinceOf(w, m);
    const reached = w.op !== "is" || Date.now() - since >= (w.for || 0) * T.min;
    arm.set(a.id, reached ? { armed: false, since: null } : { armed: true, since });
  }
  function check(a) {
    const w = a.when, m = metric(w);
    const st = arm.get(a.id) || { armed: true, since: null };
    arm.set(a.id, st);
    if (!holds(w, m)) {
      st.since = null;
      if (clearlyNot(w, m)) st.armed = true;
      return;
    }
    if (!st.armed) return;
    if (st.since == null) st.since = sinceOf(w, m);
    if (Date.now() - st.since < (w.for || 0) * T.min) return;
    st.armed = false;
    st.since = null;
    fire(a, { why: whyValue(w, m), key: w.key, value: m.v });
  }
  function whyValue(w, m) {
    const what = panelDatum(w.num, w.key);
    let why;
    if (w.op === "is") why = tx("s.auto.why.is", { what, value: fmtWithUnit(w.key, m.v) });
    else why = tx(w.op === "above" ? "s.auto.why.above" : "s.auto.why.below", { what, limit: fmtLimit(w.key, w.value, true), value: fmtWithUnit(w.key, m.v) });
    return w.for ? tx("s.auto.why.for", { why, d: dur(w.for * MIN) }) : why;
  }

  /* ── running ── */
  function fire(a, c, { manual = false } = {}) {
    const now = Date.now();
    if (!manual) {
      if (!a.on) return;
      const ts = (fired.get(a.id) || []).filter((t) => now - t < BRAKE_WINDOW * (T.min / MIN));
      ts.push(now);
      fired.set(a.id, ts);
      if (ts.length > BRAKE_RUNS) {
        a.on = false;
        a.paused = now;
        fired.delete(a.id);
        cancel(a.id);
        saveCfg();
        log(tx("s.log.autoBrake", { name: a.name, n: BRAKE_RUNS, d: dur(BRAKE_WINDOW) }), a.when.num ?? null);
        return;
      }
    }
    cancel(a.id); // a trigger while it's waiting starts it again
    run.last[a.id] = { t: now };
    saveRun();
    log(tx("s.log.autoRun", { name: a.name, why: c.why }), a.when.num ?? null);
    steps(a, 0, c, tokens.get(a.id));
  }
  /** Stops a run where it is (its waits): not what it turned on «for N min», that still goes back. */
  function cancel(id) {
    tokens.set(id, (tokens.get(id) || 0) + 1);
    clearTimeout(timers.get(`run:${id}`));
    timers.delete(`run:${id}`);
    if (run.runs[id]) { delete run.runs[id]; saveRun(); }
  }
  async function steps(a, from, c, token) {
    for (let i = from; i < a.steps.length; i++) {
      if (!alive || tokens.get(a.id) !== token) return;
      const s = a.steps[i];
      if (s.type === "wait") {
        if (i === a.steps.length - 1) break; // nothing after it
        run.runs[a.id] = { step: i + 1, at: Date.now() + s.seconds * T.sec, c: { key: c.key ?? null, value: c.value ?? null } };
        saveRun();
        schedule(`run:${a.id}`, run.runs[a.id].at, () => resume(a.id));
        return;
      }
      try {
        await step(a, s, c);
      } catch (err) {
        registro.error(tx("s.j.autoFail", { name: a.name, e: err.stack || err }));
      }
    }
  }
  function resume(id, late = false) {
    timers.delete(`run:${id}`);
    const r = run.runs[id], a = byId(id);
    if (!r) return;
    delete run.runs[id];
    saveRun();
    if (!a) return;
    if (late) log(tx("s.log.autoLate", { name: a.name }), a.when.num ?? null);
    steps(a, r.step, r.c || {}, tokens.get(id));
  }
  function fail(a, what, e) { log(tx("s.log.autoFail", { name: a.name, what, e }), a.when.num ?? null); }

  /** A command to a switch; if another one to it is still waiting for its answer (10 s at most), after that one. */
  async function send(num, key, v, who) {
    const until = Date.now() + BUSY_WAIT;
    for (;;) {
      const r = await paneles.mandar(num, key, v, { by: who });
      if (r.code !== "busy" || Date.now() > until || !alive) return r;
      await new Promise((ok) => setTimeout(ok, 250).unref?.());
    }
  }

  async function step(a, s, c) {
    if (s.type === "switch") {
      const k = `${s.num}|${s.key}`;
      dropBack(k); // the last command an automation sends to a switch is what counts
      const r = await send(s.num, s.key, s.value, by(a.name));
      if (!r.ok) fail(a, switchText(s.num, s.key, s.value), r.error);
      if (s.for) {
        run.backs[k] = { id: a.id, name: a.name, num: s.num, key: s.key, value: s.value ? 0 : 1, at: Date.now() + s.for * T.min, tries: 0 };
        saveRun();
        schedule(`back:${k}`, run.backs[k].at, () => back(k));
      }
      return;
    }
    if (s.type === "message") {
      const what = tx("s.auto.step.message", { to: targetName(s.to) });
      if (!motor.meshSay(s.to, fill(s.text, c))) fail(a, what, tx("s.auto.e.notSent"));
      return;
    }
    if (s.type === "ask") {
      // The engine says why it doesn't ask (not connected, too soon) as a short message to whoever pressed: here, the log.
      const said = [];
      const hear = (m) => said.push(m);
      eventos.on("toast", hear);
      try { motor.ask(s.num, s.what); } finally { eventos.off("toast", hear); }
      if (said.length) fail(a, tx("s.auto.step.ask", { what: ASK_ALL[s.what].label, node: motor.nodeName(s.num) }), said[0]);
    }
  }
  const switchText = (num, key, v) => {
    const d = paneles.dato(num, key);
    return tx("s.auto.step.switch", { what: panelDatum(num, key), value: d ? textoDato(d, v) : String(v) });
  };
  function targetName(to) {
    if (to.channel != null) return tx("mesh.channel", { name: S.channels.find((c) => c.index === to.channel)?.name || to.channel });
    return motor.nodeName(to.node);
  }
  /** {valor} / {value}: the datum that fired it, with its unit; {hora} / {time}: now. */
  function fill(text, c) {
    const v = c.key && isNum(c.value) ? fmtWithUnit(c.key, c.value) : "—";
    return fitBytes(text.replace(/\{(valor|value)\}/gi, v).replace(/\{(hora|time)\}/gi, hhmm.format(new Date())), TEXT_MAX);
  }

  /* ── switches back after «for N min» ── */
  function dropBack(k) {
    clearTimeout(timers.get(`back:${k}`));
    timers.delete(`back:${k}`);
    if (run.backs[k]) { delete run.backs[k]; saveRun(); }
  }
  async function back(k) {
    timers.delete(`back:${k}`);
    const b = run.backs[k];
    if (!b || !alive) return;
    const r = await send(b.num, b.key, b.value, by(b.name));
    if (run.backs[k] !== b) return; // a newer command to it meanwhile
    const what = switchText(b.num, b.key, b.value);
    if (r.ok || r.code === "gone" || r.code === "nocmd" || b.tries >= BACK_TRIES) {
      delete run.backs[k];
      saveRun();
      if (!r.ok) log(tx(r.code === "gone" || r.code === "nocmd" ? "s.log.autoFail" : "s.log.autoBackGaveUp", { name: b.name, what, e: r.error }), b.num);
      return;
    }
    if (!b.tries) log(tx("s.log.autoBackRetry", { name: b.name, what, e: r.error }), b.num);
    b.tries++;
    b.at = Date.now() + T.retry;
    saveRun();
    schedule(`back:${k}`, b.at, () => back(k));
  }

  function schedule(k, at, f) {
    clearTimeout(timers.get(k));
    const tm = setTimeout(f, Math.max(0, at - Date.now()));
    tm.unref?.();
    timers.set(k, tm);
  }

  /* ── when: a time of day; and «for N min» that may have been reached ── */
  function tick() {
    const now = Date.now(), d = new Date(now);
    const at = `${pad(d.getHours())}:${pad(d.getMinutes())}`, day = isoDay(d), key = minuteKey(now);
    for (const a of cfg.list) {
      if (!a.on) continue;
      if (a.when.type === "time") {
        if (a.when.at === at && a.when.days.includes(day) && (!run.last[a.id] || minuteKey(run.last[a.id].t) !== key)) fire(a, { why: tx("s.auto.why.time", { time: at }) });
      } else if (a.when.type === "value" && a.when.for) check(a);
    }
  }

  eventos.on("valor", (num, key) => {
    for (const a of cfg.list) if (a.on && a.when.type === "value" && a.when.num === num && a.when.key === key) check(a);
  });

  for (const a of cfg.list) baseline(a);
  publish();

  return {
    /** Creates (without id) or changes one: { ok, id, toast } or { ok: false, error }. */
    save(input) {
      const r = checkAutomation(input, { S, paneles });
      if (r.error) return { ok: false, error: r.error };
      const a = r.auto;
      if (a.id != null) {
        const i = cfg.list.findIndex((x) => x.id === a.id);
        if (i < 0) return { ok: false, error: tx("s.auto.e.gone") };
        cancel(a.id); // what it was doing belongs to the old version
        fired.delete(a.id);
        cfg.list[i] = a;
        log(tx("s.log.autoChanged", { name: a.name }));
      } else {
        if (cfg.list.length >= MAX_AUTOMATIONS) return { ok: false, error: tx("s.auto.e.full", { n: MAX_AUTOMATIONS }) };
        a.id = cfg.next++;
        cfg.list.push(a);
        log(tx("s.log.autoNew", { name: a.name }));
      }
      baseline(a);
      saveCfg();
      return { ok: true, id: a.id, toast: tx("s.auto.saved", { name: a.name }) };
    },
    remove(id) {
      const a = byId(id);
      if (!a) return { ok: false, error: tx("s.auto.e.gone") };
      cancel(id);
      cfg.list = cfg.list.filter((x) => x !== a);
      delete run.last[id];
      arm.delete(id);
      fired.delete(id);
      saveRun();
      saveCfg();
      log(tx("s.log.autoRemoved", { name: a.name }));
      return { ok: true, toast: tx("s.auto.removed", { name: a.name }) };
    },
    /** Switched on or off from the screen (on again after the brake, too). Off, it stops where it was. */
    setOn(id, on) {
      const a = byId(id);
      if (!a) return { ok: false, error: tx("s.auto.e.gone") };
      if (a.on === !!on && !a.paused) return { ok: true };
      a.on = !!on;
      delete a.paused;
      fired.delete(id);
      if (a.on) baseline(a);
      else cancel(id);
      saveCfg();
      log(tx(a.on ? "s.log.autoOn" : "s.log.autoOff", { name: a.name }));
      return { ok: true, toast: tx(a.on ? "s.auto.onToast" : "s.auto.offToast", { name: a.name }) };
    },
    /** Its steps now, as if it had fired (also when it's off: to try it out). */
    runNow(id) {
      const a = byId(id);
      if (!a) return { ok: false, error: tx("s.auto.e.gone") };
      fire(a, { why: tx("s.auto.why.manual") }, { manual: true });
      return { ok: true, toast: tx("s.auto.running", { name: a.name }) };
    },
    start() {
      // What was waiting when the server stopped: what is already due goes a little after starting.
      for (const id of Object.keys(run.runs)) {
        const r = run.runs[id], late = r.at <= Date.now();
        if (!byId(Number(id))) { delete run.runs[id]; continue; }
        schedule(`run:${id}`, late ? Date.now() + T.afterStart : r.at, () => resume(Number(id), late));
      }
      for (const k of Object.keys(run.backs)) {
        const b = run.backs[k];
        schedule(`back:${k}`, b.at <= Date.now() ? Date.now() + T.afterStart : b.at, () => back(k));
      }
      saveRun();
      tickId = setInterval(tick, T.tick);
      tickId.unref?.();
      const n = cfg.list.filter((a) => a.on).length;
      if (cfg.list.length) registro.info(tx("s.j.automations", { n: cfg.list.length, on: n }));
    },
    stop() {
      alive = false;
      clearInterval(tickId);
      for (const tm of timers.values()) clearTimeout(tm);
      timers.clear();
    },
    /** For the tests: what the clock does every few seconds. */
    tick,
    get list() { return cfg.list; },
  };
}
