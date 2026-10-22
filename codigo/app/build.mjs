// Builds the screen the server serves, from index.src.html, into codigo/dist/app/:
// a self-contained index.html, plus sw.js, the manifest and the icons so it can be installed as an app.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(root, "..", "dist"); // codigo/dist, como antes de separar app y núcleo
const app = path.join(out, "app");
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });

const res = await build({
  entryPoints: [path.join(root, "src/app.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome105"],
  minify: true,
  write: false,
  legalComments: "none",
  loader: { ".css": "text" }, // Leaflet's stylesheet goes in as text and is added when the map opens
  alias: {
    os: path.join(root, "src/shims/os.js"),
    path: path.join(root, "src/shims/path.js"),
    util: path.join(root, "src/shims/util.js"),
  },
  // The core's engine decodes protobuf with @meshtastic/core, which expects a bit of Node.
  banner: { js: 'var process = globalThis.process || { env: {}, cwd: function () { return ""; } };' },
  logLevel: "warning",
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const src = fs.readFileSync(path.join(root, "index.src.html"), "utf8");

// title, links and style go to <head>
const headBits = [];
let body = src
  .replace(/<title>[\s\S]*?<\/title>\n?/, (m) => (headBits.push(m.trim()), ""))
  .replace(/<meta name="claude:[^>]*>\n?/, "")
  .replace(/<link [^>]*>\n?/g, (m) => (headBits.push(m.trim()), ""))
  .replace(/<style>[\s\S]*?<\/style>\n?/, (m) => (headBits.push(m.trim()), ""));
body = body.replace("<!--APP-->", () => `<script>${js}</script>`);
const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#e9eeec" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1513" media="(prefers-color-scheme: dark)">
<meta name="description" content="Vigilancia 24/7 de una malla Meshtastic y dispositivos MQTT, en tu red.">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="./icon-192.png">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
${headBits.join("\n")}
</head>
<body>
${body}
</body>
</html>
`;
fs.writeFileSync(path.join(app, "index.html"), html);

const version = Date.now().toString(36);
fs.writeFileSync(path.join(app, "sw.js"), fs.readFileSync(path.join(root, "pwa/sw.js"), "utf8").replace("__VERSION__", version));
// What the server serves next to the page so it can be installed as an app (over https, e.g. with Tailscale).
for (const f of ["manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
  fs.copyFileSync(path.join(root, "pwa", f), path.join(app, f));
}
console.log(`JS ${(js.length / 1024).toFixed(0)} KB · PWA ${(html.length / 1024).toFixed(0)} KB · versión ${version}`);
