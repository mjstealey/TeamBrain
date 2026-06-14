# Getting Started with TeamBrain

A developer's guide to reading and writing your team's shared memory from your
AI tool. If you can sign in with GitHub and paste a few lines of config, you can
be capturing and searching team context in about five minutes.

> **What this guide is not:** the operator/deploy guide (that's
> [`deploy/production/README.md`](../deploy/production/README.md)) or the
> architecture rationale (that's
> [`docs/adr/0001-teambrain-architecture.md`](adr/0001-teambrain-architecture.md)).
> This is the end-user onboarding path.

> **Prefer to click?** The **Repositories** dashboard at
> **<https://pr.fabric-testbed.net/repos>** turns this guide into a status-aware,
> mostly one-click flow: it lists every repo you can act on, shows what's already
> set up per repo, and can register a repo, sync members, issue API tokens,
> generate an `AGENTS.md`, and open a setup PR for the capture-on-merge workflow.
> The per-developer MCP/REST connection in § 3 is still a copy-paste step.

---

## 1. What TeamBrain is

TeamBrain is a multi-tenant, project-scoped, **AI-agnostic** shared memory
service for development teams. It gives everyone on a repo the same persistent
context — decisions, conventions, gotchas, in-flight debugging notes — regardless
of which AI tool each person uses (Claude Code, Cursor, Codex, ChatGPT,
gemini-cli, Copilot).

The primary transport is **MCP** (Model Context Protocol); a parallel
**REST/OpenAPI** surface covers anything that isn't MCP-native (GitHub Actions,
OpenAI function calling, custom agents). Both talk to the same backend and
enforce the same access rules. Full rationale:
[`docs/adr/0001-teambrain-architecture.md`](adr/0001-teambrain-architecture.md).

---

## 2. Get access

1. **Sign in.** Open <https://pr.fabric-testbed.net/> and sign in with GitHub
   (OAuth). This creates your user record on first login.
2. **Be a project member.** You can only see and write memory for projects you
   belong to. Membership is managed in `project_members` and is kept in sync from
   each project's GitHub collaborators/teams automatically — so if you're a
   collaborator on the repo, you'll usually be a member within ~15 minutes of
   first sign-in. **Empty search results almost always mean "not a member yet,"**
   not "no memory exists."
3. **Grab a token for testing.** The landing page shows your **access token** (a
   GitHub-OAuth JWT) and a **Renew** button. You'll paste this into your AI tool's
   config below. It lasts **24 hours**; renew it from the same page when it
   expires.

