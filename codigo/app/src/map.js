// Map section: the latest reading of each node with a location, filtered by sensor and age.
// Leaflet va dentro de la app (sin CDN) para que abra sin internet; el fondo son teselas de OpenStreetMap.
import { map as lmap, tileLayer, marker, divIcon, latLng, latLngBounds, control, Control, DomUtil, DomEvent, layerGroup, circleMarker, circle, polyline, point } from "leaflet/dist/leaflet-src.esm.js";
import leafletCss from "leaflet/dist/leaflet.css";
import { metricMeta, fmtWithUnit, fmtNum } from "@vigia/nucleo/metrics.js";
import { precisionM, fmtDist } from "@vigia/nucleo/geo.js";
import { AGES, ageMs, metricCounts, defaultMetric, mapPoints, declutter, ageOpacity, pillText, scaleFor, inkFor } from "./mapdata.js";
import { snrQuality } from "@vigia/nucleo/route.js";
import { t, getLang } from "./i18n.js";

const SPAIN = { center: [40.0, -3.7], zoom: 6 };

/**
 * ctx: { nodes(): nodo[], myNode(): num|null, esc, ago(t), stamp(t), load(): {}, save(obj),
 *        sf(): factor de dispersión del receptor, hopName(num), legHops(leg) }
 */
