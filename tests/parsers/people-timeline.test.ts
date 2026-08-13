import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAccountTimeline } from "../../src/x/parser.js";

describe("People SearchTimeline parser", () => {
  it("normalizes current User records separately from posts", () => {
    const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/people-timeline.json", import.meta.url), "utf8"));
    const parsed = parseAccountTimeline(fixture, "example research", "2026-08-12T20:00:00.000Z");
    expect(parsed.bottomCursor).toBe("PEOPLE_CURSOR");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.accounts).toEqual([
      expect.objectContaining({
        id: "3000000000000000001",
        handle: "example_lab",
        displayName: "Example Research Lab",
        url: "https://x.com/example_lab",
        description: "Synthetic parser fixture account.",
        websiteUrl: "https://example.org/",
        verified: true,
        verificationType: "Business",
        followersCount: 1234,
        followingCount: 42,
        postsCount: 321,
        mediaCount: 12,
        protected: false,
        provenance: { query: "example research", retrievedAt: "2026-08-12T20:00:00.000Z", transport: "captured-operation" }
      })
    ]);
  });
});
