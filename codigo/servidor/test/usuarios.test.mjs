// Users and sessions: the first user with its code, passwords, sessions that last 30 days unused, failed attempts that
// slow down; and on the web, that nothing but the app and signing in works without a session.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { abrirAlmacen } from "../src/almacen.js";
import { crearUsuarios, cifrar, comprobarClave, aparatoDe, SESION_MS } from "../src/usuarios.js";
import { crearVigia } from "../src/vigia.js";
import { crearWeb } from "../src/web.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { NodoFalso, hasta, CASETA } from "./nodo-falso.mjs";

const DIA = 24 * 3600 * 1000;

/** Users on a database in memory, with a clock the test moves. */
function montar({ datos = null } = {}) {
  const almacen = abrirAlmacen(":memory:");
  let t = Date.UTC(2026, 9, 23, 10);
  const cerradas = [];
  const notas = [];
  const u = crearUsuarios({ almacen, datos, ahora: () => t, alCerrar: (ids) => cerradas.push(...ids), apuntar: (texto, por) => notas.push({ texto, por }) });
  return { u, almacen, cerradas, notas, pasar: (ms) => { t += ms; } };
}

test("passwords: scrypt, the same one checks, another or a damaged hash doesn't", async () => {
  const h = await cifrar("una clave bastante larga");
  assert.match(h, /^scrypt:16384:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.notEqual(h, await cifrar("una clave bastante larga")); // each with its own salt
  assert.equal(await comprobarClave("una clave bastante larga", h), true);
  assert.equal(await comprobarClave("una clave bastante larg", h), false);
  assert.equal(await comprobarClave("una clave bastante larga", "scrypt:16384:8:1:AAAA:"), false);
  assert.equal(await comprobarClave("x", "texto plano"), false);
});

test("the first user: only with the code, which then disappears", async () => {
  const { u } = montar();
  assert.equal(u.hay(), false);
  assert.match(u.codigo, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  let r = await u.primero("AAAA-AAAA", "Dani", "clave-de-dani-1");
  assert.equal(r.ok, false);
  assert.match(r.error, /código/);
  // Typed in lower case and without the dash, it's the same code.
  r = await u.primero(u.codigo.toLowerCase().replace("-", " "), "Dani", "clave-de-dani-1", { aparato: "Chrome · Android" });
  assert.equal(r.ok, true);
  assert.equal(r.nombre, "Dani");
  assert.equal(u.sesion(r.token).nombre, "Dani");
  assert.equal(u.codigo, null);
  r = await u.primero("lo que sea", "Otro", "clave-de-otro-1");
  assert.match(r.error, /Ya hay usuarios/);
});

test("the code is kept in the data folder (the same after a restart) and goes when there is a user", async () => {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), "talaia-u-"));
  const db = path.join(datos, "vigia.db");
  const a1 = abrirAlmacen(db);
  const u1 = crearUsuarios({ almacen: a1, datos });
  const fichero = path.join(datos, "primer-usuario.txt");
  assert.equal(fs.readFileSync(fichero, "utf8").trim(), u1.codigo);
  assert.equal(fs.statSync(fichero).mode & 0o777, 0o600);
  const codigo = u1.codigo;
  a1.cerrar();
  const a2 = abrirAlmacen(db);
  const u2 = crearUsuarios({ almacen: a2, datos });
  assert.equal(u2.codigo, codigo);
  assert.equal((await u2.primero(codigo, "Dani", "clave-de-dani-1")).ok, true);
  assert.equal(fs.existsSync(fichero), false);
  a2.cerrar();
  fs.rmSync(datos, { recursive: true, force: true });
});

test("names and passwords that are not taken", async () => {
  const { u } = montar();
  assert.match((await u.crear("", "clave-larga-1")).error, /nombre/);
  assert.match((await u.crear("-dani", "clave-larga-1")).error, /nombre/);
  assert.match((await u.crear("a".repeat(33), "clave-larga-1")).error, /nombre/);
  assert.match((await u.crear("Dani", "corta")).error, /al menos 10/);
  assert.match((await u.crear("Dani Rosselló", "dani rosselló")).error, /nombre de usuario/);
  assert.equal((await u.crear("María José", "clave-de-maria")).ok, true);
  assert.match((await u.crear("maría josé", "otra-clave-larga")).error, /Ya hay/); // the same name, however written
  assert.equal((await u.crear("Dani", "x".repeat(200))).ok, true);
  assert.match((await u.crear("Otro", "x".repeat(201))).error, /como mucho/);
});

