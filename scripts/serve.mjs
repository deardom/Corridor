// Tiny static server for running the web app locally: npm start, then open http://localhost:8080
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8" };
const port = Number(process.env.PORT) || 8080;

createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  if (path === "/" || path === "\\") path = "/index.html";
  try {
    let body = await readFile(join(root, path));
    if (path === "/index.html" && !body.toString("utf8", 0, 20).toLowerCase().startsWith("<!doctype")) body = Buffer.from("<!doctype html><html lang=\"en\"><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>" + body.toString("utf8") + "</body></html>");
    res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(port, () => console.log(`Corridor running at http://localhost:${port}`));
