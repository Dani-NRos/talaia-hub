// Settings → Users: your account (signing out, your password, your other devices) and everyone else's. One kind of
// user (Dani, 23 Oct. 2026): everyone can do everything, adding and removing users included; the server checks it.
import { ctx } from "../ctx.js";
import { t } from "../i18n.js";
import { $, esc } from "../ui.js";
import { ago } from "@vigia/nucleo/textos.js";

const PASS_MIN = 10; // the same as the server's (usuarios.js), to say so before sending
const S = () => ctx.S;
const key = (n) => String(n ?? "").normalize("NFKC").trim().toLocaleLowerCase("es");
let passFor = null; // the user whose new password is being typed
let removeArmed = { name: null, t: 0 }; // «Remove» has to be pressed twice

function sessionRow(s, mine) {
  const here = s.id === S().me?.sesion;
  return `<li><span><b>${esc(s.aparato || t("users.device"))}</b> · ${esc(here ? t("users.thisDevice") : t("users.used", { ago: ago(s.usada) }))}</span>${here || !mine ? "" : `<button type="button" class="mini" data-ses-close="${esc(s.id)}">${esc(t("users.close"))}</button>`}</li>`;
}

function accountHTML(me) {
  const others = (me?.sesiones || []).filter((s) => s.id !== S().me?.sesion);
  return `<section class="blk"><h3>${esc(t("users.account"))}</h3>
      <div class="set-row"><span>${t("users.signedAs", { name: `<strong>${esc(S().me?.nombre || "?")}</strong>` })}</span><button type="button" class="btn ghost" data-sign-out>${esc(t("users.signOut"))}</button></div>
      <details class="mq-adv"><summary>${esc(t("users.changeOwn"))}</summary>
        <form class="mq-f" data-own-pass novalidate>
          <input type="text" class="vh" autocomplete="username" value="${esc(S().me?.nombre || "")}" tabindex="-1" aria-hidden="true">
          <label for="uCur">${esc(t("users.current"))}</label><input id="uCur" class="inp" type="password" autocomplete="current-password">
          <label for="uNew">${esc(t("users.new"))}</label><input id="uNew" class="inp" type="password" autocomplete="new-password" placeholder="${esc(t("users.passMin", { n: PASS_MIN }))}">
          <label for="uNew2">${esc(t("users.again"))}</label><input id="uNew2" class="inp" type="password" autocomplete="new-password">
        </form>
        <p class="form-err" id="uOwnErr" role="alert" hidden></p>
        <div class="btns"><button type="button" class="btn primary" data-own-save>${esc(t("users.save"))}</button></div>
        <p class="hint">${esc(t("users.changeOwnHint"))}</p>
      </details>
      <h4>${esc(t("users.otherDevices"))}</h4>
      ${others.length ? `<ul class="us-ses">${others.map((s) => sessionRow(s, true)).join("")}</ul>` : `<p class="hint">${esc(t("users.noOtherDevices"))}</p>`}
      ${others.length > 1 ? `<div class="btns"><button type="button" class="btn ghost" data-ses-others>${esc(t("users.closeOthers"))}</button></div>` : ""}
    </section>`;
}

function userHTML(u) {
  const armed = removeArmed.name === u.nombre && Date.now() - removeArmed.t < 4000;
  const last = u.usado ? t("users.lastUse", { ago: ago(u.usado) }) : t("users.neverIn");
  const n = u.sesiones.length;
  const form = passFor === u.nombre ? `<form class="mq-f us-pass" data-user-pass novalidate>
        <input type="text" class="vh" autocomplete="username" value="${esc(u.nombre)}" tabindex="-1" aria-hidden="true">
        <label for="uFor1">${esc(t("users.new"))}</label><input id="uFor1" class="inp" type="password" autocomplete="new-password" placeholder="${esc(t("users.passMin", { n: PASS_MIN }))}">
        <label for="uFor2">${esc(t("users.again"))}</label><input id="uFor2" class="inp" type="password" autocomplete="new-password">
      </form>
      <p class="form-err" id="uForErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-pass-save="${esc(u.nombre)}">${esc(t("users.save"))}</button><button type="button" class="btn ghost" data-pass-cancel>${esc(t("set.cancel"))}</button></div>
      <p class="hint">${esc(t("users.newPassHint", { name: u.nombre }))}</p>` : "";
  return `<li class="mq-b us-u">
      <div class="mq-bh"><strong>${esc(u.nombre)}</strong><span class="hint">${esc(last)}${n ? ` · ${esc(t(n === 1 ? "users.sessions1" : "users.sessions", { n }))}` : ""}</span></div>
      ${n ? `<ul class="us-ses">${u.sesiones.map((s) => sessionRow(s, false)).join("")}</ul>` : ""}
      ${form || `<div class="btns"><button type="button" class="mini" data-pass-for="${esc(u.nombre)}">${esc(t("users.newPass"))}</button>${n ? `<button type="button" class="mini" data-ses-user="${esc(u.nombre)}">${esc(t("users.closeTheirs"))}</button>` : ""}<button type="button" class="mini danger" data-user-del="${esc(u.nombre)}">${esc(t(armed ? "users.removeArm" : "users.remove"))}</button></div>`}
    </li>`;
}

