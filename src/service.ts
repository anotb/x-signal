import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Config } from "./config.js";
import {
  MonitorDefinitionSchema,
  SearchFiltersSchema,
  type AccountSearchResult,
  type ContinueSearchInput,
  type EvidencePageResult,
  type SearchFilters,
  type SearchResult,
  type XPost,
  type XSearchInput,
} from "./contracts.js";
import { clusterPosts, deduplicatePosts, rankPostsWithScores } from "./aggregation.js";
import { toXSignalError, XSignalError } from "./errors.js";
import { safeLog } from "./redaction.js";
import { Store, type LeasedLeg, type StoredMonitor, type StoredRun } from "./store.js";
import { XBrowser } from "./x/browser.js";
import type { SessionCookieInput } from "./session.js";
import { compileQuery, decodeOffsetCursor, normalizePostId } from "./x/query.js";

const FOLLOWING_MARKER = "__xsignal_exact_following_feed__";
const RESPONSE_BYTE_BUDGET = 1_500_000;
type SessionSourceState = { id: string; label: string; lastSeenAt?: string; lastSyncedAt?: string; lastAppliedAt?: string };
type PendingSessionSourceState = { id: string; label: string; requestedAt: string };
type EvidenceSort = "observation" | "balanced" | "recency" | "engagement";

export class XService {
  readonly store: Store;
  readonly browser: XBrowser;
  private readonly workerId = `worker-${randomUUID()}`;
  private workerTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private monitorTicking = false;
  private readonly monitorRuns = new Map<string, Promise<Record<string, unknown>>>();
  private readonly inlineRuns = new Set<string>();
  private sessionSyncTail: Promise<void> = Promise.resolve();
  private lastSchedulerError: string | null = null;

  constructor(private readonly config: Config) {
    this.store = new Store(config);
    const persistedRetryAt = this.store.getSetting<string>("rate_backoff_until");
    const initialBackoffUntil = persistedRetryAt ? Date.parse(persistedRetryAt) : 0;
    this.browser = new XBrowser(
      config,
      (operation) => this.store.recordOperation(operation),
      {
        initialBackoffUntil: Number.isFinite(initialBackoffUntil) ? initialBackoffUntil : 0,
        onBackoff: (retryAt) => this.store.setSetting("rate_backoff_until", retryAt),
      },
    );
  }

  start(): void {
    const recovered = this.store.recoverInterrupted();
    if (recovered) safeLog("runs_recovered", { legs: recovered });
    this.workerTimer = setInterval(() => void this.tick(), 750);
    this.workerTimer.unref();
    void this.tick();
    this.scheduleNextMonitor();
  }

  close(): void {
    if (this.workerTimer) clearInterval(this.workerTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.store.close();
  }

  async syncSession(cookies: SessionCookieInput[], source?: { id: string; label: string }, activate = false) {
    const previous = this.sessionSyncTail;
    let release!: () => void;
    this.sessionSyncTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.syncSessionLocked(cookies, source, activate);
    } finally {
      release();
    }
  }

  private async syncSessionLocked(cookies: SessionCookieInput[], source?: { id: string; label: string }, activate = false) {
    const candidate = source ?? { id: "legacy", label: "Legacy Chrome companion" };
    const receivedAt = new Date().toISOString();
    const knownSources = this.store.getSetting<Record<string, SessionSourceState>>("session_sources") ?? {};
    knownSources[candidate.id] = { ...knownSources[candidate.id], ...candidate, lastSeenAt: receivedAt };
    this.store.setSetting("session_sources", knownSources);
    const active = this.store.getSetting<SessionSourceState>("active_session_source");
    let pending = this.store.getSetting<PendingSessionSourceState>("pending_session_source");
    const switching = active !== null && active.id !== candidate.id;
    if (activate && !switching && pending) {
      this.store.setSetting("pending_session_source", null);
      pending = null;
    }
    if (switching && activate) {
      pending = { ...candidate, requestedAt: receivedAt };
      this.store.setSetting("pending_session_source", pending);
    }
    const completingPendingSwitch = switching && pending?.id === candidate.id;
    if (switching && !activate && !completingPendingSwitch) {
      return { applied: false, inactive: true, cookieCount: cookies.length, identity: this.browser.status(), activeSource: active };
    }
    if (switching && this.store.listActiveRuns().length > 0) {
      return { applied: false, inactive: false, deferred: true, pendingActivation: true, cookieCount: cookies.length, identity: this.browser.status(), activeSource: active };
    }
    if (!switching && this.store.listActiveRuns().length > 0 && this.browser.sessionWouldChange(cookies)) {
      return { applied: false, inactive: false, deferred: true, cookieCount: cookies.length, identity: this.browser.status(), activeSource: active };
    }
    const result = await this.browser.importSession(cookies);
    const now = new Date().toISOString();
    const activeSource: SessionSourceState = {
      ...candidate,
      lastSeenAt: receivedAt,
      lastSyncedAt: now,
      lastAppliedAt: result.applied ? now : switching ? now : active?.lastAppliedAt,
    };
    this.store.setSetting("active_session_source", activeSource);
    if (pending?.id === candidate.id) this.store.setSetting("pending_session_source", null);
    knownSources[candidate.id] = activeSource;
    this.store.setSetting("session_sources", knownSources);
    return { ...result, inactive: false, activeSource };
  }