test("signing in: the same answer for a wrong name or password; only the token's hash is kept", async () => {
  const { u, almacen, notas } = montar();
  await u.crear("Dani", "clave-de-dani-1");
  const mal1 = await u.entrar("Dani", "otra-clave-cualquiera");
  const mal2 = await u.entrar("Nadie", "clave-de-dani-1");
  assert.deepEqual(mal1, mal2);
  assert.equal(mal1.ok, false);
  const r = await u.entrar("DANI", "clave-de-dani-1", { aparato: "Firefox · Linux" });
  assert.equal(r.ok, true);
  assert.equal(r.nombre, "Dani");
  assert.ok(r.token.length >= 40);
  assert.deepEqual({ ...u.sesion(r.token), id: "-" }, { id: "-", nombre: "Dani", llave: "dani" });
  assert.equal(u.sesion("otro-token-que-no-existe-de-verdad"), null);
  const filas = almacen.db.prepare("SELECT * FROM sesiones").all();
  assert.equal(filas.length, 1);
  assert.doesNotMatch(JSON.stringify(filas), new RegExp(r.token));
  assert.equal(filas[0].aparato, "Firefox · Linux");
  assert.ok(notas.some((n) => n.texto === "Dani ha entrado (Firefox · Linux)"));
  // What the screens see: no passwords, no tokens.
  const lista = JSON.stringify(u.lista());
  assert.doesNotMatch(lista, /scrypt|clave/);
  assert.doesNotMatch(lista, new RegExp(r.token));
});

test("failed attempts: five free, then a wait that doubles; right afterwards, it's fine again", async () => {
  const { u, pasar } = montar();
  await u.crear("Dani", "clave-de-dani-1");
  for (let i = 0; i < 5; i++) assert.equal((await u.entrar("Dani", `mala-${i}-xxxxxx`)).espera, undefined);
  let r = await u.entrar("Dani", "clave-de-dani-1");
  assert.equal(r.ok, false);
  assert.equal(r.espera, 1); // even the right one has to wait
  pasar(1000);
  assert.equal((await u.entrar("Dani", "mala-otra-xxxxxx")).ok, false);
  assert.equal((await u.entrar("Dani", "clave-de-dani-1")).espera, 2);
  pasar(2000);
  assert.equal((await u.entrar("Dani", "clave-de-dani-1")).ok, true);
  assert.equal((await u.entrar("Dani", "mala-xxxxxxxxx")).espera, undefined); // the count starts again
  // Another name is not affected by Dani's.
  await u.crear("Ana", "clave-de-ana-12");
  for (let i = 0; i < 6; i++) await u.entrar("Dani", `mala-${i}-xxxxxx`);
  assert.equal((await u.entrar("Ana", "clave-de-ana-12")).ok, true);
});

test("many failures in a minute, whatever the names: everyone waits", async () => {
  const { u, pasar } = montar();
  await u.crear("Dani", "clave-de-dani-1");
  for (let i = 0; i < 50; i++) await u.entrar(`nombre${i}`, "una-clave-cualquiera");
  const r = await u.entrar("Dani", "clave-de-dani-1");
  assert.ok(r.espera > 0 && r.espera <= 60);
  pasar(61000);
  assert.equal((await u.entrar("Dani", "clave-de-dani-1")).ok, true);
});

test("sessions: 30 days unused and it's over; used, it lasts", async () => {
  const { u, pasar, cerradas } = montar();
  await u.crear("Dani", "clave-de-dani-1");
  const usada = (await u.entrar("Dani", "clave-de-dani-1")).token;
  const olvidada = (await u.entrar("Dani", "clave-de-dani-1")).token;
  for (let i = 0; i < 4; i++) { pasar(20 * DIA); assert.ok(u.sesion(usada), `day ${(i + 1) * 20}`); }
  assert.equal(u.sesion(olvidada), null);
  assert.equal(cerradas.length, 1);
  pasar(SESION_MS + 1000);
  u.podar();
  assert.equal(u.sesion(usada), null);
});

