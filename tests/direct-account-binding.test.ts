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

describe("account-bound direct reads", () => {
  it("probes identity and binds account, timeline, and post captures to it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-direct-account-"));
    dirs.push(dir);
    const service = new XService(testConfig(dir));
    vi.spyOn(service.browser, "probeIdentity").mockResolvedValue({ connected: true, authenticated: true, handle: "AltAccount", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    const operation = { name: "Fixture", queryId: "fixture", method: "GET", path: "/fixture", sourcePage: "/fixture", lens: "top", capturedAt: new Date().toISOString(), parserVersion: 1, replayed: false, variableKeys: [], featureKeys: [], fieldToggleKeys: [] };
    const timeline = vi.spyOn(service.browser, "timeline").mockResolvedValue({ posts: [fixturePost("timeline")], nextCursor: null, warnings: [], operation });
    const accounts = vi.spyOn(service.browser, "searchAccounts").mockResolvedValue({ accounts: [], nextCursor: null, warnings: [], operation });
    const post = vi.spyOn(service.browser, "post").mockResolvedValue({ primary: fixturePost("12345"), thread: [], replies: [], quotes: [], warnings: [] });

    await service.getTimeline({ type: "following" }, 10);
    await service.searchAccounts("researchers", 10);
    await service.getPost("12345", "post", 10);

    expect(timeline).toHaveBeenCalledWith({ type: "following" }, 10, null, 0, undefined, "altaccount", expect.any(Set));
    expect(accounts).toHaveBeenCalledWith("researchers", 10, 0, "altaccount", expect.any(Set));
    expect(post).toHaveBeenCalledWith("12345", "post", 10, "altaccount");
    service.close();
  });

  it("binds direct continuation cursors to the source, query, account, and seen IDs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-direct-cursors-"));
    dirs.push(dir);
    const service = new XService(testConfig(dir));
    vi.spyOn(service.browser, "probeIdentity").mockResolvedValue({ connected: true, authenticated: true, handle: "AltAccount", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    const operation = { name: "Fixture", queryId: "fixture", method: "GET", path: "/fixture", sourcePage: "/fixture", lens: "top", capturedAt: new Date().toISOString(), parserVersion: 1, replayed: false, variableKeys: [], featureKeys: [], fieldToggleKeys: [] };
    const timeline = vi.spyOn(service.browser, "timeline")
      .mockResolvedValueOnce({ posts: [fixturePost("one"), fixturePost("two")], nextCursor: "more", warnings: [], operation })
      .mockResolvedValueOnce({ posts: [fixturePost("three")], nextCursor: null, warnings: [], operation });

    const first = await service.getTimeline({ type: "following" }, 2) as { nextCursor: string };
    expect(first.nextCursor).toMatch(/^d1:/);
    await service.getTimeline({ type: "following" }, 2, false, first.nextCursor);
    const secondCall = timeline.mock.calls[1] as unknown[];
    expect(secondCall[3]).toBe(0);
    expect([...(secondCall[6] as ReadonlySet<string>)]).toEqual(["one", "two"]);
    await expect(service.getTimeline({ type: "for_you" }, 2, false, first.nextCursor)).rejects.toMatchObject({ code: "INVALID_CURSOR" });

    const account = (id: string) => ({
      id, handle: `account_${id}`, displayName: null, url: `https://x.com/account_${id}`, description: null, location: null, websiteUrl: null,
      avatarUrl: null, bannerUrl: null, createdAt: null, verified: null, verificationType: null, followersCount: null, followingCount: null,
      postsCount: null, mediaCount: null, protected: null, possiblySensitive: null,
      provenance: { query: "researchers", retrievedAt: new Date().toISOString(), transport: "captured-operation" as const },
    });
    const accounts = vi.spyOn(service.browser, "searchAccounts")
      .mockResolvedValueOnce({ accounts: [account("a")], nextCursor: "more", warnings: [], operation })
      .mockResolvedValueOnce({ accounts: [account("b")], nextCursor: null, warnings: [], operation });
    const accountFirst = await service.searchAccounts("researchers", 1);
    expect(accountFirst.nextCursor).toMatch(/^d1:/);
    await service.searchAccounts("researchers", 1, accountFirst.nextCursor ?? undefined);
    expect([...((accounts.mock.calls[1] as unknown[])[4] as ReadonlySet<string>)]).toEqual(["a"]);
    await expect(service.searchAccounts("different", 1, accountFirst.nextCursor ?? undefined)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    service.close();
  });

  it("surfaces a requested live-probe failure instead of returning stale identity", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-live-probe-"));
    dirs.push(dir);
    const service = new XService(testConfig(dir));
    vi.spyOn(service.browser, "probeIdentity").mockRejectedValue(new Error("probe timed out"));
    await expect(service.status({ liveProbe: true })).rejects.toThrow(/probe timed out/i);
    service.close();
  });

  it("runs both Top and Latest in the persisted live canary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-canary-"));
    dirs.push(dir);
    const service = new XService(testConfig(dir));
    vi.spyOn(service.browser, "probeIdentity").mockResolvedValue({ connected: true, authenticated: true, handle: "AltAccount", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    const search = vi.spyOn(service.browser, "search").mockImplementation(async (_query, mode) => ({
      posts: [fixturePost(`canary-${mode}`, { provenance: { ...fixturePost("canary").provenance, lens: mode } })],
      nextCursor: null,
      warnings: [],
      operation: { name: "SearchTimeline", queryId: "fixture", method: "GET", path: "/fixture", sourcePage: "/search", lens: mode, capturedAt: new Date().toISOString(), parserVersion: 1, replayed: false, variableKeys: [], featureKeys: [], fieldToggleKeys: [] },
    }));
    const result = await service.canary();
    expect(search.mock.calls.map((call) => call[1]).sort()).toEqual(["latest", "top"]);
    expect(result).toMatchObject({ handle: "AltAccount", postCount: 2, lenses: ["latest", "top"] });
    expect(service.store.getSetting("last_live_canary")).toMatchObject({ runId: result.runId, lenses: ["latest", "top"] });
    service.close();
  });
});
