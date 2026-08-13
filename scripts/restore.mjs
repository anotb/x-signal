import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const source = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!source || !process.argv.includes("--confirm-replace")) {
  process.stderr.write("Usage: node scripts/restore.mjs <backup-directory> --confirm-replace\n");
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
if (![1, 2, 3].includes(manifest.version)) throw new Error("Unsupported backup manifest");
const files = manifest.version >= 2 ? manifest.files : manifest.files.map((name) => ({ name, sha256: null }));
for (const file of files) {
  const filename = path.join(source, file.name);
  if (!fs.existsSync(filename)) throw new Error(`Backup is missing ${file.name}`);
  if (file.sha256 && await sha256(filename) !== file.sha256) throw new Error(`Backup checksum failed for ${file.name}`);
}
const tunnelWasRunning = isTunnelRunning();
run(tunnelWasRunning
  ? ["compose", "--profile", "chatgpt", "stop", "openai-tunnel", "x-signal", "browser"]
  : ["compose", "stop", "x-signal", "browser"]);
try {
  restore("x-signal", path.join(source, "xsignal-data.tgz"));
  restore("browser", path.join(source, "xsignal-browser.tgz"));
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

function restore(service, filename) {
  const input = fs.openSync(filename, "r");
  try {
    const command = "find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -xzf - -C /data";
    const result = spawnSync("docker", ["compose", "run", "--rm", "--no-deps", "-T", "--entrypoint", "sh", service, "-c", command], { stdio: [input, "inherit", "inherit"] });
    if (result.status !== 0) throw new Error(`Could not restore ${service}`);
  } finally {
    fs.closeSync(input);
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
