import { supabase } from './supabase.js'
import { usdToBucks } from './pricing.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function getLocalFallback(key, def) {
  try { return JSON.parse(localStorage.getItem(key)) ?? def } catch { return def }
}
function setLocalFallback(key, val) {
  localStorage.setItem(key, JSON.stringify(val))
}

// ─── User Profile ────────────────────────────────────────────────────────────

export async function getProfile(userId) {
  if (!supabase) return getLocalFallback('macrolens_goals', { calories: 2000, protein: 150, carbs: 200, fat: 65 })
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function upsertProfile(userId, profile) {
  if (!supabase) { setLocalFallback('macrolens_goals', profile); return profile }
  const { data, error } = await supabase
    .from('user_profiles')
    .upsert({ user_id: userId, ...profile, updated_at: new Date().toISOString() })
    .select()
    .single()
  if (error) throw error
  return data
}

// ─── Goals ───────────────────────────────────────────────────────────────────

export async function getGoals(userId) {
  if (!supabase) return getLocalFallback('macrolens_goals', { calories: 2000, protein: 150, carbs: 200, fat: 65 })
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data ?? { calories: 2000, protein: 150, carbs: 200, fat: 65 }
}

export async function saveGoals(userId, goals) {
  if (!supabase) { setLocalFallback('macrolens_goals', goals); return goals }
  const { data, error } = await supabase
    .from('goals')
    .upsert(
      { user_id: userId, ...goals, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

// ─── Meal Log ────────────────────────────────────────────────────────────────

export async function getMealLog(userId, { limit = 200, fromDate } = {}) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_log', [])
    if (fromDate) return all.filter(e => new Date(e.logged_at || e.timestamp) >= new Date(fromDate))
    return all.slice(0, limit)
  }
  let query = supabase
    .from('meal_log')
    .select('*')
    .eq('user_id', userId)
    .order('logged_at', { ascending: false })
    .limit(limit)
  if (fromDate) query = query.gte('logged_at', fromDate)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function addMealEntry(userId, entry) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_log', [])
    const newEntry = { ...entry, id: Date.now(), logged_at: entry.logged_at ?? new Date().toISOString() }
    all.unshift(newEntry)
    setLocalFallback('macrolens_log', all)
    return newEntry
  }
  // Full-label fields are passed through verbatim — null means "not
  // tracked" and the UI shows that explicitly. Never coerce to 0.
  const { data, error } = await supabase
    .from('meal_log')
    .insert({
      user_id: userId,
      name: entry.name,
      calories: entry.calories ?? 0,
      protein: entry.protein ?? 0,
      carbs: entry.carbs ?? 0,
      fat: entry.fat ?? 0,
      fiber: entry.fiber ?? 0,
      sugar: entry.sugar ?? 0,
      base_calories: entry.base_calories ?? entry.calories ?? 0,
      base_protein: entry.base_protein ?? entry.protein ?? 0,
      base_carbs: entry.base_carbs ?? entry.carbs ?? 0,
      base_fat: entry.base_fat ?? entry.fat ?? 0,
      base_fiber: entry.base_fiber ?? entry.fiber ?? 0,
      base_sugar: entry.base_sugar ?? entry.sugar ?? 0,
      servings_consumed: entry.servings_consumed ?? 1,
      confidence: entry.confidence ?? 'medium',
      notes: entry.notes ?? '',
      food_item_id: entry.food_item_id ?? null,
      recipe_id: entry.recipe_id ?? null,
      meal_type: entry.meal_type ?? null,
      logged_at: entry.logged_at ?? new Date().toISOString(),
      saturated_fat_g: entry.saturated_fat_g ?? null,
      trans_fat_g:     entry.trans_fat_g ?? null,
      cholesterol_mg:  entry.cholesterol_mg ?? null,
      sodium_mg:       entry.sodium_mg ?? null,
      // fiber_g defaults to legacy `fiber` so pre-toggle entries still
      // show fiber in the expanded view. Other columns stay null when
      // not tracked.
      fiber_g:         entry.fiber_g ?? (entry.fiber ?? null),
      sugar_total_g:   entry.sugar_total_g ?? null,
      sugar_added_g:   entry.sugar_added_g ?? null,
      vitamin_a_mcg:   entry.vitamin_a_mcg ?? null,
      vitamin_c_mg:    entry.vitamin_c_mg ?? null,
      vitamin_d_mcg:   entry.vitamin_d_mcg ?? null,
      calcium_mg:      entry.calcium_mg ?? null,
      iron_mg:         entry.iron_mg ?? null,
      potassium_mg:    entry.potassium_mg ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateMealEntry(userId, id, updates) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_log', [])
    const idx = all.findIndex(e => e.id === id)
    if (idx !== -1) { all[idx] = { ...all[idx], ...updates }; setLocalFallback('macrolens_log', all) }
    return all[idx]
  }
  const { data, error } = await supabase
    .from('meal_log')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteMealEntry(userId, id) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_log', [])
    setLocalFallback('macrolens_log', all.filter(e => e.id !== id))
    return
  }
  const { error } = await supabase
    .from('meal_log')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

// ─── Meal Planner ────────────────────────────────────────────────────────────

export async function getPlannerWeek(userId, weekStart) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_planner', { meals: Array(7).fill([]) })
    return all
  }
  const { data, error } = await supabase
    .from('meal_planner')
    .select('*')
    .eq('user_id', userId)
    .eq('week_start_date', weekStart)
    .order('day_of_week')
  if (error) throw error
  const meals = Array.from({ length: 7 }, () => [])
  ;(data ?? []).forEach(row => {
    // Use actual_date if available to derive the correct slot — avoids any
    // timezone ambiguity in day_of_week that was stored by older app versions
    let slot = row.day_of_week
    if (row.actual_date) {
      // actual_date is 'YYYY-MM-DD' from DB — parse directly, no Date constructor
      const [yr, mo, dy] = row.actual_date.split('-').map(Number)
      slot = new Date(yr, mo - 1, dy).getDay()
    }
    if (slot >= 0 && slot < 7) meals[slot].push(row)
  })
  return { meals }
}

