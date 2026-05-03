-- Generic foods sourced from USDA FoodData Central. Read-only for users;
-- imported via scripts/import-usda-foods.js with the service role.
-- Lets the Quick Log search hit a known-good name before falling back to
-- an AI describe call (token savings on common foods like banana, avocado).
CREATE TABLE IF NOT EXISTS public.generic_foods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    aliases text[] NOT NULL DEFAULT '{}'::text[],
    serving_description text,
    serving_grams numeric,
    serving_oz numeric,
    kcal numeric NOT NULL,
    protein_g numeric NOT NULL,
    carbs_g numeric NOT NULL,
    fat_g numeric NOT NULL,
    fiber_g numeric,
    fdc_id text UNIQUE,
    source text NOT NULL DEFAULT 'usda_fdc',
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Trigram index on name for fast ilike + fuzzy match. The pg_trgm
-- extension is already enabled on this project (used by ingredient_synonyms).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS generic_foods_name_trgm
    ON public.generic_foods USING gin (name gin_trgm_ops);

-- GIN index on aliases for fast ANY/contains lookups when searching by alias.
CREATE INDEX IF NOT EXISTS generic_foods_aliases_gin
    ON public.generic_foods USING gin (aliases);

ALTER TABLE public.generic_foods ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated user can SELECT (the table is shared reference data).
DROP POLICY IF EXISTS generic_foods_select ON public.generic_foods;
CREATE POLICY generic_foods_select ON public.generic_foods
    FOR SELECT TO authenticated
    USING (true);

-- Writes are service-role only — the import script and any future curation
-- scripts run with the service key, which bypasses RLS regardless of policy.
-- We omit INSERT/UPDATE/DELETE policies so authenticated users get refused.

GRANT SELECT ON public.generic_foods TO authenticated;
