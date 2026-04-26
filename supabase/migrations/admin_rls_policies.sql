-- Add admin RLS policies on user_profiles.
--
-- Discovered while debugging: the suspend button on the Admin Panel
-- silently no-op'd. Same with role changes and spend-cap overrides.
-- Cause: the existing policies on user_profiles only let users
-- read/update their OWN row (auth.uid() = user_id). Admins were
-- subject to the same restriction, so their UPDATEs got filtered
-- to 0 rows by RLS — no error, but no rows changed either.
--
-- Existing policies (kept):
--   users_insert_own_profile     INSERT WITH CHECK (auth.uid() = user_id)
--   users_select_own_profile     SELECT USING     (auth.uid() = user_id)
--   users_update_own_profile     UPDATE USING     (auth.uid() = user_id)
--   providers_readable_by_all    SELECT USING     (role IN ('provider','admin'))
--
-- New (this migration):
--   admins_select_any_profile    SELECT USING     (admin check)
--   admins_update_any_profile    UPDATE USING + WITH CHECK (admin check)
--
-- The SELECT policy is also necessary — without it, the Admin Panel
-- could only see provider+admin profiles (via providers_readable_by_all)
-- and missed every free/premium user. With it, admins see everyone.

-- Helper: returns true if the calling auth user has admin role.
-- SECURITY DEFINER bypasses RLS during the lookup — required to avoid
-- infinite recursion (the policies on user_profiles would otherwise
-- gate this function's own SELECT against the table).
create or replace function public.is_current_user_admin()
returns boolean
language sql
security definer
stable
as $$
  select coalesce(
    (select role = 'admin' or is_admin = true
       from public.user_profiles
      where user_id = auth.uid()),
    false
  );
$$;

-- Drop old admin policies if they exist (safe re-run support)
drop policy if exists admins_select_any_profile on public.user_profiles;
drop policy if exists admins_update_any_profile on public.user_profiles;

-- Admins can read every profile (admin panel needs this for free/premium users)
create policy admins_select_any_profile
  on public.user_profiles
  for select
  using (public.is_current_user_admin());

-- Admins can update any profile (suspend, role change, override caps)
create policy admins_update_any_profile
  on public.user_profiles
  for update
  using (public.is_current_user_admin())
  with check (public.is_current_user_admin());

-- Reload schema cache so PostgREST picks up the new policies right away
notify pgrst, 'reload schema';
