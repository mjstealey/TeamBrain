# decision: **Phase 5 § A — long-lived non-interactive API token mechanism — shipped 2026-05

> Promoted from TeamBrain thought `d4818bc5-0906-4f0e-bed2-6bd883ce8028` on 2026-06-16T10:57:56.293Z.

## Content

**Phase 5 § A — long-lived non-interactive API token mechanism — shipped 2026-05-29.**

Deployed and end-to-end smoke-verified on `pr.fabric-testbed.net`. Closes the Phase 4 § J deferral.

**Architecture (refresh/access split):**
- Opaque `tbk_<base64url(32)>` token = durable, revocable credential. Stored ONLY as SHA-256 in `public.api_tokens` (RLS-locked, `service_role`-only). Default 180-day expiry.
- `POST /teambrain-token/token/exchange` swaps it for a 15-min HS256 JWT signed with `JWT_SECRET`. Caller sends `X-TeamBrain-Token: tbk_…` plus the public anon key as `Authorization: Bearer` (gateway pass-through; the function ignores it). No user JWT involved.
- Minted JWT drives MCP/REST through existing RLS. `sub` = per-project bot's `auth.users.id`; bot is a `contributor` member with `is_service_account: true` (membership-sync exempts it).

**Capability fence (RLS, not just app code) — migration 0012:**
- New helpers in `app` schema: `jwt_claims()`, `is_token_call()`, `token_allowed_scopes()` (SECURITY INVOKER, GUC-only, fail-closed).
- Amended `public.thoughts` policies: SELECT/INSERT add `(not is_token_call() or scope = any(allowed_scopes::text[]))`; UPDATE/DELETE denied entirely for token calls.
- Human JWTs carry no claim → guards reduce to 0002 verbatim. Fully backward-compatible.

**Fence invariant:** the per-project bot is created with no password, no identity, non-routable `@teambrain.local` email → no claim-less JWT path. The ONLY way to get a bot JWT is the exchange, which always stamps `teambrain_token: true`.

**Default capability** (the Phase 5 GitHub Action's job): capture + read on `project`/`personal`. No `project_private`, no `mark_stale`/`promote_to_docs`. Customizable per token.

**Surface:**
- `POST /teambrain-token/token` — admin-gated issuance (lazy bot provisioning, returns plaintext once).
- `GET /teambrain-token/token?project=…` — admin-gated metadata list.
- `POST /teambrain-token/token/{id}/revoke` — admin-gated soft revoke (effective within 15-min TTL).
- `POST /teambrain-token/token/exchange` — opaque → minted JWT.

OpenAPI 3.1 spec at `/openapi.yaml`; curl recipes in `examples/curl.md` § 8; runnable GitHub Action with Environment-based human-approval gate at `examples/github-actions/capture-on-merge.yml`.

**Smoke verified end-to-end:** issue → exchange → capture `project` → `project_private` denied (403) → `mark_stale` denied (403) → revoke → re-exchange (401 token revoked).

**Unblocks:** Phase 5 § C (runnable GitHub Action). § B (Slack) and § D (slash commands) had no dependency.

**Open follow-ups (not blocking pilot):** exchange audit/rate limiting; ES256 migration path if the stack moves off HS256 + `JWT_SECRET`; `teambrain-auth` dev refresh daemon.

## Provenance

- scope: `project`
- captured: 2026-05-30T00:17:16.211579+00:00
- last verified: 2026-06-15T12:31:51.962+00:00
- linked commit: `88bb3ce`
- paths: `migrations/0012_api_tokens.sql`, `edge-functions/teambrain-token/`, `edge-functions/teambrain-mcp/index.ts`, `edge-functions/teambrain-rest/index.ts`, `edge-functions/teambrain-membership-sync/sync.ts`, `examples/github-actions/capture-on-merge.yml`, `examples/curl.md`, `deploy/production/nginx/html/openapi.yaml`, `docs/development/phase-5-checklist.md`
- tags: `phase-5`, `api-token`, `milestone`, `shipped`, `teambrain-token`
