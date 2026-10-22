// Paneles del servidor: nombres propios, paneles sin nodo y datos que llegan por MQTT.
//
//  - Cualquier panel (el de un nodo Meshtastic vigilado o uno sin nodo) se puede renombrar y llevar datos MQTT: cada
//    dato tiene broker, tema, campo, tipo, unidad y nombre, y se guarda como una lectura más del panel con su propia
//    clave («mq3»), así tiene gráficas, alarmas e histórico como cualquier métrica. Como mucho una lectura por minuto
//    y dato (la última que llegó); en pantalla se ve al momento.
//  - Los paneles sin nodo son números negativos (ningún nodo Meshtastic los tiene): un nodo «de mentira» en S.nodes,
//    vigilado, que reutiliza todo lo del motor. «Sin datos» usa la hora del último dato (apagado por defecto).
//  - Los datos del panel del receptor marcados «a la malla» salen cada cierto tiempo como su telemetría de ambiente.
//  - Estados ON/OFF (tipo «estado»): se guardan como 1 y 0, cada cambio al momento (y, si no cambia, uno por hora); el
//    motor sabe desde cuándo está cada uno («desde») para avisar de «abierta más de 10 min».
//  - Un panel sin nodo puede tener un tema de conexión (el LWT de Tasmota, el «online» de Shelly…): «Sin conexión» en
//    el panel al momento y, si se pide, su alarma.
//  - Un estado con «orden» se enciende y apaga desde Vigía (sin confirmación, como decidió Dani): se publica el mensaje
//    en su tema y se espera a que el tema de estado diga que ha cambiado (si en 10 s no lo dice, «no ha contestado»).
//  - Los Shelly no dejan su estado guardado en el broker: al conectar con él se les pide (status_update / update).
//
// Configuración en SQLite («paneles»); lo que ven las pantallas, en S.paneles (parte «paneles»). Lo de la 1.16 (la
// estación, en Ajustes) se migra al panel del receptor: ver migrarEstacion.
import { create, toBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import {
  comprobarDatos, comprobarMalla, comprobarConexion, leerValor, leerEstado, pareceEstado, pareceConexion, convertir,
  unidades, textoValores, textoDato, proximoEnvio, metasDe, nombreDato, esEstado, pedirEstadoShelly, TIPOS_PANEL,
  MALLA_DEFECTO, TIPOS,
} from "@vigia/nucleo/mqtt-datos.js";
import { registrarMetricas } from "@vigia/nucleo/metrics.js";
import { RE, trendKey, conexionKey } from "@vigia/nucleo/motor.js";
import { hhmm } from "@vigia/nucleo/textos.js";
import { tx } from "@vigia/nucleo/idioma.js";
import "./textos.js";

const BUSCAR_MS = 3000; // al buscar temas, cuánto se escucha cada broker
const BUSCAR_MAX = 2000; // un broker con mucho retenido (Home Assistant, zigbee2mqtt…) tiene cientos
const A_MANO_MS = 60000; // entre dos «Enviar ahora»
const LECTURA_MS = 60000; // cada dato se guarda como lectura como mucho una vez por minuto
const ESTADO_MS = 3600000; // un estado, al cambiar; si no cambia, como mucho una vez por hora
const ORDEN_MS = 10000; // lo que se espera a que un dispositivo diga que ha hecho la orden

/** Un Telemetry con la telemetría de ambiente, codificado. valores: { tipo: número } en unidades de Meshtastic. */
export function telemetriaAmbiente(valores, segundos) {
  const TEL = Protobuf.Telemetry;
  const m = {};
  for (const [k, v] of Object.entries(valores)) m[k] = k === "soilMoisture" ? Math.round(v) : v; // es un entero
  const tel = create(TEL.TelemetrySchema, { time: segundos, variant: { case: "environmentMetrics", value: create(TEL.EnvironmentMetricsSchema, m) } });
  return toBinary(TEL.TelemetrySchema, tel);
}

/** Los números y los estados ON/OFF de un JSON, con su ruta («temperature», «ENERGY.Power», «contact»), hasta 3 niveles. */
function numerosDe(obj, ruta = "", out = [], nivel = 0) {
  if (nivel > 3 || !obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const r = ruta ? `${ruta}.${k}` : k;
    if (typeof v === "number" && Number.isFinite(v)) out.push({ campo: r, v });
    else if (pareceEstado(v)) out.push({ campo: r, v: String(v), estado: true });
    else if (typeof v === "object") numerosDe(v, r, out, nivel + 1);
  }
  return out;
}

const VACIO = () => ({ siguiente: { panel: 1, dato: 1 }, paneles: {}, malla: { ...MALLA_DEFECTO } });

/**
 * La estación de la 1.16 (Ajustes → De MQTT a la malla) pasa a datos MQTT del panel del receptor, con su histórico:
 * sus lecturas estaban en las métricas de Meshtastic del receptor («temperature»…) y pasan a las claves nuevas.
 * Se llama al arrancar, con S ya leído y antes de cargar las lecturas recientes.
 */
export function migrarEstacion({ almacen, S, registro }) {
  const est = almacen.leer("estacion", null);
  if (!est || almacen.leer("paneles", null)) return;
  // Sin saber aún cuál es el receptor (no ha conectado nunca), se espera: se migra al arrancar otra vez.
  if (S.myNode == null && est.datos?.length) return;
  const cfg = VACIO();
  cfg.malla = { activado: !!est.activado, cada: est.cada || 30, canal: est.canal ?? 0, saltos: est.saltos ?? null };
  const me = S.myNode;
  if (me != null && est.datos?.length) {
    const datos = est.datos.map((d, i) => ({ clave: `mq${i + 1}`, nombre: "", tipo: d.metrica, broker: d.broker, tema: d.tema, campo: d.campo || "", unidad: d.unidad, caduca: d.caduca || 0, malla: true }));
    cfg.paneles[me] = { datos };
    cfg.siguiente.dato = datos.length + 1;
    // El panel del receptor tiene que estar en el tablero: es donde se ven y se configuran ahora estos datos.
    S.cfg.watched[me] ||= { offlineMin: S.settings.defaultOfflineMin, rules: {} };
    const n = S.nodes.get(me), w = S.cfg.watched[me];
    for (const d of datos) {
      almacen.lecturas.renombrar(me, d.tipo, d.clave);
      if (n?.metrics?.[d.tipo]) { n.metrics[d.clave] = n.metrics[d.tipo]; delete n.metrics[d.tipo]; }
      if (w?.rules?.[d.tipo]) { w.rules[d.clave] = w.rules[d.tipo]; delete w.rules[d.tipo]; }
      for (const k of [...S.active.keys()]) if (k.startsWith(`${me}|${d.tipo}|`) || k === trendKey(me, d.tipo)) S.active.delete(k);
    }
    almacen.guardar("nodes", [...S.nodes.values()]);
    almacen.guardar("cfg", S.cfg);
    almacen.guardar("active", [...S.active.values()]);
  }
  almacen.guardar("paneles", cfg);
  almacen.guardar("mallaUltimo", almacen.leer("estacionUltimo", null));
  almacen.guardar("estacionVieja", est); // por si acaso
  almacen.guardar("estacion", null);
  registro.info(tx("s.j.stationMoved", { n: cfg.paneles[me]?.datos.length || 0 }));
}

/**
 * vigia: { S, motor, eventos, almacen, registro, receptor: () => el receptor actual, brokers: () => [{ id, nombre }] }.
 */
export function crearPaneles({ S, motor, eventos, almacen, registro, receptor, brokers = () => [] }) {
  let cfg = { ...VACIO(), ...(almacen.leer("paneles", null) || {}) };
  const valores = new Map(); // clave → { v, t, b?, u? } | { nulo, t } | { error, t }; v ya en la unidad de Vigía
  const porClave = new Map(); // clave → { num, d }
  const conexiones = new Map(); // id del broker → su conexión
  const quitar = new Map(); // id del broker → cómo quitar sus suscripciones
  const pendientes = new Map(); // clave → { num, v, t, timer }: lectura por guardar (una por minuto)
  const guardadoT = new Map(); // clave → cuándo se guardó la última
  const guardadoV = new Map(); // clave → el último valor guardado (para los estados: cada cambio se guarda)
  const conexionV = new Map(); // num del panel → lo último de su tema de conexión: { v: 1 | 0, t } | { error, t } | { nulo, t }
  const ordenes = new Map(); // clave → la orden que espera respuesta { num, v, t, timer } o la que no la tuvo { v, t, error }
  let timer = null, proximo = null, contarT = null, vivo = true;
  let ultimo = almacen.leer("mallaUltimo", null), ultimoFallo = null, aMano = 0;

  const guardar = () => almacen.guardar("paneles", cfg);
  const panel = (num) => cfg.paneles[num] || null;
  const nombrePanel = (num) => motor.nodeName(num);

  /** Lo que se deduce de la configuración: las claves, las métricas para la pantalla y los nodos de los paneles. */
  function aplicar() {
    porClave.clear();
    for (const [k, p] of Object.entries(cfg.paneles)) for (const d of p.datos || []) porClave.set(d.clave, { num: Number(k), d });
    registrarMetricas(metasDe(cfg.paneles));
    for (const [k, p] of Object.entries(cfg.paneles)) {
      const num = Number(k);
      if (num < 0) {
        const n = motor.node(num);
        Object.assign(n, { long: p.nombre, short: TIPOS_PANEL[p.tipo]?.corto || "MQTT", fuente: "mqtt", tipoPanel: p.tipo });
      } else if (S.nodes.has(num) || p.nombre) {
        const n = motor.node(num);
        if (p.nombre) n.alias = p.nombre;
        else delete n.alias;
      }
    }
    for (const k of [...valores.keys()]) if (!porClave.has(k)) valores.delete(k);
  }

  /** Lo que no puede venir de MQTT: lo que publica el propio Vigía (haría un bucle malla → MQTT → malla). */
  function temaProhibido(tema) {
    const base = S.mqtt?.ha?.base || "vigia";
    if (tema === base || tema.startsWith(`${base}/`) || tema.split("/").some((p) => p.startsWith("vigia_"))) {
      return tx("s.pan.ownTopic");
    }
    return null;
  }

  /** Lo que saldría ahora a la malla: los datos del receptor marcados, con valor y al día; y los que no, con el motivo. */
  function alDia(ahora = Date.now()) {
    const vals = {}, faltan = [];
    for (const d of (S.myNode != null && panel(S.myNode)?.datos) || []) {
      if (!d.malla) continue;
      const x = valores.get(d.clave);
      const nombre = nombreDato(d);
      if (!x) faltan.push(tx("s.pan.missingNotYet", { name: nombre }));
      else if (x.error) faltan.push(`${nombre} (${x.error})`);
      else if (x.nulo) faltan.push(tx("s.pan.missingNull", { name: nombre }));
      else if (d.caduca && ahora - x.t > d.caduca * 60000) faltan.push(tx("s.pan.missingStale", { name: nombre, time: hhmm.format(new Date(x.t)) }));
      else vals[d.tipo] = x.v;
    }
    return { vals, faltan };
  }

  function contar() {
    clearTimeout(contarT);
    contarT = null;
    const previo = alDia();
    S.paneles = {
      paneles: cfg.paneles,
      valores: Object.fromEntries(valores),
      malla: { ...cfg.malla, proximo, ultimo, previo: { texto: textoValores(previo.vals), faltan: previo.faltan } },
      conexion: Object.fromEntries(conexionV),
      ordenes: Object.fromEntries([...ordenes].map(([k, o]) => [k, o.error ? { v: o.v, t: o.t, error: o.error } : { v: o.v, t: o.t, enviando: true }])),
    };
    eventos.emit("parte", "paneles");
  }
  // Los valores pueden llegar a menudo: a las pantallas, como mucho una vez por segundo.
  const contarPronto = () => { if (!contarT) contarT = setTimeout(contar, 1000); };

  /* ── lo que llega por MQTT ── */
  function recibido(broker, tema, carga) {
    const t = Date.now();
    for (const [k, p] of Object.entries(cfg.paneles)) {
      if (p.conexion?.broker === broker && p.conexion.tema === tema) recibidaConexion(Number(k), carga, t);
    }
    for (const { num, d } of porClave.values()) {
      if (d.broker !== broker || d.tema !== tema) continue;
      if (esEstado(d.tipo)) { recibidoEstado(num, d, carga, t); continue; }
      const r = leerValor(carga, d.campo);
      if (r.falta && valores.get(d.clave)?.v != null) continue; // un mensaje de otra clase por el mismo tema: no es para este dato
      if (r.error || r.nulo) { valores.set(d.clave, { ...r, t }); continue; }
      const c = convertir(d.tipo, d.unidad, r.v);
      if (c.error) { valores.set(d.clave, { error: c.error, t }); continue; }
      const otra = d.tipo !== "otro" && d.unidad && d.unidad !== unidades(d.tipo)[0];
      valores.set(d.clave, { v: c.v, t, ...(otra ? { b: r.v, u: d.unidad } : {}) });
      if (S.cfg.watched[num]) {
        // Al momento: el valor en el panel y sus límites (la alarma no espera al minuto de la lectura).
        const n = motor.node(num);
        n.metrics[d.clave] = { v: c.v, t };
        if (num < 0) motor.touch(num, t);
        motor.evalThreshold(num, d.clave, c.v, t);
        cambioNodos = true;
      }
      lectura(num, d.clave, c.v, t);
    }
    if (cambioNodos) { cambioNodos = false; motor.guardar("nodes"); }
    contarPronto();
  }
  let cambioNodos = false;

  /** Un estado ON/OFF: al momento en el panel, con desde cuándo lo tiene, y su alarma. */
  function recibidoEstado(num, d, carga, t) {
    const r = leerEstado(carga, d.campo, d.invertir);
    if (r.falta && valores.get(d.clave)?.v != null) return; // un mensaje de otra clase por el mismo tema
    if (r.v == null) { valores.set(d.clave, { ...r, t }); return; }
    valores.set(d.clave, { v: r.v, t });
    if (S.cfg.watched[num]) {
      const n = motor.node(num);
      const p = n.metrics[d.clave];
      n.metrics[d.clave] = { v: r.v, t, desde: p && p.v === r.v ? (p.desde ?? p.t) : t };
      if (num < 0) motor.touch(num, t);
      motor.evalEstado(num, d.clave);
      cambioNodos = true;
    }
    lectura(num, d.clave, r.v, t, true);
    const o = ordenes.get(d.clave);
    if (o && !o.error && o.v === r.v) { // el dispositivo dice que lo ha hecho
      clearTimeout(o.timer);
      ordenes.delete(d.clave);
      motor.addLog("info", tx("s.log.cmdDone", { panel: nombrePanel(num), datum: nombreDato(d), value: textoDato(d, r.v) }), num);
      contar(); // a las pantallas ya, junto con el estado nuevo (sin el segundo de espera de los valores)
    } else if (o?.error) ordenes.delete(d.clave); // ya ha dicho algo: fuera el «no ha contestado»
  }

  /** Lo que dice el tema de conexión de un panel sin nodo («Online», «Offline», true…). */
  function recibidaConexion(num, carga, t) {
    const c = panel(num)?.conexion;
    if (!c) return;
    const r = leerEstado(carga, c.campo);
    if (r.falta && conexionV.get(num)?.v != null) return;
    if (r.v == null) { conexionV.set(num, { ...r, t }); return; }
    conexionV.set(num, { v: r.v, t });
    const n = motor.node(num);
    if (n.conectado !== (r.v === 1)) {
      n.conectado = r.v === 1;
      n.conectadoT = t;
      cambioNodos = true;
    }
    evalConexion(num);
  }
  /** «Sin conexión»: si el panel lo pide y el dispositivo dice que se ha desconectado. */
  function evalConexion(num) {
    const c = panel(num)?.conexion, n = S.nodes.get(num), key = conexionKey(num);
    if (c?.avisar && S.cfg.watched[num] && n?.conectado === false) motor.raise(key, { num, kind: "conexion", value: n.conectadoT, t: n.conectadoT });
    else if (c?.avisar && n?.conectado === true) motor.clearAlarm(key, { t: n.conectadoT });
    else motor.clearAlarm(key, { silent: true });
  }
  /** Sin tema de conexión (o con otro): ya no se sabe si está conectado. */
  function olvidarConexion(num) {
    conexionV.delete(num);
    const n = S.nodes.get(num);
    if (n) { delete n.conectado; delete n.conectadoT; }
    motor.clearAlarm(conexionKey(num), { silent: true });
  }

  /**
   * Una lectura por minuto y dato: la primera, al momento; las que llegan antes, se queda la última para el final.
   * Un estado: cada cambio, al momento; si no cambia, uno por hora (así la gráfica sabe que sigue igual).
   */
  function lectura(num, clave, v, t, estado = false) {
    const p = pendientes.get(clave);
    if (estado && guardadoV.get(clave) !== v) {
      if (p) { clearTimeout(p.timer); pendientes.delete(clave); }
      // Dos cambios en el mismo milisegundo serían la misma lectura (y se perdería el segundo): uno más tarde.
      return guardarLectura(num, clave, v, Math.max(t, (guardadoT.get(clave) || 0) + 1));
    }
    if (p) { Object.assign(p, { num, v, t }); return; }
    const espera = (guardadoT.get(clave) || 0) + (estado ? ESTADO_MS : LECTURA_MS) - t;
    if (espera <= 0) return guardarLectura(num, clave, v, t);
    const q = { num, v, t, timer: null };
    q.timer = setTimeout(() => { pendientes.delete(clave); guardarLectura(q.num, clave, q.v, q.t); }, espera);
    q.timer.unref?.();
    pendientes.set(clave, q);
  }
  function guardarLectura(num, clave, v, t) {
    if (!vivo || !S.cfg.watched[num] || porClave.get(clave)?.num !== num) return;
    guardadoT.set(clave, t);
    guardadoV.set(clave, v);
    // En un panel sin nodo, que llegue un dato es «dar señal»; en el de un nodo, no (eso es la radio).
    motor.ingest(num, { [clave]: v }, t, { touch: num < 0 });
  }

  /** Los temas de los datos de ese broker (o de todos). Aunque el panel no se vea: así no se pierde nada al volver. */
  function suscribirse(solo = null) {
    for (const [id, con] of conexiones) {
      if (solo && id !== solo) continue;
      for (const q of quitar.get(id) || []) q();
      const temas = new Set([...porClave.values()].filter(({ d }) => d.broker === id).map(({ d }) => d.tema));
      for (const p of Object.values(cfg.paneles)) if (p.conexion?.broker === id) temas.add(p.conexion.tema);
      quitar.set(id, [...temas].map((tema) => con.suscribir(tema, (t, carga) => recibido(id, tema, carga))));
    }
  }

  /** A los Shelly de ese broker, que digan su estado (solo pide información: no cambia nada). */
  function pedirEstados(id) {
    const con = conexiones.get(id);
    if (!con?.conectada) return;
    const pedir = new Map();
    for (const { d } of porClave.values()) {
      const p = d.broker === id && pedirEstadoShelly(d.tema);
      if (p) pedir.set(p.tema, p.carga);
    }
    for (const [tema, carga] of pedir) con.publicar(tema, carga);
  }

  /* ── a la malla ── */
  function programar() {
    clearTimeout(timer);
    timer = null;
    proximo = null;
    if (vivo && cfg.malla.activado) {
      proximo = proximoEnvio(Date.now(), cfg.malla.cada);
      timer = setTimeout(() => { enviar(); programar(); }, proximo - Date.now());
      timer.unref?.();
    }
    contar();
  }

  /** Manda a la malla lo que haya al día (las lecturas ya se guardan al llegar). */
  async function enviar(manual = false) {
    const ahora = Date.now();
    const m = cfg.malla;
    const { vals, faltan } = alDia(ahora);
    const canal = S.channels.find((c) => c.index === m.canal);
    const destino = canal ? tx("mesh.channel", { name: canal.name }) : tx("s.pan.channelN", { n: m.canal });
    const rec = { t: ahora, texto: textoValores(vals), destino, faltan, resultado: tx("mesh.r.sending"), ok: null, manual };
    ultimo = rec;
    const fin = (resultado, ok) => {
      Object.assign(rec, { resultado, ok, tDone: Date.now() });
      if (ok) {
        registro.depurar(tx("s.j.meshOk", { text: rec.texto, to: destino, result: resultado }));
        if (ultimoFallo) registro.info(tx("s.j.meshBack", { to: destino }));
        ultimoFallo = null;
      } else if (resultado !== ultimoFallo) {
        registro.aviso(tx("s.j.meshFail", { text: rec.texto || tx("s.pan.noData"), result: resultado })); // el mismo fallo, una vez
        ultimoFallo = resultado;
      }
      if (ultimo === rec) { almacen.guardar("mallaUltimo", rec); contar(); }
    };
    if (!rec.texto) return fin(tx("s.pan.r.nothing"), false);
    const r = receptor();
    if (!r || S.link.state !== "ready") return fin(tx("s.pan.r.noReceiver"), false);
    if (!canal) return fin(tx(m.canal == null ? "s.pan.r.noChannel" : "s.pan.r.channelGone"), false);
    contar();
    try {
      await r.sendTelemetry(m.canal, telemetriaAmbiente(vals, Math.floor(ahora / 1000)), m.saltos).done;
      fin(tx("mesh.r.relayed"), true);
    } catch (e) {
      const code = e && typeof e === "object" && "error" in e ? e.error : "send";
      fin(code === RE.TIMEOUT ? tx("s.pan.r.noConfirm")
        : code === RE.MAX_RETRANSMIT ? tx("mesh.r.nobody")
          : tx("s.pan.r.failed", { why: motor.askFailText(code) }), false);
    }
  }

  /** Escucha un broker unos segundos: los temas con números (de un JSON, cada campo con número). */
  async function buscarEn(broker, con) {
    const vistos = new Map();
    const uds = new Map(); // mqtt_statestream con publish_attributes: «…/entidad/unit_of_measurement» → «"km/h"»
    const soltar = con.suscribir("#", (tema, carga) => {
      if (tema.endsWith("/unit_of_measurement")) {
        try { const u = JSON.parse(carga.toString()); if (typeof u === "string") uds.set(tema.slice(0, -20), u); } catch { /* no es una unidad */ }
        return;
      }
      if (vistos.size >= BUSCAR_MAX || temaProhibido(tema) || /\/config$/.test(tema) || /(^|\/)bridge\//.test(tema)) return;
      const r = leerValor(carga);
      if (r.v != null) return vistos.set(`${tema}\n`, { broker, tema, campo: "", v: r.v });
      const txt = carga.toString().trim();
      // Un estado («ON», «true», «open»…) o la conexión del dispositivo («Online»).
      if (pareceEstado(txt)) return vistos.set(`${tema}\n`, { broker, tema, campo: "", v: txt, estado: true, ...(pareceConexion(tema, "", txt) ? { conexion: true } : {}) });
      let j;
      try { j = JSON.parse(txt); } catch { return; }
      for (const x of numerosDe(j)) {
        if (x.estado && pareceConexion(tema, x.campo, x.v)) x.conexion = true;
        vistos.set(`${tema}\n${x.campo}`, { broker, tema, ...x });
      }
    });
    await new Promise((r) => setTimeout(r, BUSCAR_MS));
    soltar();
    const temas = [...vistos.values()];
    for (const x of temas) {
      const u = x.tema.endsWith("/state") && uds.get(x.tema.slice(0, -6));
      if (u) x.unidad = u;
    }
    return temas;
  }

  /** Quita de un panel lo de los datos que ya no tiene: límites, alarmas, valor y lecturas. */
  function olvidarDato(num, clave) {
    const w = S.cfg.watched[num];
    if (w?.rules?.[clave]) delete w.rules[clave];
    for (const k of [...S.active.keys()]) if (k.startsWith(`${num}|${clave}|`) || k === trendKey(num, clave)) motor.clearAlarm(k, { silent: true });
    const n = S.nodes.get(num);
    if (n?.metrics?.[clave]) delete n.metrics[clave];
    S.recent.delete(`${num}|${clave}`);
    clearTimeout(pendientes.get(clave)?.timer);
    pendientes.delete(clave);
    clearTimeout(ordenes.get(clave)?.timer);
    ordenes.delete(clave);
    valores.delete(clave);
    almacen.lecturas.borrar(num, clave);
  }

  const nombreOk = (txt) => String(txt ?? "").trim();

  aplicar();
  contar();
  return {
    /** La conexión de un broker (al arrancar o al cambiar su configuración). Devuelve cómo soltarla. */
    enganchar(id, con) {
      conexiones.set(id, con);
      suscribirse(id);
      contar();
      // Al conectar (y al volver a conectar), los Shelly dicen cómo están: un poco después, ya con las suscripciones.
      const alConectar = () => { const tt = setTimeout(() => { if (vivo) pedirEstados(id); }, 300); tt.unref?.(); };
      con.on?.("conectada", alConectar);
      if (con.conectada) alConectar();
      return () => {
        con.off?.("conectada", alConectar);
        if (conexiones.get(id) !== con) return;
        for (const q of quitar.get(id) || []) q();
        quitar.delete(id);
        conexiones.delete(id);
        contar();
      };
    },
    /** Qué datos usan ese broker (para no quitarlo). */
    usos: (id) => [...porClave.values()].filter(({ d }) => d.broker === id).map(({ num, d }) => `${nombrePanel(num)} (${nombreDato(d)})`)
      .concat(Object.entries(cfg.paneles).filter(([, p]) => p.conexion?.broker === id).map(([k]) => `${nombrePanel(Number(k))} (conexión)`)),
    arrancar() {
      const n = porClave.size;
      if (n) registro.info(tx("s.j.panels", { n, mesh: cfg.malla.activado ? tx("s.j.panelsMesh", { every: cfg.malla.cada, ch: cfg.malla.canal }) : "" }));
      programar();
    },

    /** Un panel nuevo, sin nodo: sus datos llegarán por MQTT. */
    crearPanel({ nombre, tipo }) {
      nombre = nombreOk(nombre);
      if (!nombre) return { ok: false, error: tx("s.pan.nameMissing") };
      if (nombre.length > 40) return { ok: false, error: tx("s.pan.nameLong") };
      if (!TIPOS_PANEL[tipo]) return { ok: false, error: tx("s.pan.chooseType") };
      const num = -cfg.siguiente.panel++;
      cfg.paneles[num] = { nombre, tipo, datos: [] };
      guardar();
      aplicar();
      // «Sin datos» apagado: hay sensores que solo publican cuando cambian.
      S.cfg.watched[num] = { offlineMin: 0, rules: {} };
      motor.guardar("cfg");
      motor.guardar("nodes");
      motor.addLog("info", tx("s.log.panelNew", { name: nombre }), num);
      contar();
      return { ok: true, num, toast: tx("s.pan.created", { name: nombre }) };
    },
    /** Quita un panel sin nodo, con sus datos y su histórico. */
    quitarPanel(num) {
      const p = panel(num);
      if (num >= 0 || !p) return { ok: false, error: tx("s.pan.cantRemove") };
      for (const d of p.datos) olvidarDato(num, d.clave);
      olvidarConexion(num);
      delete cfg.paneles[num];
      guardar();
      for (const k of [...S.active.keys()]) if (S.active.get(k).num === num) motor.clearAlarm(k, { silent: true });
      motor.addLog("info", tx("s.log.panelRemoved", { name: p.nombre }), num);
      delete S.cfg.watched[num];
      S.nodes.delete(num);
      almacen.lecturas.borrar(num);
      aplicar();
      suscribirse();
      motor.guardar("cfg");
      motor.guardar("nodes");
      contar();
      return { ok: true, toast: tx("s.pan.removed", { name: p.nombre }) };
    },
    /** El nombre del panel en Vigía. Vacío, en el de un nodo, vuelve a su nombre de Meshtastic. */
    renombrar(num, nombre) {
      nombre = nombreOk(nombre);
      if (nombre.length > 40) return { ok: false, error: tx("s.pan.nameLong") };
      if (num < 0) {
        if (!panel(num)) return { ok: false, error: tx("s.pan.gone") };
        if (!nombre) return { ok: false, error: tx("s.pan.nameMissing") };
      } else if (!S.nodes.has(num)) return { ok: false, error: tx("s.pan.noNode") };
      const antes = nombrePanel(num);
      cfg.paneles[num] ||= { datos: [] };
      if (nombre) cfg.paneles[num].nombre = nombre;
      else delete cfg.paneles[num].nombre;
      guardar();
      aplicar();
      motor.guardar("nodes");
      const ahora = nombrePanel(num);
      if (ahora !== antes) motor.addLog("info", tx("s.log.renamed", { old: antes, name: ahora }), num);
      contar();
      return { ok: true, toast: tx(nombre ? "s.pan.renamed" : "s.pan.renamedBack", { name: ahora }) };
    },
    /** Qué es un panel sin nodo (Shelly, Tasmota…): solo la etiqueta. */
    tipoPanel(num, tipo) {
      const p = panel(num);
      if (num >= 0 || !p) return { ok: false, error: tx("s.pan.gone") };
      if (!TIPOS_PANEL[tipo]) return { ok: false, error: tx("s.pan.chooseType") };
      p.tipo = tipo;
      guardar();
      aplicar();
      motor.guardar("nodes");
      contar();
      return { ok: true };
    },
    /**
     * Los datos MQTT de un panel (los que no estén, se quitan con su histórico) y, en uno sin nodo, su tema de
     * conexión ({ broker, tema, campo, avisar } o null; sin darlo, se queda el que tenga).
     */
    guardarDatos(num, lista, conexion) {
      if (!S.cfg.watched[num]) return { ok: false, error: tx("s.pan.notWatched") };
      const ids = new Set(brokers().map((b) => b.id));
      const r = comprobarDatos(lista, { temaProhibido, brokers: ids, receptor: num === S.myNode });
      if (r.error) return { ok: false, error: r.error };
      let con;
      if (conexion !== undefined) {
        if (num >= 0 && conexion?.tema) return { ok: false, error: tx("s.pan.connNoNode") };
        const c = comprobarConexion(conexion, { temaProhibido, brokers: ids });
        if (c.error) return { ok: false, error: c.error };
        con = c.conexion;
      }
      const antes = panel(num)?.datos || [];
      const suyas = new Set(antes.map((d) => d.clave));
      for (const d of r.datos) {
        const a = d.clave && suyas.has(d.clave) ? antes.find((x) => x.clave === d.clave) : null;
        // Un dato nuevo, una clave repetida en la lista o un número que pasa a estado (o al revés: su histórico ya no
        // vale para él): clave nueva, y lo de la vieja se quita.
        if (!a || esEstado(a.tipo) !== esEstado(d.tipo)) { d.clave = `mq${cfg.siguiente.dato++}`; continue; }
        suyas.delete(d.clave);
        if (a.broker !== d.broker || a.tema !== d.tema || a.campo !== d.campo || a.unidad !== d.unidad || a.tipo !== d.tipo || !!a.invertir !== !!d.invertir) valores.delete(d.clave);
      }
      for (const clave of suyas) olvidarDato(num, clave); // los que se han quitado
      cfg.paneles[num] ||= { datos: [] };
      cfg.paneles[num].datos = r.datos;
      if (con !== undefined) {
        const v = cfg.paneles[num].conexion;
        if (!con || !v || v.broker !== con.broker || v.tema !== con.tema || v.campo !== con.campo) olvidarConexion(num);
        if (con) cfg.paneles[num].conexion = con;
        else delete cfg.paneles[num].conexion;
        evalConexion(num);
      }
      guardar();
      aplicar();
      suscribirse();
      motor.guardar("cfg");
      motor.guardar("nodes");
      registro.info(tx("s.j.panelData", { panel: nombrePanel(num), n: r.datos.length }));
      programar();
      for (const id of conexiones.keys()) pedirEstados(id); // si hay un Shelly nuevo, que diga ya cómo está
      return { ok: true, toast: tx("s.pan.dataSaved") };
    },
    /**
     * Enciende (v = 1) o apaga (v = 0) un dato ON/OFF que tenga orden: publica su mensaje y espera a que su tema de
     * estado diga que ha cambiado. Sin confirmación (decisión de Dani; sin usuarios por ahora).
     */
    async mandar(num, clave, v) {
      const d = panel(num)?.datos.find((x) => x.clave === clave);
      if (!S.cfg.watched[num] || !d) return { ok: false, error: tx("s.pan.datumGone") };
      if (!d.orden) return { ok: false, error: tx("s.pan.noCmd") };
      if (v !== 0 && v !== 1) return { ok: false };
      const con = conexiones.get(d.broker);
      if (!con?.conectada) return { ok: false, error: tx("s.pan.brokerDown", { name: nombreDato(d) }) };
      const antes = ordenes.get(clave);
      if (antes && !antes.error) return { ok: false, error: tx("s.pan.waitCmd") };
      // Pending before publishing: a device on the same broker can answer before the broker acknowledges (qos 1),
      // and its answer has to find the order waiting.
      const o = { num, v, t: Date.now(), timer: null };
      ordenes.set(clave, o);
      if (!(await con.publicar(d.orden.tema, v ? d.orden.on : d.orden.off, { qos: 1 }))) {
        if (ordenes.get(clave) === o) ordenes.delete(clave);
        return { ok: false, error: tx("s.pan.cmdFailed") };
      }
      if (ordenes.get(clave) !== o) return { ok: true }; // it has already said it did it
      o.timer = setTimeout(() => {
        if (ordenes.get(clave) !== o) return;
        ordenes.set(clave, { v, t: o.t, error: tx("s.pan.noAnswer") });
        motor.addLog("info", tx("s.log.cmdNoAnswer", { panel: nombrePanel(num), datum: nombreDato(d), value: textoDato(d, v) }), num);
        contar();
      }, ORDEN_MS);
      o.timer.unref?.();
      contar();
      return { ok: true };
    },
    /** Cada cuánto, por qué canal y con cuántos saltos salen a la malla los datos del receptor. */
    configurarMalla(cambio) {
      const { malla, error } = comprobarMalla(cambio, cfg.malla);
      if (error) return { ok: false, error };
      cfg.malla = malla;
      guardar();
      registro.info(malla.activado ? tx("s.j.mesh", { every: malla.cada, ch: malla.canal }) : tx("s.j.meshOff"));
      programar();
      return { ok: true, toast: malla.activado ? tx("s.pan.meshSaved", { time: hhmm.format(new Date(proximo)) }) : tx("s.pan.meshSavedOff") };
    },
    /**
     * Escucha los brokers conectados unos segundos y devuelve los temas con números o estados:
     * { ok, temas: [{ broker, tema, campo, v, unidad?, estado?, conexion? }] }.
     */
    async buscarTemas() {
      const conectadas = [...conexiones].filter(([, c]) => c.conectada);
      if (!conectadas.length) return { ok: false, error: tx("s.pan.connectBroker") };
      const porBroker = await Promise.all(conectadas.map(([id, c]) => buscarEn(id, c)));
      const temas = porBroker.flat().sort((a, b) => a.tema.localeCompare(b.tema) || a.campo.localeCompare(b.campo) || a.broker.localeCompare(b.broker));
      return { ok: true, temas, toast: temas.length ? tx("s.pan.found", { n: temas.length }) : tx("s.pan.foundNone") };
    },
    /** Manda ya a la malla lo que haya (sin esperar al siguiente envío). */
    enviarAhora() {
      if (!panel(S.myNode)?.datos.some((d) => d.malla)) return { ok: false, error: tx("s.pan.markMesh") };
      if (Date.now() - aMano < A_MANO_MS) return { ok: false, error: tx("s.pan.waitMinute") };
      aMano = Date.now();
      enviar(true);
      return { ok: true, toast: tx("s.pan.sending") };
    },
    /** After a change of the server's language: the names of the data without a name of their own (their type's). */
    reetiquetar() {
      registrarMetricas(metasDe(cfg.paneles));
      contar();
    },
    parar() {
      // Lo que esperaba su minuto se guarda ya: que no se pierda el último dato al reiniciar.
      for (const [clave, p] of pendientes) { clearTimeout(p.timer); guardarLectura(p.num, clave, p.v, p.t); }
      pendientes.clear();
      vivo = false;
      clearTimeout(timer);
      clearTimeout(contarT);
      for (const qs of quitar.values()) for (const q of qs) q();
      quitar.clear();
      for (const o of ordenes.values()) clearTimeout(o.timer);
    },
    /** Para las pruebas. */
    get valores() { return valores; },
    enviar,
    tipos: TIPOS,
  };
}
