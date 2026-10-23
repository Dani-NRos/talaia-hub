// Almacén del servidor en SQLite (node:sqlite, sin compilar nada):
//  - lecturas: el histórico, con la misma forma que en la app ({ node, metric, t, v }) y sin duplicados;
//  - estado: lo que la app guarda en localStorage (cfg, nodos, alarmas activas, registro…), como JSON por clave.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const VERSION = 1;

/**
 * The database file in a data folder: talaia.db. Up to 2.0 it was vigia.db; mover: rename it now (only the service
 * does, when starting, before opening it), or just use whichever is there (the terminal, with the service running).
 */
export function rutaAlmacen(datos, { mover = false } = {}) {
  const nueva = path.join(datos, "talaia.db"), vieja = path.join(datos, "vigia.db");
  if (fs.existsSync(nueva) || !fs.existsSync(vieja)) return nueva;
  if (!mover) return vieja;
  for (const fin of ["", "-wal", "-shm"]) if (fs.existsSync(vieja + fin)) fs.renameSync(vieja + fin, nueva + fin);
  return nueva;
}

/** ruta: fichero de la base de datos, o ":memory:" para pruebas. */
export function abrirAlmacen(ruta) {
  if (ruta !== ":memory:") fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  // WAL: lecturas y escrituras a la vez, y menos escrituras en la tarjeta SD de una Raspberry.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS lecturas (
      nodo INTEGER NOT NULL, metrica TEXT NOT NULL, t INTEGER NOT NULL, v REAL NOT NULL,
      PRIMARY KEY (nodo, metrica, t)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS lecturas_t ON lecturas (t);
    CREATE TABLE IF NOT EXISTS estado (clave TEXT PRIMARY KEY, valor TEXT NOT NULL, t INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS esquema (version INTEGER NOT NULL);
  `);
  const v = db.prepare("SELECT version FROM esquema").get();
  if (!v) db.prepare("INSERT INTO esquema (version) VALUES (?)").run(VERSION);

  const q = {
    // Nueva lectura: si ya estaba (la misma hora del mismo sensor), se actualiza su valor sin contarla otra vez.
    nueva: db.prepare("INSERT OR IGNORE INTO lecturas (nodo, metrica, t, v) VALUES (?, ?, ?, ?)"),
    poner: db.prepare("UPDATE lecturas SET v = ?4 WHERE nodo = ?1 AND metrica = ?2 AND t = ?3"),
    serie: db.prepare("SELECT t, v FROM lecturas WHERE nodo = ? AND metrica = ? AND t >= ? AND t <= ? ORDER BY t"),
    todas: db.prepare("SELECT nodo AS node, metrica AS metric, t, v FROM lecturas ORDER BY t"),
    cuenta: db.prepare("SELECT COUNT(*) AS n FROM lecturas"),
    cuentaDesde: db.prepare("SELECT COUNT(*) AS n FROM lecturas WHERE t >= ?"),
    podar: db.prepare("DELETE FROM lecturas WHERE t < ?"),
    vaciar: db.prepare("DELETE FROM lecturas"),
    leerEstado: db.prepare("SELECT valor FROM estado WHERE clave = ?"),
    guardarEstado: db.prepare("INSERT OR REPLACE INTO estado (clave, valor, t) VALUES (?, ?, ?)"),
  };

  let total = null; // lecturas guardadas, sin volver a contarlas (ver count)
  /** Histórico con la misma interfaz que el de la app (store.js), para el motor. */
  const lecturas = {
    kind: "sqlite",
    async add(rows) {
      if (!rows.length) return;
      db.exec("BEGIN");
      let nuevas = 0;
      try {
        for (const r of rows) {
          const t = Math.round(r.t);
          if (Number(q.nueva.run(r.node, r.metric, t, r.v).changes)) nuevas++;
          else q.poner.run(r.node, r.metric, t, r.v); // ya estaba: se queda el valor nuevo, como antes
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      if (total != null) total += nuevas;
    },
    async series(node, metric, from, to = Number.MAX_SAFE_INTEGER) {
      return q.serie.all(node, metric, Math.floor(from), Math.min(to, Number.MAX_SAFE_INTEGER)).map((r) => ({ t: r.t, v: r.v }));
    },
    async all() { return q.todas.all().map((r) => ({ ...r })); },
    /**
     * Cuántas lecturas hay (desde esa hora, si se da). El total sale de memoria: contarlas todas en SQLite recorre
     * la tabla entera, y con un año de histórico eso para el servidor (alarmas incluidas) un par de segundos en una Pi.
     */
    async count(desde = null) {
      if (desde != null) return q.cuentaDesde.get(Math.floor(desde)).n;
      if (total == null) total = q.cuenta.get().n;
      return total;
    },
    async prune(before) {
      const n = Number(q.podar.run(Math.floor(before)).changes);
      if (total != null) total -= n;
      return n;
    },
    async clear() { q.vaciar.run(); total = 0; },
    /** Las lecturas de una métrica de un nodo pasan a llamarse de otra forma (al cambiar cómo se guarda un dato). */
    renombrar(node, de, a) { return Number(db.prepare("UPDATE OR IGNORE lecturas SET metrica = ? WHERE nodo = ? AND metrica = ?").run(a, node, de).changes); },
    /** Borra las lecturas de una métrica de un nodo (un dato que se quita) o de todo un nodo (metric null). */
    borrar(node, metric = null) {
      const n = Number((metric == null
        ? db.prepare("DELETE FROM lecturas WHERE nodo = ?").run(node)
        : db.prepare("DELETE FROM lecturas WHERE nodo = ? AND metrica = ?").run(node, metric)).changes);
      if (total != null) total -= n;
      return n;
    },
  };

  return {
    db,
    lecturas,
    /** Lee una parte del estado (JSON); d si no está o está dañada. */
    leer(clave, d = null) {
      const r = q.leerEstado.get(clave);
      if (!r) return d;
      try { return JSON.parse(r.valor); } catch { return d; }
    },
    guardar(clave, valor) { q.guardarEstado.run(clave, JSON.stringify(valor), Date.now()); },
    /** Tamaño del fichero (con el diario WAL), en bytes. */
    tamano() {
      if (ruta === ":memory:") return 0;
      let n = 0;
      for (const f of [ruta, `${ruta}-wal`]) { try { n += fs.statSync(f).size; } catch { /* no existe */ } }
      return n;
    },
    cerrar() { try { db.close(); } catch { /* ya cerrada */ } },
  };
}
