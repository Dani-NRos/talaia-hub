// Codificador mínimo de protobuf para el mensaje meshtastic.User.
// Es lo único con contenido que la app envía (al pedir la ficha de un nodo se manda la propia).
// Números de campo según mesh.proto: id=1, long_name=2, short_name=3, macaddr=4, hw_model=5,
// is_licensed=6, role=7, public_key=8, is_unmessagable=9.

const te = new TextEncoder();

function varint(n, out) {
  let v = Math.max(0, Math.floor(n));
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

export function encodeUser(u) {
  const out = [];
  const tag = (no, wire) => varint(no * 8 + wire, out);
  const bytes = (no, b) => {
    if (!b || !b.length) return;
    tag(no, 2);
    varint(b.length, out);
    for (const x of b) out.push(x);
  };
  const str = (no, s) => { if (s) bytes(no, te.encode(s)); };
  const num = (no, v) => { if (v) { tag(no, 0); varint(v, out); } };
  str(1, u.id);
  str(2, u.longName);
  str(3, u.shortName);
  bytes(4, u.macaddr);
  num(5, u.hwModel);
  num(6, u.isLicensed ? 1 : 0);
  num(7, u.role);
  bytes(8, u.publicKey);
  num(9, u.isUnmessagable ? 1 : 0);
  return new Uint8Array(out);
}

/**
 * Saca error_reason (campo 3) de un mensaje meshtastic.Routing. 0 = acuse (todo bien); otro número = el error;
 * null si el mensaje no es un acuse ni un error (route_request / route_reply) o viene mal formado.
 */
export function routingErrorReason(bytes) {
  if (!bytes || !bytes.length) return null;
  let i = 0;
  const varint = () => {
    let v = 0, mul = 1, b;
    do {
      if (i >= bytes.length) throw new Error("corto");
      b = bytes[i++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return v;
  };
  try {
    while (i < bytes.length) {
      const key = varint();
      const field = Math.floor(key / 8), wire = key & 7;
      if (field === 3 && wire === 0) return varint();
      if (wire === 0) varint();
      else if (wire === 2) { const len = varint(); i += len; } // «i += varint()» sumaría la i de antes de leer la longitud
      else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else return null;
    }
  } catch { return null; }
  return null;
}

/**
 * Lee un meshtastic.RouteDiscovery (respuesta a un traceroute): route=1 (fixed32), snr_towards=2 (int32),
 * route_back=3 (fixed32), snr_back=4 (int32). Acepta campos empaquetados (lo normal en proto3) y sueltos.
 * Los SNR van en cuartos de dB; -128 es «desconocido». Devuelve null si el mensaje viene mal formado.
 */
export function decodeRouteDiscovery(bytes) {
  const out = { route: [], snrTowards: [], routeBack: [], snrBack: [] };
  if (!bytes) return out;
  let i = 0;
  // varint de 32 bits con signo: los int32 negativos llegan como varint de 10 bytes; solo cuentan los 32 bajos.
  const varint32 = () => {
    let lo = 0, shift = 0, b;
    do {
      if (i >= bytes.length) throw new Error("corto");
      b = bytes[i++];
      if (shift < 32) lo |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return lo | 0;
  };
  const fixed32 = () => {
    if (i + 4 > bytes.length) throw new Error("corto");
    const v = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
    i += 4;
    return v;
  };
  const LISTS = { 1: ["route", "f"], 2: ["snrTowards", "v"], 3: ["routeBack", "f"], 4: ["snrBack", "v"] };
  try {
    while (i < bytes.length) {
      const key = varint32() >>> 0;
      const field = key >>> 3, wire = key & 7;
      const list = LISTS[field];
      if (list && wire === 2) {
        const len = varint32(); // primero la longitud: «i + varint32()» sumaría la i de antes de leerla
        const end = i + len;
        if (end > bytes.length) throw new Error("corto");
        while (i < end) out[list[0]].push(list[1] === "f" ? fixed32() : varint32());
      } else if (list && list[1] === "f" && wire === 5) out[list[0]].push(fixed32());
      else if (list && list[1] === "v" && wire === 0) out[list[0]].push(varint32());
      else if (wire === 0) varint32();
      else if (wire === 2) { const len = varint32(); i += len; }
      else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else return null;
    }
    if (i > bytes.length) return null;
  } catch { return null; }
  return out;
}
