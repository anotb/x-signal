import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { XService } from "./service.js";

const service = new XService(loadConfig());
const server = createMcpServer(service);
service.start();
await server.connect(new StdioServerTransport());

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close().catch(() => undefined);
  service.close();
}
process.on("SIGINT", () => void close().finally(() => process.exit(0)));
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
