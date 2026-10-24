import { registrarMetricas } from "@talaia/nucleo/metrics.js";
import { createMapView } from "./map.js";
import { ctx } from "./ctx.js";
import { sparkHTML, sparkStateHTML } from "./charts.js";
import { $, esc, setHTML, LS, ICON, renameStored } from "./ui.js";
import { refreshPosition, copyText, patchSwitches, setFence, setFenceRadius, removeFence, toggleSwitch } from "./views/node-parts.js";
import { renderNodes, onNodesQuery, saveNodesView } from "./views/nodes.js";
import { renderLog } from "./views/alarms.js";
import { boardHTML, renderCards, toggleCard, toggleAllCards, moveCard, watchCardsWidth } from "./views/dashboard.js";
import { openSheet, onSheetClose, renderSheet, drawCharts, refreshSheetLive, refreshRequests, patchRequestStatus, legHops, setSheetRange, resizeSheet, trendFormFill, addTrend, removeTrend, saveStateAlarm, saveRuleFromInput, watch, unwatch, isSheetOpen } from "./views/sheet.js";
import { patchPanels, data, meshOut, newPanelSheet, createPanel } from "./views/panel-config.js";
import { openFull, closeFull, refreshFull, setFullRange, resizeFull } from "./views/fullscreen.js";
import { loraSf } from "@talaia/nucleo/route.js";
import { FILTERS } from "./meshsearch.js";
import { conectarServidor, crearStoreRemoto } from "./remoto.js";
import { whoAmI, showGate } from "./views/signin.js";
import { t as tr, getLang } from "./i18n.js";
import { initShell, go, isView, setAlarms, relabel } from "./shell.js";
import { initSettings, openSettings, enterSettings, renderSettings, patchSettings, patchMeshLast, pushDiag } from "./views/settings.js";
import { initAlerts, fireAlarm, applyWake, setServiceWorker } from "./alerts.js";
import { initAutomations, renderAutomations } from "./views/automations.js";
import { HOUR, ago, stamp } from "@talaia/nucleo/textos.js";
import { metasDe } from "@talaia/nucleo/mqtt-datos.js";
import { crearMotor, estadoInicial, askKey, seriesKey } from "@talaia/nucleo/motor.js";

/* ───────────── estado ───────────── */
const DEFAULT_SETTINGS = { sound: true, wake: false, retentionDays: 30, defaultOfflineMin: 75, mesh: null };
// Lo que comparte con el servidor (nodos, alarmas, peticiones…) lo define el núcleo; aquí se añade lo de pantalla.
const S = {
  ...estadoInicial(),
  settings: { ...DEFAULT_SETTINGS },
  trouble: null, // último fallo de conexión clasificado
  diag: [],
  meshExpanded: false,
  ui: { collapsed: {}, order: [] }, // tarjetas vigiladas: contraídas y orden elegido (se guardan aparte de las alarmas)
  ordering: false, // modo «Ordenar» de las tarjetas
  full: null, // nodo abierto a pantalla completa: { num, range }
  meshQ: "", // texto del buscador de «Resto de la malla» (no se guarda)
  meshView: { filters: [], sort: "auto" }, // filtros y orden del buscador (se guardan)
  logExpanded: false,
  detail: null, // { num, range }
  servidorOk: false, // modo «Servidor»: hay conexión con él
  me: null, // who this screen is signed in as: { nombre, sesion } (the start of its session's id)
  usuarios: [], // the server's users and their sessions (Settings → Users)
};
let mapView = null; // se crea al abrir el mapa por primera vez

/* ───────────── motor (núcleo común con el servidor) ───────────── */
const motor = crearMotor(S, {
  cambio: () => render(),
  lectura(num) { if (S.detail && S.detail.num === num) refreshSheetLive(); refreshFull(num); },
  posicion: (num) => refreshPosition(num),
  peticion: (num) => refreshRequests(num),
  peticionEstado: (num) => patchRequestStatus(num),
  ruta() { if (mapView && isView("map")) mapView.update(); },
  avisoMalla: () => patchMeshLast(),
  registro: () => renderLog(),
  alarma: (al) => fireAlarm(al),
  toast: (msg) => toast(msg),
  diag: (e) => pushDiag(e),
  // El servidor lo guarda todo; aquí solo los ajustes de este aparato (sonido, pantalla encendida).
  guardar: (k) => { if (k === "settings") saveSettings(); },
  // El servidor tiene la radio: las peticiones le llegan como órdenes (askUI), nunca salen de aquí.
  radio: { listo: () => S.servidorOk },
});
const { ack, unacked, hopName } = motor;
let servidor = null; // modo «Servidor»: la conexión con él
const orden = (datos) => servidor.orden(datos);
Object.assign(ctx, { S, motor, orden, toast: (m) => toast(m), render: () => render(), sparkHTML, sparkStateHTML });

