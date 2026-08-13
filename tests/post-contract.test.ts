import { describe, expect, it } from "vitest";
import type { XPost } from "../src/contracts.js";
import { adaptPostContext } from "../src/service.js";

describe("post context adapter", () => {
  it("exposes the primary browser post under the MCP contract's post field", () => {
    const primary = { id: "12345" } as XPost;
    const adapted = adaptPostContext({ primary, thread: [], replies: [], quotes: [], warnings: [] });
    expect(adapted).toEqual({ post: primary, thread: [], replies: [], quotes: [], warnings: [] });
    expect(adapted).not.toHaveProperty("primary");
  });
});
