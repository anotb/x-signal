import { describe, expect, it } from "vitest";
import { MonitorDefinitionSchema, SearchFiltersSchema } from "../src/contracts.js";
import { accountSearchUrl, compileQuery, decodeOffsetCursor, encodeOffsetCursor, normalizeHandle, normalizePostId, searchUrl } from "../src/x/query.js";

describe("query compilation", () => {
  it("adds only bounded supported operators for validated handles", () => {
    const query = compileQuery("MCP Apps", {
      since: "2026-08-01",
      until: "2026-08-12",
      language: "en",
      accounts: ["@example_lab", "researcher_1"],
      toAccounts: ["@researcher_1"],
      mentioningAccounts: ["@Example_Lab"],
      minLikes: 5,
      minReposts: 2,
      minReplies: 3,
      includeReplies: false,
      includeReposts: false,
      mediaOnly: false,
      linksOnly: true,
    });
    expect(query).toContain("since:2026-08-01");
    expect(query).toContain("from:example_lab OR from:researcher_1");
    expect(query).toContain("to:researcher_1");
    expect(query).toContain("@Example_Lab");
    expect(query).toContain("-filter:replies");
    expect(query).toContain("filter:links");
    expect(query).toContain("min_replies:3");
    expect(compileQuery("regional", { language: "pt-BR" })).toBe("regional lang:pt");
  });

  it("builds exact X search lenses and normalizes identifiers", () => {
    expect(searchUrl("a b", "latest")).toContain("f=live");
    expect(searchUrl("a b", "top")).toContain("f=top");
    expect(searchUrl("a b", "media")).toContain("f=media");
    expect(accountSearchUrl("Example Lab")).toContain("f=user");
    expect(normalizeHandle("https://x.com/example_lab")).toBe("example_lab");
    expect(normalizeHandle("@example_lab")).toBe("example_lab");
    expect(() => normalizeHandle("@invalid-news")).toThrow(/Invalid X handle/);
    expect(() => normalizeHandle("https://x.com/example_lab/status/12345")).toThrow(/Invalid X handle/);
    expect(normalizePostId("https://x.com/example_lab/status/1234567890")).toBe("1234567890");
    expect(decodeOffsetCursor(encodeOffsetCursor(80))).toBe(80);
  });

  it("rejects impossible or inverted dates and conflicting media scopes", () => {
    expect(SearchFiltersSchema.safeParse({ since: "2026-02-30" }).success).toBe(false);
    expect(SearchFiltersSchema.safeParse({ until: "2026-13-01" }).success).toBe(false);
    expect(SearchFiltersSchema.safeParse({ since: "2026-08-12", until: "2026-08-01" }).success).toBe(false);
    expect(SearchFiltersSchema.safeParse({ imagesOnly: true, videosOnly: true }).success).toBe(false);
    expect(SearchFiltersSchema.safeParse({ accounts: ["bad handle!"] }).success).toBe(false);
    expect(() => compileQuery("x", { accounts: ["bad handle!"] })).toThrow(/invalid X handle/i);
  });

  it("revalidates shared and per-leg filters after merging", async () => {
    const { XSearchInputSchema } = await import("../src/contracts.js");
    expect(XSearchInputSchema.safeParse({
      filters: { imagesOnly: true },
      queries: [{ query: "x", mode: "media", limit: 5, filters: { videosOnly: true } }],
      execution: "job",
    }).success).toBe(false);
  });

  it("rejects effective queries that exceed the upstream-safe bound instead of truncating", () => {
    expect(() => compileQuery("x".repeat(4_090), { accounts: ["example_a", "example_b", "example_c"] })).toThrow(/effective X query/i);
  });

  it("validates monitor handles without imposing a smaller combined-source ceiling", () => {
    expect(MonitorDefinitionSchema.safeParse({ name: "invalid", accounts: ["not a handle"] }).success).toBe(false);
    expect(MonitorDefinitionSchema.safeParse({
      name: "expanded",
      queries: Array.from({ length: 32 }, (_, index) => ({ query: `topic ${index}`, mode: "latest", limit: 5 })),
      accounts: Array.from({ length: 50 }, (_, index) => `account_${index}`),
      includeFollowing: true,
    }).success).toBe(true);
  });
});
