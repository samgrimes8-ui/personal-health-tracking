-- Resolve the WARN-level security advisories left after fix_security_definer_views.
--
-- Scope:
--   1. function_search_path_mutable — every flagged function gets an explicit
--      `set search_path` so the planner can't be tricked by a malicious
--      search_path on the calling session.
--   2. anon / authenticated_security_definer_function_executable — revoke
--      EXECUTE from public-facing roles for functions that should never be
--      reachable via PostgREST (/rest/v1/rpc/<name>):
--        - trigger functions
--        - maintenance scripts (cleanup_old_error_logs)
--        - edge-function-only RPCs (record_usage, check_spend_limit,
--          calculate_request_cost*) — service_role bypasses these grants,
--          so the edge functions in api/ continue to work
--      Helper functions used inside RLS policy expressions (is_admin,
--      is_current_user_admin) keep the authenticated grant since RLS
--      evaluates them in the caller's session, but we revoke anon.
--   3. public_bucket_allows_listing — the broad SELECT policy on
--      provider-avatars allowed listing the whole bucket. Public buckets
--      serve files directly via the storage public-URL endpoint without
--      needing a SELECT policy on storage.objects, so the policy is
--      pure overhead.
--
-- Safe to re-run.

-- ── 1. Pin search_path on every flagged function ────────────────────────

alter function public.bump_recipe_instructions_version() set search_path = public;
alter function public.handle_new_user()                  set search_path = public, auth;
alter function public.sync_user_email()                  set search_path = public, auth;
alter function public.cleanup_old_error_logs()           set search_path = public;
alter function public.is_admin()                         set search_path = public;
alter function public.is_current_user_admin()            set search_path = public;
alter function public.check_spend_limit(uuid, numeric)   set search_path = public;
alter function public.calculate_request_cost(text, integer, integer)
  set search_path = public;
alter function public.calculate_request_cost_v2(text, text, integer, integer, integer, timestamptz)
  set search_path = public;
alter function public.record_usage(uuid, text, text, integer, integer)
  set search_path = public;
alter function public.record_usage(uuid, text, text, integer, integer, text, text, text[], integer)
  set search_path = public;
alter function public.record_usage(uuid, text, text, integer, integer, text, text, text[], integer, text, integer, text)
  set search_path = public;

-- ── 2. Revoke EXECUTE where the function isn't meant to be called via RPC ──

-- Triggers: invoked by the trigger machinery, never directly.
revoke execute on function public.bump_recipe_instructions_version() from public, anon, authenticated;
revoke execute on function public.handle_new_user()                  from public, anon, authenticated;
revoke execute on function public.sync_user_email()                  from public, anon, authenticated;

-- Maintenance: only run by an admin in psql / SQL editor.
revoke execute on function public.cleanup_old_error_logs() from public, anon, authenticated;

-- Edge-function-only RPCs. /api/analyze.js, /api/tts.js call these with
-- the service-role key, which bypasses GRANTs. Authenticated browsers
-- have no business calling them directly.
revoke execute on function public.check_spend_limit(uuid, numeric) from public, anon, authenticated;
revoke execute on function public.calculate_request_cost(text, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.calculate_request_cost_v2(text, text, integer, integer, integer, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.record_usage(uuid, text, text, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.record_usage(uuid, text, text, integer, integer, text, text, text[], integer)
  from public, anon, authenticated;
revoke execute on function public.record_usage(uuid, text, text, integer, integer, text, text, text[], integer, text, integer, text)
  from public, anon, authenticated;

-- RLS-policy helpers: authenticated must keep EXECUTE so RLS policies
-- referencing these functions evaluate correctly inside the caller's
-- session. Anon never has an authenticated user_id to check, so revoke.
revoke execute on function public.is_admin()              from public, anon;
revoke execute on function public.is_current_user_admin() from public, anon;
grant  execute on function public.is_admin()              to authenticated;
grant  execute on function public.is_current_user_admin() to authenticated;

-- ── 3. Drop the over-broad provider-avatars SELECT policy ───────────────
-- Public buckets serve files via the public URL endpoint without any
-- policy on storage.objects. The broad SELECT policy added LIST/search
-- access on top of that, exposing every avatar filename. Removing it
-- doesn't break direct image loads (which use the public URL).
drop policy if exists provider_avatars_public_read on storage.objects;

-- Reload PostgREST so revoked RPCs disappear from the API surface
-- without waiting for the next schema-cache refresh.
notify pgrst, 'reload schema';
