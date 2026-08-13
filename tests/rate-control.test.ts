import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XSignalError } from "../src/errors.js";
import { XService } from "../src/service.js";
import { Store } from "../src/store.js";
import { parseRetryAfterMs, selectCaptureWindow } from "../src/x/browser.js";
import { fixturePost, testConfig } from "./helpers.js";

const dirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-rate-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("adaptive rate recovery", () => {
  it("checkpoints only the requested lazy-load window after skips", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ id: String(index + 1) }));
    expect(selectCaptureWindow(items, new Set(["1", "2"]), 3, 5).map((item) => item.id)).toEqual(["6", "7", "8", "9", "10"]);
  });

  it("honors both numeric and HTTP-date Retry-After values", () => {
    const now = Date.parse("2026-08-12T20:00:00.000Z");
    expect(parseRetryAfterMs("45", now)).toBe(45_000);
    expect(parseRetryAfterMs("Wed, 12 Aug 2026 20:02:00 GMT", now)).toBe(120_000);
    expect(parseRetryAfterMs("not-a-date", now)).toBe(0);
  });

  it("persists backoff across restart and rejects a replacement search without creating a run", async () => {
    const dir = makeDir();
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const seed = new Store(testConfig(dir));
    seed.setSetting("rate_backoff_until", retryAt);
    seed.close();

    const service = new XService(testConfig(dir));
    await expect(service.search({ queries: [{ query: "replacement", mode: "top", limit: 10 }], execution: "inline" }))
      .rejects.toMatchObject({ code: "RATE_LIMITED", retryAt });
    expect(service.store.listActiveRuns()).toHaveLength(0);
    expect(service.browser.recommendedConcurrency()).toBe(1);
    await expect(service.status()).resolves.toMatchObject({ rateControl: { limited: true, retryAt, recoveryMode: true } });
    service.close();
  });

  it("defers a live-limited leg for the same run instead of failing it", async () => {
    const dir = makeDir();
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const service = new XService(testConfig(dir));
    vi.spyOn(service.browser, "probeIdentity").mockResolvedValue({ connected: true, authenticated: true, handle: "fixture", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    vi.spyOn(service.browser, "search").mockRejectedValue(new XSignalError("RATE_LIMITED", "fixture pressure", {
      retryAt,
      retryAfterMs: 60_000,
    }));

    const result = await service.search({ queries: [{ query: "same run", mode: "top", limit: 10 }], execution: "inline" });
    expect(result).toMatchObject({ status: "running", retryAt, errors: [] });
    expect(service.store.getRun(result.runId)).toMatchObject({ failedLegs: 0, completedLegs: 0, retryAt });
    service.close();
  });

  it("waits for an inline leg leased concurrently by the background worker", async () => {
    const dir = makeDir();
    const service = new XService(testConfig(dir));
    vi.spyOn(service.browser, "probeIdentity").mockResolvedValue({ connected: true, authenticated: true, handle: "fixture", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    vi.spyOn(service.browser, "search").mockImplementation(async (_query, mode) => {
      await new Promise((resolve) => setTimeout(resolve, mode === "top" ? 800 : 100));
      return {
        posts: [fixturePost(mode)],
        nextCursor: null,
        warnings: [],
        operation: {
          name: "SearchTimeline",
          queryId: "fixture",
          method: "GET",
          path: "/fixture",
          sourcePage: "/search",
          lens: mode,
          capturedAt: new Date().toISOString(),
          parserVersion: 1,
          replayed: false,
          variableKeys: [],
          featureKeys: [],
          fieldToggleKeys: [],
        },
      };
    });
    service.start();

    const result = await service.search({
      queries: [
        { query: "first", mode: "top", limit: 5 },
        { query: "second", mode: "latest", limit: 5 },
      ],
      execution: "inline",
    });
    expect(result).toMatchObject({ status: "completed", retryAt: null, errors: [] });
    expect(result.posts).toHaveLength(2);
    service.close();
  });

  it("starts the next queued leg as soon as one pool slot finishes", async () => {
    const dir = makeDir();
    const service = new XService(testConfig(dir));
    vi.spyOn(service.browser, "probeIdentity").mockResolvedValue({ connected: true, authenticated: true, handle: "fixture", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowFinished = false;
    let thirdStartedBeforeSlowFinished = false;
    let active = 0;
    let maximumActive = 0;
    const started: string[] = [];
    vi.spyOn(service.browser, "search").mockImplementation(async (query, mode) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.push(query);
      try {
        if (query === "slow") {
          await slow;
          slowFinished = true;
        }
        if (query === "third") thirdStartedBeforeSlowFinished = !slowFinished;
        return {
          posts: [fixturePost(query)],
          nextCursor: null,
          warnings: [],
          operation: { name: "SearchTimeline", queryId: "fixture", method: "GET", path: "/fixture", sourcePage: "/search", lens: mode, capturedAt: new Date().toISOString(), parserVersion: 1, replayed: false, variableKeys: [], featureKeys: [], fieldToggleKeys: [] },
        };
      } finally {
        active -= 1;
      }
    });

    const pending = service.search({
      queries: [
        { query: "slow", mode: "top", limit: 1 },
        { query: "fast", mode: "latest", limit: 1 },
        { query: "third", mode: "top", limit: 1 },
      ],
      execution: "inline",
    });
    await vi.waitFor(() => expect(started).toContain("third"));
    expect(thirdStartedBeforeSlowFinished).toBe(true);
    expect(maximumActive).toBe(2);
    releaseSlow();
    await expect(pending).resolves.toMatchObject({ status: "completed" });
    service.close();
  });
});
