import type { Config } from "../src/config.js";
import type { XPost } from "../src/contracts.js";

export function testConfig(dataDir: string): Config {
  return {
    version: "0.1.0-rc.5",
    port: 7345,
    dataDir,
    databasePath: `${dataDir}/x-signal.sqlite`,
    exportDir: `${dataDir}/exports`,
    browserCdpUrl: "http://127.0.0.1:1",
    maxBrowserConcurrency: 2,
    requestSpacingMs: 1,
    logLevel: "silent",
    bearerToken: null,
    debugTools: false,
    allowPrivateMonitorSinks: false,
  };
}

export function fixturePost(id: string, overrides: Partial<XPost> = {}): XPost {
  return {
    id,
    url: `https://x.com/fixture/status/${id}`,
    text: `Fixture post ${id}`,
    createdAt: "2026-08-12T12:00:00.000Z",
    language: "en",
    author: { id: `author-${id}`, handle: `author_${id}`, displayName: "Fixture", url: `https://x.com/author_${id}`, avatarUrl: null, verified: false, followersCount: 10 },
    metrics: { replies: 1, reposts: 2, quotes: 0, likes: 5, views: 100 },
    conversationId: id,
    inReplyToPostId: null,
    quotedPost: null,
    repostOf: null,
    media: [],
    flags: { reply: false, repost: false, quote: false, promoted: false, pinned: false, article: false, notePost: false },
    provenance: { profile: "fixture", lens: "top", query: "fixture", queryLabel: "fixture", retrievedAt: "2026-08-12T12:10:00.000Z", runId: null, transport: "captured-operation" },
    ...overrides,
  };
}
