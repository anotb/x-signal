import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const BROWSER_DISPOSABLE_PATHS = [
  "./profile/*/Cache",
  "./profile/*/Code Cache",
  "./profile/*/GPUCache",
  "./profile/*/Service Worker/CacheStorage",
  "./profile/*/Service Worker/ScriptCache",
  "./profile/GrShaderCache",
  "./profile/GraphiteDawnCache",
  "./profile/ShaderCache",
  "./profile/DawnGraphiteCache",
  "./profile/Crashpad",
  "./xvfb.log",
  "./fluxbox.log",
  "./x11vnc.log",
  "./novnc.log",
];

const destination = path.resolve(process.argv[2] || path.join("backups", new Date().toISOString().replace(/[:.]/g, "-")));
fs.mkdirSync(destination, { recursive: true });
const tunnelWasRunning = isTunnelRunning();
run(tunnelWasRunning
  ? ["compose", "--profile", "chatgpt", "stop", "openai-tunnel", "x-signal", "browser"]
  : ["compose", "stop", "x-signal", "browser"]);
try {
  archive("x-signal", path.join(destination, "xsignal-data.tgz"));
  archive("browser", path.join(destination, "xsignal-browser.tgz"), BROWSER_DISPOSABLE_PATHS);
  const files = await Promise.all(["xsignal-data.tgz", "xsignal-browser.tgz"].map(async (name) => ({ name, sha256: await sha256(path.join(destination, name)) })));
  fs.writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify({
    version: 3,
    createdAt: new Date().toISOString(),
    files,
    browserExcludedDisposablePaths: BROWSER_DISPOSABLE_PATHS,
  }, null, 2)}\n`, { mode: 0o600 });
} finally {
  run(tunnelWasRunning
    ? ["compose", "--profile", "chatgpt", "up", "-d", "browser", "x-signal", "openai-tunnel"]
    : ["compose", "up", "-d", "browser", "x-signal"]);
}

function sha256(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(filename);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}
process.stdout.write(`${destination}\n`);

function archive(service, filename, exclusions = []) {
  const output = fs.openSync(filename, "w", 0o600);
  try {
    const tarArgs = ["-czf", "-", ...exclusions.map((entry) => `--exclude=${entry}`), "-C", "/data", "."];
    const result = spawnSync("docker", ["compose", "run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", service, ...tarArgs], { stdio: ["ignore", output, "inherit"] });
    if (result.status !== 0) throw new Error(`Could not archive ${service}`);
  } finally {
    fs.closeSync(output);
  }
}

function run(args) {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed`);
}

function isTunnelRunning() {
  const result = spawnSync("docker", ["compose", "--profile", "chatgpt", "ps", "--status", "running", "-q", "openai-tunnel"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Could not inspect Secure MCP Tunnel state");
  return result.stdout.trim().length > 0;
}