  async status(options: { liveProbe?: boolean } = {}): Promise<Record<string, unknown>> {
    if (options.liveProbe) await this.browser.probeIdentity(true);
    const identity = this.browser.status();
    const rateControl = this.browser.rateControlStatus();
    const operations = this.store.listOperations();
    const now = Date.now();
    const operationByName = new Map(operations.map((operation) => [`${operation.name}:${operation.lens}`, operation]));
    const operationCapability = (name: string, implemented = true) => {
      const operation = operationByName.get(name);
      const capturedAt = typeof operation?.capturedAt === "string" ? Date.parse(operation.capturedAt) : Number.NaN;
      return capability(Boolean(operation), implemented, Number.isFinite(capturedAt) ? now - capturedAt < 7 * 86_400_000 : null);
    };
    const monitors = this.store.listMonitors();
    const capabilities = {
      searchTop: operationCapability("SearchTimeline:top"),
      searchLatest: operationCapability("SearchTimeline:latest"),
      searchMedia: operationCapability("SearchTimeline:media"),
      searchPeople: operationCapability("SearchTimeline:people"),
      following: operationCapability("HomeLatestTimeline:following"),
      forYou: operationCapability("HomeTimeline:for_you"),
      post: operationCapability("TweetDetail:post"),
      thread: operationCapability("TweetDetail:post"),
      replies: operationCapability("TweetDetail:post"),
      quotes: operationByName.has("QuoteTweets:quotes") ? operationCapability("QuoteTweets:quotes") : operationCapability("SearchTimeline:quotes"),
      userTimeline: operationCapability("UserTweets:user"),
      bookmarks: operationCapability("Bookmarks:bookmarks"),
      lists: operationCapability("ListLatestTweetsTimeline:list"),
      communities: operationCapability("CommunityTweetsTimeline:community"),
      monitoring: capability(monitors.some((monitor) => monitor.lastRunId !== null), true, null),
      exports: capability(this.store.hasExports(), true, null),
    };
    const activeSessionSource = this.store.getSetting<SessionSourceState>("active_session_source");
    const pendingSessionSource = this.store.getSetting<PendingSessionSourceState>("pending_session_source");
    const knownSessionSources = this.store.getSetting<Record<string, SessionSourceState>>("session_sources") ?? {};
    if (activeSessionSource && !knownSessionSources[activeSessionSource.id]) knownSessionSources[activeSessionSource.id] = activeSessionSource;
    return {
      version: this.config.version,
      browser: identity,
      rateControl: {
        limited: rateControl.limited,
        retryAt: rateControl.retryAt,
        retryAfterSeconds: Math.ceil(rateControl.retryAfterMs / 1_000),
        requestSpacingMs: rateControl.requestSpacingMs,
        maxConcurrency: rateControl.maxConcurrency,
        recoveryMode: rateControl.recoveryMode,
      },
      capabilities,
      sessionSource: activeSessionSource,
      pendingSessionSource,
      sessionSources: Object.values(knownSessionSources).sort((a, b) => a.label.localeCompare(b.label)),
      operations: operations.map((operation) => ({
        name: operation.name,
        lens: operation.lens,
        capturedAt: operation.capturedAt,
        parserVersion: operation.parserVersion,
        replayed: Boolean(operation.replayed),
        freshness: typeof operation.capturedAt === "string" && now - Date.parse(operation.capturedAt) < 7 * 86_400_000 ? "fresh" : "stale",
      })),
      lastSuccessfulLiveCanary: this.store.getSetting("last_live_canary"),
      scheduler: {
        workerId: this.workerId,
        activeRuns: this.store.listActiveRuns(),
        dueMonitors: monitors.filter((monitor) => monitor.state === "active" && monitor.nextRunAt && Date.parse(monitor.nextRunAt) <= now).map((monitor) => monitor.id),
        lastError: this.lastSchedulerError,
      },
      remediation: identity.authenticated === false || identity.authenticated === null
        ? identity.remediation
        : this.lastSchedulerError
          ? "Inspect the app logs for the redacted scheduler failure and retry the affected run."
          : null,
    };
  }

  async search(input: XSearchInput): Promise<SearchResult> {
    const rateControl = this.browser.rateControlStatus();
    if (rateControl.limited && rateControl.retryAt) {
      throw new XSignalError("RATE_LIMITED", "X Signal is preserving the active upstream backoff window; no new run was created.", {
        retryAfterMs: rateControl.retryAfterMs,
        retryAt: rateControl.retryAt,
        remediation: `Continue with stored evidence or wait until ${rateControl.retryAt}; do not issue replacement searches before then.`,
      });
    }
    let accountHandle = this.browser.status().handle;
    if (input.idempotencyKey && !accountHandle) {
      const identity = await this.browser.probeIdentity();
      if (!identity.authenticated || !identity.handle) throw new XSignalError("NOT_AUTHENTICATED", "An account-bound idempotent search requires the persistent browser to be signed into X.", { remediation: identity.remediation ?? undefined });
      accountHandle = identity.handle;
    }
    const runId = this.store.createRun(input, "search", accountHandle);
    const execution = input.execution === "auto"
      ? input.queries.length === 1 && (input.queries[0]?.limit ?? 20) <= 50 ? "inline" : "job"
      : input.execution;
    if (execution === "inline") {
      this.inlineRuns.add(runId);
      try {
        await this.runUntilSettled(runId);
      } finally {
        this.inlineRuns.delete(runId);
      }
    }
    else void this.tick();
    return this.result(runId);
  }

  async continueSearch(input: ContinueSearchInput): Promise<SearchResult> {
    const rateControl = this.browser.rateControlStatus();
    if (rateControl.limited && rateControl.retryAt) {
      throw new XSignalError("RATE_LIMITED", "X Signal is preserving the active upstream backoff window; the stored run was not changed.", {
        retryAfterMs: rateControl.retryAfterMs,
        retryAt: rateControl.retryAt,
        remediation: `Wait until ${rateControl.retryAt}, then continue the same run.`,
      });
    }
    const requested = input.legs?.map((leg) => ({ legId: leg.legId, additionalLimit: leg.additionalLimit ?? 40 })) ?? null;
    const continued = this.store.continueRun(input.runId, requested, input.additionalLimit ?? 40, input.idempotencyKey, input.execution);
    const queuedLegs = continued.legs.filter((leg) => leg.status === "queued");
    const totalAdditional = queuedLegs.reduce((sum, leg) => sum + Math.max(0, leg.query.limit - leg.returnedCount), 0);
    const execution = input.execution === "auto" ? totalAdditional <= 50 && queuedLegs.length === 1 ? "inline" : "job" : input.execution;
    if (execution === "inline") {
      this.inlineRuns.add(input.runId);
      try {
        await this.runUntilSettled(input.runId);
      } finally {
        this.inlineRuns.delete(input.runId);
      }
    } else void this.tick();
    return this.result(input.runId);
  }

