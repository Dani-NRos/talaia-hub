// Interface language. Each screen picks its own (stored on the device); by default, the browser's.
// Texts are looked up by key; a value can be a string with {placeholders} or a function of the values.
// Sections move here as they are rewritten (step 3.3): until then, their texts are still in app.js, in Spanish.

const STORE_KEY = "talaia.lang";

const es = {
  "app.name": "Talaia",
  "nav.label": "Secciones",
  "nav.dashboard": "Tablero",
  "nav.alarms": "Alarmas",
  "nav.nodes": "Nodos",
  "nav.map": "Mapa",
  "nav.automations": "Automatizaciones",
  "nav.automations.short": "Autom.",
  "nav.automations.rail": "Automati\u00adzaciones",
  "nav.settings": "Ajustes",
  "nav.alarmsBadge": (v) => (v.n === 1 ? "1 alarma sin atender" : `${v.n} alarmas sin atender`),

  "title.alarm": (v) => `(${v.n}) Alarma · Talaia`,

  "link.noServer": "Sin conexión con el servidor",
  "link.ready": "{name} conectado",
  "link.reading": "Leyendo el nodo…",
  "link.readingN": "Leyendo el nodo · {n}",
  "link.unplugged": "Receptor desenchufado",
  "link.lost": "Receptor sin conexión",
  "link.stopped": "Receptor parado",
  "link.receiver": "Receptor",
  "link.short.noServer": "Sin servidor",
  "link.short.reading": "Leyendo…",
  "link.short.unplugged": "Desenchufado",
  "link.short.lost": "Sin receptor",
  "link.short.stopped": "Parado",
  "link.open": "Estado del servidor y su receptor",

  "auto.soon": "Llega en la 2.1",
  "auto.lead": "Reglas «si… entonces…» con lo que pasa en la malla y en tus dispositivos MQTT.",
  "auto.example": "Por ejemplo: encender un enchufe cuando llegue un mensaje por la malla, o cuando un sensor pase de un valor.",

  "screen.title": "Esta pantalla",
  "screen.lang": "Idioma",
  "screen.theme": "Tema",
  "screen.theme.auto": "Según el sistema",
  "screen.theme.light": "Día",
  "screen.theme.dark": "Guardia nocturna",
  "screen.hint": "El idioma y el tema son de cada pantalla. Lo que sale del servidor (avisos por la malla, Home Assistant y el registro) sigue en español por ahora.",
};

const en = {
  "app.name": "Talaia",
  "nav.label": "Sections",
  "nav.dashboard": "Dashboard",
  "nav.alarms": "Alarms",
  "nav.nodes": "Nodes",
  "nav.map": "Map",
  "nav.automations": "Automations",
  "nav.automations.short": "Automate",
  "nav.automations.rail": "Automa\u00adtions",
  "nav.settings": "Settings",
  "nav.alarmsBadge": (v) => (v.n === 1 ? "1 unattended alarm" : `${v.n} unattended alarms`),

  "title.alarm": (v) => `(${v.n}) Alarm · Talaia`,

  "link.noServer": "No connection to the server",
  "link.ready": "{name} connected",
  "link.reading": "Reading the node…",
  "link.readingN": "Reading the node · {n}",
  "link.unplugged": "Receiver unplugged",
  "link.lost": "Receiver disconnected",
  "link.stopped": "Receiver stopped",
  "link.receiver": "Receiver",
  "link.short.noServer": "No server",
  "link.short.reading": "Reading…",
  "link.short.unplugged": "Unplugged",
  "link.short.lost": "No receiver",
  "link.short.stopped": "Stopped",
  "link.open": "Status of the server and its receiver",

  "auto.soon": "Coming in 2.1",
  "auto.lead": "“If… then…” rules built on what happens in the mesh and on your MQTT devices.",
  "auto.example": "For example: switch a plug on when a message arrives over the mesh, or when a sensor goes past a value.",

  "screen.title": "This screen",
  "screen.lang": "Language",
  "screen.theme": "Theme",
  "screen.theme.auto": "Match the system",
  "screen.theme.light": "Day",
  "screen.theme.dark": "Night watch",
  "screen.hint": "Language and theme belong to each screen. What the server sends out (mesh alerts, Home Assistant and the log) is still in Spanish for now.",
};

const DICTS = { es, en };
export const LANGS = [
  { code: "es", name: "Español" },
  { code: "en", name: "English" },
];

/** Spanish for Spanish and the other languages of Spain; English for everything else. */
export function browserLang(list = (typeof navigator !== "undefined" && (navigator.languages || [navigator.language])) || []) {
  for (const l of list) {
    const base = String(l || "").toLowerCase().split("-")[0];
    if (["es", "ca", "eu", "gl", "ast", "an", "oc"].includes(base)) return "es";
    if (base === "en") return "en";
  }
  return "en";
}

function stored() {
  try { const v = localStorage.getItem(STORE_KEY); return DICTS[v] ? v : null; } catch { return null; }
}

let lang = stored() || browserLang();

export const getLang = () => lang;
/** Locale for numbers and dates. */
export const locale = () => (lang === "es" ? "es-ES" : "en-GB");

export function setLang(code) {
  if (!DICTS[code]) return;
  lang = code;
  try { localStorage.setItem(STORE_KEY, code); } catch { /* no storage */ }
  if (typeof document !== "undefined") document.documentElement.lang = code;
}

/** Text for `key` in the current language (Spanish if missing, the key itself as a last resort). */
export function t(key, vars = {}) {
  const v = DICTS[lang][key] ?? es[key];
  if (v == null) return key;
  if (typeof v === "function") return v(vars);
  return v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** For tests: every key of every language. */
export const _dicts = DICTS;
