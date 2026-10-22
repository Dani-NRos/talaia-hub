// Lo que cambia el usuario (vigilar, límites, cambio rápido, valla, ajustes, avisos por la malla), sin pantalla.
// Lo usan la app (sin servidor) y el servidor (cuando la orden llega de una pantalla conectada a él), así una misma
// acción hace lo mismo y deja los mismos textos en el registro, se pulse donde se pulse.
//
// Cada acción devuelve { ok, toast?, error? }: toast es el mensaje corto para quien pulsó; error, por qué no se hizo.
// Lo que escribe el usuario (comas decimales, textos) se interpreta en la pantalla: aquí llegan números o null.
import { metricMeta, fmtLimit } from "./metrics.js";
import { fmtDist } from "./geo.js";
import { parseTrendRule } from "./trend.js";
import { MIN, HOUR, isNum, dur, trendVerb, hoursText } from "./textos.js";
import { seriesKey, trendKey, estadoKey } from "./motor.js";
import { tx } from "./idioma.js";

export function crearAcciones(motor) {
  const { S } = motor;
  const saveCfg = () => motor.guardar("cfg");

  /** Carga en memoria las lecturas de las últimas 26 h (para gráficas y cambio rápido). Sin nums, las de los vigilados. */
  async function cargarRecientes(nums) {
    const list = nums || Object.keys(S.cfg.watched).map(Number);
    const since = Date.now() - 26 * HOUR;
    for (const num of list) {
      const n = S.nodes.get(num);
      if (!n) continue;
      for (const k of Object.keys(n.metrics)) {
        const ser = await S.store.series(num, k, since);
        if (ser.length) S.recent.set(seriesKey(num, k), ser);
      }
    }
  }

  function vigilar(num) {
    if (motor.isWatched(num)) return { ok: false };
    S.cfg.watched[num] = { offlineMin: S.settings.defaultOfflineMin, rules: {} };
    saveCfg();
    const recientes = cargarRecientes([num]);
    motor.addLog("info", tx("log.watch", { name: motor.nodeName(num) }), num);
    motor.evalNode(num);
    return { ok: true, recientes, toast: tx("act.watched", { name: motor.nodeName(num) }) };
  }

  function dejarDeVigilar(num) {
    delete S.cfg.watched[num];
    saveCfg();
    for (const k of [...S.active.keys()]) if (S.active.get(k).num === num) motor.clearAlarm(k, { silent: true });
    motor.addLog("info", tx("log.unwatch", { name: motor.nodeName(num) }), num);
    return { ok: true };
  }

  /** Minutos sin señal para avisar (null: no avisar). */
  function ponerSinSenal(num, v) {
    const w = S.cfg.watched[num];
    if (!w) return { ok: false };
    if (Number.isNaN(v) || (v !== null && v < 1)) return { ok: false, error: tx("act.offErr") };
    w.offlineMin = v === null ? 0 : Math.round(v);
    saveCfg();
    motor.evalOffline();
    return { ok: true, toast: v === null ? tx("act.offOff") : tx("act.offOn", { d: dur(w.offlineMin * MIN) }) };
  }

  /** Mínimo o máximo de una métrica (side: «min» o «max»; v: número o null para quitarlo). */
  function ponerLimite(num, k, side, v) {
    const w = S.cfg.watched[num];
    if (!w || (side !== "min" && side !== "max")) return { ok: false };
    if (v !== null && !isNum(v)) return { ok: false, error: tx("act.notNumber") };
    w.rules = w.rules || {};
    const r = { ...(w.rules[k] || {}) };
    if (v === null) delete r[side]; else r[side] = v;
    if (isNum(r.min) && isNum(r.max) && r.min >= r.max) return { ok: false, error: tx("act.minMax", { label: metricMeta(k).label.toLowerCase() }) };
    if (isNum(r.min) || isNum(r.max) || r.trend || r.estado) w.rules[k] = r; else delete w.rules[k];
    saveCfg();
    const cur = S.nodes.get(num)?.metrics[k];
    if (cur) motor.evalThreshold(num, k, cur.v, cur.t);
    else { motor.clearAlarm(`${num}|${k}|high`, { silent: true }); motor.clearAlarm(`${num}|${k}|low`, { silent: true }); }
    return { ok: true, toast: tx("act.limitSaved") };
  }

  /** Aviso de cambio rápido: rule = { dir: «down» | «up», delta, hours }. */
  function ponerTendencia(num, k, rule) {
    const w = S.cfg.watched[num];
    if (!w) return { ok: false };
    const { rule: ok, error } = parseTrendRule(rule?.dir, rule?.delta, rule?.hours);
    if (error) return { ok: false, error };
    w.rules = w.rules || {};
    const had = !!w.rules[k]?.trend;
    w.rules[k] = { ...(w.rules[k] || {}), trend: ok };
    saveCfg();
    motor.addLog("info", tx("log.trendSet", { name: motor.nodeName(num), label: metricMeta(k).label, verb: trendVerb(ok.dir), limit: fmtLimit(k, ok.delta, true), hours: hoursText(ok.hours) }), num);
    motor.evalTrend(num, k, { strict: true });
    return { ok: true, toast: tx(had ? "act.trendUpdated" : "act.trendAdded") };
  }

  /**
   * Alarma de un dato ON/OFF (servidor): cuando: 1 (ON) | 0 (OFF) | null (no avisar); min: minutos que tiene que
   * durar ese estado para avisar (0 o null: al momento).
   */
  function ponerEstado(num, k, cuando, min) {
    const w = S.cfg.watched[num];
    const m = metricMeta(k);
    if (!w || !m.estados) return { ok: false };
    if (cuando !== null && cuando !== 0 && cuando !== 1) return { ok: false };
    const minutos = min == null ? 0 : min;
    if (!(Number.isInteger(minutos) && minutos >= 0 && minutos <= 7 * 24 * 60)) return { ok: false, error: tx("act.stateMinErr") };
    w.rules = w.rules || {};
    const r = { ...(w.rules[k] || {}) };
    if (cuando === null) delete r.estado; else r.estado = { cuando, min: minutos };
    if (Object.keys(r).length) w.rules[k] = r; else delete w.rules[k];
    saveCfg();
    motor.evalEstado(num, k, { strict: true });
    if (cuando === null) { motor.clearAlarm(estadoKey(num, k), { silent: true }); return { ok: true, toast: tx("act.alarmRemoved") }; }
    return { ok: true, toast: tx("act.stateSet", { state: m.estados[cuando ? 0 : 1], d: minutos ? tx("act.stateFor", { d: dur(minutos * MIN) }) : "" }) };
  }

  function quitarTendencia(num, k) {
    const w = S.cfg.watched[num];
    if (!w?.rules?.[k]?.trend) return { ok: false };
    delete w.rules[k].trend;
    if (!Object.keys(w.rules[k]).length) delete w.rules[k];
    saveCfg();
    motor.clearAlarm(trendKey(num, k), { silent: true });
    motor.addLog("info", tx("log.trendRemoved", { name: motor.nodeName(num), label: metricMeta(k).label.toLowerCase() }), num);
    return { ok: true, toast: tx("act.alarmRemoved") };
  }

  /* ── valla antirrobo ── */
  const radioMal = (r) => !r || Number.isNaN(r) || r < 20;
  function fijarValla(num, r) {
    if (!S.cfg.watched[num] || !S.nodes.get(num)?.pos) return { ok: false };
    if (radioMal(r)) return { ok: false, error: tx("act.radiusErr") };
    if (!motor.setFence(num, r)) return { ok: false };
    return { ok: true, toast: tx("act.fenceSet") };
  }
  function radioValla(num, r) {
    const w = S.cfg.watched[num];
    if (!w?.fence) return { ok: false };
    if (radioMal(r)) return { ok: false, error: tx("act.radiusErr"), radio: w.fence.r };
    motor.setFenceRadius(num, r);
    return { ok: true, toast: tx("act.radius", { r: fmtDist(w.fence.r) }) };
  }
  function quitarValla(num) {
    return { ok: motor.delFence(num) };
  }

  /* ── ajustes ── */
  /** Minutos sin señal que se ponen a los nodos que se empiezan a vigilar. */
  function sinSenalPorDefecto(v) {
    if (!v || Number.isNaN(v) || v < 1) return { ok: false, error: tx("act.offDefaultErr"), valor: S.settings.defaultOfflineMin };
    S.settings.defaultOfflineMin = Math.round(v);
    motor.guardar("settings");
    return { ok: true, toast: tx("act.saved") };
  }
  function retencion(dias) {
    if (!(Number.isFinite(dias) && dias >= 1)) return { ok: false };
    S.settings.retentionDays = dias;
    motor.guardar("settings");
    return { ok: true, poda: S.store.prune(Date.now() - dias * 24 * HOUR) };
  }

  /* ── avisos por la malla ── */
  const saveMeshCfg = () => { if (!S.demo) motor.guardar("settings"); };
  /** cambio: { enabled } | { onClear } | { channel: índice o null } | { node: número o null } */
  function avisosMalla(cambio) {
    const cfg = motor.meshCfg();
    if ("enabled" in cambio || "onClear" in cambio) {
      if ("enabled" in cambio) cfg.enabled = !!cambio.enabled; else cfg.onClear = !!cambio.onClear;
      saveMeshCfg();
      if (cambio.enabled && cfg.channel == null && cfg.node == null) return { ok: true, toast: tx("act.chooseTarget") };
      return { ok: true };
    }
    if ("channel" in cambio) {
      const v = cambio.channel;
      const ch = S.channels.find((c) => c.index === v);
      if (v != null && !ch?.private) { cfg.channel = null; saveMeshCfg(); return { ok: false, toast: tx("act.publicChannel") }; }
      cfg.channel = v;
      saveMeshCfg();
      return { ok: true };
    }
    if ("node" in cambio) {
      cfg.node = cambio.node;
      saveMeshCfg();
      return { ok: true };
    }
    return { ok: false };
  }
  function pruebaMalla() {
    if (!S.demo && S.link.state !== "ready") return { ok: false, toast: tx("act.connectForTest") };
    motor.meshNotify("test");
    return { ok: true };
  }

  async function borrarHistorico() {
    await S.store.clear();
    S.recent = new Map();
    return { ok: true, toast: tx("act.historyWiped") };
  }

  return {
    cargarRecientes, vigilar, dejarDeVigilar, ponerSinSenal, ponerLimite, ponerTendencia, quitarTendencia, ponerEstado,
    fijarValla, radioValla, quitarValla, sinSenalPorDefecto, retencion, avisosMalla, pruebaMalla, borrarHistorico,
  };
}
