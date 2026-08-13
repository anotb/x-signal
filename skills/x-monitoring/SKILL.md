---
name: x-monitoring
description: Create, run, inspect, pause, resume, and compare durable X Signal monitors. Use when X queries, accounts, or Following should be checked repeatedly or compared over time.
---

# X monitoring

1. Call `x_monitor` with `list` and reuse a monitor when its sources and cadence match.
2. Create explicit labeled queries, accounts, optional Following, cadence, filters, and optional webhook or ntfy sink. Report it active only after successful creation.
3. When current output is requested, call `run` immediately; scheduled activation alone is not a current result.
4. Run `results` to compare with the previous successful baseline. Report new and removed posts, meaningful metric and author changes, cluster shifts, partial legs, and delivery state when present.
5. Preserve direct X links from the stored run. Use `pause`, `resume`, `update`, or `delete` only when the user asks for that state change.
