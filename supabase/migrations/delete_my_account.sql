-- Self-service account deletion. Required by App Store guideline 5.1.1(v),
-- and just good user hygiene regardless. SECURITY DEFINER is necessary
-- because regular authenticated users can't delete from auth.users; the
-- explicit auth.uid() check at the top is the access control — nobody
-- can delete anyone but themselves through this function.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $function$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  delete from public.recipe_audio
   where recipe_id in (select id from public.recipes where user_id = uid);

  delete from public.meal_plan_shares    where owner_user_id = uid;
  delete from public.recipe_shares       where user_id = uid;
  delete from public.meal_planner        where user_id = uid;
  delete from public.meal_log            where user_id = uid;
  delete from public.checkins            where user_id = uid;
  delete from public.recipes             where user_id = uid;
  delete from public.food_items          where user_id = uid;
  delete from public.body_metrics        where user_id = uid;
  delete from public.goals               where user_id = uid;
  delete from public.ingredient_synonyms where user_id = uid;
  delete from public.token_usage         where user_id = uid;
  delete from public.error_logs          where user_id = uid;
  delete from public.provider_broadcasts where provider_id = uid;
  delete from public.provider_follows    where follower_id = uid or provider_id = uid;
  delete from public.admin_allowlist     where user_id = uid;
  delete from public.user_profiles       where user_id = uid;

  delete from auth.users where id = uid;
end;
$function$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

notify pgrst, 'reload schema';