export function usersTab() {
  const all = S().usuarios || [];
  const mine = all.find((u) => key(u.nombre) === key(S().me?.nombre));
  const others = all.filter((u) => u !== mine);
  return `${accountHTML(mine)}
    <section class="blk"><h3>${esc(t("users.heading"))}</h3>
      ${others.length ? `<ul class="mq-l">${others.map(userHTML).join("")}</ul>` : `<p class="hint">${esc(t("users.onlyYou"))}</p>`}
      <details class="mq-adv"${others.length ? "" : " open"}><summary>${esc(t("users.add"))}</summary>
        <form class="mq-f" data-user-new novalidate>
          <label for="uAddName">${esc(t("users.name"))}</label><input id="uAddName" class="inp" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="32">
          <label for="uAdd1">${esc(t("users.pass"))}</label><input id="uAdd1" class="inp" type="password" autocomplete="new-password" placeholder="${esc(t("users.passMin", { n: PASS_MIN }))}">
          <label for="uAdd2">${esc(t("users.again"))}</label><input id="uAdd2" class="inp" type="password" autocomplete="new-password">
        </form>
        <p class="form-err" id="uAddErr" role="alert" hidden></p>
        <div class="btns"><button type="button" class="btn primary" data-user-add>${esc(t("users.create"))}</button></div>
      </details>
      <p class="hint">${esc(t("users.hint"))}</p>
    </section>`;
}

function err(id, msg) { const e = $(`#${id}`); if (e) { e.textContent = msg; e.hidden = false; } }
/** Two password boxes that must say the same, long enough: the error, or null. */
function twoPasswords(a, b) {
  if ([...a].length < PASS_MIN) return t("users.passMin", { n: PASS_MIN });
  if (a !== b) return t("gate.mismatch");
  return null;
}

/** A button of this tab: true if it was one (rerender: the tab again). */
export async function usersClick(b, rerender) {
  const ds = b.dataset;
  const { orden, toast } = ctx;
  if ("signOut" in ds) {
    try { await fetch("api/salir", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch { /* the page reloads anyway */ }
    location.reload();
    return true;
  }
  if ("ownSave" in ds) {
    const v = (id) => $(`#${id}`).value;
    const e = !v("uCur") ? t("users.needCurrent") : twoPasswords(v("uNew"), v("uNew2"));
    if (e) { err("uOwnErr", e); return true; }
    const r = await orden({ orden: "claveUsuario", nombre: S().me.nombre, clave: v("uNew"), actual: v("uCur") });
    if (!r.ok) { err("uOwnErr", r.error || t("gate.failed")); return true; }
    toast(r.toast);
    rerender();
    return true;
  }
  if ("sesClose" in ds) { const r = await orden({ orden: "cerrarSesion", id: ds.sesClose }); toast(r.error || r.toast); return true; }
  if ("sesOthers" in ds) { const r = await orden({ orden: "cerrarSesiones", nombre: S().me.nombre }); toast(r.error || r.toast); return true; }
  if ("sesUser" in ds) { const r = await orden({ orden: "cerrarSesiones", nombre: ds.sesUser }); toast(r.error || r.toast); return true; }
  if ("passFor" in ds) { passFor = ds.passFor; rerender(); $("#uFor1")?.focus(); return true; }
  if ("passCancel" in ds) { passFor = null; rerender(); return true; }
  if ("passSave" in ds) {
    const e = twoPasswords($("#uFor1").value, $("#uFor2").value);
    if (e) { err("uForErr", e); return true; }
    const r = await orden({ orden: "claveUsuario", nombre: ds.passSave, clave: $("#uFor1").value });
    if (!r.ok) { err("uForErr", r.error || t("gate.failed")); return true; }
    passFor = null;
    toast(r.toast);
    rerender();
    return true;
  }
  if ("userDel" in ds) {
    const name = ds.userDel;
    if (removeArmed.name !== name || Date.now() - removeArmed.t > 4000) { removeArmed = { name, t: Date.now() }; b.textContent = t("users.removeArm"); return true; }
    removeArmed = { name: null, t: 0 };
    const r = await orden({ orden: "quitarUsuario", nombre: name });
    toast(r.error || r.toast);
    return true;
  }
  if ("userAdd" in ds) {
    const name = $("#uAddName").value.trim();
    if (!name) { err("uAddErr", t("users.needName")); return true; }
    const e = twoPasswords($("#uAdd1").value, $("#uAdd2").value);
    if (e) { err("uAddErr", e); return true; }
    const r = await orden({ orden: "crearUsuario", nombre: name, clave: $("#uAdd1").value });
    if (!r.ok) { err("uAddErr", r.error || t("gate.failed")); return true; }
    toast(r.toast);
    rerender();
    return true;
  }
  return false;
}