> **The JWT is a personal, short-lived credential.** Don't commit it into a
> shared/checked-in config file (see the per-client notes below for the safe
> team-sharing pattern). For automation that can't do an interactive login (CI,
> cron, GitHub Actions), use a non-interactive **API token** instead — see
> [§ 8 of the curl recipes](../examples/curl.md#8-non-interactive-api-tokens--teambrain-token).

---

## 3. Connect your AI tool

The MCP endpoint is the same for every client:

```
https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp
```

Authentication is a single header on every request: `Authorization: Bearer <JWT>`
(the access token from step 2).

Once connected, your tool gains six MCP tools — `capture_project_thought`,
`search_project_thoughts`, `list_recent_project_thoughts`, `mark_stale`,
`promote_to_docs`, and `ping` — which it will call on your behalf when you ask it
to remember or recall things.

### Claude Code (remote MCP over HTTP)

Add it with the CLI (replace `YOUR_JWT` with your access token):

```bash
claude mcp add --transport http teambrain \
  https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp \
  --header "Authorization: Bearer YOUR_JWT"
```

This defaults to `--scope local` (private to you, stored in `~/.claude.json`).
Verify it connected with `/mcp` inside Claude Code, or `claude mcp list` from the
shell.

**Sharing the connection with your team (without leaking your token).** A
project-scoped `.mcp.json` is committed to git, so it must **not** contain a raw
JWT. Commit the endpoint and have each developer supply their own token via an
environment variable — Claude Code expands `${VAR}` in `.mcp.json`:

```json
{
  "mcpServers": {
    "teambrain": {
      "type": "http",
      "url": "https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp",
      "headers": { "Authorization": "Bearer ${TEAMBRAIN_JWT}" }
    }
  }
}
```

Then each developer runs `export TEAMBRAIN_JWT='<their access token>'` before
launching Claude Code. (For a token that auto-refreshes, point `headersHelper` at
a script that prints `{"Authorization": "Bearer <JWT>"}` instead of using a
static `headers` block.)

### Cursor

Add a remote MCP server in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json`
(project). As with Claude Code, prefer an env-var reference over a committed raw
token:

```json
{
  "mcpServers": {
    "teambrain": {
      "url": "https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp",
      "headers": { "Authorization": "Bearer YOUR_JWT" }
    }
  }
}
```

Reload via **Settings → MCP** and confirm `teambrain` shows its tools.

### gemini-cli

Add to `~/.gemini/settings.json` (use `httpUrl` for the streamable-HTTP
transport):

```json
{
  "mcpServers": {
    "teambrain": {
      "httpUrl": "https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp",
      "headers": { "Authorization": "Bearer YOUR_JWT" }
    }
  }
}
```

Run `/mcp` in gemini-cli to confirm the server and its tools loaded.

### Copilot / VS Code, and other MCP clients

Any client that supports remote MCP over streamable HTTP works the same way:
point it at the endpoint above and set the `Authorization: Bearer <JWT>` header.
Consult your client's MCP docs for the exact config-file shape; the two values
you need are always the **URL** and the **bearer header**.

### ChatGPT / OpenAI function calling (no MCP) — use REST

Non-MCP clients use the REST/OpenAPI surface against the same backend:

- OpenAPI 3.1 spec: <https://pr.fabric-testbed.net/openapi.yaml>
- Worked client: [`examples/openai_function_calling.py`](../examples/openai_function_calling.py)
- Every endpoint as copy-paste curl: [`examples/curl.md`](../examples/curl.md)

### Slash commands — *shipped (Claude Code + Codex)*

Optional one-keystroke shortcuts over the connected MCP server:

- `/tb-remember <text>` — capture (searches first to avoid duplicates)
- `/tb-recall <query>` — semantic search
- `/tb-recent [N]` — newest-first list

Install per client (and the Cursor template, marked untested) is in
[`examples/slash-commands/README.md`](../examples/slash-commands/README.md). They wrap the
same tools you already have over MCP — connect the server first (§ 3 above).

### Slack — *coming soon*

- ☐ **Slack capture bot** (one channel → one project) — Phase 5 § B, not yet shipped.

This section will gain copy-paste Slack setup when it lands.

---

## 4. The mental model

Three small concepts cover almost everything.

### Scope — *who can see it*

| Scope | Visible to | Use for |
|---|---|---|
| `personal` | only you (across all your projects) | your own notes, preferences |
| `project` | every member of the project | shared team knowledge (the common case) |
| `project_private` | members, but excluded from default reads | sensitive project context |

A `personal` thought carries no project. A `project` / `project_private` thought
requires you to be a **writer** (contributor or admin) on the project.

### Type — *what kind of memory it is*

`decision · convention · gotcha · context · preference · runbook`

Optional but recommended — it makes memory easier to scan and filter. (Phase 5
auto-capture from merged PRs is constrained to
`decision | convention | gotcha | context`.)

### `project_slug` — *which project*

A project is identified by its `owner/repo` slug (e.g.
`fabric-testbed/TeamBrain`). Most operations take a `project_slug`; if you omit
it, the server falls back to its configured default. **Pass it explicitly** when
you're working against a specific repo so you don't capture into the wrong place.

---

## 5. Your first capture and search

### From an AI tool (MCP)

Just talk to it. The tool decides when to call TeamBrain:

> **You:** Remember for this project that all stored timestamps are UTC; we
> convert to local only at the display tier. That's a convention.
>
> *(your tool calls `capture_project_thought` with `scope: project`,
> `type: convention`)*

> **You:** What do we know about how this project handles timestamps?
>
> *(your tool calls `search_project_thoughts` and answers from the result)*

Tip: name the project if you work across several — "for `fabric-testbed/TeamBrain`,
remember that…" — so the slug is unambiguous.

### From the shell (REST)

The exact same operations over HTTP (full recipes in
[`examples/curl.md`](../examples/curl.md)):

```bash
export TEAMBRAIN_JWT='<access token from the landing page>'
export BASE=https://pr.fabric-testbed.net/functions/v1
AUTH=(-H "Authorization: Bearer $TEAMBRAIN_JWT" -H "Content-Type: application/json")

# Capture
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts" -d '{
  "content": "All stored timestamps are UTC; convert at the display tier only.",
  "scope": "project", "type": "convention",
  "project_slug": "fabric-testbed/TeamBrain",
  "tags": ["timestamps", "convention"]
}' | jq .

