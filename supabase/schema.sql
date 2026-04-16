-- ============================================================
-- MacroLens Supabase Schema
-- Run this in your Supabase SQL editor (project > SQL editor)
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ─── user_profiles ──────────────────────────────────────────
create table if not exists public.user_profiles (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references auth.users(id) on delete cascade not null unique,
  display_name  text,
  monthly_token_limit  integer default 100000,
  tokens_used_this_month integer default 0,
  token_reset_date  date default date_trunc('month', now())::date,
  plan          text default 'free',   -- 'free' | 'pro'
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table public.user_profiles enable row level security;

create policy "Users can view own profile"
  on public.user_profiles for select
  using (auth.uid() = user_id);

create policy "Users can update own profile"
  on public.user_profiles for update
  using (auth.uid() = user_id);

create policy "Users can insert own profile"
  on public.user_profiles for insert
  with check (auth.uid() = user_id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.user_profiles (user_id, display_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─── goals ──────────────────────────────────────────────────
create table if not exists public.goals (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references auth.users(id) on delete cascade not null unique,
  calories   integer default 2000,
  protein    integer default 150,
  carbs      integer default 200,
  fat        integer default 65,
  updated_at timestamptz default now()
);

alter table public.goals enable row level security;

create policy "Users manage own goals"
  on public.goals for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─── meal_log ────────────────────────────────────────────────
create table if not exists public.meal_log (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  name        text not null,
  calories    numeric(8,2) default 0,
  protein     numeric(8,2) default 0,
  carbs       numeric(8,2) default 0,
  fat         numeric(8,2) default 0,
  fiber       numeric(8,2) default 0,
  sugar       numeric(8,2) default 0,
  confidence  text default 'medium',
  notes       text default '',
  logged_at   timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table public.meal_log enable row level security;

create policy "Users manage own meal log"
  on public.meal_log for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index meal_log_user_date on public.meal_log(user_id, logged_at desc);

-- ─── meal_planner ────────────────────────────────────────────
create table if not exists public.meal_planner (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid references auth.users(id) on delete cascade not null,
  week_start_date  date not null,
  day_of_week      smallint not null check (day_of_week between 0 and 6),
  meal_name        text not null,
  calories         numeric(8,2) default 0,
  protein          numeric(8,2) default 0,
  carbs            numeric(8,2) default 0,
  fat              numeric(8,2) default 0,
  fiber            numeric(8,2) default 0,
  is_leftover      boolean default false,
  created_at       timestamptz default now()
);

alter table public.meal_planner enable row level security;

create policy "Users manage own planner"
  on public.meal_planner for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index meal_planner_user_week on public.meal_planner(user_id, week_start_date);

-- ─── token_usage ─────────────────────────────────────────────
create table if not exists public.token_usage (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  tokens_used integer not null,
  model       text not null,
  feature     text not null,  -- 'photo' | 'recipe' | 'search' | 'planner'
  created_at  timestamptz default now()
);

alter table public.token_usage enable row level security;

create policy "Users view own token usage"
  on public.token_usage for select
  using (auth.uid() = user_id);

create policy "Users insert own token usage"
  on public.token_usage for insert
  with check (auth.uid() = user_id);

create index token_usage_user_month on public.token_usage(user_id, created_at desc);

-- ─── Helper: monthly token rollup ────────────────────────────
-- A view for easy per-user monthly usage queries
create or replace view public.token_usage_monthly as
select
  user_id,
  date_trunc('month', created_at) as month,
  sum(tokens_used) as total_tokens,
  count(*) as request_count
from public.token_usage
group by user_id, date_trunc('month', created_at);
