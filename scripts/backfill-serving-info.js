#!/usr/bin/env node
/**
 * Backfill serving_description / serving_grams / serving_oz on:
 *   - food_items rows where serving_grams IS NULL
 *   - meal_log rows that are orphan free-text (no food_item_id, no
 *     recipe_id) AND missing serving info
 *
 * Idempotent — only touches rows where serving_grams IS NULL, so safe
 * to re-run after a failure or to mop up rows that landed NULL between
 * runs.
 *
 * Strategy:
 *   1. SQL pre-pass already covers food_items whose name matches a row
 *      in generic_foods (cheap, no AI). Run via the migration applied
 *      with this commit.
 *   2. This script handles the long tail — branded foods, restaurant
 *      items, multi-word descriptions — by calling the Anthropic API
 *      directly with the same analyzeFoodItem prompt the iOS / web
 *      describe path uses. Per-row cost: ~3¢ at current Sonnet pricing.
 *   3. After food_items are backfilled, a final SQL pass copies
 *      serving_* from food_items down onto any meal_log rows linked
 *      to them — one query, no per-row work.
 *
 * Usage:
 *   SUPABASE_URL=https://rwrcklqpvfvuvwatpbxh.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJhbGci... \
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   node scripts/backfill-serving-info.js
 *
 * Optional: --dry-run prints the AI's proposed values without writing.
 */
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const DRY_RUN = process.argv.includes('--dry-run')

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY required')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

// Same prompt as analyzeFoodItem in src/lib/ai.js, trimmed to just the
// serving fields we care about for backfill. Keeps the response small.
const PROMPT = (description) => `Nutrition facts for this single food item: "${description}"

If this is a specific branded product, look up its actual nutrition label values.
If it's a generic food, use standard USDA values for ONE natural serving.

Respond ONLY with a JSON object, no markdown:
{
  "serving_description": "plain-language single-serving unit with grams, e.g. '1 medium avocado, ~150g' or '1 slice of toast (~30g)' or '1 large egg (~50g)' or '1 cup cooked rice, ~195g'",
  "serving_grams": number,
  "serving_oz": number
}

Rules:
- Pick the SMALLEST REASONABLE serving someone would consume in one sitting (1 tbsp for fats / oils / condiments, 1 slice for bread, 1 oz for cheese / nuts, 4 oz for cooked meat, the natural piece for produce). NEVER wholesale package size.
- serving_description MUST always include an approximate gram weight.
- serving_grams is a NUMBER. serving_oz = serving_grams / 28.3495, one decimal.`

async function describeOne(name) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: PROMPT(name) }],
  })
  const text = msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
  // Tolerate ```json fences and stray prose around the JSON.
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`No JSON in response: ${text.slice(0, 200)}`)
  const parsed = JSON.parse(match[0])
  if (!parsed.serving_description || !Number.isFinite(parsed.serving_grams)) {
    throw new Error(`Invalid response: ${JSON.stringify(parsed)}`)
  }
  return {
    serving_description: parsed.serving_description,
    serving_grams: parsed.serving_grams,
    serving_oz: Number.isFinite(parsed.serving_oz)
      ? parsed.serving_oz
      : Math.round((parsed.serving_grams / 28.3495) * 10) / 10,
  }
}

