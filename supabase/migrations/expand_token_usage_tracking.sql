-- Expand token_usage tracking so we can answer "why did THIS call cost so much?"
--
-- Current state:
--   - token_usage stores: input_tokens, output_tokens, tokens_used, cost_usd,
--     model, feature (coarse bucket), created_at
--   - cost computed via public.calculate_request_cost(model, in, out)
--   - record_usage() also updates user_profiles.total_spent_usd for spend caps
--
-- Gap: `feature` is one of 5 broad buckets ('recipe', 'photo', 'search',
-- 'planner', 'food'). Can't tell which SPECIFIC operation spiked, whether
-- it used web_search, how long it took, or whether the input was image vs
-- text. Adding those four fields gives us the "why" data.
--
-- This migration is purely additive:
--   - New columns are nullable (older rows stay valid)
--   - New RPC params have defaults (older callers still work unchanged)
--   - calculate_request_cost, user_profiles.total_spent_usd tracking, and
--     the jsonb return shape are all preserved as-is
--
-- Safe to re-run.

alter table public.token_usage
  add column if not exists action text,
  add column if not exists input_type text,
  add column if not exists tools_used text[],
  add column if not exists duration_ms integer;

-- Index for "which actions are most expensive" queries. Partial because
-- scanning rows with null action (pre-instrumentation) is never useful.
create index if not exists token_usage_action_idx
  on public.token_usage(action, created_at desc)
  where action is not null;

-- Extend record_usage() with 4 new optional parameters. Signature stays
-- backwards-compatible — existing /api/analyze.js calls that pass only
-- the original 5 args keep working and just leave the new columns null.
--
-- Everything else preserved:
--   - Uses public.calculate_request_cost (don't duplicate pricing logic)
--   - Updates user_profiles.total_spent_usd (keeps spend caps working)
--   - Returns jsonb (matches whatever callers expect)
create or replace function public.record_usage(
  p_user_id uuid,
  p_model text,
  p_feature text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_action text default null,
  p_input_type text default null,
  p_tools_used text[] default null,
  p_duration_ms integer default null
) returns jsonb
language plpgsql
security definer
as $function$
declare
  v_cost numeric(10,6);
begin
  v_cost := public.calculate_request_cost(p_model, p_input_tokens, p_output_tokens);

  insert into public.token_usage (
    user_id, model, feature,
    tokens_used, input_tokens, output_tokens, cost_usd,
    action, input_type, tools_used, duration_ms
  ) values (
    p_user_id, p_model, p_feature,
    p_input_tokens + p_output_tokens,
    p_input_tokens, p_output_tokens, v_cost,
    p_action, p_input_type, p_tools_used, p_duration_ms
  );

  update public.user_profiles
     set total_spent_usd = total_spent_usd + v_cost,
         updated_at = now()
   where user_id = p_user_id;

  return jsonb_build_object(
    'cost_usd', v_cost,
    'input_tokens', p_input_tokens,
    'output_tokens', p_output_tokens
  );
end;
$function$;

-- Reload PostgREST schema cache so the new signature is visible to the
-- RPC proxy in our serverless functions (otherwise /api/analyze.js will
-- keep seeing the old 5-arg signature for a few minutes).
notify pgrst, 'reload schema';
