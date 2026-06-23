# context: **Phase 5 § B (Slack `/tb`) — progress checkpoint 2026-06-11 (afternoon). Resume

> Promoted from TeamBrain thought `352dc705-dc54-483e-86f8-7096f1748018` on 2026-06-15T18:44:37.348Z.

## Content

**Phase 5 § B (Slack `/tb`) — progress checkpoint 2026-06-11 (afternoon). Resume here when the FABRIC Slack-app approval lands.** Updates the "Remaining" section of milestone `d38906b2` (design + decisions live there and in `docs/development/phase-5-checklist.md` § B; still accurate).

**DONE since the milestone:**
- PR #30 merged to `main` (`164cb6e`); feature branch deleted from both remotes; local + personal fork in sync.
- **B5 server-side complete AND verified on production** (runbook § 11c, all green): migration `0023` applied (proven by the DB-path smoke below, not just assumed); `SLACK_SIGNING_SECRET` in `.env` and confirmed inside the functions container (32 chars); override cp'd; `teambrain-slack` rsynced; functions + nginx force-recreated; nginx `^~` anon-key injection rendered (2 hits in the rendered conf).
- Verified chain: `GET /health` → `slack_command_enabled: true`; unsigned POST → 401 **from the function's signature gate** (body says `Slack signature verification failed` — confirms the request passed the dispatcher, i.e. the nginx injection works); synthetic v0-HMAC-signed `/tb help` → 200 help text; signed `/tb status` → correct "not linked" reply (exercises `slack_channels` via the service client → `0023` live).
- Slack app created from `examples/slack/manifest.yml` in the FABRIC workspace; signing secret captured.

**GOTCHA (smoke-harness only, never affects real Slack traffic):** the secret in the VM `.env` is single-quoted. docker compose strips the quotes; shell `grep|cut` does NOT — so the § 11c synthetic smoke signed with a 34-char quoted string and got 401 until the extraction added `tr -d "'\""`. Real Slack signs with its own copy, byte-exact. TODO: harden the § 11c extraction in `deploy/production/README.md` (or drop the quotes in `.env`).

**BLOCKED ON:** FABRIC workspace admins approving the Slack app install. Nothing else.

**REMAINING when approval lands — B6, in Slack:**
1. `/tb help` in any channel (first real Slack-signed request).
2. In the dogfood channel: `/tb link fabric-testbed/TeamBrain` → run the pre-filled curl it returns with a user JWT (project admin) → `/tb status` shows linked.
3. `/tb remember <real gotcha>` → in-channel confirmation; verify tags carry `slack` + `slack-user:` + `slack-channel:` and author = project bot; retrievable via `/tb recall` AND MCP `search_project_thoughts`.
4. Negative checks: unlinked channel refuses with guidance; after `DELETE /teambrain-slack/links/:id` the channel refuses again.

**THEN close out § B:** mark shipped in `docs/development/phase-5-checklist.md` § B (B5/B6 Done-whens) + `CLAUDE.md` Repository State; harden the § 11c extraction; mark_stale `d38906b2`'s pending framing; **Phase 5 complete** → the "connect & capture from every surface" docs trigger fires (`docs/documentation-plan.md` § 3, gated on § B + § D both shipped).

## Provenance

- scope: `project`
- captured: 2026-06-11T16:52:47.401676+00:00
- last verified: 2026-06-15T16:08:25.04+00:00
- linked PR: https://github.com/fabric-testbed/TeamBrain/pull/30
- paths: `docs/development/phase-5-checklist.md`, `deploy/production/README.md`, `examples/slack/README.md`, `edge-functions/teambrain-slack/index.ts`
- tags: `slash-capture`, `phase-5`, `slack`, `status`, `handoff`, `b5-verified`, `b6-pending`, `app-approval`
