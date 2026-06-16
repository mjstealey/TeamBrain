# decision: **Phase 5 § B — Slack `/tb` slash command — BUILT 2026-06-11 (PR #30, branch `fe

> Promoted from TeamBrain thought `d38906b2-c2bf-4d14-a7a3-806538732c04` on 2026-06-16T10:55:29.544Z.

## Content

**Phase 5 § B — Slack `/tb` slash command — BUILT 2026-06-11 (PR #30, branch `feat/slack-bot`). Live smoke pending two Michael-driven steps (B5/B6).**

The last un-started Phase 5 item. A `/tb` slash command (`remember`/`recall`/`recent`/`status`/`link`/`help`) scoped per Slack channel to a project via `migrations/0023_slack_channels.sql` (service_role-only mapping table, explicit deny-all per the 0016 convention) + `edge-functions/teambrain-slack/` (the 8th function).

**Key decisions (full B-D1…D10 in `docs/phase-5-checklist.md` § B):**
- **Slash command, NOT OB1's every-message inbox** — explicit capture only (the § C over-capture lesson); channel→project scoping kept, which was the actual § B requirement. Reaction-capture (:brain: on existing messages) is follow-up B-F1 (needs Events API + bot token).
- **No service_role in the data path:** commands run as the § A per-project bot under a 5-min minted JWT (same claim shape as /token/exchange → 0012 capability fence applies), narrowed to `project` scope ONLY (a shared channel must never touch personal/project_private), calling `teambrain-rest` in-stack. No opaque token stored — the slack_channels row is the durable authorization; unlink revokes within the TTL.
- **One Slack credential:** slash-command-only app (manifest at `examples/slack/manifest.yml`, single `commands` scope, no bot token, no Events API); authn = Slack v0 HMAC signature over `SLACK_SIGNING_SECRET`; replies via `response_url` (ACK <3s, work under `EdgeRuntime.waitUntil`).
- **Gateway trick:** Slack can't send an Authorization header and the dispatcher's VERIFY_JWT is global → nginx `^~` location injects the PUBLIC anon key on `/functions/v1/teambrain-slack/slack/` only (envsubst, same mechanism as the landing-page sub_filter). Admin `/links*` CRUD stays project-admin-gated on a real GitHub-OAuth JWT.
- **Trust model accepted + documented:** linking a channel makes Slack channel membership the capture/read ACL for that project's `project`-scope memories. Linking is REST-only (`/tb link` returns a pre-filled curl) — a Slack user doesn't map to a GitHub identity.

**Validation:** deno-check green on all 8 functions; openapi-spec-validator OK (new `slack` tag + /links* paths); signature/parse helpers unit-smoked (valid/tampered/stale/missing all correct). Runbook § 11c includes a synthetic signed smoke that needs no Slack app. Drive-by fix: README § 8 rsync loops were missing `teambrain-staleness` (deployed since Phase 6 § C) — added along with `teambrain-slack`.

**Remaining to call § B shipped:** B5 — Michael creates the Slack app from the manifest in the FABRIC workspace, sets `SLACK_SIGNING_SECRET` on the VM, applies 0023, cp's the override, recreates functions+nginx, rsyncs the function; B6 — link a channel to the dogfood project and run the in-Slack smoke. After B5/B6: **Phase 5 complete**, and the "connect & capture from every surface" docs trigger fires (documentation-plan § 3, gated on § B + § D both shipped).

## Provenance

- scope: `project`
- captured: 2026-06-11T11:24:54.610718+00:00
- last verified: 2026-06-15T16:08:27.378+00:00
- linked commit: `3f1e60d`
- linked PR: https://github.com/fabric-testbed/TeamBrain/pull/30
- paths: `migrations/0023_slack_channels.sql`, `edge-functions/teambrain-slack/index.ts`, `edge-functions/teambrain-slack/slack.ts`, `deploy/production/nginx/templates/pr.fabric-testbed.net.conf.template`, `examples/slack/README.md`, `docs/phase-5-checklist.md`
- tags: `phase-5`, `milestone`, `slack`, `tb-slash-command`, `teambrain-slack`, `pr-30`, `pending-smoke`
