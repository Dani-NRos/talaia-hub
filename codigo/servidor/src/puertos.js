// Puertos serie con un nodo Meshtastic enchufado, leídos de /sys y /dev/serial/by-id.
// No se usa la lista de serialport: en Linux llama a udevadm, que no siempre está (contenedores), y si falta
// tumba el proceso entero.
import fs from "node:fs";
import path from "node:path";
import { USB_VENDORS } from "@vigia/nucleo/tramas.js";
import { tx } from "@vigia/nucleo/idioma.js";
import "./textos.js";

const hex4 = (n) => n.toString(16).padStart(4, "0");
const leer = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } };

/**
 * Lista los puertos ttyACM/ttyUSB con sus datos USB.
 * Devuelve [{ ruta, porId, vid, pid, fabricante, producto, serie, conocido }].
 * raices: para las pruebas ({ sys: "/sys", dev: "/dev" }).
 */
export function listarPuertos({ sys = "/sys", dev = "/dev" } = {}) {
  const base = path.join(sys, "class/tty");
  let nombres = [];
  try { nombres = fs.readdirSync(base).filter((n) => /^tty(ACM|USB)\d+$/.test(n)); } catch { return []; }
  // Nombres estables: /dev/serial/by-id/usb-Fabricante_Producto_Serie-if00 → ttyACM0
  const porId = new Map();
  try {
    const dir = path.join(dev, "serial/by-id");
    for (const l of fs.readdirSync(dir)) {
      try { porId.set(path.basename(fs.readlinkSync(path.join(dir, l))), path.join(dir, l)); } catch { /* no es un enlace */ }
    }
  } catch { /* sin udev, no hay by-id */ }
  const out = [];
  for (const n of nombres.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
    // El dispositivo USB es el primer antecesor con idVendor (el tty cuelga de la interfaz, y esta del aparato).
    let d;
    try { d = fs.realpathSync(path.join(base, n, "device")); } catch { continue; }
    let usb = null;
    for (let i = 0; i < 4 && d && d !== "/"; i++, d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, "idVendor"))) { usb = d; break; }
    }
    const vid = usb ? parseInt(leer(path.join(usb, "idVendor")), 16) : null;
    const pid = usb ? parseInt(leer(path.join(usb, "idProduct")), 16) : null;
    out.push({
      ruta: path.join(dev, n),
      porId: porId.get(n) || null,
      vid, pid,
      fabricante: usb ? leer(path.join(usb, "manufacturer")) : "",
      producto: usb ? leer(path.join(usb, "product")) : "",
      serie: usb ? leer(path.join(usb, "serial")) : "",
      conocido: vid != null && USB_VENDORS.some((u) => u.vid === vid),
    });
  }
  return out;
}

export const usbId = (p) => (p.vid != null ? `${hex4(p.vid)}:${hex4(p.pid ?? 0)}` : "?");
export const describirPuerto = (p) => `${p.porId || p.ruta} (USB ${usbId(p)}${p.producto ? `, ${p.producto}` : ""})`;

/**
 * Elige el puerto según la configuración:
 *   "auto"              el único nodo de fabricante conocido (si hay varios, el primero, y avisa)
 *   "239a:8029"         el de ese fabricante y producto USB (sobrevive a que cambie ttyACM0 → ttyACM1)
 *   "/dev/…"            esa ruta tal cual (mejor /dev/serial/by-id/…, que no cambia)
 * Devuelve { puerto, nota } o { puerto: null, motivo }.
 */
export function elegirPuerto(conf, lista) {
  const c = String(conf || "auto").trim();
  if (c.startsWith("/")) {
    // Una ruta fija: vale aunque no salga en /sys (p. ej. un puerto virtual para pruebas).
    const p = lista.find((x) => x.ruta === c || x.porId === c);
    if (p) return { puerto: { ...p, ruta: c } };
    return fs.existsSync(c) ? { puerto: { ruta: c, porId: null, vid: null, pid: null, producto: "", conocido: false } } : { puerto: null, motivo: tx("s.port.noPath", { path: c }) };
  }
  const m = /^([0-9a-f]{4}):([0-9a-f]{4})$/i.exec(c);
  if (m) {
    const vid = parseInt(m[1], 16), pid = parseInt(m[2], 16);
    const p = lista.find((x) => x.vid === vid && x.pid === pid);
    return p ? { puerto: p } : { puerto: null, motivo: tx("s.port.noUsb", { id: c.toLowerCase() }) };
  }
  const nodos = lista.filter((x) => x.conocido);
  if (!nodos.length) {
    return { puerto: null, motivo: lista.length ? tx("s.port.noneLooks", { list: lista.map(describirPuerto).join(", ") }) : tx("s.port.none") };
  }
  if (nodos.length > 1) return { puerto: nodos[0], nota: tx("s.port.several", { n: nodos.length, port: describirPuerto(nodos[0]) }) };
  return { puerto: nodos[0] };
}
