# Phase 5 Checklist

Concrete, ordered tasks for Phase 5 — **capture integrations**: a long-lived non-interactive **API token** (the gating prerequisite, § A), a **Slack bot** (channel → `project_id`, § B), a **GitHub Action** that summarizes a merged PR behind a human-approval gate (§ C), and **slash commands** for Claude Code / Cursor (§ D). Each item has an explicit **Done when** acceptance criterion.

Section A is detailed because it is the gate: the runnable GitHub Action (§ C) cannot land until A is green. Sections B and D have **no dependency on A** and can proceed in parallel; they are stubbed here and will be fleshed out when started.

Phase 5 entry preconditions (from `docs/phase-4-checklist.md` § I and the current state of `main`):

- ✅ Phases 0–4 complete on `main`; deployed and live on `pr.fabric-testbed.net`.
- ✅ MCP surface live — 6 tools round-trip (`ping`, `capture_project_thought`, `search_project_thoughts`, `list_recent_project_thoughts`, `mark_stale`, `promote_to_docs`).
- ✅ REST surface live and at parity with MCP; `openapi.yaml` published and lint-clean.
- ✅ Self-service project registration (`teambrain-register-project`) shipped; multiple projects registered.
- ✅ A non-interactive credential for server-to-server callers — § A shipped 2026-05-29 (commits `0b86f85` + `88bb3ce`); end-to-end smoke green on `pr.fabric-testbed.net`.

---

## Architectural shape (the one-pager)

The token mechanism is a **refresh/access split**:

