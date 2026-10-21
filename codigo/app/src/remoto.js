// Modo «Servidor»: la app abierta desde Vigía servidor. El estado (nodos, alarmas, registro, peticiones) es el del
// servidor, que lo manda al conectar y después solo lo que cambia; lo que se pulsa va al servidor como una orden.
// Las rutas son relativas («api/…») para que funcione también detrás de un proxy con prefijo.

/**
 * h: { onEstado(foto), onCambio(parche), onAlarma({ al, titulo, detalle }), onConexion(conectado) }
 * Devuelve { orden(datos) → Promise<{ ok, toast?, error? }>, cerrar() }.
 */
export function conectarServidor(h) {
  let es = null, otra = null, cerrada = false;
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
      if (es.readyState === EventSource.CLOSED && !cerrada) { clearTimeout(otra); otra = setTimeout(abrir, 3000); }
    });
  }
  abrir();

  async function orden(datos) {
    try {
      const r = await fetch("api/orden", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(datos) });
      const j = await r.json().catch(() => ({}));
      return { ok: false, ...j };
    } catch {
      return { ok: false, error: "Sin conexión con el servidor." };
    }
  }
  return { orden, cerrar: () => { cerrada = true; clearTimeout(otra); es.close(); } };
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
