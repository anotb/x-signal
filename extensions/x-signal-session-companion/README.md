# X Signal Session Companion

This optional Manifest V3 extension keeps the persistent Docker Chromium session aligned with one intentionally selected Chrome profile. It never reads browsing history and sends only X/Twitter cookie records to the loopback X Signal service.

## Recommended alternate-account setup

Use a dedicated Chrome profile when X Signal should research through an alternate X account while your everyday Chrome profile stays on your main account:

1. Start X Signal with `docker compose up -d --build`.
2. Create a new Chrome profile and sign that profile into the intended X account.
3. In that profile, open Chrome's Extensions page, enable **Developer mode**, and choose **Load unpacked**.
4. Select this `extensions/x-signal-session-companion` directory.
5. Open the X Signal extension. Give the profile a recognizable label, leave **Keep this profile synced automatically** checked, and click **Use this profile** once.
6. Confirm the popup says **Connected as @…**. Your everyday Chrome profile may remain signed into a different X account.

That is the complete recurring setup. While the dedicated Chrome profile is running, the companion refreshes at startup, every five minutes, and after relevant X/Twitter cookie changes. Docker retains its own persistent signed-in profile between refreshes and across app, browser, Compose, and host restarts. The popup shows the last refresh, and `x_status` reports every known source's last heartbeat plus the active source's successful refresh/application timestamps.

Each Chrome profile receives a different stable source ID. Only the selected source can update Docker, so installed companions in other profiles cannot race or silently change the research account. To switch to another prepared profile, open it and click **Use this profile** once. If research is active, X Signal remembers the selection and that profile's automatic sync completes the switch after the run settles. To change the X account inside the already selected dedicated profile, sign into the replacement account there. Cookie-change sync detects it automatically; if research is active, the update waits and retries automatically after that run settles. No cookie paste or recurring button click is required.

## Temporary same-profile transfer

For a short one-time copy from an existing Chrome profile, click **Use this profile**, then turn off **Keep this profile synced automatically** before changing that Chrome profile back. This prevents a later cookie change from overwriting Docker. It is not a durable alternate-account strategy: X can invalidate the copied login when the same Chrome profile logs out or changes accounts. Use the dedicated-profile setup above for lasting freshness.

## Minimal installation

1. Start X Signal with `docker compose up -d --build`.
2. In Chrome's Extensions page, enable Developer mode and choose **Load unpacked**.
3. Select this directory.

After that one-time installation, sync is automatic at Chrome startup, every five minutes, and after relevant X/Twitter cookie changes. The endpoint is `http://127.0.0.1:7345/setup/session-sync`; cookie values are never returned through MCP tools or logs.

An unpacked extension does not update itself. After pulling a newer X Signal release, return to Chrome's Extensions page and reload the companion.
