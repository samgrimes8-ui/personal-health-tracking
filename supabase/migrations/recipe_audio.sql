-- ─────────────────────────────────────────────────────────────────────────
-- Recipe audio cache for paid voices (OpenAI TTS)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Caches synthesised MP3s per (recipe, step, servings, voice, version) so
-- the OpenAI bill is paid once per unique combo across all reads — by all
-- users, even after they re-open the recipe a hundred times.
--
-- Cache key components:
--   recipe_id            — which recipe
--   step_index           — which instruction step (0-based)
--   servings             — current target serving size; instruction text
--                          scales (scaleStepText regex-replaces "2 cups"
--                          → "4 cups" etc), so different servings produce
--                          different audio. numeric(6,2) handles 0.5/1.5/etc.
--   voice_id             — 'alloy' / 'nova' / 'shimmer' / etc. We may add
--                          ElevenLabs voices later, hence string not enum.
--   instructions_version — bumped on every recipes.update via the bump path
--                          in upsertRecipe. Old cache rows become unreachable
--                          after an edit; a nightly sweep deletes orphaned
--                          MP3s from storage.
--
-- Storage bucket: 'recipe-audio' (public read, server-side write only).
-- Public read is fine because the URLs are unguessable UUIDs and recipe
-- instructions aren't sensitive — they end up in public share pages anyway.
--
-- Safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. instructions_version on recipes
-- ─────────────────────────────────────────────────────────────────────────
-- Bumped on every recipe save. The save itself IS the cache invalidation —
-- atomic, concurrent-safe, no cleanup race. See TODO.md "Edit invalidation".

alter table public.recipes
  add column if not exists instructions_version integer not null default 1;

-- Trigger: bump instructions_version on substantive content changes.
-- Catching this in the DB rather than the client keeps every code path
-- consistent — saveRecipeInstructions, upsertRecipe, future SQL updates,
-- admin-panel edits all bump correctly without remembering to do it.
--
-- We deliberately exclude tag-only updates (per TODO.md: tags don't appear
-- in scaleStepText so cached audio stays valid). Same for share_token,
-- is_shared, og_cache, ai_notes, confidence, source_url, updated_at —
-- these don't change spoken content. Adding more columns to the "matters"
-- list is the safer direction; under-invalidation gives users stale audio
-- mid-cook, which is way worse than re-paying $0.033 occasionally.

create or replace function public.bump_recipe_instructions_version()
returns trigger
language plpgsql
as $function$
begin
  if (NEW.instructions is distinct from OLD.instructions)
     or (NEW.ingredients is distinct from OLD.ingredients)
     or (NEW.name is distinct from OLD.name)
     or (NEW.servings is distinct from OLD.servings)
     or (NEW.description is distinct from OLD.description)
  then
    NEW.instructions_version := coalesce(OLD.instructions_version, 0) + 1;
  end if;
  return NEW;
end;
$function$;

drop trigger if exists trg_bump_recipe_instructions_version on public.recipes;
create trigger trg_bump_recipe_instructions_version
  before update on public.recipes
  for each row
  execute function public.bump_recipe_instructions_version();

-- ─────────────────────────────────────────────────────────────────────────
-- 2. recipe_audio cache table
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.recipe_audio (
  id                    uuid primary key default gen_random_uuid(),
  recipe_id             uuid not null references public.recipes(id) on delete cascade,
  step_index            integer not null,
  servings              numeric(6,2) not null,
  voice_id              text not null,
  instructions_version  integer not null,
  mp3_url               text not null,
  storage_path          text not null,
  char_count            integer not null,
  created_at            timestamptz not null default now()
);

-- Cache lookup hot path: (recipe, step, servings, voice, version)
create unique index if not exists recipe_audio_cache_key_idx
  on public.recipe_audio(recipe_id, step_index, servings, voice_id, instructions_version);

-- Sweep-orphans path: rows where instructions_version is no longer current
create index if not exists recipe_audio_recipe_version_idx
  on public.recipe_audio(recipe_id, instructions_version);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. RLS — readable by anyone with the recipe (cache is shared across users)
-- ─────────────────────────────────────────────────────────────────────────
-- Reads are open: cache reuse across users is the entire point. Writes are
-- restricted to the service role (api/tts.js) — clients never insert directly.

alter table public.recipe_audio enable row level security;

drop policy if exists "recipe_audio_read_all" on public.recipe_audio;
create policy "recipe_audio_read_all"
  on public.recipe_audio
  for select
  using (true);

-- Server-only writes. service_role bypasses RLS, so we don't need an
-- INSERT policy for it; the absence of any INSERT/UPDATE/DELETE policy
-- blocks anon and authenticated users from writing through the REST API.

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Storage bucket for the actual MP3 blobs
-- ─────────────────────────────────────────────────────────────────────────
-- Created via the storage admin API rather than SQL because storage.buckets
-- inserts are role-restricted. If this fails (already exists) the do-block
-- swallows the error and continues.

do $$
begin
  insert into storage.buckets (id, name, public)
  values ('recipe-audio', 'recipe-audio', true)
  on conflict (id) do nothing;
exception when others then
  -- bucket already exists or insufficient privileges; that's fine
  null;
end $$;

notify pgrst, 'reload schema';
