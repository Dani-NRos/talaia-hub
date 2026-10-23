// The `talaia` command: its options in Spanish and English, what it says in the terminal's language (or the server's,
// if the terminal says none), the exit codes of --code, and the language a new installation starts with.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { crearTalaia } from "../src/talaia.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { getLanguage, setLanguage } from "@talaia/nucleo/idioma.js";

const MAIN = new URL("../src/main.js", import.meta.url).pathname;

function montar() {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-cli-"));
  const cfg = path.join(datos, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: 9 }, datos }));
  const talaia = (lang, ...a) => {
    const env = { ...process.env, LANG: lang };
    for (const k of ["LC_ALL", "LC_MESSAGES", "TALAIA_DOCKER"]) delete env[k];
    const r = spawnSync(process.execPath, [MAIN, "--config", cfg, ...a], { env, encoding: "utf8", input: "" });
    return { status: r.status, out: (r.stdout + r.stderr).trim() };
  };
  return { datos, talaia };
}

test("talaia --code / --codigo: the code, or why not, with an exit code the installer can read", () => {
  const { datos, talaia } = montar();
  let r = talaia("en_GB.UTF-8", "--code");
  assert.equal(r.status, 4);
  assert.match(r.out, /There's no code yet: start the service \(sudo systemctl restart talaia\)/);
  fs.writeFileSync(path.join(datos, "primer-usuario.txt"), "ABCD-EFGH\n");
  r = talaia("es_ES.UTF-8", "--codigo");
  assert.deepEqual(r, { status: 0, out: "Código para crear el primer usuario: ABCD-EFGH" });
  assert.deepEqual(talaia("en_US.UTF-8", "--code"), { status: 0, out: "Code to create the first user: ABCD-EFGH" });
  // The users: none yet; one made from the terminal (password from a pipe, twice).
  assert.match(talaia("en_US.UTF-8", "--users").out, /There are no users yet\. .*sudo talaia --code.*sudo talaia --password NAME/);
  const env = { ...process.env, LANG: "en_US.UTF-8" };
  const p = spawnSync(process.execPath, [MAIN, "--config", path.join(datos, "config.json"), "--password", "Dani"], { env, encoding: "utf8", input: "una-clave-larga\nuna-clave-larga\n" });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /Done: Dani can sign in with that password now/);
  r = talaia("es_ES.UTF-8", "--codigo");
  assert.equal(r.status, 3);
  assert.match(r.out, /Ya hay usuarios: no hace falta código\. Para cambiar una contraseña: sudo talaia --clave NOMBRE/);
  assert.match(talaia("es_ES.UTF-8", "--usuarios").out, /^Dani · 0 sesiones abiertas · último uso: nunca$/);
  assert.match(talaia("en_GB.UTF-8", "--users").out, /^Dani · 0 open sessions · last used: never$/);
  assert.match(talaia("en_GB.UTF-8", "--password").out, /The name is missing: sudo talaia --password NAME/);
});

test("talaia with no language in the terminal (Docker): the server's, and English if it has none", () => {
  const { datos, talaia } = montar();
  assert.match(talaia("", "--code").out, /There's no code yet/);
  const a = abrirAlmacen(path.join(datos, "talaia.db"));
  a.guardar("settings", { language: "es" });
  a.cerrar();
  assert.match(talaia("C.UTF-8", "--code").out, /Aún no hay código/);
  assert.match(talaia("en_GB.UTF-8", "--code").out, /There's no code yet/, "the terminal's, if it says one");
  // Invalid configuration, before anything is known: the terminal's.
  fs.writeFileSync(path.join(datos, "config.json"), JSON.stringify({ receiver: { type: "tcp" } }));
  assert.deepEqual(talaia("en_GB.UTF-8", "--code"), { status: 2, out: "Invalid configuration: the TCP receiver needs a “host”: the node's IP or name" });
  assert.equal(talaia("es_ES.UTF-8", "--code").out, "Configuración no válida: para el receptor por TCP falta «host»: la IP o el nombre del nodo");
});

test("a new installation starts in the machine's language; one of before, in Spanish; a chosen one stays", async () => {
  const registro = crearRegistro({ nivel: "error", salida: [] });
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: 9 } });
  try {
    // New: nothing of the mesh saved (the installer may have made the database for the broker's users already).
    let almacen = abrirAlmacen(":memory:");
    almacen.guardar("mosquitto", { interno: { clave: "x" }, usuarios: [] });
    let t = await crearTalaia(config, registro, { almacen, idiomaNuevo: "en" });
    assert.equal(t.S.settings.language, "en");
    assert.equal(almacen.leer("settings").language, "en", "saved: the next start doesn't decide again");
    await t.detener();
    // Of before 3.4: nodes saved, no language. Spanish, whatever the machine's.
    almacen = abrirAlmacen(":memory:");
    almacen.guardar("nodes", []);
    almacen.guardar("cfg", { watched: {} });
    t = await crearTalaia(config, registro, { almacen, idiomaNuevo: "en" });
    assert.equal(t.S.settings.language, "es");
    await t.detener();
    // Chosen: it stays.
    almacen = abrirAlmacen(":memory:");
    almacen.guardar("settings", { language: "en" });
    t = await crearTalaia(config, registro, { almacen, idiomaNuevo: "es" });
    assert.equal(t.S.settings.language, "en");
    await t.detener();
  } finally {
    setLanguage("es");
  }
  assert.equal(getLanguage(), "es");
});
