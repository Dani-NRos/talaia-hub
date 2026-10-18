// Almacén del servidor en SQLite (node:sqlite, sin compilar nada):
//  - lecturas: el histórico, con la misma forma que en la app ({ node, metric, t, v }) y sin duplicados;
//  - estado: lo que la app guarda en localStorage (cfg, nodos, alarmas activas, registro…), como JSON por clave.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const VERSION = 1;

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
    poner: db.prepare("INSERT OR REPLACE INTO lecturas (nodo, metrica, t, v) VALUES (?, ?, ?, ?)"),
    serie: db.prepare("SELECT t, v FROM lecturas WHERE nodo = ? AND metrica = ? AND t >= ? AND t <= ? ORDER BY t"),
    todas: db.prepare("SELECT nodo AS node, metrica AS metric, t, v FROM lecturas ORDER BY t"),
    cuenta: db.prepare("SELECT COUNT(*) AS n FROM lecturas"),
    cuentaDesde: db.prepare("SELECT COUNT(*) AS n FROM lecturas WHERE t >= ?"),
    podar: db.prepare("DELETE FROM lecturas WHERE t < ?"),
    vaciar: db.prepare("DELETE FROM lecturas"),
    leerEstado: db.prepare("SELECT valor FROM estado WHERE clave = ?"),
    guardarEstado: db.prepare("INSERT OR REPLACE INTO estado (clave, valor, t) VALUES (?, ?, ?)"),
  };

  /** Histórico con la misma interfaz que el de la app (store.js), para el motor. */
  const lecturas = {
    kind: "sqlite",
    async add(rows) {
      if (!rows.length) return;
      db.exec("BEGIN");
      try {
        for (const r of rows) q.poner.run(r.node, r.metric, Math.round(r.t), r.v);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async series(node, metric, from, to = Number.MAX_SAFE_INTEGER) {
      return q.serie.all(node, metric, Math.floor(from), Math.min(to, Number.MAX_SAFE_INTEGER)).map((r) => ({ t: r.t, v: r.v }));
    },
    async all() { return q.todas.all().map((r) => ({ ...r })); },
    async count(desde = null) { return (desde == null ? q.cuenta.get() : q.cuentaDesde.get(Math.floor(desde))).n; },
    async prune(before) { return Number(q.podar.run(Math.floor(before)).changes); },
    async clear() { q.vaciar.run(); },
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
