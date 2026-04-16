# MacroLens — AI Nutrition Tracker

AI-powered macro tracking with user auth, cross-device sync, and weekly meal planning.

## Stack

- **Frontend**: Vite + Vanilla JS
- **Backend**: Supabase (Postgres + Auth + Row-Level Security)
- **AI**: Anthropic Claude (vision, recipe analysis, web search)
- **Deploy**: Netlify

## Setup

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run `supabase/schema.sql`
3. Copy your **Project URL** and **anon key** from Settings → API
4. (Optional) Enable Google OAuth in Authentication → Providers

### 2. Local dev

```bash
npm install
cp .env.example .env.local
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

### 3. Netlify deploy

Add these environment variables in Netlify → Site → Environment variables:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Architecture

```
src/
  lib/
    supabase.js     # Supabase client singleton
    auth.js         # Login, signup, OAuth, session
    db.js           # All DB operations (goals, log, planner, token usage)
    ai.js           # Anthropic API calls with token tracking
  pages/
    auth.js         # Login/signup UI
    app.js          # Main app — dashboard, planner, history, goals, account
  main.js           # Entry point — auth gating
  style.css         # All styles
supabase/
  schema.sql        # Full DB schema with RLS policies
```

## Database schema

| Table | Purpose |
|-------|---------|
| `user_profiles` | Per-user settings, plan, token limits |
| `goals` | Daily macro targets |
| `meal_log` | Logged meals with macros |
| `meal_planner` | Weekly planned meals |
| `token_usage` | Per-request token tracking for billing |

## Roadmap

- [ ] Phase 2: Server-side API proxy (remove user API key requirement)
- [ ] Phase 2: Monthly token budgets enforced server-side
- [ ] Phase 3: Stripe billing for pro plans
- [ ] Phase 3: Native mobile app (Capacitor)
