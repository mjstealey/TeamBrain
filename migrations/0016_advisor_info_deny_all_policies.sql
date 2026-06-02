-- 0016_advisor_info_deny_all_policies.sql — Phase 6 (security-advisor paydown):
-- add explicit deny-all RLS policies to the two service_role-only tables that
-- Supabase's Security Advisor lists under lint 0008 (rls_enabled_no_policy):
-- public.api_tokens (0012) and public.app_config (0013).
--
-- Apply via Studio SQL editor. The api_tokens half is safe on any stack
-- (0012 is an "always" migration). The app_config half self-skips when the
-- table is absent — app_config only exists where the production-only 0013 was
-- applied — so this file is a no-op (not an error) on scratch stacks too.
--
-- Background:
--   Both tables are intentionally service_role-only. 0012/0013 each enable
--   RLS, `revoke all` from anon/authenticated, and grant DML to service_role
--   only. "RLS enabled + zero policies" already denies every non-BYPASSRLS
--   role, so this is the correct secure-by-default posture — NOT a missing-
--   policy bug. Lint 0008 is INFO precisely because that state is usually
--   intentional; the linter can't tell a deliberate lockdown from a forgotten
--   policy.
--
--   This migration is purely cosmetic/legibility: it adds a permissive
--   `using (false)` policy to each table so the lockdown is an explicit schema
--   object (and the advisor board reads a clean zero) WITHOUT changing
--   behavior. service_role has BYPASSRLS, so the edge functions and pg_cron
--   that read/write these tables are unaffected; the policy only ever applies
--   to anon/authenticated, who are already denied by the absent table grant.
--   `with check (false)` covers the INSERT/UPDATE paths for completeness.
--
--   public.health_events is deliberately NOT included: 0013 grants it SELECT
--   to authenticated and already carries the health_events_select_authenticated
--   policy, so it does not trip lint 0008.

begin;

-- api_tokens — always present (0012 is an "always" migration). drop+create
-- keeps the file re-runnable (CREATE POLICY has no IF NOT EXISTS form).
drop policy if exists api_tokens_no_direct_access on public.api_tokens;
create policy api_tokens_no_direct_access on public.api_tokens
  for all using (false) with check (false);

-- app_config — only exists where the production-only 0013 ran. Guarded so the
-- file is a no-op on scratch stacks that skipped 0013 (a bare CREATE POLICY on
-- a missing table would error and abort the transaction). References are fully
-- qualified, so the block is correct regardless of search_path.
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_tables
    where schemaname = 'public' and tablename = 'app_config'
  ) then
    drop policy if exists app_config_no_direct_access on public.app_config;
    create policy app_config_no_direct_access on public.app_config
      for all using (false) with check (false);
  end if;
end
$$;

commit;

-- Verification (read-only) — expect one policy row per existing table:
--
--   select schemaname, tablename, policyname, permissive, qual, with_check
--   from pg_policies
--   where tablename in ('api_tokens', 'app_config')
--   order by tablename;
--
-- Then re-run Supabase Security Advisor: lint 0008 should no longer list
-- api_tokens or app_config. Behavior is unchanged — GET /token,
-- membership-sync, and the pg_cron jobs all act as service_role (BYPASSRLS).
