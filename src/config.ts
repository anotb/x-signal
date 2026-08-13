import path from "node:path";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = path.resolve(env.XSIGNAL_DATA_DIR ?? "./data");
  return {
    version: "0.1.0-rc.5",
    port: positiveInt(env.XSIGNAL_PORT, 7345),
    dataDir,
    databasePath: path.join(dataDir, "x-signal.sqlite"),
    exportDir: path.join(dataDir, "exports"),
    browserCdpUrl: env.XSIGNAL_BROWSER_CDP_URL ?? "http://127.0.0.1:9223",
    maxBrowserConcurrency: Math.min(2, positiveInt(env.XSIGNAL_MAX_BROWSER_CONCURRENCY, 2)),
    requestSpacingMs: positiveInt(env.XSIGNAL_REQUEST_SPACING_MS, 900),
    logLevel: env.XSIGNAL_LOG_LEVEL ?? "info",
    bearerToken: env.XSIGNAL_MCP_BEARER_TOKEN?.trim() || null,
    debugTools: env.XSIGNAL_DEBUG_TOOLS === "1",
    allowPrivateMonitorSinks: env.XSIGNAL_ALLOW_PRIVATE_MONITOR_SINKS === "1",
  } as const;
}
