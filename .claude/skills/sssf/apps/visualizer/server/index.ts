/** Local-only JSON API and static host for a target repository's sssf.db. */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApiRoutes, notFound } from "./app.ts";
import { SssfDb, resolveDbPath } from "./db.ts";

const PORT = Number(process.env.PORT ?? 4600);
const DIST_DIR = resolve(import.meta.dir, "..", "dist");

const dbPath = resolveDbPath();
let db: SssfDb;
try {
  db = new SssfDb(dbPath);
} catch (error) {
  console.error(`[sssf] ${(error as Error).message}`);
  process.exit(1);
}

async function serveStatic(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (!existsSync(DIST_DIR)) {
    return new Response(
      `SSSF visualizer API is running on :${PORT}.\n\nNo ./dist build found. Run "bun run dev" or "bun run build".\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const candidate = resolve(join(DIST_DIR, pathname));
  if ((candidate === DIST_DIR || candidate.startsWith(`${DIST_DIR}/`)) && existsSync(candidate) && statSync(candidate).isFile()) {
    return new Response(Bun.file(candidate));
  }
  const indexHtml = join(DIST_DIR, "index.html");
  return existsSync(indexHtml)
    ? new Response(Bun.file(indexHtml), { headers: { "content-type": "text/html; charset=utf-8" } })
    : notFound("not found");
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  reusePort: false,
  routes: createApiRoutes(db),
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) return notFound(`no route ${pathname}`);
    return serveStatic(req);
  },
});

console.log(`[sssf] visualizer api  http://127.0.0.1:${server.port}`);
console.log(`[sssf] db              ${db.path}  [journal_mode=${db.journalMode}]`);
console.log(existsSync(DIST_DIR) ? `[sssf] serving ui from  ${DIST_DIR}` : `[sssf] no ./dist — use "bun run dev" for Vite`);

let shutdownPromise: Promise<void> | null = null;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try { await server.stop(true); } finally { db.close(); }
  })();
  return shutdownPromise;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown().finally(() => process.exit(0)));
}
