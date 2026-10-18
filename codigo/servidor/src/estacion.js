// De MQTT a la malla: los datos de una estación (Home Assistant, zigbee2mqtt, Shelly…) que llegan por MQTT salen cada
// cierto tiempo por el receptor como telemetría de ambiente suya, y se guardan como lecturas del receptor (gráficas,
// alarmas, histórico). Para la malla, el receptor tiene esos sensores.
//
// Configuración en SQLite («estacion»); lo que ven las pantallas, en S.estacion (parte «estacion»). Se engancha a la
// conexión MQTT que haya (enganchar), y se vuelve a enganchar cuando cambia.
import { create, toBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import {
  ESTACION_DEFECTO, comprobarEstacion, leerValor, aMeshtastic, textoValores, proximoEnvio, unidades,
} from "@vigia/nucleo/estacion.js";
import { metricMeta } from "@vigia/nucleo/metrics.js";
import { RE } from "@vigia/nucleo/motor.js";
import { hhmm } from "@vigia/nucleo/textos.js";

const BUSCAR_MS = 3000; // al buscar temas, cuánto se escucha el broker
const BUSCAR_MAX = 400;
const A_MANO_MS = 60000; // entre dos «Enviar ahora»

/** Un Telemetry con la telemetría de ambiente, codificado. valores: { metrica: número } en unidades de Meshtastic. */
export function telemetriaAmbiente(valores, segundos) {
  const TEL = Protobuf.Telemetry;
  const m = {};
  for (const [k, v] of Object.entries(valores)) m[k] = k === "soilMoisture" ? Math.round(v) : v; // es un entero
  const tel = create(TEL.TelemetrySchema, { time: segundos, variant: { case: "environmentMetrics", value: create(TEL.EnvironmentMetricsSchema, m) } });
  return toBinary(TEL.TelemetrySchema, tel);
}

/** Los números de un JSON, con su ruta («temperature», «datos.temperatura»), hasta 3 niveles. */
function numerosDe(obj, ruta = "", out = [], nivel = 0) {
  if (nivel > 3 || !obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const r = ruta ? `${ruta}.${k}` : k;
    if (typeof v === "number" && Number.isFinite(v)) out.push({ campo: r, v });
    else if (typeof v === "object") numerosDe(v, r, out, nivel + 1);
  }
  return out;
}

/**
 * vigia: { S, motor, eventos, almacen, registro, receptor: () => el receptor actual }.
 * Devuelve { enganchar, arrancar, configurar, buscarTemas, enviarAhora, parar }.
 */
export function crearEstacion({ S, motor, eventos, almacen, registro, receptor }) {
  let cfg = comprobarEstacion(almacen.leer("estacion", {}) || {}).cfg || { ...ESTACION_DEFECTO };
  const valores = new Map(); // metrica → { v, t } | { nulo, t } | { error, t }; v ya en unidades de Meshtastic
  let conexion = null, quitar = [], timer = null, proximo = null, contarT = null, vivo = true;
  let ultimo = almacen.leer("estacionUltimo", null);
  let ultimoFallo = null, aMano = 0;

  /** Lo que no puede venir de MQTT: lo que publica el propio Vigía (haría un bucle malla → MQTT → malla). */
  function temaProhibido(tema) {
    const base = S.mqtt?.base || "vigia";
    if (tema === base || tema.startsWith(`${base}/`) || tema.split("/").some((p) => p.startsWith("vigia_"))) {
      return "ese tema es de lo que publica Vigía: mandaría a la malla lo que ya viene de ella.";
    }
    return null;
  }

  /** Lo que se mandaría ahora: los datos con valor válido y al día; y los que no, con el motivo. */
  function alDia(ahora = Date.now()) {
    const vals = {}, faltan = [];
    for (const d of cfg.datos) {
      const x = valores.get(d.metrica);
      const nombre = metricMeta(d.metrica).label;
      if (!x) faltan.push(`${nombre} (aún no ha llegado)`);
      else if (x.error) faltan.push(`${nombre} (${x.error})`);
      else if (x.nulo) faltan.push(`${nombre} (no disponible)`);
      else if (d.caduca && ahora - x.t > d.caduca * 60000) faltan.push(`${nombre} (sin datos nuevos desde las ${hhmm.format(new Date(x.t))})`);
      else vals[d.metrica] = x.v;
    }
    return { vals, faltan };
  }

  function contar() {
    clearTimeout(contarT);
    contarT = null;
    const previo = alDia();
    S.estacion = {
      ...cfg, proximo, ultimo,
      valores: Object.fromEntries(valores),
      previo: { texto: textoValores(previo.vals), faltan: previo.faltan },
      receptor: S.myNode != null ? motor.nodeName(S.myNode) : null,
    };
    eventos.emit("parte", "estacion");
  }
  // Los valores pueden llegar a menudo: a las pantallas, como mucho una vez por segundo.
  const contarPronto = () => { if (!contarT) contarT = setTimeout(contar, 1000); };

  /* ── lo que llega por MQTT ── */
  function recibido(tema, carga) {
    const t = Date.now();
    for (const d of cfg.datos) {
      if (d.tema !== tema) continue;
      const r = leerValor(carga, d.campo);
      if (r.error || r.nulo) { valores.set(d.metrica, { ...r, t }); continue; }
      const c = aMeshtastic(d.metrica, d.unidad, r.v);
      valores.set(d.metrica, c.error ? { error: c.error, t } : { v: c.v, t, ...(d.unidad !== unidades(d.metrica)[0] ? { b: r.v, u: d.unidad } : {}) });
    }
    contarPronto();
  }

  function suscribirse() {
    for (const q of quitar) q();
    quitar = [];
    // Lo que ya no se usa no se queda con un valor viejo en pantalla.
    for (const m of [...valores.keys()]) if (!cfg.datos.some((d) => d.metrica === m)) valores.delete(m);
    if (!conexion) return;
    // Aunque esté apagado: así se ven los valores en Ajustes antes de activarlo.
    for (const tema of new Set(cfg.datos.map((d) => d.tema))) quitar.push(conexion.suscribir(tema, (t, carga) => recibido(tema, carga)));
  }

  /* ── envíos ── */
  function programar() {
    clearTimeout(timer);
    timer = null;
    proximo = null;
    if (vivo && cfg.activado) {
      proximo = proximoEnvio(Date.now(), cfg.cada);
      timer = setTimeout(() => { enviar(); programar(); }, proximo - Date.now());
      timer.unref?.();
    }
    contar();
  }

  /** Guarda las lecturas en el receptor y las manda a la malla. */
  async function enviar(manual = false) {
    const ahora = Date.now();
    const { vals, faltan } = alDia(ahora);
    const canal = S.channels.find((c) => c.index === cfg.canal);
    const destino = canal ? `canal «${canal.name}»` : `canal ${cfg.canal}`;
    const rec = { t: ahora, texto: textoValores(vals), destino, faltan, resultado: "enviando…", ok: null, manual };
    ultimo = rec;
    const fin = (resultado, ok) => {
      rec.resultado = resultado;
      rec.ok = ok;
      rec.tDone = Date.now();
      if (ok) {
        registro.depurar(`Estación: ${rec.texto} → ${destino}: ${resultado}`);
        if (ultimoFallo) registro.info(`Estación: vuelve a salir bien (${destino})`);
        ultimoFallo = null;
      } else if (resultado !== ultimoFallo) {
        // El mismo fallo se cuenta una vez, no cada media hora.
        registro.aviso(`Estación: ${rec.texto || "sin datos"}: ${resultado}`);
        ultimoFallo = resultado;
      }
      if (ultimo === rec) { almacen.guardar("estacionUltimo", rec); contar(); }
    };
    if (!rec.texto) return fin("nada que mandar: ningún dato al día", false);
    // Lecturas del receptor, aunque no salgan a la malla: los datos de la estación son de verdad.
    if (S.myNode != null) motor.ingest(S.myNode, vals, ahora, { kind: "environmentMetrics", touch: false });
    const r = receptor();
    if (!r || S.link.state !== "ready") return fin("no ha salido: el receptor no está conectado (sí se ha guardado como lectura)", false);
    if (!canal) return fin(cfg.canal == null ? "no ha salido: falta elegir el canal" : "no ha salido: ese canal ya no está en el receptor", false);
    contar();
    try {
      await r.sendTelemetry(cfg.canal, telemetriaAmbiente(vals, Math.floor(ahora / 1000)), cfg.saltos).done;
      fin("repetido por la malla", true);
    } catch (e) {
      const code = e && typeof e === "object" && "error" in e ? e.error : "send";
      fin(code === RE.TIMEOUT ? "sin confirmación: no se oyó a nadie repetirlo"
        : code === RE.MAX_RETRANSMIT ? "nadie lo repitió (¿hay nodos al alcance?)"
          : `no ha salido: ${motor.askFailText(code)}`, false);
    }
  }

  contar();
  return {
    /** La conexión MQTT nueva (al arrancar o cambiar su configuración). Devuelve cómo soltarla. */
    enganchar(con) {
      conexion = con;
      suscribirse();
      contar();
      return () => {
        if (conexion !== con) return;
        for (const q of quitar) q();
        quitar = [];
        conexion = null;
        contar();
      };
    },
    arrancar() {
      if (cfg.activado) registro.info(`Estación: ${cfg.datos.length} datos a la malla cada ${cfg.cada} min por el canal ${cfg.canal}`);
      programar();
    },
    /** Cambia la configuración (lo que no venga se queda). Devuelve { ok, toast?, error? }. */
    configurar(dada) {
      const { cfg: nueva, error } = comprobarEstacion(dada, cfg, temaProhibido);
      if (error) return { ok: false, error };
      const antes = cfg;
      cfg = nueva;
      almacen.guardar("estacion", cfg);
      // Si cambia la unidad o el campo de un dato, el valor que había ya no vale: se espera al siguiente.
      for (const d of cfg.datos) {
        const a = antes.datos.find((x) => x.metrica === d.metrica);
        if (!a || a.tema !== d.tema || a.campo !== d.campo || a.unidad !== d.unidad) valores.delete(d.metrica);
      }
      registro.info(cfg.activado ? `Estación: ${cfg.datos.length} datos a la malla cada ${cfg.cada} min por el canal ${cfg.canal}` : "Estación: apagada");
      suscribirse();
      programar();
      return { ok: true, toast: cfg.activado ? `Guardado. Próximo envío a las ${hhmm.format(new Date(proximo))}.` : "Guardado. No se manda nada a la malla." };
    },
    /** Escucha el broker unos segundos y devuelve los temas que traen números: { ok, temas: [{ tema, campo, v }] }. */
    async buscarTemas() {
      if (!conexion?.conectada) return { ok: false, error: "Primero conecta MQTT (en el apartado de arriba)." };
      const vistos = new Map();
      const soltar = conexion.suscribir("#", (tema, carga) => {
        if (vistos.size >= BUSCAR_MAX || temaProhibido(tema) || /\/config$/.test(tema) || /(^|\/)bridge\//.test(tema)) return;
        const r = leerValor(carga);
        if (r.v != null) return vistos.set(`${tema}\n`, { tema, campo: "", v: r.v });
        let j;
        try { j = JSON.parse(carga.toString()); } catch { return; }
        for (const x of numerosDe(j)) vistos.set(`${tema}\n${x.campo}`, { tema, ...x });
      });
      await new Promise((r) => setTimeout(r, BUSCAR_MS));
      soltar();
      const temas = [...vistos.values()].sort((a, b) => a.tema.localeCompare(b.tema) || a.campo.localeCompare(b.campo));
      return { ok: true, temas, toast: temas.length ? `${temas.length} con números` : "No ha llegado ningún tema con números" };
    },
    /** Manda ya lo que haya (sin esperar al siguiente envío). */
    enviarAhora() {
      if (!cfg.datos.length) return { ok: false, error: "Añade y guarda al menos un dato." };
      if (Date.now() - aMano < A_MANO_MS) return { ok: false, error: "Espera un minuto entre envíos a mano." };
      aMano = Date.now();
      enviar(true);
      return { ok: true, toast: "Enviando…" };
    },
    parar() {
      vivo = false;
      clearTimeout(timer);
      clearTimeout(contarT);
      for (const q of quitar) q();
      quitar = [];
    },
    /** Para las pruebas: los últimos valores y mandar sin esperar (ni el minuto entre envíos a mano). */
    get valores() { return valores; },
    enviar,
  };
}

