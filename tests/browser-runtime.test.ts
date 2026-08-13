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

  it("coalesces concurrent identity probes and parks the authenticated tab", async () => {
    const browser = new XBrowser(testConfig("."), () => undefined);
    let currentUrl = "https://x.com/home";
    const navigations: string[] = [];
    let closed = false;
    let closeListener: () => void = () => undefined;
    const page = {
      bringToFront: async () => undefined,
      goto: async (url: string) => { navigations.push(url); currentUrl = url; await Promise.resolve(); },
      waitForTimeout: async () => undefined,
      url: () => currentUrl,
      isClosed: () => closed,
      once: (_event: "close", listener: () => void) => { closeListener = listener; },
      close: async () => { closed = true; closeListener(); },
      getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
      locator: () => ({ first: () => ({ getAttribute: async () => "/fixture_account" }) }),
    };
    const connectedBrowser = { isConnected: () => true };
    const context = { pages: () => [page], newPage: async () => page };
    const internal = browser as unknown as {
      browser: typeof connectedBrowser;
      context: typeof context;
      connect(): Promise<typeof context>;
    };
    internal.browser = connectedBrowser;
    internal.context = context;
    internal.connect = async () => context;
    const [one, two] = await Promise.all([browser.probeIdentity(true), browser.probeIdentity(true)]);
    expect(navigations).toEqual(["https://x.com/home", "about:blank"]);
    expect(one.handle).toBe("fixture_account");
    expect(two).toEqual(one);
  });

  it("reuses the parked tab and makes a challenge authoritative over a profile link", async () => {
    const browser = new XBrowser(testConfig("."), () => undefined);
    let currentUrl = "about:blank";
    const navigations: string[] = [];
    let newPages = 0;
    let closed = false;
    let closeListener: () => void = () => undefined;
    const page = {
      bringToFront: async () => undefined,
      goto: async (url: string) => { navigations.push(url); currentUrl = url; },
      waitForTimeout: async () => undefined,
      url: () => currentUrl,
      isClosed: () => closed,
      once: (_event: "close", listener: () => void) => { closeListener = listener; },
      close: async () => { closed = true; closeListener(); },
      getByText: () => ({ first: () => ({ isVisible: async () => true }) }),
      locator: () => ({ first: () => ({ getAttribute: async () => "/fixture_account" }) }),
    };
    const internal = browser as unknown as { connect(): Promise<{ pages(): typeof page[]; newPage(): Promise<typeof page> }> };
    internal.connect = async () => ({
      pages: () => [page],
      newPage: async () => { newPages += 1; return page; },
    });

    const identity = await browser.probeIdentity(true);

    expect(identity.authenticated).toBe(false);
    expect(identity.challenge).toBe(true);
    expect(identity.remediation).toMatch(/challenge/i);
    expect(navigations).toEqual(["https://x.com/home"]);
    expect(newPages).toBe(0);
  });

  it("navigates only the explicitly owned identity page when another X page exists", async () => {
    const browser = new XBrowser(testConfig("."), () => undefined);
    const identityNavigations: string[] = [];
    const captureNavigations: string[] = [];
    let identityUrl = "about:blank";
    let identityClosed = false;
    let identityCloseListener: () => void = () => undefined;
    const identityPage = {
      bringToFront: async () => undefined,
      goto: async (url: string) => { identityNavigations.push(url); identityUrl = url; },
      waitForTimeout: async () => undefined,
      url: () => identityUrl,
      isClosed: () => identityClosed,
      once: (_event: "close", listener: () => void) => { identityCloseListener = listener; },
      close: async () => { identityClosed = true; identityCloseListener(); },
      getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
      locator: () => ({ first: () => ({ getAttribute: async () => "/fixture_account" }) }),
    };
    const capturePage = {
      ...identityPage,
      goto: async (url: string) => { captureNavigations.push(url); },
      url: () => "https://x.com/search?q=fixture",
    };
    const connectedBrowser = { isConnected: () => true };
    const internal = browser as unknown as {
      browser: typeof connectedBrowser;
      context: unknown;
      identityPage: typeof identityPage;
      connect(): Promise<{ pages(): Array<typeof identityPage | typeof capturePage>; newPage(): Promise<typeof identityPage> }>;
    };
    const context = { pages: () => [capturePage, identityPage], newPage: async () => identityPage };
    internal.browser = connectedBrowser;
    internal.context = context;
    internal.identityPage = identityPage;
    internal.connect = async () => context;

    const identity = await browser.probeIdentity(true);

    expect(identity.authenticated).toBe(true);
    expect(identityNavigations).toEqual(["https://x.com/home", "about:blank"]);
    expect(captureNavigations).toEqual([]);
  });

  it("keeps a login redirect from a capture as the single visible recovery page", async () => {
    const browser = new XBrowser(testConfig("."), () => undefined);
    let oldClosed = false;
    const oldPage = {
      url: () => "about:blank",
      isClosed: () => oldClosed,
      close: async () => { oldClosed = true; },
    };
    let currentUrl = "about:blank";
    let captureClosed = false;
    let broughtToFront = false;
    let closeListener: () => void = () => undefined;
    const capturePage = {
      waitForResponse: async () => { await Promise.resolve(); throw new Error("response timed out"); },
      goto: async () => { currentUrl = "https://x.com/i/flow/login"; },
      url: () => currentUrl,
      isClosed: () => captureClosed,
      once: (_event: "close", listener: () => void) => { closeListener = listener; },
      close: async () => { captureClosed = true; closeListener(); },
      bringToFront: async () => { broughtToFront = true; },
    };
    const internal = browser as unknown as {
      identityPage: typeof oldPage | typeof capturePage | null;
      connect(): Promise<{ newPage(): Promise<typeof capturePage> }>;
      captureItems<T extends { id: string }>(
        options: { targetUrl: string; operationNames: string[]; lens: "latest"; limit: number },
        parse: (payload: unknown) => { items: T[]; bottomCursor: string | null; warnings: string[] },
      ): Promise<unknown>;
    };
    internal.identityPage = oldPage;
    internal.connect = async () => ({ newPage: async () => capturePage });

    await expect(internal.captureItems(
      { targetUrl: "https://x.com/search?q=fixture", operationNames: ["SearchTimeline"], lens: "latest", limit: 1 },
      () => ({ items: [], bottomCursor: null, warnings: [] }),
    )).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });

    expect(oldClosed).toBe(true);
    expect(captureClosed).toBe(false);
    expect(broughtToFront).toBe(true);
    expect(internal.identityPage).toBe(capturePage);
    expect(browser.status()).toMatchObject({ authenticated: false, challenge: false });
  });

  it("turns an HTTP authentication failure into a visible recovery page", async () => {
    const browser = new XBrowser(testConfig("."), () => undefined);
    const response = {
      url: () => "https://x.com/i/api/graphql/fixture/SearchTimeline?variables=%7B%7D",
      status: () => 401,
      headers: () => ({}),
      json: async () => ({ data: "unreachable" }),
    };
    let currentUrl = "about:blank";
    const navigations: string[] = [];
    let closed = false;
    let broughtToFront = false;
    let closeListener: () => void = () => undefined;
    const page = {
      waitForResponse: async () => response,
      goto: async (url: string) => { navigations.push(url); currentUrl = url; },
      url: () => currentUrl,
      isClosed: () => closed,
      once: (_event: "close", listener: () => void) => { closeListener = listener; },
      close: async () => { closed = true; closeListener(); },
      bringToFront: async () => { broughtToFront = true; },
    };
    const internal = browser as unknown as {
      identityPage: typeof page | null;
      connect(): Promise<{ newPage(): Promise<typeof page> }>;
      captureItems<T extends { id: string }>(
        options: { targetUrl: string; operationNames: string[]; lens: "latest"; limit: number },
        parse: (payload: unknown) => { items: T[]; bottomCursor: string | null; warnings: string[] },
      ): Promise<unknown>;
    };
    internal.connect = async () => ({ newPage: async () => page });

    await expect(internal.captureItems(
      { targetUrl: "https://x.com/search?q=fixture", operationNames: ["SearchTimeline"], lens: "latest", limit: 1 },
      () => ({ items: [], bottomCursor: null, warnings: [] }),
    )).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });

    expect(navigations).toEqual(["https://x.com/search?q=fixture", "https://x.com/home"]);
    expect(closed).toBe(false);
    expect(broughtToFront).toBe(true);
    expect(internal.identityPage).toBe(page);
    expect(browser.status()).toMatchObject({ authenticated: false, handle: null });
  });

  it("fails closed and discards the owned page when idle parking fails", async () => {
    const browser = new XBrowser(testConfig("."), () => undefined);
    let currentUrl = "about:blank";
    let closed = false;
    let closeListener: () => void = () => undefined;
    const page = {
      bringToFront: async () => undefined,
      goto: async (url: string) => {
        if (url === "about:blank" && currentUrl !== "about:blank") throw new Error("parking failed");
        currentUrl = url;
      },
      waitForTimeout: async () => undefined,
      url: () => currentUrl,
      isClosed: () => closed,
      once: (_event: "close", listener: () => void) => { closeListener = listener; },
      close: async () => { closed = true; closeListener(); },
      getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
      locator: () => ({ first: () => ({ getAttribute: async () => "/fixture_account" }) }),
    };
    const connectedBrowser = { isConnected: () => true };
    const internal = browser as unknown as {
      browser: typeof connectedBrowser;
      identityPage: typeof page | null;
      connect(): Promise<{ pages(): typeof page[]; newPage(): Promise<typeof page> }>;
    };
    internal.browser = connectedBrowser;
    internal.connect = async () => ({ pages: () => [page], newPage: async () => page });

    await expect(browser.probeIdentity(true)).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

    expect(closed).toBe(true);
    expect(internal.identityPage).toBeNull();
    expect(browser.status()).toMatchObject({ connected: true, authenticated: null, handle: null, lastCheckedAt: null });
  });

  it("invalidates cached identity on disconnect and probes the replacement context", async () => {
    const browser = new XBrowser(testConfig("."), () => undefined);
    const disconnectedBrowser = { isConnected: () => false };
    const connectedBrowser = { isConnected: () => true };
    let currentUrl = "about:blank";
    const navigations: string[] = [];
    let closed = false;
    let closeListener: () => void = () => undefined;
    const page = {
      bringToFront: async () => undefined,
      goto: async (url: string) => { navigations.push(url); currentUrl = url; },
      waitForTimeout: async () => undefined,
      url: () => currentUrl,
      isClosed: () => closed,
      once: (_event: "close", listener: () => void) => { closeListener = listener; },
      close: async () => { closed = true; closeListener(); },
      getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
      locator: () => ({ first: () => ({ getAttribute: async () => "/replacement_account" }) }),
    };
    const context = { pages: () => [page], newPage: async () => page };
    const internal = browser as unknown as {
      browser: typeof disconnectedBrowser | typeof connectedBrowser | null;
      context: typeof context | null;
      identityPage: typeof page | null;
      identity: ReturnType<XBrowser["status"]>;
      handleBrowserDisconnect(source: typeof disconnectedBrowser): void;
      connect(): Promise<typeof context>;
    };
    internal.browser = disconnectedBrowser;
    internal.context = context;
    internal.identityPage = page;
    internal.identity = { connected: true, authenticated: true, handle: "old_account", lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null };
    internal.handleBrowserDisconnect(disconnectedBrowser);
    expect(browser.status()).toMatchObject({ connected: false, authenticated: null, handle: null, lastCheckedAt: null });
    internal.connect = async () => { internal.browser = connectedBrowser; internal.context = context; return context; };

    const identity = await browser.probeIdentity();

    expect(identity).toMatchObject({ connected: true, authenticated: true, handle: "replacement_account" });
    expect(navigations).toEqual(["https://x.com/home", "about:blank"]);
  });

  it("never exceeds the configured browser concurrency", async () => {
    const config = { ...testConfig("."), maxBrowserConcurrency: 1 };
    const browser = new XBrowser(config, () => undefined);
    const internal = browser as unknown as { semaphore: { use<T>(work: () => Promise<T>): Promise<T> } };
    let active = 0;
    let maximum = 0;

    await Promise.all(Array.from({ length: 40 }, () => internal.semaphore.use(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
    })));

    expect(maximum).toBe(1);
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
