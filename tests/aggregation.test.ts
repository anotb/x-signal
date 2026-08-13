import { describe, expect, it } from "vitest";
import { clusterPosts, deduplicatePosts, rankPosts, rankPostsWithScores } from "../src/aggregation.js";
import { fixturePost } from "./helpers.js";

describe("deterministic aggregation", () => {
  it("deduplicates IDs, preserves query-match labels, and ranks deterministically", () => {
    const first = fixturePost("1", { text: "Chromium persistent context", provenance: { ...fixturePost("1").provenance, queryLabel: "browser" } });
    const duplicate = fixturePost("1", { provenance: { ...fixturePost("1").provenance, queryLabel: "persistence" } });
    const second = fixturePost("2", { text: "SQLite recovery leases", metrics: { replies: 2, reposts: 4, quotes: 1, likes: 20, views: 1000 } });
    const deduped = deduplicatePosts([first, duplicate, second]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.provenance.queryLabel).toContain("browser");
    expect(deduped[0]?.provenance.queryLabel).toContain("persistence");
    expect(rankPosts(deduped, "balanced", true).map((post) => post.id)).toEqual(rankPosts(deduped, "balanced", true).map((post) => post.id));
    const ranked = rankPostsWithScores(deduped, "balanced", true);
    expect(ranked.ranking).toHaveLength(ranked.posts.length);
    expect(ranked.ranking.find((item) => item.postId === "1")).toMatchObject({ queryCoverage: 2 });
    expect(clusterPosts(deduped)).toEqual(clusterPosts(deduped));
  });

  it("preserves distinct posts with similar wording so clustering, not deduplication, groups evidence", () => {
    const text = "A product announcement with intentionally identical wording across two accounts";
    const first = fixturePost("10", { text });
    const second = fixturePost("11", { text, author: { ...fixturePost("11").author, id: "another-author", handle: "another" } });
    expect(deduplicatePosts([first, second]).map((post) => post.id)).toEqual(["10", "11"]);
  });

  it("selects and merges duplicate observations independently of arrival order", () => {
    const older = fixturePost("same", {
      metrics: { replies: 1, reposts: 1, quotes: 0, likes: 5, views: 100 },
      provenance: { ...fixturePost("same").provenance, lens: "top", queryLabel: "z-angle", retrievedAt: "2026-08-12T12:00:00.000Z" },
    });
    const newer = fixturePost("same", {
      metrics: { replies: 2, reposts: 3, quotes: 1, likes: 25, views: 500 },
      provenance: { ...fixturePost("same").provenance, lens: "latest", queryLabel: "a-angle", retrievedAt: "2026-08-12T13:00:00.000Z" },
    });
    const forward = deduplicatePosts([older, newer]);
    const reverse = deduplicatePosts([newer, older]);
    expect(forward).toEqual(reverse);
    expect(forward[0]).toMatchObject({
      metrics: newer.metrics,
      provenance: { lens: "latest | top", queryLabel: "a-angle | z-angle", retrievedAt: "2026-08-12T13:00:00.000Z" },
    });
  });
});
