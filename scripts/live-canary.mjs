import { spawnSync } from "node:child_process";

// Run the canary inside the deployed application container so the observed
// success is recorded in the same persistent SQLite database exposed by
// x_status. Docker smoke separately verifies the Streamable HTTP MCP surface.
const result = spawnSync(
  "docker",
  ["compose", "exec", "-T", "x-signal", "node", "dist/src/cli.js", "canary"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Live canary failed with exit code ${result.status ?? "unknown"}.`);

// Keep account handles and durable run IDs in the private runtime database,
// where x_status can use them for continuity checks. CI/terminal output only
// needs the non-identifying acceptance summary.
let record;
try {
  const payload = result.stdout.match(/\{\s*"at"\s*:[\s\S]*\}\s*$/)?.[0];
  if (!payload) throw new Error("missing canary payload");
  record = JSON.parse(payload);
} catch {
  throw new Error("Live canary returned an unreadable result.");
}
process.stdout.write(`${JSON.stringify({
  status: "ok",
  at: record.at,
  postCount: record.postCount,
  lenses: record.lenses,
}, null, 2)}\n`);