  async searchAccounts(query: string, limit = 20, cursor?: string): Promise<AccountSearchResult> {
    const expectedAccount = await this.verifiedAccountHandle();
    const scope = JSON.stringify({ query: query.trim() });
    const legacy = cursor?.startsWith("offset:") ? decodeOffsetCursor(cursor) : 0;
    const seenIds = cursor && !cursor.startsWith("offset:")
      ? new Set(this.store.readDirectCursor(cursor, "accounts", scope, expectedAccount))
      : new Set<string>();
    const read = await this.browser.searchAccounts(query, limit, legacy, expectedAccount, seenIds);
    const nextSeen = new Set([...seenIds, ...read.accounts.map((account) => account.id)]);
    return {
      query,
      accounts: read.accounts,
      nextCursor: read.nextCursor && read.accounts.length ? this.store.createDirectCursor("accounts", scope, expectedAccount, nextSeen) : null,
      warnings: read.warnings,
    };
  }

  result(runId: string, offset = 0, responseLimit?: number): SearchResult {
    const run = this.store.getRun(runId);
    const aggregation = run.input.aggregation;
    const deduped = aggregation?.deduplicate === false ? run.posts : deduplicatePosts(run.posts);
    const ranked = rankPostsWithScores(deduped, aggregation?.rank ?? "balanced", aggregation?.authorDiversity ?? true);
    const allPosts = ranked.posts;
    const limit = responseLimit === Number.POSITIVE_INFINITY
      ? Math.max(1, allPosts.length)
      : Math.max(1, Math.min(responseLimit ?? run.input.responseLimit ?? 200, 500));
    const page = responseLimit === Number.POSITIVE_INFINITY
      ? { posts: allPosts.slice(offset), estimatedBytes: Buffer.byteLength(JSON.stringify(allPosts.slice(offset)), "utf8"), truncatedByByteBudget: false }
      : byteBoundedPage(allPosts, offset, limit);
    const posts = page.posts;
    const visibleIds = new Set(posts.map((post) => post.id));
    const clusters = aggregation?.cluster === false ? [] : clusterPosts(posts);
    return {
      runId,
      status: run.status,
      posts,
      totalPosts: allPosts.length,
      evidencePage: {
        sort: aggregation?.rank ?? "balanced",
        offset,
        limit,
        returnedCount: posts.length,
        nextCursor: offset + posts.length < allPosts.length ? encodeEvidenceCursor(runId, null, aggregation?.rank ?? "balanced", offset + posts.length, evidenceSnapshot(allPosts)) : null,
        byteBudgetBytes: RESPONSE_BYTE_BUDGET,
        estimatedBytes: page.estimatedBytes,
        truncatedByByteBudget: page.truncatedByByteBudget,
      },
      ranking: ranked.ranking.filter((entry) => visibleIds.has(entry.postId)),
      clusters,
      warnings: run.warnings,
      errors: run.errors.map((error) => ({ legId: error.legId, code: normalizeErrorCode(error.code), message: error.message })),
      legs: run.legs.map((leg) => ({
        ...(() => {
          const filters = mergeFilters(run.input.filters, leg.query.filters);
          return { effectiveQuery: compileQuery(leg.query.query, filters), filterVerification: describeFilterVerification(filters) };
        })(),
        id: leg.id,
        index: leg.index,
        label: leg.query.label ?? null,
        query: leg.query.query,
        mode: leg.query.mode,
        status: leg.status,
        requestedCount: leg.query.limit,
        returnedCount: leg.returnedCount,
        hasMore: leg.status === "completed" && leg.cursor !== null,
      })),
      continuation: {
        available: run.legs.some((leg) => leg.status === "completed" && leg.cursor !== null),
        runId,
        continuableLegIds: run.legs.filter((leg) => leg.status === "completed" && leg.cursor !== null).map((leg) => leg.id),
      },
      retryAt: run.retryAt,
    };
  }

  evidence(runId: string, legId: string | undefined, cursor: string | undefined, limit = 100, requestedSort?: EvidenceSort): EvidencePageResult {
    const run = this.store.getRun(runId);
    if (legId && !run.legs.some((leg) => leg.id === legId)) throw new XSignalError("INVALID_CURSOR", `Leg ${legId} does not belong to run ${runId}.`);
    const decoded = decodeEvidenceCursor(cursor, requestedSort ?? "observation");
    if (decoded.runId && decoded.runId !== runId) throw new XSignalError("INVALID_CURSOR", "The evidence cursor belongs to a different run.");
    if (decoded.legId !== undefined && decoded.legId !== (legId ?? null)) throw new XSignalError("INVALID_CURSOR", "The evidence cursor belongs to a different leg selection.");
    if (requestedSort && decoded.sort !== requestedSort) throw new XSignalError("INVALID_CURSOR", "The evidence cursor and requested sort do not match; pass the cursor unchanged without changing sort.");
    const sort = decoded.sort;
    const offset = decoded.offset;
    const observations = this.store.getLegPosts(runId, legId);
    const source = run.input.aggregation?.deduplicate === false ? observations : deduplicatePosts(observations);
    const posts = sort === "observation" ? source : rankPostsWithScores(source, sort, run.input.aggregation?.authorDiversity ?? true).posts;
    const snapshot = evidenceSnapshot(posts);
    if (decoded.snapshot && decoded.snapshot !== snapshot) throw new XSignalError("INVALID_CURSOR", "The stored run changed after this evidence cursor was issued; restart paging from the first page.");
    const bounded = Math.max(1, Math.min(limit, 500));
    const page = byteBoundedPage(posts, offset, bounded);
    return {
      runId,
      legId: legId ?? null,
      sort,
      totalPosts: posts.length,
      offset,
      limit: bounded,
      returnedCount: page.posts.length,
      nextCursor: offset + page.posts.length < posts.length ? encodeEvidenceCursor(runId, legId ?? null, sort, offset + page.posts.length, snapshot) : null,
      byteBudgetBytes: RESPONSE_BYTE_BUDGET,
      estimatedBytes: page.estimatedBytes,
      truncatedByByteBudget: page.truncatedByByteBudget,
      posts: page.posts,
    };
  }

