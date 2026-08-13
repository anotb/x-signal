import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { XService } from "../src/service.js";
import { fixturePost, testConfig } from "./helpers.js";

const dirs: string[] = [];

function makeService(): XService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-evidence-"));
  dirs.push(dir);
  return new XService(testConfig(dir));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("stored evidence paging", () => {
  it("continues the exact ranked ordering emitted by x_search", () => {
    const service = makeService();
    const runId = service.store.createRun({
      queries: [{ query: "ranked", mode: "top", limit: 5 }],
      execution: "inline",
      responseLimit: 2,
      aggregation: { deduplicate: true, cluster: true, rank: "engagement", authorDiversity: false },
    });
    const leg = service.store.leaseLeg("test", 60_000, runId)!;
    service.store.completeLeg(leg, [1, 2, 3, 4, 5].map((id) => fixturePost(String(id), { metrics: { replies: id, reposts: id, quotes: id, likes: id * 10, views: id * 100 } })), null, []);

    const first = service.result(runId);
    const all = service.result(runId, 0, Number.POSITIVE_INFINITY).posts;
    expect(first.evidencePage.sort).toBe("engagement");
    expect(first.evidencePage.nextCursor).toMatch(/^e1:/);
    const second = service.evidence(runId, undefined, first.evidencePage.nextCursor!, 2);
    expect(second.posts.map((post) => post.id)).toEqual(all.slice(2, 4).map((post) => post.id));
    expect(second.posts.map((post) => post.id)).not.toEqual(expect.arrayContaining(first.posts.map((post) => post.id)));
    service.close();
  });

  it("preserves duplicate observations when run aggregation requests it", () => {
    const service = makeService();
    const runId = service.store.createRun({
      queries: [{ query: "one", mode: "top", limit: 1 }, { query: "two", mode: "latest", limit: 1 }],
      execution: "inline",
      aggregation: { deduplicate: false, cluster: false, rank: "balanced", authorDiversity: false },
    });
    for (let index = 0; index < 2; index += 1) {
      const leg = service.store.leaseLeg("test", 60_000, runId)!;
      service.store.completeLeg(leg, [fixturePost("same", { provenance: { ...fixturePost("same").provenance, lens: index ? "latest" : "top" } })], null, []);
    }
    expect(service.evidence(runId, undefined, undefined, 10).posts.map((post) => post.id)).toEqual(["same", "same"]);
    service.close();
  });

  it("adapts a response page by bytes without reducing the stored collection", () => {
    const service = makeService();
    const runId = service.store.createRun({ queries: [{ query: "large", mode: "top", limit: 3 }], execution: "inline", responseLimit: 3 });
    const leg = service.store.leaseLeg("test", 60_000, runId)!;
    service.store.completeLeg(leg, ["a", "b", "c"].map((id) => fixturePost(id, { text: id.repeat(800_000) })), null, []);
    const result = service.result(runId);
    expect(result.totalPosts).toBe(3);
    expect(result.posts).toHaveLength(1);
    expect(result.evidencePage).toMatchObject({ truncatedByByteBudget: true, byteBudgetBytes: 1_500_000 });
    expect(result.evidencePage.nextCursor).toMatch(/^e1:/);
    service.close();
  });
});
