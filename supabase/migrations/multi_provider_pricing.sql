-- ─────────────────────────────────────────────────────────────────────────
-- Multi-provider pricing + time-effective rates + snapshotting on usage
-- ─────────────────────────────────────────────────────────────────────────
--
-- This migration future-proofs the cost-tracking infra for:
--   1. Multiple AI providers (Anthropic, OpenAI, ElevenLabs, etc.)
--   2. Multiple billing models (per-token chat, per-character TTS, etc.)
--   3. Rate changes over time (Anthropic raises Sonnet someday — historical
--      cost_usd values stay accurate; new calls bill at the new rate)
--   4. Snapshot auditing — every token_usage row carries the rate it was
--      billed at, so the math is reproducible without joining anything
--
-- Strictly additive: existing analyze.js calls continue to work without any
-- code changes. New columns are nullable; new RPC params have defaults; old
-- function signature stays available as a wrapper.
--
-- Safe to re-run.
--
-- After running, refresh the schema cache via the NOTIFY at the bottom.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Extend model_pricing
-- ─────────────────────────────────────────────────────────────────────────
-- Existing schema: (id uuid, model text, input_cost_per_1m, output_cost_per_1m, updated_at)
--
-- New columns:
--   provider          — 'anthropic' / 'openai' / 'elevenlabs' / etc.
--                       Required. Backfill existing rows to 'anthropic'.
--   unit_type         — 'tokens' / 'characters' / 'images' / 'seconds_audio'
--                       Defaults to 'tokens' so existing chat-model rows
--                       are correct without manual update.
--   unit_cost_per_1m  — Per-unit cost for non-token billing (TTS, image gen).
--                       NULL for chat models (which use input/output rates).
--   effective_from    — When this rate started being valid. Required.
--                       Backfill existing rows to created_at or a sentinel
--                       far-past date.
--   effective_until   — When this rate stopped being valid. NULL = current.
--                       When pricing changes, insert a new row with the
--                       new rate AND update the old row's effective_until.

alter table public.model_pricing
  add column if not exists provider          text,
  add column if not exists unit_type         text default 'tokens',
  add column if not exists unit_cost_per_1m  numeric(10,6),
  add column if not exists effective_from    timestamptz,
  add column if not exists effective_until   timestamptz;

-- Backfill existing rows: all current rows are Anthropic chat models
-- using token-based pricing, effective from when they were created.
update public.model_pricing
   set provider = 'anthropic',
       unit_type = 'tokens',
       effective_from = coalesce(effective_from, updated_at, '2024-01-01'::timestamptz)
 where provider is null;

-- Now make provider + unit_type + effective_from NOT NULL
alter table public.model_pricing
  alter column provider set not null,
  alter column unit_type set not null,
  alter column effective_from set not null;

-- The original unique constraint was implicit on (model). With time-effective
-- pricing we need (provider, model, effective_from) — a model can have
-- multiple historical rate rows. Drop any old unique on model first.
do $$
begin
  -- Old code may not have had a UNIQUE constraint at all; just defensive
  if exists (
    select 1 from pg_constraint
    where conname = 'model_pricing_model_key'
       or conname = 'model_pricing_model_unique'
  ) then
    execute 'alter table public.model_pricing drop constraint if exists model_pricing_model_key';
    execute 'alter table public.model_pricing drop constraint if exists model_pricing_model_unique';
  end if;
end $$;

create unique index if not exists model_pricing_provider_model_effective_idx
  on public.model_pricing(provider, model, effective_from);

-- Index for the active-rate lookup pattern: WHERE provider=? AND model=?
-- AND effective_from <= ? AND (effective_until IS NULL OR effective_until > ?)
create index if not exists model_pricing_active_lookup_idx
  on public.model_pricing(provider, model, effective_from desc)
  where effective_until is null;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Seed/refresh pricing data
-- ─────────────────────────────────────────────────────────────────────────
-- Existing rows in production:
--   claude-haiku-4-5     0.80 / 4.00      ✓ correct
--   claude-opus-4-5     15.00 / 75.00     ✗ STALE — was cut to 5/25 in Nov 2025
--   claude-sonnet-4-5    3.00 / 15.00     ✓ correct
--
-- Strategy:
--   - For Opus 4.5 stale row: end its effective period (effective_until=now())
--     and insert a new row with corrected $5/$25 effective from today.
--     Past calls keep the rate they were billed at (stored in cost_usd
--     and now also in the new snapshot columns).
--   - Add new models that came out since the table was last updated:
--     claude-sonnet-4-6, claude-opus-4-6, claude-opus-4-7
--   - Add OpenAI TTS placeholders for the upcoming paid voice work.
--     Rates current as of April 2026 — bump effective_from / insert new
--     rows when prices actually change.

-- Mark stale Opus 4.5 row as historical (if not already)
update public.model_pricing
   set effective_until = now()
 where provider = 'anthropic'
   and model = 'claude-opus-4-5'
   and input_cost_per_1m = 15.000000  -- only the stale row, not corrected ones
   and effective_until is null;

