import type { SearchFilters } from "../contracts.js";
import { XSignalError } from "../errors.js";

function quoteOperator(value: string): string {
  return `"${value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;
}

function handleGroup(operator: "from" | "to" | "mention", handles: string[]): string | null {
  const normalized = handles.map((value) => {
    const handle = value.replace(/^@/, "");
    if (!/^[a-z0-9_]{1,15}$/i.test(handle)) throw new XSignalError("CAPABILITY_UNAVAILABLE", `Invalid X handle filter '${value}'.`);
    return handle;
  });
  if (!normalized.length) return null;
  const parts = normalized.map((handle) => operator === "mention" ? `@${handle}` : `${operator}:${handle}`);
  return `(${parts.join(" OR ")})`;
}

export function compileQuery(query: string, filters: SearchFilters | undefined): string {
  const parts = [query.trim()];
  if (filters?.since) parts.push(`since:${filters.since}`);
  if (filters?.until) parts.push(`until:${filters.until}`);
  if (filters?.language) parts.push(`lang:${filters.language.split("-")[0]?.replace(/[^a-z]/gi, "") ?? ""}`);
  if (filters?.accounts?.length) parts.push(handleGroup("from", filters.accounts) ?? "");
  if (filters?.toAccounts?.length) parts.push(handleGroup("to", filters.toAccounts) ?? "");
  if (filters?.mentioningAccounts?.length) parts.push(handleGroup("mention", filters.mentioningAccounts) ?? "");
  if (filters?.includeReplies === false) parts.push("-filter:replies");
  if (filters?.includeReposts === false) parts.push("-filter:nativeretweets");
  if (filters?.imagesOnly) parts.push("filter:images");
  else if (filters?.videosOnly) parts.push("filter:videos");
  else if (filters?.mediaOnly) parts.push("filter:media");
  if (filters?.linksOnly) parts.push("filter:links");
  if (filters?.minLikes !== undefined) parts.push(`min_faves:${filters.minLikes}`);
  if (filters?.minReposts !== undefined) parts.push(`min_retweets:${filters.minReposts}`);
  if (filters?.minReplies !== undefined) parts.push(`min_replies:${filters.minReplies}`);
  const effective = parts.filter(Boolean).join(" ");
  if (effective.length > 4_096) throw new XSignalError("CAPABILITY_UNAVAILABLE", `The effective X query is ${effective.length} characters; reduce query text or filter handles below 4096 characters.`);
  return effective;
}

export function searchUrl(query: string, mode: "top" | "latest" | "media"): string {
  const f = mode === "latest" ? "live" : mode === "media" ? "media" : "top";
  return `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=${f}`;
}

export function accountSearchUrl(query: string): string {
  return `https://x.com/search?q=${encodeURIComponent(query.trim())}&src=typed_query&f=user`;
}

export function encodeOffsetCursor(offset: number): string {
  return `offset:${Math.max(0, Math.trunc(offset))}`;
}

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  if (!match?.[1]) throw new XSignalError("INVALID_CURSOR", "Cursor must be an offset token returned by the same X Signal tool.");
  return Number.parseInt(match[1], 10);
}

export function normalizeHandle(value: string): string {
  const trimmed = value.trim();
  const url = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([a-z0-9_]{1,15})\/?(?:[?#].*)?$/i.exec(trimmed);
  const handle = url?.[1] ?? trimmed.replace(/^@/, "");
  if (!/^[a-z0-9_]{1,15}$/i.test(handle)) {
    throw new XSignalError("CAPABILITY_UNAVAILABLE", `Invalid X handle '${value}'. Use an exact @handle or profile URL.`);
  }
  return handle;
}

export function normalizePostId(value: string): string {
  const match = /(?:status\/)?(\d{5,})/.exec(value);
  return match?.[1] ?? value.trim();
}
