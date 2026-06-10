-- 0022_staleness_functions_lockdown.sql — Phase 6 (security-advisor paydown):
-- restrict EXECUTE on the two SECURITY DEFINER staleness producers to
-- service_role only.
--
-- Apply via Studio SQL editor after 0018 (which creates both functions).
-- **Production only** — these functions exist only where 0018 was applied;
-- a scratch stack that skipped 0018 has nothing to act on (a REVOKE on a
-- missing function errors and aborts the txn). Idempotent where they exist.
--
-- Background (same root cause as 0015's membership_sync_health lockdown):
--   Supabase's Security Advisor flags both functions under lints 0028/0029
--   ("anon / authenticated can EXECUTE a SECURITY DEFINER function",
--   reachable at /rest/v1/rpc/<fn>):
--     * public.flag_thoughts_for_paths(uuid, text[], text, jsonb)
--     * public.flag_expired_thoughts()
--   0018 did `revoke all ... from public` and granted service_role — which
--   looks complete, but on Supabase `public` is not the only grant path.
--   The stack ships ALTER DEFAULT PRIVILEGES on schema public that grants
--   EXECUTE on every newly created function explicitly to `anon` and
--   `authenticated`. A `revoke from public` never touches those per-role
--   grants, so both functions stayed callable by anyone holding the
--   ANON_KEY (which is embedded in the public landing-page HTML by design).
--   This is exactly why 0021 (dashboard_activity) revoked `anon` by name,
--   and why 0015 revoked all three API roles by name.
--
-- Why this is a real exposure, not advisor noise:
--   Both functions are SECURITY DEFINER, so they bypass RLS. An
--   unauthenticated caller could:
--     * flag_thoughts_for_paths — stamp stale_flagged_at on any project's
--       thoughts (integrity vandalism: mass-flagging a project's memory as
--       stale erodes the exact trust signal Phase 7 measures), insert
--       arbitrary-detail rows into public.staleness_signals for any project,
--       and use the returned thought_ids as a minor existence oracle.
--     * flag_expired_thoughts — trigger the expiry sweep off-schedule
--       (low impact; it only flags genuinely-expired thoughts).
--   Neither writes or returns thought content, so this is integrity/DoS,
--   not disclosure — but unauthenticated write-capable RPCs on the prod DB
--   should be closed.
--
-- Safe because the only legitimate callers already use service_role:
--   * teambrain-staleness edge function — createClient(..., SERVICE_ROLE_KEY)
--     and asserts role=service_role before calling flag_thoughts_for_paths.
--   * pg_cron jobs in 0019 — run flag_expired_thoughts() / the /scan endpoint
--     under the service_role bearer.
--   Locking to service_role changes nothing observable for either.
--   When a signed-in surface eventually needs these, front them with a
--   service_role edge function (mirroring GET /health) rather than
--   re-granting direct RPC to `authenticated` — that keeps the advisor green.

begin;

-- flag_thoughts_for_paths: remove the default per-role grants (anon +
-- authenticated) the advisor named. `from public` is belt-and-suspenders;
-- 0018 already did it, but re-asserting makes this file's end state
-- self-contained.
revoke execute on function public.flag_thoughts_for_paths(uuid, text[], text, jsonb) from public;
revoke execute on function public.flag_thoughts_for_paths(uuid, text[], text, jsonb) from anon;
revoke execute on function public.flag_thoughts_for_paths(uuid, text[], text, jsonb) from authenticated;
grant  execute on function public.flag_thoughts_for_paths(uuid, text[], text, jsonb) to service_role;

-- flag_expired_thoughts: same treatment.
revoke execute on function public.flag_expired_thoughts() from public;
revoke execute on function public.flag_expired_thoughts() from anon;
revoke execute on function public.flag_expired_thoughts() from authenticated;
grant  execute on function public.flag_expired_thoughts() to service_role;

commit;

-- Verification (read-only) — confirm the two API-facing roles can no longer
-- execute either function. (postgres + supabase_admin retain EXECUTE as the
-- owner/superuser roles; they are NOT reachable through the PostgREST JWT
-- surface, so they don't trip lints 0028/0029. The meaningful assertion is
-- that anon + authenticated are absent for both functions — expect 0 rows.)
--
--   select routine_name, grantee, privilege_type
--   from information_schema.routine_privileges
--   where routine_schema = 'public'
--     and routine_name in ('flag_thoughts_for_paths', 'flag_expired_thoughts')
--     and grantee in ('anon', 'authenticated', 'PUBLIC');
