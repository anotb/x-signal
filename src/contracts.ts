import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "NOT_AUTHENTICATED",
  "REAUTH_REQUIRED",
  "RATE_LIMITED",
  "UPSTREAM_CHALLENGE",
  "UPSTREAM_CHANGED",
  "CAPABILITY_UNAVAILABLE",
  "INVALID_CURSOR",
  "NOT_FOUND",
  "RUN_NOT_FOUND",
  "CANCELLED",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const XAuthorSchema = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string().nullable(),
  url: z.string().url(),
  avatarUrl: z.string().url().nullable(),
  verified: z.boolean().nullable(),
  followersCount: z.number().int().nonnegative().nullable(),
});
export type XAuthor = z.infer<typeof XAuthorSchema>;

export const XAccountSchema = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string().nullable(),
  url: z.string().url(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  websiteUrl: z.string().url().nullable(),
  avatarUrl: z.string().url().nullable(),
  bannerUrl: z.string().url().nullable(),
  createdAt: z.string().nullable(),
  verified: z.boolean().nullable(),
  verificationType: z.string().nullable(),
  followersCount: z.number().int().nonnegative().nullable(),
  followingCount: z.number().int().nonnegative().nullable(),
  postsCount: z.number().int().nonnegative().nullable(),
  mediaCount: z.number().int().nonnegative().nullable(),
  protected: z.boolean().nullable(),
  possiblySensitive: z.boolean().nullable(),
  provenance: z.object({
    query: z.string(),
    retrievedAt: z.string(),
    transport: z.literal("captured-operation"),
  }),
});
export type XAccount = z.infer<typeof XAccountSchema>;

export const XMediaSchema = z.object({
  type: z.enum(["image", "video", "gif", "card"]),
  url: z.string().url().nullable(),
  previewUrl: z.string().url().nullable(),
  altText: z.string().nullable(),
});

export type XPost = {
  id: string;
  url: string;
  text: string;
  createdAt: string | null;
  language: string | null;
  author: XAuthor;
  metrics: {
    replies: number | null;
    reposts: number | null;
    quotes: number | null;
    likes: number | null;
    views: number | null;
  };
  conversationId: string | null;
  inReplyToPostId: string | null;
  quotedPost: XPost | null;
  repostOf: XPost | null;
  media: Array<z.infer<typeof XMediaSchema>>;
  flags: {
    reply: boolean;
    repost: boolean;
    quote: boolean;
    promoted: boolean;
    pinned: boolean;
    article: boolean;
    notePost: boolean;
  };
  provenance: {
    profile: string | null;
    lens: string;
    query: string | null;
    queryLabel: string | null;
    retrievedAt: string;
    runId: string | null;
    transport: "captured-operation";
  };
};

export const XPostSchema: z.ZodType<XPost> = z.lazy(() =>
  z.object({
    id: z.string(),
    url: z.string().url(),
    text: z.string(),
    createdAt: z.string().nullable(),
    language: z.string().nullable(),
    author: XAuthorSchema,
    metrics: z.object({
      replies: z.number().int().nonnegative().nullable(),
      reposts: z.number().int().nonnegative().nullable(),
      quotes: z.number().int().nonnegative().nullable(),
      likes: z.number().int().nonnegative().nullable(),
      views: z.number().int().nonnegative().nullable(),
    }),
    conversationId: z.string().nullable(),
    inReplyToPostId: z.string().nullable(),
    quotedPost: XPostSchema.nullable(),
    repostOf: XPostSchema.nullable(),
    media: z.array(XMediaSchema),
    flags: z.object({
      reply: z.boolean(),
      repost: z.boolean(),
      quote: z.boolean(),
      promoted: z.boolean(),
      pinned: z.boolean(),
      article: z.boolean(),
      notePost: z.boolean(),
    }),
    provenance: z.object({
      profile: z.string().nullable(),
      lens: z.string(),
      query: z.string().nullable(),
      queryLabel: z.string().nullable(),
      retrievedAt: z.string(),
      runId: z.string().nullable(),
      transport: z.literal("captured-operation"),
    }),
  }),
);

const UtcDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Must be a real UTC calendar date");

const HandleSchema = z.string().regex(/^@?[a-z0-9_]{1,15}$/i, "Must be an X handle with at most 15 letters, digits, or underscores");