async function backfillFoodItems() {
  const { data: rows, error } = await supabase
    .from('food_items')
    .select('id, name, brand')
    .is('serving_grams', null)
  if (error) throw error
  console.log(`food_items: ${rows.length} rows missing serving_grams`)

  let ok = 0, fail = 0
  for (const row of rows) {
    const query = row.brand ? `${row.brand} ${row.name}` : row.name
    try {
      const result = await describeOne(query)
      console.log(`  ${row.name} → ${result.serving_description}`)
      if (DRY_RUN) { ok++; continue }
      const { error: updErr } = await supabase
        .from('food_items')
        .update({
          serving_description: result.serving_description,
          serving_grams: result.serving_grams,
          serving_oz: result.serving_oz,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
      if (updErr) throw updErr
      ok++
    } catch (e) {
      console.error(`  ✗ ${row.name}: ${e.message}`)
      fail++
    }
  }
  console.log(`food_items: ${ok} updated, ${fail} failed`)
}

async function backfillMealLogOrphans() {
  // Free-text meal_log rows — no food_item_id, no recipe_id, missing
  // serving info. food_item_id-linked rows get covered by the SQL
  // copy-down at the end.
  const { data: rows, error } = await supabase
    .from('meal_log')
    .select('id, name')
    .is('food_item_id', null)
    .is('recipe_id', null)
    .is('serving_grams', null)
  if (error) throw error
  console.log(`meal_log orphans: ${rows.length} rows missing serving info`)

  let ok = 0, fail = 0
  for (const row of rows) {
    if (!row.name) {
      console.log(`  ✗ ${row.id}: no name to query`)
      fail++
      continue
    }
    try {
      const result = await describeOne(row.name)
      console.log(`  ${row.name} → ${result.serving_description}`)
      if (DRY_RUN) { ok++; continue }
      const { error: updErr } = await supabase
        .from('meal_log')
        .update({
          serving_description: result.serving_description,
          serving_grams: result.serving_grams,
          serving_oz: result.serving_oz,
        })
        .eq('id', row.id)
      if (updErr) throw updErr
      ok++
    } catch (e) {
      console.error(`  ✗ ${row.name}: ${e.message}`)
      fail++
    }
  }
  console.log(`meal_log orphans: ${ok} updated, ${fail} failed`)
}

async function copyDownToLinkedMealLog() {
  // After food_items got backfilled, propagate the values down to any
  // meal_log row that links to a now-populated food_item.
  if (DRY_RUN) {
    console.log('meal_log copy-down: skipped in dry-run')
    return
  }
  const { error } = await supabase.rpc('copy_serving_info_to_meal_log').catch(() => ({ error: null }))
  if (error) throw error
  // No RPC defined → fall back to a plain UPDATE via REST
  const { data: linked } = await supabase
    .from('meal_log')
    .select('id, food_item_id')
    .is('serving_grams', null)
    .not('food_item_id', 'is', null)
  if (!linked?.length) {
    console.log('meal_log copy-down: nothing to update')
    return
  }
  const ids = [...new Set(linked.map(r => r.food_item_id).filter(Boolean))]
  const { data: foods } = await supabase
    .from('food_items')
    .select('id, serving_description, serving_grams, serving_oz')
    .in('id', ids)
  const byId = new Map((foods ?? []).map(f => [f.id, f]))
  let ok = 0
  for (const row of linked) {
    const f = byId.get(row.food_item_id)
    if (!f?.serving_grams) continue
    await supabase
      .from('meal_log')
      .update({
        serving_description: f.serving_description,
        serving_grams: f.serving_grams,
        serving_oz: f.serving_oz,
      })
      .eq('id', row.id)
    ok++
  }
  console.log(`meal_log copy-down: ${ok} rows updated from linked food_items`)
}

async function fallbackUnknownTags() {
  // Any meal_log row STILL missing both fields after AI backfill +
  // copy-down gets the honest-fallback marker so the UI never renders
  // a blank serving cell. Tap-to-set affordance handles the upgrade.
  if (DRY_RUN) return
  const { error, count } = await supabase
    .from('meal_log')
    .update({ serving_description: '1 serving (size unknown)' }, { count: 'exact' })
    .is('serving_description', null)
  if (error) throw error
  console.log(`meal_log fallback: ${count ?? 0} rows tagged as size-unknown`)
}

async function main() {
  console.log(DRY_RUN ? '[DRY RUN]' : '[LIVE]')
  await backfillFoodItems()
  await backfillMealLogOrphans()
  await copyDownToLinkedMealLog()
  await fallbackUnknownTags()
  console.log('Done.')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
