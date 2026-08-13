import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp.js";
import { XService } from "../../src/service.js";
import { testConfig } from "../helpers.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-mcp-"));
const service = new XService(testConfig(dir));
const server = createMcpServer(service);
const client = new Client({ name: "x-signal-contract-test", version: "1.0.0" });

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await server.close();
  service.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("MCP contract", () => {
  it("advertises the focused tool set with schemas and truthful annotations", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["fetch", "search", "x_cancel_run", "x_continue_search", "x_export", "x_get_evidence", "x_get_post", "x_get_run", "x_get_timeline", "x_monitor", "x_search", "x_search_accounts", "x_status"]);
    for (const tool of listed.tools) {
      expect(tool.description).toMatch(/^Use this when/);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations).toBeTruthy();
    }
    const standardSearch = listed.tools.find((tool) => tool.name === "search")!;
    const standardFetch = listed.tools.find((tool) => tool.name === "fetch")!;
    expect(Object.keys(standardSearch.inputSchema.properties ?? {})).toEqual(["query"]);
    expect(Object.keys(standardFetch.inputSchema.properties ?? {})).toEqual(["id"]);
    expect(standardSearch.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["results"],
      properties: {
        results: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "url"],
            properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string", format: "uri" } },
          },
        },
      },
    });
    expect(standardFetch.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "text", "url", "metadata"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        text: { type: "string" },
        url: { type: "string", format: "uri" },
        metadata: {
          type: "object",
          additionalProperties: false,
          required: ["postId", "author", "createdAt", "metrics", "flags", "provenance"],
        },
      },
    });
    expect(listed.tools.some((tool) => tool._meta && "ui" in tool._meta)).toBe(false);
    expect(listed.tools.find((tool) => tool.name === "x_cancel_run")?.annotations?.destructiveHint).toBe(true);
    const postSearchSchema = JSON.stringify(listed.tools.find((tool) => tool.name === "x_search")?.inputSchema);
    expect(postSearchSchema).toContain('"latest"');
    expect(postSearchSchema).not.toContain('"people"');
    expect(listed.tools.find((tool) => tool.name === "x_search")?.description).toContain("reference placement and count remain model-chosen");
    const timelineSchema = JSON.stringify(listed.tools.find((tool) => tool.name === "x_get_timeline")?.inputSchema);
    expect(timelineSchema).toContain('"community"');
    expect(timelineSchema).not.toContain('"notifications"');
    expect(listed.tools.find((tool) => tool.name === "x_search_accounts")?.description).toContain("people");
  });

  it("answers status without dispatching browser work", async () => {
    const result = await client.callTool({ name: "x_status", arguments: { liveProbe: false } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ version: "0.1.0-rc.5", rateControl: { limited: false, maxConcurrency: 2, recoveryMode: false } });
    expect((result.structuredContent as { capabilities: Record<string, { state: string }> }).capabilities["searchTop"]?.state).toBe("ready-unverified");
    expect(service.store.listActiveRuns()).toHaveLength(0);
  });

  it("rejects invalid input at the schema boundary", async () => {
    const result = await client.callTool({ name: "x_search", arguments: { queries: [] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Input validation error");
  });

  it("keeps canonical references in text without file-materialization links", async () => {
    const runId = service.store.createRun({ queries: [{ query: "links", mode: "top", limit: 1 }], execution: "inline" });
    const leg = service.store.leaseLeg("contract", 60_000, runId)!;
    const { fixturePost } = await import("../helpers.js");
    service.store.completeLeg(leg, [fixturePost("12345")], null, []);
    const result = await client.callTool({ name: "x_get_evidence", arguments: { runId, limit: 1 } });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(content)).toContain("https://x.com/fixture/status/12345");
    expect(content.some((item) => item.type === "resource_link")).toBe(false);
  });

  it("round-trips the immutable standard search result ID through fetch", async () => {
    const runId = service.store.createRun({ queries: [{ query: "round trip", mode: "top", limit: 1 }], execution: "inline" });
    const leg = service.store.leaseLeg("standard-contract", 60_000, runId)!;
    const { fixturePost } = await import("../helpers.js");
    service.store.completeLeg(leg, [fixturePost("54321")], null, []);
    const id = `runitem:${runId}:54321`;
    const result = await client.callTool({ name: "fetch", arguments: { id } });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const payload = JSON.parse(content.find((item) => item.type === "text")?.text ?? "{}");
    expect(payload).toMatchObject({ id, metadata: { postId: "54321" }, url: "https://x.com/fixture/status/54321" });
    expect(result.structuredContent).toEqual(payload);
  });

  it("coalesces repeated standard searches for the same account and query", async () => {
    const runId = service.store.createRun({
      queries: [
        { query: "cache contract", label: "Top", mode: "top", limit: 25 },
        { query: "cache contract", label: "Latest", mode: "latest", limit: 25 },
      ],
      execution: "inline",
    });
    const { fixturePost } = await import("../helpers.js");
    const first = service.store.leaseLeg("cache-contract", 60_000, runId)!;
    service.store.completeLeg(first, [fixturePost("61001")], null, []);
    const second = service.store.leaseLeg("cache-contract", 60_000, runId)!;
    service.store.completeLeg(second, [fixturePost("61002")], null, []);
    const search = vi.spyOn(service, "search").mockResolvedValue(service.result(runId));
    try {
      const [one, two] = await Promise.all([
        client.callTool({ name: "search", arguments: { query: "cache contract" } }),
        client.callTool({ name: "search", arguments: { query: "cache contract" } }),
      ]);
      expect(one.isError).not.toBe(true);
      expect(two.content).toEqual(one.content);
      expect(one.structuredContent).toEqual(JSON.parse((one.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}"));
      expect(two.structuredContent).toEqual(one.structuredContent);
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      search.mockRestore();
    }
  });

  it("returns a stable tool error for a missing run without browser work", async () => {
    const result = await client.callTool({ name: "x_get_run", arguments: { runId: "00000000-0000-4000-8000-000000000000" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === "text");
    expect(text && "text" in text ? text.text : "").toContain("RUN_NOT_FOUND");
  });

  it("exposes no UI resource in the tool-only archetype", async () => {
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    expect(resources.resources).toEqual([]);
    expect(templates.resourceTemplates.map((resource) => resource.uriTemplate)).toEqual(["x-signal://exports/{id}"]);
  });
});
