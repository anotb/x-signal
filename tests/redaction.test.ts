import { describe, expect, it } from "vitest";
import { redact, redactText } from "../src/redaction.js";

describe("secret redaction", () => {
  it("removes browser credentials by key and value pattern", () => {
    const output = redact({ authorization: "Bearer abc.def", nested: { cookie: "auth_token=secret", safe: "value" }, text: "Bearer visible-secret" });
    const json = JSON.stringify(output);
    expect(json).not.toContain("abc.def");
    expect(json).not.toContain("secret");
    expect(json).toContain("value");
    expect(redactText("ct0=csrfvalue")).not.toContain("csrfvalue");
  });
});
