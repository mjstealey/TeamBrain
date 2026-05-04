-- 0003_disable_graphql.sql — drop pg_graphql; TeamBrain uses MCP + REST.
--
-- Apply via Studio SQL editor on the scratch instance, after 0002_rls.sql.
--
-- TeamBrain's transports are committed in `docs/adr/0001-teambrain-architecture.md`:
-- MCP (edge function, primary) and REST/OpenAPI (PostgREST, parallel surface
-- for non-MCP-native clients). GraphQL is not in the architecture and never
-- has been. The Supabase docker stack ships pg_graphql enabled by default,
-- which (a) introspects every grant on `public` into a discoverable schema
-- and (b) trips the database linter (lint 0027) for every table where
-- `authenticated` has SELECT — which, in our case, is every table, because
-- PostgREST and MCP both depend on those grants.
--
-- Dropping the extension is the on-architecture fix. PostgREST is unaffected
-- (it does not depend on pg_graphql). Studio's Database tab is unaffected
-- (it uses postgres-meta). Only the `/graphql/v1` endpoint goes away, and
-- we never exposed it to clients.
--
-- Reversibility: `create extension pg_graphql with schema graphql` brings it
-- back identically. The drop has no destructive side effect on user data —
-- pg_graphql is a resolver, not a storage layer.

begin;

drop extension if exists pg_graphql;

commit;
