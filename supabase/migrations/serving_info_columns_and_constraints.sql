-- Worker: serving-units (May 2-3, 2026)
--
-- Adds structured single-serving fields to food_items + meal_log so
-- generic foods like "avocado" carry "1 medium avocado, ~150g" instead
-- of just a numeric calorie count, then back-fills what we can from
-- USDA generic_foods (name match) and adds a soft constraint so future
-- inserts can't land empty.
--
-- This file is the consolidated record of three migrations applied
-- live via MCP:
--   1. add_serving_description_columns
--   2. backfill_serving_info_from_generic_foods
--   3. soft_serving_info_constraint
--
-- Re-applying is idempotent (IF NOT EXISTS / NOT VALID guards).

-- ─── 1. Schema ────────────────────────────────────────────────────────
ALTER TABLE public.food_items
  ADD COLUMN IF NOT EXISTS serving_description text,
  ADD COLUMN IF NOT EXISTS serving_grams numeric,
  ADD COLUMN IF NOT EXISTS serving_oz numeric;

ALTER TABLE public.meal_log
  ADD COLUMN IF NOT EXISTS serving_description text,
  ADD COLUMN IF NOT EXISTS serving_grams numeric,
  ADD COLUMN IF NOT EXISTS serving_oz numeric;

-- ─── 2. Backfill from USDA generic_foods ──────────────────────────────
-- Cheap pre-pass — covers the food_items rows whose name matches a
-- known USDA row (case-insensitive on name OR alias). The long tail
-- (branded items, restaurant orders, multi-word descriptions) gets
-- handled by scripts/backfill-serving-info.js using the Anthropic API.
UPDATE public.food_items f
SET serving_description = g.serving_description,
    serving_grams       = g.serving_grams,
    serving_oz          = g.serving_oz,
    updated_at          = now()
FROM public.generic_foods g
WHERE f.serving_grams IS NULL
  AND (
        lower(trim(g.name)) = lower(trim(f.name))
     OR lower(trim(f.name)) = ANY(SELECT lower(trim(a)) FROM unnest(g.aliases) AS a)
  );

-- meal_log copy-down: any row linked to a now-populated food_item
-- inherits its serving fields so the renderer doesn't need a join.
UPDATE public.meal_log m
SET serving_description = f.serving_description,
    serving_grams       = f.serving_grams,
    serving_oz          = f.serving_oz
FROM public.food_items f
WHERE m.food_item_id = f.id
  AND m.serving_grams IS NULL
  AND f.serving_grams IS NOT NULL;

-- Recipe-linked meal_log rows render as "1 recipe serving" — recipes
-- don't carry weights so this is the honest fallback. Macro totals on
-- the row are still correct (planned_servings × per-serving recipe).
UPDATE public.meal_log m
SET serving_description = '1 recipe serving',
    serving_grams       = NULL,
    serving_oz          = NULL
WHERE m.recipe_id IS NOT NULL
  AND m.serving_description IS NULL;

-- ─── 3. Soft constraints (NOT VALID grandfathers legacy NULLs) ────────
-- Future inserts must carry at least one of the structured fields. The
-- backfill script + UI tap-to-set will eventually heal the legacy
-- NULLs; running VALIDATE CONSTRAINT once the table is clean turns
-- this into a hard guarantee without a second migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'food_items_serving_present'
      AND conrelid = 'public.food_items'::regclass
  ) THEN
    EXECUTE $constraint$
      ALTER TABLE public.food_items
        ADD CONSTRAINT food_items_serving_present
        CHECK (serving_description IS NOT NULL OR serving_grams IS NOT NULL)
        NOT VALID
    $constraint$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meal_log_serving_present'
      AND conrelid = 'public.meal_log'::regclass
  ) THEN
    EXECUTE $constraint$
      ALTER TABLE public.meal_log
        ADD CONSTRAINT meal_log_serving_present
        CHECK (
          serving_description IS NOT NULL
          OR serving_grams IS NOT NULL
          OR food_item_id IS NOT NULL
          OR recipe_id IS NOT NULL
        )
        NOT VALID
    $constraint$;
  END IF;
END
$$;
