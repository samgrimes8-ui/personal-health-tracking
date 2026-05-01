-- ─────────────────────────────────────────────────────────────────────────
-- HealthKit two-way sync columns
-- ─────────────────────────────────────────────────────────────────────────
--
-- Adds the dedup columns the iOS native app needs to keep weight rows in
-- sync with Apple Health (HealthKit). These live on `checkins`, not
-- `body_metrics`, because:
--
--   - body_metrics is a SINGLETON per user (UNIQUE on user_id) — it can't
--     hold a 12-month backfill of weigh-ins, only the current state.
--   - checkins is the multi-row weight history table the existing
--     LogWeightSheet flow already inserts into.
--
-- (The original brief said body_metrics; the schema doesn't allow it. We
-- went with checkins. See worker-healthkit reply for the deviation note.)
--
-- Columns:
--   healthkit_uuid TEXT NULL  — sample.uuid.uuidString returned by HK on
--                               write OR delivered by HKAnchoredObjectQuery
--                               on read. NULL for pre-HK rows + rows that
--                               weren't pushed (toggle off).
--   source         TEXT NOT NULL DEFAULT 'manual'
--                             — 'manual' for rows the user logged in the
--                               app (web or native), 'healthkit' for rows
--                               we pulled from HK. Used to decide whether
--                               to push back (we never push HK-sourced
--                               rows back to HK; that would dupe).
--
-- Unique partial index on healthkit_uuid (WHERE NOT NULL) is the primary
-- defense against pull-side duplicates: if a sample with the same UUID
-- comes back through HKAnchoredObjectQuery a second time (anchor reset,
-- reinstall, etc) the insert errors and we skip cleanly.
--
-- Safe to re-run.

alter table public.checkins
  add column if not exists healthkit_uuid text,
  add column if not exists source text not null default 'manual';

-- Constrain source values. Existing rows default to 'manual' so the
-- check passes against historical data.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'checkins_source_check'
  ) then
    alter table public.checkins
      add constraint checkins_source_check
      check (source in ('manual', 'healthkit'));
  end if;
end$$;

-- Unique partial index — only enforce uniqueness on rows that have a
-- healthkit_uuid. NULL rows (manual entries that weren't pushed to HK)
-- are unconstrained.
create unique index if not exists checkins_healthkit_uuid_unique
  on public.checkins(healthkit_uuid)
  where healthkit_uuid is not null;

-- Lookup index for the dedup check on the pull path
-- (SELECT id FROM checkins WHERE healthkit_uuid = $1) — partial since
-- only HK-sourced rows have a UUID.
create index if not exists checkins_healthkit_uuid_lookup
  on public.checkins(user_id, healthkit_uuid)
  where healthkit_uuid is not null;
