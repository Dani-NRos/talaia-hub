// Configuración del servidor: un JSON pequeño (por defecto /etc/vigia/servidor.json). Lo que no se ponga, por defecto.
//
// {
//   "receptor": { "tipo": "usb", "puerto": "auto" },        // o "/dev/serial/by-id/…", o "239a:8029"
//   "receptor": { "tipo": "tcp", "host": "192.168.1.60", "puerto": 4403 },
//   "web": { "puerto": 4404 },
//   "datos": "/var/lib/vigia",
//   "retencionDias": 90,
//   "registro": "info"                                       // o "depurar"
// }
import fs from "node:fs";

export const RUTA_CONFIG = "/etc/vigia/servidor.json";

export const DEFECTO = {
  receptor: { tipo: "usb", puerto: "auto" },
  web: { puerto: 4404, escuchar: "0.0.0.0" },
  datos: "/var/lib/vigia",
  retencionDias: 90,
  registro: "info",
};

export class ErrorConfig extends Error {}

/** Lee y comprueba la configuración. Sin fichero, la de por defecto (salvo que se pida que exista). */
export function leerConfig(ruta = RUTA_CONFIG, { obligatoria = false } = {}) {
  let dada = {};
  if (fs.existsSync(ruta)) {
    try {
      dada = JSON.parse(fs.readFileSync(ruta, "utf8"));
    } catch (e) {
      throw new ErrorConfig(`${ruta} no es un JSON válido: ${e.message}`);
    }
  } else if (obligatoria) {
    throw new ErrorConfig(`no existe ${ruta}`);
  }
  return comprobar(dada);
}

export function comprobar(dada) {
  const c = {
    ...DEFECTO,
    ...dada,
    receptor: { ...(dada.receptor?.tipo === "tcp" ? { tipo: "tcp", puerto: 4403 } : DEFECTO.receptor), ...(dada.receptor || {}) },
    web: { ...DEFECTO.web, ...(dada.web || {}) },
  };
  const r = c.receptor;
  if (r.tipo !== "usb" && r.tipo !== "tcp") throw new ErrorConfig(`receptor.tipo tiene que ser "usb" o "tcp" (pone "${r.tipo}")`);
  if (r.tipo === "tcp") {
    if (!r.host || typeof r.host !== "string") throw new ErrorConfig('para el receptor por TCP falta "host": la IP o el nombre del nodo');
    if (!Number.isInteger(r.puerto) || r.puerto < 1 || r.puerto > 65535) throw new ErrorConfig("receptor.puerto tiene que ser un número de puerto (por defecto 4403)");
  } else {
    const p = String(r.puerto ?? "auto");
    if (!(p === "auto" || p.startsWith("/") || /^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(p))) {
      throw new ErrorConfig(`receptor.puerto por USB tiene que ser "auto", una ruta como "/dev/ttyACM0" o un id USB como "239a:8029" (pone "${p}")`);
    }
    r.puerto = p;
  }
  if (!Number.isInteger(c.web.puerto) || c.web.puerto < 1 || c.web.puerto > 65535) throw new ErrorConfig("web.puerto tiene que ser un número de puerto");
  if (typeof c.datos !== "string" || !c.datos) throw new ErrorConfig("datos tiene que ser una carpeta");
  if (!(Number.isFinite(c.retencionDias) && c.retencionDias >= 1)) throw new ErrorConfig("retencionDias tiene que ser un número de días (1 o más)");
  if (!["depurar", "info", "aviso", "error"].includes(c.registro)) throw new ErrorConfig('registro tiene que ser "depurar", "info", "aviso" o "error"');
  return c;
}

/** «por TCP en 192.168.1.60:4403», «por USB», «por USB en /dev/ttyACM0»: para el registro. */
export const describirReceptor = (r) => (r.tipo === "tcp" ? `por TCP en ${r.host}:${r.puerto}` : r.puerto === "auto" ? "por USB" : `por USB en ${r.puerto}`);
