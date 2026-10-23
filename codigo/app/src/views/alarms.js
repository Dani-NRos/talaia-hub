// Alarms: the same notice as the dashboard (active alarms, with Acknowledge) and the log of what has happened.
// The log's texts are written by the server, in its language (step 3.4); what a person did carries their name.
import { ctx } from "../ctx.js";
import { t } from "../i18n.js";
import { $, esc, setHTML } from "../ui.js";
import { stamp } from "@talaia/nucleo/textos.js";

const PAGE = 30;

export function renderLog() {
  const { S } = ctx;
  $("#h-log").textContent = t("log.heading");
  const list = S.logExpanded ? S.log : S.log.slice(0, PAGE);
  setHTML($("#log"), list.length
    ? list.map((e) => `<li class="lg lg-${e.type}"><time>${esc(stamp(e.t))}</time><span>${esc(e.text)}${e.by ? ` <em class="lg-by">· ${esc(e.by)}</em>` : ""}</span></li>`).join("")
    : `<li class="empty-row">${esc(t("log.empty"))}</li>`);
  const more = $("#logMore");
  more.hidden = S.log.length <= PAGE;
  more.textContent = S.logExpanded ? t("log.less") : t("log.all", { n: S.log.length });
}
