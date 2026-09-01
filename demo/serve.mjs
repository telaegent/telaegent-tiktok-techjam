// Zero-dependency static host for the scripted Telaegent demo.
//
//   node demo/serve.mjs          -> http://localhost:4173
//   node demo/serve.mjs 8080     -> http://localhost:8080
//
// Binds to loopback only. Serves nothing outside this directory.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const requested = decodeURIComponent(url.pathname);
  const relative = normalize(requested === "/" ? "index.html" : requested).replace(
    /^([/\\.])+/,
    "",
  );
  const filePath = join(ROOT, relative);

  // Never serve outside the demo directory.
  if (!filePath.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type": TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    // Single-page demo: unknown paths fall back to the demo itself.
    const fallback = join(ROOT, "index.html");
    try {
      const info = await stat(fallback);
      response.writeHead(200, {
        "Content-Type": TYPES[".html"],
        "Content-Length": info.size,
        "Cache-Control": "no-store",
      });
      createReadStream(fallback).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("  Telaegent scripted demo");
  console.log("  http://localhost:" + PORT);
  console.log("");
  console.log("  Offline. No server, no database, no provider, no GitHub.");
  console.log("  Ctrl+C to stop.");
  console.log("");
});
