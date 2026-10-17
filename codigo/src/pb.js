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
      else if (wire === 2) i += varint();
      else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else return null;
    }
  } catch { return null; }
  return null;
}
