import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XService } from "../src/service.js";
import { fixturePost, testConfig } from "./helpers.js";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable monitor delivery", () => {
  it("does not advance the baseline after a failed delivery and resumes without repeating X work", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.statusCode = requests === 1 ? 500 : 204;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not expose a port");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-monitor-delivery-"));
    dirs.push(dir);
    const service = new XService({ ...testConfig(dir), allowPrivateMonitorSinks: true });
    vi.spyOn(service.browser, "probeIdentity").mockResolvedValue({ connected: true, authenticated: true, handle: "fixture", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    const search = vi.spyOn(service.browser, "search").mockResolvedValue({
      posts: [fixturePost("monitor")],
      nextCursor: null,
      warnings: [],
      operation: { name: "SearchTimeline", queryId: "fixture", method: "GET", path: "/fixture", sourcePage: "/search", lens: "latest", capturedAt: new Date().toISOString(), parserVersion: 1, replayed: false, variableKeys: [], featureKeys: [], fieldToggleKeys: [] },
    });
    const created = await service.monitor("create", { definition: {
      name: "delivery",
      queries: [{ query: "monitor", mode: "latest", limit: 1 }],
      cadence: { type: "interval", everyMinutes: 60 },
      sink: `http://127.0.0.1:${address.port}/hook`,
    } }) as { monitor: { id: string } };

    const first = await service.monitor("run", { id: created.monitor.id }) as { pending?: string };
    expect(first.pending).toBe("delivery-retry");
    expect(service.store.getMonitor(created.monitor.id)).toMatchObject({ lastRunId: null, executionStage: "delivering" });
    service.store.db.prepare("UPDATE deliveries SET next_attempt_at=?").run("2000-01-01T00:00:00.000Z");

    const second = await service.monitor("run", { id: created.monitor.id }) as { pending?: string };
    expect(second.pending).toBeUndefined();
    expect(service.store.getMonitor(created.monitor.id)).toMatchObject({ activeRunId: null, executionStage: "idle" });
    expect(service.store.getMonitor(created.monitor.id).lastRunId).toBeTruthy();
    expect(search).toHaveBeenCalledTimes(1);
    expect(requests).toBe(2);
    service.close();
  });
});
