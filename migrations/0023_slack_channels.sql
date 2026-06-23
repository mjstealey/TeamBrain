-- 0023_slack_channels.sql — Phase 5 § B1: Slack channel → project mapping.
--
-- Apply via Studio SQL editor (or docker exec psql as supabase_admin) on the
-- target instance, after 0001-0022.
--
-- Background (docs/development/phase-5-checklist.md § B):
--   The `teambrain-slack` edge function exposes a `/tb` slash command
--   (remember / recall / recent / status) inside Slack. The channel the
--   command is typed in resolves the TeamBrain project through this table:
--   one row per linked (workspace, channel) pair, pointing at exactly one
--   project. A project may have many linked channels; a channel maps to at
--   most one project (unique constraint below).
--
--   Trust model (B-D2/B-D3): a row in this table IS the durable
--   authorization for Slack-originated capture/read on its project — the
--   Slack request signature (HMAC over the signing secret) authenticates the
--   request, the link row authorizes it, and the function then mints a
--   short-lived bot JWT (same claim shape as the § A token exchange, so the
--   0012 capability fence applies: `project` scope only, no UPDATE/DELETE)
--   and drives the existing REST surface through the existing RLS. Unlinking
--   the channel (row delete via the admin route) revokes the path.
--
--   Rows are created/listed/deleted ONLY through the function's admin routes
--   (`POST/GET/DELETE /teambrain-slack/links`), which gate on the caller
--   being a project admin — the same gate as API-token CRUD (§ A2).
--
-- Conventions (from 0012/0013/0016 + project memory):
--   * Table lives in `public` but is service_role-only: RLS enabled, grants
--     revoked from anon/authenticated, full DML granted to service_role only.
--     PostgREST never exposes it to end users.
--   * Explicit deny-all policy so the lockdown is a visible schema object and
--     Security Advisor lint 0008 (rls_enabled_no_policy) reads clean — the
--     0016 convention, applied here from day one instead of retrofitted.
--   * Unqualified references avoided; everything schema-qualified.

begin;

-- 1. Table ---------------------------------------------------------------

create table if not exists public.slack_channels (
  id                 uuid primary key default gen_random_uuid(),

  -- Slack identifiers. team_id is the workspace (T…); channel_id is the
  -- channel (C…, historically G… for private groups). Names/domain are
  -- display-only convenience captured at link time — Slack may rename a
  -- channel without this row noticing; the IDs are the identity.
  slack_team_id      text not null,
  slack_team_domain  text,
  slack_channel_id   text not null,
  slack_channel_name text,

  project_id         uuid not null references public.projects (id) on delete cascade,

  -- Provenance: which (human) user linked it, via the admin route.
  linked_by          uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),

  -- Ops signal, stamped best-effort on each slash-command use (mirrors
  -- api_tokens.last_used_at): a never-used link is a candidate for cleanup.
  last_used_at       timestamptz,

  -- A channel belongs to at most one project. Re-linking requires an
  -- explicit unlink first (the function returns 409 with the current
  -- mapping rather than silently re-pointing capture traffic).
  unique (slack_team_id, slack_channel_id)
);

comment on table public.slack_channels is
  'Phase 5 § B: Slack (workspace, channel) → TeamBrain project mapping. A row is the durable authorization for Slack-originated capture/read on its project; managed only via teambrain-slack admin routes (project-admin gated). Service_role-only.';
comment on column public.slack_channels.slack_team_id is
  'Slack workspace id (T…). Identity is (slack_team_id, slack_channel_id); names are display-only.';
comment on column public.slack_channels.slack_channel_id is
  'Slack channel id (C…, legacy private groups G…).';
comment on column public.slack_channels.last_used_at is
  'Best-effort stamp on each slash-command use of this link (ops signal, mirrors api_tokens.last_used_at).';

-- Slash-command hot path: resolve a channel to its project.
create index if not exists slack_channels_lookup_idx
  on public.slack_channels (slack_team_id, slack_channel_id);

-- Admin listing: all links for a project.
create index if not exists slack_channels_project_idx
  on public.slack_channels (project_id);

-- 2. Lockdown (service_role only) ----------------------------------------

alter table public.slack_channels enable row level security;

revoke all on public.slack_channels from anon;
revoke all on public.slack_channels from authenticated;
grant select, insert, update, delete on public.slack_channels to service_role;

-- Explicit deny-all so the advisor board reads a deliberate lockdown, not a
-- forgotten policy (0016 convention). service_role bypasses RLS; everyone
-- else is denied by this policy AND by the revoked grants above.
drop policy if exists slack_channels_deny_all on public.slack_channels;
create policy slack_channels_deny_all
  on public.slack_channels
  for all
  using (false)
  with check (false);

comment on policy slack_channels_deny_all on public.slack_channels is
  'Deliberate deny-all: table is service_role-only (teambrain-slack edge function). See 0016 for the convention.';

commit;

-- Verification (run separately after apply):
--
--   -- table + columns present
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'slack_channels';
--
--   -- RLS on, deny-all policy present
--   select relrowsecurity from pg_class where oid = 'public.slack_channels'::regclass;
--   select polname from pg_policy where polrelid = 'public.slack_channels'::regclass;
--
--   -- grants: service_role only
--   select grantee, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'slack_channels';