- The **opaque token** (`tbk_<32 random bytes, base64url>`) is the durable, revocable credential. It is stored **only as a SHA-256 hash** (`app.api_tokens.token_hash`); the plaintext is shown exactly once, at issuance. It is never a JWT and is never presented to the MCP/REST surface directly.
- The caller exchanges the opaque token for a **short-lived (15 min) minted JWT** — HS256-signed with `JWT_SECRET`, shaped like a GoTrue access token (`sub` = the project's bot user, `role: authenticated`, `aud: authenticated`). That JWT drives the existing MCP/REST surface through the **existing RLS** — no new happy-path policy logic.

**Why an exchange rather than presenting the token directly** (both verified against the deployed code):

- `teambrain-mcp/index.ts:65` decodes the `Authorization` bearer as a 3-segment JWT, and PostgREST verifies the signature against `JWT_SECRET`. An opaque string satisfies neither — so it must be exchanged for a real JWT first.
- The Edge Runtime dispatcher's JWT check is **global, not per-function** (`volumes/functions/main/index.ts:7`, a single `VERIFY_JWT` flag). The exchange endpoint therefore satisfies the gateway with the **public `ANON_KEY`** as its `Authorization` bearer (a valid HS256 JWT, not a secret) and carries the real opaque token in an `X-TeamBrain-Token` header. This works whether `VERIFY_JWT` is on or off and needs **no dispatcher modification**.
- `JWT_SECRET` is already injected into every function worker (the dispatcher reads it at `main/index.ts:5` and forwards the whole container env at `:148`), so minting needs no new env wiring — only a confirmation it is present.

Revocation takes effect within the 15-minute access-token TTL: every exchange re-checks `revoked_at`/`expires_at`, so a revoked opaque token stops minting JWTs on its next refresh.

The issuance/exchange function is **`teambrain-token`** — distinct from the `teambrain-auth` name § J reserved for the (still-deferred) developer-side JWT-refresh daemon.

---

## A — API token mechanism (the Phase 5 gating item) — *complete (2026-05-29)*

### Decisions locked before coding

- **A‑D1. Token model** — *resolved: opaque refresh token (hashed at rest) → short-lived minted JWT.* Standard refresh/access split; minted JWT is HS256 over `JWT_SECRET` so both the gateway and PostgREST accept it.
- **A‑D2. Principal identity** — *resolved: per-project service account.* Each project gets one bot (`auth.users` row, `user_metadata.teambrain_bot = true`) plus a `project_members` row (`role: contributor`, `is_service_account: true`). Provisioned lazily on first token issuance. Per-project keeps provenance clean (`thoughts.author_user_id` identifies the source project's bot) and bounds a leak to one project.
- **A‑D3. RLS enforcement** — *resolved: mint a JWT and reuse RLS verbatim* (no service_role + manual filter). `contributor` is the floor — `0002`'s `thoughts_insert_self` (line 178) requires `is_project_writer` to capture `project` scope.
- **A‑D4. Capabilities** — *resolved: capture + read, no `project_private`; enforced in RLS via JWT claim* (call **a**). A friendly app-layer guard in MCP/REST is a UX nicety, **not** the boundary: the minted JWT is a valid contributor token that could otherwise hit PostgREST directly, so the limit must live in RLS. Concretely: `mark_stale`/`promote_to_docs` (updates) and deletes are denied for token calls at the DB; `project_private` is filtered out of reads and rejected on writes.
- **A‑D5. Opaque-token lifetime** — *resolved: default `expires_at = now() + 180 days`, plus explicit revocation* (call **b**). Non-expiring is not the default.
- **A‑D6. Gateway pass-through** — *resolved: `Authorization: Bearer <ANON_KEY>` (public) + `X-TeamBrain-Token: tbk_…`* on the exchange call. No `main/index.ts` change.

### A1. Migration `migrations/0012_api_tokens.sql`

- `app.api_tokens` (in the `app` schema, off the PostgREST-exposed surface like the `0002` helpers; RLS enabled, grants to `service_role` only): `id`, `token_hash` (unique), `token_prefix`, `principal_user_id` → `auth.users`, `project_id` → `public.projects`, `allowed_tools text[]`, `allowed_scopes text[]`, `name`, `created_by`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`.
- `public.projects.bot_user_id uuid` (nullable, → `auth.users`) — explicit per-project bot pointer.
- `public.project_members.is_service_account boolean not null default false` — the membership-sync exemption flag (§ A3).
- New `app` helpers (read `current_setting('request.jwt.claims', true)::jsonb`, `stable`, `set search_path = ''`, `grant execute … to authenticated`): `app.is_token_call()` → true when the `teambrain_token` claim is present; `app.token_allowed_scopes()` → the claim's scope array (or `null`).
- Amend `public.thoughts` policies (drop/recreate, single transaction, mirroring `0002`'s style):
  - `thoughts_select` / `thoughts_insert_self`: AND-in `(not app.is_token_call() or scope = any(app.token_allowed_scopes()))`.
  - `thoughts_update_self_or_writer` / `thoughts_delete_own_or_admin`: AND-in `(not app.is_token_call())`.

**Done when:** the migration applies clean via Studio; the existing Phase 2/4 smoke (human JWT) is unchanged; a synthetic bot JWT (`teambrain_token: true`, `teambrain_allowed_scopes: ["project","personal"]`) can `INSERT` a `project`-scope row, is **denied** a `project_private` insert and **denied** any `UPDATE`/`DELETE`, and `SELECT` returns no `project_private` rows.

### A2. Edge function `edge-functions/teambrain-token/` (`index.ts` + `deno.json`)

Reuses the `teambrain-register-project` patterns (service-role client, `{sub, role}` claim parse, `app.is_project_admin` gate). Routes:

- `POST /token` — **admin only** (caller's user JWT). Lazily provisions the project bot via `service.auth.admin.createUser(…)`, stamps `projects.bot_user_id`, inserts the `project_members` row (`contributor`, `is_service_account: true`). Generates `tbk_…`, stores **only** its SHA-256, returns the plaintext **once**.
- `GET /token?project=…` — **admin only**. Lists token metadata (prefix, name, `last_used_at`, `expires_at`, `revoked_at`) — never the hash or plaintext.
- `POST /token/{id}/revoke` — **admin only**. Sets `revoked_at` (soft; no `DELETE`).
- `POST /token/exchange` — anon-key gateway pass + `X-TeamBrain-Token`. Hash → lookup → reject if `revoked_at`/`expired` → bump `last_used_at` → mint a 15-min HS256 JWT (`sub` = `bot_user_id`, `role`/`aud` = `authenticated`, custom claims `teambrain_token: true`, `teambrain_allowed_scopes`, `teambrain_allowed_tools`). Returns `{ access_token, expires_in }`.

**Done when:** an admin can create/list/revoke; a non-admin gets `403`; exchange returns a JWT that `teambrain-mcp` accepts and resolves to the bot's `auth.uid()`; a revoked or expired token fails exchange with a structured error (not a 500).

### A3. Membership-sync bot exemption

`teambrain-membership-sync/sync.ts` would otherwise tombstone the bot every cron run — it has no GitHub handle, so it is never in the "desired" set and falls into the removal loop (`sync.ts:262-269`). Fix: add `is_service_account` to the `project_members` select (`sync.ts:223`) and `continue` past service-account rows in the removal loop (`sync.ts:264`).

**Done when:** a manual `/sync` with the bot present reports it in neither `removed` nor `restored`, and the bot's `project_members.removed_at` stays `null` across a full sync.

### A4. Capability guard in `teambrain-mcp` + `teambrain-rest` (UX layer)

Read `teambrain_token` / `teambrain_allowed_tools` from the JWT; when present, reject a disallowed tool (`mark_stale`, `promote_to_docs` for the capture+read token) with a clear "not permitted for this token" error rather than letting it fail as an opaque RLS denial; intersect requested search/list scopes with `teambrain_allowed_scopes`. Human JWTs (no claim) are unaffected.

**Done when:** a bot-token JWT calling `mark_stale` gets a clear app-level rejection; `capture`/`search`/`list_recent` succeed; a `project_private` capture is refused with a comprehensible message (and RLS backstops it regardless).

### A5. Examples + OpenAPI

- Rewrite `examples/github-actions/capture-on-merge.yml` from the Phase 4 *illustrative* stub to the real flow: exchange `tbk_` → mint JWT → (LLM summarizes merge) → **human-approval gate** (GitHub Environment protection) → `capture_project_thought`.
- Add a curl recipe for the exchange call (anon key + `X-TeamBrain-Token`).
- Extend `nginx/html/openapi.yaml` (3.1) with `/token`, `/token/{id}/revoke`, and `/token/exchange`, documenting the exchange's anon-key + `X-TeamBrain-Token` auth shape.

**Done when:** `actionlint` clean; spec re-validates lint-clean with `openapi-spec-validator`; the curl exchange recipe runs against production.

### A6. Deploy + end-to-end smoke

- Confirm `JWT_SECRET` is in the functions service env (expected — the stock dispatcher reads it); add to the `override.yml` passthrough only if missing (and if so, `cp` to the box per the override-is-a-copy rule).
- Apply `0012` via Studio; rsync `teambrain-token/` into `~/supabase-stack/volumes/functions/` (no `--delete` — the earlier footgun wiped stock `main/`/`hello/`); redeploy patched `teambrain-mcp` / `teambrain-rest` / `teambrain-membership-sync`.
- **Reload PostgREST's schema cache** after `0012` (`NOTIFY pgrst, 'reload schema'`, or bounce the `rest` container) so the new `public.api_tokens` table is visible — otherwise the `teambrain-token` service client gets a 404/`PGRST205` on it.
- Smoke: **Michael** creates the token in his own shell (plaintext returned once — not echoed through Claude) → exchange → capture a `project` thought → confirm `project_private` capture and `mark_stale` are denied → revoke → confirm exchange now fails.

**Done when:** the full smoke passes on `pr.fabric-testbed.net`.

### A7. Commit

**Done when:** `main` on both remotes contains `0012`, `teambrain-token/`, the `sync.ts` / MCP / REST patches, the examples, the spec update, and this checklist; production is deployed and § A6 is green.

---

## B — Slack bot (channel → `project_id`) — *stub, not gated on A*

Adapt OB1's Slack capture pattern, scoped per channel to a `project_id`. Authenticates as a project member (bot or per-installer OAuth — TBD when started). To be detailed when § B begins.

**Done when:** *(to be defined)*.

---

## C — GitHub Action: PR-merge summarization — *consumes A; scoped 2026-05-30*

The runnable version of the Phase 4 illustrative example, and the API token's first real consumer. On PR merge, a **server-side** LLM step proposes 0–3 candidate captures from the merged PR's metadata; the proposals are surfaced in the workflow run summary; a **human-approval gate** (GitHub Environment) must pass before anything is written; on approval the approved set is captured against the REST surface under the project bot's short-lived JWT. First target is the dogfood repo `fabric-testbed/TeamBrain`. Shipping this end-to-end satisfies the Phase 6 readiness gate.

### Decisions locked (2026-05-30)

- **C‑D1. Job topology** — two jobs in one workflow: `propose` (ungated) → `capture` (`needs: propose`, Environment-gated). Each job exchanges its **own fresh** 15‑min JWT from the opaque `tbk_` token (the durable credential, held as a repo secret). A single minted JWT cannot span the approval wait — a human may take hours — so the capture job re‑exchanges *after* the gate rather than reusing the propose job's JWT.
- **C‑D2. Summarization location** — *server-side* `edge-functions/teambrain-summarize/`. The AI key and the proposal prompt live in one place; every adopting repo's workflow stays AI‑key‑free and prompt‑free (per TeamBrain's "new client = config, not code"). The Action just POSTs a PR payload and renders the returned proposals.
- **C‑D3. AI provider/model** — *resolved 2026-05-30: FABRIC's LiteLLM gateway* (`ai-renci.fabric-testbed.net`), which exposes an Anthropic-`/v1/messages`-compatible endpoint, with model **`gpt-5.4-mini`** (a light extraction task; configurable via `TEAMBRAIN_SUMMARIZE_MODEL`). `teambrain-summarize` speaks that same wire format, so only the endpoint + auth changed, not the request: it reads `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (Bearer), wired via the `override.yml` passthrough and `cp`'d to the box (override‑is‑a‑copy rule). The code default stays Anthropic-direct (`claude-sonnet-4-6` over `api.anthropic.com`) for portability.
  - **Egress finding (corrects the earlier "revisit before broadening" hedge):** the ai-renci catalog is entirely **OpenAI-backed** (`gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex / 5.2` — no self-hosted/open-weights option), so routing through it does **not** remove third-party egress — PR metadata still reaches OpenAI via the gateway. The win is **governance**: a FABRIC-owned key + billing + rotation + single audit point, replacing a personal key. Marginal egress is ~zero because OpenAI is **already in TeamBrain's data path** via the embedding provider. The genuine "no third-party AI vendor in the data path" goal would require a self-hosted model the catalog does not currently offer. Tracked with the embedding-provider open decision — `embedding.ts` now also accepts `OPENAI_BASE_URL`, so embeddings can ride the same FABRIC key/gateway (keep a 1536-dim model to avoid a schema migration).
- **C‑D4. LLM input (egress boundary)** — PR **metadata only**: title, body, commit messages, and changed-file *paths*. **No diff contents.** Keeps the prompt bounded, avoids leaking secrets that live in diffs to a third‑party model, and is the conservative default given C‑D3. A bounded, secret‑scrubbed diff is a future option, not Phase 5.
- **C‑D5. Approval gate mechanism** — *revised 2026-05-30:* native GitHub **Environment required-reviewers are unavailable** on this private repo. (`fabric-testbed` is on the Team plan, but the API returns `422 — "ensure the billing plan supports the required reviewers protection rule"`; that rule needs GitHub Enterprise for private repos, or a public repo.) So the gate is an **issue-based approval** via `trstringer/manual-approval` (SHA-pinned `74d99df` / v1.12.0): the `capture` job opens an issue listing the proposals, @-mentions the approver(s) (repo var `TEAMBRAIN_APPROVERS`, default = the PR merger `github.actor`), and blocks until one comments `approved` (writes) or `denied` (discards all). Still **binary** (approve-all / reject-all); per-proposal curation deferred. Upside over the native gate: the proposals render **inline in the issue**, so the approver reviews them without leaving the issue. Requires `issues: write` on the `capture` job.
- **C‑D6. Capture shape** — proposals are constrained to the token's default capability: `scope: project` only, `type ∈ {decision, convention, gotcha, context}`, `confidence: tentative`, tags include `pr-merge` + `auto-capture`, and every capture carries `linked_pr_url` + `linked_commit_sha`. No `project_private`, no `mark_stale`/`promote_to_docs` (RLS backstops this regardless — see § A4).
- **C‑D7. Idempotency** — the REST read surface does not expose `linked_pr_url` (neither `GET /thoughts` nor `/thoughts/search` returns it), so the capture job dedups on a **deterministic per-PR tag** (`owner/repo#N`) instead: it lists recent thoughts (`GET /thoughts`, which *does* return `tags`) and skips the whole capture if any already carries that tag. Robust for the realistic re‑run (the original is still recent); a re‑run after 100+ newer captures would fall outside the window and miss it — accepted for the pilot. The clean future fix is a `linked_pr_url` filter on `GET /thoughts` (which would also serve Phase 6 staleness-by-PR).
- **C‑D8. Prompt-injection posture** — PR title/body are **untrusted** input to the LLM; a hostile PR could try to steer the proposals. The human‑approval gate is the security backstop — nothing is written without a reviewer seeing the exact proposals first. PR‑controlled strings reach the shell only via env + `jq --arg`, never spliced into the script (the existing example already does this).
- **C‑D9. First target** — dogfood `fabric-testbed/TeamBrain` (already a registered project).

### C1. Edge function `edge-functions/teambrain-summarize/` (`index.ts` + `deno.json`)

`POST /teambrain-summarize/propose` — authenticated by any valid JWT (the gateway's global `VERIFY_JWT`; in practice the project bot's minted JWT). Reuses the `teambrain-token`/`teambrain-rest` scaffolding (`HttpError` + `onError`, decode-only JWT, structured errors). Body: `{ project_slug, title, body, commits: string[], changed_paths: string[] }`. Calls Claude (`ANTHROPIC_API_KEY`, model per C‑D3) with a fixed prompt that returns **0–3** proposals as strict JSON, each `{ content, type, scope: "project", tags }`. Writes nothing — generation only. Returns `{ project_slug, count, proposals: [...] }` (possibly empty). *(Built 2026-05-30: `index.ts` + `summarize.ts` + `deno.json`, deno-type-clean; deploy/smoke pending C4/C6.)*

**Done when:** a valid-JWT POST with sample PR metadata returns 0–3 well-formed proposals as JSON; an unauthenticated call is rejected by the gateway; a malformed/oversized body returns a structured 4xx, not a 500; the function never writes to `thoughts`.

### C2. Rewrite `examples/github-actions/capture-on-merge.yml` to the two-job flow

- `permissions: contents: read, pull-requests: read`.
- **Job `propose`** (`if: pull_request.merged == true`): gather PR metadata (event payload for title/body/url/number/sha; `gh api` for commit messages + changed-file paths under `GITHUB_TOKEN`), exchange `tbk_` → JWT, POST to `/teambrain-summarize`, render the proposals to `$GITHUB_STEP_SUMMARY` (human-readable), persist them as a job artifact / `outputs.proposals`, and set `outputs.has_proposals`.
- **Job `capture`** (`needs: propose`, `if: needs.propose.outputs.has_proposals == 'true'`, `environment: teambrain-capture`): on approval, read the proposals, exchange a **fresh** `tbk_` → JWT, dedup by `linked_pr_url` (C‑D7), then POST each to `/teambrain-rest/thoughts` with provenance + tags. Warn (don't fail the merge pipeline) on any capture hiccup; mask the minted JWT (`::add-mask::`).

**Done when:** `actionlint` is clean; a dry inspection shows no PR-controlled value reaching the shell except via env + `jq --arg`; the gate sits between proposal and any write; `has_proposals == false` skips the `capture` job (no pointless approval prompt). *(Built 2026-05-30, gate revised same day: `propose → issue-approval → capture`. Proposals pass via job outputs — `proposals` (compact JSON) drives the writes, `proposals_md` is the approval-issue body. Gate is `trstringer/manual-approval` (SHA-pinned), since native Environment reviewers aren't available on this plan — see C‑D5. Dedup per C‑D7. `actionlint` + `shellcheck` clean. Live smoke pending C4/C6.)*

### C3. OpenAPI + curl

- Add `/teambrain-summarize` to `nginx/html/openapi.yaml` (3.1): JWT auth, request (PR payload), response (`proposals[]`).
- Add a curl recipe (exchange → summarize → inspect proposals) to `examples/curl.md`.

**Done when:** spec re-validates lint-clean with `openapi-spec-validator`; the curl recipe runs against production and returns proposals; tail-verify the spec for stray wrapper tags after editing (the gotcha that bit this very checklist). *(Built 2026-05-30: `summarize` tag + `/teambrain-summarize/propose` path + `ProposeRequest`/`Proposal`/`ProposeResult`/`SummarizeError` schemas; `openapi-spec-validator` → OK; curl § 9 added. Live "runs against production" check pending C4/C6.)*

### C4. Deploy `teambrain-summarize` + wire the AI key

- Add `ANTHROPIC_API_KEY` (and optional `TEAMBRAIN_SUMMARIZE_MODEL`) to the functions service env via `deploy/production/docker-compose.override.yml` passthrough; `cp` the override to `~/supabase-stack/` on the box (copy‑not‑symlink) and recreate the functions service.
- rsync `teambrain-summarize/` into `~/supabase-stack/volumes/functions/` (**no `--delete`** — the footgun that wiped stock `main/`/`hello/`).

**Done when:** `POST /functions/v1/teambrain-summarize` on `pr.fabric-testbed.net` returns proposals for a sample payload under a bot JWT.

### C5. Dogfood rollout (Michael-driven steps)

- Michael issues a `tbk_` token for `fabric-testbed/TeamBrain` in his own shell (plaintext returned once — not echoed through Claude); store it as the repo **secret** `TEAMBRAIN_TOKEN`; add the public anon key as the repo **variable** `TEAMBRAIN_ANON_KEY`.
- Create the `teambrain-capture` Environment with Michael as a Required reviewer.
- Land `capture-on-merge.yml` in `.github/workflows/` of `fabric-testbed/TeamBrain`.

**Done when:** the workflow appears under the repo's Actions and is wired to the secret/variable/environment.

### C6. End-to-end smoke on a real PR

Open → merge a small real PR in the dogfood repo. The `propose` job posts 0–3 proposals to the run summary; the `capture` job pauses on the gate; Michael approves; the approved captures land; each is retrievable via `search_project_thoughts` with its `linked_pr_url`; a workflow re-run writes no duplicates.

**Done when:** the full propose → gate → capture → retrieve path passes on a real merged PR, with dedup verified on re-run.

### C7. Commit

**Done when:** `main` on both remotes contains `teambrain-summarize/`, the rewritten workflow, the spec + curl updates, and this scoped § C; production has the function deployed and the dogfood repo wired; § C6 is green.

**§ C done when:** a merged PR in `fabric-testbed/TeamBrain` produces LLM-proposed captures that, after human approval, land in TeamBrain and are retrievable — satisfying the Phase 6 readiness gate (one working end-to-end capture path).

---

## D — Slash commands for Claude Code / Cursor — *stub, not gated on A*

Document/ship `/remember`-style slash commands that call `capture_project_thought` with the repo auto-detected as `project_id`. To be detailed when § D begins.

**Done when:** *(to be defined)*.

---

## Phase 6 readiness gate

Phase 6 (staleness & promotion: `last_verified_at` decay in ranking, commit-triggered staleness via webhook, `promote_to_docs` generating ADR/docs PRs) can begin when § A is green and at least one of § B / § C / § D has shipped a working capture path end-to-end.

---

## Open follow-ups not blocking Phase 5

- **`teambrain-auth` dev refresh daemon** — developer-side helper that keeps a fresh 24h JWT on disk for CLI clients. Convenience, still deferred (§ J of Phase 4).
- **Exchange audit / rate limiting** — an `api_token_uses` audit table or per-token rate limit on `/token/exchange`. Not required for the pilot; revisit if the exchange surface needs hardening.
- **Asymmetric-key migration** — minting assumes legacy **HS256** over `JWT_SECRET` (matches this stack's current anon/service JWTs and the dispatcher's legacy-verify path). If the stack ever migrates to Supabase's asymmetric (ES256/JWKS) keys, `teambrain-token`'s `mintAccessToken` must switch to signing with the ES256 private key.

---

## Notes for the next session

- JWT lifetime for humans is 24h (`GOTRUE_JWT_EXP=86400`); minted bot access tokens are intentionally far shorter (15 min) to bound revocation latency.
- The exchange endpoint is the only path that is reachable without a real user JWT — keep its surface minimal and its validation strict.
- Default project slug on the server is `fabric-testbed/fabric-core-api`; token-scoped callers operate against the token's bound `project_id`, independent of that default.
