import { supabase } from './supabase.js'

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
    const newEntry = { ...entry, id: Date.now(), logged_at: new Date().toISOString() }
    all.unshift(newEntry)
    setLocalFallback('macrolens_log', all)
    return newEntry
  }
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
      logged_at: new Date().toISOString()
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
    supabase.from('user_profiles').select('spending_limit_usd, total_spent_usd, is_admin, unlimited_access, account_status, role, is_provider, provider_name, provider_slug, provider_bio, provider_specialty, provider_avatar_url').eq('user_id', userId).maybeSingle(),
    supabase.from('token_usage').select('cost_usd, tokens_used, feature').eq('user_id', userId).gte('created_at', startOfMonth.toISOString())
  ])

  const profile = profileRes.data ?? {}
  const usage = usageRes.data ?? []
  const monthSpent = usage.reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0)
  const monthTokens = usage.reduce((s, r) => s + (r.tokens_used || 0), 0)
  const limit = profile.spending_limit_usd ?? 10
  const role = profile.role || (profile.is_admin ? 'admin' : profile.unlimited_access ? 'premium' : 'free')
  const isUnlimited = role === 'admin' || role === 'premium' || role === 'dietitian' || profile.unlimited_access

  return {
    spent: Math.round(monthSpent * 10000) / 10000,
    limit: isUnlimited ? null : limit,
    remaining: isUnlimited ? null : Math.max(0, limit - monthSpent),
    totalSpent: profile.total_spent_usd ?? 0,
    tokens: monthTokens,
    requests: usage.length,
    isAdmin: role === 'admin' || profile.is_admin || false,
    isDietitian: role === 'dietitian',
    isPremium: isUnlimited,
    isFree: role === 'free' && !isUnlimited,
    isProvider: profile.is_provider || false,
    providerName: profile.provider_name || null,
    providerSlug: profile.provider_slug || null,
    providerBio: profile.provider_bio || null,
    providerSpecialty: profile.provider_specialty || null,
    providerAvatarUrl: profile.provider_avatar_url || null,
    role,
    isUnlimited,
    accountStatus: profile.account_status ?? 'active',
    breakdown: usage.reduce((acc, r) => {
      acc[r.feature] = (acc[r.feature] || 0) + (parseFloat(r.cost_usd) || 0)
      return acc
    }, {})
  }
}

// Admin only — get all users
export async function getAdminUserOverview() {
  if (!supabase) return []
  const { data, error } = await supabase.from('admin_user_overview').select('*').order('spent_this_month_usd', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function setUserRole(userId, role) {
  if (!supabase) return
  const isAdmin = role === 'admin'
  const unlimitedAccess = role !== 'free'
  const { error } = await supabase.from('user_profiles')
    .update({ role, is_admin: isAdmin, unlimited_access: unlimitedAccess })
    .eq('user_id', userId)
  if (error) throw error
}

export async function setUserPrivileges(userId, { isAdmin, unlimitedAccess, spendingLimitUsd, accountStatus }) {
  if (!supabase) return
  const updates = {}
  if (isAdmin !== undefined) updates.is_admin = isAdmin
  if (unlimitedAccess !== undefined) updates.unlimited_access = unlimitedAccess
  if (spendingLimitUsd !== undefined) updates.spending_limit_usd = spendingLimitUsd
  if (accountStatus !== undefined) updates.account_status = accountStatus
  const { error } = await supabase.from('user_profiles').update(updates).eq('user_id', userId)
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
    // Schema cache lag — strip only the specific column causing the error and retry
    if (err.message?.includes("'recipes'")) {
      const stripped = { ...payload }
      if (err.message?.includes('source_url')) delete stripped.source_url
      if (err.message?.includes('notes') && !err.message?.includes('ai_notes')) delete stripped.notes
      // Never strip instructions — it's the most important field to persist
      return await tryUpsert(stripped)
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
    .select('id, instructions')
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

export async function getCheckins(userId, limit = 52) {
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

export async function generateShareToken(userId, recipeId) {
  if (!supabase) return null
  // Generate a UUID token and make recipe public
  const token = crypto.randomUUID()
  const { data, error } = await supabase
    .from('recipes')
    .update({ share_token: token, is_public: true })
    .eq('id', recipeId)
    .eq('user_id', userId)
    .select('share_token')
    .single()
  if (error) throw error
  return data.share_token
}

export async function getRecipeByShareToken(token) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .eq('share_token', token)
    .eq('is_public', true)
    .single()
  if (error) return null
  return data
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

// ─── Recipe Sharing ───────────────────────────────────────────────────────────

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

export async function saveProviderProfile(userId, { provider_name, provider_bio, provider_specialty, provider_slug, provider_avatar_url }) {
  if (!supabase) return
  const updates = {}
  if (provider_name !== undefined) updates.provider_name = provider_name
  if (provider_bio !== undefined) updates.provider_bio = provider_bio
  if (provider_specialty !== undefined) updates.provider_specialty = provider_specialty
  if (provider_slug !== undefined) updates.provider_slug = provider_slug
  if (provider_avatar_url !== undefined) updates.provider_avatar_url = provider_avatar_url
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

export async function getProviders() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('user_profiles')
    .select('user_id, provider_name, provider_bio, provider_slug, provider_specialty, provider_avatar_url, role, email')
    .eq('is_provider', true)
    .order('provider_name')
  if (error) throw error
  return data ?? []
}

export async function getProviderBySlug(slug) {
  if (!supabase) return null
  const { data } = await supabase
    .from('user_profiles')
    .select('user_id, provider_name, provider_bio, provider_slug, provider_specialty, role')
    .eq('provider_slug', slug)
    .eq('is_provider', true)
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
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('user_id, provider_name, provider_bio, provider_slug, provider_specialty, role')
    .in('user_id', ids)
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

  // Load the user's existing recipes once to dedupe by name.
  // Freeze the set of initial ids so we can later count how many were newly added.
  let userRecipes = []
  {
    const { data } = await supabase.from('recipes').select('id, name').eq('user_id', userId)
    userRecipes = data || []
  }
  const initialIds = new Set(userRecipes.map(r => r.id))

  for (const origId of uniqueRecipeIds) {
    // If the user already owns this exact row (unlikely but possible), reuse it
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

    // Dedupe by name: if the user already has a recipe with this exact name,
    // reuse it instead of making duplicates on repeat copies of the same plan
    const existingByName = userRecipes.find(r =>
      (r.name || '').trim().toLowerCase() === (source.name || '').trim().toLowerCase()
    )
    if (existingByName) {
      recipeIdMap[origId] = existingByName.id
      diagnostics.push({ origId, name: source.name, status: 'dedupe-by-name' })
      continue
    }

    // Insert a fresh copy into the user's library
    try {
      const { share_token, is_shared, is_public, id, user_id, created_at, updated_at, ...fields } = source
      const payload = { ...fields, user_id: userId, share_token: null, is_shared: false, is_public: false }
      const { data: inserted, error: insErr } = await supabase
        .from('recipes')
        .insert(payload)
        .select('id, name')
        .single()
      if (insErr || !inserted) {
        diagnostics.push({ origId, name: source.name, status: 'insert-failed', insertErr: insErr?.message || 'no data returned' })
        recipeIdMap[origId] = null
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
  return { mealsCopied: rows.length, recipesAdded, diagnostics }
}
