# Working with X Signal

## Installing for a user

- Detect the operating system and confirm Docker Compose is available before changing anything.
- Keep the default services and ports bound to loopback.
- Start with `docker compose up -d --build --wait`, then check `/healthz`, `/readyz`, and `docker compose ps`.
- Connect local Codex clients to `http://127.0.0.1:7345/mcp`.
- Never ask a user to paste cookies, session tokens, VNC passwords, tunnel URLs, or other credentials into chat.
- Prefer a dedicated Chrome profile with the session companion. A profile selected during active research is queued and should complete through automatic sync; do not ask for a second activation click. Use noVNC for visible sign-in or challenge recovery.
- Do not bypass X authentication, challenges, access controls, or rate limits.
- For ChatGPT web, use the opt-in `chatgpt` Secure MCP Tunnel profile. Help the user create a workspace-associated tunnel and a runtime key restricted to **Tunnels Read + Use**, then ask them to enter both directly into `npm run tunnel:secure:configure`; its key prompt is hidden. Never capture, print, repeat, or commit either value. Use `npm run tunnel:chatgpt` only as an explicitly short-lived fallback, and never expose port 7345 directly.
- Explain every visible step the user must perform and verify the final X identity without repeating its handle in public logs.

## Changing the project

- Keep the architecture tool-only unless a real user workflow requires UI.
- Preserve one persistent browser, concurrency two, request spacing, durable jobs, account-bound provenance, and adaptive backoff.
- Do not add posting, generic browser automation, CAPTCHA handling, proxy rotation, or enforcement-evasion features.
- Use synthetic parser fixtures. Never commit captured posts, account handles, browser data, exports, registrations, tunnel identifiers, credentials, temporary URLs, or local paths. The only image exception is an explicitly allowlisted public showcase capture under `docs/assets` that has been manually checked against `SECURITY.md`.
- Run `npm run validate`, `npm audit --audit-level=moderate`, `docker compose config --quiet`, and the plugin/skill validators before release.
- Treat live tests as real account traffic. Use the smallest canary that proves the change and do not leave test monitors running.
