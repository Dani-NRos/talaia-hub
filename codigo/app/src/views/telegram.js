// Settings → Telegram: the bot's token (never shown back), on or off, the pairing code for a chat or a group, the
// paired chats and a test message. The server does the rest (servidor/src/telegram.js).
import { ctx } from "../ctx.js";
import { t } from "../i18n.js";
import { $, esc } from "../ui.js";
import { stamp } from "@talaia/nucleo/textos.js";

const S = () => ctx.S;
let tokenDraft = null; // typed and not saved yet

export function telegramHTML() {
  const tg = S().telegram || { on: false, hasToken: false, bot: null, chats: [], code: null, state: "off", error: null };
  const state = tg.state === "ok" ? `<span class="okt">${esc(t("set.tg.stateOk", { bot: tg.bot ? `@${tg.bot}` : "" }))}</span>`
    : tg.state === "error" ? `<span class="warn-t">${esc(t("set.tg.stateError", { e: tg.error || "" }))}</span>`
    : esc(t(tg.hasToken ? "set.tg.stateOff" : "set.tg.stateNoToken"));
  const chats = tg.chats.length
    ? `<ul class="mq-us tg-l">${tg.chats.map((c) => `<li><span>${esc(c.name)} <small>· ${esc(t(c.kind === "group" ? "set.tg.group" : "set.tg.private"))} · ${esc(t("set.tg.since", { when: stamp(c.since) }))}</small></span><button type="button" class="mini" data-tg-del="${c.id}">${esc(t("pc.remove"))}</button></li>`).join("")}</ul>`
    : `<p class="hint">${esc(t("set.tg.noChats"))}</p>`;
  const pairing = tg.hasToken
    ? `<h4>${esc(t("set.tg.pair"))}</h4>
      <p class="hint">${esc(t("set.tg.pairHow", { bot: tg.bot ? `@${tg.bot}` : t("set.tg.theBot") }))}</p>
      <div class="set-row tg-code"><code class="tg-c" id="tgCode">${esc(tg.code || "—")}</code><button type="button" class="mini" data-tg-code>${esc(t("set.tg.newCode"))}</button></div>
      <h4>${esc(t("set.tg.chats"))}</h4>
      ${chats}
      <div class="btns"><button type="button" class="btn ghost" data-tg-test${tg.on && tg.chats.length ? "" : " disabled"}>${esc(t("set.tg.test"))}</button></div>`
    : "";
  return `<section class="blk" id="tgBox"><h3>Telegram</h3>
      <p class="hint">${esc(t("set.tg.lead"))}</p>
      <div class="set-row"><label class="sw" for="tgOn"><input type="checkbox" id="tgOn"${tg.on ? " checked" : ""}${tg.hasToken ? "" : " disabled"}><span class="sw-ui"></span><span>${esc(t("set.tg.on"))}</span></label></div>
      <p class="hint" id="tgState">${state}</p>
      <div class="mq-f">
        <label for="tgToken">${esc(t("set.tg.token"))}</label><input id="tgToken" class="inp" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(tg.hasToken ? t("set.tg.tokenKept") : "123456789:AAH…")}" value="${esc(tokenDraft ?? "")}">
      </div>
      <p class="form-err" id="tgErr" role="alert" hidden></p>
      <div class="btns"><button type="button" class="btn primary" data-tg-save>${esc(t("set.tg.saveToken"))}</button>${tg.hasToken ? `<button type="button" class="btn ghost" data-tg-notoken>${esc(t("set.tg.removeToken"))}</button>` : ""}</div>
      <p class="hint">${esc(t("set.tg.tokenHint"))}</p>
      ${pairing}
      <p class="hint">${esc(t("set.tg.hint"))}</p>
    </section>`;
}

/** A button of this block: true if it was one. */
export async function telegramClick(b, redraw) {
  const ds = b.dataset, { orden, toast } = ctx;
  const err = (msg) => { const e = $("#tgErr"); if (e) { e.textContent = msg; e.hidden = false; } };
  if ("tgSave" in ds) {
    const token = ($("#tgToken")?.value || "").trim();
    if (!token) return err(t("set.tg.e.empty")), true;
    const r = await orden({ orden: "telegram", cambio: { token, on: true } });
    if (!r.ok) return err(r.error), true;
    tokenDraft = null;
    toast(r.toast);
    redraw();
    return true;
  }
  if ("tgNotoken" in ds) {
    const r = await orden({ orden: "telegram", cambio: { token: null } });
    if (!r.ok) return err(r.error), true;
    tokenDraft = null;
    toast(r.toast);
    redraw();
    return true;
  }
  if ("tgCode" in ds) {
    const r = await orden({ orden: "telegramCode" });
    if (r.ok) { const c = $("#tgCode"); if (c) c.textContent = r.code; }
    return true;
  }
  if ("tgDel" in ds) {
    const r = await orden({ orden: "telegramRemoveChat", id: Number(ds.tgDel) });
    toast(r.error || r.toast);
    return true;
  }
  if ("tgTest" in ds) {
    const r = await orden({ orden: "telegramTest" });
    toast(r.error || r.toast);
    return true;
  }
  return false;
}
/** A change in this block: true if it was one. */
export async function telegramChange(el) {
  const { orden, toast } = ctx;
  if (el.id === "tgOn") {
    const r = await orden({ orden: "telegram", cambio: { on: el.checked } });
    if (!r.ok) el.checked = !el.checked;
    toast(r.error || r.toast);
    return true;
  }
  return telegramInput(el);
}
export function telegramInput(el) {
  if (el.id !== "tgToken") return false;
  tokenDraft = el.value;
  return true;
}
