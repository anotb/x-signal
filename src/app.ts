import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { safeLog } from "./redaction.js";
import { toXSignalError } from "./errors.js";
import { SessionSyncRequestSchema } from "./session.js";
import { XService } from "./service.js";

const config = loadConfig();
const service = new XService(config);
service.start();
const startedAt = Date.now();
let requests = 0;
let mcpRequests = 0;
let mcpErrors = 0;
let sessionSyncAttempts = 0;
let sessionSyncApplied = 0;
let sessionSyncFailures = 0;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
app.use((req, res, next) => {
  requests += 1;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));

const companionCors = cors({
  origin(origin, callback) {
    if (origin && /^chrome-extension:\/\/[a-p]{32}$/i.test(origin)) callback(null, true);
    else callback(new Error("Chrome companion origin is required"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-X-Signal-Companion"],
});

app.options("/setup/session-sync", companionCors);
app.post("/setup/session-sync", companionCors, async (req, res) => {
  sessionSyncAttempts += 1;
  if (req.get("x-x-signal-companion") !== "1") {
    sessionSyncFailures += 1;
    res.status(400).json({ error: "INVALID_COMPANION_REQUEST" });
    return;
  }
  const parsed = SessionSyncRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sessionSyncFailures += 1;
    res.status(400).json({ error: "INVALID_SESSION_SYNC" });
    return;
  }
  try {
    const result = await service.syncSession(parsed.data.cookies, parsed.data.source, parsed.data.activate ?? false);
    if (result.applied) sessionSyncApplied += 1;
    res.json({
      status: result.inactive ? "inactive" : result.deferred ? "deferred" : result.applied ? "applied" : "unchanged",
      cookieCount: result.cookieCount,
      authenticated: result.identity.authenticated,
      handle: result.identity.handle,
      activeSource: result.activeSource,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    sessionSyncFailures += 1;
    const converted = toXSignalError(error);
    safeLog("session_sync_failed", { code: converted.code, message: converted.message });
    res.status(converted.code === "CAPABILITY_UNAVAILABLE" ? 409 : 503).json({
      error: converted.code,
      remediation: converted.code === "CAPABILITY_UNAVAILABLE" ? converted.message : "Keep X signed in in Chrome; the companion will retry automatically.",
    });
  }
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)$/i.test(origin) || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin)) callback(null, true);
    else callback(new Error("Origin is not allowed"));
  },
  exposedHeaders: ["Mcp-Session-Id"],
}));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", version: config.version, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
});

app.get("/readyz", async (_req, res) => {
  try {
    const browserUrl = new URL(config.browserCdpUrl);
    browserUrl.hostname = (await lookup(browserUrl.hostname, { family: 4 })).address;
    browserUrl.pathname = `${browserUrl.pathname.replace(/\/$/, "")}/json/version`;
    const response = await fetch(browserUrl, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error(`browser HTTP ${response.status}`);
    res.json({ status: "ready", browser: "reachable", database: "ready" });
  } catch {
    res.status(503).json({ status: "not_ready", browser: "unreachable", remediation: "Inspect `docker compose ps` and browser logs." });
  }
});

app.get("/metrics", (_req, res) => {
  const activeRuns = service.store.listActiveRuns().length;
  const monitors = service.store.listMonitors();
  res.type("text/plain; version=0.0.4").send([
    "# HELP xsignal_uptime_seconds Process uptime.",
    "# TYPE xsignal_uptime_seconds gauge",
    `xsignal_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
    "# HELP xsignal_http_requests_total HTTP requests handled.",
    "# TYPE xsignal_http_requests_total counter",
    `xsignal_http_requests_total ${requests}`,
    "# HELP xsignal_mcp_requests_total MCP requests handled.",
    "# TYPE xsignal_mcp_requests_total counter",
    `xsignal_mcp_requests_total ${mcpRequests}`,
    "# HELP xsignal_mcp_errors_total MCP transport failures.",
    "# TYPE xsignal_mcp_errors_total counter",
    `xsignal_mcp_errors_total ${mcpErrors}`,
    "# HELP xsignal_session_sync_attempts_total Chrome companion session sync attempts.",
    "# TYPE xsignal_session_sync_attempts_total counter",
    `xsignal_session_sync_attempts_total ${sessionSyncAttempts}`,
    "# TYPE xsignal_session_sync_applied_total counter",
    `xsignal_session_sync_applied_total ${sessionSyncApplied}`,
    "# TYPE xsignal_session_sync_failures_total counter",
    `xsignal_session_sync_failures_total ${sessionSyncFailures}`,
    "# TYPE xsignal_active_runs gauge",
    `xsignal_active_runs ${activeRuns}`,
    "# TYPE xsignal_active_monitors gauge",
    `xsignal_active_monitors ${monitors.filter((monitor) => monitor.state === "active").length}`,
    "",
  ].join("\n"));
});

app.get("/exports/:id", authorize, (req, res) => {
  try {
    const exported = service.getExport(String(req.params.id ?? ""));
    res.type(exported.mimeType).setHeader("Content-Disposition", `attachment; filename="${exported.filename}"`).send(exported.content);
  } catch {
    res.status(404).json({ error: "NOT_FOUND" });
  }
});

app.all("/mcp", authorize, async (req, res) => {
  mcpRequests += 1;
  const rpcMethod = typeof req.body === "object" && req.body !== null && typeof (req.body as { method?: unknown }).method === "string"
    ? (req.body as { method: string }).method
    : req.method === "GET" ? "stream-open" : "unknown";
  safeLog("mcp_request", { method: rpcMethod });
  const server = createMcpServer(service);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    mcpErrors += 1;
    safeLog("mcp_transport_error", { message: error instanceof Error ? error.message : "unknown" });
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: "BAD_REQUEST" });
});

const listener = app.listen(config.port, "0.0.0.0", () => {
  safeLog("server_ready", { port: config.port, mcp: "/mcp", apiKeyRequired: false, bearerProtection: config.bearerToken !== null });
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  safeLog("server_closing", { signal });
  listener.close(() => {
    service.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function authorize(req: Request, res: Response, next: NextFunction): void {
  if (!config.bearerToken) {
    next();
    return;
  }
  const supplied = req.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBuffer = Buffer.from(config.bearerToken);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="x-signal"');
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }
  next();
}
