-- Per-user ingredient synonyms — persists the AI smart-merge results
-- across sessions.
--
-- Workflow: user taps '✨ Smart merge' on the grocery list. Claude
-- returns pairs like {from: "scallion greens", to: "green onions"}.
-- We store them in this table so the dedup applies on every future
-- grocery list load — without re-paying AI Bucks each time.
--
-- Names are lowercased for case-insensitive matching. Composite
-- primary key on (user_id, from_name) prevents the same user from
-- having two contradictory synonyms for the same ingredient.
--
-- RLS: each user can only read/write their own rows.
--
-- Safe to re-run.

create table if not exists public.ingredient_synonyms (
  user_id    uuid not null references auth.users(id) on delete cascade,
  from_name  text not null,
  to_name    text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, from_name)
);

-- Index on user_id for fast 'load all my synonyms' queries (the
-- primary key already covers this so it's mostly redundant, but
-- explicit is nice).
create index if not exists ingredient_synonyms_user_id_idx
  on public.ingredient_synonyms(user_id);

-- RLS — same pattern as the rest of the app's per-user tables.
alter table public.ingredient_synonyms enable row level security;

drop policy if exists synonyms_select_own on public.ingredient_synonyms;
drop policy if exists synonyms_insert_own on public.ingredient_synonyms;
drop policy if exists synonyms_delete_own on public.ingredient_synonyms;

create policy synonyms_select_own
  on public.ingredient_synonyms
  for select
  using (auth.uid() = user_id);

create policy synonyms_insert_own
  on public.ingredient_synonyms
  for insert
  with check (auth.uid() = user_id);

create policy synonyms_delete_own
  on public.ingredient_synonyms
  for delete
  using (auth.uid() = user_id);

notify pgrst, 'reload schema';
