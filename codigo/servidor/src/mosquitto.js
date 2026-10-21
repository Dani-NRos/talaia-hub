// El broker MQTT de este equipo (Mosquitto, lo instala el instalador): Vigía gestiona sus usuarios.
//
// Mosquitto lee los usuarios de /etc/mosquitto/vigia.passwd, que solo puede tocar root. Vigía escribe el suyo en
// <datos>/mosquitto/passwd (el mismo formato, con las contraseñas cifradas) y un servicio del sistema
// (vigia-mosquitto.path, del instalador) lo copia a Mosquitto y lo recarga en cuanto cambia. Así se cambian
// usuarios y contraseñas desde la pantalla sin dar permisos de administrador al servidor.
//
// Hay un usuario interno, «vigia-servidor», con una contraseña al azar: el de Vigía para conectarse a su broker.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const USUARIO_INTERNO = "vigia-servidor";
const NOMBRE_OK = /^[A-Za-z0-9._-]{1,64}$/;
export const CLAVE_MIN = 8;

/** Contraseña cifrada como la escribe mosquitto_passwd (2.0): PBKDF2-SHA512, 101 vueltas, sal de 12 bytes. */
export function cifrarClave(clave, sal = crypto.randomBytes(12), vueltas = 101) {
  const h = crypto.pbkdf2Sync(Buffer.from(String(clave), "utf8"), sal, vueltas, 64, "sha512");
  return `$7$${vueltas}$${sal.toString("base64")}$${h.toString("base64")}`;
}

/** ¿Esa contraseña es la de ese cifrado? (para las pruebas) */
export function claveValida(clave, cifrada) {
  const [, tipo, vueltas, sal, h] = String(cifrada).split("$");
  if (tipo !== "7") return false;
  const d = crypto.pbkdf2Sync(Buffer.from(String(clave), "utf8"), Buffer.from(sal, "base64"), Number(vueltas), 64, "sha512");
  return crypto.timingSafeEqual(d, Buffer.from(h, "base64"));
}

/** Por qué no vale un usuario nuevo (o null si vale). */
export function comprobarUsuario(nombre, clave) {
  if (!NOMBRE_OK.test(String(nombre || ""))) return "El usuario solo puede llevar letras sin tildes, números, «.», «-» y «_» (hasta 64).";
  if (nombre === USUARIO_INTERNO) return `«${USUARIO_INTERNO}» es el usuario de Vigía: elige otro nombre.`;
  if (clave != null && String(clave).length < CLAVE_MIN) return `La contraseña tiene que tener al menos ${CLAVE_MIN} caracteres.`;
  if (clave != null && /[\r\n]/.test(clave)) return "La contraseña no puede llevar saltos de línea.";
  return null;
}

/** Las direcciones de este equipo en la red de casa, para configurar los dispositivos («192.168.1.50»). */
export function direccionesLocales() {
  const out = [];
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const a of lista || []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

/**
 * config: la del servidor (con config.mosquitto). almacen: SQLite («mosquitto»: usuarios y su cifrado).
 * Devuelve { url, interno, usuarios(), ponerUsuario(nombre, clave), quitarUsuario(nombre), escribir() }.
 */
export function crearBrokerLocal({ config, almacen, registro }) {
  const fichero = config.mosquitto.usuarios || path.join(config.datos, "mosquitto", "passwd");
  let guardado = almacen.leer("mosquitto", null);
  if (!guardado?.interno?.clave) {
    // La primera vez: el usuario de Vigía, con una contraseña larga al azar que nadie tiene que saber.
    const clave = crypto.randomBytes(24).toString("base64url");
    guardado = { interno: { clave, cifrada: cifrarClave(clave) }, usuarios: guardado?.usuarios || [] };
    almacen.guardar("mosquitto", guardado);
  }

  function contenido() {
    const lineas = [`${USUARIO_INTERNO}:${guardado.interno.cifrada}`, ...guardado.usuarios.map((u) => `${u.nombre}:${u.cifrada}`)];
    return `${lineas.join("\n")}\n`;
  }
  /** Escribe el fichero si ha cambiado (cada vez, Mosquitto se recarga). */
  function escribir() {
    const txt = contenido();
    try {
      if (fs.existsSync(fichero) && fs.readFileSync(fichero, "utf8") === txt) return;
      fs.mkdirSync(path.dirname(fichero), { recursive: true });
      fs.writeFileSync(fichero, txt, { mode: 0o600 });
    } catch (e) {
      registro.error(`No se pudo escribir los usuarios del broker en ${fichero}: ${e.message}`);
    }
  }
  function guardar() { almacen.guardar("mosquitto", guardado); escribir(); }

  return {
    url: `mqtt://127.0.0.1:${config.mosquitto.puerto}`,
    puerto: config.mosquitto.puerto,
    fichero,
    interno: { usuario: USUARIO_INTERNO, clave: guardado.interno.clave },
    usuarios: () => guardado.usuarios.map((u) => ({ nombre: u.nombre })),
    /** Añade un usuario o le cambia la contraseña. */
    ponerUsuario(nombre, clave) {
      nombre = String(nombre || "").trim();
      const error = comprobarUsuario(nombre, String(clave ?? ""));
      if (error) return { ok: false, error };
      const u = guardado.usuarios.find((x) => x.nombre === nombre);
      if (u) u.cifrada = cifrarClave(clave);
      else guardado.usuarios.push({ nombre, cifrada: cifrarClave(clave) });
      guardado.usuarios.sort((a, b) => a.nombre.localeCompare(b.nombre));
      guardar();
      registro.info(`Broker de este equipo: ${u ? "nueva contraseña para" : "nuevo usuario"} «${nombre}»`);
      return { ok: true, toast: u ? `Contraseña de «${nombre}» cambiada.` : `Usuario «${nombre}» creado.` };
    },
    quitarUsuario(nombre) {
      const n = guardado.usuarios.length;
      guardado.usuarios = guardado.usuarios.filter((x) => x.nombre !== nombre);
      if (guardado.usuarios.length === n) return { ok: false, error: "Ese usuario no existe." };
      guardar();
      registro.info(`Broker de este equipo: usuario «${nombre}» quitado`);
      return { ok: true, toast: `Usuario «${nombre}» quitado: ya no puede conectarse.` };
    },
    escribir,
  };
}