  runDetails(runId: string): Record<string, unknown> {
    const run = this.store.getRun(runId);
    return {
      run: runSummary(run),
      result: this.result(runId),
    };
  }

  async cancelRun(runId: string): Promise<Record<string, unknown>> {
    const cancelled = this.store.cancelRun(runId);
    const interruptedPages = cancelled ? await this.browser.cancelRun(runId) : 0;
    return { runId, cancelled, interruptedPages, status: this.store.getRun(runId).status };
  }

  async getPost(value: string, context: "post" | "thread" | "replies" | "quotes" | "all", limit = 40): Promise<Record<string, unknown>> {
    const expectedAccount = await this.verifiedAccountHandle();
    return adaptPostContext(await this.browser.post(value, context, Math.min(limit, 100), expectedAccount));
  }

  async getTimeline(source: { type: string; handle?: string; id?: string }, limit = 40, excludePromoted = false, cursor?: string): Promise<Record<string, unknown>> {
    const expectedAccount = await this.verifiedAccountHandle();
    const scope = directTimelineScope(source, excludePromoted);
    const legacy = cursor?.startsWith("offset:") ? decodeOffsetCursor(cursor) : 0;
    const seenIds = cursor && !cursor.startsWith("offset:")
      ? new Set(this.store.readDirectCursor(cursor, "timeline", scope, expectedAccount))
      : new Set<string>();
    const result = await this.browser.timeline(source, Math.min(limit, 500), null, legacy, undefined, expectedAccount, seenIds);
    const nextSeen = new Set([...seenIds, ...result.posts.map((post) => post.id)]);
    return {
      source,
      posts: excludePromoted ? result.posts.filter((post) => !post.flags.promoted) : result.posts,
      nextCursor: result.nextCursor && result.posts.length ? this.store.createDirectCursor("timeline", scope, expectedAccount, nextSeen) : null,
      warnings: result.warnings,
    };
  }

  async fetch(value: string): Promise<Record<string, unknown>> {
    const trimmed = value.trim();
    const snapshot = /^runitem:([0-9a-f-]{36}):(\d+)$/i.exec(trimmed);
    if (snapshot?.[1] && snapshot[2]) {
      const post = this.store.getRun(snapshot[1]).posts.find((candidate) => candidate.id === snapshot[2]);
      if (!post) throw new XSignalError("NOT_FOUND", `The immutable search observation ${trimmed} does not exist.`);
      return { type: "post", source: "run-snapshot", runId: snapshot[1], post };
    }
    const postId = normalizePostId(trimmed);
    if (/\d{5,}/.test(postId) && (/status\//.test(trimmed) || /^\d+$/.test(trimmed))) {
      const stored = this.store.getPost(postId);
      return stored ? { type: "post", source: "stored", post: stored } : { type: "post", source: "live", ...(await this.getPost(postId, "post")) };
    }
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(trimmed)) {
      try {
        return { type: "run", source: "stored", ...this.runDetails(trimmed) };
      } catch (error) {
        if (!(error instanceof XSignalError) || error.code !== "RUN_NOT_FOUND") throw error;
      }
    }
    if (/^(?:@|https?:\/\/(?:www\.)?x\.com\/)?[a-z0-9_]{1,15}\/?$/i.test(trimmed)) {
      return { type: "user", source: "live", ...(await this.getTimeline({ type: "user", handle: trimmed }, 20)) };
    }
    throw new XSignalError("NOT_FOUND", "The value was not a stored result ID, supported X post URL/ID, or user handle/URL.");
  }

  async monitor(action: string, input: { id?: string; definition?: unknown }): Promise<Record<string, unknown>> {
    if (action === "create") {
      const definition = MonitorDefinitionSchema.parse(input.definition);
      const monitor = this.store.createMonitor(definition);
      this.scheduleNextMonitor();
      return { action, monitor: publicMonitor(monitor) };
    }
    if (action === "list") return { action, monitors: this.store.listMonitors().map(publicMonitor) };
    if (!input.id) throw new XSignalError("NOT_FOUND", `Monitor action '${action}' requires an id.`);
    if (action === "get") return { action, monitor: publicMonitor(this.store.getMonitor(input.id)) };
    if (action === "update") {
      const definition = MonitorDefinitionSchema.parse(input.definition);
      const monitor = this.store.updateMonitor(input.id, definition);
      this.scheduleNextMonitor();
      return { action, monitor: publicMonitor(monitor) };
    }
    if (action === "pause" || action === "resume") {
      const monitor = this.store.setMonitorState(input.id, action === "pause" ? "paused" : "active");
      this.scheduleNextMonitor();
      return { action, monitor: publicMonitor(monitor) };
    }
    if (action === "delete") {
      const deleted = this.store.deleteMonitor(input.id);
      this.scheduleNextMonitor();
      return { action, id: input.id, deleted };
    }
    if (action === "results") return { action, id: input.id, results: this.store.monitorResults(input.id) };
    if (action === "run") {
      const result = await this.runMonitor(this.store.getMonitor(input.id));
      this.scheduleNextMonitor();
      return { action, ...result };
    }
    throw new XSignalError("CAPABILITY_UNAVAILABLE", `Unsupported monitor action '${action}'.`);
  }

  export(sourceType: "run" | "monitor", sourceId: string, format: "json" | "ndjson" | "csv" | "markdown"): Record<string, unknown> {
    const runId = sourceType === "run" ? sourceId : this.store.getMonitor(sourceId).lastRunId;
    if (!runId) throw new XSignalError("NOT_FOUND", "The monitor has no successful result to export.");
    const result = this.result(runId, 0, Number.POSITIVE_INFINITY);
    const { content, mimeType, extension } = renderExport(result, format);
    const exported = this.store.createExport(sourceType, sourceId, format, `x-signal-${sourceId}.${extension}`, mimeType, content);
    return { sourceType, sourceId, format, ...exported };
  }

