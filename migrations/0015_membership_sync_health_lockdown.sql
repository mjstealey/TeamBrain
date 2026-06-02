-- 0015_membership_sync_health_lockdown.sql — Phase 6 (security-advisor paydown):
-- restrict EXECUTE on public.membership_sync_health(int) to service_role only.
--
-- Apply via Studio SQL editor after 0013 (which creates the function).
-- **Production only** — the function exists only where 0013 was applied;
-- scratch stacks skip 0013, so there is nothing to act on there (a plain
-- REVOKE on a missing function would error and abort the txn — apply this
-- only where 0013 ran).
--
-- Background:
--   Supabase's Security Advisor flags membership_sync_health() under lints
--   0028/0029 ("anon / authenticated can EXECUTE a SECURITY DEFINER
--   function", reachable at /rest/v1/rpc/membership_sync_health). Two grant
--   paths put it on the public API:
--     * anon          — via Postgres's default PUBLIC execute grant, which
--                        0013 never revoked. 0013's comment said "anon may
--                        not", but the default grant left anon able to anyway.
--     * authenticated — via an explicit grant 0013 added for a *future*
--                        dashboard that does not yet exist.
--   The function is SECURITY DEFINER (it reads public.sync_runs without a
--   caller grant) and returns only status/timestamps/failure-count — never
--   membership data — so the exposure was low risk. But it is unnecessary:
--   the only real caller is the GET /health edge-function endpoint, which
--   invokes the RPC through a service_role client
--   (edge-functions/teambrain-membership-sync/index.ts). The documented
--   anon-key health probe hits that edge function, not this RPC directly, so
--   locking the RPC to service_role does not change the externally observable
--   health endpoint (still 200/503 on the same anon-key curl).
--
--   When a signed-in dashboard eventually needs this data, prefer fronting it
--   with a service_role edge function (mirroring GET /health) over re-granting
--   direct RPC to `authenticated` — that keeps the advisor green.

begin;

-- Remove the default PUBLIC grant (the anon path) and the speculative
-- authenticated grant. `from anon` is belt-and-suspenders: anon only ever
-- held EXECUTE via PUBLIC, but the advisor named the role explicitly, so we
-- revoke it by name too for an unambiguous end state.
revoke execute on function public.membership_sync_health(int) from public;
revoke execute on function public.membership_sync_health(int) from anon;
revoke execute on function public.membership_sync_health(int) from authenticated;

-- Re-assert the one grant the system actually uses (idempotent; already
-- present from 0013) so this file states the function's intended
-- reachability on its own.
grant execute on function public.membership_sync_health(int) to service_role;

commit;

-- Verification (read-only) — expect exactly one grantee row: service_role.
--
--   select grantee, privilege_type
--   from information_schema.routine_privileges
--   where routine_schema = 'public'
--     and routine_name   = 'membership_sync_health'
--   order by grantee;
--
-- Then confirm Supabase Security Advisor lints 0028/0029 no longer list
-- membership_sync_health, and that the health endpoint still answers:
--
--   curl -sS -o /dev/null -w '%{http_code}\n' \
--     -H "Authorization: Bearer ${ANON_KEY}" \
--     "https://pr.fabric-testbed.net/functions/v1/teambrain-membership-sync/health"
--   # still 200 healthy / 503 stale — unchanged by this migration.
