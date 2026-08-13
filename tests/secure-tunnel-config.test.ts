import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureSecureTunnel, inspectSecureTunnel, validateApiKey, validateTunnelId } from "../scripts/configure-secure-tunnel.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsignal-tunnel-"));
  temporaryRoots.push(root);
  return root;
}

describe("Secure MCP Tunnel local configuration", () => {
  it("mounts the runtime key at the exact file path used by the pinned client", () => {
    const compose = fs.readFileSync(path.resolve("compose.yaml"), "utf8");
    expect(compose).toContain("profiles: [\"chatgpt\"]");
    expect(compose).toContain("target: openai-tunnel-api-key");
    expect(compose).toContain("file:/run/secrets/openai-tunnel-api-key");
    expect(compose).toContain('ALLOW_REMOTE_UI: "true"');
    expect(compose).toContain('"127.0.0.1:7346:8080"');
    expect(compose).toContain("--require-control-plane-poll");
    for (const script of ["scripts/backup.mjs", "scripts/restore.mjs"]) {
      const source = fs.readFileSync(path.resolve(script), "utf8");
      expect(source).toContain('"--profile", "chatgpt"');
      expect(source).toContain('"openai-tunnel"');
    }
  });

  it("stores the tunnel ID in .env and the key in an ignored secret file", () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, ".env"), "XSIGNAL_PORT=7345\n", "utf8");
    const tunnelId = `tunnel_${"a".repeat(16)}`;
    const apiKey = `sk-${"b".repeat(32)}`;

    configureSecureTunnel({ root, tunnelId, apiKey });

    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe(`XSIGNAL_PORT=7345\nOPENAI_TUNNEL_ID=${tunnelId}\n`);
    expect(fs.readFileSync(path.join(root, ".secrets", "openai-tunnel-api-key"), "utf8")).toBe(`${apiKey}\n`);
    expect(inspectSecureTunnel({ root })).toEqual({ status: "ok", tunnelIdConfigured: true, apiKeyConfigured: true });
  });

  it("updates one half without deleting the other", () => {
    const root = temporaryRoot();
    const tunnelId = `tunnel_${"c".repeat(16)}`;
    const firstKey = `sk-${"d".repeat(32)}`;
    const secondKey = `sk-${"e".repeat(32)}`;
    configureSecureTunnel({ root, tunnelId, apiKey: firstKey });

    configureSecureTunnel({ root, apiKey: secondKey });

    expect(inspectSecureTunnel({ root }).status).toBe("ok");
    expect(fs.readFileSync(path.join(root, ".secrets", "openai-tunnel-api-key"), "utf8")).toBe(`${secondKey}\n`);
  });

  it("can save a piped key before a tunnel ID is copied", () => {
    const root = temporaryRoot();
    const apiKey = `sk-${"f".repeat(32)}`;

    expect(configureSecureTunnel({ root, apiKey }).tunnelIdConfigured).toBe(false);
    expect(fs.readFileSync(path.join(root, ".secrets", "openai-tunnel-api-key"), "utf8")).toBe(`${apiKey}\n`);
  });

  it("rejects malformed identifiers and keys", () => {
    expect(() => validateTunnelId("temporary-url")).toThrow(/Tunnel ID/);
    expect(() => validateApiKey("not-a-key")).toThrow(/Runtime API key/);
  });
});
