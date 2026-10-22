// Language of the texts the core writes: times, metric names, alarms, requests. Spanish by default.
// The screen sets the viewer's language; the server will set its own (step 3.4), for what it sends out
// (mesh alerts, Home Assistant, the log). Number and date formats follow it too.

let LANG = "es";
const listeners = new Set();

export const LANGUAGES = ["es", "en"];
export const getLanguage = () => LANG;
/** Locale for Intl: decimal comma and 24 h in Spanish; decimal point and 24 h in (British) English. */
export const localeOf = (l = LANG) => (l === "en" ? "en-GB" : "es-ES");

export function setLanguage(l) {
  if (!LANGUAGES.includes(l) || l === LANG) return;
  LANG = l;
  for (const f of listeners) f(l);
}
/** Called after every change of language (to rebuild what was built with the old one). */
export function onLanguage(f) { listeners.add(f); return () => listeners.delete(f); }

const es = {
  // times
  "t.min": "{n} min",
  "t.h": "{h} h",
  "t.hmin": "{h} h {m} min",
  "t.day": "1 día",
  "t.days": "{n} días",
  "t.never": "nunca",
  "t.now": "ahora mismo",
  "t.ago": "hace {d}",
  "t.lastMin": "en los últimos {n} min",
  "t.lastHour": "en la última hora",
  "t.lastHours": "en las últimas {h} horas",
  "t.drops": "baja",
  "t.rises": "sube",

  // alarms: titles, details and what the log says when they end
  "al.link": "Receptor desconectado",
  "al.test": "Alarma de prueba",
  "al.offline": "{name} · Sin señal más de {d}",
  "al.offlineData": "{name} · Sin datos más de {d}",
  "al.moved": "{name} · Fuera de su sitio",
  "al.conexion": "{name} · Sin conexión",
  "al.estado": "{name} · {label}: {state}",
  "al.estadoFor": "{name} · {label}: {state} más de {d}",
  "al.trendDown": "{name} · {label} bajando rápido (−{change} en {d})",
  "al.trendUp": "{name} · {label} subiendo rápido (+{change} en {d})",
  "al.high": "{name} · {label} por encima de {limit}",
  "al.low": "{name} · {label} por debajo de {limit}",
  "al.d.link.serial": "Reintentando la conexión por cable. Las alarmas de nodo sin señal quedan en pausa.",
  "al.d.link.tcp": "Reintentando la conexión por la red. Las alarmas de nodo sin señal quedan en pausa.",
  "al.d.link.ble": "Reintentando la conexión Bluetooth. Las alarmas de nodo sin señal quedan en pausa.",
  "al.d.test": "Así suena y se ve un aviso. Pulsa Enterado para callarlo.",
  "al.d.offline": "Último dato {ago} ({stamp}).",
  "al.d.conexion": "El dispositivo dice que se ha desconectado ({stamp}).",
  "al.d.estado": "{state} desde {stamp}.",
  "al.d.moved": "Está a {dist}{dir} de su sitio (valla de {fence}). Posición de las {time}.",
  "al.d.movedDir": " al {dir}",
  "al.d.trend": "De {from} a las {fromT} a {to} a las {toT}. Avisa si {verb} {limit} o más en {hours}.",
  "al.d.value": "Ahora {value}.",
  "al.c.link": "Receptor conectado de nuevo",
  "al.c.test": "Alarma de prueba cerrada",
  "al.c.offline": "{name} · Vuelve a dar señal",
  "al.c.offlineData": "{name} · Vuelven a llegar datos",
  "al.c.moved": "{name} · De vuelta en su sitio",
  "al.c.movedAt": "{name} · De vuelta en su sitio (a {dist})",
  "al.c.conexion": "{name} · Conectado otra vez",
  "al.c.estado": "{name} · {label}: {state}",
  "al.c.estadoAfter": "{name} · {label}: {state} (tras {d})",
  "al.c.estadoOff": "ya no avisa",
  "al.c.trend": "{name} · {label} ya no {verb} tan rápido",
  "al.c.trendAt": "{name} · {label} ya no {verb} tan rápido ({value})",
  "al.c.range": "{name} · {label} de vuelta en rango",
  "al.c.rangeAt": "{name} · {label} de vuelta en rango ({value})",
  "al.late": " (recibida al reconectar)",
  "al.ack": "Enterado: {title}",

  // requests to a node
  "ask.env": "Ambiente",
  "ask.env.what": "Temperatura, humedad y presión",
  "ask.device": "Batería",
  "ask.device.what": "Batería, tensión y uso del canal",
  "ask.air": "Aire",
  "ask.air.what": "CO₂ y partículas",
  "ask.power": "Energía",
  "ask.power.what": "Tensión y corriente de los canales INA",
  "ask.info": "Ficha",
  "ask.pos": "Posición",
  "ask.route": "Ruta",
  "ask.f.noResponse": "el nodo contesta que no tiene ese sensor",
  "ask.f.maxRetransmit": "no llegó al nodo tras varios intentos",
  "ask.f.noRoute": "no hay ruta hasta el nodo",
  "ask.f.noChannel": "el receptor no tiene el canal de ese nodo",
  "ask.f.noPubkey": "tu receptor no tiene la clave de este nodo, pide su ficha",
  "ask.f.unknownPubkey": "el nodo no tiene la clave de tu receptor, pedir su ficha se la envía",
  "ask.f.pkiFailed": "fallo de cifrado con ese nodo, pedir su ficha suele arreglarlo",
  "ask.f.dutyCycle": "el receptor ha agotado su tiempo de emisión, prueba en unos minutos",
  "ask.f.rateLimit": "límite de uso del canal alcanzado, prueba en unos minutos",
  "ask.f.rejected": "el nodo rechazó la petición",
  "ask.f.infoAcked": "el nodo la recibió y ya tiene la clave de tu receptor, pero no contestó: no repite su ficha a quien se la pidió en las últimas 12 h, ni si acaba de anunciarla",
  "ask.f.posAcked": "el nodo la recibió pero no contestó; como mucho repite su posición cada 3 min",
  "ask.f.acked": "el nodo la recibió pero no mandó datos",
  "ask.f.infoTimeout": "sin respuesta en {s} s. Aunque no conteste, si le llegó ya tiene la clave de tu receptor: vuelve a pedirle los datos",
  "ask.f.routeTimeout": "sin respuesta en {s} s: el nodo está fuera de alcance, apagado, más lejos que el límite de saltos de tu receptor{hops} o en otro canal; o la respuesta se perdió por el camino",
  "ask.f.timeout": "sin respuesta en {s} s",
  "ask.f.throttled": "tu receptor solo lanza un traceroute cada 30 s; espera un poco y repite",
  "ask.f.notice": "el receptor no la envió: {why}",
  "ask.f.noticeNone": "sin motivo",
  "ask.f.send": "no se pudo enviar al receptor",
  "ask.f.error": "error {code}",

  // compass (from the fence to the node)
  "geo.rose": "N NE E SE S SO O NO",

  // names of ON/OFF states (MQTT data)
  "st.encendido": "Encendido|Apagado",
  "st.abierta": "Abierta|Cerrada",
  "st.abierto": "Abierto|Cerrado",
  "st.agua": "Hay agua|Seco",
  "st.movimiento": "Movimiento|Sin movimiento",
  "st.si": "Sí|No",
  "st.on": "ON|OFF",
};

