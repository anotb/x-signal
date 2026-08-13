import { describe, expect, it } from "vitest";
import { assertSafeSink } from "../src/service.js";

describe("monitor sink boundary", () => {
  it("rejects credential-bearing, plaintext, and private destinations by default", async () => {
    await expect(assertSafeSink("https://user:secret@example.com/hook", false)).rejects.toThrow(/credentials/i);
    await expect(assertSafeSink("http://example.com/hook", false)).rejects.toThrow(/HTTPS/i);
    await expect(assertSafeSink("https://127.0.0.1/hook", false)).rejects.toThrow(/private|loopback/i);
    await expect(assertSafeSink("https://[::ffff:7f00:1]/hook", false)).rejects.toThrow(/private|loopback/i);
    await expect(assertSafeSink("https://[ff02::1]/hook", false)).rejects.toThrow(/private|loopback/i);
  });

  it("supports explicit operator opt-in for local development sinks", async () => {
    await expect(assertSafeSink("http://127.0.0.1:9999/hook", true)).resolves.toBeUndefined();
  });
});
