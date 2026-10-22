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
  assert.equal(t("link.ready", { name: "DNN5" }), "DNN5 conectado");
  assert.equal(t("nav.alarmsBadge", { n: 1 }), "1 alarma sin atender");
  assert.equal(t("nav.alarmsBadge", { n: 3 }), "3 alarmas sin atender");
  setLang("en");
  assert.equal(t("link.ready", { name: "DNN5" }), "DNN5 connected");
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