# Search (semantic, freshness-aware ranking)
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts/search" -d '{
  "query": "how do we handle timestamps?",
  "project_slug": "fabric-testbed/TeamBrain", "limit": 5
}' | jq '.results[] | {rank_score, type, content}'
```

Search ranks by `rank_score` (similarity adjusted for recency, confidence, and
expiry), not raw cosine `similarity` — so a freshly re-verified memory outranks a
stale near-duplicate. See [`examples/curl.md` § 3](../examples/curl.md#3-search--post-teambrain-restthoughtssearch).

---

## 6. Where memory lives — and when to promote it

TeamBrain is deliberately **not** the only home for team knowledge. There are two
homes, and knowing which to reach for keeps both trustworthy:

- **In the repo (canonical, reviewed, versioned with code):** `AGENTS.md`,
  `.claude/CLAUDE.md`, `.cursor/rules/`, `docs/adr/`, `docs/context/`. This is
  settled knowledge that's earned a review.
- **In TeamBrain (living, cross-developer, still moving):** in-flight debugging
  notes, gotchas not yet promoted, recent decisions still being validated, dev
  preferences, cross-repo context.

**The promotion loop is the governance mechanism.** When a TeamBrain memory
stabilizes — it's been confirmed and keeps proving true — promote it into the
repo as a reviewed doc with `promote_to_docs` (REST:
[`POST …/thoughts/{id}/promote`](../examples/curl.md#6-promote-to-docs--post-teambrain-restthoughtsidpromote)).
That opens a real PR with an ADR-style file generated from the memory; once a
human merges it, the knowledge is canonical and the original memory points at the
merged doc. This is what keeps TeamBrain from becoming a second, competing source
of truth.

**Freshness.** Every memory tracks `last_verified_at` and an optional
`expires_at`, and carries a `confidence` of `tentative | confirmed | deprecated`.
Search decays stale memories so they sink. When a commit touches a path a memory
is pinned to (`paths`), or an expiry passes, the memory is **flagged for
re-verification** — list those with `flagged_only=true`. Re-verifying (or
`mark_stale`) clears the flag.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Search returns nothing | You're not a member of that project yet | Confirm you're a GitHub collaborator on the repo; membership syncs within ~15 min of first sign-in. Check the `project_slug`. |
| `401 Unauthorized` | JWT missing or expired (they last 24h) | Re-grab the access token from <https://pr.fabric-testbed.net/> (the **Renew** button) and update your client config / `TEAMBRAIN_JWT`. |
| Captured into the wrong project | `project_slug` omitted → fell back to the server default | Always pass `project_slug` (`owner/repo`) explicitly. |
| `403` on capture | Not a writer on the project, or wrong scope | You need `contributor`/`admin` to write `project`/`project_private`. `personal` thoughts must omit `project_slug`. |
| Tool doesn't appear in your AI client | MCP server didn't connect | Re-check the URL and bearer header; in Claude Code run `/mcp`, in gemini-cli `/mcp`, in Cursor open Settings → MCP. |

Full error-code reference:
[`examples/curl.md` § Error shape](../examples/curl.md#error-shape).

---

## Where to next

- **Every endpoint, copy-paste:** [`examples/curl.md`](../examples/curl.md)
- **OpenAPI contract:** <https://pr.fabric-testbed.net/openapi.yaml>
- **Add PR-merge auto-capture to your repo:** [`docs/capture-on-merge-adoption.md`](capture-on-merge-adoption.md)
- **Architecture & decisions:** [`docs/adr/0001-teambrain-architecture.md`](adr/0001-teambrain-architecture.md)
- **Run/operate the service:** [`deploy/production/README.md`](../deploy/production/README.md)
