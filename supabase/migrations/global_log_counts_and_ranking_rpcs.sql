-- Composite Quick Log ranking: schema + trigger + backfill + RPCs.
-- Applied via mcp__supabase__apply_migration (3 separate migrations
-- collapsed here for source-control record-keeping).

-- 1) Columns + indexes ------------------------------------------------------

ALTER TABLE food_items
  ADD COLUMN IF NOT EXISTS global_log_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS global_log_distinct_users INT NOT NULL DEFAULT 0;

ALTER TABLE generic_foods
  ADD COLUMN IF NOT EXISTS global_log_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS global_log_distinct_users INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_foundation_food BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS food_items_global_log_count_idx
  ON food_items(global_log_count DESC);
CREATE INDEX IF NOT EXISTS generic_foods_global_log_count_idx
  ON generic_foods(global_log_count DESC);
CREATE INDEX IF NOT EXISTS meal_log_food_item_id_user_id_idx
  ON meal_log(food_item_id, user_id) WHERE food_item_id IS NOT NULL;

-- 2) Trigger ---------------------------------------------------------------
-- Maintains food_items.global_log_count + .global_log_distinct_users on
-- every meal_log insert/delete. SECURITY DEFINER so the increment can
-- write to a food_items row that doesn't belong to the inserting user.

CREATE OR REPLACE FUNCTION public._maintain_food_item_log_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.food_item_id IS NOT NULL THEN
      UPDATE food_items
        SET global_log_count = global_log_count + 1,
            global_log_distinct_users = (
              SELECT COUNT(DISTINCT user_id)
              FROM meal_log
              WHERE food_item_id = NEW.food_item_id
            )
      WHERE id = NEW.food_item_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.food_item_id IS NOT NULL THEN
      UPDATE food_items
        SET global_log_count = GREATEST(global_log_count - 1, 0),
            global_log_distinct_users = (
              SELECT COUNT(DISTINCT user_id)
              FROM meal_log
              WHERE food_item_id = OLD.food_item_id
            )
      WHERE id = OLD.food_item_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS meal_log_maintain_food_item_counts ON meal_log;
CREATE TRIGGER meal_log_maintain_food_item_counts
AFTER INSERT OR DELETE ON meal_log
FOR EACH ROW
EXECUTE FUNCTION public._maintain_food_item_log_counts();

-- 3) Backfill --------------------------------------------------------------
-- Idempotent — re-running just recomputes from current meal_log state.

UPDATE food_items fi
SET global_log_count = sub.cnt,
    global_log_distinct_users = sub.distinct_users
FROM (
  SELECT food_item_id, COUNT(*) AS cnt, COUNT(DISTINCT user_id) AS distinct_users
  FROM meal_log
  WHERE food_item_id IS NOT NULL
  GROUP BY food_item_id
) sub
WHERE fi.id = sub.food_item_id;

-- 4) Composite-ranking RPCs ------------------------------------------------
-- Score = exact-prefix(1000) + substring(100) + user_30d(*10) +
--         global_when_eligible(*1) + foundation(50, generic_foods only).
-- Tiebreaker: name ASC. SECURITY INVOKER so RLS still gates per-user
-- visibility; food_items filters by auth.uid() inside.

CREATE OR REPLACE FUNCTION public.search_food_items_ranked(p_query TEXT, p_limit INT DEFAULT 10)
RETURNS SETOF public.food_items
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH q AS (
    SELECT LOWER(BTRIM(COALESCE(p_query, ''))) AS qq
  )
  SELECT fi.*
  FROM food_items fi, q
  WHERE fi.user_id = auth.uid()
    AND q.qq <> ''
    AND (
      LOWER(fi.name) LIKE '%' || q.qq || '%'
      OR LOWER(COALESCE(fi.brand, '')) LIKE '%' || q.qq || '%'
    )
  ORDER BY (
    CASE WHEN LOWER(fi.name) LIKE q.qq || '%' THEN 1000 ELSE 0 END
    + CASE WHEN LOWER(fi.name) LIKE '%' || q.qq || '%' THEN 100 ELSE 0 END
    + COALESCE((
        SELECT COUNT(*)
        FROM meal_log ml
        WHERE ml.user_id = auth.uid()
          AND ml.food_item_id = fi.id
          AND ml.logged_at > NOW() - INTERVAL '30 days'
      ), 0) * 10
    + CASE WHEN fi.global_log_distinct_users >= 5 THEN fi.global_log_count ELSE 0 END
  ) DESC,
  fi.name ASC
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION public.search_generic_foods_ranked(p_query TEXT, p_limit INT DEFAULT 8)
RETURNS SETOF public.generic_foods
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH q AS (
    SELECT LOWER(BTRIM(COALESCE(p_query, ''))) AS qq
  )
  SELECT gf.*
  FROM generic_foods gf, q
  WHERE q.qq <> ''
    AND (
      LOWER(gf.name) LIKE '%' || q.qq || '%'
      OR q.qq = ANY(gf.aliases)
    )
  ORDER BY (
    CASE WHEN LOWER(gf.name) LIKE q.qq || '%' THEN 1000 ELSE 0 END
    + CASE WHEN LOWER(gf.name) LIKE '%' || q.qq || '%' THEN 100 ELSE 0 END
    + CASE WHEN gf.global_log_distinct_users >= 5 THEN gf.global_log_count ELSE 0 END
    + CASE WHEN gf.is_foundation_food THEN 50 ELSE 0 END
  ) DESC,
  gf.name ASC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.search_food_items_ranked(TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_generic_foods_ranked(TEXT, INT) TO authenticated, anon;
