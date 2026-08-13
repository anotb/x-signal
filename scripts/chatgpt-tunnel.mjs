import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const appReadyUrl = process.env.XSIGNAL_READY_URL ?? "http://127.0.0.1:7345/readyz";
const proxyScript = fileURLToPath(new URL("./tunnel-proxy.mjs", import.meta.url));
const token = randomBytes(32).toString("base64url");
const children = new Set();
let stopping = false;

function tail(text, limit = 4_000) {
  return text.length > limit ? text.slice(-limit) : text;
}

async function checkReady() {
  let response;
  try {
    response = await fetch(appReadyUrl, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(`X Signal is not reachable at ${appReadyUrl}. Start it with docker compose up -d --build --wait.`, { cause: error });
  }
  if (!response.ok) throw new Error(`X Signal returned HTTP ${response.status} from ${appReadyUrl}.`);
}

function start(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function watchFailure(child, label) {
  return new Promise((resolve) => {
    child.once("error", (error) => {
      if (!stopping) resolve(new Error(`${label} failed: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (!stopping) resolve(new Error(`${label} stopped unexpectedly (${signal ?? `code ${code}`}).`));
    });
  });
}

async function readyBeforeFailure(ready, failures) {
  const outcome = await Promise.race([
    ready.then((value) => ({ value })),
    ...failures.map((failure) => failure.then((error) => ({ error }))),
  ]);
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

function waitForOutput(child, streams, match, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let output = "";
    const listeners = [];
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      for (const [stream, listener] of listeners) stream.off("data", listener);
    };
    const onError = (error) => {
      cleanup();
      reject(new Error(`${label} could not start: ${error.message}`));
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`${label} exited before it was ready (${signal ?? `code ${code}`}).${output ? `\n${tail(output).trim()}` : ""}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} did not become ready within ${Math.round(timeoutMs / 1_000)} seconds.${output ? `\n${tail(output).trim()}` : ""}`));
    }, timeoutMs);
    for (const stream of streams) {
      const listener = (chunk) => {
        output = tail(output + chunk.toString());
        const result = match(output);
        if (result !== undefined) {
          cleanup();
          resolve(result);
        }
      };
      listeners.push([stream, listener]);
      stream.on("data", listener);
    }
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function stopAll() {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([...children].map(stopChild));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await stopAll();
    process.exit(0);
  });
}

try {
  await checkReady();

  const proxy = start(process.execPath, [proxyScript], {
    env: {
      ...process.env,
      XSIGNAL_TUNNEL_PATH_TOKEN: token,
      XSIGNAL_TUNNEL_PROXY_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proxyFailure = watchFailure(proxy, "Local tunnel proxy");
  const proxyPort = await readyBeforeFailure(
    waitForOutput(
      proxy,
      [proxy.stdout, proxy.stderr],
      (output) => {
        const match = output.match(/"status":"ready"[^\n]*"port":(\d+)/);
        return match ? Number.parseInt(match[1], 10) : undefined;
      },
      10_000,
      "Local tunnel proxy",
    ),
    [proxyFailure],
  );

  const cloudflared = start("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${proxyPort}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cloudflaredFailure = watchFailure(cloudflared, "cloudflared");
  const publicOrigin = await readyBeforeFailure(
    waitForOutput(
      cloudflared,
      [cloudflared.stdout, cloudflared.stderr],
      (output) => output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0],
      45_000,
      "cloudflared",
    ),
    [proxyFailure, cloudflaredFailure],
  );
  cloudflared.stdout.resume();
  cloudflared.stderr.resume();

  process.stdout.write(`\nX Signal is ready for ChatGPT:\n\n${publicOrigin}/${token}\n\n`);
  process.stdout.write("Treat this URL like a password. Keep this terminal open; press Ctrl+C to stop it.\n");

  throw await Promise.race([proxyFailure, cloudflaredFailure]);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await stopAll();
  process.exitCode = 1;
}
