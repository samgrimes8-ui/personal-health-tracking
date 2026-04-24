-- Per-user preset-hiding for recipe tags.
--
-- RECIPE_TAG_PRESETS in the app is a hardcoded 8-item list (Breakfast,
-- Lunch, Dinner, Snack, Chicken, Beef, Fish, Vegetarian). Some users
-- don't eat meat, others don't snack, others don't distinguish meal
-- types — they want to delete presets they'll never use.
--
-- Adds a hidden_tag_presets text[] column. When a user "deletes" a
-- preset from Manage Tags, we append the preset name (lowercased) to
-- this array. The Manage Tags modal and the Tag-picker both filter
-- the preset list by this column before rendering.
--
-- Existing tags on recipes are unaffected — if you had a recipe tagged
-- "Vegetarian" and you hide the "Vegetarian" preset, the tag stays on
-- the recipe. You just don't see "Vegetarian" as a suggestion anymore.
--
-- Safe to re-run (guarded with IF NOT EXISTS).

alter table public.user_profiles
  add column if not exists hidden_tag_presets text[] default '{}'::text[];

-- No schema reload needed — PostgREST auto-detects new columns on next
-- request. But nudge it anyway so the change shows up immediately in
-- any already-active session.
notify pgrst, 'reload schema';