/* ───────────── persistencia: solo lo de este aparato ───────────── */
function saveSettings() { LS.set("talaia.settings", S.settings); }

function showErr(el, msg) { el.textContent = msg; el.hidden = false; }

// Solo se reescribe el texto de estado cada segundo, para no robar toques a los botones.
setInterval(() => {
  const waiting = new Set([...S.req.values()].filter((r) => r.state === "wait").map((r) => r.num));
  for (const num of waiting) patchRequestStatus(num);
}, 1000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    applyWake();
    render();
  }
});

/* ───────────── render ───────────── */
let raf = 0;
function render() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderTop();
    renderBoard();
    renderCards();
    renderNodes();
    renderLog();
    renderAutomations();
    if (isView("map")) mapView?.update();
    if (S.full) refreshFull(null);
    setAlarms(unacked().length);
  });
}


/** Barra de arriba: primero, si hay conexión con el servidor; después, cómo está su receptor. */
function renderTop() {
  const b = $("#linkBtn");
  const st = !S.servidorOk ? "noserver" : S.link.state;
  // On a phone the short label leaves room for the section's name.
  let label, short;
  const name = S.nodes.get(S.myNode)?.short || tr("link.receiver");
  if (!S.servidorOk) [label, short] = [tr("link.noServer"), tr("link.short.noServer")];
  else if (st === "ready") [label, short] = [tr("link.ready", { name }), name];
  else if (st === "configuring") [label, short] = [S.link.extra?.packets ? tr("link.readingN", { n: S.link.extra.packets }) : tr("link.reading"), tr("link.short.reading")];
  else if (st === "reconnecting" || st === "connecting") [label, short] = S.trouble?.kind === "unplugged" ? [tr("link.unplugged"), tr("link.short.unplugged")] : [tr("link.lost"), tr("link.short.lost")];
  else [label, short] = [tr("link.stopped"), tr("link.short.stopped")];
  b.dataset.state = st;
  b.setAttribute("aria-label", label);
  setHTML(b, `<span class="ld"></span>${ICON.server}<span class="lt">${esc(label)}</span><span class="lt-s" aria-hidden="true">${esc(short)}</span>`);
}

function renderBoard() {
  const html = boardHTML();
  setHTML($("#board"), html);
  setHTML($("#alarmBoard"), html);
}

/* ───────────── tarjetas de los nodos vigilados ───────────── */



/* ───────────── resto de la malla y buscador ───────────── */






/* ───────────── mapa ───────────── */
let persistAsked = false;
let mapWanted = null; // what the Map section has to show when it opens: { focus, route }
/** focus: nodo en el que centrar el mapa (desde su tarjeta o su ficha). route: { to, fwd, back } de un traceroute. */
function openMap(focus = null, route = null) {
  if ($("#detail").open) $("#detail").close();
  if ($("#nodeview").open) $("#nodeview").close();
  mapWanted = { focus, route };
  go("map");
}
function enterMap() {
  // Que el navegador no vacíe el fondo guardado cuando el móvil vaya justo de espacio.
  if (!persistAsked) { persistAsked = true; navigator.storage?.persist?.().catch(() => {}); }
  if (!mapView) {
    mapView = createMapView({
      nodes: () => [...S.nodes.values()].filter((n) => n.num >= 0).map((n) => (n.alias ? { ...n, long: n.alias } : n)),
      myNode: () => S.myNode,
      esc, ago, stamp,
      sf: () => loraSf(S.lora),
      hopName, legHops,
      load: () => LS.get("talaia.map", {}),
      save: (v) => LS.set("talaia.map", v),
    });
  }
  const w = mapWanted || { focus: null, route: null };
  mapWanted = null;
  mapView.open(w.focus, w.route);
}