export const SearchFiltersSchema = z.object({
  since: UtcDateSchema.optional().describe("Inclusive UTC calendar date (YYYY-MM-DD)"),
  until: UtcDateSchema.optional().describe("Exclusive UTC calendar date (YYYY-MM-DD)"),
  language: z.string().regex(/^[a-z]{2,3}(?:-[a-z]{2})?$/i).optional().describe("Language tag such as en, es, or pt-BR; X search and local verification use its base language"),
  accounts: z.array(HandleSchema).max(25).optional().describe("Only posts authored by any of these handles"),
  toAccounts: z.array(HandleSchema).max(25).optional().describe("Only posts replying to any of these handles"),
  mentioningAccounts: z.array(HandleSchema).max(25).optional().describe("Only posts mentioning any of these handles"),
  minLikes: z.number().int().nonnegative().optional().describe("Minimum like count"),
  minReposts: z.number().int().nonnegative().optional().describe("Minimum repost count"),
  minReplies: z.number().int().nonnegative().optional().describe("Minimum reply count"),
  includeReplies: z.boolean().optional().describe("Include replies; set false to exclude them"),
  includeReposts: z.boolean().optional().describe("Include native reposts; set false to exclude them"),
  mediaOnly: z.boolean().optional().describe("Require any attached media"),
  imagesOnly: z.boolean().optional().describe("Require an image"),
  videosOnly: z.boolean().optional().describe("Require a video or GIF"),
  linksOnly: z.boolean().optional().describe("Require an external link"),
}).superRefine((filters, context) => {
  if (filters.since && filters.until && filters.since >= filters.until) {
    context.addIssue({ code: "custom", message: "since must be earlier than until", path: ["until"] });
  }
  const exclusiveContentFilters = [filters.mediaOnly, filters.imagesOnly, filters.videosOnly].filter(Boolean).length;
  if (exclusiveContentFilters > 1) context.addIssue({ code: "custom", message: "Choose only one of mediaOnly, imagesOnly, or videosOnly" });
});

export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

export const QueryLegSchema = z.object({
  query: z.string().min(1).max(1024).describe("Keywords, phrase, hashtag, or deliberate X query syntax for this research angle"),
  label: z.string().min(1).max(120).optional().describe("Short evidence-lens label used in provenance and synthesis"),
  mode: z.enum(["top", "latest", "media"]).default("top").describe("Top favors relevance, Latest favors recency, Media restricts to X's media search"),
  limit: z.number().int().min(1).max(500).default(40).describe("Target number of unique posts for this leg; choose only as much evidence as the task needs"),
  filters: SearchFiltersSchema.optional().describe("Overrides shared filters for only this leg"),
});

export const AggregationSchema = z.object({
  deduplicate: z.boolean().default(true),
  cluster: z.boolean().default(true),
  rank: z.enum(["balanced", "recency", "engagement"]).default("balanced"),
  authorDiversity: z.boolean().default(true),
});

export const XSearchInputSchema = z.object({
  queries: z.array(QueryLegSchema).min(1).max(32),
  filters: SearchFiltersSchema.optional(),
  aggregation: AggregationSchema.optional(),
  execution: z.enum(["auto", "inline", "job"]).default("auto").describe("auto chooses inline for small work and a durable job for broad work; inline waits for completion; job returns immediately for polling"),
  responseLimit: z.number().int().min(1).max(500).optional().describe("Maximum evidence records returned in each MCP response; defaults to 200 and x_get_evidence retrieves further pages"),
  idempotencyKey: z.string().min(1).max(200).optional().describe("Optional retry key bound to this exact search request; reuse only when retrying a lost response"),
}).superRefine((input, context) => {
  input.queries.forEach((query, index) => {
    const merged = input.filters || query.filters ? { ...input.filters, ...query.filters } : undefined;
    const result = merged ? SearchFiltersSchema.safeParse(merged) : null;
    if (result && !result.success) {
      for (const issue of result.error.issues) context.addIssue({ ...issue, path: ["queries", index, "filters", ...issue.path] });
    }
  });
});
export type XSearchInput = z.infer<typeof XSearchInputSchema>;

export const ClusterSchema = z.object({
  id: z.string(),
  label: z.string(),
  postIds: z.array(z.string()),
  score: z.number(),
});

export const RankingScoreSchema = z.object({
  postId: z.string(),
  score: z.number(),
  engagement: z.number(),
  recency: z.number(),
  queryCoverage: z.number().int().positive(),
  authorPenalty: z.number(),
  lenses: z.array(z.string()),
});

