-- Lower free-tier default cap from $0.30 to $0.10 (= 100 AI Bucks at 1000x)
--
-- User-facing reasoning: keep free tier accessible enough to experience
-- the AI features (~33 actions is roughly 1 week of heavy logging), but
-- tight enough that engaged users hit the upgrade prompt within days.
-- With 300 AI Bucks users could log 3-5 meals/day for a month without
-- ever hitting the wall, which meant the upgrade prompt never appeared.
--
-- Only change: the case-when branch in check_spend_limit. Every other
-- piece of pricing logic (role defaults, overrides, admin bypass, etc)
-- is unchanged.
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
  v_override_active boolean;
begin
  select * into v_profile
  from public.user_profiles
  where user_id = p_user_id;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'profile_not_found');
  end if;

  if v_profile.role = 'admin' then
    return jsonb_build_object('allowed', true, 'unlimited', true,
      'spent_usd', v_profile.total_spent_usd, 'limit_usd', null);
  end if;

  if v_profile.account_status is distinct from 'active' then
    return jsonb_build_object('allowed', false, 'reason', 'account_suspended',
      'status', v_profile.account_status);
  end if;

  v_override_active := v_profile.spending_limit_usd is not null
    and (v_profile.spending_limit_expires_at is null
         or v_profile.spending_limit_expires_at > now());

  v_effective_limit := case
    when v_override_active then v_profile.spending_limit_usd
    else case v_profile.role
      when 'free'     then 0.10
      when 'premium'  then 10.00
      when 'provider' then 50.00
      else                 0.10
    end
  end;

  select coalesce(sum(cost_usd), 0) into v_month_spent
  from public.token_usage
  where user_id = p_user_id
    and created_at >= date_trunc('month', now());

  if (v_month_spent + p_estimated_cost) > v_effective_limit then
    return jsonb_build_object(
      'allowed', false, 'reason', 'spending_limit_exceeded',
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

notify pgrst, 'reload schema';
