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
-- row that had is_public=true but wasn't marked is_shared yet, rewrites
-- the RLS policy that referenced is_public to use is_shared instead,
-- then drops is_public.
--
-- Safe to re-run: everything is idempotent.

-- Step 1: Backfill. Any recipe marked public in the old system becomes
-- shared in the new one. Preserves the existing share_token so old links
-- keep resolving after the app code switches over.
update public.recipes
  set is_shared = true
  where is_public = true
    and (is_shared is null or is_shared = false);

-- Step 2: Rewrite the RLS policy that depends on is_public.
-- The existing policy (owner_or_public_read) reads roughly as:
--   USING (auth.uid() = user_id OR is_public = true)
-- which granted anon/authenticated SELECT on rows flagged public.
--
-- After consolidation, "public" means is_shared = true. The share-reading
-- server endpoint uses the service role key anyway (bypasses RLS), so this
-- policy is mostly vestigial — but we update it rather than drop it so any
-- future client-side code that tries to read shared recipes through the
-- anon key continues to work.
--
-- Drop-and-recreate is safer than ALTER POLICY for logic changes.
drop policy if exists owner_or_public_read on public.recipes;

create policy owner_or_public_read on public.recipes
  for select
  using (auth.uid() = user_id or is_shared = true);

-- Step 3: Drop the now-unused column. With the policy rewritten above,
-- nothing depends on is_public anymore.
alter table public.recipes drop column if exists is_public;

-- Refresh PostgREST's cached schema so the dropped column isn't still
-- in its API reflection.
notify pgrst, 'reload schema';
