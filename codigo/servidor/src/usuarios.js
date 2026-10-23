// Users and sessions: who can open the screens and send orders (Dani, 23 Oct. 2026).
//
// - Always asked, also at home. One kind of user: everyone can do everything, users included. The table keeps a
//   role column (all "admin") so kinds of user can come later without moving data.
// - Passwords with scrypt (node:crypto, nothing to compile): 10 to 200 characters, no other rules. Only the hash is
//   kept, and it never leaves this module.
// - Sessions: a random token in an HttpOnly cookie; the database keeps only its SHA-256. They last 30 days without
//   being used, renewed while in use (the last use is written at most once an hour).
// - The first user is created from a screen with a one-time code, shown in the journal and by the installer, kept in
//   <data>/primer-usuario.txt until then: nobody else on the network can get there first.
// - Failed attempts slow down: five free per name, then a wait that doubles each time (up to 15 min); and if there
//   are many failures in a minute, whatever the names, everyone waits.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { HOUR, DAY } from "@talaia/nucleo/textos.js";
import { tx } from "@talaia/nucleo/idioma.js";
import "./textos.js";

const scrypt = promisify(crypto.scrypt);
export const SESION_MS = 30 * DAY;
const RENOVAR_MS = HOUR;
export const CLAVE_MIN = 10;
const CLAVE_MAX = 200;
const SCRYPT = { N: 16384, r: 8, p: 1 }; // 16 MB and a fraction of a second, also on a Raspberry Pi Zero 2
const LARGO = 32;
const LIBRES = 5, ESPERA_MAX = 15 * 60000, GLOBAL_MAX = 50; // failures: free per name; longest wait; per minute
const A_LA_VEZ = 8; // passwords being checked at once (each one, 16 MB and a fraction of a second): more, wait
const NOMBRE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u;
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O nor 1/I: read from a screen and typed by hand

