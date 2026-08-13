import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright-core";
import { lookup } from "node:dns/promises";
import type { Config } from "../config.js";
import type { Lens, ProvenanceContext, XAccount, XPost } from "../contracts.js";
import { XSignalError, toXSignalError } from "../errors.js";
import { safeLog } from "../redaction.js";
import { normalizeSessionCookies, sessionDigest, type SessionCookieInput } from "../session.js";
import { parseAccountTimeline, parseTimeline } from "./parser.js";
import { accountSearchUrl, normalizeHandle, normalizePostId, searchUrl } from "./query.js";

type OperationCapture = {
  name: string;
  queryId: string;
  method: string;
  path: string;
  sourcePage: string;
  lens: string;
  capturedAt: string;
  parserVersion: number;
  replayed: boolean;
  variableKeys: string[];
  featureKeys: string[];
  fieldToggleKeys: string[];
};

export type BrowserRead = {
  posts: XPost[];
  nextCursor: string | null;
  warnings: string[];
  operation: OperationCapture;
};

export type BrowserAccountRead = {
  accounts: XAccount[];
  nextCursor: string | null;
  warnings: string[];
  operation: OperationCapture;
};

export type BrowserIdentity = {
  connected: boolean;
  authenticated: boolean | null;
  handle: string | null;
  lastCheckedAt: string | null;
  challenge: boolean;
  remediation: string | null;
};

export type RateControlStatus = {
  limited: boolean;
  retryAt: string | null;
  retryAfterMs: number;
  requestSpacingMs: number;
  maxConcurrency: number;
  recoveryMode: boolean;
};

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async use<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

class ReadWriteGate {
  private readers = 0;
  private writer = false;
  private readonly queue: Array<{ type: "read" | "write"; start: () => void }> = [];

  async read<T>(work: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      const start = () => { this.readers += 1; resolve(); };
      if (!this.writer && !this.queue.some((item) => item.type === "write")) start();
      else this.queue.push({ type: "read", start });
    });
    try { return await work(); }
    finally { this.readers -= 1; this.drain(); }
  }

  async write<T>(work: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      const start = () => { this.writer = true; resolve(); };
      if (!this.writer && this.readers === 0 && this.queue.length === 0) start();
      else this.queue.push({ type: "write", start });
    });
    try { return await work(); }
    finally { this.writer = false; this.drain(); }
  }

  private drain(): void {
    if (this.writer || this.readers > 0 && this.queue[0]?.type === "write") return;
    const first = this.queue[0];
    if (!first) return;
    if (first.type === "write") {
      this.queue.shift()!.start();
      return;
    }
    while (this.queue[0]?.type === "read") this.queue.shift()!.start();
  }
}

type CaptureOptions = {
  targetUrl: string;
  operationNames: string[];
  lens: Lens;
  query?: string | null;
  queryLabel?: string | null;
  runId?: string | null;
  limit: number;
  skipIds?: ReadonlySet<string>;
  skipCount?: number;
  action?: (page: Page) => Promise<void>;
  shouldContinue?: () => boolean;
  profile?: string | null;
  expectedAccount?: string | null;
  onProgress?: (posts: XPost[]) => void;
};

type ParsedItems<T> = { items: T[]; bottomCursor: string | null; warnings: string[] };
type CapturedItems<T> = { items: T[]; nextCursor: string | null; warnings: string[]; operation: OperationCapture };

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 32;