test("passwords changed: one's own needs the current one and keeps this session; someone else's ends all of theirs", async () => {
  const { u, cerradas, notas } = montar();
  await u.crear("Dani", "clave-de-dani-1");
  await u.crear("Ana", "clave-de-ana-12");
  const d1 = await u.entrar("Dani", "clave-de-dani-1"), d2 = await u.entrar("Dani", "clave-de-dani-1");
  const a1 = await u.entrar("Ana", "clave-de-ana-12");
  const yo = u.sesion(d1.token);
  let r = await u.cambiarClave("Dani", "clave-nueva-dani", { propia: true, actual: "no-es-esta-xx", menos: yo.id });
  assert.match(r.error, /actual/);
  r = await u.cambiarClave("Dani", "clave-nueva-dani", { propia: true, actual: "clave-de-dani-1", menos: yo.id, por: "Dani" });
  assert.equal(r.ok, true);
  assert.ok(u.sesion(d1.token));
  assert.equal(u.sesion(d2.token), null);
  assert.equal((await u.entrar("Dani", "clave-nueva-dani")).ok, true);
  // Ana's, by Dani: without the current one; Ana's sessions end.
  r = await u.cambiarClave("Ana", "clave-nueva-ana", { por: "Dani" });
  assert.equal(r.ok, true);
  assert.equal(u.sesion(a1.token), null);
  assert.ok(cerradas.length >= 2);
  assert.deepEqual(notas.filter((n) => /Contraseña nueva/.test(n.texto)).map((n) => n.por), ["Dani", "Dani"]);
});

test("removing users: not oneself; their sessions end", async () => {
  const { u, cerradas } = montar();
  await u.crear("Dani", "clave-de-dani-1");
  await u.crear("Ana", "clave-de-ana-12");
  const a = await u.entrar("Ana", "clave-de-ana-12");
  assert.match(u.quitar("Dani", { yo: "dani" }).error, /ti/);
  assert.equal(u.quitar("Ana", { yo: "dani" }).ok, true);
  assert.equal(u.sesion(a.token), null);
  assert.equal(cerradas.length, 1);
  assert.deepEqual(u.lista().map((x) => x.nombre), ["Dani"]);
  assert.match(u.quitar("Ana").error, /ya no existe/);
});

test("ending sessions: all of a user's, all but this one, or one from the list", async () => {
  const { u } = montar();
  await u.crear("Dani", "clave-de-dani-1");
  const t = [];
  for (let i = 0; i < 3; i++) t.push((await u.entrar("Dani", "clave-de-dani-1")).token);
  const yo = u.sesion(t[0]);
  assert.match(u.cerrarSesiones("Dani", { menos: yo.id }).toast, /2 sesiones/);
  assert.ok(u.sesion(t[0]));
  assert.equal(u.sesion(t[1]), null);
  const corto = u.lista()[0].sesiones[0].id;
  assert.equal(corto.length, 12);
  assert.equal(u.cerrarUna(corto).ok, true);
  assert.equal(u.sesion(t[0]), null);
});

test("the device of a session, from its browser", () => {
  assert.equal(aparatoDe("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36"), "Chrome · Android");
  assert.equal(aparatoDe("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari · iPhone");
  assert.equal(aparatoDe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0"), "Edge · Windows");
  assert.equal(aparatoDe("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox · Linux");
  assert.equal(aparatoDe(""), "");
});

/* ───────────── on the web ───────────── */

async function servidor(t) {
  const nodo = new NodoFalso();
  const puertoNodo = await nodo.escucharTcp();
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-"));
  fs.writeFileSync(path.join(appDir, "index.html"), "<!doctype html><html><head><title>Talaia</title></head><body>app</body></html>");
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, web: { escuchar: "127.0.0.1" }, datos: os.tmpdir() });
  config.web.puerto = 0;
  const vigia = await crearVigia(config, crearRegistro({ nivel: "error", salida: [] }), { almacen: abrirAlmacen(":memory:") });
  const web = crearWeb(vigia, config, crearRegistro({ nivel: "error", salida: [] }), { appDir });
  const puerto = await web.escuchar();
  vigia.arrancar();
  await hasta(() => vigia.S.link.state === "ready", 8000, "receptor listo");
  t.after(async () => { await web.cerrar(); await vigia.detener(); await nodo.cerrar(); });
  return { vigia, nodo, base: `http://127.0.0.1:${puerto}`, puerto };
}
function pedir(base, ruta, { metodo = "GET", cabeceras = {}, datos = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(ruta, base);
    const headers = { ...(datos ? { "content-type": "application/json" } : {}), ...cabeceras };
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: metodo, headers }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { d += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(d); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, cuerpo: d, json }); });
    });
    req.on("error", reject);
    if (datos) req.write(JSON.stringify(datos));
    req.end();
  });
}
const galletaDe = (r) => String(r.headers["set-cookie"] || "").split(";")[0];

