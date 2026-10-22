// Canales del receptor y textos para la malla: qué canal es privado y cuánto cabe en un mensaje.
import { tx } from "./idioma.js";

// Clave por defecto de Meshtastic (canales públicos) y la del canal de eventos, según Channels.h del firmware.
export const DEFAULT_PSK = [0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59, 0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01];
export const EVENT_PSK = [0x38, 0x4b, 0xbc, 0xc0, 0x1d, 0xc0, 0x22, 0xd1, 0x81, 0xbf, 0x36, 0xb8, 0x61, 0x21, 0xe1, 0xfb,
  0x96, 0xb7, 0x2e, 0x55, 0xbf, 0x74, 0x22, 0x7e, 0x9d, 0x6a, 0xfb, 0x48, 0xd6, 0x4c, 0xb1, 0xa1];

/**
 * ¿Lo puede leer cualquiera? Sin cifrar, clave por defecto (o su atajo de 1 byte), clave corta o canal de eventos.
 * `kind` says why (so each screen can say it in its language: channelWhy); `why`, in the core's language now.
 */
export function channelPrivacy(psk) {
  const k = psk ? [...psk] : [];
  const pub = (kind) => ({ private: false, kind, why: tx(`ch.${kind}`) });
  if (k.length === 0) return pub("plain");
  if (k.length === 1) return pub(k[0] === 0 ? "plain" : "default");
  if (k.length < 16) return pub("short");
  if (k.length === 16 && k.slice(0, 15).every((b, i) => b === DEFAULT_PSK[i])) return pub("default");
  if (k.length === 32 && k.every((b, i) => b === EVENT_PSK[i])) return pub("event");
  return { private: true, kind: "", why: "" };
}
/** Why a channel is public, in the current language. */
export const channelWhy = (ch) => (ch?.kind ? tx(`ch.${ch.kind}`) : ch?.why || "");

const te8 = new TextEncoder();
/** Recorta a 200 bytes (el límite práctico de un texto Meshtastic); las tildes ocupan 2. */
export function fitBytes(str, max = 200) {
  if (te8.encode(str).length <= max) return str;
  let s2 = str;
  while (s2 && te8.encode(s2 + "…").length > max) s2 = s2.slice(0, -1);
  return s2 + "…";
}
