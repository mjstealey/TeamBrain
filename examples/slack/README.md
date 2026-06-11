# TeamBrain in Slack — the `/tb` slash command

Phase 5 § B: capture and recall TeamBrain memories from Slack, scoped per
channel to a project. Type `/tb remember <text>` in a linked channel and it
lands in that channel's project memory; `/tb recall <query>` searches it.

This adapts [OB1's slack-capture integration](https://github.com/NateBJones-Projects/OB1)
(see `CREDITS.md`) with three deliberate differences:

| | OB1 | TeamBrain |
|---|---|---|
| What captures | **every message** in a dedicated inbox channel | only explicit `/tb remember` (team channels would over-capture) |
| Tenancy | one user, one channel | any channel → its linked project (`slack_channels` table) |
| Write path | `service_role` (bypasses RLS) | per-project bot JWT through the REST surface — same RLS + capability fence as every other caller |

## What you get

| Command | Does | Who sees the reply |
|---|---|---|
| `/tb remember <text>` | captures a `project`-scope memory, tagged `slack`, `slack-user:<you>`, `slack-channel:<name>` | the whole channel (shared memory is a team event) |
| `/tb recall <query>` | semantic search, top 5, freshness-ranked; flags deprecated/stale hits | only you |
| `/tb recent [n]` | last *n* memories (default 5, max 15) | only you |
| `/tb status` | which project this channel is linked to | only you |
| `/tb link <owner/repo>` | the link recipe, pre-filled with this channel's IDs | only you |
| `/tb help` | usage | only you |

`mark_stale` / `promote_to_docs` are deliberately absent — same reasoning as
the slash-command pack (`examples/slash-commands/`): they are low-frequency,
agent-judgment actions, not hotkeys. The bot JWT couldn't perform them anyway
(capability fence: capture + read only, `project` scope only — a shared
channel can never touch `personal` or `project_private` memories).

## Trust model (read before linking a channel)

Linking a channel makes **Slack's channel membership the capture/read ACL**
for that project's `project`-scope memories: anyone who can type in the
channel can `/tb remember` and `/tb recall` as the project bot, whether or
not they have a TeamBrain account. Requests are authenticated by Slack's
request signature; the channel→project link (created only by a project
admin) is the authorization. Don't link a channel whose membership is wider
than the project team.

---

## Setup (one-time, ~10 minutes)

### 1. Create the Slack app (workspace admin)

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app
   manifest** → select the workspace → paste [`manifest.yml`](manifest.yml).
2. Review (one slash command, one `commands` scope) → **Create**.
3. **Install to Workspace** → Allow.
4. **Basic Information → App Credentials → Signing Secret** — copy it. This
   is the only credential the server needs (the bot token is never used).

### 2. Configure the server (TeamBrain operator)

On `pr.fabric-testbed.net`, follow `deploy/production/README.md` § 11c:
apply `migrations/0023_slack_channels.sql`, set `SLACK_SIGNING_SECRET` in
`.env`, re-copy the compose override, recreate `functions` + `nginx`, rsync
the `teambrain-slack` function. The runbook includes a synthetic signed
smoke you can run before Slack ever calls in.

### 3. Link a channel to a project (project admin)

In the target Slack channel, run:

```
/tb link fabric-testbed/your-repo
```

It replies (visible only to you) with a `curl` pre-filled with the channel's
IDs. Run it with your GitHub-OAuth JWT (sign in at
<https://pr.fabric-testbed.net> to get one) — linking requires proving you
are a TeamBrain **admin** of the project, which can't be done from inside
Slack (a Slack user doesn't map to a GitHub identity). Then:

```
/tb status     →  "This channel is linked to fabric-testbed/your-repo …"
/tb remember The staging VM only has 8 GB — don't run both pilots on it
/tb recall staging memory limits
```

Link management recipes (list, unlink) are in
[`../curl.md`](../curl.md) § 10; the REST contract is in the published
[OpenAPI spec](https://pr.fabric-testbed.net/openapi.yaml) under the `slack`
tag.

---

## Notes & limits (v1)

- **No message capture, no reactions.** Capturing an existing Slack message
  (e.g. react with :brain:) needs the Events API + a bot token with history
  scopes — a deliberate § B follow-up, not in v1.
- **No search-first dedup prompt.** Unlike `/tb-remember` in the editor
  slash-command pack, `/tb remember` writes immediately — interactive
  confirmation in Slack requires buttons/interactivity surface we didn't
  take on for v1. Keep captures deliberate.
- **Attribution.** Captures are authored by the *project bot* (like the
  capture-on-merge Action); the human is recorded in the
  `slack-user:<name>` tag and shown in the confirmation message.
- **Slow replies.** Slack demands an ACK within 3 s; the function ACKs
  immediately ("Capturing…") and posts the real result a moment later via
  `response_url`.
- **Renamed channels** keep working (identity is the channel *id*), but
  `/tb status` may show a stale display name from link time.