  async canary(): Promise<Record<string, unknown>> {
    const identity = await this.browser.probeIdentity(true);
    if (!identity.authenticated) throw new XSignalError("NOT_AUTHENTICATED", "The Docker browser is not signed into X.", { remediation: identity.remediation ?? undefined });
    const search = await this.search({
      queries: [
        { query: "OpenAI MCP", label: "live-canary-top", mode: "top", limit: 5 },
        { query: "OpenAI MCP", label: "live-canary-latest", mode: "latest", limit: 5 },
      ],
      execution: "inline",
      aggregation: { deduplicate: true, cluster: true, rank: "balanced", authorDiversity: true },
    });
    if (search.status !== "completed" || !search.posts.length) throw new XSignalError("UPSTREAM_CHANGED", `Live canary ended ${search.status} with ${search.posts.length} normalized posts.`);
    const lenses = [...new Set(search.legs.filter((leg) => leg.status === "completed").map((leg) => leg.mode))].sort();
    const record = { at: new Date().toISOString(), runId: search.runId, postCount: search.posts.length, handle: identity.handle, lenses };
    this.store.setSetting("last_live_canary", record);
    return record;
  }

  getExport(id: string): ReturnType<Store["getExport"]> {
    return this.store.getExport(id);
  }

  private async verifiedAccountHandle(): Promise<string> {
    const identity = await this.browser.probeIdentity();
    if (!identity.authenticated || !identity.handle) {
      throw new XSignalError("NOT_AUTHENTICATED", "The persistent browser is not signed into a readable X account.", { remediation: identity.remediation ?? undefined });
    }
    return identity.handle.toLowerCase();
  }

