import type { ProvenanceContext, XAccount, XAuthor, XPost } from "../contracts.js";
import { XSignalError } from "../errors.js";

type JsonRecord = Record<string, unknown>;

export type ParsedTimeline = {
  posts: XPost[];
  topCursor: string | null;
  bottomCursor: string | null;
  warnings: string[];
};

export type ParsedAccountTimeline = {
  accounts: XAccount[];
  topCursor: string | null;
  bottomCursor: string | null;
  warnings: string[];
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    const obj = record(current);
    if (!obj) return undefined;
    current = obj[key];
  }
  return current;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function isoDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function httpUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function parseAccount(value: unknown, query: string, retrievedAt: string): XAccount | null {
  const user = record(value);
  if (!user || text(user.__typename) !== "User") return null;
  const core = record(user.core) ?? {};
  const avatar = record(user.avatar) ?? {};
  const banner = record(user.banner) ?? {};
  const location = record(user.location) ?? {};
  const profileBio = record(user.profile_bio) ?? {};
  const relationships = record(user.relationship_counts) ?? {};
  const tweetCounts = record(user.tweet_counts) ?? {};
  const verification = record(user.verification) ?? {};
  const website = record(user.website) ?? {};
  const privacy = record(user.privacy) ?? {};
  const id = text(user.rest_id) ?? text(user.id);
  const handle = text(core.screen_name);
  if (!id || !handle) return null;
  return {
    id,
    handle,
    displayName: text(core.name),
    url: `https://x.com/${encodeURIComponent(handle)}`,
    description: text(profileBio.description),
    location: text(location.location),
    websiteUrl: httpUrl(website.url),
    avatarUrl: httpUrl(avatar.image_url),
    bannerUrl: httpUrl(banner.image_url),
    createdAt: isoDate(core.created_at),
    verified: typeof verification.verified === "boolean" ? verification.verified : typeof user.is_blue_verified === "boolean" ? user.is_blue_verified : null,
    verificationType: text(verification.verified_type),
    followersCount: integer(relationships.followers),
    followingCount: integer(relationships.following),
    postsCount: integer(tweetCounts.tweets),
    mediaCount: integer(tweetCounts.media_tweets),
    protected: typeof privacy.protected === "boolean" ? privacy.protected : null,
    possiblySensitive: typeof user.possibly_sensitive === "boolean" ? user.possibly_sensitive : null,
    provenance: { query, retrievedAt, transport: "captured-operation" },
  };
}

function unwrapTweet(value: unknown): JsonRecord | null {
  const initial = record(value);
  if (!initial) return null;
  const typename = text(initial.__typename);
  if (typename === "TweetWithVisibilityResults") return record(initial.tweet);
  if (typename === "TweetTombstone" || typename === "TweetUnavailable") return null;
  return initial;
}

function parseAuthor(tweet: JsonRecord): XAuthor | null {
  const user = record(at(tweet, ["core", "user_results", "result"]));
  if (!user) return null;
  const legacy = record(user.legacy) ?? {};
  const core = record(user.core) ?? {};
  const avatar = record(user.avatar) ?? {};
  const relationships = record(user.relationship_counts) ?? {};
  const handle = text(legacy.screen_name) ?? text(core.screen_name);
  const id = text(user.rest_id) ?? text(user.id);
  if (!handle || !id) return null;
  return {
    id,
    handle,
    displayName: text(legacy.name) ?? text(core.name),
    url: `https://x.com/${encodeURIComponent(handle)}`,
    avatarUrl: text(legacy.profile_image_url_https) ?? text(avatar.image_url),
    verified: typeof user.is_blue_verified === "boolean" ? user.is_blue_verified : typeof legacy.verified === "boolean" ? legacy.verified : null,
    followersCount: integer(legacy.followers_count) ?? integer(relationships.followers),
  };
}

