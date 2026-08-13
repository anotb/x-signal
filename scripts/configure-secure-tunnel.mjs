import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";

const tunnelKey = "OPENAI_TUNNEL_ID";
const secretRelativePath = path.join(".secrets", "openai-tunnel-api-key");

export function validateTunnelId(value) {
  const normalized = value.trim();
  if (!/^tunnel_[A-Za-z0-9_-]{8,}$/.test(normalized)) {
    throw new Error("Tunnel ID must start with tunnel_ and contain only letters, numbers, underscores, or hyphens.");
  }
  return normalized;
}

export function validateApiKey(value) {
  const normalized = value.trim();
  if (!/^sk-[A-Za-z0-9_.-]{20,}$/.test(normalized)) {
    throw new Error("Runtime API key does not look like an OpenAI project key.");
  }
  return normalized;
}

function readEnvValue(file, key) {
  if (!fs.existsSync(file)) return undefined;
  const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim() || undefined;
}

function writeAtomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function upsertEnv(file, key, value) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  while (lines.at(-1) === "") lines.pop();
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const next = `${key}=${value}`;
  if (index >= 0) lines[index] = next;
  else lines.push(next);
  writeAtomic(file, `${lines.join("\n")}\n`);
}

export function configureSecureTunnel({ root = process.cwd(), tunnelId, apiKey } = {}) {
  const envFile = path.join(root, ".env");
  const secretFile = path.join(root, secretRelativePath);
  const existingTunnelId = readEnvValue(envFile, tunnelKey);
  const resolvedTunnelId = tunnelId ? validateTunnelId(tunnelId) : existingTunnelId ? validateTunnelId(existingTunnelId) : undefined;
  if (!resolvedTunnelId && apiKey === undefined) throw new Error("Tunnel ID is missing.");
  if (resolvedTunnelId) upsertEnv(envFile, tunnelKey, resolvedTunnelId);
  if (apiKey !== undefined) writeAtomic(secretFile, `${validateApiKey(apiKey)}\n`);
  return { envFile, secretFile, hasApiKey: fs.existsSync(secretFile), tunnelIdConfigured: Boolean(resolvedTunnelId) };
}

export function inspectSecureTunnel({ root = process.cwd() } = {}) {
  const envFile = path.join(root, ".env");
  const secretFile = path.join(root, secretRelativePath);
  validateTunnelId(readEnvValue(envFile, tunnelKey) ?? "");
  if (!fs.existsSync(secretFile)) throw new Error("Runtime key file is missing. Run npm run tunnel:secure:configure.");
  validateApiKey(fs.readFileSync(secretFile, "utf8"));
  return { status: "ok", tunnelIdConfigured: true, apiKeyConfigured: true };
}

async function readAllStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

async function readHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("Hidden input needs an interactive terminal. Pipe the key to --api-key-from-stdin instead.");
  }
  return await new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const finish = () => {
      cleanup();
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          process.stdout.write("•");
        }
      }
    };
    process.stdout.write(prompt);
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function interactiveConfigure() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this command in an interactive terminal, or use the documented stdin flags.");
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const tunnelId = await prompt.question("Secure MCP tunnel ID: ");
  prompt.close();
  const apiKey = await readHidden("Runtime API key (hidden): ");
  configureSecureTunnel({ tunnelId, apiKey });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--check")) {
    process.stdout.write(`${JSON.stringify(inspectSecureTunnel())}\n`);
    return;
  }
  if (args.has("--tunnel-id-from-stdin")) {
    configureSecureTunnel({ tunnelId: await readAllStdin() });
  } else if (args.has("--api-key-from-stdin")) {
    configureSecureTunnel({ apiKey: await readAllStdin() });
  } else {
    await interactiveConfigure();
  }
  process.stdout.write("Secure MCP Tunnel configuration saved to ignored local files. No credential was printed.\n");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
