// Modo «Servidor»: la app abierta desde Vigía servidor. El estado (nodos, alarmas, registro, peticiones) es el del
// servidor, que lo manda al conectar y después solo lo que cambia; lo que se pulsa va al servidor como una orden.
// Las rutas son relativas («api/…») para que funcione también detrás de un proxy con prefijo.
import { t } from "./i18n.js";

/**
 * h: { onEstado(foto), onCambio(parche), onAlarma({ al, titulo, detalle }), onConexion(conectado),
 *      onSalida(primero) — the session has ended (or there is none): back to signing in }
 * Devuelve { orden(datos) → Promise<{ ok, toast?, error? }>, cerrar() }.
 */
export function conectarServidor(h) {
  let es = null, otra = null, cerrada = false;
  /** Without a session the server answers 401 and the browser gives up: is that it, or is the server away? */
  async function sinSesion() {
    try {
      const r = await fetch("api/sesion", { cache: "no-store" });
      if (r.status !== 401) return false;
      const j = await r.json().catch(() => ({}));
      cerrar();
      h.onSalida?.(!!j.primero);
      return true;
    } catch { return false; }
  }
  function cerrar() { cerrada = true; clearTimeout(otra); es?.close(); }
  function abrir() {
    es = new EventSource("api/eventos");
    // EventSource vuelve a conectar solo (el servidor pide 3 s) y, al volver, llega otra vez la foto completa.
    es.addEventListener("estado", (e) => { h.onConexion?.(true); h.onEstado(JSON.parse(e.data)); });
    es.addEventListener("cambio", (e) => h.onCambio(JSON.parse(e.data)));
    es.addEventListener("alarma", (e) => h.onAlarma?.(JSON.parse(e.data)));
    es.addEventListener("error", () => {
      h.onConexion?.(false);
      // Si el navegador se rinde (le llega algo que no son eventos, como la página de error de un proxy mientras el
      // servidor arranca), no vuelve a intentarlo: se abre otra conexión.
      if (es.readyState === EventSource.CLOSED && !cerrada) {
        clearTimeout(otra);
        sinSesion().then((fuera) => { if (!fuera && !cerrada) otra = setTimeout(abrir, 3000); });
      }
    });
  }
  abrir();

  async function orden(datos) {
    try {
      const r = await fetch("api/orden", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(datos) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { sinSesion(); return { ok: false, error: t("gate.ended") }; }
      return { ok: false, ...j };
    } catch {
      return { ok: false, error: t("link.noServerOrder") };
    }
  }
  // Every few hours, «still here»: a screen that never reloads (on a wall) keeps its 30 days of session counting.
  const renovar = setInterval(() => { if (!cerrada) sinSesion(); }, 6 * 3600 * 1000);
  return { orden, cerrar: () => { clearInterval(renovar); cerrar(); } };
}

/** Histórico guardado en el servidor, con la misma forma que el de la app (store.js). */
export function crearStoreRemoto(orden) {
  return {
    kind: "servidor",
    async add() { /* lo guarda el servidor */ },
    async series(node, metric, from, to = Number.MAX_SAFE_INTEGER) {
      try {
        const q = new URLSearchParams({ nodo: node, metrica: metric, desde: Math.floor(from), hasta: Math.min(to, Number.MAX_SAFE_INTEGER) });
        const r = await fetch(`api/serie?${q}`);
        return r.ok ? await r.json() : [];
      } catch { return []; }
    },
    async all() { return []; }, // la exportación se descarga del servidor (api/lecturas.csv)
    async count() {
      try { return (await (await fetch("api/salud")).json()).lecturas ?? 0; } catch { return 0; }
    },
    async prune() { /* poda el servidor, según los días que tenga puestos */ },
    async clear() { await orden({ orden: "borrarHistorico" }); },
  };
}
