import playwright from "/opt/x-signal-browser/node_modules/playwright-core/index.js";

const { chromium } = playwright;

const mode = process.argv[2];
if (mode !== "write" && mode !== "read") throw new Error("Usage: browser-persistence.mjs <write|read>");

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
if (!context) throw new Error("Persistent context not exposed over CDP");
const page = await context.newPage();
try {
  await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (mode === "write") {
    await context.addCookies([{ name: "xsignal_persistence_probe", value: "present", domain: "example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 86_400, httpOnly: true, sameSite: "Lax", secure: true }]);
    await page.evaluate(() => localStorage.setItem("xsignal_persistence_probe", "present"));
    await page.waitForTimeout(1_000);
  }
  const cookies = await context.cookies("https://example.com");
  const cookiePresent = cookies.some((cookie) => cookie.name === "xsignal_persistence_probe" && cookie.value === "present");
  const storagePresent = await page.evaluate(() => localStorage.getItem("xsignal_persistence_probe") === "present");
  process.stdout.write(`${JSON.stringify({ mode, cdpConnected: true, cookiePresent, storagePresent })}\n`);
  process.exitCode = cookiePresent && storagePresent ? 0 : 1;
} finally {
  await page.close();
  process.exit(process.exitCode ?? 0);
}
