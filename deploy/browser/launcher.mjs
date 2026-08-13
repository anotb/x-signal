import { chromium } from "playwright-core";
import net from "node:net";

const profileDir = "/data/profile";
let context;
let cdpForwarder;
let closing = false;
const sockets = new Set();

function log(level, event, fields = {}) {
  process.stdout.write(JSON.stringify({ level, event, ...fields }) + "\n");
}

function closeForwarder() {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (!cdpForwarder?.listening) return Promise.resolve();
  return new Promise((resolve) => cdpForwarder.close(resolve));
}

async function close(signal, exitCode = 0) {
  if (closing) return;
  closing = true;
  log("info", "browser_closing", { signal, exitCode });
  const timer = setTimeout(() => process.exit(1), 20_000);
  timer.unref();
  try {
    // Closing Chromium first flushes the persistent profile and naturally closes
    // CDP clients. Destroy any remaining proxy sockets before awaiting the listener.
    await context?.close();
    await closeForwarder();
  } finally {
    clearTimeout(timer);
    process.exit(exitCode);
  }
}

process.on("SIGTERM", () => void close("SIGTERM"));
process.on("SIGINT", () => void close("SIGINT"));

context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: null,
  acceptDownloads: false,
  args: [
    "--remote-debugging-address=0.0.0.0",
    "--remote-debugging-port=9222",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--metrics-recording-only"
  ]
});
context.on("close", () => {
  if (!closing) void close("chromium-exited", 1);
});

if (context.pages().length === 0) await context.newPage();
cdpForwarder = net.createServer((downstream) => {
  const upstream = net.connect(9222, "127.0.0.1");
  sockets.add(downstream);
  sockets.add(upstream);
  downstream.pipe(upstream);
  upstream.pipe(downstream);
  const close = () => {
    downstream.destroy();
    upstream.destroy();
  };
  const forgetDownstream = () => sockets.delete(downstream);
  const forgetUpstream = () => sockets.delete(upstream);
  downstream.on("error", close);
  upstream.on("error", close);
  downstream.on("close", forgetDownstream);
  upstream.on("close", forgetUpstream);
});
await new Promise((resolve, reject) => {
  cdpForwarder.once("error", reject);
  cdpForwarder.listen(9223, "0.0.0.0", resolve);
});
log("info", "browser_ready", { cdpPort: 9223, profile: "persistent" });

await new Promise(() => {});