export class XBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private identityProbe: Promise<BrowserIdentity> | null = null;
  private readonly semaphore: Semaphore;
  private readonly sessionGate = new ReadWriteGate();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly activeRunPages = new Map<string, Set<Page>>();
  private lastImportedSessionDigest: string | null = null;
  private sessionEpoch = randomEpoch();
  private dispatchTail: Promise<void> = Promise.resolve();
  private lastDispatchAt = 0;
  private backoffUntil = 0;
  private currentSpacingMs: number;
  private recoveringFromRateLimit: boolean;
  private recoverySuccesses = 0;
  private consecutiveRateLimits = 0;
  private identity: BrowserIdentity = {
    connected: false,
    authenticated: null,
    handle: null,
    lastCheckedAt: null,
    challenge: false,
    remediation: "Start the browser sidecar, then sign into X through noVNC.",
  };

  constructor(
    private readonly config: Config,
    private readonly onOperation: (operation: OperationCapture) => void,
    rateState: { initialBackoffUntil?: number; onBackoff?: (retryAt: string) => void } = {},
  ) {
    this.semaphore = new Semaphore(config.maxBrowserConcurrency);
    this.currentSpacingMs = config.requestSpacingMs;
    this.backoffUntil = Math.max(0, rateState.initialBackoffUntil ?? 0);
    this.recoveringFromRateLimit = this.backoffUntil > Date.now();
    this.onBackoff = rateState.onBackoff ?? (() => undefined);
  }

  private readonly onBackoff: (retryAt: string) => void;

  status(): BrowserIdentity {
    return { ...this.identity };
  }

  cacheScope(): string {
    return this.sessionEpoch;
  }

  rateControlStatus(): RateControlStatus {
    const now = Date.now();
    const limited = this.backoffUntil > now;
    return {
      limited,
      retryAt: limited ? new Date(this.backoffUntil).toISOString() : null,
      retryAfterMs: limited ? this.backoffUntil - now : 0,
      requestSpacingMs: this.currentSpacingMs,
      maxConcurrency: this.config.maxBrowserConcurrency,
      recoveryMode: this.recoveringFromRateLimit,
    };
  }

  recommendedConcurrency(): number {
    return this.recoveringFromRateLimit ? 1 : this.config.maxBrowserConcurrency;
  }

  async cancelRun(runId: string): Promise<number> {
    const pages = [...(this.activeRunPages.get(runId) ?? [])];
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    return pages.length;
  }

  async importSession(input: SessionCookieInput[]): Promise<{ applied: boolean; cookieCount: number; identity: BrowserIdentity }> {
    const cookies = normalizeSessionCookies(input);
    const digest = sessionDigest(cookies);
    if (digest === this.lastImportedSessionDigest) {
      return { applied: false, cookieCount: cookies.length, identity: this.status() };
    }
    await this.sessionGate.write(async () => {
      const context = await this.connect();
      await context.clearCookies({ domain: /(?:^|\.)((?:x)|(?:twitter))\.com$/i });
      if (cookies.length) await context.addCookies(cookies);
      this.sessionEpoch = randomEpoch();
      this.cache.clear();
    });
    this.lastImportedSessionDigest = digest;
    this.identity = { ...this.identity, authenticated: null, handle: null, lastCheckedAt: null, challenge: false, remediation: null };
    const identity = await this.probeIdentity(true);
    safeLog("session_sync_applied", { cookieCount: cookies.length, authenticated: identity.authenticated, handle: identity.handle });
    return { applied: true, cookieCount: cookies.length, identity };
  }

  sessionWouldChange(input: SessionCookieInput[]): boolean {
    return sessionDigest(normalizeSessionCookies(input)) !== this.lastImportedSessionDigest;
  }

  private async connect(): Promise<BrowserContext> {
    if (this.browser?.isConnected() && this.context) return this.context;
    try {
      const endpoint = await resolveCdpEndpoint(this.config.browserCdpUrl);
      this.browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
      this.context = this.browser.contexts()[0] ?? null;
      if (!this.context) throw new Error("CDP browser did not expose its persistent context");
      this.identity = { ...this.identity, connected: true, remediation: null };
      this.browser.on("disconnected", () => {
        this.browser = null;
        this.context = null;
        this.identity = { ...this.identity, connected: false, remediation: "Restart or inspect the browser sidecar." };
      });
      safeLog("browser_attached", { endpoint: new URL(this.config.browserCdpUrl).origin });
      return this.context;
    } catch (error) {
      this.browser = null;
      this.context = null;
      this.identity = { ...this.identity, connected: false, remediation: "Run `docker compose up -d browser` and inspect its health." };
      throw toXSignalError(error);
    }
  }

  async probeIdentity(force = false): Promise<BrowserIdentity> {
    if (!force && this.identity.lastCheckedAt && Date.now() - Date.parse(this.identity.lastCheckedAt) < 5 * 60_000) return this.status();
    if (this.identityProbe) return this.identityProbe;
    const probe = this.sessionGate.read(() => this.semaphore.use(async () => {
      const context = await this.connect();
      const page = context.pages().find((candidate) => candidate.url().startsWith("https://x.com/")) ?? await context.newPage();
      await page.bringToFront();
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1_500);
      const url = page.url();
      const challenge = /\/account\/access|\/i\/flow\/login|challenge/i.test(url)
        || await page.getByText(/verify your identity|unusual activity|authenticate your account/i).first().isVisible().catch(() => false);
      const href = await page.locator('a[data-testid="AppTabBar_Profile_Link"]').first().getAttribute("href").catch(() => null);
      const handle = href && /^\/[A-Za-z0-9_]+$/.test(href) ? href.slice(1) : null;
      const authenticated = handle !== null;
      const previousHandle = this.identity.handle;
      const identityWasPreviouslyChecked = this.identity.lastCheckedAt !== null;
      this.identity = {
        connected: true,
        authenticated,
        handle,
        lastCheckedAt: new Date().toISOString(),
        challenge,
        remediation: authenticated ? null : challenge
          ? "Resolve the visible X account challenge through noVNC; X Signal does not bypass challenges."
          : "Open noVNC at http://127.0.0.1:6080/vnc.html and sign into X in the persistent browser.",
      };
      if (identityWasPreviouslyChecked && (previousHandle ?? "").toLowerCase() !== (handle ?? "").toLowerCase()) {
        this.sessionEpoch = randomEpoch();
        this.cache.clear();
      }
      return this.status();
    }));
    this.identityProbe = probe;
    try {
      return await probe;
    } finally {
      if (this.identityProbe === probe) this.identityProbe = null;
    }
  }

  async search(query: string, mode: "top" | "latest" | "media", limit: number, options: { label?: string; runId?: string; skipPostIds?: ReadonlySet<string>; shouldContinue?: () => boolean; expectedAccount?: string; onProgress?: (posts: XPost[]) => void } = {}): Promise<BrowserRead> {
    const skipKey = continuationKey(options.skipPostIds);
    const key = `search:${this.sessionEpoch}:${mode}:${query}:${limit}:${skipKey}:${options.label ?? ""}:${options.runId ?? ""}`;
    return this.coalesced(key, () => this.capture({
      targetUrl: searchUrl(query, mode),
      operationNames: ["SearchTimeline"],
      lens: mode,
      query,
      queryLabel: options.label ?? null,
      runId: options.runId ?? null,
      limit,
      skipIds: options.skipPostIds,
      shouldContinue: options.shouldContinue,
      profile: options.expectedAccount ?? this.identity.handle,
      expectedAccount: options.expectedAccount,
      onProgress: options.onProgress,
    }));
  }

  async searchAccounts(query: string, limit: number, skipCount = 0, expectedAccount?: string, skipIds?: ReadonlySet<string>): Promise<BrowserAccountRead> {
    const skipKey = continuationKey(skipIds);
    const key = `accounts:${this.sessionEpoch}:${query}:${limit}:${skipCount}:${skipKey}:${expectedAccount ?? ""}`;
    return this.coalesced(key, () => this.captureAccounts({
      targetUrl: accountSearchUrl(query),
      operationNames: ["SearchTimeline"],
      lens: "people",
      query,
      limit,
      skipCount,
      skipIds,
      profile: expectedAccount ?? this.identity.handle,
      expectedAccount,
    }));
  }

  async timeline(
    source: { type: string; handle?: string; id?: string },
    limit: number,
    runId?: string | null,
    skipCount?: number,
    shouldContinue?: () => boolean,
    expectedAccount?: string,
    onProgress?: (posts: XPost[]) => void,
  ): Promise<BrowserRead>;
  async timeline(
    source: { type: string; handle?: string; id?: string },
    limit: number,
    runId?: string | null,
    skipCount?: number,
    shouldContinue?: () => boolean,
    expectedAccount?: string,
    skipIds?: ReadonlySet<string>,
    onProgress?: (posts: XPost[]) => void,
  ): Promise<BrowserRead>;
  async timeline(
    source: { type: string; handle?: string; id?: string },
    limit: number,
    runId: string | null = null,
    skipCount = 0,
    shouldContinue?: () => boolean,
    expectedAccount?: string,
    skipIdsOrProgress?: ReadonlySet<string> | ((posts: XPost[]) => void),
    nextProgress?: (posts: XPost[]) => void,
  ): Promise<BrowserRead> {
    const skipIds = typeof skipIdsOrProgress === "function" ? undefined : skipIdsOrProgress;
    const onProgress = typeof skipIdsOrProgress === "function" ? skipIdsOrProgress : nextProgress;
    const skipKey = continuationKey(skipIds);
    if (source.type === "user") {
      const handle = normalizeHandle(source.handle ?? "");
      if (!handle) throw new XSignalError("NOT_FOUND", "A valid X handle is required for a user timeline.");
      return this.coalesced(`user:${this.sessionEpoch}:${handle}:${limit}:${skipCount}:${skipKey}:${runId ?? ""}`, () => this.capture({
        targetUrl: `https://x.com/${encodeURIComponent(handle)}`,
        operationNames: ["UserTweets"],
        lens: "user",
        query: `@${handle}`,
        runId,
        limit,
        skipCount,
        skipIds,
        shouldContinue,
        profile: expectedAccount ?? this.identity.handle,
        expectedAccount,
        onProgress,
      }));
    }
    if (source.type === "bookmarks") {
      return this.coalesced(`bookmarks:${this.sessionEpoch}:${limit}:${skipCount}:${skipKey}:${runId ?? ""}`, () => this.capture({
        targetUrl: "https://x.com/i/bookmarks",
        operationNames: ["Bookmarks"],
        lens: "bookmarks",
        runId,
        limit,
        skipCount,
        skipIds,
        shouldContinue,
        profile: expectedAccount ?? this.identity.handle,
        expectedAccount,
        onProgress,
      }));
    }
    if (source.type === "following" || source.type === "for_you") {
      const following = source.type === "following";
      return this.coalesced(`home:${this.sessionEpoch}:${source.type}:${limit}:${skipCount}:${skipKey}:${runId ?? ""}`, () => this.capture({
        targetUrl: "https://x.com/home",
        operationNames: following ? ["HomeLatestTimeline"] : ["HomeTimeline"],
        lens: following ? "following" : "for_you",
        runId,
        limit,
        skipCount,
        skipIds,
        shouldContinue,
        profile: expectedAccount ?? this.identity.handle,
        expectedAccount,
        onProgress,
        action: async (page) => {
          const label = following ? /^Following$/i : /^For you$/i;
          const tab = page.getByRole("tab", { name: label }).first();
          await tab.waitFor({ state: "visible", timeout: 15_000 });
          await tab.click();
        },
      }));
    }
    if (source.type === "list") {
      const id = normalizeNumericId(source.id, "list");
      return this.coalesced(`list:${this.sessionEpoch}:${id}:${limit}:${skipCount}:${skipKey}:${runId ?? ""}`, () => this.capture({
        targetUrl: `https://x.com/i/lists/${id}`,
        operationNames: ["ListLatestTweetsTimeline"],
        lens: "list",
        query: `list:${id}`,
        runId,
        limit,
        skipCount,
        skipIds,
        shouldContinue,
        profile: expectedAccount ?? this.identity.handle,
        expectedAccount,
        onProgress,
      }));
    }
    if (source.type === "community") {
      const id = normalizeNumericId(source.id, "community");
      return this.coalesced(`community:${this.sessionEpoch}:${id}:${limit}:${skipCount}:${skipKey}:${runId ?? ""}`, () => this.capture({
        targetUrl: `https://x.com/i/communities/${id}`,
        operationNames: ["CommunityTweetsTimeline"],
        lens: "community",
        query: `community:${id}`,
        runId,
        limit,
        skipCount,
        skipIds,
        shouldContinue,
        profile: expectedAccount ?? this.identity.handle,
        expectedAccount,
        onProgress,
      }));
    }
    throw new XSignalError("CAPABILITY_UNAVAILABLE", `Timeline source '${source.type}' has no current captured operation.`, {
      remediation: "Use following, for_you, user, bookmarks, list, or community.",
    });
  }

  async post(value: string, context: "post" | "thread" | "replies" | "quotes" | "all", limit: number, expectedAccount?: string): Promise<{ primary: XPost; thread: XPost[]; replies: XPost[]; quotes: XPost[]; warnings: string[] }> {
    const id = normalizePostId(value);
    if (!/^\d{5,}$/.test(id)) throw new XSignalError("NOT_FOUND", "Provide an X post URL or numeric post ID.");
    const base = await this.coalesced(`post:${this.sessionEpoch}:${id}:${limit}:${expectedAccount ?? ""}`, () => this.capture({
      targetUrl: `https://x.com/i/status/${id}`,
      operationNames: ["TweetDetail"],
      lens: "post",
      limit,
      profile: expectedAccount ?? this.identity.handle,
      expectedAccount,
    }));
    const primary = base.posts.find((post) => post.id === id);
    if (!primary) throw new XSignalError("NOT_FOUND", `X returned no readable post with ID ${id}.`);
    const sameConversation = base.posts.filter((post) => post.conversationId === primary.conversationId && post.id !== id);
    const thread = sameConversation.filter((post) => post.author.id === primary.author.id).sort(byCreatedAt);
    const replies = sameConversation.filter((post) => post.author.id !== primary.author.id).sort(byEngagement).slice(0, limit);
    let quotes: XPost[] = [];
    const warnings = [...base.warnings];
    if (context === "quotes" || context === "all") {
      try {
        const quoteRead = await this.capture({
          targetUrl: `https://x.com/i/status/${id}/quotes`,
          operationNames: ["QuoteTweets", "SearchTimeline"],
          lens: "quotes",
          limit,
          profile: expectedAccount ?? this.identity.handle,
          expectedAccount,
        });
        quotes = quoteRead.posts.filter((post) => post.quotedPost ? post.quotedPost.id === id : post.flags.quote).sort(byEngagement).slice(0, limit);
        warnings.push(...quoteRead.warnings);
      } catch (error) {
        warnings.push(`Quote-post context unavailable: ${toXSignalError(error).code}.`);
      }
    }
    return {
      primary,
      thread: context === "post" || context === "replies" || context === "quotes" ? [] : thread,
      replies: context === "post" || context === "thread" || context === "quotes" ? [] : replies,
      quotes: context === "post" || context === "thread" || context === "replies" ? [] : quotes,
      warnings,
    };
  }

  private async coalesced<T>(key: string, work: () => Promise<T>): Promise<T> {
    const now = Date.now();
    this.evictExpiredCache(now);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return structuredClone(cached.value) as T;
    }
    const active = this.inFlight.get(key) as Promise<T> | undefined;
    if (active) return structuredClone(await active);
    const promise = work().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    const result = await promise;
    this.cache.delete(key);
    this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: result });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return structuredClone(result);
  }

  private evictExpiredCache(now = Date.now()): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }

  private async capture(options: CaptureOptions): Promise<BrowserRead> {
    const captured = await this.captureItems(options, (payload) => {
      const parsed = parseTimeline(payload, provenance(options));
      return { items: parsed.posts, bottomCursor: parsed.bottomCursor, warnings: parsed.warnings };
    });
    return { posts: captured.items, nextCursor: captured.nextCursor, warnings: captured.warnings, operation: captured.operation };
  }

  private async captureAccounts(options: CaptureOptions): Promise<BrowserAccountRead> {
    const captured = await this.captureItems(options, (payload) => {
      const parsed = parseAccountTimeline(payload, options.query ?? "");
      return { items: parsed.accounts, bottomCursor: parsed.bottomCursor, warnings: parsed.warnings };
    });
    return { accounts: captured.items, nextCursor: captured.nextCursor, warnings: captured.warnings, operation: captured.operation };
  }

  private async captureItems<T extends { id: string }>(options: CaptureOptions, parse: (payload: unknown) => ParsedItems<T>): Promise<CapturedItems<T>> {
    return this.sessionGate.read(() => this.semaphore.use(async () => {
      if (options.shouldContinue && !options.shouldContinue()) throw new XSignalError("CANCELLED", "The run was cancelled before browser dispatch.");
      await this.beforeDispatch();
      if (options.shouldContinue && !options.shouldContinue()) throw new XSignalError("CANCELLED", "The run was cancelled before browser navigation.");
      const context = await this.connect();
      const page = await context.newPage();
      if (options.runId) {
        const pages = this.activeRunPages.get(options.runId) ?? new Set<Page>();
        pages.add(page);
        this.activeRunPages.set(options.runId, pages);
      }
      const payloads: unknown[] = [];
      const captureWarnings: string[] = [];
      try {
        const responsePromise = page.waitForResponse(
          (response) => options.operationNames.some((name) => operationName(response.url()) === name),
          { timeout: 35_000 },
        );
        if (options.action) {
          await page.goto(options.targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await options.action(page);
        } else {
          await page.goto(options.targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        }
        const firstResponse = await responsePromise;
        this.assertReadablePage(page);
        if (options.expectedAccount) await this.assertExpectedAccount(page, options.expectedAccount);
        const first = await this.readJson(firstResponse);
        payloads.push(first);

        const meta = operationMeta(firstResponse, options);
        this.onOperation(meta);

        const parsedPages = payloads.map(parse);
        let cursor = parsedPages[0]?.bottomCursor ?? null;
        let attempts = 0;
        let stagnantAttempts = 0;
        const skipCount = Math.max(0, options.skipCount ?? 0);
        const skipIds = options.skipIds ?? new Set<string>();
        const soughtDepth = skipCount + skipIds.size + options.limit;
        const maxAttempts = Math.max(4, Math.ceil(soughtDepth / 15) + 4);
        const allUnique = () => [...new Map(parsedPages.flatMap((pageResult) => pageResult.items).map((item) => [item.id, item])).values()];
        const selected = () => selectCaptureWindow(allUnique(), skipIds, skipCount, options.limit);
        if (options.onProgress) options.onProgress(selected() as unknown as XPost[]);
        this.assertBackoffClear("lazy-load capture");
        let uniqueCount = allUnique().length;
        while ((!options.shouldContinue || options.shouldContinue()) && selected().length < options.limit && attempts < maxAttempts && stagnantAttempts < 6) {
          this.assertBackoffClear("lazy-load request");
          attempts += 1;
          const nextPromise = page.waitForResponse(
            (response) => operationName(response.url()) === meta.name,
            { timeout: 4_000 },
          ).catch(() => null);
          await page.locator('article[data-testid="tweet"], [data-testid="UserCell"]').last().scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
          await page.mouse.wheel(0, 5_000);
          await page.evaluate(() => window.scrollTo(0, document.scrollingElement?.scrollHeight ?? document.body.scrollHeight));
          const next = await nextPromise;
          if (!next) {
            stagnantAttempts += 1;
            continue;
          }
          const nextPayload = await this.readJson(next);
          payloads.push(nextPayload);
          const nextParsed = parse(nextPayload);
          parsedPages.push(nextParsed);
          if (options.onProgress) options.onProgress(selected() as unknown as XPost[]);
          cursor = nextParsed.bottomCursor ?? cursor;
          const nextUniqueCount = allUnique().length;
          stagnantAttempts = nextUniqueCount > uniqueCount ? 0 : stagnantAttempts + 1;
          uniqueCount = nextUniqueCount;
          this.assertBackoffClear("lazy-load response");
          await page.waitForTimeout(this.currentSpacingMs);
        }
        if (options.shouldContinue && !options.shouldContinue()) throw new XSignalError("CANCELLED", "The run or browser-work lease ended during capture.");
        this.assertBackoffClear("capture completion");
        const items = selected();
        const warnings = [...new Set([...captureWarnings, ...parsedPages.flatMap((pageResult) => pageResult.warnings)])];
        this.identity = { ...this.identity, connected: true, authenticated: true, lastCheckedAt: new Date().toISOString(), challenge: false, remediation: null };
        this.noteSuccessfulOperation();
        safeLog("x_operation_succeeded", { operation: meta.name, lens: meta.lens, count: items.length, replayed: meta.replayed, attempts, skipped: skipCount + skipIds.size });
        return { items, nextCursor: cursor, warnings, operation: meta };
      } catch (error) {
        this.assertReadablePage(page);
        throw toXSignalError(error);
      } finally {
        if (options.runId) {
          const pages = this.activeRunPages.get(options.runId);
          pages?.delete(page);
          if (pages?.size === 0) this.activeRunPages.delete(options.runId);
        }
        await page.close().catch(() => undefined);
      }
    }));
  }

  private assertReadablePage(page: Page): void {
    const url = page.url();
    if (/\/i\/flow\/login|\/account\/access/i.test(url)) {
      this.identity = { ...this.identity, connected: true, authenticated: false, challenge: /account\/access/i.test(url), lastCheckedAt: new Date().toISOString(), remediation: "Complete X sign-in or the visible challenge through noVNC." };
      throw new XSignalError(/account\/access/i.test(url) ? "UPSTREAM_CHALLENGE" : "NOT_AUTHENTICATED", "The persistent X browser requires interactive sign-in.");
    }
  }

  private async assertExpectedAccount(page: Page, expected: string): Promise<void> {
    const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]').first();
    await profileLink.waitFor({ state: "attached", timeout: 3_000 }).catch(() => undefined);
    const href = await profileLink.getAttribute("href").catch(() => null);
    const observed = href && /^\/[A-Za-z0-9_]+$/.test(href) ? href.slice(1).toLowerCase() : null;
    if (!observed) {
      throw new XSignalError("REAUTH_REQUIRED", `X Signal could not verify which signed-in account produced this response; the operation was discarded instead of attributing it to @${expected}.`, {
        remediation: "Open the persistent browser, confirm X home loads normally, then retry. If the account changed, sync or activate the intended Chrome profile first.",
      });
    }
    if (observed && observed !== expected.toLowerCase()) {
      this.identity = { ...this.identity, authenticated: true, handle: observed, lastCheckedAt: new Date().toISOString() };
      this.sessionEpoch = randomEpoch();
      this.cache.clear();
      throw new XSignalError("REAUTH_REQUIRED", `The browser changed to @${observed} while this run is bound to @${expected}. Retry with the intended account active.`);
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    const status = response.status();
    this.assertHttpStatus(status, response.headers()["retry-after"], "X operation");
    return response.json();
  }

  private assertHttpStatus(status: number, retryAfter: string | undefined, label: string): void {
    if (status === 401 || status === 403) throw new XSignalError("REAUTH_REQUIRED", `${label} returned HTTP ${status}.`);
    if (status === 429) {
      this.consecutiveRateLimits += 1;
      const exponentialFloor = Math.min(15 * 60_000, 30_000 * (2 ** Math.min(this.consecutiveRateLimits - 1, 5)));
      const headerDelay = parseRetryAfterMs(retryAfter);
      const retryAfterMs = Math.max(headerDelay, exponentialFloor);
      const retryAt = this.applyBackoff(retryAfterMs);
      throw new XSignalError("RATE_LIMITED", `${label} returned HTTP 429.`, { retryAfterMs, retryAt, remediation: `Retry after ${retryAt}.` });
    }
  }

  private assertBackoffClear(stage: string): void {
    const now = Date.now();
    if (this.backoffUntil <= now) return;
    const retryAt = new Date(this.backoffUntil).toISOString();
    throw new XSignalError("RATE_LIMITED", `X Signal stopped ${stage} because another browser task established a global backoff window.`, {
      retryAfterMs: this.backoffUntil - now,
      retryAt,
      remediation: `Retry after ${retryAt}.`,
    });
  }

  private async beforeDispatch(): Promise<void> {
    let release!: () => void;
    const previous = this.dispatchTail;
    this.dispatchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
    const now = Date.now();
    this.assertBackoffClear("browser dispatch");
    const waitMs = this.currentSpacingMs - (now - this.lastDispatchAt);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.assertBackoffClear("browser dispatch while it waited for global spacing");
    this.lastDispatchAt = Date.now();
    } finally {
      release();
    }
  }

  private applyBackoff(retryAfterMs: number): string {
    const bounded = Math.min(Math.max(retryAfterMs, 30_000), 15 * 60_000);
    this.backoffUntil = Math.max(this.backoffUntil, Date.now() + bounded);
    this.recoveringFromRateLimit = true;
    this.recoverySuccesses = 0;
    this.currentSpacingMs = Math.min(5_000, Math.max(this.config.requestSpacingMs + 250, Math.ceil(this.currentSpacingMs * 1.5)));
    const retryAt = new Date(this.backoffUntil).toISOString();
    this.onBackoff(retryAt);
    return retryAt;
  }

  private noteSuccessfulOperation(): void {
    this.currentSpacingMs = Math.max(this.config.requestSpacingMs, this.currentSpacingMs - 250);
    if (!this.recoveringFromRateLimit) {
      this.consecutiveRateLimits = 0;
      return;
    }
    this.recoverySuccesses += 1;
    if (this.recoverySuccesses >= 2) {
      this.recoveringFromRateLimit = false;
      this.recoverySuccesses = 0;
      this.consecutiveRateLimits = 0;
    }
  }
}

