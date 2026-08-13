import { describe, expect, it } from "vitest";
import { normalizeSessionCookies, SessionSyncRequestSchema, sessionDigest } from "../src/session.js";

describe("session companion boundary", () => {
  it("accepts only X-owned cookie domains and maps Chrome SameSite values", () => {
    const cookies = normalizeSessionCookies([
      { name: "auth_token", value: "secret", domain: ".x.com", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction" },
      { name: "ignored", value: "secret", domain: ".example.com", path: "/" },
    ]);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: "auth_token", domain: ".x.com", sameSite: "None" });
  });

  it("deduplicates deterministically and hashes values without exposing them", () => {
    const cookies = normalizeSessionCookies([
      { name: "ct0", value: "old", domain: ".x.com", path: "/" },
      { name: "ct0", value: "new", domain: ".x.com", path: "/" },
    ]);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.value).toBe("new");
    expect(sessionDigest(cookies)).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionDigest(cookies)).not.toContain("new");
  });

  it("rejects non-versioned and oversized sync payloads", () => {
    expect(SessionSyncRequestSchema.safeParse({ reason: "periodic", cookies: [] }).success).toBe(false);
    expect(SessionSyncRequestSchema.safeParse({ version: 1, reason: "periodic", cookies: new Array(513).fill({ name: "a", value: "", domain: ".x.com", path: "/" }) }).success).toBe(false);
  });

  it("accepts a portable named Chrome-profile source and intentional activation", () => {
    expect(SessionSyncRequestSchema.safeParse({
      version: 1,
      reason: "manual",
      cookies: [],
      source: { id: "00000000-0000-4000-8000-000000000001", label: "Alternate X" },
      activate: true,
    }).success).toBe(true);
  });
});
