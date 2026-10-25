// Interface language: both dictionaries have the same keys, placeholders are filled, and the default follows the browser.
import test from "node:test";
import assert from "node:assert/strict";
import { t, setLang, getLang, browserLang, _dicts } from "../src/i18n.js";

test("Spanish and English have the same keys", () => {
  const es = Object.keys(_dicts.es).sort();
  const en = Object.keys(_dicts.en).sort();
  assert.deepEqual(en.filter((k) => !es.includes(k)), [], "only in English");
  assert.deepEqual(es.filter((k) => !en.includes(k)), [], "only in Spanish");
});

test("texts with values, and plurals", () => {
  setLang("es");
  assert.equal(getLang(), "es");
  assert.equal(t("link.ready", { name: "BAS5" }), "BAS5 conectado");
  assert.equal(t("nav.alarmsBadge", { n: 1 }), "1 alarma sin atender");
  assert.equal(t("nav.alarmsBadge", { n: 3 }), "3 alarmas sin atender");
  setLang("en");
  assert.equal(t("link.ready", { name: "BAS5" }), "BAS5 connected");
  assert.equal(t("title.alarm", { n: 2 }), "(2) Alarm · Talaia");
  assert.equal(t("no.such.key"), "no.such.key");
  setLang("xx"); // unknown: stays as it was
  assert.equal(getLang(), "en");
});

test("the browser's language picks the default", () => {
  assert.equal(browserLang(["es-ES", "en"]), "es");
  assert.equal(browserLang(["ca-ES"]), "es");
  assert.equal(browserLang(["eu"]), "es");
  assert.equal(browserLang(["en-GB", "es"]), "en");
  assert.equal(browserLang(["de-DE", "fr"]), "en");
  assert.equal(browserLang(["de-DE", "es"]), "es");
  assert.equal(browserLang([]), "en");
});

test("every text the screen asks for is in both languages, with the same placeholders", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = new URL("../src/", import.meta.url).pathname;
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f));
  const used = new Set();
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/\btr?\(\s*"([\w.]+)"/g)) used.add(m[1]);
    for (const m of s.matchAll(/\btr?\([^()]*?\?\s*"([\w.]+)"\s*:\s*"([\w.]+)"/g)) { used.add(m[1]); used.add(m[2]); }
  }
  // The tabs of Settings are asked for by name (`set.tab.${k}`): their list, from the source.
  const tabs = /export const TABS = \[([^\]]+)\]/.exec(fs.readFileSync(path.join(dir, "views/settings.js"), "utf8"))[1].match(/[a-z]+/g);
  for (const k of tabs) used.add(`set.tab.${k}`);
  for (const lang of Object.keys(_dicts)) assert.deepEqual([...used].filter((k) => !(k in _dicts[lang])).sort(), [], `missing in ${lang}`);
  const holes = (v) => (typeof v === "string" ? [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",") : "fn");
  const differ = Object.keys(_dicts.es).filter((k) => holes(_dicts.es[k]) !== holes(_dicts.en[k]));
  assert.deepEqual(differ, [], "different placeholders");
});
