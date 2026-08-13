import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { XBrowser } from "../src/x/browser.js";
import { testConfig } from "./helpers.js";

describe("browser runtime hardening", () => {
  it("bounds the short-lived result cache and evicts expired entries", async () => {
    const browser = new XBrowser(testConfig("."), () => undefined);
    const internal = browser as unknown as {
      cache: Map<string, { expiresAt: number; value: unknown }>;
      coalesced<T>(key: string, work: () => Promise<T>): Promise<T>;
    };
    internal.cache.set("expired", { expiresAt: Date.now() - 1, value: "old" });
    for (let index = 0; index < 40; index += 1) {
      await internal.coalesced(`key-${index}`, async () => ({ index }));
    }
    expect(internal.cache.has("expired")).toBe(false);
    expect(internal.cache.size).toBe(32);
    expect(internal.cache.has("key-0")).toBe(false);
    expect(internal.cache.has("key-39")).toBe(true);
  });

  it("stops peer work when a browser task establishes global backoff", () => {
    const browser = new XBrowser(testConfig("."), () => undefined) as unknown as {
      backoffUntil: number;
      assertBackoffClear(stage: string): void;
    };
    browser.backoffUntil = Date.now() + 30_000;
    expect(() => browser.assertBackoffClear("lazy-load request")).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
  });

  it("classifies replay authentication and rate responses through the same path", () => {
    const browser = new XBrowser(testConfig("."), () => undefined) as unknown as {
      assertHttpStatus(status: number, retryAfter: string | undefined, label: string): void;
    };
    expect(() => browser.assertHttpStatus(401, undefined, "Replay")).toThrow(expect.objectContaining({ code: "REAUTH_REQUIRED" }));
    expect(() => browser.assertHttpStatus(403, undefined, "Replay")).toThrow(expect.objectContaining({ code: "REAUTH_REQUIRED" }));
    expect(() => browser.assertHttpStatus(429, "45", "Replay")).toThrow(expect.objectContaining({ code: "RATE_LIMITED", retryAfterMs: 45_000 }));
  });

  it("uses the browser-generated response without issuing a duplicate replay request", async () => {
    const browser = new XBrowser(testConfig("."), () => undefined);
    let evaluations = 0;
    const response = {
      url: () => "https://x.com/i/api/graphql/fixture/SearchTimeline?variables=%7B%7D",
      status: () => 200,
      headers: () => ({}),
      json: async () => ({ data: "fixture" }),
      request: () => ({ method: () => "GET", postDataJSON: () => null }),
    };
    const page = {
      waitForResponse: async () => response,
      goto: async () => undefined,
      url: () => "https://x.com/search?q=fixture",
      evaluate: async () => { evaluations += 1; throw new Error("unexpected replay"); },
      close: async () => undefined,
    };
    const internal = browser as unknown as {
      connect(): Promise<{ newPage(): Promise<typeof page> }>;
      captureItems<T extends { id: string }>(
        options: { targetUrl: string; operationNames: string[]; lens: "latest"; limit: number },
        parse: (payload: unknown) => { items: T[]; bottomCursor: string | null; warnings: string[] },
      ): Promise<{ items: T[]; warnings: string[]; operation: { replayed: boolean } }>;
    };
    internal.connect = async () => ({ newPage: async () => page });

    const result = await internal.captureItems(
      { targetUrl: "https://x.com/search?q=fixture", operationNames: ["SearchTimeline"], lens: "latest", limit: 1 },
      () => ({ items: [{ id: "fixture-post" }], bottomCursor: null, warnings: [] }),
    );

    expect(result.items).toEqual([{ id: "fixture-post" }]);
    expect(result.operation.replayed).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(evaluations).toBe(0);
  });

  it("coalesces concurrent identity probes onto one X navigation", async () => {
    const browser = new XBrowser(testConfig("."), () => undefined);
    let navigations = 0;
    const page = {
      bringToFront: async () => undefined,
      goto: async () => { navigations += 1; await Promise.resolve(); },
      waitForTimeout: async () => undefined,
      url: () => "https://x.com/home",
      getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
      locator: () => ({ first: () => ({ getAttribute: async () => "/fixture_account" }) }),
    };
    const internal = browser as unknown as { connect(): Promise<{ pages(): typeof page[]; newPage(): Promise<typeof page> }> };
    internal.connect = async () => ({ pages: () => [page], newPage: async () => page });
    const [one, two] = await Promise.all([browser.probeIdentity(true), browser.probeIdentity(true)]);
    expect(navigations).toBe(1);
    expect(one.handle).toBe("fixture_account");
    expect(two).toEqual(one);
  });

  it("keeps sidecar supervision and health requirements explicit", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const entrypoint = fs.readFileSync(path.join(root, "deploy/browser/entrypoint.sh"), "utf8");
    const launcher = fs.readFileSync(path.join(root, "deploy/browser/launcher.mjs"), "utf8");
    const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
    expect(entrypoint).toContain("wait -n");
    expect(entrypoint).toContain('exit 1');
    expect(entrypoint).not.toContain("\r");
    expect(fs.readFileSync(path.join(root, "deploy/browser/Dockerfile"), "utf8")).toContain("sed -i 's/\\r$//' ./entrypoint.sh");
    expect(launcher.indexOf("await context?.close()" )).toBeLessThan(launcher.indexOf("await closeForwarder()"));
    expect(launcher).toContain("for (const socket of sockets) socket.destroy()");
    expect(compose).toContain("6080/vnc.html");
    expect(compose).toContain("9222/json/version");
  });
});
