import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Config } from "./config.js";
import type { ContinueSearchInput, XPost, XSearchInput } from "./contracts.js";
import { clusterPosts } from "./aggregation.js";
import { XSignalError } from "./errors.js";

type DbRow = Record<string, unknown>;

export type StoredRun = {
  id: string;
  kind: "search" | "monitor";
  status: "queued" | "running" | "partial" | "completed" | "failed" | "cancelled";
  input: XSearchInput;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  totalLegs: number;
  completedLegs: number;
  failedLegs: number;
  browserDispatches: number;
  accountHandle: string | null;
  retryAt: string | null;
  posts: XPost[];
  warnings: string[];
  errors: Array<{ legId: string | null; code: string; message: string }>;
  legs: Array<{
    id: string;
    index: number;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    query: XSearchInput["queries"][number];
    cursor: string | null;
    returnedCount: number;
  }>;
};

export type LeasedLeg = {
  id: string;
  runId: string;
  index: number;
  query: XSearchInput["queries"][number];
  input: XSearchInput;
  leaseOwner: string;
  leaseToken: string;
  accountHandle: string | null;
};

export type StoredMonitor = {
  id: string;
  definition: Record<string, unknown>;
  state: "active" | "paused";
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunId: string | null;
  activeRunId: string | null;
  executionStage: "idle" | "searching" | "delivering";
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operations (
  name TEXT NOT NULL,
  lens TEXT NOT NULL,
  query_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  source_page TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  replayed INTEGER NOT NULL DEFAULT 0,
  suspect INTEGER NOT NULL DEFAULT 0,
  variable_keys_json TEXT NOT NULL DEFAULT '[]',
  feature_keys_json TEXT NOT NULL DEFAULT '[]',
  field_toggle_keys_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(name, lens)
);
CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  run_id TEXT,
  lens TEXT NOT NULL,
  query TEXT,
  query_label TEXT,
  retrieved_at TEXT NOT NULL,
  UNIQUE(post_id, run_id, lens, query, query_label)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('search','monitor')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','partial','completed','failed','cancelled')),
  input_json TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash TEXT,
  account_handle TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  browser_dispatches INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  errors_json TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS run_legs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  leg_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  query_json TEXT NOT NULL,
  cursor TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_message TEXT,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  not_before_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, leg_index)
);
CREATE TABLE IF NOT EXISTS run_items (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  leg_id TEXT NOT NULL REFERENCES run_legs(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id),
  ordinal INTEGER NOT NULL,
  snapshot_json TEXT,
  PRIMARY KEY(run_id, leg_id, post_id)
);
CREATE TABLE IF NOT EXISTS run_seen_items (
  leg_id TEXT NOT NULL REFERENCES run_legs(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL,
  PRIMARY KEY(leg_id, post_id)
);
CREATE TABLE IF NOT EXISTS run_capture_checkpoints (
  leg_id TEXT NOT NULL REFERENCES run_legs(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT,
  PRIMARY KEY(leg_id, post_id)
);
CREATE TABLE IF NOT EXISTS continuations (
  idempotency_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS direct_cursors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('accounts','timeline')),
  scope_hash TEXT NOT NULL,
  account_handle TEXT NOT NULL,
  seen_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','paused')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_run_at TEXT,
  last_run_id TEXT,
  active_run_id TEXT,
  execution_stage TEXT NOT NULL DEFAULT 'idle'
);
CREATE UNIQUE INDEX IF NOT EXISTS monitors_idempotency ON monitors(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS monitor_runs (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  baseline_run_id TEXT,
  diff_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(monitor_id, run_id)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  monitor_run_id TEXT NOT NULL REFERENCES monitor_runs(id) ON DELETE CASCADE,
  sink TEXT NOT NULL,
  status TEXT NOT NULL,
  delivered_at TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  UNIQUE(monitor_run_id, sink)
);
CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  format TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(private readonly config: Config) {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    fs.mkdirSync(config.exportDir, { recursive: true });
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const runItemColumns = this.db.prepare("PRAGMA table_info(run_items)").all() as DbRow[];
    if (!runItemColumns.some((column) => column.name === "snapshot_json")) this.db.exec("ALTER TABLE run_items ADD COLUMN snapshot_json TEXT");
    const operationColumns = this.db.prepare("PRAGMA table_info(operations)").all() as DbRow[];
    if (!operationColumns.some((column) => column.name === "variable_keys_json")) this.db.exec("ALTER TABLE operations ADD COLUMN variable_keys_json TEXT NOT NULL DEFAULT '[]'");
    if (!operationColumns.some((column) => column.name === "feature_keys_json")) this.db.exec("ALTER TABLE operations ADD COLUMN feature_keys_json TEXT NOT NULL DEFAULT '[]'");
    if (!operationColumns.some((column) => column.name === "field_toggle_keys_json")) this.db.exec("ALTER TABLE operations ADD COLUMN field_toggle_keys_json TEXT NOT NULL DEFAULT '[]'");
    const legColumns = this.db.prepare("PRAGMA table_info(run_legs)").all() as DbRow[];
    if (!legColumns.some((column) => column.name === "not_before_at")) this.db.exec("ALTER TABLE run_legs ADD COLUMN not_before_at TEXT");
    if (!legColumns.some((column) => column.name === "lease_token")) this.db.exec("ALTER TABLE run_legs ADD COLUMN lease_token TEXT");
    const runColumns = this.db.prepare("PRAGMA table_info(runs)").all() as DbRow[];
    if (!runColumns.some((column) => column.name === "request_hash")) this.db.exec("ALTER TABLE runs ADD COLUMN request_hash TEXT");
    if (!runColumns.some((column) => column.name === "account_handle")) this.db.exec("ALTER TABLE runs ADD COLUMN account_handle TEXT");
    const monitorColumns = this.db.prepare("PRAGMA table_info(monitors)").all() as DbRow[];
    if (!monitorColumns.some((column) => column.name === "active_run_id")) this.db.exec("ALTER TABLE monitors ADD COLUMN active_run_id TEXT");
    if (!monitorColumns.some((column) => column.name === "execution_stage")) this.db.exec("ALTER TABLE monitors ADD COLUMN execution_stage TEXT NOT NULL DEFAULT 'idle'");
    const deliveryColumns = this.db.prepare("PRAGMA table_info(deliveries)").all() as DbRow[];
    if (!deliveryColumns.some((column) => column.name === "attempts")) this.db.exec("ALTER TABLE deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    if (!deliveryColumns.some((column) => column.name === "next_attempt_at")) this.db.exec("ALTER TABLE deliveries ADD COLUMN next_attempt_at TEXT");
  }

  close(): void {
    this.db.close();
  }

  recoverInterrupted(): number {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const legs = this.db.prepare("UPDATE run_legs SET status='queued', lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE status='running'").run(now).changes;
      this.db.prepare("UPDATE runs SET status='queued', updated_at=? WHERE status='running'").run(now);
      this.db.exec("COMMIT");
      return Number(legs);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordOperation(operation: { name: string; lens: string; queryId: string; method: string; path: string; sourcePage: string; capturedAt: string; parserVersion: number; replayed: boolean; variableKeys: string[]; featureKeys: string[]; fieldToggleKeys: string[] }): void {
    this.db.prepare(`
      INSERT INTO operations(name,lens,query_id,method,path,source_page,captured_at,parser_version,replayed,suspect,variable_keys_json,feature_keys_json,field_toggle_keys_json)
      VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)
      ON CONFLICT(name,lens) DO UPDATE SET query_id=excluded.query_id,method=excluded.method,path=excluded.path,
        source_page=excluded.source_page,captured_at=excluded.captured_at,parser_version=excluded.parser_version,
        replayed=MAX(operations.replayed,excluded.replayed),suspect=0,variable_keys_json=excluded.variable_keys_json,
        feature_keys_json=excluded.feature_keys_json,field_toggle_keys_json=excluded.field_toggle_keys_json
    `).run(operation.name, operation.lens, operation.queryId, operation.method, operation.path, operation.sourcePage, operation.capturedAt, operation.parserVersion, operation.replayed ? 1 : 0, JSON.stringify(operation.variableKeys), JSON.stringify(operation.featureKeys), JSON.stringify(operation.fieldToggleKeys));
  }

  listOperations(): Array<Record<string, unknown>> {
    return (this.db.prepare("SELECT name,lens,query_id AS queryId,method,path,source_page AS sourcePage,captured_at AS capturedAt,parser_version AS parserVersion,replayed,suspect,variable_keys_json,feature_keys_json,field_toggle_keys_json FROM operations ORDER BY name,lens").all() as DbRow[]).map((row) => ({
      name: row.name, lens: row.lens, queryId: row.queryId, method: row.method, path: row.path, sourcePage: row.sourcePage,
      capturedAt: row.capturedAt, parserVersion: row.parserVersion, replayed: row.replayed, suspect: row.suspect,
      variableKeys: JSON.parse(row.variable_keys_json as string), featureKeys: JSON.parse(row.feature_keys_json as string), fieldToggleKeys: JSON.parse(row.field_toggle_keys_json as string),
    }));
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key=?").get(key) as DbRow | undefined;
    return row ? JSON.parse(row.value_json as string) as T : null;
  }

  getPost(id: string): XPost | null {
    const row = this.db.prepare("SELECT json FROM posts WHERE id=?").get(id) as DbRow | undefined;
    return row ? normalizeStoredPost(JSON.parse(row.json as string)) : null;
  }

  createRun(input: XSearchInput, kind: "search" | "monitor" = "search", accountHandle: string | null = null): string {
    const requestHash = canonicalRequestHash(input, kind, accountHandle);
    const existing = input.idempotencyKey
      ? this.db.prepare("SELECT id,request_hash,input_json,kind,account_handle FROM runs WHERE idempotency_key=?").get(input.idempotencyKey) as DbRow | undefined
      : undefined;
    if (typeof existing?.id === "string") {
      const priorHash = typeof existing.request_hash === "string" ? existing.request_hash : canonicalRequestHash(JSON.parse(existing.input_json as string) as XSearchInput, existing.kind as "search" | "monitor", existing.account_handle as string | null);
      if (priorHash !== requestHash) throw new XSignalError("IDEMPOTENCY_CONFLICT", "This idempotency key is already bound to a different X Signal request.");
      return existing.id;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO runs(id,kind,status,input_json,idempotency_key,request_hash,account_handle,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id, kind, "queued", JSON.stringify(input), input.idempotencyKey ?? null, requestHash, accountHandle, now, now);
      const insert = this.db.prepare("INSERT INTO run_legs(id,run_id,leg_index,status,query_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)");
      input.queries.forEach((query, index) => insert.run(randomUUID(), id, index, "queued", JSON.stringify(query), now, now));
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (input.idempotencyKey) {
        const winner = this.db.prepare("SELECT id,request_hash FROM runs WHERE idempotency_key=?").get(input.idempotencyKey) as DbRow | undefined;
        if (typeof winner?.id === "string" && winner.request_hash === requestHash) return winner.id;
      }
      throw error;
    }
  }

  continueRun(runId: string, requested: Array<{ legId: string; additionalLimit: number }> | null, defaultAdditionalLimit: number, idempotencyKey?: string, execution: ContinueSearchInput["execution"] = "auto"): StoredRun {
    const requestHash = canonicalContinuationHash(runId, requested, defaultAdditionalLimit, execution);
    if (idempotencyKey) {
      const existing = this.db.prepare("SELECT run_id,request_hash FROM continuations WHERE idempotency_key=?").get(idempotencyKey) as DbRow | undefined;
      if (existing) {
        if (existing.run_id !== runId || existing.request_hash !== requestHash) throw new XSignalError("IDEMPOTENCY_CONFLICT", "This continuation idempotency key is already bound to a different request.");
        return this.getRun(runId);
      }
    }
    const run = this.getRun(runId);
    if (run.kind !== "search") throw new XSignalError("CAPABILITY_UNAVAILABLE", "Monitor runs cannot be continued as interactive searches.");
    if (!["completed", "partial", "failed"].includes(run.status)) {
      throw new XSignalError("CAPABILITY_UNAVAILABLE", `Run ${runId} is ${run.status}; poll or cancel it before requesting more evidence.`);
    }
    const byId = new Map(run.legs.map((leg) => [leg.id, leg]));
    const selections = requested ?? run.legs
      .filter((leg) => leg.status === "completed" && leg.cursor !== null)
      .map((leg) => ({ legId: leg.id, additionalLimit: defaultAdditionalLimit }));
    if (!selections.length) throw new XSignalError("INVALID_CURSOR", "No completed search leg currently reports more X results.");
    const uniqueSelections = new Map<string, number>();
    for (const selection of selections) {
      const leg = byId.get(selection.legId);
      if (!leg) throw new XSignalError("INVALID_CURSOR", `Leg ${selection.legId} does not belong to run ${runId}.`);
      if (leg.status !== "completed" || leg.cursor === null) throw new XSignalError("INVALID_CURSOR", `Leg ${selection.legId} is not continuable.`);
      uniqueSelections.set(selection.legId, selection.additionalLimit);
    }

    const nextInput = structuredClone(run.input);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updateLeg = this.db.prepare(`UPDATE run_legs SET status='queued',query_json=?,error_code=NULL,error_message=NULL,
        lease_owner=NULL,lease_expires_at=NULL,not_before_at=NULL,updated_at=? WHERE id=?`);
      for (const [legId, additionalLimit] of uniqueSelections) {
        const leg = byId.get(legId)!;
        const query = { ...leg.query, limit: leg.query.limit + additionalLimit };
        nextInput.queries[leg.index] = query;
        updateLeg.run(JSON.stringify(query), now, legId);
      }
      this.db.prepare("UPDATE runs SET status='queued',input_json=?,updated_at=?,completed_at=NULL WHERE id=?")
        .run(JSON.stringify(nextInput), now, runId);
      if (idempotencyKey) this.db.prepare("INSERT INTO continuations(idempotency_key,run_id,request_hash,created_at) VALUES(?,?,?,?)")
        .run(idempotencyKey, runId, requestHash, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (idempotencyKey) {
        const winner = this.db.prepare("SELECT run_id,request_hash FROM continuations WHERE idempotency_key=?").get(idempotencyKey) as DbRow | undefined;
        if (winner?.run_id === runId && winner.request_hash === requestHash) return this.getRun(runId);
      }
      throw error;
    }
    return this.getRun(runId);
  }

  getLegPostIds(legId: string): string[] {
    return (this.db.prepare("SELECT post_id FROM run_items WHERE leg_id=? ORDER BY ordinal,post_id").all(legId) as DbRow[])
      .map((row) => row.post_id as string);
  }

  getLegAcceptedPostIds(legId: string): string[] {
    return (this.db.prepare(`SELECT post_id FROM (
      SELECT post_id,ordinal AS ordering FROM run_items WHERE leg_id=?
      UNION ALL
      SELECT post_id,1000000000+ordinal AS ordering FROM run_capture_checkpoints WHERE leg_id=? AND accepted=1
    ) GROUP BY post_id ORDER BY MIN(ordering),post_id`).all(legId, legId) as DbRow[])
      .map((row) => row.post_id as string);
  }

  getLegSeenPostIds(legId: string): string[] {
    const rows = this.db.prepare(`SELECT post_id,ordering FROM (
      SELECT post_id,rowid AS ordering FROM run_seen_items WHERE leg_id=?
      UNION ALL
      SELECT post_id,1000000000+ordinal AS ordering FROM run_capture_checkpoints WHERE leg_id=?
    ) GROUP BY post_id ORDER BY MIN(ordering)`).all(legId, legId) as DbRow[];
    if (rows.length) return rows.map((row) => row.post_id as string);
    return this.getLegPostIds(legId);
  }

  checkpointLeg(leg: LeasedLeg, acceptedPosts: XPost[], seenPostIds: string[]): boolean {
    if (!seenPostIds.length) return true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owned = this.db.prepare("SELECT 1 AS owned FROM run_legs WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?")
        .get(leg.id, leg.leaseOwner, leg.leaseToken) as DbRow | undefined;
      if (!owned) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const ordinalRow = this.db.prepare("SELECT COALESCE(MAX(ordinal),-1) AS maximum FROM run_capture_checkpoints WHERE leg_id=?").get(leg.id) as DbRow;
      let ordinal = Number(ordinalRow.maximum) + 1;
      const acceptedById = new Map(acceptedPosts.map((post) => [post.id, post]));
      const insert = this.db.prepare(`INSERT INTO run_capture_checkpoints(leg_id,post_id,ordinal,accepted,snapshot_json) VALUES(?,?,?,?,?)
        ON CONFLICT(leg_id,post_id) DO UPDATE SET accepted=MAX(accepted,excluded.accepted),snapshot_json=COALESCE(excluded.snapshot_json,snapshot_json)`);
      for (const postId of seenPostIds) {
        const post = acceptedById.get(postId);
        insert.run(leg.id, postId, ordinal, post ? 1 : 0, post ? JSON.stringify(post) : null);
        ordinal += 1;
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  leaseLeg(owner: string, leaseMs = 60_000, runId?: string): LeasedLeg | null {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + leaseMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const whereRun = runId ? "AND l.run_id=?" : "";
      const params: SQLInputValue[] = runId ? [now, now, runId] : [now, now];
      const row = this.db.prepare(`
        SELECT l.id,l.run_id,l.leg_index,l.query_json,r.input_json,r.account_handle
        FROM run_legs l JOIN runs r ON r.id=l.run_id
        WHERE r.status NOT IN ('cancelled','completed','failed')
          AND (l.status='queued' OR (l.status='running' AND l.lease_expires_at < ?))
          AND (l.not_before_at IS NULL OR l.not_before_at <= ?) ${whereRun}
        ORDER BY r.created_at,l.leg_index LIMIT 1
      `).get(...params) as DbRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const leaseToken = randomUUID();
      const changed = this.db.prepare("UPDATE run_legs SET status='running',lease_owner=?,lease_token=?,lease_expires_at=?,not_before_at=NULL,updated_at=? WHERE id=? AND status IN ('queued','running')")
        .run(owner, leaseToken, expires, now, row.id as string).changes;
      if (!changed) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.prepare("UPDATE runs SET status='running',started_at=COALESCE(started_at,?),updated_at=?,browser_dispatches=browser_dispatches+1 WHERE id=?")
        .run(now, now, row.run_id as string);
      this.db.exec("COMMIT");
      return {
        id: row.id as string,
        runId: row.run_id as string,
        index: Number(row.leg_index),
        query: JSON.parse(row.query_json as string) as XSearchInput["queries"][number],
        input: JSON.parse(row.input_json as string) as XSearchInput,
        leaseOwner: owner,
        leaseToken,
        accountHandle: row.account_handle as string | null,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  extendLease(leg: LeasedLeg, leaseMs = 120_000): boolean {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + leaseMs).toISOString();
    return Number(this.db.prepare("UPDATE run_legs SET lease_expires_at=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?")
      .run(expires, now, leg.id, leg.leaseOwner, leg.leaseToken).changes) > 0;
  }

  completeLeg(leg: LeasedLeg, posts: XPost[], cursor: string | null, warnings: string[], seenPostIds: string[] = posts.map((post) => post.id)): boolean {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT warnings_json FROM run_legs WHERE id=?").get(leg.id) as DbRow | undefined;
      const combinedWarnings = [...new Set([...(prior ? JSON.parse(prior.warnings_json as string) as string[] : []), ...warnings])];
      const fenced = this.db.prepare("UPDATE run_legs SET status='completed',cursor=?,warnings_json=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,not_before_at=NULL,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?")
        .run(cursor, JSON.stringify(combinedWarnings), now, leg.id, leg.leaseOwner, leg.leaseToken).changes;
      if (!fenced) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const checkpoints = this.db.prepare("SELECT post_id,accepted,snapshot_json FROM run_capture_checkpoints WHERE leg_id=? ORDER BY ordinal").all(leg.id) as DbRow[];
      const checkpointPosts = checkpoints.filter((row) => Number(row.accepted) === 1 && typeof row.snapshot_json === "string")
        .map((row) => normalizeStoredPost(JSON.parse(row.snapshot_json as string)));
      const allPosts = [...new Map([...checkpointPosts, ...posts].map((post) => [post.id, post])).values()];
      const allSeenPostIds = [...new Set([...checkpoints.map((row) => row.post_id as string), ...seenPostIds])];
      const ordinalRow = this.db.prepare("SELECT COALESCE(MAX(ordinal),-1) AS maximum FROM run_items WHERE leg_id=?").get(leg.id) as DbRow;
      const firstOrdinal = Number(ordinalRow.maximum) + 1;
      const upsertAuthor = this.db.prepare("INSERT INTO authors(id,json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at");
      const upsertPost = this.db.prepare("INSERT INTO posts(id,json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at");
      const addItem = this.db.prepare("INSERT OR IGNORE INTO run_items(run_id,leg_id,post_id,ordinal,snapshot_json) VALUES(?,?,?,?,?)");
      const observe = this.db.prepare("INSERT OR IGNORE INTO observations(id,post_id,run_id,lens,query,query_label,retrieved_at) VALUES(?,?,?,?,?,?,?)");
      const markSeen = this.db.prepare("INSERT OR IGNORE INTO run_seen_items(leg_id,post_id) VALUES(?,?)");
      for (const postId of allSeenPostIds) markSeen.run(leg.id, postId);
      allPosts.forEach((post, index) => {
        upsertAuthor.run(post.author.id, JSON.stringify(post.author), now);
        upsertPost.run(post.id, JSON.stringify(post), now);
        addItem.run(leg.runId, leg.id, post.id, firstOrdinal + index, JSON.stringify(post));
        observe.run(randomUUID(), post.id, leg.runId, post.provenance.lens, post.provenance.query, post.provenance.queryLabel, post.provenance.retrievedAt);
      });
      this.db.prepare("DELETE FROM run_capture_checkpoints WHERE leg_id=?").run(leg.id);
      this.db.exec("COMMIT");
      this.finalizeRun(leg.runId);
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  failLeg(leg: LeasedLeg, code: string, message: string): boolean {
    const now = new Date().toISOString();
    const changed = this.db.prepare("UPDATE run_legs SET status='failed',error_code=?,error_message=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,not_before_at=NULL,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?")
      .run(code, message, now, leg.id, leg.leaseOwner, leg.leaseToken).changes;
    if (changed) this.db.prepare("DELETE FROM run_capture_checkpoints WHERE leg_id=?").run(leg.id);
    this.finalizeRun(leg.runId);
    return Number(changed) > 0;
  }

  deferLeg(leg: LeasedLeg, retryAt: string): boolean {
    const now = new Date().toISOString();
    const changed = this.db.prepare("UPDATE run_legs SET status='queued',error_code=NULL,error_message=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,not_before_at=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_token=?")
      .run(retryAt, now, leg.id, leg.leaseOwner, leg.leaseToken).changes;
    if (changed) this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=? AND status!='cancelled'").run(now, leg.runId);
    return Number(changed) > 0;
  }

  private finalizeRun(runId: string): void {
    const counts = this.db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) pending
      FROM run_legs WHERE run_id=?`).get(runId) as DbRow;
    if (Number(counts.pending) > 0) return;
    const current = this.db.prepare("SELECT status FROM runs WHERE id=?").get(runId) as DbRow | undefined;
    if (current?.status === "cancelled") return;
    const completed = Number(counts.completed);
    const failed = Number(counts.failed);
    const status = completed > 0 && failed > 0 ? "partial" : failed > 0 ? "failed" : "completed";
    const now = new Date().toISOString();
    this.db.prepare("UPDATE runs SET status=?,updated_at=?,completed_at=? WHERE id=?").run(status, now, now, runId);
  }

  cancelRun(runId: string): boolean {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare("UPDATE runs SET status='cancelled',updated_at=?,completed_at=? WHERE id=? AND status NOT IN ('completed','failed','cancelled')")
        .run(now, now, runId).changes;
      this.db.prepare("UPDATE run_legs SET status='cancelled',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE run_id=? AND status IN ('queued','running')")
        .run(now, runId);
      this.db.prepare("DELETE FROM run_capture_checkpoints WHERE leg_id IN (SELECT id FROM run_legs WHERE run_id=?)").run(runId);
      this.db.exec("COMMIT");
      return Number(changed) > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(runId: string): StoredRun {
    const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as DbRow | undefined;
    if (!run) throw new XSignalError("RUN_NOT_FOUND", `No run exists with ID ${runId}.`);
    const legs = this.db.prepare("SELECT * FROM run_legs WHERE run_id=? ORDER BY leg_index").all(runId) as DbRow[];
    const postRows = this.db.prepare(`SELECT COALESCE(i.snapshot_json,p.json) AS json FROM run_items i
      JOIN run_legs l ON l.id=i.leg_id JOIN posts p ON p.id=i.post_id
      WHERE i.run_id=? ORDER BY l.leg_index,i.ordinal,i.post_id`).all(runId) as DbRow[];
    const countRows = this.db.prepare("SELECT leg_id,COUNT(*) AS count FROM run_items WHERE run_id=? GROUP BY leg_id").all(runId) as DbRow[];
    const countsByLeg = new Map(countRows.map((row) => [row.leg_id as string, Number(row.count)]));
    const posts = postRows.map((row) => normalizeStoredPost(JSON.parse(row.json as string)));
    const warnings = legs.flatMap((row) => JSON.parse(row.warnings_json as string) as string[]);
    const errors = legs.filter((row) => row.error_code).map((row) => ({ legId: row.id as string, code: row.error_code as string, message: row.error_message as string }));
    const retryAt = legs.map((row) => row.not_before_at as string | null).filter((value): value is string => value !== null).sort()[0] ?? null;
    return {
      id: run.id as string,
      kind: run.kind as StoredRun["kind"],
      status: run.status as StoredRun["status"],
      input: JSON.parse(run.input_json as string) as XSearchInput,
      createdAt: run.created_at as string,
      updatedAt: run.updated_at as string,
      startedAt: run.started_at as string | null,
      completedAt: run.completed_at as string | null,
      totalLegs: legs.length,
      completedLegs: legs.filter((row) => row.status === "completed").length,
      failedLegs: legs.filter((row) => row.status === "failed").length,
      browserDispatches: Number(run.browser_dispatches),
      accountHandle: run.account_handle as string | null,
      retryAt,
      posts,
      warnings,
      errors,
      legs: legs.map((row) => ({
        id: row.id as string,
        index: Number(row.leg_index),
        status: row.status as StoredRun["legs"][number]["status"],
        query: JSON.parse(row.query_json as string) as XSearchInput["queries"][number],
        cursor: row.cursor as string | null,
        returnedCount: countsByLeg.get(row.id as string) ?? 0,
      })),
    };
  }

  filterRunItems(runId: string, keep: (post: XPost) => boolean): { before: number; after: number } {
    const run = this.getRun(runId);
    if (run.kind !== "monitor") throw new XSignalError("INTERNAL", "Only monitor runs can be filtered after capture.");
    const rows = this.db.prepare("SELECT run_id,leg_id,post_id,COALESCE(snapshot_json,p.json) AS json FROM run_items i JOIN posts p ON p.id=i.post_id WHERE i.run_id=?")
      .all(runId) as DbRow[];
    const remove = rows.filter((row) => !keep(normalizeStoredPost(JSON.parse(row.json as string))));
    if (remove.length) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const statement = this.db.prepare("DELETE FROM run_items WHERE run_id=? AND leg_id=? AND post_id=?");
        for (const row of remove) statement.run(row.run_id as string, row.leg_id as string, row.post_id as string);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    return { before: rows.length, after: rows.length - remove.length };
  }

  listActiveRuns(): Array<{ id: string; status: string }> {
    return this.db.prepare("SELECT id,status FROM runs WHERE status IN ('queued','running') ORDER BY created_at").all() as Array<{ id: string; status: string }>;
  }

  isRunActive(runId: string): boolean {
    const row = this.db.prepare("SELECT status FROM runs WHERE id=?").get(runId) as DbRow | undefined;
    return row?.status === "queued" || row?.status === "running";
  }

  bindRunAccount(runId: string, handle: string): string {
    const normalized = handle.toLowerCase();
    this.db.prepare("UPDATE runs SET account_handle=?,updated_at=? WHERE id=? AND account_handle IS NULL")
      .run(normalized, new Date().toISOString(), runId);
    const row = this.db.prepare("SELECT account_handle FROM runs WHERE id=?").get(runId) as DbRow | undefined;
    if (!row) throw new XSignalError("RUN_NOT_FOUND", `No run exists with ID ${runId}.`);
    return String(row.account_handle ?? "").toLowerCase();
  }

  getLegPosts(runId: string, legId?: string): XPost[] {
    const params: SQLInputValue[] = legId ? [runId, legId] : [runId];
    const clause = legId ? "AND i.leg_id=?" : "";
    return (this.db.prepare(`SELECT COALESCE(i.snapshot_json,p.json) AS json FROM run_items i
      JOIN run_legs l ON l.id=i.leg_id JOIN posts p ON p.id=i.post_id
      WHERE i.run_id=? ${clause} ORDER BY l.leg_index,i.ordinal,i.post_id`).all(...params) as DbRow[])
      .map((row) => normalizeStoredPost(JSON.parse(row.json as string)));
  }

  createDirectCursor(kind: "accounts" | "timeline", scope: string, accountHandle: string, seenIds: Iterable<string>): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const uniqueIds = [...new Set(seenIds)].sort();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM direct_cursors WHERE created_at < ?").run(cutoff);
      this.db.prepare("INSERT INTO direct_cursors(id,kind,scope_hash,account_handle,seen_ids_json,created_at) VALUES(?,?,?,?,?,?)")
        .run(id, kind, directCursorScopeHash(scope), accountHandle.toLowerCase(), JSON.stringify(uniqueIds), now);
      this.db.exec("COMMIT");
      return `d1:${id}`;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readDirectCursor(token: string, kind: "accounts" | "timeline", scope: string, accountHandle: string): string[] {
    const match = /^d1:([0-9a-f]{8}-[0-9a-f-]{27,})$/i.exec(token);
    if (!match?.[1]) throw new XSignalError("INVALID_CURSOR", "Pass the opaque cursor returned by the same X Signal tool unchanged.");
    const row = this.db.prepare("SELECT kind,scope_hash,account_handle,seen_ids_json FROM direct_cursors WHERE id=?").get(match[1]) as DbRow | undefined;
    if (!row || row.kind !== kind || row.scope_hash !== directCursorScopeHash(scope) || String(row.account_handle).toLowerCase() !== accountHandle.toLowerCase()) {
      throw new XSignalError("INVALID_CURSOR", "The cursor belongs to a different query, timeline source, or X account.");
    }
    const parsed = JSON.parse(row.seen_ids_json as string) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) throw new XSignalError("INVALID_CURSOR", "The stored direct-read cursor is invalid.");
    return parsed;
  }

  createMonitor(definition: Record<string, unknown>): StoredMonitor {
    const idempotencyKey = typeof definition.idempotencyKey === "string" ? definition.idempotencyKey : null;
    if (idempotencyKey) {
      const existing = this.db.prepare("SELECT id FROM monitors WHERE idempotency_key=?").get(idempotencyKey) as DbRow | undefined;
      if (typeof existing?.id === "string") {
        const monitor = this.getMonitor(existing.id);
        if (canonicalMonitorHash(monitor.definition) !== canonicalMonitorHash(definition)) {
          throw new XSignalError("IDEMPOTENCY_CONFLICT", "This monitor idempotency key is already bound to a different definition.");
        }
        return monitor;
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const next = nextMonitorRun(definition).toISOString();
    this.db.prepare("INSERT INTO monitors(id,definition_json,state,idempotency_key,created_at,updated_at,next_run_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, JSON.stringify(definition), "active", idempotencyKey, now, now, next);
    return this.getMonitor(id);
  }

  getMonitor(id: string): StoredMonitor {
    const row = this.db.prepare("SELECT * FROM monitors WHERE id=?").get(id) as DbRow | undefined;
    if (!row) throw new XSignalError("NOT_FOUND", `No monitor exists with ID ${id}.`);
    return mapMonitor(row);
  }

  listMonitors(): StoredMonitor[] {
    return (this.db.prepare("SELECT * FROM monitors ORDER BY created_at").all() as DbRow[]).map(mapMonitor);
  }

  updateMonitor(id: string, definition: Record<string, unknown>): StoredMonitor {
    this.getMonitor(id);
    const now = new Date().toISOString();
    const next = nextMonitorRun(definition).toISOString();
    this.db.prepare("UPDATE monitors SET definition_json=?,updated_at=?,next_run_at=? WHERE id=?").run(JSON.stringify(definition), now, next, id);
    return this.getMonitor(id);
  }

  setMonitorState(id: string, state: "active" | "paused"): StoredMonitor {
    this.getMonitor(id);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE monitors SET state=?,updated_at=?,next_run_at=? WHERE id=?")
      .run(state, now, state === "active" ? now : null, id);
    return this.getMonitor(id);
  }

  deleteMonitor(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM monitors WHERE id=?").run(id).changes) > 0;
  }

  dueMonitors(): StoredMonitor[] {
    const now = new Date().toISOString();
    return (this.db.prepare("SELECT * FROM monitors WHERE state='active' AND next_run_at <= ? ORDER BY next_run_at").all(now) as DbRow[]).map(mapMonitor);
  }

  nextDueMonitorAt(): string | null {
    const row = this.db.prepare("SELECT MIN(next_run_at) AS next_run_at FROM monitors WHERE state='active' AND next_run_at IS NOT NULL").get() as DbRow;
    return typeof row.next_run_at === "string" ? row.next_run_at : null;
  }

  claimDueMonitor(leaseMinutes = 5): StoredMonitor | null {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + leaseMinutes * 60_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT id,next_run_at FROM monitors WHERE state='active' AND next_run_at <= ? ORDER BY next_run_at LIMIT 1").get(now) as DbRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const changed = this.db.prepare("UPDATE monitors SET next_run_at=?,updated_at=? WHERE id=? AND next_run_at=?")
        .run(leaseUntil, now, row.id as string, row.next_run_at as string).changes;
      this.db.exec("COMMIT");
      return changed ? this.getMonitor(row.id as string) : null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rescheduleMonitor(id: string, when: Date): void {
    this.db.prepare("UPDATE monitors SET next_run_at=?,updated_at=? WHERE id=? AND state='active'").run(when.toISOString(), new Date().toISOString(), id);
  }

  setMonitorExecution(id: string, activeRunId: string | null, stage: "idle" | "searching" | "delivering"): StoredMonitor {
    this.getMonitor(id);
    this.db.prepare("UPDATE monitors SET active_run_id=?,execution_stage=?,updated_at=? WHERE id=?")
      .run(activeRunId, stage, new Date().toISOString(), id);
    return this.getMonitor(id);
  }

  prepareMonitorRun(monitorId: string, runId: string): { id: string; diff: Record<string, unknown> } {
    const monitor = this.getMonitor(monitorId);
    const run = this.getRun(runId);
    const baselineRunId = monitor.lastRunId;
    const baselineRun = baselineRunId ? this.getRun(baselineRunId) : null;
    const baselineIds = new Set((baselineRun?.posts ?? []).map((post) => post.id));
    const currentIds = new Set(run.posts.map((post) => post.id));
    const accountChanged = Boolean(baselineRun && (baselineRun.accountHandle ?? "").toLowerCase() !== (run.accountHandle ?? "").toLowerCase());
    const legSnapshots = (targetRunId: string) => (this.db.prepare(`SELECT l.id,l.leg_index,l.status,l.query_json,l.error_code,l.error_message,COUNT(i.post_id) AS item_count
      FROM run_legs l LEFT JOIN run_items i ON i.leg_id=l.id WHERE l.run_id=? GROUP BY l.id ORDER BY l.leg_index`).all(targetRunId) as DbRow[])
      .map((row) => ({
        id: row.id as string,
        index: Number(row.leg_index),
        status: row.status as string,
        queryJson: row.query_json as string,
        itemCount: Number(row.item_count),
        errorCode: row.error_code ?? null,
        errorMessage: row.error_message ?? null,
        posts: this.getLegPosts(targetRunId, row.id as string),
      }));
    const currentLegs = legSnapshots(runId);
    const baselineLegs = baselineRunId ? legSnapshots(baselineRunId) : [];
    const baselineLegsByIndex = new Map(baselineLegs.map((leg) => [leg.index, leg]));
    const comparableLegIndexes: number[] = [];
    const unknownLegs: Array<{ legId: string; index: number; status: string; reason: string; code: unknown; message: unknown }> = [];
    const comparableCurrentPosts: XPost[] = [];
    const comparableBaselinePosts: XPost[] = [];
    for (const current of currentLegs) {
      const baseline = baselineLegsByIndex.get(current.index);
      const reason = accountChanged
        ? "account-changed"
        : !baseline
          ? "no-comparable-baseline-leg"
          : baseline.queryJson !== current.queryJson
            ? "query-changed"
            : current.status !== "completed" || baseline.status !== "completed"
              ? "leg-not-completed"
              : current.itemCount === 0 || baseline.itemCount === 0
                ? "empty-leg"
                : null;
      if (reason) {
        unknownLegs.push({ legId: current.id, index: current.index, status: current.status, reason, code: current.errorCode, message: current.errorMessage ?? (current.itemCount === 0 ? "No posts returned" : null) });
      } else if (baseline) {
        comparableLegIndexes.push(current.index);
        comparableCurrentPosts.push(...current.posts);
        comparableBaselinePosts.push(...baseline.posts);
      }
    }
    const comparableCurrentIds = new Set(comparableCurrentPosts.map((post) => post.id));
    const comparableBaselineIds = new Set(comparableBaselinePosts.map((post) => post.id));
    const addedPostIds = baselineRun === null || accountChanged
      ? [...currentIds].sort()
      : [...currentIds].filter((id) => !baselineIds.has(id)).sort();
    const removedPostIds = baselineRun && !accountChanged
      ? [...comparableBaselineIds].filter((id) => !comparableCurrentIds.has(id)).sort()
      : [];
    const unchangedCount = [...comparableCurrentIds].filter((id) => comparableBaselineIds.has(id)).length;
    const baselineById = new Map((baselineRun?.posts ?? []).map((post) => [post.id, post]));
    const currentById = new Map(run.posts.map((post) => [post.id, post]));
    const freshnessMinutes = Number(monitor.definition.freshnessMinutes ?? 1_440);
    const freshnessCutoff = Date.now() - freshnessMinutes * 60_000;
    const newlySurfacedOlderPostIds = addedPostIds.filter((id) => {
      const createdAt = currentById.get(id)?.createdAt;
      return createdAt !== null && createdAt !== undefined && Date.parse(createdAt) < freshnessCutoff;
    });
    const metricChanges = [...comparableCurrentIds].filter((id) => comparableBaselineIds.has(id)).flatMap((id) => meaningfulMetricChanges(baselineById.get(id), currentById.get(id)));
    const baselineAuthors = new Set([...baselineById.values()].map((post) => post.author.id));
    const newAuthors = [...new Map(addedPostIds.map((id) => currentById.get(id)).filter((post): post is XPost => post !== undefined && !baselineAuthors.has(post.author.id)).map((post) => [post.author.id, { id: post.author.id, handle: post.author.handle, url: post.author.url }])).values()];
    const baselineClusters = new Set(clusterPosts(accountChanged ? [] : comparableBaselinePosts).map((cluster) => cluster.label));
    const currentClusters = new Set(clusterPosts(accountChanged ? run.posts : comparableCurrentPosts).map((cluster) => cluster.label));
    const clusterShifts = { added: [...currentClusters].filter((label) => !baselineClusters.has(label)).sort(), removed: [...baselineClusters].filter((label) => !currentClusters.has(label)).sort() };
    const failedOrEmptyLegs = currentLegs.filter((leg) => leg.status === "failed" || leg.itemCount === 0).map((leg) => ({ legId: leg.id, status: leg.status, code: leg.errorCode, message: leg.errorMessage ?? (leg.itemCount === 0 ? "No posts returned" : null) }));
    const sourceLinks = addedPostIds.map((id) => currentById.get(id)?.url).filter((url): url is string => typeof url === "string");
    const comparisonState = baselineRun === null ? "initial" : accountChanged ? "account-changed" : unknownLegs.length ? "partial" : "comparable";
    const diff = {
      monitorId,
      runId,
      baselineRunId,
      comparisonState,
      currentAccountHandle: run.accountHandle,
      baselineAccountHandle: baselineRun?.accountHandle ?? null,
      comparableLegIndexes,
      unknownLegs,
      removalsSuppressed: baselineRun === null || accountChanged || unknownLegs.length > 0,
      addedPostIds,
      newlySurfacedOlderPostIds,
      removedPostIds,
      unchangedCount,
      metricChanges,
      newAuthors,
      clusterShifts,
      failedOrEmptyLegs,
      sourceLinks,
    };
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO monitor_runs(id,monitor_id,run_id,baseline_run_id,diff_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, monitorId, runId, baselineRunId, JSON.stringify(diff), now);
    const row = this.db.prepare("SELECT id,diff_json FROM monitor_runs WHERE monitor_id=? AND run_id=?").get(monitorId, runId) as DbRow;
    return { id: row.id as string, diff: JSON.parse(row.diff_json as string) as Record<string, unknown> };
  }

  commitMonitorRun(monitorId: string, runId: string): void {
    const monitor = this.getMonitor(monitorId);
    const exists = this.db.prepare("SELECT 1 AS present FROM monitor_runs WHERE monitor_id=? AND run_id=?").get(monitorId, runId) as DbRow | undefined;
    if (!exists) throw new XSignalError("INTERNAL", "Monitor diff must be prepared before committing its baseline.");
    const now = new Date().toISOString();
    this.db.prepare("UPDATE monitors SET last_run_id=?,active_run_id=NULL,execution_stage='idle',next_run_at=?,updated_at=? WHERE id=?")
      .run(runId, nextMonitorRun(monitor.definition).toISOString(), now, monitorId);
  }

  completeMonitorRun(monitorId: string, runId: string): { id: string; diff: Record<string, unknown> } {
    const prepared = this.prepareMonitorRun(monitorId, runId);
    this.commitMonitorRun(monitorId, runId);
    return prepared;
  }

  monitorResults(monitorId: string): Array<Record<string, unknown>> {
    this.getMonitor(monitorId);
    return (this.db.prepare("SELECT id,run_id,baseline_run_id,diff_json,created_at FROM monitor_runs WHERE monitor_id=? ORDER BY created_at DESC").all(monitorId) as DbRow[])
      .map((row) => {
        const deliveries = (this.db.prepare("SELECT sink,status,delivered_at AS deliveredAt,error,attempts,next_attempt_at AS nextAttemptAt FROM deliveries WHERE monitor_run_id=? ORDER BY sink").all(row.id as string) as DbRow[])
          .map((delivery) => ({ ...delivery, sink: redactSink(String(delivery.sink)) }));
        return { id: row.id, runId: row.run_id, baselineRunId: row.baseline_run_id, diff: JSON.parse(row.diff_json as string), deliveries, createdAt: row.created_at };
      });
  }

  pruneMonitorHistory(monitorId: string, retentionDays: number, now = new Date()): number {
    const monitor = this.getMonitor(monitorId);
    const cutoff = new Date(now.getTime() - Math.max(1, retentionDays) * 86_400_000).toISOString();
    const rows = this.db.prepare("SELECT run_id FROM monitor_runs WHERE monitor_id=? AND created_at < ? AND run_id != COALESCE(?, '')")
      .all(monitorId, cutoff, monitor.lastRunId) as DbRow[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const removeRun = this.db.prepare("DELETE FROM runs WHERE id=? AND kind='monitor'");
      for (const row of rows) removeRun.run(row.run_id as string);
      this.db.prepare(`DELETE FROM observations WHERE run_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.id=observations.run_id)`).run();
      this.db.prepare(`DELETE FROM posts WHERE NOT EXISTS (SELECT 1 FROM run_items WHERE run_items.post_id=posts.id)
        AND NOT EXISTS (SELECT 1 FROM observations WHERE observations.post_id=posts.id)`).run();
      this.db.prepare(`DELETE FROM authors WHERE NOT EXISTS (
        SELECT 1 FROM posts WHERE json_extract(posts.json,'$.author.id')=authors.id
      )`).run();
      this.db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createDelivery(monitorRunId: string, sink: string): { id: string; state: "ready" | "waiting" | "delivered"; retryAt: string | null } {
    const id = randomUUID();
    const pendingLease = new Date(Date.now() + 5 * 60_000).toISOString();
    const result = this.db.prepare("INSERT OR IGNORE INTO deliveries(id,monitor_run_id,sink,status,next_attempt_at) VALUES(?,?,?,'pending',?)").run(id, monitorRunId, sink, pendingLease);
    if (Number(result.changes) > 0) return { id, state: "ready", retryAt: null };
    const existing = this.db.prepare("SELECT id,status,next_attempt_at FROM deliveries WHERE monitor_run_id=? AND sink=?").get(monitorRunId, sink) as DbRow;
    if (existing.status === "delivered") return { id: existing.id as string, state: "delivered", retryAt: null };
    const retryable = existing.status !== "delivered" && (existing.next_attempt_at === null || Date.parse(existing.next_attempt_at as string) <= Date.now());
    if (retryable) {
      this.db.prepare("UPDATE deliveries SET status='pending',error=NULL,next_attempt_at=? WHERE id=?").run(pendingLease, existing.id as string);
      return { id: existing.id as string, state: "ready", retryAt: null };
    }
    return { id: existing.id as string, state: "waiting", retryAt: existing.next_attempt_at as string | null };
  }

  finishDelivery(id: string, ok: boolean, error?: string): string | null {
    const row = this.db.prepare("SELECT attempts FROM deliveries WHERE id=?").get(id) as DbRow | undefined;
    const attempts = Number(row?.attempts ?? 0) + 1;
    const retryAt = ok ? null : new Date(Date.now() + Math.min(60 * 60_000, 30_000 * (2 ** Math.min(attempts - 1, 7)))).toISOString();
    this.db.prepare("UPDATE deliveries SET status=?,delivered_at=?,error=?,attempts=?,next_attempt_at=? WHERE id=?")
      .run(ok ? "delivered" : "failed", ok ? new Date().toISOString() : null, error ?? null, attempts, retryAt, id);
    return retryAt;
  }

  createExport(sourceType: string, sourceId: string, format: string, filename: string, mimeType: string, content: string): { id: string; uri: string; filename: string; mimeType: string; bytes: number } {
    const id = randomUUID();
    const safeFilename = filename.replace(/[^a-z0-9_.-]/gi, "-");
    this.db.prepare("INSERT INTO exports(id,source_type,source_id,format,filename,mime_type,content,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, sourceType, sourceId, format, safeFilename, mimeType, content, new Date().toISOString());
    fs.writeFileSync(path.join(this.config.exportDir, `${id}-${safeFilename}`), content, { encoding: "utf8", mode: 0o600 });
    return { id, uri: `x-signal://exports/${id}`, filename: safeFilename, mimeType, bytes: Buffer.byteLength(content) };
  }

  getExport(id: string): { id: string; filename: string; mimeType: string; content: string } {
    const row = this.db.prepare("SELECT id,filename,mime_type,content FROM exports WHERE id=?").get(id) as DbRow | undefined;
    if (!row) throw new XSignalError("NOT_FOUND", `No export exists with ID ${id}.`);
    return { id: row.id as string, filename: row.filename as string, mimeType: row.mime_type as string, content: row.content as string };
  }

  hasExports(): boolean {
    const row = this.db.prepare("SELECT EXISTS(SELECT 1 FROM exports LIMIT 1) AS present").get() as DbRow;
    return Boolean(row.present);
  }
}

export function nextMonitorRun(definition: Record<string, unknown>, from = new Date()): Date {
  const cadence = definition.cadence as { type?: string; everyMinutes?: number; atLocalTime?: string } | undefined;
  if (cadence?.type === "daily" && /^\d{2}:\d{2}$/.test(cadence.atLocalTime ?? "")) {
    const [hour = 0, minute = 0] = (cadence.atLocalTime ?? "00:00").split(":").map(Number);
    const timezone = typeof definition.timezone === "string" ? definition.timezone : "UTC";
    const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
    for (let offset = 0; offset <= 49 * 60; offset += 1) {
      const candidate = new Date(start + offset * 60_000);
      const parts = zonedParts(candidate, timezone);
      if (parts.hour === hour && parts.minute === minute) return candidate;
    }
    throw new XSignalError("CAPABILITY_UNAVAILABLE", `Could not schedule ${cadence.atLocalTime} in timezone ${timezone} within 49 hours.`);
  }
  const minutes = cadence?.type === "interval" ? Number(cadence.everyMinutes ?? 60) : Number(definition.everyMinutes ?? 60);
  return new Date(from.getTime() + Math.max(15, minutes) * 60_000);
}

function zonedParts(value: Date, timezone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
  return {
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0),
    minute: Number(parts.find((part) => part.type === "minute")?.value ?? 0),
  };
}

function meaningfulMetricChanges(before: XPost | undefined, after: XPost | undefined): Array<Record<string, unknown>> {
  if (!before || !after) return [];
  const keys = ["likes", "reposts", "quotes", "replies", "views"] as const;
  const changes = keys.flatMap((key) => {
    const from = before.metrics[key];
    const to = after.metrics[key];
    if (from === null || to === null || to === from) return [];
    const delta = to - from;
    const threshold = key === "views" ? 100 : 2;
    if (Math.abs(delta) < threshold && Math.abs(delta) / Math.max(1, from) < 0.1) return [];
    return [{ metric: key, from, to, delta }];
  });
  return changes.length ? [{ postId: after.id, url: after.url, changes }] : [];
}

function mapMonitor(row: DbRow): StoredMonitor {
  return {
    id: row.id as string,
    definition: JSON.parse(row.definition_json as string) as Record<string, unknown>,
    state: row.state as "active" | "paused",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    nextRunAt: row.next_run_at as string | null,
    lastRunId: row.last_run_id as string | null,
    activeRunId: row.active_run_id as string | null,
    executionStage: (row.execution_stage as StoredMonitor["executionStage"] | null) ?? "idle",
  };
}

function redactSink(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return "configured";
  }
}

function canonicalRequestHash(input: XSearchInput, kind: "search" | "monitor", accountHandle: string | null): string {
  const normalized = structuredClone(input) as XSearchInput;
  delete normalized.idempotencyKey;
  return createHash("sha256").update(JSON.stringify({ kind, accountHandle: accountHandle?.toLowerCase() ?? null, input: normalized })).digest("hex");
}

function canonicalContinuationHash(runId: string, requested: Array<{ legId: string; additionalLimit: number }> | null, defaultAdditionalLimit: number, execution: ContinueSearchInput["execution"]): string {
  const legs = requested ? [...requested].sort((a, b) => a.legId.localeCompare(b.legId) || a.additionalLimit - b.additionalLimit) : null;
  return createHash("sha256").update(JSON.stringify({ runId, legs, defaultAdditionalLimit, execution })).digest("hex");
}

function directCursorScopeHash(scope: string): string {
  return createHash("sha256").update(scope).digest("hex");
}

function canonicalMonitorHash(definition: Record<string, unknown>): string {
  const normalized = structuredClone(definition);
  delete normalized.idempotencyKey;
  return createHash("sha256").update(stableJson(normalized)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeStoredPost(value: unknown): XPost {
  const post = value as XPost & { language?: unknown };
  return {
    ...post,
    language: typeof post.language === "string" ? post.language : null,
    quotedPost: post.quotedPost ? normalizeStoredPost(post.quotedPost) : null,
    repostOf: post.repostOf ? normalizeStoredPost(post.repostOf) : null,
  };
}
