const PERIODIC_ALARM = "x-signal-periodic-sync";
const CHANGE_ALARM = "x-signal-cookie-change-sync";
const ENDPOINT = "http://127.0.0.1:7345/setup/session-sync";

async function collectCookies() {
  const groups = await Promise.all([
    chrome.cookies.getAll({ domain: "x.com" }),
    chrome.cookies.getAll({ domain: "twitter.com" }),
  ]);
  const unique = new Map();
  for (const cookie of groups.flat()) {
    if (!/(^|\.)((x)|(twitter))\.com$/i.test(cookie.domain)) continue;
    unique.set(`${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`, {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      expirationDate: cookie.expirationDate,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    });
  }
  return [...unique.values()];
}

async function sourceIdentity() {
  const stored = await chrome.storage.local.get(["sessionSourceId", "sessionSourceLabel"]);
  const id = stored.sessionSourceId || crypto.randomUUID();
  const label = stored.sessionSourceLabel || `Chrome profile ${id.slice(0, 6)}`;
  if (!stored.sessionSourceId || !stored.sessionSourceLabel) await chrome.storage.local.set({ sessionSourceId: id, sessionSourceLabel: label });
  return { id, label };
}

async function automaticSyncEnabled() {
  const stored = await chrome.storage.local.get("automaticSyncEnabled");
  return stored.automaticSyncEnabled !== false;
}

async function sync(reason, activate = false) {
  const attemptedAt = new Date().toISOString();
  try {
    const cookies = await collectCookies();
    const source = await sourceIdentity();
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-X-Signal-Companion": "1" },
      body: JSON.stringify({ version: 1, reason, cookies, source, activate }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.remediation || result.error || `HTTP ${response.status}`);
    const state = { ok: true, attemptedAt, ...result };
    await chrome.storage.local.set({ sessionSyncState: state });
    chrome.action.setBadgeText({ text: result.authenticated ? "" : "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
    return state;
  } catch (error) {
    const state = { ok: false, attemptedAt, error: error instanceof Error ? error.message : "Session sync failed" };
    await chrome.storage.local.set({ sessionSyncState: state });
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
    return state;
  }
}

async function initialize() {
  await chrome.alarms.create(PERIODIC_ALARM, { delayInMinutes: 1, periodInMinutes: 5 });
  if (await automaticSyncEnabled()) await sync("startup");
}

chrome.runtime.onInstalled.addListener(() => void initialize());
chrome.runtime.onStartup.addListener(() => void initialize());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_ALARM) void automaticSyncEnabled().then((enabled) => enabled ? sync("periodic") : undefined);
  if (alarm.name === CHANGE_ALARM) void automaticSyncEnabled().then((enabled) => enabled ? sync("cookie-change") : undefined);
});
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (/(^|\.)((x)|(twitter))\.com$/i.test(cookie.domain)) {
    void automaticSyncEnabled().then((enabled) => enabled ? chrome.alarms.create(CHANGE_ALARM, { delayInMinutes: 0.5 }) : undefined);
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!new Set(["sync-now", "activate-profile", "rename-profile", "set-auto-sync"]).has(message?.type)) return false;
  if (message.type === "rename-profile") {
    void chrome.storage.local.set({ sessionSourceLabel: String(message.label || "").trim().slice(0, 80) }).then(() => sourceIdentity()).then(sendResponse);
    return true;
  }
  if (message.type === "set-auto-sync") {
    const enabled = message.enabled !== false;
    void chrome.storage.local.set({ automaticSyncEnabled: enabled }).then(async () => {
      if (enabled) return sync("manual");
      const state = await chrome.storage.local.get("sessionSyncState");
      return { ...(state.sessionSyncState ?? {}), automaticSyncEnabled: false };
    }).then(sendResponse);
    return true;
  }
  void sync("manual", message.type === "activate-profile").then(sendResponse);
  return true;
});

void initialize();
