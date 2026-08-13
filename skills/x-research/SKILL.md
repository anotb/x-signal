---
name: x-research
description: Research and synthesize substantial live X evidence across one or multiple topics, labeled query angles, Top and Latest, relevant timelines, and post context. Use for open-ended research, comparisons, trend discovery, emerging accounts, current events, or technical discussion on X.
---

# X research

1. Call `x_status` only when service, sign-in, or rate health is uncertain.
2. Use `x_search_accounts` when the task needs people, organizations, experts, emerging accounts, or an exact handle. Continue with its returned cursor only when the next account page is useful.
3. Plan enough distinct post-query angles to answer the actual question. For a broad single topic, usually combine Top and Latest with a few scoped or Media variants in one `x_search`. For multiple topics, label each topic and lens in one consolidated call when practical. Choose useful per-leg limits and `responseLimit` from the requested breadth; do not request 200 by habit or impose an arbitrary global result ceiling.
4. Let long research run when it is still gathering useful evidence. If a result is `running` with `retryAt`, retain its `runId`, continue any independent reasoning, and call `x_get_run` after `retryAt`. Do not launch replacement searches or rapid status probes during the backoff window.
5. Inspect `totalPosts`, the evidence-page cursor, per-leg requested/returned counts, continuation availability, query coverage, lenses, authors, clusters, warnings, and failed legs. Use `x_get_evidence` to read more already-stored records without touching X. Use `x_continue_search` on only consequential thin legs when genuinely new upstream evidence is needed; repeat it if justified. Add a different angle only for a real evidence gap, not as a substitute for either continuation path.
6. Use `x_get_timeline` for an exact Following, For You, user, bookmarks, list, or community source. Preserve its cursor when another page is useful. Expand consequential posts with `x_get_post` when thread, reply, or quote-post context could confirm, qualify, or challenge the claim.
7. Synthesize patterns and disagreements across the full evidence set. Distinguish what posts claim, what engagement shows, and what you infer. Canonical X URLs are available when references would improve traceability or the user asks for them. Choose a proportionate set, placement, and style for the specific answer; references may be omitted when they add little value. Do not dump bare URLs or force a fixed citation section unless the user asks.
8. Create or change an `x_monitor` only when requested.

Favor independent coverage and author diversity over volume for its own sake. High engagement is not factual reliability.