export async function addPlannerMeal(userId, weekStart, dayIdx, meal) {
  if (!supabase) {
    const planner = getLocalFallback('macrolens_planner', { meals: Array(7).fill(null).map(() => []) })
    planner.meals[dayIdx].push(meal)
    setLocalFallback('macrolens_planner', planner)
    return { ...meal, id: Date.now() }
  }
  // Compute actual_date from weekStart + dayIdx using pure date math (no timezone risk)
  const [wyr, wmo, wdy] = weekStart.split('-').map(Number)
  const actualDate = new Date(wyr, wmo - 1, wdy + dayIdx)
  const actualDateStr = `${actualDate.getFullYear()}-${String(actualDate.getMonth()+1).padStart(2,'0')}-${String(actualDate.getDate()).padStart(2,'0')}`

  const { data, error } = await supabase
    .from('meal_planner')
    .insert({
      user_id: userId,
      week_start_date: weekStart,
      day_of_week: dayIdx,
      actual_date: actualDateStr,
      meal_name: meal.name,
      calories: meal.calories ?? 0,
      protein: meal.protein ?? 0,
      carbs: meal.carbs ?? 0,
      fat: meal.fat ?? 0,
      fiber: meal.fiber ?? 0,
      is_leftover: meal.leftover ?? false,
      planned_servings: meal.planned_servings ?? null,
      recipe_id: meal.id ?? null,
      meal_type: meal.meal_type ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updatePlannerMeal(userId, id, updates) {
  if (!supabase) return updates
  const { data, error } = await supabase
    .from('meal_planner')
    .update({
      meal_name: updates.name,
      calories: updates.calories,
      protein: updates.protein,
      carbs: updates.carbs,
      fat: updates.fat,
      fiber: updates.fiber,
      is_leftover: updates.leftover
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deletePlannerMeal(userId, id) {
  if (!supabase) return
  const { error } = await supabase
    .from('meal_planner')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

// Move a planner meal to a different date. Recomputes week_start_date and
// day_of_week from the target date so the meal shows up on the correct day
// when the user navigates there.
export async function movePlannerMeal(userId, id, targetDate) {
  if (!supabase) return
  const [y, m, d] = targetDate.split('-').map(Number)
  const target = new Date(y, m - 1, d)
  const dayIdx = target.getDay()
  const weekStart = new Date(target)
  weekStart.setDate(weekStart.getDate() - dayIdx)
  const pad = n => String(n).padStart(2, '0')
  const ds = dt => `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`

  const { data, error } = await supabase
    .from('meal_planner')
    .update({
      actual_date: targetDate,
      day_of_week: dayIdx,
      week_start_date: ds(weekStart),
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) throw error
  return data
}

// ─── Token Usage + Spend Limits ──────────────────────────────────────────────

export async function checkSpendLimit(userId, estimatedCostUsd = 0.01) {
  if (!supabase) return { allowed: true, unlimited: true }
  const { data, error } = await supabase
    .rpc('check_spend_limit', {
      p_user_id: userId,
      p_estimated_cost: estimatedCostUsd
    })
  if (error) throw error
  return data
}

export async function recordTokenUsage(userId, { inputTokens, outputTokens, model, feature }) {
  if (!supabase) return
  const { error } = await supabase.rpc('record_usage', {
    p_user_id: userId,
    p_model: model,
    p_feature: feature,
    p_input_tokens: inputTokens ?? 0,
    p_output_tokens: outputTokens ?? 0
  })
  if (error) console.warn('Failed to record usage:', error.message)
}

export async function getUsageSummary(userId) {
  if (!supabase) return { spent: 0, limit: 10, remaining: 10, requests: 0 }
  const startOfMonth = new Date()
  startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0)

  const [profileRes, usageRes] = await Promise.all([
    supabase.from('user_profiles').select('spending_limit_usd, spending_limit_expires_at, total_spent_usd, is_admin, account_status, role, provider_name, provider_slug, provider_bio, provider_specialty, provider_avatar_url, credentials, hidden_tag_presets, track_full_nutrition').eq('user_id', userId).maybeSingle(),
    supabase.from('token_usage').select('cost_usd, tokens_used, feature').eq('user_id', userId).gte('created_at', startOfMonth.toISOString())
  ])

  const profile = profileRes.data ?? {}
  const usage = usageRes.data ?? []
  const monthSpent = usage.reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0)
  const monthTokens = usage.reduce((s, r) => s + (r.tokens_used || 0), 0)

  // Role is the single source of truth for spend caps and provider status.
  // Fallbacks:
  //   - Old records with is_admin=true but no role get 'admin'
  //   - Everything else defaults to 'free' (safest — cap applies)
  // Note: is_provider and unlimited_access columns are being dropped in
  // the migration, so we don't read them here anymore. If somehow they
  // still exist on old rows, they're ignored.
  const role = profile.role || (profile.is_admin ? 'admin' : 'free')

  // Map role → default monthly cap. Admin is unlimited (null). Everyone
  // else has a ceiling tied to their tier. Per-user override via
  // spending_limit_usd column is respected if set (null means "use default").
  const ROLE_CAPS = { free: 0.10, premium: 10.00, provider: 50.00, admin: null }
  const defaultCap = ROLE_CAPS[role] ?? ROLE_CAPS.free
  const overrideCap = profile.spending_limit_usd != null ? parseFloat(profile.spending_limit_usd) : null
  const limit = overrideCap ?? defaultCap
  const isUnlimited = limit == null

  // Provider status is role + data. Just being role='admin' isn't enough
  // to count as a "provider" for UI purposes — we also require a
  // provider_name, meaning the user has actually set up a provider
  // profile. This separates "I have admin powers" from "I run a channel".
  //
  // Matrix:
  //   role='provider' + no name        → not yet discoverable; still needs setup
  //   role='admin'    + no name        → admin without a channel (e.g. internal ops)
  //   role='provider' + name           → active provider, discoverable
  //   role='admin'    + name           → admin who also runs a channel
  //   role='free'/'premium' + anything → not a provider
  const hasProviderProfile = !!(profile.provider_name && profile.provider_name.trim())
  const isProvider = hasProviderProfile && (role === 'provider' || role === 'admin')

  // Compute user-facing Computer Calories (1000x multiplier). We expose these as
  // *additional* fields alongside the raw dollar amounts — UI reads Bucks
  // for display, internal logic (spend cap enforcement, pricing) stays in
  // dollars. See src/lib/pricing.js for the conversion rationale.
  const spentBucks = usdToBucks(monthSpent)
  const limitBucks = isUnlimited || limit == null ? null : usdToBucks(limit)
  const remainingBucks = isUnlimited || limit == null
    ? null
    : Math.max(0, usdToBucks(limit) - spentBucks)  // Is the admin override currently active? Same logic mirroring the
  // server-side check_spend_limit RPC so the UI can accurately show
  // "Custom allotment active" badges.
  const hasOverride = profile.spending_limit_usd != null
  const overrideExpiresAt = profile.spending_limit_expires_at
    ? new Date(profile.spending_limit_expires_at)
    : null
  const overrideActive = hasOverride &&
    (overrideExpiresAt == null || overrideExpiresAt > new Date())

  return {
    spent: Math.round(monthSpent * 10000) / 10000,
    limit: isUnlimited ? null : limit,
    remaining: isUnlimited ? null : Math.max(0, limit - monthSpent),
    // User-facing display units. Prefer these in UI.
    spentBucks,
    limitBucks,
    remainingBucks,
    totalSpent: profile.total_spent_usd ?? 0,
    tokens: monthTokens,
    requests: usage.length,
    isAdmin: role === 'admin',
    isProvider,
    isPremium: role === 'premium' || role === 'admin',
    isFree: role === 'free',
    // Legacy alias — some UI still reads isDietitian. Treat 'provider' as
    // its closest semantic equivalent so nothing breaks during the transition.
    // Will delete once all references are swept out of app.js.
    isDietitian: isProvider,
    providerName: profile.provider_name || null,
    providerSlug: profile.provider_slug || null,
    providerBio: profile.provider_bio || null,
    providerSpecialty: profile.provider_specialty || null,
    providerAvatarUrl: profile.provider_avatar_url || null,
    credentials: profile.credentials || null,
    // Per-user preset hiding — array of preset tag names (lowercased)
    // the user has chosen to delete from their suggestion list. UI
    // reads this from state.usage.hiddenTagPresets.
    hiddenTagPresets: Array.isArray(profile.hidden_tag_presets) ? profile.hidden_tag_presets : [],
    // Full-nutrition-label opt-in — canonical source for the toggle.
    // localStorage caches it for cold-start render speed; the UI reads
    // from state.usage.trackFullNutrition once getUsageSummary lands.
    trackFullNutrition: profile.track_full_nutrition === true,
    // Override visibility for admin UI. null when no override set.
    override: hasOverride ? {
      active: overrideActive,
      limitUsd: parseFloat(profile.spending_limit_usd),
      limitBucks: usdToBucks(profile.spending_limit_usd),
      expiresAt: overrideExpiresAt,  // Date object or null (permanent)
    } : null,
    role,
    isUnlimited,
    accountStatus: profile.account_status ?? 'active',
    breakdown: usage.reduce((acc, r) => {
      acc[r.feature] = (acc[r.feature] || 0) + (parseFloat(r.cost_usd) || 0)
      return acc
    }, {})
  }
}

// Targeted update: just user_profiles.track_full_nutrition. Canonical
// store for the full-nutrition-label opt-in (used to live on goals; the
// goals row isn't always loaded before the toggle renders, so cross-
// device sync was unreliable). Caller is responsible for caching the
// value in localStorage so a cold-launched tab sees the user's setting
// before the auth/profile fetch returns.
export async function saveTrackFullNutrition(userId, on) {
  if (!supabase) {
    setLocalFallback('macrolens_track_full_nutrition', !!on)
    return
  }
  const { error } = await supabase
    .from('user_profiles')
    .update({ track_full_nutrition: !!on })
    .eq('user_id', userId)
  if (error) throw error
}

// Admin only — get all users.
//
// Backed by a SECURITY DEFINER function that explicitly checks
// is_admin(auth.uid()) before returning rows. Replaced the previous
// public.admin_user_overview view, which the Supabase linter flagged
// as exposing auth.users to anon and as bypassing RLS via SECURITY
// DEFINER. Function variant is safe because the auth check gates
// access at the application layer.
export async function getAdminUserOverview() {
  if (!supabase) return []
  const { data, error } = await supabase
    .rpc('admin_user_overview')
    .order('spent_this_month_usd', { ascending: false })
  if (error) throw error
  return data ?? []
}

// Valid roles in the new model. Setting anything outside this list throws
// — much easier to catch typos at the edge than to debug why half the app
// thinks you're a provider and half doesn't.
const VALID_ROLES = new Set(['free', 'premium', 'provider', 'admin'])

export async function setUserRole(userId, role) {
  if (!supabase) return
  if (!VALID_ROLES.has(role)) {
    throw new Error(`Invalid role '${role}' — must be one of: ${[...VALID_ROLES].join(', ')}`)
  }
  // is_admin kept in sync with role for backwards compat with anything still
  // reading that column directly. Will remove once that audit is complete.
  const isAdmin = role === 'admin'
  const { error } = await supabase.from('user_profiles')
    .update({ role, is_admin: isAdmin })
    .eq('user_id', userId)
  if (error) throw error
}

// Admin-facing: set per-user overrides. spending_limit_usd stays as an
// escape hatch — null means 'use the role default', anything else pins
// the cap regardless of role. spending_limit_expires_at controls whether
// the override is permanent (null) or auto-expires on a specific date.
// account_status lets admins suspend users.
export async function setUserPrivileges(userId, { spendingLimitUsd, spendingLimitExpiresAt, accountStatus }) {
  if (!supabase) return
  const updates = {}
  if (spendingLimitUsd !== undefined) updates.spending_limit_usd = spendingLimitUsd
  if (spendingLimitExpiresAt !== undefined) {
    // Accept Date, ISO string, or null. Normalize to ISO string or null.
    updates.spending_limit_expires_at = spendingLimitExpiresAt instanceof Date
      ? spendingLimitExpiresAt.toISOString()
      : spendingLimitExpiresAt
  }
  if (accountStatus !== undefined) updates.account_status = accountStatus
  const { error } = await supabase.from('user_profiles').update(updates).eq('user_id', userId)
  if (error) throw error
}

// Clear the spending-limit override, reverting the user to their role
// default cap. Called by the [Clear] button in the Account page override
// info row. Both columns reset to null together so there's never a stale
// expiration pointing at a missing amount.
export async function clearSpendingOverride(userId) {
  if (!supabase) return
  const { error } = await supabase.from('user_profiles')
    .update({ spending_limit_usd: null, spending_limit_expires_at: null })
    .eq('user_id', userId)
  if (error) throw error
}

// Hide a preset tag for this user. Appends the lowercased name to the
// hidden_tag_presets array if not already present. UI filters the preset
// suggestion list by this, so the user stops seeing it.
export async function hideTagPreset(userId, presetName) {
  if (!supabase || !presetName) return
  const key = String(presetName).toLowerCase().trim()
  if (!key) return
  // Read-modify-write. Safe for a single-user operation; no concurrent
  // edits to the same profile's hidden_tag_presets expected.
  const { data: profile } = await supabase.from('user_profiles')
    .select('hidden_tag_presets').eq('user_id', userId).maybeSingle()
  const current = Array.isArray(profile?.hidden_tag_presets) ? profile.hidden_tag_presets : []
  if (current.map(s => s.toLowerCase()).includes(key)) return
  const { error } = await supabase.from('user_profiles')
    .update({ hidden_tag_presets: [...current, key] }).eq('user_id', userId)
  if (error) throw error
}

// Unhide a preset — reverses hideTagPreset. Not currently wired to UI
// but exists for symmetry and future "restore defaults" flows.
export async function unhideTagPreset(userId, presetName) {
  if (!supabase || !presetName) return
  const key = String(presetName).toLowerCase().trim()
  const { data: profile } = await supabase.from('user_profiles')
    .select('hidden_tag_presets').eq('user_id', userId).maybeSingle()
  const current = Array.isArray(profile?.hidden_tag_presets) ? profile.hidden_tag_presets : []
  const filtered = current.filter(s => s.toLowerCase() !== key)
  if (filtered.length === current.length) return
  const { error } = await supabase.from('user_profiles')
    .update({ hidden_tag_presets: filtered }).eq('user_id', userId)
  if (error) throw error
}

// ─── Ingredient synonyms (grocery smart-merge persistence) ────────────────
// Stores user-specific name mappings learned via the AI smart-merge.
// E.g. {from: "scallion greens", to: "green onions"}. Read on app boot
// into state.aiSynonyms; consulted by sumIngredients to collapse rows.

export async function getIngredientSynonyms(userId) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('ingredient_synonyms')
    .select('from_name, to_name')
    .eq('user_id', userId)
  if (error) {
    // Table might not exist yet (pre-migration). Fail soft — synonyms
    // are an enhancement, not a critical feature.
    console.warn('[getIngredientSynonyms] failed (table may not exist yet):', error.message)
    return []
  }
  return data ?? []
}

// Batch upsert. Used after the AI smart-merge call returns synonym
// pairs — we save them all at once. Conflict-on-PK does an UPDATE so
// the same 'from' getting a new 'to' is allowed (later AI call wins).
export async function saveIngredientSynonyms(userId, pairs) {
  if (!supabase || !pairs?.length) return
  const rows = pairs
    .filter(p => p.from && p.to)
    .map(p => ({
      user_id: userId,
      from_name: String(p.from).toLowerCase().trim(),
      to_name: String(p.to).toLowerCase().trim(),
    }))
    .filter(r => r.from_name && r.to_name && r.from_name !== r.to_name)
  if (!rows.length) return
  const { error } = await supabase
    .from('ingredient_synonyms')
    .upsert(rows, { onConflict: 'user_id,from_name' })
  if (error) throw error
}

// Delete one or more synonyms by from_name. Used by the per-row unmerge
// button — when the user clicks × on a merged row, we look up which
// from_names mapped to that row's canonical name and delete each.
export async function deleteIngredientSynonyms(userId, fromNames) {
  if (!supabase || !fromNames?.length) return
  const lowered = fromNames.map(n => String(n).toLowerCase().trim()).filter(Boolean)
  if (!lowered.length) return
  const { error } = await supabase
    .from('ingredient_synonyms')
    .delete()
    .eq('user_id', userId)
    .in('from_name', lowered)
  if (error) throw error
}

// ─── Recipes ──────────────────────────────────────────────────────────────────

export async function getRecipes(userId) {
  if (!supabase) return getLocalFallback('macrolens_recipes', [])
  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function upsertRecipe(userId, recipe) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_recipes', [])
    const idx = all.findIndex(r => r.id === recipe.id)
    const updated = { ...recipe, user_id: userId, updated_at: new Date().toISOString() }
    if (!updated.id) updated.id = Date.now().toString()
    if (idx !== -1) all[idx] = updated; else all.unshift(updated)
    setLocalFallback('macrolens_recipes', all)
    return updated
  }
  // Only send columns that exist in the DB schema
  const payload = {
    user_id: userId,
    updated_at: new Date().toISOString(),
    name: recipe.name,
    description: recipe.description || '',
    servings: recipe.servings || 4,
    serving_label: recipe.serving_label || 'serving',
    calories: recipe.calories || 0,
    protein: recipe.protein || 0,
    carbs: recipe.carbs || 0,
    fat: recipe.fat || 0,
    fiber: recipe.fiber || 0,
    sugar: recipe.sugar || 0,
    ingredients: recipe.ingredients || [],
    ai_notes: recipe.ai_notes || recipe.notes || '',
    confidence: recipe.confidence || 'medium',
    source: recipe.source || 'manual',
    source_url: recipe.source_url || '',
    notes: recipe.notes || '',
    instructions: recipe.instructions || null,
    tags: Array.isArray(recipe.tags) ? recipe.tags : [],
  }
  if (recipe.id) payload.id = recipe.id

  const tryUpsert = async (p) => {
    const { data, error } = await supabase.from('recipes').upsert(p).select().single()
    if (error) throw error
    return data
  }
  try {
    return await tryUpsert(payload)
  } catch (err) {
    // Schema cache lag — strip only specific columns we know are optional.
    // Important: do NOT strip `tags`. Previously we did, which meant any
    // Supabase schema-cache blip caused tags to silently vanish from saves
    // while the user saw "Recipe saved!". If the tags column is genuinely
    // missing (user skipped the migration), we'd rather fail loudly so they
    // know to run it, rather than pretend tags worked.
    const msg = err?.message || ''
    if (msg.includes("'recipes'") || msg.includes('column')) {
      const stripped = { ...payload }
      let strippedAnything = false
      if (msg.includes('source_url')) { delete stripped.source_url; strippedAnything = true }
      if (msg.includes('notes') && !msg.includes('ai_notes')) { delete stripped.notes; strippedAnything = true }
      // Tags specifically: log a loud console warning so if this path ever
      // gets hit we can see it. Re-throw rather than silently drop.
      if (msg.includes('tags')) {
        console.error('[upsertRecipe] DB rejected "tags" column. Did you run add_recipe_tags.sql? Error:', err)
        throw new Error('Tags column not found. Run the add_recipe_tags.sql migration in Supabase, or try: NOTIFY pgrst, \'reload schema\';')
      }
      if (strippedAnything) return await tryUpsert(stripped)
    }
    throw err
  }
}


export async function saveRecipeInstructions(userId, recipeId, instructions) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_recipes', [])
    const idx = all.findIndex(r => r.id === recipeId)
    if (idx !== -1) { all[idx].instructions = instructions; setLocalFallback('macrolens_recipes', all) }
    return
  }
  // Ensure instructions is a plain object (not a Proxy or other wrapper)
  const payload = JSON.parse(JSON.stringify(instructions))
  const { data, error } = await supabase
    .from('recipes')
    .update({ instructions: payload, updated_at: new Date().toISOString() })
    .eq('id', recipeId)
    .eq('user_id', userId)
    .select('id, instructions, instructions_version')
    .maybeSingle()
  if (error) {
    console.error('saveRecipeInstructions error:', error)
    throw new Error(error.message)
  }
  if (!data) {
    // 0 rows updated — most commonly means the recipe belongs to another user
    throw new Error("Can't save to this recipe — it isn't in your library. Copy the meal plan to your planner first, which imports the recipe.")
  }
  if (!data.instructions) {
    throw new Error('Save appeared to succeed but instructions were not returned from DB')
  }
  return data
}

export async function deleteRecipe(userId, id) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_recipes', [])
    setLocalFallback('macrolens_recipes', all.filter(r => r.id !== id))
    return
  }
  const { error } = await supabase
    .from('recipes')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

export async function getRecipeByName(userId, name) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_recipes', [])
    return all.find(r => r.name.toLowerCase() === name.toLowerCase()) ?? null
  }
  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .eq('user_id', userId)
    .ilike('name', name)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function getWeeksWithMeals(userId) {
  // Returns array of distinct week_start_date strings that have at least one meal
  if (!supabase) return []
  const { data, error } = await supabase
    .from('meal_planner')
    .select('week_start_date')
    .eq('user_id', userId)
    .order('week_start_date', { ascending: false })
  if (error) throw error
  // Deduplicate
  const seen = new Set()
  return (data ?? []).filter(r => {
    if (seen.has(r.week_start_date)) return false
    seen.add(r.week_start_date); return true
  }).map(r => r.week_start_date)
}

