// Salida a Home Assistant por MQTT, con autodescubrimiento: HA crea solo los dispositivos y sus entidades.
//
//  «Talaia»                 receptor conectado, alarmas sin atender y activas, nodos oídos en la última hora,
//                                   último aviso por la malla, un evento por alarma (para notificar) y «Enterado todas».
//                                   Solo lo de los nodos Meshtastic: los datos MQTT de los paneles (y sus alarmas), no.
//  «Talaia · Caseta huerto» (uno por nodo vigilado)
//                                   un sensor por métrica, último oído, saltos y SNR; un sensor binario por cada alarma
//                                   que tenga puesta (límite, cambio rápido, sin señal, valla) y su botón «Enterado».
//
// Temas (base «vigia» por defecto):
//   vigia/estado                    online / offline (testamento): si el servidor cae, HA lo marca «no disponible»
//   vigia/servidor/estado           JSON con lo del servidor (retenido)
//   vigia/servidor/evento           un mensaje por alarma, resuelta o vista (no retenido):
//                                   { event_type, texto, detalle, nodo, id, hora }
//   vigia/servidor/enterado_todas   ← botón de HA
//   vigia/nodo/<id>/estado          JSON con lecturas y alarmas de ese nodo (retenido)
//   vigia/nodo/<id>/enterado        ← botones de HA (la carga dice qué alarma)
//   homeassistant/<tipo>/vigia_<id>/<entidad>/config   autodescubrimiento (retenido)
import fs from "node:fs";
import { metricMeta } from "@talaia/nucleo/metrics.js";
import { hexId, trendKey, esAlarmaMqtt } from "@talaia/nucleo/motor.js";
import { HOUR, isNum } from "@talaia/nucleo/textos.js";
import { esClaveMqtt } from "@talaia/nucleo/mqtt-datos.js";
import { tx } from "@talaia/nucleo/idioma.js";
import "./textos.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const REPO = "https://github.com/Dani-NRos/talaia-hub";
const ESPERA_MS = 1000; // los cambios se juntan y salen como mucho cada segundo
const LIMPIEZA_MS = 3000; // al conectar, tiempo para recibir lo que había publicado antes y quitar lo que sobra

/** Tipo de dispositivo de HA de cada métrica (para iconos, unidades y estadísticas). */
const CLASE = {
  temperature: "temperature", soilTemperature: "temperature", relativeHumidity: "humidity",
  barometricPressure: "atmospheric_pressure", batteryLevel: "battery", soilMoisture: "moisture", lux: "illuminance",
  voltage: "voltage", sensorVoltage: "voltage", ch1Voltage: "voltage", ch2Voltage: "voltage", ch3Voltage: "voltage",
  current: "current", ch1Current: "current", ch2Current: "current", ch3Current: "current",
  co2: "carbon_dioxide", pm10Standard: "pm1", pm25Standard: "pm25", pm100Standard: "pm10",
  windSpeed: "wind_speed", windGust: "wind_speed", rainfall1h: "precipitation", rainfall24h: "precipitation",
  distance: "distance", weight: "weight",
};
const DIAGNOSTICO = new Set(["channelUtilization", "airUtilTx"]);
// HA escribe «μg/m³» con la mu griega; la app, con el signo de micro (se ven igual, pero HA no la reconocería).
const unidadHA = (u) => u.replace("\u00b5", "\u03bc");

export const idNodo = (num) => (num >>> 0).toString(16).padStart(8, "0");
const iso = (t) => (t ? new Date(t).toISOString() : null);
const corta = (s, n = 250) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? null);

/** Alarmas que puede tener un nodo vigilado según lo que tiene puesto: { slug, key, nombre }. */
export function alarmasPosibles(num, w, S) {
  const out = [];
  for (const [k, r] of Object.entries(w?.rules || {})) {
    if (esClaveMqtt(k)) continue; // los datos MQTT no van a Home Assistant (los lee él de su broker)
    const l = metricMeta(k).label;
    // The slugs are identifiers in Home Assistant: they never change (the names do, with the server's language).
    if (isNum(r.max)) out.push({ slug: `${k}_alta`, key: `${num}|${k}|high`, nombre: tx("s.ha.high", { label: l }) });
    if (isNum(r.min)) out.push({ slug: `${k}_baja`, key: `${num}|${k}|low`, nombre: tx("s.ha.low", { label: l }) });
    if (r.trend) out.push({ slug: `${k}_cambio_rapido`, key: trendKey(num, k), nombre: tx("s.ha.trend", { label: l }) });
  }
  const lim = isNum(w?.offlineMin) ? w.offlineMin : S.settings.defaultOfflineMin;
  if (lim) out.push({ slug: "sin_senal", key: `${num}||offline`, nombre: tx("s.ha.offline") });
  if (w?.fence) out.push({ slug: "fuera_de_su_sitio", key: `${num}||moved`, nombre: tx("s.ha.moved") });
  return out;
}

