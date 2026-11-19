// Serves app/ui (or another copy of it, for a capture of an older version) on 127.0.0.1 with the
// app's own CSP, and slips the harness's stub in before the page's scripts. Nothing of the app
// runs: no Tauri, no hub, no plugin copy.
//
//   node app/harness/serve.mjs [--ui <dir>] [--port <n>]   (prints the URL, Ctrl+C stops)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json" };
const csp = JSON.parse(fs.readFileSync(path.join(here, "..", "src-tauri", "tauri.conf.json"), "utf8")).app.security.csp;
const STUB = '<script src="/__harness/fixtures.js"></script><script src="/__harness/stub.js"></script>';

/** Starts the server; resolves to { url, close } */
export function serve({ ui = path.join(here, "..", "ui"), port = 0 } = {}) {
  const root = path.resolve(ui);
  /** One request: 400 for a URL that does not parse, 404 for no such file, 500 for a read that fails */
  const handle = (req, res) => {
    let url;
    let decoded;
    try {
      url = new URL(req.url, "http://x");
      decoded = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // The browser asks for one; the app's WebView never does
    if (decoded === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    const own = decoded.startsWith("/__harness/");
    const base = own ? here : root;
    const rel = own ? decoded.slice("/__harness/".length) : decoded === "/" ? "index.html" : decoded.slice(1);
    const file = path.resolve(base, rel);
    let body;
    try {
      if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
      body = fs.readFileSync(file);
    } catch (error) {
      res.writeHead(error.code === "ENOENT" || error.code === "ENOTDIR" ? 404 : 500).end();
      return;
    }
    if (file.endsWith(".html") && !own) body = Buffer.from(body.toString("utf8").replace(/<head>/, `<head>${STUB}`));
    // The harness's own page of controls gets the app's stylesheets, in index.html's order
    if (file.endsWith(".html") && own) {
      const links = fs.readFileSync(path.join(root, "index.html"), "utf8").match(/<link rel="stylesheet" href="[^"]+">/g) ?? [];
      body = Buffer.from(body.toString("utf8").replace("<!-- stylesheets -->", `${STUB}${links.map((l) => l.replace('href="', 'href="/')).join("")}`));
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "content-security-policy": csp, "cache-control": "no-store" });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      // Whatever else throws answers 500; the server keeps serving
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    // A port in use (--port) rejects instead of throwing out of the event loop
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const { port: bound } = server.address();
      resolve({ url: `http://127.0.0.1:${bound}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const { url } = await serve({ ui: arg("--ui"), port: Number(arg("--port") ?? 0) });
  console.log(url);
}