function parseMedia(legacy: JsonRecord): XPost["media"] {
  const extended = record(legacy.extended_entities);
  const entities = record(legacy.entities);
  const media = Array.isArray(extended?.media) ? extended.media : Array.isArray(entities?.media) ? entities.media : [];
  const parsed: XPost["media"] = [];
  for (const raw of media) {
    const item = record(raw);
    if (!item) continue;
    const rawType = text(item.type);
    const type = rawType === "photo" ? "image" : rawType === "animated_gif" ? "gif" : rawType === "video" ? "video" : null;
    if (!type) continue;
    const variants = Array.isArray(record(item.video_info)?.variants) ? record(item.video_info)?.variants as unknown[] : [];
    const videoUrl = variants
      .map(record)
      .filter((variant): variant is JsonRecord => variant !== null && text(variant.content_type) === "video/mp4")
      .sort((a, b) => (integer(b.bitrate) ?? 0) - (integer(a.bitrate) ?? 0))
      .map((variant) => text(variant.url))
      .find((url): url is string => url !== null) ?? null;
    parsed.push({
      type,
      url: type === "image" ? text(item.media_url_https) : videoUrl,
      previewUrl: text(item.media_url_https),
      altText: text(item.ext_alt_text),
    });
  }
  const urls = Array.isArray(entities?.urls) ? entities.urls : [];
  const cardUrl = urls.map(record).map((item) => text(item?.expanded_url)).find((url) => url !== null && !/\/status\/\d+/i.test(url));
  if (cardUrl) parsed.push({ type: "card", url: cardUrl, previewUrl: null, altText: null });
  return parsed;
}

function parseArticleText(article: JsonRecord | null): string | null {
  if (!article) return null;
  const title = text(article.title);
  const plain = text(article.plain_text);
  const blocks = at(article, ["content_state", "blocks"]);
  const blockText = Array.isArray(blocks)
    ? blocks.map(record).map((block) => text(block?.text)).filter((value): value is string => value !== null).join("\n\n")
    : null;
  const body = plain ?? blockText;
  if (title && body && !body.startsWith(title)) return `${title}\n\n${body}`;
  return body ?? title;
}

function parseTweet(value: unknown, provenance: ProvenanceContext, entryFlags: { promoted?: boolean; pinned?: boolean } = {}, depth = 0): XPost | null {
  const tweet = unwrapTweet(value);
  if (!tweet) return null;
  const legacy = record(tweet.legacy);
  const id = text(tweet.rest_id);
  const author = parseAuthor(tweet);
  if (!legacy || !id || !author) return null;
  const noteText = text(at(tweet, ["note_tweet", "note_tweet_results", "result", "text"]));
  const article = record(at(tweet, ["article", "article_results", "result"]));
  const articleText = parseArticleText(article);
  const quotedRaw = at(tweet, ["quoted_status_result", "result"]);
  const repostRaw = at(legacy, ["retweeted_status_result", "result"]);
  const quotedPost = depth === 0 && quotedRaw ? parseTweet(quotedRaw, provenance, {}, 1) : null;
  const repostOf = depth === 0 && repostRaw ? parseTweet(repostRaw, provenance, {}, 1) : null;
  return {
    id,
    url: `https://x.com/${encodeURIComponent(author.handle)}/status/${id}`,
    text: noteText ?? articleText ?? text(legacy.full_text) ?? "",
    createdAt: isoDate(legacy.created_at),
    language: text(legacy.lang),
    author,
    metrics: {
      replies: integer(legacy.reply_count),
      reposts: integer(legacy.retweet_count),
      quotes: integer(legacy.quote_count),
      likes: integer(legacy.favorite_count),
      views: integer(at(tweet, ["views", "count"])),
    },
    conversationId: text(legacy.conversation_id_str),
    inReplyToPostId: text(legacy.in_reply_to_status_id_str),
    quotedPost,
    repostOf,
    media: parseMedia(legacy),
    flags: {
      reply: text(legacy.in_reply_to_status_id_str) !== null,
      repost: repostOf !== null,
      quote: quotedPost !== null || legacy.is_quote_status === true,
      promoted: entryFlags.promoted === true,
      pinned: entryFlags.pinned === true,
      article: article !== null,
      notePost: noteText !== null,
    },
    provenance,
  };
}

