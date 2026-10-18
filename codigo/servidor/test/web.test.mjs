// Pruebas de la web del servidor: estado y cambios por eventos, órdenes desde la pantalla (y que una web ajena no
// pueda mandarlas), la app servida en modo «Servidor», series y CSV. Con un nodo simulado por TCP.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { crearVigia } from "../src/vigia.js";
import { crearWeb } from "../src/web.js";
import { comprobar } from "../src/config.js";
import { crearRegistro } from "../src/registro.js";
import { abrirAlmacen } from "../src/almacen.js";
import { NodoFalso, hasta, PORT, CASETA, AVISADO } from "./nodo-falso.mjs";

async function montar(t) {
  const nodo = new NodoFalso();
  const puertoNodo = await nodo.escucharTcp();
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-"));
  fs.writeFileSync(path.join(appDir, "index.html"), "<!doctype html><html><head><title>Vigía</title></head><body>app</body></html>");
  fs.writeFileSync(path.join(appDir, "sw.js"), "// sw");
  const config = comprobar({ receptor: { tipo: "tcp", host: "127.0.0.1", puerto: puertoNodo }, web: { escuchar: "127.0.0.1" }, datos: os.tmpdir() });
  config.web.puerto = 0; // uno libre, para las pruebas
  const registro = crearRegistro({ nivel: "error", salida: [] });
  const almacen = abrirAlmacen(":memory:");
  const vigia = await crearVigia(config, registro, { almacen });
  const web = crearWeb(vigia, config, registro, { appDir });
  const puerto = await web.escuchar();
  vigia.arrancar();
  await hasta(() => vigia.S.link.state === "ready", 8000, "receptor listo");
  t.after(async () => { await web.cerrar(); await vigia.detener(); await nodo.cerrar(); });
  const base = `http://127.0.0.1:${puerto}`;
  return { vigia, web, nodo, base, puerto };
}

/** Petición HTTP con cabeceras a mano (fetch no deja cambiar Host ni Origin). */
function pedir(base, ruta, { metodo = "GET", cabeceras = {}, cuerpo = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(ruta, base);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: metodo, headers: cabeceras }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { d += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, cuerpo: d }));
    });
    req.on("error", reject);
    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}
const orden = (base, datos, extra = {}) => pedir(base, "/api/orden", { metodo: "POST", cabeceras: { "content-type": "application/json", ...extra }, cuerpo: JSON.stringify(datos) })
  .then((r) => ({ ...r, json: JSON.parse(r.cuerpo) }));

/** Escucha /api/eventos y va guardando lo que llega. */
function escuchar(base) {
  const ev = [];
  const req = http.get(new URL("/api/eventos", base), (res) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const bloque = buf.slice(0, i); buf = buf.slice(i + 2);
        const tipo = /^event: (.*)$/m.exec(bloque)?.[1];
        const datos = /^data: (.*)$/m.exec(bloque)?.[1];
        if (tipo) ev.push({ tipo, datos: JSON.parse(datos) });
      }
    });
  });
  return { ev, cerrar: () => req.destroy() };
}

test("eventos: el estado al conectar y después solo lo que cambia", async (t) => {
  const { base, nodo } = await montar(t);
  const e = escuchar(base);
  t.after(e.cerrar);
  await hasta(() => e.ev.length >= 1, 3000, "estado inicial");
  const est = e.ev[0];
  assert.equal(est.tipo, "estado");
  assert.equal(est.datos.link.state, "ready");
  assert.ok(est.datos.nodes.some((n) => n.long === "Caseta huerto"));
  assert.equal(est.datos.myUser.publicKey.length, 32);
  nodo.ambiente(CASETA, { temperature: 22.5 });
  await hasta(() => e.ev.some((x) => x.tipo === "cambio" && x.datos.rows), 3000, "lecturas nuevas");
  const c = e.ev.find((x) => x.tipo === "cambio" && x.datos.rows);
  assert.deepEqual(c.datos.rows.map((r) => [r.metric, r.v]), [["temperature", 22.5]]);
  assert.ok(c.datos.nodes.some((n) => n.num === CASETA && n.metrics.temperature.v === 22.5));
  // Con todo ya enviado, otra lectura solo lleva el nodo que cambió (no la base entera).
  const antes = e.ev.length;
  nodo.ambiente(CASETA, { temperature: 22.75 });
  await hasta(() => e.ev.slice(antes).some((x) => x.datos.rows), 3000, "otra lectura");
  const d = e.ev.slice(antes).find((x) => x.datos.rows);
  assert.deepEqual(d.datos.nodes.map((n) => n.num), [CASETA]);
});

