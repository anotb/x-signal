import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XService } from "../src/service.js";
import { testConfig } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("named Chrome session sources", () => {
  it("prevents periodic profile races and switches only on intentional activation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-session-source-"));
    dirs.push(dir);
    const service = new XService(testConfig(dir));
    const identity = { connected: true, authenticated: true, handle: "alternate", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null };
    const imported = vi.spyOn(service.browser, "importSession").mockResolvedValue({ applied: true, cookieCount: 1, identity });
    const cookies = [{ name: "auth_token", value: "fixture", domain: ".x.com", path: "/" }];
    const main = { id: "00000000-0000-4000-8000-000000000001", label: "Main X" };
    const alternate = { id: "00000000-0000-4000-8000-000000000002", label: "Alternate X" };

    const first = await service.syncSession(cookies, main);
    expect(first).toMatchObject({ applied: true, inactive: false, activeSource: main });
    expect(first.activeSource!.lastSyncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.activeSource!.lastAppliedAt).toBe(first.activeSource!.lastSyncedAt);
    await expect(service.syncSession(cookies, alternate)).resolves.toMatchObject({ applied: false, inactive: true, activeSource: main });
    expect(imported).toHaveBeenCalledTimes(1);
    await expect(service.syncSession(cookies, alternate, true)).resolves.toMatchObject({ applied: true, inactive: false, activeSource: alternate });
    expect(imported).toHaveBeenCalledTimes(2);
    expect(service.store.getSetting("active_session_source")).toMatchObject({ ...alternate, lastSyncedAt: expect.any(String), lastAppliedAt: expect.any(String) });
    service.close();
  });

  it("queues one intentional profile switch behind active research and completes it on automatic sync", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-session-source-active-"));
    dirs.push(dir);
    const service = new XService(testConfig(dir));
    const identity = { connected: true, authenticated: true, handle: "alternate", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null };
    const imported = vi.spyOn(service.browser, "importSession").mockResolvedValue({ applied: true, cookieCount: 1, identity });
    const cookies = [{ name: "auth_token", value: "fixture", domain: ".x.com", path: "/" }];
    const main = { id: "00000000-0000-4000-8000-000000000001", label: "Main X" };
    const alternate = { id: "00000000-0000-4000-8000-000000000002", label: "Alternate X" };
    await service.syncSession(cookies, main);
    const runId = service.store.createRun({ queries: [{ query: "active", mode: "latest", limit: 5 }], execution: "job" });

    await expect(service.syncSession(cookies, alternate, true)).resolves.toMatchObject({
      applied: false,
      deferred: true,
      pendingActivation: true,
      activeSource: main,
    });
    expect(imported).toHaveBeenCalledTimes(1);
    expect(service.store.getSetting("pending_session_source")).toMatchObject(alternate);
    await expect(service.syncSession(cookies, alternate)).resolves.toMatchObject({ deferred: true, pendingActivation: true, activeSource: main });
    service.store.cancelRun(runId);
    await expect(service.syncSession(cookies, alternate)).resolves.toMatchObject({ applied: true, activeSource: alternate });
    expect(imported).toHaveBeenCalledTimes(2);
    expect(service.store.getSetting("pending_session_source")).toBeNull();
    service.close();
  });

  it("keeps a queued profile selection across restart until its next automatic sync", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-session-source-restart-"));
    dirs.push(dir);
    const cookies = [{ name: "auth_token", value: "fixture", domain: ".x.com", path: "/" }];
    const main = { id: "00000000-0000-4000-8000-000000000001", label: "Main X" };
    const alternate = { id: "00000000-0000-4000-8000-000000000002", label: "Alternate X" };

    const first = new XService(testConfig(dir));
    vi.spyOn(first.browser, "importSession").mockResolvedValue({
      applied: true,
      cookieCount: 1,
      identity: { connected: true, authenticated: true, handle: "main", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null },
    });
    await first.syncSession(cookies, main);
    first.store.createRun({ queries: [{ query: "active", mode: "latest", limit: 5 }], execution: "job" });
    await expect(first.syncSession(cookies, alternate, true)).resolves.toMatchObject({ deferred: true, pendingActivation: true });
    first.close();

    const restarted = new XService(testConfig(dir));
    vi.spyOn(restarted.browser, "importSession").mockResolvedValue({
      applied: true,
      cookieCount: 1,
      identity: { connected: true, authenticated: true, handle: "alternate", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null },
    });
    restarted.store.cancelRun(restarted.store.listActiveRuns()[0]!.id);
    await expect(restarted.syncSession(cookies, alternate)).resolves.toMatchObject({ applied: true, activeSource: alternate });
    expect(restarted.store.getSetting("pending_session_source")).toBeNull();
    restarted.close();
  });

  it("defers a same-profile cookie change until active research settles", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-session-source-deferred-"));
    dirs.push(dir);
    const service = new XService(testConfig(dir));
    const identity = { connected: true, authenticated: true, handle: "main", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null };
    const imported = vi.spyOn(service.browser, "importSession").mockResolvedValue({ applied: true, cookieCount: 1, identity });
    const source = { id: "00000000-0000-4000-8000-000000000001", label: "Main X" };
    const firstCookies = [{ name: "auth_token", value: "first", domain: ".x.com", path: "/" }];
    await service.syncSession(firstCookies, source);
    const runId = service.store.createRun({ queries: [{ query: "active", mode: "latest", limit: 5 }], execution: "job" });
    const changedCookies = [{ name: "auth_token", value: "second", domain: ".x.com", path: "/" }];
    await expect(service.syncSession(changedCookies, source)).resolves.toMatchObject({ applied: false, inactive: false, deferred: true, activeSource: source });
    expect(imported).toHaveBeenCalledTimes(1);
    service.store.cancelRun(runId);
    await expect(service.syncSession(changedCookies, source)).resolves.toMatchObject({ applied: true, activeSource: source });
    expect(imported).toHaveBeenCalledTimes(2);
    service.close();
  });

  it("serializes activation so an older periodic refresh cannot undo it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-signal-session-source-atomic-"));
    dirs.push(dir);
    const service = new XService(testConfig(dir));
    const cookies = [{ name: "auth_token", value: "fixture", domain: ".x.com", path: "/" }];
    const main = { id: "00000000-0000-4000-8000-000000000001", label: "Main X" };
    const alternate = { id: "00000000-0000-4000-8000-000000000002", label: "Alternate X" };
    const identity = (handle: string) => ({ connected: true, authenticated: true, handle, lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null });
    const imported: string[] = [];
    let releaseAlternate!: () => void;
    const alternateBlocked = new Promise<void>((resolve) => { releaseAlternate = resolve; });
    vi.spyOn(service.browser, "importSession").mockImplementation(async () => {
      const active = service.store.getSetting<{ id: string }>("active_session_source");
      if (active?.id === main.id && imported.length === 1) await alternateBlocked;
      const handle = imported.length === 0 ? "main" : "alternate";
      imported.push(handle);
      return { applied: true, cookieCount: 1, identity: identity(handle) };
    });
    await service.syncSession(cookies, main);
    const activation = service.syncSession(cookies, alternate, true);
    await vi.waitFor(() => expect(imported).toHaveLength(1));
    const stalePeriodic = service.syncSession(cookies, main);
    releaseAlternate();
    await expect(activation).resolves.toMatchObject({ activeSource: alternate });
    await expect(stalePeriodic).resolves.toMatchObject({ applied: false, inactive: true, activeSource: alternate });
    expect(imported).toEqual(["main", "alternate"]);
    expect(service.store.getSetting("active_session_source")).toMatchObject(alternate);
    service.close();
  });
});
