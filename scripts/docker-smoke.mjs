import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.env.XSIGNAL_BASE_URL || "http://127.0.0.1:7345";
const checks = await Promise.all(["/healthz", "/readyz", "/metrics"].map(async (path) => {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return path;
}));
const client = new Client({ name: "x-signal-docker-smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
try {
  const tools = await client.listTools();
  const status = await client.callTool({ name: "x_status", arguments: { liveProbe: false } });
  if (status.isError) throw new Error("x_status returned a tool error");
  if (!tools.tools.some((tool) => tool.name === "x_search")) throw new Error("x_search was not advertised");
  process.stdout.write(`${JSON.stringify({ checks, tools: tools.tools.length, status: "ok" })}\n`);
} finally {
  await client.close();
}
