// Draws the app icons (codigo/app/pwa/icon-*.png) from the mark in app/src/logo.js.
// Needs Playwright with Chromium (PLAYWRIGHT_DIR, by default /opt/npm-tools/node_modules/). Run: node herramientas/iconos.mjs
import path from "node:path";
import { iconSVG } from "../app/src/logo.js";

const pwDir = process.env.PLAYWRIGHT_DIR || "/opt/npm-tools/node_modules/";
const { chromium } = await import(path.join(pwDir, "playwright/index.mjs"));
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "../app/pwa");

const ICONS = [
  { file: "icon-192.png", size: 192, pad: 0.12, radius: 0.2 },
  { file: "icon-512.png", size: 512, pad: 0.12, radius: 0.2 },
  // Maskable: the launcher crops it to its own shape, so full bleed and the tower inside the safe zone (80 %).
  { file: "icon-maskable-512.png", size: 512, pad: 0.22, radius: 0 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const ic of ICONS) {
  await page.setViewportSize({ width: ic.size, height: ic.size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${iconSVG(ic)}`);
  await page.screenshot({ path: path.join(out, ic.file), omitBackground: true });
  console.log(ic.file);
}
await browser.close();