  private async runUntilSettled(runId: string): Promise<void> {
    for (;;) {
      const run = this.store.getRun(runId);
      if (["completed", "partial", "failed", "cancelled"].includes(run.status)) return;
      const executed = await this.runWorkConservingPool(runId);
      const current = this.store.getRun(runId);
      if (["completed", "partial", "failed", "cancelled"].includes(current.status)) return;
      if (!executed) {
        if (current.retryAt) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.inlineRuns.size || this.browser.rateControlStatus().limited) return;
    this.ticking = true;
    try {
      await this.runWorkConservingPool();
      this.lastSchedulerError = null;
    } catch (error) {
      this.lastSchedulerError = toXSignalError(error).message;
      safeLog("scheduler_tick_failed", { error: this.lastSchedulerError });
    } finally {
      this.ticking = false;
    }
  }

  private async runWorkConservingPool(runId?: string): Promise<boolean> {
    const active = new Set<Promise<void>>();
    let executed = false;
    for (;;) {
      const capacity = this.browser.recommendedConcurrency();
      while (!this.browser.rateControlStatus().limited && active.size < capacity) {
        const leg = this.store.leaseLeg(this.workerId, 60_000, runId);
        if (!leg) break;
        executed = true;
        let task!: Promise<void>;
        task = this.executeLeg(leg).finally(() => active.delete(task));
        active.add(task);
      }
      if (!active.size) return executed;
      await Promise.race(active);
    }
  }

  private async executeLeg(leg: LeasedLeg): Promise<void> {
    let leaseValid = true;
    const heartbeat = setInterval(() => { leaseValid = this.store.extendLease(leg); }, 30_000);
    heartbeat.unref();
    try {
      if (!this.store.isRunActive(leg.runId)) throw new XSignalError("CANCELLED", "The run is no longer active.");
      const identity = await this.browser.probeIdentity();
      if (!identity.authenticated || !identity.handle) throw new XSignalError("NOT_AUTHENTICATED", "The persistent browser is not signed into X.", { remediation: identity.remediation ?? undefined });
      const boundHandle = this.store.bindRunAccount(leg.runId, identity.handle);
      if (boundHandle !== identity.handle.toLowerCase()) throw new XSignalError("REAUTH_REQUIRED", `Run ${leg.runId} belongs to @${boundHandle}, but the browser is signed in as @${identity.handle}.`);
      const acceptedPostIds = new Set(this.store.getLegAcceptedPostIds(leg.id));
      const seenPostIds = new Set(this.store.getLegSeenPostIds(leg.id));
      const remaining = Math.max(0, leg.query.limit - acceptedPostIds.size);
      const filters = mergeFilters(leg.input.filters, leg.query.filters);
      if (remaining === 0) {
        this.store.completeLeg(leg, [], this.store.getRun(leg.runId).legs.find((candidate) => candidate.id === leg.id)?.cursor ?? null, []);
        return;
      }
      const shouldContinue = () => leaseValid && this.store.isRunActive(leg.runId);
      const checkpoint = (posts: XPost[]) => {
        const accepted = locallyFilter(posts, filters);
        if (!this.store.checkpointLeg(leg, accepted, posts.map((post) => post.id))) leaseValid = false;
      };
      const read = leg.query.query === FOLLOWING_MARKER
        ? await this.browser.timeline({ type: "following" }, remaining, leg.runId, 0, shouldContinue, boundHandle, seenPostIds, checkpoint)
        : await this.browser.search(
          compileQuery(leg.query.query, filters),
          leg.query.mode,
          remaining,
          { label: leg.query.label, runId: leg.runId, skipPostIds: seenPostIds, shouldContinue, expectedAccount: boundHandle, onProgress: checkpoint },
        );
      const filtered = locallyFilter(read.posts, filters);
      this.store.completeLeg(leg, filtered, read.nextCursor, read.warnings, read.posts.map((post) => post.id));
    } catch (error) {
      const converted = toXSignalError(error);
      if (converted.code === "RATE_LIMITED") {
        const retryAt = converted.retryAt ?? this.browser.rateControlStatus().retryAt ?? new Date(Date.now() + 30_000).toISOString();
        this.store.setSetting("rate_backoff_until", retryAt);
        this.store.deferLeg(leg, retryAt);
      } else {
        this.store.failLeg(leg, converted.code, converted.message);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private scheduleNextMonitor(): void {
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    const next = this.store.nextDueMonitorAt();
    if (!next) {
      this.monitorTimer = null;
      return;
    }
    const delay = Math.max(0, Math.min(2_147_000_000, Date.parse(next) - Date.now()));
    this.monitorTimer = setTimeout(() => void this.tickMonitors(), delay);
    this.monitorTimer.unref();
  }

  private async runMonitor(monitor: StoredMonitor): Promise<Record<string, unknown>> {
    const active = this.monitorRuns.get(monitor.id);
    if (active) return active;
    const promise = this.executeMonitor(monitor).finally(() => this.monitorRuns.delete(monitor.id));
    this.monitorRuns.set(monitor.id, promise);
    return promise;
  }

  private async tickMonitors(): Promise<void> {
    if (this.monitorTicking) return;
    this.monitorTicking = true;
    try {
      for (;;) {
        const monitor = this.store.claimDueMonitor();
        if (!monitor) break;
        try {
          await this.runMonitor(monitor);
        } catch (error) {
          this.store.rescheduleMonitor(monitor.id, new Date(Date.now() + 5 * 60_000));
          safeLog("monitor_run_failed", { monitorId: monitor.id, error: toXSignalError(error).message });
        }
      }
    } finally {
      this.monitorTicking = false;
      this.scheduleNextMonitor();
    }
  }

  private async executeMonitor(monitor: StoredMonitor): Promise<Record<string, unknown>> {
    let current = this.store.getMonitor(monitor.id);
    const definition = MonitorDefinitionSchema.parse(current.definition);
    let runId = current.activeRunId;
    if (!runId) {
      const queries = [...definition.queries];
      for (const account of definition.accounts) queries.push({ query: `from:${account.replace(/^@/, "")}`, label: `@${account.replace(/^@/, "")}`, mode: "latest", limit: 20 });
      if (definition.includeFollowing) queries.push({ query: FOLLOWING_MARKER, label: "Following", mode: "top", limit: 100 });
      if (!queries.length) throw new XSignalError("CAPABILITY_UNAVAILABLE", "Monitor has no queries, accounts, or Following source.");
      const runInput: XSearchInput = { queries, execution: "job", responseLimit: 200, aggregation: { deduplicate: true, cluster: true, rank: "balanced", authorDiversity: true } };
      runId = this.store.createRun(runInput, "monitor");
      current = this.store.setMonitorExecution(monitor.id, runId, "searching");
      void this.tick();
    }

    let run = this.store.getRun(runId);
    let filtering: { before: number; after: number } | null = null;
    if (current.executionStage === "searching") {
      await this.runUntilSettled(runId);
      run = this.store.getRun(runId);
      if (run.retryAt) {
        this.store.rescheduleMonitor(monitor.id, new Date(run.retryAt));
        return { monitor: publicMonitor(this.store.getMonitor(monitor.id)), run: runSummary(run), pending: "backoff" };
      }
      if (run.status !== "completed") {
        this.store.setMonitorExecution(monitor.id, null, "idle");
        throw new XSignalError("INTERNAL", `Monitor search ended ${run.status}; its baseline was not advanced.`);
      }
      const include = definition.include.map(normalizeMonitorTerm).filter(Boolean);
      const exclude = definition.exclude.map(normalizeMonitorTerm).filter(Boolean);
      filtering = this.store.filterRunItems(runId, (post) => monitorPostMatches(post, include, exclude));
      this.store.prepareMonitorRun(monitor.id, runId);
      current = this.store.setMonitorExecution(monitor.id, runId, "delivering");
    }

    const monitorRun = this.store.prepareMonitorRun(monitor.id, runId);
    const sink = definition.sink;
    if (sink) {
      const sinkUrl = typeof sink === "string" ? sink : sink.url;
      const sinkType = typeof sink === "string" ? "webhook" : sink.type;
      const delivery = await this.deliver(monitorRun.id, sinkUrl, monitorRun.diff, sinkType);
      if (!delivery.delivered) {
        this.store.rescheduleMonitor(monitor.id, new Date(delivery.retryAt ?? Date.now() + 5 * 60_000));
        return { monitor: publicMonitor(current), run: runSummary(run), filtering, pending: "delivery-retry", diff: monitorRun.diff };
      }
    }
    this.store.commitMonitorRun(monitor.id, runId);
    const prunedRuns = this.store.pruneMonitorHistory(monitor.id, definition.retentionDays);
    return { monitor: publicMonitor(this.store.getMonitor(monitor.id)), run: runSummary(run), filtering, prunedRuns, diff: monitorRun.diff };
  }

  private async deliver(monitorRunId: string, sink: string, diff: Record<string, unknown>, sinkType: "webhook" | "ntfy"): Promise<{ delivered: boolean; retryAt: string | null }> {
    const delivery = this.store.createDelivery(monitorRunId, sink);
    if (delivery.state === "delivered") return { delivered: true, retryAt: null };
    if (delivery.state === "waiting") return { delivered: false, retryAt: delivery.retryAt };
    try {
      const body = JSON.stringify(sinkType === "ntfy"
        ? { title: "X Signal monitor", message: `${(diff.addedPostIds as string[] | undefined)?.length ?? 0} new posts`, click: (diff.sourceLinks as string[] | undefined)?.[0], tags: ["mag"] }
        : { source: "x-signal", ...diff });
      let target = sink;
      let response: Response | null = null;
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        await assertSafeSink(target, this.config.allowPrivateMonitorSinks);
        response = await fetch(target, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "user-agent": "x-signal/0.1" }, body, signal: AbortSignal.timeout(10_000) });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location) throw new Error("Monitor sink redirect omitted Location");
        target = new URL(location, target).href;
      }
      if (!response) throw new Error("Monitor sink produced no response");
      if (!response.ok) throw new Error(`Sink returned HTTP ${response.status}`);
      this.store.finishDelivery(delivery.id, true);
      return { delivered: true, retryAt: null };
    } catch (error) {
      const retryAt = this.store.finishDelivery(delivery.id, false, error instanceof Error ? error.message : "Delivery failed");
      return { delivered: false, retryAt };
    }
  }
}

