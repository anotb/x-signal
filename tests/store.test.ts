import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { XSearchInput } from "../src/contracts.js";
import { nextMonitorRun, Store } from "../src/store.js";
import { fixturePost, testConfig } from "./helpers.js";

const dirs: string[] = [];
function makeStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-store-"));
  dirs.push(dir);
  return new Store(testConfig(dir));
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const input: XSearchInput = {
  queries: [
    { query: "first", mode: "top", limit: 10 },
    { query: "second", mode: "latest", limit: 10 },
  ],
  execution: "job",
  aggregation: { deduplicate: true, cluster: true, rank: "balanced", authorDiversity: true },
  idempotencyKey: "fixture-run-key",
};

describe("SQLite run state", () => {
  it("coalesces idempotent runs and never dispatches on polling", () => {
    const store = makeStore();
    const id = store.createRun(input);
    expect(store.createRun(input)).toBe(id);
    const leg = store.leaseLeg("test-worker", 60_000, id)!;
    store.completeLeg(leg, [fixturePost("100")], "cursor", []);
    const dispatches = store.getRun(id).browserDispatches;
    expect(store.getRun(id).browserDispatches).toBe(dispatches);
    expect(store.getRun(id).posts).toHaveLength(1);
    store.close();
  });

  it("rejects an idempotency key reused for different input", () => {
    const store = makeStore();
    store.createRun(input);
    expect(() => store.createRun({ ...input, queries: [{ query: "different", mode: "top", limit: 10 }] }))
      .toThrow(/idempotency key is already bound/i);
    store.close();
  });

  it("does not reuse an idempotency key across X accounts", () => {
    const store = makeStore();
    store.createRun(input, "search", "main_account");
    expect(() => store.createRun(input, "search", "alternate_account")).toThrow(/idempotency key is already bound/i);
    store.close();
  });

  it("fences stale and cancelled lease completion before persisting posts", () => {
    const store = makeStore();
    const id = store.createRun({ queries: [{ query: "lease", mode: "top", limit: 2 }], execution: "job" });
    const stale = store.leaseLeg("old", 60_000, id)!;
    store.db.prepare("UPDATE run_legs SET lease_expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", stale.id);
    const current = store.leaseLeg("new", 60_000, id)!;
    expect(store.completeLeg(stale, [fixturePost("stale")], null, [])).toBe(false);
    expect(store.completeLeg(current, [fixturePost("current")], null, [])).toBe(true);
    expect(store.getRun(id).posts.map((post) => post.id)).toEqual(["current"]);

    const cancelledId = store.createRun({ queries: [{ query: "cancel", mode: "top", limit: 1 }], execution: "job" });
    const cancelled = store.leaseLeg("worker", 60_000, cancelledId)!;
    store.cancelRun(cancelledId);
    expect(store.completeLeg(cancelled, [fixturePost("too-late")], null, [])).toBe(false);
    expect(store.getRun(cancelledId).posts).toEqual([]);
    store.close();
  });

  it("recovers a leased leg after process restart", () => {
    const store = makeStore();
    const id = store.createRun({ ...input, idempotencyKey: "recovery-key" });
    expect(store.leaseLeg("dead-worker", 600_000, id)).not.toBeNull();
    store.close();
    const reopened = new Store(testConfig(dirs[0]!));
    expect(reopened.recoverInterrupted()).toBe(1);
    expect(reopened.leaseLeg("new-worker", 60_000, id)).not.toBeNull();
    reopened.close();
  });

  it("persists scoped direct-read cursor state across restart", () => {
    const store = makeStore();
    const token = store.createDirectCursor("timeline", "following:false", "fixture", ["2", "1"]);
    store.close();
    const reopened = new Store(testConfig(dirs[0]!));
    expect(reopened.readDirectCursor(token, "timeline", "following:false", "fixture")).toEqual(["1", "2"]);
    expect(() => reopened.readDirectCursor(token, "timeline", "for_you:false", "fixture")).toThrow(/different query, timeline source, or X account/i);
    expect(() => reopened.readDirectCursor(token, "timeline", "following:false", "another-account")).toThrow(/different query, timeline source, or X account/i);
    reopened.close();
  });

  it("reads pre-language snapshots without discarding historical evidence", () => {
    const store = makeStore();
    const id = store.createRun({ queries: [{ query: "legacy", mode: "top", limit: 1 }], execution: "job" });
    const leg = store.leaseLeg("worker", 60_000, id)!;
    store.completeLeg(leg, [fixturePost("legacy")], null, []);
    const legacy = fixturePost("legacy") as unknown as Record<string, unknown>;
    delete legacy.language;
    store.db.prepare("UPDATE run_items SET snapshot_json=? WHERE run_id=?").run(JSON.stringify(legacy), id);
    store.db.prepare("UPDATE posts SET json=? WHERE id=?").run(JSON.stringify(legacy), "legacy");
    expect(store.getRun(id).posts[0]).toMatchObject({ id: "legacy", language: null });
    expect(store.getPost("legacy")).toMatchObject({ id: "legacy", language: null });
    store.close();
  });

  it("continues selected completed legs in place and preserves prior evidence across restart", () => {
    const store = makeStore();
    const id = store.createRun({ queries: [{ query: "continuation", mode: "latest", limit: 2 }], execution: "inline" });
    const firstLeg = store.leaseLeg("first-worker", 60_000, id)!;
    store.completeLeg(firstLeg, [fixturePost("1"), fixturePost("2")], "cursor-one", ["first page"]);
    const legId = store.getRun(id).legs[0]!.id;
    store.close();

    const reopened = new Store(testConfig(dirs[0]!));
    const continued = reopened.continueRun(id, [{ legId, additionalLimit: 2 }], 40, "continue-once", "auto");
    expect(continued).toMatchObject({ id, status: "queued", posts: [{ id: "1" }, { id: "2" }] });
    expect(continued.legs[0]).toMatchObject({ id: legId, status: "queued", returnedCount: 2, query: { limit: 4 } });
    const secondLeg = reopened.leaseLeg("second-worker", 60_000, id)!;
    expect(reopened.getLegPostIds(secondLeg.id)).toEqual(["1", "2"]);
    reopened.completeLeg(secondLeg, [fixturePost("3"), fixturePost("4")], "cursor-two", ["second page"]);
    const completed = reopened.getRun(id);
    expect(completed.status).toBe("completed");
    expect(completed.posts.map((post) => post.id)).toEqual(["1", "2", "3", "4"]);
    expect(completed.legs[0]).toMatchObject({ returnedCount: 4, query: { limit: 4 }, cursor: "cursor-two" });
    expect(completed.warnings).toEqual(["first page", "second page"]);
    reopened.close();
  });

  it("makes continuation retries duplicate-safe and rejects key reuse for another request", () => {
    const store = makeStore();
    const id = store.createRun({ queries: [{ query: "continuation", mode: "latest", limit: 2 }], execution: "job" });
    const first = store.leaseLeg("worker", 60_000, id)!;
    store.completeLeg(first, [fixturePost("1"), fixturePost("2")], "cursor", []);
    const legId = store.getRun(id).legs[0]!.id;
    const request = [{ legId, additionalLimit: 3 }];
    expect(store.continueRun(id, request, 40, "retry-safe", "job").legs[0]?.query.limit).toBe(5);
    expect(store.continueRun(id, request, 40, "retry-safe", "job").legs[0]?.query.limit).toBe(5);
    expect(() => store.continueRun(id, [{ legId, additionalLimit: 4 }], 40, "retry-safe", "job"))
      .toThrow(/continuation idempotency key is already bound/i);
    store.close();
  });

  it("persists a deferred rate-limited leg and leases it only after retryAt", () => {
    const store = makeStore();
    const id = store.createRun({ ...input, queries: [input.queries[0]!], idempotencyKey: "deferred-key" });
    const leg = store.leaseLeg("rate-worker", 60_000, id)!;
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    store.deferLeg(leg, retryAt);
    expect(store.getRun(id)).toMatchObject({ status: "running", retryAt, failedLegs: 0 });
    expect(store.leaseLeg("early-worker", 60_000, id)).toBeNull();
    store.close();

    const reopened = new Store(testConfig(dirs[0]!));
    expect(reopened.getRun(id).retryAt).toBe(retryAt);
    reopened.db.prepare("UPDATE run_legs SET not_before_at=? WHERE run_id=?").run("2000-01-01T00:00:00.000Z", id);
    expect(reopened.leaseLeg("later-worker", 60_000, id)).not.toBeNull();
    reopened.close();
  });

  it("recovers page checkpoints after restart and merges accepted snapshots once", () => {
    const store = makeStore();
    const id = store.createRun({ queries: [{ query: "deep", mode: "latest", limit: 3 }], execution: "job" });
    const firstLease = store.leaseLeg("first-worker", 60_000, id)!;
    expect(store.checkpointLeg(firstLease, [fixturePost("1")], ["1", "2"])).toBe(true);
    expect(store.getLegSeenPostIds(firstLease.id)).toEqual(["1", "2"]);
    store.close();

    const reopened = new Store(testConfig(dirs[0]!));
    expect(reopened.recoverInterrupted()).toBe(1);
    const resumedLease = reopened.leaseLeg("resumed-worker", 60_000, id)!;
    expect(reopened.getLegSeenPostIds(resumedLease.id)).toEqual(["1", "2"]);
    reopened.completeLeg(resumedLease, [fixturePost("3")], null, [], ["3"]);
    expect(reopened.getRun(id).posts.map((post) => post.id).sort()).toEqual(["1", "3"]);
    expect(reopened.getLegSeenPostIds(resumedLease.id)).toEqual(["1", "2", "3"]);
    reopened.close();
  });

  it("discards uncommitted page checkpoints when a run is cancelled", () => {
    const store = makeStore();
    const id = store.createRun({ queries: [{ query: "cancel", mode: "latest", limit: 3 }], execution: "job" });
    const leg = store.leaseLeg("worker", 60_000, id)!;
    store.checkpointLeg(leg, [fixturePost("partial")], ["partial"]);
    expect(store.cancelRun(id)).toBe(true);
    expect(store.getRun(id)).toMatchObject({ status: "cancelled", posts: [] });
    expect(Number((store.db.prepare("SELECT COUNT(*) AS count FROM run_capture_checkpoints WHERE leg_id=?").get(leg.id) as { count: number }).count)).toBe(0);
    store.close();
  });

  it("diffs monitor baselines and creates one delivery per sink", () => {
    const store = makeStore();
    const monitor = store.createMonitor({ name: "fixture", queries: [{ query: "x", mode: "top", limit: 10 }], accounts: [], includeFollowing: false, everyMinutes: 60, freshnessMinutes: 1440, include: [], exclude: [], retentionDays: 90 });
    const run1 = store.createRun({ queries: [{ query: "x", mode: "top", limit: 10 }], execution: "inline" }, "monitor");
    const leg1 = store.leaseLeg("worker", 60_000, run1)!;
    store.completeLeg(leg1, [fixturePost("1"), fixturePost("2", { metrics: { replies: 1, reposts: 2, quotes: 0, likes: 5, views: 100 } })], null, []);
    const first = store.completeMonitorRun(monitor.id, run1);
    expect(first.diff.addedPostIds).toEqual(["1", "2"]);
    const run2 = store.createRun({ queries: [{ query: "x", mode: "top", limit: 10 }], execution: "inline", idempotencyKey: "monitor-second" }, "monitor");
    const leg2 = store.leaseLeg("worker", 60_000, run2)!;
    store.completeLeg(leg2, [fixturePost("2", { metrics: { replies: 1, reposts: 2, quotes: 0, likes: 15, views: 250 } }), fixturePost("3")], null, []);
    const second = store.completeMonitorRun(monitor.id, run2);
    expect(second.diff).toMatchObject({ addedPostIds: ["3"], removedPostIds: ["1"], unchangedCount: 1 });
    expect(second.diff.metricChanges).toEqual([expect.objectContaining({ postId: "2" })]);
    expect(second.diff.newAuthors).toEqual([expect.objectContaining({ id: "author-3" })]);
    const one = store.createDelivery(second.id, "https://example.com/hook");
    const two = store.createDelivery(second.id, "https://example.com/hook");
    expect(one.state).toBe("ready");
    expect(two.state).toBe("waiting");
    expect(two.id).toBe(one.id);
    store.finishDelivery(one.id, true);
    expect(store.createDelivery(second.id, "https://example.com/hook")).toMatchObject({ id: one.id, state: "delivered", retryAt: null });
    store.close();
  });

  it("rejects a monitor idempotency key reused for another definition", () => {
    const store = makeStore();
    const definition = { name: "first", queries: [{ query: "x", mode: "top", limit: 10 }], accounts: [], includeFollowing: false, everyMinutes: 60, freshnessMinutes: 1440, include: [], exclude: [], retentionDays: 90, idempotencyKey: "same-monitor" };
    const created = store.createMonitor(definition);
    expect(store.createMonitor({ ...definition })).toMatchObject({ id: created.id });
    expect(() => store.createMonitor({ ...definition, name: "different" })).toThrow(/idempotency key is already bound/i);
    store.close();
  });

  it("treats an empty current monitor leg as unknown instead of removed", () => {
    const store = makeStore();
    const monitor = store.createMonitor({ name: "empty-safe", queries: [{ query: "x", mode: "top", limit: 10 }], accounts: [], includeFollowing: false, everyMinutes: 60, freshnessMinutes: 1440, include: [], exclude: [], retentionDays: 90 });
    const baseline = store.createRun({ queries: [{ query: "x", mode: "top", limit: 10 }], execution: "inline" }, "monitor", "same_account");
    const baselineLeg = store.leaseLeg("worker", 60_000, baseline)!;
    store.completeLeg(baselineLeg, [fixturePost("present")], null, []);
    store.completeMonitorRun(monitor.id, baseline);
    const current = store.createRun({ queries: [{ query: "x", mode: "top", limit: 10 }], execution: "inline" }, "monitor", "same_account");
    const currentLeg = store.leaseLeg("worker", 60_000, current)!;
    store.completeLeg(currentLeg, [], null, []);
    const result = store.completeMonitorRun(monitor.id, current);
    expect(result.diff).toMatchObject({ comparisonState: "partial", removedPostIds: [], removalsSuppressed: true });
    expect(result.diff.unknownLegs).toEqual([expect.objectContaining({ index: 0, reason: "empty-leg" })]);
    store.close();
  });

  it("never reports removals across an account change", () => {
    const store = makeStore();
    const monitor = store.createMonitor({ name: "account-safe", queries: [{ query: "x", mode: "top", limit: 10 }], accounts: [], includeFollowing: false, everyMinutes: 60, freshnessMinutes: 1440, include: [], exclude: [], retentionDays: 90 });
    const baseline = store.createRun({ queries: [{ query: "x", mode: "top", limit: 10 }], execution: "inline" }, "monitor", "main_account");
    const baselineLeg = store.leaseLeg("worker", 60_000, baseline)!;
    store.completeLeg(baselineLeg, [fixturePost("main-only")], null, []);
    store.completeMonitorRun(monitor.id, baseline);
    const current = store.createRun({ queries: [{ query: "x", mode: "top", limit: 10 }], execution: "inline" }, "monitor", "alternate_account");
    const currentLeg = store.leaseLeg("worker", 60_000, current)!;
    store.completeLeg(currentLeg, [fixturePost("alternate-only")], null, []);
    const result = store.completeMonitorRun(monitor.id, current);
    expect(result.diff).toMatchObject({ comparisonState: "account-changed", baselineAccountHandle: "main_account", currentAccountHandle: "alternate_account", addedPostIds: ["alternate-only"], removedPostIds: [], removalsSuppressed: true });
    store.close();
  });

  it("keeps a prepared monitor diff and failed delivery pending across restart until commit", () => {
    const store = makeStore();
    const monitor = store.createMonitor({ name: "durable", queries: [{ query: "x", mode: "top", limit: 10 }], accounts: [], includeFollowing: false, everyMinutes: 60, freshnessMinutes: 1440, include: [], exclude: [], retentionDays: 90 });
    const runId = store.createRun({ queries: [{ query: "x", mode: "top", limit: 10 }], execution: "job" }, "monitor");
    const leg = store.leaseLeg("worker", 60_000, runId)!;
    store.completeLeg(leg, [fixturePost("durable")], null, []);
    const prepared = store.prepareMonitorRun(monitor.id, runId);
    store.setMonitorExecution(monitor.id, runId, "delivering");
    const delivery = store.createDelivery(prepared.id, "https://example.com/hook");
    const retryAt = store.finishDelivery(delivery.id, false, "temporary");
    expect(retryAt).toBeTruthy();
    expect(store.getMonitor(monitor.id)).toMatchObject({ lastRunId: null, activeRunId: runId, executionStage: "delivering" });
    store.close();

    const reopened = new Store(testConfig(dirs[0]!));
    expect(reopened.prepareMonitorRun(monitor.id, runId)).toEqual(prepared);
    expect(reopened.createDelivery(prepared.id, "https://example.com/hook")).toMatchObject({ state: "waiting", retryAt });
    reopened.db.prepare("UPDATE deliveries SET next_attempt_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", delivery.id);
    expect(reopened.createDelivery(prepared.id, "https://example.com/hook")).toMatchObject({ state: "ready" });
    reopened.finishDelivery(delivery.id, true);
    reopened.commitMonitorRun(monitor.id, runId);
    expect(reopened.getMonitor(monitor.id)).toMatchObject({ lastRunId: runId, activeRunId: null, executionStage: "idle" });
    reopened.close();
  });

  it("computes interval and daily-local monitor schedules", () => {
    const from = new Date("2026-08-12T10:00:00.000Z");
    expect(nextMonitorRun({ cadence: { type: "interval", everyMinutes: 15 } }, from).toISOString()).toBe("2026-08-12T10:15:00.000Z");
    const daily = nextMonitorRun({ cadence: { type: "daily", atLocalTime: "11:30" }, timezone: "America/New_York" }, from);
    expect(daily.toISOString()).toBe("2026-08-12T15:30:00.000Z");
  });

  it("filters captured monitor items before diffing", () => {
    const store = makeStore();
    const runId = store.createRun({ queries: [{ query: "x", mode: "top", limit: 10 }], execution: "inline" }, "monitor");
    const leg = store.leaseLeg("test", 60_000, runId)!;
    store.completeLeg(leg, [fixturePost("keep", { text: "alpha signal" }), fixturePost("drop", { text: "beta noise" })], null, []);
    expect(store.filterRunItems(runId, (post) => post.text.includes("signal"))).toEqual({ before: 2, after: 1 });
    expect(store.getRun(runId).posts.map((post) => post.id)).toEqual(["keep"]);
    store.close();
  });

  it("prunes expired monitor runs but preserves the current baseline", () => {
    const store = makeStore();
    const monitor = store.createMonitor({ name: "retained", queries: [{ query: "x", mode: "top", limit: 10 }], accounts: [], includeFollowing: false, everyMinutes: 60, freshnessMinutes: 1440, include: [], exclude: [], retentionDays: 1 });
    const oldRun = store.createRun({ queries: [{ query: "old", mode: "top", limit: 10 }], execution: "inline" }, "monitor");
    const oldLeg = store.leaseLeg("test", 60_000, oldRun)!;
    store.completeLeg(oldLeg, [fixturePost("old", { text: "old" })], null, []);
    store.completeMonitorRun(monitor.id, oldRun);
    store.db.prepare("UPDATE monitor_runs SET created_at=? WHERE run_id=?").run("2020-01-01T00:00:00.000Z", oldRun);
    const currentRun = store.createRun({ queries: [{ query: "new", mode: "top", limit: 10 }], execution: "inline" }, "monitor");
    const currentLeg = store.leaseLeg("test", 60_000, currentRun)!;
    store.completeLeg(currentLeg, [fixturePost("new", { text: "new" })], null, []);
    store.completeMonitorRun(monitor.id, currentRun);
    expect(store.pruneMonitorHistory(monitor.id, 1, new Date("2026-08-12T00:00:00.000Z"))).toBe(1);
    expect(() => store.getRun(oldRun)).toThrow();
    expect(store.getPost("old")).toBeNull();
    expect((store.db.prepare("SELECT COUNT(*) AS count FROM observations WHERE run_id=?").get(oldRun) as { count: number }).count).toBe(0);
    expect((store.db.prepare("SELECT COUNT(*) AS count FROM authors WHERE id='author-old'").get() as { count: number }).count).toBe(0);
    expect(store.getRun(currentRun).id).toBe(currentRun);
    expect(store.getPost("new")?.id).toBe("new");
    store.close();
  });

  it("writes durable exports with formula-safe CSV handled by the service layer", () => {
    const store = makeStore();
    const exported = store.createExport("run", "fixture", "markdown", "fixture.md", "text/markdown", "# Fixture\n");
    expect(exported.uri).toMatch(/^x-signal:\/\/exports\//);
    expect(store.getExport(exported.id).content).toBe("# Fixture\n");
    expect(fs.existsSync(path.join(dirs[0]!, "exports", `${exported.id}-fixture.md`))).toBe(true);
    store.close();
  });
});