/* ───────────── Enterado y peticiones: van al servidor ───────────── */
function ackUI(key) {
  if (key === "test") return ack(key); // la alarma de prueba es solo de este aparato
  orden({ orden: "ack", key });
}
function ackAllUI() {
  if (S.active.has("test")) ack("test");
  orden({ orden: "ackAll" });
}
async function askUI(num, type) {
  const r = await orden({ orden: "pedir", num, tipo: type });
  if (r.toast || r.error) toast(r.toast || r.error);
}

/* ───────────── toast ───────────── */
let toastT = null;
function toast(msg) {
  if (!msg) return;
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove("show");
  void t.offsetWidth;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.classList.remove("show"); setTimeout(() => { t.hidden = true; }, 250); }, 3600);
}

/* ───────────── eventos ───────────── */
let unwatchArmed = 0;
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("a, button, [data-open], [data-close]");
  if (t?.tagName === "A") return; // enlaces (Google Maps, GitHub) van a lo suyo
  if (!t) {
    const dlg = ev.target.closest("dialog");
    if (dlg && ev.target === dlg) dlg.close();
    return;
  }
  const ds = t.dataset;
  if ("ask" in ds) return askUI(Number(ds.num), ds.ask);
  if ("mapFocus" in ds) return openMap(Number(ds.mapFocus));
  if ("cardToggle" in ds) return toggleCard(Number(ds.cardToggle));
  if ("cardsAll" in ds) return toggleAllCards();
  if ("order" in ds) { S.ordering = true; renderCards(); return $("#cards .ord-row [data-move]")?.focus(); }
  if ("orderDone" in ds) { S.ordering = false; renderCards(); return toast(tr("dash.orderSaved")); }
  if ("move" in ds) return moveCard(Number(ds.move), Number(ds.dir));
  if ("full" in ds) return openFull(Number(ds.full));
  if ("fullRange" in ds) return setFullRange(ds.fullRange);
  if ("routeMap" in ds) { const num = Number(ds.routeMap); return S.traces[num] && openMap(num, { to: num, ...S.traces[num] }); }
  if ("copy" in ds) return copyText(ds.copy, t);
  if ("fenceSet" in ds) return setFence(Number(ds.fenceSet));
  if ("fenceDel" in ds) return removeFence(Number(ds.fenceDel));
  if ("trendAdd" in ds) return addTrend(Number(ds.trendAdd));
  if ("trendDel" in ds) return S.detail && removeTrend(S.detail.num, ds.trendDel);
  if ("ack" in ds) return ackUI(ds.ack);
  if ("ackall" in ds) return ackAllUI();
  if ("watch" in ds) return watch(Number(ds.watch));
  if ("close" in ds) return t.closest("dialog")?.close();
  if ("retry" in ds) return orden({ orden: "reconectar" });
  if ("diag" in ds) { openSettings("receiver"); setTimeout(() => $("#diagBox")?.scrollIntoView({ block: "start" }), 80); return; }
  if ("orden" in ds) return toggleSwitch(Number(ds.num), ds.orden);
  if ("panelNuevo" in ds) return newPanelSheet();
  if ("panelCrear" in ds) return createPanel(openSheet);
  if ("panelQuitar" in ds) {
    if (Date.now() - unwatchArmed > 4000) { unwatchArmed = Date.now(); t.textContent = tr("sheet.removeArm"); return; }
    unwatchArmed = 0;
    const r = await orden({ orden: "quitarPanel", num: Number(ds.panelQuitar) });
    if (!r.ok) return toast(r.error);
    $("#detail").close();
    return toast(r.toast);
  }
  if ("pnNombre" in ds) {
    const r = await orden({ orden: "renombrar", num: Number(ds.pnNombre), nombre: $("#pnNombre").value });
    if (!r.ok) return showErr($("#pnErr"), r.error);
    $("#pnErr").hidden = true;
    return toast(r.toast);
  }
  if (S.detail && ("datAdd" in ds || "datDel" in ds || "datUsar" in ds || "datBuscar" in ds || "datSave" in ds || "conUsar" in ds)) {
    const num = S.detail.num;
    if ("conUsar" in ds) return data.useConn(num, Number(ds.conUsar));
    if ("datSave" in ds) return data.save(num);
    if ("datBuscar" in ds) return data.find(t, num);
    if ("datUsar" in ds) return data.use(num, Number(ds.datUsar));
    if ("datDel" in ds) return data.remove(num, Number(ds.datDel));
    return data.add(num);
  }
  if ("mallaSave" in ds) return meshOut.save();
  if ("mallaSend" in ds) { const r = await orden({ orden: "enviarMalla" }); return toast(r.error || r.toast); }
  if ("unwatch" in ds) {
    if (Date.now() - unwatchArmed > 4000) { unwatchArmed = Date.now(); t.textContent = tr("sheet.unwatchArm"); return; }
    unwatchArmed = 0;
    await unwatch(Number(ds.unwatch));
    if (isSheetOpen()) { renderSheet(); drawCharts(); }
    return;
  }
  if ("range" in ds) return setSheetRange(ds.range);
  if (t.id === "linkBtn") return openSettings("receiver");
  if (t.id === "meshMore") { S.meshExpanded = !S.meshExpanded; return renderNodes(); }
  if ("mf" in ds) {
    const f = new Set(S.meshView.filters);
    if (f.has(ds.mf)) f.delete(ds.mf); else f.add(ds.mf);
    S.meshView.filters = FILTERS.map((x) => x.key).filter((k) => f.has(k));
    S.meshExpanded = false;
    saveNodesView();
    return renderNodes();
  }
  if ("meshClear" in ds) {
    S.meshQ = "";
    $("#meshQ").value = "";
    S.meshView.filters = [];
    saveNodesView();
    renderNodes();
    return $("#meshQ").focus();
  }
  if (t.id === "logMore") { S.logExpanded = !S.logExpanded; return renderLog(); }
  if ("open" in ds) return openSheet(Number(ds.open));
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.target.id === "pnNombre" || ev.target.id === "npNombre")) {
    ev.preventDefault(); // Intro guarda el nombre (o crea el panel)
    $(ev.target.id === "pnNombre" ? "[data-pn-nombre]" : "[data-panel-crear]")?.click();
    return;
  }
  // «/» lleva al buscador, salvo escribiendo en otra casilla o con una ficha abierta.
  // «/» lleva al buscador de Nodos desde cualquier sección.
  if (ev.key === "/" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.target.closest?.("input, textarea, select, [contenteditable]") && !document.querySelector("dialog[open]") && !$("#meshTools").hidden) {
    ev.preventDefault();
    if (!isView("nodes")) go("nodes");
    setTimeout(() => $("#meshQ").focus(), 0);
    return;
  }
  if (ev.key === "Escape" && ev.target.id === "meshQ") {
    if (ev.target.value) { ev.preventDefault(); ev.target.value = ""; onNodesQuery(""); } else ev.target.blur();
    return;
  }
  if (ev.key === "Enter" && ev.target.id === "meshQ") {
    // Intro abre el primer resultado.
    ev.preventDefault();
    onNodesQuery(ev.target.value, true);
    const first = $("#mesh .row-main");
    if (first && S.meshQ.trim()) openSheet(Number(first.dataset.open));
    return;
  }
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.(".card[data-open]")) { ev.preventDefault(); openSheet(Number(ev.target.dataset.open)); }
  if (ev.key === "Enter" && ev.target.closest?.(".tr-form") && ev.target.matches("input")) { ev.preventDefault(); return S.detail && addTrend(S.detail.num); }
  if (ev.key === "Enter" && ev.target.matches?.("#detail .inp")) ev.target.blur();
});