function normalizeMonitorTerm(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function monitorPostMatches(post: XPost, include: string[], exclude: string[]): boolean {
  const nested = [post.quotedPost, post.repostOf].filter((value): value is XPost => value !== null);
  const haystack = [
    post.text,
    post.author.handle,
    post.author.displayName ?? "",
    post.url,
    ...nested.flatMap((value) => [value.text, value.author.handle, value.author.displayName ?? "", value.url]),
  ].join("\n").toLocaleLowerCase();
  if (exclude.some((term) => haystack.includes(term))) return false;
  return include.length === 0 || include.some((term) => haystack.includes(term));
}

function byteBoundedPage(posts: XPost[], offset: number, limit: number): { posts: XPost[]; estimatedBytes: number; truncatedByByteBudget: boolean } {
  const page: XPost[] = [];
  let estimatedBytes = 1_024;
  const candidates = posts.slice(offset, offset + limit);
  for (const post of candidates) {
    const bytes = Buffer.byteLength(JSON.stringify(post), "utf8") + 2;
    if (page.length > 0 && estimatedBytes + bytes > RESPONSE_BYTE_BUDGET) break;
    page.push(post);
    estimatedBytes += bytes;
  }
  return { posts: page, estimatedBytes, truncatedByByteBudget: page.length < candidates.length };
}

function evidenceSnapshot(posts: XPost[]): string {
  return createHash("sha256").update(posts.map((post) => post.id).join("\n")).digest("base64url").slice(0, 16);
}

function encodeEvidenceCursor(runId: string, legId: string | null, sort: EvidenceSort, offset: number, snapshot: string): string {
  return `e1:${Buffer.from(JSON.stringify({ r: runId, l: legId, s: sort, o: Math.max(0, Math.trunc(offset)), h: snapshot }), "utf8").toString("base64url")}`;
}

function decodeEvidenceCursor(cursor: string | undefined, fallbackSort: EvidenceSort): { runId?: string; legId?: string | null; sort: EvidenceSort; offset: number; snapshot?: string } {
  if (!cursor) return { sort: fallbackSort, offset: 0 };
  if (/^offset:\d+$/.test(cursor)) return { sort: fallbackSort, offset: decodeOffsetCursor(cursor) };
  const match = /^e1:([A-Za-z0-9_-]+)$/.exec(cursor);
  if (!match?.[1]) throw new XSignalError("INVALID_CURSOR", "Pass the opaque evidence cursor returned by X Signal unchanged.");
  try {
    const value = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.r !== "string" || !(value.l === null || typeof value.l === "string") || !["observation", "balanced", "recency", "engagement"].includes(String(value.s)) || !Number.isInteger(value.o) || Number(value.o) < 0 || typeof value.h !== "string") {
      throw new Error("invalid cursor payload");
    }
    return { runId: value.r, legId: value.l as string | null, sort: value.s as EvidenceSort, offset: Number(value.o), snapshot: value.h };
  } catch {
    throw new XSignalError("INVALID_CURSOR", "Pass the opaque evidence cursor returned by X Signal unchanged.");
  }
}

export function adaptPostContext(result: { primary: XPost; thread: XPost[]; replies: XPost[]; quotes: XPost[]; warnings: string[] }): { post: XPost; thread: XPost[]; replies: XPost[]; quotes: XPost[]; warnings: string[] } {
  return { post: result.primary, thread: result.thread, replies: result.replies, quotes: result.quotes, warnings: result.warnings };
}

function capability(observed: boolean, implemented: boolean, fresh: boolean | null = null): Record<string, unknown> {
  return {
    implemented,
    observed,
    state: !implemented
      ? "unavailable"
      : !observed
        ? "ready-unverified"
        : fresh === true
          ? "live-verified-fresh"
          : fresh === false
            ? "live-verified-stale"
            : "live-verified-historical",
  };
}

function normalizeErrorCode(value: string): "NOT_AUTHENTICATED" | "REAUTH_REQUIRED" | "RATE_LIMITED" | "UPSTREAM_CHALLENGE" | "UPSTREAM_CHANGED" | "CAPABILITY_UNAVAILABLE" | "INVALID_CURSOR" | "NOT_FOUND" | "RUN_NOT_FOUND" | "CANCELLED" | "IDEMPOTENCY_CONFLICT" | "INTERNAL" {
  const values = new Set(["NOT_AUTHENTICATED", "REAUTH_REQUIRED", "RATE_LIMITED", "UPSTREAM_CHALLENGE", "UPSTREAM_CHANGED", "CAPABILITY_UNAVAILABLE", "INVALID_CURSOR", "NOT_FOUND", "RUN_NOT_FOUND", "CANCELLED", "IDEMPOTENCY_CONFLICT", "INTERNAL"]);
  return values.has(value) ? value as ReturnType<typeof normalizeErrorCode> : "INTERNAL";
}

function runSummary(run: StoredRun): Record<string, unknown> {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    totalLegs: run.totalLegs,
    completedLegs: run.completedLegs,
    failedLegs: run.failedLegs,
    browserDispatches: run.browserDispatches,
    accountHandle: run.accountHandle,
    retryAt: run.retryAt,
  };
}

function publicMonitor(monitor: StoredMonitor): StoredMonitor {
  const definition = structuredClone(monitor.definition);
  const sink = definition.sink;
  if (typeof sink === "string") definition.sink = redactUrl(sink);
  else if (sink && typeof sink === "object" && "url" in sink) definition.sink = { ...(sink as Record<string, unknown>), url: redactUrl(String((sink as { url: unknown }).url)) };
  return { ...monitor, definition };
}

function redactUrl(value: string): string {
  try { const url = new URL(value); return `${url.protocol}//${url.host}/…`; }
  catch { return "configured"; }
}

