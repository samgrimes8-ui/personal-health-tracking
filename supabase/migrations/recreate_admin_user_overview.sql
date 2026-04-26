-- Recreate public.admin_user_overview view.
--
-- Got dropped (probably CASCADE during the role refactor — it referenced
-- is_provider or unlimited_access, both of which are gone now).
-- The Admin Panel inside the Account page reads from this view to show
-- per-user stats: signup date, role, spend, tokens, log counts, etc.
--
-- Aggregates data from user_profiles + auth.users + token_usage + meal_log
-- + recipes. SECURITY INVOKER (default) so RLS still applies — but in
-- practice only admins read this (UI gates access via state.usage.isAdmin),
-- and it's queried with the user's own auth context.
--
-- Safe to re-run (CREATE OR REPLACE).

create or replace view public.admin_user_overview as
with month_usage as (
  -- Per-user spend + token + request counts for the current calendar month
  select user_id,
         sum(cost_usd)         as spent_this_month_usd,
         sum(tokens_used)      as tokens_this_month,
         count(*)              as requests_this_month
    from public.token_usage
   where created_at >= date_trunc('month', now())
   group by user_id
),
log_counts as (
  -- Per-user meal log counts (all-time and current month).
  -- meal_log uses logged_at (the date food was eaten) rather than
  -- created_at. logged_at is also a better signal for last-activity:
  -- it reflects when the food was eaten, including backdated entries.
  select user_id,
         count(*) filter (where logged_at >= date_trunc('month', now())) as log_entries_this_month,
         count(*)                                                          as log_entries_total,
         max(logged_at)                                                    as last_log_at
    from public.meal_log
   group by user_id
),
recipe_counts as (
  select user_id, count(*) as recipe_count
    from public.recipes
   group by user_id
)
select p.user_id,
       u.email,
       p.role,
       p.account_status,
       p.spending_limit_usd,
       p.spending_limit_expires_at,
       p.total_spent_usd,
       p.is_admin,
       p.provider_name,
       p.created_at,
       -- Activity heuristic: most recent of meal log, account update.
       -- Used by the panel to show 'last active X days ago'.
       greatest(
         coalesce(lc.last_log_at,    p.created_at),
         coalesce(p.updated_at,      p.created_at)
       ) as last_active,
       coalesce(mu.spent_this_month_usd,   0)::numeric(10,4) as spent_this_month_usd,
       coalesce(mu.tokens_this_month,      0)                as tokens_this_month,
       coalesce(mu.requests_this_month,    0)                as requests_this_month,
       coalesce(lc.log_entries_total,      0)                as log_entries_total,
       coalesce(lc.log_entries_this_month, 0)                as log_entries_this_month,
       coalesce(rc.recipe_count,           0)                as recipe_count
  from public.user_profiles p
  join auth.users u on u.id = p.user_id
  left join month_usage   mu on mu.user_id = p.user_id
  left join log_counts    lc on lc.user_id = p.user_id
  left join recipe_counts rc on rc.user_id = p.user_id;

-- Reload schema cache so PostgREST picks up the new view.
notify pgrst, 'reload schema';