document.addEventListener("input", (ev) => {
  if (ev.target.id === "meshQ") onNodesQuery(ev.target.value);
  if (ev.target.id === "filtroTemas") return S.detail && data.filter(ev.target.value, S.detail.num);
  if (S.detail && ev.target.closest?.("#conBox") && ev.target.matches("input:not([type=checkbox])[data-con-k]")) data.changeConn(S.detail.num, ev.target);
  if (S.detail && ev.target.closest?.("#datBox") && ev.target.matches("input:not([type=checkbox])[data-dat-k]")) data.change(S.detail.num, ev.target);
});

document.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (t.closest?.("#conBox")) return S.detail && t.dataset.conK && data.changeConn(S.detail.num, t);
  if (t.closest?.("#datBox")) return S.detail && t.dataset.datK && data.change(S.detail.num, t);
  if (t.closest?.("#mallaBox")) return meshOut.change(t);
  if (t.closest?.("#nomBox")) {
    if (t.id !== "pnTipo" || !S.detail) return; // el nombre se guarda con su botón
    const r = await orden({ orden: "tipoPanel", num: S.detail.num, tipo: t.value });
    return toast(r.ok ? tr("sheet.saved") : r.error);
  }
  if (t.id === "npTipo" || t.id === "npNombre") return;
  if (t.id === "meshSort") { S.meshView.sort = t.value; S.meshExpanded = false; saveNodesView(); return renderNodes(); }
  if (t.id === "fence-r") return S.detail && setFenceRadius(S.detail.num, t);
  if (t.id === "tr-metric") return trendFormFill();
  if (t.closest(".tr-form")) return; // se guarda con el botón
  if (t.matches("[data-est-cuando], [data-est-min]")) return saveStateAlarm(t);
  if (t.matches("#detail .inp")) return saveRuleFromInput(t);
});