const INSTRUCTION_PATHS: ReadonlyArray<readonly string[]> = [
  ["data", "search_by_raw_query", "search_timeline", "timeline", "instructions"],
  ["data", "home", "home_timeline_urt", "instructions"],
  ["data", "home", "home_latest_timeline", "timeline", "instructions"],
  ["data", "user", "result", "timeline", "timeline", "instructions"],
  ["data", "bookmark_timeline_v2", "timeline", "instructions"],
  ["data", "threaded_conversation_with_injections_v2", "instructions"],
  ["data", "search_by_raw_query", "search_timeline", "timeline", "timeline", "instructions"],
  ["data", "list", "tweets_timeline", "timeline", "instructions"],
  ["data", "communityResults", "result", "ranked_community_timeline", "timeline", "instructions"],
];

function findInstructions(payload: unknown): unknown[] {
  for (const path of INSTRUCTION_PATHS) {
    const candidate = at(payload, path);
    if (Array.isArray(candidate)) return candidate;
  }
  throw new XSignalError("UPSTREAM_CHANGED", "No supported X timeline instruction path was present in the response.", {
    remediation: "Refresh the smallest relevant X page to capture the current operation and update its parser fixture.",
  });
}

function entryTweetCandidates(entry: JsonRecord): Array<{ value: unknown; promoted: boolean; pinned: boolean }> {
  const content = record(entry.content);
  if (!content) return [];
  const entryId = text(entry.entryId) ?? "";
  const promoted = record(content.promotedMetadata) !== null || entryId.startsWith("promoted-");
  const pinned = entry._xsignalPinned === true || entryId.startsWith("pin-") || entryId.startsWith("pinned-");
  const values: Array<{ value: unknown; promoted: boolean; pinned: boolean }> = [];
  const direct = at(content, ["itemContent", "tweet_results", "result"]);
  if (direct) values.push({ value: direct, promoted, pinned });
  const directV2 = at(content, ["itemContent", "tweetResult", "result"]);
  if (directV2) values.push({ value: directV2, promoted, pinned });
  const moduleItems = Array.isArray(content.items) ? content.items : [];
  for (const rawItem of moduleItems) {
    const item = record(rawItem);
    if (!item) continue;
    const candidate = at(item, ["item", "itemContent", "tweet_results", "result"])
      ?? at(item, ["item", "itemContent", "tweetResult", "result"])
      ?? at(item, ["itemContent", "tweet_results", "result"]);
    if (candidate) {
      const itemContent = record(at(item, ["item", "itemContent"])) ?? record(item.itemContent);
      values.push({ value: candidate, promoted: promoted || record(itemContent?.promotedMetadata) !== null, pinned });
    }
  }
  return values;
}

function entryAccountCandidates(entry: JsonRecord): unknown[] {
  const content = record(entry.content);
  if (!content) return [];
  const values: unknown[] = [];
  const direct = at(content, ["itemContent", "user_results", "result"])
    ?? at(content, ["itemContent", "userResult", "result"]);
  if (direct) values.push(direct);
  const moduleItems = Array.isArray(content.items) ? content.items : [];
  for (const rawItem of moduleItems) {
    const item = record(rawItem);
    if (!item) continue;
    const candidate = at(item, ["item", "itemContent", "user_results", "result"])
      ?? at(item, ["item", "itemContent", "userResult", "result"])
      ?? at(item, ["itemContent", "user_results", "result"]);
    if (candidate) values.push(candidate);
  }
  return values;
}