export async function getPlannerRange(userId, fromDate, toDate) {
  // Fetch all planner meals between two dates (inclusive)
  // fromDate / toDate are 'YYYY-MM-DD' strings
  if (!supabase) return { meals: [] }

  // Get all week_starts that overlap the range
  const from = new Date(fromDate + 'T00:00:00')
  const to = new Date(toDate + 'T00:00:00')

  // Collect week starts for the range
  const weekStarts = []
  const cursor = new Date(from)
  cursor.setDate(cursor.getDate() - cursor.getDay()) // snap to Sunday
  while (cursor <= to) {
    const c = cursor; weekStarts.push(`${c.getFullYear()}-${String(c.getMonth()+1).padStart(2,'0')}-${String(c.getDate()).padStart(2,'0')}`)
    cursor.setDate(cursor.getDate() + 7)
  }

  const { data, error } = await supabase
    .from('meal_planner')
    .select('*')
    .eq('user_id', userId)
    .in('week_start_date', weekStarts)
    .order('week_start_date')
    .order('day_of_week')
  if (error) throw error

  // Helper: local date string without UTC shift
  const localDs = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

  // Filter to only days within fromDate..toDate
  const meals = (data ?? []).filter(row => {
    const [yr, mo, dy] = row.week_start_date.split('-').map(Number)
    const d = new Date(yr, mo - 1, dy + row.day_of_week)
    const ds = localDs(d)
    return ds >= fromDate && ds <= toDate
  }).map(row => {
    const [yr, mo, dy] = row.week_start_date.split('-').map(Number)
    const d = new Date(yr, mo - 1, dy + row.day_of_week)
    return { ...row, actualDate: localDs(d) }
  })

  return { meals }
}


