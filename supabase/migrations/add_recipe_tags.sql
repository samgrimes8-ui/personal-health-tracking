-- Add tags array to recipes for grouping (Winter, Crockpot, etc.)
-- Run this in the Supabase SQL editor.

alter table public.recipes
  add column if not exists tags text[] default '{}'::text[];

-- GIN index so filtering by tag is fast even with lots of recipes
create index if not exists recipes_tags_idx
  on public.recipes using gin (tags);

comment on column public.recipes.tags is
  'Array of tag names (e.g. Winter, Crockpot, Meal Prep). Used for grouping recipes into browsable categories.';
