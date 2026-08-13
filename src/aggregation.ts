import { createHash } from "node:crypto";
import type { XPost } from "./contracts.js";

export type RankMode = "balanced" | "recency" | "engagement";

export type RankingScore = {
  postId: string;
  score: number;
  engagement: number;
  recency: number;
  queryCoverage: number;
  authorPenalty: number;
  lenses: string[];
};

function engagement(post: XPost): number {
  const { likes, reposts, quotes, replies, views } = post.metrics;
  return (likes ?? 0) + (reposts ?? 0) * 2 + (quotes ?? 0) * 2.5 + (replies ?? 0) * 1.25 + Math.log10((views ?? 0) + 1);
}

function recency(post: XPost, nowMs: number): number {
  const created = post.createdAt ? Date.parse(post.createdAt) : 0;
  if (!created) return 0;
  return Math.max(0, 1 - (nowMs - created) / (7 * 24 * 60 * 60 * 1000));
}

export function rankPostsWithScores(posts: XPost[], mode: RankMode, authorDiversity: boolean): { posts: XPost[]; ranking: RankingScore[] } {
  const nowMs = posts.map((post) => post.provenance.retrievedAt).map(Date.parse).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? Date.now();
  const maxEngagement = Math.max(1, ...posts.map(engagement));
  const scored = posts.map((post) => {
    const engagementScore = engagement(post) / maxEngagement;
    const recencyScore = recency(post, nowMs);
    const queryCoverage = Math.max(1, new Set((post.provenance.queryLabel ?? "").split(" | ").filter(Boolean)).size);
    const coverageScore = Math.min(1, queryCoverage / 3);
    const score = mode === "recency" ? recencyScore : mode === "engagement" ? engagementScore : engagementScore * 0.5 + recencyScore * 0.4 + coverageScore * 0.1;
    return { post, score, engagementScore, recencyScore, queryCoverage };
  }).sort((a, b) => b.score - a.score || a.post.id.localeCompare(b.post.id));
  const authorCounts = new Map<string, number>();
  const adjusted = scored.map((item) => {
      const count = authorCounts.get(item.post.author.id) ?? 0;
      authorCounts.set(item.post.author.id, count + 1);
      const authorPenalty = authorDiversity ? 1 / (1 + count * 0.4) : 1;
      return { ...item, authorPenalty, adjusted: item.score * authorPenalty };
    })
    .sort((a, b) => b.adjusted - a.adjusted || a.post.id.localeCompare(b.post.id));
  return {
    posts: adjusted.map(({ post }) => post),
    ranking: adjusted.map((item) => ({
      postId: item.post.id,
      score: rounded(item.adjusted),
      engagement: rounded(item.engagementScore),
      recency: rounded(item.recencyScore),
      queryCoverage: item.queryCoverage,
      authorPenalty: rounded(item.authorPenalty),
      lenses: [...new Set(item.post.provenance.lens.split(" | ").filter(Boolean))].sort(),
    })),
  };
}

export function rankPosts(posts: XPost[], mode: RankMode, authorDiversity: boolean): XPost[] {
  return rankPostsWithScores(posts, mode, authorDiversity).posts;
}

export function deduplicatePosts(posts: XPost[]): XPost[] {
  const byId = new Map<string, XPost[]>();
  const order: string[] = [];
  for (const post of posts) {
    const observations = byId.get(post.id);
    if (!observations) {
      byId.set(post.id, [post]);
      order.push(post.id);
    } else observations.push(post);
  }
  return order.map((id) => {
    const observations = byId.get(id)!;
    const canonical = [...observations].sort(compareCanonicalObservation).at(-1)!;
    const queryLabel = [...new Set(observations.flatMap((post) => (post.provenance.queryLabel ?? "").split(" | ").filter(Boolean)))].sort().join(" | ") || null;
    const lens = [...new Set(observations.flatMap((post) => post.provenance.lens.split(" | ").filter(Boolean)))].sort().join(" | ");
    return { ...canonical, provenance: { ...canonical.provenance, queryLabel, lens } };
  });
}

function compareCanonicalObservation(left: XPost, right: XPost): number {
  const retrieved = Date.parse(left.provenance.retrievedAt) - Date.parse(right.provenance.retrievedAt);
  if (Number.isFinite(retrieved) && retrieved !== 0) return retrieved;
  const richness = postRichness(left) - postRichness(right);
  if (richness !== 0) return richness;
  return stablePostJson(left).localeCompare(stablePostJson(right));
}

function postRichness(post: XPost): number {
  return post.text.length
    + post.media.length * 100
    + Object.values(post.metrics).filter((value) => value !== null).length * 20
    + (post.quotedPost ? 100 : 0)
    + (post.repostOf ? 100 : 0)
    + (post.createdAt ? 10 : 0);
}

function stablePostJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePostJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stablePostJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

const STOP = new Set(["about", "after", "again", "also", "been", "being", "could", "does", "from", "have", "into", "more", "most", "over", "that", "their", "there", "these", "they", "this", "those", "through", "under", "very", "what", "when", "where", "which", "with", "would", "https", "http"]);

function keywords(post: XPost): string[] {
  return [...new Set(post.text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])].filter((word) => !STOP.has(word)).slice(0, 20);
}

export function clusterPosts(posts: XPost[]): Array<{ id: string; label: string; postIds: string[]; score: number }> {
  const buckets = new Map<string, XPost[]>();
  for (const post of posts) {
    const key = keywords(post)[0] ?? `author:${post.author.handle.toLowerCase()}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(post);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([label, values]) => ({
      id: createHash("sha256").update(`${label}:${values.map((post) => post.id).sort().join(",")}`).digest("hex").slice(0, 16),
      label,
      postIds: values.map((post) => post.id),
      score: Number(values.reduce((sum, post) => sum + engagement(post), 0).toFixed(3)),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