/**
 * talaia: { S, motor, eventos, registro }. conexion: una ConexionMqtt. opts: { base, prefijo }.
 * Devuelve { publicarTodo(), retirar(), parar() }.
 */
export function crearSalidaHA({ S, motor, eventos, registro }, conexion, { base = "vigia", prefijo = "homeassistant" } = {}) {
  const T = {
    disponible: `${base}/estado`,
    servidor: `${base}/servidor/estado`,
    evento: `${base}/servidor/evento`,
    todas: `${base}/servidor/enterado_todas`,
    nodo: (num) => `${base}/nodo/${idNodo(num)}/estado`,
    enterado: (num) => `${base}/nodo/${idNodo(num)}/enterado`,
    config: (tipo, nodo, ent) => `${prefijo}/${tipo}/${nodo}/${ent}/config`,
  };
  const publicados = new Map(); // tema de autodescubrimiento → JSON publicado
  const sucios = new Set(); // nodos con estado por mandar
  const enviados = new Map(); // tema de estado → último JSON mandado: solo sale lo que cambia de verdad
  let servidorSucio = false, configSucia = false, timer = null, limpieza = null, vivo = true;
  let oidos = 0; // nodos oídos en la última hora: se cuenta una vez por minuto, no con cada paquete
  let ultimoLog = S.log[0] || null;

  const disponibilidad = { availability_topic: T.disponible, payload_available: "online", payload_not_available: "offline" };
  // Names, in the server's language (built each time: they follow a change of language). The identifiers
  // («vigia_…») stay as they were, so Home Assistant keeps the same devices and their history.
  const origen = { name: "Talaia Hub", sw: VERSION, url: REPO };
  const dispServidor = () => ({ identifiers: ["vigia_servidor"], name: "Talaia", manufacturer: "Talaia Hub", model: tx("s.ha.model"), sw_version: VERSION, configuration_url: REPO });
  const dispNodo = (num, n) => ({
    identifiers: [`vigia_${idNodo(num)}`], name: `Talaia · ${n?.alias || n?.long || hexId(num)}`, manufacturer: "Meshtastic",
    ...(n?.hw ? { model: n.hw } : {}), via_device: "vigia_servidor",
  });
  // Solo nodos Meshtastic: los paneles sin nodo (números negativos) son datos MQTT, que no van a Home Assistant.
  const vigilados = () => Object.keys(S.cfg.watched).map(Number).filter((num) => num >= 0);

  /* ── autodescubrimiento: lo que debería haber publicado ahora ── */
  function deseado() {
    const out = new Map();
    const pon = (tipo, nodo, ent, cfg) => out.set(T.config(tipo, nodo, ent), JSON.stringify({ ...cfg, ...disponibilidad, origin: origen }));
    // El servidor.
    const dsv = dispServidor();
    const sv = (ent, cfg) => ({ unique_id: `vigia_servidor_${ent}`, device: dsv, ...cfg });
    pon("binary_sensor", "vigia_servidor", "receptor", sv("receptor", { name: tx("s.ha.receiver"), device_class: "connectivity", state_topic: T.servidor, value_template: "{{ value_json.receptor }}" }));
    pon("binary_sensor", "vigia_servidor", "hay_alarmas", sv("hay_alarmas", { name: tx("s.ha.anyAlarm"), device_class: "problem", state_topic: T.servidor, value_template: "{{ 'ON' if value_json.sin_atender > 0 else 'OFF' }}" }));
    pon("sensor", "vigia_servidor", "sin_atender", sv("sin_atender", { name: tx("s.ha.unattended"), state_topic: T.servidor, value_template: "{{ value_json.sin_atender }}", state_class: "measurement", icon: "mdi:alarm-light" }));
    pon("sensor", "vigia_servidor", "activas", sv("activas", { name: tx("s.ha.active"), state_topic: T.servidor, value_template: "{{ value_json.activas }}", state_class: "measurement", icon: "mdi:alarm-light-outline" }));
    pon("sensor", "vigia_servidor", "oidos", sv("oidos", { name: tx("s.ha.heard"), state_topic: T.servidor, value_template: "{{ value_json.oidos }}", unit_of_measurement: tx("s.ha.nodes"), state_class: "measurement", icon: "mdi:radio-tower" }));
    pon("sensor", "vigia_servidor", "aviso_malla", sv("aviso_malla", { name: tx("s.ha.lastAlert"), state_topic: T.servidor, value_template: "{{ value_json.aviso.texto }}", json_attributes_topic: T.servidor, json_attributes_template: "{{ value_json.aviso | tojson }}", icon: "mdi:message-alert" }));
    pon("event", "vigia_servidor", "alarmas", sv("alarmas", { name: tx("s.ha.alarms"), state_topic: T.evento, event_types: ["alarma", "resuelta", "vista"], icon: "mdi:bell-alert" }));
    pon("button", "vigia_servidor", "enterado_todas", sv("enterado_todas", { name: tx("s.ha.ackAll"), command_topic: T.todas, payload_press: "PRESS", icon: "mdi:check-all" }));
    // Los nodos vigilados.
    for (const num of vigilados()) {
      const n = S.nodes.get(num), id = idNodo(num), nodo = `vigia_${id}`, dev = dispNodo(num, n);
      const nd = (ent, cfg) => ({ unique_id: `vigia_${id}_${ent}`, device: dev, state_topic: T.nodo(num), ...cfg });
      for (const k of Object.keys(n?.metrics || {})) {
        if (esClaveMqtt(k)) continue;
        const m = metricMeta(k);
        pon("sensor", nodo, k, nd(k, {
          name: m.label, value_template: `{{ value_json.m.${k} }}`, state_class: "measurement", suggested_display_precision: m.dec,
          ...(m.unit ? { unit_of_measurement: unidadHA(m.unit) } : {}), ...(CLASE[k] ? { device_class: CLASE[k] } : {}),
          ...(DIAGNOSTICO.has(k) ? { entity_category: "diagnostic" } : {}),
        }));
      }
      pon("sensor", nodo, "oido", nd("oido", { name: tx("s.ha.lastHeard"), device_class: "timestamp", value_template: "{{ value_json.oido }}", entity_category: "diagnostic" }));
      pon("sensor", nodo, "saltos", nd("saltos", { name: tx("s.ha.hops"), value_template: "{{ value_json.saltos }}", state_class: "measurement", entity_category: "diagnostic", icon: "mdi:transit-connection-variant" }));
      pon("sensor", nodo, "snr", nd("snr", { name: "SNR", value_template: "{{ value_json.snr }}", unit_of_measurement: "dB", state_class: "measurement", suggested_display_precision: 1, entity_category: "diagnostic", icon: "mdi:signal" }));
      for (const a of alarmasPosibles(num, S.cfg.watched[num], S)) {
        pon("binary_sensor", nodo, `alarma_${a.slug}`, nd(`alarma_${a.slug}`, {
          name: a.nombre, device_class: "problem", value_template: `{{ value_json.a.${a.slug} }}`,
          json_attributes_topic: T.nodo(num), json_attributes_template: `{{ value_json.d.${a.slug} | tojson }}`,
        }));
        pon("button", nodo, `enterado_${a.slug}`, { unique_id: `vigia_${id}_enterado_${a.slug}`, device: dev, name: tx("s.ha.ack", { name: a.nombre }), command_topic: T.enterado(num), payload_press: a.slug, icon: "mdi:check" });
      }
    }
    return out;
  }

  /** Publica lo que falte o haya cambiado y retira lo que sobra. todo: volver a mandarlo todo (HA ha arrancado). */
  async function sincronizarConfig(todo = false) {
    const d = deseado();
    for (const [tema, json] of d) {
      if (!vivo) return;
      if (!todo && publicados.get(tema) === json) continue;
      // Se apunta antes de mandarlo: si mientras tanto se retira todo, también se borra este.
      publicados.set(tema, json);
      if (!(await conexion.publicar(tema, json, { retener: true, qos: 1 }))) publicados.delete(tema);
    }
    const fuera = new Set();
    for (const tema of [...publicados.keys()]) {
      if (!vivo) return;
      if (d.has(tema)) continue;
      if (await conexion.publicar(tema, "", { retener: true, qos: 1 })) publicados.delete(tema);
      const id = /\/vigia_([0-9a-f]{8})\//.exec(tema)?.[1];
      if (id) fuera.add(parseInt(id, 16));
    }
    // De un nodo que se deja de vigilar, se borra también su último estado retenido.
    for (const num of fuera) {
      if (S.cfg.watched[num]) continue;
      await conexion.publicar(T.nodo(num), "", { retener: true });
      enviados.delete(T.nodo(num));
    }
  }

  /* ── estados ── */
  /** Las alarmas activas que ve Home Assistant: las de los nodos (no las de los datos MQTT). */
  const deNodos = () => [...S.active.values()].filter((x) => !esAlarmaMqtt(x));
  function estadoNodo(num) {
    const n = S.nodes.get(num);
    const m = {};
    for (const [k, x] of Object.entries(n?.metrics || {})) if (!esClaveMqtt(k)) m[k] = k === "batteryLevel" && x.v > 100 ? 100 : x.v; // 101: enchufado
    const a = {}, d = {};
    for (const p of alarmasPosibles(num, S.cfg.watched[num], S)) {
      const al = S.active.get(p.key);
      a[p.slug] = al ? "ON" : "OFF";
      d[p.slug] = al ? { titulo: motor.alarmTitle(al), detalle: motor.alarmDetail(al), desde: iso(al.since), visto: !!al.acked } : {};
    }
    return { m, oido: iso(n?.lastHeard), saltos: n?.hops ?? null, snr: n?.snr ?? null, a, d };
  }
  function estadoServidor() {
    const activas = deNodos();
    const ml = S.meshLast;
    return {
      receptor: S.link.state === "ready" ? "ON" : "OFF",
      sin_atender: activas.filter((x) => !x.acked).length,
      activas: activas.length,
      oidos,
      aviso: ml ? { texto: corta(ml.text), destino: ml.tg?.label || null, resultado: ml.result || null, entregado: ml.ok, hora: iso(ml.tDone || ml.t) } : { texto: null },
    };
  }

  function programar() { if (!timer && vivo) timer = setTimeout(vaciar, ESPERA_MS); }
  async function vaciar() {
    timer = null;
    if (!conexion.conectada) return; // al reconectar se manda todo
    if (configSucia) { configSucia = false; await sincronizarConfig(); }
    const nums = [...sucios];
    sucios.clear();
    for (const num of nums) if (S.cfg.watched[num]) await mandarEstado(T.nodo(num), estadoNodo(num));
    if (servidorSucio) { servidorSucio = false; await mandarEstado(T.servidor, estadoServidor()); }
  }
  async function mandarEstado(tema, datos) {
    const json = JSON.stringify(datos);
    if (enviados.get(tema) === json) return;
    if (await conexion.publicar(tema, json, { retener: true })) enviados.set(tema, json);
  }
  function contarOidos() {
    const hace = Date.now() - HOUR;
    oidos = 0;
    for (const n of S.nodes.values()) if (n.num >= 0 && n.lastHeard >= hace) oidos++;
  }
  const marcarNodo = (num) => { if (num >= 0 && S.cfg.watched[num]) { sucios.add(num); programar(); } };
  const marcarVigilados = () => { for (const num of vigilados()) sucios.add(num); programar(); };
  const marcarServidor = () => { servidorSucio = true; programar(); };
  const marcarConfig = () => { configSucia = true; programar(); };

  /** Lo nuevo del registro de Talaia (alarmas, resueltas, vistas) sale como evento: con él se notifica en HA. */
  function eventosNuevos() {
    const nuevas = [];
    for (const e of S.log) { if (e === ultimoLog) break; nuevas.push(e); }
    ultimoLog = S.log[0] || null;
    const TIPO = { raise: "alarma", clear: "resuelta", ack: "vista" };
    for (const e of nuevas.reverse()) {
      if (!TIPO[e.type] || e.mqtt) continue; // las de los datos MQTT no van a Home Assistant
      // De una alarma que salta, también el dato de ahora («Ahora 31,4 °C.»), para el aviso al móvil.
      const al = e.type === "raise" ? [...S.active.values()].find((x) => (x.num ?? null) === e.num && e.text.startsWith(motor.alarmTitle(x))) : null;
      conexion.publicar(T.evento, {
        event_type: TIPO[e.type], texto: e.text, detalle: al ? motor.alarmDetail(al) : null,
        nodo: e.num != null ? motor.nodeName(e.num) : null, id: e.num != null ? hexId(e.num) : null, hora: iso(e.t),
      });
    }
  }

  /** Todo otra vez: al conectar y cuando HA arranca (manda «online» a homeassistant/status). */
  async function publicarTodo() {
    if (!conexion.conectada) return;
    await conexion.publicar(T.disponible, "online", { retener: true, qos: 1 });
    enviados.clear();
    await sincronizarConfig(true);
    marcarVigilados();
    marcarServidor();
  }

  /* ── lo que llega de Talaia ── */
  const escuchas = {
    lectura: (num) => marcarNodo(num),
    posicion: (num) => marcarNodo(num),
    cambio: () => marcarServidor(),
    avisoMalla: () => marcarServidor(),
    parte: (k) => {
      if (k === "cfg" || k === "settings") { marcarConfig(); marcarVigilados(); }
      else if (k === "nodes") { marcarConfig(); marcarVigilados(); } // nombre, modelo, métricas nuevas, último oído
      else if (k === "active") { marcarVigilados(); marcarServidor(); }
      else if (k === "log") eventosNuevos();
      else if (k === "meshLast") marcarServidor();
    },
  };
  for (const [ev, f] of Object.entries(escuchas)) eventos.on(ev, f);
  contarOidos();
  const reloj = setInterval(() => { contarOidos(); marcarServidor(); }, 60000); // «nodos oídos en la última hora»
  reloj.unref?.();

  /* ── lo que llega de Home Assistant ── */
  const quitar = [
    conexion.suscribir(`${base}/nodo/+/enterado`, (tema, carga) => {
      const num = parseInt(tema.split("/").at(-2), 16);
      const slug = carga.toString();
      const a = alarmasPosibles(num, S.cfg.watched[num], S).find((x) => x.slug === slug);
      const al = a && S.active.get(a.key);
      if (!al || al.acked) return;
      registro.info(tx("s.j.haAck", { title: motor.alarmTitle(al) }));
      motor.ack(a.key);
    }),
    conexion.suscribir(T.todas, () => {
      // Todas las que ve Home Assistant: las de los datos MQTT no le llegan, así que tampoco las da por vistas.
      const suyas = deNodos().filter((x) => !x.acked);
      if (!suyas.length) return;
      registro.info(tx("s.j.haAckAll"));
      for (const x of suyas) motor.ack(x.key);
    }),
    // HA avisa así al arrancar: hay que volver a contarle todo (no siempre guarda lo retenido).
    conexion.suscribir(`${prefijo}/status`, (tema, carga) => {
      if (carga.toString() === "online") setTimeout(() => { if (vivo) publicarTodo(); }, 1000 + Math.random() * 2000);
    }),
  ];
  // Al conectar: lo que hubiera publicado antes (otra versión, nodos que se dejaron de vigilar con el servidor parado)
  // llega como retenido; tras unos segundos, se quita lo que ya no corresponde.
  let quitarSub = null;
  function recogerAntiguos() {
    clearTimeout(limpieza);
    quitarSub?.();
    quitarSub = conexion.suscribir(`${prefijo}/+/+/+/config`, (tema, carga) => {
      if (!tema.split("/")[2]?.startsWith("vigia_") || !carga.length) return;
      if (!publicados.has(tema)) publicados.set(tema, carga.toString());
    });
    limpieza = setTimeout(() => { quitarSub?.(); quitarSub = null; if (vivo) marcarConfig(); }, LIMPIEZA_MS);
  }
  const alConectar = () => { recogerAntiguos(); publicarTodo(); };
  conexion.on("conectada", alConectar);
  if (conexion.conectada) alConectar();

  return {
    publicarTodo,
    /** Quita de HA todo lo de Talaia (al apagar la salida a HA o cambiar de prefijo). */
    async retirar() {
      detener(); // primero, que nada vuelva a publicar mientras se borra
      for (const tema of [...publicados.keys()]) { await conexion.publicar(tema, "", { retener: true, qos: 1 }); publicados.delete(tema); }
      for (const num of vigilados()) await conexion.publicar(T.nodo(num), "", { retener: true });
      await conexion.publicar(T.servidor, "", { retener: true });
      enviados.clear();
    },
    parar: () => detener(),
  };

  function detener() {
    if (!vivo) return;
    vivo = false;
    clearTimeout(timer);
    clearTimeout(limpieza);
    quitarSub?.();
    clearInterval(reloj);
    for (const [ev, f] of Object.entries(escuchas)) eventos.off(ev, f);
    conexion.off("conectada", alConectar);
    for (const q of quitar) q();
  }
}