export function createMapView(ctx) {
  const view = document.getElementById("v-map"); // the Map section: the map is drawn while it is showing
  const showing = () => !view.hidden;
  const box = document.getElementById("mapBox");
  const selM = document.getElementById("mapMetric");
  const selA = document.getElementById("mapAge");
  const countEl = document.getElementById("mapCount");
  const filtersEl = selM.closest(".map-f");
  const st = { metric: null, age: "24h", ...(ctx.load() || {}) };
  const markers = new Map(); // clave → { mk, html, lat, lon }
  let focusNum = null; // nodo pedido desde su ficha: se ve siempre y resaltado hasta cerrar el mapa
  let zoomedIn = false; // la vista actual es la de un nodo concreto: al abrir desde la cabecera se vuelve a ver todo
  let m = null, rings = null, guides = null, legendEl = null, emptyEl = null, offEl = null, fitted = false;
  let shown = { metric: null, points: [], others: [] };
  let route = null, routeLayer = null, routeEl = null; // ruta de un traceroute: { to, fwd, back }

  let labelled = null; // language of the texts already on the map
  /** Texts that are drawn once (controls, the age selector): again when the language changes. */
  function labels() {
    if (labelled === getLang()) return;
    labelled = getLang();
    selA.innerHTML = AGES.map((a) => `<option value="${a.key}">${ctx.esc(t(`map.age.${a.key}`))}</option>`).join("");
    selA.value = st.age;
    document.querySelector("label[for=mapMetric]").textContent = t("map.sensor");
    document.querySelector("label[for=mapAge]").textContent = t("map.age");
    if (!m) return;
    for (const [sel, key] of [[".leaflet-control-zoom-in", "map.zoomIn"], [".leaflet-control-zoom-out", "map.zoomOut"], [".map-fit", "map.fit"]]) {
      const el = box.querySelector(sel);
      if (el) { el.title = t(key); el.setAttribute("aria-label", t(key)); }
    }
    if (offEl) offEl.textContent = t("map.offline");
  }
  labels();
  const save = () => ctx.save({ metric: st.metric, age: st.age });
  selM.addEventListener("change", () => { st.metric = selM.value || null; save(); update(); });
  selA.addEventListener("change", () => { st.age = selA.value; save(); update(); });

  function ensure() {
    if (m) return;
    const css = document.createElement("style");
    css.textContent = leafletCss;
    document.head.prepend(css); // antes que los estilos de la app, para que estos manden
    m = lmap(box, { zoomControl: false, worldCopyJump: true, minZoom: 3 });
    m.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    control.zoom({ position: "topright", zoomInTitle: t("map.zoomIn"), zoomOutTitle: t("map.zoomOut") }).addTo(m);
    // crossOrigin: las teselas llegan con CORS y el service worker podrá guardarlas como respuestas normales.
    tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      crossOrigin: true,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(m);

    const Fit = Control.extend({
      onAdd() {
        const wrap = DomUtil.create("div", "leaflet-bar");
        const b = DomUtil.create("a", "map-fit", wrap);
        b.href = "#";
        b.setAttribute("role", "button");
        b.title = t("map.fit");
        b.setAttribute("aria-label", t("map.fit"));
        b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        DomEvent.disableClickPropagation(wrap);
        DomEvent.on(b, "click", (e) => { DomEvent.preventDefault(e); fit(true); });
        return wrap;
      },
    });
    new Fit({ position: "topright" }).addTo(m);

    const Legend = Control.extend({
      onAdd() {
        legendEl = DomUtil.create("div", "map-legend");
        DomEvent.disableClickPropagation(legendEl);
        return legendEl;
      },
    });
    new Legend({ position: "bottomleft" }).addTo(m);

    // Círculos de precisión en una capa propia, por debajo de las líneas y de las píldoras.
    m.createPane("precision").style.zIndex = 350;
    rings = layerGroup().addTo(m);
    guides = layerGroup().addTo(m); // punto exacto y línea de las píldoras apartadas, por debajo de todas ellas
    const Offline = Control.extend({
      onAdd() {
        offEl = DomUtil.create("div", "map-off");
        offEl.textContent = t("map.offline");
        offEl.hidden = navigator.onLine;
        return offEl;
      },
    });
    new Offline({ position: "topleft" }).addTo(m);
    // Ruta de un traceroute: por encima del fondo y los círculos, por debajo de las píldoras.
    m.createPane("route").style.zIndex = 450;
    routeLayer = layerGroup().addTo(m);
    const RouteInfo = Control.extend({
      onAdd() {
        routeEl = DomUtil.create("div", "map-route");
        routeEl.hidden = true;
        DomEvent.disableClickPropagation(routeEl);
        DomEvent.on(routeEl, "click", (e) => {
          if (!e.target.closest("[data-route-off]")) return;
          route = null;
          drawRoute();
          update();
        });
        return routeEl;
      },
    });
    new RouteInfo({ position: "topleft" }).addTo(m);
    const onNet = () => { if (offEl) offEl.hidden = navigator.onLine; };
    window.addEventListener("online", onNet);
    window.addEventListener("offline", onNet);

    m.on("zoomend viewreset", spread);
    emptyEl = DomUtil.create("div", "map-empty", box);
    emptyEl.hidden = true;
  }

  /* ── marcadores ── */
  function nodeOf(num) { return ctx.nodes().find((n) => n.num === num); }

  function popupHTML(num) {
    const { esc, ago, stamp } = ctx;
    const n = nodeOf(num);
    if (!n) return "";
    const metric = shown.metric;
    const meta = metric ? metricMeta(metric) : null;
    const p = shown.points.find((x) => x.num === num);
    let h = `<div class="mpop"><div class="mpop-h"><span class="tag sm">${esc(n.short)}</span><strong>${esc(n.long)}</strong></div>`;
    if (p) {
      h += `<p class="mpop-v">${esc(fmtWithUnit(metric, p.v))} <span>${esc(meta.label)}</span></p>`;
      h += `<p class="meta">${esc(t("map.measured", { ago: ago(p.t), stamp: stamp(p.t) }))}</p>`;
      if (p.far) h += `<p class="mpop-far">${esc(t("map.far"))}</p>`;
    } else if (meta) {
      h += `<p class="meta">${esc(t("map.noneMetric", { label: meta.label.toLowerCase() }))}</p>`;
    }
    if (n.pos) {
      const pm = precisionM(n.pos.bits);
      const prec = pm ? ` ±${fmtDist(pm)}` : n.pos.bits >= 32 ? t("map.exact") : "";
      h += `<p class="meta">${esc(t("map.location", { prec, ago: ago(n.pos.t) }))}</p>`;
    }
    h += `<button type="button" class="mini" data-open="${num}">${esc(t("map.open"))}</button></div>`;
    return h;
  }

  function place(key, lat, lon, html, z, title) {
    let it = markers.get(key);
    if (!it) {
      const mk = marker([lat, lon], { icon: divIcon({ className: "mp-w", html, iconSize: [0, 0] }), title, keyboard: true, riseOnHover: true, zIndexOffset: z });
      const num = Number(key.slice(2));
      mk.bindPopup(() => popupHTML(num), { maxWidth: 270, autoPanPadding: [16, 16], closeButton: true });
      mk.addTo(m);
      it = { mk, html, lat, lon };
      markers.set(key, it);
      return;
    }
    if (it.lat !== lat || it.lon !== lon) { it.mk.setLatLng([lat, lon]); it.lat = lat; it.lon = lon; }
    if (it.html !== html) { it.mk.setIcon(divIcon({ className: "mp-w", html, iconSize: [0, 0] })); it.html = html; }
    it.mk.setZIndexOffset(z);
    if (it.mk.options.title !== title) it.mk.options.title = title;
  }

  /* ── leyenda ── */
  function legendHTML(metric, sc, anyFar, anyRing, n) {
    if (!metric || !n) return "";
    const meta = metricMeta(metric);
    const lab = (v) => {
      const s = fmtNum(v, Math.min(meta.dec, Math.abs(sc.hi - sc.lo) < 10 ? 1 : 0));
      return meta.unit === "°C" ? `${s}°` : s;
    };
    const unit = meta.unit && meta.unit !== "°C" ? ` <span>${ctx.esc(meta.unit)}</span>` : "";
    let h = `<p class="ml-t">${ctx.esc(meta.label)}${unit}</p>`;
    if (sc.kind === "one") {
      h += `<div class="ml-one"><i style="background:${sc.stops[0]}"></i>${lab(sc.lo)}</div>`;
    } else {
      h += `<div class="ml-bar" style="background:linear-gradient(90deg,${sc.stops.join(",")})"></div>`;
      h += `<div class="ml-ticks"><span>${sc.kind === "div" ? "≤ " : ""}${lab(sc.lo)}</span>${sc.kind === "div" ? `<span>${lab(sc.mid)}</span>` : ""}<span>${sc.kind === "div" ? "≥ " : ""}${lab(sc.hi)}</span></div>`;
    }
    if (anyFar) h += `<p class="ml-far"><i></i>${ctx.esc(t("map.lg.far"))}</p>`;
    if (anyRing) h += `<p class="ml-ring"><i></i>${ctx.esc(t("map.lg.ring"))}</p>`;
    h += `<p class="ml-age">${ctx.esc(t("map.lg.age"))}</p>`;
    return h;
  }

  /* ── pintar ── */
  function update() {
    if (!m || !showing()) return;
    labels();
    if (route) return updateRoute();
    routeMode(false);
    const { esc } = ctx;
    const now = Date.now();
    const nodes = ctx.nodes();
    const maxAge = ageMs(st.age);
    const counts = metricCounts(nodes, maxAge, now);
    const metric = st.metric || defaultMetric(counts);

    // Selector: métricas con nodos en el periodo; la elegida se mantiene aunque ahora no tenga ninguno.
    const opts = [...counts];
    if (metric && !counts.has(metric)) opts.unshift([metric, 0]);
    const optHTML = opts.length
      ? opts.map(([k, c]) => `<option value="${esc(k)}"${k === metric ? " selected" : ""}>${esc(metricMeta(k).label)} (${c})</option>`).join("")
      : `<option value="">${esc(t("map.noSensors"))}</option>`;
    if (selM.dataset.h !== optHTML) { selM.innerHTML = optHTML; selM.dataset.h = optHTML; }
    selM.disabled = !opts.length;

    const { points, others } = mapPoints(nodes, metric, maxAge, now, focusNum, route ? routeNodes() : null);
    shown = { metric, points, others };
    const sc = scaleFor(metric, points.map((p) => p.v));
    const me = ctx.myNode();
    const keep = new Set();
    const byAge = [...points].sort((a, b) => a.t - b.t); // lo más reciente, encima
    byAge.forEach((p, i) => {
      const bg = sc.color(p.v);
      const html = `<div class="mp${p.far ? " far" : ""}${p.num === focusNum ? " focus" : ""}" style="--c:${bg};--i:${inkFor(bg)};opacity:${ageOpacity(now - p.t)}">${esc(pillText(metric, p.v))}</div>`;
      const n = nodeOf(p.num);
      place(`p:${p.num}`, p.lat, p.lon, html, p.num === focusNum ? 5000 : 1000 + i, `${n?.long || ""}: ${pillText(metric, p.v)}`);
      keep.add(`p:${p.num}`);
    });
    // Zona donde puede estar cada nodo cuyo canal recorta la posición (≈730 m en el canal público).
    rings.clearLayers();
    // Borde siempre oscuro (un gris neutro de 18 °C no se vería sobre el mapa); el relleno, del color del valor.
    const ring = (q, fill) => {
      if (!q.acc) return;
      circle([q.lat, q.lon], { radius: q.acc, pane: "precision", interactive: false, color: "#152320", weight: 1.5, opacity: 0.45, dashArray: "5 5", fillColor: fill, fillOpacity: 0.18 }).addTo(rings);
    };
    for (const p of points) ring(p, sc.color(p.v));
    for (const o of others) ring(o, "#66726e");
    for (const o of others) {
      const html = `<div class="md${o.num === me ? " me" : ""}${o.num === focusNum ? " focus" : ""}"></div>`;
      place(`o:${o.num}`, o.lat, o.lon, html, o.num === focusNum ? 5000 : 0, nodeOf(o.num)?.long || "");
      keep.add(`o:${o.num}`);
    }
    for (const [k, it] of markers) if (!keep.has(k)) { it.mk.remove(); markers.delete(k); }
    spread();

    countEl.textContent = points.length ? t(points.length === 1 ? "map.count1" : "map.count", { n: points.length }) : "";
    if (legendEl) {
      const h = legendHTML(metric, sc, points.some((p) => p.far), [...points, ...others].some((q) => q.acc), points.length);
      if (legendEl.dataset.h !== h) { legendEl.innerHTML = h; legendEl.dataset.h = h; }
      legendEl.hidden = !h;
    }
    const period = t(`map.age.${st.age}`).toLowerCase();
    let msg = "";
    if (!nodes.some((n) => n.pos)) msg = t("map.empty.noPos");
    else if (!metric) msg = t("map.empty.noTelemetry", { period });
    else if (!points.length) msg = t("map.empty.noMetric", { label: metricMeta(metric).label.toLowerCase(), period });
    emptyEl.textContent = msg;
    emptyEl.hidden = !msg || !!route;
    drawRoute();
  }

  /* ── ruta de un traceroute ── */
  /** Con la ruta en pantalla no hay sensor que elegir: se ocultan los filtros y el mapa recoge el hueco. */
  function routeMode(on) {
    if (!filtersEl || filtersEl.hidden === on) return;
    filtersEl.hidden = on;
    m.invalidateSize();
  }
  /**
   * Con una ruta en pantalla solo salen sus nodos, como etiquetas con su nombre corto: las lecturas del sensor
   * taparían las líneas. Al quitar la ruta (×) vuelve el mapa de sensores.
   */
  function updateRoute() {
    const { esc } = ctx;
    const me = ctx.myNode();
    const stops = [], seen = new Set();
    for (const num of [...route.fwd.nodes, ...(route.back?.nodes || [])]) {
      if (seen.has(num)) continue;
      seen.add(num);
      const n = nodeOf(num);
      if (!n?.pos) continue;
      stops.push({ num, lat: n.pos.lat, lon: n.pos.lon, t: -stops.length, acc: precisionM(n.pos.bits) });
    }
    shown = { metric: null, points: stops, others: [] };
    const keep = new Set();
    stops.forEach((q, i) => {
      const n = nodeOf(q.num);
      const cls = q.num === route.to ? " dest" : q.num === me ? " me" : "";
      place(`p:${q.num}`, q.lat, q.lon, `<div class="mp stop${cls}">${esc(n.short)}</div>`, q.num === route.to ? 5000 : 2000 - i, n.long);
      keep.add(`p:${q.num}`);
    });
    rings.clearLayers();
    for (const q of stops) {
      if (q.acc) circle([q.lat, q.lon], { radius: q.acc, pane: "precision", interactive: false, color: "#152320", weight: 1.5, opacity: 0.45, dashArray: "5 5", fillColor: "#66726e", fillOpacity: 0.12 }).addTo(rings);
    }
    for (const [k, it] of markers) if (!keep.has(k)) { it.mk.remove(); markers.delete(k); }
    countEl.textContent = t("map.route");
    routeMode(true);
    if (legendEl) legendEl.hidden = true;
    emptyEl.hidden = true;
    drawRoute();
    spread();
  }
  const routeNodes = () => new Set([...route.fwd.nodes, ...(route.back?.nodes || [])]);
  function posOf(num) {
    const p = nodeOf(num)?.pos;
    return p ? latLng(p.lat, p.lon) : null;
  }
  /** La vuelta solo se dibuja si va por otro camino que la ida. */
  const sameWay = (r) => !r.back || r.back.nodes.join() === [...r.fwd.nodes].reverse().join();
  /**
   * Une los nodos del tramo que tienen ubicación. Si entre dos hay nodos sin ubicación (o que repitieron sin
   * la clave del canal), la línea va punteada: por ahí pasó, pero no se sabe por dónde.
   */
  function drawLeg(leg, style, labels) {
    let prev = null, prevI = -1, missing = 0;
    leg.nodes.forEach((num, i) => {
      const at = posOf(num);
      if (!at) { missing++; return; }
      if (prev) {
        const gap = i - prevI > 1;
        polyline([prev, at], { pane: "route", interactive: false, ...style, ...(gap ? { dashArray: "1 9", lineCap: "round" } : {}) }).addTo(routeLayer);
        const s = leg.snr[i - 1];
        if (labels && !gap && s != null) {
          const mid = latLng((prev.lat + at.lat) / 2, (prev.lng + at.lng) / 2);
          const q = snrQuality(s, ctx.sf()) || "unk";
          const txt = `${fmtNum(s, Number.isInteger(s) ? 0 : Number.isInteger(s * 2) ? 1 : 2)} dB`;
          marker(mid, { pane: "route", interactive: false, keyboard: false, icon: divIcon({ className: "rt-lbl-w", html: `<span class="rt-lbl q-${q}">${txt}</span>`, iconSize: [0, 0] }) }).addTo(routeLayer);
        }
      }
      prev = at;
      prevI = i;
    });
    return missing;
  }
  function drawRoute() {
    if (!routeLayer) return;
    routeLayer.clearLayers();
    if (!route) { if (routeEl) routeEl.hidden = true; return; }
    const { esc } = ctx;
    const both = !sameWay(route);
    if (both) drawLeg(route.back, { color: "#7b3fa0", weight: 3, opacity: 0.85, dashArray: "9 7" }, false);
    drawLeg(route.fwd, { color: "#0d366b", weight: 4, opacity: 0.9 }, true);
    const noPos = [...routeNodes()].filter((num) => !posOf(num)).length;
    let h = `<div class="mr-h"><strong>${esc(t("map.routeTo", { name: ctx.hopName(route.to) }))}</strong><button type="button" class="mr-x" data-route-off aria-label="${esc(t("map.routeOff"))}">×</button></div>`;
    h += `<p><i class="mr-fwd"></i>${esc(t("map.fwd", { hops: ctx.legHops(route.fwd) }))}${both ? "" : route.back ? esc(t("map.backSame")) : ""}</p>`;
    if (both) h += `<p><i class="mr-back"></i>${esc(t("map.back", { hops: ctx.legHops(route.back) }))}</p>`;
    if (noPos) h += `<p class="mr-miss"><i class="mr-gap"></i>${esc(t(noPos === 1 ? "map.noPos1" : "map.noPos", { n: noPos }))}</p>`;
    if (routeEl.dataset.h !== h) { routeEl.innerHTML = h; routeEl.dataset.h = h; }
    routeEl.hidden = false;
  }
  function fitRoute() {
    const pts = [...routeNodes()].map(posOf).filter(Boolean);
    if (!pts.length) return false;
    if (pts.length === 1) m.setView(pts[0], 13, { animate: false });
    else m.fitBounds(latLngBounds(pts), { padding: [56, 56], maxZoom: 15, animate: false });
    return true;
  }

  /** Aparta las píldoras que se pisan a este zoom. La lectura más reciente se queda en su sitio. */
  function spread() {
    if (!m) return;
    const items = [];
    for (const p of [...shown.points].sort((a, b) => b.t - a.t)) {
      const root = markers.get(`p:${p.num}`)?.mk.getElement();
      const pill = root?.querySelector(".mp");
      if (!pill) continue;
      const pt = m.latLngToLayerPoint([p.lat, p.lon]);
      items.push({ key: p.num, x: pt.x, y: pt.y, w: pill.offsetWidth, h: pill.offsetHeight, root });
    }
    const offs = declutter(items);
    guides.clearLayers();
    for (const it of items) {
      const dy = offs.get(it.key) || 0;
      it.root.style.setProperty("--y", `${dy}px`);
      if (!dy) continue;
      // Apartada: línea desde donde está el nodo hasta su píldora, y un punto en el sitio exacto.
      const at = m.layerPointToLatLng(point(it.x, it.y));
      const to = m.layerPointToLatLng(point(it.x, it.y + dy));
      polyline([at, to], { color: "#152320", weight: 2, opacity: 0.55, interactive: false }).addTo(guides);
      circleMarker(at, { radius: 4, color: "#ffffff", weight: 2, fillColor: "#152320", fillOpacity: 1, interactive: false }).addTo(guides);
    }
  }

  /** Encuadra los nodos que se ven; si no hay, el receptor o la península. */
  function fit(animate = false) {
    const pts = [...shown.points, ...shown.others];
    if (pts.length) {
      const b = latLngBounds(pts.map((p) => [p.lat, p.lon]));
      m.fitBounds(b, { padding: [48, 48], maxZoom: 14, animate });
      return;
    }
    const mine = nodeOf(ctx.myNode())?.pos;
    if (mine) m.setView([mine.lat, mine.lon], 12, { animate });
    else m.setView(SPAIN.center, SPAIN.zoom, { animate });
  }

  /** Centra el mapa en un nodo (si su posición es aproximada, que quepa su círculo) y abre su globo. */
  function centerOn(num) {
    const n = nodeOf(num);
    if (!n?.pos) return false;
    const at = latLng(n.pos.lat, n.pos.lon);
    const acc = precisionM(n.pos.bits);
    if (acc) m.fitBounds(at.toBounds(acc * 2.4), { maxZoom: 15, animate: false });
    else m.setView(at, Math.max(fitted ? m.getZoom() : 0, 15), { animate: false });
    const it = markers.get(`p:${num}`) || markers.get(`o:${num}`);
    it?.mk.openPopup();
    return true;
  }

  /** focus: número de nodo para abrir el mapa centrado en él. r: ruta de un traceroute para dibujarla. */
  function open(focus = null, r = null) {
    ensure();
    m.invalidateSize();
    focusNum = focus;
    route = r;
    m.closePopup();
    update();
    if (route && fitRoute()) { fitted = true; zoomedIn = true; }
    else if (focus != null && centerOn(focus)) { fitted = true; zoomedIn = true; }
    else if (!fitted || zoomedIn) { fit(false); fitted = true; zoomedIn = false; }
    spread(); // los marcadores no existen hasta que el mapa tiene vista: se colocan ya encuadrado
    requestAnimationFrame(() => { m.invalidateSize(); spread(); });
  }

  /** Al cambiar entre demo y nodos reales: lo pintado deja de valer y hay que volver a encuadrar. */
  function reset() {
    for (const it of markers.values()) it.mk.remove();
    markers.clear();
    fitted = false;
    if (showing()) { update(); fit(false); fitted = true; spread(); }
  }

  /** On leaving the section: forget the node that was asked for and close its popup, or it would still cover the map. */
  function leave() { focusNum = null; route = null; drawRoute(); m?.closePopup(); }

  return { open, update, reset, leave };
}
