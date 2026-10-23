// The texts of the core and the server: every key asked for with tx() exists in Spanish and English, and both
// languages have the same placeholders (a missing one would show "{name}" to whoever reads it).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _textDicts } from "@talaia/nucleo/idioma.js";
import "../src/textos.js";

const raiz = new URL("../../", import.meta.url).pathname;
const fuentes = ["nucleo/src", "servidor/src"].flatMap((d) =>
  fs.readdirSync(path.join(raiz, d)).filter((f) => f.endsWith(".js")).map((f) => path.join(raiz, d, f)));

/** The first argument of each tx( … ) call: up to its first comma or closing parenthesis at the same depth. */
function primerosArgumentos(src) {
  const out = [];
  for (const m of src.matchAll(/\btx\(/g)) {
    let i = m.index + m[0].length, depth = 0, quote = null;
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) break;
    }
    out.push(src.slice(start, i));
  }
  return out;
}

test("every text asked for exists in both languages", () => {
  const usadas = new Set(), plantillas = new Set();
  for (const f of fuentes) {
    const src = fs.readFileSync(f, "utf8");
    for (const arg of primerosArgumentos(src)) {
      for (const m of arg.matchAll(/"([a-z][\w]*(?:\.[\w]+)+)"/g)) usadas.add(m[1]);
      for (const m of arg.matchAll(/`([a-z][\w.]*)\.\$\{/g)) plantillas.add(m[1]);
    }
  }
  assert.ok(usadas.size > 300, `only ${usadas.size} keys found: is the search still right?`);
  for (const lang of ["es", "en"]) {
    const d = _textDicts[lang];
    assert.deepEqual([...usadas].filter((k) => !(k in d)).sort(), [], `missing in ${lang}`);
    // keys built from a variable (`ask.${type}`): at least one of each family
    for (const p of plantillas) assert.ok(Object.keys(d).some((k) => k.startsWith(`${p}.`)), `no ${p}.* in ${lang}`);
  }
  // the families built from a variable, one by one
  for (const k of [...["permiso", "busy", "unplugged", "noapi", "red", "lost"].map((k) => `s.rx.tip.${k}`), "s.lang.es", "s.lang.en", "s.j.log.raise", "s.j.log.clear", "s.j.log.ack", "s.j.log.info"]) {
    assert.ok(k in _textDicts.es && k in _textDicts.en, k);
  }
});

test("Spanish and English have the same keys and the same placeholders", () => {
  const { es, en } = _textDicts;
  assert.deepEqual(Object.keys(en).filter((k) => !(k in es)), [], "only in English");
  assert.deepEqual(Object.keys(es).filter((k) => !(k in en)), [], "only in Spanish");
  const huecos = (v) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  assert.deepEqual(Object.keys(es).filter((k) => huecos(es[k]) !== huecos(en[k])), [], "different placeholders");
});
