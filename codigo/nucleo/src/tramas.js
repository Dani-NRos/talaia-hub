// Tramas del puerto serie de Meshtastic, sin depender del navegador: las usan la app (Web Serial) y el servidor.
//
// Por el puerto serie el firmware manda cada FromRadio en una trama: 0x94 0xC3, longitud (2 bytes, primero el
// alto) y el protobuf. Entre trama y trama puede colar texto: el registro de arranque del nodo, que sale por el
// mismo puerto hasta que el cliente pide la configuración. Lo que mandamos va con la misma cabecera.
//
// Por qué no se usa el troceado de @meshtastic/core: descarta un paquete si dentro aparecen los bytes 0x94 0xC3
// (puede pasar en un id de nodo o en datos cifrados) y no se recupera de una cabecera falsa con longitud imposible.

const START1 = 0x94, START2 = 0xc3, MAX_LEN = 512;
// Sin un latido el firmware deja el modo API del puerto a los 15 min sin tráfico del cliente (también por TCP).
export const HEARTBEAT_MS = 5 * 60000;
export const HEARTBEAT = new Uint8Array([0x3a, 0x00]); // ToRadio { heartbeat: {} } (campo 7)
export const DISCONNECT = new Uint8Array([0x20, 0x01]); // ToRadio { disconnect: true } (campo 4)
/** 32 bytes 0xC3: despiertan el puerto del nodo antes de pedirle la configuración. */
export const wakeBytes = () => new Uint8Array(32).fill(START2);

/** Pone la cabecera de trama a un protobuf ToRadio. */
export function frame(bytes) {
  const out = new Uint8Array(bytes.length + 4);
  out.set([START1, START2, (bytes.length >> 8) & 0xff, bytes.length & 0xff]);
  out.set(bytes, 4);
  return out;
}

/**
 * Troceador de lo que llega por el puerto. push(bytes) devuelve [{ type: "packet", data } | { type: "text", data }]
 * en orden. Guarda los trozos incompletos para la siguiente llamada.
 */
export function createFramer() {
  let buf = new Uint8Array(0);
  return {
    push(chunk) {
      if (chunk?.length) {
        const n = new Uint8Array(buf.length + chunk.length);
        n.set(buf);
        n.set(chunk, buf.length);
        buf = n;
      }
      const out = [];
      let i = 0;
      for (;;) {
        let s = -1;
        for (let k = i; k + 1 < buf.length; k++) if (buf[k] === START1 && buf[k + 1] === START2) { s = k; break; }
        if (s < 0) {
          // Sin cabecera: todo es texto, menos un 0x94 final que puede ser media cabecera.
          const keep = buf.length > i && buf[buf.length - 1] === START1 ? buf.length - 1 : buf.length;
          if (keep > i) out.push({ type: "text", data: buf.slice(i, keep) });
          buf = buf.slice(keep);
          return out;
        }
        if (s > i) out.push({ type: "text", data: buf.slice(i, s) });
        if (s + 4 > buf.length) { buf = buf.slice(s); return out; }
        const len = (buf[s + 2] << 8) | buf[s + 3];
        if (len > MAX_LEN) { // cabecera falsa: se sigue buscando desde el byte siguiente
          out.push({ type: "text", data: buf.slice(s, s + 1) });
          i = s + 1;
          continue;
        }
        if (s + 4 + len > buf.length) { buf = buf.slice(s); return out; }
        out.push({ type: "packet", data: buf.slice(s + 4, s + 4 + len) });
        i = s + 4 + len;
      }
    },
  };
}

/** Texto del registro del nodo en líneas completas; guarda la línea a medias. */
export function createLines(onLine) {
  const td = new TextDecoder();
  let part = "";
  return (bytes) => {
    part += td.decode(bytes, { stream: true });
    const lines = part.split(/\r?\n/);
    part = lines.pop();
    if (part.length > 400) { lines.push(part); part = ""; }
    for (const l of lines) if (l.trim()) onLine(l.replace(/\x1b\[[0-9;]*m/g, "").trim()); // sin colores ANSI
  };
}
