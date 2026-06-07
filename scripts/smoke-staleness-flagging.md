# Smoke — Phase 6 § C commit-triggered staleness flagging

Repeatable check that a commit touching a path a thought pins flags that thought for
re-verification (and **only** that thought — no false positive on an unrelated path), that
the flag is surfaceable and cleared on re-verify, and that the pluggable interface also
flags expired thoughts. This is the "Done when" for `docs/phase-6-checklist.md` § C.

Operator-run (you hold the GitHub-OAuth JWT). Prereqs: `0018` applied (+ `NOTIFY pgrst,
'reload schema'`) and the patched `teambrain-mcp` / `teambrain-rest` + new `teambrain-staleness`
deployed. The **primary** path (steps 1–4) is SQL-direct and needs no GitHub round-trip; the
**secondary** path (step 5) exercises the real poller and needs the GitHub App to have
**Contents: read** + `0019`'s cron (or a manual `/scan`). Studio SQL runs as the admin/service
role; only qualified single-/few-row writes.

## 0. Setup

```bash
export TEAMBRAIN_JWT='<access_token from https://pr.fabric-testbed.net/>'
export BASE=https://pr.fabric-testbed.net/functions/v1
AUTH=(-H "Authorization: Bearer $TEAMBRAIN_JWT" -H "Content-Type: application/json")
SLUG=fabric-testbed/TeamBrain
```

## 1. Capture a pinned thought + an unrelated control

```bash
A=$(curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts" -d "{
  \"content\": \"STALENESS-FLAG smoke: the README documents the quickstart.\",
  \"scope\": \"project\", \"type\": \"context\", \"project_slug\": \"$SLUG\",
  \"paths\": [\"README.md\"], \"tags\": [\"staleness-flag-smoke\"]
}" | jq -r .id)

B=$(curl -sS "${AUTH[@]}" -X POST "$BASE/teambrain-rest/thoughts" -d "{
  \"content\": \"STALENESS-FLAG smoke: the LICENSE is unrelated to README changes.\",
  \"scope\": \"project\", \"type\": \"context\", \"project_slug\": \"$SLUG\",
  \"paths\": [\"LICENSE\"], \"tags\": [\"staleness-flag-smoke\"]
}" | jq -r .id)

echo "A (README, should flag)   = $A"
echo "B (LICENSE, control)      = $B"
```

## 2. Fire the pluggable core directly — Studio SQL

Simulates "a commit touched `README.md`" without a GitHub round-trip. Returns the flagged
thought id(s) — expect **A only**.

```sql
select * from public.flag_thoughts_for_paths(
  (select id from public.projects where repo_slug = 'fabric-testbed/TeamBrain'),
  array['README.md'],
  'commit_touched_path',
  jsonb_build_object('smoke', true)
);
```

## 3. Assert flagged correctly (no false positive) + surfaced

```bash
# REST flagged_only view → expect A present, B absent.
curl -sS "${AUTH[@]}" \
  "$BASE/teambrain-rest/thoughts?project_slug=$SLUG&flagged_only=true&limit=50" \
  | jq '[.results[] | select(.tags|index("staleness-flag-smoke")) | {id, stale_flagged_at, paths}]'
```

Studio SQL cross-check (badge + signal row; B untouched):

```sql
select id, paths, stale_flagged_at from public.thoughts where id in ('<A-id>', '<B-id>');
-- expect: A.stale_flagged_at set, B.stale_flagged_at null.
select thought_id, signal_kind, detail from public.staleness_signals where thought_id = '<A-id>';
-- expect: one commit_touched_path row; none for B.
```

**Pass:** A is flagged + has a `commit_touched_path` signal; B (LICENSE) is **not** flagged.

## 4. Re-verify clears the flag

```bash
curl -sS "${AUTH[@]}" -X PATCH "$BASE/teambrain-rest/thoughts/$A/stale" \
  -d '{"confidence":"tentative","reason":"re-checked after README change"}' \
  | jq '{updated, stale_flagged_at}'      # stale_flagged_at → null
```

```bash
# flagged_only view now excludes A.
curl -sS "${AUTH[@]}" \
  "$BASE/teambrain-rest/thoughts?project_slug=$SLUG&flagged_only=true&limit=50" \
  | jq '[.results[] | select(.tags|index("staleness-flag-smoke")) | .id]'   # → []
```

**Pass:** the `mark_stale` response shows `stale_flagged_at: null`; A no longer appears under `flagged_only`.

## 5. (Secondary) End-to-end via the real poller

Needs the GitHub App **Contents: read** permission and the `teambrain-staleness` function deployed.

1. Push a small commit to `fabric-testbed/TeamBrain` that touches `README.md`.
2. Trigger the scan (operator — service-role bearer from the stack `.env`/`app_config`; the
   pg_cron in `0019` also fires this every 15 min at `5,20,35,50`):
   ```bash
   curl -sS -X POST "$BASE/teambrain-staleness/scan" \
     -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
     -d "{\"project_slug\":\"$SLUG\"}" | jq .
   ```
   First scan of the repo **seeds the cursor and flags nothing** (no historical backfill);
   run it once to seed, push the README commit, then scan again — the second scan reports
   `flagged > 0` and lists the README-pinned thought in `flagged_ids`.
3. `GET $BASE/teambrain-staleness/health` → `200 ok`.

## 6. (Optional) Expiry producer — proves the interface is pluggable

```sql
-- a thought already past its expiry, then run the second producer:
update public.thoughts set expires_at = now() - interval '1 day' where id = '<A-id>';
select public.flag_expired_thoughts();          -- returns count flagged (≥1)
select stale_flagged_at from public.thoughts where id = '<A-id>';        -- set
select signal_kind from public.staleness_signals where thought_id = '<A-id>';  -- includes expires_at_hit
```

## 7. Cleanup — Studio SQL (cascade removes the signals)

```bash
echo "delete from public.thoughts where id in ('$A', '$B');"
```
