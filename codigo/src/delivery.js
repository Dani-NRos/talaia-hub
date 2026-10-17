// Entrega de un mensaje directo a un nodo (aviso de alarma por la malla). Sin DOM, para probarlo con node --test.
//
// Al mandar un mensaje con acuse, el primer «acuse» que suele llegar es el implícito de tu propio receptor:
// lo da en cuanto oye que un vecino repite el mensaje. Eso solo dice que salió a la malla. Entregado es cuando
// llega el acuse del propio nodo destino. Un error (sin ruta, sin clave, agotó los reintentos…) lo cierra como
// fallido, venga de quien venga. Si el acuse del destino llega después de un error o de agotar la espera,
// el mensaje pasa a entregado (tarde).

/** Fases: sending → relayed → delivered | failed | unconfirmed. */
export const FINAL = new Set(["delivered", "failed", "unconfirmed"]);

export const newDelivery = () => ({ phase: "sending", code: null, relayed: false, late: false });

/**
 * Aplica un suceso y devuelve el estado nuevo (o el mismo objeto si no cambia nada).
 * ev: { type: "ack", from, err } — acuse (err 0) o error de la malla para nuestro paquete
 *     { type: "timeout" } — se acabó la espera sin noticias del destino
 * ctx: { dest } — número del nodo destino
 */
export function deliveryStep(st, ev, ctx) {
  if (st.phase === "delivered") return st;
  if (ev.type === "ack") {
    if (ev.err === 0 || ev.err == null) {
      if (ev.from === ctx.dest) return { ...st, phase: "delivered", code: null, late: FINAL.has(st.phase) };
      if (FINAL.has(st.phase)) return st;
      return st.phase === "sending" ? { ...st, phase: "relayed", relayed: true } : st;
    }
    if (FINAL.has(st.phase)) return st;
    return { ...st, phase: "failed", code: ev.err };
  }
  if (ev.type === "timeout") {
    if (FINAL.has(st.phase)) return st;
    return { ...st, phase: "unconfirmed" };
  }
  return st;
}