export function parseRetryAfterMs(value: string | undefined, now = Date.now()): number {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Math.max(0, Number(value.trim()) * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function selectCaptureWindow<T extends { id: string }>(items: T[], skipIds: ReadonlySet<string>, skipCount: number, limit: number): T[] {
  const start = Math.max(0, Math.trunc(skipCount));
  return items.filter((item) => !skipIds.has(item.id)).slice(start, start + Math.max(0, Math.trunc(limit)));
}

function operationName(url: string): string | null {
  try {
    const match = /\/i\/api\/graphql\/[^/]+\/([^/?]+)/.exec(new URL(url).pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function operationMeta(response: Response, options: CaptureOptions): OperationCapture {
  const url = new URL(response.url());
  const match = /\/i\/api\/graphql\/([^/]+)\/([^/?]+)/.exec(url.pathname);
  if (!match?.[1] || !match[2]) throw new XSignalError("UPSTREAM_CHANGED", "Captured response did not have an expected X GraphQL operation path.");
  const requestTemplate = scrubOperationTemplate(response);
  return {
    queryId: match[1],
    name: match[2],
    method: response.request().method(),
    path: url.pathname,
    sourcePage: new URL(options.targetUrl).pathname,
    lens: options.lens,
    capturedAt: new Date().toISOString(),
    parserVersion: 1,
    replayed: false,
    ...requestTemplate,
  };
}

function scrubOperationTemplate(response: Response): Pick<OperationCapture, "variableKeys" | "featureKeys" | "fieldToggleKeys"> {
  const url = new URL(response.url());
  let body: JsonObject = {};
  try {
    const parsed = response.request().postDataJSON() as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as JsonObject;
  } catch {
    body = {};
  }
  return {
    variableKeys: objectKeys(url.searchParams.get("variables") ?? body.variables),
    featureKeys: objectKeys(url.searchParams.get("features") ?? body.features),
    fieldToggleKeys: objectKeys(url.searchParams.get("fieldToggles") ?? body.fieldToggles),
  };
}

type JsonObject = Record<string, unknown>;

function objectKeys(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed as JsonObject).sort() : [];
  } catch {
    return [];
  }
}

function provenance(options: CaptureOptions): ProvenanceContext {
  return {
    profile: options.profile ?? null,
    lens: options.lens,
    query: options.query ?? null,
    queryLabel: options.queryLabel ?? null,
    retrievedAt: new Date().toISOString(),
    runId: options.runId ?? null,
    transport: "captured-operation",
  };
}

function randomEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function continuationKey(ids: ReadonlySet<string> | undefined): string {
  if (!ids?.size) return "0";
  const ordered = [...ids].sort();
  return `${ordered.length}:${ordered[0] ?? ""}:${ordered.at(-1) ?? ""}`;
}

function normalizeNumericId(value: string | undefined, kind: "list" | "community"): string {
  const id = /(?:^|\/)(\d{5,})(?:$|[/?#])/.exec(value ?? "")?.[1] ?? (/^\d{5,}$/.test(value ?? "") ? value : null);
  if (!id) throw new XSignalError("NOT_FOUND", `Provide an X ${kind} URL or numeric ${kind} ID.`);
  return id;
}

function byCreatedAt(a: XPost, b: XPost): number {
  return (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);
}

function byEngagement(a: XPost, b: XPost): number {
  const score = (post: XPost) => (post.metrics.likes ?? 0) + 2 * (post.metrics.reposts ?? 0) + 2 * (post.metrics.quotes ?? 0) + (post.metrics.replies ?? 0);
  return score(b) - score(a) || a.id.localeCompare(b.id);
}

async function resolveCdpEndpoint(configured: string): Promise<string> {
  if (/^wss?:\/\//i.test(configured)) return configured;
  const base = new URL(configured);
  const resolved = await lookup(base.hostname, { family: 4 });
  const discovery = new URL(base);
  discovery.hostname = resolved.address;
  discovery.pathname = `${discovery.pathname.replace(/\/$/, "")}/json/version`;
  const response = await fetch(discovery, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}`);
  const version = await response.json() as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error("CDP discovery omitted webSocketDebuggerUrl");
  const endpoint = new URL(version.webSocketDebuggerUrl);
  endpoint.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  endpoint.hostname = resolved.address;
  endpoint.port = base.port;
  return endpoint.href;
}
