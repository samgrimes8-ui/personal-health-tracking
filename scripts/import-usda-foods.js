#!/usr/bin/env node
/**
 * One-time (idempotent) importer for USDA FoodData Central →
 * public.generic_foods. Lets Quick Log search hit a known-good
 * generic food (banana, avocado, oats, …) before falling back to
 * an AI describe call.
 *
 * Usage:
 *   SUPABASE_URL=https://rwrcklqpvfvuvwatpbxh.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/import-usda-foods.js
 *
 * Sources (USDA, public domain):
 *   SR Legacy (~7800 generic foods)  — fdc.nal.usda.gov/fdc-datasets
 *   Foundation Foods (~400 high-quality generic foods)
 *
 * Skips rows missing any of kcal / protein / carbs / fat (those are
 * the four columns Quick Log relies on, so a partial row is useless).
 *
 * Idempotent — upserts on fdc_id, so re-running just refreshes existing
 * rows. Safe to run again after a USDA dataset bump.
 */
import { createClient } from '@supabase/supabase-js'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// USDA download URLs. Updated alongside FDC releases — bump these and
// re-run to refresh. Both files are public-domain JSON dumps.
const SOURCES = [
  {
    name: 'sr_legacy',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
    jsonRoot: 'SRLegacyFoods',
  },
  {
    name: 'foundation',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip',
    jsonRoot: 'FoundationFoods',
  },
]

// USDA nutrient-number → our column. Matches FDC's published nutrient list.
// `268` (kJ) is a fallback when `208` (kcal) is missing — divide by 4.184.
const N = {
  KCAL: '208',
  KJ: '268',
  PROTEIN: '203',
  CARBS: '205',
  FAT: '204',
  FIBER: '291',
}

// Average AI cost per food describe call (input + output tokens at Sonnet
// pricing, measured from token_usage.cost_usd over the planner-describe
// feature in production). Used purely for the savings estimate at the end.
const AVG_AI_DESCRIBE_COST_USD = 0.0025

// ─── Download + extract ────────────────────────────────────────────────
async function ensureDataset(src) {
  const cacheDir = join(tmpdir(), 'usda-fdc-cache')
  await mkdir(cacheDir, { recursive: true })
  const zipPath = join(cacheDir, `${src.name}.zip`)
  const extractDir = join(cacheDir, src.name)

  // Reuse cached zip if present (USDA datasets are immutable per release).
  let cached = false
  try { await stat(zipPath); cached = true } catch {}
  if (!cached) {
    process.stderr.write(`[${src.name}] downloading ${src.url}\n`)
    const res = await fetch(src.url)
    if (!res.ok) throw new Error(`fetch ${src.url}: ${res.status}`)
    await pipeline(res.body, createWriteStream(zipPath))
  } else {
    process.stderr.write(`[${src.name}] using cached zip\n`)
  }

  await mkdir(extractDir, { recursive: true })
  // `unzip` ships on macOS + most Linux; cheap shell-out beats pulling a
  // zip-parsing dep just for this one-shot script.
  await execFileP('unzip', ['-oq', zipPath, '-d', extractDir])

  const { readdir } = await import('node:fs/promises')
  const files = (await readdir(extractDir)).filter(f => f.endsWith('.json'))
  if (!files.length) throw new Error(`no JSON in ${extractDir}`)
  const jsonPath = join(extractDir, files[0])
  const blob = JSON.parse(await readFile(jsonPath, 'utf8'))
  return blob[src.jsonRoot] || []
}

// ─── Parse ─────────────────────────────────────────────────────────────
/** Pull macros (per 100g) from a foodNutrients array. Returns null if any
 * of the four core columns is missing — Quick Log won't render a row
 * without all four, so we skip these instead of inserting partial rows. */
function extractMacros(foodNutrients) {
  const by = new Map()
  for (const n of foodNutrients || []) {
    const num = n?.nutrient?.number
    if (num) by.set(num, n.amount)
  }
  let kcal = by.get(N.KCAL)
  if (kcal == null && by.get(N.KJ) != null) kcal = by.get(N.KJ) / 4.184
  const protein = by.get(N.PROTEIN)
  const carbs = by.get(N.CARBS)
  const fat = by.get(N.FAT)
  if ([kcal, protein, carbs, fat].some(v => v == null)) return null
  return {
    kcal: round(kcal, 1),
    protein: round(protein, 2),
    carbs: round(carbs, 2),
    fat: round(fat, 2),
    fiber: by.get(N.FIBER) != null ? round(by.get(N.FIBER), 2) : null,
  }
}

function round(n, places) {
  const m = 10 ** places
  return Math.round(n * m) / m
}

/** Pick the most useful default portion. Heuristic: prefer named household
 * units ("1 medium", "1 cup", "1 slice") over abstract ones ("RACC",
 * "undetermined"). Falls back to a literal 100g serving so every row has
 * something usable. */
