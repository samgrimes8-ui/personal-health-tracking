-- Personal meal plan shares — distinct from provider_broadcasts.
--
-- The two concepts are intentionally separate:
--   provider_broadcasts → public/published, follower-driven, provider branding
--   meal_plan_shares    → private link to a specific person, no public listing
--
-- Schema mirrors the broadcast model in spirit (snapshot at share time so
-- the recipient sees stable content even if the owner edits later) but
-- captures recipe data inline in plan_data so the share page is self-
-- contained and doesn't need a secondary recipe-fetch endpoint.
--
-- Access control: anyone holding the token can read (the token IS the
-- access control, same way recipes.share_token works). Only the owner
-- can write or revoke.

create table if not exists public.meal_plan_shares (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  share_token text not null unique,
  week_start date not null,           -- Sunday of the snapshotted week
  label text,                          -- optional human-readable name
  plan_data jsonb not null,           -- array of { day_of_week, meal_type, meal_name,
                                       --   planned_servings, is_leftover, recipe_id, recipe_snapshot {...} }
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meal_plan_shares_owner_idx
  on public.meal_plan_shares(owner_user_id) where is_active;

create index if not exists meal_plan_shares_token_idx
  on public.meal_plan_shares(share_token) where is_active;

alter table public.meal_plan_shares enable row level security;

-- Public read by token. Token-as-access-control mirrors recipes share flow.
drop policy if exists meal_plan_shares_public_read on public.meal_plan_shares;
create policy meal_plan_shares_public_read on public.meal_plan_shares
  for select using (is_active = true);

-- Owner-only write/revoke.
drop policy if exists meal_plan_shares_owner_insert on public.meal_plan_shares;
create policy meal_plan_shares_owner_insert on public.meal_plan_shares
  for insert with check (auth.uid() = owner_user_id);

drop policy if exists meal_plan_shares_owner_update on public.meal_plan_shares;
create policy meal_plan_shares_owner_update on public.meal_plan_shares
  for update using (auth.uid() = owner_user_id) with check (auth.uid() = owner_user_id);

drop policy if exists meal_plan_shares_owner_delete on public.meal_plan_shares;
create policy meal_plan_shares_owner_delete on public.meal_plan_shares
  for delete using (auth.uid() = owner_user_id);

-- Track shared-plan provenance on planner rows so the recipient can later
-- click "Save recipe" on a row that wasn't auto-imported. Both columns are
-- nullable; only set when the row was created by a share copy AND the
-- recipient opted not to save the recipe at copy time.
alter table public.meal_planner
  add column if not exists from_share_token text,
  add column if not exists from_share_index int;

notify pgrst, 'reload schema';
