# Contributing

Bug reports and focused pull requests are welcome.

## Before opening a pull request

```bash
npm ci
npm run validate
npm audit --audit-level=moderate
docker compose config --quiet
```

If the change touches live X behavior, describe the smallest live check you ran without including account names, post IDs, captured text, screenshots, or tunnel details.

## Project rules

- Keep the normal research surface read-only.
- Preserve conservative browser dispatch and visible authentication/challenge states.
- Use synthetic fixtures under `tests/fixtures`.
- Do not commit non-example `.env*` files, `.app.json`, browser profiles, cookies, SQLite files, exports, backups, logs, screenshots, or captured research.
- Record borrowed code or material adaptations in `docs/UPSTREAMS.md` with an exact source and license.

For security issues, follow [SECURITY.md](SECURITY.md) rather than opening a public issue with sensitive details.
