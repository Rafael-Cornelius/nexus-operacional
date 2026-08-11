import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.cwd(), "apps/web/out");
const rootPrefix = `${root}${sep}`;
const basePath = "/nexus-operacional";
const port = Number(process.env.PAGES_PREVIEW_PORT ?? 4173);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function reply(response, statusCode, body) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname,
    );
    if (pathname === basePath) {
      response.writeHead(308, { location: `${basePath}/` });
      response.end();
      return;
    }
    if (!pathname.startsWith(`${basePath}/`)) {
      reply(response, 404, "Not found");
      return;
    }

    const relativePath = pathname.slice(basePath.length).replace(/^\/+/, "");
    let filePath = resolve(root, relativePath || "index.html");
    if (filePath !== root && !filePath.startsWith(rootPrefix)) {
      reply(response, 400, "Invalid path");
      return;
    }

    let fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = resolve(filePath, "index.html");
      if (!filePath.startsWith(rootPrefix)) {
        reply(response, 400, "Invalid path");
        return;
      }
      fileStat = await stat(filePath);
    }
    if (!fileStat.isFile()) {
      reply(response, 404, "Not found");
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": String(fileStat.size),
      "content-type": mimeTypes.get(extname(filePath)) ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    reply(response, code === "ENOENT" ? 404 : 500, code === "ENOENT" ? "Not found" : "Server error");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Pages preview ready at http://127.0.0.1:${port}${basePath}/\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
