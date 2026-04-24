-- Consolidate two parallel recipe-share flags into one.
--
-- Previously there were two booleans:
--   is_public  -- used by the older "?token=X" share modal
--   is_shared  -- used by the newer card-tile share button
--
-- Both set share_token on the same recipe, but two different endpoints
-- filtered by different columns. Net effect: whichever share UI was
-- used last "owned" whether the link worked.
--
-- This migration picks is_shared as the canonical column, backfills any
-- row that had is_public=true but wasn't marked is_shared yet, then
-- drops is_public.
--
-- Safe to re-run: everything is idempotent.

-- Backfill: any recipe marked public in the old system becomes shared
-- in the new one. Preserves the existing share_token so old links keep
-- resolving after the app code switches over.
update public.recipes
  set is_shared = true
  where is_public = true
    and (is_shared is null or is_shared = false);

-- Drop the old column. We no longer read or write it anywhere after the
-- accompanying app.js / db.js changes land. If you haven't deployed the
-- code yet, DO NOT RUN THIS migration until you do — otherwise the app's
-- old write paths will error.
alter table public.recipes drop column if exists is_public;

-- Refresh PostgREST's cached schema so the dropped column isn't still
-- in its API reflection.
notify pgrst, 'reload schema';
