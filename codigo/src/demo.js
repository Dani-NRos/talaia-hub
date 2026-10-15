// Datos inventados para el modo demostración. Nada de esto se guarda.

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60000;
const HOUR = 60 * MIN;

export const DEMO_IDS = { recv: 0xa1b2c3d4, caseta: 0x3c6e19a2, garaje: 0x5d20b7f1, monte: 0x7e4410c8 };

export function buildDemo(now = Date.now()) {
  const rnd = prng(20261014);
  const noise = (a) => (rnd() - 0.5) * 2 * a;
  const step = 30 * MIN;
  const end = Math.floor(now / step) * step;
  const start = end - 7 * 24 * HOUR;
  const hourOf = (t) => new Date(t).getHours() + new Date(t).getMinutes() / 60;
  const daily = (t, peak = 15) => Math.cos(((hourOf(t) - peak) / 24) * 2 * Math.PI);
  const rows = [];
  const push = (node, metric, t, v) => rows.push({ node, metric, t, v: Math.round(v * 100) / 100 });

  const { recv, caseta, garaje, monte } = DEMO_IDS;
  const monteLast = now - 96 * MIN;

  for (let t = start; t <= end; t += step) {
    const day = Math.floor((t - start) / (24 * HOUR));
    // Caseta del huerto: chapa al sol, se dispara a mediodía.
    const warm = day >= 5 ? 2.5 : 0;
    push(caseta, "temperature", t, 22 + warm + 9 * daily(t) + noise(0.6));
    push(caseta, "relativeHumidity", t, 58 - 16 * daily(t) + noise(2));
    push(caseta, "barometricPressure", t, 1016 - day * 0.9 + 1.2 * Math.sin(t / (9 * HOUR)) + noise(0.3));
    push(caseta, "batteryLevel", t, 92 - 4 * ((t - start) / (7 * 24 * HOUR)) + noise(0.5));
    // Garaje: estable, con corriente.
    push(garaje, "temperature", t, 18 + 1.4 * daily(t, 17) + noise(0.3));
    push(garaje, "relativeHumidity", t, 70 - 3 * daily(t, 17) + noise(1));
    push(garaje, "batteryLevel", t, 101);
    // Nodo solar en el monte: batería que no termina de recuperarse.
    if (t <= monteLast) {
      const sun = Math.max(0, daily(t, 13.5));
      const drain = 64 - 21 * ((t - start) / (7 * 24 * HOUR));
      push(monte, "batteryLevel", t, Math.min(100, drain + 9 * sun + noise(0.8)));
      push(monte, "voltage", t, 3.62 + 0.22 * ((drain + 9 * sun) / 100) + noise(0.01));
      push(monte, "temperature", t, 13 + 7 * daily(t, 14) + noise(0.5));
    }
    push(recv, "batteryLevel", t, 101);
  }
  // Las últimas lecturas de la caseta suben por encima del umbral.
  const lastT = end;
  [[lastT - 2 * step, 33.1], [lastT - step, 34.8], [lastT, 36.4]].forEach(([t, v]) => {
    const i = rows.findIndex((r) => r.node === caseta && r.metric === "temperature" && r.t === t);
    if (i >= 0) rows[i].v = v;
  });

  const nodes = [
    { num: recv, short: "RCPT", long: "Receptor casa", hw: "HELTEC_V4", lastHeard: now, hops: 0, key: true, pos: { lat: 39.15204, lon: -0.43797, bits: 32, src: 1, t: now } },
    { num: caseta, short: "CSTA", long: "Caseta huerto", hw: "RAK4631", lastHeard: lastT, hops: 1, snr: 7.5, hasEnv: true, key: true, pos: { lat: 39.15881, lon: -0.44118, bits: 32, src: 2, t: lastT } },
    { num: garaje, short: "GARJ", long: "Garaje", hw: "HELTEC_V3", lastHeard: end, hops: 0, snr: 11, hasEnv: true, key: true, pos: { lat: 39.15031, lon: -0.43508, bits: 32, src: 1, t: end } },
    { num: monte, short: "MONT", long: "Nodo solar monte", hw: "SEEED_XIAO_S3", lastHeard: monteLast, hops: 2, snr: -9.25, hasEnv: true, key: true, pos: { lat: 39.13022, lon: -0.41264, bits: 32, src: 1, t: monteLast } },
    { num: 0x2299aa10, short: "MURT", long: "Repetidor Murta", hw: "RAK4631", lastHeard: now - 12 * MIN, hops: 2, key: true, pos: { lat: 39.11915, lon: -0.39251, bits: 15, src: 1, t: now - 12 * MIN } },
    { num: 0x44c10e7b, short: "CULL", long: "Base Cullera", hw: "TBEAM", lastHeard: now - 41 * MIN, hops: 3, hasEnv: true, key: false, pos: { lat: 39.16521, lon: -0.25473, bits: 15, src: 2, t: now - 41 * MIN } },
    { num: 0x19f3d2c6, short: "PEPE", long: "Nodo de Pepe", hw: "TLORA_V2_1_1P6", lastHeard: now - 3 * HOUR, hops: 1, key: true },
    { num: 0x0be7714d, short: "TRKR", long: "Tracker de ruta", hw: "TRACKER_T1000_E", lastHeard: now - 2 * 24 * HOUR, hops: 4, key: true, pos: { lat: 39.21043, lon: -0.51307, bits: 32, src: 2, t: now - 2 * 24 * HOUR } },
  ];
  const extraMetrics = {
    0x44c10e7b: { temperature: { v: 21.3, t: now - 41 * MIN }, relativeHumidity: { v: 66, t: now - 41 * MIN } },
    0x2299aa10: { batteryLevel: { v: 78, t: now - 12 * MIN } },
  };

  const watched = {
    [caseta]: { offlineMin: 75, rules: { temperature: { max: 35 }, relativeHumidity: { min: 25 } }, fence: { lat: 39.15881, lon: -0.44118, r: 150, at: now - 3 * 24 * HOUR } },
    [garaje]: { offlineMin: 75, rules: { temperature: { min: 3 } } },
    [monte]: { offlineMin: 75, rules: { batteryLevel: { min: 25 } } },
  };

  // Nuevas lecturas cada pocos segundos para ver el panel vivo.
  const live = { [caseta]: { temperature: 36.4, relativeHumidity: 41 }, [garaje]: { temperature: 18.6, relativeHumidity: 69 } };
  function tick() {
    const id = rnd() < 0.6 ? caseta : garaje;
    const cur = live[id];
    if (id === caseta) {
      cur.temperature += (35.2 - cur.temperature) * 0.15 + noise(0.35);
      cur.relativeHumidity += noise(1);
    } else {
      cur.temperature += (18.4 - cur.temperature) * 0.2 + noise(0.15);
      cur.relativeHumidity += noise(0.6);
    }
    const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
    return { num: id, metrics: { temperature: r(cur.temperature, 1), relativeHumidity: r(cur.relativeHumidity, 0) } };
  }

  // Respuesta simulada a «Pedir ahora»: datos tras unos segundos, o el error que daría el firmware.
  const tracker = 0x0be7714d, cullera = 0x44c10e7b;
  const noKey = new Set(nodes.filter((n) => n.key === false).map((n) => n.num));
  function reply(num, type) {
    const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
    const delay = 2500 + rnd() * 4500;
    if (num === monte || num === tracker) return { delay: 9000, error: "MAX_RETRANSMIT" };
    if (type === "info") { noKey.delete(num); return { delay: delay + 1500 }; }
    if (type === "pos") {
      const p = nodes.find((n) => n.num === num)?.pos;
      if (!p) return { delay };
      const j = p.src === 2 ? () => (rnd() - 0.5) * 0.00006 : () => 0;
      return { delay, pos: { ...p, lat: p.lat + j(), lon: p.lon + j() } };
    }
    if (noKey.has(num)) return { delay: 400, error: 39 };
    if (type === "device") {
      const base = { [caseta]: { batteryLevel: 88, voltage: 4.05 }, [garaje]: { batteryLevel: 101, voltage: 5.08 }, [recv]: { batteryLevel: 101, voltage: 5.1 } }[num]
        || { batteryLevel: Math.round(55 + rnd() * 40), voltage: r(3.7 + rnd() * 0.4, 2) };
      return { delay, metrics: { ...base, channelUtilization: r(4 + rnd() * 9), airUtilTx: r(0.5 + rnd() * 2) } };
    }
    if (type === "env" && live[num]) {
      const c = live[num];
      return { delay, metrics: { temperature: r(c.temperature + noise(0.2)), relativeHumidity: Math.round(c.relativeHumidity), barometricPressure: Math.round(1009 + rnd() * 3) } };
    }
    if (type === "env" && num === cullera) return { delay: delay + 3000, metrics: { temperature: r(21 + noise(0.6)), relativeHumidity: Math.round(64 + noise(3)) } };
    if (type === "power" && num === garaje) return { delay, metrics: { ch1Voltage: r(13.1 + noise(0.1), 2), ch1Current: Math.round(210 + noise(25)) } };
    return { delay: 1800 + rnd() * 1500, error: "NO_RESPONSE" };
  }

  return { myNode: recv, nodes, rows, watched, extraMetrics, tick, reply };
}