$("#nodeview").addEventListener("close", closeFull);
$("#detail").addEventListener("close", () => { onSheetClose(); unwatchArmed = 0; });
// On rotating the phone or resizing, the charts are redrawn at the new size.
window.addEventListener("resize", () => { resizeFull(); resizeSheet(); });

/* ───────────── estado del servidor ───────────── */
/** Lecturas nuevas del servidor: a las series de las últimas 26 h, como hace el motor al recibirlas. */
function anadirReciente(r) {
  const key = seriesKey(r.node, r.metric);
  const arr = S.recent.get(key) || [];
  const i = arr.findIndex((p) => p.t === r.t);
  if (i >= 0) arr[i] = { t: r.t, v: r.v }; // ya venía en la foto
  else arr.push({ t: r.t, v: r.v });
  if (arr.length > 1 && arr[arr.length - 2].t > r.t) arr.sort((a, b) => a.t - b.t);
  while (arr.length && arr[0].t < Date.now() - 26 * HOUR) arr.shift();
  S.recent.set(key, arr);
}
function aplicarPartes(p) {
  if ("cfg" in p) S.cfg = p.cfg;
  if ("active" in p) {
    const prueba = S.active.get("test"); // la alarma de prueba es solo de este aparato
    S.active = new Map(p.active.map((a) => [a.key, a]));
    if (prueba) S.active.set("test", prueba);
  }
  for (const k of ["log", "channels", "myNode", "myUser", "lora", "traces", "meshLast", "link", "device", "trouble", "diag", "mqtt", "usuarios", "automations", "meshOrders"]) if (k in p) S[k] = p[k];
  if ("paneles" in p) {
    S.paneles = p.paneles;
    registrarMetricas(metasDe(S.paneles?.paneles)); // los datos MQTT, como métricas con su nombre y su unidad
  }
  if ("req" in p) S.req = new Map(p.req.map((r) => [askKey(r.num, r.type), r]));
  if ("settings" in p) Object.assign(S.settings, p.settings); // sonido y pantalla encendida siguen siendo de este aparato
  if ("recent" in p) S.recent = new Map(Object.entries(p.recent));
  if (p.nodes) for (const n of p.nodes) S.nodes.set(n.num, n);
  if (p.rows) for (const r of p.rows) anadirReciente(r);
}
/** Refresca lo que esté abierto según lo que haya cambiado, sin pisar lo que se esté escribiendo. */
function refrescarAbiertos(p) {
  const escribiendo = (sel) => document.activeElement?.matches?.(sel);
  const num = S.detail?.num;
  if (num != null && $("#detail").open) {
    if (("cfg" in p || "active" in p || "traces" in p) && !escribiendo("#detail input, #detail select")) { renderSheet(); drawCharts(); }
    else if (p.nodes?.some((n) => n.num === num) && Object.keys(S.nodes.get(num)?.metrics || {}).some((k) => !$(`#detail [data-cur="${k}"]`)) && !escribiendo("#detail input, #detail select")) {
      renderSheet(); // a new metric (its first datum): its row of limits and its chart
      drawCharts();
    } else {
      if (p.nodes?.some((n) => n.num === num) || p.rows?.some((r) => r.node === num)) refreshSheetLive();
      if ("req" in p || "traces" in p) { refreshRequests(num); refreshPosition(num); }
    }
    if ("paneles" in p || "mqtt" in p || "channels" in p) patchPanels(); // values, names of the brokers, channels
  }
  if (S.full && (p.nodes || p.rows || "active" in p)) refreshFull(S.full.num);
  if ((S.detail || S.full) && ("paneles" in p || p.nodes)) patchSwitches();
  if (isView("settings")) {
    patchSettings(p);
  }
  if (mapView && isView("map") && (p.nodes || "traces" in p)) mapView.update();
}
/** Entering a section: the map is drawn when it shows; Settings, with what it has now. */
function enterView(view, { sub } = {}) {
  if (view === "map") enterMap();
  else if (view === "settings") enterSettings(sub);
  else if (view === "automations") renderAutomations();
}
function leaveView(view) {
  if (view === "map") mapView?.leave();
}

