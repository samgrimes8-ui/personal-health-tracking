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
    .upsert({ user_id: userId, ...goals, updated_at: new Date().toISOString() })
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
    supabase.from('user_profiles').select('spending_limit_usd, total_spent_usd, is_admin, unlimited_access, account_status').eq('user_id', userId).maybeSingle(),
    supabase.from('token_usage').select('cost_usd, tokens_used, feature').eq('user_id', userId).gte('created_at', startOfMonth.toISOString())
  ])

  const profile = profileRes.data ?? {}
  const usage = usageRes.data ?? []
  const monthSpent = usage.reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0)
  const monthTokens = usage.reduce((s, r) => s + (r.tokens_used || 0), 0)
  const limit = profile.spending_limit_usd ?? 10
  const isUnlimited = profile.is_admin || profile.unlimited_access

  return {
    spent: Math.round(monthSpent * 10000) / 10000,
    limit: isUnlimited ? null : limit,
    remaining: isUnlimited ? null : Math.max(0, limit - monthSpent),
    totalSpent: profile.total_spent_usd ?? 0,
    tokens: monthTokens,
    requests: usage.length,
    isAdmin: profile.is_admin ?? false,
    isUnlimited: isUnlimited ?? false,
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
  const { error } = await supabase
    .from('recipes')
    .update({ instructions, updated_at: new Date().toISOString() })
    .eq('id', recipeId)
    .eq('user_id', userId)
  if (error) throw error
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
