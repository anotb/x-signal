import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTimeline } from "../../src/x/parser.js";

const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/post-variants.json", import.meta.url), "utf8")) as unknown;
const provenance = { profile: "fixture", lens: "top", query: "fixture", queryLabel: "fixture", retrievedAt: "2026-08-12T10:00:00.000Z", runId: "fixture", transport: "captured-operation" as const };

describe("post variant parser fixture", () => {
  it("preserves pin, reply, repost, quote, promotion, notes, articles, media, cards, and cursors", () => {
    const parsed = parseTimeline(fixture, provenance);
    const byId = new Map(parsed.posts.map((post) => [post.id, post]));
    expect(byId.get("101")).toMatchObject({ text: "Article title\n\nFirst paragraph.\n\nSecond paragraph.", flags: { pinned: true, article: true } });
    expect(byId.get("102")?.flags.reply).toBe(true);
    expect(byId.get("103")?.repostOf?.id).toBe("90");
    expect(byId.get("104")?.quotedPost?.id).toBe("91");
    expect(byId.get("105")?.flags.promoted).toBe(true);
    expect(byId.get("106")).toMatchObject({ text: "full long-form note", flags: { notePost: true } });
    expect(byId.get("107")?.media.map((item) => item.type)).toEqual(["image", "gif", "video"]);
    expect(byId.get("107")?.media[2]?.url).toBe("https://media.example.invalid/high.mp4");
    expect(byId.get("108")?.media[0]).toMatchObject({ type: "card", url: "https://x.com/i/article/123" });
    expect(parsed.bottomCursor).toBe("bottom-cursor");
  });
});
