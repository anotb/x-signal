import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTimeline } from "../../src/x/parser.js";

const source = JSON.parse(fs.readFileSync(new URL("../fixtures/search-timeline.json", import.meta.url), "utf8"));
const instructions = source.data.search_by_raw_query.search_timeline.timeline.instructions;
const provenance = { profile: "fixture", lens: "list", query: null, queryLabel: null, retrievedAt: "2026-08-12T20:00:00.000Z", runId: null, transport: "captured-operation" as const };

describe("exact timeline instruction paths", () => {
  it.each([
    ["list", { data: { list: { tweets_timeline: { timeline: { instructions } } } } }],
    ["community", { data: { communityResults: { result: { ranked_community_timeline: { timeline: { instructions } } } } } }],
  ])("parses the live-observed %s path", (_name, payload) => {
    const parsed = parseTimeline(payload, provenance);
    expect(parsed.posts.length).toBeGreaterThan(0);
    expect(parsed.bottomCursor).toBe("DAABCURSOR");
  });
});