export const SearchResultSchema = z.object({
  runId: z.string(),
  status: z.enum(["queued", "running", "partial", "completed", "failed", "cancelled"]),
  posts: z.array(XPostSchema),
  totalPosts: z.number().int().nonnegative(),
  evidencePage: z.object({
    sort: z.enum(["observation", "balanced", "recency", "engagement"]),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    returnedCount: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
    byteBudgetBytes: z.number().int().positive(),
    estimatedBytes: z.number().int().positive(),
    truncatedByByteBudget: z.boolean(),
  }),
  ranking: z.array(RankingScoreSchema),
  clusters: z.array(ClusterSchema),
  warnings: z.array(z.string()),
  errors: z.array(z.object({ legId: z.string().nullable(), code: ErrorCodeSchema, message: z.string() })),
  legs: z.array(z.object({
    id: z.string(),
    index: z.number().int().nonnegative(),
    label: z.string().nullable(),
    query: z.string(),
    effectiveQuery: z.string(),
    mode: z.enum(["top", "latest", "media"]),
    filterVerification: z.object({ locallyVerified: z.array(z.string()), upstreamOnly: z.array(z.string()) }),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    requestedCount: z.number().int().positive(),
    returnedCount: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })),
  continuation: z.object({
    available: z.boolean(),
    runId: z.string(),
    continuableLegIds: z.array(z.string()),
  }),
  retryAt: z.string().nullable(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const EvidencePageResultSchema = z.object({
  runId: z.string(),
  legId: z.string().nullable(),
  sort: z.enum(["observation", "balanced", "recency", "engagement"]),
  totalPosts: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  returnedCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  byteBudgetBytes: z.number().int().positive(),
  estimatedBytes: z.number().int().positive(),
  truncatedByByteBudget: z.boolean(),
  posts: z.array(XPostSchema),
});
export type EvidencePageResult = z.infer<typeof EvidencePageResultSchema>;

export const ContinueSearchInputSchema = z.object({
  runId: z.string().uuid().describe("Completed or partially completed x_search run to extend in place"),
  additionalLimit: z.number().int().min(1).max(500).default(40).describe("Additional unique posts requested for every selected leg"),
  legs: z.array(z.object({
    legId: z.string().uuid(),
    additionalLimit: z.number().int().min(1).max(500).default(40),
  })).min(1).max(32).optional().describe("Optional per-leg continuation sizes; omit to continue every leg that has more results"),
  execution: z.enum(["auto", "inline", "job"]).default("auto"),
  idempotencyKey: z.string().min(1).max(200).optional().describe("Reuse on a retried continuation request so a lost response cannot increase the target twice"),
});
export type ContinueSearchInput = z.infer<typeof ContinueSearchInputSchema>;

export const AccountSearchResultSchema = z.object({
  query: z.string(),
  accounts: z.array(XAccountSchema),
  nextCursor: z.string().nullable(),
  warnings: z.array(z.string()),
});
export type AccountSearchResult = z.infer<typeof AccountSearchResultSchema>;

export const PostContextSchema = z.enum(["post", "thread", "replies", "quotes", "all"]);
export const PostContextResultSchema = z.object({
  post: XPostSchema,
  thread: z.array(XPostSchema),
  replies: z.array(XPostSchema),
  quotes: z.array(XPostSchema),
  warnings: z.array(z.string()),
});

export const TimelineSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("following") }),
  z.object({ type: z.literal("for_you") }),
  z.object({ type: z.literal("user"), handle: z.string().min(1).max(64) }),
  z.object({ type: z.literal("bookmarks") }),
  z.object({ type: z.literal("list"), id: z.string().min(1) }),
  z.object({ type: z.literal("community"), id: z.string().min(1) }),
]);

export const TimelineResultSchema = z.object({
  source: TimelineSourceSchema,
  posts: z.array(XPostSchema),
  nextCursor: z.string().nullable(),
  warnings: z.array(z.string()),
});

export const RunSchema = z.object({
  id: z.string(),
  kind: z.enum(["search", "monitor"]),
  status: z.enum(["queued", "running", "partial", "completed", "failed", "cancelled"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  totalLegs: z.number().int().nonnegative(),
  completedLegs: z.number().int().nonnegative(),
  failedLegs: z.number().int().nonnegative(),
  browserDispatches: z.number().int().nonnegative(),
  accountHandle: z.string().nullable(),
  retryAt: z.string().nullable(),
});

export const MonitorActionSchema = z.enum(["create", "update", "list", "get", "pause", "resume", "run", "results", "delete"]);
export const MonitorDefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  queries: z.array(QueryLegSchema).max(32).default([]),
  accounts: z.array(HandleSchema).max(50).default([]),
  includeFollowing: z.boolean().default(false),
  cadence: z.discriminatedUnion("type", [
    z.object({ type: z.literal("interval"), everyMinutes: z.number().int().min(15).max(43_200) }),
    z.object({ type: z.literal("daily"), atLocalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }),
  ]).optional(),
  timezone: z.string().min(1).max(100).default("UTC").refine((value) => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
  }, "Must be a supported IANA timezone such as America/New_York or UTC"),
  everyMinutes: z.number().int().min(15).max(43_200).optional().describe("Backward-compatible interval cadence; prefer cadence"),
  freshnessMinutes: z.number().int().min(1).max(525_600).default(1_440),
  include: z.array(z.string().max(120)).max(30).default([]),
  exclude: z.array(z.string().max(120)).max(30).default([]),
  sink: z.union([
    z.string().url(),
    z.object({ type: z.enum(["webhook", "ntfy"]), url: z.string().url() }),
  ]).optional(),
  retentionDays: z.number().int().min(1).max(3650).default(90),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const MonitorSchema = z.object({
  id: z.string(),
  definition: MonitorDefinitionSchema,
  state: z.enum(["active", "paused"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunId: z.string().nullable(),
});

export const MonitorDiffSchema = z.object({
  monitorId: z.string(),
  runId: z.string(),
  baselineRunId: z.string().nullable(),
  addedPostIds: z.array(z.string()),
  removedPostIds: z.array(z.string()),
  unchangedCount: z.number().int().nonnegative(),
});

export type Lens = "top" | "latest" | "people" | "media" | "following" | "for_you" | "user" | "bookmarks" | "post" | "quotes" | "list" | "community";

export type ProvenanceContext = {
  profile: string | null;
  lens: string;
  query: string | null;
  queryLabel: string | null;
  retrievedAt: string;
  runId: string | null;
  transport: "captured-operation";
};