test("órdenes: vigilar y poner un límite; la alarma y el «Enterado» llegan a todas las pantallas", async (t) => {
  const { base, vigia, nodo } = await montar(t);
  const a = escuchar(base), b = escuchar(base);
  t.after(() => { a.cerrar(); b.cerrar(); });
  await hasta(() => a.ev.length && b.ev.length, 3000, "dos pantallas");
  let r = await orden(base, { orden: "vigilar", num: CASETA });
  assert.deepEqual(r.json, { ok: true, toast: "Caseta huerto fijado arriba. Ponle límites en su ficha." });
  r = await orden(base, { orden: "limite", num: CASETA, metrica: "temperature", lado: "max", valor: 30 });
  assert.equal(r.json.toast, "Límite guardado");
  r = await orden(base, { orden: "limite", num: CASETA, metrica: "temperature", lado: "min", valor: 31 });
  assert.deepEqual(r.json, { ok: false, error: "En temperatura el mínimo tiene que ser menor que el máximo." });
  nodo.ambiente(CASETA, { temperature: 33 });
  await hasta(() => b.ev.some((x) => x.tipo === "alarma"), 3000, "alarma en la otra pantalla");
  assert.equal(b.ev.find((x) => x.tipo === "alarma").datos.titulo, "Caseta huerto · Temperatura por encima de 30,0 °C");
  const key = `${CASETA}|temperature|high`;
  await orden(base, { orden: "ack", key });
  await hasta(() => b.ev.some((x) => x.tipo === "cambio" && x.datos.active?.some((al) => al.key === key && al.acked)), 3000, "visto en la otra pantalla");
  assert.equal(vigia.S.active.get(key).acked, true);
});

test("órdenes: los avisos del motor vuelven a quien pulsó; datos no válidos se rechazan", async (t) => {
  const { base, nodo } = await montar(t);
  let r = await orden(base, { orden: "pedir", num: CASETA, tipo: "route" });
  assert.equal(r.json.ok, true);
  await nodo.esperar(() => nodo.paquetes(PORT.TRACEROUTE_APP).length === 1, 3000, "traceroute");
  r = await orden(base, { orden: "pedir", num: AVISADO, tipo: "route" });
  assert.match(r.json.toast, /^Tu receptor solo lanza un traceroute cada 30 s, a cualquier nodo\. Espera \d+ s\.$/);
  assert.equal(nodo.paquetes(PORT.TRACEROUTE_APP).length, 1);
  r = await orden(base, { orden: "pedir", num: -1, tipo: "env" });
  assert.equal(r.status, 400);
  r = await orden(base, { orden: "limite", num: CASETA, metrica: "temp; drop", lado: "max", valor: 1 });
  assert.equal(r.status, 400);
  r = await orden(base, { orden: "formatear" });
  assert.match(r.json.error, /orden desconocida/);
});

test("una web ajena no puede mandar órdenes ni entrar con un nombre público", async (t) => {
  const { base, puerto } = await montar(t);
  // Sin JSON (lo que puede mandar un formulario de otra web sin preguntar al navegador).
  let r = await pedir(base, "/api/orden", { metodo: "POST", cabeceras: { "content-type": "text/plain" }, cuerpo: '{"orden":"pruebaMalla"}' });
  assert.equal(r.status, 415);
  // Desde otra página.
  r = await orden(base, { orden: "ackAll" }, { origin: "https://malvada.example" });
  assert.equal(r.status, 403);
  // Desde la propia página, sí.
  r = await orden(base, { orden: "ackAll" }, { origin: `http://127.0.0.1:${puerto}` });
  assert.equal(r.status, 200);
  // Un dominio público apuntando a la red de casa (DNS rebinding): fuera.
  r = await pedir(base, "/api/estado", { cabeceras: { host: `malvada.example:${puerto}` } });
  assert.equal(r.status, 421);
  for (const host of ["bmax", "bmax.local", "bmax.tailnet-123.ts.net", "192.168.1.20", "[::1]"]) {
    r = await pedir(base, "/api/salud", { cabeceras: { host: `${host}:${puerto}` } });
    assert.equal(r.status, 200, host);
  }
});

test("sirve la app marcada para arrancar en modo «Servidor», sin salirse de su carpeta", async (t) => {
  const { base } = await montar(t);
  let r = await pedir(base, "/");
  assert.equal(r.status, 200);
  assert.match(r.cuerpo, /<head>\n<script>window\.__VIGIA_SERVIDOR = true;<\/script>/);
  r = await pedir(base, "/sw.js");
  assert.equal(r.cuerpo, "// sw");
  r = await pedir(base, "/../../../etc/passwd");
  assert.notEqual(r.status, 200);
  r = await pedir(base, "/%2e%2e/%2e%2e/etc/passwd");
  assert.notEqual(r.status, 200);
});

test("series y CSV del histórico", async (t) => {
  const { base, nodo } = await montar(t);
  nodo.ambiente(CASETA, { temperature: 18.25 });
  await hasta(async () => true);
  await new Promise((r) => setTimeout(r, 300));
  let r = await pedir(base, `/api/serie?nodo=${CASETA}&metrica=temperature&desde=0`);
  const s = JSON.parse(r.cuerpo);
  assert.equal(s.length, 1);
  assert.equal(s[0].v, 18.25);
  r = await pedir(base, "/api/lecturas.csv");
  assert.match(r.headers["content-disposition"], /attachment; filename="vigia-servidor-\d{4}-\d{2}-\d{2}\.csv"/);
  const lineas = r.cuerpo.replace(/^﻿/, "").trim().split("\n");
  assert.equal(lineas[0], "fecha;nodo;nombre;metrica;valor;unidad");
  assert.ok(lineas.some((l) => l.endsWith(`;!${CASETA.toString(16)};"Caseta huerto";temperature;18,25;°C`)));
});
