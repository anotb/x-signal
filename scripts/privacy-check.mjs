import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const allowedShowcaseImages = new Set([
  "docs/assets/x-signal-live-humanoid-robots.jpg",
  "docs/assets/x-signal-live-wide-research.png",
]);
const forbiddenTracked = [
  /^\.app\.json$/,
  /(?:^|\/)\.env(?:\.(?!example$)[^/]+)?$/i,
  /(?:^|\/)\.secrets\//i,
  /(?:^|\/)backups?\//i,
  /(?:^|\/)exports?\//i,
  /(?:^|\/)screenshots?\//i,
  /(?:^|\/)evidence\/private\//i,
  /(?:^|\/)\.codex\/pro-reviews\//i,
  /(?:^|\/)(?:profile|cookies?)(?:\/|$)/i,
  /\.(?:sqlite(?:-shm|-wal)?|tgz|tar|zip)$/i,
];

const failures = [];
for (const file of tracked) {
  if (forbiddenTracked.some((pattern) => pattern.test(file))) failures.push(`private artifact is tracked: ${file}`);
  if (/\.(?:png|jpe?g|gif|webp)$/i.test(file) && !allowedShowcaseImages.has(file.replaceAll("\\", "/"))) {
    failures.push(`unreviewed image asset is tracked: ${file}`);
  }
  if (allowedShowcaseImages.has(file.replaceAll("\\", "/"))) {
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 * 1024) failures.push(`showcase image exceeds 2 MiB review limit: ${file}`);
  }
}

const textFiles = tracked.filter((file) => {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= 2 * 1024 * 1024 && !/\.(?:png|jpe?g|gif|webp|ico|woff2?)$/i.test(file);
  } catch {
    return false;
  }
});

const privatePatterns = [
  { name: "local Windows user path", pattern: /C:\\Users\\(?!USERNAME(?:\\|$)|YOUR_USERNAME(?:\\|$)|you(?:\\|$))[^\\\r\n]+/i },
  { name: "ChatGPT registration ID", pattern: /asdk_app_[A-Za-z0-9_-]+/ },
  { name: "named Chrome session-source identifier", pattern: /(?:source|sessionSource)(?:\s+ID)?\s*[`"':=]+\s*[0-9a-f]{8}-[0-9a-f-]{27,}/i },
  { name: "live X acceptance handle", pattern: /(?:authenticated|Docker reports|signed-in identity|selected source)\s+(?:as\s+)?`?@[A-Za-z0-9_]{1,15}\b/i },
  { name: "temporary tunnel hostname", pattern: /https?:\/\/[^\s"')]*(?:trycloudflare\.com|ngrok(?:-free)?\.app)/i },
  { name: "OpenAI runtime API key", pattern: /\bsk-[A-Za-z0-9_.-]{20,}\b/ },
  { name: "Secure MCP tunnel identity", pattern: /\btunnel_[A-Za-z0-9_-]{24,}\b/ },
  { name: "private-key material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "obvious bearer/cookie secret", pattern: /\b(?:auth_token|ct0|XSIGNAL_MCP_BEARER_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_%+\/.=-]{20,}/i },
];

for (const file of textFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const { name, pattern } of privatePatterns) {
    if (pattern.test(text)) failures.push(`${name} appears in tracked file: ${file}`);
  }
  if (/\.md$/i.test(file)) {
    if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) failures.push(`runtime UUID appears in publishable documentation: ${file}`);
    if (/\b[0-9]{15,22}\b/.test(text)) failures.push(`long post/account ID appears in publishable documentation: ${file}`);
    if (/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s"')]+\/status\/[0-9]+/i.test(text)) failures.push(`direct X post URL appears in publishable documentation: ${file}`);
  }
  if (file.startsWith("tests/fixtures/")) {
    if (/pbs\.twimg\.com|platform\.twitter\.com|api\.x\.com|\bOpenAI\b|openai\.com/i.test(text)) failures.push(`parser fixture contains non-synthetic account or production asset data: ${file}`);
  }
}

if (failures.length) {
  process.stderr.write(`Privacy check failed:\n${[...new Set(failures)].map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(JSON.stringify({ status: "ok", trackedFiles: tracked.length, scannedTextFiles: textFiles.length }) + "\n");
