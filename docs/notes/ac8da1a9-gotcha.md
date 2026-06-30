# gotcha: **Capture-on-merge wasted ~2,520 GitHub Actions minutes on idle approval waits (

> Promoted from TeamBrain thought `ac8da1a9-203a-40c0-a981-5d43e7c0191b` on 2026-06-30T15:34:28.858Z.

## Content

**Capture-on-merge wasted ~2,520 GitHub Actions minutes on idle approval waits (2026-06-15 → 06-17). Bound the `capture` job with `timeout-minutes`.**

Measured on `fabric-testbed/TeamBrain` (`gh run list --workflow capture-on-merge.yml --created 2026-06-15..2026-06-18`): 31 runs in the window — **22 success** (cheap: 0–6 min; one 42-min run waited then captured), **7 `cancelled` at the 6-hour job timeout**, and **2 `failure` at 0 min** on 06-17. The 7 timeouts ≈ **2,520 min** of held runner time and produced **zero captures** (~97% of the window's spend); six were on 06-15 (~2,160 min — matches the ~2,300-min "90% of 3,000" billing alert), one on 06-16.

**Root cause:** the `capture` job blocks on `trstringer/manual-approval`, which holds a runner while polling the approval issue. The approver defaults to the PR merger (`TEAMBRAIN_APPROVERS` || `github.actor`); when no `approved`/`denied` comment arrived, each job idled to the **default `timeout-minutes: 360`** (GitHub-hosted default = 6 h) before being killed. Cost is decoupled from value — you pay the idle wait whether it ends in approve, deny, or timeout, and a timeout yields nothing. (`GET /actions/runs/{id}/timing` reports `billable: 0` for these cancelled runs — unreliable for timed-out runs; wall-clock is the real figure and matches the billing dashboard.)

**The two 06-17 `failure`-at-0-min runs** (jobs failed with `steps: 0`, fired by the #91/#92 merges) are the signature of the **Actions spending limit now blocking new runs** — capture-on-merge is currently hard-stopped by the budget, not actively burning minutes.

**Fixes, by reach:**
1. **`timeout-minutes` on the `capture` job** (e.g. 30) — a stuck run costs ~30 not 360; would have cut 2,520 → ~210. Highest-value, **not yet applied**. Lives in 3 synced copies: `examples/github-actions/capture-on-merge.yml`, `.github/workflows/capture-on-merge.yml`, and the base64 in `edge-functions/teambrain-console/agents-md.ts` (drift-checked by `scripts/check-embedded-assets.sh`).
2. **Central toggle / `TEAMBRAIN_CAPTURE=off`** — disable per-repo without editing the workflow (PR #91, merged 06-17; server-flag half needs migration `0026` deployed, the repo-variable half works immediately).
3. **Re-home server-side** — GitHub webhook → `teambrain-summarize` edge function does summarize+capture off the Actions budget entirely (no idle runner). The sustainable shape at volume.
4. **Reconsider per-PR granularity + the human gate** — auto-captures land `tentative`, bot-authored, rarely verified/promoted; batch/digest, or drop-the-gate-and-curate (lean on freshness ranking + dedup + `mark_stale`), are the alternatives.

Couldn't measure `loomai-dev`/`fabric-core-api` (no `gh` access / different workflow filename) — any timeouts there stack on the shared `fabric-testbed` pool. Complements the §C milestone `8153d210` (which chose the human-approval gate); this is the cost evidence that the blocking-idle pattern doesn't scale.

## Provenance

- scope: `project`
- captured: 2026-06-17T19:30:42.737336+00:00
- last verified: 2026-06-22T16:00:08.771+00:00
- paths: `examples/github-actions/capture-on-merge.yml`, `.github/workflows/capture-on-merge.yml`, `edge-functions/teambrain-console/agents-md.ts`
- tags: `capture-on-merge`, `github-actions`, `actions-minutes`, `manual-approval`, `timeout-minutes`, `cost`, `incident`, `pr-merge`, `operations`, `phase-5`
