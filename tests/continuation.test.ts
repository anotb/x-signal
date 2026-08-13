import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XService } from "../src/service.js";
import { fixturePost, testConfig } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable search continuation", () => {
  it("adds new unique posts to selected legs without replacing the run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-continuation-"));
    dirs.push(dir);
    const service = new XService(testConfig(dir));
    vi.spyOn(service.browser, "probeIdentity").mockResolvedValue({ connected: true, authenticated: true, handle: "fixture", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    const search = vi.spyOn(service.browser, "search").mockImplementation(async (_query, mode, limit, options) => {
      const offset = options?.skipPostIds?.size ?? 0;
      return {
        posts: Array.from({ length: limit }, (_, index) => fixturePost(String(offset + index + 1))),
        nextCursor: `cursor-${offset + limit}`,
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

    const initial = await service.search({ queries: [{ query: "continuation", mode: "latest", limit: 2 }], execution: "inline", responseLimit: 2 });
    expect(initial.posts.map((post) => post.id)).toEqual(["1", "2"]);
    const legId = initial.legs[0]!.id;
    const continued = await service.continueSearch({
      runId: initial.runId,
      additionalLimit: 40,
      legs: [{ legId, additionalLimit: 3 }],
      execution: "inline",
    });

    expect(continued.runId).toBe(initial.runId);
    expect(continued.posts.map((post) => post.id)).toHaveLength(2);
    expect(continued).toMatchObject({ totalPosts: 5, evidencePage: { sort: "balanced", offset: 0, limit: 2, returnedCount: 2, nextCursor: expect.stringMatching(/^e1:/) } });
    const secondPage = service.evidence(initial.runId, undefined, continued.evidencePage.nextCursor ?? undefined, 2);
    const thirdPage = service.evidence(initial.runId, undefined, secondPage.nextCursor ?? undefined, 2);
    expect(secondPage.sort).toBe("balanced");
    expect([...continued.posts, ...secondPage.posts, ...thirdPage.posts].map((post) => post.id).sort()).toEqual(["1", "2", "3", "4", "5"]);
    expect(continued.legs[0]).toMatchObject({ id: legId, requestedCount: 5, returnedCount: 5, hasMore: true });
    expect(continued.continuation).toMatchObject({ available: true, runId: initial.runId, continuableLegIds: [legId] });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]?.[2]).toBe(3);
    expect(search.mock.calls[1]?.[3]?.skipPostIds?.size).toBe(2);
    service.close();
  });

  it("remembers locally rejected candidates so filtered continuation advances deeper", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-filtered-continuation-"));
    dirs.push(dir);
    const service = new XService(testConfig(dir));
    vi.spyOn(service.browser, "probeIdentity").mockResolvedValue({ connected: true, authenticated: true, handle: "fixture", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    const search = vi.spyOn(service.browser, "search").mockImplementation(async (_query, mode, _limit, options) => ({
      posts: options?.skipPostIds?.size
        ? [fixturePost("3", { metrics: { replies: 1, reposts: 2, quotes: 0, likes: 30, views: 100 } }), fixturePost("4", { metrics: { replies: 1, reposts: 2, quotes: 0, likes: 40, views: 100 } })]
        : [fixturePost("1", { metrics: { replies: 1, reposts: 2, quotes: 0, likes: 1, views: 100 } }), fixturePost("2", { metrics: { replies: 1, reposts: 2, quotes: 0, likes: 20, views: 100 } })],
      nextCursor: "more",
      warnings: [],
      operation: { name: "SearchTimeline", queryId: "fixture", method: "GET", path: "/fixture", sourcePage: "/search", lens: mode, capturedAt: new Date().toISOString(), parserVersion: 1, replayed: false, variableKeys: [], featureKeys: [], fieldToggleKeys: [] },
    }));

    const initial = await service.search({ queries: [{ query: "filtered", mode: "latest", limit: 2, filters: { minLikes: 10 } }], execution: "inline" });
    expect(initial.posts.map((post) => post.id)).toEqual(["2"]);
    const continued = await service.continueSearch({ runId: initial.runId, legs: [{ legId: initial.legs[0]!.id, additionalLimit: 1 }], additionalLimit: 1, execution: "inline" });
    expect(continued.posts.map((post) => post.id).sort()).toEqual(["2", "3", "4"]);
    expect(search.mock.calls[1]?.[3]?.skipPostIds?.size).toBe(2);
    expect(service.store.getLegSeenPostIds(initial.legs[0]!.id).sort()).toEqual(["1", "2", "3", "4"]);
    service.close();
  });

  it("counts accepted restart checkpoints toward the requested target", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-checkpoint-target-"));
    dirs.push(dir);
    const first = new XService(testConfig(dir));
    const runId = first.store.createRun({ queries: [{ query: "restart", mode: "latest", limit: 3 }], execution: "job" });
    const lease = first.store.leaseLeg("interrupted", 60_000, runId)!;
    first.store.checkpointLeg(lease, [fixturePost("accepted")], ["accepted", "rejected"]);
    first.close();

    const resumed = new XService(testConfig(dir));
    vi.spyOn(resumed.browser, "probeIdentity").mockResolvedValue({ connected: true, authenticated: true, handle: "fixture", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    const search = vi.spyOn(resumed.browser, "search").mockImplementation(async (_query, mode, limit) => ({
      posts: Array.from({ length: limit }, (_, index) => fixturePost(`new-${index}`)),
      nextCursor: null,
      warnings: [],
      operation: { name: "SearchTimeline", queryId: "fixture", method: "GET", path: "/fixture", sourcePage: "/search", lens: mode, capturedAt: new Date().toISOString(), parserVersion: 1, replayed: false, variableKeys: [], featureKeys: [], fieldToggleKeys: [] },
    }));
    resumed.start();
    await vi.waitFor(() => expect(resumed.store.getRun(runId).status).toBe("completed"));
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[2]).toBe(2);
    expect(resumed.store.getRun(runId).posts.map((post) => post.id).sort()).toEqual(["accepted", "new-0", "new-1"]);
    resumed.close();
  });
});
