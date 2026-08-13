const status = document.querySelector("#status");
const detail = document.querySelector("#detail");
const button = document.querySelector("#sync");
const activate = document.querySelector("#activate");
const profileLabel = document.querySelector("#profile-label");
const autoSync = document.querySelector("#auto-sync");

function render(state) {
  if (!state) {
    status.textContent = "Waiting for the first automatic sync.";
    detail.textContent = "Chrome checks every five minutes and whenever X changes a session cookie.";
    return;
  }
  status.textContent = state.ok && state.status === "inactive"
    ? `Inactive; X Signal currently follows ${state.activeSource?.label || "another Chrome profile"}`
    : state.ok && state.status === "deferred"
    ? "Session update queued behind active research"
    : state.ok && state.authenticated
    ? `Connected as @${state.handle}`
    : state.ok ? "X session needs attention" : "Local app unavailable";
  detail.textContent = state.ok
    ? `Last checked ${new Date(state.attemptedAt).toLocaleString()}. ${state.status === "inactive" ? "Click Use this profile to switch intentionally." : state.status === "deferred" ? "No action is needed; automatic sync will retry after the current run finishes." : "Automatic sync is active."}`
    : `${state.error}. Automatic retry is active.`;
}

chrome.storage.local.get(["sessionSyncState", "sessionSourceLabel", "automaticSyncEnabled"]).then(({ sessionSyncState, sessionSourceLabel, automaticSyncEnabled }) => {
  profileLabel.value = sessionSourceLabel || "";
  autoSync.checked = automaticSyncEnabled !== false;
  render(sessionSyncState);
});
profileLabel.addEventListener("change", async () => {
  const source = await chrome.runtime.sendMessage({ type: "rename-profile", label: profileLabel.value });
  profileLabel.value = source.label;
});
autoSync.addEventListener("change", async () => {
  autoSync.disabled = true;
  const state = await chrome.runtime.sendMessage({ type: "set-auto-sync", enabled: autoSync.checked });
  render(state);
  autoSync.disabled = false;
});
button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Syncing…";
  render(await chrome.runtime.sendMessage({ type: "sync-now" }));
  button.disabled = false;
});
activate.addEventListener("click", async () => {
  activate.disabled = true;
  status.textContent = "Switching X Signal to this Chrome profile…";
  render(await chrome.runtime.sendMessage({ type: "activate-profile" }));
  activate.disabled = false;
});