-- Insert/upsert the corrected & new pricing rows. We use ON CONFLICT
-- (provider, model, effective_from) DO NOTHING so this migration is
-- idempotent — re-running won't create duplicates.
insert into public.model_pricing
  (provider, model, input_cost_per_1m, output_cost_per_1m, unit_cost_per_1m, unit_type, effective_from, updated_at)
values
  -- Anthropic: corrected Opus 4.5 rate
  ('anthropic', 'claude-opus-4-5',     5.000000, 25.000000, null, 'tokens', '2025-11-24'::timestamptz, now()),
  -- Anthropic: 4.6 family
  ('anthropic', 'claude-opus-4-6',     5.000000, 25.000000, null, 'tokens', '2026-02-01'::timestamptz, now()),
  ('anthropic', 'claude-sonnet-4-6',   3.000000, 15.000000, null, 'tokens', '2026-02-01'::timestamptz, now()),
  -- Anthropic: 4.7 family (released April 16, 2026)
  ('anthropic', 'claude-opus-4-7',     5.000000, 25.000000, null, 'tokens', '2026-04-16'::timestamptz, now()),
  -- OpenAI TTS — for the upcoming paid voice work. Per-character billing.
  -- $15 per 1M chars (tts-1) and $30 per 1M chars (tts-1-hd) as of April 2026.
  ('openai',    'tts-1',               null, null, 15.000000, 'characters', '2024-01-01'::timestamptz, now()),
  ('openai',    'tts-1-hd',            null, null, 30.000000, 'characters', '2024-01-01'::timestamptz, now())
on conflict (provider, model, effective_from) do nothing;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Extend token_usage
-- ─────────────────────────────────────────────────────────────────────────
-- New columns:
--   provider              — Identifies the API provider for the call
--   units_used            — Generic unit count (chars for TTS, images for
--                           img-gen, etc). Replaces input_tokens+output_tokens
--                           as the source of truth for non-chat billing.
--                           For chat calls, leave null (input_tokens +
--                           output_tokens = tokens_used continues to work).
--   unit_type             — Unit dimension: tokens / characters / images
--   input_rate_snapshot   — Rate (per 1M) used to compute the input portion
--   output_rate_snapshot  — Rate (per 1M) used to compute the output portion
--   unit_rate_snapshot    — Rate (per 1M) used for unit-based billing
--
-- Snapshotting rates makes every row self-auditable: cost_usd is exactly
-- (tokens × rate / 1M) without needing to know which pricing row was active.
-- This is critical for reconciling against vendor invoices.

alter table public.token_usage
  add column if not exists provider             text,
  add column if not exists units_used           integer,
  add column if not exists unit_type            text,
  add column if not exists input_rate_snapshot  numeric(10,6),
  add column if not exists output_rate_snapshot numeric(10,6),
  add column if not exists unit_rate_snapshot   numeric(10,6);

-- Backfill existing rows to provider='anthropic', unit_type='tokens'.
-- We can't backfill rate snapshots accurately (rates may have changed
-- since), but we can populate provider/unit_type so reporting queries
-- have consistent values across old and new rows.
update public.token_usage
   set provider = 'anthropic',
       unit_type = 'tokens'
 where provider is null;

-- Index for "show me TTS spend" / "show me Anthropic spend" reporting
create index if not exists token_usage_provider_idx
  on public.token_usage(provider, created_at desc)
  where provider is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Rewrite calculate_request_cost
-- ─────────────────────────────────────────────────────────────────────────
-- New signature accepts provider + units. Looks up the pricing row that
-- was effective at the given timestamp (defaults to now). Falls through
-- by branch on unit_type — token billing uses input/output rates;
-- everything else uses unit_cost_per_1m.
--
-- Returns a record so callers can grab cost AND the snapshot rates in a
-- single round trip — record_usage uses these to populate the snapshot
-- columns in token_usage.
--
-- Old (3-arg) signature is preserved as a wrapper below so any existing
-- callers (DB triggers, manual queries, etc) keep working.

create or replace function public.calculate_request_cost_v2(
  p_provider      text,
  p_model         text,
  p_input_tokens  integer default null,
  p_output_tokens integer default null,
  p_units_used    integer default null,
  p_at_time       timestamptz default now()
) returns table (
  cost_usd            numeric(10,6),
  input_rate_snapshot  numeric(10,6),
  output_rate_snapshot numeric(10,6),
  unit_rate_snapshot   numeric(10,6),
  unit_type            text
)
language plpgsql stable security definer
as $function$
declare
  v_pricing record;
