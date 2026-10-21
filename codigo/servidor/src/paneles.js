// Paneles del servidor: nombres propios, paneles sin nodo y datos que llegan por MQTT.
//
//  - Cualquier panel (el de un nodo Meshtastic vigilado o uno sin nodo) se puede renombrar y llevar datos MQTT: cada
//    dato tiene broker, tema, campo, tipo, unidad y nombre, y se guarda como una lectura más del panel con su propia
//    clave («mq3»), así tiene gráficas, alarmas e histórico como cualquier métrica. Como mucho una lectura por minuto
//    y dato (la última que llegó); en pantalla se ve al momento.
//  - Los paneles sin nodo son números negativos (ningún nodo Meshtastic los tiene): un nodo «de mentira» en S.nodes,
//    vigilado, que reutiliza todo lo del motor. «Sin datos» usa la hora del último dato (apagado por defecto).
//  - Los datos del panel del receptor marcados «a la malla» salen cada cierto tiempo como su telemetría de ambiente.
//
// Configuración en SQLite («paneles»); lo que ven las pantallas, en S.paneles (parte «paneles»). Lo de la 1.16 (la
// estación, en Ajustes) se migra al panel del receptor: ver migrarEstacion.
import { create, toBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import {
  comprobarDatos, comprobarMalla, leerValor, convertir, unidades, textoValores, proximoEnvio, metasDe, nombreDato,
  TIPOS_PANEL, MALLA_DEFECTO, TIPOS,
} from "@vigia/nucleo/mqtt-datos.js";
import { registrarMetricas } from "@vigia/nucleo/metrics.js";
import { RE, trendKey } from "@vigia/nucleo/motor.js";
import { hhmm } from "@vigia/nucleo/textos.js";

const BUSCAR_MS = 3000; // al buscar temas, cuánto se escucha cada broker
const BUSCAR_MAX = 2000; // un broker con mucho retenido (Home Assistant, zigbee2mqtt…) tiene cientos
const A_MANO_MS = 60000; // entre dos «Enviar ahora»
const LECTURA_MS = 60000; // cada dato se guarda como lectura como mucho una vez por minuto

/** Un Telemetry con la telemetría de ambiente, codificado. valores: { tipo: número } en unidades de Meshtastic. */
export function telemetriaAmbiente(valores, segundos) {
  const TEL = Protobuf.Telemetry;
  const m = {};
  for (const [k, v] of Object.entries(valores)) m[k] = k === "soilMoisture" ? Math.round(v) : v; // es un entero
  const tel = create(TEL.TelemetrySchema, { time: segundos, variant: { case: "environmentMetrics", value: create(TEL.EnvironmentMetricsSchema, m) } });
  return toBinary(TEL.TelemetrySchema, tel);
}

/** Los números de un JSON, con su ruta («temperature», «ENERGY.Power»), hasta 3 niveles. */
function numerosDe(obj, ruta = "", out = [], nivel = 0) {
  if (nivel > 3 || !obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const r = ruta ? `${ruta}.${k}` : k;
    if (typeof v === "number" && Number.isFinite(v)) out.push({ campo: r, v });
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
  registro.info(`Paneles: la estación pasa al panel del receptor (${cfg.paneles[me]?.datos.length || 0} datos)`);
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
      return "ese tema es de lo que publica Vigía: mandaría lo que ya viene de él.";
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
      if (!x) faltan.push(`${nombre} (aún no ha llegado)`);
      else if (x.error) faltan.push(`${nombre} (${x.error})`);
      else if (x.nulo) faltan.push(`${nombre} (no disponible)`);
      else if (d.caduca && ahora - x.t > d.caduca * 60000) faltan.push(`${nombre} (sin datos nuevos desde las ${hhmm.format(new Date(x.t))})`);
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
    };
    eventos.emit("parte", "paneles");
  }
  // Los valores pueden llegar a menudo: a las pantallas, como mucho una vez por segundo.
  const contarPronto = () => { if (!contarT) contarT = setTimeout(contar, 1000); };

  /* ── lo que llega por MQTT ── */
  function recibido(broker, tema, carga) {
    const t = Date.now();
    for (const { num, d } of porClave.values()) {
      if (d.broker !== broker || d.tema !== tema) continue;
      const r = leerValor(carga, d.campo);
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

  /** Una lectura por minuto y dato: la primera, al momento; las que llegan antes, se queda la última para el final. */
  function lectura(num, clave, v, t) {
    const p = pendientes.get(clave);
    if (p) { Object.assign(p, { num, v, t }); return; }
    const espera = (guardadoT.get(clave) || 0) + LECTURA_MS - t;
    if (espera <= 0) return guardarLectura(num, clave, v, t);
    const q = { num, v, t, timer: null };
    q.timer = setTimeout(() => { pendientes.delete(clave); guardarLectura(q.num, clave, q.v, q.t); }, espera);
    q.timer.unref?.();
    pendientes.set(clave, q);
  }
  function guardarLectura(num, clave, v, t) {
    if (!vivo || !S.cfg.watched[num] || porClave.get(clave)?.num !== num) return;
    guardadoT.set(clave, t);
    // En un panel sin nodo, que llegue un dato es «dar señal»; en el de un nodo, no (eso es la radio).
    motor.ingest(num, { [clave]: v }, t, { touch: num < 0 });
  }

  /** Los temas de los datos de ese broker (o de todos). Aunque el panel no se vea: así no se pierde nada al volver. */
  function suscribirse(solo = null) {
    for (const [id, con] of conexiones) {
      if (solo && id !== solo) continue;
      for (const q of quitar.get(id) || []) q();
      const temas = new Set([...porClave.values()].filter(({ d }) => d.broker === id).map(({ d }) => d.tema));
      quitar.set(id, [...temas].map((tema) => con.suscribir(tema, (t, carga) => recibido(id, tema, carga))));
    }
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
    const destino = canal ? `canal «${canal.name}»` : `canal ${m.canal}`;
    const rec = { t: ahora, texto: textoValores(vals), destino, faltan, resultado: "enviando…", ok: null, manual };
    ultimo = rec;
    const fin = (resultado, ok) => {
      Object.assign(rec, { resultado, ok, tDone: Date.now() });
      if (ok) {
        registro.depurar(`A la malla: ${rec.texto} → ${destino}: ${resultado}`);
        if (ultimoFallo) registro.info(`A la malla: vuelve a salir bien (${destino})`);
        ultimoFallo = null;
      } else if (resultado !== ultimoFallo) {
        registro.aviso(`A la malla: ${rec.texto || "sin datos"}: ${resultado}`); // el mismo fallo, una vez
        ultimoFallo = resultado;
      }
      if (ultimo === rec) { almacen.guardar("mallaUltimo", rec); contar(); }
    };
    if (!rec.texto) return fin("nada que mandar: ningún dato al día", false);
    const r = receptor();
    if (!r || S.link.state !== "ready") return fin("no ha salido: el receptor no está conectado", false);
    if (!canal) return fin(m.canal == null ? "no ha salido: falta elegir el canal" : "no ha salido: ese canal ya no está en el receptor", false);
    contar();
    try {
      await r.sendTelemetry(m.canal, telemetriaAmbiente(vals, Math.floor(ahora / 1000)), m.saltos).done;
      fin("repetido por la malla", true);
    } catch (e) {
      const code = e && typeof e === "object" && "error" in e ? e.error : "send";
      fin(code === RE.TIMEOUT ? "sin confirmación: no se oyó a nadie repetirlo"
        : code === RE.MAX_RETRANSMIT ? "nadie lo repitió (¿hay nodos al alcance?)"
          : `no ha salido: ${motor.askFailText(code)}`, false);
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
      let j;
      try { j = JSON.parse(carga.toString()); } catch { return; }
      for (const x of numerosDe(j)) vistos.set(`${tema}\n${x.campo}`, { broker, tema, ...x });
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
      return () => {
        if (conexiones.get(id) !== con) return;
        for (const q of quitar.get(id) || []) q();
        quitar.delete(id);
        conexiones.delete(id);
        contar();
      };
    },
    /** Qué datos usan ese broker (para no quitarlo). */
    usos: (id) => [...porClave.values()].filter(({ d }) => d.broker === id).map(({ num, d }) => `${nombrePanel(num)} (${nombreDato(d)})`),
    arrancar() {
      const n = porClave.size;
      if (n) registro.info(`Paneles: ${n} datos por MQTT${cfg.malla.activado ? `; a la malla cada ${cfg.malla.cada} min por el canal ${cfg.malla.canal}` : ""}`);
      programar();
    },

    /** Un panel nuevo, sin nodo: sus datos llegarán por MQTT. */
    crearPanel({ nombre, tipo }) {
      nombre = nombreOk(nombre);
      if (!nombre) return { ok: false, error: "Ponle un nombre al panel." };
      if (nombre.length > 40) return { ok: false, error: "El nombre es demasiado largo (hasta 40 letras)." };
      if (!TIPOS_PANEL[tipo]) return { ok: false, error: "Elige qué es." };
      const num = -cfg.siguiente.panel++;
      cfg.paneles[num] = { nombre, tipo, datos: [] };
      guardar();
      aplicar();
      // «Sin datos» apagado: hay sensores que solo publican cuando cambian.
      S.cfg.watched[num] = { offlineMin: 0, rules: {} };
      motor.guardar("cfg");
      motor.guardar("nodes");
      motor.addLog("info", `Panel nuevo: ${nombre}`, num);
      contar();
      return { ok: true, num, toast: `Panel «${nombre}» creado: añade sus datos.` };
    },
    /** Quita un panel sin nodo, con sus datos y su histórico. */
    quitarPanel(num) {
      const p = panel(num);
      if (num >= 0 || !p) return { ok: false, error: "Ese panel no se puede quitar (los de los nodos se dejan de vigilar)." };
      for (const d of p.datos) olvidarDato(num, d.clave);
      delete cfg.paneles[num];
      guardar();
      for (const k of [...S.active.keys()]) if (S.active.get(k).num === num) motor.clearAlarm(k, { silent: true });
      motor.addLog("info", `Panel quitado: ${p.nombre}`, num);
      delete S.cfg.watched[num];
      S.nodes.delete(num);
      almacen.lecturas.borrar(num);
      aplicar();
      suscribirse();
      motor.guardar("cfg");
      motor.guardar("nodes");
      contar();
      return { ok: true, toast: `Panel «${p.nombre}» quitado.` };
    },
    /** El nombre del panel en Vigía. Vacío, en el de un nodo, vuelve a su nombre de Meshtastic. */
    renombrar(num, nombre) {
      nombre = nombreOk(nombre);
      if (nombre.length > 40) return { ok: false, error: "El nombre es demasiado largo (hasta 40 letras)." };
      if (num < 0) {
        if (!panel(num)) return { ok: false, error: "Ese panel ya no existe." };
        if (!nombre) return { ok: false, error: "Ponle un nombre al panel." };
      } else if (!S.nodes.has(num)) return { ok: false, error: "Ese nodo no está." };
      const antes = nombrePanel(num);
      cfg.paneles[num] ||= { datos: [] };
      if (nombre) cfg.paneles[num].nombre = nombre;
      else delete cfg.paneles[num].nombre;
      guardar();
      aplicar();
      motor.guardar("nodes");
      const ahora = nombrePanel(num);
      if (ahora !== antes) motor.addLog("info", `${antes} se llama ahora ${ahora}`, num);
      contar();
      return { ok: true, toast: nombre ? `Ahora se llama «${ahora}».` : `Vuelve a su nombre: «${ahora}».` };
    },
    /** Qué es un panel sin nodo (Shelly, Tasmota…): solo la etiqueta. */
    tipoPanel(num, tipo) {
      const p = panel(num);
      if (num >= 0 || !p) return { ok: false, error: "Ese panel ya no existe." };
      if (!TIPOS_PANEL[tipo]) return { ok: false, error: "Elige qué es." };
      p.tipo = tipo;
      guardar();
      aplicar();
      motor.guardar("nodes");
      contar();
      return { ok: true };
    },
    /** Los datos MQTT de un panel (los que no estén, se quitan con su histórico). */
    guardarDatos(num, lista) {
      if (!S.cfg.watched[num]) return { ok: false, error: "Ese panel ya no está." };
      const r = comprobarDatos(lista, { temaProhibido, brokers: new Set(brokers().map((b) => b.id)), receptor: num === S.myNode });
      if (r.error) return { ok: false, error: r.error };
      const antes = panel(num)?.datos || [];
      const suyas = new Set(antes.map((d) => d.clave));
      for (const d of r.datos) {
        // Una clave que no es de este panel (o que ya se usa en esta lista) es un dato nuevo.
        if (!d.clave || !suyas.has(d.clave)) d.clave = `mq${cfg.siguiente.dato++}`;
        suyas.delete(d.clave);
        const a = antes.find((x) => x.clave === d.clave);
        if (a && (a.broker !== d.broker || a.tema !== d.tema || a.campo !== d.campo || a.unidad !== d.unidad || a.tipo !== d.tipo)) valores.delete(d.clave);
      }
      for (const clave of suyas) olvidarDato(num, clave); // los que se han quitado
      cfg.paneles[num] ||= { datos: [] };
      cfg.paneles[num].datos = r.datos;
      guardar();
      aplicar();
      suscribirse();
      motor.guardar("cfg");
      motor.guardar("nodes");
      registro.info(`Paneles: ${nombrePanel(num)} con ${r.datos.length} datos por MQTT`);
      programar();
      return { ok: true, toast: "Datos guardados." };
    },
    /** Cada cuánto, por qué canal y con cuántos saltos salen a la malla los datos del receptor. */
    configurarMalla(cambio) {
      const { malla, error } = comprobarMalla(cambio, cfg.malla);
      if (error) return { ok: false, error };
      cfg.malla = malla;
      guardar();
      registro.info(malla.activado ? `A la malla: cada ${malla.cada} min por el canal ${malla.canal}` : "A la malla: apagado");
      programar();
      return { ok: true, toast: malla.activado ? `Guardado. Próximo envío a las ${hhmm.format(new Date(proximo))}.` : "Guardado. No se manda nada a la malla." };
    },
    /** Escucha los brokers conectados unos segundos y devuelve los temas con números: { ok, temas: [{ broker, tema, campo, v, unidad? }] }. */
    async buscarTemas() {
      const conectadas = [...conexiones].filter(([, c]) => c.conectada);
      if (!conectadas.length) return { ok: false, error: "Primero conecta algún broker MQTT (en Ajustes → MQTT)." };
      const porBroker = await Promise.all(conectadas.map(([id, c]) => buscarEn(id, c)));
      const temas = porBroker.flat().sort((a, b) => a.tema.localeCompare(b.tema) || a.campo.localeCompare(b.campo) || a.broker.localeCompare(b.broker));
      return { ok: true, temas, toast: temas.length ? `${temas.length} con números` : "No ha llegado ningún tema con números" };
    },
    /** Manda ya a la malla lo que haya (sin esperar al siguiente envío). */
    enviarAhora() {
      if (!panel(S.myNode)?.datos.some((d) => d.malla)) return { ok: false, error: "Marca «A la malla» en algún dato del receptor y guárdalo." };
      if (Date.now() - aMano < A_MANO_MS) return { ok: false, error: "Espera un minuto entre envíos a mano." };
      aMano = Date.now();
      enviar(true);
      return { ok: true, toast: "Enviando…" };
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
    },
    /** Para las pruebas. */
    get valores() { return valores; },
    enviar,
    tipos: TIPOS,
  };
}
