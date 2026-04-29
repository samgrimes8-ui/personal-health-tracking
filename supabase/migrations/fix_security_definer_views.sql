-- Fix three SECURITY-level findings reported by Supabase database linter:
--
--   auth_users_exposed       public.admin_user_overview  → exposed to anon
--   security_definer_view    public.admin_user_overview  → bypasses RLS
--   security_definer_view    public.token_usage_monthly  → bypasses RLS
--
-- Strategy:
--
--   admin_user_overview — Replace the view with a SECURITY DEFINER FUNCTION
--   that explicitly checks the caller is an admin before returning rows.
--   A function can hold elevated privileges safely because the auth check
--   gates access at the application layer; a view can't (PostgREST exposes
--   it directly to whatever role you grant SELECT to). The app calls the
--   function via supabase.rpc() instead of from().select().
--
--   token_usage_monthly — Not referenced by any app code (grep src/ api/).
--   Drop it. Re-create as SECURITY INVOKER if it's ever needed for
--   ad-hoc queries.
--
-- Safe to re-run: all DROP statements use IF EXISTS, all CREATEs use
-- OR REPLACE.

-- ── Drop the offending views ─────────────────────────────────────────────
drop view if exists public.admin_user_overview cascade;
drop view if exists public.token_usage_monthly cascade;

-- ── Admin guard ──────────────────────────────────────────────────────────
-- Mirrors the role check the app already uses on user_profiles. Stable so
-- the planner can cache it within a query, security definer so the function
-- can read the user_profiles row regardless of RLS.
create or replace function public.is_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.user_profiles
     where user_id = p_user_id
       and (role = 'admin' or is_admin = true)
  );
$$;

revoke all on function public.is_admin(uuid) from public, anon;
grant execute on function public.is_admin(uuid) to authenticated;

-- ── Admin user overview replacement ──────────────────────────────────────
-- Returns the exact same columns the dropped view returned, in the same
-- shape. Raises permission_denied (42501) if the caller isn't an admin so
-- a non-admin client gets a noisy error rather than silent empty results.
create or replace function public.admin_user_overview()
returns table (
  user_id uuid,
  email text,
  role text,
  account_status text,
  spending_limit_usd numeric,
  spending_limit_expires_at timestamptz,
  total_spent_usd numeric,
  is_admin boolean,
  provider_name text,
  created_at timestamptz,
  last_active timestamptz,
  spent_this_month_usd numeric,
  tokens_this_month bigint,
  requests_this_month bigint,
  log_entries_total bigint,
  log_entries_this_month bigint,
  recipe_count bigint
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admin access required' using errcode = '42501';
  end if;

  return query
  with month_usage as (
    select tu.user_id,
           sum(tu.cost_usd)    as spent_this_month_usd,
           sum(tu.tokens_used) as tokens_this_month,
           count(*)            as requests_this_month
      from public.token_usage tu
     where tu.created_at >= date_trunc('month', now())
     group by tu.user_id
  ),
  log_counts as (
    select ml.user_id,
           count(*) filter (where ml.logged_at >= date_trunc('month', now())) as log_entries_this_month,
           count(*)                                                            as log_entries_total,
           max(ml.logged_at)                                                   as last_log_at
      from public.meal_log ml
     group by ml.user_id
  ),
  recipe_counts as (
    select r.user_id, count(*) as recipe_count
      from public.recipes r
     group by r.user_id
  )
  select p.user_id,
         u.email::text,
         p.role,
         p.account_status,
         p.spending_limit_usd,
         p.spending_limit_expires_at,
         p.total_spent_usd,
         p.is_admin,
         p.provider_name,
         p.created_at,
         greatest(
           coalesce(lc.last_log_at, p.created_at),
           coalesce(p.updated_at,   p.created_at)
         ) as last_active,
         coalesce(mu.spent_this_month_usd, 0)::numeric(10,4) as spent_this_month_usd,
         coalesce(mu.tokens_this_month,    0)                as tokens_this_month,
         coalesce(mu.requests_this_month,  0)                as requests_this_month,
         coalesce(lc.log_entries_total,      0)              as log_entries_total,
         coalesce(lc.log_entries_this_month, 0)              as log_entries_this_month,
         coalesce(rc.recipe_count,           0)              as recipe_count
    from public.user_profiles p
    join auth.users u on u.id = p.user_id
    left join month_usage   mu on mu.user_id = p.user_id
    left join log_counts    lc on lc.user_id = p.user_id
    left join recipe_counts rc on rc.user_id = p.user_id;
end;
$$;

revoke all on function public.admin_user_overview() from public, anon;
grant execute on function public.admin_user_overview() to authenticated;

-- Reload PostgREST schema cache so the rpc endpoint picks up immediately.
notify pgrst, 'reload schema';