begin
  -- Find the pricing row that was effective at p_at_time.
  -- (effective_from <= p_at_time AND (effective_until IS NULL OR effective_until > p_at_time))
  -- Pick the most recent one if multiple match (shouldn't happen with proper
  -- effective_until management, but defensive).
  select mp.input_cost_per_1m,
         mp.output_cost_per_1m,
         mp.unit_cost_per_1m,
         mp.unit_type
    into v_pricing
    from public.model_pricing mp
   where mp.provider = p_provider
     and mp.model = p_model
     and mp.effective_from <= p_at_time
     and (mp.effective_until is null or mp.effective_until > p_at_time)
   order by mp.effective_from desc
   limit 1;

  if not found then
    -- Unknown model. Defensive: return $0 and null rates so the gap is
    -- visible in the dashboard. Better than silently treating it as
    -- Sonnet (which the old function did — a footgun for non-Anthropic
    -- providers like TTS where the unit math is completely different).
    return query select 0.000000::numeric(10,6),
                        null::numeric(10,6),
                        null::numeric(10,6),
                        null::numeric(10,6),
                        null::text;
    return;
  end if;

  if v_pricing.unit_type = 'tokens' then
    return query select
      round(
        (coalesce(p_input_tokens,  0) * coalesce(v_pricing.input_cost_per_1m,  0) / 1000000.0) +
        (coalesce(p_output_tokens, 0) * coalesce(v_pricing.output_cost_per_1m, 0) / 1000000.0),
        6
      )::numeric(10,6),
      v_pricing.input_cost_per_1m,
      v_pricing.output_cost_per_1m,
      null::numeric(10,6),
      v_pricing.unit_type;
  else
    -- Per-unit billing (characters for TTS, images for img-gen, etc)
    return query select
      round(
        coalesce(p_units_used, 0) * coalesce(v_pricing.unit_cost_per_1m, 0) / 1000000.0,
        6
      )::numeric(10,6),
      null::numeric(10,6),
      null::numeric(10,6),
      v_pricing.unit_cost_per_1m,
      v_pricing.unit_type;
  end if;
end;
$function$;

-- Preserve the OLD 3-arg signature as a wrapper. Any code path or DB
-- trigger that called the old form keeps working — just routed through
-- v2 with provider='anthropic'. We can remove this wrapper later once
-- we're sure nothing else calls the old shape.
create or replace function public.calculate_request_cost(
  p_model         text,
  p_input_tokens  integer,
  p_output_tokens integer
) returns numeric
language plpgsql stable security definer
as $function$
declare
  v_result record;
begin
  select * into v_result
    from public.calculate_request_cost_v2(
      'anthropic'::text, p_model, p_input_tokens, p_output_tokens, null, now()
    );
  return v_result.cost_usd;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Extend record_usage RPC
-- ─────────────────────────────────────────────────────────────────────────
-- Add provider + units + unit_type params with defaults. Snapshot the
-- rates at write time into token_usage so historical rows are self-auditable.
--
-- Backward compat: existing analyze.js calls (5 required args + 4 optional
-- action/input_type/tools_used/duration_ms) continue to work — they default
-- provider to 'anthropic' and units_used to null.

create or replace function public.record_usage(
  p_user_id       uuid,
  p_model         text,
  p_feature       text,
  p_input_tokens  integer,
  p_output_tokens integer,
  p_action        text default null,
  p_input_type    text default null,
  p_tools_used    text[] default null,
  p_duration_ms   integer default null,
  p_provider      text default 'anthropic',
  p_units_used    integer default null,
  p_unit_type     text default null
) returns jsonb
language plpgsql
security definer
as $function$
declare
  v_pricing record;
  v_call_time timestamptz := now();
begin
  -- Look up the active rate AND compute cost in one call.
  select * into v_pricing
    from public.calculate_request_cost_v2(
      p_provider, p_model, p_input_tokens, p_output_tokens, p_units_used, v_call_time
    );

  insert into public.token_usage (
    user_id, model, provider, feature,
    tokens_used, input_tokens, output_tokens,
    units_used, unit_type,
    input_rate_snapshot, output_rate_snapshot, unit_rate_snapshot,
    cost_usd,
    action, input_type, tools_used, duration_ms,
    created_at
  ) values (
    p_user_id, p_model, p_provider, p_feature,
    coalesce(p_input_tokens, 0) + coalesce(p_output_tokens, 0),
    p_input_tokens, p_output_tokens,
    p_units_used, coalesce(p_unit_type, v_pricing.unit_type),
    v_pricing.input_rate_snapshot, v_pricing.output_rate_snapshot, v_pricing.unit_rate_snapshot,
    v_pricing.cost_usd,
    p_action, p_input_type, p_tools_used, p_duration_ms,
    v_call_time
  );

  -- Spend cap continues to work unchanged — total_spent_usd accumulates
  -- across all providers/unit types using the unified cost_usd field.
  update public.user_profiles
     set total_spent_usd = total_spent_usd + v_pricing.cost_usd,
         updated_at = now()
   where user_id = p_user_id;

  return jsonb_build_object(
    'cost_usd', v_pricing.cost_usd,
    'input_tokens', p_input_tokens,
    'output_tokens', p_output_tokens,
    'units_used', p_units_used,
    'provider', p_provider,
    'unit_type', coalesce(p_unit_type, v_pricing.unit_type)
  );
end;
$function$;

-- Tell PostgREST to pick up the new function signature so /api/analyze.js
-- can call it with the new optional args (p_provider, p_units_used,
-- p_unit_type) once we wire them up. Without this, the new signature
-- might not be visible for a few minutes.
notify pgrst, 'reload schema';