/** The same name however it is written: «Dani», «dani», «DANI». */
export const llaveDe = (nombre) => String(nombre ?? "").normalize("NFKC").trim().toLocaleLowerCase("es");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export async function cifrar(clave) {
  const sal = crypto.randomBytes(16);
  const h = await scrypt(clave.normalize("NFKC"), sal, LARGO, SCRYPT);
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${sal.toString("base64")}:${h.toString("base64")}`;
}
export async function comprobarClave(clave, guardada) {
  const [tipo, N, r, p, sal, h] = String(guardada).split(":");
  if (tipo !== "scrypt" || !sal || !h) return false;
  try {
    const esperado = Buffer.from(h, "base64");
    const hecho = await scrypt(String(clave).normalize("NFKC"), Buffer.from(sal, "base64"), esperado.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * Number(N) * Number(r) });
    return esperado.length > 0 && crypto.timingSafeEqual(hecho, esperado);
  } catch {
    return false; // a damaged hash: nobody gets in with it
  }
}

/** A short name for a session's device, from its browser: «Chrome · Android», «Safari · iPhone». */
export function aparatoDe(ua = "") {
  const so = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  const nav = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : /curl|node|undici/i.test(ua) ? ua.split("/")[0] : "";
  return [nav, so].filter(Boolean).join(" · ").slice(0, 60);
}

/**
 * almacen: the SQLite store. datos: the data folder (for the first user's code). registro: the journal.
 * apuntar(text, by): a line for Talaia's log, with who did it. alCerrar(ids): sessions that have just ended
 * (the web closes their screens). ahora: the clock (tests). codigoInicial: false from the terminal, which must not
 * make the first user's code (the service makes it, and its file has to stay the service's).
 */
export function crearUsuarios({ almacen, datos = null, registro = null, apuntar = null, alCerrar = () => {}, ahora = () => Date.now(), codigoInicial = true }) {
  const nota = (texto, por = null) => (apuntar ? apuntar(texto, por) : registro?.info(texto));
  const { db } = almacen;
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      llave TEXT PRIMARY KEY, nombre TEXT NOT NULL, clave TEXT NOT NULL, rol TEXT NOT NULL DEFAULT 'admin',
      creado INTEGER NOT NULL, cambiada INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sesiones (
      id TEXT PRIMARY KEY, llave TEXT NOT NULL, creada INTEGER NOT NULL, usada INTEGER NOT NULL, aparato TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS sesiones_llave ON sesiones (llave);
  `);
  const q = {
    cuantos: db.prepare("SELECT COUNT(*) AS n FROM usuarios"),
    uno: db.prepare("SELECT * FROM usuarios WHERE llave = ?"),
    todos: db.prepare("SELECT llave, nombre, creado FROM usuarios ORDER BY nombre COLLATE NOCASE"),
    nuevo: db.prepare("INSERT INTO usuarios (llave, nombre, clave, creado, cambiada) VALUES (?, ?, ?, ?, ?)"),
    clave: db.prepare("UPDATE usuarios SET clave = ?, cambiada = ? WHERE llave = ?"),
    quitar: db.prepare("DELETE FROM usuarios WHERE llave = ?"),
    sesion: db.prepare("SELECT s.id, s.llave, s.usada, u.nombre FROM sesiones s JOIN usuarios u ON u.llave = s.llave WHERE s.id = ?"),
    sesionesDe: db.prepare("SELECT id FROM sesiones WHERE llave = ?"),
    todasSesiones: db.prepare("SELECT id, llave, creada, usada, aparato FROM sesiones ORDER BY usada DESC"),
    abrir: db.prepare("INSERT INTO sesiones (id, llave, creada, usada, aparato) VALUES (?, ?, ?, ?, ?)"),
    usar: db.prepare("UPDATE sesiones SET usada = ? WHERE id = ?"),
    cerrar: db.prepare("DELETE FROM sesiones WHERE id = ?"),
    viejas: db.prepare("SELECT id FROM sesiones WHERE usada < ?"),
  };
  const fichero = datos ? path.join(datos, "primer-usuario.txt") : null;
  let codigo = null;
  let cambios = () => {};

  /* ── the first user's code ── */
  function prepararCodigo() {
    if (hay()) { borrarCodigo(); return; }
    if (fichero) { try { codigo = fs.readFileSync(fichero, "utf8").trim() || null; } catch { codigo = null; } }
    if (!codigo) {
      const b = crypto.randomBytes(8);
      codigo = [...b].map((x) => ALFABETO[x % ALFABETO.length]).join("").replace(/^(.{4})/, "$1-");
      if (fichero) { try { fs.writeFileSync(fichero, `${codigo}\n`, { mode: 0o600 }); } catch (e) { registro?.error(tx("s.j.codeFile", { e: e.message })); } }
    }
    registro?.aviso(tx("s.j.firstUser", { code: codigo }));
  }
  function borrarCodigo() {
    codigo = null;
    if (fichero) { try { fs.rmSync(fichero, { force: true }); } catch { /* it stays: harmless once there are users */ } }
  }
  const limpioCodigo = (c) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  /* ── failed attempts ── */
  const fallos = new Map(); // name key → { n, t, hasta }
  let recientes = []; // when the last failures were, whatever the name
  function espera(llave) {
    const t = ahora();
    recientes = recientes.filter((x) => t - x < 60000);
    if (recientes.length >= GLOBAL_MAX) return 60000 - (t - recientes[0]);
    const f = fallos.get(llave);
    return f && f.hasta > t ? f.hasta - t : 0;
  }
  function fallo(llave) {
    const t = ahora();
    let f = fallos.get(llave);
    if (!f || t - f.t > DAY) f = { n: 0, t, hasta: 0 };
    f.n++; f.t = t;
    if (f.n >= LIBRES) f.hasta = t + Math.min(ESPERA_MAX, 1000 * 2 ** (f.n - LIBRES));
    fallos.set(llave, f);
    if (fallos.size > 2000) fallos.delete(fallos.keys().next().value);
    recientes.push(t);
  }
  const frenado = (ms) => ({ ok: false, error: tx("s.u.wait", { s: Math.ceil(ms / 1000) }), espera: Math.ceil(ms / 1000) });
  // Many attempts at the same time would all pass the checks above before any failure counts: only a few at once.
  let enCurso = 0;

  /* ── checks ── */
  function nombreMal(nombre) {
    const n = String(nombre ?? "").normalize("NFKC").trim();
    return NOMBRE.test(n) ? null : tx("s.u.badName");
  }
  function claveMal(clave, nombre = "") {
    if (typeof clave !== "string" || [...clave].length < CLAVE_MIN) return tx("s.u.shortPass", { n: CLAVE_MIN });
    if ([...clave].length > CLAVE_MAX) return tx("s.u.longPass", { n: CLAVE_MAX });
    if (llaveDe(clave) === llaveDe(nombre)) return tx("s.u.passIsName");
    return null;
  }

  // A hash to compare against when the name doesn't exist, so a wrong name takes as long as a wrong password.
  let falsa = null;
  const hashFalso = () => (falsa ||= cifrar(crypto.randomBytes(12).toString("hex"))); // made once

  /* ── sessions ── */
  function abrirSesion(llave, aparato) {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = ahora();
    q.abrir.run(sha256(token), llave, t, t, aparato || "");
    cambios();
    return token;
  }
  function cerrarIds(ids) {
    if (!ids.length) return;
    for (const id of ids) q.cerrar.run(id);
    alCerrar(ids);
    cambios();
  }
  /** Sessions not used for 30 days. */
  function podar() { cerrarIds(q.viejas.all(ahora() - SESION_MS).map((r) => r.id)); }

  function hay() { return q.cuantos.get().n > 0; }

  const api = {
    hay,
    /** The code to create the first user (null once there is one). */
    get codigo() { return codigo; },
    /** When users or sessions change (for the screens). */
    set alCambiar(f) { cambios = f; },

    /** Users and their sessions, for the screens: never the passwords, and only the start of each session's id. */
    lista() {
      const ses = q.todasSesiones.all();
      return q.todos.all().map((u) => {
        const mias = ses.filter((s) => s.llave === u.llave);
        return { nombre: u.nombre, creado: u.creado, usado: mias[0]?.usada ?? null,
          sesiones: mias.map((s) => ({ id: s.id.slice(0, 12), aparato: s.aparato, creada: s.creada, usada: s.usada })) };
      });
    },

    /** The session of a cookie's token: { id, nombre, llave } or null (unknown or 30 days unused). Renews it. */
    sesion(token) {
      if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
      const id = sha256(token);
      const s = q.sesion.get(id);
      if (!s) return null;
      const t = ahora();
      if (t - s.usada > SESION_MS) { cerrarIds([id]); return null; }
      if (t - s.usada > RENOVAR_MS) { q.usar.run(t, id); cambios(); } // the list on the screens says when it was used
      return { id, nombre: s.nombre, llave: s.llave };
    },
    /** For a session already known (an open screen): still there? Renews it as in use. */
    sigue(id) {
      const s = q.sesion.get(id);
      if (!s) return false;
      const t = ahora();
      if (t - s.usada > SESION_MS) { cerrarIds([id]); return false; }
      if (t - s.usada > RENOVAR_MS) { q.usar.run(t, id); cambios(); }
      return true;
    },
    podar,

    /** Sign in: { ok, token, nombre } or { ok: false, error, espera? }. The same answer for a wrong name or password. */
    async entrar(nombre, clave, { aparato = "" } = {}) {
      const llave = llaveDe(nombre);
      const w = espera(llave);
      if (w > 0) return frenado(w);
      if (enCurso >= A_LA_VEZ) return frenado(1000);
      const u = llave ? q.uno.get(llave) : null;
      let bien = false;
      enCurso++; // before the first wait, so the ones arriving at the same time see it
      try {
        bien = typeof clave === "string" && clave.length <= CLAVE_MAX && (await comprobarClave(clave, u ? u.clave : await hashFalso()));
      } finally {
        enCurso--;
      }
      if (!u || !bien) {
        fallo(llave);
        // The name as typed, without anything that could pass for another line of the journal.
        registro?.aviso(tx("s.j.signInFail", { name: String(nombre ?? "").slice(0, 40).replace(/[\u0000-\u001f\u007f]/g, "?") }));
        return { ok: false, error: tx("s.u.wrong") };
      }
      fallos.delete(llave);
      nota(tx("s.log.signIn", { name: u.nombre, device: aparato || "?" }));
      return { ok: true, token: abrirSesion(llave, aparato), nombre: u.nombre };
    },

    /** The first user, with the code: { ok, token, nombre } or { ok: false, error }. */
    async primero(cod, nombre, clave, { aparato = "" } = {}) {
      if (hay()) return { ok: false, error: tx("s.u.alreadyUsers") };
      const w = espera("#codigo");
      if (w > 0) return frenado(w);
      const a = Buffer.from(limpioCodigo(cod)), b = Buffer.from(limpioCodigo(codigo));
      if (!codigo || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        fallo("#codigo");
        return { ok: false, error: tx("s.u.badCode") };
      }
      const r = await api.crear(nombre, clave);
      if (!r.ok) return r;
      return { ok: true, token: abrirSesion(llaveDe(nombre), aparato), nombre: r.nombre };
    },

    /** A new user (por: who made it, for the log). */
    async crear(nombre, clave, { por = null } = {}) {
      const e = nombreMal(nombre) || claveMal(clave, nombre);
      if (e) return { ok: false, error: e };
      const n = String(nombre).normalize("NFKC").trim(), llave = llaveDe(n);
      if (q.uno.get(llave)) return { ok: false, error: tx("s.u.exists", { name: n }) };
      const h = await cifrar(clave);
      if (q.uno.get(llave)) return { ok: false, error: tx("s.u.exists", { name: n }) }; // made meanwhile
      const t = ahora();
      q.nuevo.run(llave, n, h, t, t);
      borrarCodigo();
      cambios();
      nota(tx("s.log.userNew", { name: n }), por);
      return { ok: true, nombre: n, toast: tx("s.u.created", { name: n }) };
    },

    /**
     * New password for a user. Their own needs the current one (opts.actual); someone else's doesn't (everyone can
     * do everything). Every session of that user ends, except opts.menos (the one that changed its own).
     */
    async cambiarClave(nombre, clave, { actual = null, propia = false, menos = null, por = null } = {}) {
      const u = q.uno.get(llaveDe(nombre));
      if (!u) return { ok: false, error: tx("s.u.noUser") };
      const e = claveMal(clave, u.nombre);
      if (e) return { ok: false, error: e };
      if (propia) {
        const w = espera(u.llave);
        if (w > 0) return frenado(w);
        if (typeof actual !== "string" || !(await comprobarClave(actual, u.clave))) { fallo(u.llave); return { ok: false, error: tx("s.u.wrongCurrent") }; }
      }
      q.clave.run(await cifrar(clave), ahora(), u.llave);
      cerrarIds(q.sesionesDe.all(u.llave).map((r) => r.id).filter((id) => id !== menos));
      nota(tx("s.log.userPass", { name: u.nombre }), por);
      return { ok: true, toast: tx(propia ? "s.u.ownPassSaved" : "s.u.passSaved", { name: u.nombre }) };
    },

    /** Removes a user (not oneself: someone else has to; so there is always someone). */
    quitar(nombre, { yo = null, por = null } = {}) {
      const u = q.uno.get(llaveDe(nombre));
      if (!u) return { ok: false, error: tx("s.u.noUser") };
      if (u.llave === yo) return { ok: false, error: tx("s.u.notYourself") };
      const ids = q.sesionesDe.all(u.llave).map((r) => r.id);
      q.quitar.run(u.llave);
      cerrarIds(ids);
      cambios();
      nota(tx("s.log.userRemoved", { name: u.nombre }), por);
      return { ok: true, toast: tx("s.u.removed", { name: u.nombre }) };
    },

    /** Ends a user's sessions (all of them; for oneself, all but this one). */
    cerrarSesiones(nombre, { menos = null } = {}) {
      const u = q.uno.get(llaveDe(nombre));
      if (!u) return { ok: false, error: tx("s.u.noUser") };
      const ids = q.sesionesDe.all(u.llave).map((r) => r.id).filter((id) => id !== menos);
      cerrarIds(ids);
      return { ok: true, toast: tx(ids.length === 1 ? "s.u.closed1" : "s.u.closed", { n: ids.length }) };
    },
    /** Ends one session by the start of its id (from the list). */
    cerrarUna(corto) {
      if (typeof corto !== "string" || corto.length < 12) return { ok: false };
      const s = q.todasSesiones.all().find((x) => x.id.startsWith(corto));
      if (!s) return { ok: false, error: tx("s.u.noSession") };
      cerrarIds([s.id]);
      return { ok: true, toast: tx("s.u.closed1") };
    },
    /** Signing out: this session ends. */
    salir(id) { if (id) cerrarIds([id]); },

    /**
     * From the terminal (sudo talaia --clave NAME): sets the password, creating the user if it isn't there,
     * and ends their sessions. Without checking the current one: whoever is root on the machine can anyway.
     */
    async ponerDesdeTerminal(nombre, clave) {
      const llave = llaveDe(nombre);
      if (!q.uno.get(llave)) return api.crear(nombre, clave);
      const u = q.uno.get(llave);
      const e = claveMal(clave, u.nombre);
      if (e) return { ok: false, error: e };
      q.clave.run(await cifrar(clave), ahora(), llave);
      for (const r of q.sesionesDe.all(llave)) q.cerrar.run(r.id);
      return { ok: true, nombre: u.nombre };
    },
  };
  if (codigoInicial) prepararCodigo();
  return api;
}
