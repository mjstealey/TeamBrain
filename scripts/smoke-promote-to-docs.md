# Smoke — Phase 6 § D `promote_to_docs` → real docs PR

Repeatable check that promoting a thought opens a real PR in the project's repo with the
generated ADR-style markdown, stamps the source thought (`promoted_pr_url` +
`confidence: confirmed`), is idempotent on a re-promote, and refuses a non-writer / a
`personal`-scope thought. This is the "Done when" for `docs/development/phase-6-checklist.md` § D.

Operator-run (you hold the GitHub-OAuth JWT). **Prereqs:**

1. `migrations/0020_thoughts_promoted_pr_url.sql` applied via Studio (+ `NOTIFY pgrst, 'reload schema'`).
2. Patched `teambrain-mcp` / `teambrain-rest` + the new shared `teambrain-mcp/promote.ts` deployed
   (rsync `teambrain-mcp/`, `teambrain-rest/`, `teambrain-membership-sync/` together — `promote.ts`
   imports `getInstallationToken` from the sync function; **no `--delete`**).
3. **The gate:** the TeamBrain GitHub App (the same App that drives membership sync) must have
   **Contents: write** and **Pull requests: write** on the target repo, and be installed on it.
   This is a superset of the § C `Contents: read` grant — bump it to write in the org's
   *GitHub Apps → TeamBrain Sync → Permissions* page and re-approve the install. Until this lands,
   step 2 returns `502` with a message naming the missing permission (by design, not a 500).

## 0. Setup

```bash
export TEAMBRAIN_JWT='<access_token from https://pr.fabric-testbed.net/>'
export BASE=https://pr.fabric-testbed.net/functions/v1
AUTH=(-H "Authorization: Bearer $TEAMBRAIN_JWT" -H "Content-Type: application/json")
SLUG=fabric-testbed/TeamBrain
```

## 1. Capture a thought to promote

```bash
ID=$(curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts" -d "{
  \"content\": \"PROMOTE smoke: TeamBrain promotes stabilized memories into reviewed repo docs via a human-gated PR.\",
  \"scope\": \"project\", \"type\": \"decision\", \"project_slug\": \"$SLUG\",
  \"tags\": [\"promote-smoke\"]
}" | jq -r .id)
echo "thought to promote = $ID"
```

## 2. Promote → opens a real PR

```bash
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts/$ID/promote" -d '{
  "target_path": "docs/adr/",
  "target_branch": "main"
}' | tee /tmp/promote.json | jq '{ok, already_promoted, pr_url, branch, path, stamped, stamp_error}'
PR_URL=$(jq -r .pr_url /tmp/promote.json)
echo "PR = $PR_URL"
```

**Pass:** `ok:true`, `already_promoted:false`, `stamped:true`, and `pr_url` points at a new PR in
`fabric-testbed/TeamBrain`. The branch is `teambrain/promote-<id8>` and `path` is
`docs/adr/<id8>-decision.md`.

## 3. Verify the PR + committed file

```bash
gh pr view "$PR_URL" --json number,headRefName,files,state \
  | jq '{number, headRefName, state, files: [.files[].path]}'
# expect: state OPEN, headRefName teambrain/promote-<id8>, files includes docs/adr/<id8>-decision.md
gh pr diff "$PR_URL" | sed -n '1,40p'   # eyeball the generated markdown (Content + Provenance)
```

## 4. Idempotency — re-promote returns the same PR, opens no duplicate

```bash
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts/$ID/promote" -d '{}' \
  | jq '{ok, already_promoted, pr_url}'
# expect: ok:true, already_promoted:true, pr_url == the step-2 PR (no second PR)
gh pr list --repo fabric-testbed/TeamBrain --search "head:teambrain/promote-${ID:0:8}" --json number \
  | jq 'length'   # expect: 1
```

## 5. Source thought was stamped

```bash
curl -sS "${AUTH[@]}" "$BASE/teambrain-rest/thoughts?project_slug=$SLUG&limit=50" \
  | jq --arg id "$ID" '.results[] | select(.id==$id) | {id, confidence, promoted_pr_url}'
# expect: confidence "confirmed", promoted_pr_url == the PR URL
```

## 6. (Negative) refusals

```bash
# personal-scope thought → 422 not_a_project_thought (no repo to target)
P=$(curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts" \
  -d '{"content":"PROMOTE smoke: personal note","scope":"personal","type":"context","tags":["promote-smoke"]}' | jq -r .id)
curl -sS -o /dev/null -w "%{http_code}\n" "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts/$P/promote" -d '{}'
# expect: 422
```

A non-writer (reader) calling promote should get `403 {ok:false, code:"forbidden"}`. Test only if a
reader JWT is handy; RLS + the explicit role check both back this.

## 7. Cleanup

```bash
gh pr close "$PR_URL" --delete-branch        # close the smoke PR + delete its branch
```

```sql
-- Studio SQL (admin/service role): drop the smoke thoughts.
delete from public.thoughts where 'promote-smoke' = any(tags);
```