function pickDefaultPortion(foodPortions) {
  if (!foodPortions || !foodPortions.length) {
    return { description: '100 g', grams: 100 }
  }
  const ranked = [...foodPortions].sort((a, b) => score(b) - score(a))
  const p = ranked[0]
  const grams = p.gramWeight || 100
  const unit = p.measureUnit?.name || ''
  const abbr = p.measureUnit?.abbreviation || ''
  const value = p.amount ?? p.value ?? 1
  const modifier = (p.modifier || '').trim()

  let desc
  if (unit && unit !== 'undetermined' && unit !== 'RACC') {
    const unitLabel = abbr && abbr !== 'undetermined' && abbr !== 'RACC' ? abbr : unit
    desc = `${value} ${unitLabel}${modifier ? ' ' + modifier : ''}, ~${round(grams, 1)}g`
  } else if (modifier) {
    desc = `${value} ${modifier}, ~${round(grams, 1)}g`
  } else {
    desc = `${round(grams, 1)} g`
  }
  return { description: desc.trim(), grams }

  function score(p) {
    const u = (p.measureUnit?.name || '').toLowerCase()
    const m = (p.modifier || '').toLowerCase()
    let s = 0
    if (['cup', 'tablespoon', 'teaspoon', 'slice', 'medium', 'large', 'small', 'piece', 'fruit', 'oz'].some(k => u.includes(k) || m.includes(k))) s += 10
    if (u === 'racc') s += 5
    if (u === 'undetermined' && !m) s -= 5
    if (p.gramWeight && p.gramWeight > 0) s += 1
    return s
  }
}

/** Build a forgiving alias list so a search for "banana" still hits a row
 * named "Bananas, raw". Strips USDA descriptors, splits on commas, adds
 * the singular form. Aliases are stored lowercase. */
function buildAliases(name) {
  const out = new Set()
  const lower = name.toLowerCase().trim()
  out.add(lower)
  // First clause before the first comma is usually the bare ingredient.
  const head = lower.split(',')[0].trim()
  if (head) out.add(head)
  // Strip common USDA descriptors so "apples, raw, with skin" → "apples".
  const stripped = lower
    .replace(/,\s*(raw|cooked|boiled|baked|roasted|fresh|frozen|dried|canned|with skin|without skin|ns as to .*?)\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/,\s*$/, '')
    .trim()
  if (stripped) out.add(stripped)
  // Naive depluralization for the head term — "bananas" → "banana".
  if (head.endsWith('ies')) out.add(head.slice(0, -3) + 'y')
  else if (head.endsWith('es') && head.length > 4) out.add(head.slice(0, -2))
  else if (head.endsWith('s') && head.length > 3) out.add(head.slice(0, -1))
  return [...out].filter(Boolean).slice(0, 8)
}

function projectFood(item) {
  if (!item || !item.description || !item.fdcId) return null
  const macros100 = extractMacros(item.foodNutrients)
  if (!macros100) return null
  const portion = pickDefaultPortion(item.foodPortions)
  // Macros stored per-serving (not per-100g) so Quick Log can drop them
  // straight into meal_log without a unit conversion at log time.
  const factor = portion.grams / 100
  const kcal = round(macros100.kcal * factor, 1)
  const protein = round(macros100.protein * factor, 2)
  const carbs = round(macros100.carbs * factor, 2)
  const fat = round(macros100.fat * factor, 2)
  const fiber = macros100.fiber != null ? round(macros100.fiber * factor, 2) : null
  // Last sanity check — a zero-everything row would clutter search results
  // without giving the user useful macros.
  if (kcal === 0 && protein === 0 && carbs === 0 && fat === 0) return null
  return {
    fdc_id: String(item.fdcId),
    name: item.description.trim(),
    aliases: buildAliases(item.description),
    serving_description: portion.description,
    serving_grams: round(portion.grams, 2),
    serving_oz: round(portion.grams / 28.3495, 2),
    kcal,
    protein_g: protein,
    carbs_g: carbs,
    fat_g: fat,
    fiber_g: fiber,
    source: 'usda_fdc',
  }
}

// ─── Upsert ────────────────────────────────────────────────────────────
async function upsertBatched(rows) {
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  }
  const client = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  })
  const BATCH = 500
  let written = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const { error } = await client
      .from('generic_foods')
      .upsert(slice, { onConflict: 'fdc_id' })
    if (error) throw new Error(`batch ${i}: ${error.message}`)
    written += slice.length
    process.stderr.write(`upserted ${written}/${rows.length}\r`)
  }
  process.stderr.write('\n')
  return written
}

// ─── main ──────────────────────────────────────────────────────────────
async function main() {
  const all = []
  for (const src of SOURCES) {
    const items = await ensureDataset(src)
    let kept = 0, skipped = 0
    for (const item of items) {
      const row = projectFood(item)
      if (row) { all.push(row); kept++ } else skipped++
    }
    process.stderr.write(`[${src.name}] kept ${kept}, skipped ${skipped} (missing core macros)\n`)
  }

  // Dedup on fdc_id within the batch — Foundation/SR Legacy don't overlap
  // by fdcId, but defending against future dataset additions costs nothing.
  const byId = new Map()
  for (const r of all) byId.set(r.fdc_id, r)
  const final = [...byId.values()]

  // Optional `--dry-run` mode: emit JSON to stdout without hitting the DB.
  // Useful for inspecting the projection before committing.
  if (process.argv.includes('--dry-run')) {
    await writeFile('/tmp/generic_foods_preview.json', JSON.stringify(final, null, 2))
    process.stderr.write(`dry-run: wrote ${final.length} rows to /tmp/generic_foods_preview.json\n`)
    return
  }

  const written = await upsertBatched(final)
  const savingsUsd = (written * AVG_AI_DESCRIBE_COST_USD).toFixed(2)
  process.stderr.write(
    `\n✓ ${written} generic foods imported.\n` +
    `  Estimated AI savings if every row replaces one describe call: $${savingsUsd}\n` +
    `  (assumes ~$${AVG_AI_DESCRIBE_COST_USD.toFixed(4)} per planner-describe call)\n`,
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