const en = {
  "t.min": "{n} min",
  "t.h": "{h} h",
  "t.hmin": "{h} h {m} min",
  "t.day": "1 day",
  "t.days": "{n} days",
  "t.never": "never",
  "t.now": "just now",
  "t.ago": "{d} ago",
  "t.lastMin": "in the last {n} min",
  "t.lastHour": "in the last hour",
  "t.lastHours": "in the last {h} hours",
  "t.drops": "drops",
  "t.rises": "rises",

  "al.link": "Receiver disconnected",
  "al.test": "Test alarm",
  "al.offline": "{name} · No signal for over {d}",
  "al.offlineData": "{name} · No data for over {d}",
  "al.moved": "{name} · Out of place",
  "al.conexion": "{name} · Disconnected",
  "al.estado": "{name} · {label}: {state}",
  "al.estadoFor": "{name} · {label}: {state} for over {d}",
  "al.trendDown": "{name} · {label} falling fast (−{change} in {d})",
  "al.trendUp": "{name} · {label} rising fast (+{change} in {d})",
  "al.high": "{name} · {label} above {limit}",
  "al.low": "{name} · {label} below {limit}",
  "al.d.link.serial": "Retrying the cable connection. No-signal alarms are paused.",
  "al.d.link.tcp": "Retrying the network connection. No-signal alarms are paused.",
  "al.d.link.ble": "Retrying the Bluetooth connection. No-signal alarms are paused.",
  "al.d.test": "This is how an alert sounds and looks. Press Acknowledge to silence it.",
  "al.d.offline": "Last data {ago} ({stamp}).",
  "al.d.conexion": "The device says it has disconnected ({stamp}).",
  "al.d.estado": "{state} since {stamp}.",
  "al.d.moved": "It is {dist}{dir} from its place (fence of {fence}). Position at {time}.",
  "al.d.movedDir": " to the {dir}",
  "al.d.trend": "From {from} at {fromT} to {to} at {toT}. Warns if it {verb} {limit} or more in {hours}.",
  "al.d.value": "Now {value}.",
  "al.c.link": "Receiver connected again",
  "al.c.test": "Test alarm closed",
  "al.c.offline": "{name} · Signal again",
  "al.c.offlineData": "{name} · Data arriving again",
  "al.c.moved": "{name} · Back in its place",
  "al.c.movedAt": "{name} · Back in its place ({dist} away)",
  "al.c.conexion": "{name} · Connected again",
  "al.c.estado": "{name} · {label}: {state}",
  "al.c.estadoAfter": "{name} · {label}: {state} (after {d})",
  "al.c.estadoOff": "no longer warns",
  "al.c.trend": "{name} · {label} no longer {verb} so fast",
  "al.c.trendAt": "{name} · {label} no longer {verb} so fast ({value})",
  "al.c.range": "{name} · {label} back in range",
  "al.c.rangeAt": "{name} · {label} back in range ({value})",
  "al.late": " (received on reconnecting)",
  "al.ack": "Acknowledged: {title}",

  "ask.env": "Environment",
  "ask.env.what": "Temperature, humidity and pressure",
  "ask.device": "Battery",
  "ask.device.what": "Battery, voltage and channel use",
  "ask.air": "Air",
  "ask.air.what": "CO₂ and particles",
  "ask.power": "Power",
  "ask.power.what": "Voltage and current of the INA channels",
  "ask.info": "Node info",
  "ask.pos": "Position",
  "ask.route": "Route",
  "ask.f.noResponse": "the node answers that it has no such sensor",
  "ask.f.maxRetransmit": "it did not reach the node after several tries",
  "ask.f.noRoute": "there is no route to the node",
  "ask.f.noChannel": "the receiver does not have that node's channel",
  "ask.f.noPubkey": "your receiver does not have this node's key: ask for its node info",
  "ask.f.unknownPubkey": "the node does not have your receiver's key; asking for its node info sends it",
  "ask.f.pkiFailed": "encryption failed with that node; asking for its node info usually fixes it",
  "ask.f.dutyCycle": "the receiver has used up its airtime; try again in a few minutes",
  "ask.f.rateLimit": "channel use limit reached; try again in a few minutes",
  "ask.f.rejected": "the node rejected the request",
  "ask.f.infoAcked": "the node got it and now has your receiver's key, but did not answer: it does not repeat its node info to whoever asked in the last 12 h, nor if it has just announced it",
  "ask.f.posAcked": "the node got it but did not answer; it repeats its position every 3 min at most",
  "ask.f.acked": "the node got it but sent no data",
  "ask.f.infoTimeout": "no answer in {s} s. Even without an answer, if it got there it now has your receiver's key: ask for the data again",
  "ask.f.routeTimeout": "no answer in {s} s: the node is out of range, off, further than your receiver's hop limit{hops} or on another channel; or the answer got lost on the way",
  "ask.f.timeout": "no answer in {s} s",
  "ask.f.throttled": "your receiver only sends one traceroute every 30 s; wait a little and try again",
  "ask.f.notice": "the receiver did not send it: {why}",
  "ask.f.noticeNone": "no reason given",
  "ask.f.send": "it could not be sent to the receiver",
  "ask.f.error": "error {code}",

  "geo.rose": "N NE E SE S SW W NW",

  "st.encendido": "On|Off",
  "st.abierta": "Open|Closed",
  "st.abierto": "Open|Closed",
  "st.agua": "Water|Dry",
  "st.movimiento": "Motion|No motion",
  "st.si": "Yes|No",
  "st.on": "ON|OFF",
};

const DICTS = { es, en };

/** Core text for `key` in the current language, with {values} filled in. */
export function tx(key, vars = {}) {
  const v = DICTS[LANG][key] ?? es[key];
  if (v == null) return key;
  return v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** For tests: both dictionaries. */
export const _textDicts = DICTS;