// Auto-save a food item if it doesn't exist yet, return its id
// Skips recipes (they have their own table) and items with recipe_id
export async function autoSaveFoodItem(userId, entry, foodItems) {
  // Don't auto-save if it's already linked to a food or recipe
  if (entry.food_item_id || entry.recipe_id) return entry.food_item_id ?? null
  // Don't auto-save if it looks like a recipe (has ingredients)
  if (entry.ingredients?.length) return null

  // Check if already in local food items list by name
  const existing = (foodItems || []).find(f =>
    f.name.toLowerCase() === (entry.name || '').toLowerCase()
  )
  if (existing) return existing.id

  // Create new food item
  try {
    const food = await upsertFoodItem(userId, {
      name: entry.name,
      brand: entry.brand || '',
      serving_size: entry.serving_size || '1 serving',
      calories: entry.base_calories ?? entry.calories ?? 0,
      protein:  entry.base_protein  ?? entry.protein  ?? 0,
      carbs:    entry.base_carbs    ?? entry.carbs    ?? 0,
      fat:      entry.base_fat      ?? entry.fat      ?? 0,
      fiber:    entry.base_fiber    ?? entry.fiber    ?? 0,
      sugar:    entry.base_sugar    ?? entry.sugar    ?? 0,
      sodium:   entry.sodium ?? 0,
      components: [],
      source: entry.source || 'log',
      // Forward any full-label values the AI returned so the saved
      // food_item carries them — future re-logs reuse the same values.
      saturated_fat_g: entry.saturated_fat_g ?? null,
      trans_fat_g:     entry.trans_fat_g ?? null,
      cholesterol_mg:  entry.cholesterol_mg ?? null,
      sodium_mg:       entry.sodium_mg ?? null,
      fiber_g:         entry.fiber_g ?? null,
      sugar_total_g:   entry.sugar_total_g ?? null,
      sugar_added_g:   entry.sugar_added_g ?? null,
      vitamin_a_mcg:   entry.vitamin_a_mcg ?? null,
      vitamin_c_mg:    entry.vitamin_c_mg ?? null,
      vitamin_d_mcg:   entry.vitamin_d_mcg ?? null,
      calcium_mg:      entry.calcium_mg ?? null,
      iron_mg:         entry.iron_mg ?? null,
      potassium_mg:    entry.potassium_mg ?? null,
    })
    return food.id
  } catch (err) {
    console.warn('autoSaveFoodItem failed:', err.message)
    return null
  }
}

// ─── Food Items ───────────────────────────────────────────────────────────────

export async function getFoodItems(userId) {
  if (!supabase) return getLocalFallback('macrolens_food_items', [])
  const { data, error } = await supabase
    .from('food_items')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function upsertFoodItem(userId, item) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_food_items', [])
    const idx = all.findIndex(f => f.id === item.id)
    const updated = { ...item, user_id: userId, updated_at: new Date().toISOString() }
    if (!updated.id) updated.id = Date.now().toString()
    if (idx !== -1) all[idx] = updated; else all.unshift(updated)
    setLocalFallback('macrolens_food_items', all)
    return updated
  }
  const payload = {
    user_id: userId,
    updated_at: new Date().toISOString(),
    name: item.name,
    brand: item.brand || '',
    serving_size: item.serving_size || '1 serving',
    calories: item.calories || 0,
    protein: item.protein || 0,
    carbs: item.carbs || 0,
    fat: item.fat || 0,
    fiber: item.fiber || 0,
    sugar: item.sugar || 0,
    sodium: item.sodium || 0,
    components: item.components || [],
    notes: item.notes || '',
    source: item.source || 'manual',
    // Full-label fields — null = not tracked; never coerce to 0.
    saturated_fat_g: item.saturated_fat_g ?? null,
    trans_fat_g:     item.trans_fat_g ?? null,
    cholesterol_mg:  item.cholesterol_mg ?? null,
    sodium_mg:       item.sodium_mg ?? null,
    fiber_g:         item.fiber_g ?? null,
    sugar_total_g:   item.sugar_total_g ?? null,
    sugar_added_g:   item.sugar_added_g ?? null,
    vitamin_a_mcg:   item.vitamin_a_mcg ?? null,
    vitamin_c_mg:    item.vitamin_c_mg ?? null,
    vitamin_d_mcg:   item.vitamin_d_mcg ?? null,
    calcium_mg:      item.calcium_mg ?? null,
    iron_mg:         item.iron_mg ?? null,
    potassium_mg:    item.potassium_mg ?? null,
  }
  if (item.id) payload.id = item.id
  const { data, error } = await supabase
    .from('food_items')
    .upsert(payload)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteFoodItem(userId, id) {
  if (!supabase) {
    const all = getLocalFallback('macrolens_food_items', [])
    setLocalFallback('macrolens_food_items', all.filter(f => f.id !== id))
    return
  }
  const { error } = await supabase
    .from('food_items')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw error
}

// ─── Error Logging ────────────────────────────────────────────────────────────

export async function logError(userId, error, context = {}) {
  if (!supabase) return
  try {
    await supabase.from('error_logs').insert({
      user_id: userId || null,
      error_message: String(error?.message || error).slice(0, 500),
      error_stack: error?.stack?.slice(0, 2000) || null,
      context: context.context || null,
      page: context.page || null,
      url: typeof window !== 'undefined' ? window.location.href.slice(0, 200) : null,
    })
  } catch {
    // Never throw from error logger
  }
}

