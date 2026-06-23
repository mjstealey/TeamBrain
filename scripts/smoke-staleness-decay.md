# Smoke — Phase 6 § B staleness decay in search ranking

Repeatable end-to-end check that `match_thoughts` ranks a **fresh** thought above a
**stale/deprecated** near-duplicate for the same query, and that `include_deprecated:false`
drops deprecated rows entirely. This is the "Done when" for `docs/development/phase-6-checklist.md` § B.

Operator-run (you hold the GitHub-OAuth JWT). Prereqs: migration `0017` applied (+
`NOTIFY pgrst, 'reload schema'`), the patched `teambrain-rest` deployed, and you are a
**writer** on `fabric-testbed/TeamBrain`. Studio steps run in the SQL editor as the admin/
service role; a qualified single-/two-row `update`/`delete` only — never unqualified.

## 0. Setup

```bash
export TEAMBRAIN_JWT='<access_token from https://pr.fabric-testbed.net/>'
export BASE=https://pr.fabric-testbed.net/functions/v1
AUTH=(-H "Authorization: Bearer $TEAMBRAIN_JWT" -H "Content-Type: application/json")
SLUG=fabric-testbed/TeamBrain
```

## 1. Capture two near-identical thoughts

A distinctive marker token keeps the query from colliding with the real corpus.

```bash
A=$(curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts" -d "{
  \"content\": \"STALENESS-SMOKE quokka: the widget retry budget is 3 attempts with exponential backoff.\",
  \"scope\": \"project\", \"type\": \"convention\", \"project_slug\": \"$SLUG\",
  \"tags\": [\"staleness-smoke\"]
}" | jq -r .id)

B=$(curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts" -d "{
  \"content\": \"STALENESS-SMOKE quokka: widget retry budget is three attempts using exponential backoff.\",
  \"scope\": \"project\", \"type\": \"convention\", \"project_slug\": \"$SLUG\",
  \"tags\": [\"staleness-smoke\"]
}" | jq -r .id)

echo "A (will stay fresh)   = $A"
echo "B (will go deprecated) = $B"
```

## 2. Age + deprecate B (and, to show the confirmed boost, freshen + confirm A)

Studio SQL editor — paste the ids from step 1:

```sql
-- B: backdate verification ~4.4 half-lives and deprecate it.
update public.thoughts
   set last_verified_at = now() - interval '400 days',
       confidence       = 'deprecated'
 where id = '<B-id>';

-- A: re-verify now and confirm it (optional — demonstrates the ×1.15 boost).
update public.thoughts
   set last_verified_at = now(),
       confidence       = 'confirmed'
 where id = '<A-id>';
```

## 3. Search — assert ordering (both returned, fresh on top)

```bash
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts/search" -d "{
  \"query\": \"STALENESS-SMOKE quokka widget retry budget\",
  \"project_slug\": \"$SLUG\", \"limit\": 10, \"threshold\": 0.2
}" | jq '.results[] | {id, rank_score, similarity, confidence, last_verified_at}'
```

**Pass:** both `$A` and `$B` appear; `$A` has the **higher `rank_score`** and sorts first,
`$B` sorts last. `similarity` (raw cosine) is close for both — proving the reorder is the
freshness/confidence factors, not similarity. Expected rough math (per `0017`):
`A ≈ sim × 1.15 × ~1.0` vs `B ≈ sim × 0.40 × ~0.5` → `A` ≈ 5–6× `B`.

## 4. Search with `include_deprecated:false` — assert B drops out

```bash
curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts/search" -d "{
  \"query\": \"STALENESS-SMOKE quokka widget retry budget\",
  \"project_slug\": \"$SLUG\", \"include_deprecated\": false, \"threshold\": 0.2
}" | jq '[.results[] | {id, confidence}]'
```

**Pass:** `$A` is present; `$B` (deprecated) is **absent**.

## 5. Cleanup

Studio SQL editor — qualified, two-row delete:

```sql
delete from public.thoughts where id in ('<A-id>', '<B-id>');
```

## MCP variant

The same assertions hold through `search_project_thoughts` (Claude Code / Cursor / etc.):
the tool now returns `rank_score`, `confidence`, and `expires_at`, and accepts
`include_deprecated`. Steps 1/2/5 are identical; run the search via the MCP tool instead of
the REST curl.