export async function assertSafeSink(value: string, allowPrivate: boolean): Promise<void> {
  const url = new URL(value);
  if (!new Set(["https:", "http:"]).has(url.protocol)) throw new XSignalError("CAPABILITY_UNAVAILABLE", "Monitor sinks must use HTTP or HTTPS.");
  if ((url.username || url.password)) throw new XSignalError("CAPABILITY_UNAVAILABLE", "Monitor sink credentials must not appear in URL user-info.");
  if (!allowPrivate && url.protocol !== "https:") throw new XSignalError("CAPABILITY_UNAVAILABLE", "Monitor sinks require HTTPS unless private sinks are explicitly enabled by the operator.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new XSignalError("NOT_FOUND", "Monitor sink hostname did not resolve.");
  if (!allowPrivate && addresses.some(({ address }) => isNonPublicAddress(address))) {
    throw new XSignalError("CAPABILITY_UNAVAILABLE", "Monitor sink resolves to a loopback, private, link-local, multicast, or otherwise non-public address.");
  }
}

function isNonPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const mappedTail = /^::ffff:(.+)$/.exec(normalized)?.[1];
  const mapped = mappedTail && /^\d+\.\d+\.\d+\.\d+$/.test(mappedTail)
    ? mappedTail
    : mappedTail && /^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(mappedTail)
      ? mappedTail.split(":").flatMap((part) => { const value = Number.parseInt(part, 16); return [value >> 8, value & 255]; }).join(".")
      : undefined;
  const candidate = mapped ?? normalized;
  const octets = candidate.split(".").map(Number);
  if (octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    const [a = 0, b = 0, c = 0] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
      || (a === 203 && b === 0 && c === 113);
  }
  if (!normalized.includes(":")) return true;
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff")) return true;
  const first = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff) return true;
  return /^2001:0?db8(?::|$)/.test(normalized);
}

function mergeFilters(shared: SearchFilters | undefined, local: SearchFilters | undefined): SearchFilters | undefined {
  return shared || local ? SearchFiltersSchema.parse({ ...shared, ...local }) : undefined;
}

function directTimelineScope(source: { type: string; handle?: string; id?: string }, excludePromoted: boolean): string {
  return JSON.stringify({
    type: source.type,
    handle: source.handle?.trim().toLowerCase() ?? null,
    id: source.id?.trim() ?? null,
    excludePromoted,
  });
}

function locallyFilter(posts: XPost[], filters: SearchFilters | undefined): XPost[] {
  const since = filters?.since ? Date.parse(filters.since) : null;
  const until = filters?.until ? Date.parse(filters.until) : null;
  return posts.filter((post) => {
    const created = post.createdAt ? Date.parse(post.createdAt) : null;
    if (since !== null && (created === null || !Number.isFinite(created) || created < since)) return false;
    if (until !== null && (created === null || !Number.isFinite(created) || created >= until)) return false;
    if (filters?.language && post.language?.toLowerCase().split("-")[0] !== filters.language.toLowerCase().split("-")[0]) return false;
    if (filters?.accounts?.length && !filters.accounts.some((handle) => handle.replace(/^@/, "").toLowerCase() === post.author.handle.toLowerCase())) return false;
    if ((post.metrics.likes ?? 0) < (filters?.minLikes ?? 0)) return false;
    if ((post.metrics.reposts ?? 0) < (filters?.minReposts ?? 0)) return false;
    if ((post.metrics.replies ?? 0) < (filters?.minReplies ?? 0)) return false;
    if (filters?.includeReplies === false && post.flags.reply) return false;
    if (filters?.includeReposts === false && post.flags.repost) return false;
    if (filters?.mediaOnly && post.media.length === 0) return false;
    if (filters?.imagesOnly && !post.media.some((item) => item.type === "image")) return false;
    if (filters?.videosOnly && !post.media.some((item) => item.type === "video" || item.type === "gif")) return false;
    if (filters?.linksOnly && !post.media.some((item) => item.type === "card") && !/https?:\/\//i.test(post.text)) return false;
    return true;
  });
}

function describeFilterVerification(filters: SearchFilters | undefined): { locallyVerified: string[]; upstreamOnly: string[] } {
  if (!filters) return { locallyVerified: [], upstreamOnly: [] };
  const localKeys = ["since", "until", "language", "accounts", "minLikes", "minReposts", "minReplies", "includeReplies", "includeReposts", "mediaOnly", "imagesOnly", "videosOnly", "linksOnly"] as const;
  const upstreamKeys = ["toAccounts", "mentioningAccounts"] as const;
  return {
    locallyVerified: localKeys.filter((key) => filters[key] !== undefined),
    upstreamOnly: upstreamKeys.filter((key) => filters[key] !== undefined),
  };
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function renderExport(result: SearchResult, format: "json" | "ndjson" | "csv" | "markdown"): { content: string; mimeType: string; extension: string } {
  if (format === "json") return { content: `${JSON.stringify(result, null, 2)}\n`, mimeType: "application/json", extension: "json" };
  if (format === "ndjson") return { content: `${result.posts.map((post) => JSON.stringify(post)).join("\n")}\n`, mimeType: "application/x-ndjson", extension: "ndjson" };
  if (format === "csv") {
    const headers = ["id", "url", "created_at", "author_handle", "author_name", "text", "likes", "reposts", "quotes", "replies", "views", "lens", "query_label", "transport"];
    const rows = result.posts.map((post) => [post.id, post.url, post.createdAt, post.author.handle, post.author.displayName, post.text, post.metrics.likes, post.metrics.reposts, post.metrics.quotes, post.metrics.replies, post.metrics.views, post.provenance.lens, post.provenance.queryLabel, post.provenance.transport].map(csvCell).join(","));
    return { content: `${headers.map(csvCell).join(",")}\n${rows.join("\n")}\n`, mimeType: "text/csv", extension: "csv" };
  }
  const body = result.posts.map((post) => `- [@${post.author.handle}](${post.url}) — ${post.text.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|")}  \n  ${post.createdAt ?? "unknown time"} · ${post.provenance.lens} · likes ${post.metrics.likes ?? "?"} · reposts ${post.metrics.reposts ?? "?"}`).join("\n");
  return { content: `# X Signal research\n\nRun: \`${result.runId}\`\n\n${body}\n`, mimeType: "text/markdown", extension: "md" };
}
