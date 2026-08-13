---
name: x-setup
description: Diagnose and operate X Signal Docker, browser, sign-in, MCP, operation, and tunnel setup. Use when installation, health, authentication, browser visibility, or client connection is failing.
---

# X Signal setup

1. Call `x_status` with `liveProbe: true`, then distinguish app, database, browser/CDP, X authentication/challenge, captured operation, and tunnel failures.
2. Check `docker compose ps`, `/healthz`, `/readyz`, and redacted service logs. Use `http://127.0.0.1:6080/vnc.html` only for visible sign-in or challenge recovery.
3. The persistent browser profile survives Compose and host restarts. For an alternate account, recommend a dedicated Chrome profile with the companion installed, automatic sync left on, and **Use this profile** selected once; the everyday Chrome profile can remain on another account. Never ask the user to paste cookies or tokens into chat. Check all named sources' `lastSeenAt` plus the active source's `lastSyncedAt`/`lastAppliedAt` and any `pendingSessionSource`. A different prepared profile is selected intentionally and automatic sync completes the switch after current runs settle. An account change inside the selected profile is detected from cookie changes and automatically deferred/retried behind active research. A same-profile one-time transfer can pause automatic sync, but X may invalidate it when that profile changes accounts.
4. For local MCP clients use `http://127.0.0.1:7345/mcp`. For ChatGPT, use the Compose `chatgpt` profile and the hidden `npm run tunnel:secure:configure` prompt. Check the local tunnel `/readyz` and verify workspace association plus **Tunnels Read + Use** if it is not listed. Never capture or repeat a tunnel ID or runtime key. Use the path-gated temporary command only for an explicitly short-lived fallback, then refresh the app after schema changes.
5. Give exact recovery commands and recheck status. Do not bypass X challenges or weaken loopback/tunnel authentication.
