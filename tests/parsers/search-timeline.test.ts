import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTimeline } from "../../src/x/parser.js";

const payload = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/search-timeline.json"), "utf8")) as unknown;
const provenance = {
  profile: "fixture",
  lens: "top",
  query: "fixture query",
  queryLabel: "fixture leg",
  retrievedAt: "2026-08-12T12:15:00.000Z",
  runId: "fixture-run",
  transport: "captured-operation" as const,
};

describe("SearchTimeline parser", () => {
  it("normalizes known timeline entries without promoting nested quotes to top-level results", () => {
    const parsed = parseTimeline(payload, provenance);
    expect(parsed.posts).toHaveLength(2);
    expect(parsed.bottomCursor).toBe("DAABCURSOR");
    expect(parsed.topCursor).toBe("TOPCURSOR");
    const primary = parsed.posts[0]!;
    expect(primary.id).toBe("1000000000000000001");
    expect(primary.text).toContain("Long-form fixture note");
    expect(primary.author.handle).toBe("fixture_author");
    expect(primary.author.followersCount).toBe(1234);
    expect(primary.flags.notePost).toBe(true);
    expect(primary.flags.quote).toBe(true);
    expect(primary.media.map((item) => item.type)).toEqual(["image", "card"]);
    expect(primary.quotedPost?.id).toBe("1000000000000000999");
    expect(parsed.posts.some((post) => post.id === "1000000000000000999")).toBe(false);
  });

  it("distinguishes a conversation-module reply", () => {
    const reply = parseTimeline(payload, provenance).posts[1]!;
    expect(reply.flags.reply).toBe(true);
    expect(reply.inReplyToPostId).toBe("1000000000000000001");
    expect(reply.conversationId).toBe("1000000000000000001");
  });

  it("reports unavailable or unparseable candidate records instead of dropping them silently", () => {
    const changed = structuredClone(payload) as any;
    changed.data.search_by_raw_query.search_timeline.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result = { __typename: "TweetTombstone" };
    const parsed = parseTimeline(changed, provenance);
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.warnings).toEqual([expect.stringMatching(/Skipped 1 unavailable, tombstoned, or unparseable/i)]);
  });

  it("returns a stable upstream-change error for an unknown shape", () => {
    expect(() => parseTimeline({ data: {} }, provenance)).toThrow(/No supported X timeline instruction path/);
  });
});
