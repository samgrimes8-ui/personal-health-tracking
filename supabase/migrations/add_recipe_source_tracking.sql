-- Add columns for tracking a recipe's provenance when imported from a broadcast.
-- Run this in the Supabase SQL editor.

alter table public.recipes
  add column if not exists source_recipe_id uuid references public.recipes(id) on delete set null,
  add column if not exists source_updated_at timestamptz,
  add column if not exists update_history jsonb default '[]'::jsonb;

-- Index for fast dedupe lookups during broadcast import
create index if not exists recipes_user_source_idx
  on public.recipes(user_id, source_recipe_id)
  where source_recipe_id is not null;

comment on column public.recipes.source_recipe_id is
  'If this recipe was imported from a provider broadcast, this points to the original recipe. NULL for user-created recipes.';

comment on column public.recipes.source_updated_at is
  'The updated_at of the source recipe when we last synced. Used to detect when a refresh is available.';

comment on column public.recipes.update_history is
  'JSON array of {ts, changes[]} entries recording auto-sync updates from the source recipe, so the user can see what changed and when.';