export function parseTimeline(payload: unknown, provenance: ProvenanceContext): ParsedTimeline {
  const instructions = findInstructions(payload);
  const entries: JsonRecord[] = [];
  for (const rawInstruction of instructions) {
    const instruction = record(rawInstruction);
    if (!instruction) continue;
    if (Array.isArray(instruction.entries)) {
      for (const rawEntry of instruction.entries) {
        const item = record(rawEntry);
        if (item) entries.push(instruction.type === "TimelinePinEntry" ? { ...item, _xsignalPinned: true } : item);
      }
    }
    const single = record(instruction.entry);
    if (single) entries.push(instruction.type === "TimelinePinEntry" ? { ...single, _xsignalPinned: true } : single);
  }

  const posts: XPost[] = [];
  let candidates = 0;
  let topCursor: string | null = null;
  let bottomCursor: string | null = null;
  for (const entry of entries) {
    const cursorType = text(at(entry, ["content", "cursorType"]));
    const cursorValue = text(at(entry, ["content", "value"]));
    if (cursorType === "Top" && cursorValue) topCursor = cursorValue;
    if (cursorType === "Bottom" && cursorValue) bottomCursor = cursorValue;
    for (const candidate of entryTweetCandidates(entry)) {
      candidates += 1;
      const parsed = parseTweet(candidate.value, provenance, candidate);
      if (parsed) posts.push(parsed);
    }
  }
  const unique = [...new Map(posts.map((post) => [post.id, post])).values()];
  const warnings: string[] = [];
  if (candidates === 0) warnings.push("The operation succeeded but contained no recognizable post entries.");
  else if (posts.length === 0) warnings.push(`The operation contained ${candidates} post entries, but none were parseable (for example unavailable or tombstoned records).`);
  else if (posts.length < candidates) warnings.push(`Skipped ${candidates - posts.length} unavailable, tombstoned, or unparseable post entries.`);
  if (unique.length < posts.length) warnings.push(`Collapsed ${posts.length - unique.length} repeated observations of the same post ID within this response.`);
  return {
    posts: unique,
    topCursor,
    bottomCursor,
    warnings,
  };
}

export function parseAccountTimeline(payload: unknown, query: string, retrievedAt = new Date().toISOString()): ParsedAccountTimeline {
  const instructions = findInstructions(payload);
  const entries: JsonRecord[] = [];
  for (const rawInstruction of instructions) {
    const instruction = record(rawInstruction);
    if (!instruction) continue;
    if (Array.isArray(instruction.entries)) {
      for (const rawEntry of instruction.entries) {
        const item = record(rawEntry);
        if (item) entries.push(item);
      }
    }
    const single = record(instruction.entry);
    if (single) entries.push(single);
  }

  const accounts: XAccount[] = [];
  let candidates = 0;
  let topCursor: string | null = null;
  let bottomCursor: string | null = null;
  for (const entry of entries) {
    const cursorType = text(at(entry, ["content", "cursorType"]));
    const cursorValue = text(at(entry, ["content", "value"]));
    if (cursorType === "Top" && cursorValue) topCursor = cursorValue;
    if (cursorType === "Bottom" && cursorValue) bottomCursor = cursorValue;
    for (const candidate of entryAccountCandidates(entry)) {
      candidates += 1;
      const parsed = parseAccount(candidate, query, retrievedAt);
      if (parsed) accounts.push(parsed);
    }
  }
  const unique = [...new Map(accounts.map((account) => [account.id, account])).values()];
  const warnings: string[] = [];
  if (candidates === 0) warnings.push("The People operation succeeded but contained no recognizable account entries.");
  else if (accounts.length === 0) warnings.push(`The People operation contained ${candidates} account entries, but none were parseable.`);
  else if (accounts.length < candidates) warnings.push(`Skipped ${candidates - accounts.length} unavailable or unparseable account entries.`);
  if (unique.length < accounts.length) warnings.push(`Collapsed ${accounts.length - unique.length} repeated observations of the same account ID within this response.`);
  return {
    accounts: unique,
    topCursor,
    bottomCursor,
    warnings,
  };
}

export function containsLoginState(payload: unknown): boolean {
  const account = at(payload, ["data", "viewer", "user_results", "result"]);
  return account !== undefined && account !== null;
}