test("web: without a session, only the app, «alive» and signing in", async (t) => {
  const { base, vigia } = await servidor(t);
  assert.equal((await pedir(base, "/")).status, 200);
  const salud = await pedir(base, "/api/salud");
  assert.deepEqual(Object.keys(salud.json).sort(), ["ok", "receptor"]);
  for (const ruta of ["/api/estado", "/api/eventos", `/api/serie?nodo=${CASETA}&metrica=temperature`, "/api/lecturas.csv", "/api/nada"]) {
    const r = await pedir(base, ruta);
    assert.equal(r.status, 401, ruta);
    assert.equal(r.json.entrar, true);
  }
  assert.equal((await pedir(base, "/api/orden", { metodo: "POST", datos: { orden: "ackAll" } })).status, 401);
  assert.equal((await pedir(base, "/api/orden", { metodo: "POST", datos: { orden: "crearUsuario", nombre: "Malo", clave: "clave-del-malo" } })).status, 401);
  // With a made-up cookie, the same.
  assert.equal((await pedir(base, "/api/estado", { cabeceras: { cookie: "talaia_sesion=inventada-pero-bastante-larga-0000" } })).status, 401);
  // No users: the screen is told to make the first one.
  const s = await pedir(base, "/api/sesion");
  assert.equal(s.status, 401);
  assert.equal(s.json.primero, true);
  assert.equal(vigia.usuarios.hay(), false);
});

