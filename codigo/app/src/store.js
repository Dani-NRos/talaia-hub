// Histórico de lecturas. IndexedDB en el móvil; memoria en el modo demo.
// Cada fila: { node, metric, t (ms), v }. La clave compuesta evita duplicados.

const DB_NAME = "vigia-mesh";
const STORE = "readings";

function req(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function createIdbStore() {
  let dbp = null;
  const open = () => {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        let r;
        try { r = indexedDB.open(DB_NAME, 1); } catch (e) { rej(e); return; }
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: ["node", "metric", "t"] });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  };
  const tx = async (mode) => (await open()).transaction(STORE, mode).objectStore(STORE);

  return {
    kind: "idb",
    async add(rows) {
      if (!rows.length) return;
      try {
        const st = await tx("readwrite");
        for (const r of rows) st.put(r);
        await new Promise((res, rej) => { st.transaction.oncomplete = res; st.transaction.onerror = () => rej(st.transaction.error); });
      } catch (e) { console.warn("No se pudo guardar la lectura", e); }
    },
    async series(node, metric, from, to = Infinity) {
      try {
        const st = await tx("readonly");
        const range = IDBKeyRange.bound([node, metric, from], [node, metric, to]);
        const rows = await req(st.getAll(range));
        return rows.map((r) => ({ t: r.t, v: r.v }));
      } catch { return []; }
    },
    async all() {
      try { return await req((await tx("readonly")).getAll()); } catch { return []; }
    },
    async count() {
      try { return await req((await tx("readonly")).count()); } catch { return 0; }
    },
    async prune(before) {
      try {
        const st = await tx("readwrite");
        await new Promise((res) => {
          const c = st.openCursor();
          c.onsuccess = () => {
            const cur = c.result;
            if (!cur) return res();
            if (cur.value.t < before) cur.delete();
            cur.continue();
          };
          c.onerror = () => res();
        });
      } catch { /* sin almacenamiento */ }
    },
    async clear() {
      try { await req((await tx("readwrite")).clear()); } catch { /* nada que borrar */ }
    },
  };
}

export function createMemStore() {
  let rows = [];
  return {
    kind: "mem",
    async add(r) { rows.push(...r); },
    async series(node, metric, from, to = Infinity) {
      return rows.filter((r) => r.node === node && r.metric === metric && r.t >= from && r.t <= to)
        .sort((a, b) => a.t - b.t).map((r) => ({ t: r.t, v: r.v }));
    },
    async all() { return rows.slice(); },
    async count() { return rows.length; },
    async prune(before) { rows = rows.filter((r) => r.t >= before); },
    async clear() { rows = []; },
  };
}
