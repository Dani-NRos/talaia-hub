// How this screen warns: the alarm sound (repeated while there are unattended alarms), vibration, the system
// notification, and keeping the screen on. All of it belongs to this device (Settings → This screen).
import { ctx } from "./ctx.js";
import { t } from "./i18n.js";

let audio = null;
/** Browsers only let a page play sound after a tap or a key: the audio starts with the first one. */
export function unlockAudio() {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { /* no audio */ }
}

export function beep() {
  if (!audio || audio.state !== "running") return;
  const t0 = audio.currentTime;
  [[880, 0], [660, 0.2], [880, 0.4]].forEach(([f, d]) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "square";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + d);
    g.gain.exponentialRampToValueAtTime(0.16, t0 + d + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.17);
    o.connect(g).connect(audio.destination);
    o.start(t0 + d);
    o.stop(t0 + d + 0.18);
  });
}

let swReg = null;
export function setServiceWorker(reg) { swReg = reg; }

async function notify(al) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = ctx.motor.alarmTitle(al), body = ctx.motor.alarmDetail(al);
  try {
    const reg = swReg || (navigator.serviceWorker && (await navigator.serviceWorker.getRegistration()));
    if (reg) { await reg.showNotification(title, { body, tag: al.key, renotify: true, requireInteraction: true, icon: "./icon-192.png", badge: "./icon-192.png" }); return; }
  } catch { /* goes on */ }
  try { new Notification(title, { body, tag: al.key }); } catch { /* Android requires a service worker */ }
}

/** A new alarm: vibration, sound and notification. */
export function fireAlarm(al) {
  try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.([300, 150, 300, 150, 700]); } catch { /* no vibration */ }
  if (ctx.S.settings.sound) beep();
  notify(al);
}

/** What the browser allows with notifications here: granted, default (can ask), denied, http (needs https), none. */
export const notificationState = () => (!("Notification" in window) ? "none" : !window.isSecureContext ? "http" : Notification.permission);

let wakeLock = null;
/** Keeps the screen on (or lets it go off) as this device's setting says. */
export async function applyWake() {
  if (!ctx.S.settings.wake) {
    try { await wakeLock?.release(); } catch { /* already released */ }
    wakeLock = null;
    return;
  }
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    ctx.toast(t("screen.wakeFailed"));
  }
}

/** The audio starts with the first tap; the sound repeats every 2.5 s while there are unattended alarms. */
export function initAlerts() {
  document.addEventListener("pointerdown", unlockAudio, { capture: true });
  document.addEventListener("keydown", unlockAudio, { capture: true });
  setInterval(() => { if (ctx.S.settings.sound && ctx.motor.unacked().length) beep(); }, 2500);
}