export async function cleanupOldErrors() {
  if (!supabase) return
  try {
    // Delete errors older than 14 days for this user
    await supabase
      .from('error_logs')
      .delete()
      .lt('created_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
  } catch {}
}

export async function getErrorLogs(userId, limit = 100) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('error_logs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return []
  return data ?? []
}

export async function getAllErrorLogs(limit = 200) {
  if (!supabase) return []
  // Admin view — uses service role via server or falls back to own logs
  const { data, error } = await supabase
    .from('error_logs')
    .select('*, user_profiles(email:user_id)')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return []
  return data ?? []
}

// ─── Body Metrics ─────────────────────────────────────────────────────────────

export async function getBodyMetrics(userId) {
  if (!supabase) return null
  const { data } = await supabase.from('body_metrics').select('*').eq('user_id', userId).maybeSingle()
  return data
}

export async function saveBodyMetrics(userId, metrics) {
  if (!supabase) return metrics
  const payload = { ...metrics, user_id: userId, updated_at: new Date().toISOString() }
  const { data, error } = await supabase.from('body_metrics').upsert(payload).select().single()
  if (error) throw error
  return data
}

export async function getCheckins(userId, limit = 2000) {
  // Default raised from 52 → 2000 to cover yearly history. At one weigh-in
  // per day that's ~5.5 years; almost all real users will fall well under
  // this cap. The Goals page now buckets checkins into weekly/monthly/yearly
  // tiers and needs the full set to compute past-year averages.
  if (!supabase) return []
  const { data, error } = await supabase
    .from('checkins').select('*').eq('user_id', userId)
    .order('checked_in_at', { ascending: false }).limit(limit)
  if (error) return []
  return data ?? []
}

export async function saveCheckin(userId, checkin) {
  if (!supabase) return checkin
  const { data, error } = await supabase
    .from('checkins').insert({ ...checkin, user_id: userId }).select().single()
  if (error) throw error
  return data
}

export async function updateCheckin(userId, checkinId, patch) {
  if (!supabase) return { id: checkinId, ...patch }
  const { data, error } = await supabase
    .from('checkins')
    .update(patch)
    .eq('id', checkinId)
    .eq('user_id', userId)  // defense-in-depth: only update your own rows
    .select().single()
  if (error) throw error
  return data
}

export async function deleteCheckin(userId, checkinId) {
  if (!supabase) return true
  const { error } = await supabase
    .from('checkins')
    .delete()
    .eq('id', checkinId)
    .eq('user_id', userId) // defense-in-depth: only delete your own rows
  if (error) throw error
  return true
}

export async function uploadScanFile(userId, file) {
  if (!supabase) return null
  const ext = file.name.split('.').pop()
  const path = `${userId}/${Date.now()}.${ext}`
  const { error } = await supabase.storage.from('body-scans').upload(path, file, {
    cacheControl: '3600', upsert: false
  })
  if (error) throw error
  return path
}

export async function getScanUrl(path) {
  if (!supabase || !path) return null
  const { data } = await supabase.storage.from('body-scans').createSignedUrl(path, 60 * 60 * 24)
  return data?.signedUrl || null
}

// ─── Recipe Sharing ───────────────────────────────────────────────────────────
//
// Historically there were two share flows writing to two different booleans
// on public.recipes: is_public (legacy, full Share modal) and is_shared
// (newer, card-tile Share button). That led to share links from one flow
// being unreadable by the other endpoint. We've consolidated on is_shared.
//
// generateShareToken() is kept as a thin alias for enableRecipeSharing()
// so any caller still using the old name keeps working. Same for the
// reader — getRecipeByShareToken() delegates to getSharedRecipe().

export async function generateShareToken(userId, recipeId) {
  return enableRecipeSharing(userId, recipeId)
}

export async function getRecipeByShareToken(token) {
  return getSharedRecipe(token)
}

export async function shareRecipeWithUser(fromUserId, recipeId, toEmail) {
  if (!supabase) return null
  // Look up recipient by email via user_profiles
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('user_id')
    .eq('email', toEmail)
    .maybeSingle()

  const { data, error } = await supabase
    .from('recipe_shares')
    .insert({
      recipe_id: recipeId,
      from_user_id: fromUserId,
      to_user_id: profile?.user_id || null,
      to_email: toEmail,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getIncomingShares(userId) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('recipe_shares')
    .select('*, recipes(*)')
    .eq('to_user_id', userId)
    .order('created_at', { ascending: false })
  if (error) return []
  return data ?? []
}

export async function markShareRead(shareId) {
  if (!supabase) return
  await supabase.from('recipe_shares').update({ is_read: true }).eq('id', shareId)
}

export async function getUnreadShareCount(userId) {
  if (!supabase) return 0
  const { count } = await supabase
    .from('recipe_shares')
    .select('*', { count: 'exact', head: true })
    .eq('to_user_id', userId)
    .eq('is_read', false)
  return count || 0
}

export async function enableRecipeSharing(userId, recipeId) {
  if (!supabase) return null
  // Generate a share token if not already set
  const token = crypto.randomUUID()
  const { data, error } = await supabase
    .from('recipes')
    .update({ share_token: token, is_shared: true })
    .eq('id', recipeId)
    .eq('user_id', userId)
    .select('share_token')
    .single()
  if (error) throw error
  return data.share_token
}

export async function disableRecipeSharing(userId, recipeId) {
  if (!supabase) return
  const { error } = await supabase
    .from('recipes')
    .update({ is_shared: false })
    .eq('id', recipeId)
    .eq('user_id', userId)
  if (error) throw error
}

export async function getSharedRecipe(shareToken) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .eq('share_token', shareToken)
    .eq('is_shared', true)
    .maybeSingle()
  if (error) return null
  return data
}

// Fetch any recipe the current user can read: either their own,
// or someone else's flagged is_shared=true. Used by the broadcast
// preview modal so users can peek at any provider's recipe.
export async function getRecipeByIdPublic(recipeId) {
  if (!supabase || !recipeId) return null
  // Try own-library first (covers case where user already copied it)
  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .eq('id', recipeId)
    .maybeSingle()
  if (error) return null
  return data
}

export async function saveSharedRecipeToLibrary(userId, recipe) {
  if (!supabase) return null
  // Copy recipe to user's library, stripping ownership fields
  const { share_token, is_shared, id, user_id, created_at, updated_at, ...fields } = recipe
  const { data, error } = await supabase
    .from('recipes')
    .insert({ ...fields, user_id: userId, share_token: null, is_shared: false })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function saveRecipeOgCache(userId, recipeId, ogData) {
  if (!supabase) return
  await supabase.from('recipes')
    .update({ og_cache: ogData })
    .eq('id', recipeId)
    .eq('user_id', userId)
}

// ─── Provider / Broadcast ──────────────────────────────────────────────────────

export async function saveProviderProfile(userId, { provider_name, provider_bio, provider_specialty, provider_slug, provider_avatar_url, credentials }) {
  if (!supabase) return
  const updates = {}
  if (provider_name !== undefined) updates.provider_name = provider_name
  if (provider_bio !== undefined) updates.provider_bio = provider_bio
  if (provider_specialty !== undefined) updates.provider_specialty = provider_specialty
  if (provider_slug !== undefined) updates.provider_slug = provider_slug
  if (provider_avatar_url !== undefined) updates.provider_avatar_url = provider_avatar_url
  // Free-text credentials string like "RD, LD, CSCS". No validation — we
  // trust the provider to describe themselves honestly.
  if (credentials !== undefined) updates.credentials = credentials
  const { error } = await supabase.from('user_profiles').update(updates).eq('user_id', userId)
  if (error) throw error
}

export async function uploadProviderAvatar(userId, file) {
  if (!supabase) return null
  const ext = file.name.split('.').pop() || 'jpg'
  const path = `${userId}/avatar.${ext}`
  // Delete any existing avatars for this user first
  const { data: existing } = await supabase.storage.from('provider-avatars').list(userId)
  if (existing?.length) {
    await supabase.storage.from('provider-avatars').remove(existing.map(f => `${userId}/${f.name}`))
  }
  const { error } = await supabase.storage.from('provider-avatars').upload(path, file, { upsert: true })
  if (error) throw error
  const { data } = supabase.storage.from('provider-avatars').getPublicUrl(path)
  return data.publicUrl + '?t=' + Date.now() // cache bust
}

// Roles considered "currently active as a provider" — shown in the
// Providers directory and allowed to own broadcasts. Under the new
// role model, this is simply the 'provider' role (plus admin for
// internal testing).
//
// Shared broadcasts (meal plan links already distributed) are NOT gated
// on this — they're keyed on share_token only. Demoting a provider
// hides them from discovery but existing links keep resolving.
const ACTIVE_PROVIDER_ROLES = ['provider', 'admin']

export async function getProviders() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('user_profiles')
    .select('user_id, provider_name, provider_bio, provider_slug, provider_specialty, provider_avatar_url, credentials, role, email')
    .in('role', ACTIVE_PROVIDER_ROLES)
    .not('provider_name', 'is', null)
    .order('provider_name')
  if (error) throw error
  return data ?? []
}

export async function getProviderBySlug(slug) {
  if (!supabase) return null
  const { data } = await supabase
    .from('user_profiles')
    .select('user_id, provider_name, provider_bio, provider_slug, provider_specialty, credentials, role')
    .eq('provider_slug', slug)
    .in('role', ACTIVE_PROVIDER_ROLES)
    .not('provider_name', 'is', null)
    .maybeSingle()
  return data
}

export async function getProviderBroadcasts(providerId, publishedOnly = true) {
  if (!supabase) return []
  let q = supabase
    .from('provider_broadcasts')
    .select('*')
    .eq('provider_id', providerId)
    .order('week_start', { ascending: false })
  if (publishedOnly) q = q.eq('is_published', true)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

export async function saveBroadcast(broadcast) {
  if (!supabase) return null
  // Auto-generate share token for new broadcasts
  if (!broadcast.share_token) {
    broadcast.share_token = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8)
  }
  const { data, error } = await supabase
    .from('provider_broadcasts')
    .upsert({ ...broadcast, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getBroadcastByToken(token) {
  if (!supabase) return null
  const { data } = await supabase
    .from('provider_broadcasts')
    .select('*, user_profiles!provider_id(provider_name, provider_specialty, provider_bio)')
    .eq('share_token', token)
    .eq('is_published', true)
    .maybeSingle()
  return data
}

export async function deleteBroadcast(id, userId = null) {
  if (!supabase) return
  let q = supabase.from('provider_broadcasts').delete().eq('id', id)
  if (userId) q = q.eq('provider_id', userId)
  const { error } = await q
  if (error) throw error
}

export async function followProvider(followerId, providerId) {
  if (!supabase) return
  const { error } = await supabase
    .from('provider_follows')
    .upsert({ follower_id: followerId, provider_id: providerId }, { onConflict: 'follower_id,provider_id' })
  if (error) throw error
}

export async function unfollowProvider(followerId, providerId) {
  if (!supabase) return
  const { error } = await supabase
    .from('provider_follows')
    .delete()
    .eq('follower_id', followerId)
    .eq('provider_id', providerId)
  if (error) throw error
}

export async function getFollowedProviders(userId) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('provider_follows')
    .select('provider_id')
    .eq('follower_id', userId)
  if (error || !data?.length) return []
  const ids = data.map(r => r.provider_id)
  // Same filter as getProviders — if a provider is inactive (demoted role,
  // or flipped is_provider=false), they shouldn't appear in the follower's
  // Following list either. The provider_follows row itself stays so if
  // they're re-promoted, the follow relationship auto-resurfaces with no
  // data loss. Symmetric with how the directory works.
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('user_id, provider_name, provider_bio, provider_slug, provider_specialty, credentials, role')
    .in('user_id', ids)
    .in('role', ACTIVE_PROVIDER_ROLES)
    .not('provider_name', 'is', null)
  return profiles ?? []
}

export async function isFollowingProvider(followerId, providerId) {
  if (!supabase) return false
  const { data } = await supabase
    .from('provider_follows')
    .select('follower_id')
    .eq('follower_id', followerId)
    .eq('provider_id', providerId)
    .maybeSingle()
  return !!data
}

export async function getFollowerCount(providerId) {
  if (!supabase) return 0
  const { count } = await supabase
    .from('provider_follows')
    .select('*', { count: 'exact', head: true })
    .eq('provider_id', providerId)
  return count ?? 0
}

export async function copyBroadcastToPlanner(userId, broadcast, startDate, selectedIndices = null, mealTypeOverrides = null) {
  if (!supabase || !broadcast?.plan_data?.length) return 0

  // Apply per-meal type overrides (keyed by original index) before filtering
  const overrides = mealTypeOverrides || {}
  const overriddenData = broadcast.plan_data.map((item, i) =>
    overrides[i] ? { ...item, meal_type: overrides[i] } : item
  )

  // Filter to selected items (or all if none specified)
  let items = selectedIndices
    ? overriddenData.filter((_, i) => selectedIndices.includes(i))
    : overriddenData

  if (!items.length) return 0

  // Sort items by their original date so the sequence matches the broadcast
  items = [...items].sort((a, b) => {
    const ad = a.actual_date || ''
    const bd = b.actual_date || ''
    return ad.localeCompare(bd)
  })

  // ── Auto-save each unique recipe into the user's library ────────────
  // For each distinct recipe_id referenced in the selected meals, fetch
  // the recipe (library → direct → broadcast-recipe API) and save a copy
  // to the user's library. Map the original recipe_id to the new library id
  // so every planner row ends up pointing to the user's own recipe.
  const uniqueRecipeIds = [...new Set(items.map(i => i.recipe_id).filter(Boolean))]
  const recipeIdMap = {} // original_id -> new_library_id
  const diagnostics = [] // human-readable per-recipe outcome

  console.log('[copyBroadcast] unique recipe_ids to import:', uniqueRecipeIds)
  console.log('[copyBroadcast] broadcast.share_token:', broadcast?.share_token)

  // Load user's existing recipes with source tracking so we can dedupe by origin
  // (and fall back to name for recipes imported before the source_recipe_id
  // column existed).
  let userRecipes = []
  {
    const { data } = await supabase
      .from('recipes')
      .select('id, name, source_recipe_id, source_updated_at, update_history, calories, protein, carbs, fat, fiber, sugar, servings, description, instructions, ingredients')
      .eq('user_id', userId)
    userRecipes = data || []
  }
  const initialIds = new Set(userRecipes.map(r => r.id))

  // Helper: compute a list of human-readable changes between two recipe snapshots.
  // Ignores user-only fields (id, user_id, timestamps, notes) and returns e.g.
  // [{field: 'calories', from: 485, to: 520}, {field: 'instructions', from: '3 steps', to: '4 steps'}]
  const diffRecipe = (oldR, newR) => {
    const changes = []
    const macroFields = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'servings']
    for (const f of macroFields) {
      const a = Number(oldR[f] ?? 0)
      const b = Number(newR[f] ?? 0)
      if (Math.abs(a - b) > 0.5) changes.push({ field: f, from: a, to: b })
    }
    if ((oldR.name || '').trim() !== (newR.name || '').trim()) {
      changes.push({ field: 'name', from: oldR.name, to: newR.name })
    }
    if ((oldR.description || '') !== (newR.description || '')) {
      changes.push({ field: 'description', from: oldR.description?.slice(0,40), to: newR.description?.slice(0,40) })
    }
    const oldIngCount = (oldR.ingredients || []).length
    const newIngCount = (newR.ingredients || []).length
    if (oldIngCount !== newIngCount) {
      changes.push({ field: 'ingredients', from: `${oldIngCount} items`, to: `${newIngCount} items` })
    }
    const oldStepCount = oldR.instructions?.steps?.length || 0
    const newStepCount = newR.instructions?.steps?.length || 0
    if (oldStepCount !== newStepCount) {
      changes.push({ field: 'instructions', from: `${oldStepCount} steps`, to: `${newStepCount} steps` })
    }
    return changes
  }

  for (const origId of uniqueRecipeIds) {
    // If the user already owns this exact row (user is importing their own plan), reuse it
    const alreadyOwnsById = userRecipes.find(r => r.id === origId)
    if (alreadyOwnsById) {
      recipeIdMap[origId] = origId
      diagnostics.push({ origId, name: alreadyOwnsById.name, status: 'already-owned' })
      continue
    }

    // Fetch the source recipe (direct read first; may succeed if RLS permits)
    let source = null
    let directErr = null
    {
      const { data, error } = await supabase.from('recipes').select('*').eq('id', origId).maybeSingle()
      if (data) source = data
      if (error) directErr = error
    }

    let apiStatus = null, apiErrBody = null
    // Fall back to the service-role API using the broadcast share_token
    if (!source && broadcast?.share_token) {
      try {
        const url = `/api/broadcast-recipe?broadcast_token=${encodeURIComponent(broadcast.share_token)}&recipe_id=${encodeURIComponent(origId)}`
        const resp = await fetch(url)
        apiStatus = resp.status
        if (resp.ok) {
          source = await resp.json()
        } else {
          apiErrBody = await resp.text().catch(() => '')
        }
      } catch (e) {
        apiErrBody = String(e?.message || e)
      }
    }

    if (!source) {
      diagnostics.push({
        origId,
        name: null,
        status: 'fetch-failed',
        directErr: directErr?.message || null,
        apiStatus,
        apiErrBody: apiErrBody?.slice(0, 200) || null,
      })
      recipeIdMap[origId] = null
      continue
    }

    // Primary dedupe: do we already have a copy of THIS source recipe?
    const existingBySource = userRecipes.find(r => r.source_recipe_id === origId)
    if (existingBySource) {
      // Check if the source has been updated since our last sync. If so,
      // auto-update the mirrored fields and log the diff so the user can see
      // what changed without being surprised by silent shifts.
      const sourceUpdatedAt = source.updated_at
      const lastSyncedAt = existingBySource.source_updated_at
      const needsUpdate = sourceUpdatedAt && (!lastSyncedAt || new Date(sourceUpdatedAt) > new Date(lastSyncedAt))

      if (needsUpdate) {
        const changes = diffRecipe(existingBySource, source)
        if (changes.length > 0) {
          const history = Array.isArray(existingBySource.update_history) ? existingBySource.update_history : []
          const newEntry = { ts: new Date().toISOString(), changes }
          const updatedHistory = [newEntry, ...history].slice(0, 20) // keep last 20 entries
          const updatePayload = {
            name: source.name,
            description: source.description || '',
            servings: source.servings || 4,
            serving_label: source.serving_label || 'serving',
            calories: source.calories || 0,
            protein: source.protein || 0,
            carbs: source.carbs || 0,
            fat: source.fat || 0,
            fiber: source.fiber || 0,
            sugar: source.sugar || 0,
            ingredients: source.ingredients || [],
            instructions: source.instructions || existingBySource.instructions || null,
            source_updated_at: sourceUpdatedAt,
            update_history: updatedHistory,
            updated_at: new Date().toISOString(),
          }
          const { error: updErr } = await supabase
            .from('recipes')
            .update(updatePayload)
            .eq('id', existingBySource.id)
            .eq('user_id', userId)
          if (updErr) {
            diagnostics.push({ origId, name: source.name, status: 'update-failed', insertErr: updErr.message })
          } else {
            diagnostics.push({ origId, name: source.name, status: 'auto-updated', newId: existingBySource.id, changeCount: changes.length })
          }
        } else {
          // Timestamp diverged but nothing meaningful changed — still bump the marker
          await supabase
            .from('recipes')
            .update({ source_updated_at: sourceUpdatedAt })
            .eq('id', existingBySource.id)
            .eq('user_id', userId)
          diagnostics.push({ origId, name: source.name, status: 'dedupe-by-source' })
        }
      } else {
        diagnostics.push({ origId, name: source.name, status: 'dedupe-by-source' })
      }
      recipeIdMap[origId] = existingBySource.id
      continue
    }

    // Legacy fallback: dedupe by name for recipes imported before we tracked
    // source_recipe_id. Adopt the source linkage onto the existing row so
    // future imports use the proper path.
    const existingByName = userRecipes.find(r =>
      !r.source_recipe_id &&
      (r.name || '').trim().toLowerCase() === (source.name || '').trim().toLowerCase()
    )
    if (existingByName) {
      // Quietly backfill source_recipe_id + source_updated_at so next import
      // can detect updates. Don't overwrite any user edits.
      await supabase
        .from('recipes')
        .update({
          source_recipe_id: origId,
          source_updated_at: source.updated_at || null,
        })
        .eq('id', existingByName.id)
        .eq('user_id', userId)
      recipeIdMap[origId] = existingByName.id
      diagnostics.push({ origId, name: source.name, status: 'adopted-by-name' })
      continue
    }

    // Insert a fresh copy into the user's library
    try {
      const { share_token, is_shared, id, user_id, created_at, updated_at, ...fields } = source
      const payload = {
        ...fields,
        user_id: userId,
        share_token: null,
        is_shared: false,
        source_recipe_id: origId,
        source_updated_at: source.updated_at || null,
        update_history: [],
      }
      const { data: inserted, error: insErr } = await supabase
        .from('recipes')
        .insert(payload)
        .select('id, name')
        .single()
      if (insErr || !inserted) {
        // If the source_recipe_id column doesn't exist yet (user hasn't run
        // the migration), retry without the new fields
        if (insErr?.message?.includes('source_recipe_id') || insErr?.message?.includes('update_history')) {
          const { source_recipe_id, source_updated_at, update_history, ...legacy } = payload
          const { data: inserted2, error: insErr2 } = await supabase
            .from('recipes')
            .insert(legacy)
            .select('id, name')
            .single()
          if (inserted2) {
            recipeIdMap[origId] = inserted2.id
            userRecipes.push(inserted2)
            diagnostics.push({ origId, name: inserted2.name, status: 'imported-legacy', newId: inserted2.id })
            continue
          }
          diagnostics.push({ origId, name: source.name, status: 'insert-failed', insertErr: insErr2?.message || insErr.message })
          recipeIdMap[origId] = null
        } else {
          diagnostics.push({ origId, name: source.name, status: 'insert-failed', insertErr: insErr?.message || 'no data returned' })
          recipeIdMap[origId] = null
        }
      } else {
        recipeIdMap[origId] = inserted.id
        userRecipes.push(inserted)
        diagnostics.push({ origId, name: inserted.name, status: 'imported', newId: inserted.id })
      }
    } catch (e) {
      diagnostics.push({ origId, name: source.name, status: 'insert-threw', insertErr: String(e?.message || e) })
      recipeIdMap[origId] = null
    }
  }

  console.log('[copyBroadcast] final recipeIdMap:', recipeIdMap)

  // One meal per day, sequential from the start date.
  // Users can reorder meals on the planner after the copy.
  const [stY, stM, stD] = startDate.split('-').map(Number)
  const startDateObj = new Date(stY, stM - 1, stD)

  const pad = n => String(n).padStart(2, '0')
  const ds = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`

  const rows = items.map((item, i) => {
    const actualDate = new Date(startDateObj)
    actualDate.setDate(actualDate.getDate() + i)
    const actualDateStr = ds(actualDate)

    // Compute the Sunday-based week this date belongs to
    const dayIdx = actualDate.getDay()
    const weekStartForRow = new Date(actualDate)
    weekStartForRow.setDate(weekStartForRow.getDate() - dayIdx)
    const weekStartStr = ds(weekStartForRow)

    const name = item.meal_name || item._name || item.recipe_name || 'Meal'

    // Use the user's own recipe id if we managed to copy it, otherwise null
    const linkedRecipeId = item.recipe_id ? (recipeIdMap[item.recipe_id] ?? null) : null

    return {
      user_id: userId,
      week_start_date: weekStartStr,
      day_of_week: dayIdx,
      actual_date: actualDateStr,
      meal_name: name,
      calories: Number(item.calories ?? item._calories ?? 0),
      protein: Number(item.protein ?? 0),
      carbs: Number(item.carbs ?? 0),
      fat: Number(item.fat ?? 0),
      fiber: Number(item.fiber ?? 0),
      is_leftover: !!item.is_leftover,
      planned_servings: item.planned_servings ?? 1,
      recipe_id: linkedRecipeId,
      meal_type: item.meal_type || null,
    }
  })

  const { data, error } = await supabase.from('meal_planner').insert(rows).select()
  if (error) throw error

  // Count only the recipe ids that weren't in the user's library before this copy
  const recipesAdded = Object.values(recipeIdMap).filter(id => id && !initialIds.has(id)).length
  const recipesUpdated = diagnostics.filter(d => d.status === 'auto-updated').length
  return { mealsCopied: rows.length, recipesAdded, recipesUpdated, diagnostics }
}

// ─── Personal meal plan shares ──────────────────────────────────────────────
//
// Distinct from provider broadcasts: any user can share a single week of
// their planner via a private link. The shared snapshot is self-contained
// (recipes embedded in plan_data) so the public landing page doesn't need
// any cross-user RLS gymnastics.

function _shortShareToken() {
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8)
}

// Snapshots one week of the user's planner into the structure that the share
// page + copy flow consumes. weekStart is the Sunday of the target week.
export async function createMealPlanShare(userId, weekStart, label = null) {
  if (!supabase) return null

  // Fetch the planner rows for this week.
  const weekEnd = (() => {
    const d = new Date(weekStart + 'T00:00:00')
    d.setDate(d.getDate() + 6)
    return d.toISOString().slice(0, 10)
  })()
  const { data: meals, error: mErr } = await supabase
    .from('meal_planner')
    .select('id, day_of_week, meal_type, meal_name, planned_servings, is_leftover, recipe_id, actual_date')
    .eq('user_id', userId)
    .gte('actual_date', weekStart)
    .lte('actual_date', weekEnd)
    .order('actual_date', { ascending: true })
  if (mErr) throw mErr
  if (!meals?.length) throw new Error('No meals planned for that week')

  // Pull the referenced recipes (just the user's own — RLS already enforces).
  const recipeIds = [...new Set(meals.map(m => m.recipe_id).filter(Boolean))]
  let recipesById = {}
  if (recipeIds.length) {
    const { data: rs } = await supabase
      .from('recipes')
      .select('id, name, servings, ingredients, instructions, calories, protein, carbs, fat, fiber, sugar, description, tags, source_url')
      .in('id', recipeIds)
      .eq('user_id', userId)
    recipesById = Object.fromEntries((rs || []).map(r => [r.id, r]))
  }

  // Build the snapshot. Each item embeds the recipe inline so the share is
  // self-contained — recipient doesn't need to hit the owner's row.
  const plan_data = meals.map(m => {
    const r = m.recipe_id ? recipesById[m.recipe_id] : null
    return {
      day_of_week: m.day_of_week,
      meal_type: m.meal_type,
      meal_name: m.meal_name,
      planned_servings: m.planned_servings,
      is_leftover: !!m.is_leftover,
      actual_date: m.actual_date,
      recipe_id: m.recipe_id,
      recipe_snapshot: r ? {
        name: r.name,
        servings: r.servings,
        ingredients: r.ingredients,
        instructions: r.instructions,
        calories: r.calories,
        protein: r.protein,
        carbs: r.carbs,
        fat: r.fat,
        fiber: r.fiber,
        sugar: r.sugar,
        description: r.description,
        tags: r.tags,
        source_url: r.source_url,
      } : null,
    }
  })

  const share_token = _shortShareToken()
  const { data, error } = await supabase
    .from('meal_plan_shares')
    .insert({
      owner_user_id: userId,
      share_token,
      week_start: weekStart,
      label: label || null,
      plan_data,
      is_active: true,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// Public read by token. RLS allows anon + authenticated to select active rows.
// We don't auto-embed user_profiles here — there's no FK between
// meal_plan_shares.owner_user_id and user_profiles, and user_profiles RLS
// would block the join anyway from a logged-out recipient. The /api/share
// landing page does a separate service-role lookup; the in-app copy modal
// falls back to a generic owner label.
export async function getMealPlanShareByToken(token) {
  if (!supabase) return null
  const { data } = await supabase
    .from('meal_plan_shares')
    .select('*')
    .eq('share_token', token)
    .eq('is_active', true)
    .maybeSingle()
  if (!data) return null
  // Best-effort owner name lookup (RLS may block — that's fine, we just
  // fall back to a generic label in the UI).
  try {
    const { data: prof } = await supabase
      .from('user_profiles')
      .select('provider_name')
      .eq('user_id', data.owner_user_id)
      .maybeSingle()
    data.user_profiles = prof || null
  } catch {
    data.user_profiles = null
  }
  return data
}

export async function getMyMealPlanShares(userId) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('meal_plan_shares')
    .select('id, share_token, week_start, label, is_active, created_at')
    .eq('owner_user_id', userId)
    .order('created_at', { ascending: false })
  if (error) return []
  return data ?? []
}

export async function revokeMealPlanShare(userId, shareId) {
  if (!supabase) return
  const { error } = await supabase
    .from('meal_plan_shares')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', shareId)
    .eq('owner_user_id', userId)
  if (error) throw error
}

// Copy a personal meal-plan share into the recipient's planner.
//
//   share          → the row from getMealPlanShareByToken
//   targetWeekStart→ Sunday of the recipient's destination week
//   saveRecipeIdx  → Set<number> of plan_data indices whose recipes the
//                    recipient opted to import into their library. Indices
//                    not in the set get a planner row with recipe_id=null
//                    (just the meal name) plus from_share_token/index so
//                    they can save the recipe later from the planner row.
export async function copyMealPlanShareToPlanner(userId, share, targetWeekStart, saveRecipeIdx = null) {
  if (!supabase || !share?.plan_data?.length) return { mealsCopied: 0, recipesAdded: 0 }

  const items = share.plan_data
  const saveSet = saveRecipeIdx instanceof Set ? saveRecipeIdx : new Set(saveRecipeIdx || [])

  // Pre-load the recipient's existing recipes so we can dedupe by source_recipe_id
  // and avoid double-importing if the recipient hits the same share twice.
  const { data: existing } = await supabase
    .from('recipes')
    .select('id, source_recipe_id, name')
    .eq('user_id', userId)
  const existingBySource = {}
  for (const r of existing || []) {
    if (r.source_recipe_id) existingBySource[r.source_recipe_id] = r.id
  }

  // Import recipes the user wants to save. Map plan_data index → new recipe id.
  const importedRecipeIdByIdx = {}
  let recipesAdded = 0
  for (let i = 0; i < items.length; i++) {
    if (!saveSet.has(i)) continue
    const item = items[i]
    const snap = item.recipe_snapshot
    if (!snap) continue
    if (item.recipe_id && existingBySource[item.recipe_id]) {
      importedRecipeIdByIdx[i] = existingBySource[item.recipe_id]
      continue
    }
    const { data: created, error: rErr } = await supabase
      .from('recipes')
      .insert({
        user_id: userId,
        name: snap.name,
        servings: snap.servings || 1,
        ingredients: snap.ingredients || [],
        instructions: snap.instructions || null,
        calories: snap.calories,
        protein: snap.protein,
        carbs: snap.carbs,
        fat: snap.fat,
        fiber: snap.fiber,
        sugar: snap.sugar,
        description: snap.description,
        tags: snap.tags || [],
        source_url: snap.source_url,
        source_recipe_id: item.recipe_id || null,
      })
      .select('id')
      .single()
    if (rErr) {
      console.warn('[copyMealPlanShare] recipe insert failed:', rErr.message)
      continue
    }
    importedRecipeIdByIdx[i] = created.id
    recipesAdded += 1
  }

  // Build planner rows. day_of_week is preserved from the share so meals land
  // on the same weekday in the recipient's target week. week_start_date is
  // the Sunday-of-week that meal_planner uses as its primary grouping key,
  // so meals from different rows still cluster correctly even when
  // targetWeekStart isn't a Sunday.
  const targetStart = new Date(targetWeekStart + 'T00:00:00')
  const rows = items.map((item, i) => {
    const dow = item.day_of_week ?? 0
    const d = new Date(targetStart); d.setDate(d.getDate() + dow)
    const actual_date = d.toISOString().slice(0, 10)
    // Sunday of the actual_date's week (matches getWeekStart() in app.js).
    const sunday = new Date(d); sunday.setDate(sunday.getDate() - sunday.getDay())
    const week_start_date = sunday.toISOString().slice(0, 10)
    const recipeId = importedRecipeIdByIdx[i] || null
    const snap = item.recipe_snapshot || {}
    return {
      user_id: userId,
      week_start_date,
      actual_date,
      day_of_week: dow,
      meal_type: item.meal_type || null,
      meal_name: item.meal_name || snap.name || 'Meal',
      planned_servings: item.planned_servings ?? 1,
      is_leftover: !!item.is_leftover,
      recipe_id: recipeId,
      // Carry macros from the snapshot so calorie / protein totals on the
      // recipient's planner work even if they didn't import the recipe.
      calories: snap.calories ?? null,
      protein: snap.protein ?? null,
      carbs: snap.carbs ?? null,
      fat: snap.fat ?? null,
      fiber: snap.fiber ?? null,
      // Provenance: only stamp these when we DIDN'T import the recipe, so
      // the planner row knows it can offer a "save recipe from share" link.
      from_share_token: recipeId ? null : share.share_token,
      from_share_index: recipeId ? null : i,
    }
  })

  const { data: inserted, error } = await supabase
    .from('meal_planner')
    .insert(rows)
    .select()
  if (error) throw error

  return { mealsCopied: inserted?.length || 0, recipesAdded }
}

// Late-import a recipe from the share that produced a given planner row.
// Used when the recipient skipped saving the recipe at copy time and later
// changes their mind from the planner.
//
// Two-step: insert into recipes (deduping by source_recipe_id), then update
// the planner row to point at the new recipe and clear the from_share_*
// provenance columns. Returns the imported recipe row so the UI can refresh
// state.recipes without a full reload.
/// Self-service account deletion. Calls the SECURITY DEFINER RPC
/// public.delete_my_account, which removes every public-schema row
/// owned by the user and the auth.users entry itself. Caller must
/// be the authenticated user — the function checks auth.uid().
///
/// Returns when the delete completes; the caller is responsible for
/// signing out + navigating away (the JWT is still valid for a few
/// seconds after the row is gone, so explicit signOut is cleanest).
export async function deleteMyAccount() {
  if (!supabase) throw new Error('No backend')
  const { error } = await supabase.rpc('delete_my_account')
  if (error) throw error
}

// ─── Identity linking ────────────────────────────────────────────────────────
//
// Lets a signed-in user attach a second sign-in provider (today: Google) to
// their existing auth.users row. Same user_id, multiple `auth.identities`
// rows. Solves "I signed up with email; how do I sign in with Google later?"
// and the iOS-Apple → desktop-Google use case.
//
// Requires `Manual Linking` to be enabled in Supabase Auth settings (off
// by default). With it off, linkIdentity returns an
// `manual_linking_disabled` error.

export async function getMyIdentities() {
  if (!supabase) return []
  const { data, error } = await supabase.auth.getUserIdentities()
  if (error) {
    console.warn('[identities] fetch failed:', error.message)
    return []
  }
  return data?.identities ?? []
}

export async function linkGoogleIdentity(redirectTo) {
  if (!supabase) throw new Error('No backend')
  const { data, error } = await supabase.auth.linkIdentity({
    provider: 'google',
    options: redirectTo ? { redirectTo } : undefined,
  })
  if (error) throw error
  // Supabase JS returns the OAuth URL but doesn't auto-navigate. We hand
  // it back so the caller can decide between window.location.href (web)
  // and ASWebAuthenticationSession (eventual native flow).
  return data
}

export async function unlinkIdentity(identityOrId) {
  if (!supabase) throw new Error('No backend')
  // unlinkIdentity expects the full identity object (it reads .id and
  // .user_id internally). Callers pass identity objects from
  // getMyIdentities; we accept either an object or an id string and
  // resolve to the object if needed.
  let identity = identityOrId
  if (typeof identityOrId === 'string') {
    const all = await getMyIdentities()
    identity = all.find(i => i.identity_id === identityOrId || i.id === identityOrId)
    if (!identity) throw new Error('Identity not found')
  }
  const { error } = await supabase.auth.unlinkIdentity(identity)
  if (error) throw error
}

export async function saveSharedRecipeFromPlannerRow(userId, plannerMealId) {
  if (!supabase) return null

  // Pull the planner row's provenance.
  const { data: meal, error: mErr } = await supabase
    .from('meal_planner')
    .select('id, from_share_token, from_share_index')
    .eq('id', plannerMealId)
    .eq('user_id', userId)
    .maybeSingle()
  if (mErr) throw mErr
  if (!meal?.from_share_token || meal.from_share_index == null) {
    throw new Error('This meal is not linked to a share')
  }

  // Resolve the recipe snapshot from the share.
  const share = await getMealPlanShareByToken(meal.from_share_token)
  if (!share) throw new Error('The original share is no longer active')
  const item = (share.plan_data || [])[meal.from_share_index]
  const snap = item?.recipe_snapshot
  if (!snap) throw new Error('The original share has no recipe for this meal')

  // Dedupe: if user already imported this exact source_recipe_id, reuse.
  let recipe
  if (item.recipe_id) {
    const { data: existing } = await supabase
      .from('recipes')
      .select('*')
      .eq('user_id', userId)
      .eq('source_recipe_id', item.recipe_id)
      .maybeSingle()
    if (existing) recipe = existing
  }

  if (!recipe) {
    const { data: created, error: rErr } = await supabase
      .from('recipes')
      .insert({
        user_id: userId,
        name: snap.name,
        servings: snap.servings || 1,
        ingredients: snap.ingredients || [],
        instructions: snap.instructions || null,
        calories: snap.calories,
        protein: snap.protein,
        carbs: snap.carbs,
        fat: snap.fat,
        fiber: snap.fiber,
        sugar: snap.sugar,
        description: snap.description,
        tags: snap.tags || [],
        source_url: snap.source_url,
        source_recipe_id: item.recipe_id || null,
      })
      .select()
      .single()
    if (rErr) throw rErr
    recipe = created
  }

  // Re-point the planner row at the imported recipe and drop provenance.
  const { error: uErr } = await supabase
    .from('meal_planner')
    .update({ recipe_id: recipe.id, from_share_token: null, from_share_index: null })
    .eq('id', plannerMealId)
    .eq('user_id', userId)
  if (uErr) throw uErr

  return recipe
}

// ─── Generic foods (USDA reference data) ─────────────────────────────────────

/**
 * Search the public.generic_foods table for a query string. The table is
 * USDA FoodData Central reference data, populated by
 * scripts/import-usda-foods.js. Read-only for all authenticated users.
 *
 * Quick Log calls this BEFORE the AI describe fallback so common foods
 * (banana, avocado, oats, …) skip the Claude roundtrip and just log
 * directly with the USDA macros.
 *
 * Calls the `search_generic_foods_ranked` RPC, which applies the composite
 * Quick Log ranking server-side: exact-prefix(1000) + substring(100) +
 * global_log_count when ≥5 distinct users have logged it + USDA Foundation
 * bonus (50). Tiebreaker is name ASC. Mirrors iOS QuickLogSection.
 */
export async function searchGenericFoods(query, limit = 8) {
  if (!supabase || !query?.trim()) return []
  const { data, error } = await supabase.rpc('search_generic_foods_ranked', {
    p_query: query.trim(),
    p_limit: limit,
  })
  if (error) throw error
  return data || []
}

/**
 * Search the user's own food_items library via the matching RPC, which
 * applies the composite Quick Log formula server-side: exact-prefix(1000)
 * + substring(100) + user_log_count_last_30d (×10) + global_log_count
 * when ≥5 distinct users have logged it. Tiebreaker is name ASC.
 * Substring match runs against name OR brand. Returns rows already sorted.
 */
export async function searchFoodItemsRanked(query, limit = 10) {
  if (!supabase || !query?.trim()) return []
  const { data, error } = await supabase.rpc('search_food_items_ranked', {
    p_query: query.trim(),
    p_limit: limit,
  })
  if (error) throw error
  return data || []
}

