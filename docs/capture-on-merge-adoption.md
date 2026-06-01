# Adopting capture-on-merge in your repo

**Audience:** a repo admin (e.g. Komal / `kthare10`) who wants merged PRs in their
repo to propose TeamBrain memories behind a human-approval gate.

**What you get:** when a PR merges, a server-side LLM reads the PR's *metadata*
and proposes 0–3 candidate memories; an approval issue lists them; once an
approver comments **approved**, the approved set is written to TeamBrain tagged
with the PR's provenance. Nothing is ever written without a human approving the
exact text first.

This is the runnable version of `examples/github-actions/capture-on-merge.yml`
(Phase 5 § C), already dogfooded end-to-end on `fabric-testbed/TeamBrain`.

---

## 0. Doability for `fabric-testbed/loomai-dev` (private) — confirmed

`loomai-dev` lives in the **`fabric-testbed`** org
(<https://github.com/fabric-testbed/loomai-dev>), so it **clears the org gate**
and adoption is **fully self-service**: Komal can do all four steps in
[§ 2](#2-adoption-the-four-steps) herself — no code changes, no operator
involvement. Being **private doesn't matter** — the approval gate is issue-based,
which works on any plan or visibility (see
[§ 4](#4-the-approver-gate-public-vs-private)).

| Eligibility gate | Status for `fabric-testbed/loomai-dev` |
|---|---|
| **Org gate** — repo owner must be `fabric-testbed` (`TEAMBRAIN_GITHUB_ORG`) | ✅ Cleared. |
| **App-visibility** — the TeamBrain GitHub App must be able to see the repo | ⚠️ The one thing to confirm. If the App is installed on **all** `fabric-testbed` repos, you're done. If it's on **selected** repos, `loomai-dev` must be in the selection or Step 1 returns `404` — a one-click org-owner fix ([§ 6](#6-the-only-possible-blocker-app-visibility)). |

**Prerequisite for Komal personally:** repo-admin on `loomai-dev` (she has it —
it's hers) and a **one-time GitHub-OAuth sign-in** at
<https://pr.fabric-testbed.net/> (creates the `auth.users` row TeamBrain keys
off — this is the same buy-in step tracked as the pre-pilot blocker).

Everything else is shared infrastructure that already exists and needs **no
per-repo setup**: the `teambrain-summarize` LLM endpoint, the FABRIC AI key, the
`teambrain-token` exchange, and the REST surface are all live on
`https://pr.fabric-testbed.net`.

---

## 1. How the flow works

```
PR merges
   │
   ▼
┌────────────────────────────────────────────────────────────────┐
│ job: propose            (permissions: contents+PRs read)       │
│  1. gather PR METADATA   title · body · commit msgs ·          │
│       (NO diffs)            changed-file PATHS                 │
│  2. exchange tbk_ token → 15-min JWT                           │
│  3. dedup: already captured for this PR? → stop, no LLM call   │
│  4. POST /teambrain-summarize/propose  → 0–3 proposals         │
│  5. render proposals into the run summary + job outputs        │
└────────────────────────────────────────────────────────────────┘
   │ has_proposals == true
   ▼
┌───────────────────────────────────────────────────────────────┐
│ job: capture            (permissions: issues write)           │
│  1. open an APPROVAL ISSUE listing the proposals,             │
│       @-mention the approver(s) — BLOCKS here                 │
│  2. approver comments "approved"  (or "denied" → discard all) │
│  3. exchange a FRESH tbk_ → JWT  (the propose job's expired)  │
│  4. dedup again, then write each proposal to                  │
│       /teambrain-rest/thoughts  with provenance + tags        │
└───────────────────────────────────────────────────────────────┘
```

Key design points (all already settled — you don't choose these):

- **Two jobs, a fresh JWT each.** The minted JWT lives only 15 minutes — far
  shorter than a human-approval wait — so the `capture` job re-exchanges its own
  token *after* the gate. The durable credential is the opaque `tbk_` token held
  as a repo secret.
- **Server-side summarization.** The AI key and the proposal prompt live in the
  `teambrain-summarize` edge function. **Your workflow carries no AI key and no
  prompt.** It just POSTs PR metadata and renders what comes back.
- **Metadata only — no diffs.** Only the PR title, body, commit messages, and
  changed-file *paths* are sent to the model. Diff contents never leave your repo
  through this path.
- **Human approval is the security backstop.** PR titles/bodies are untrusted
  input to the LLM; nothing is written until an approver sees the exact
  proposals and approves. PR-controlled strings reach the shell only via
  `env:` + `jq --arg`, never spliced into a script.

---

## 2. Adoption — the four steps

Prerequisites for the person doing this:
- A **GitHub account with repo-admin** on the target repo.
- Has signed into <https://pr.fabric-testbed.net/> **once** with GitHub OAuth
  (this creates the `auth.users` row TeamBrain keys off).

All API calls below go to `BASE=https://pr.fabric-testbed.net/functions/v1`.

### Step 1 — Register the repo as a TeamBrain project

Grab your **GitHub-OAuth JWT** from the landing page (sign in → copy the access
token; it lasts 24h). Then:

```bash
export BASE=https://pr.fabric-testbed.net/functions/v1
export TEAMBRAIN_JWT='<access token from https://pr.fabric-testbed.net/>'
AUTH=(-H "Authorization: Bearer $TEAMBRAIN_JWT" -H "Content-Type: application/json")

curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-register-project/register" -d '{
  "repo_slug": "fabric-testbed/loomai-dev",
  "name": "LoomAI (dev)"
}' | jq .
```

What this does (and why it must be you): the function checks — using the
TeamBrain GitHub App — that **you are an admin collaborator** on the repo, then
creates the project and seeds **you as the project `admin`** in
`project_members`. That admin row is what lets you issue a token in Step 2. It
also kicks off a membership sync to pull in the rest of your team.

- `201` → registered. (Skip this step if the repo is already registered;
  re-running returns `409 already registered`.)
- `404 not found or not accessible to the TeamBrain GitHub App` → the App can't
  see `loomai-dev`; an org owner must add it to the App's installation — see
  [§ 6](#6-the-only-possible-blocker-app-visibility).
- `403 repo owner must be the "fabric-testbed" GitHub org` → shouldn't happen for
  `loomai-dev`; means the `repo_slug` was mistyped (it must be
  `fabric-testbed/loomai-dev`).
- `403 requires admin permission` → you have write/maintain but not admin on the
  repo; an actual repo admin must register it.

### Step 2 — Issue a long-lived `tbk_` token (project admin)

> ⚠️ The token plaintext is returned **exactly once** and is never retrievable
> again. Run this in your own terminal and capture the output directly — don't
> paste it into a chat or a ticket.

```bash
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-token/token" -d '{
  "project_slug": "fabric-testbed/loomai-dev",
  "name": "capture-on-merge (GitHub Actions)"
}' | jq .
```

The response includes `"token": "tbk_…"`. Copy that value — it's the credential
for Step 3. Defaults (no need to override): capture + read tools, scopes
`["project","personal"]`, **180-day** expiry. You can later list or revoke
tokens:

```bash
curl -sS "${AUTH[@]}" "$BASE/teambrain-token/token?project=fabric-testbed/loomai-dev" | jq .   # list
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-token/token/$TOKEN_ID/revoke" | jq .            # revoke
```

### Step 3 — Set the repo secret + variables

In the repo: **Settings → Secrets and variables → Actions**.

| Name | Kind | Value | Why |
|---|---|---|---|
| `TEAMBRAIN_TOKEN` | **Secret** | the `tbk_…` from Step 2 | the durable credential the workflow exchanges for short-lived JWTs |
| `TEAMBRAIN_ANON_KEY` | **Variable** | the public anon key (see below) | gateway pass-through only — *not* a secret; it's the same key the landing page ships to browsers |
| `TEAMBRAIN_APPROVERS` | **Variable** *(optional)* | comma/newline list of GitHub usernames | who may approve a capture; defaults to the PR merger |

**Where to get the anon key:** open <https://pr.fabric-testbed.net/>, view the
"copy curl" snippet (or page source) — it's the value in the `apikey:` header /
`ANON_KEY` constant. It is intentionally public (it only satisfies the gateway's
"some valid JWT" check on the exchange call), so storing it as a *variable* is
correct.

CLI equivalent:

```bash
gh secret   set TEAMBRAIN_TOKEN    --repo fabric-testbed/loomai-dev   # paste tbk_… when prompted
gh variable set TEAMBRAIN_ANON_KEY --repo fabric-testbed/loomai-dev --body '<public anon key>'
gh variable set TEAMBRAIN_APPROVERS --repo fabric-testbed/loomai-dev --body 'kthare10'   # optional
```

### Step 4 — Add the workflow

Copy the shipped, hardened workflow into your repo:

```bash
mkdir -p .github/workflows
curl -sSL https://raw.githubusercontent.com/fabric-testbed/TeamBrain/main/examples/github-actions/capture-on-merge.yml \
  -o .github/workflows/capture-on-merge.yml
git add .github/workflows/capture-on-merge.yml
git commit -m "ci: TeamBrain capture-on-merge"
```

No edits to the file are needed — it reads everything from the secret/variables
you set in Step 3, and the API base URL is the same for every repo. Open and
merge a small PR to smoke-test (see [§ 5](#5-verify-it-works)).

---

## 3. The workflow at a glance

The file is `examples/github-actions/capture-on-merge.yml`. You don't edit it,
but here's what it relies on so nothing is a black box:

- **Trigger:** `on: pull_request: [closed]`, guarded by
  `if: github.event.pull_request.merged == true` (so close-without-merge is a
  no-op).
- **Least privilege:** top-level `permissions: {}`; `propose` opts into
  `contents: read` + `pull-requests: read`, `capture` into `issues: write`.
- **Idempotency:** both jobs skip if a capture already exists for the PR's URL,
  so a re-run never duplicates.
- **Project slug = `github.repository`** — this is why the registered slug must
  match the repo exactly (`fabric-testbed/loomai-dev`).

---

## 4. The approver gate: public vs private

This is the only place the public/private question actually matters — and the
shipped default already handles both.

### Default (shipped): issue-based gate — works everywhere

The workflow uses [`trstringer/manual-approval`](https://github.com/trstringer/manual-approval)
(SHA-pinned). The `capture` job opens an issue that **renders the proposals
inline**, @-mentions the approver(s), and blocks until someone comments
`approved` (writes) or `denied` (discards all).

This works on **any repository — public or private — on any GitHub plan.** No
extra setup beyond `issues: write` (already in the workflow) and optionally the
`TEAMBRAIN_APPROVERS` variable.

> **For `loomai-dev` (private, `fabric-testbed` Team plan), this is your gate** —
> use the workflow as-is. The native-reviewers alternative below is **not
> available** for this repo (private + non-Enterprise → GitHub returns `422`), so
> there's nothing to change.

### Optional alternative: native GitHub Environment required-reviewers

GitHub's built-in deployment-protection "required reviewers" rule is an
alternative gate, but its availability is plan-dependent:

| Repo visibility | Native required-reviewers available? |
|---|---|
| **Public** | ✅ Yes, on all plans (free). |
| **Private** | ⚠️ Needs **GitHub Enterprise**. On `fabric-testbed`'s current Team plan the API returns `422 — billing plan does not support the required reviewers protection rule`. |

Because the issue-based gate already covers every case and renders proposals
inline, there's **no reason to switch** unless you specifically want GitHub's
native approval UI on a **public** (or Enterprise) repo. If you do:

1. Create an Environment named `teambrain-capture` with yourself as a
   *Required reviewer* (Settings → Environments).
2. In the `capture` job, replace the `trstringer/manual-approval` step with
   `environment: teambrain-capture` on the job and drop `issues: write`.

That swap is a local edit to your copy of the workflow; the rest of the flow is
identical.

---

## 5. Verify it works

1. Open a small PR in the repo and merge it.
2. **Actions tab** → the `propose` job's summary shows *N* proposed captures
   (or "No durable memories proposed" — a no-op is a valid outcome).
3. If there were proposals, an **approval issue** opens titled
   `TeamBrain: approve N capture(s) for PR #…`. Comment **approved**.
4. The `capture` job writes them. Confirm via search:

   ```bash
   curl -sS "${AUTH[@]}" -G "$BASE/teambrain-rest/thoughts/search" \
     --data-urlencode "project_slug=fabric-testbed/loomai-dev" \
     --data-urlencode "q=<something from the PR>" | jq '.results[] | {type, content, tags}'
   ```

   Captures carry tags `pr-merge`, `auto-capture`, and `owner/repo#N`.
5. **Re-run** the workflow on the same PR → it writes **0** duplicates (the dedup
   guard fires).

---

## 6. The only possible blocker: App visibility

Since `loomai-dev` is under `fabric-testbed`, the org gate is already cleared and
nothing in § 2 requires a code change. The **one** thing that could still stop
Step 1 is whether the TeamBrain GitHub App can *see* `loomai-dev`:

- If the App is installed on **all repositories** in the `fabric-testbed` org →
  nothing to do; proceed with § 2.
- If the App is installed on **selected repositories** → `loomai-dev` must be
  added to that selection, or registration (and later membership sync) returns
  `404 not accessible to the TeamBrain GitHub App`.

**Fix (org-owner action, ~1 minute):** GitHub → `fabric-testbed` org → *Settings
→ GitHub Apps* → the TeamBrain Sync App → *Configure* → under *Repository
access*, either keep "All repositories" or add `loomai-dev` to the selected set →
*Save*. Then re-run § 2 Step 1.

This is the same App whose installation token already drives membership sync for
every registered `fabric-testbed` project, so no new credentials or env wiring
are involved — only the repo selection. Komal can't change this herself (it's an
org-settings action), so if Step 1 `404`s, that's the one thing to hand to an
org owner.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Register → `404 not accessible to the TeamBrain GitHub App` | App can't see `loomai-dev` | add it to the App installation — [§ 6](#6-the-only-possible-blocker-app-visibility) |
| Register → `403 repo owner must be the "fabric-testbed" GitHub org` | `repo_slug` mistyped | use exactly `fabric-testbed/loomai-dev` |
| Register → `403 requires admin permission` | You're not a repo admin | a repo admin must register |
| Token create → `403 project admin role required` | You aren't the project admin | register the project yourself, or have the admin issue the token |
| `propose` job warns and skips | `TEAMBRAIN_TOKEN`/`TEAMBRAIN_ANON_KEY` unset | re-check Step 3 (secret vs variable) |
| `token exchange failed` | token revoked/expired, or wrong anon key | re-issue the `tbk_`; confirm the anon-key variable |
| No approval issue appears | `propose` found 0 proposals, or `has_proposals=false` | expected for low-signal PRs; check the run summary |
| Captures don't show in search | wrong `project_slug`, or still awaiting approval | confirm slug = `github.repository`; approve the issue |

---

## 8. Security & operational notes

- **`tbk_` is a secret; the anon key is not.** Keep `TEAMBRAIN_TOKEN` a repo
  *secret*; the anon key is deliberately public (it ships to browsers) and
  belongs in a *variable*.
- **Capability-fenced by design.** The minted JWT can only `capture` + `search` +
  `list_recent` in `project`/`personal` scope. It **cannot** write
  `project_private`, `mark_stale`, or `promote_to_docs` — enforced in the
  database (RLS), not just the app. A leaked token is bounded to one project's
  non-private memory and is revocable in Step 2.
- **Revocation latency ≤ 15 min.** Revoking the `tbk_` stops new JWT mints; any
  already-minted JWT expires within 15 minutes.
- **Nothing writes without a human.** The approval gate is mandatory and binary
  (approve-all / deny-all); per-proposal curation is a future enhancement.

---

## Reference

- Workflow: `examples/github-actions/capture-on-merge.yml`
- Server summarizer: `edge-functions/teambrain-summarize/`
- Token issuance/exchange: `edge-functions/teambrain-token/` · curl recipes in `examples/curl.md` §§ 8–9
- Registration: `edge-functions/teambrain-register-project/`
- OpenAPI contract: <https://pr.fabric-testbed.net/openapi.yaml>
- Design rationale: `docs/phase-5-checklist.md` § C (decisions C-D1 … C-D9)