/** The session has ended (signed out here or elsewhere, the password changed, the user removed): back to signing in. */
function salida(primero) {
  for (const d of ["#detail", "#nodeview"]) if ($(d).open) $(d).close();
  // Nothing of the server's stays to warn about: no alarm sound behind the sign-in, with no way to acknowledge it.
  S.active = new Map();
  setAlarms(0);
  showGate(primero, { ended: true, onLang: () => { document.documentElement.lang = getLang(); } });
}

async function boot() {
  document.documentElement.lang = getLang();
  initAutomations();
  initAlerts();
  initSettings({
    languageChanged() {
      registrarMetricas(metasDe(S.paneles?.paneles)); // names of the MQTT data and of their states, in the new language
      relabel(); render();
    },
    saveDeviceSettings: saveSettings,
  });
  initShell({ enter: enterView, leave: leaveView });
  renameStored(["settings", "cards", "meshView", "map"].map((k) => [`vigia.${k}`, `talaia.${k}`]));
  S.settings = { ...DEFAULT_SETTINGS, ...LS.get("talaia.settings", {}) };
  S.ui = { collapsed: {}, order: [], ...(LS.get("talaia.cards", {}) || {}) };
  S.meshView = { filters: [], sort: "auto", ...(LS.get("talaia.meshView", {}) || {}) };
  S.link = { state: "connecting", extra: null };
  watchCardsWidth();
  render();
  // Who is this screen? Without a session, only the sign-in (there is nothing to see without one).
  const yo = await whoAmI();
  if (yo && !yo.ok) return showGate(yo.primero, { onLang: () => { document.documentElement.lang = getLang(); } });
  if (yo?.ok) S.me = { nombre: yo.nombre, sesion: yo.sesion };
  servidor = conectarServidor({
    onSalida: salida,
    onConexion(ok) {
      if (ok === S.servidorOk) return;
      S.servidorOk = ok;
      if (!ok) pushDiag({ t: Date.now(), msg: tr("diag.noServer") });
      render();
      if (isView("settings")) renderSettings();
    },
    onEstado(foto) {
      if (!S.me) whoAmI().then((r) => { if (r?.ok) { S.me = { nombre: r.nombre, sesion: r.sesion }; if (isView("settings")) renderSettings(); } });
      S.nodes = new Map(foto.nodes.map((n) => [n.num, n]));
      aplicarPartes({ ...foto, nodes: null });
      render();
      refrescarAbiertos(foto);
    },
    onCambio(p) {
      aplicarPartes(p);
      render();
      refrescarAbiertos(p);
    },
    onAlarma({ al }) { if (!al.acked) fireAlarm(al); },
  });
  S.store = crearStoreRemoto(orden);
  applyWake();
  // Service worker y notificaciones solo con https (Tailscale); por http en la red de casa, el navegador no los deja.
  if (window.isSecureContext && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").then(setServiceWorker).catch(() => {});
  }
  setInterval(render, 15000); // «hace X min»
}

boot();
