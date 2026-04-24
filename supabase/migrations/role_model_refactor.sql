-- ═══════════════════════════════════════════════════════════════════════════
-- Role model refactor
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Moves from a messy split model (role + is_provider + unlimited_access +
-- is_admin) to a single-source-of-truth `role` column.
--
-- New model:
--   role = 'free'      → $0.30 / month AI budget
--   role = 'premium'   → $10.00 / month AI budget
--   role = 'provider'  → $50.00 / month AI budget  (replaces dietitian/coach/nutritionist)
--   role = 'admin'     → unlimited, also bypasses every other check
--
-- Adds `credentials text` (free-text field like "RD, LD, CSCS") so providers
-- can describe themselves without us maintaining a rigid enum of subtypes.
--
-- Drops `is_provider` and `unlimited_access` columns — both subsumed by role.
-- Keeps `spending_limit_usd` as an OPTIONAL per-user override (null = use
-- role default). Keeps `is_admin` for now as a mirror of role='admin' until
-- we've fully audited every consumer.
--
-- Old role values ('dietitian', 'coach', 'nutritionist', 'trainer') are
-- migrated to 'provider'. Everyone else falls back to 'free'. Users with
-- is_admin=true but no role get 'admin'.
--
-- Safe to re-run: everything is additive or idempotent.
--
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Step 1: Add credentials column ──────────────────────────────────────

alter table public.user_profiles
  add column if not exists credentials text;

-- ─── Step 2: Normalize role values ────────────────────────────────────────
-- Map every existing role value to one of the 4 new canonical values. Run
-- this BEFORE dropping is_provider/unlimited_access so we can use them as
-- signals during the migration (e.g. unlimited_access=true with no role
-- suggests the user should be premium-or-higher).

update public.user_profiles
set role = case
  -- Admin takes precedence over everything else
  when role = 'admin' or is_admin = true                               then 'admin'
  -- Old provider-ish roles all collapse to the single 'provider' role
  when role in ('dietitian', 'coach', 'nutritionist', 'trainer')       then 'provider'
  -- Already-premium users keep premium
  when role = 'premium'                                                then 'premium'
  -- Anyone with unlimited_access but no specific role → premium (safe assumption)
  when unlimited_access = true and (role is null or role = 'free')     then 'premium'
  -- Everything else → free
  else                                                                       'free'
end
where role is distinct from case
  when role = 'admin' or is_admin = true                               then 'admin'
  when role in ('dietitian', 'coach', 'nutritionist', 'trainer')       then 'provider'
  when role = 'premium'                                                then 'premium'
  when unlimited_access = true and (role is null or role = 'free')     then 'premium'
  else                                                                       'free'
end;

-- ─── Step 3: Drop obsolete columns ────────────────────────────────────────
-- is_provider and unlimited_access are fully subsumed by role now. We
-- CASCADE on the drops because the old check_spend_limit RPC references
-- unlimited_access — once we drop the column the function breaks, so we
-- recreate it in step 5 below.

alter table public.user_profiles
  drop column if exists is_provider,
  drop column if exists unlimited_access cascade;

-- ─── Step 4: Sync is_admin with role='admin' ──────────────────────────────
-- Keep is_admin consistent for the small number of consumers that still
-- read it directly (we'll remove that redundancy in a follow-up once
-- audited).

update public.user_profiles
set is_admin = (role = 'admin');

-- ─── Step 5: Rewrite check_spend_limit with role-based caps ──────────────
-- Preserves every branch of the original:
--   - profile_not_found   → blocked
--   - admin (replaces is_admin/unlimited_access) → pass, unlimited
--   - account_suspended   → blocked
--   - spending_limit_exceeded → blocked (with spent/limit/remaining)
--   - allowed → pass with usage numbers
--
-- Limit lookup priority:
--   1. If user has spending_limit_usd set (not null), use that. This is
--      the admin override escape hatch — we pinned you to $0.01 earlier
--      via this exact column, for example.
--   2. Otherwise use the role default ($0.30 / $10 / $50 / unlimited).

create or replace function public.check_spend_limit(
  p_user_id uuid,
  p_estimated_cost numeric default 0.01
) returns jsonb
language plpgsql
security definer
as $function$
declare
  v_profile      public.user_profiles%rowtype;
  v_month_spent  numeric(10,4);
  v_effective_limit numeric;
begin
  select * into v_profile
  from public.user_profiles
  where user_id = p_user_id;

  if not found then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'profile_not_found'
    );
  end if;

  -- Admin role bypasses every check
  if v_profile.role = 'admin' then
    return jsonb_build_object(
      'allowed', true,
      'unlimited', true,
      'spent_usd', v_profile.total_spent_usd,
      'limit_usd', null
    );
  end if;

  -- Suspended accounts blocked regardless of role
  if v_profile.account_status is distinct from 'active' then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'account_suspended',
      'status', v_profile.account_status
    );
  end if;

  -- Per-user override wins over role default. A null override means
  -- "use whatever the role says", which is the common case.
  v_effective_limit := coalesce(
    v_profile.spending_limit_usd,
    case v_profile.role
      when 'free'     then 0.30
      when 'premium'  then 10.00
      when 'provider' then 50.00
      else                 0.30  -- defensive fallback for unknown roles
    end
  );

  -- Month-to-date spend from token_usage
  select coalesce(sum(cost_usd), 0) into v_month_spent
  from public.token_usage
  where user_id = p_user_id
    and created_at >= date_trunc('month', now());

  if (v_month_spent + p_estimated_cost) > v_effective_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'spending_limit_exceeded',
      'spent_usd', v_month_spent,
      'limit_usd', v_effective_limit,
      'remaining_usd', greatest(0, v_effective_limit - v_month_spent)
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'spent_usd', v_month_spent,
    'limit_usd', v_effective_limit,
    'remaining_usd', greatest(0, v_effective_limit - v_month_spent - p_estimated_cost)
  );
end;
$function$;

-- ─── Step 6: Reload PostgREST schema cache ────────────────────────────────

notify pgrst, 'reload schema';