test("web: the first user with the code, signed in at once; the cookie is HttpOnly", async (t) => {
  const { base, vigia } = await servidor(t);
  let r = await pedir(base, "/api/primero", { metodo: "POST", datos: { codigo: "NOPE-NOPE", nombre: "Dani", clave: "clave-de-dani-1" } });
  assert.equal(r.status, 401);
  r = await pedir(base, "/api/primero", { metodo: "POST", datos: { codigo: vigia.usuarios.codigo, nombre: "Dani", clave: "clave-de-dani-1" } });
  assert.equal(r.status, 200);
  const cookie = String(r.headers["set-cookie"]);
  assert.match(cookie, /^talaia_sesion=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  const g = galletaDe(r);
  r = await pedir(base, "/api/sesion", { cabeceras: { cookie: g } });
  assert.equal(r.json.nombre, "Dani");
  assert.equal(r.json.sesion.length, 12);
  assert.equal((await pedir(base, "/api/estado", { cabeceras: { cookie: g } })).status, 200);
  // Once there is one, the code is no good any more.
  r = await pedir(base, "/api/primero", { metodo: "POST", datos: { codigo: "lo que sea", nombre: "Otro", clave: "clave-de-otro-1" } });
  assert.equal(r.status, 409);
  // The users go to the screens without passwords.
  const estado = (await pedir(base, "/api/estado", { cabeceras: { cookie: g } })).cuerpo;
  assert.match(estado, /"usuarios":\[\{"nombre":"Dani"/);
  assert.doesNotMatch(estado, /scrypt/);
});

test("web: signing in from another page, wrong, too many times, and over https", async (t) => {
  const { base, vigia, puerto } = await servidor(t);
  await vigia.usuarios.crear("Dani", "clave-de-dani-1");
  let r = await pedir(base, "/api/entrar", { metodo: "POST", datos: { nombre: "Dani", clave: "clave-de-dani-1" }, cabeceras: { origin: "https://malvada.example" } });
  assert.equal(r.status, 403);
  assert.equal(r.headers["set-cookie"], undefined);
  r = await pedir(base, "/api/entrar", { metodo: "POST", cabeceras: { "content-type": "text/plain" } });
  assert.equal(r.status, 415);
  for (let i = 0; i < 5; i++) assert.equal((await pedir(base, "/api/entrar", { metodo: "POST", datos: { nombre: "Dani", clave: "mala-mala-mala" } })).status, 401);
  r = await pedir(base, "/api/entrar", { metodo: "POST", datos: { nombre: "Dani", clave: "mala-mala-mala" } });
  assert.equal(r.status, 429);
  assert.match(r.json.error, /Espera/);
  // Over «tailscale serve» (https, name .ts.net), the cookie only travels encrypted.
  await new Promise((res) => setTimeout(res, 1100));
  const ts = "bmax.tail1234.ts.net";
  r = await pedir(base, "/api/entrar", { metodo: "POST", datos: { nombre: "Dani", clave: "clave-de-dani-1" }, cabeceras: { host: ts, origin: `https://${ts}` } });
  assert.equal(r.status, 200, r.cuerpo);
  assert.match(String(r.headers["set-cookie"]), /; Secure$/);
  assert.ok(puerto);
});

test("web: signing out, and a screen whose session ends stops getting anything", async (t) => {
  const { base, vigia } = await servidor(t);
  await vigia.usuarios.crear("Dani", "clave-de-dani-1");
  await vigia.usuarios.crear("Ana", "clave-de-ana-12");
  const dani = galletaDe(await pedir(base, "/api/entrar", { metodo: "POST", datos: { nombre: "Dani", clave: "clave-de-dani-1" } }));
  const ana = galletaDe(await pedir(base, "/api/entrar", { metodo: "POST", datos: { nombre: "Ana", clave: "clave-de-ana-12" } }));
  // Ana's screen, open.
  let fin = false;
  const sse = http.get(new URL("/api/eventos", base), { headers: { cookie: ana } }, (res) => { res.resume(); res.on("end", () => { fin = true; }); });
  t.after(() => sse.destroy());
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fin, false);
  // Dani ends Ana's sessions: her screen is cut off, and she can't come back with that cookie.
  const r = await pedir(base, "/api/orden", { metodo: "POST", datos: { orden: "cerrarSesiones", nombre: "Ana" }, cabeceras: { cookie: dani } });
  assert.equal(r.json.ok, true);
  await hasta(() => fin, 2000, "Ana's screen cut off");
  assert.equal((await pedir(base, "/api/estado", { cabeceras: { cookie: ana } })).status, 401);
  // Dani signs out: the cookie is cleared and no longer valid.
  const salir = await pedir(base, "/api/salir", { metodo: "POST", cabeceras: { cookie: dani } });
  assert.match(String(salir.headers["set-cookie"]), /^talaia_sesion=; .*Max-Age=0/);
  assert.equal((await pedir(base, "/api/estado", { cabeceras: { cookie: dani } })).status, 401);
});

test("web: users from the screen, and who did each thing in the log", async (t) => {
  const { base, vigia, nodo } = await servidor(t);
  await vigia.usuarios.crear("Dani", "clave-de-dani-1");
  const dani = galletaDe(await pedir(base, "/api/entrar", { metodo: "POST", datos: { nombre: "Dani", clave: "clave-de-dani-1" } }));
  const orden = (datos, g = dani) => pedir(base, "/api/orden", { metodo: "POST", datos, cabeceras: { cookie: g } });
  let r = await orden({ orden: "crearUsuario", nombre: "Ana", clave: "clave-de-ana-12" });
  assert.deepEqual(r.json, { ok: true, toast: "Usuario «Ana» creado." });
  assert.deepEqual({ text: vigia.S.log[0].text, by: vigia.S.log[0].by }, { text: "Usuario nuevo: Ana", by: "Dani" });
  r = await orden({ orden: "crearUsuario", nombre: "Ana", clave: 3 });
  assert.equal(r.status, 400);
  r = await orden({ orden: "quitarUsuario", nombre: "Dani" });
  assert.match(r.json.error, /ti/);
  r = await orden({ orden: "claveUsuario", nombre: "Dani", clave: "clave-nueva-dani" });
  assert.match(r.json.error, /actual/); // one's own, without the current one: no
  r = await orden({ orden: "claveUsuario", nombre: "Dani", clave: "clave-nueva-dani", actual: "clave-de-dani-1" });
  assert.equal(r.json.ok, true);
  assert.equal((await pedir(base, "/api/sesion", { cabeceras: { cookie: dani } })).status, 200); // this one stays
  // What a user does carries their name; alarms coming and going don't.
  r = await orden({ orden: "vigilar", num: CASETA });
  assert.equal(r.json.ok, true);
  assert.equal(vigia.S.log[0].by, "Dani");
  r = await orden({ orden: "limite", num: CASETA, metrica: "temperature", lado: "max", valor: 10 });
  assert.equal(r.json.ok, true);
  nodo.ambiente(CASETA, { temperature: 22 });
  await hasta(() => vigia.S.log.some((e) => e.type === "raise"), 3000, "the alarm");
  assert.equal(vigia.S.log.find((e) => e.type === "raise").by, undefined);
  assert.equal(vigia.S.log.find((e) => e.type === "info" && /Vigilando/.test(e.text)).by, "Dani");
  // Names of orders that are not orders.
  for (const o of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    r = await orden({ orden: o });
    assert.equal(r.status, 400, o);
  }
});

test("many sign-ins at the same time: only a few passwords are checked at once", async () => {
  const { u } = montar();
  await u.crear("Dani", "clave-de-dani-1");
  const r = await Promise.all(Array.from({ length: 20 }, (_, i) => u.entrar(`n${i}`, "una-clave-cualquiera")));
  assert.ok(r.filter((x) => x.espera).length >= 10, "the rest are told to wait");
  assert.equal((await u.entrar("Dani", "clave-de-dani-1")).ok, true); // and afterwards, in
});
