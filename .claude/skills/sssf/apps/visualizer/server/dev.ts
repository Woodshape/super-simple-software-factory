import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { resolveDbPath } from "./db.ts";

const HOST = "127.0.0.1";
const API_PORT = 4600;
const UI_PORT = 4601;
const HEALTH_URL = `http://${HOST}:${API_PORT}/api/health`;
const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;

type Child = ReturnType<typeof Bun.spawn>;

let api: Child | null = null;
let ui: Child | null = null;
let signalExitCode: number | null = null;
let cleanupPromise: Promise<void> | null = null;

function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: HOST, port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

async function stopChild(child: Child | null): Promise<void> {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // It may have won the child-exit race and already be gone.
  }

  const result = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(STOP_TIMEOUT_MS).then(() => false),
  ]);
  if (!result) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already reaped between the timeout and kill.
    }
    await child.exited;
  }
}

function cleanup(): Promise<void> {
  if (!cleanupPromise) {
    cleanupPromise = Promise.all([stopChild(api), stopChild(ui)]).then(() => undefined);
  }
  return cleanupPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    signalExitCode = signal === "SIGINT" ? 130 : 143;
    void cleanup();
  });
}

async function waitForApiReady(child: Child): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Readiness is intentionally sequential: each attempt races the same child.
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await Promise.race([
      child.exited.then((code) => ({ kind: "exit" as const, code })),
      Bun.sleep(100).then(() => ({ kind: "poll" as const })),
    ]);
    if (outcome.kind === "exit") {
      throw new Error(`API exited before readiness (status ${outcome.code})`);
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Listener is not ready yet; continue until the finite deadline.
    }
  }
  throw new Error(`API did not become healthy at ${HEALTH_URL} within ${READY_TIMEOUT_MS}ms`);
}

async function run(): Promise<number> {
  const occupied = await Promise.all([
    portAcceptsConnections(API_PORT),
    portAcceptsConnections(UI_PORT),
  ]);
  // A signal can arrive while the asynchronous preflight sockets settle.
  // Never spawn a child after cleanup has already taken its snapshot.
  if (signalExitCode !== null) return signalExitCode;

  const collisions = [API_PORT, UI_PORT].filter((_, index) => occupied[index]);
  if (collisions.length > 0) {
    console.error(
      `[sssf] fixed port${collisions.length > 1 ? "s" : ""} ${collisions.join(", ")} already in use on ${HOST}`,
    );
    return 1;
  }

  const appDir = resolve(import.meta.dir, "..");
  const viteEntry = resolve(appDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteEntry)) {
    console.error("[sssf] Vite is not installed; run bun install first");
    return 1;
  }

  const dbPath = resolveDbPath();
  try {
    api = Bun.spawn(
      [process.execPath, "run", resolve(import.meta.dir, "index.ts"), "--db", dbPath],
      {
        cwd: appDir,
        env: { ...process.env, SSSF_DB: dbPath, PORT: String(API_PORT) },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    await waitForApiReady(api);
    if (signalExitCode !== null) throw new Error("startup interrupted");

    ui = Bun.spawn(
      [
        process.execPath,
        viteEntry,
        "--host",
        HOST,
        "--port",
        String(UI_PORT),
        "--strictPort",
      ],
      {
        cwd: appDir,
        env: process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    const first = await Promise.race([
      api.exited.then((code) => ({ name: "API", code })),
      ui.exited.then((code) => ({ name: "Vite", code })),
    ]);
    if (signalExitCode === null) {
      console.error(`[sssf] ${first.name} exited (status ${first.code}); stopping sibling`);
    }
    await cleanup();
    return signalExitCode ?? first.code;
  } catch (error) {
    if (signalExitCode === null) {
      console.error(`[sssf] startup failed: ${(error as Error).message}`);
    }
    await cleanup();
    return signalExitCode ?? 1;
  }
}

process.exitCode = await run();
