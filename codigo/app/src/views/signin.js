// Signing in, over everything else: with a user name and password, or, when there are no users yet, making the first
// one with the code the installer showed (it is also in the server's journal). The session is a cookie this page's
// code never sees; once in, the page loads again with it.
import { t, getLang, setLang, LANGS } from "../i18n.js";
import { $, esc } from "../ui.js";
import { logoSVG } from "../logo.js";

const gate = () => $("#gate");
let first = false;
let docker = false; // the server runs in Docker: its commands are «docker compose exec talaia talaia …»

/** Asks the server who this screen is: { ok, nombre, sesion } | { ok: false, primero } | null (no answer). */
export async function whoAmI() {
  try {
    const r = await fetch("api/sesion", { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { docker = !!j.docker; return { ok: false, primero: !!j.primero }; }
    return r.ok ? j : null;
  } catch {
    return null;
  }
}

/** Shows the sign-in (primero: there are no users, make the first one). onLang: the page's language changed. */
export function showGate(primero, { ended = false, onLang = () => {} } = {}) {
  first = !!primero;
  const el = gate();
  document.documentElement.toggleAttribute("data-gate", true);
  el.hidden = false;
  const langs = LANGS.map((l) => `<option value="${l.code}"${l.code === getLang() ? " selected" : ""}>${l.name}</option>`).join("");
  const field = (id, label, attrs) => `<label for="${id}">${esc(label)}</label><input id="${id}" class="inp" ${attrs}>`;
  el.innerHTML = `<form class="gate-f" novalidate>
      <div class="gate-mark">${logoSVG()}<span>Talaia</span></div>
      <h1>${esc(t(first ? "gate.firstTitle" : "gate.title"))}</h1>
      ${ended && !first ? `<p class="gate-note" role="status">${esc(t("gate.ended"))}</p>` : ""}
      <p class="hint">${esc(t(first ? "gate.firstHint" : "gate.hint"))}</p>
      <div class="gate-fields">
        ${first ? field("gCode", t("gate.code"), 'autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" required') : ""}
        ${field("gName", t("gate.name"), `autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" required`)}
        ${field("gPass", t("gate.pass"), `type="password" autocomplete="${first ? "new-password" : "current-password"}" maxlength="200" required`)}
        ${first ? field("gPass2", t("gate.pass2"), 'type="password" autocomplete="new-password" maxlength="200" required') : ""}
      </div>
      <p class="form-err" id="gErr" role="alert" hidden></p>
      <button type="submit" class="btn primary gate-go">${esc(t(first ? "gate.create" : "gate.enter"))}</button>
      <p class="hint gate-help">${esc(t(first ? (docker ? "gate.firstHelpDocker" : "gate.firstHelp") : docker ? "gate.forgotDocker" : "gate.forgot"))}</p>
      <div class="gate-lang"><label for="gLang" class="vh">${esc(t("screen.lang"))}</label><select id="gLang" class="inp sel lang">${langs}</select></div>
    </form>`;
  el.querySelector("form").addEventListener("submit", submit);
  el.querySelector("#gLang").addEventListener("change", (ev) => { setLang(ev.target.value); onLang(); showGate(first, { ended, onLang }); });
  (el.querySelector("#gCode") || el.querySelector("#gName")).focus();
}

function fail(msg) {
  const e = $("#gErr");
  e.textContent = msg;
  e.hidden = false;
}

async function submit(ev) {
  ev.preventDefault();
  const v = (id) => $(`#${id}`)?.value ?? "";
  const nombre = v("gName").trim(), clave = v("gPass");
  if (!nombre || !clave || (first && !v("gCode").trim())) return fail(t("gate.missing"));
  if (first && clave !== v("gPass2")) return fail(t("gate.mismatch"));
  const btn = gate().querySelector(".gate-go");
  btn.disabled = true;
  try {
    const r = await fetch(first ? "api/primero" : "api/entrar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(first ? { codigo: v("gCode"), nombre, clave } : { nombre, clave }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) return location.reload(); // in, with the session's cookie: everything starts again
    if (r.status === 409) { showGate(false); return fail(j.error || t("gate.failed")); } // someone made the first meanwhile
    fail(j.error || t("gate.failed"));
    if (!first) { $("#gPass").value = ""; $("#gPass").focus(); }
  } catch {
    fail(t("gate.noServer"));
  } finally {
    btn.disabled = false;
  }
}
