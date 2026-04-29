import { signOut } from '../lib/auth.js'
import {
  getGoals, saveGoals as dbSaveGoals,
  getMealLog, addMealEntry, updateMealEntry, deleteMealEntry,
  getPlannerWeek, addPlannerMeal, updatePlannerMeal, deletePlannerMeal, movePlannerMeal,
  getUsageSummary, getAdminUserOverview, setUserPrivileges,
  getRecipes, upsertRecipe, deleteRecipe, getRecipeByName,
  getWeeksWithMeals, getPlannerRange,
  getFoodItems, upsertFoodItem, deleteFoodItem,
  saveRecipeInstructions, autoSaveFoodItem,
  logError, cleanupOldErrors, getErrorLogs, getAllErrorLogs,
  getBodyMetrics, saveBodyMetrics, getCheckins, saveCheckin, deleteCheckin, uploadScanFile, getScanUrl,
  generateShareToken,
  enableRecipeSharing, disableRecipeSharing, getSharedRecipe, saveSharedRecipeToLibrary, getRecipeByIdPublic,
  saveRecipeOgCache, setUserRole, clearSpendingOverride, hideTagPreset, unhideTagPreset,
  getIngredientSynonyms, saveIngredientSynonyms, deleteIngredientSynonyms,
  getProviders, getProviderBroadcasts, saveBroadcast, deleteBroadcast,
  followProvider, unfollowProvider, getFollowedProviders, isFollowingProvider,
  getFollowerCount, copyBroadcastToPlanner, saveProviderProfile, uploadProviderAvatar
} from '../lib/db.js'
import { TIERS, nextTierFromRole, formatBucks, bucksCount, usdToBucks } from '../lib/pricing.js'
import { categorizeByName, parseAmount, canonicalizeName } from '../lib/categorize.js'
import {
  analyzePhoto, analyzeRecipe, analyzeRecipePhoto, analyzeDishBySearch, analyzePlannerDescription,
  classifyFoodPhoto,
  extractIngredients, recalculateMacros, analyzeFoodItem, analyzeNutritionLabel,
  generateRecipeInstructions, extractBodyScan, fetchOgMetadata, readBarcodeFromImage,
  extractRecipeFromPhoto, generateRecipeFromMood, dedupGroceryNames,
  fetchRecipeAudio
} from '../lib/ai.js'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Preset recipe tags shown as suggestions in the editor + always visible
// in the filter pills on the recipes page. Users can also create custom
// tags on top of these.
// Tag presets shown as quick-suggestions when tagging a new recipe.
// Deliberately short and opinion-light: meal categories + the three
// most-cooked proteins + a single veg option. Anything else users want
// (Crockpot, Gluten-Free, Summer, High-Protein, etc) they can type as
// a custom tag — those still work, they're just not suggested up front.
//
// Kept short because the previous 19-item list was clutter: it tried to
// cover every possible cooking equipment, season, and diet, which meant
// most users saw a wall of suggestions they'd never use.
const RECIPE_TAG_PRESETS = [
  'Breakfast', 'Lunch', 'Dinner', 'Snack',
  'Chicken', 'Beef', 'Fish', 'Vegetarian',
]

// Returns the preset tags this user sees, after filtering out any
// they've manually hidden via the Manage Tags modal. All tag-related
// UI (picker chips, Manage Tags rows, etc) calls this rather than
// reading RECIPE_TAG_PRESETS directly.
function getVisiblePresets() {
  const hidden = (state.usage?.hiddenTagPresets || []).map(s => s.toLowerCase())
  if (!hidden.length) return RECIPE_TAG_PRESETS
  return RECIPE_TAG_PRESETS.filter(p => !hidden.includes(p.toLowerCase()))
}

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  user: null,
  goals: { calories: 2000, protein: 150, carbs: 200, fat: 65 },
  log: [],
  recipes: [],
  foodItems: [],
  bodyMetrics: null,
  checkins: [],
  providers: [],
  followedProviders: [],
  myBroadcasts: [],
  recipeMode: 'write',    // 'write' | 'snap'  (link input merged into 'write')
  units: null, // set on init from locale
  newUsersCount: 0,
  editingFoodItem: null,
  editingComponents: null,
  pendingComponent: null,
  foodSearch: '',
  recipeSearch: '',
  recipeActiveTag: '', // '' = all recipes; otherwise filter to that tag
  providerSearch: '',
  providersTab: 'browse', // 'browse' | 'mychannel' — tabs shown only for users with a provider channel
  analyticsRange: 30, // default range for analytics page (days)
  planner: { meals: Array(7).fill(null).map(() => []) },
  usage: { spent: 0, limit: 10, remaining: 10, tokens: 0, requests: 0, isAdmin: false, isUnlimited: false, isProvider: false },
  currentPage: 'log',
  currentMode: 'food',
  foodMode: 'search',     // 'search' | 'photo'  (photo auto-detects barcode/label/meal)
  foodPhotoStatus: 'idle', // 'idle' | 'processing' | 'ready-label' | 'ready-food' | 'done-barcode'
  imageBase64: null,
  labelImageBase64: null,
  recipeImageBase64: null, // photo of recipe card / cookbook page / screenshot
  currentEntry: null,
  editingEntry: null,
  editingBaseMacros: null,
  editingMealType: null,
  planningRecipe: null,
  plannerTarget: null,
  plannerTab: 'history',
  plannerView: 'meals',
  groceryView: 'full',
  groceryItems: null,
  groceryCustomItems: [],
  groceryFromDate: null,  // null = today
  groceryToDate: null,    // null = end of furthest planned week
  mealServings: {},
  excludedIngredients: new Set(),
  aiPlannerResult: null,
  weekStart: getWeekStart(),
  weeksWithMeals: [],
  showCalendar: false,
  calendarMonth: null,
  // apiKey moved server-side — no longer needed in client
  editingRecipe: null,
  recipeTab: 'ingredients',
  recipeServings: null, // 'ingredients' | 'instructions'  // recipe being edited in modal
  cookingMode: null, // { recipeId, stepIndex } when in read-aloud mode; null otherwise
  cookingVoiceOff: localStorage.getItem('macrolens_voice_off') === '1', // silent step-through mode
}

// Safe local date string — avoids UTC timezone shift from toISOString()
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function getWeekStart() {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay())
  return localDateStr(d)
}

let _appInitialized = false

// ─── Init ─────────────────────────────────────────────────────────────────────
export async function initApp(user, container) {
  state.user = user

  // Global error handler — captures unhandled errors and logs to DB
  if (!window._errorHandlerInstalled) {
    window._errorHandlerInstalled = true
    window.addEventListener('error', (e) => {
      logError(state.user?.id, e.error || e.message, {
        context: 'unhandled_error',
        page: state.currentPage,
      }).catch(() => {})
    })
    window.addEventListener('unhandledrejection', (e) => {
      logError(state.user?.id, e.reason, {
        context: 'unhandled_promise',
        page: state.currentPage,
      }).catch(() => {})
    })
  }

  // Run cleanup once per session (not every page nav)
  if (!window._errorCleanupRan) {
    window._errorCleanupRan = true
    cleanupOldErrors().catch(() => {})
  }
  try {
    await Promise.race([
      loadAll(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Load timeout')), 12000))
    ])
  } catch (err) {
    console.warn('loadAll failed or timed out:', err.message)
    // Set safe defaults so the app still renders
    state.goals = state.goals || { calories: 2000, protein: 150, carbs: 200, fat: 65 }
    state.log = state.log || []
    state.recipes = state.recipes || []
    state.foodItems = state.foodItems || []
    state.weeksWithMeals = state.weeksWithMeals || []
  }
  if (!_appInitialized) {
    // Restore page BEFORE renderShell so nav active class is correct on first render
    const savedPage = sessionStorage.getItem('macrolens_page')
    const validPages = ['log','analytics','planner','history','goals','recipes','foods','account','providers']
    if (savedPage && validPages.includes(savedPage)) state.currentPage = savedPage
    renderShell(container)
    wireGlobals()
    _appInitialized = true
  }
  // Also sync on re-init (auth refresh etc) without full shell re-render
  const savedPage = sessionStorage.getItem('macrolens_page')
  const validPages = ['log','analytics','planner','history','goals','recipes','foods','account','providers']
  if (savedPage && validPages.includes(savedPage)) state.currentPage = savedPage
  renderPage()
  // Load new user badge for admins (background, non-blocking)
  if (state.usage?.isAdmin) {
    getAdminUserOverview().then(users => {
      const now = new Date()
      state.newUsersCount = users.filter(u => {
        if (!u.created_at) return false
        return (now - new Date(u.created_at)) < 7 * 24 * 60 * 60 * 1000
      }).length
      // Re-render just the nav badge
      const navAccount = document.getElementById('nav-account')
      if (navAccount && state.newUsersCount > 0) {
        const badge = navAccount.querySelector('span[style*="border-radius:999px"]')
        if (!badge) {
          const b = document.createElement('span')
          b.style.cssText = 'position:absolute;top:4px;right:4px;background:var(--red);color:white;border-radius:999px;font-size:9px;font-weight:700;padding:1px 5px;min-width:16px;text-align:center'
          b.textContent = state.newUsersCount
          navAccount.style.position = 'relative'
          navAccount.appendChild(b)
        }
      }
    }).catch(() => {})
  }
}

async function loadAll() {
  const safe = (fn) => fn().catch(err => { console.warn('loadAll partial failure:', err.message); return null })

  const [goals, log, usage, recipes, weeksWithMeals, foodItems, todayPlanner, bodyMetrics, checkins, providers, followedProviders, synonyms] = await Promise.all([
    safe(() => getGoals(state.user.id)),
    safe(() => getMealLog(state.user.id, { limit: 300 })),
    safe(() => getUsageSummary(state.user.id)),
    safe(() => getRecipes(state.user.id)),
    safe(() => getWeeksWithMeals(state.user.id)),
    safe(() => getFoodItems(state.user.id)),
    safe(() => getPlannerWeek(state.user.id, getWeekStart())),
    safe(() => getBodyMetrics(state.user.id)),
    safe(() => getCheckins(state.user.id)),
    safe(() => getProviders()),
    safe(() => getFollowedProviders(state.user.id)),
    safe(() => getIngredientSynonyms(state.user.id)),
  ])
  state.goals = { calories: goals?.calories ?? 2000, protein: goals?.protein ?? 150, carbs: goals?.carbs ?? 200, fat: goals?.fat ?? 65 }
  state.log = log ?? []
  state.usage = usage
  state.recipes = recipes ?? []
  state.weeksWithMeals = weeksWithMeals ?? []
  state.foodItems = foodItems ?? []
  if (todayPlanner) state.planner = todayPlanner
  state.bodyMetrics = bodyMetrics
  state.checkins = checkins ?? []
  state.providers = providers ?? []
  state.followedProviders = followedProviders ?? []
  // Build synonyms lookup map: { from_name → to_name } for sumIngredients.
  // Renamed from session-only state._aiSynonyms to state.aiSynonyms (no
  // underscore) since it's now persistent and a first-class state field.
  state.aiSynonyms = {}
  for (const row of (synonyms || [])) {
    if (row?.from_name && row?.to_name) {
      state.aiSynonyms[row.from_name.toLowerCase()] = row.to_name.toLowerCase()
    }
  }
  // If user is a provider, load their broadcasts. Provider status now
  // derived purely from role — isProvider is true for 'provider' and
  // 'admin' roles, false for everyone else.
  if (usage?.isProvider) {
    safe(() => getProviderBroadcasts(state.user.id, false)).then(b => { state.myBroadcasts = b ?? [] })
  }
  // Auto-detect units from locale (US = imperial, rest = metric)
  if (!state.units) {
    const locale = navigator.language || 'en-US'
    const savedUnits = localStorage.getItem('macrolens_units')
    // US English → imperial by default
    const defaultImperial = locale === 'en-US' || locale.startsWith('en-US')
    state.units = savedUnits || (defaultImperial ? 'imperial' : 'metric')
  }
}

// ─── Analytics helpers ───────────────────────────────────────────────────────
// All computation is derived on-the-fly from state (log, checkins, goals).
// No new storage needed — this is pure frontend analytics.

// Local date string 'YYYY-MM-DD' in the user's timezone (never toISOString)
function analyticsLocalDs(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// Aggregate log entries into { 'YYYY-MM-DD': { cal, p, c, f, count } }
function aggregateLogByDay(log) {
  const byDay = {}
  for (const e of (log || [])) {
    const ts = e.logged_at || e.timestamp
    if (!ts) continue
    const d = new Date(ts)
    if (isNaN(d.getTime())) continue
    const k = analyticsLocalDs(d)
    if (!byDay[k]) byDay[k] = { date: k, cal: 0, p: 0, c: 0, f: 0, fi: 0, count: 0 }
    byDay[k].cal += (e.calories || 0)
    byDay[k].p += (e.protein || 0)
    byDay[k].c += (e.carbs || 0)
    byDay[k].f += (e.fat || 0)
    byDay[k].fi += (e.fiber || 0)
    byDay[k].count += 1
  }
  return byDay
}

// Return N days ending today, oldest first, with zeros for days without logs
function buildDailyWindow(log, days) {
  const byDay = aggregateLogByDay(log)
  const out = []
  const today = new Date()
  today.setHours(0,0,0,0)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const k = analyticsLocalDs(d)
    out.push(byDay[k] || { date: k, cal: 0, p: 0, c: 0, f: 0, fi: 0, count: 0 })
  }
  return out
}

// Summary stats across a daily window: avg, count of days with logs,
// adherence = % of logged days that hit goal within ±15%
function summarizeWindow(daily, goals) {
  const logged = daily.filter(d => d.count > 0)
  const n = logged.length || 1
  const avg = {
    cal: logged.reduce((a, d) => a + d.cal, 0) / n,
    p: logged.reduce((a, d) => a + d.p, 0) / n,
    c: logged.reduce((a, d) => a + d.c, 0) / n,
    f: logged.reduce((a, d) => a + d.f, 0) / n,
    fi: logged.reduce((a, d) => a + d.fi, 0) / n,
  }
  // Adherence: within ±15% of goal for calories, or hit protein ≥ goal
  const calTarget = goals?.calories || 2000
  const proteinTarget = goals?.protein || 150
  const calInRange = logged.filter(d => Math.abs(d.cal - calTarget) <= calTarget * 0.15).length
  const proteinHit = logged.filter(d => d.p >= proteinTarget).length
  return {
    avg,
    loggedDays: logged.length,
    totalDays: daily.length,
    calAdherencePct: logged.length ? Math.round((calInRange / logged.length) * 100) : 0,
    proteinAdherencePct: logged.length ? Math.round((proteinHit / logged.length) * 100) : 0,
  }
}

// Most-logged items — map log entries to recipe_id or food_item_id,
// count occurrences, return top N with display info
function topLoggedItems(log, recipes, foodItems, topN = 5) {
  const counts = {} // key -> { id, type, name, count, kcal }
  for (const e of (log || [])) {
    let key = null, type = null, ref = null
    if (e.recipe_id) {
      key = 'r:' + e.recipe_id
      type = 'recipe'
      ref = (recipes || []).find(r => r.id === e.recipe_id)
    } else if (e.food_item_id) {
      key = 'f:' + e.food_item_id
      type = 'food'
      ref = (foodItems || []).find(f => f.id === e.food_item_id)
    } else {
      // Fall back to name-based grouping for entries without links
      const name = (e.name || '').trim().toLowerCase()
      if (!name) continue
      key = 'n:' + name
      type = 'unlinked'
    }
    if (!counts[key]) {
      counts[key] = {
        key,
        type,
        name: ref?.name || e.name || 'Unknown',
        count: 0,
        totalCal: 0,
        id: ref?.id,
      }
    }
    counts[key].count += 1
    counts[key].totalCal += (e.calories || 0)
  }
  return Object.values(counts)
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
}

// Day-of-week pattern: avg calories per DOW
function dayOfWeekPattern(log) {
  const byDow = [0,1,2,3,4,5,6].map(i => ({ dow: i, cal: 0, count: 0 }))
  const byDay = aggregateLogByDay(log)
  for (const k of Object.keys(byDay)) {
    const [y,m,d] = k.split('-').map(Number)
    const dow = new Date(y, m - 1, d).getDay()
    byDow[dow].cal += byDay[k].cal
    byDow[dow].count += 1
  }
  return byDow.map(r => ({ ...r, avg: r.count ? r.cal / r.count : 0 }))
}

// Meal timing: average first-meal and last-meal hour of day
function mealTimingStats(log) {
  const firstByDay = {}, lastByDay = {}
  for (const e of (log || [])) {
    const ts = e.logged_at || e.timestamp
    if (!ts) continue
    const d = new Date(ts)
    if (isNaN(d.getTime())) continue
    const k = analyticsLocalDs(d)
    const hours = d.getHours() + d.getMinutes() / 60
    if (firstByDay[k] == null || hours < firstByDay[k]) firstByDay[k] = hours
    if (lastByDay[k] == null || hours > lastByDay[k]) lastByDay[k] = hours
  }
  const firsts = Object.values(firstByDay)
  const lasts = Object.values(lastByDay)
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
  const fmtHour = h => {
    if (h == null) return '—'
    const hh = Math.floor(h)
    const mm = Math.round((h - hh) * 60)
    const period = hh >= 12 ? 'PM' : 'AM'
    const display = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh
    return `${display}:${String(mm).padStart(2,'0')} ${period}`
  }
  return {
    firstMeal: fmtHour(avg(firsts)),
    lastMeal: fmtHour(avg(lasts)),
    eatingWindowHrs: firsts.length && lasts.length
      ? +((avg(lasts) - avg(firsts)).toFixed(1))
      : null,
  }
}

// Sparkline SVG — compact inline line chart
function sparkline(values, opts = {}) {
  const { width = 100, height = 28, color = 'var(--accent)', fill = true } = opts
  if (!values.length) return ''
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * width
    const y = height - ((v - min) / range) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const fillPath = fill
    ? `<polygon fill="${color}" fill-opacity="0.12" points="0,${height} ${pts} ${width},${height}" />`
    : ''
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none" style="display:block">
    ${fillPath}
    <polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}" />
  </svg>`
}

// Line chart with x/y axis labels — used for the full-page trends
function lineChart(values, opts = {}) {
  const {
    width = 600, height = 180, color = 'var(--accent)',
    targetLine = null, targetLabel = '', labels = [],
    yFormat = (v) => Math.round(v)
  } = opts
  if (!values.length) return '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">No data yet</div>'

  const padL = 44, padR = 12, padT = 12, padB = 28
  const plotW = width - padL - padR
  const plotH = height - padT - padB

  const allValues = targetLine != null ? [...values, targetLine] : values
  const maxRaw = Math.max(...allValues, 1)
  const minRaw = Math.min(...allValues.filter(v => v > 0), 0)
  // Round max up to next nice number
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxRaw)))
  const max = Math.ceil(maxRaw / magnitude) * magnitude
  const min = 0
  const range = max - min || 1

  const xFor = i => padL + (i / (values.length - 1 || 1)) * plotW
  const yFor = v => padT + plotH - ((v - min) / range) * plotH

  const linePoints = values.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ')
  const areaPoints = `${padL},${padT + plotH} ${linePoints} ${padL + plotW},${padT + plotH}`

  // Grid lines
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => min + f * range)
  const gridLines = yTicks.map(v => {
    const y = yFor(v)
    return `<line x1="${padL}" x2="${padL + plotW}" y1="${y}" y2="${y}" stroke="var(--border)" stroke-width="0.5" />
      <text x="${padL - 6}" y="${y + 3}" font-size="9" fill="var(--text3)" text-anchor="end">${yFormat(v)}</text>`
  }).join('')

  // X labels: show ~5 of them evenly spread
  const labelStride = Math.max(1, Math.floor(labels.length / 5))
  const xLabels = labels.map((lbl, i) => {
    if (i % labelStride !== 0 && i !== labels.length - 1) return ''
    return `<text x="${xFor(i)}" y="${height - 8}" font-size="9" fill="var(--text3)" text-anchor="middle">${esc(lbl)}</text>`
  }).join('')

  const targetLineEl = targetLine != null ? `
    <line x1="${padL}" x2="${padL + plotW}" y1="${yFor(targetLine)}" y2="${yFor(targetLine)}"
      stroke="var(--text3)" stroke-width="1" stroke-dasharray="3,3" />
    <text x="${padL + plotW - 4}" y="${yFor(targetLine) - 4}" font-size="9" fill="var(--text3)" text-anchor="end">${esc(targetLabel)}</text>
  ` : ''

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;display:block" preserveAspectRatio="xMidYMid meet">
    ${gridLines}
    ${targetLineEl}
    <polygon fill="${color}" fill-opacity="0.12" points="${areaPoints}" />
    <polyline fill="none" stroke="${color}" stroke-width="1.75" points="${linePoints}" />
    ${xLabels}
  </svg>`
}

// Github-style contribution heatmap for goal adherence
function adherenceHeatmap(daily, goals) {
  const cellSize = 12, gap = 2
  const calTarget = goals?.calories || 2000
  const proteinTarget = goals?.protein || 150

  const cells = daily.map(d => {
    if (d.count === 0) return { d, status: 'empty', score: 0 }
    const calOK = Math.abs(d.cal - calTarget) <= calTarget * 0.15
    const proteinOK = d.p >= proteinTarget
    const score = (calOK ? 1 : 0) + (proteinOK ? 1 : 0)
    return { d, status: score === 2 ? 'good' : score === 1 ? 'ok' : 'off', score }
  })

  // Render as a grid — 7 rows per week, reading left-to-right
  // Align first week to start on Sunday
  const firstDate = new Date(daily[0].date + 'T00:00:00')
  const startDow = firstDate.getDay()
  const totalCells = startDow + daily.length
  const weeks = Math.ceil(totalCells / 7)
  const gridW = weeks * (cellSize + gap)
  const gridH = 7 * (cellSize + gap)

  let rects = ''
  for (let i = 0; i < daily.length; i++) {
    const cellIndex = startDow + i
    const col = Math.floor(cellIndex / 7)
    const row = cellIndex % 7
    const x = col * (cellSize + gap)
    const y = row * (cellSize + gap)
    const c = cells[i]
    const color = c.status === 'good' ? 'var(--protein)'
                : c.status === 'ok' ? 'rgba(126,211,173,0.4)'
                : c.status === 'off' ? 'rgba(224,110,110,0.35)'
                : 'var(--bg3)'
    rects += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${color}">
      <title>${c.d.date}: ${c.d.count ? `${Math.round(c.d.cal)} kcal · ${Math.round(c.d.p)}g P` : 'no log'}</title>
    </rect>`
  }

  return `<div style="overflow-x:auto;padding:4px 0">
    <svg viewBox="0 0 ${gridW} ${gridH}" width="${gridW}" height="${gridH}" style="display:block">${rects}</svg>
  </div>`
}

// ─── Analytics page ──────────────────────────────────────────────────────────
function renderAnalyticsPage(container) {
  const log = state.log || []
  const checkins = state.checkins || []
  const recipes = state.recipes || []
  const foodItems = state.foodItems || []
  const goals = state.goals || {}
  const range = state.analyticsRange || 30 // days

  const daily = buildDailyWindow(log, range)
  const summary = summarizeWindow(daily, goals)
  const prevDaily = buildDailyWindow(log, range).map(() => null) // placeholder
  // Compute the previous comparable period for delta
  const prevWindow = (() => {
    const byDay = aggregateLogByDay(log)
    const today = new Date()
    today.setHours(0,0,0,0)
    const out = []
    for (let i = range * 2 - 1; i >= range; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const k = analyticsLocalDs(d)
      out.push(byDay[k] || { date: k, cal: 0, p: 0, c: 0, f: 0, fi: 0, count: 0 })
    }
    return out
  })()
  const prevSummary = summarizeWindow(prevWindow, goals)
  const calDelta = prevSummary.avg.cal > 0
    ? Math.round(((summary.avg.cal - prevSummary.avg.cal) / prevSummary.avg.cal) * 100)
    : null

  const topItems = topLoggedItems(log, recipes, foodItems, 5)
  const dowPattern = dayOfWeekPattern(log.filter(e => {
    const ts = e.logged_at || e.timestamp
    if (!ts) return false
    const d = new Date(ts)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - range)
    return d >= cutoff
  }))
  const timing = mealTimingStats(log.filter(e => {
    const ts = e.logged_at || e.timestamp
    if (!ts) return false
    const d = new Date(ts)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - range)
    return d >= cutoff
  }))

  // Weight trend from checkins — sort ascending, filter to range
  const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - range)
  const weightData = [...checkins]
    .filter(c => c.weight_kg)
    .map(c => ({ date: c.scan_date || c.checked_in_at, weight: c.weight_kg, bodyFat: c.body_fat_pct, lean: c.lean_body_mass_kg }))
    .filter(c => c.date && new Date(c.date + 'T00:00:00') >= cutoffDate)
    .sort((a, b) => a.date.localeCompare(b.date))

  const isImperial = state.units === 'imperial'
  const weightFor = kg => isImperial ? +(kg * 2.20462).toFixed(1) : +kg.toFixed(1)
  const weightUnit = isImperial ? 'lbs' : 'kg'

  const shortDate = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  // Range picker pills
  const rangeBtn = (days, label) => `<button onclick="setAnalyticsRange(${days})"
    style="padding:6px 14px;border-radius:999px;font-size:12px;font-weight:500;font-family:inherit;cursor:pointer;border:1px solid ${range === days ? 'var(--accent)' : 'var(--border2)'};background:${range === days ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg3)'};color:${range === days ? 'var(--accent)' : 'var(--text2)'};transition:all 0.15s">${esc(label)}</button>`

  container.innerHTML = `
    <div class="greeting">Analytics</div>
    <div class="greeting-sub">Trends, patterns, and goal adherence across your logged data.</div>

    <!-- Range picker -->
    <div style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap">
      ${rangeBtn(7, '7 days')}
      ${rangeBtn(30, '30 days')}
      ${rangeBtn(90, '90 days')}
      ${rangeBtn(365, '1 year')}
    </div>

    <!-- Headline metric -->
    <div class="upload-card" style="margin-bottom:16px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:6px">${range}-day average</div>
      <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
        <div style="font-family:'DM Serif Display',serif;font-size:44px;color:var(--cal);line-height:1">${Math.round(summary.avg.cal)}</div>
        <div style="font-size:14px;color:var(--text3)">kcal / day</div>
        ${calDelta != null ? `
          <div style="font-size:13px;color:${calDelta > 0 ? 'var(--fat)' : 'var(--protein)'};font-weight:500">
            ${calDelta > 0 ? '↑' : '↓'} ${Math.abs(calDelta)}% vs prior ${range} days
          </div>
        ` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:16px">
        <div><div style="font-size:11px;color:var(--text3);margin-bottom:2px">PROTEIN</div><div style="font-size:18px;font-weight:600;color:var(--protein)">${Math.round(summary.avg.p)}g</div><div style="font-size:10px;color:var(--text3)">of ${goals.protein || 150}g goal</div></div>
        <div><div style="font-size:11px;color:var(--text3);margin-bottom:2px">CARBS</div><div style="font-size:18px;font-weight:600;color:var(--carbs)">${Math.round(summary.avg.c)}g</div></div>
        <div><div style="font-size:11px;color:var(--text3);margin-bottom:2px">FAT</div><div style="font-size:18px;font-weight:600;color:var(--fat)">${Math.round(summary.avg.f)}g</div></div>
        <div><div style="font-size:11px;color:var(--text3);margin-bottom:2px">FIBER</div><div style="font-size:18px;font-weight:600;color:var(--text2)">${Math.round(summary.avg.fi)}g</div></div>
      </div>
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);font-size:12px;color:var(--text3)">
        Logged ${summary.loggedDays} of ${summary.totalDays} days
        · <span style="color:${summary.calAdherencePct >= 70 ? 'var(--protein)' : summary.calAdherencePct >= 40 ? 'var(--accent)' : 'var(--fat)'}">${summary.calAdherencePct}%</span> within calorie goal
        · <span style="color:${summary.proteinAdherencePct >= 70 ? 'var(--protein)' : summary.proteinAdherencePct >= 40 ? 'var(--accent)' : 'var(--fat)'}">${summary.proteinAdherencePct}%</span> hit protein
      </div>
    </div>

    <!-- Calorie trend -->
    <div class="upload-card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:13px;font-weight:500;color:var(--text2)">Daily calories</div>
        <div style="font-size:11px;color:var(--text3)">Goal: ${goals.calories || 2000} kcal</div>
      </div>
      ${lineChart(daily.map(d => d.cal), {
        width: 600, height: 180, color: 'var(--cal)',
        targetLine: goals.calories || 2000, targetLabel: `${goals.calories || 2000} goal`,
        labels: daily.map(d => shortDate(d.date))
      })}
    </div>

    <!-- Protein trend -->
    <div class="upload-card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:13px;font-weight:500;color:var(--text2)">Daily protein</div>
        <div style="font-size:11px;color:var(--text3)">Goal: ${goals.protein || 150}g</div>
      </div>
      ${lineChart(daily.map(d => d.p), {
        width: 600, height: 160, color: 'var(--protein)',
        targetLine: goals.protein || 150, targetLabel: `${goals.protein || 150}g goal`,
        labels: daily.map(d => shortDate(d.date)),
        yFormat: v => Math.round(v) + 'g'
      })}
    </div>

    <!-- Weight trend (only if we have check-ins) -->
    ${weightData.length >= 2 ? `
      <div class="upload-card" style="margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:13px;font-weight:500;color:var(--text2)">Weight</div>
          <div style="font-size:11px;color:var(--text3)">
            ${(() => {
              const diff = weightData[weightData.length - 1].weight - weightData[0].weight
              const diffDisp = isImperial ? diff * 2.20462 : diff
              return `${diff > 0 ? '+' : ''}${diffDisp.toFixed(1)} ${weightUnit} over ${range} days`
            })()}
          </div>
        </div>
        ${lineChart(weightData.map(c => weightFor(c.weight)), {
          width: 600, height: 160, color: 'var(--accent)',
          labels: weightData.map(c => shortDate(c.date)),
          yFormat: v => v + ' ' + weightUnit
        })}
      </div>
    ` : ''}

    <!-- Heatmap -->
    <div class="upload-card" style="margin-bottom:16px">
      <div style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:4px">Goal adherence heatmap</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:12px">Green = hit calorie + protein goals · Yellow = partial · Red = off · Gray = no log</div>
      ${adherenceHeatmap(daily, goals)}
    </div>

    <!-- Secondary grid: two columns on desktop -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:16px">

      <!-- Most-logged items -->
      <div class="upload-card">
        <div style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:12px">Most-logged items</div>
        ${topItems.length ? topItems.map((it, i) => `
          <div style="display:flex;align-items:center;gap:10px;padding:6px 0;${i < topItems.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
            <div style="font-size:11px;color:var(--text3);width:16px;text-align:right">${i + 1}</div>
            <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--text)">${esc(it.name)}</div>
            <div style="font-size:11px;color:${it.type === 'recipe' ? 'var(--protein)' : it.type === 'food' ? 'var(--carbs)' : 'var(--text3)'};text-transform:uppercase;letter-spacing:0.5px">${it.type === 'recipe' ? '⭐' : it.type === 'food' ? '🥫' : ''}</div>
            <div style="font-size:13px;font-weight:600;color:var(--text2)">${it.count}×</div>
          </div>
        `).join('') : '<div style="font-size:12px;color:var(--text3)">No entries yet.</div>'}
      </div>

      <!-- Day of week -->
      <div class="upload-card">
        <div style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:12px">Avg calories by day of week</div>
        ${(() => {
          const maxAvg = Math.max(...dowPattern.map(d => d.avg), 1)
          return dowPattern.map(d => {
            const pct = (d.avg / maxAvg) * 100
            return `<div style="display:flex;align-items:center;gap:10px;padding:4px 0">
              <div style="font-size:11px;color:var(--text3);width:28px">${DAYS[d.dow]}</div>
              <div style="flex:1;height:14px;background:var(--bg3);border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--cal);border-radius:3px"></div></div>
              <div style="font-size:11px;color:var(--text2);width:48px;text-align:right">${d.count ? Math.round(d.avg) : '—'}</div>
            </div>`
          }).join('')
        })()}
      </div>

      <!-- Meal timing -->
      <div class="upload-card">
        <div style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:12px">Meal timing</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:12px;color:var(--text3)">First meal (avg)</div>
            <div style="font-size:15px;font-weight:600;color:var(--text)">${timing.firstMeal}</div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:12px;color:var(--text3)">Last meal (avg)</div>
            <div style="font-size:15px;font-weight:600;color:var(--text)">${timing.lastMeal}</div>
          </div>
          ${timing.eatingWindowHrs != null ? `
            <div style="display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid var(--border)">
              <div style="font-size:12px;color:var(--text3)">Eating window</div>
              <div style="font-size:15px;font-weight:600;color:var(--accent)">${timing.eatingWindowHrs}h</div>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Body composition summary -->
      ${weightData.length >= 1 ? `
        <div class="upload-card">
          <div style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:12px">Latest body scan</div>
          ${(() => {
            const latest = weightData[weightData.length - 1]
            return `
              <div style="display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;justify-content:space-between"><span style="font-size:12px;color:var(--text3)">Weight</span><span style="font-size:15px;font-weight:600;color:var(--accent)">${weightFor(latest.weight)} ${weightUnit}</span></div>
                ${latest.bodyFat != null ? `<div style="display:flex;justify-content:space-between"><span style="font-size:12px;color:var(--text3)">Body fat</span><span style="font-size:15px;font-weight:600;color:var(--fat)">${latest.bodyFat}%</span></div>` : ''}
                ${latest.lean ? `<div style="display:flex;justify-content:space-between"><span style="font-size:12px;color:var(--text3)">Lean mass</span><span style="font-size:15px;font-weight:600;color:var(--protein)">${weightFor(latest.lean)} ${weightUnit}</span></div>` : ''}
                <div style="font-size:10px;color:var(--text3);margin-top:2px">${shortDate(latest.date)}</div>
              </div>
            `
          })()}
        </div>
      ` : ''}

    </div>
  `
}

// Compact strip shown on the dashboard — a teaser that summarises the
// last 7 days and links through to the full analytics page. Kept
// intentionally small (3 stat tiles + one sparkline) so it doesn't
// clutter the main dashboard.
function renderDashboardAnalyticsWidget() {
  // Wrap the whole thing — this runs during dashboard render, and a crash
  // here takes the entire dashboard with it. Returning '' on any error
  // means the user just doesn't see the widget, instead of seeing nothing.
  try {
    const log = state.log || []
    const goals = state.goals || {}
    const checkins = state.checkins || []

    const daily = buildDailyWindow(log, 7)
    const summary = summarizeWindow(daily, goals)

    // Don't render until there's something worth showing — avoids a
    // misleading "0 kcal / 0 days logged" strip on brand-new accounts.
    if (summary.loggedDays === 0 && checkins.length === 0) return ''

    const calValues = daily.map(d => d.cal)
    const proteinValues = daily.map(d => d.p)

    // Weight delta across whatever checkins we have in the last 30 days
    const isImperial = state.units === 'imperial'
    const weightUnit = isImperial ? 'lbs' : 'kg'
    const recentCheckins = [...checkins]
      .filter(c => c.weight_kg)
      .sort((a, b) => (a.scan_date || a.checked_in_at || '').localeCompare(b.scan_date || b.checked_in_at || ''))
    const weightDelta = recentCheckins.length >= 2
      ? (recentCheckins[recentCheckins.length - 1].weight_kg - recentCheckins[0].weight_kg)
      : null
    const weightDeltaDisp = weightDelta != null
      ? `${weightDelta > 0 ? '+' : ''}${(isImperial ? weightDelta * 2.20462 : weightDelta).toFixed(1)} ${weightUnit}`
      : null

    const tile = (label, value, sub, sparkVals, color) => `
      <button onclick="switchPage('analytics')" style="flex:1;min-width:150px;background:none;border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;text-align:left;cursor:pointer;font-family:inherit;transition:border-color 0.15s"
        onmouseover="this.style.borderColor='var(--border2)'" onmouseout="this.style.borderColor='var(--border)'">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:4px">${label}</div>
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:6px">
          <div style="font-size:20px;font-weight:600;color:${color};line-height:1">${value}</div>
          ${sub ? `<div style="font-size:11px;color:var(--text3)">${sub}</div>` : ''}
        </div>
        ${sparkVals ? sparkline(sparkVals, { width: 140, height: 22, color }) : ''}
      </button>
    `

    return `
      <div class="upload-card" style="margin-bottom:16px;padding:14px 16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">Last 7 days</div>
          <button onclick="switchPage('analytics')"
            style="background:none;border:none;color:var(--accent);font-size:12px;font-family:inherit;cursor:pointer;padding:0">
            View analytics →
          </button>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${tile('Avg calories', Math.round(summary.avg.cal), 'kcal/day', calValues, 'var(--cal)')}
          ${tile('Avg protein', Math.round(summary.avg.p) + 'g', `${summary.proteinAdherencePct}% hit goal`, proteinValues, 'var(--protein)')}
          ${weightDeltaDisp
            ? tile('Weight change', weightDeltaDisp, `${recentCheckins.length} check-ins`, null, 'var(--accent)')
            : tile('Days logged', summary.loggedDays + '/7', 'this week', null, 'var(--text)')}
        </div>
      </div>
    `
  } catch (err) {
    // Dev-visible console error but user just doesn't see the widget
    console.error('Dashboard analytics widget failed:', err)
    return ''
  }
}

// ─── Shell HTML ──────────────────────────────────────────────────────────────
function renderShell(container) {
  container.innerHTML = `
    <div class="sidebar-overlay" id="sidebar-overlay" onclick="closeSidebar()"></div>
    <button class="hamburger" onclick="toggleSidebar()"><span></span><span></span><span></span></button>

    <div class="app">
      <aside class="sidebar" id="sidebar">
        <div class="logo">
          <div class="logo-text">MacroLens</div>
          <div class="logo-sub">AI nutrition tracker</div>
        </div>
        <nav class="nav">
          <div class="nav-item ${state.currentPage === 'log' ? 'active' : ''}" id="nav-log" onclick="switchPage('log')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            Dashboard
          </div>
          <div class="nav-item ${state.currentPage === 'analytics' ? 'active' : ''}" id="nav-analytics" onclick="switchPage('analytics')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            Analytics
          </div>
          <div class="nav-item ${state.currentPage === 'planner' ? 'active' : ''}" id="nav-planner" onclick="switchPage('planner')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            Meal Planner
          </div>
          <div class="nav-item ${state.currentPage === 'goals' ? 'active' : ''}" id="nav-goals" onclick="switchPage('goals')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Goals
          </div>
          <div class="nav-item ${state.currentPage === 'recipes' ? 'active' : ''}" id="nav-recipes" onclick="switchPage('recipes')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            Recipes
          </div>
          <div class="nav-item ${state.currentPage === 'providers' ? 'active' : ''}" id="nav-providers" onclick="switchPage('providers')" style="position:relative">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
            Providers
            ${state.followedProviders?.length > 0 ? `<span style="position:absolute;top:4px;right:4px;background:var(--protein);color:white;border-radius:999px;font-size:9px;font-weight:700;padding:1px 5px">${state.followedProviders.length}</span>` : ''}
          </div>
          <div class="nav-item ${state.currentPage === 'foods' ? 'active' : ''}" id="nav-foods" onclick="switchPage('foods')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            Foods
          </div>
          <div class="nav-item ${state.currentPage === 'account' ? 'active' : ''}" id="nav-account" onclick="switchPage('account')" style="position:relative">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            Account
            ${state.usage?.isAdmin && state.newUsersCount > 0 ? `<span style="position:absolute;top:4px;right:4px;background:var(--red);color:white;border-radius:999px;font-size:9px;font-weight:700;padding:1px 5px;min-width:16px;text-align:center">${state.newUsersCount}</span>` : ''}
          </div>
        </nav>
        <div class="goal-widget">
          <div class="goal-title">Today's progress</div>
          <div class="goal-row"><span class="goal-label">Calories</span><span class="goal-nums" id="sb-cal">—</span></div>
          <div class="goal-bar"><div class="goal-fill" id="sb-cal-bar" style="background:var(--cal);width:0%"></div></div>
          <div class="goal-row"><span class="goal-label">Protein</span><span class="goal-nums" id="sb-p">—</span></div>
          <div class="goal-bar"><div class="goal-fill" id="sb-p-bar" style="background:var(--protein);width:0%"></div></div>
          <div class="goal-row"><span class="goal-label">Carbs</span><span class="goal-nums" id="sb-c">—</span></div>
          <div class="goal-bar"><div class="goal-fill" id="sb-c-bar" style="background:var(--carbs);width:0%"></div></div>
          <div class="goal-row"><span class="goal-label">Fat</span><span class="goal-nums" id="sb-f">—</span></div>
          <div class="goal-bar"><div class="goal-fill" id="sb-f-bar" style="background:var(--fat);width:0%"></div></div>
        </div>
      </aside>

      <main class="main" id="main-content"></main>
    </div>

    <!-- Modals -->
    <div class="modal-overlay" id="edit-modal">
      <div class="modal-box">
        <button class="modal-close" onclick="closeEditModal()">×</button>
        <h3>Edit meal</h3>
        <div class="modal-field"><label>Meal name</label><input type="text" id="edit-name" /></div>
        <!-- Meal type -->
        <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
          ${['Breakfast','Lunch','Snack','Dinner'].map(t => `
            <button id="meal-type-btn-${t}" onclick="setEditMealType('${t}')"
              style="flex:1;padding:6px 4px;border-radius:var(--r);font-size:12px;font-family:inherit;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text3)">
              ${{'Breakfast':'🌅','Lunch':'☀️','Snack':'🍎','Dinner':'🌙'}[t]} ${t}
            </button>`).join('')}
        </div>

        <!-- Servings multiplier -->
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:10px 12px;background:var(--bg3);border-radius:var(--r)">
          <label style="font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;white-space:nowrap">Servings eaten</label>
          <input type="number" id="edit-servings" min="0.25" max="20" step="0.25" value="1"
            oninput="applyServingsMultiplier()"
            style="width:70px;background:var(--bg4);border:1px solid var(--border2);border-radius:6px;padding:6px 10px;color:var(--text);font-size:15px;font-weight:600;font-family:inherit;outline:none;text-align:center" />
          <span style="font-size:12px;color:var(--text3)">Macros below update automatically</span>
        </div>

        <div class="modal-grid">
          <div class="modal-field"><label>Calories</label><input type="number" id="edit-cal" /></div>
          <div class="modal-field"><label>Protein (g)</label><input type="number" id="edit-protein" /></div>
          <div class="modal-field"><label>Carbs (g)</label><input type="number" id="edit-carbs" /></div>
          <div class="modal-field"><label>Fat (g)</label><input type="number" id="edit-fat" /></div>
          <div class="modal-field"><label>Fiber (g)</label><input type="number" id="edit-fiber" /></div>
          <div class="modal-field"><label>Sugar (g)</label><input type="number" id="edit-sugar" /></div>
        </div>
        <div class="modal-actions">
          <button class="btn-delete" onclick="deleteEditEntry()">Delete</button>
          <button class="btn-cancel" onclick="closeEditModal()">Cancel</button>
          <button class="btn-save" onclick="saveEditEntry()">Save changes</button>
        </div>
        <div style="margin-top:8px">
          <button onclick="saveLogEntryToFoods()" id="save-to-foods-btn"
            style="width:100%;background:none;border:1px solid var(--border2);border-radius:var(--r);padding:8px;font-size:13px;color:var(--text3);cursor:pointer;font-family:inherit"
            onmouseover="this.style.color='var(--carbs)';this.style.borderColor='var(--carbs)'"
            onmouseout="this.style.color='var(--text3)';this.style.borderColor='var(--border2)'">
            🍎 Save to My Foods
          </button>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="planner-modal">
      <div class="planner-modal">
        <button class="modal-close" onclick="closePlannerModal()">×</button>
        <h3 id="planner-modal-title">Add meal</h3>

        <!-- Meal type selector -->
        <div style="display:flex;gap:6px;margin-bottom:12px">
          ${[['breakfast','🌅','Breakfast'],['lunch','☀️','Lunch'],['snack','🍎','Snack'],['dinner','🌙','Dinner']].map(([val,icon,label]) =>
            `<button onclick="setPlannerMealType('${val}')" data-meal-type-btn="${val}"
              style="flex:1;padding:7px 4px;border-radius:var(--r);font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;border:1px solid var(--border2);background:var(--bg3);color:var(--text3);display:flex;flex-direction:column;align-items:center;gap:2px">
              <span style="font-size:14px">${icon}</span>${label}
            </button>`
          ).join('')}
        </div>
        <input type="hidden" id="planner-meal-type" value="dinner" />

        <div class="pm-tabs">
          <button class="pm-tab active" id="pm-tab-history" onclick="switchPlannerTab('history')">📋 History</button>
          <button class="pm-tab" id="pm-tab-ai" onclick="switchPlannerTab('ai')">✨ Describe</button>
          <button class="pm-tab" id="pm-tab-photo" onclick="switchPlannerTab('photo')">📸 Photo</button>
        </div>
        <div class="pm-panel active" id="pm-panel-history">
          <input class="planner-search" id="planner-search" placeholder="Search recipes and meal history..." oninput="filterPlannerList()" />
          <div class="history-pick-list" id="history-pick-list"></div>
        </div>
        <div class="pm-panel" id="pm-panel-ai">
          <textarea class="pm-textarea" id="pm-ai-input" placeholder="Describe the meal or recipe...&#10;&#10;e.g. Skillet chicken cacciatore with pasta&#10;e.g. 200g grilled salmon, 1 cup quinoa, roasted broccoli"></textarea>
          <button class="pm-analyze-btn" id="pm-analyze-btn" onclick="analyzePlannerMealHandler()">Analyze with AI</button>
          <div class="pm-result" id="pm-result">
            <div class="pm-result-name" id="pm-result-name"></div>
            <div class="pm-result-pills" id="pm-result-pills"></div>
            <button class="pm-add-btn" onclick="addAiMealToPlannerHandler()">+ Add to planner</button>
          </div>
        </div>
        <div class="pm-panel" id="pm-panel-photo">
          <div class="pm-upload-area" id="pm-upload-area" onclick="document.getElementById('pm-file-input').click()">
            <div id="pm-upload-inner">
              <div style="font-size:28px;margin-bottom:6px">📸</div>
              <div style="font-size:13px;color:var(--text2)">Tap to upload a photo or screenshot</div>
              <div style="font-size:11px;color:var(--text3);margin-top:3px">recipe card, screenshot, food photo</div>
            </div>
          </div>
          <input type="file" id="pm-file-input" accept="image/*" style="display:none" />
          <button class="pm-analyze-btn" id="pm-photo-analyze-btn" onclick="analyzePlannerPhotoHandler()" style="display:none">Analyze photo with AI</button>
          <div class="pm-result" id="pm-photo-result">
            <div class="pm-result-name" id="pm-photo-result-name"></div>
            <div class="pm-result-pills" id="pm-photo-result-pills"></div>
            <button class="pm-add-btn" onclick="addPhotoMealToPlannerHandler()">+ Add to planner</button>
          </div>
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
          <label class="leftover-toggle">
            <input type="checkbox" id="leftover-check" onchange="toggleLeftoverPreview(this.checked)" />
            Also add as next-day lunch (leftovers)
          </label>
          <div id="leftover-preview" style="display:none;margin-top:8px;font-size:12px;color:var(--carbs);padding:6px 10px;background:rgba(122,180,232,0.08);border-radius:var(--r);border:1px solid rgba(122,180,232,0.2)">
            Will also be added to <span id="leftover-day-label">Monday</span> as lunch
          </div>
        </div>
      </div>
    </div>

    <!-- Methodology modal -->
    <div class="modal-overlay" id="methodology-modal">
      <div class="modal-box" style="max-width:560px;max-height:85vh;overflow-y:auto">
        <button class="modal-close" onclick="closeMethodologyModal()">×</button>
        <h3 style="color:var(--accent);margin-bottom:4px">How macros are calculated</h3>
        <div style="font-size:12px;color:var(--text3);margin-bottom:20px">Based on peer-reviewed nutrition science</div>

        <div style="display:flex;flex-direction:column;gap:16px;font-size:13px">

          <div>
            <div style="font-weight:600;color:var(--text);margin-bottom:6px">Step 1 — Basal Metabolic Rate (BMR)</div>
            <div style="color:var(--text3);margin-bottom:8px">Calories your body burns at complete rest. Two formulas are used:</div>
            <div style="background:var(--bg3);border-radius:var(--r);padding:10px 12px;margin-bottom:6px">
              <div style="font-size:11px;font-weight:600;color:var(--accent);margin-bottom:4px">✓ Katch-McArdle (when body fat % is known — most accurate)</div>
              <div style="font-family:monospace;font-size:12px;color:var(--text)">BMR = 370 + (21.6 × Lean Body Mass kg)</div>
            </div>
            <div style="background:var(--bg3);border-radius:var(--r);padding:10px 12px">
              <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:4px">⚠ Mifflin-St Jeor (fallback without body fat %)</div>
              <div style="font-family:monospace;font-size:12px;color:var(--text)">BMR = (10 × kg) + (6.25 × cm) − (5 × age) ± 5</div>
            </div>
          </div>

          <div>
            <div style="font-weight:600;color:var(--text);margin-bottom:6px">Step 2 — Total Daily Energy Expenditure (TDEE)</div>
            <div style="color:var(--text3);margin-bottom:8px">BMR × activity multiplier (Harris-Benedict scale):</div>
            <div style="background:var(--bg3);border-radius:var(--r);padding:10px 12px">
              <div style="display:flex;flex-direction:column;gap:4px;font-size:12px">
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Sedentary</span><span style="font-family:monospace;color:var(--text)">× 1.20</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Lightly active (1–3x/wk)</span><span style="font-family:monospace;color:var(--text)">× 1.375</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Moderately active (3–5x/wk)</span><span style="font-family:monospace;color:var(--text)">× 1.55</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Very active (6–7x/wk)</span><span style="font-family:monospace;color:var(--text)">× 1.725</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Extremely active</span><span style="font-family:monospace;color:var(--text)">× 1.90</span></div>
              </div>
            </div>
          </div>

          <div>
            <div style="font-weight:600;color:var(--text);margin-bottom:6px">Step 3 — Calorie Target</div>
            <div style="background:var(--bg3);border-radius:var(--r);padding:10px 12px;font-size:12px">
              <div style="display:flex;flex-direction:column;gap:4px">
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Lose fat — Slow</span><span style="font-family:monospace;color:var(--text)">TDEE − 250 kcal</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Lose fat — Moderate</span><span style="font-family:monospace;color:var(--text)">TDEE − 400 kcal</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Lose fat — Aggressive</span><span style="font-family:monospace;color:var(--text)">TDEE − 600 kcal</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Maintain</span><span style="font-family:monospace;color:var(--text)">TDEE</span></div>
                <div style="display:flex;justify-content:space-between"><span style="color:var(--text3)">Build muscle</span><span style="font-family:monospace;color:var(--text)">TDEE + 250–400 kcal</span></div>
              </div>
              <div style="margin-top:8px;font-size:11px;color:var(--text3)">Minimum 1,200 kcal/day floor enforced.</div>
            </div>
          </div>

          <div>
            <div style="font-weight:600;color:var(--text);margin-bottom:6px">Step 4 — Macro Distribution</div>
            <div style="background:var(--bg3);border-radius:var(--r);padding:10px 12px;font-size:12px;display:flex;flex-direction:column;gap:6px">
              <div><span style="color:var(--protein);font-weight:600">Protein: </span><span style="color:var(--text3)">1.0 g per lb of lean body mass (or 0.75× total weight if BF% unknown)</span></div>
              <div><span style="color:var(--fat);font-weight:600">Fat: </span><span style="color:var(--text3)">25% of total calorie target ÷ 9</span></div>
              <div><span style="color:var(--carbs);font-weight:600">Carbs: </span><span style="color:var(--text3)">Remaining calories ÷ 4 (min 50g/day)</span></div>
            </div>
          </div>

          <div style="padding:10px 12px;background:color-mix(in srgb, var(--accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--accent) 20%, transparent);border-radius:var(--r);font-size:11px;color:var(--text3)">
            <strong style="color:var(--accent)">References:</strong> Mifflin et al. (1990) AJCN; Katch-McArdle (2011); Harris-Benedict activity factors; ISSN Protein Position Stand (2017); Dietary Reference Intakes, National Academies (2005).
          </div>

          <button onclick="closeMethodologyModal()"
            style="width:100%;padding:10px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);font-size:13px;font-weight:600;font-family:inherit;cursor:pointer">
            Got it
          </button>
        </div>
      </div>
    </div>

    <!-- Limit reached modal — shown when the user hits their monthly AI
         Bucks cap. Replaces the raw 429 toast with a conversion-optimized
         experience: warm headline, full bar, one clear upgrade CTA. -->
    <div class="modal-overlay" id="limit-reached-modal">
      <div class="modal-box" style="max-width:440px">
        <button class="modal-close" onclick="closeLimitReachedModal()">×</button>
        <div style="text-align:center;padding:8px 0 4px">
          <div style="font-size:38px;margin-bottom:12px">⚡</div>
          <h3 style="margin:0 0 8px;font-family:'DM Serif Display',serif;font-size:22px">Out of AI Bucks</h3>
          <div id="limit-reached-subtitle" style="font-size:13px;color:var(--text3);margin-bottom:20px;line-height:1.5">
            You've used all your AI Bucks for this month.
          </div>
        </div>
        <!-- Full-red progress bar visualizes the hit cap -->
        <div class="bar-bg" style="height:10px;margin-bottom:6px">
          <div style="background:var(--red);width:100%;height:100%;border-radius:999px"></div>
        </div>
        <div id="limit-reached-usage" style="font-size:12px;color:var(--text3);text-align:center;margin-bottom:16px">
          All AI Bucks used
        </div>

        <!-- Loss-framed list of what they can't do right now -->
        <div style="background:var(--bg3);border-radius:var(--r);padding:14px;margin-bottom:18px">
          <div style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Upgrade to Premium to</div>
          <div style="display:flex;flex-direction:column;gap:7px;font-size:13px;color:var(--text2)">
            <div>📸 Analyze meal photos</div>
            <div>📷 Scan barcodes</div>
            <div>🔗 Import recipes from links</div>
            <div>🗓️ Use the AI meal planner</div>
          </div>
        </div>

        <button onclick="closeLimitReachedModal();switchPage('upgrade')"
          style="width:100%;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);padding:13px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;margin-bottom:10px">
          Upgrade to Premium
        </button>
        <div style="font-size:11px;color:var(--text3);text-align:center">Your free AI Bucks reset on the 1st of each month</div>
      </div>
    </div>

    <!-- Methodology modal -->
    <div class="modal-overlay" id="checkin-modal">
      <div class="modal-box" style="max-width:480px">
        <button class="modal-close" onclick="closeCheckinModal()">×</button>
        <h3>Log weight</h3>

        <!-- Quick entry: just weight + date -->
        <div style="background:var(--bg3);border-radius:var(--r);padding:12px;margin-bottom:10px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="modal-field"><label id="ci-weight-label">Weight (lbs)</label><input type="number" step="0.1" id="ci-weight" placeholder="210" /></div>
            <div class="modal-field"><label>Date</label><input type="date" id="ci-date" /></div>
          </div>
        </div>

        <!-- Toggle for more details -->
        <button onclick="toggleCheckinDetails()" id="ci-details-toggle"
          style="width:100%;background:none;border:1px solid var(--border2);border-radius:var(--r);padding:9px;font-size:13px;color:var(--text3);font-family:inherit;cursor:pointer;margin-bottom:10px;display:flex;align-items:center;justify-content:center;gap:6px">
          <span id="ci-details-arrow">▸</span> Add body composition details
        </button>

        <!-- Expandable details -->
        <div id="ci-details-panel" style="display:none">
          <div style="background:var(--bg3);border-radius:var(--r);padding:12px;margin-bottom:10px">
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">📊 Body composition</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div class="modal-field">
                <label>Body fat % <span style="font-weight:400;color:var(--text3);font-size:10px">(optional)</span></label>
                <input type="number" step="0.1" id="ci-bf" placeholder="17" />
              </div>
              <div class="modal-field">
                <label id="ci-muscle-label">Muscle mass (lbs) <span style="font-weight:400;color:var(--text3);font-size:10px">(optional)</span></label>
                <input type="number" step="0.1" id="ci-muscle" placeholder="101" />
              </div>
            </div>
          </div>

          <!-- Scan upload -->
          <div style="background:var(--bg3);border-radius:var(--r);padding:12px;margin-bottom:10px">
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">📄 InBody / DEXA scan</div>
            <div style="font-size:12px;color:var(--text3);margin-bottom:10px">Upload your scan and AI extracts all metrics automatically.</div>
            <div id="scan-upload-area" onclick="document.getElementById('scan-file-input').click()"
              style="border:1.5px dashed var(--border2);border-radius:var(--r);padding:14px;text-align:center;cursor:pointer;background:var(--bg2)"
              onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
              <div id="scan-upload-inner">
                <div style="font-size:24px;margin-bottom:4px">📄</div>
                <div style="font-size:13px;color:var(--text2)">Upload scan (PDF or image)</div>
                <div style="font-size:11px;color:var(--text3);margin-top:2px">AI will extract your metrics automatically</div>
              </div>
            </div>
            <input type="file" id="scan-file-input" accept="application/pdf,image/*" style="display:none" onchange="handleScanUpload(this.files[0])" />
            <div id="scan-status" style="font-size:12px;color:var(--text3);margin-top:6px;text-align:center;min-height:18px"></div>
            <div class="modal-field" style="margin-top:10px">
              <label>Scan date <span style="font-weight:400;color:var(--text3);font-size:10px">(date on the report)</span></label>
              <input type="date" id="ci-scan-date" style="width:100%;background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r);padding:9px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none" />
            </div>
          </div>
        </div>

        <!-- Notes -->
        <div class="modal-field" style="margin-bottom:16px">
          <label>Notes <span style="font-weight:400;color:var(--text3);font-size:10px">(optional)</span></label>
          <textarea id="ci-notes" placeholder="How are you feeling? Energy levels, sleep..."
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px 12px;color:var(--text);font-size:13px;font-family:inherit;outline:none;resize:none;min-height:56px"></textarea>
        </div>

        <div class="modal-actions">
          <button class="btn-cancel" onclick="closeCheckinModal()">Cancel</button>
          <button class="btn-save" onclick="saveCheckinHandler()">Save</button>
        </div>
      </div>
    </div>

    <!-- Broadcast modal -->
    <div class="modal-overlay" id="broadcast-modal">
      <div class="modal-box" style="max-width:500px;padding:0">
        <div id="broadcast-modal-content"></div>
      </div>
    </div>

    <!-- Food item modal -->
    <div class="modal-overlay" id="food-item-modal">
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r3);width:100%;max-width:520px;max-height:90vh;overflow-y:auto;position:relative">
        <div id="food-item-modal-content"></div>
      </div>
    </div>

    <!-- Plan recipe modal -->
    <div class="modal-overlay" id="plan-recipe-modal">
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r3);padding:0;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;position:relative">
        <div id="plan-recipe-modal-content"></div>
      </div>
    </div>

    <!-- Recipe modal (persists across pages) -->
    <div class="modal-overlay" id="recipe-modal">
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r3);padding:0;width:100%;max-width:620px;max-height:90vh;overflow-y:auto;position:relative">
        <div id="recipe-modal-content"></div>
      </div>
    </div>

    <!-- Copy broadcast preview modal -->
    <div class="modal-overlay" id="copy-broadcast-modal">
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r3);padding:0;width:100%;max-width:560px;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;position:relative">
        <div id="copy-broadcast-content" style="overflow-y:auto;flex:1"></div>
      </div>
    </div>

    <!-- Manage tags modal -->
    <div class="modal-overlay" id="manage-tags-modal">
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r3);padding:0;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;position:relative">
        <div id="manage-tags-content"></div>
      </div>
    </div>

    <!-- Quick-tag modal — add/remove tags on a single recipe without entering edit mode -->
    <div class="modal-overlay" id="quick-tag-modal">
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r3);padding:0;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;position:relative">
        <div id="quick-tag-content"></div>
      </div>
    </div>

    <div class="toast" id="toast"></div>
  `
  updateSidebar()
}

// ─── Page Routing ─────────────────────────────────────────────────────────────
// ─── Tier helpers ─────────────────────────────────────────────────────────────
function userCanAccess(feature) {
  // Anyone paid or elevated gets the full app.
  const role = state.usage?.role || 'free'
  if (role === 'admin' || role === 'premium' || role === 'provider') return true

  // Free tier access rules (Nov 2025 rewrite):
  //
  // The old model gated entire pages (Recipes/Planner/Goals/Foods) behind
  // Premium. That killed the demo — users never saw the gated features,
  // so they never knew what they were paying for. The new model:
  //
  // 1. Free users can visit and browse almost everything. They can save
  //    recipes manually, plan meals by dragging, set goals, etc.
  // 2. The paywall kicks in at the POINT OF AI CONSUMPTION (photo scan,
  //    URL import, barcode lookup) — when AI Bucks run out, the upgrade
  //    modal appears. Storage/DB writes are always free.
  // 3. A couple of features remain fully Premium-gated because they're
  //    categorically AI-heavy: grocery list generation aggregates and
  //    deduplicates ingredients across planned meals using an LLM.
  //
  // The `grocery` feature-tag is checked from within the Planner page's
  // tab switcher (not here at the routing level), so it doesn't need to
  // be listed in freeFeatures — Planner itself is accessible, grocery
  // just isn't.
  const premiumOnlyFeatures = ['upgrade'] // upgrade page is special-cased elsewhere
  return !premiumOnlyFeatures.includes(feature)
}

// Specific feature-level gates that are premium-only even though their
// parent page is accessible to free users. These are the AI-heaviest
// flows where letting free users dip in would blow through the 100
// AI Bucks allotment almost immediately.
function isPremiumOnlyFeature(featureId) {
  const PREMIUM_ONLY = new Set([
    'grocery',  // Grocery list generation — full LLM pass over planned meals
  ])
  if (state.usage?.role === 'admin' || state.usage?.role === 'premium' || state.usage?.role === 'provider') return false
  return PREMIUM_ONLY.has(featureId)
}

function renderUpgradePage(container, feature) {
  // The specific feature they were trying to access (if any) — shown in
  // the headline so the upgrade nudge feels contextual, not abstract.
  const featureNames = {
    planner: 'Meal Planner',
    goals: 'Goals & Body Tracking',
    recipes: 'Recipes',
    foods: 'Saved Foods',
  }
  const featureLabel = featureNames[feature] || null

  // Pull the two user-facing tiers from the pricing module. We render
  // them side-by-side on desktop, stacked on mobile. "Featured" tier
  // (Premium) gets a gold border accent to draw the eye.
  const tierCard = (tier) => {
    const isFeatured = !!tier.featured
    return `
      <div style="flex:1;background:var(--bg3);border:2px solid ${isFeatured ? 'var(--accent)' : 'var(--border2)'};border-radius:16px;padding:24px;display:flex;flex-direction:column;min-width:0;position:relative">
        ${isFeatured ? '<div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--accent);color:var(--accent-fg);font-size:10px;font-weight:700;padding:3px 10px;border-radius:999px;letter-spacing:0.5px">RECOMMENDED</div>' : ''}
        <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:4px">${tier.name}</div>
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">
          <span style="font-size:32px;font-weight:700;color:var(--text);font-family:'DM Serif Display',serif">${tier.priceLabel}</span>
          ${tier.priceUsd > 0 ? '<span style="font-size:13px;color:var(--text3)">/month</span>' : ''}
        </div>
        <div style="font-size:13px;color:var(--text3);line-height:1.5;margin-bottom:18px;min-height:38px">${tier.description}</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;flex:1">
          ${tier.features.map(f => `
            <div style="display:flex;gap:10px;align-items:start;font-size:13px;${f.included ? 'color:var(--text)' : 'color:var(--text3);text-decoration:line-through'}">
              <span style="color:${f.included ? 'var(--protein)' : 'var(--text3)'};flex-shrink:0;width:14px;text-align:center">${f.included ? '✓' : '×'}</span>
              <span style="flex:1;line-height:1.4">${esc(f.text)}</span>
            </div>`).join('')}
        </div>
        ${tier.id === 'premium' ? `
          <button onclick="handleUpgradeClick()"
            style="background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);padding:13px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;width:100%">
            Upgrade to Premium
          </button>
        ` : `
          <div style="text-align:center;padding:13px;font-size:13px;color:var(--text3)">Current plan</div>
        `}
      </div>
    `
  }

  container.innerHTML = `
    <div style="max-width:720px;margin:0 auto;padding:24px 20px">
      <div style="text-align:center;margin-bottom:32px">
        <div style="font-size:32px;margin-bottom:12px">⚡</div>
        ${featureLabel ? `
          <div style="font-size:22px;font-weight:700;color:var(--text);margin-bottom:6px;font-family:'DM Serif Display',serif">Unlock ${esc(featureLabel)}</div>
          <div style="font-size:14px;color:var(--text3);max-width:440px;margin:0 auto;line-height:1.5">Upgrade to Premium to use all AI features and get ${bucksCount(10.00)} AI Bucks every month.</div>
        ` : `
          <div style="font-size:26px;font-weight:700;color:var(--text);margin-bottom:6px;font-family:'DM Serif Display',serif">Choose your plan</div>
          <div style="font-size:14px;color:var(--text3);max-width:440px;margin:0 auto;line-height:1.5">Get more AI Bucks and unlock every feature.</div>
        `}
      </div>

      <!-- Two-tier grid. Flex-wraps to single column on narrow screens. -->
      <div style="display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap" class="upgrade-grid">
        ${TIERS.map(tierCard).join('')}
      </div>

      <!-- What are AI Bucks? little explainer below — answers the obvious
           question without forcing a user to click away. -->
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:16px;font-size:12px;color:var(--text3);line-height:1.5">
        <div style="color:var(--text2);font-weight:600;margin-bottom:6px">What are AI Bucks?</div>
        AI Bucks power every smart feature in the app — photo analysis, barcode scanning, recipe import, and the meal planner AI. Most actions cost just 1–3 AI Bucks, and your monthly allotment resets on the 1st.
      </div>

      <div style="text-align:center;margin-top:20px;font-size:12px;color:var(--text3)">
        Are you a dietitian, coach, or nutrition pro? <a href="#" onclick="alert('Provider applications coming soon — reach out to the team for early access.');return false" style="color:var(--accent);text-decoration:none">Apply to be a provider →</a>
      </div>
    </div>

    <style>
      @media (max-width: 560px) {
        .upgrade-grid > * { flex: 1 1 100% !important }
      }
    </style>
  `
}

// Placeholder upgrade handler. Real payment wiring comes later; for now
// we just let them know it's in development so they don't hit a dead
// button. Collecting intent here would be the right next step.
window.handleUpgradeClick = () => {
  alert("Premium is coming soon. Reach out to the team for early access, or hit the thumbs-up button in the app to let us know you're interested.")
}

function renderPage() {
  const main = document.getElementById('main-content')
  // Toggle wide layout for pages that benefit from horizontal space (planner
  // week grid, recipe/food card grids). Dashboard/goals/account stay at the
  // focused ~1040px reading width.
  const widePages = new Set(['planner', 'recipes', 'foods', 'history', 'analytics'])
  if (main) {
    if (widePages.has(state.currentPage)) main.classList.add('main-wide')
    else main.classList.remove('main-wide')
  }
  // Paywall check for free users
  if (state.usage?.isFree && !userCanAccess(state.currentPage)) {
    renderUpgradePage(main, state.currentPage)
    updateSidebar()
    return
  }
  switch (state.currentPage) {
    case 'log':
      try {
        renderDashboard(main)
      } catch (e) {
        console.error('Dashboard render failed:', e)
        main.innerHTML = `<div style="padding:20px">
          <div class="greeting">Dashboard</div>
          <div class="greeting-sub" style="color:var(--fat)">Something went wrong rendering the dashboard.</div>
          <div class="upload-card">
            <div style="font-size:13px;color:var(--text2);margin-bottom:8px">${esc(e.message || 'Unknown error')}</div>
            <pre style="font-size:11px;color:var(--text3);white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow-y:auto">${esc(e.stack || '')}</pre>
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
              <button onclick="switchPage('analytics')" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text);padding:8px 14px;border-radius:var(--r);font-family:inherit;font-size:13px;cursor:pointer">Try analytics</button>
              <button onclick="switchPage('planner')" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text);padding:8px 14px;border-radius:var(--r);font-family:inherit;font-size:13px;cursor:pointer">Try planner</button>
              <button onclick="location.reload()" style="background:var(--accent);border:none;color:var(--accent-fg);padding:8px 14px;border-radius:var(--r);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer">Hard reload</button>
            </div>
          </div>
        </div>`
      }
      break
    case 'analytics':
      try {
        renderAnalyticsPage(main)
      } catch (e) {
        console.error('Analytics page render failed:', e)
        main.innerHTML = `<div class="greeting">Analytics</div>
          <div class="greeting-sub">Something went wrong loading analytics.</div>
          <div class="upload-card">
            <div style="font-size:13px;color:var(--text2);margin-bottom:8px">${esc(e.message || 'Unknown error')}</div>
            <div style="font-size:11px;color:var(--text3)">Try reloading. If the issue persists, tap the thumbs-down to report it.</div>
          </div>`
      }
      break
    case 'planner':  renderPlanner(main); break
    case 'history':  renderHistory(main); break
    case 'goals':    renderGoalsPage(main); break
    case 'recipes':  renderRecipesPage(main); break
    case 'providers': renderProvidersPage(main); break
    case 'foods':    renderFoodsPage(main); break
    case 'account':
      try {
        renderAccount(main)
      } catch(e) {
        main.innerHTML = `<div style="padding:20px;color:var(--fat)">
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">Account page error</div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:8px">${e.message}</div>
          <pre style="font-size:11px;color:var(--text3);white-space:pre-wrap;overflow-wrap:anywhere">${e.stack}</pre>
        </div>`
      }
      break
  }
  updateSidebar()
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

// ─── Meal type helpers ────────────────────────────────────────────────────────
const MEAL_TYPES = ['Breakfast', 'Lunch', 'Snack', 'Dinner']
const MEAL_TYPE_ICONS = { Breakfast: '🌅', Lunch: '☀️', Snack: '🍎', Dinner: '🌙' }
window.MEAL_TYPES = MEAL_TYPES
window.MEAL_TYPE_ICONS = MEAL_TYPE_ICONS

function getMealTypeFromTime(date) {
  const h = (date instanceof Date ? date : new Date(date)).getHours()
  if (h >= 5  && h < 10) return 'Breakfast'
  if (h >= 10 && h < 14) return 'Lunch'
  if (h >= 14 && h < 17) return 'Snack'
  if (h >= 17 && h < 22) return 'Dinner'
  return 'Snack'
}

function getTodayPlannedMeals() {
  if (!state.planner?.meals) return []
  const dow = new Date().getDay()
  return (state.planner.meals[dow] || []).filter(m =>
    !m.is_leftover && !m.leftover && !(m.meal_name || m.name || '').toLowerCase().includes('(leftover')
  )
}

function renderDashboard(container) {
  const h = new Date().getHours()
  const greeting = h < 12 ? 'Good morning.' : h < 17 ? 'Good afternoon.' : 'Good evening.'
  const todayLog = getTodayLog()

  container.innerHTML = `
    <div class="greeting">${greeting}</div>
    <div class="greeting-sub">Log your meals and track your macros.</div>

    <!-- Analyze food -->
    <div class="two-col">
      <div class="upload-card">
        <div class="section-title" style="display:flex;align-items:center;gap:8px">
          <span>Analyze food</span>
          ${state.usage?.isFree ? '<span style="font-size:10px;padding:2px 8px;background:color-mix(in srgb, var(--accent) 12%, transparent);color:var(--accent);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);border-radius:999px;font-weight:500">⚡ Uses AI Bucks</span>' : ''}
        </div>
        <!-- Top-level: just Food vs Recipe. Everything else is nested. -->
        <div class="mode-tabs">
          <button class="mode-tab ${state.currentMode === 'food' ? 'active' : ''}" data-mode="food" onclick="switchMode('food')">🍎 Food</button>
          <button class="mode-tab ${state.currentMode === 'recipe' ? 'active' : ''}" data-mode="recipe" onclick="switchMode('recipe')">📖 Recipe</button>
        </div>

        <!-- RECIPE: 2 sub-modes (write / snap) — link support is merged
             into the write textarea (URLs pasted there are detected
             automatically and routed through web search) -->
        <div class="mode-panel ${state.currentMode === 'recipe' ? 'active' : ''}" id="mode-recipe">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
            <button class="food-sub-btn ${state.recipeMode === 'write' ? 'active' : ''}"
              onclick="setRecipeMode('write')" id="recipe-btn-write">
              <span style="font-size:18px;display:block;margin-bottom:2px">✍️</span>
              <span style="font-size:11px">Write it</span>
            </button>
            <button class="food-sub-btn ${state.recipeMode === 'snap' ? 'active' : ''}"
              onclick="setRecipeMode('snap')" id="recipe-btn-snap">
              <span style="font-size:18px;display:block;margin-bottom:2px">📸</span>
              <span style="font-size:11px">Photo</span>
            </button>
          </div>

          <!-- Write it — handles description, ingredient lists, AND URLs -->
          <div id="recipe-panel-write" style="${state.recipeMode === 'write' ? '' : 'display:none'}">
            <textarea class="recipe-textarea" id="recipe-input" rows="6"
              oninput="checkRecipeWriteHint(this.value)"
              placeholder="Describe the recipe, paste ingredients, or drop a URL.&#10;&#10;All of these work:&#10;&#10;• Grilled chicken bowl with rice and broccoli&#10;&#10;• 2 cups chicken breast&#10;  1 cup brown rice&#10;  1 tbsp olive oil&#10;&#10;• https://cookingclassy.com/chicken-piccata"></textarea>

            <!-- Static fallback note (default) -->
            <div id="recipe-write-note" class="link-note" style="font-size:11px;color:var(--text3);margin-top:6px">
              URLs get extracted and searched. Instagram/TikTok fall back to dish-name search.
            </div>

            <!-- Active hint for private-platform URLs. Hidden by default;
                 checkRecipeWriteHint() flips display based on textarea content. -->
            <div id="recipe-write-private-hint" style="display:none;margin-top:8px;padding:10px 12px;border-radius:var(--r);background:color-mix(in srgb, var(--accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--accent) 25%, transparent);font-size:12px;color:var(--text2);line-height:1.45">
              <div style="font-weight:600;color:var(--accent);margin-bottom:4px">📱 <span id="recipe-write-private-platform">Instagram</span> links are private</div>
              <div>We can't read reel content directly. Try one of these:</div>
              <ul style="margin:6px 0 0 0;padding-left:18px">
                <li>Add the dish name below the link (e.g. <em>"viral baked feta pasta"</em>) — AI will search for the recipe</li>
                <li>Copy the caption text and paste it here</li>
                <li>Screenshot the ingredient list and use <strong>Photo</strong> instead</li>
              </ul>
            </div>
          </div>

          <!-- Snap recipe — photo of a cookbook page, recipe card, or screenshot -->
          <div id="recipe-panel-snap" style="${state.recipeMode === 'snap' ? '' : 'display:none'}">
            <input type="file" id="recipe-snap-camera" accept="image/*" capture="environment" style="display:none" />
            <input type="file" id="recipe-snap-library" accept="image/*" style="display:none" />
            <div id="recipe-snap-preview" style="border:1.5px dashed var(--border2);border-radius:var(--r);background:var(--bg3);min-height:160px;display:flex;align-items:center;justify-content:center;padding:24px 20px">
              <div style="text-align:center">
                <div style="font-size:36px;margin-bottom:10px">📸</div>
                <div style="font-size:16px;color:var(--text);font-weight:500;margin-bottom:6px">Snap a recipe</div>
                <div style="font-size:13px;color:var(--text2);line-height:1.4;max-width:280px;margin:0 auto">Cookbook page, recipe card, or blog screenshot — AI reads and analyzes it</div>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
              <button type="button" id="recipe-snap-btn-camera"
                style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px;color:var(--text);font-size:13px;font-family:inherit;cursor:pointer">
                📷 Camera
              </button>
              <button type="button" id="recipe-snap-btn-library"
                style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px;color:var(--text);font-size:13px;font-family:inherit;cursor:pointer">
                🖼️ Choose photo
              </button>
            </div>
          </div>
        </div>

        <!-- FOOD: 2 sub-modes (describe / photo). The photo mode runs
             auto-detection: barcode → nutrition label → meal photo.
             User doesn't pick which; we figure it out from the image. -->
        <div class="mode-panel ${state.currentMode === 'food' ? 'active' : ''}" id="mode-food">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
            <button class="food-sub-btn ${state.foodMode === 'search' ? 'active' : ''}"
              onclick="setFoodMode('search')" id="food-btn-search">
              <span style="font-size:18px;display:block;margin-bottom:2px">🔤</span>
              <span style="font-size:11px">Describe</span>
            </button>
            <button class="food-sub-btn ${state.foodMode === 'photo' ? 'active' : ''}"
              onclick="setFoodMode('photo')" id="food-btn-photo">
              <span style="font-size:18px;display:block;margin-bottom:2px">📸</span>
              <span style="font-size:11px">Photo</span>
            </button>
          </div>

          <!-- Describe food -->
          <div id="food-panel-search" style="${state.foodMode === 'search' ? '' : 'display:none'}">
            <input class="link-input" id="food-search-input"
              placeholder="e.g. RXBAR Chocolate Sea Salt, greek yogurt 150g, Quest bar..."
              style="margin-bottom:6px" />
            <div style="font-size:11px;color:var(--text3)">AI looks up the exact nutrition facts for the product or food you describe</div>
          </div>

          <!-- Unified photo input — auto-detects barcode / label / meal.
               The underlying pipeline is unchanged (we still have
               decodeBarcodeFromFile, analyzeNutritionLabel, analyzePhoto);
               we just route based on what's in the image. -->
          <div id="food-panel-photo" style="${state.foodMode === 'photo' ? '' : 'display:none'}">
            <input type="file" id="foodphoto-camera" accept="image/*" capture="environment" style="display:none" />
            <input type="file" id="foodphoto-library" accept="image/*" style="display:none" />
            <div id="foodphoto-preview" style="border:1.5px dashed var(--border2);border-radius:var(--r);background:var(--bg3);min-height:160px;display:flex;align-items:center;justify-content:center;padding:24px 20px">
              <div style="text-align:center">
                <div style="font-size:36px;margin-bottom:10px">📸</div>
                <div style="font-size:16px;color:var(--text);font-weight:500;margin-bottom:6px">Take or upload a photo</div>
                <div style="font-size:13px;color:var(--text2);line-height:1.4;max-width:280px;margin:0 auto">Barcode, nutrition label, or a meal — we'll figure out what it is</div>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
              <button type="button" id="foodphoto-btn-camera"
                style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px;color:var(--text);font-size:13px;font-family:inherit;cursor:pointer">
                📷 Camera
              </button>
              <button type="button" id="foodphoto-btn-library"
                style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px;color:var(--text);font-size:13px;font-family:inherit;cursor:pointer">
                🖼️ Choose photo
              </button>
            </div>
            <div id="foodphoto-status" style="font-size:12px;color:var(--text3);margin-top:6px;text-align:center;min-height:18px"></div>
            <input id="barcode-manual-input" class="link-input" placeholder="Or type barcode number..." style="margin-top:6px;display:none"
              onkeydown="if(event.key==='Enter')lookupBarcode(this.value)" />
          </div>
        </div>

        <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
          <textarea id="meal-name-input" placeholder="Meal name (optional)..." rows="1" style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px 12px;color:var(--text);font-size:13px;font-family:'DM Sans',sans-serif;resize:none;outline:none;"></textarea>
          <button class="analyze-btn" id="analyze-btn" onclick="analyzeFoodHandler()">Analyze with AI</button>
        </div>
      </div>

      <div class="result-card" id="result-card" style="${state.currentEntry ? '' : 'display:none'}">
        <div id="result-content" style="display:flex;flex-direction:column;gap:14px">
          <div class="result-name" id="res-name" style="color:var(--text3);font-family:inherit;font-size:15px">Results will appear here after analysis</div>
          <div class="result-desc" id="res-desc"></div>
          <div class="macro-pills" id="res-pills"></div>
          <div class="nutrition-detail" id="res-detail"></div>
          <button class="log-btn" id="log-entry-btn" onclick="logCurrentEntryHandler()" style="display:none">+ Log this meal</button>
        </div>
      </div>
    </div>

    <!-- Quick log — AI-free path. For free users, the Free badge calls
         out that this doesn't burn AI Bucks. -->
    <div class="log-card" style="margin-bottom:16px">
      <div class="log-header">
        <span class="log-header-title">Quick log ${state.usage?.isFree ? '<span style="font-size:10px;margin-left:6px;padding:2px 8px;background:rgba(76,175,130,0.15);color:var(--protein);border:1px solid rgba(76,175,130,0.3);border-radius:999px;font-weight:500;letter-spacing:0">⚡ Free · No AI</span>' : ''}</span>
        <span style="font-size:11px;color:var(--text3)">from recipes & history</span>
      </div>
      <div style="padding:12px 16px">
        <input class="planner-search" id="quick-log-search" placeholder="Search meals and recipes to log..."
          oninput="filterQuickLog()" style="margin-bottom:8px" />
        <div id="quick-log-list"></div>
      </div>
    </div>

    <!-- Daily macro counts -->
    <div class="stats-row">
      <div class="stat-card"><div class="stat-label">Calories</div><div class="stat-val" style="color:var(--cal)" id="stat-cal">0</div><div class="stat-sub">of <span id="stat-cal-goal">${state.goals.calories}</span> kcal</div></div>
      <div class="stat-card"><div class="stat-label">Protein</div><div class="stat-val" style="color:var(--protein)" id="stat-p">0g</div><div class="stat-sub">of <span id="stat-p-goal">${state.goals.protein}</span>g</div></div>
      <div class="stat-card"><div class="stat-label">Carbs</div><div class="stat-val" style="color:var(--carbs)" id="stat-c">0g</div><div class="stat-sub">of <span id="stat-c-goal">${state.goals.carbs}</span>g</div></div>
      <div class="stat-card"><div class="stat-label">Fat</div><div class="stat-val" style="color:var(--fat)" id="stat-f">0g</div><div class="stat-sub">of <span id="stat-f-goal">${state.goals.fat}</span>g</div></div>
    </div>

    <!-- Today's meals -->
    <div class="log-card" style="margin-bottom:16px">
      <div class="log-header">
        <span class="log-header-title">Today's meals</span>
      </div>
      <div id="today-log-body">${renderTodayMeals(todayLog)}</div>
    </div>

    <!-- Macro breakdown / Goal progress -->
    <div class="chart-row">
      <div class="chart-card">
        <div class="chart-title">Macro breakdown today</div>
        <div class="donut-wrap">
          <svg width="120" height="120" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="50" fill="none" stroke="var(--bg4)" stroke-width="18"/>
            <circle id="d-protein" cx="60" cy="60" r="50" fill="none" stroke="var(--protein)" stroke-width="18" stroke-dasharray="0 314" stroke-linecap="round" transform="rotate(-90 60 60)" style="transition:stroke-dasharray 0.7s"/>
            <circle id="d-carbs" cx="60" cy="60" r="50" fill="none" stroke="var(--carbs)" stroke-width="18" stroke-dasharray="0 314" stroke-linecap="round" transform="rotate(-90 60 60)" style="transition:stroke-dasharray 0.7s"/>
            <circle id="d-fat" cx="60" cy="60" r="50" fill="none" stroke="var(--fat)" stroke-width="18" stroke-dasharray="0 314" stroke-linecap="round" transform="rotate(-90 60 60)" style="transition:stroke-dasharray 0.7s"/>
            <text x="60" y="56" text-anchor="middle" font-size="14" font-weight="600" fill="var(--text)" id="donut-cal">0</text>
            <text x="60" y="70" text-anchor="middle" font-size="10" fill="var(--text3)">kcal</text>
          </svg>
          <div class="donut-legend">
            <div class="legend-row"><div class="legend-dot" style="background:var(--protein)"></div><span class="legend-label">Protein</span><span class="legend-pct" id="leg-p">0%</span></div>
            <div class="legend-row"><div class="legend-dot" style="background:var(--carbs)"></div><span class="legend-label">Carbs</span><span class="legend-pct" id="leg-c">0%</span></div>
            <div class="legend-row"><div class="legend-dot" style="background:var(--fat)"></div><span class="legend-label">Fat</span><span class="legend-pct" id="leg-f">0%</span></div>
          </div>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Goal progress</div>
        <div class="bar-chart">
          <div><div class="bar-row-label"><span class="bar-label">Calories</span><span class="bar-val" id="bar-cal-val">—</span></div><div class="bar-bg"><div class="bar-fill" id="bar-cal" style="background:var(--cal);width:0%"></div></div></div>
          <div><div class="bar-row-label"><span class="bar-label">Protein</span><span class="bar-val" id="bar-p-val">—</span></div><div class="bar-bg"><div class="bar-fill" id="bar-p" style="background:var(--protein);width:0%"></div></div></div>
          <div><div class="bar-row-label"><span class="bar-label">Carbs</span><span class="bar-val" id="bar-c-val">—</span></div><div class="bar-bg"><div class="bar-fill" id="bar-c" style="background:var(--carbs);width:0%"></div></div></div>
          <div><div class="bar-row-label"><span class="bar-label">Fat</span><span class="bar-val" id="bar-f-val">—</span></div><div class="bar-bg"><div class="bar-fill" id="bar-f" style="background:var(--fat);width:0%"></div></div></div>
        </div>
      </div>
    </div>

    <!-- Analytics -->
    ${renderDashboardAnalyticsWidget()}
  `

  updateStats()
  // Wire today log clicks — use setTimeout to ensure DOM is ready
  setTimeout(() => {
    const el = document.getElementById('today-log-body')
    if (el) wireTodayLogClicks(el)
  }, 0)
  // Show quick log empty state or recent items immediately
  setTimeout(() => filterQuickLog(), 0)
  // Set correct analyze button label for current mode
  setTimeout(() => window.updateAnalyzeBtn(), 0)
  if (state.currentMode === 'food') {
    if (state.foodMode === 'photo') wireFoodPhotoInput()
  } else if (state.currentMode === 'recipe') {
    if (state.recipeMode === 'snap') wireRecipeSnapInput()
  }

  // Restore food-photo preview if exists (shown inside foodphoto-preview now)
  if (state.imageBase64) {
    const preview = document.getElementById('foodphoto-preview')
    if (preview) preview.innerHTML = `<img src="data:image/jpeg;base64,${state.imageBase64}" style="max-height:220px;border-radius:var(--r);object-fit:contain" alt="preview">`
  }
  // Restore recipe-snap preview if exists
  if (state.recipeImageBase64) {
    const preview = document.getElementById('recipe-snap-preview')
    if (preview) preview.innerHTML = `<img src="data:image/jpeg;base64,${state.recipeImageBase64}" style="max-height:220px;border-radius:var(--r);object-fit:contain" alt="recipe">`
  }
  // Restore result if exists
  if (state.currentEntry) {
    showResult(state.currentEntry)
  }
}

// ─── History ──────────────────────────────────────────────────────────────────
function renderHistory(container) {
  container.innerHTML = `
    <div class="greeting">History</div>
    <div class="greeting-sub">All logged meals. Click any row to edit.</div>
    <div class="log-card">
      <div class="log-header"><span class="log-header-title">All entries</span></div>
      ${renderLogTable(state.log, false)}
    </div>
  `
}

function renderTodayMeals(logEntries) {
  const planned = getTodayPlannedMeals()
  const enriched = logEntries.map(e => ({
    ...e,
    _mealType: e.meal_type || getMealTypeFromTime(new Date(e.logged_at || e.timestamp))
  }))
  const loggedNames = new Set(logEntries.map(e => (e.name || '').toLowerCase()))
  const grouped = {}
  MEAL_TYPES.forEach(t => { grouped[t] = [] })
  enriched.forEach(e => { if (grouped[e._mealType]) grouped[e._mealType].push(e) })
  const plannedByType = {}
  MEAL_TYPES.forEach(t => { plannedByType[t] = [] })
  planned.forEach((m, i) => {
    const type = m.meal_type || MEAL_TYPES[Math.min(i, MEAL_TYPES.length - 1)]
    if (plannedByType[type]) plannedByType[type].push(m)
  })
  const activeMealTypes = MEAL_TYPES.filter(t => grouped[t].length > 0 || plannedByType[t].length > 0)
  if (!activeMealTypes.length) {
    return '<div class="log-empty">No meals yet today. Analyze a meal or check off a planned meal.</div>'
  }

  let html = ''
  activeMealTypes.forEach(mealType => {
    const logs = grouped[mealType]
    const plans = plannedByType[mealType]
    const mealCal = logs.reduce((a, e) => a + (e.calories || 0), 0)
    const mealP   = logs.reduce((a, e) => a + (e.protein  || 0), 0)
    const mealC   = logs.reduce((a, e) => a + (e.carbs    || 0), 0)
    const mealF   = logs.reduce((a, e) => a + (e.fat      || 0), 0)
    const icon = MEAL_TYPE_ICONS[mealType] || ''

    html += '<div style="margin-bottom:4px">'
    // Header
    html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px 4px;background:var(--bg3)">'
    html += '<span style="font-size:12px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px">' + icon + ' ' + mealType + '</span>'
    if (logs.length) {
      html += '<span style="font-size:11px;color:var(--text3)">'
        + '<span style="color:var(--accent)">' + Math.round(mealCal) + '</span> kcal'
        + ' <span style="color:var(--protein)">P' + Math.round(mealP) + '</span>'
        + ' <span style="color:var(--carbs)">C' + Math.round(mealC) + '</span>'
        + ' <span style="color:var(--fat)">F' + Math.round(mealF) + '</span>'
        + '</span>'
    }
    html += '</div>'

    // Planned rows — data-plan-id for click delegation
    plans.forEach(m => {
      const mealName = esc(m.meal_name || m.name || '')
      const isLogged = loggedNames.has((m.meal_name || m.name || '').toLowerCase())
      const check = isLogged
        ? '<svg width="10" height="10" viewBox="0 0 10 10"><polyline points="1.5,5 4,7.5 8.5,2" stroke="white" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>' : ''
      html += '<div data-plan-id="' + m.id + '" data-meal-type="' + mealType + '" style="display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--border);cursor:pointer;opacity:' + (isLogged ? '0.5' : '1') + '">'
        + '<div style="width:20px;height:20px;border-radius:50%;border:2px solid ' + (isLogged ? 'var(--protein)' : 'var(--border2)') + ';background:' + (isLogged ? 'var(--protein)' : 'none') + ';flex-shrink:0;display:flex;align-items:center;justify-content:center">' + check + '</div>'
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-size:13px;color:var(--text2)' + (isLogged ? ';text-decoration:line-through' : '') + '">' + mealName + '</div>'
        + '<div style="font-size:11px;color:var(--text3)">Planned · ' + Math.round(m.calories || 0) + ' kcal</div>'
        + '</div>'
        + (isLogged ? '<span style="font-size:11px;color:var(--text3);flex-shrink:0">Tap to unlog</span>' : '<span style="font-size:11px;color:var(--text3);flex-shrink:0">Log it →</span>')
        + '</div>'
    })

    // Logged rows — data-log-id for click delegation
    logs.forEach(e => {
      const timeStr = new Date(e.logged_at || e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const servingTxt = e.servings_consumed && e.servings_consumed != 1
        ? '<span style="font-size:10px;color:var(--text3);margin-left:4px">×' + e.servings_consumed + '</span>' : ''
      const entryIcon = MEAL_TYPE_ICONS[e._mealType] || ''
      html += '<div data-log-id="' + e.id + '" style="display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--border);cursor:pointer">'
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-size:13px;color:var(--text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e.name) + servingTxt + '</div>'
        + '<div style="font-size:11px;color:var(--text3);margin-top:1px;display:flex;align-items:center;gap:6px">'
        + '<span>' + timeStr + '</span>'
        + '<span data-type-btn="' + e.id + '" data-current-type="' + e._mealType + '" style="cursor:pointer;color:var(--text3);font-size:10px;padding:1px 4px;border-radius:3px;border:1px solid var(--border)">'
        + entryIcon + ' ' + e._mealType + ' ▾</span>'
        + '</div></div>'
        + '<div style="text-align:right;flex-shrink:0;font-size:12px">'
        + '<div style="color:var(--accent);font-weight:600">' + Math.round(e.calories) + ' kcal</div>'
        + '<div style="color:var(--text3)">P' + Math.round(e.protein) + ' C' + Math.round(e.carbs) + ' F' + Math.round(e.fat) + '</div>'
        + '</div></div>'
    })

    html += '</div>'
  })
  return html
}


function renderLogTable(entries, isToday) {
  if (!entries.length) return `<div class="log-empty">${isToday ? 'No entries yet. Analyze a meal to get started.' : 'No history yet.'}</div>`
  return `
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
      <table class="log-table" style="min-width:480px;width:100%">
        <thead>
          <tr>
            <th style="text-align:left">Meal</th>
            <th>${isToday ? 'Time' : 'Date'}</th>
            ${!isToday ? '<th>Type</th>' : ''}
            <th>Cal</th>
            <th>P</th>
            <th>C</th>
            <th>F</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(e => {
            const d = new Date(e.logged_at || e.timestamp)
            const timeStr = isToday
              ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
            const mealType = e.meal_type || getMealTypeFromTime(d)
            const mealIcon = MEAL_TYPE_ICONS[mealType] || ''
            const servingBadge = e.servings_consumed && e.servings_consumed != 1
              ? `<span style="font-size:10px;color:var(--text3);margin-left:4px">×${e.servings_consumed}</span>` : ''
            return `<tr style="cursor:pointer" onclick="openEditModal('${e.id}', 'log')">
              <td class="td-name" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${esc(e.name)}${servingBadge}
              </td>
              <td class="td-time">${timeStr}</td>
              ${!isToday ? `<td style="font-size:11px;white-space:nowrap">${mealIcon} ${mealType}</td>` : ''}
              <td class="td-cal" style="color:var(--accent);font-weight:600">${Math.round(e.calories)}</td>
              <td class="td-p" style="color:var(--protein)">${Math.round(e.protein)}g</td>
              <td class="td-c" style="color:var(--carbs)">${Math.round(e.carbs)}g</td>
              <td class="td-f" style="color:var(--fat)">${Math.round(e.fat)}g</td>
              <td><button class="td-act" onclick="openEditModal('${e.id}','log');event.stopPropagation()">✎</button></td>
            </tr>`
          }).join('')}
        </tbody>
      </table>
    </div>
  `
}

// ─── Planner ──────────────────────────────────────────────────────────────────
async function renderPlanner(container) {
  if (typeof container === 'undefined') container = document.getElementById('main-content')
  console.log('[planner] rendering weekStart:', state.weekStart)
  const planner = await getPlannerWeek(state.user.id, state.weekStart)
  state.planner = planner

  // Ensure current week is in the weeksWithMeals list if it has meals
  const hasMealsThisWeek = planner.meals.some(d => d.length > 0)
  if (hasMealsThisWeek && !state.weeksWithMeals.includes(state.weekStart)) {
    state.weeksWithMeals = [state.weekStart, ...state.weeksWithMeals].sort().reverse()
  }

  const allMeals = planner.meals.flat()
  const isCurrentWeek = state.weekStart === getWeekStart()

  container.innerHTML = `
    <div class="greeting">Meal Planner</div>

    <!-- Week navigation bar -->
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
      <button class="td-act" onclick="shiftWeek(-1)" style="font-size:20px;padding:4px 12px;border:1px solid var(--border2);border-radius:var(--r)">‹</button>

      <button onclick="toggleCalendar()" style="flex:1;min-width:160px;background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r);padding:8px 14px;color:var(--text);font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;transition:border-color 0.15s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
        <span style="font-size:14px;font-weight:500">${formatWeekLabel(state.weekStart)}</span>
        <span style="font-size:11px;color:var(--text3)">${isCurrentWeek ? 'This week' : ''} 📅</span>
      </button>

      <button class="td-act" onclick="shiftWeek(1)" style="font-size:20px;padding:4px 12px;border:1px solid var(--border2);border-radius:var(--r)">›</button>

      ${!isCurrentWeek ? `<button onclick="jumpToToday()" style="background:color-mix(in srgb, var(--accent) 12%, transparent);color:var(--accent);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);border-radius:var(--r);padding:6px 12px;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap">Today</button>` : ''}
    </div>

    <!-- Calendar picker -->
    ${state.showCalendar ? renderCalendarPicker() : ''}

    <!-- Planner / Grocery tabs -->
    <div style="display:flex;gap:4px;margin-bottom:20px;margin-top:16px">
      <button class="mode-tab ${state.plannerView !== 'grocery' ? 'active' : ''}" onclick="setPlannerView('meals')" style="flex:0 0 auto;padding:8px 18px">📅 Meal plan</button>
      <button class="mode-tab ${state.plannerView === 'grocery' ? 'active' : ''}" onclick="setPlannerView('grocery')" style="flex:0 0 auto;padding:8px 18px">🛒 Grocery list${isPremiumOnlyFeature('grocery') ? ' <span style=\"font-size:10px;opacity:0.7;margin-left:4px\">⭐</span>' : ''}</button>
    </div>

    ${state.plannerView === 'grocery' ? '<div id="grocery-placeholder"><div class="log-empty">Loading grocery list...</div></div>' : renderMealPlanView(planner)}
  `

  // Async: inject grocery list after shell renders
  if (state.plannerView === 'grocery') {
    const groceryEl = await renderGroceryList(allMeals, planner)
    const placeholder = document.getElementById('grocery-placeholder')
    if (placeholder) placeholder.replaceWith(groceryEl)
  }
}

function renderCalendarPicker() {
  // Build a mini month calendar + quick-jump list of weeks with meals
  const today = new Date()
  const currentWeekStart = state.weekStart

  // Use state.calendarMonth if set, otherwise use the month of the current weekStart
  if (!state.calendarMonth) {
    const d = new Date(currentWeekStart + 'T00:00:00')
    state.calendarMonth = { year: d.getFullYear(), month: d.getMonth() }
  }
  const { year, month } = state.calendarMonth

  const monthName = new Date(year, month, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })

  // Build calendar days
  const firstDay = new Date(year, month, 1)
  const startOffset = firstDay.getDay() // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  // Get all weeks in this month
  const weeksSet = new Set(state.weeksWithMeals)

  function getWeekStartForDate(dateStr) {
    const [yr, mo, dy] = dateStr.split('-').map(Number)
    const d = new Date(yr, mo - 1, dy)
    d.setDate(d.getDate() - d.getDay())
    return localDateStr(d)
  }

  const cells = []
  // Empty cells for offset
  for (let i = 0; i < startOffset; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  // Quick-jump: last 10 weeks with meals (most recent first)
  const recentWeeks = state.weeksWithMeals.slice(0, 10)

  return `
    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r2);overflow:hidden;margin-bottom:4px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid var(--border)">

        <!-- Mini calendar -->
        <div style="padding:16px;border-right:1px solid var(--border)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <button onclick="shiftCalMonth(-1)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:16px;padding:2px 8px;font-family:inherit">‹</button>
            <span style="font-size:13px;font-weight:500;color:var(--text)">${monthName}</span>
            <button onclick="shiftCalMonth(1)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:16px;padding:2px 8px;font-family:inherit">›</button>
          </div>
          <!-- Day headers -->
          <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px">
            ${['S','M','T','W','T','F','S'].map(d => `<div style="text-align:center;font-size:10px;color:var(--text3);padding:2px 0">${d}</div>`).join('')}
          </div>
          <!-- Day cells -->
          <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">
            ${cells.map(day => {
              if (!day) return `<div></div>`
              const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
              const wk = getWeekStartForDate(dateStr)
              const isSelected = wk === currentWeekStart
              const hasMeals = weeksSet.has(wk)
              const isToday = dateStr === localDateStr(today)
              return `<button onclick="jumpToWeek('${wk}')"
                style="aspect-ratio:1;border-radius:50%;border:none;cursor:pointer;font-size:11px;font-family:inherit;position:relative;
                  background:${isSelected ? 'var(--accent)' : 'none'};
                  color:${isSelected ? 'var(--accent-fg)' : isToday ? 'var(--accent)' : 'var(--text)'};
                  font-weight:${isToday || isSelected ? '600' : '400'};
                  outline:${isToday && !isSelected ? '1px solid var(--accent)' : 'none'}"
                onmouseover="if(!${isSelected})this.style.background='var(--bg3)'"
                onmouseout="if(!${isSelected})this.style.background='none'"
              >${day}${hasMeals && !isSelected ? `<span style="position:absolute;bottom:1px;left:50%;transform:translateX(-50%);width:4px;height:4px;background:var(--accent);border-radius:50%;opacity:0.6"></span>` : ''}</button>`
            }).join('')}
          </div>
        </div>

        <!-- Recent weeks with meals -->
        <div style="padding:16px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px">Weeks with meals</div>
          ${!recentWeeks.length
            ? `<div style="font-size:12px;color:var(--text3)">No planned weeks yet</div>`
            : recentWeeks.map(wk => {
                const isSelected = wk === currentWeekStart
                const [wyr,wmo,wdy] = wk.split('-').map(Number)
                const d = new Date(wyr, wmo-1, wdy)
                const end = new Date(wyr, wmo-1, wdy+6)
                const label = `${d.toLocaleDateString([], {month:'short',day:'numeric'})} – ${end.toLocaleDateString([], {month:'short',day:'numeric'})}`
                const isThisWeek = wk === getWeekStart()
                return `<button onclick="jumpToWeek('${wk}')"
                  style="width:100%;text-align:left;background:${isSelected ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'none'};
                    border:1px solid ${isSelected ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'transparent'};
                    border-radius:var(--r);padding:7px 10px;margin-bottom:4px;
                    color:${isSelected ? 'var(--accent)' : 'var(--text2)'};
                    font-size:12px;font-family:inherit;cursor:pointer;display:flex;justify-content:space-between;align-items:center"
                  onmouseover="if(!${isSelected})this.style.background='var(--bg3)'"
                  onmouseout="if(!${isSelected})this.style.background='none'"
                >
                  <span>${label}</span>
                  ${isThisWeek ? `<span style="font-size:10px;color:var(--accent)">this week</span>` : ''}
                </button>`
              }).join('')}
          ${state.weeksWithMeals.length > 10 ? `<div style="font-size:11px;color:var(--text3);margin-top:4px">+ ${state.weeksWithMeals.length - 10} more — use calendar to navigate</div>` : ''}
        </div>
      </div>
      <button onclick="toggleCalendar()" style="width:100%;background:none;border:none;color:var(--text3);font-size:12px;padding:8px;cursor:pointer;font-family:inherit">Close ✕</button>
    </div>
  `
}

function renderMealPlanView(planner) {
  const MEAL_SLOTS = [
    { key: 'breakfast', label: 'Breakfast', icon: '🌅', color: 'var(--cal)' },
    { key: 'lunch',     label: 'Lunch',     icon: '☀️',  color: 'var(--carbs)' },
    { key: 'snack',     label: 'Snack',     icon: '🍎',  color: 'var(--protein)' },
    { key: 'dinner',    label: 'Dinner',    icon: '🌙',  color: 'var(--fat)' },
  ]

  // NOTE: We rely solely on the meal's own is_leftover flag here — we do NOT
  // infer "leftover" from "same recipe earlier in the week." A user may plan
  // the same recipe fresh on two different days (separate cooks), and that's
  // totally valid. If the user wants the second one marked as leftover, they
  // do so explicitly at plan time via the leftover toggle / "Plan as leftover"
  // prompt, which sets is_leftover=true in the DB.

  // Weekly calorie bar
  const weekCals = DAYS.map((_, di) =>
    (planner.meals[di] || []).reduce((a, m) => a + (m.calories || 0), 0)
  )
  const maxCal = Math.max(...weekCals, 1)
  const goalCal = window.state?.goals?.calories || 2000

  return `
    <!-- Weekly overview bar -->
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r2);padding:14px 16px;margin-bottom:16px">
      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Weekly overview</div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px">
        ${DAYS.map((day, di) => {
          const cal = weekCals[di]
          const pct = Math.min(100, Math.round((cal / goalCal) * 100))
          const barColor = pct > 110 ? 'var(--red)' : pct > 90 ? 'var(--protein)' : 'var(--accent)'
          const meals = planner.meals[di] || []
          const isToday = localDateStr(new Date()) === (() => {
            const ws = new Date(state.weekStart + 'T00:00:00')
            ws.setDate(ws.getDate() + di)
            return localDateStr(ws)
          })()
          return `<div style="text-align:center">
            <div style="font-size:9px;color:${isToday ? 'var(--accent)' : 'var(--text3)'};font-weight:${isToday ? '700' : '400'};margin-bottom:4px;text-transform:uppercase">${day.slice(0,3)}</div>
            <div style="height:40px;background:var(--bg3);border-radius:4px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;margin-bottom:4px">
              ${cal > 0 ? `<div style="height:${pct}%;background:${barColor};border-radius:4px;transition:height 0.3s;min-height:3px"></div>` : ''}
            </div>
            <div style="font-size:9px;color:${cal > 0 ? 'var(--text2)' : 'var(--text3)'}">${cal > 0 ? Math.round(cal) : '—'}</div>
          </div>`
        }).join('')}
      </div>
    </div>

    <!-- Day columns grouped by meal type -->
    <div style="display:flex;flex-direction:column;gap:8px">
      ${DAYS.map((day, di) => {
        const dayMeals = planner.meals[di] || []
        const dayCal = dayMeals.reduce((a, m) => a + (m.calories || 0), 0)
        const ws = new Date(state.weekStart + 'T00:00:00')
        ws.setDate(ws.getDate() + di)
        const dateStr = localDateStr(ws)
        const isToday = dateStr === localDateStr(new Date())
        const isPast = dateStr < localDateStr(new Date()) && !isToday

        return `<div style="background:var(--bg2);border:1px solid ${isToday ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border)'};border-radius:var(--r2);overflow:hidden;opacity:${isPast ? '0.7' : '1'}"
          data-planner-day="${di}" data-planner-date="${dateStr}"
          ondragover="handlePlannerDragOver(event, this)"
          ondragleave="handlePlannerDragLeave(event, this)"
          ondrop="handlePlannerDrop(event, '${dateStr}', this)">
          <!-- Day header -->
          <div style="padding:10px 14px;display:flex;align-items:center;justify-content:space-between;background:${isToday ? 'color-mix(in srgb, var(--accent) 6%, transparent)' : 'var(--bg3)'}">
            <div style="display:flex;align-items:center;gap:8px">
              <div style="font-size:14px;font-weight:600;color:${isToday ? 'var(--accent)' : 'var(--text)'}">
                ${day}
                ${isToday ? '<span style="font-size:10px;background:var(--accent);color:var(--accent-fg);border-radius:4px;padding:1px 5px;margin-left:4px;font-weight:700">TODAY</span>' : ''}
              </div>
              <div style="font-size:11px;color:var(--text3)">${new Date(dateStr + 'T00:00:00').toLocaleDateString([], {month:'short', day:'numeric'})}</div>
            </div>
            <div style="font-size:12px;color:${dayCal > 0 ? 'var(--text2)' : 'var(--text3)'}">
              ${dayCal > 0 ? Math.round(dayCal) + ' kcal' : 'Empty'}
            </div>
          </div>

          <!-- Meal slots (stacked on mobile, 2x2 grid on desktop) -->
          <div class="planner-day-slots" style="padding:8px">
            ${MEAL_SLOTS.map(slot => {
              const slotMeals = dayMeals.filter(m =>
                (m.meal_type || 'dinner').toLowerCase() === slot.key
              )
              return `<div style="margin-bottom:6px">
                <!-- Slot header + add button -->
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                  <div style="display:flex;align-items:center;gap:5px">
                    <span style="font-size:11px">${slot.icon}</span>
                    <span style="font-size:10px;font-weight:600;color:${slot.color};text-transform:uppercase;letter-spacing:0.5px">${slot.label}</span>
                  </div>
                  <button onclick="openPlannerModal(${di}, '${slot.key}')"
                    style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;padding:0 4px;line-height:1;font-family:inherit"
                    title="Add ${slot.label}">+</button>
                </div>
                <!-- Meals in this slot -->
                ${slotMeals.length ? slotMeals.map(m => {
                  // Use the explicit DB flag, not the "same recipe earlier this week"
                  // heuristic — that heuristic was misleading users who wanted to
                  // plan the same recipe fresh on two separate days.
                  const isLeftover = !!(m.is_leftover || m.leftover)
                  return `<div style="display:flex;align-items:center;gap:6px;padding:7px 8px;background:var(--bg3);border-radius:var(--r);margin-bottom:3px;cursor:pointer"
                    data-meal-id="${m.id}"
                    onclick="openEditModal('${m.id}', 'planner', {d:${di}})">
                    <span draggable="true"
                      ondragstart="handlePlannerDragStart(event, '${m.id}')"
                      ondragend="handlePlannerDragEnd(event)"
                      onclick="event.stopPropagation()"
                      style="color:var(--text3);font-size:14px;cursor:grab;user-select:none;padding:4px 6px;flex-shrink:0;line-height:1;touch-action:none"
                      title="Drag to another day">⋮⋮</span>
                    <div style="flex:1;min-width:0">
                      <div style="font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                        ${isLeftover ? '<span style="font-size:10px;background:rgba(91,156,246,0.15);color:var(--carbs);border-radius:3px;padding:1px 4px;margin-right:4px">🥡 Leftover</span>' : ''}
                        ${esc(m.meal_name || m.name || '')}
                      </div>
                      <div style="font-size:10px;color:var(--text3);margin-top:1px">${Math.round(m.calories || 0)} kcal · P${Math.round(m.protein||0)}g C${Math.round(m.carbs||0)}g F${Math.round(m.fat||0)}g</div>
                    </div>
                    ${m.recipe_id ? `<button onclick="viewPlannerRecipe('${m.recipe_id}', event)"
                      title="View recipe"
                      style="background:none;border:none;color:var(--text3);font-size:14px;cursor:pointer;padding:2px 4px;flex-shrink:0;line-height:1">📖</button>` : ''}
                    <button onclick="openMovePlannerMealMenu('${m.id}', '${m.actual_date || dateStr}', this);event.stopPropagation()"
                      style="background:none;border:none;color:var(--text3);font-size:14px;cursor:pointer;padding:2px 4px;flex-shrink:0;line-height:1"
                      title="Move to another day">↔</button>
                    <button onclick="deletePlannerMealHandler('${m.id}',${di},0);event.stopPropagation()"
                      style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:2px 4px;flex-shrink:0;line-height:1">×</button>
                  </div>`
                }).join('') : `<div style="padding:5px 8px;font-size:11px;color:var(--text3);border:1px dashed var(--border);border-radius:var(--r);cursor:pointer;text-align:center"
                  onclick="openPlannerModal(${di}, '${slot.key}')">
                  + Add ${slot.label.toLowerCase()}
                </div>`}
              </div>`
            }).join('')}
          </div>
        </div>`
      }).join('')}
    </div>
  `
}


async function renderGroceryList(allMeals, planner) {
  const view = state.groceryView || 'full'
  const today = localDateStr(new Date())

  // Compute effective date range
  const fromDate = state.groceryFromDate || today
  const toDate = state.groceryToDate || (() => {
    // Default: end of the furthest planned week
    const weeks = state.weeksWithMeals.length
      ? [...state.weeksWithMeals].sort()
      : [state.weekStart]
    const lastWeek = weeks[weeks.length - 1]
    const [yr, mo, dy] = lastWeek.split('-').map(Number)
    const d = new Date(yr, mo - 1, dy + 6)
    return localDateStr(d)
  })()

  // Fetch meals across the range (may span multiple weeks)
  let rangeMeals
  try {
    const result = await getPlannerRange(state.user.id, fromDate, toDate)
    rangeMeals = result.meals
  } catch {
    rangeMeals = planner.meals.flat()
  }
  // Cache for synchronous reads (copyGroceryList in particular — it can't
  // await without losing the iOS user-gesture token needed for clipboard
  // access). Refreshed every time the grocery view renders so it stays
  // in sync with the visible list.
  state._groceryRangeMeals = rangeMeals

  // Detect orphaned leftovers: leftovers whose source cook is outside the
  // shopping window. We fetch a broader pool (current week + a couple around
  // it) so we can tell the user WHERE the source is (helpful for context).
  const broaderPool = planner?.meals?.flat() || []
  const orphanLeftovers = rangeMeals
    .filter(m => isLeftover(m))
    .map(m => ({ leftover: m, ...findLeftoverSource(m, rangeMeals, broaderPool) }))
    .filter(x => x.isOrphan)

  // Stash orphan ids on state so collectAllIngredients can see which
  // "leftovers" actually need to be shopped for as fresh cooks.
  state._orphanLeftoverIds = new Set(orphanLeftovers.map(o => o.leftover.id))

  // Format date labels
  const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })
  const isAutoFrom = !state.groceryFromDate
  const isAutoTo = !state.groceryToDate
  const pastDaysExcluded = isAutoFrom && fromDate > (() => {
    // Check if current week has past days
    return state.weekStart
  })()

  const container = document.createElement('div')
  container.className = 'log-card'
  container.style.marginBottom = '20px'
  container.innerHTML = `
    <div class="log-header">
      <span class="log-header-title">🛒 Grocery list</span>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="clear-btn" onclick="copyGroceryList()" style="color:var(--protein)" id="grocery-copy-btn">📋 Copy</button>
        <button class="clear-btn" onclick="smartMergeGrocery()" style="color:var(--carbs)" id="grocery-merge-btn">✨ Smart merge</button>
        <button class="clear-btn" onclick="addGroceryItem()" style="color:var(--accent)">+ Add item</button>
        <button class="clear-btn" onclick="resetExclusions()" style="color:var(--text3)">Reset</button>
      </div>
    </div>

    <!-- Date range bar -->
    <div style="padding:10px 16px;background:var(--bg3);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--text3)">Shopping for:</span>
      <div style="display:flex;align-items:center;gap:6px;flex:1;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:4px">
          <input type="date" id="grocery-from" value="${fromDate}"
            onchange="setGroceryDateRange(this.value, null)"
            style="background:var(--bg4);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;color:var(--text);font-size:12px;font-family:inherit;outline:none" />
        </div>
        <span style="font-size:12px;color:var(--text3)">→</span>
        <div style="display:flex;align-items:center;gap:4px">
          <input type="date" id="grocery-to" value="${toDate}"
            onchange="setGroceryDateRange(null, this.value)"
            style="background:var(--bg4);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;color:var(--text);font-size:12px;font-family:inherit;outline:none" />
        </div>
        ${(!isAutoFrom || !isAutoTo) ? `<button onclick="resetGroceryDates()" style="font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;font-family:inherit;padding:0">Reset to today</button>` : ''}
      </div>
      ${isAutoFrom ? `<span style="font-size:11px;color:var(--protein);white-space:nowrap">✓ Past days excluded</span>` : ''}
    </div>

    ${orphanLeftovers.length > 0 ? `
      <!-- Orphaned leftovers warning -->
      <div style="padding:12px 16px;background:rgba(217,96,96,0.08);border-bottom:1px solid rgba(217,96,96,0.25)">
        <div style="display:flex;align-items:start;gap:10px">
          <div style="font-size:18px;line-height:1.2;flex-shrink:0">⚠️</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500;color:var(--text);margin-bottom:4px">
              ${orphanLeftovers.length} leftover${orphanLeftovers.length === 1 ? '' : 's'} without a cook in your shopping window
            </div>
            <div style="font-size:12px;color:var(--text2);line-height:1.5;margin-bottom:6px">
              These meals are planned as leftovers, but their source cook ${orphanLeftovers.every(o => o.source) ? 'happens before this window' : `isn't in your planner`}. You'll need to cook them fresh — their ingredients are shown below as full shopping items.
            </div>
            <div style="display:flex;flex-direction:column;gap:3px">
              ${orphanLeftovers.slice(0, 5).map(({ leftover, source }) => {
                const ldate = leftover.actualDate ? fmtDate(leftover.actualDate) : (DAYS[leftover.day_of_week] || '')
                const sdate = source?.actualDate ? ` · source was ${fmtDate(source.actualDate)}` : (source ? ` · source on ${DAYS[source.day_of_week] || '?'}` : '')
                return `<div style="font-size:11px;color:var(--text3)">
                  <span style="color:var(--text2)">${esc(originalMealName(leftover))}</span> on <span style="color:var(--text2)">${ldate}</span>${sdate}
                </div>`
              }).join('')}
              ${orphanLeftovers.length > 5 ? `<div style="font-size:11px;color:var(--text3)">+ ${orphanLeftovers.length - 5} more</div>` : ''}
            </div>
          </div>
        </div>
      </div>
    ` : ''}

    <!-- View tabs -->
    <div style="display:flex;gap:4px;padding:10px 16px;border-bottom:1px solid var(--border)">
      <button class="mode-tab ${view === 'full' ? 'active' : ''}" onclick="setGroceryView('full')" style="flex:0 0 auto;font-size:12px;padding:5px 12px">Full list</button>
      <button class="mode-tab ${view === 'bymeal' ? 'active' : ''}" onclick="setGroceryView('bymeal')" style="flex:0 0 auto;font-size:12px;padding:5px 12px">By meal</button>
      <span style="margin-left:auto;font-size:11px;color:var(--text3);align-self:center">${rangeMeals.filter(m => !isLeftover(m)).length} meals · ${fmtDate(fromDate)} – ${fmtDate(toDate)}</span>
    </div>

    <div id="grocery-body">
      ${view === 'full' ? renderGroceryFull(null, rangeMeals) : renderGroceryByMeal(null, rangeMeals)}
    </div>
  `
  return container
}

// ── Category config ────────────────────────────────────────────────────────────
// Helper — detect leftover meals (suffix added when created)
function isLeftover(meal) {
  const name = (meal.meal_name || meal.name || '').toLowerCase()
  return name.endsWith('(leftovers)') || meal.is_leftover === true
}

// Detect "orphaned" leftovers: leftovers whose source cook (the fresh,
// non-leftover instance of the same recipe) falls OUTSIDE the shopping
// window. If you mark Saturday as leftovers of a Wednesday cook but
// then set your grocery window to start Thursday, the Wednesday cook's
// ingredients aren't on your list — so the Saturday leftover is
// effectively a fresh cook you'll need to shop for.
//
// Returns { source: null, isOrphan: true } when no source is in-range,
// { source: <meal>, isOrphan: false } when it is.
function findLeftoverSource(leftover, rangeMeals, allMealsInWeeks) {
  const name = originalMealName(leftover).toLowerCase()
  const recipeId = leftover.recipe_id
  const leftoverDate = leftover.actualDate || leftover.actual_date

  // Prefer the in-range pool (ingredients the user will already be buying)
  const inRangeSource = rangeMeals.find(m => {
    if (m.id === leftover.id) return false
    if (isLeftover(m)) return false
    const matchById = recipeId && m.recipe_id === recipeId
    const matchByName = !recipeId && (m.meal_name || m.name || '').toLowerCase() === name
    if (!matchById && !matchByName) return false
    // Source must be on or before the leftover's day so the cook happens first
    const sourceDate = m.actualDate || m.actual_date
    return !leftoverDate || !sourceDate || sourceDate <= leftoverDate
  })
  if (inRangeSource) return { source: inRangeSource, isOrphan: false }

  // No in-range source — check the broader pool (state.planner) in case
  // the source is in the same week but before fromDate
  const broaderSource = (allMealsInWeeks || []).find(m => {
    if (m.id === leftover.id) return false
    if (isLeftover(m)) return false
    const matchById = recipeId && m.recipe_id === recipeId
    const matchByName = !recipeId && (m.meal_name || m.name || '').toLowerCase() === name
    return matchById || matchByName
  })
  return { source: broaderSource || null, isOrphan: true }
}

function originalMealName(meal) {
  return (meal.meal_name || meal.name || '').replace(/\s*\(leftovers\)\s*$/i, '').trim()
}

const CATEGORIES = {
  produce:    { label: 'Produce',    emoji: '🥦', color: 'var(--protein)' },
  protein:    { label: 'Protein',    emoji: '🥩', color: 'var(--fat)' },
  dairy:      { label: 'Dairy',      emoji: '🧀', color: 'var(--carbs)' },
  pantry:     { label: 'Pantry',     emoji: '🥫', color: 'var(--text2)' },
  spices:     { label: 'Spices',     emoji: '🧂', color: 'var(--fiber)' },
  grains:     { label: 'Grains',     emoji: '🌾', color: 'var(--cal)' },
  frozen:     { label: 'Frozen',     emoji: '🧊', color: 'var(--carbs)' },
  bakery:     { label: 'Bakery',     emoji: '🍞', color: 'var(--fat)' },
  beverages:  { label: 'Beverages',  emoji: '🧃', color: 'var(--text2)' },
  other:      { label: 'Other',      emoji: '📦', color: 'var(--text3)' },
}
const CATEGORY_ORDER = ['produce','protein','dairy','grains','pantry','spices','frozen','bakery','beverages','other']

// ── Unit conversion helpers ────────────────────────────────────────────────────
// Two parallel "dimensions": weight (oz) and volume (tbsp). When two
// ingredients share a dimension, their amounts can be added together
// (1/4 cup + 2 tbsp = 6 tbsp). When they don't (1 lb + 1 cup), they
// stay separate.
const UNIT_TO_OZ = { lbs: 16, lb: 16, oz: 1, g: 0.03527, kg: 35.27 }
const OZ_CONVERSIONS = ['lbs','lb','oz','g','kg']

// Volume units → tablespoons. tbsp picked as canonical because it
// produces nicer totals than ml for typical recipe quantities.
const UNIT_TO_TBSP = {
  cup: 16, cups: 16, c: 16,
  tbsp: 1, tbs: 1, tablespoon: 1, tablespoons: 1,
  tsp: 1/3, teaspoon: 1/3, teaspoons: 1/3,
  'fl oz': 2, floz: 2, 'fluid ounce': 2, 'fluid ounces': 2,
  ml: 0.0676, milliliter: 0.0676, milliliters: 0.0676,
  l: 67.628, liter: 67.628, liters: 67.628,
  pint: 32, pints: 32, pt: 32,
  quart: 64, quarts: 64, qt: 64,
  gallon: 256, gallons: 256, gal: 256,
}

function toOz(amount, unit) {
  const factor = UNIT_TO_OZ[unit?.toLowerCase()]
  return factor ? amount * factor : null
}

function toTbsp(amount, unit) {
  const factor = UNIT_TO_TBSP[unit?.toLowerCase()]
  return factor ? amount * factor : null
}

function formatAmount(oz, preferUnit) {
  if (oz === null) return null
  if (oz >= 16) return { amount: +(oz / 16).toFixed(2), unit: 'lbs' }
  return { amount: +oz.toFixed(2), unit: 'oz' }
}

// Format volume in tbsp back to the most-readable unit. Above 1/4 cup
// (4 tbsp), we render as cups so summed volumes don't show as
// "16 tbsp" when "1 cup" is what people expect.
function formatVolume(tbsp) {
  if (tbsp == null) return null
  if (tbsp >= 4) {
    const cups = tbsp / 16
    return { amount: Math.round(cups * 4) / 4, unit: 'cups' }
  }
  if (tbsp >= 1) return { amount: +tbsp.toFixed(2), unit: 'tbsp' }
  return { amount: +(tbsp * 3).toFixed(2), unit: 'tsp' }
}

function sumIngredients(items) {
  // items: [{name, amount (number), unit, category, excluded, mealName}]
  // Group by name+unit where possible, summing amounts.
  // Two-pass dedup:
  //   Pass 2 (AI synonyms, persistent across sessions): if state.aiSynonyms
  //     has an entry for this name, swap it in first.
  //   Pass 1 (regex canonicalizer, free): runs on either the original
  //     name or the AI-swapped name to handle variants the AI didn't
  //     touch. Most rows get caught here.
  // Display name on the merged row uses the final canonical form.
  //
  // We also track aiMergedFrom on each grouped row — the list of
  // ORIGINAL ingredient names that got pulled into this canonical row
  // via the AI synonym map. This drives the "✨ +N variants" badge UI
  // and the per-row unmerge button.
  const aiSyn = state.aiSynonyms || {}
  const grouped = {}
  items.forEach(item => {
    if (item.excluded) return
    const lowered = (item.name || '').toLowerCase().trim()
    // Apply AI synonym if one exists for this exact name.
    const aiHit = aiSyn[lowered]
    const afterAi = aiHit || lowered
    const canonical = canonicalizeName(afterAi) || afterAi || (item.name || '').toLowerCase().trim()
    const key = canonical
    const amt = parseAmount(item.amount)
    // Source record — captures every contribution to a grouped row,
    // with viaAi flagging whether the AI synonym map was responsible
    // (those are the only ones removed if the user unmerges).
    // Tracking ALL sources lets the merge-details modal show the full
    // composition of a row, not just the AI-merged subset — so the
    // user can see what stays vs. what splits out on unmerge.
    const sourceRecord = {
      name: item.name,
      amount: amt,
      unit: item.unit || '',
      mealName: item.mealName,
      viaAi: !!aiHit,
    }
    if (!grouped[key]) {
      grouped[key] = {
        ...item,
        name: canonical,
        totalAmount: amt,
        meals: [item.mealName],
        // sources is the full contribution list. aiMergedFrom (computed
        // from sources at render time) stays available as an alias for
        // the badge count and the unmerge variant-names.
        sources: [sourceRecord],
      }
    } else {
      const existing = grouped[key]
      // Dedupe on (name + mealName + unit) so a recipe listing the
      // same ingredient multiple times doesn't show as multiple sources.
      const dupe = existing.sources.find(s =>
        s.name.toLowerCase() === sourceRecord.name.toLowerCase()
        && s.mealName === sourceRecord.mealName
        && s.unit === sourceRecord.unit
      )
      if (!dupe) existing.sources.push(sourceRecord)
      // Try to convert through one of two dimensions:
      //   1. WEIGHT — oz/lbs/g/kg can sum together
      //   2. VOLUME — cups/tbsp/tsp/ml/L can sum together
      const existOz = toOz(existing.totalAmount, existing.unit)
      const newOz = toOz(amt, item.unit)
      const existTbsp = toTbsp(existing.totalAmount, existing.unit)
      const newTbsp = toTbsp(amt, item.unit)

      if (existOz !== null && newOz !== null) {
        const totalOz = existOz + newOz
        const fmt = formatAmount(totalOz)
        existing.totalAmount = fmt.amount
        existing.unit = fmt.unit
      } else if (existTbsp !== null && newTbsp !== null) {
        const totalTbsp = existTbsp + newTbsp
        const fmt = formatVolume(totalTbsp)
        existing.totalAmount = fmt.amount
        existing.unit = fmt.unit
      } else if (existing.unit === item.unit) {
        existing.totalAmount += amt
      } else {
        // Different units that can't convert — keep separate.
        const altKey = `${canonical}_${item.unit}`
        if (!grouped[altKey]) {
          grouped[altKey] = {
            ...item,
            name: canonical,
            totalAmount: amt,
            meals: [item.mealName],
            sources: [sourceRecord],
          }
        } else {
          grouped[altKey].totalAmount += amt
          grouped[altKey].meals.push(item.mealName)
          const altDupe = grouped[altKey].sources.find(s =>
            s.name.toLowerCase() === sourceRecord.name.toLowerCase()
            && s.mealName === sourceRecord.mealName
            && s.unit === sourceRecord.unit
          )
          if (!altDupe) grouped[altKey].sources.push(sourceRecord)
        }
        return
      }
      if (!existing.meals.includes(item.mealName)) existing.meals.push(item.mealName)
    }
  })
  // Compute aiMergedFrom from sources for compatibility with the badge
  // render path. It's just the AI-via subset of sources.
  for (const row of Object.values(grouped)) {
    row.aiMergedFrom = (row.sources || []).filter(s => s.viaAi)
  }
  return Object.values(grouped)
}

function collectAllIngredients(planner, rangeMeals) {
  // Use rangeMeals if provided (cross-week), else fall back to current week planner
  const items = []
  if (!state.excludedIngredients) state.excludedIngredients = new Set()

  const meals = rangeMeals || planner?.meals?.flat() || []

  meals.forEach(m => {
    // Skip leftovers that have a source cook in the shopping window — their
    // ingredients are covered. BUT include orphaned leftovers (source is
    // outside the window) so the user actually gets the ingredients they
    // need to cook them fresh.
    const orphanIds = state._orphanLeftoverIds || new Set()
    if (isLeftover(m) && !orphanIds.has(m.id)) return

    const mealName = m.meal_name || m.name
    const recipe = state.recipes.find(r => r.name.toLowerCase() === (originalMealName(m) || mealName).toLowerCase())
    const ingredients = recipe?.ingredients || []
    const baseServings = recipe?.servings || 1
    // Priority: 1) user override in this session, 2) planned_servings from DB, 3) base recipe servings
    const requestedServings = state.mealServings?.[m.id] ?? m.planned_servings ?? baseServings
    const multiplier = requestedServings / baseServings
    const dayLabel = m.actualDate
      ? new Date(m.actualDate + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      : (DAYS[m.day_of_week] || '')

    ingredients.forEach(ing => {
      const excKey = `${m.id}::${ing.name.toLowerCase()}`
      // Category resolution priority:
      //   1. AI-supplied category (if it matches our taxonomy)
      //   2. Keyword-based inference from the ingredient name
      //   3. 'other' as last resort
      // The keyword fallback rescues recipes where the AI dropped the
      // field entirely (sometimes happens on photo flows) — without it
      // every ingredient defaulted to 'other' and the grocery list
      // rendered as one giant unsorted blob.
      const aiCat = ing.category && CATEGORIES[ing.category] ? ing.category : null
      const fallback = aiCat || categorizeByName(ing.name) || 'other'
      items.push({
        name: ing.name,
        amount: parseAmount(ing.amount) * multiplier,
        unit: ing.unit || '',
        category: fallback,
        excluded: state.excludedIngredients.has(excKey),
        excKey,
        mealId: m.id,
        mealName,
        day: m.day_of_week,
        dayLabel,
        requestedServings,
        baseServings
      })
    })

    if (!ingredients.length) {
      const excKey = `${m.id}::${mealName.toLowerCase()}`
      items.push({
        name: mealName, amount: null, unit: '', category: 'other',
        excluded: state.excludedIngredients.has(excKey),
        excKey, mealId: m.id, mealName, day: m.day_of_week,
        dayLabel, noIngredients: true
      })
    }
  })
  return items
}

function renderGroceryFull(planner, rangeMeals) {
  const allItems = collectAllIngredients(planner, rangeMeals)
  const active = allItems.filter(i => !i.excluded)

  if (!allItems.length) return `<div class="log-empty">No meals planned yet. Add meals to the planner to generate a grocery list.</div>`

  // Sum by ingredient name
  const summed = sumIngredients(active)

  // Group by category
  const byCategory = {}
  summed.forEach(item => {
    const cat = item.category || 'other'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(item)
  })

  // Custom items
  const customItems = state.groceryCustomItems || []

  const excludedCount = allItems.filter(i => i.excluded).length

  return `
    <div style="padding:0">
      ${excludedCount ? `<div style="padding:8px 20px;font-size:12px;color:var(--text3);background:var(--bg3);border-bottom:1px solid var(--border)">${excludedCount} item${excludedCount !== 1 ? 's' : ''} excluded — <button class="clear-btn" style="color:var(--accent);font-size:12px" onclick="resetExclusions()">Show all</button></div>` : ''}

      ${CATEGORY_ORDER.filter(cat => byCategory[cat]?.length).map(cat => {
        const cfg = CATEGORIES[cat]
        const items = byCategory[cat]
        return `
          <div>
            <div style="padding:10px 20px 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${cfg.color};background:var(--bg3);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">
              <span>${cfg.emoji}</span><span>${cfg.label}</span><span style="color:var(--text3);font-weight:400">(${items.length})</span>
            </div>
            ${items.map(item => {
              const merged = item.aiMergedFrom || []
              const sources = item.sources || []
              // Encode the full row state (canonical name, total, sources
              // with viaAi flags) as base64 JSON. The modal needs ALL
              // sources to show the user the complete row composition,
              // not just the AI-merged subset — otherwise the canonical
              // contribution is invisible and the math doesn't add up.
              const mergeAttr = merged.length
                ? `data-merge-info="${btoa(unescape(encodeURIComponent(JSON.stringify({ canonical: item.name, total: item.totalAmount, unit: item.unit, sources }))))}"`
                : ''
              return `
              <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 20px;border-bottom:1px solid var(--border)" ${mergeAttr}>
                <span style="font-weight:600;color:${cfg.color};width:80px;flex-shrink:0;font-size:13px;padding-top:2px">
                  ${item.totalAmount ? `${item.totalAmount % 1 === 0 ? item.totalAmount : +item.totalAmount.toFixed(2)} ${item.unit}` : '—'}
                </span>
                <!-- Right-side column stacks the name + (optional badge)
                     on top, and the source-meal label below. This avoids
                     the prior horizontal flex layout where a long meal
                     name would push the name column to ~30px wide and
                     force per-character wrapping (Safari behavior).
                     min-width:0 prevents the column from claiming
                     intrinsic content width and overflowing the row. -->
                <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
                  <div style="font-size:14px;color:var(--text);display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0">
                    <span style="overflow-wrap:anywhere;word-break:normal;min-width:0">${esc(item.name)}</span>
                    ${merged.length ? `
                      <button onclick="showMergeDetails(this);event.stopPropagation()"
                        title="Tap to view what got merged into this row"
                        style="background:rgba(122,180,232,0.12);border:1px solid rgba(122,180,232,0.3);border-radius:999px;padding:2px 9px;font-size:10px;color:var(--carbs);cursor:pointer;font-family:inherit;white-space:nowrap;line-height:1.4;flex-shrink:0">
                        ✨ +${merged.length} variant${merged.length === 1 ? '' : 's'}
                      </button>
                    ` : ''}
                  </div>
                  ${item.meals?.length ? `
                    <div style="font-size:11px;color:var(--text3);overflow-wrap:anywhere;word-break:normal;min-width:0">${esc(item.meals.join(', '))}</div>
                  ` : ''}
                </div>
              </div>`
            }).join('')}
          </div>`
      }).join('')}

      ${customItems.length ? `
        <div>
          <div style="padding:10px 20px 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text3);background:var(--bg3);border-bottom:1px solid var(--border)">📝 Custom items</div>
          ${customItems.map((item, i) => `
            <div style="display:flex;align-items:center;gap:10px;padding:10px 20px;border-bottom:1px solid var(--border)">
              <input type="text" value="${esc(item.text)}" onchange="editCustomGroceryItem(${i}, this.value)"
                style="flex:1;background:none;border:none;outline:none;color:var(--text);font-size:14px;font-family:inherit" />
              <button class="td-act" onclick="removeCustomGroceryItem(${i})" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text3)'" style="font-size:16px">×</button>
            </div>`).join('')}
        </div>` : ''}

      ${!summed.length && !customItems.length ? `<div class="log-empty">All items excluded. <button class="clear-btn" style="color:var(--accent)" onclick="resetExclusions()">Reset</button></div>` : ''}
    </div>
  `
}

function renderGroceryByMeal(planner, rangeMeals) {
  const meals = rangeMeals || planner?.meals?.flat() || []
  const hasMeals = meals.length > 0
  if (!hasMeals) return `<div class="log-empty">No meals in this date range.</div>`
  if (!state.mealServings) state.mealServings = {}
  if (!state.excludedIngredients) state.excludedIngredients = new Set()

  // Group by day label for display
  const grouped = {}
  meals.forEach(m => {
    const label = m.actualDate
      ? new Date(m.actualDate + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
      : (DAYS[m.day_of_week] || 'Unknown')
    if (!grouped[label]) grouped[label] = []
    grouped[label].push(m)
  })

  return `
    <div style="padding:12px 20px">
      ${Object.entries(grouped).map(([dayLabel, dayMeals]) => {
        return `
          <div style="margin-bottom:20px">
            <div style="font-size:12px;font-weight:500;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">${dayLabel}</div>
            ${dayMeals.map(m => {
              const mealName = m.meal_name || m.name
              const recipe = state.recipes.find(r => r.name.toLowerCase() === mealName.toLowerCase())
              const ingredients = recipe?.ingredients || []
              const baseServings = recipe?.servings || 1
              const requestedServings = state.mealServings[m.id] ?? m.planned_servings ?? baseServings
              const multiplier = requestedServings / baseServings

              const isOrphanLeftover = isLeftover(m) && (state._orphanLeftoverIds || new Set()).has(m.id)
              const isCoveredLeftover = isLeftover(m) && !isOrphanLeftover

              return `
                <div style="margin-bottom:12px;padding:10px 12px;background:var(--bg3);border-radius:var(--r)">
                  ${isCoveredLeftover ? `
                    <!-- Leftover meal with source in range — ingredients not duplicated -->
                    <div style="display:flex;align-items:center;gap:10px">
                      <div style="flex:1">
                        <div style="font-size:13px;font-weight:500;color:var(--text2)">${esc(mealName)}</div>
                        <div style="font-size:11px;color:var(--text3);margin-top:3px">
                          ↩ Leftovers from ${originalMealName(m)} — ingredients already on your list
                        </div>
                      </div>
                      <span style="font-size:11px;padding:3px 8px;background:rgba(122,180,232,0.12);color:var(--carbs);border-radius:4px;border:1px solid rgba(122,180,232,0.25)">no shopping needed</span>
                    </div>
                  ` : `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap">
                      <div style="font-size:13px;font-weight:500;color:var(--text);flex:1;min-width:0">${esc(mealName)}</div>
                      ${isOrphanLeftover
                        ? `<span style="font-size:10px;padding:2px 7px;background:rgba(217,96,96,0.12);color:var(--red);border-radius:4px;border:1px solid rgba(217,96,96,0.3);white-space:nowrap">⚠ orphan — shopping needed</span>`
                        : (!ingredients.length
                          ? `<button class="clear-btn" style="color:var(--carbs);font-size:11px" onclick="fetchAndSaveIngredients('${m.id}', '${mealName.replace(/'/g,"\\'")}')">✨ AI extract</button>`
                          : `<span style="font-size:11px;color:var(--text3)">${ingredients.length} ingredients</span>`)}
                    </div>
                    ${isOrphanLeftover ? `
                      <div style="font-size:11px;color:var(--text3);margin-bottom:8px;padding:6px 8px;background:rgba(217,96,96,0.05);border-radius:4px;line-height:1.4">
                        Source cook is outside your shopping window. Ingredients added to your list as if cooking fresh.
                      </div>
                    ` : ''}

                    <!-- Serving size input -->
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:6px 0;border-bottom:1px solid var(--border)">
                      <span style="font-size:12px;color:var(--text3)">Servings:</span>
                      <input type="number" min="1" max="100" step="1"
                        value="${requestedServings}"
                        onchange="setMealServings('${m.id}', this.value)"
                        style="width:60px;background:var(--bg4);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;color:var(--text);font-size:13px;font-family:inherit;outline:none;text-align:center" />
                      <span style="font-size:12px;color:var(--text3)">people</span>
                      ${multiplier !== 1 ? `<span style="font-size:11px;color:var(--accent);margin-left:4px">×${+multiplier.toFixed(2)} base recipe</span>` : ''}
                    </div>

                    ${ingredients.length ? `
                      <div>
                        ${ingredients.map(ing => {
                          const excKey = `${m.id}::${ing.name.toLowerCase()}`
                          const isExcluded = state.excludedIngredients.has(excKey)
                          const adjustedAmt = parseAmount(ing.amount) * multiplier
                          const displayAmt = adjustedAmt % 1 === 0 ? adjustedAmt : +adjustedAmt.toFixed(2)
                          // Same category resolution as collectAllIngredients:
                          // AI value if valid, else keyword inference, else 'other'.
                          // Without this, every row in the per-meal view shows
                          // "Other" because the AI commonly omits category.
                          const aiCatRaw = ing.category && CATEGORIES[ing.category] ? ing.category : null
                          const resolvedCat = aiCatRaw || categorizeByName(ing.name) || 'other'
                          const cat = CATEGORIES[resolvedCat] || CATEGORIES.other
                          return `
                            <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);${isExcluded ? 'opacity:0.4' : ''}">
                              <button onclick="toggleIngredientExclusion('${m.id}', '${ing.name.replace(/'/g,"\\'")}', ${isExcluded})"
                                title="${isExcluded ? 'Add back to list' : 'Already have it — exclude from list'}"
                                style="background:none;border:none;cursor:pointer;font-size:14px;padding:0;line-height:1;flex-shrink:0">${isExcluded ? '➕' : '➖'}</button>
                              <span style="font-size:11px;padding:1px 6px;border-radius:4px;background:${cat.color}22;color:${cat.color};min-width:52px;text-align:center">${cat.emoji} ${cat.label}</span>
                              <span style="font-size:12px;font-weight:500;color:var(--text2);min-width:65px">${displayAmt} ${esc(ing.unit || '')}</span>
                              <span style="font-size:13px;color:var(--text);${isExcluded ? 'text-decoration:line-through' : ''}">${esc(ing.name)}</span>
                            </div>`
                        }).join('')}
                      </div>
                    ` : `<div style="font-size:11px;color:var(--text3)">No ingredients yet — click AI extract above</div>`}
                  `}
                </div>`
            }).join('')}
          </div>`
      }).join('')}
    </div>
  `
}



function formatWeekLabel(weekStart) {
  const [yr, mo, dy] = weekStart.split('-').map(Number)
  const d = new Date(yr, mo - 1, dy)
  const end = new Date(yr, mo - 1, dy + 6)
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
}

// ─── Foods Page ───────────────────────────────────────────────────────────────
function renderFoodsPage(container) {
  const items = state.foodItems
  const q = (state.foodSearch || '').trim().toLowerCase()
  const filtered = searchFoods(items, q)

  container.innerHTML = `
    <div class="greeting">My Foods</div>
    <div class="greeting-sub">Saved food items — single foods, combos, protein shakes.</div>

    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
      <input class="planner-search" id="food-search" placeholder="Search foods by name, brand, or component..."
        value="${esc(q)}"
        oninput="filterFoodsList(this.value)"
        style="flex:1;min-width:180px" />
      <button class="analyze-btn" style="width:auto;padding:10px 20px;flex-shrink:0" onclick="openFoodItemModal()">+ New food</button>
    </div>

    ${!filtered.length ? `
      <div class="log-card">
        <div class="log-empty" style="padding:60px">
          ${items.length ? `No foods match "${esc(q)}".` : 'No saved foods yet.'}<br>
          <span style="font-size:12px;color:var(--text3);margin-top:6px;display:block">
            ${items.length ? 'Try a different search.' : 'Save packaged foods from barcode scan, or build combos like protein shakes.'}
          </span>
        </div>
      </div>
    ` : `
      <div id="foods-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
        ${filtered.map(f => renderFoodCard(f)).join('')}
      </div>
    `}
  `

  // Restore focus on search input if the user was typing
  if (q) {
    setTimeout(() => {
      const input = document.getElementById('food-search')
      if (input && document.activeElement !== input) {
        input.focus()
        const len = input.value.length
        input.setSelectionRange(len, len)
      }
    }, 0)
  }
}

function renderFoodCard(f) {
  return `
    <div class="upload-card" style="cursor:pointer;transition:border-color 0.15s"
      onmouseover="this.style.borderColor='var(--border2)'"
      onmouseout="this.style.borderColor='var(--border)'"
      onclick="openFoodItemModal('${f.id}')">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:15px;color:var(--text);margin-bottom:2px">${esc(f.name)}</div>
          ${f.brand ? `<div style="font-size:12px;color:var(--text3)">${esc(f.brand)}</div>` : ''}
        </div>
        <div style="font-size:11px;color:var(--text3);flex-shrink:0;margin-left:8px;text-align:right">
          ${f.serving_size || '1 serving'}<br>
          ${f.components?.length ? `<span style="color:var(--carbs)">${f.components.length} components</span>` : ''}
        </div>
      </div>
      <div class="macro-pills" style="margin-bottom:10px">
        <span class="macro-pill pill-cal" style="font-size:11px;padding:2px 8px">${Math.round(f.calories)} kcal</span>
        <span class="macro-pill pill-p" style="font-size:11px;padding:2px 8px">${Math.round(f.protein)}g P</span>
        <span class="macro-pill pill-c" style="font-size:11px;padding:2px 8px">${Math.round(f.carbs)}g C</span>
        <span class="macro-pill pill-f" style="font-size:11px;padding:2px 8px">${Math.round(f.fat)}g F</span>
      </div>
      <button onclick="quickLogFoodItem('${f.id}');event.stopPropagation()"
        style="width:100%;background:color-mix(in srgb, var(--accent) 10%, transparent);color:var(--accent);border:1px solid color-mix(in srgb, var(--accent) 25%, transparent);border-radius:var(--r);padding:8px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer">
        + Log this
      </button>
    </div>
  `
}

// Rank a food item against a search term. Higher score = better match.
// 0 means no match (filter out).
// Buckets:
//   100 — name starts with query ('ban' → 'Banana')
//    80 — name contains query as a whole word
//    70 — name contains query anywhere
//    50 — brand contains query ('fage' → every Fage item)
//    25 — a component name contains query
//         (so 'banana' surfaces 'Peanut Butter Banana Shake' because
//          banana is one of its components, below exact name matches)
function rankFoodMatch(food, q) {
  if (!q) return 1
  const name = (food.name || '').toLowerCase()
  const brand = (food.brand || '').toLowerCase()
  if (name.startsWith(q)) return 100
  const wordRe = new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  if (wordRe.test(name)) return 80
  if (name.includes(q)) return 70
  if (brand.includes(q)) return 50
  const comps = food.components || []
  if (comps.some(c => (c.name || '').toLowerCase().includes(q))) return 25
  return 0
}

function searchFoods(list, queryRaw) {
  const q = (queryRaw || '').trim().toLowerCase()
  if (!q) return list
  return list
    .map(f => ({ f, score: rankFoodMatch(f, q) }))
    .filter(x => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const an = (a.f.name || '').toLowerCase()
      const bn = (b.f.name || '').toLowerCase()
      if (an.length !== bn.length) return an.length - bn.length
      return an.localeCompare(bn)
    })
    .map(x => x.f)
}

function renderFoodItemModal(item, editingComponents) {
  const isNew = !item?.id
  const components = editingComponents || item?.components || []
  const totals = components.reduce((acc, c) => ({
    calories: acc.calories + (c.calories || 0),
    protein:  acc.protein  + (c.protein  || 0),
    carbs:    acc.carbs    + (c.carbs    || 0),
    fat:      acc.fat      + (c.fat      || 0),
    fiber:    acc.fiber    + (c.fiber    || 0),
    sugar:    acc.sugar    + (c.sugar    || 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0 })

  const hasComponents = components.length > 0

  return `
    <div style="padding:20px">
      <button class="modal-close" onclick="closeFoodItemModal()">×</button>
      <h3 style="margin:0 0 16px;font-size:18px">${isNew ? 'New food item' : 'Edit food item'}</h3>

      <!-- Name + Brand -->
      <div class="modal-field">
        <label>Food name</label>
        <input type="text" id="fi-name" value="${esc(item?.name || '')}" placeholder="Morning Protein Shake, Greek Yogurt Bowl..." />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="modal-field" style="margin-bottom:0">
          <label>Brand (optional)</label>
          <input type="text" id="fi-brand" value="${esc(item?.brand || '')}" placeholder="Brand name..." />
        </div>
        <div class="modal-field" style="margin-bottom:0">
          <label>Serving size</label>
          <input type="text" id="fi-serving" value="${esc(item?.serving_size || '1 serving')}" placeholder="1 shake, 1 cup..." />
        </div>
      </div>

      <!-- Components section -->
      <div style="margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">
            Components ${components.length ? `(${components.length})` : ''}
          </div>
          <button onclick="openAddComponentModal()" class="clear-btn" style="color:var(--accent)">+ Add component</button>
        </div>

        ${!components.length ? `
          <div style="padding:16px;text-align:center;font-size:13px;color:var(--text3);background:var(--bg3);border-radius:var(--r);border:1px dashed var(--border2)">
            Add components to auto-calculate macros<br>
            <span style="font-size:11px">e.g. 2 cups milk, 1 scoop protein powder</span>
          </div>
        ` : `
          <div style="border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
            ${components.map((c, i) => `
              <div style="padding:9px 12px;border-bottom:1px solid var(--border)">
                <div style="display:flex;align-items:center;gap:8px">
                  <div style="flex:1;min-width:0">
                    <div style="font-size:13px;color:var(--text)">
                    ${c.qty && c.qty !== 1 ? `<span style="color:var(--accent);font-weight:500">${c.qty} ${esc(c.unit||'serving')} </span>` : (c.unit && c.unit !== 'serving' ? `<span style="color:var(--accent);font-weight:500">${esc(c.unit)} </span>` : '')}${esc(c.name)}
                  </div>
                    <div style="font-size:11px;color:var(--text3)">${Math.round(c.calories)} kcal · P${Math.round(c.protein)} C${Math.round(c.carbs)} F${Math.round(c.fat)}</div>
                  </div>
                  <button onclick="toggleComponentEdit(${i})" style="background:none;border:none;color:var(--text3);font-size:12px;cursor:pointer;padding:2px 6px;border-radius:4px;border:1px solid var(--border)"
                    onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text3)'">Edit</button>
                  <button onclick="removeFoodComponent(${i})" style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:0;flex-shrink:0"
                    onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text3)'">×</button>
                </div>
                <!-- Inline edit panel -->
                <div id="comp-edit-${i}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
                  <div style="font-size:11px;color:var(--text3);margin-bottom:6px">Adjust serving size — macros scale automatically</div>
                  <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                    <input type="number" min="0.1" step="0.25" value="${c.qty || 1}"
                      id="comp-qty-${i}"
                      oninput="updateComponentQty(${i})"
                      style="width:70px;background:var(--bg4);border:1px solid var(--border2);border-radius:6px;padding:5px 8px;color:var(--text);font-size:14px;font-family:inherit;outline:none;text-align:center" />
                    <input type="text" value="${esc(c.unit || 'serving')}"
                      id="comp-unit-${i}"
                      oninput="updateComponentUnit(${i})"
                      placeholder="serving, cup, scoop..."
                      style="flex:1;min-width:90px;background:var(--bg4);border:1px solid var(--border2);border-radius:6px;padding:5px 8px;color:var(--text);font-size:13px;font-family:inherit;outline:none" />
                    <span style="font-size:11px;color:var(--text3);white-space:nowrap">= ${Math.round(c.calories)} kcal</span>
                  </div>
                </div>
              </div>`).join('')}
            <!-- Totals row -->
            <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--bg3)">
              <div style="flex:1">
                <div style="font-size:12px;font-weight:600;color:var(--text2)">Total</div>
              </div>
              <div style="font-size:12px;color:var(--text2);font-weight:500">
                ${Math.round(totals.calories)} kcal · P${Math.round(totals.protein)} C${Math.round(totals.carbs)} F${Math.round(totals.fat)}
              </div>
            </div>
          </div>
        `}
      </div>

      <!-- Manual macros (shown when no components, or as override) -->
      <div id="fi-manual-section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">
            ${hasComponents ? 'Macros (auto-calculated)' : 'Macros per serving'}
          </div>
        </div>
        <div class="modal-grid">
          <div class="modal-field"><label>Calories</label><input type="number" id="fi-cal" value="${Math.round(hasComponents ? totals.calories : (item?.calories||0))}" ${hasComponents?'readonly style="opacity:0.6"':''} /></div>
          <div class="modal-field"><label>Protein (g)</label><input type="number" id="fi-protein" value="${Math.round(hasComponents ? totals.protein : (item?.protein||0))}" ${hasComponents?'readonly style="opacity:0.6"':''} /></div>
          <div class="modal-field"><label>Carbs (g)</label><input type="number" id="fi-carbs" value="${Math.round(hasComponents ? totals.carbs : (item?.carbs||0))}" ${hasComponents?'readonly style="opacity:0.6"':''} /></div>
          <div class="modal-field"><label>Fat (g)</label><input type="number" id="fi-fat" value="${Math.round(hasComponents ? totals.fat : (item?.fat||0))}" ${hasComponents?'readonly style="opacity:0.6"':''} /></div>
          <div class="modal-field"><label>Fiber (g)</label><input type="number" id="fi-fiber" value="${Math.round(hasComponents ? totals.fiber : (item?.fiber||0))}" ${hasComponents?'readonly style="opacity:0.6"':''} /></div>
          <div class="modal-field"><label>Sugar (g)</label><input type="number" id="fi-sugar" value="${Math.round(hasComponents ? totals.sugar : (item?.sugar||0))}" ${hasComponents?'readonly style="opacity:0.6"':''} /></div>
        </div>
      </div>

      <div class="modal-actions">
        ${!isNew ? `<button class="btn-delete" onclick="deleteFoodItemHandler('${item.id}')">Delete</button>` : ''}
        <button class="btn-cancel" onclick="closeFoodItemModal()">Cancel</button>
        <button class="btn-save" onclick="saveFoodItemHandler()">Save food</button>
      </div>
    </div>

    <!-- Add component sub-panel (hidden by default) -->
    <div id="add-component-panel" style="display:none;border-top:1px solid var(--border);padding:20px;background:var(--bg3)">
      <div style="font-size:13px;font-weight:500;color:var(--text);margin-bottom:12px">Add a component</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:12px">
        <button class="food-sub-btn active" id="comp-btn-describe" onclick="setCompMode('describe')">
          <span style="font-size:18px;display:block;margin-bottom:2px">🔤</span>
          <span style="font-size:11px">Describe</span>
        </button>
        <button class="food-sub-btn" id="comp-btn-barcode" onclick="setCompMode('barcode')">
          <span style="font-size:18px;display:block;margin-bottom:2px">📷</span>
          <span style="font-size:11px">Scan</span>
        </button>
        <button class="food-sub-btn" id="comp-btn-label" onclick="setCompMode('label')">
          <span style="font-size:18px;display:block;margin-bottom:2px">🏷️</span>
          <span style="font-size:11px">Label</span>
        </button>
        <button class="food-sub-btn" id="comp-btn-saved" onclick="setCompMode('saved')">
          <span style="font-size:18px;display:block;margin-bottom:2px">⭐</span>
          <span style="font-size:11px">Saved</span>
        </button>
      </div>

      <div id="comp-panel-describe">
        <input class="link-input" id="comp-describe-input" placeholder="e.g. 2 cups whole milk, 1 scoop vanilla whey..." />
      </div>
      <div id="comp-panel-barcode" style="display:none">
        <input type="file" id="comp-barcode-file" accept="image/*" capture="environment" style="display:none"
          onchange="handleComponentBarcode(this.files[0])" />
        <button onclick="document.getElementById('comp-barcode-file').click()"
          style="width:100%;padding:12px;background:var(--bg4);border:1.5px dashed var(--border2);border-radius:var(--r);color:var(--text2);font-size:13px;cursor:pointer;font-family:inherit">
          📷 Open camera to scan barcode
        </button>
        <input class="link-input" id="comp-barcode-manual" placeholder="Or type barcode number..." style="margin-top:8px" />
        <div id="comp-barcode-status" style="font-size:11px;color:var(--text3);margin-top:4px"></div>
      </div>
      <div id="comp-panel-label" style="display:none">
        <input type="file" id="comp-label-file" accept="image/*" style="display:none"
          onchange="handleComponentLabel(this.files[0])" />
        <button onclick="document.getElementById('comp-label-file').click()"
          style="width:100%;padding:12px;background:var(--bg4);border:1.5px dashed var(--border2);border-radius:var(--r);color:var(--text2);font-size:13px;cursor:pointer;font-family:inherit">
          🏷️ Snap nutrition label
        </button>
        <div id="comp-label-status" style="font-size:11px;color:var(--text3);margin-top:6px;text-align:center"></div>
      </div>
      <div id="comp-panel-saved" style="display:none">
        <input class="link-input" id="comp-saved-search" placeholder="Search saved foods and recipes..."
          oninput="filterCompSavedSearch(this.value)" />
        <div id="comp-saved-results" style="margin-top:8px;max-height:180px;overflow-y:auto"></div>
      </div>

      <div id="comp-result" style="display:none;margin-top:10px;padding:10px 12px;background:var(--bg4);border-radius:var(--r);border:1px solid var(--border2)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <div style="font-size:13px;font-weight:500;color:var(--text)" id="comp-result-name"></div>
          <div style="font-size:11px;color:var(--text3)" id="comp-result-macros"></div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:12px;color:var(--text3)">Qty:</span>
          <input type="number" min="0.1" step="0.25" value="1" id="comp-result-qty"
            oninput="updatePendingQty()"
            style="width:65px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;color:var(--text);font-size:13px;font-family:inherit;outline:none;text-align:center" />
          <input type="text" value="serving" id="comp-result-unit" placeholder="serving, cup, scoop..."
            oninput="updatePendingUnit()"
            style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;color:var(--text);font-size:13px;font-family:inherit;outline:none" />
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:12px">
        <button onclick="cancelAddComponent()" class="btn-cancel" style="flex:0 0 auto">Cancel</button>
        <button onclick="analyzeComponentHandler()" class="pm-analyze-btn" style="flex:1;margin:0" id="comp-analyze-btn">✨ Look up</button>
        <button onclick="confirmAddComponent()" class="btn-save" style="flex:0 0 auto;opacity:0.5" id="comp-add-btn">Add ✓</button>
      </div>
    </div>
  `
}

// ─── Recipes Page ─────────────────────────────────────────────────────────────
function renderRecipesPage(container) {
  const allRecipes = state.recipes
  const q = (state.recipeSearch || '').trim().toLowerCase()
  const activeTag = state.recipeActiveTag || ''

  // Build unified tag list: presets always shown; plus any custom tags
  // the user has actually used. Tags are case-insensitive for matching
  // but we preserve the original casing for display.
  const tagCounts = {}
  for (const r of allRecipes) {
    const tags = Array.isArray(r.tags) ? r.tags : []
    for (const t of tags) {
      if (!t) continue
      const key = t.trim()
      if (!key) continue
      if (!tagCounts[key]) tagCounts[key] = 0
      tagCounts[key]++
    }
  }
  // Merge presets (always shown, even if 0) with custom used tags.
  // Use getVisiblePresets() so hidden-by-user presets don't appear in
  // the filter bar.
  const visiblePresets = getVisiblePresets()
  const presetSet = new Set(visiblePresets.map(t => t.toLowerCase()))
  const customTags = Object.keys(tagCounts)
    .filter(t => !presetSet.has(t.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
  const displayTags = [...visiblePresets, ...customTags]

  // Apply tag filter BEFORE the search rank so search results are scoped to tag
  const tagFiltered = activeTag
    ? (activeTag === '__untagged__'
        ? allRecipes.filter(r => !(Array.isArray(r.tags) && r.tags.length))
        : allRecipes.filter(r => Array.isArray(r.tags) && r.tags.some(t => t && t.toLowerCase() === activeTag.toLowerCase())))
    : allRecipes
  const recipes = searchRecipes(tagFiltered, q)

  const untaggedCount = allRecipes.filter(r => !(Array.isArray(r.tags) && r.tags.length)).length

  const pill = (label, tagValue, count, isActive) => `
    <button onclick="setRecipeTag('${tagValue.replace(/'/g,"\\'")}')"
      style="flex-shrink:0;padding:6px 14px;border-radius:999px;font-size:12px;font-weight:500;font-family:inherit;cursor:pointer;border:1px solid ${isActive ? 'var(--accent)' : 'var(--border2)'};background:${isActive ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg3)'};color:${isActive ? 'var(--accent)' : 'var(--text2)'};transition:all 0.15s;white-space:nowrap"
      onmouseover="if (!${isActive}) { this.style.borderColor='var(--border2)'; this.style.color='var(--text)' }"
      onmouseout="if (!${isActive}) { this.style.borderColor='var(--border2)'; this.style.color='var(--text2)' }">
      ${esc(label)}${count != null ? ` <span style="opacity:0.6;margin-left:2px">${count}</span>` : ''}
    </button>
  `

  container.innerHTML = `
    <div class="greeting">Recipes</div>
    <div class="greeting-sub">Saved recipes with ingredients and macros per serving.</div>

    <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
      ${allRecipes.length ? `
        <input class="planner-search" id="recipe-search" placeholder="Search recipes by name or ingredient..."
          value="${esc(q)}"
          oninput="filterRecipesList(this.value)"
          style="flex:1;min-width:180px" />
      ` : ''}
      <button class="analyze-btn" style="width:auto;padding:10px 20px;flex-shrink:0" onclick="openNewRecipeModal()">+ New recipe</button>
      ${allRecipes.length ? `
        <button onclick="openManageTagsModal()"
          style="width:auto;padding:10px 14px;flex-shrink:0;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);color:var(--text2);font-size:13px;font-family:inherit;cursor:pointer"
          title="Rename or delete tags">
          ⚙️ Tags
        </button>
      ` : ''}
    </div>

    ${allRecipes.length ? `
      <!-- Tag pill bar — horizontally scrollable on overflow -->
      <div style="display:flex;gap:6px;margin-bottom:20px;overflow-x:auto;padding:4px 0 8px;scrollbar-width:thin">
        ${pill('All', '', allRecipes.length, !activeTag)}
        ${untaggedCount > 0 ? pill('Untagged', '__untagged__', untaggedCount, activeTag === '__untagged__') : ''}
        ${displayTags.map(tag => pill(tag, tag, tagCounts[tag] || 0, activeTag.toLowerCase() === tag.toLowerCase())).join('')}
      </div>
    ` : ''}

    ${!recipes.length ? `
      <div class="log-card">
        <div class="log-empty" style="padding:60px">
          ${q && activeTag ? `No recipes in <strong style="color:var(--text)">${esc(activeTag)}</strong> match "${esc(q)}".`
            : q ? `No recipes match "${esc(q)}".`
            : activeTag ? `No recipes tagged <strong style="color:var(--text)">${esc(activeTag === '__untagged__' ? 'Untagged' : activeTag)}</strong> yet.`
            : 'No recipes saved yet.'}<br>
          <span style="font-size:12px;color:var(--text3);margin-top:6px;display:block">
            ${q || activeTag ? 'Try clearing the filter or searching for something else.' : 'Analyze a meal and save it as a recipe, or create one manually.'}
          </span>
        </div>
      </div>
    ` : `
      <div id="recipe-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">
        ${recipes.map(r => renderRecipeCard(r)).join('')}
      </div>
    `}
  `

  // Restore focus on search input if the user was typing
  if (q) {
    setTimeout(() => {
      const input = document.getElementById('recipe-search')
      if (input && document.activeElement !== input) {
        input.focus()
        // Move caret to end
        const len = input.value.length
        input.setSelectionRange(len, len)
      }
    }, 0)
  }

  document.getElementById('recipe-modal')?.addEventListener('click', e => {
    if (e.target.id === 'recipe-modal') closeRecipeModal()
  })
}

function renderRecipeCard(r) {
  const tags = Array.isArray(r.tags) ? r.tags.filter(Boolean) : []
  return `
    <div class="upload-card" style="cursor:pointer;transition:border-color 0.15s" onmouseover="this.style.borderColor='var(--border2)'" onmouseout="this.style.borderColor='var(--border)'" onclick="openRecipeModal('${r.id}')">
      <!-- Actions row on top — keeps the title from getting squeezed when
           the name wraps across multiple lines. Servings pill on the right
           stays as a compact label. -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:6px">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <button onclick="openQuickTagModal('${r.id}');event.stopPropagation()"
            title="Add or remove tags"
            style="background:none;border:1px solid var(--border2);border-radius:var(--r);padding:3px 8px;font-size:11px;color:var(--text3);cursor:pointer;font-family:inherit"
            onmouseover="this.style.borderColor='var(--carbs)';this.style.color='var(--carbs)'"
            onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text3)'">🏷️ Tag</button>
          <button onclick="openPlanRecipeModal('${r.id}');event.stopPropagation()"
            title="Plan this recipe for a day"
            style="background:none;border:1px solid var(--border2);border-radius:var(--r);padding:3px 8px;font-size:11px;color:var(--text3);cursor:pointer;font-family:inherit"
            onmouseover="this.style.borderColor='var(--protein)';this.style.color='var(--protein)'"
            onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text3)'">📅 Plan</button>
          <button onclick="openShareModal('${r.id}');event.stopPropagation()"
            title="Share recipe"
            style="background:none;border:1px solid var(--border2);border-radius:var(--r);padding:3px 8px;font-size:11px;color:var(--text3);cursor:pointer;font-family:inherit"
            onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
            onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text3)'">↗ Share</button>
        </div>
        <span style="font-size:11px;color:var(--text3);background:var(--bg3);border-radius:4px;padding:2px 7px;white-space:nowrap">${r.servings} serving${r.servings !== 1 ? 's' : ''}</span>
      </div>
      <!-- Name gets the full card width, no competition from buttons. -->
      <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--text);margin-bottom:8px;line-height:1.25">${esc(r.name)}</div>
      ${r.description ? `<div style="font-size:12px;color:var(--text2);margin-bottom:10px;line-height:1.5">${esc(r.description)}</div>` : ''}
      <div class="macro-pills" style="margin-bottom:10px">
        <span class="macro-pill pill-cal">${Math.round(r.calories)} kcal</span>
        <span class="macro-pill pill-p">${Math.round(r.protein)}g P</span>
        <span class="macro-pill pill-c">${Math.round(r.carbs)}g C</span>
        <span class="macro-pill pill-f">${Math.round(r.fat)}g F</span>
      </div>
      ${tags.length ? `
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">
          ${tags.slice(0, 4).map(t => `<span style="font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(122,180,232,0.1);color:var(--carbs);border:1px solid rgba(122,180,232,0.2)">${esc(t)}</span>`).join('')}
          ${tags.length > 4 ? `<span style="font-size:10px;color:var(--text3);padding:2px 4px">+${tags.length - 4}</span>` : ''}
        </div>
      ` : ''}
      ${r.ingredients?.length ? `
        <div style="font-size:11px;color:var(--text3)">${r.ingredients.length} ingredients · <span style="color:var(--text2)">per 1 of ${r.servings} servings</span></div>
      ` : ''}
    </div>
  `
}

// Tag editor/display block for the recipe modal. Shows as read-only chips
// in view mode (and for read-only recipes belonging to other providers),
// and as an add/remove widget with preset suggestions in edit/new mode.
function renderRecipeTagEditor(recipe, mode, isNew, isReadOnly) {
  const tags = Array.isArray(recipe.tags) ? recipe.tags.filter(Boolean) : []
  const editable = (mode === 'edit' || isNew) && !isReadOnly

  if (!editable) {
    if (!tags.length) return ''
    return `
      <div style="margin-bottom:20px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:8px">Tags</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${tags.map(t => `<span style="font-size:12px;padding:4px 10px;border-radius:999px;background:rgba(122,180,232,0.1);color:var(--carbs);border:1px solid rgba(122,180,232,0.25)">${esc(t)}</span>`).join('')}
        </div>
      </div>
    `
  }

  // Editable: chips + input + preset suggestions. Selected state lives on
  // window._editingTags, seeded from recipe.tags on open.
  if (!window._editingTags) window._editingTags = new Set(tags.map(t => t.toLowerCase()))
  // Make sure the seed is correct when switching recipes
  window._editingTags = new Set(tags.map(t => t.toLowerCase()))
  window._editingTagsDisplay = {}
  tags.forEach(t => { window._editingTagsDisplay[t.toLowerCase()] = t })

  const chip = (t, isOn) => `<button type="button" data-tag="${esc(t)}" onclick="toggleRecipeTag('${t.replace(/'/g,"\\'")}')"
      style="font-size:12px;padding:4px 12px;border-radius:999px;cursor:pointer;font-family:inherit;border:1px solid ${isOn ? 'var(--carbs)' : 'var(--border2)'};background:${isOn ? 'rgba(122,180,232,0.18)' : 'var(--bg3)'};color:${isOn ? 'var(--carbs)' : 'var(--text2)'};transition:all 0.15s">${isOn ? '✓ ' : ''}${esc(t)}</button>`

  // Collect all known tags for suggestions: visible presets ∪ other recipes' tags
  // ∪ in-memory staged customs. Hidden presets don't appear as suggestions,
  // but if a recipe already has one it still shows up (that tag is rendered
  // via r.tags directly, not presets).
  const visiblePresets = getVisiblePresets()
  const knownTags = new Set(visiblePresets.map(t => t.toLowerCase()))
  const displayMap = {}
  visiblePresets.forEach(t => { displayMap[t.toLowerCase()] = t })
  // Staged custom tags — created via Manage Tags but not yet attached to any
  // recipe. Surface as suggestions so they're usable right away.
  for (const t of (state._stagedCustomTags || [])) {
    const k = String(t).toLowerCase()
    if (!displayMap[k]) displayMap[k] = t
    knownTags.add(k)
  }
  for (const r of (state.recipes || [])) {
    if (!Array.isArray(r.tags)) continue
    for (const t of r.tags) {
      if (!t) continue
      const key = t.toLowerCase()
      if (!displayMap[key]) displayMap[key] = t
      knownTags.add(key)
    }
  }
  // Also include currently-selected custom tags so they render as "on"
  for (const key of window._editingTags) {
    if (!displayMap[key]) displayMap[key] = window._editingTagsDisplay[key] || key
  }
  const suggestions = Array.from(knownTags).map(k => displayMap[k])

  return `
    <div style="margin-bottom:20px" id="recipe-tag-editor">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:8px">Tags <span style="text-transform:none;letter-spacing:0;color:var(--text3);font-size:10px">· tap to toggle, or type a new one below</span></div>
      <div id="recipe-tag-chips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        ${suggestions.map(t => chip(t, window._editingTags.has(t.toLowerCase()))).join('')}
      </div>
      <div style="display:flex;gap:6px">
        <input type="text" id="recipe-tag-input" placeholder="Create a new tag..."
          onkeydown="if (event.key === 'Enter') { event.preventDefault(); addCustomRecipeTag() }"
          style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:7px 12px;color:var(--text);font-size:13px;font-family:inherit;outline:none" />
        <button type="button" onclick="addCustomRecipeTag()"
          style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:7px 14px;font-size:12px;color:var(--text2);cursor:pointer;font-family:inherit;white-space:nowrap">
          + Add
        </button>
      </div>
    </div>
  `
}

// Rank a recipe against a search term. Higher score = better match.
// 0 means no match (filter out).
// Buckets (highest to lowest):
//   100 — name starts with query (e.g. "chi" → "Chicken Tacos")
//    80 — name contains query as whole word
//    70 — name contains query anywhere
//    40 — description contains query
//    20 — an ingredient name contains query
// Within each bucket, ties are broken by shorter name first, then alphabetical.
function rankRecipeMatch(recipe, q) {
  if (!q) return 1
  const name = (recipe.name || '').toLowerCase()
  const desc = (recipe.description || '').toLowerCase()
  if (name.startsWith(q)) return 100
  // "whole word" = preceded by start-of-string or non-letter
  const wordRe = new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  if (wordRe.test(name)) return 80
  if (name.includes(q)) return 70
  if (desc.includes(q)) return 40
  const ings = recipe.ingredients || []
  if (ings.some(ing => (ing.name || '').toLowerCase().includes(q))) return 20
  return 0
}

function searchRecipes(list, queryRaw) {
  const q = (queryRaw || '').trim().toLowerCase()
  if (!q) return list
  return list
    .map(r => ({ r, score: rankRecipeMatch(r, q) }))
    .filter(x => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const an = (a.r.name || '').toLowerCase()
      const bn = (b.r.name || '').toLowerCase()
      if (an.length !== bn.length) return an.length - bn.length
      return an.localeCompare(bn)
    })
    .map(x => x.r)
}

function buildOgCard(url, og) {
  if (!url) return ''
  const domain = (() => { try { return new URL(url).hostname.replace('www.','') } catch { return url } })()
  const isInstagram = domain.includes('instagram.com')
  const isTikTok    = domain.includes('tiktok.com')
  const isBlocked   = isInstagram || isTikTok || og?.blocked

  // No OG data yet — show loading state or clean link fallback
  if (!og || og.error === 'timeout') {
    return `<a href="${esc(url)}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);text-decoration:none;color:inherit">
      <span style="font-size:20px">${isInstagram ? '📸' : isTikTok ? '🎵' : '🔗'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${isBlocked ? (isInstagram ? 'View on Instagram' : 'View on TikTok') : 'View original recipe'}</div>
        <div style="font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(domain)}</div>
      </div>
      <span style="font-size:12px;color:var(--text3)">↗</span>
    </a>`
  }

  const hasImage = og.image && !isBlocked
  return `<a href="${esc(url)}" target="_blank" rel="noopener" style="display:block;border:1px solid var(--border2);border-radius:var(--r);overflow:hidden;text-decoration:none;color:inherit;background:var(--bg3)">
    ${hasImage ? `<div style="width:100%;height:160px;overflow:hidden;background:var(--bg4)"><img src="${esc(og.image)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.style.display='none'" /></div>` : ''}
    <div style="padding:12px 14px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
      <div style="flex:1;min-width:0">
        ${og.siteName ? `<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:4px">${esc(og.siteName)}</div>` : ''}
        ${og.title ? `<div style="font-size:13px;font-weight:600;color:var(--text);line-height:1.3;margin-bottom:4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(og.title)}</div>` : ''}
        ${og.description ? `<div style="font-size:12px;color:var(--text3);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.4">${esc(og.description)}</div>` : ''}
        <div style="font-size:11px;color:var(--accent);margin-top:6px">View original ↗</div>
      </div>
    </div>
  </a>`
}

function renderRecipeModalContent(recipe, mode = 'view') {
  const isNew = !recipe.id
  const ingredients = recipe.ingredients || []
  const isView = mode === 'view' && !isNew
  // Read-only when the current user doesn't own the recipe — e.g. viewing
  // another provider's recipe from a broadcast preview. They can see the
  // details but can't edit, delete, plan, or generate instructions.
  const currentUserId = window.state?.user?.id
  const isReadOnly = !!(recipe.user_id && currentUserId && recipe.user_id !== currentUserId)
  const isViewOwned = isView && !isReadOnly

  return `
    <div style="position:relative">

      ${isNew ? `
        <div onclick="document.getElementById('cookbook-file-input').click()"
          style="background:color-mix(in srgb, var(--accent) 8%, transparent);border-bottom:1.5px dashed color-mix(in srgb, var(--accent) 35%, transparent);padding:12px 16px;display:flex;align-items:center;gap:10px;cursor:pointer">
          <span style="font-size:22px">📖</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600;color:var(--accent)">Import from cookbook</div>
            <div style="font-size:11px;color:var(--text3)">Tap to photograph a recipe — AI fills everything in</div>
          </div>
          <span id="cookbook-spinner" style="display:none">⏳</span>
        </div>
        <input type="file" id="cookbook-file-input" accept="image/*" style="display:none"
          onchange="handleCookbookPhoto(this.files[0])" />
        <div id="cookbook-status" style="font-size:11px;color:var(--text3);padding:2px 16px;text-align:center;min-height:14px;background:color-mix(in srgb, var(--accent) 4%, transparent)"></div>
      ` : ''}

      <!-- Sticky header: name + plan button -->
      <div style="position:sticky;top:0;z-index:10;background:var(--bg2);border-bottom:1px solid var(--border);padding:12px 16px 10px">
        <button class="modal-close" onclick="closeRecipeModal()" style="top:10px;right:12px">×</button>

        ${mode === 'edit' || isNew ? `
          <input type="text" id="recipe-name" value="${esc(recipe.name || '')}"
            placeholder="Recipe name..."
            style="width:100%;background:none;border:none;border-bottom:1px solid var(--border2);outline:none;font-family:'DM Serif Display',serif;font-size:20px;color:var(--text);padding-bottom:4px;margin-right:32px;display:block" />
        ` : `
          <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--text);margin-right:36px;line-height:1.2;margin-bottom:8px">${esc(recipe.name)}</div>
        `}

        ${isView ? `
          <div style="display:flex;align-items:center;gap:6px">
            <div style="display:flex;gap:4px;flex-wrap:nowrap;flex:1;overflow:hidden;min-width:0">
              <span class="macro-pill pill-cal" style="font-size:11px;padding:2px 7px;white-space:nowrap">${Math.round(recipe.calories)} kcal</span>
              <span class="macro-pill pill-p" style="font-size:11px;padding:2px 7px;white-space:nowrap">${Math.round(recipe.protein)}g P</span>
              <span class="macro-pill pill-c" style="font-size:11px;padding:2px 7px;white-space:nowrap">${Math.round(recipe.carbs)}g C</span>
              <span class="macro-pill pill-f" style="font-size:11px;padding:2px 7px;white-space:nowrap">${Math.round(recipe.fat)}g F</span>
            </div>
            ${!isReadOnly ? `
              <button onclick="openPlanRecipeModal('${recipe.id}')"
                style="background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);padding:7px 12px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0">
                📅 Plan
              </button>
              <button onclick="shareRecipe('${recipe.id}')"
                id="share-btn-${recipe.id}"
                style="background:${recipe.is_shared ? 'rgba(76,175,130,0.15)' : 'var(--bg3)'};color:${recipe.is_shared ? 'var(--protein)' : 'var(--text3)'};border:1px solid ${recipe.is_shared ? 'var(--protein)' : 'var(--border2)'};border-radius:var(--r);padding:7px 10px;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0">
                ${recipe.is_shared ? '🔗 Shared' : '🔗 Share'}
              </button>
            ` : ''}
          </div>
        ` : ''}
        ${isReadOnly ? `
          <div style="margin-top:10px;padding:8px 10px;background:rgba(122,180,232,0.08);border:1px solid rgba(122,180,232,0.25);border-radius:var(--r);font-size:11px;color:var(--text2);line-height:1.5">
            👁 Preview — this recipe belongs to another provider. Copy their meal plan to your planner to save the recipe to your library, then you'll be able to edit servings, generate instructions, and plan meals with it.
          </div>
        ` : ''}
      </div>

      <!-- Scrollable body -->
      <div style="padding:20px 20px 28px">

        <!-- Description -->
        ${mode === 'edit' || isNew ? `
          <div class="modal-field">
            <label>Description (optional)</label>
            <input type="text" id="recipe-desc" value="${esc(recipe.description || '')}" placeholder="Brief description..." />
          </div>
        ` : recipe.description ? `<div style="font-size:13px;color:var(--text2);margin-bottom:16px">${esc(recipe.description)}</div>` : ''}

        <!-- Auto-update history from provider (view mode only) -->
        ${isView && Array.isArray(recipe.update_history) && recipe.update_history.length > 0 ? (() => {
          const latest = recipe.update_history[0]
          const latestDate = latest?.ts ? new Date(latest.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''
          const changeSummary = (latest?.changes || []).slice(0, 3).map(c => {
            if (c.field === 'name') return `renamed`
            if (c.field === 'description') return `description edited`
            if (c.field === 'ingredients') return `ingredients: ${c.from} → ${c.to}`
            if (c.field === 'instructions') return `instructions: ${c.from} → ${c.to}`
            if (typeof c.from === 'number' && typeof c.to === 'number') {
              const delta = c.to - c.from
              return `${c.field} ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}${c.field==='calories'?' kcal':'g'}`
            }
            return c.field
          }).join(' · ')
          const extraCount = Math.max(0, (latest?.changes || []).length - 3)
          return `<div style="margin-bottom:16px;padding:10px 12px;background:rgba(122,180,232,0.08);border:1px solid rgba(122,180,232,0.25);border-radius:var(--r);font-size:11px;color:var(--text2);line-height:1.5">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
              <span style="color:var(--carbs);font-weight:500">🔄 Provider update · ${latestDate}</span>
            </div>
            <div>${esc(changeSummary)}${extraCount > 0 ? ` · +${extraCount} more` : ''}</div>
            ${recipe.update_history.length > 1 ? `<div style="font-size:10px;color:var(--text3);margin-top:4px">+ ${recipe.update_history.length - 1} older update${recipe.update_history.length === 2 ? '' : 's'}</div>` : ''}
          </div>`
        })() : ''}

        <!-- Source URL -->
        ${mode === 'edit' || isNew ? `
          <div class="modal-field">
            <label>Source URL (optional)</label>
            <input type="url" id="recipe-source-url" value="${esc(recipe.source_url || '')}"
              placeholder="https://... Instagram, YouTube, website..." />
          </div>
        ` : recipe.source_url ? `
          <div id="og-preview-card" style="margin-bottom:16px">
            ${buildOgCard(recipe.source_url, recipe.og_cache)}
          </div>
        ` : ''}

        <!-- Servings -->
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;padding:12px 16px;background:var(--bg3);border-radius:var(--r)">
          <span style="font-size:13px;color:var(--text2)">Servings:</span>
          ${mode === 'edit' || isNew ? `
            <input type="number" id="recipe-servings" value="${recipe.servings || 4}" min="0.5" step="0.5"
              style="width:70px;background:var(--bg4);border:1px solid var(--border2);border-radius:var(--r);padding:6px 10px;color:var(--text);font-size:14px;font-family:inherit;outline:none"
              onchange="updateServingLabel()" />
            <input type="text" id="recipe-serving-label" value="${esc(recipe.serving_label || 'serving')}"
              placeholder="serving / slice / cup..."
              style="flex:1;background:var(--bg4);border:1px solid var(--border2);border-radius:var(--r);padding:6px 10px;color:var(--text);font-size:13px;font-family:inherit;outline:none" />
          ` : `
            <span style="font-size:14px;font-weight:500;color:var(--text)">${recipe.servings} ${recipe.serving_label || 'servings'}</span>
          `}
          <span style="font-size:11px;color:var(--text3);margin-left:auto">per serving</span>
        </div>

        <!-- Macros (edit mode only — view mode shows in sticky header) -->
        ${mode === 'edit' || isNew ? `
          <div style="margin-bottom:20px">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px">Macros per serving</div>
            <div class="modal-grid">
              <div class="modal-field"><label>Calories</label><input type="number" id="r-cal" value="${Math.round(recipe.calories || 0)}" /></div>
              <div class="modal-field"><label>Protein (g)</label><input type="number" id="r-protein" value="${Math.round(recipe.protein || 0)}" /></div>
              <div class="modal-field"><label>Carbs (g)</label><input type="number" id="r-carbs" value="${Math.round(recipe.carbs || 0)}" /></div>
              <div class="modal-field"><label>Fat (g)</label><input type="number" id="r-fat" value="${Math.round(recipe.fat || 0)}" /></div>
              <div class="modal-field"><label>Fiber (g)</label><input type="number" id="r-fiber" value="${Math.round(recipe.fiber || 0)}" /></div>
              <div class="modal-field"><label>Sugar (g)</label><input type="number" id="r-sugar" value="${Math.round(recipe.sugar || 0)}" /></div>
            </div>
          </div>
        ` : ''}

        ${renderRecipeTagEditor(recipe, mode, isNew, isReadOnly)}

        <!-- Ingredients / Instructions toggle (view mode only) -->
        <div style="margin-bottom:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px;flex-wrap:wrap">
            ${(() => {
              // Compute active tab once. If there are no instruction steps,
              // 'instructions' is effectively unreachable, so we treat the
              // ingredients button as active regardless of state.recipeTab.
              const hasSteps = !!recipe.instructions?.steps?.length
              const onInstr = hasSteps && state.recipeTab === 'instructions'
              // Active tab gets:
              //   - solid accent-tinted background (var(--accent) at 15% alpha)
              //   - accent-colored text for clear "this is selected" signal
              //   - subtle border highlight
              // Inactive tab gets transparent bg + muted text. Way more
              // contrast than the previous --bg2 / --bg3 attempt where
              // the colors were ~6% lightness apart and indistinguishable
              // on phone screens.
              const activeStyle = 'background:rgba(212,165,116,0.18);color:var(--accent);box-shadow:inset 0 0 0 1px rgba(212,165,116,0.35)'
              const inactiveStyle = 'background:transparent;color:var(--text3)'
              return `
                <div style="display:flex;gap:0;background:var(--bg3);border-radius:var(--r);padding:3px;border:1px solid var(--border)">
                  <button onclick="setRecipeTab('ingredients')" id="rtab-ingredients"
                    style="padding:6px 14px;border:none;border-radius:calc(var(--r) - 2px);font-size:12px;font-family:inherit;cursor:pointer;font-weight:600;transition:background 0.15s;${onInstr ? inactiveStyle : activeStyle}">
                    📋 Ingredients
                  </button>
                  <button onclick="setRecipeTab('instructions')" id="rtab-instructions"
                    style="padding:6px 14px;border:none;border-radius:calc(var(--r) - 2px);font-size:12px;font-family:inherit;cursor:pointer;font-weight:600;transition:background 0.15s;${onInstr ? activeStyle : inactiveStyle}">
                    👨‍🍳 Instructions
                  </button>
                </div>
              `
            })()}
            ${(recipe.instructions?.steps?.length && state.recipeTab === 'instructions') ? `
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <!-- Read-aloud cooking mode: opens a fullscreen overlay
                     that reads each instruction step aloud and lets the
                     user tap Next/Repeat. Uses browser SpeechSynthesis,
                     no AI cost. -->
                <button onclick="openCookingMode('${recipe.id}')"
                  style="background:none;border:1px solid var(--border2);border-radius:var(--r);padding:5px 10px;font-size:12px;color:var(--text2);cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px"
                  onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
                  🔊 Read aloud
                </button>
                <button onclick="downloadRecipeInstructions('${recipe.id}')"
                  style="background:none;border:1px solid var(--border2);border-radius:var(--r);padding:5px 10px;font-size:12px;color:var(--text2);cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px"
                  onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
                  ⬇ Download
                </button>
              </div>` : ''}
          </div>

          ${state.recipeTab === 'instructions' ? `
            <!-- Servings scaler -->
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px;padding:10px 12px;background:var(--bg3);border-radius:var(--r)">
              <span style="font-size:12px;color:var(--text3)">Base:</span>
              <span style="font-size:13px;font-weight:600;color:var(--text)">${recipe.servings || 1} ${recipe.serving_label || 'servings'}</span>
              <span style="font-size:12px;color:var(--text3)">→ Making:</span>
              <input type="number" min="0.5" step="0.5"
                value="${state.recipeServings != null ? state.recipeServings : (recipe.servings || 1)}"
                oninput="setRecipeServings(this.value)"
                style="width:60px;background:var(--bg4);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;color:var(--text);font-size:14px;font-weight:600;font-family:inherit;outline:none;text-align:center" />
              <span style="font-size:12px;color:var(--text3)">${recipe.serving_label || 'servings'}</span>
              ${(state.recipeServings && state.recipeServings != (recipe.servings||1)) ? `<span style="font-size:11px;color:var(--accent);font-weight:600">×${+(state.recipeServings/(recipe.servings||1)).toFixed(2)}</span>` : ''}
            </div>
            ${!recipe.instructions?.steps?.length ? `
              <div style="padding:20px;text-align:center;background:var(--bg3);border-radius:var(--r);border:1px dashed var(--border2)">
                <div style="font-size:13px;color:var(--text2);margin-bottom:${isReadOnly ? '0' : '12px'}">No instructions yet</div>
                ${!isReadOnly ? `
                  <button onclick="generateInstructionsHandler('${recipe.id}')" id="gen-instr-btn" class="pm-analyze-btn" style="margin:0">
                    ✨ Generate cooking instructions with AI
                  </button>
                ` : ''}
              </div>
            ` : `
              ${recipe.instructions.prep_time || recipe.instructions.cook_time ? `
                <div style="display:flex;gap:16px;margin-bottom:14px;font-size:13px;color:var(--text2)">
                  ${recipe.instructions.prep_time ? `<span>⏱ Prep: <strong>${recipe.instructions.prep_time}</strong></span>` : ''}
                  ${recipe.instructions.cook_time ? `<span>🔥 Cook: <strong>${recipe.instructions.cook_time}</strong></span>` : ''}
                </div>` : ''}
              <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:12px">
                ${(recipe.instructions.steps || []).map((step, i) => {
                  const target = state.recipeServings != null ? state.recipeServings : (recipe.servings || 1)
                  return `<li style="font-size:14px;color:var(--text);line-height:1.55;padding-left:4px">${scaleStepText(step, recipe.servings || 1, target)}</li>`
                }).join('')}
              </ol>
              ${recipe.instructions.tips?.length ? `
                <div style="margin-top:16px;padding:12px;background:color-mix(in srgb, var(--accent) 6%, transparent);border-radius:var(--r);border:1px solid color-mix(in srgb, var(--accent) 15%, transparent)">
                  <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:8px">Tips</div>
                  ${recipe.instructions.tips.map(t => `<div style="font-size:13px;color:var(--text2);margin-bottom:4px">• ${esc(t)}</div>`).join('')}
                </div>` : ''}
              ${!isReadOnly ? `
                <button onclick="generateInstructionsHandler('${recipe.id}')" id="gen-instr-btn"
                  style="margin-top:14px;background:none;border:1px solid var(--border);border-radius:var(--r);padding:6px 12px;font-size:12px;color:var(--text3);cursor:pointer;font-family:inherit;width:100%"
                  onmouseover="this.style.color='var(--carbs)'" onmouseout="this.style.color='var(--text3)'">
                  ✨ Regenerate instructions
              </button>
              ` : ''}
            `}
          ` : `
            <!-- Ingredients tab with scaler -->
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;padding:8px 12px;background:var(--bg3);border-radius:var(--r)">
              <span style="font-size:12px;color:var(--text3)">Base:</span>
              <span style="font-size:13px;font-weight:600;color:var(--text)">${recipe.servings || 1} ${recipe.serving_label || 'servings'}</span>
              <span style="font-size:12px;color:var(--text3)">→ Scale to:</span>
              <input type="number" min="0.5" step="0.5"
                value="${state.recipeServings != null ? state.recipeServings : (recipe.servings || 1)}"
                oninput="setRecipeServings(this.value)"
                style="width:60px;background:var(--bg4);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;color:var(--text);font-size:14px;font-weight:600;font-family:inherit;outline:none;text-align:center" />
              <span style="font-size:12px;color:var(--text3)">${recipe.serving_label || 'servings'}</span>
              ${(state.recipeServings && state.recipeServings != (recipe.servings||1)) ? `<span style="font-size:11px;color:var(--accent);font-weight:600">×${+(state.recipeServings/(recipe.servings||1)).toFixed(2)}</span>` : ''}
            </div>
            <div style="border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
              ${!ingredients.length ? `
                <div style="padding:20px;text-align:center;font-size:13px;color:var(--text3)">No ingredients yet.</div>
              ` : ingredients.map((ing, i) => {
                  const target = state.recipeServings != null ? state.recipeServings : (recipe.servings||1)
                  return renderIngredientRow(ing, i, false, target, recipe.servings||1)
                }).join('')}
            </div>
          `}
        </div>

        <!-- Ingredients (edit mode) -->
        ${mode === 'edit' || isNew ? `
        <div style="margin-bottom:20px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">
              Ingredients ${ingredients.length ? `(${ingredients.length})` : ''}
            </div>
            <div style="display:flex;gap:8px">
              <button class="clear-btn" style="color:var(--accent)" onclick="addIngredientRow()">+ Add</button>
              <button class="clear-btn" style="color:var(--carbs)" onclick="fetchIngredients('${recipe.id || ''}')">✨ AI extract</button>
            </div>
          </div>
          <div id="ingredient-list" style="border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
            ${!ingredients.length ? `
              <div style="padding:20px;text-align:center;font-size:13px;color:var(--text3)">
                No ingredients yet. Add manually or click <b style="color:var(--carbs)">AI extract</b> to auto-fill.
              </div>
            ` : ingredients.map((ing, i) => renderIngredientRow(ing, i, true)).join('')}
          </div>
        </div>
        ` : ''}
        ${(mode === 'edit' || isNew) && ingredients.length ? `
          <div style="margin-bottom:20px">
            <button class="pm-analyze-btn" id="recalc-btn" onclick="recalculateMacrosHandler()">
              ✨ Recalculate macros from ingredients
            </button>
          </div>
        ` : ''}

        <!-- AI estimate for new recipes with no ingredients yet -->
        ${(mode === 'edit' || isNew) && !ingredients.length ? `
          <div style="margin-bottom:20px;padding:14px;background:var(--bg3);border-radius:var(--r);border:1px solid var(--border)">
            <div style="font-size:12px;color:var(--text3);margin-bottom:10px">Let AI estimate macros and extract ingredients from the recipe name, description, or URL.</div>
            <button class="pm-analyze-btn" id="ai-estimate-btn" onclick="aiEstimateRecipeHandler()">
              ✨ Estimate macros &amp; ingredients with AI
            </button>
          </div>
        ` : ''}

        <!-- Bottom actions — management only (Edit/Delete/Save) -->
        <div class="modal-actions">
          ${isReadOnly ? `
            <button class="btn-cancel" onclick="closeRecipeModal()" style="flex:1">Close preview</button>
          ` : isView ? `
            <button class="btn-delete" onclick="deleteRecipeHandler('${recipe.id}')">Delete</button>
            <button class="btn-cancel" onclick="closeRecipeModal()">Close</button>
            <button class="btn-save" onclick="openRecipeModal('${recipe.id}', 'edit')">Edit</button>
          ` : `
            ${!isNew ? `<button class="btn-delete" onclick="deleteRecipeHandler('${recipe.id}')">Delete</button>` : ''}
            <button class="btn-cancel" onclick="${isNew ? 'closeRecipeModal()' : `openRecipeModal('${recipe.id}', 'view')`}">Cancel</button>
            <button class="btn-save" id="recipe-save-btn" onclick="saveRecipeHandler()">Save recipe</button>
          `}
        </div>
      </div>
    </div>
  `
}

function renderPlanRecipeModal(recipe) {
  const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
  // Build 4-week grid of days for picking
  const today = new Date()
  today.setHours(0,0,0,0)

  // Generate next 28 days
  const days = []
  for (let i = 0; i < 28; i++) {
    const d = new Date(today)
    d.setDate(today.getDate() + i)
    const dateStr = localDateStr(d)
    days.push({
      dateStr,
      dayNum: d.getDate(),
      month: d.toLocaleDateString([], { month: 'short' }),
      isToday: i === 0,
      isFirstOfMonth: d.getDate() === 1 || i === 0
    })
  }

  // Pad the start so day 1 (today) lands on the correct column (Sun=0 … Sat=6)
  const leadingBlanks = today.getDay()
  const blankCells = Array(leadingBlanks).fill(null)

  return `
    <div style="padding:24px 24px 20px">
      <button class="modal-close" onclick="closePlanRecipeModal()" style="position:absolute;top:16px;right:16px">×</button>
      <h3 style="margin:0 0 4px;font-size:18px">Add to meal plan</h3>
      <div style="font-size:13px;color:var(--text3);margin-bottom:20px">${esc(recipe.name)}</div>

      <!-- Day picker -->
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px">Pick day(s) to eat this</div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:20px" id="plan-day-grid">
        ${DAYS_SHORT.map(d => `<div style="text-align:center;font-size:10px;color:var(--text3);padding:2px 0">${d}</div>`).join('')}
        ${blankCells.map(() => `<div></div>`).join('')}
        ${days.map(d => `
          <button data-date="${d.dateStr}"
            onclick="togglePlanDay('${d.dateStr}')"
            style="aspect-ratio:1;border-radius:6px;border:1px solid var(--border);background:${d.isToday ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg3)'};
              color:${d.isToday ? 'var(--accent)' : 'var(--text2)'};cursor:pointer;font-size:11px;font-family:inherit;
              outline:${d.isToday ? '1px solid var(--accent)' : 'none'};position:relative;padding:0"
            onmouseover="if(!this.classList.contains('plan-day-selected'))this.style.background='var(--bg4)'"
            onmouseout="if(!this.classList.contains('plan-day-selected'))this.style.background='${d.isToday ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg3)'}'">
            ${d.isFirstOfMonth ? `<span style="position:absolute;top:2px;left:3px;font-size:8px;color:var(--text3)">${d.month}</span>` : ''}
            ${d.dayNum}
          </button>`).join('')}
      </div>

      <!-- Cook-once advanced option — collapsed by default -->
      <div id="cook-once-section">
        <button onclick="toggleCookOnce()" style="background:none;border:none;color:var(--text3);font-size:12px;cursor:pointer;font-family:inherit;padding:0;display:flex;align-items:center;gap:6px;margin-bottom:12px">
          <span id="cook-once-chevron">▶</span>
          <span>🍳 Cook once, eat on multiple days</span>
        </button>
        <div id="cook-once-panel" style="display:none;background:var(--bg3);border-radius:var(--r);padding:14px;margin-bottom:16px;font-size:13px">
          <div style="color:var(--text2);margin-bottom:10px;line-height:1.5">
            Select multiple days above — ingredients only count once (first day).
            The other days show as "no shopping needed" in your grocery list.
          </div>
          <div style="color:var(--text3);font-size:12px;line-height:1.6">
            <strong style="color:var(--text2)">Common patterns:</strong><br>
            • Meal prep: cook Sun → eat Mon, Wed, Fri<br>
            • Big batch: Mon dinner → Thu lunch → Sat dinner<br>
            • Two nights: Tue dinner → Wed dinner
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
            <div style="font-size:12px;color:var(--text3);margin-bottom:6px">First cooking day <span style="color:var(--accent)">(ingredients counted here)</span></div>
            <div id="cook-once-primary" style="font-size:13px;color:var(--text2);font-style:italic">Select a day above to set</div>
          </div>
        </div>
      </div>

      <!-- Selected days summary -->
      <div id="plan-selected-summary" style="font-size:12px;color:var(--text3);margin-bottom:16px;min-height:18px"></div>

      <!-- Servings to make -->
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;padding:10px 12px;background:var(--bg3);border-radius:var(--r)">
        <span style="font-size:13px;color:var(--text2)">Servings to make:</span>
        <input type="number" id="plan-servings-input" min="1" step="1"
          value="${recipe.servings || 4}"
          oninput="state.planningRecipe && (state.planningRecipe.plannedServings = parseFloat(this.value) || ${recipe.servings || 4})"
          style="width:65px;background:var(--bg4);border:1px solid var(--border2);border-radius:6px;padding:5px 8px;color:var(--text);font-size:15px;font-weight:600;font-family:inherit;outline:none;text-align:center" />
        <span style="font-size:12px;color:var(--text3)">(base recipe: ${recipe.servings || 4})</span>
      </div>

      <!-- Meal type selector -->
      <div style="margin-bottom:14px">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Which meal?</div>
        <div style="display:flex;gap:6px">
          ${[['breakfast','🌅','Breakfast'],['lunch','☀️','Lunch'],['snack','🍎','Snack'],['dinner','🌙','Dinner']].map(([val,icon,label]) =>
            `<button onclick="selectPlanRecipeMealType('${val}', this)"
              style="flex:1;padding:8px 4px;border-radius:var(--r);font-size:11px;font-weight:600;font-family:inherit;cursor:pointer;border:1px solid ${val === 'dinner' ? 'var(--accent)' : 'var(--border2)'};background:${val === 'dinner' ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg3)'};color:${val === 'dinner' ? 'var(--accent)' : 'var(--text3)'};display:flex;flex-direction:column;align-items:center;gap:2px">
              <span style="font-size:14px">${icon}</span>${label}
            </button>`
          ).join('')}
        </div>
        <input type="hidden" id="plan-recipe-meal-type" value="dinner" />
      </div>

      <!-- Add button -->
      <button id="plan-recipe-add-btn" onclick="confirmPlanRecipe('${recipe.id}')"
        style="width:100%;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);padding:14px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;opacity:0.4;pointer-events:none">
        Add to plan
      </button>
    </div>
  `
}


// Scale number+unit mentions in a step by a multiplier
function scaleStepText(step, baseServings, targetServings) {
  const safeStep = esc(step)
  if (!baseServings || !targetServings) return safeStep
  const multiplier = targetServings / baseServings
  return safeStep.replace(/(\d+(?:\.\d+)?(?:\/\d+)?)\s*(cups?|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|lbs?|pounds?|\bg\b|kg|ml|liters?|litres?|cloves?|slices?|pieces?|cans?|pints?|quarts?)/gi,
    (match, num, unit) => {
      const base = num.includes('/') ? (() => { const [n,d] = num.split('/').map(Number); return n/d })() : parseFloat(num)
      const scaled = base * multiplier
      let display
      if (scaled % 1 === 0) display = String(scaled)
      else {
        const rounded = Math.round(scaled * 4) / 4
        const whole = Math.floor(rounded)
        const frac = rounded - whole
        const fracMap = {0.25:'¼', 0.5:'½', 0.75:'¾'}
        display = whole > 0
          ? whole + (frac ? (fracMap[frac] || frac) : '')
          : (fracMap[frac] || +scaled.toFixed(2))
      }
      return `<strong style="color:var(--accent)">${display}</strong> ${unit}`
    }
  )
}

// Spoken-form rendering for TTS. Same scaling logic as scaleStepText, but the
// output is plain English: "0.5 tbsp" → "half a tablespoon", "350°F" →
// "350 degrees Fahrenheit", "¾ cup" → "three quarters of a cup". Strips any
// HTML so the speech engine doesn't pronounce tags.
//
// Kept in sync with speechifyStepText() in api/tts.js — if you change either
// copy, change both.
const _UNIT_FORMS = {
  cup:['cup','cups'], cups:['cup','cups'],
  tbsp:['tablespoon','tablespoons'], tbsps:['tablespoon','tablespoons'],
  tablespoon:['tablespoon','tablespoons'], tablespoons:['tablespoon','tablespoons'],
  tsp:['teaspoon','teaspoons'], tsps:['teaspoon','teaspoons'],
  teaspoon:['teaspoon','teaspoons'], teaspoons:['teaspoon','teaspoons'],
  oz:['ounce','ounces'], ounce:['ounce','ounces'], ounces:['ounce','ounces'],
  lb:['pound','pounds'], lbs:['pound','pounds'],
  pound:['pound','pounds'], pounds:['pound','pounds'],
  g:['gram','grams'], kg:['kilogram','kilograms'],
  ml:['milliliter','milliliters'], l:['liter','liters'],
  liter:['liter','liters'], liters:['liter','liters'],
  litre:['liter','liters'], litres:['liter','liters'],
  clove:['clove','cloves'], cloves:['clove','cloves'],
  slice:['slice','slices'], slices:['slice','slices'],
  piece:['piece','pieces'], pieces:['piece','pieces'],
  can:['can','cans'], cans:['can','cans'],
  pint:['pint','pints'], pints:['pint','pints'],
  quart:['quart','quarts'], quarts:['quart','quarts'],
}
function _phraseQty(q, unit, vowelStart) {
  const article = vowelStart ? 'an' : 'a'
  const r = Math.round(q * 4) / 4
  const whole = Math.floor(r)
  const frac = r - whole
  if (whole === 0 && frac === 0.5)  return `half ${article} ${unit}`
  if (whole === 0 && frac === 0.25) return `a quarter ${unit}`
  if (whole === 0 && frac === 0.75) return `three quarters of ${article} ${unit}`
  if (whole > 0  && frac === 0)     return `${whole} ${unit}`
  if (whole > 0  && frac === 0.5)   return `${whole} and a half ${unit}`
  if (whole > 0  && frac === 0.25)  return `${whole} and a quarter ${unit}`
  if (whole > 0  && frac === 0.75)  return `${whole} and three quarters ${unit}`
  return `${q} ${unit}`
}
function speechifyStepText(step, baseServings, targetServings) {
  if (!step) return ''
  let out = String(step).replace(/<[^>]*>/g, '')
  out = out.replace(/½/g, '0.5').replace(/¼/g, '0.25').replace(/¾/g, '0.75')
           .replace(/⅓/g, '0.333').replace(/⅔/g, '0.667')
  out = out.replace(/(\d+)\s*°\s*([FC])\b/g, (_, n, u) => `${n} degrees ${u === 'F' ? 'Fahrenheit' : 'Celsius'}`)
  const mult = (baseServings && targetServings) ? targetServings / baseServings : 1
  const re = /(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*(cups?|tbsps?|tablespoons?|tsps?|teaspoons?|oz|ounces?|lbs?|pounds?|\bg\b|kg|ml|l|liters?|litres?|cloves?|slices?|pieces?|cans?|pints?|quarts?)?/gi
  return out.replace(re, (match, qStr, uStr) => {
    let q
    const m = qStr.match(/^(\d+)\s+(\d+)\/(\d+)$/)
    if (m) q = parseInt(m[1], 10) + Number(m[2]) / Number(m[3])
    else if (qStr.includes('/')) { const [n, d] = qStr.split('/').map(Number); q = n / d }
    else q = parseFloat(qStr)
    if (!isFinite(q)) return match
    q = q * mult
    if (!uStr) return match  // bare numbers without a unit stay as-is
    const forms = _UNIT_FORMS[uStr.toLowerCase()] || [uStr, uStr]
    const unit = forms[q !== 1 ? 1 : 0]
    return _phraseQty(q, unit, /^[aeio]/i.test(unit))
  })
}

function renderIngredientRow(ing, idx, editable, targetServings, baseServings) {
  if (editable) {
    return `
      <div style="display:flex;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border)" id="ing-row-${idx}">
        <input type="text" value="${esc(ing.amount || '')}" placeholder="Amt"
          oninput="updateIngredient(${idx},'amount',this.value)"
          style="width:60px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:5px 8px;color:var(--text);font-size:13px;font-family:inherit;outline:none" />
        <input type="text" value="${esc(ing.unit || '')}" placeholder="unit"
          oninput="updateIngredient(${idx},'unit',this.value)"
          style="width:60px;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:5px 8px;color:var(--text);font-size:13px;font-family:inherit;outline:none" />
        <input type="text" value="${esc(ing.name || '')}" placeholder="Ingredient name"
          oninput="updateIngredient(${idx},'name',this.value)"
          style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:5px 8px;color:var(--text);font-size:13px;font-family:inherit;outline:none" />
        <button onclick="removeIngredientRow(${idx})" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;padding:2px 4px;line-height:1" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text3)'">×</button>
      </div>
    `
  }
  const multiplier = (targetServings && baseServings && baseServings !== targetServings)
    ? targetServings / baseServings : 1
  const rawAmt = parseAmount(ing.amount)
  const scaledAmt = rawAmt ? rawAmt * multiplier : 0
  const displayAmt = scaledAmt === 0 ? (ing.amount || '') : (scaledAmt % 1 === 0 ? scaledAmt : +scaledAmt.toFixed(2))
  return `
    <div style="display:flex;gap:10px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--border)">
      <span style="font-size:13px;color:var(--accent);min-width:80px;font-weight:${multiplier !== 1 && rawAmt ? '600' : '400'}">${displayAmt} ${esc(ing.unit || '')}</span>
      <span style="font-size:13px;color:var(--text)">${esc(ing.name || '')}</span>
    </div>
  `
}

// ─── Goals Page ───────────────────────────────────────────────────────────────
function buildCheckinRow(c, isImperial) {
  const toDisp = (kg) => kg ? (isImperial ? +(kg*2.20462).toFixed(1)+'lbs' : kg+'kg') : null
  const hasSegmental = c.seg_lean_trunk_kg || c.seg_lean_left_arm_kg
  const hasExtended  = c.total_body_water_kg || c.visceral_fat_level || c.visceral_fat || c.inbody_score || c.bmr
  const hasDexa      = c.bone_mineral_density || c.android_fat_pct
  const visceralVal  = c.visceral_fat_level || c.visceral_fat  // handle both column names
  const displayDate  = c.scan_date || c.checked_in_at

  const pill = (label, val) => val != null
    ? `<div style="background:var(--bg3);border-radius:4px;padding:3px 8px;font-size:11px;white-space:nowrap">
        <span style="color:var(--text3)">${label}: </span>
        <span style="color:var(--text);font-weight:500">${val}</span>
       </div>` : ''

  const cell = (val, label, color) => val != null
    ? `<div style="padding:8px 4px;background:var(--bg2);text-align:center">
        <div style="font-size:13px;font-weight:600;color:${color}">${val}</div>
        <div style="font-size:10px;color:var(--text3)">${label}</div>
       </div>` : ''

  const coreMetrics = [
    [toDisp(c.weight_kg), 'Weight', 'var(--accent)'],
    [c.body_fat_pct != null ? c.body_fat_pct+'%' : null, 'Body Fat', 'var(--fat)'],
    [toDisp(c.muscle_mass_kg), 'Muscle', 'var(--protein)'],
    [toDisp(c.lean_body_mass_kg), 'Lean Mass', 'var(--protein)'],
    [c.bmr ? c.bmr+' kcal' : null, 'BMR', 'var(--carbs)'],
    [c.bmi ? String(c.bmi) : null, 'BMI', 'var(--text2)'],
  ].filter(([v]) => v)

  return `
  <div style="border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--bg3)">
      <div>
        <span style="font-size:13px;font-weight:600;color:var(--text)">
          ${new Date(displayDate + 'T12:00:00').toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'})}
        </span>
        ${c.scan_type ? `<span style="font-size:10px;color:var(--text3);margin-left:6px;text-transform:uppercase;background:var(--bg4);padding:2px 5px;border-radius:3px">${c.scan_type}</span>` : ''}
        ${c.notes ? `<div style="font-size:11px;color:var(--text3);margin-top:2px">${c.notes}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        ${c.scan_file_path ? '<span style="font-size:20px" title="Scan attached">📄</span>' : ''}
        <button onclick="deleteCheckinHandler('${c.id}')" title="Delete check-in"
          style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;padding:4px;line-height:1;font-family:inherit"
          onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--text3)'">×</button>
      </div>
    </div>

    ${coreMetrics.length ? `
    <div style="display:grid;grid-template-columns:repeat(${Math.min(coreMetrics.length,3)},1fr);gap:1px;background:var(--border)">
      ${coreMetrics.map(([v,l,col]) => cell(v,l,col)).join('')}
    </div>` : ''}

    ${hasExtended ? `
    <div style="padding:8px 12px;border-top:1px solid var(--border)">
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Body Composition</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${pill('TBW', toDisp(c.total_body_water_kg))}
        ${pill('Fat Mass', toDisp(c.body_fat_mass_kg))}
        ${pill('Visceral Fat', visceralVal ? 'Level '+visceralVal : null)}
        ${pill('ECW/TBW', c.ecw_tbw_ratio)}
        ${pill('InBody Score', c.inbody_score ? c.inbody_score+'/100' : null)}
        ${pill('SMI', c.smi ? c.smi+' kg/m²' : null)}
        ${pill('Protein', c.protein_kg ? toDisp(c.protein_kg) : null)}
        ${pill('Minerals', c.minerals_kg ? toDisp(c.minerals_kg) : null)}
        ${pill('BCM', toDisp(c.body_cell_mass_kg))}
      </div>
    </div>` : ''}

    ${hasSegmental ? `
    <div style="padding:8px 12px;border-top:1px solid var(--border)">
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Segmental Lean Mass</div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;text-align:center">
        ${[['L Arm',c.seg_lean_left_arm_kg,c.seg_lean_left_arm_pct],
           ['R Arm',c.seg_lean_right_arm_kg,c.seg_lean_right_arm_pct],
           ['Trunk',c.seg_lean_trunk_kg,c.seg_lean_trunk_pct],
           ['L Leg',c.seg_lean_left_leg_kg,c.seg_lean_left_leg_pct],
           ['R Leg',c.seg_lean_right_leg_kg,c.seg_lean_right_leg_pct]
          ].map(([lbl,kg,pct]) => `
          <div style="background:var(--bg3);border-radius:4px;padding:4px 2px">
            <div style="font-size:11px;font-weight:500;color:var(--text)">${toDisp(kg)||'—'}</div>
            <div style="font-size:10px;color:${!pct?'var(--text3)':pct>=100?'var(--protein)':'var(--fat)'}">${pct?pct+'%':''}</div>
            <div style="font-size:9px;color:var(--text3)">${lbl}</div>
          </div>`).join('')}
      </div>
    </div>` : ''}

    ${hasDexa ? `
    <div style="padding:8px 12px;border-top:1px solid var(--border)">
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">DEXA Analysis</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${pill('BMD', c.bone_mineral_density ? c.bone_mineral_density+' g/cm²' : null)}
        ${pill('T-score', c.t_score)}
        ${pill('Z-score', c.z_score)}
        ${pill('Android Fat', c.android_fat_pct ? c.android_fat_pct+'%' : null)}
        ${pill('Gynoid Fat', c.gynoid_fat_pct ? c.gynoid_fat_pct+'%' : null)}
        ${pill('A/G Ratio', c.android_gynoid_ratio)}
        ${pill('VAT', c.vat_area_cm2 ? c.vat_area_cm2+' cm²' : null)}
      </div>
    </div>` : ''}
  </div>`
}


function calcBMR(m) {
  if (!m?.weight_kg) return null

  // Katch-McArdle (most accurate) — requires body fat %
  if (m.body_fat_pct) {
    const lbm = m.weight_kg * (1 - m.body_fat_pct / 100)
    return Math.round(370 + 21.6 * lbm)
  }

  // Mifflin-St Jeor fallback — requires height, age, sex
  if (m.height_cm && m.age) {
    const base = 10 * m.weight_kg + 6.25 * m.height_cm - 5 * m.age
    return Math.round(m.sex === 'female' ? base - 161 : base + 5)
  }

  return null
}

function calcTDEE(bmr, activity) {
  const mults = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 }
  return bmr ? Math.round(bmr * (mults[activity] || 1.55)) : null
}

function calcTargetMacros(m, tdee) {
  if (!tdee || !m) return null
  const pace = { slow: 250, moderate: 400, aggressive: 600 }
  const deficit = m.weight_goal === 'lose' ? (pace[m.pace] || 400)
    : m.weight_goal === 'gain' ? -(pace[m.pace] || 300) : 0
  const targetCal = Math.max(1200, tdee - deficit)

  // Protein: base off lean body mass if BF% known, else conservative estimate from total weight
  const lbm_lbs = m.body_fat_pct
    ? (m.weight_kg * (1 - m.body_fat_pct / 100)) * 2.20462
    : (m.weight_kg * 2.20462) * 0.75  // estimate lean mass as 75% of total weight
  const proteinG = Math.round(lbm_lbs * 1.0) // 1g per lb lean mass

  const fatCal = Math.round(targetCal * 0.25)
  const fatG = Math.round(fatCal / 9)
  const carbCal = targetCal - (proteinG * 4) - fatCal
  const carbG = Math.max(50, Math.round(carbCal / 4))
  return { calories: targetCal, protein: proteinG, carbs: carbG, fat: fatG }
}

function weeksToGoal(m) {
  if (!m?.weight_kg || !m?.goal_weight_kg) return null
  const diff = Math.abs(m.weight_kg - m.goal_weight_kg)
  const pace = { slow: 0.25, moderate: 0.4, aggressive: 0.6 }
  const kgPerWeek = pace[m.pace] || 0.4
  return Math.ceil(diff / kgPerWeek)
}

function renderBroadcastForm(b) {
  const today = localDateStr(new Date())
  // Default end date: 6 days from today (1 week)
  const defaultEnd = (() => { const d = new Date(); d.setDate(d.getDate() + 6); return localDateStr(d) })()
  const endDate = b.end_date || defaultEnd
  const startDate = b.start_date || today

  return `
    <div style="padding:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <div style="font-family:'DM Serif Display',serif;font-size:20px;color:var(--text)">${b.id ? 'Edit plan' : 'Share meal plan'}</div>
        <button onclick="closeBroadcastModal()" style="background:none;border:none;font-size:22px;color:var(--text3);cursor:pointer">×</button>
      </div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:20px">Followers can copy your planned meals to their week</div>
      <input type="hidden" id="bc-id" value="${b.id || ''}" />
      <input type="hidden" id="bc-start" value="${startDate}" />

      <!-- Date range -->
      <div style="background:var(--bg3);border-radius:var(--r);padding:14px 16px;margin-bottom:16px">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Date range</div>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;text-align:center">
            <div style="font-size:11px;color:var(--text3);margin-bottom:4px">From</div>
            <div style="font-size:15px;font-weight:600;color:var(--accent)">Today</div>
            <div style="font-size:11px;color:var(--text3)">${new Date(today + 'T12:00:00').toLocaleDateString([],{month:'short',day:'numeric'})}</div>
          </div>
          <div style="color:var(--text3);font-size:18px">→</div>
          <div style="flex:1;text-align:center">
            <div style="font-size:11px;color:var(--text3);margin-bottom:4px">Through</div>
            <input type="date" id="bc-end" value="${endDate}" min="${today}"
              style="width:100%;background:var(--bg2);border:1px solid var(--accent);border-radius:8px;padding:6px 8px;color:var(--accent);font-size:13px;font-weight:600;font-family:inherit;outline:none;text-align:center;cursor:pointer"
              onchange="previewBroadcastPlan(this.value)" />
          </div>
        </div>
      </div>

      <!-- Meal preview -->
      <div id="bc-plan-preview" style="margin-bottom:16px">
        <div style="background:var(--bg3);border-radius:var(--r);padding:12px;font-size:12px;color:var(--text3);text-align:center">
          Loading your meals...
        </div>
      </div>

      <!-- Title (optional) -->
      <div class="modal-field" style="margin-bottom:12px">
        <label>Title <span style="font-weight:400;color:var(--text3);font-size:10px">(optional — auto-generates if blank)</span></label>
        <input type="text" id="bc-title" value="${esc(b.title || '')}" placeholder="e.g. High protein week · April plan"
          style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none" />
      </div>

      <!-- Notes -->
      <div class="modal-field" style="margin-bottom:16px">
        <label>Notes <span style="font-weight:400;color:var(--text3);font-size:10px">(optional)</span></label>
        <textarea id="bc-desc" placeholder="Macro targets, tips, focus for this plan..."
          style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px 12px;color:var(--text);font-size:13px;font-family:inherit;outline:none;resize:none;min-height:56px">${esc(b.description || '')}</textarea>
      </div>

      <!-- Publish toggle -->
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding:10px 12px;background:var(--bg3);border-radius:var(--r)">
        <input type="checkbox" id="bc-published" ${b.is_published ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer" />
        <div>
          <div style="font-size:13px;color:var(--text);font-weight:500">Publish & share link</div>
          <div style="font-size:11px;color:var(--text3)">Makes this plan visible to followers and shareable</div>
        </div>
      </div>

      <div style="display:flex;gap:8px">
        <button onclick="closeBroadcastModal()"
          style="flex:1;padding:12px;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);color:var(--text3);font-size:14px;font-family:inherit;cursor:pointer">
          Cancel
        </button>
        <button id="bc-save-btn" onclick="saveBroadcastHandler()"
          style="flex:2;padding:12px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);font-size:14px;font-weight:700;font-family:inherit;cursor:pointer">
          ${b.is_published ? '✓ Save & share' : 'Save draft'}
        </button>
      </div>
    </div>
  `
}

function renderProvidersPage(container) {
  const isProvider = state.usage?.isProvider
  const myProvidersAll = state.followedProviders || []
  const allProvidersAll = state.providers || []

  // Apply search filter (client-side name/specialty/bio match)
  const q = (state.providerSearch || '').trim().toLowerCase()
  const matchProvider = (p) => {
    if (!q) return true
    return (p.provider_name || '').toLowerCase().includes(q)
      || (p.provider_specialty || '').toLowerCase().includes(q)
      || (p.provider_bio || '').toLowerCase().includes(q)
  }
  const myProviders = myProvidersAll.filter(matchProvider)
  const allProviders = allProvidersAll.filter(matchProvider)

  // Tab state: providers can toggle between browsing the directory and
  // managing their own channel. Non-providers don't see tabs — they just
  // see the directory. Default tab is 'browse' (per product decision):
  // a provider opening the Providers page probably wants to see peers.
  const tab = state.providersTab || 'browse'

  // The directory view — shared between non-providers (the whole page)
  // and providers-on-browse-tab (one of two tabs). Also filters out the
  // current user's own provider row so you don't see yourself in the list.
  const directoryHtml = (() => {
    const mineFiltered = myProviders.filter(p => p.user_id !== state.user.id)
    const allFiltered = allProviders.filter(p => p.user_id !== state.user.id)
    return `
      ${allProvidersAll.length ? `
        <div style="margin-bottom:16px">
          <input class="planner-search" id="provider-search" placeholder="Search providers by name or specialty..."
            value="${esc(q)}"
            oninput="filterProvidersList(this.value)"
            style="width:100%" />
        </div>
      ` : ''}

      ${mineFiltered.length ? `
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Following (${mineFiltered.length}${q ? ` · filtered` : ''})</div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:24px">
          ${mineFiltered.map(p => renderProviderCard(p, true)).join('')}
        </div>
      ` : ''}

      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">
        ${mineFiltered.length ? 'All providers' : 'Discover providers'}
      </div>
      ${(() => {
        const unfollowed = allFiltered.filter(p => !myProvidersAll.some(f => f.user_id === p.user_id))
        return unfollowed.length ? `
          <div style="display:flex;flex-direction:column;gap:10px">
            ${unfollowed.map(p => renderProviderCard(p, false)).join('')}
          </div>
        ` : mineFiltered.length ? (q ? `
          <div class="upload-card" style="text-align:center;padding:24px;color:var(--text3);font-size:13px">
            No other providers match "${esc(q)}"
          </div>
        ` : '') : `
          <div class="upload-card" style="text-align:center;padding:32px">
            <div style="font-size:32px;margin-bottom:8px">🩺</div>
            <div style="font-size:14px;color:var(--text2);font-weight:500">${q ? `No providers match "${esc(q)}"` : 'No providers yet'}</div>
            <div style="font-size:12px;color:var(--text3);margin-top:4px">${q ? 'Try a different search' : 'Providers will appear here when they join MacroLens'}</div>
          </div>
        `
      })()}
    `
  })()

  // Tab pill button factory. Used only when isProvider=true.
  const tabPill = (id, label) => {
    const active = tab === id
    return `
      <button onclick="switchProvidersTab('${id}')"
        style="flex:1;padding:10px 14px;background:${active ? 'var(--bg3)' : 'transparent'};border:1px solid ${active ? 'var(--border2)' : 'transparent'};color:${active ? 'var(--text)' : 'var(--text3)'};border-radius:var(--r);font-size:13px;font-weight:${active ? '600' : '500'};font-family:inherit;cursor:pointer;transition:all 0.15s">
        ${label}
      </button>
    `
  }

  container.innerHTML = `
    <div class="greeting">Providers</div>
    <div class="greeting-sub">${isProvider ? 'Browse other providers or manage your channel.' : 'Follow dietitians and coaches — copy their meal plans to your week.'}</div>

    ${isProvider ? `
      <!-- Tab switcher — only shown to users with a provider channel -->
      <div style="display:flex;gap:6px;margin-bottom:20px;background:var(--bg2);border:1px solid var(--border);border-radius:calc(var(--r) + 2px);padding:4px">
        ${tabPill('browse', '🔍 Browse')}
        ${tabPill('mychannel', '📡 My Channel')}
      </div>
    ` : ''}

    ${isProvider && tab === 'mychannel' ? renderMyProviderChannel() : directoryHtml}
  `

  // Load broadcasts for followed providers whenever we're showing the
  // directory (non-providers always; providers on the Browse tab). This
  // populates the 'No plans published yet' / '[Preview & copy]' buttons
  // on each followed-provider card.
  if (!isProvider || tab === 'browse') loadFollowedBroadcasts()
}

function renderProviderCard(p, isFollowing) {
  const avatar = p.provider_avatar_url
    ? `<img src="${esc(p.provider_avatar_url)}" alt="${esc(p.provider_name)}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><div style="display:none;width:44px;height:44px;background:rgba(76,175,130,0.15);border-radius:50%;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">🩺</div>`
    : `<div style="width:44px;height:44px;background:rgba(76,175,130,0.15);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">🩺</div>`

  // Credentials render as small accent-colored chips (think "RD · LD · CSCS").
  // We parse a comma-separated string and split on common separators. If the
  // provider hasn't filled this in yet, we fall back to showing the specialty
  // inline like before so their card still has a subtitle.
  const credentialChips = (p.credentials || '')
    .split(/[,|]/)
    .map(s => s.trim())
    .filter(Boolean)
  const chipsHtml = credentialChips.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin:3px 0 2px">${credentialChips.map(c =>
        `<span style="font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(76,175,130,0.12);color:var(--protein);border:1px solid rgba(76,175,130,0.3);white-space:nowrap">${esc(c)}</span>`
      ).join('')}</div>`
    : ''

  return `
    <div class="upload-card" style="padding:0;overflow:hidden">
      <div style="padding:14px 16px;display:flex;align-items:start;gap:12px">
        ${avatar}
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:600;color:var(--text)">${esc(p.provider_name || p.email || 'Provider')}</div>
          ${chipsHtml}
          ${p.provider_specialty ? `<div style="font-size:11px;color:var(--text2);margin-bottom:2px">${esc(p.provider_specialty)}</div>` : ''}
          ${p.provider_bio ? `<div style="font-size:12px;color:var(--text3);line-height:1.4">${esc(p.provider_bio)}</div>` : ''}
        </div>
        <button onclick="${isFollowing ? `unfollowProviderHandler('${p.user_id}')` : `followProviderHandler('${p.user_id}')`}"
          style="flex-shrink:0;padding:7px 14px;border-radius:var(--r);font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;border:1px solid ${isFollowing ? 'var(--border2)' : 'var(--protein)'};background:${isFollowing ? 'var(--bg3)' : 'rgba(76,175,130,0.15)'};color:${isFollowing ? 'var(--text3)' : 'var(--protein)'}">
          ${isFollowing ? 'Following' : '+ Follow'}
        </button>
      </div>
      <div id="broadcasts-${p.user_id}" style="border-top:1px solid var(--border)">
        <div style="padding:10px 16px;font-size:12px;color:var(--text3)">Loading plans...</div>
      </div>
    </div>
  `
}

function renderMyProviderChannel() {
  const broadcasts = state.myBroadcasts || []
  const u = state.usage || {}
  const avatarUrl = u.providerAvatarUrl || null
  return `
    <!-- Provider profile editor -->
    <div class="upload-card" style="margin-bottom:16px">
      <div class="section-title" style="margin-bottom:14px">My profile</div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
        <!-- Avatar -->
        <div style="position:relative;flex-shrink:0">
          <div id="provider-avatar-preview" style="width:72px;height:72px;border-radius:50%;overflow:hidden;background:rgba(76,175,130,0.15);display:flex;align-items:center;justify-content:center;font-size:32px;cursor:pointer" onclick="document.getElementById('provider-avatar-input').click()">
            ${avatarUrl
              ? `<img src="${esc(avatarUrl)}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML='🩺'" />`
              : '🩺'}
          </div>
          <div onclick="document.getElementById('provider-avatar-input').click()"
            style="position:absolute;bottom:0;right:0;width:22px;height:22px;background:var(--accent);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:11px">
            📷
          </div>
          <input type="file" id="provider-avatar-input" accept="image/*" style="display:none" onchange="uploadProviderAvatarHandler(this.files[0])" />
        </div>
        <div style="flex:1;font-size:12px;color:var(--text3);line-height:1.5">
          Tap your photo to update it.<br>This appears on your provider card and shared meal plan pages.
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="modal-field">
          <label>Display name</label>
          <input type="text" id="provider-name-input" value="${esc(u.providerName || '')}" placeholder="Your full name" />
        </div>
        <div class="modal-field">
          <label>Specialty</label>
          <input type="text" id="provider-specialty-input" value="${esc(u.providerSpecialty || '')}" placeholder="e.g. Sports nutrition, weight loss, pediatric" />
        </div>
        <div class="modal-field">
          <label>Credentials</label>
          <input type="text" id="provider-credentials-input" value="${esc(u.credentials || '')}" placeholder="e.g. RD, LD, MS, CSCS" />
          <div style="font-size:11px;color:var(--text3);margin-top:4px">Comma-separated. Shown as chips on your provider card.</div>
        </div>
        <div class="modal-field">
          <label>Bio</label>
          <textarea id="provider-bio-input" rows="3" style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px 12px;color:var(--text);font-size:13px;font-family:inherit;resize:none;outline:none;width:100%"
            placeholder="A short description shown on your provider card...">${esc(u.providerBio || '')}</textarea>
        </div>
        <button onclick="saveProviderProfileHandler()"
          style="background:var(--protein);color:#fff;border:none;border-radius:var(--r);padding:11px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer">
          Save profile
        </button>
      </div>
    </div>

    <!-- Broadcasts -->
    <div class="upload-card" style="margin-bottom:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div class="section-title" style="margin:0">My broadcasts</div>
        <button onclick="openNewBroadcastModal()"
          style="background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);padding:8px 14px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer">
          + New plan
        </button>
      </div>
      ${!broadcasts.length ? `
        <div style="text-align:center;padding:20px;color:var(--text3);font-size:13px">
          No broadcasts yet. Create your first weekly plan to share with followers.
        </div>
      ` : broadcasts.map(b => `
        <div style="background:var(--bg3);border-radius:var(--r);padding:12px;margin-bottom:8px;display:flex;align-items:start;justify-content:space-between;gap:8px">
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
              <span style="font-size:13px;font-weight:600;color:var(--text)">${esc(b.title)}</span>
              <span style="font-size:10px;padding:2px 7px;border-radius:999px;font-weight:600;background:${b.is_published ? 'rgba(76,175,130,0.2)' : 'var(--bg2)'};color:${b.is_published ? 'var(--protein)' : 'var(--text3)'}">
                ${b.is_published ? 'Live' : 'Draft'}
              </span>
            </div>
            <div style="font-size:11px;color:var(--text3)">Week of ${new Date(b.week_start + 'T12:00:00').toLocaleDateString([], {month:'short', day:'numeric'})}</div>
            ${b.description ? `<div style="font-size:11px;color:var(--text3);margin-top:2px">${esc(b.description)}</div>` : ''}
            <div style="font-size:11px;color:var(--text3);margin-top:4px">${(b.plan_data || []).length} meals planned</div>
            ${b.is_published && b.share_token ? `
            <div style="font-size:11px;color:var(--accent);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px">
              🔗 personal-health-tracking.vercel.app/api/plan/${b.share_token}
            </div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
            ${b.is_published && b.share_token ? `
            <button onclick="shareBroadcastLink('${b.share_token}', this)"
              style="background:color-mix(in srgb, var(--accent) 10%, transparent);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);border-radius:6px;padding:5px 10px;font-size:11px;color:var(--accent);cursor:pointer;font-family:inherit">
              🔗 Share link
            </button>` : ''}
            <button onclick="editBroadcastHandler('${b.id}')"
              style="background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:5px 10px;font-size:11px;color:var(--text2);cursor:pointer;font-family:inherit">
              Edit
            </button>
            <button onclick="toggleBroadcastPublished('${b.id}', ${b.is_published})"
              style="background:${b.is_published ? 'rgba(239,68,68,0.1)' : 'rgba(76,175,130,0.15)'};border:1px solid ${b.is_published ? 'var(--red)' : 'var(--protein)'};border-radius:6px;padding:5px 10px;font-size:11px;color:${b.is_published ? 'var(--red)' : 'var(--protein)'};cursor:pointer;font-family:inherit">
              ${b.is_published ? 'Unpublish' : 'Publish'}
            </button>
            <button onclick="deleteBroadcastHandler('${b.id}')"
              title="Delete plan"
              style="background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:5px 8px;font-size:11px;color:var(--text3);cursor:pointer;font-family:inherit">
              🗑
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  `
}

// Reusable macro target fields with lock-to-balance logic
function buildMacroFields(goals) {
  const cal = goals?.calories ?? 2000
  const pro = goals?.protein ?? 150
  const carb = goals?.carbs ?? 200
  const fat = goals?.fat ?? 65
  // Each macro has a lock icon — locked = fixed, unlocked = auto-adjusts
  // Default: calories locked, fat locked, carbs unlocks to balance
  const lockState = window._macroLockState || { cal: true, pro: false, carb: false, fat: true }
  const lockIcon = (key) => `
    <button onclick="toggleMacroLock('${key}')" title="${lockState[key] ? 'Locked — click to let this adjust' : 'Unlocked — click to lock'}"
      style="background:none;border:none;padding:2px 4px;cursor:pointer;font-size:13px;opacity:${lockState[key] ? '1' : '0.4'};line-height:1">
      ${lockState[key] ? '🔒' : '🔓'}
    </button>`
  const field = (id, label, val, color, lockKey) => `
    <div style="position:relative">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
        <label style="font-size:11px;color:${color};text-transform:uppercase;letter-spacing:0.5px;font-weight:600">${label}</label>
        ${lockIcon(lockKey)}
      </div>
      <input type="number" id="${id}" value="${val}"
        style="width:100%;background:var(--bg3);border:1px solid ${lockState[lockKey] ? 'var(--border2)' : color};border-radius:var(--r);padding:9px 12px;color:var(--text);font-size:15px;font-weight:600;font-family:inherit;outline:none;opacity:${lockState[lockKey] ? '0.7' : '1'}"
        ${lockState[lockKey] ? 'readonly' : ''}
        oninput="rebalanceMacros('${lockKey}')" />
    </div>`
  return `
    <div style="margin-bottom:6px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Daily targets</div>
        <div style="font-size:11px;color:var(--text3)">🔒 = fixed &nbsp; 🔓 = auto-adjusts</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:4px">
        ${field('goal-cal','Calories',cal,'var(--cal)','cal')}
        ${field('goal-p','Protein',pro,'var(--protein)','pro')}
        ${field('goal-c','Carbs',carb,'var(--carbs)','carb')}
        ${field('goal-f','Fat',fat,'var(--fat)','fat')}
      </div>
      <div style="font-size:11px;color:var(--text3);text-align:right;margin-top:2px" id="macro-balance-hint"></div>
    </div>
  `
}

function renderGoalsPage(container) {
  const m = state.bodyMetrics || {}
  const bmr = calcBMR(m)
  const tdee = calcTDEE(bmr, m.activity_level)
  const targets = calcTargetMacros(m, tdee)
  const weeks = weeksToGoal(m)
  const checkins = state.checkins || []
  const isImperial = state.units === 'imperial'

  // Conversion helpers
  const kgToLbs = kg => kg ? +(kg * 2.20462).toFixed(1) : ''
  const cmToFtIn = cm => {
    if (!cm) return { ft: '', inches: '' }
    const totalIn = cm / 2.54
    return { ft: Math.floor(totalIn / 12), inches: +(totalIn % 12).toFixed(1) }
  }
  const lbsToKg = lbs => lbs ? +(lbs / 2.20462).toFixed(2) : null
  const ftInToCm = (ft, inches) => ft ? +((parseFloat(ft)*12 + parseFloat(inches||0)) * 2.54).toFixed(1) : null

  const ftIn = cmToFtIn(m.height_cm)
  const weightDisplay = isImperial ? kgToLbs(m.weight_kg) : m.weight_kg
  const muscleDisplay = isImperial ? kgToLbs(m.muscle_mass_kg) : m.muscle_mass_kg
  const goalWeightDisplay = isImperial ? kgToLbs(m.goal_weight_kg) : m.goal_weight_kg

  const inp = (id, type, val, placeholder='') =>
    `<input type="${type}" id="${id}" value="${val ?? ''}" placeholder="${placeholder}"
      style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:9px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none">`
  const sel = (id, val, opts) =>
    `<select id="${id}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:9px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none">
      ${opts.map(([v,l]) => `<option value="${v}" ${val===v?'selected':''}>${l}</option>`).join('')}
    </select>`

  // Collapse state — explicit user choice (localStorage) wins; otherwise
  // default to expanded for missing data so the onboarding flow still
  // funnels new users into filling things in. Once data exists, we collapse
  // to keep the page short.
  const bmSaved = (() => { try { return localStorage.getItem('macrolens_goals_bm_open') } catch { return null } })()
  const gsSaved = (() => { try { return localStorage.getItem('macrolens_goals_gs_open') } catch { return null } })()
  const bmOpen = bmSaved === '1' || (bmSaved === null && !m.weight_kg)
  const gsOpen = gsSaved === '1' || (gsSaved === null && !state.goals?.calories)

  // Weekly average weight from check-ins. Buckets by Sunday-start week to
  // match getWeekStart() used elsewhere. A single bar per week — multiple
  // weigh-ins in the same week are averaged so the chart smooths out
  // morning/evening fluctuations.
  const weeklyAvgs = (() => {
    const buckets = {}
    for (const c of checkins) {
      const date = c.scan_date || (c.checked_in_at ? c.checked_in_at.slice(0, 10) : null)
      if (!date || !c.weight_kg) continue
      const d = new Date(date + 'T00:00:00')
      d.setDate(d.getDate() - d.getDay())
      const wk = localDateStr(d)
      if (!buckets[wk]) buckets[wk] = []
      buckets[wk].push(Number(c.weight_kg))
    }
    return Object.entries(buckets)
      .map(([weekStart, ws]) => ({ weekStart, avg_kg: ws.reduce((a,b)=>a+b,0) / ws.length, count: ws.length }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
  })()

  container.innerHTML = `
    <div class="greeting">Goals & Body</div>
    <div class="greeting-sub">Track your metrics, calculate your targets, log your progress.</div>

    <div class="upload-card" style="margin-bottom:16px">
      <div onclick="toggleGoalsSection('bm')"
        class="section-title" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;margin-bottom:${bmOpen ? '16px' : '0'}">
        <span style="display:flex;align-items:center;gap:8px">
          <span style="display:inline-block;transform:rotate(${bmOpen ? '90deg' : '0deg'});transition:transform 0.15s;font-size:11px;color:var(--text3)">▸</span>
          <span>Body metrics</span>
          ${!bmOpen && bmr ? `<span style="font-size:11px;color:var(--text3);font-weight:400;text-transform:none;letter-spacing:0;margin-left:8px">BMR ${bmr} · TDEE ${tdee}</span>` : ''}
        </span>
        ${bmOpen ? `
          <div onclick="event.stopPropagation()" style="display:flex;gap:4px;background:var(--bg3);border-radius:var(--r);padding:3px;border:1px solid var(--border)">
            <button onclick="setUnits('imperial')"
              style="padding:4px 10px;border:none;border-radius:calc(var(--r) - 2px);font-size:11px;font-family:inherit;cursor:pointer;font-weight:500;
                background:${isImperial ? 'var(--bg2)' : 'none'};color:${isImperial ? 'var(--text)' : 'var(--text3)'}">lbs / ft</button>
            <button onclick="setUnits('metric')"
              style="padding:4px 10px;border:none;border-radius:calc(var(--r) - 2px);font-size:11px;font-family:inherit;cursor:pointer;font-weight:500;
                background:${!isImperial ? 'var(--bg2)' : 'none'};color:${!isImperial ? 'var(--text)' : 'var(--text3)'}">kg / cm</button>
          </div>
        ` : ''}
      </div>
      <div style="${bmOpen ? '' : 'display:none'}">
        <button onclick="openCheckinModal()"
          style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--r);padding:11px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;margin-bottom:14px;display:flex;align-items:center;justify-content:center;gap:8px"
          onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
          📊 Log weight + InBody / DEXA scan
        </button>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label class="field-label">Sex</label>
          ${sel('bm-sex', m.sex||'male', [['male','Male'],['female','Female']])}
        </div>
        <div>
          <label class="field-label">Age</label>
          ${inp('bm-age','number', m.age, '30')}
        </div>
        ${isImperial ? `
        <div>
          <label class="field-label">Height (ft)</label>
          ${inp('bm-ft','number', ftIn.ft, '5')}
        </div>
        <div>
          <label class="field-label">Height (in)</label>
          ${inp('bm-in','number', ftIn.inches, '10')}
        </div>
        <div>
          <label class="field-label">Current weight (lbs)</label>
          ${inp('bm-weight','number', weightDisplay, '175')}
        </div>
        ` : `
        <div>
          <label class="field-label">Height (cm)</label>
          ${inp('bm-height','number', m.height_cm, '175')}
        </div>
        <div>
          <label class="field-label">Current weight (kg)</label>
          ${inp('bm-weight','number', weightDisplay, '80')}
        </div>
        `}
        <div>
          <label class="field-label">Body fat % <span style="font-weight:400;color:var(--text3)">(optional)</span></label>
          ${inp('bm-bf','number', m.body_fat_pct, 'e.g. 17')}
        </div>
        <div>
          <label class="field-label">Muscle mass (${isImperial ? 'lbs' : 'kg'})</label>
          ${inp('bm-muscle','number', muscleDisplay, '')}
        </div>
      </div>
      <div style="margin-bottom:12px">
        <label class="field-label">Activity level</label>
        ${sel('bm-activity', m.activity_level||'moderate', [
          ['sedentary','Sedentary (desk job, no exercise)'],
          ['light','Light (1-3x/week)'],
          ['moderate','Moderate (3-5x/week)'],
          ['active','Active (6-7x/week)'],
          ['very_active','Very active (2x/day or physical job)']
        ])}
      </div>

      ${bmr ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;padding:12px;background:var(--bg3);border-radius:var(--r)">
          <div style="text-align:center">
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">BMR</div>
            <div style="font-size:22px;font-weight:700;color:var(--accent)" id="calc-bmr">${bmr}</div>
            <div style="font-size:11px;color:var(--text3)">kcal at rest</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">TDEE</div>
            <div style="font-size:22px;font-weight:700;color:var(--protein)" id="calc-tdee">${tdee}</div>
            <div style="font-size:11px;color:var(--text3)">maintenance</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:12px;padding:0 2px" id="calc-formula-note">
          ${m.body_fat_pct
            ? '✓ Using Katch-McArdle (body fat % known — most accurate)'
            : '⚠ Using Mifflin-St Jeor estimate — add body fat % for better accuracy'}
        </div>
      ` : ''}
      </div>
    </div>

    <!-- Goal settings -->
    <div class="upload-card" style="margin-bottom:16px">
      <div onclick="toggleGoalsSection('gs')"
        class="section-title" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;margin-bottom:${gsOpen ? '12px' : '0'}">
        <span style="display:flex;align-items:center;gap:8px">
          <span style="display:inline-block;transform:rotate(${gsOpen ? '90deg' : '0deg'});transition:transform 0.15s;font-size:11px;color:var(--text3)">▸</span>
          <span>Goal settings</span>
          ${!gsOpen && state.goals?.calories ? `<span style="font-size:11px;color:var(--text3);font-weight:400;text-transform:none;letter-spacing:0;margin-left:8px">${state.goals.calories} kcal · ${state.goals.protein}P / ${state.goals.carbs}C / ${state.goals.fat}F</span>` : ''}
        </span>
      </div>
      <div style="${gsOpen ? '' : 'display:none'}">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label class="field-label">Goal weight (${isImperial ? 'lbs' : 'kg'})</label>
          ${inp('bm-goal-weight','number', goalWeightDisplay, isImperial ? '165' : '75')}
        </div>
        <div>
          <label class="field-label">Goal body fat %</label>
          ${inp('bm-goal-bf','number', m.goal_body_fat_pct, '15')}
        </div>
        <div>
          <label class="field-label">Direction</label>
          ${sel('bm-direction', m.weight_goal||'lose', [
            ['lose','Lose fat'],['maintain','Maintain'],['gain','Build muscle']
          ])}
        </div>
        <div>
          <label class="field-label">Pace</label>
          ${sel('bm-pace', m.pace||'moderate', [
            ['slow','Slow (sustainable)'],
            ['moderate','Moderate (recommended)'],
            ['aggressive','Aggressive (harder)']
          ])}
        </div>
      </div>

      <div id="calc-targets">
      ${targets ? `
        <div style="background:var(--bg3);border-radius:var(--r);padding:14px;margin-bottom:12px">
          <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px;display:flex;align-items:center;gap:6px">
            Calculated daily targets
            ${weeks ? `<span style="font-weight:400;color:var(--text3)">~${weeks} weeks to goal</span>` : ''}
            <button onclick="showMethodologyModal()" title="How are these calculated?"
              style="background:none;border:1px solid var(--border2);border-radius:50%;width:18px;height:18px;cursor:pointer;font-size:11px;color:var(--text3);display:inline-flex;align-items:center;justify-content:center;padding:0;font-family:inherit;flex-shrink:0;margin-left:auto"
              onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
              onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text3)'">i</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center">
            <div><div style="font-size:18px;font-weight:700;color:var(--accent)">${targets.calories}</div><div style="font-size:10px;color:var(--text3)">kcal</div></div>
            <div><div style="font-size:18px;font-weight:700;color:var(--protein)">${targets.protein}g</div><div style="font-size:10px;color:var(--text3)">protein</div></div>
            <div><div style="font-size:18px;font-weight:700;color:var(--carbs)">${targets.carbs}g</div><div style="font-size:10px;color:var(--text3)">carbs</div></div>
            <div><div style="font-size:18px;font-weight:700;color:var(--fat)">${targets.fat}g</div><div style="font-size:10px;color:var(--text3)">fat</div></div>
          </div>
          <button onclick="applyCalculatedTargets(${targets.calories},${targets.protein},${targets.carbs},${targets.fat})"
            style="width:100%;margin-top:10px;background:color-mix(in srgb, var(--accent) 10%, transparent);color:var(--accent);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);border-radius:var(--r);padding:8px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer">
            ↓ Use these targets (fills fields below)
          </button>
        </div>
      ` : `
        <div style="padding:12px;background:var(--bg3);border-radius:var(--r);font-size:13px;color:var(--text3);margin-bottom:12px">
          Fill in your body metrics above to calculate personalized macro targets.
        </div>
      `}
      </div>

      <!-- Manual override -->
      <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Daily macro targets</div>
          <div style="font-size:11px;color:var(--text3)">Edit manually or use calculated targets above</div>
        </div>
        ${buildMacroFields(state.goals)}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <button onclick="saveBodyMetricsOnly()"
            style="padding:12px;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);color:var(--text2);font-size:13px;font-weight:500;font-family:inherit;cursor:pointer"
            onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
            Save body metrics
          </button>
          <button onclick="saveGoalsHandler()"
            style="padding:12px;background:var(--accent);border:none;border-radius:var(--r);color:var(--accent-fg);font-size:13px;font-weight:700;font-family:inherit;cursor:pointer">
            Save targets
          </button>
        </div>
      </div>
      </div>
    </div>

    <!-- Weekly check-in -->
    <div class="upload-card" style="margin-bottom:16px">
      <div class="section-title">Weekly check-in</div>
      <button onclick="openCheckinModal()"
        style="width:100%;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);padding:14px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;margin-bottom:8px;display:flex;align-items:center;justify-content:center;gap:8px">
        📊 Log weight + InBody / DEXA scan
      </button>
      <div style="font-size:12px;color:var(--text3);text-align:center;margin-bottom:14px">
        Tap to enter your weekly weigh-in or upload an InBody / DEXA scan — AI extracts body composition automatically.
      </div>
      ${!weeklyAvgs.length ? `
        <div style="font-size:13px;color:var(--text3);padding:12px 0">No check-ins yet. Log your first weekly weigh-in!</div>
      ` : `
        <!-- Weekly average weight chart — one bar per week, multiple weigh-ins
             in the same week are averaged so day-to-day fluctuations smooth out. -->
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-size:12px;color:var(--text3)">Weekly average weight (${isImperial ? 'lbs' : 'kg'})</div>
            <div style="font-size:11px;color:var(--text3)">${weeklyAvgs.length} ${weeklyAvgs.length === 1 ? 'week' : 'weeks'}</div>
          </div>
          <div style="display:flex;align-items:flex-end;gap:4px;height:60px">
            ${(() => {
              const last = weeklyAvgs.slice(-12)
              const allAvgs = last.map(w => w.avg_kg)
              const minW = Math.min(...allAvgs), maxW = Math.max(...allAvgs)
              const range = maxW - minW || 1
              return last.map(w => {
                const pct = Math.round(((w.avg_kg - minW) / range) * 50 + 10)
                const display = isImperial ? +(w.avg_kg * 2.20462).toFixed(1) + ' lbs' : +w.avg_kg.toFixed(1) + ' kg'
                const tip = `Week of ${w.weekStart}: ${display} (${w.count} ${w.count === 1 ? 'reading' : 'readings'})`
                return `<div style="flex:1;background:var(--accent);border-radius:2px 2px 0 0;height:${pct}%;min-height:4px;opacity:0.85" title="${tip}"></div>`
              }).join('')
            })()}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${checkins.slice(0,8).map(c => buildCheckinRow(c, isImperial)).join('')}
        </div>
      `}
    </div>
  `

  // Wire save button to also save body metrics
  wireGoalsPage()
}

function wireGoalsPage() {
  // Live recalc when inputs change
  const ids = ['bm-sex','bm-age','bm-height','bm-weight','bm-bf','bm-muscle','bm-activity','bm-goal-weight','bm-goal-bf','bm-direction','bm-pace']
  ids.forEach(id => {
    const el = document.getElementById(id)
    if (el) el.addEventListener('change', () => window.previewGoalsCalc())
  })
}


// ─── Account Page ─────────────────────────────────────────────────────────────


// ─── Account Page ─────────────────────────────────────────────────────────────
function renderAccount(container) {
  const u = state.usage || {}
  const isImperial = state.units === 'imperial'
  const m = state.bodyMetrics || {}
  const bmr = calcBMR(m)
  const tdee = calcTDEE(bmr, m.activity_level)
  const targets = calcTargetMacros(m, tdee)
  const weeks = weeksToGoal(m)
  const spentPct = u.isUnlimited ? 0 : Math.min(100, Math.round(((u.spent ?? 0) / (u.limit ?? 10)) * 100))
  const spentColor = spentPct >= 90 ? 'var(--red)' : spentPct >= 70 ? 'var(--fat)' : 'var(--accent)'
  const kgToLbs = kg => kg ? +(kg * 2.20462).toFixed(1) : ''
  const cmToFtIn = cm => { if (!cm) return { ft: '', inches: '' }; const totalIn = cm / 2.54; return { ft: Math.floor(totalIn / 12), inches: +(totalIn % 12).toFixed(1) } }
  const ftIn = cmToFtIn(m.height_cm)
  const weightDisplay = isImperial ? kgToLbs(m.weight_kg) : m.weight_kg
  const muscleDisplay = isImperial ? kgToLbs(m.muscle_mass_kg) : m.muscle_mass_kg
  const goalWeightDisplay = isImperial ? kgToLbs(m.goal_weight_kg) : m.goal_weight_kg
  const inp = (id, type, val, placeholder='') =>
    `<input type="${type}" id="${id}" value="${val ?? ''}" placeholder="${placeholder}"
      style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:9px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none">`
  const sel = (id, val, opts) =>
    `<select id="${id}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:9px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none">
      ${opts.map(([v,l]) => `<option value="${v}" ${val===v?'selected':''}}>${l}</option>`).join('')}
    </select>`

  const _themeSaved = (() => { try { return localStorage.getItem('macrolens_theme') } catch { return null } })()
  const _themeCurrent = _themeSaved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  const _themeOpt = (id, label, sub, active) => `
    <button onclick="setTheme('${id}')"
      style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 10px;background:${active ? 'var(--bg4)' : 'var(--bg3)'};border:1px solid ${active ? 'var(--accent)' : 'var(--border2)'};border-radius:var(--r);color:${active ? 'var(--accent)' : 'var(--text2)'};font-family:inherit;font-size:13px;font-weight:${active ? '600' : '500'};cursor:pointer;transition:all 0.15s">
      <span style="font-size:20px">${id === 'light' ? '☀️' : id === 'dark' ? '🌙' : '🖥️'}</span>
      <span>${label}</span>
      <span style="font-size:11px;color:var(--text3);font-weight:400">${sub}</span>
    </button>`

  container.innerHTML = `
    <div class="greeting">Account</div>
    <div class="greeting-sub">${state.user.email}</div>

    <!-- Appearance -->
    <div class="upload-card" style="margin-bottom:16px">
      <div class="section-title">Appearance</div>
      <div style="display:flex;gap:8px">
        ${_themeOpt('light',  'Light',  'Bright',        _themeSaved === 'light')}
        ${_themeOpt('dark',   'Dark',   'Original',      _themeSaved === 'dark')}
        ${_themeOpt('system', 'System', 'Follow device', !_themeSaved)}
      </div>
      <div style="font-size:12px;color:var(--text3);margin-top:10px;line-height:1.5">
        Currently using ${_themeCurrent} mode.
      </div>
    </div>

    <!-- Data & history -->
    <div class="upload-card" style="margin-bottom:16px">
      <div class="section-title">Your data</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button onclick="switchPage('history')"
          style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);color:var(--text);font-family:inherit;font-size:14px;cursor:pointer;text-align:left;transition:border-color 0.15s"
          onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
          <span style="font-size:18px">📜</span>
          <div style="flex:1">
            <div style="font-weight:500">View all meal history</div>
            <div style="font-size:12px;color:var(--text3);margin-top:2px">Every meal you've logged, searchable and editable</div>
          </div>
          <span style="color:var(--text3)">›</span>
        </button>
        <button onclick="switchPage('analytics')"
          style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);color:var(--text);font-family:inherit;font-size:14px;cursor:pointer;text-align:left;transition:border-color 0.15s"
          onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
          <span style="font-size:18px">📊</span>
          <div style="flex:1">
            <div style="font-weight:500">Analytics</div>
            <div style="font-size:12px;color:var(--text3);margin-top:2px">Trends, goal adherence, patterns</div>
          </div>
          <span style="color:var(--text3)">›</span>
        </button>
      </div>
    </div>

    <!-- Usage card -->

    <div class="upload-card" style="margin-bottom:16px">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>Body metrics</span>
        <div style="display:flex;gap:4px;background:var(--bg3);border-radius:var(--r);padding:3px;border:1px solid var(--border)">
          <button onclick="setUnits('imperial')"
            style="padding:4px 10px;border:none;border-radius:calc(var(--r) - 2px);font-size:11px;font-family:inherit;cursor:pointer;font-weight:500;
              background:${isImperial ? 'var(--bg2)' : 'none'};color:${isImperial ? 'var(--text)' : 'var(--text3)'}">lbs / ft</button>
          <button onclick="setUnits('metric')"
            style="padding:4px 10px;border:none;border-radius:calc(var(--r) - 2px);font-size:11px;font-family:inherit;cursor:pointer;font-weight:500;
              background:${!isImperial ? 'var(--bg2)' : 'none'};color:${!isImperial ? 'var(--text)' : 'var(--text3)'}">kg / cm</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label class="field-label">Sex</label>
          ${sel('bm-sex', m.sex||'male', [['male','Male'],['female','Female']])}
        </div>
        <div>
          <label class="field-label">Age</label>
          ${inp('bm-age','number', m.age, '30')}
        </div>
        ${isImperial ? `
        <div>
          <label class="field-label">Height (ft)</label>
          ${inp('bm-ft','number', ftIn.ft, '5')}
        </div>
        <div>
          <label class="field-label">Height (in)</label>
          ${inp('bm-in','number', ftIn.inches, '10')}
        </div>
        <div>
          <label class="field-label">Current weight (lbs)</label>
          ${inp('bm-weight','number', weightDisplay, '175')}
        </div>
        ` : `
        <div>
          <label class="field-label">Height (cm)</label>
          ${inp('bm-height','number', m.height_cm, '175')}
        </div>
        <div>
          <label class="field-label">Current weight (kg)</label>
          ${inp('bm-weight','number', weightDisplay, '80')}
        </div>
        `}
        <div>
          <label class="field-label">Body fat % <span style="font-weight:400;color:var(--text3)">(optional)</span></label>
          ${inp('bm-bf','number', m.body_fat_pct, 'e.g. 17')}
        </div>
        <div>
          <label class="field-label">Muscle mass (${isImperial ? 'lbs' : 'kg'})</label>
          ${inp('bm-muscle','number', muscleDisplay, '')}
        </div>
      </div>
      <div style="margin-bottom:12px">
        <label class="field-label">Activity level</label>
        ${sel('bm-activity', m.activity_level||'moderate', [
          ['sedentary','Sedentary (desk job, no exercise)'],
          ['light','Light (1-3x/week)'],
          ['moderate','Moderate (3-5x/week)'],
          ['active','Active (6-7x/week)'],
          ['very_active','Very active (2x/day or physical job)']
        ])}
      </div>

      ${bmr ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;padding:12px;background:var(--bg3);border-radius:var(--r)">
          <div style="text-align:center">
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">BMR</div>
            <div style="font-size:22px;font-weight:700;color:var(--accent)" id="calc-bmr">${bmr}</div>
            <div style="font-size:11px;color:var(--text3)">kcal at rest</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">TDEE</div>
            <div style="font-size:22px;font-weight:700;color:var(--protein)" id="calc-tdee">${tdee}</div>
            <div style="font-size:11px;color:var(--text3)">maintenance</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:12px;padding:0 2px" id="calc-formula-note">
          ${m.body_fat_pct
            ? '✓ Using Katch-McArdle (body fat % known — most accurate)'
            : '⚠ Using Mifflin-St Jeor estimate — add body fat % for better accuracy'}
        </div>
      ` : ''}
    </div>

    <!-- Goal settings -->
    <div class="upload-card" style="margin-bottom:16px">
      <div class="section-title">Goal settings</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label class="field-label">Goal weight (${isImperial ? 'lbs' : 'kg'})</label>
          ${inp('bm-goal-weight','number', goalWeightDisplay, isImperial ? '165' : '75')}
        </div>
        <div>
          <label class="field-label">Goal body fat %</label>
          ${inp('bm-goal-bf','number', m.goal_body_fat_pct, '15')}
        </div>
        <div>
          <label class="field-label">Direction</label>
          ${sel('bm-direction', m.weight_goal||'lose', [
            ['lose','Lose fat'],['maintain','Maintain'],['gain','Build muscle']
          ])}
        </div>
        <div>
          <label class="field-label">Pace</label>
          ${sel('bm-pace', m.pace||'moderate', [
            ['slow','Slow (sustainable)'],
            ['moderate','Moderate (recommended)'],
            ['aggressive','Aggressive (harder)']
          ])}
        </div>
      </div>

      <div id="calc-targets">
      ${targets ? `
        <div style="background:var(--bg3);border-radius:var(--r);padding:14px;margin-bottom:12px">
          <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px;display:flex;align-items:center;gap:6px">
            Calculated daily targets
            ${weeks ? `<span style="font-weight:400;color:var(--text3)">~${weeks} weeks to goal</span>` : ''}
            <button onclick="showMethodologyModal()" title="How are these calculated?"
              style="background:none;border:1px solid var(--border2);border-radius:50%;width:18px;height:18px;cursor:pointer;font-size:11px;color:var(--text3);display:inline-flex;align-items:center;justify-content:center;padding:0;font-family:inherit;flex-shrink:0;margin-left:auto"
              onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
              onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text3)'">i</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center">
            <div><div style="font-size:18px;font-weight:700;color:var(--accent)">${targets.calories}</div><div style="font-size:10px;color:var(--text3)">kcal</div></div>
            <div><div style="font-size:18px;font-weight:700;color:var(--protein)">${targets.protein}g</div><div style="font-size:10px;color:var(--text3)">protein</div></div>
            <div><div style="font-size:18px;font-weight:700;color:var(--carbs)">${targets.carbs}g</div><div style="font-size:10px;color:var(--text3)">carbs</div></div>
            <div><div style="font-size:18px;font-weight:700;color:var(--fat)">${targets.fat}g</div><div style="font-size:10px;color:var(--text3)">fat</div></div>
          </div>
          <button onclick="applyCalculatedTargets(${targets.calories},${targets.protein},${targets.carbs},${targets.fat})"
            style="width:100%;margin-top:10px;background:color-mix(in srgb, var(--accent) 10%, transparent);color:var(--accent);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);border-radius:var(--r);padding:8px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer">
            ↓ Use these targets (fills fields below)
          </button>
        </div>
      ` : `
        <div style="padding:12px;background:var(--bg3);border-radius:var(--r);font-size:13px;color:var(--text3);margin-bottom:12px">
          Fill in your body metrics above to calculate personalized macro targets.
        </div>
      `}
      </div>

      <!-- Manual override -->
      <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Daily macro targets</div>
          <div style="font-size:11px;color:var(--text3)">Edit manually or use calculated targets above</div>
        </div>
        ${buildMacroFields(state.goals)}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <button onclick="saveBodyMetricsOnly()"
            style="padding:12px;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);color:var(--text2);font-size:13px;font-weight:500;font-family:inherit;cursor:pointer"
            onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
            Save body metrics
          </button>
          <button onclick="saveGoalsHandler()"
            style="padding:12px;background:var(--accent);border:none;border-radius:var(--r);color:var(--accent-fg);font-size:13px;font-weight:700;font-family:inherit;cursor:pointer">
            Save targets
          </button>
        </div>
      </div>
    </div>

    <div class="upload-card" style="max-width:520px;margin-bottom:20px">
      <div class="section-title">AI Bucks this month</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap">
        ${u.role === 'admin' ? `
          <span style="background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--accent);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600">👑 Admin</span>
          <span style="font-size:12px;color:var(--text3)">Unlimited access · All features</span>
        ` : u.role === 'provider' ? `
          <span style="background:rgba(76,175,130,0.15);color:var(--protein);border:1px solid rgba(76,175,130,0.3);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600">🩺 Provider</span>
          <span style="font-size:12px;color:var(--text3)">Professional access</span>
        ` : u.role === 'premium' ? `
          <span style="background:rgba(91,156,246,0.15);color:var(--carbs);border:1px solid rgba(91,156,246,0.3);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600">⭐ Premium</span>
          <span style="font-size:12px;color:var(--text3)">All AI features unlocked</span>
        ` : `
          <span style="background:var(--bg3);color:var(--text3);border:1px solid var(--border2);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:500">Free</span>
          <a href="#" onclick="switchPage('upgrade');return false" style="font-size:12px;color:var(--accent);text-decoration:none;font-weight:500">Upgrade to Premium →</a>
        `}
      </div>

      ${!u.isUnlimited ? `
      <!-- Big numeric readout: remaining bucks front and center -->
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px">
        <span style="font-size:32px;font-weight:700;color:${spentColor};font-family:'DM Serif Display',serif">${bucksCount(u.remaining ?? 0)}</span>
        <span style="font-size:13px;color:var(--text3)">AI Bucks remaining of ${bucksCount(u.limit ?? 0)}</span>
      </div>
      <div class="bar-bg" style="height:10px;margin-bottom:8px">
        <div class="bar-fill" style="background:${spentColor};width:${spentPct}%;transition:width 0.3s"></div>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:14px">Resets on the 1st of each month</div>

      ${u.role === 'free' && spentPct >= 70 ? `
      <!-- Upsell inline when they're approaching the cap -->
      <button onclick="switchPage('upgrade')"
        style="width:100%;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);padding:12px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;margin-bottom:8px">
        ⚡ Upgrade for ${bucksCount(10.00)} AI Bucks/mo
      </button>` : ''}
      ` : `
      <!-- Unlimited users see request count instead -->
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:14px">
        <span style="font-size:32px;font-weight:700;color:var(--protein);font-family:'DM Serif Display',serif">${u.requests ?? 0}</span>
        <span style="font-size:13px;color:var(--text3)">AI actions this month · unlimited</span>
      </div>
      `}

      ${u.override ? `
      <!-- Admin override indicator. Only shows if someone manually pinned
           this user's cap via the spending_limit_usd column. Permanent
           overrides have no expiration; time-limited ones show the date. -->
      <div style="background:rgba(91,156,246,0.08);border:1px solid rgba(91,156,246,0.25);border-radius:var(--r);padding:10px 12px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div style="font-size:12px;color:var(--carbs);line-height:1.4">
          <div style="font-weight:600">Custom allotment active${u.override.active ? '' : ' (expired)'}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">${u.override.expiresAt ? 'Expires ' + u.override.expiresAt.toLocaleDateString() : 'Permanent (no expiration)'}</div>
        </div>
        <button onclick="clearOverrideHandler()"
          style="background:transparent;border:1px solid var(--border2);color:var(--text2);border-radius:var(--r);padding:6px 10px;font-size:11px;font-family:inherit;cursor:pointer;flex-shrink:0">
          Clear
        </button>
      </div>` : ''}
    </div>

    <!-- AI info -->
    <div class="upload-card" style="max-width:520px;margin-bottom:20px">
      <div class="section-title">AI analysis</div>
      <p style="font-size:13px;color:var(--text2);line-height:1.6">
        Food analysis is powered by Claude AI and runs securely on our servers.
        No API key needed — each action uses a small number of AI Bucks from your monthly allotment above.
      </p>
    </div>

    <!-- Admin panel -->
    ${u.isAdmin ? `
    <div class="upload-card" style="max-width:900px;margin-bottom:20px">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>👑 Admin panel — all users</span>
        <button class="clear-btn" onclick="refreshAdminPanel()" style="color:var(--accent)">Refresh</button>
      </div>
      <div id="admin-panel-content">
        <div style="color:var(--text3);font-size:13px;padding:20px 0">Loading users...</div>
      </div>
    </div>
    <div class="upload-card" style="max-width:900px;margin-bottom:20px">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
        <span>🪲 Error logs <span style="font-size:11px;font-weight:400;color:var(--text3)">(auto-cleared after 14 days)</span></span>
        <button class="clear-btn" onclick="loadErrorLogs()" style="color:var(--accent)" id="error-log-load-btn">Load</button>
      </div>
      <div id="error-log-content" style="color:var(--text3);font-size:12px;padding:8px 0">
        Tap Load to view recent errors across all users.
      </div>
    </div>` : ''}

    <!-- Sign out -->
    <div class="upload-card" style="max-width:520px">
      <div class="section-title">Session</div>
      <button class="btn-delete" style="width:100%;padding:12px;font-size:14px" onclick="handleSignOut()">Sign out</button>
    </div>
  `

  if (u.isAdmin) loadAdminPanel()
}

async function loadAdminPanel() {
  const el = document.getElementById('admin-panel-content')
  if (!el) return
  el.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:20px 0">Loading...</div>'
  try {
    const users = await getAdminUserOverview()
    if (!users.length) { el.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:20px 0">No users yet.</div>'; return }

    // Aggregate stats
    const totalUsers = users.length
    const activeUsers = users.filter(u => u.account_status === 'active').length
    const totalSpentMonth = users.reduce((a, u) => a + Number(u.spent_this_month_usd ?? 0), 0)
    const totalSpentAllTime = users.reduce((a, u) => a + Number(u.total_spent_usd ?? 0), 0)
    const totalLogs = users.reduce((a, u) => a + Number(u.log_entries_total ?? 0), 0)
    const totalLogsMonth = users.reduce((a, u) => a + Number(u.log_entries_this_month ?? 0), 0)
    const totalTokensMonth = users.reduce((a, u) => a + Number(u.tokens_this_month ?? 0), 0)

    // New users this month
    const newThisMonth = users.filter(u => {
      if (!u.created_at) return false
      const joined = new Date(u.created_at)
      const now = new Date()
      return joined.getMonth() === now.getMonth() && joined.getFullYear() === now.getFullYear()
    }).length

    el.innerHTML = `
      <!-- Summary metrics -->
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:20px">
        ${[
          { label: 'Total users', value: totalUsers, sub: `${newThisMonth} new this month`, color: 'var(--accent)' },
          { label: 'Active', value: activeUsers, sub: `${totalUsers - activeUsers} inactive`, color: 'var(--protein)' },
          { label: 'Spend this month', value: '$' + totalSpentMonth.toFixed(3), sub: '$' + totalSpentAllTime.toFixed(3) + ' all time', color: 'var(--cal)' },
          { label: 'AI tokens (month)', value: Math.round(totalTokensMonth/1000) + 'k', sub: totalLogsMonth + ' meals logged', color: 'var(--carbs)' },
        ].map(s => `
          <div style="background:var(--bg3);border-radius:var(--r);padding:12px;border:1px solid var(--border)">
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">${s.label}</div>
            <div style="font-size:22px;font-weight:700;color:${s.color}">${s.value}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${s.sub}</div>
          </div>`).join('')}
      </div>

      <!-- User list -->
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px">
        All users — ${totalUsers} total
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${users.map(u => {
          const spentPct = Math.min(100, (Number(u.spent_this_month_usd ?? 0) / Number(u.spending_limit_usd ?? 10)) * 100)
          const joinDate = u.created_at ? new Date(u.created_at).toLocaleDateString([], {month:'short', day:'numeric', year:'numeric'}) : '?'
          const lastActive = u.last_active ? new Date(u.last_active).toLocaleDateString([], {month:'short', day:'numeric'}) : 'never'
          const isNew = u.created_at && (() => { const d = new Date(u.created_at); const n = new Date(); return d.getMonth()===n.getMonth()&&d.getFullYear()===n.getFullYear() })()
          return `
          <div style="background:var(--bg3);border-radius:var(--r);padding:12px;border:1px solid var(--border)">
            <div style="display:flex;align-items:start;justify-content:space-between;gap:8px;margin-bottom:8px">
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:500;color:var(--text);display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                  ${esc(u.email)}
                  ${isNew ? '<span style="font-size:10px;background:rgba(76,175,130,0.2);color:var(--protein);border-radius:4px;padding:1px 5px">🆕 new</span>' : ''}
                </div>
                <div style="font-size:11px;color:var(--text3);margin-top:3px">
                  Joined ${joinDate} · Last active ${lastActive} · ${u.log_entries_total ?? 0} meals · ${u.recipe_count ?? 0} recipes
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                <!-- Role selector. Uses the canonical 4-role set from the
                     refactor: free / premium / provider / admin. Anything
                     in u.role outside this set falls back to 'free' for
                     the dropdown's selected value (those rows shouldn't
                     exist after the refactor migration, but defensive). -->
                <select onchange="changeUserRole('${u.user_id}', this.value)"
                  style="background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;font-size:12px;color:var(--text);font-family:inherit;cursor:pointer">
                  ${['admin','provider','premium','free'].map(r =>
                    '<option value="' + r + '" ' + ((u.role||'free') === r ? 'selected' : '') + '>' +
                    {admin:'👑 Admin',provider:'🩺 Provider',premium:'⭐ Premium',free:'Free'}[r] + '</option>'
                  ).join('')}
                </select>
                <button class="td-act" title="${u.account_status === 'active' ? 'Suspend' : 'Activate'}"
                  onclick="toggleSuspend('${u.user_id}', '${u.account_status}')"
                  style="color:${u.account_status === 'active' ? 'var(--text3)' : 'var(--protein)'}">
                  ${u.account_status === 'active' ? '⏸' : '▶'}
                </button>
              </div>
            </div>
            <!-- Spend bar -->
            <div style="display:flex;align-items:center;gap:8px">
              <div style="flex:1;height:4px;background:var(--bg4);border-radius:2px;overflow:hidden">
                <div style="width:${spentPct}%;height:100%;background:${spentPct > 80 ? 'var(--red)' : spentPct > 50 ? 'var(--cal)' : 'var(--protein)'};border-radius:2px"></div>
              </div>
              <span style="font-size:11px;color:var(--text3);white-space:nowrap">
                $${Number(u.spent_this_month_usd??0).toFixed(3)} / $${Number(u.spending_limit_usd??10).toFixed(0)} · ${u.requests_this_month??0} req · ${Math.round((u.tokens_this_month??0)/1000)}k tokens
              </span>
            </div>
          </div>`
        }).join('')}
      </div>
    `
  } catch (err) {
    if (el) el.innerHTML = `<div style="color:var(--red);font-size:13px">Error: ${err.message}</div>`
  }
}

// ─── Analyze Food ─────────────────────────────────────────────────────────────
async function doAnalyze() {
  const mealHint = document.getElementById('meal-name-input')?.value.trim() ?? ''

  if (state.currentMode === 'recipe') {
    if (state.recipeMode === 'write') {
      // Single textarea handles description, ingredient list, AND URLs.
      // Regex picks out any URL; if found, route to dishBySearch (web search)
      // so we can pull the recipe off the page. Otherwise analyzeRecipe.
      const raw = document.getElementById('recipe-input')?.value.trim()
      if (!raw) { showToast('Please write, paste, or link the recipe first', 'error'); return null }
      const urlMatch = raw.match(/https?:\/\/\S+/)
      if (urlMatch) {
        const url = urlMatch[0]
        const dishName = raw.replace(urlMatch[0], '').trim() || url
        return await analyzeDishBySearch(dishName, url)
      }
      return await analyzeRecipe(raw, mealHint)
    } else if (state.recipeMode === 'snap') {
      if (!state.recipeImageBase64) { showToast('Please snap or choose a recipe photo first', 'error'); return null }
      const btn = document.getElementById('analyze-btn')
      if (btn) btn.innerHTML = '<span class="analyzing-spinner"></span> Reading recipe...'
      return await analyzeRecipePhoto(state.recipeImageBase64, mealHint)
    }
  }

  if (state.currentMode === 'food') {
    if (state.foodMode === 'search') {
      const desc = document.getElementById('food-search-input')?.value.trim()
      if (!desc) { showToast('Please describe the food first', 'error'); return null }
      return await analyzeFoodItem(desc)
    } else if (state.foodMode === 'photo') {
      // Unified photo path. handlePhotoUnified() already ran when the file
      // was picked, and either:
      //  a) Found a barcode and called lookupBarcode (result shown directly)
      //  b) Classified the image and cached what to run under
      //     state._pendingFoodPhotoAction — we just execute that here.
      if (state._pendingFoodPhotoAction) {
        const action = state._pendingFoodPhotoAction
        state._pendingFoodPhotoAction = null
        return await action(mealHint)
      }
      // Manual barcode entry fallback (if user typed a UPC)
      const manualCode = document.getElementById('barcode-manual-input')?.value.trim()
      if (manualCode) {
        return await new Promise(resolve => {
          lookupBarcode(manualCode).then(resolve).catch(() => resolve(null))
        })
      }
      showToast('Please take or upload a photo first', 'error')
      return null
    }
  }

  return null
}

// ─── Sidebar Stats ────────────────────────────────────────────────────────────
function updateSidebar() {
  // Always keep nav active state in sync with current page
  document.querySelectorAll('.nav-item[id^="nav-"]').forEach(el => {
    const page = el.id.replace('nav-', '')
    el.classList.toggle('active', page === state.currentPage)
  })

  const today = getTodayLog()
  const t = totals(today)
  const g = state.goals

  const setSb = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text }
  const setBar = (id, pct) => { const el = document.getElementById(id); if (el) el.style.width = pct + '%' }

  setSb('sb-cal', `${Math.round(t.cal)} / ${g.calories}`)
  setSb('sb-p', `${Math.round(t.p)} / ${g.protein}g`)
  setSb('sb-c', `${Math.round(t.c)} / ${g.carbs}g`)
  setSb('sb-f', `${Math.round(t.fat)} / ${g.fat}g`)
  setBar('sb-cal-bar', Math.min(100, (t.cal / g.calories) * 100))
  setBar('sb-p-bar', Math.min(100, (t.p / g.protein) * 100))
  setBar('sb-c-bar', Math.min(100, (t.c / g.carbs) * 100))
  setBar('sb-f-bar', Math.min(100, (t.fat / g.fat) * 100))
}

function updateStats() {
  const today = getTodayLog()
  const t = totals(today)
  const g = state.goals

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val }
  set('stat-cal', Math.round(t.cal))
  set('stat-p', Math.round(t.p) + 'g')
  set('stat-c', Math.round(t.c) + 'g')
  set('stat-f', Math.round(t.fat) + 'g')
  set('bar-cal-val', `${Math.round(t.cal)} / ${g.calories}`)
  set('bar-p-val', `${Math.round(t.p)} / ${g.protein}g`)
  set('bar-c-val', `${Math.round(t.c)} / ${g.carbs}g`)
  set('bar-f-val', `${Math.round(t.fat)} / ${g.fat}g`)

  const setBar = (id, pct) => { const el = document.getElementById(id); if (el) el.style.width = pct + '%' }
  setBar('bar-cal', Math.min(100, (t.cal / g.calories) * 100))
  setBar('bar-p', Math.min(100, (t.p / g.protein) * 100))
  setBar('bar-c', Math.min(100, (t.c / g.carbs) * 100))
  setBar('bar-f', Math.min(100, (t.fat / g.fat) * 100))

  // Donut
  const tc = t.p * 4 + t.c * 4 + t.fat * 9
  set('donut-cal', Math.round(t.cal))
  const circ = 2 * Math.PI * 50
  const pP = tc > 0 ? (t.p * 4) / tc : 0
  const pC = tc > 0 ? (t.c * 4) / tc : 0
  const pF = tc > 0 ? (t.fat * 9) / tc : 0
  const sd = (id, dash, off) => {
    const el = document.getElementById(id)
    if (el) { el.setAttribute('stroke-dasharray', `${dash * circ} ${circ}`); el.setAttribute('stroke-dashoffset', -(off * circ)) }
  }
  sd('d-protein', pP, 0); sd('d-carbs', pC, pP); sd('d-fat', pF, pP + pC)
  set('leg-p', Math.round(pP * 100) + '%')
  set('leg-c', Math.round(pC * 100) + '%')
  set('leg-f', Math.round(pF * 100) + '%')

  updateSidebar()
}

function showResult(r) {
  const card = document.getElementById('result-card')
  const content = document.getElementById('result-content')
  if (!content) return
  if (card) card.style.display = ''
  content.style.display = 'flex'
  document.getElementById('res-name').textContent = r.name
  document.getElementById('res-name').style.color = 'var(--text)'
  document.getElementById('res-name').style.fontFamily = "'DM Serif Display', serif"
  document.getElementById('res-name').style.fontSize = '20px'
  document.getElementById('res-desc').textContent = r.description ?? ''
  document.getElementById('res-pills').innerHTML = `
    <span class="macro-pill pill-cal">${Math.round(r.calories)} kcal</span>
    <span class="macro-pill pill-p">${Math.round(r.protein)}g protein</span>
    <span class="macro-pill pill-c">${Math.round(r.carbs)}g carbs</span>
    <span class="macro-pill pill-f">${Math.round(r.fat)}g fat</span>
    ${r.fiber ? `<span class="macro-pill pill-fiber">${Math.round(r.fiber)}g fiber</span>` : ''}
  `

  // Ingredients list
  const ingredients = r.ingredients || []
  const ingredientHTML = ingredients.length ? `
    <div style="margin-top:4px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:8px">
        Ingredients (${ingredients.length}) — for ${r.servings || 1} serving${(r.servings || 1) !== 1 ? 's' : ''}
      </div>
      <div style="border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        ${ingredients.map(ing => `
          <div style="display:flex;gap:10px;align-items:center;padding:7px 12px;border-bottom:1px solid var(--border);font-size:13px">
            <span style="color:var(--accent);min-width:70px;font-weight:500">${esc(ing.amount || '')} ${esc(ing.unit || '')}</span>
            <span style="color:var(--text)">${esc(ing.name)}</span>
          </div>`).join('').replace(/border-bottom[^;]+;([^<]*)<\/div>\s*$/, '$1</div>')}
      </div>
    </div>` : ''

  document.getElementById('res-detail').innerHTML = `
    ${r.brand ? `<span style="color:var(--text3)">Brand: </span><span>${esc(r.brand)}</span>&nbsp;&nbsp;` : ''}
    ${r.serving_size ? `<span style="color:var(--text3)">Serving: </span><span>${esc(r.serving_size)}</span>&nbsp;&nbsp;` : ''}
    <span style="color:var(--text3)">Sugar: </span><span>${Math.round(r.sugar || 0)}g</span>
    ${r.sodium ? `&nbsp;&nbsp;<span style="color:var(--text3)">Sodium: </span><span>${Math.round(r.sodium)}mg</span>` : ''}
    &nbsp;&nbsp;<span style="color:var(--text3)">Confidence: </span><span>${r.confidence}</span>
    ${r.notes ? `<br><span style="color:var(--text3)">Note: </span><span>${r.notes}</span>` : ''}
    ${ingredientHTML}
  `
  const btn = document.getElementById('log-entry-btn')
  if (btn) { btn.textContent = '+ Log this meal'; btn.className = 'log-btn'; btn.style.display = 'block' }
  // Add save button — routes to Foods or Recipes based on content
  if (!document.getElementById('save-recipe-btn')) {
    const recipeBtn = document.createElement('button')
    recipeBtn.id = 'save-recipe-btn'
    recipeBtn.className = 'log-btn'
    const hasIngredients = r.ingredients?.length > 0
    recipeBtn.textContent = hasIngredients ? '⭐ Save as recipe' : '🍎 Save to My Foods'
    recipeBtn.onclick = () => window.saveAsRecipeHandler?.()
    btn?.parentNode?.appendChild(recipeBtn)
  } else {
    const rb = document.getElementById('save-recipe-btn')
    const hasIngredients = r.ingredients?.length > 0
    rb.textContent = hasIngredients ? '⭐ Save as recipe' : '🍎 Save to My Foods'
    rb.disabled = false; rb.style.color = ''
  }
}

function refreshTodayLog() {
  const el = document.getElementById('today-log-body')
  if (!el) return
  // Replace element entirely to kill any stacked event listeners
  const newEl = el.cloneNode(false)
  newEl.innerHTML = renderTodayMeals(getTodayLog())
  el.parentNode.replaceChild(newEl, el)
  wireTodayLogClicks(newEl)
}

function wireTodayLogClicks(container) {
  if (!container || container._todayWired) return
  container._todayWired = true
  container.addEventListener('click', e => {
    // Logged entry — meal type toggle button
    const typeBtn = e.target.closest('[data-type-btn]')
    if (typeBtn) {
      e.stopPropagation()
      window.changeMealType(typeBtn.dataset.typeBtn, typeBtn.dataset.currentType)
      return
    }
    // Logged entry row — open edit modal
    const logRow = e.target.closest('[data-log-id]')
    if (logRow) {
      window.openEditModal(logRow.dataset.logId, 'log')
      return
    }
    // Planned meal row — log it
    const planRow = e.target.closest('[data-plan-id]')
    if (planRow) {
      window.logPlannedMeal(planRow.dataset.planId, planRow.dataset.mealType)
    }
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTodayLog() {
  const today = new Date().toDateString()
  return state.log.filter(e => new Date(e.logged_at || e.timestamp).toDateString() === today)
}

function totals(entries) {
  return entries.reduce((a, e) => ({
    cal: a.cal + (e.calories || 0),
    p: a.p + (e.protein || 0),
    c: a.c + (e.carbs || 0),
    fat: a.fat + (e.fat || 0)
  }), { cal: 0, p: 0, c: 0, fat: 0 })
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

function showToast(msg, type) {
  const t = document.getElementById('toast')
  if (!t) return
  t.textContent = msg
  t.className = 'toast show ' + (type || '')
  setTimeout(() => { t.className = 'toast' }, 3000)
}

function wireFileInput() {
  const fi = document.getElementById('file-input')
  const ua = document.getElementById('upload-area')
  if (!fi || !ua) return
  fi.addEventListener('change', e => { const f = e.target.files[0]; if (f) handleFile(f) })
  ua.addEventListener('dragover', e => { e.preventDefault(); ua.classList.add('drag-over') })
  ua.addEventListener('dragleave', () => ua.classList.remove('drag-over'))
  ua.addEventListener('drop', e => { e.preventDefault(); ua.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f) handleFile(f) })
}

// Downscale a photo file to a base64 JPEG (no data URL prefix) that fits
// comfortably within Vercel's 4.5MB edge function body limit. iPhone 12MP
// photos routinely hit ~4-7MB base64 — unscaled, they cause "Load failed"
// fetch errors before our code even sees the request.
//
// Targets a max dimension of 1600px and JPEG quality 0.85, which preserves
// enough detail for nutrition-label OCR and food-photo analysis while
// typically landing under 500KB.
//
// Tries two paths: createImageBitmap (fast, efficient, but chokes on HEIC
// in older Safari versions), then falls back to <img> element decoding
// (slower but handles HEIC via the browser's native image pipeline).
async function downscaleImage(file, { maxDim = 1600, quality = 0.85 } = {}) {
  const drawAndEncode = async (source, srcW, srcH) => {
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH))
    const w = Math.max(1, Math.round(srcW * scale))
    const h = Math.max(1, Math.round(srcH * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(source, 0, 0, w, h)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) throw new Error('toBlob returned null')
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result)
      fr.onerror = () => reject(fr.error || new Error('FileReader failed'))
      fr.readAsDataURL(blob)
    })
    return { base64: dataUrl.split(',')[1], dataUrl, width: w, height: h, bytes: blob.size }
  }

  // Attempt 1: createImageBitmap — fast, works for most formats
  try {
    const bitmap = await createImageBitmap(file)
    return await drawAndEncode(bitmap, bitmap.width, bitmap.height)
  } catch (err1) {
    console.warn('createImageBitmap path failed:', err1?.message || err1)
  }

  // Attempt 2: load into an <img> element via object URL. This handles
  // HEIC (iPhone's default format since iOS 11), because Safari decodes
  // HEIC natively for <img> but not for createImageBitmap.
  try {
    const objUrl = URL.createObjectURL(file)
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('Image failed to load (unsupported format?)'))
        el.src = objUrl
      })
      return await drawAndEncode(img, img.naturalWidth || img.width, img.naturalHeight || img.height)
    } finally {
      URL.revokeObjectURL(objUrl)
    }
  } catch (err2) {
    console.warn('img-element path failed:', err2?.message || err2)
  }

  // Attempt 3: give up on resizing — return the raw bytes as base64.
  // Downstream may reject if too big, but at least we give it a shot.
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(fr.error || new Error('FileReader failed'))
    fr.readAsDataURL(file)
  })
  return { base64: dataUrl.split(',')[1], dataUrl, width: 0, height: 0, bytes: file.size }
}

function handleFile(file) {
  // Show immediate loading state so the user knows the upload registered
  const inner = document.getElementById('upload-inner')
  if (inner) inner.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">Processing photo…</div>`
  downscaleImage(file).then(({ base64, dataUrl, bytes }) => {
    state.imageBase64 = base64
    if (inner) inner.innerHTML = `<img src="${dataUrl}" class="preview-img" alt="preview">`
    const empty = document.getElementById('result-empty')
    if (empty) empty.style.display = 'none'
    console.log(`[photo] Downscaled to ${Math.round(bytes / 1024)}KB`)
  }).catch(err => {
    if (inner) inner.innerHTML = `<div style="padding:20px;text-align:center;color:var(--red);font-size:13px">Failed to load photo: ${err?.message || err}</div>`
  })
}

// ─── Wire Global Handlers ─────────────────────────────────────────────────────
function wireGlobals() {
  window.switchPage = (name) => {
    state.currentPage = name
    sessionStorage.setItem('macrolens_page', name)
    // Update active nav item directly — shell doesn't re-render
    document.querySelectorAll('.nav-item[id^="nav-"]').forEach(el => {
      const page = el.id.replace('nav-', '')
      el.classList.toggle('active', page === name)
    })
    renderPage()
    closeSidebar()
  }

  window.updateAnalyzeBtn = function() {
    const btn = document.getElementById('analyze-btn')
    if (!btn) return
    // Food > Photo is special: button state tracks the classification
    // pipeline so the user isn't tempted to tap before we know what to do.
    //  - idle        : no photo picked yet → disabled, prompt to upload
    //  - processing  : downscaling / barcode decode / AI classifier running
    //                  → disabled, shows what's happening
    //  - ready-label : classifier said 'label' → enabled, 'Analyze label'
    //  - ready-food  : classifier said 'food'  → enabled, 'Analyze meal'
    //  - done-barcode: barcode already looked up → disabled (nothing to run)
    if (state.currentMode === 'food' && state.foodMode === 'photo') {
      const ps = state.foodPhotoStatus || 'idle'
      btn.disabled = (ps === 'idle' || ps === 'processing' || ps === 'done-barcode')
      btn.style.opacity = btn.disabled ? '0.5' : '1'
      btn.style.cursor = btn.disabled ? 'not-allowed' : 'pointer'
      const photoLabels = {
        'idle':         '📸 Take or upload a photo',
        'processing':   '⏳ Reading photo...',
        'ready-label':  '✨ Analyze nutrition label',
        'ready-food':   '✨ Analyze meal photo',
        'done-barcode': '✓ Product found above',
      }
      btn.textContent = photoLabels[ps]
      return
    }

    // All other modes use the simple static labels. Re-enable the button
    // in case we're coming back from a disabled photo state.
    btn.disabled = false
    btn.style.opacity = '1'
    btn.style.cursor = 'pointer'
    const labels = {
      food: {
        search: '✨ Analyze with AI',
        photo:  '📸 Analyze photo',
      },
      recipe: {
        write: '✨ Analyze recipe',
        snap:  '📸 Read recipe photo',
      },
    }
    const group = labels[state.currentMode] || labels.food
    const subMode = state.currentMode === 'food' ? state.foodMode : state.recipeMode
    btn.textContent = group[subMode] || '✨ Analyze with AI'
  }

  window.switchMode = (mode) => {
    state.currentMode = mode
    // Clear stale image state when leaving a photo mode, so a base64 from
    // one mode can't leak into another.
    if (mode !== 'food' || state.foodMode !== 'photo') {
      state.imageBase64 = null
      state.labelImageBase64 = null
      state._pendingFoodPhotoAction = null
      state.foodPhotoStatus = 'idle'
    }
    if (mode !== 'recipe' || state.recipeMode !== 'snap') {
      state.recipeImageBase64 = null
    }
    ;['recipe', 'food'].forEach(m => {
      const panel = document.getElementById(`mode-${m}`)
      if (panel) panel.classList.toggle('active', m === mode)
    })
    document.querySelectorAll('.mode-tab[data-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode)
    })
    if (mode === 'food' && state.foodMode === 'photo') wireFoodPhotoInput()
    if (mode === 'recipe' && state.recipeMode === 'snap') wireRecipeSnapInput()
    window.updateAnalyzeBtn()
  }

  window.setRecipeMode = (mode) => {
    state.recipeMode = mode
    ;['write', 'snap'].forEach(m => {
      const panel = document.getElementById(`recipe-panel-${m}`)
      const btn = document.getElementById(`recipe-btn-${m}`)
      if (panel) panel.style.display = m === mode ? '' : 'none'
      if (btn) btn.classList.toggle('active', m === mode)
    })
    if (mode === 'snap') wireRecipeSnapInput()
    window.updateAnalyzeBtn()
  }

  // Detect Instagram / TikTok URLs. Both are private platforms that block
  // automated fetching (robots.txt, anti-scraping). Shared by the Write-it
  // textarea hint and the "Paste a link" import modal.
  //   Returns 'instagram' | 'tiktok' | null.
  function detectPrivateRecipePlatform(text) {
    const s = (text || '').toLowerCase()
    if (/https?:\/\/(www\.|m\.)?(instagram\.com|instagr\.am)\//.test(s)) return 'instagram'
    if (/https?:\/\/(www\.|vm\.|vt\.)?tiktok\.com\//.test(s)) return 'tiktok'
    return null
  }

  // Toggle show/hide on a { hint, default, platformSpan } trio based on whether
  // the given text contains a private-platform URL. Used by both the Write-it
  // textarea and the Paste-a-link modal so the UX is consistent.
  function togglePrivatePlatformHint({ hintId, defaultId, platformSpanId, value }) {
    const hint = document.getElementById(hintId)
    const defaultEl = defaultId ? document.getElementById(defaultId) : null
    const platformSpan = platformSpanId ? document.getElementById(platformSpanId) : null
    if (!hint) return
    const platform = detectPrivateRecipePlatform(value)
    if (platform) {
      if (platformSpan) platformSpan.textContent = platform === 'instagram' ? 'Instagram' : 'TikTok'
      hint.style.display = ''
      if (defaultEl) defaultEl.style.display = 'none'
    } else {
      hint.style.display = 'none'
      if (defaultEl) defaultEl.style.display = ''
    }
  }

  // Shows an actionable hint when the user pastes an Instagram or TikTok URL
  // into the Write-it textarea. These platforms block automated fetching,
  // so the "just paste a URL" flow silently falls back to dish-name search —
  // which fails if the user didn't also describe the dish. Better to tell
  // them up front what they need to do.
  window.checkRecipeWriteHint = (value) => {
    togglePrivatePlatformHint({
      hintId: 'recipe-write-private-hint',
      defaultId: 'recipe-write-note',
      platformSpanId: 'recipe-write-private-platform',
      value,
    })
  }

  // Same pattern for the "+ New recipe → Paste a link" modal. No "default
  // note" to hide — the modal's static copy already covers it — but we
  // still flip the warning box on/off as the user types.
  window.checkImportLinkHint = (value) => {
    togglePrivatePlatformHint({
      hintId: 'import-link-private-hint',
      defaultId: null,
      platformSpanId: 'import-link-private-platform',
      value,
    })
  }

  window.setFoodMode = (mode) => {
    state.foodMode = mode
    // Fresh entry into Photo mode: reset the pipeline status so the
    // button shows 'Take or upload a photo first' rather than reusing
    // a stale 'ready-food' from a previous round.
    if (mode === 'photo') {
      state.foodPhotoStatus = state.foodPhotoStatus || 'idle'
    }
    ;['search', 'photo'].forEach(m => {
      const panel = document.getElementById(`food-panel-${m}`)
      const btn = document.getElementById(`food-btn-${m}`)
      if (panel) panel.style.display = m === mode ? '' : 'none'
      if (btn) btn.classList.toggle('active', m === mode)
    })
    if (mode === 'photo') wireFoodPhotoInput()
    window.updateAnalyzeBtn()
  }

  // ── Barcode scanner ─────────────────────────────────────────────
  window.startBarcodeScanner = async () => {
    const video = document.getElementById('barcode-video')
    const inner = document.getElementById('barcode-scanner-inner')
    const status = document.getElementById('barcode-status')

    // iOS Safari doesn't support BarcodeDetector or getUserMedia reliably
    // Best approach: use file input with camera capture, then decode with ZXing
    const fileInput = document.getElementById('barcode-file-input-camera')
    if (fileInput) {
      fileInput.click()
      return
    }

    // Desktop/Android: try native BarcodeDetector with live camera
    if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 } }
        })
        video.style.display = 'block'
        if (inner) inner.style.display = 'none'
        video.srcObject = stream
        if (status) status.textContent = 'Point camera at barcode...'
        const detector = new window.BarcodeDetector({
          formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','qr_code']
        })
        state._barcodeStream = stream
        state._barcodeInterval = setInterval(async () => {
          try {
            const codes = await detector.detect(video)
            if (codes.length > 0) {
              clearInterval(state._barcodeInterval)
              stream.getTracks().forEach(t => t.stop())
              video.style.display = 'none'
              if (inner) inner.style.display = 'block'
              if (status) status.textContent = `Found: ${codes[0].rawValue} — looking up...`
              await lookupBarcode(codes[0].rawValue)
            }
          } catch {}
        }, 300)
        return
      } catch {}
    }

    // Fallback: focus manual input
    if (status) status.textContent = ''
    document.getElementById('barcode-manual-input')?.focus()
  }

  // ── Barcode decode: free-first approach ────────────────────────
  // 1. Native BarcodeDetector (iOS 17+, Chrome Android) — zero cost
  // 2. ZXing WASM — free JS lib, handles large mobile photos
  // 3. Manual entry — never burn tokens on barcode reading

  async function decodeBarcodeFromFile(file) {
    const maxSize = 1600
    const drawToCanvas = async () => {
      try {
        const bitmap = await createImageBitmap(file)
        const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height))
        const w = Math.max(1, Math.round(bitmap.width * scale))
        const h = Math.max(1, Math.round(bitmap.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
        return canvas
      } catch (e1) {
        console.warn('[barcode] createImageBitmap failed, trying img element:', e1?.message || e1)
        const objUrl = URL.createObjectURL(file)
        try {
          const img = await new Promise((resolve, reject) => {
            const el = new Image()
            el.onload = () => resolve(el)
            el.onerror = () => reject(new Error('Image element load failed'))
            el.src = objUrl
          })
          const iw = img.naturalWidth || img.width
          const ih = img.naturalHeight || img.height
          const scale = Math.min(1, maxSize / Math.max(iw, ih))
          const w = Math.max(1, Math.round(iw * scale))
          const h = Math.max(1, Math.round(ih * scale))
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          canvas.getContext('2d').drawImage(img, 0, 0, w, h)
          return canvas
        } finally {
          URL.revokeObjectURL(objUrl)
        }
      }
    }

    // Center-crop a canvas to a fraction of its size (0.6 = keep middle 60%)
    const centerCrop = (source, fraction) => {
      const cropW = Math.round(source.width * fraction)
      const cropH = Math.round(source.height * fraction)
      const sx = Math.round((source.width - cropW) / 2)
      const sy = Math.round((source.height - cropH) / 2)
      // Scale up the cropped region so it's the same total size as the
      // original — gives ZXing / BarcodeDetector more pixels per bar.
      const outW = source.width
      const outH = source.height
      const canvas = document.createElement('canvas')
      canvas.width = outW
      canvas.height = outH
      canvas.getContext('2d').drawImage(source, sx, sy, cropW, cropH, 0, 0, outW, outH)
      return canvas
    }

    // Try all four orientations (0°, 90°, 180°, 270°) — some barcodes end
    // up sideways when taking photos freehand.
    const rotate = (source, degrees) => {
      const rad = degrees * Math.PI / 180
      const sin = Math.abs(Math.sin(rad))
      const cos = Math.abs(Math.cos(rad))
      const w = Math.round(source.width * cos + source.height * sin)
      const h = Math.round(source.width * sin + source.height * cos)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.translate(w / 2, h / 2)
      ctx.rotate(rad)
      ctx.drawImage(source, -source.width / 2, -source.height / 2)
      return canvas
    }

    // Attempt a decode with both detectors on a given canvas.
    const tryDecode = async (canvas, label) => {
      // 1. Native BarcodeDetector (free, fast — iOS 17+, Chrome Android)
      if ('BarcodeDetector' in window) {
        try {
          const detector = new window.BarcodeDetector({
            formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','qr_code']
          })
          const results = await detector.detect(canvas)
          if (results.length > 0) {
            console.log(`[barcode] BarcodeDetector hit on ${label}:`, results[0].rawValue)
            return results[0].rawValue
          }
        } catch (e) {
          console.warn(`[barcode] BarcodeDetector error on ${label}:`, e?.message || e)
        }
      }
      // 2. ZXing
      try {
        if (window._ZXing) {
          const result = await window._ZXing.decodeFromCanvas(canvas)
          const text = result?.getText?.() || result?.text
          if (text) {
            console.log(`[barcode] ZXing hit on ${label}:`, text)
            return text
          }
        }
      } catch (e) {
        if (e?.name !== 'NotFoundException' && !/not.*found/i.test(e?.message || '')) {
          console.warn(`[barcode] ZXing error on ${label}:`, e?.message || e)
        }
      }
      return null
    }

    // Load ZXing once upfront so it's ready for each pass
    try { await loadZXing() } catch (e) { console.warn('[barcode] ZXing load failed:', e?.message || e) }

    const canvas = await drawToCanvas()

    // Pass 1: full image, no rotation
    let result = await tryDecode(canvas, 'full')
    if (result) return result

    // Pass 2: 90° rotation (common when phone is held in portrait but the
    // barcode on the product is in landscape orientation)
    result = await tryDecode(rotate(canvas, 90), 'full-90°')
    if (result) return result

    // Pass 3: center-crop to 60% and scale back up (zoom on the center of
    // the frame — where users typically aim the barcode)
    const zoomed60 = centerCrop(canvas, 0.6)
    result = await tryDecode(zoomed60, 'center-60%')
    if (result) return result

    result = await tryDecode(rotate(zoomed60, 90), 'center-60%-90°')
    if (result) return result

    // Pass 4: even tighter crop (40%) — for tiny distant barcodes
    const zoomed40 = centerCrop(canvas, 0.4)
    result = await tryDecode(zoomed40, 'center-40%')
    if (result) return result

    result = await tryDecode(rotate(zoomed40, 90), 'center-40%-90°')
    if (result) return result

    return null
  }

  function loadZXing() {
    if (window._ZXing) return Promise.resolve()
    return new Promise((resolve, reject) => {
      // Use the browser-compatible ZXing build
      const s = document.createElement('script')
      s.src = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.4/umd/index.min.js'
      s.onload = async () => {
        try {
          window._ZXing = new window.ZXingBrowser.BrowserMultiFormatReader()
          resolve()
        } catch { reject() }
      }
      s.onerror = reject
      document.head.appendChild(s)
    })
  }

  // Remove the dead handleBarcodeImage (replaced by handleFoodPhoto).
  // The old one targeted #barcode-status which no longer exists.
  window.handleBarcodeImage = async (file) => {
    // Kept as a shim for any lingering callers — routes to the new handler
    if (file) handleFoodPhoto(file)
  }

  function loadQuagga() { return Promise.resolve() } // no longer used


  window.lookupBarcode = async (code) => {
    code = String(code).trim()
    if (!code) return
    // Status now lives in the unified photo panel. Fall back gracefully
    // if neither is present (e.g. programmatic call from elsewhere).
    const status = document.getElementById('foodphoto-status') || document.getElementById('barcode-status')
    if (status) status.textContent = `Looking up ${code}...`
    try {
      const res = await fetch(`/api/barcode?upc=${code}`)
      const data = await res.json()
      if (!data.found) {
        if (status) {
          status.textContent = 'Not in database — try "Describe" instead'
          status.style.color = 'var(--fat)'
        }
        showToast('Product not found — try describing it instead', 'error')
        return
      }
      if (status) {
        status.textContent = `✓ Found: ${data.name}`
        status.style.color = 'var(--accent)'
      }
      state.currentEntry = { ...data, ingredients: [] }
      showResult(state.currentEntry)
    } catch (err) {
      if (status) {
        status.textContent = 'Lookup failed'
        status.style.color = 'var(--red)'
      }
      showToast('Lookup failed: ' + err.message, 'error')
    }
  }

  // ── Unified Food > Photo input ─────────────────────────────────
  // One photo input. Auto-detects whether it's a barcode, a nutrition
  // label, or a meal photo, and routes accordingly.
  //
  // Pipeline at upload time:
  //  1. Downscale + show preview
  //  2. Try barcode decoders (native + ZXing, multi-pass). Fast, free.
  //  3. If barcode found: look up UPC immediately. Done.
  //  4. If no barcode: ask AI classifier "barcode/label/food?"
  //  5. Based on result, cache either:
  //       - label → analyzeNutritionLabel call in state._pendingFoodPhotoAction
  //       - food  → analyzePhoto call
  //     User taps main Analyze button to run it.
  //
  // The manual barcode entry input stays hidden by default, but reveals
  // itself as a fallback if the user wants to type a UPC manually.
  window.wireFoodPhotoInput = function() {
    const container = document.getElementById('food-panel-photo')
    if (!container || container._wired) return
    container._wired = true

    const fiCam = document.getElementById('foodphoto-camera')
    const fiLib = document.getElementById('foodphoto-library')
    const btnCam = document.getElementById('foodphoto-btn-camera')
    const btnLib = document.getElementById('foodphoto-btn-library')
    const manual = document.getElementById('barcode-manual-input')

    if (btnCam && fiCam) btnCam.addEventListener('click', () => { fiCam.value = ''; fiCam.click() })
    if (btnLib && fiLib) btnLib.addEventListener('click', () => { fiLib.value = ''; fiLib.click() })

    const onChange = (e) => {
      const file = e.target.files?.[0]
      if (file) handleFoodPhoto(file)
    }
    if (fiCam) fiCam.addEventListener('change', onChange)
    if (fiLib) fiLib.addEventListener('change', onChange)

    if (manual && !manual._wired) {
      manual._wired = true
      manual.addEventListener('keydown', e => {
        if (e.key === 'Enter') lookupBarcode(manual.value)
      })
    }
  }

  // Runs the whole "figure out what this photo is and do the right thing"
  // pipeline. Called from wireFoodPhotoInput's file-change handler.
  async function handleFoodPhoto(file) {
    const preview = document.getElementById('foodphoto-preview')
    const status = document.getElementById('foodphoto-status')
    const manual = document.getElementById('barcode-manual-input')

    const setStatus = (msg, color) => {
      if (!status) return
      status.textContent = msg
      status.style.color = color || 'var(--text3)'
    }
    // Set both the on-screen status line AND the state field that drives
    // the main Analyze button's label and disabled state.
    const setPhase = (phase, msg, color) => {
      state.foodPhotoStatus = phase
      if (msg) setStatus(msg, color)
      window.updateAnalyzeBtn()
    }

    // Reset any previously cached action so re-uploading a new photo
    // doesn't leave stale state around
    state._pendingFoodPhotoAction = null
    state.imageBase64 = null
    state.labelImageBase64 = null

    // Step 1: downscale and show preview immediately
    if (preview) preview.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">Processing photo…</div>`
    setPhase('processing', 'Processing photo...')

    let scaled
    try {
      scaled = await downscaleImage(file, { maxDim: 1600, quality: 0.9 })
    } catch (err) {
      if (preview) preview.innerHTML = `<div style="padding:20px;text-align:center;color:var(--red);font-size:13px">Couldn't read photo: ${esc(err?.message || err)}</div>`
      setPhase('idle', 'Failed to load photo', 'var(--red)')
      return
    }

    if (preview) preview.innerHTML = `<img src="${scaled.dataUrl}" style="max-height:220px;border-radius:var(--r);object-fit:contain" alt="photo">`

    // Step 2: try local barcode decoders (fast, zero cost)
    setPhase('processing', 'Checking for barcode...')
    let code = null
    try {
      code = await decodeBarcodeFromFile(file)
    } catch (err) {
      console.warn('[foodphoto] barcode decode threw:', err?.message || err)
    }

    if (code) {
      setPhase('processing', `Barcode found: ${code} — looking up...`, 'var(--accent)')
      if (manual) manual.value = code
      try {
        await lookupBarcode(code)
        // Result card is now showing; button becomes 'already done' so the
        // user isn't tempted to tap and re-run anything.
        setPhase('done-barcode')
      } catch (err) {
        setPhase('idle', `Lookup failed: ${err?.message || err}`, 'var(--red)')
      }
      return
    }

    // Step 3: AI classifier to decide what kind of photo this is
    setPhase('processing', 'No barcode — detecting what this is...')
    let kind = 'food'
    try {
      kind = await classifyFoodPhoto(scaled.base64)
    } catch (err) {
      console.warn('[foodphoto] classifier failed:', err?.message || err)
    }

    // Step 4: based on classification, cache the appropriate action.
    if (kind === 'barcode') {
      setPhase('processing', 'Reading barcode digits from image...')
      try {
        const aiCode = await readBarcodeFromImage(scaled.base64)
        if (aiCode) {
          setPhase('processing', `Read: ${aiCode} — looking up...`, 'var(--accent)')
          if (manual) manual.value = aiCode
          await lookupBarcode(aiCode)
          setPhase('done-barcode')
          return
        }
      } catch (err) {
        console.warn('[foodphoto] AI barcode read failed:', err?.message || err)
      }
      setPhase('idle', "Couldn't read barcode — type the number below", 'var(--fat)')
      if (manual) { manual.style.display = ''; manual.focus(); manual.style.borderColor = 'var(--accent)' }
      return
    }

    if (kind === 'label') {
      state.labelImageBase64 = scaled.base64
      state._pendingFoodPhotoAction = async () => {
        const btn = document.getElementById('analyze-btn')
        if (btn) btn.innerHTML = '<span class="analyzing-spinner"></span> Reading label...'
        return await analyzeNutritionLabel(state.labelImageBase64)
      }
      setPhase('ready-label', 'Nutrition label detected', 'var(--accent)')
      return
    }

    // Default: meal photo
    state.imageBase64 = scaled.base64
    state._pendingFoodPhotoAction = async (mealHint) => {
      const btn = document.getElementById('analyze-btn')
      if (btn) btn.innerHTML = '<span class="analyzing-spinner"></span> Analyzing photo...'
      return await analyzePhoto(state.imageBase64, mealHint)
    }
    setPhase('ready-food', 'Meal photo detected', 'var(--accent)')
  }

  // ── Recipe > Snap recipe (photograph a recipe card / cookbook page) ──
  // Saves the base64 to state.recipeImageBase64 so doAnalyze can pick it up.
  window.wireRecipeSnapInput = function() {
    const container = document.getElementById('recipe-panel-snap')
    if (!container || container._wired) return
    container._wired = true

    const fiCam = document.getElementById('recipe-snap-camera')
    const fiLib = document.getElementById('recipe-snap-library')
    const btnCam = document.getElementById('recipe-snap-btn-camera')
    const btnLib = document.getElementById('recipe-snap-btn-library')

    if (btnCam && fiCam) btnCam.addEventListener('click', () => { fiCam.value = ''; fiCam.click() })
    if (btnLib && fiLib) btnLib.addEventListener('click', () => { fiLib.value = ''; fiLib.click() })

    const onChange = (e) => {
      const file = e.target.files?.[0]
      if (!file) return
      const preview = document.getElementById('recipe-snap-preview')
      if (preview) preview.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px">Processing recipe photo…</div>`
      downscaleImage(file).then(({ base64, dataUrl, bytes }) => {
        state.recipeImageBase64 = base64
        if (preview) preview.innerHTML = `<img src="${dataUrl}" style="max-height:220px;border-radius:var(--r);object-fit:contain" alt="recipe">`
        console.log(`[recipe-snap] Downscaled to ${Math.round(bytes / 1024)}KB`)
      }).catch(err => {
        if (preview) preview.innerHTML = `<div style="padding:20px;text-align:center;color:var(--red);font-size:13px">Failed to load photo: ${err?.message || err}</div>`
      })
    }
    if (fiCam) fiCam.addEventListener('change', onChange)
    if (fiLib) fiLib.addEventListener('change', onChange)
  }

  window.toggleSidebar = () => {
    const sb = document.getElementById('sidebar')
    const ov = document.getElementById('sidebar-overlay')
    const isOpen = sb?.classList.contains('open')
    if (isOpen) {
      closeSidebar()
    } else {
      sb?.classList.add('open')
      ov?.classList.add('visible')
    }
  }
  window.closeSidebar = () => {
    const sb = document.getElementById('sidebar')
    const ov = document.getElementById('sidebar-overlay')
    if (!sb) return
    sb.classList.remove('open')
    // Force inline transform to match closed state — prevents transition fighting
    if (window.innerWidth <= 768) {
      sb.style.transform = 'translateX(-100%)'
      setTimeout(() => { if (sb) sb.style.transform = '' }, 300)
    }
    if (ov) { ov.classList.remove('visible') }
  }

  window.analyzeFoodHandler = async () => {
    const btn = document.getElementById('analyze-btn')
    if (!btn) return

    // Free tier: allow 20 analyses/month
    if (state.usage?.isFree) {
      const used = state.usage?.requests || 0
      const FREE_LIMIT = 20
      if (used >= FREE_LIMIT) {
        showToast(`Free plan limit (${FREE_LIMIT} analyses/month) reached. Upgrade for unlimited.`, 'error')
        return
      }
    }

    btn.disabled = true
    btn.innerHTML = '<span class="analyzing-spinner"></span> Analyzing...'
    try {
      const result = await doAnalyze()
      if (result) { state.currentEntry = result; showResult(result) }
    } catch (err) {
      showToast('Analysis failed: ' + err.message, 'error')
      logError(state.user?.id, err, { context: 'analyze_food', page: state.currentPage })
    }
    btn.disabled = false
    btn.textContent = 'Analyze with AI'
  }

  window.logCurrentEntryHandler = async () => {
    if (!state.currentEntry) return
    try {
      const e = state.currentEntry

      // Auto-save recipe with ingredients
      if (e.ingredients?.length) {
        getRecipeByName(state.user.id, e.name).then(existing => {
          if (!existing) {
            upsertRecipe(state.user.id, {
              name: e.name, description: e.description || '',
              servings: e.servings || 1, calories: e.calories,
              protein: e.protein, carbs: e.carbs, fat: e.fat,
              fiber: e.fiber || 0, sugar: e.sugar || 0,
              ingredients: e.ingredients, source: 'ai_photo',
              confidence: e.confidence, ai_notes: e.notes || ''
            }).then(recipe => { state.recipes.unshift(recipe) }).catch(() => {})
          }
        }).catch(() => {})
      }

      // Auto-save to food_items and get the id to link in the log
      const food_item_id = e.ingredients?.length ? null
        : await autoSaveFoodItem(state.user.id, e, state.foodItems).then(id => {
            if (id) {
              // Add to local state if new
              const isNew = !state.foodItems.find(f => f.id === id)
              if (isNew) getFoodItems(state.user.id).then(items => { state.foodItems = items }).catch(() => {})
            }
            return id
          }).catch(() => null)

      const entry = await addMealEntry(state.user.id, { ...e, food_item_id, meal_type: getMealTypeFromTime(new Date()) })
      state.log.unshift(entry)

      state.currentEntry = null
      updateStats()
      refreshTodayLog()
      const btn = document.getElementById('log-entry-btn')
      if (btn) { btn.textContent = '✓ Logged!'; btn.className = 'log-btn logged' }
      showToast(entry.name + ' logged!', 'success')
    } catch (err) { showToast('Failed to log: ' + err.message, 'error') }
  }

  window.clearTodayLog = async () => {
    const today = new Date().toDateString()
    const todayEntries = state.log.filter(e => new Date(e.logged_at || e.timestamp).toDateString() === today)
    try {
      await Promise.all(todayEntries.map(e => deleteMealEntry(state.user.id, e.id)))
      state.log = state.log.filter(e => new Date(e.logged_at || e.timestamp).toDateString() !== today)
      renderPage()
      showToast("Today's log cleared", '')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  // ── Goals & Body Metrics ───────────────────────────────────────
  window.previewGoalsCalc = () => {
    const m = readBodyMetricsForm()
    const bmr = calcBMR(m)
    const tdee = calcTDEE(bmr, m.activity_level)
    const targets = calcTargetMacros(m, tdee)
    const weeks = m.weight_kg && m.goal_weight_kg ? (() => {
      const diff = Math.abs(m.weight_kg - m.goal_weight_kg)
      const pace = { slow: 0.25, moderate: 0.4, aggressive: 0.6 }
      return Math.ceil(diff / (pace[m.pace] || 0.4))
    })() : null

    // Update BMR/TDEE display
    const bmrEl = document.getElementById('calc-bmr')
    const tdeeEl = document.getElementById('calc-tdee')
    const noteEl = document.getElementById('calc-formula-note')
    if (bmrEl) bmrEl.textContent = bmr || '—'
    if (tdeeEl) tdeeEl.textContent = tdee || '—'
    if (noteEl) noteEl.textContent = bmr
      ? (m.body_fat_pct
          ? '✓ Katch-McArdle (body fat % known — most accurate)'
          : '⚠ Mifflin-St Jeor estimate — add body fat % for best accuracy')
      : ''

    // Update target macros display
    const targEl = document.getElementById('calc-targets')
    if (targEl) {
      if (targets) {
        targEl.innerHTML = `
          <div style="background:var(--bg3);border-radius:var(--r);padding:14px;margin-bottom:12px">
            <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px;display:flex;align-items:center;gap:6px">
              Calculated daily targets
              ${weeks ? `<span style="font-weight:400;color:var(--text3)">~${weeks} weeks to goal</span>` : ''}
              <button onclick="showMethodologyModal()" title="How are these calculated?"
                style="background:none;border:1px solid var(--border2);border-radius:50%;width:18px;height:18px;cursor:pointer;font-size:11px;color:var(--text3);display:inline-flex;align-items:center;justify-content:center;padding:0;font-family:inherit;flex-shrink:0;margin-left:auto">i</button>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center">
              <div><div style="font-size:18px;font-weight:700;color:var(--accent)">${targets.calories}</div><div style="font-size:10px;color:var(--text3)">kcal</div></div>
              <div><div style="font-size:18px;font-weight:700;color:var(--protein)">${targets.protein}g</div><div style="font-size:10px;color:var(--text3)">protein</div></div>
              <div><div style="font-size:18px;font-weight:700;color:var(--carbs)">${targets.carbs}g</div><div style="font-size:10px;color:var(--text3)">carbs</div></div>
              <div><div style="font-size:18px;font-weight:700;color:var(--fat)">${targets.fat}g</div><div style="font-size:10px;color:var(--text3)">fat</div></div>
            </div>
            <button onclick="applyCalculatedTargets(${targets.calories},${targets.protein},${targets.carbs},${targets.fat})"
              style="width:100%;margin-top:10px;background:color-mix(in srgb, var(--accent) 10%, transparent);color:var(--accent);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);border-radius:var(--r);padding:8px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer">
              ↓ Use these targets (fills fields below)
            </button>
          </div>`
      } else {
        targEl.innerHTML = `<div style="padding:12px;background:var(--bg3);border-radius:var(--r);font-size:13px;color:var(--text3);margin-bottom:12px">Fill in body metrics above to calculate targets.</div>`
      }
    }
  }

  window.setUnits = (units) => {
    state.units = units
    localStorage.setItem('macrolens_units', units)
    renderPage()
  }

  // Goals page — toggle Body metrics or Goal settings collapse. Default
  // open/closed is computed from data (open if empty, closed if filled),
  // so on first toggle we have to resolve current visible state to know
  // which way to flip.
  window.toggleGoalsSection = (key) => {
    const lsKey = key === 'bm' ? 'macrolens_goals_bm_open' : 'macrolens_goals_gs_open'
    const saved = (() => { try { return localStorage.getItem(lsKey) } catch { return null } })()
    let isOpen
    if (saved === null) {
      const m = state.bodyMetrics || {}
      isOpen = key === 'bm' ? !m.weight_kg : !state.goals?.calories
    } else {
      isOpen = saved === '1'
    }
    try { localStorage.setItem(lsKey, isOpen ? '0' : '1') } catch {}
    renderPage()
  }

  // Theme picker. 'light'/'dark' persist an explicit choice; 'system' clears
  // the saved value so the inline boot script falls back to prefers-color-scheme
  // on the next load. We resolve and apply the new theme immediately so the
  // change is visible without a reload.
  window.setTheme = (choice) => {
    if (choice === 'system') {
      try { localStorage.removeItem('macrolens_theme') } catch {}
    } else if (choice === 'light' || choice === 'dark') {
      try { localStorage.setItem('macrolens_theme', choice) } catch {}
    }
    const sysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    const resolved = choice === 'system' ? (sysLight ? 'light' : 'dark') : choice
    document.documentElement.setAttribute('data-theme', resolved)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.content = resolved === 'light' ? '#fbfaf6' : '#15130f'
    renderPage()
  }

  function readBodyMetricsForm() {
    const isImperial = state.units === 'imperial'
    const rawWeight = parseFloat(document.getElementById('bm-weight')?.value) || null
    const rawMuscle = parseFloat(document.getElementById('bm-muscle')?.value) || null
    const rawGoalWeight = parseFloat(document.getElementById('bm-goal-weight')?.value) || null

    let height_cm = null
    if (isImperial) {
      const ft = parseFloat(document.getElementById('bm-ft')?.value) || 0
      const inches = parseFloat(document.getElementById('bm-in')?.value) || 0
      height_cm = ft || inches ? +((ft * 12 + inches) * 2.54).toFixed(1) : null
    } else {
      height_cm = parseFloat(document.getElementById('bm-height')?.value) || null
    }

    return {
      sex: document.getElementById('bm-sex')?.value || 'male',
      age: parseFloat(document.getElementById('bm-age')?.value) || null,
      height_cm,
      weight_kg: isImperial && rawWeight ? +(rawWeight / 2.20462).toFixed(2) : rawWeight,
      body_fat_pct: parseFloat(document.getElementById('bm-bf')?.value) || null,
      muscle_mass_kg: isImperial && rawMuscle ? +(rawMuscle / 2.20462).toFixed(2) : rawMuscle,
      activity_level: document.getElementById('bm-activity')?.value || 'moderate',
      goal_weight_kg: isImperial && rawGoalWeight ? +(rawGoalWeight / 2.20462).toFixed(2) : rawGoalWeight,
      goal_body_fat_pct: parseFloat(document.getElementById('bm-goal-bf')?.value) || null,
      weight_goal: document.getElementById('bm-direction')?.value || 'lose',
      pace: document.getElementById('bm-pace')?.value || 'moderate',
    }
  }

  window.applyCalculatedTargets = (cal, protein, carbs, fat) => {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v }
    setVal('goal-cal', cal); setVal('goal-p', protein)
    setVal('goal-c', carbs); setVal('goal-f', fat)
    showToast('Targets applied — tap Save to confirm', 'success')
  }

  // ──────────────────────────────────────────────────────────────────────
  // Unified share helper. Every "share a link" action in the app goes
  // through this. Behavior:
  //   1. If navigator.share is available (iOS, most modern mobile), open
  //      the native share sheet. Single tap → user picks Messages, Mail,
  //      AirDrop, Copy, etc from the system UI.
  //   2. If the user cancels the sheet (AbortError), silently do nothing.
  //   3. If navigator.share is missing (some desktop browsers, older
  //      WebViews), fall back to clipboard + toast.
  //   4. If clipboard ALSO fails (rare, usually perms), surface the URL
  //      in a toast so the user can copy it manually.
  //
  // We deliberately pass ONLY { title, url } to navigator.share. Adding
  // a `text` field causes the iOS share sheet's Copy action to copy the
  // text instead of the URL — which breaks the single most common use
  // case ("send me the link").
  async function shareLink({ title, url }) {
    if (navigator.share) {
      try {
        await navigator.share({ title, url })
        return
      } catch (err) {
        if (err?.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      showToast('Link copied!', 'success')
    } catch {
      showToast('Copy: ' + url, '')
    }
  }
  window._shareLink = shareLink

  // Single share entry point for recipes. Ensures a share token exists
  // (creating one on first call), then fires the native share sheet.
  // The previous multi-section modal ("public link" vs "send to user"
  // vs "regenerate" vs "stop sharing") was confusing and the in-app
  // send-to-user path was broken, so we deleted the whole modal and
  // collapsed everything to a one-tap action.
  //
  // Both window.shareRecipe and window.openShareModal resolve to this —
  // the two names exist because different card templates wire to
  // different handlers, and I'd rather keep them as aliases than hunt
  // down every onclick="openShareModal(...)" in the HTML.
  async function shareRecipeByLink(recipeId) {
    const recipe = state.recipes.find(r => r.id === recipeId)
    if (!recipe) return
    const btn = document.getElementById('share-btn-' + recipeId)

    // Make sure the recipe has a share_token. First-time sharers get one
    // generated on the fly.
    let token = recipe.share_token
    if (!recipe.is_shared || !token) {
      try {
        if (btn) { btn.textContent = '⏳'; btn.disabled = true }
        token = await enableRecipeSharing(state.user.id, recipeId)
        recipe.is_shared = true
        recipe.share_token = token
      } catch (err) {
        showToast('Error: ' + err.message, 'error')
        if (btn) { btn.textContent = '🔗 Share'; btn.disabled = false }
        return
      }
    }

    // Visual feedback on the card button
    if (btn) {
      btn.textContent = '🔗 Shared'
      btn.style.background = 'rgba(76,175,130,0.15)'
      btn.style.color = 'var(--protein)'
      btn.style.borderColor = 'var(--protein)'
      btn.disabled = false
    }

    await shareLink({
      title: recipe.name || 'Recipe',
      url: `${window.location.origin}/api/recipe/${token}`,
    })
  }
  window.shareRecipe = shareRecipeByLink
  window.openShareModal = shareRecipeByLink

  // Kept as thin aliases so any inline onclick="..." from older templates
  // keeps working — all three do the same thing now.
  window.nativeShareRecipe = () => {
    if (state.sharingRecipeId) return shareRecipeByLink(state.sharingRecipeId)
  }
  window.copyShareLink = window.nativeShareRecipe

  window.showMethodologyModal = () => {
    document.getElementById('methodology-modal')?.classList.add('open')
  }
  window.closeMethodologyModal = () => {
    document.getElementById('methodology-modal')?.classList.remove('open')
  }
  document.getElementById('methodology-modal')?.addEventListener('click', e => {
    if (e.target.id === 'methodology-modal') closeMethodologyModal()
  })

  window.stopSharingRecipe = async (recipeId) => {
    try {
      await disableRecipeSharing(state.user.id, recipeId)
      const recipe = state.recipes.find(r => r.id === recipeId)
      if (recipe) { recipe.is_shared = false }
      showToast('Recipe is no longer shared', '')
      const btn = document.getElementById('share-btn-' + recipeId)
      if (btn) {
        btn.textContent = '🔗 Share'
        btn.style.background = 'var(--bg3)'
        btn.style.color = 'var(--text3)'
        btn.style.borderColor = 'var(--border2)'
      }
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.toggleCheckinDetails = () => {
    const panel = document.getElementById('ci-details-panel')
    const arrow = document.getElementById('ci-details-arrow')
    const toggle = document.getElementById('ci-details-toggle')
    if (!panel) return
    const isOpen = panel.style.display !== 'none'
    panel.style.display = isOpen ? 'none' : 'block'
    if (arrow) arrow.textContent = isOpen ? '▸' : '▾'
    if (toggle) toggle.style.color = isOpen ? 'var(--text3)' : 'var(--accent)'
  }

  window.openCheckinModal = () => {
    state.pendingCheckinScan = null
    const isImperial = state.units === 'imperial'
    const today = new Date().toISOString().split('T')[0]
    document.getElementById('ci-date').value = today
    document.getElementById('ci-scan-date').value = today
    const wLabel = document.getElementById('ci-weight-label')
    if (wLabel) wLabel.textContent = isImperial ? 'Weight (lbs)' : 'Weight (kg)'
    const mLabel = document.getElementById('ci-muscle-label')
    if (mLabel) mLabel.innerHTML = `${isImperial ? 'Muscle mass (lbs)' : 'Muscle mass (kg)'} <span style="font-weight:400;color:var(--text3);font-size:10px">(optional)</span>`
    const bm = state.bodyMetrics
    document.getElementById('ci-weight').value = bm?.weight_kg
      ? (isImperial ? +(bm.weight_kg * 2.20462).toFixed(1) : bm.weight_kg) : ''
    document.getElementById('ci-bf').value = bm?.body_fat_pct || ''
    document.getElementById('ci-muscle').value = bm?.muscle_mass_kg
      ? (isImperial ? +(bm.muscle_mass_kg * 2.20462).toFixed(1) : bm.muscle_mass_kg) : ''
    document.getElementById('ci-notes').value = ''
    document.getElementById('scan-status').textContent = ''
    document.getElementById('scan-upload-inner').innerHTML = '<div style="font-size:24px;margin-bottom:4px">📄</div><div style="font-size:13px;color:var(--text2)">Upload scan (PDF or image)</div><div style="font-size:11px;color:var(--text3);margin-top:2px">AI will extract your metrics automatically</div>'
    // Collapse details panel on open
    const panel = document.getElementById('ci-details-panel')
    const arrow = document.getElementById('ci-details-arrow')
    if (panel) panel.style.display = 'none'
    if (arrow) arrow.textContent = '▸'
    document.getElementById('checkin-modal').classList.add('open')
  }

  window.closeCheckinModal = () => {
    document.getElementById('checkin-modal').classList.remove('open')
    state.pendingCheckinScan = null
  }

  window.handleScanUpload = async (file) => {
    if (!file) return
    const status = document.getElementById('scan-status')
    const inner = document.getElementById('scan-upload-inner')
    if (status) status.textContent = 'Reading scan...'
    if (inner) inner.innerHTML = '<div style="font-size:24px">⏳</div><div style="font-size:13px;color:var(--text2)">Extracting metrics...</div>'

    // Auto-expand details panel when scan is uploaded
    const panel = document.getElementById('ci-details-panel')
    const arrow = document.getElementById('ci-details-arrow')
    if (panel) panel.style.display = 'block'
    if (arrow) arrow.textContent = '▾'

    const isImperial = state.units === 'imperial'
    const resetUpload = (msg) => {
      if (inner) inner.innerHTML = '<div style="font-size:24px">📄</div><div style="font-size:13px;color:var(--text2)">Upload scan (PDF or image)</div><div style="font-size:11px;color:var(--text3);margin-top:2px">AI will extract your metrics automatically</div>'
      if (status) status.textContent = msg
      state.pendingCheckinScan = { file, extracted: null }
    }

    try {
      // Read file
      const dataUrl = await new Promise((res, rej) => {
        const reader = new FileReader()
        reader.onload = e => res(e.target.result)
        reader.onerror = rej
        reader.readAsDataURL(file)
      })
      const b64 = dataUrl.split(',')[1]
      // Detect media type — iOS often gives empty type or heic
      // Claude supports: image/jpeg, image/png, image/gif, image/webp, application/pdf
      const rawType = file.type || ''
      let mediaType = 'image/jpeg' // safe default
      if (rawType === 'application/pdf') mediaType = 'application/pdf'
      else if (rawType === 'image/png') mediaType = 'image/png'
      else if (rawType === 'image/webp') mediaType = 'image/webp'
      else if (rawType === 'image/gif') mediaType = 'image/gif'
      // heic/heif → jpeg (Claude doesn't support heic, but FileReader converts it)

      // Resize image to max 1500px — Claude has a 5MB limit and iPhone photos are 5-8MB
      let finalB64 = b64
      if (mediaType !== 'application/pdf') {
        try {
          finalB64 = await new Promise((res, rej) => {
            const img = new Image()
            img.onload = () => {
              const MAX = 1500
              let { width: w, height: h } = img
              if (w > MAX || h > MAX) {
                const scale = MAX / Math.max(w, h)
                w = Math.round(w * scale)
                h = Math.round(h * scale)
              }
              const canvas = document.createElement('canvas')
              canvas.width = w; canvas.height = h
              canvas.getContext('2d').drawImage(img, 0, 0, w, h)
              // Export as jpeg quality 85
              const resized = canvas.toDataURL('image/jpeg', 0.85)
              res(resized.split(',')[1])
            }
            img.onerror = () => res(b64) // fall back to original on error
            img.src = dataUrl
          })
          mediaType = 'image/jpeg' // after resize always jpeg
        } catch { finalB64 = b64 }
      }

      // Extract with 30s timeout
      let extracted = null
      try {
        extracted = await Promise.race([
          extractBodyScan(finalB64, mediaType),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
        ])
      } catch (aiErr) {
        // AI failed or timed out — keep file attached but let user fill manually
        console.warn('Scan extraction failed:', aiErr.message)
        state.pendingCheckinScan = { file, extracted: null }
        if (inner) inner.innerHTML = '<div style="font-size:20px">📄</div><div style="font-size:12px;color:var(--protein)">' + esc(file.name) + '</div><div style="font-size:11px;color:var(--text3);margin-top:2px">File attached — fill in values above manually</div>'
        if (status) status.textContent = 'Auto-extract failed — enter values manually then Save'
        return
      }

      state.pendingCheckinScan = { file, extracted }

      // Auto-fill form — convert units if imperial
      const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val }
      if (extracted) {
        const w = extracted.weight_kg
        const mu = extracted.muscle_mass_kg
        set('ci-weight', isImperial && w ? +(w * 2.20462).toFixed(1) : w)
        set('ci-bf', extracted.body_fat_pct)
        set('ci-muscle', isImperial && mu ? +(mu * 2.20462).toFixed(1) : mu)
        if (extracted.scan_date) {
          set('ci-scan-date', extracted.scan_date)
          set('ci-date', extracted.scan_date) // also set checkin date to scan date
        }
      }

      if (inner) inner.innerHTML = '<div style="font-size:24px">✓</div><div style="font-size:13px;color:var(--protein)">' + esc(file.name) + '</div>'
      if (status) {
        const parts = []
        if (extracted?.weight_kg) parts.push(isImperial ? +(extracted.weight_kg*2.20462).toFixed(1)+'lbs' : extracted.weight_kg+'kg')
        if (extracted?.body_fat_pct) parts.push(extracted.body_fat_pct+'% BF')
        status.textContent = parts.length ? 'Extracted: ' + parts.join(', ') : 'File ready — fill in metrics above'
      }
    } catch (err) {
      resetUpload('Failed to read file — try again')
    }
  }

  window.saveCheckinHandler = async () => {
    const btn = document.querySelector('#checkin-modal .btn-save')
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...' }
    try {
      const isImperial = state.units === 'imperial'
      const rawWeight = parseFloat(document.getElementById('ci-weight')?.value) || null
      const rawMuscle = parseFloat(document.getElementById('ci-muscle')?.value) || null
      const weight = rawWeight ? (isImperial ? +(rawWeight / 2.20462).toFixed(2) : rawWeight) : null
      const bf = parseFloat(document.getElementById('ci-bf')?.value) || null
      const muscle = rawMuscle ? (isImperial ? +(rawMuscle / 2.20462).toFixed(2) : rawMuscle) : null
      const date = document.getElementById('ci-date')?.value || new Date().toISOString().split('T')[0]
      const scanDate = document.getElementById('ci-scan-date')?.value || date
      const notes = document.getElementById('ci-notes')?.value?.trim() || ''

      // Upload scan file if present — non-blocking, never fails the checkin
      let scanPath = null
      if (state.pendingCheckinScan?.file) {
        try {
          scanPath = await uploadScanFile(state.user.id, state.pendingCheckinScan.file)
        } catch (e) {
          console.warn('Scan upload failed (storage not configured?):', e.message)
          // Continue saving checkin without the file — data is what matters
        }
      }

      // Always save the checkin regardless of file upload outcome
      const checkin = await saveCheckin(state.user.id, {
        checked_in_at: date,
        scan_date: scanDate,
        weight_kg: weight,
        body_fat_pct: bf,
        muscle_mass_kg: muscle,
        notes,
        scan_file_path: scanPath,
        scan_extracted: state.pendingCheckinScan?.extracted || null,
        // Map all extracted scan fields directly to columns
        ...(state.pendingCheckinScan?.extracted ? (() => {
          const e = state.pendingCheckinScan.extracted
          return {
            scan_type: e.scan_type || null,
            scan_date: e.scan_date || null,
            lean_body_mass_kg: e.lean_body_mass_kg || null,
            body_fat_mass_kg: e.body_fat_mass_kg || null,
            bone_mass_kg: e.bone_mass_kg || null,
            total_body_water_kg: e.total_body_water_kg || null,
            intracellular_water_kg: e.intracellular_water_kg || null,
            extracellular_water_kg: e.extracellular_water_kg || null,
            ecw_tbw_ratio: e.ecw_tbw_ratio || null,
            protein_kg: e.protein_kg || null,
            minerals_kg: e.minerals_kg || null,
            bmr: e.bmr || null,
            bmi: e.bmi || null,
            inbody_score: e.inbody_score || null,
            visceral_fat_level: e.visceral_fat_level || null,
            body_cell_mass_kg: e.body_cell_mass_kg || null,
            smi: e.smi || null,
            seg_lean_left_arm_kg: e.seg_lean_left_arm_kg || null,
            seg_lean_right_arm_kg: e.seg_lean_right_arm_kg || null,
            seg_lean_trunk_kg: e.seg_lean_trunk_kg || null,
            seg_lean_left_leg_kg: e.seg_lean_left_leg_kg || null,
            seg_lean_right_leg_kg: e.seg_lean_right_leg_kg || null,
            seg_lean_left_arm_pct: e.seg_lean_left_arm_pct || null,
            seg_lean_right_arm_pct: e.seg_lean_right_arm_pct || null,
            seg_lean_trunk_pct: e.seg_lean_trunk_pct || null,
            seg_lean_left_leg_pct: e.seg_lean_left_leg_pct || null,
            seg_lean_right_leg_pct: e.seg_lean_right_leg_pct || null,
            bone_mineral_density: e.bone_mineral_density || null,
            t_score: e.t_score || null,
            z_score: e.z_score || null,
            android_fat_pct: e.android_fat_pct || null,
            gynoid_fat_pct: e.gynoid_fat_pct || null,
            android_gynoid_ratio: e.android_gynoid_ratio || null,
            vat_area_cm2: e.vat_area_cm2 || null,
          }
        })() : {})
      })
      state.checkins.unshift(checkin)

      // Update body metrics with latest weight
      if (weight || bf || muscle) {
        const updates = {}
        if (weight) updates.weight_kg = weight
        if (bf) updates.body_fat_pct = bf
        if (muscle) updates.muscle_mass_kg = muscle
        const updated = await saveBodyMetrics(state.user.id, { ...state.bodyMetrics, ...updates })
        state.bodyMetrics = updated
      }

      closeCheckinModal()
      renderPage()
      showToast('Check-in saved!', 'success')
    } catch (err) {
      showToast('Error: ' + err.message, 'error')
      if (btn) { btn.disabled = false; btn.textContent = 'Save check-in' }
    }
  }

  window.deleteCheckinHandler = async (id) => {
    const c = (state.checkins || []).find(x => String(x.id) === String(id))
    const dateLabel = c?.scan_date || c?.checked_in_at
    const label = dateLabel
      ? new Date(dateLabel + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      : 'this check-in'
    if (!confirm(`Delete check-in from ${label}? This can't be undone.`)) return
    try {
      await deleteCheckin(state.user.id, id)
      state.checkins = (state.checkins || []).filter(x => String(x.id) !== String(id))
      renderPage()
      showToast('Check-in deleted', 'success')
    } catch (err) {
      showToast('Error: ' + err.message, 'error')
    }
  }

  // Filter recipes live without full re-render — keeps focus in the search
  // input so the user can keep typing without tapping back into it.
  window.filterRecipesList = (value) => {
    state.recipeSearch = value
    const q = (value || '').trim().toLowerCase()
    const grid = document.getElementById('recipe-grid')
    if (!grid) return
    const activeTag = state.recipeActiveTag || ''
    const scoped = activeTag
      ? (activeTag === '__untagged__'
          ? state.recipes.filter(r => !(Array.isArray(r.tags) && r.tags.length))
          : state.recipes.filter(r => Array.isArray(r.tags) && r.tags.some(t => t && t.toLowerCase() === activeTag.toLowerCase())))
      : state.recipes
    const recipes = searchRecipes(scoped, q)
    if (!recipes.length) {
      grid.innerHTML = `<div class="log-card" style="grid-column:1/-1"><div class="log-empty" style="padding:40px">No recipes match "${esc(q)}"${activeTag ? ` in <strong style="color:var(--text)">${esc(activeTag === '__untagged__' ? 'Untagged' : activeTag)}</strong>` : ''}.</div></div>`
    } else {
      grid.innerHTML = recipes.map(r => renderRecipeCard(r)).join('')
    }
  }

  // Change the active tag filter. Re-renders the page so the pill bar
  // reflects the new selection and the grid updates at the same time.
  window.setRecipeTag = (tag) => {
    state.recipeActiveTag = tag === state.recipeActiveTag ? '' : tag
    renderPage()
  }

  // Switch the analytics lookback window (7 / 30 / 90 / 365 days)
  window.setAnalyticsRange = (days) => {
    state.analyticsRange = days
    renderPage()
  }

  // Inside the recipe editor: toggle a tag on or off. Operates on
  // window._editingTags (a Set of lowercase keys) and re-renders just
  // the chip row to reflect the change.
  window.toggleRecipeTag = (tag) => {
    if (!window._editingTags) window._editingTags = new Set()
    if (!window._editingTagsDisplay) window._editingTagsDisplay = {}
    const key = tag.toLowerCase()
    if (window._editingTags.has(key)) {
      window._editingTags.delete(key)
    } else {
      window._editingTags.add(key)
      window._editingTagsDisplay[key] = tag
    }
    rerenderRecipeTagChips()
  }

  // Add a custom tag from the text input. Dedupes case-insensitively
  // and also appends the chip so it appears as toggleable.
  window.addCustomRecipeTag = () => {
    const input = document.getElementById('recipe-tag-input')
    if (!input) return
    const raw = input.value.trim()
    if (!raw) return
    // Strip a leading # if the user habit-typed one
    const clean = raw.replace(/^#+/, '').trim()
    if (!clean) return
    if (!window._editingTags) window._editingTags = new Set()
    if (!window._editingTagsDisplay) window._editingTagsDisplay = {}
    const key = clean.toLowerCase()
    window._editingTags.add(key)
    window._editingTagsDisplay[key] = clean
    input.value = ''
    rerenderRecipeTagChips()
  }

  // Helper for the above — rebuild the chips row only, not the whole
  // modal, so the input focus is preserved.
  function rerenderRecipeTagChips() {
    const row = document.getElementById('recipe-tag-chips')
    if (!row) return
    // Gather visible presets + staged customs + all existing tags.
    const visiblePresets = getVisiblePresets()
    const knownTags = new Set(visiblePresets.map(t => t.toLowerCase()))
    const displayMap = {}
    visiblePresets.forEach(t => { displayMap[t.toLowerCase()] = t })
    for (const t of (state._stagedCustomTags || [])) {
      const k = String(t).toLowerCase()
      if (!displayMap[k]) displayMap[k] = t
      knownTags.add(k)
    }
    for (const r of (state.recipes || [])) {
      if (!Array.isArray(r.tags)) continue
      for (const t of r.tags) {
        if (!t) continue
        const key = t.toLowerCase()
        if (!displayMap[key]) displayMap[key] = t
        knownTags.add(key)
      }
    }
    for (const key of (window._editingTags || [])) {
      if (!displayMap[key]) displayMap[key] = (window._editingTagsDisplay?.[key]) || key
      knownTags.add(key)
    }
    const suggestions = Array.from(knownTags).map(k => displayMap[k])
    row.innerHTML = suggestions.map(t => {
      const isOn = window._editingTags.has(t.toLowerCase())
      return `<button type="button" data-tag="${esc(t)}" onclick="toggleRecipeTag('${t.replace(/'/g,"\\'")}')"
        style="font-size:12px;padding:4px 12px;border-radius:999px;cursor:pointer;font-family:inherit;border:1px solid ${isOn ? 'var(--carbs)' : 'var(--border2)'};background:${isOn ? 'rgba(122,180,232,0.18)' : 'var(--bg3)'};color:${isOn ? 'var(--carbs)' : 'var(--text2)'};transition:all 0.15s">${isOn ? '✓ ' : ''}${esc(t)}</button>`
    }).join('')
  }

  // Foods search — same pattern. Preserves focus while typing.
  window.filterFoodsList = (value) => {
    state.foodSearch = value
    const q = (value || '').trim().toLowerCase()
    const grid = document.getElementById('foods-grid')
    if (!grid) return
    const foods = searchFoods(state.foodItems, q)
    if (!foods.length) {
      grid.innerHTML = `<div class="log-card" style="grid-column:1/-1"><div class="log-empty" style="padding:40px">No foods match "${esc(q)}".</div></div>`
    } else {
      grid.innerHTML = foods.map(f => renderFoodCard(f)).join('')
    }
  }

  // Same pattern for providers page
  window.filterProvidersList = (value) => {
    state.providerSearch = value
    renderProvidersPage(document.getElementById('main-content'))
    // Restore focus
    setTimeout(() => {
      const input = document.getElementById('provider-search')
      if (input && document.activeElement !== input) {
        input.focus()
        const len = input.value.length
        input.setSelectionRange(len, len)
      }
    }, 0)
  }

  // Tab switcher for the Providers page. Only wired up when the user has
  // a provider channel (state.usage.isProvider) — free/premium users
  // don't see the tabs at all. State lives on the global state object so
  // it survives re-renders; defaults to 'browse' because a provider
  // opening the Providers page usually wants to see peers.
  window.switchProvidersTab = (tab) => {
    state.providersTab = tab
    renderProvidersPage(document.getElementById('main-content'))
  }

  document.getElementById('broadcast-modal')?.addEventListener('click', e => {
    if (e.target.id === 'broadcast-modal') closeBroadcastModal()
  })
  document.getElementById('checkin-modal')?.addEventListener('click', e => {
    if (e.target.id === 'checkin-modal') closeCheckinModal()
  })

  window.saveBodyMetricsOnly = async () => {
    try {
      const bm = readBodyMetricsForm()
      const bmr = calcBMR(bm)
      const tdee = calcTDEE(bmr, bm.activity_level)
      const updated = await saveBodyMetrics(state.user.id, { ...state.bodyMetrics, ...bm, bmr, tdee })
      state.bodyMetrics = updated
      showToast('Body metrics saved!', 'success')
      renderPage()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.saveGoalsHandler = async () => {
    const cal   = parseInt(document.getElementById('goal-cal')?.value) || 2000
    const pro   = parseInt(document.getElementById('goal-p')?.value)   || 150
    const carb  = parseInt(document.getElementById('goal-c')?.value)   || 200
    const fat   = parseInt(document.getElementById('goal-f')?.value)   || 65

    // ── Nutrition safety checks ──────────────────────────────────────────────
    const impliedCal = pro * 4 + carb * 4 + fat * 9
    const calDiff = Math.abs(cal - impliedCal)
    const warnings = []

    // Calculate personalized minimums from BMR if we have body metrics
    const m = state.bodyMetrics || {}
    const bmr = calcBMR(m)  // already accounts for weight/height/sex/age/BF%
    const safeFloor = bmr ? Math.round(bmr * 0.85) : 1200  // 85% of BMR is the clinical minimum
    const absoluteFloor = 1000  // below this is dangerous for anyone

    if (cal < absoluteFloor) {
      warnings.push(`⚠️ ${cal} kcal is dangerously low. No adult should eat fewer than ${absoluteFloor} kcal without direct medical supervision.`)
    } else if (bmr && cal < safeFloor) {
      const deficit = Math.round(bmr - cal)
      warnings.push(`⚠️ ${cal} kcal is below your estimated BMR of ${Math.round(bmr)} kcal — the calories your body burns at complete rest. Eating ${deficit} kcal less than your BMR can cause muscle loss, fatigue, and metabolic slowdown.${m.weight_kg ? ` Based on your current weight and stats.` : ''}`)
    } else if (!bmr && cal < 1200) {
      warnings.push(`⚠️ ${cal} kcal is below the general safe minimum. Add your body metrics to get a personalized recommendation.`)
    }

    if (pro < 50) {
      warnings.push(`⚠️ ${pro}g protein is very low and may cause muscle loss. Most adults need at least 50–60g daily.`)
    }
    if (m.weight_kg && pro < m.weight_kg * 0.8) {
      const minPro = Math.round(m.weight_kg * 0.8)
      warnings.push(`⚠️ ${pro}g protein is below the recommended minimum of ${minPro}g for your weight (0.8g per kg body weight).`)
    }
    if (pro > 400) {
      warnings.push(`⚠️ ${pro}g protein is unusually high. Most research supports up to 2.2g/kg body weight.`)
    }
    if (calDiff > 200) {
      warnings.push(`⚠️ Your calories (${cal} kcal) don't match your macros (${impliedCal} kcal from ${pro}g P + ${carb}g C + ${fat}g F). Consider using the lock system to balance them.`)
    }

    if (warnings.length) {
      // Show warning modal — user can still override and save
      const proceed = await new Promise(resolve => {
        const overlay = document.createElement('div')
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px'
        overlay.innerHTML = `
          <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r3);padding:24px;max-width:360px;width:100%">
            <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:6px">Before you save</div>
            <div style="font-size:13px;color:var(--text3);margin-bottom:16px;line-height:1.5">
              We noticed a few things with these targets:
            </div>
            ${warnings.map(w => `
              <div style="font-size:13px;color:var(--text2);background:var(--bg3);border-radius:var(--r);padding:10px 12px;margin-bottom:8px;line-height:1.5">
                ${w}
              </div>`).join('')}
            <div style="background:rgba(76,175,130,0.1);border:1px solid rgba(76,175,130,0.3);border-radius:var(--r);padding:14px;margin:12px 0 16px">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                <span style="font-size:18px">🩺</span>
                <div style="font-size:13px;font-weight:600;color:var(--protein)">Speak with a dietitian</div>
              </div>
              <div style="font-size:12px;color:var(--text2);line-height:1.5;margin-bottom:10px">
                A registered dietitian can help you set safe, effective targets tailored to your body and goals.
                ${state.providers?.length ? `<a onclick="document.body.removeChild(document.body.lastChild);switchPage('providers')" style="color:var(--protein);cursor:pointer;text-decoration:underline"> Meet our providers →</a>` : ''}
              </div>
              <button onclick="showComingSoon(this)"
                style="width:100%;padding:10px;background:rgba(76,175,130,0.2);border:1px solid var(--protein);border-radius:var(--r);color:var(--protein);font-size:13px;font-weight:600;font-family:inherit;cursor:pointer">
                📅 Schedule a consultation
              </button>
            </div>
            <div style="display:flex;gap:10px">
              <button id="goal-warn-cancel"
                style="flex:1;padding:12px;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);color:var(--text2);font-size:14px;font-family:inherit;cursor:pointer">
                Adjust targets
              </button>
              <button id="goal-warn-save"
                style="flex:1;padding:12px;background:rgba(239,68,68,0.15);border:1px solid var(--red);border-radius:var(--r);color:var(--red);font-size:14px;font-weight:600;font-family:inherit;cursor:pointer">
                Save anyway
              </button>
            </div>
          </div>
        `
        document.body.appendChild(overlay)
        document.getElementById('goal-warn-cancel').onclick = () => { document.body.removeChild(overlay); resolve(false) }
        document.getElementById('goal-warn-save').onclick  = () => { document.body.removeChild(overlay); resolve(true) }
        overlay.onclick = (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(false) } }
      })
      if (!proceed) return
    }

    state.goals = { calories: cal, protein: pro, carbs: carb, fat }
    try {
      await dbSaveGoals(state.user.id, state.goals)
      showToast('Targets saved!', 'success')
      updateSidebar()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.filterQuickLog = filterQuickLog

  // API key no longer needed client-side — handled by server proxy

  window.copyText = (text) => {
    navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success')).catch(() => showToast('Copy failed', 'error'))
  }

  window.copyHealthKey = () => {
    const el = document.getElementById('health-sync-key-display')
    if (el && el.textContent !== 'Loading...') {
      navigator.clipboard.writeText(el.textContent).then(() => showToast('API key copied!', 'success'))
    }
  }

  window.loadHealthSyncKey = async function() {
    const el = document.getElementById('health-sync-key-display')
    if (!el) return
    try {
      const { data } = await supabase.from('user_profiles').select('health_sync_key').eq('user_id', state.user.id).maybeSingle()
      el.textContent = data?.health_sync_key || 'Not set'
    } catch { el.textContent = 'Error loading' }
  }

  window.importAppleHealthFile = async (file) => {
    const status = document.getElementById('health-import-status')
    if (!file) return
    if (status) status.textContent = 'Reading file...'

    try {
      let xmlText = ''

      if (file.name.endsWith('.zip')) {
        if (!window.JSZip) {
          await new Promise((res, rej) => {
            const s = document.createElement('script')
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
            s.onload = res; s.onerror = rej
            document.head.appendChild(s)
          })
        }
        const zip = await window.JSZip.loadAsync(file)
        const xmlFile = zip.file('apple_health_export/export.xml') || zip.file('export.xml')
        if (!xmlFile) { if (status) status.textContent = 'Could not find export.xml in ZIP'; return }
        if (status) status.textContent = 'Parsing XML...'
        xmlText = await xmlFile.async('text')
      } else {
        xmlText = await file.text()
      }

      if (status) status.textContent = 'Extracting weight readings...'

      const parser = new DOMParser()
      const doc = parser.parseFromString(xmlText, 'text/xml')
      const records = Array.from(doc.querySelectorAll('Record[type="HKQuantityTypeIdentifierBodyMass"]'))

      if (!records.length) { if (status) status.textContent = 'No weight data found in export'; return }

      // Deduplicate by date, keep latest reading per day
      const byDate = {}
      for (const r of records) {
        const date = r.getAttribute('startDate')?.slice(0, 10)
        const val = parseFloat(r.getAttribute('value'))
        const unit = r.getAttribute('unit') || 'lb'
        if (!date || isNaN(val)) continue
        const lbs = unit.toLowerCase().includes('kg') ? val * 2.20462 : val
        if (!byDate[date] || new Date(r.getAttribute('startDate')) > new Date(byDate[date].startDate)) {
          byDate[date] = { date, weight_lbs: +lbs.toFixed(1), startDate: r.getAttribute('startDate') }
        }
      }

      const readings = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
      if (status) status.textContent = `Found ${readings.length} days — importing...`

      const { data: profile } = await supabase.from('user_profiles').select('health_sync_key').eq('user_id', state.user.id).maybeSingle()
      const apiKey = profile?.health_sync_key
      if (!apiKey) { if (status) status.textContent = 'No sync key found — try refreshing'; return }

      const BATCH = 100
      let saved = 0
      for (let i = 0; i < readings.length; i += BATCH) {
        const batch = readings.slice(i, i + BATCH)
        const res = await fetch('/api/health-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: state.user.id, api_key: apiKey, readings: batch, source: 'apple_health_import' })
        })
        const data = await res.json()
        saved += data.saved || 0
        if (status) status.textContent = `Imported ${saved} of ${readings.length} readings...`
      }

      const checkins = await getCheckins(state.user.id)
      state.checkins = checkins
      if (status) status.textContent = `✓ Imported ${saved} weight readings from Apple Health`
      showToast(`Imported ${saved} weight readings`, 'success')

    } catch (err) {
      console.error('Apple Health import error:', err)
      if (status) status.textContent = 'Import failed: ' + err.message
    }
  }

  // ─── Provider handlers ────────────────────────────────────────────────────────

  window.followProviderHandler = async (providerId) => {
    try {
      await followProvider(state.user.id, providerId)
      state.followedProviders = await getFollowedProviders(state.user.id)
      renderPage()
      showToast('Following!', 'success')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.unfollowProviderHandler = async (providerId) => {
    try {
      await unfollowProvider(state.user.id, providerId)
      state.followedProviders = await getFollowedProviders(state.user.id)
      renderPage()
      showToast('Unfollowed', 'success')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.loadFollowedBroadcasts = async function() {
    const providers = [...(state.followedProviders || []), ...(state.providers || [])]
    const seen = new Set()
    for (const p of providers) {
      if (seen.has(p.user_id)) continue
      seen.add(p.user_id)
      const el = document.getElementById(`broadcasts-${p.user_id}`)
      if (!el) continue
      try {
        const broadcasts = await getProviderBroadcasts(p.user_id, true)
        if (!broadcasts.length) {
          el.innerHTML = `<div style="padding:10px 16px;font-size:12px;color:var(--text3)">No plans published yet</div>`
          continue
        }
        el.innerHTML = broadcasts.slice(0, 2).map(b => `
          <div style="padding:12px 16px;border-bottom:1px solid var(--border);last-child:border-none">
            <div style="display:flex;align-items:start;justify-content:space-between;gap:8px">
              <div>
                <div style="font-size:13px;font-weight:500;color:var(--text)">${esc(b.title)}</div>
                <div style="font-size:11px;color:var(--text3);margin-top:2px">
                  Week of ${new Date(b.week_start + 'T12:00:00').toLocaleDateString([], {month:'short', day:'numeric'})}
                  · ${(b.plan_data||[]).length} meals
                </div>
                ${b.description ? `<div style="font-size:11px;color:var(--text3);margin-top:2px">${esc(b.description)}</div>` : ''}
              </div>
              <button onclick="copyBroadcastHandler('${b.id}','${p.user_id}')"
                style="flex-shrink:0;padding:7px 12px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap">
                Preview & copy
              </button>
            </div>
          </div>
        `).join('')
      } catch {
        el.innerHTML = `<div style="padding:10px 16px;font-size:12px;color:var(--text3)">Could not load plans</div>`
      }
    }
  }

  window.copyBroadcastHandler = async (broadcastId, providerId) => {
    try {
      // Load the broadcast so we can preview its meals
      const broadcasts = await getProviderBroadcasts(providerId, true)
      const broadcast = broadcasts.find(b => b.id === broadcastId)
      if (!broadcast) { showToast('Plan not found', 'error'); return }
      if (!broadcast.plan_data?.length) { showToast('This plan has no meals', 'error'); return }

      // Stash on window so the confirm handler can read it without re-fetching
      window._pendingCopyBroadcast = broadcast

      // Initialize selection state: by default, ALL meals are selected
      window._copySelection = new Set(broadcast.plan_data.map((_, i) => i))

      // Per-meal meal-type overrides. Starts empty; we fall back to
      // each item's original meal_type when not overridden.
      window._copyMealTypes = {}

      // Default target = current week start (Sunday)
      const defaultWeek = getWeekStart()
      document.getElementById('copy-broadcast-content').innerHTML = renderCopyBroadcastPreview(broadcast, defaultWeek)
      document.getElementById('copy-broadcast-modal').classList.add('open')

      // Force every visible checkbox checked to match our Set + sync counter
      requestAnimationFrame(() => {
        document.querySelectorAll('.copy-meal-check').forEach(cb => { cb.checked = true })
        const all = document.getElementById('copy-select-all')
        if (all) { all.checked = true; all.indeterminate = false }
        updateCopySummary()
        if (typeof updateCopyEndPreview === 'function') updateCopyEndPreview()
      })
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.closeCopyBroadcastModal = () => {
    document.getElementById('copy-broadcast-modal').classList.remove('open')
    window._pendingCopyBroadcast = null
    window._copySelection = null
    window._copyMealTypes = null
    window._copyCalMonth = null
    closeCopyCalendar()
  }

  // Share the public plan URL for the broadcast currently being previewed.
  // Tries navigator.share first (native iOS/Android share sheet) so the user
  // can pick any destination — Messages, Mail, Airdrop, social, etc. Falls
  // back to plain clipboard copy on desktop browsers where share isn't
  // available. Token sanity-checked because drafts without a token shouldn't
  // surface this button at all, but defense-in-depth is cheap.
  window.shareCopyBroadcastLink = async (event) => {
    event?.stopPropagation?.()
    const broadcast = window._pendingCopyBroadcast
    if (!broadcast?.share_token) {
      showToast('This plan has no public link yet', 'error')
      return
    }
    await window._shareLink({
      title: broadcast.title || 'Meal plan',
      url: `${window.location.origin}/api/plan/${broadcast.share_token}`,
    })
  }

  window.toggleAllCopyMeals = (checked) => {
    if (!window._copySelection) window._copySelection = new Set()
    const checks = document.querySelectorAll('.copy-meal-check')
    window._copySelection.clear()
    checks.forEach(cb => {
      cb.checked = !!checked
      if (checked) window._copySelection.add(Number(cb.dataset.idx))
    })
    // If excluding leftovers, re-apply that filter on top of select-all
    const exclude = document.getElementById('copy-exclude-leftovers')?.checked
    if (checked && exclude) applyLeftoverExclusion()
    updateCopySummary()
  }

  // Uncheck (or recheck) all leftover meals in one shot.
  window.toggleExcludeLeftovers = (excluded) => {
    if (!window._copySelection) window._copySelection = new Set()
    const broadcast = window._pendingCopyBroadcast
    if (!broadcast) return
    const plan = broadcast.plan_data || []
    plan.forEach((item, i) => {
      if (item.is_leftover) {
        const cb = document.getElementById(`copy-check-${i}`)
        if (excluded) {
          window._copySelection.delete(i)
          if (cb) cb.checked = false
        } else {
          window._copySelection.add(i)
          if (cb) cb.checked = true
        }
      }
    })
    updateCopySummary()
  }

  // Helper used by Select-all when Exclude-leftovers is already on
  function applyLeftoverExclusion() {
    const broadcast = window._pendingCopyBroadcast
    if (!broadcast || !window._copySelection) return
    ;(broadcast.plan_data || []).forEach((item, i) => {
      if (item.is_leftover) {
        window._copySelection.delete(i)
        const cb = document.getElementById(`copy-check-${i}`)
        if (cb) cb.checked = false
      }
    })
  }

  // Toggle one meal — called from the card's onclick handler.
  // Uses a JS-side Set as source of truth, then syncs the visible checkbox.
  window.toggleCopyMeal = (idx, ev) => {
    if (ev) { ev.preventDefault(); ev.stopPropagation() }
    if (!window._copySelection) window._copySelection = new Set()
    const n = Number(idx)
    if (window._copySelection.has(n)) window._copySelection.delete(n)
    else window._copySelection.add(n)
    const cb = document.getElementById(`copy-check-${n}`)
    if (cb) cb.checked = window._copySelection.has(n)
    updateCopySummary()
  }

  // Set (or override) the meal type for a single meal in the preview.
  window.setCopyMealType = (idx, type, ev) => {
    if (ev) { ev.preventDefault(); ev.stopPropagation() }
    if (!window._copyMealTypes) window._copyMealTypes = {}
    window._copyMealTypes[Number(idx)] = type
    // Re-render just this meal's pill row in place
    const container = document.getElementById(`copy-meal-type-${idx}`)
    if (!container) return
    const typeColors = {
      breakfast: { bg: 'color-mix(in srgb, var(--accent) 15%, transparent)', fg: 'var(--accent)' },
      lunch:     { bg: 'rgba(122,180,232,0.15)', fg: 'var(--carbs)' },
      dinner:    { bg: 'rgba(232,154,122,0.15)', fg: 'var(--fat)' },
      snack:     { bg: 'rgba(126,200,160,0.15)', fg: 'var(--protein)' },
    }
    container.innerHTML = ['breakfast','lunch','dinner','snack'].map(t => {
      const sel = t === type
      const c = typeColors[t]
      return `<button type="button" data-mt="${t}" onclick="setCopyMealType(${idx}, '${t}', event)"
        style="padding:3px 8px;border-radius:999px;font-size:10px;text-transform:capitalize;font-family:inherit;cursor:pointer;border:1px solid ${sel?c.fg:'var(--border)'};background:${sel?c.bg:'transparent'};color:${sel?c.fg:'var(--text3)'};transition:all 0.12s">${t}</button>`
    }).join('')
  }

  // Open the recipe modal for a meal in the preview. Checks the user's
  // own library first; if the recipe isn't there (i.e. it's someone else's
  // shared recipe), fetches it via the public helper and injects a
  // read-only version into state.recipes for the modal to render.
  window.viewCopyRecipe = async (recipeId, ev) => {
    if (ev) { ev.preventDefault(); ev.stopPropagation() }
    if (!recipeId) return
    try {
      // 1) Already in the user's library?
      let recipe = (state.recipes || []).find(r => r.id === recipeId)

      // 2) Try a direct read (works if RLS allows cross-user reads)
      if (!recipe) recipe = await getRecipeByIdPublic(recipeId)

      // 3) Fall back to the broadcast-auth API route (bypasses RLS via
      //    service-role + broadcast_token auth)
      if (!recipe) {
        const bc = window._pendingCopyBroadcast
        if (bc?.share_token) {
          try {
            const resp = await fetch(`/api/broadcast-recipe?broadcast_token=${encodeURIComponent(bc.share_token)}&recipe_id=${encodeURIComponent(recipeId)}`)
            if (resp.ok) recipe = await resp.json()
          } catch {}
        }
      }

      if (!recipe) { showToast('Recipe unavailable — the provider may have unpublished it', 'error'); return }

      // Inject a read-only copy so openRecipeModal can find it in state.recipes
      if (!(state.recipes || []).some(r => r.id === recipeId)) {
        if (!state.recipes) state.recipes = []
        state.recipes.push({ ...recipe, _readonly: true })
      }

      // Stack the recipe modal above the copy-broadcast modal (both default to
      // z-index 200, so the recipe modal — declared earlier in the DOM — would
      // otherwise render behind). We restore on close.
      const recipeModal = document.getElementById('recipe-modal')
      if (recipeModal) recipeModal.style.zIndex = '300'

      window.openRecipeModal(recipeId, 'view')
    } catch (err) { showToast('Error loading recipe: ' + err.message, 'error') }
  }

  // Used by the meal planner: fetches a recipe the user already has access to
  // in their own library and opens the recipe modal. Falls back to
  // getRecipeByIdPublic in case the recipe came from a copied broadcast and
  // isn't cached in state yet.
  window.viewPlannerRecipe = async (recipeId, ev) => {
    if (ev) { ev.preventDefault(); ev.stopPropagation() }
    if (!recipeId) return
    try {
      let recipe = (state.recipes || []).find(r => r.id === recipeId)
      if (!recipe) recipe = await getRecipeByIdPublic(recipeId)
      if (!recipe) { showToast('Recipe not found in your library', 'error'); return }
      if (!(state.recipes || []).some(r => r.id === recipeId)) {
        if (!state.recipes) state.recipes = []
        state.recipes.push({ ...recipe, _readonly: true })
      }
      window.openRecipeModal(recipeId, 'view')
    } catch (err) { showToast('Error loading recipe: ' + err.message, 'error') }
  }

  window.updateCopySummary = updateCopySummary
  function updateCopySummary() {
    if (!window._copySelection) window._copySelection = new Set()
    const checks = document.querySelectorAll('.copy-meal-check')
    const total = checks.length
    const selected = window._copySelection.size
    const el = document.getElementById('copy-selected-count')
    if (el) el.textContent = `${selected} of ${total} meal${total===1?'':'s'} selected`
    const btn = document.getElementById('copy-confirm-btn')
    if (btn) btn.disabled = selected === 0
    // Keep the header checkbox in sync
    const headerCheck = document.getElementById('copy-select-all')
    if (headerCheck) {
      if (selected === 0) { headerCheck.checked = false; headerCheck.indeterminate = false }
      else if (selected === total) { headerCheck.checked = true; headerCheck.indeterminate = false }
      else { headerCheck.checked = false; headerCheck.indeterminate = true }
    }
    // Refresh end-date preview since selection affects it
    if (typeof updateCopyEndPreview === 'function') updateCopyEndPreview()
  }

  // Live preview of when the plan will end, based on the chosen start date
  // and the number of meals selected (one meal per day).
  window.updateCopyEndPreview = () => {
    const input = document.getElementById('copy-start-date')
    const out = document.getElementById('copy-end-preview')
    const broadcast = window._pendingCopyBroadcast
    if (!input || !out || !broadcast) return
    const startStr = input.value
    if (!startStr) { out.textContent = ''; return }

    const selectedCount = (window._copySelection || new Set()).size
    if (selectedCount === 0) { out.textContent = ''; return }

    const planDays = selectedCount
    const [y, m, d] = startStr.split('-').map(Number)
    const startD = new Date(y, m - 1, d)
    const endD = new Date(y, m - 1, d + planDays - 1)
    const startFmt = startD.toLocaleDateString([], {weekday:'short', month:'short', day:'numeric'})
    const endFmt = endD.toLocaleDateString([], {weekday:'short', month:'short', day:'numeric'})
    out.textContent = planDays === 1
      ? `Plan runs on ${startFmt}`
      : `Plan runs ${startFmt} → ${endFmt} (${planDays} days)`
  }

  // ── Calendar popup for start date ─────────────────────────────
  // Uses purely local-date math (no UTC conversion) so timezones don't shift days.
  function formatStartLabel(dateStr) {
    if (!dateStr) return 'Pick a date'
    const [y, m, d] = dateStr.split('-').map(Number)
    const dt = new Date(y, m - 1, d)
    return dt.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  }
  window.formatStartLabel = formatStartLabel

  window.toggleCopyCalendar = (ev) => {
    if (ev) { ev.preventDefault(); ev.stopPropagation() }
    const popup = document.getElementById('copy-calendar-popup')
    if (!popup) return
    if (popup.style.display === 'none') {
      // Render the calendar at the currently-selected month
      const current = document.getElementById('copy-start-date')?.value || localDateStr(new Date())
      const [y, m] = current.split('-').map(Number)
      window._copyCalMonth = { year: y, month: m - 1 } // month is 0-indexed
      renderCopyCalendar()
      popup.style.display = 'block'
      // Close on outside click
      setTimeout(() => {
        document.addEventListener('click', handleCopyCalOutsideClick)
      }, 0)
    } else {
      closeCopyCalendar()
    }
  }

  function handleCopyCalOutsideClick(e) {
    const popup = document.getElementById('copy-calendar-popup')
    const btn = document.getElementById('copy-start-date-btn')
    if (!popup) return
    if (popup.contains(e.target) || (btn && btn.contains(e.target))) return
    closeCopyCalendar()
  }

  function closeCopyCalendar() {
    const popup = document.getElementById('copy-calendar-popup')
    if (popup) popup.style.display = 'none'
    document.removeEventListener('click', handleCopyCalOutsideClick)
  }
  window.closeCopyCalendar = closeCopyCalendar

  window.copyCalNav = (delta) => {
    if (!window._copyCalMonth) return
    const next = new Date(window._copyCalMonth.year, window._copyCalMonth.month + delta, 1)
    window._copyCalMonth = { year: next.getFullYear(), month: next.getMonth() }
    renderCopyCalendar()
  }

  window.copyCalPick = (dateStr) => {
    const input = document.getElementById('copy-start-date')
    const label = document.getElementById('copy-start-date-label')
    if (input) input.value = dateStr
    if (label) label.textContent = formatStartLabel(dateStr)
    closeCopyCalendar()
    updateCopyEndPreview()
  }

  function renderCopyCalendar() {
    const popup = document.getElementById('copy-calendar-popup')
    if (!popup || !window._copyCalMonth) return
    const { year, month } = window._copyCalMonth
    const todayStr = localDateStr(new Date())
    const selectedStr = document.getElementById('copy-start-date')?.value || todayStr

    const firstOfMonth = new Date(year, month, 1)
    const startWeekday = firstOfMonth.getDay() // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const monthName = firstOfMonth.toLocaleDateString([], { month: 'long', year: 'numeric' })

    // Weekday header (Sun..Sat)
    const weekdayLabels = ['S','M','T','W','T','F','S']
    const headerCells = weekdayLabels.map(w =>
      `<div style="text-align:center;font-size:10px;color:var(--text3);padding:6px 0;font-weight:500;text-transform:uppercase;letter-spacing:0.04em">${w}</div>`
    ).join('')

    // Pad start, then days, then pad end to complete grid
    const cells = []
    for (let i = 0; i < startWeekday; i++) cells.push('<div></div>')
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`
      const isToday = dateStr === todayStr
      const isPast = dateStr < todayStr
      const isSelected = dateStr === selectedStr

      let bg = 'transparent', fg = 'var(--text)', border = '1px solid transparent'
      if (isPast) { fg = 'var(--text3)'; bg = 'transparent' }
      if (isToday) { border = '1px solid var(--accent)'; fg = 'var(--accent)' }
      if (isSelected) { bg = 'var(--accent)'; fg = 'var(--accent-fg)'; border = '1px solid var(--accent)' }

      cells.push(`
        <button type="button" ${isPast ? 'disabled' : ''} onclick="copyCalPick('${dateStr}')"
          style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:12px;border-radius:8px;background:${bg};color:${fg};border:${border};cursor:${isPast?'not-allowed':'pointer'};font-family:inherit;padding:0;opacity:${isPast?0.4:1};transition:background 0.12s">
          ${day}
        </button>
      `)
    }

    popup.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <button type="button" onclick="copyCalNav(-1)"
          style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--border2);border-radius:6px;color:var(--text2);cursor:pointer;font-family:inherit">‹</button>
        <div style="font-size:14px;font-weight:500;color:var(--text)">${monthName}</div>
        <button type="button" onclick="copyCalNav(1)"
          style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--border2);border-radius:6px;color:var(--text2);cursor:pointer;font-family:inherit">›</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">
        ${headerCells}
        ${cells.join('')}
      </div>
    `
  }

  window.confirmCopyBroadcast = async () => {
    const broadcast = window._pendingCopyBroadcast
    if (!broadcast) return
    const btn = document.getElementById('copy-confirm-btn')
    try {
      // Read selection from our JS-side Set (source of truth), not the DOM
      const sel = window._copySelection || new Set()
      const selectedIndices = Array.from(sel).sort((a, b) => a - b)
      if (!selectedIndices.length) { showToast('Select at least one meal', 'error'); return }

      const startDate = document.getElementById('copy-start-date')?.value || localDateStr(new Date())

      if (btn) { btn.disabled = true; btn.textContent = 'Copying...' }
      const result = await copyBroadcastToPlanner(state.user.id, broadcast, startDate, selectedIndices, window._copyMealTypes || {})
      // Back-compat: old callers expected a number, new version returns {mealsCopied, recipesAdded, recipesUpdated, diagnostics}
      const mealsCopied = typeof result === 'number' ? result : (result?.mealsCopied || 0)
      const recipesAdded = typeof result === 'number' ? 0 : (result?.recipesAdded || 0)
      const recipesUpdated = typeof result === 'number' ? 0 : (result?.recipesUpdated || 0)
      const diagnostics = typeof result === 'number' ? [] : (result?.diagnostics || [])
      const successStatuses = new Set(['imported', 'imported-legacy', 'already-owned', 'dedupe-by-name', 'dedupe-by-source', 'adopted-by-name', 'auto-updated'])
      const recipesFailed = diagnostics.filter(d => !successStatuses.has(d.status)).length

      // Compute the Sunday-based week that contains the start date,
      // navigate the planner there, and reload it so the new meals are visible
      const [sy, sm, sd] = startDate.split('-').map(Number)
      const startD = new Date(sy, sm - 1, sd)
      const sundayD = new Date(startD)
      sundayD.setDate(sundayD.getDate() - sundayD.getDay())
      const pad = n => String(n).padStart(2, '0')
      const targetWeek = `${sundayD.getFullYear()}-${pad(sundayD.getMonth()+1)}-${pad(sundayD.getDate())}`

      state.weekStart = targetWeek
      const planner = await getPlannerWeek(state.user.id, targetWeek)
      if (planner) state.planner = planner

      // Refresh recipes list so the newly-imported / freshly-updated ones show up
      if (recipesAdded > 0 || recipesUpdated > 0) {
        try {
          const fresh = await getRecipes(state.user.id)
          if (fresh) state.recipes = fresh
        } catch {}
      }

      closeCopyBroadcastModal()

      // If any recipes failed to import, show a visible on-screen diagnostic
      // (much easier to read on mobile than the console)
      if (recipesFailed > 0) {
        showCopyDiagnostics(diagnostics, mealsCopied, recipesAdded)
      } else {
        const parts = [`Copied ${mealsCopied} meal${mealsCopied===1?'':'s'}`]
        if (recipesAdded > 0) parts.push(`added ${recipesAdded} recipe${recipesAdded===1?'':'s'} to your library`)
        if (recipesUpdated > 0) parts.push(`refreshed ${recipesUpdated} recipe${recipesUpdated===1?'':'s'} from the provider`)
        showToast(parts.join(', ') + '!', 'success')
      }
      // Route to planner page so user sees the result
      switchPage('planner')
    } catch (err) {
      console.error('[copyBroadcast] fatal error:', err)
      showToast('Error: ' + (err?.message || err), 'error')
      if (btn) { btn.disabled = false; btn.textContent = 'Copy selected meals' }
    }
  }

  // Render a visible, dismissible diagnostic alert listing exactly which
  // recipes failed to import and why. Much easier to read on mobile than
  // hunting through the browser console.
  window.showCopyDiagnostics = (diagnostics, mealsCopied, recipesAdded) => {
    const successStatuses = new Set(['imported', 'imported-legacy', 'already-owned', 'dedupe-by-name', 'dedupe-by-source', 'adopted-by-name', 'auto-updated'])
    const failed = diagnostics.filter(d => !successStatuses.has(d.status))
    if (!failed.length) return
    const rows = failed.map(d => {
      let detail = ''
      if (d.status === 'fetch-failed') {
        const parts = []
        if (d.apiStatus != null) parts.push(`API ${d.apiStatus}`)
        if (d.apiErrBody) parts.push(d.apiErrBody)
        if (d.directErr) parts.push(`direct: ${d.directErr}`)
        detail = parts.join(' · ') || 'no source'
      } else if (d.status === 'insert-failed' || d.status === 'insert-threw') {
        detail = d.insertErr || 'insert failed'
      }
      return `<div style="padding:8px 10px;background:var(--bg3);border-radius:var(--r);margin-bottom:6px;font-size:12px">
        <div style="color:var(--text);font-weight:500">${esc(d.name || d.origId.slice(0,8))}</div>
        <div style="color:var(--red);font-size:11px;margin-top:2px">${esc(d.status)}</div>
        ${detail ? `<div style="color:var(--text3);font-size:10px;margin-top:2px;word-break:break-word">${esc(detail)}</div>` : ''}
      </div>`
    }).join('')

    // Reuse the broadcast modal container for display
    const modal = document.getElementById('copy-broadcast-modal')
    const content = document.getElementById('copy-broadcast-content')
    if (!modal || !content) return
    content.innerHTML = `
      <div style="padding:20px">
        <div style="display:flex;align-items:start;justify-content:space-between;gap:12px;margin-bottom:10px">
          <div>
            <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--text)">Partial import</div>
            <div style="font-size:12px;color:var(--text2);margin-top:4px">Copied ${mealsCopied} meal${mealsCopied===1?'':'s'}. ${recipesAdded} recipe${recipesAdded===1?'':'s'} saved to your library.</div>
          </div>
          <button onclick="closeCopyBroadcastModal()" style="background:transparent;border:none;color:var(--text3);font-size:20px;cursor:pointer;padding:0 4px;line-height:1">×</button>
        </div>
        <div style="padding:10px 12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:var(--r);font-size:12px;color:var(--text2);line-height:1.5;margin-bottom:12px">
          ${failed.length} recipe${failed.length===1?'':'s'} couldn't be imported. Your meals still copied with names and macros — they just won't have a View recipe link.
        </div>
        <div style="max-height:300px;overflow-y:auto">${rows}</div>
        <button onclick="closeCopyBroadcastModal()"
          style="width:100%;margin-top:12px;padding:10px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer">
          Got it
        </button>
      </div>
    `
    modal.classList.add('open')
  }

  function renderCopyBroadcastPreview(broadcast, defaultWeekStart) {
    const meals = broadcast.plan_data || []

    // Build a list of { origIdx, item } so we preserve the index for selection
    const indexed = meals.map((item, origIdx) => ({ origIdx, item }))

    // Group by actual_date (fall back to a single "All meals" bucket)
    const groups = {}
    indexed.forEach(({ origIdx, item }) => {
      const key = item.actual_date || 'unspecified'
      if (!groups[key]) groups[key] = []
      groups[key].push({ origIdx, item })
    })
    const sortedKeys = Object.keys(groups).sort()

    // "Start on" date picker setup
    const todayStr = localDateStr(new Date())
    const planDays = (() => {
      const dates = meals.map(m => m.actual_date).filter(Boolean).sort()
      if (!dates.length) return meals.length
      const [sy, sm, sd] = dates[0].split('-').map(Number)
      const [ey, em, ed] = dates[dates.length - 1].split('-').map(Number)
      const span = Math.round((new Date(ey, em-1, ed) - new Date(sy, sm-1, sd)) / (1000*60*60*24)) + 1
      return Math.max(1, span)
    })()

    const dayFmt = (key) => {
      if (key === 'unspecified') return 'Meals'
      const d = new Date(key + 'T12:00:00')
      return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
    }

    const mealTypeBadge = (type) => {
      if (!type) return ''
      const colors = {
        breakfast: 'background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--accent)',
        lunch: 'background:rgba(122,180,232,0.15);color:var(--carbs)',
        dinner: 'background:rgba(232,154,122,0.15);color:var(--fat)',
        snack: 'background:rgba(126,200,160,0.15);color:var(--protein)',
      }
      return `<span style="font-size:10px;padding:2px 6px;border-radius:4px;text-transform:capitalize;${colors[type]||'background:var(--bg3);color:var(--text3)'}">${type}</span>`
    }

    return `
      <!-- Header -->
      <div style="padding:20px 20px 14px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg2);z-index:2">
        <div style="display:flex;align-items:start;justify-content:space-between;gap:12px;margin-bottom:6px">
          <div style="min-width:0;flex:1">
            <div style="font-family:'DM Serif Display',serif;font-size:20px;color:var(--text);line-height:1.2">${esc(broadcast.title || 'Meal plan')}</div>
            ${broadcast.description ? `<div style="font-size:12px;color:var(--text2);margin-top:4px">${esc(broadcast.description)}</div>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
            ${broadcast.share_token ? `
              <button onclick="shareCopyBroadcastLink(event)"
                title="Copy or share public link"
                style="background:transparent;border:1px solid var(--border2);color:var(--text2);font-size:12px;cursor:pointer;padding:6px 10px;border-radius:var(--r);font-family:inherit;display:inline-flex;align-items:center;gap:4px;white-space:nowrap">
                🔗 <span>Share</span>
              </button>
            ` : ''}
            <button onclick="closeCopyBroadcastModal()" style="background:transparent;border:none;color:var(--text3);font-size:20px;cursor:pointer;padding:0 4px;line-height:1">×</button>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text3)">Preview the meals, uncheck any you don't want, then pick a start date.</div>
      </div>

      <!-- Start date picker -->
      <div style="padding:14px 20px;border-bottom:1px solid var(--border);background:var(--bg3);position:relative">
        <label style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:0.04em;display:block;margin-bottom:6px">Start on</label>
        <input type="hidden" id="copy-start-date" value="${todayStr}" />
        <button type="button" id="copy-start-date-btn" onclick="toggleCopyCalendar(event)"
          style="width:100%;padding:11px 12px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:var(--r);font-family:inherit;font-size:13px;cursor:pointer;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:8px">
          <span id="copy-start-date-label">${formatStartLabel(todayStr)}</span>
          <span style="color:var(--text3);font-size:14px">📅</span>
        </button>
        <div id="copy-calendar-popup" style="display:none;position:absolute;top:100%;left:20px;right:20px;margin-top:4px;z-index:20;background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r2);box-shadow:0 10px 30px rgba(0,0,0,0.4);padding:14px"></div>
        <div id="copy-end-preview" style="font-size:11px;color:var(--text3);margin-top:6px"></div>
        <div style="font-size:11px;color:var(--text3);margin-top:4px;line-height:1.4">Meals fill one per day — recipes are saved to your library so you can edit them. You can move or swap meals later on the planner.</div>
      </div>

      <!-- Select-all row + exclude leftovers toggle -->
      <div style="padding:10px 20px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--text)">
            <input type="checkbox" id="copy-select-all" checked
              onchange="toggleAllCopyMeals(this.checked)"
              style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer" />
            Select all
          </label>
          <div id="copy-selected-count" style="font-size:12px;color:var(--text2)">${meals.length} of ${meals.length} meals selected</div>
        </div>
        ${meals.some(m => m.is_leftover) ? `
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:12px;color:var(--text2);margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
            <input type="checkbox" id="copy-exclude-leftovers"
              onchange="toggleExcludeLeftovers(this.checked)"
              style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer" />
            Exclude leftovers — skip meals marked ♻️ Leftover
          </label>
        ` : ''}
      </div>

      <!-- Meals grouped by day -->
      <div style="padding:4px 0">
        ${meals.some(m => m.is_leftover) ? `
          <div style="margin:4px 20px 8px;padding:10px 12px;background:rgba(122,180,232,0.08);border:1px solid rgba(122,180,232,0.2);border-radius:var(--r);font-size:11px;color:var(--text2);line-height:1.45">
            <span style="color:var(--carbs);font-weight:500">ℹ️ About leftovers:</span>
            Meals marked <span style="color:var(--text)">♻️ Leftover</span> will keep that flag when copied, so your planner knows they don't need a fresh prep. Use the toggle above to skip them all at once, or uncheck individual ones below.
          </div>
        ` : ''}
        ${sortedKeys.map(key => `
          <div style="padding:14px 20px 4px">
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">${dayFmt(key)}</div>
            ${groups[key].map(({ origIdx, item }) => {
              const currentType = (window._copyMealTypes && window._copyMealTypes[origIdx]) || item.meal_type || 'dinner'
              const typeColors = {
                breakfast: { bg: 'color-mix(in srgb, var(--accent) 15%, transparent)', fg: 'var(--accent)' },
                lunch:     { bg: 'rgba(122,180,232,0.15)', fg: 'var(--carbs)' },
                dinner:    { bg: 'rgba(232,154,122,0.15)', fg: 'var(--fat)' },
                snack:     { bg: 'rgba(126,200,160,0.15)', fg: 'var(--protein)' },
              }
              const typeOptions = ['breakfast','lunch','dinner','snack'].map(t => {
                const sel = t === currentType
                const c = typeColors[t]
                return `<button type="button" data-mt="${t}" onclick="setCopyMealType(${origIdx}, '${t}', event)"
                  style="padding:3px 8px;border-radius:999px;font-size:10px;text-transform:capitalize;font-family:inherit;cursor:pointer;border:1px solid ${sel?c.fg:'var(--border)'};background:${sel?c.bg:'transparent'};color:${sel?c.fg:'var(--text3)'};transition:all 0.12s">${t}</button>`
              }).join('')
              return `
              <div id="copy-card-${origIdx}" style="padding:10px;margin-bottom:6px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);user-select:none">
                <div onclick="toggleCopyMeal(${origIdx}, event)" style="display:flex;align-items:start;gap:12px;cursor:pointer">
                  <input type="checkbox" id="copy-check-${origIdx}" class="copy-meal-check" data-idx="${origIdx}" checked
                    tabindex="-1"
                    style="width:16px;height:16px;accent-color:var(--accent);margin-top:2px;flex-shrink:0;pointer-events:none" />
                  <div style="flex:1;min-width:0;pointer-events:none">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                      <div style="font-size:13px;color:var(--text);font-weight:500">${esc(item._name || item.meal_name || item.recipe_name || 'Meal')}</div>
                      ${item.is_leftover ? `
                        <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(158,155,148,0.15);color:var(--text2)">♻️ Leftover</span>
                      ` : ''}
                    </div>
                    <div style="font-size:11px;color:var(--text3);margin-top:4px;display:flex;gap:10px;flex-wrap:wrap">
                      <span>${Math.round(item.calories ?? item._calories ?? 0)} cal</span>
                      <span style="color:var(--protein)">P ${Math.round(item.protein ?? 0)}g</span>
                      <span style="color:var(--carbs)">C ${Math.round(item.carbs ?? 0)}g</span>
                      <span style="color:var(--fat)">F ${Math.round(item.fat ?? 0)}g</span>
                    </div>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);padding-left:28px">
                  <div id="copy-meal-type-${origIdx}" style="display:flex;gap:4px;flex-wrap:wrap">${typeOptions}</div>
                  ${item.recipe_id ? `
                    <button type="button" onclick="viewCopyRecipe('${item.recipe_id}', event)"
                      style="margin-left:auto;padding:5px 11px;background:color-mix(in srgb, var(--accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);border-radius:var(--r);font-size:11px;color:var(--accent);font-family:inherit;cursor:pointer;white-space:nowrap;font-weight:500">
                      📖 View recipe
                    </button>
                  ` : ''}
                </div>
              </div>
            `}).join('')}
          </div>
        `).join('')}
      </div>

      <!-- Sticky footer -->
      <div style="padding:14px 20px;border-top:1px solid var(--border);background:var(--bg2);display:flex;gap:8px;position:sticky;bottom:0">
        <button onclick="closeCopyBroadcastModal()"
          style="flex:1;padding:10px;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--r);font-family:inherit;font-size:13px;font-weight:500;cursor:pointer">
          Cancel
        </button>
        <button id="copy-confirm-btn" onclick="confirmCopyBroadcast()"
          style="flex:1.5;padding:10px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer">
          Copy selected meals
        </button>
      </div>
    `
  }

  window.openNewBroadcastModal = () => {
    const today = localDateStr(new Date())
    const defaultEnd = (() => { const d = new Date(); d.setDate(d.getDate() + 6); return localDateStr(d) })()
    document.getElementById('broadcast-modal-content').innerHTML = renderBroadcastForm({
      start_date: today,
      end_date: defaultEnd,
      title: '',
      description: '',
      is_published: false,
      plan_data: [],
    })
    document.getElementById('broadcast-modal').classList.add('open')
    setTimeout(() => previewBroadcastPlan(defaultEnd), 100)
  }

  window.editBroadcastHandler = async (id) => {
    const broadcast = state.myBroadcasts.find(b => b.id === id)
    if (!broadcast) return
    document.getElementById('broadcast-modal-content').innerHTML = renderBroadcastForm(broadcast)
    document.getElementById('broadcast-modal').classList.add('open')
    // Always re-preview from today to end_date to show current planner state
    const endDate = broadcast.end_date || broadcast.week_start
    if (endDate) setTimeout(() => previewBroadcastPlan(endDate), 100)
  }

  window.closeBroadcastModal = () => {
    document.getElementById('broadcast-modal').classList.remove('open')
  }

  window.saveProviderProfileHandler = async () => {
    const name = document.getElementById('provider-name-input')?.value.trim()
    const specialty = document.getElementById('provider-specialty-input')?.value.trim()
    const bio = document.getElementById('provider-bio-input')?.value.trim()
    const credentials = document.getElementById('provider-credentials-input')?.value.trim()
    if (!name) { showToast('Display name is required', 'error'); return }
    try {
      await saveProviderProfile(state.user.id, {
        provider_name: name,
        provider_specialty: specialty,
        provider_bio: bio,
        credentials: credentials,
        provider_slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      })
      // Refresh usage so name/bio/specialty/credentials update everywhere
      state.usage = await getUsageSummary(state.user.id)
      // Also update providers list so cards refresh
      state.providers = await getProviders()
      showToast('Profile saved', 'success')
      renderPage()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.uploadProviderAvatarHandler = async (file) => {
    if (!file) return
    const preview = document.getElementById('provider-avatar-preview')
    if (preview) preview.innerHTML = '⏳'
    try {
      // Resize to 400px before upload
      const b64 = await new Promise(res => {
        const img = new Image()
        img.onload = () => {
          const MAX = 400
          let { width: w, height: h } = img
          const scale = Math.min(1, MAX / Math.max(w, h))
          w = Math.round(w * scale); h = Math.round(h * scale)
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          canvas.getContext('2d').drawImage(img, 0, 0, w, h)
          res(canvas.toDataURL('image/jpeg', 0.9))
        }
        img.src = URL.createObjectURL(file)
      })
      // Convert base64 back to blob for upload
      const blob = await fetch(b64).then(r => r.blob())
      const resizedFile = new File([blob], file.name, { type: 'image/jpeg' })
      const url = await uploadProviderAvatar(state.user.id, resizedFile)
      await saveProviderProfile(state.user.id, { provider_avatar_url: url })
      state.usage = await getUsageSummary(state.user.id)
      state.providers = await getProviders()
      showToast('Photo updated', 'success')
      // Update preview immediately
      if (preview) preview.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover" />`
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error')
      if (preview) preview.innerHTML = '🩺'
    }
  }

  window.shareBroadcastLink = async (token, btn) => {
    // Route through the unified helper so behavior matches every other
    // share action: native share sheet on mobile, clipboard fallback on
    // desktop. The broadcast title is fetched from state so the share
    // preview on Messages/Mail includes a meaningful name.
    const broadcast = (state.myBroadcasts || []).find(b => b.share_token === token)
    await window._shareLink({
      title: broadcast?.title || 'Meal plan',
      url: `${window.location.origin}/api/plan/${token}`,
    })
    if (btn) { btn.textContent = '✓ Shared'; setTimeout(() => btn.textContent = '🔗 Share link', 2000) }
  }

  window.toggleBroadcastPublished = async (id, currentlyPublished) => {
    try {
      const broadcast = state.myBroadcasts.find(b => b.id === id)
      if (!broadcast) return
      await saveBroadcast({ ...broadcast, is_published: !currentlyPublished })
      state.myBroadcasts = await getProviderBroadcasts(state.user.id, false)
      renderPage()
      if (!currentlyPublished) {
        // Show the share link after publishing
        const updated = state.myBroadcasts.find(b => b.id === id)
        const token = updated?.share_token
        if (token) {
          const url = `${window.location.origin}/api/plan/${token}`
          navigator.clipboard.writeText(url).catch(() => {})
          showToast('🎉 Published! Link copied — share with patients or post on social', 'success')
        } else {
          showToast('🎉 Published! Followers can now copy this plan', 'success')
        }
      } else {
        showToast('Unpublished', 'success')
      }
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.deleteBroadcastHandler = async (id) => {
    const broadcast = state.myBroadcasts.find(b => b.id === id)
    if (!broadcast) return
    const label = broadcast.title ? `"${broadcast.title}"` : 'this meal plan'
    const warning = broadcast.is_published
      ? `Delete ${label}?\n\nThis plan is currently published — the share link will stop working and any followers who haven't copied it yet will lose access.\n\nThis can't be undone.`
      : `Delete ${label}?\n\nThis can't be undone.`
    if (!confirm(warning)) return
    try {
      await deleteBroadcast(id, state.user.id)
      state.myBroadcasts = (state.myBroadcasts || []).filter(b => b.id !== id)
      renderPage()
      showToast('Meal plan deleted', 'success')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.saveBroadcastHandler = async () => {
    const id = document.getElementById('bc-id')?.value || null
    const today = localDateStr(new Date())
    const endDate = document.getElementById('bc-end')?.value
    let title = document.getElementById('bc-title')?.value.trim()
    const description = document.getElementById('bc-desc')?.value.trim()
    const is_published = document.getElementById('bc-published')?.checked || false

    if (!endDate) { showToast('Pick an end date', 'error'); return }
    if (endDate < today) { showToast('End date must be today or later', 'error'); return }

    // Auto-generate title if blank
    if (!title) {
      const startFmt = new Date(today + 'T12:00:00').toLocaleDateString([],{month:'short',day:'numeric'})
      const endFmt = new Date(endDate + 'T12:00:00').toLocaleDateString([],{month:'short',day:'numeric'})
      title = `${startFmt} – ${endFmt} meal plan`
    }

    try {
      const btn = document.getElementById('bc-save-btn')
      if (btn) { btn.disabled = true; btn.textContent = 'Saving...' }

      // Pull all meals from today → end_date
      const { meals } = await getPlannerRange(state.user.id, today, endDate)
      const plan_data = (meals || []).map(item => {
        // Real row shape from meal_planner: meal_name, calories, protein, carbs, fat, fiber,
        // day_of_week, week_start_date, recipe_id, meal_type, planned_servings, actualDate
        const name = item.meal_name || item.recipe?.name || item.food_item?.name || 'Meal'
        const cal  = Number(item.calories ?? item.recipe?.calories ?? item.food_item?.calories ?? 0)
        const p    = Number(item.protein  ?? item.recipe?.protein  ?? item.food_item?.protein  ?? 0)
        const c    = Number(item.carbs    ?? item.recipe?.carbs    ?? item.food_item?.carbs    ?? 0)
        const f    = Number(item.fat      ?? item.recipe?.fat      ?? item.food_item?.fat      ?? 0)
        const fib  = Number(item.fiber    ?? item.recipe?.fiber    ?? item.food_item?.fiber    ?? 0)
        return {
          recipe_id: item.recipe_id || null,
          meal_type: item.meal_type || 'dinner',
          planned_servings: item.planned_servings || 1,
          actual_date: item.actualDate || item.actual_date || null,
          day_of_week: item.day_of_week ?? null,
          _name: name,
          meal_name: name,
          recipe_name: name,
          _calories: cal,
          calories: cal,
          protein: p,
          carbs: c,
          fat: f,
          fiber: fib,
          is_leftover: !!item.is_leftover,
        }
      })

      await saveBroadcast({
        ...(id ? { id } : {}),
        provider_id: state.user.id,
        title, description,
        week_start: today, // keep for backward compat
        start_date: today,
        end_date: endDate,
        is_published,
        plan_data
      })
      state.myBroadcasts = await getProviderBroadcasts(state.user.id, false)
      closeBroadcastModal()
      renderPage()
      if (is_published) {
        const updated = state.myBroadcasts.find(b => !id || b.id === id)
        const token = updated?.share_token
        if (token) {
          const url = `${window.location.origin}/api/plan/${token}`
          navigator.clipboard.writeText(url).catch(() => {})
          showToast('🎉 Published! Link copied — share with patients or post on social', 'success')
        } else {
          showToast('🎉 Plan published!', 'success')
        }
      } else {
        showToast('Draft saved', 'success')
      }
    } catch (err) {
      showToast('Error: ' + err.message, 'error')
      const btn = document.getElementById('bc-save-btn')
      if (btn) { btn.disabled = false; btn.textContent = 'Save' }
    }
  }

  window.previewBroadcastPlan = async (endDate) => {
    const preview = document.getElementById('bc-plan-preview')
    if (!preview || !endDate) return
    const today = localDateStr(new Date())
    if (endDate < today) {
      preview.innerHTML = `<div style="background:var(--bg3);border-radius:var(--r);padding:12px;font-size:12px;color:var(--red);text-align:center">End date must be today or later</div>`
      return
    }
    preview.innerHTML = `<div style="font-size:12px;color:var(--text3);text-align:center;padding:8px">Loading meals...</div>`
    try {
      const { meals } = await getPlannerRange(state.user.id, today, endDate)
      if (!meals?.length) {
        preview.innerHTML = `
          <div style="background:var(--bg3);border-radius:var(--r);padding:14px;font-size:12px;color:var(--text3);text-align:center">
            <div style="font-size:20px;margin-bottom:6px">📅</div>
            No meals planned between today and ${new Date(endDate + 'T12:00:00').toLocaleDateString([],{month:'short',day:'numeric'})}
            <div style="margin-top:8px;font-size:11px">Add meals to your planner first, then share them here</div>
          </div>`
        return
      }
      // Group by date
      const byDate = {}
      meals.forEach(m => {
        const d = m.actual_date || today
        if (!byDate[d]) byDate[d] = []
        byDate[d].push(m)
      })
      const days = Object.keys(byDate).sort()
      preview.innerHTML = `
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">
          ${meals.length} meal${meals.length !== 1 ? 's' : ''} across ${days.length} day${days.length !== 1 ? 's' : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto">
          ${days.map(date => {
            const dayMeals = byDate[date]
            const dayLabel = new Date(date + 'T12:00:00').toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})
            return `
              <div style="background:var(--bg3);border-radius:var(--r);padding:8px 10px">
                <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">${dayLabel}</div>
                ${dayMeals.map(m => `
                  <div style="font-size:12px;color:var(--text2);display:flex;justify-content:space-between;align-items:center;padding:2px 0">
                    <span>${esc(m.recipe?.name || m.food_item?.name || 'Meal')}</span>
                    <span style="color:var(--text3);font-size:11px">${m.meal_type || ''}</span>
                  </div>`).join('')}
              </div>`
          }).join('')}
        </div>
      `
    } catch {
      preview.innerHTML = `<div style="font-size:12px;color:var(--text3);text-align:center;padding:8px">Could not load planner</div>`
    }
  }

  // ─── Macro target lock / rebalance ────────────────────────────────────────────
  // Default: calories locked, fat locked, carbs floats
  window._macroLockState = window._macroLockState || { cal: true, pro: false, carb: false, fat: true }

  window.toggleMacroLock = (key) => {
    const locks = window._macroLockState

    // Toggle the clicked key
    locks[key] = !locks[key]

    // After toggling, check how many are still unlocked
    const unlocked = Object.values(locks).filter(v => !v).length

    // If everything is locked (0 unlocked), automatically unlock calories
    if (unlocked === 0) {
      locks.cal = false
      showToast('Calories unlocked — one macro must always float', 'success')
    }

    // Re-render only the macro fields div (not its parent which contains save buttons)
    const macroDiv = document.getElementById('goal-cal')?.closest('[style*="grid"]')?.parentElement
    if (macroDiv) {
      macroDiv.outerHTML = buildMacroFields(state.goals)
      showMacroBalanceHint()
    }
  }

  window.rebalanceMacros = (changedKey) => {
    const locks = window._macroLockState
    const cal = parseFloat(document.getElementById('goal-cal')?.value) || 0
    const pro = parseFloat(document.getElementById('goal-p')?.value) || 0
    const carb = parseFloat(document.getElementById('goal-c')?.value) || 0
    const fat = parseFloat(document.getElementById('goal-f')?.value) || 0

    // Cal from macros = protein*4 + carbs*4 + fat*9
    const calFromMacros = pro * 4 + carb * 4 + fat * 9

    // Find the unlocked fields (excluding the one just changed)
    const unlocked = Object.entries(locks).filter(([k, locked]) => !locked && k !== changedKey)

    if (locks.cal && unlocked.length === 1) {
      // Calories is fixed — adjust the one unlocked macro to balance
      const [floatKey] = unlocked[0]
      const targetCal = cal
      if (floatKey === 'carb') {
        const newCarb = Math.max(0, Math.round((targetCal - pro * 4 - fat * 9) / 4))
        const el = document.getElementById('goal-c')
        if (el) el.value = newCarb
      } else if (floatKey === 'fat') {
        const newFat = Math.max(0, Math.round((targetCal - pro * 4 - carb * 4) / 9))
        const el = document.getElementById('goal-f')
        if (el) el.value = newFat
      } else if (floatKey === 'pro') {
        const newPro = Math.max(0, Math.round((targetCal - carb * 4 - fat * 9) / 4))
        const el = document.getElementById('goal-p')
        if (el) el.value = newPro
      }
    } else if (!locks.cal) {
      // Calories floats — recalculate from macros
      const newCal = Math.round(pro * 4 + carb * 4 + fat * 9)
      const el = document.getElementById('goal-cal')
      if (el) el.value = newCal
    }

    showMacroBalanceHint()
  }

  function showMacroBalanceHint() {
    const cal = parseFloat(document.getElementById('goal-cal')?.value) || 0
    const pro = parseFloat(document.getElementById('goal-p')?.value) || 0
    const carb = parseFloat(document.getElementById('goal-c')?.value) || 0
    const fat = parseFloat(document.getElementById('goal-f')?.value) || 0
    const implied = Math.round(pro * 4 + carb * 4 + fat * 9)
    const diff = Math.abs(implied - cal)
    const hint = document.getElementById('macro-balance-hint')
    if (!hint) return
    if (diff <= 5) {
      hint.textContent = `✓ Balanced · ${cal} kcal`
      hint.style.color = 'var(--protein)'
    } else {
      hint.textContent = `Macros = ${implied} kcal · Calories set to ${cal} (${diff > 0 ? '+' : ''}${implied - cal})`
      hint.style.color = 'var(--text3)'
    }
  }

  window.showComingSoon = (btn) => {
    if (!btn) return
    const orig = btn.innerHTML
    btn.innerHTML = '🚀 Coming soon — stay tuned!'
    btn.style.background = 'color-mix(in srgb, var(--accent) 15%, transparent)'
    btn.style.borderColor = 'var(--accent)'
    btn.style.color = 'var(--accent)'
    btn.disabled = true
    setTimeout(() => {
      btn.innerHTML = orig
      btn.style.background = 'rgba(76,175,130,0.2)'
      btn.style.borderColor = 'var(--protein)'
      btn.style.color = 'var(--protein)'
      btn.disabled = false
    }, 3000)
  }

  window.handleSignOut = async () => {
    try { await signOut() } catch (e) { console.error(e) }
    window.location.reload()
  }

  // ── Edit modal ──────────────────────────────────────────────────
  window.openEditModal = (id, source, plannerCtx) => {
    let entry
    if (source === 'log') {
      entry = state.log.find(e => String(e.id) === String(id))
    } else {
      const { d, m } = plannerCtx
      const meal = state.planner.meals[d]?.[m]
      entry = meal ? { ...meal, name: meal.meal_name || meal.name } : null
    }
    if (!entry) return
    state.editingEntry = { id, source, plannerCtx }

    // Base macros = per-serving values (stored separately, or fall back to current values)
    // If servings_consumed > 1, divide back to get per-serving base
    const consumed = parseFloat(entry.servings_consumed) || 1
    state.editingBaseMacros = {
      calories: entry.base_calories ?? (entry.calories / consumed) ?? 0,
      protein:  entry.base_protein  ?? (entry.protein  / consumed) ?? 0,
      carbs:    entry.base_carbs    ?? (entry.carbs    / consumed) ?? 0,
      fat:      entry.base_fat      ?? (entry.fat      / consumed) ?? 0,
      fiber:    entry.base_fiber    ?? (entry.fiber    / consumed) ?? 0,
      sugar:    entry.base_sugar    ?? (entry.sugar    / consumed) ?? 0,
    }

    document.getElementById('edit-name').value = entry.name || ''
    document.getElementById('edit-servings').value = consumed
    // Set meal type button
    const mealType = entry.meal_type || getMealTypeFromTime(new Date(entry.logged_at || entry.timestamp))
    state.editingMealType = mealType
    setTimeout(() => window.setEditMealType(mealType), 0)
    // Show consumed (already-multiplied) values in fields
    document.getElementById('edit-cal').value = Math.round(entry.calories || 0)
    document.getElementById('edit-protein').value = Math.round(entry.protein || 0)
    document.getElementById('edit-carbs').value = Math.round(entry.carbs || 0)
    document.getElementById('edit-fat').value = Math.round(entry.fat || 0)
    document.getElementById('edit-fiber').value = Math.round(entry.fiber || 0)
    document.getElementById('edit-sugar').value = Math.round(entry.sugar || 0)
    document.getElementById('edit-modal').classList.add('open')
  }

  window.setEditMealType = (type) => {
    state.editingMealType = type
    ;['Breakfast','Lunch','Snack','Dinner'].forEach(t => {
      const btn = document.getElementById('meal-type-btn-' + t)
      if (!btn) return
      btn.style.background = t === type ? 'var(--accent)' : 'var(--bg3)'
      btn.style.color = t === type ? 'var(--accent-fg)' : 'var(--text3)'
      btn.style.borderColor = t === type ? 'var(--accent)' : 'var(--border)'
      btn.style.fontWeight = t === type ? '600' : '400'
    })
  }

  window.closeEditModal = () => {
    document.getElementById('edit-modal').classList.remove('open')
    state.editingEntry = null
    state.editingBaseMacros = null
    state.editingMealType = null
  }

  window.applyServingsMultiplier = () => {
    const servings = parseFloat(document.getElementById('edit-servings').value) || 1
    const base = state.editingBaseMacros
    if (!base) return
    const round = (v) => Math.round(v * servings * 10) / 10
    document.getElementById('edit-cal').value = round(base.calories)
    document.getElementById('edit-protein').value = round(base.protein)
    document.getElementById('edit-carbs').value = round(base.carbs)
    document.getElementById('edit-fat').value = round(base.fat)
    document.getElementById('edit-fiber').value = round(base.fiber)
    document.getElementById('edit-sugar').value = round(base.sugar)
  }

  window.saveEditEntry = async () => {
    if (!state.editingEntry) return
    const { id, source, plannerCtx } = state.editingEntry
    const servings = parseFloat(document.getElementById('edit-servings').value) || 1
    const base = state.editingBaseMacros || {}
    const vals = {
      name: document.getElementById('edit-name').value.trim(),
      // Consumed = base × servings
      calories: Math.round((base.calories || 0) * servings * 10) / 10,
      protein:  Math.round((base.protein  || 0) * servings * 10) / 10,
      carbs:    Math.round((base.carbs    || 0) * servings * 10) / 10,
      fat:      Math.round((base.fat      || 0) * servings * 10) / 10,
      fiber:    Math.round((base.fiber    || 0) * servings * 10) / 10,
      sugar:    Math.round((base.sugar    || 0) * servings * 10) / 10,
      // Preserve base macros and servings_consumed
      base_calories: base.calories || 0,
      base_protein:  base.protein  || 0,
      base_carbs:    base.carbs    || 0,
      base_fat:      base.fat      || 0,
      base_fiber:    base.fiber    || 0,
      base_sugar:    base.sugar    || 0,
      servings_consumed: servings,
      meal_type: state.editingMealType || null,
    }
    try {
      if (source === 'log') {
        await updateMealEntry(state.user.id, id, vals)
        const idx = state.log.findIndex(e => String(e.id) === String(id))
        if (idx !== -1) state.log[idx] = { ...state.log[idx], ...vals }
      } else {
        const { d, m } = plannerCtx
        const meal = state.planner.meals[d]?.[m]
        if (meal) await updatePlannerMeal(state.user.id, meal.id, { ...vals, leftover: meal.is_leftover || meal.leftover })
        if (state.planner.meals[d]?.[m]) state.planner.meals[d][m] = { ...state.planner.meals[d][m], ...vals, meal_name: vals.name }
      }
      closeEditModal()
      renderPage()
      showToast('Meal updated!', 'success')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.deleteEditEntry = async () => {
    if (!state.editingEntry) return
    if (!confirm('Delete this entry?')) return
    const { id, source, plannerCtx } = state.editingEntry
    try {
      if (source === 'log') {
        await deleteMealEntry(state.user.id, id)
        state.log = state.log.filter(e => String(e.id) !== String(id))
      } else {
        const { d, m } = plannerCtx
        const meal = state.planner.meals[d]?.[m]
        if (meal) await deletePlannerMeal(state.user.id, meal.id)
        state.planner.meals[d].splice(m, 1)
      }
      closeEditModal()
      renderPage()
      showToast('Deleted', '')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  // ── Planner view / week navigation ─────────────────────────────
  window.setPlannerView = (view) => {
    // Grocery is premium-only. Free users tapping it get the upgrade
    // modal instead of switching the view, since generating a grocery
    // list triggers a full LLM pass to aggregate/deduplicate ingredients.
    if (view === 'grocery' && isPremiumOnlyFeature('grocery')) {
      if (typeof window.openLimitReachedModal === 'function') {
        // Reuse the same modal but override the copy for a feature-gate
        // (no AI Bucks spent — they just don't have access).
        openFeatureGatedModal('Grocery list')
      } else {
        switchPage('upgrade')
      }
      return
    }
    state.plannerView = view
    renderPage()
  }

  // Feature-gate modal (distinct from limit-reached). Used when a free
  // user tries a premium-only feature — the grocery list generator is
  // the first such example. Shares a lot of styling with openLimitReachedModal
  // but different copy: 'this is a Premium feature' vs 'you ran out'.
  window.openFeatureGatedModal = (featureName) => {
    const modal = document.getElementById('limit-reached-modal')
    if (!modal) { switchPage('upgrade'); return }
    const subtitle = document.getElementById('limit-reached-subtitle')
    const usage = document.getElementById('limit-reached-usage')
    const titleEl = modal.querySelector('h3')
    if (titleEl) titleEl.textContent = `${featureName} is a Premium feature`
    if (subtitle) subtitle.textContent = `Upgrade to Premium to unlock ${featureName} and ${bucksCount(10.00)} AI Bucks every month.`
    if (usage) usage.textContent = ''
    modal.classList.add('open')
  }

  window.toggleCalendar = () => {
    state.showCalendar = !state.showCalendar
    if (state.showCalendar) {
      const [tyr, tmo] = state.weekStart.split('-').map(Number)
      state.calendarMonth = { year: tyr, month: tmo - 1 }
    }
    renderPage()
  }

  window.shiftCalMonth = (dir) => {
    if (!state.calendarMonth) return
    let { year, month } = state.calendarMonth
    month += dir
    if (month < 0) { month = 11; year-- }
    if (month > 11) { month = 0; year++ }
    state.calendarMonth = { year, month }
    renderPage()
  }

  window.jumpToWeek = (weekStart) => {
    state.weekStart = weekStart
    state.showCalendar = false
    state.calendarMonth = null
    state.mealServings = {}
    state.excludedIngredients = new Set()
    renderPage()
  }

  window.jumpToToday = () => {
    state.weekStart = getWeekStart()
    state.showCalendar = false
    state.calendarMonth = null
    state.mealServings = {}
    state.excludedIngredients = new Set()
    renderPage()
  }

  window.shiftWeek = (dir) => {
    const [yr, mo, dy] = state.weekStart.split('-').map(Number)
    const d = new Date(yr, mo - 1, dy + dir * 7)
    state.weekStart = localDateStr(d)
    state.showCalendar = false
    state.calendarMonth = null
    state.mealServings = {}
    state.excludedIngredients = new Set()
    state.groceryFromDate = null
    state.groceryToDate = null
    renderPage()
  }

  // ── Grocery list handlers ───────────────────────────────────────
  window.setGroceryView = (view) => {
    state.groceryView = view
    renderPage()
  }

  window.setGroceryDateRange = (from, to) => {
    if (from !== null) state.groceryFromDate = from
    if (to !== null) state.groceryToDate = to
    renderPage()
  }

  window.resetGroceryDates = () => {
    state.groceryFromDate = null
    state.groceryToDate = null
    renderPage()
  }

  window.setMealServings = (mealId, val) => {
    if (!state.mealServings) state.mealServings = {}
    const n = parseInt(val)
    if (n > 0) state.mealServings[mealId] = n
    renderPage()
  }

  window.toggleIngredientExclusion = (mealId, ingName, isCurrentlyExcluded) => {
    if (!state.excludedIngredients) state.excludedIngredients = new Set()
    const key = `${mealId}::${ingName.toLowerCase()}`
    if (isCurrentlyExcluded) state.excludedIngredients.delete(key)
    else state.excludedIngredients.add(key)
    renderPage()
  }

  window.resetExclusions = () => {
    state.excludedIngredients = new Set()
    renderPage()
  }

  window.addGroceryItem = () => {
    if (!state.groceryCustomItems) state.groceryCustomItems = []
    state.groceryCustomItems.push({ id: Date.now().toString(), text: '' })
    renderPage()
    setTimeout(() => {
      const inputs = document.querySelectorAll('[onchange*="editCustomGroceryItem"]')
      const last = inputs[inputs.length - 1]
      if (last) last.focus()
    }, 50)
  }

  // Build a plaintext version of the grocery list and copy to clipboard.
  // Format is optimized for pasting into Notes / Reminders / a text message.
  //
  // CRITICAL iOS quirk: navigator.clipboard.writeText requires an active
  // user gesture. Once you `await` a network call before the clipboard
  // write, iOS Safari considers the gesture expired and silently denies.
  // execCommand('copy') used to be a fallback but is deprecated and
  // doesn't reliably work on modern iOS either.
  //
  // Solution: use only data ALREADY in state.recipes / state.planner /
  // state.groceryCustomItems — no awaits before the clipboard write.
  // The grocery view has already loaded that data; we just re-derive
  // the same view synchronously.
  window.copyGroceryList = () => {
    const btn = document.getElementById('grocery-copy-btn')
    try {
      // Use the same data the visible list is rendered from. The grocery
      // list view stores fetched range meals in a state field so we don't
      // need to re-fetch — see renderGroceryList.
      const planner = state.planner || { meals: [] }
      const rangeMeals = state._groceryRangeMeals || (planner.meals || []).flat()

      const allItems = collectAllIngredients(planner, rangeMeals)
      const active = allItems.filter(i => !i.excluded)
      const summed = sumIngredients(active)

      const byCategory = {}
      summed.forEach(item => {
        const cat = item.category || 'other'
        if (!byCategory[cat]) byCategory[cat] = []
        byCategory[cat].push(item)
      })

      const customItems = (state.groceryCustomItems || [])
        .map(c => (c.text || '').trim())
        .filter(Boolean)

      const lines = ['Grocery list', '']
      for (const cat of CATEGORY_ORDER) {
        const items = byCategory[cat]
        if (!items?.length) continue
        const cfg = CATEGORIES[cat]
        lines.push(cfg?.label || cat)
        for (const item of items) {
          const amount = item.totalAmount
            ? `${item.totalAmount % 1 === 0 ? item.totalAmount : +item.totalAmount.toFixed(2)} ${item.unit || ''}`.trim()
            : ''
          lines.push(amount ? `- ${amount} ${item.name}` : `- ${item.name}`)
        }
        lines.push('')
      }
      if (customItems.length) {
        lines.push('Other')
        for (const t of customItems) lines.push(`- ${t}`)
        lines.push('')
      }
      const text = lines.join('\n').trimEnd()

      // Sync clipboard write (gesture still active). navigator.clipboard
      // returns a promise but we don't await — we kick it off and trust
      // the gesture is preserved. Failures fall through to the .catch.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => {
            showToast('Grocery list copied — paste in Notes', 'success')
            if (btn) {
              const original = btn.textContent
              btn.textContent = '✓ Copied'
              setTimeout(() => { if (btn) btn.textContent = original }, 1500)
            }
          })
          .catch(err => {
            console.warn('[copyGroceryList] clipboard write rejected:', err)
            // Fallback: show the text in a textarea modal the user can
            // manually copy from. Better than silent failure.
            showCopyableTextModal(text)
          })
      } else {
        // Very old browsers — show the modal directly
        showCopyableTextModal(text)
      }
    } catch (err) {
      console.error('[copyGroceryList] failed:', err)
      showToast('Error: ' + (err?.message || 'unknown'), 'error')
    }
  }

  // Fallback when navigator.clipboard fails: show the text in a modal
  // with a pre-selected textarea. iOS lets you tap "Copy" in the system
  // selection menu after a long press, which works even when the API
  // path doesn't.
  function showCopyableTextModal(text) {
    let modal = document.getElementById('copyable-text-modal')
    if (!modal) {
      modal = document.createElement('div')
      modal.id = 'copyable-text-modal'
      modal.className = 'modal-overlay open'
      modal.style.cssText = 'display:flex;align-items:center;justify-content:center'
      modal.innerHTML = `
        <div class="modal-box" style="max-width:480px;width:90%">
          <button class="modal-close" onclick="document.getElementById('copyable-text-modal').remove()">×</button>
          <h3 style="margin:0 0 8px;font-family:'DM Serif Display',serif">Copy your grocery list</h3>
          <div style="font-size:12px;color:var(--text3);margin-bottom:12px">Tap inside the box, Select All, then Copy.</div>
          <textarea id="copyable-text-textarea" readonly
            style="width:100%;height:300px;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:12px;color:var(--text);font-size:13px;font-family:ui-monospace,monospace;resize:none;outline:none"></textarea>
        </div>
      `
      document.body.appendChild(modal)
    } else {
      modal.classList.add('open')
    }
    const ta = modal.querySelector('#copyable-text-textarea')
    if (ta) {
      ta.value = text
      // Try to auto-select for one-tap copy on devices that support it
      setTimeout(() => { try { ta.focus(); ta.select() } catch {} }, 50)
    }
  }

  window.editCustomGroceryItem = (idx, val) => {
    if (!state.groceryCustomItems) return
    state.groceryCustomItems[idx].text = val
  }

  window.removeCustomGroceryItem = (idx) => {
    if (!state.groceryCustomItems) return
    state.groceryCustomItems.splice(idx, 1)
    renderPage()
  }

  // ── AI smart-merge for grocery list (Pass 2 of hybrid dedup) ──────
  // Sends the current post-Pass-1 ingredient names to Claude and asks
  // for a synonym map. Persisted to ingredient_synonyms table so they
  // apply on future loads without re-paying AI Bucks.
  //
  // On-demand only — costs AI Bucks, so it doesn't run silently.
  window.smartMergeGrocery = async () => {
    const btn = document.getElementById('grocery-merge-btn')
    if (!btn) return
    const originalText = btn.textContent
    try {
      btn.disabled = true
      btn.textContent = '✨ Merging...'

      // Re-derive the current post-Pass-1 list to send to AI. Use the
      // cached range meals we already store for the Copy button.
      const planner = state.planner || { meals: [] }
      const rangeMeals = state._groceryRangeMeals || (planner.meals || []).flat()
      const allItems = collectAllIngredients(planner, rangeMeals)
      const active = allItems.filter(i => !i.excluded)
      const summed = sumIngredients(active)

      if (summed.length < 2) {
        showToast('Nothing to merge — list is already clean', '')
        return
      }

      const result = await dedupGroceryNames(summed)
      const synonyms = Array.isArray(result?.synonyms) ? result.synonyms : []

      if (synonyms.length === 0) {
        showToast('Already optimized — no merges found', 'success')
        return
      }

      // Filter to actually-new pairs we don't already know about. The
      // table will silently upsert duplicates anyway, but skipping
      // them client-side gives us an accurate "added N" count.
      if (!state.aiSynonyms) state.aiSynonyms = {}
      const newPairs = []
      for (const pair of synonyms) {
        if (!pair?.from || !pair?.to) continue
        const fromKey = String(pair.from).toLowerCase().trim()
        const toCanon = String(pair.to).toLowerCase().trim()
        if (!fromKey || !toCanon || fromKey === toCanon) continue
        if (state.aiSynonyms[fromKey] !== toCanon) {
          newPairs.push({ from: fromKey, to: toCanon })
        }
      }

      if (newPairs.length === 0) {
        showToast('Already optimized — no new merges found', 'success')
        return
      }

      // Persist to DB. If this fails (e.g. table doesn't exist yet), we
      // still apply the synonyms in-memory for this session — graceful
      // degradation.
      try {
        await saveIngredientSynonyms(state.user.id, newPairs)
      } catch (saveErr) {
        console.warn('[smartMergeGrocery] DB save failed (synonyms applied in-memory):', saveErr.message)
      }

      // Apply to in-memory map
      for (const p of newPairs) {
        state.aiSynonyms[p.from] = p.to
      }

      showToast(`Merged ${newPairs.length} similar item${newPairs.length === 1 ? '' : 's'}`, 'success')
      renderPage()
    } catch (err) {
      console.error('[smartMergeGrocery] failed:', err)
      // 429 / spend-limit errors will have already shown the upgrade
      // modal via callProxy's interceptor. Other errors get a toast.
      if (!err?.message?.includes('AI Bucks')) {
        showToast('Merge failed: ' + (err?.message || 'unknown'), 'error')
      }
    } finally {
      btn.disabled = false
      btn.textContent = originalText
    }
  }

  // ── Show merge details + unmerge UI ───────────────────────────────
  // Triggered by tapping the '✨ +N variants' badge on a merged row.
  // Renders a real modal showing:
  //   - The canonical ingredient + total amount
  //   - Each variant that got merged in: original name, contributed
  //     amount, source recipe
  //   - A clear "after unmerge, these split back into N separate rows"
  //     statement so the user knows what they're committing to
  //   - Cancel / Unmerge buttons
  //
  // The previous version used confirm() with just variant names — not
  // enough context to make an informed decision. User asked for "details
  // of what the rows were before merged" and "what the rows will be if
  // I unmerge", so this modal answers both.
  //
  // Data flows through data-merge-info as base64-encoded JSON. base64
  // because raw JSON in an HTML attribute breaks on quotes/apostrophes;
  // pipe-delimited strings can't carry the rich source records we need
  // for this view.
  window.showMergeDetails = (btn) => {
    if (!btn) return
    const row = btn.closest('[data-merge-info]')
    if (!row) return
    let info
    try {
      info = JSON.parse(decodeURIComponent(escape(atob(row.dataset.mergeInfo))))
    } catch (err) {
      console.error('[showMergeDetails] decode failed:', err)
      return
    }
    if (!info?.sources?.length) return

    // Format an amount + unit for display.
    const fmt = (amt, unit) => {
      if (!amt && amt !== 0) return '—'
      const rounded = amt % 1 === 0 ? amt : +amt.toFixed(2)
      return unit ? `${rounded} ${unit}` : `${rounded}`
    }

    const totalLabel = fmt(info.total, info.unit)
    const sources = info.sources

    // Split sources by what happens on unmerge:
    //   viaAi=true  → AI synonym pulled it in; it splits back into its own row
    //   viaAi=false → was already canonical (or regex-canonicalized); it stays
    const removed = sources.filter(s => s.viaAi)
    const kept = sources.filter(s => !s.viaAi)

    // After unmerge we'll have:
    //   1 row for the canonical (the kept sources sum into it)  +
    //   N rows for each removed source (one per AI-merged variant)
    // We only count the +1 if there are kept sources (otherwise the
    // canonical row has nothing left to sum and disappears).
    const postUnmergeRows = (kept.length > 0 ? 1 : 0) + removed.length

    // Render each source as a card. AI-merged sources get a red
    // "splits out" badge; non-merged ones get a neutral "stays" badge
    // so the user can see at a glance what's happening to each.
    const sourceListHtml = sources.map(s => {
      const isRemoved = !!s.viaAi
      const badgeBg = isRemoved ? 'rgba(225,113,103,0.15)' : 'rgba(122,180,232,0.12)'
      const badgeBorder = isRemoved ? 'rgba(225,113,103,0.35)' : 'rgba(122,180,232,0.25)'
      const badgeColor = isRemoved ? 'var(--red)' : 'var(--text3)'
      const badgeLabel = isRemoved ? 'splits out' : 'stays'
      return `
        <div style="padding:10px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:2px">
            <div style="font-size:13px;color:var(--text);font-weight:500;flex:1;min-width:0;overflow-wrap:break-word">${esc(s.name)}</div>
            <span style="font-size:9px;padding:2px 7px;background:${badgeBg};border:1px solid ${badgeBorder};border-radius:999px;color:${badgeColor};white-space:nowrap;flex-shrink:0;text-transform:uppercase;letter-spacing:0.4px;font-weight:600">${badgeLabel}</span>
          </div>
          <div style="font-size:11px;color:var(--text3);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <span>${fmt(s.amount, s.unit)}</span>
            <span style="text-align:right;flex:1;min-width:0;overflow-wrap:break-word">${esc(s.mealName || '')}</span>
          </div>
        </div>
      `
    }).join('')

    // Stash the AI-removed variant names for the unmerge button. We
    // unmerge ONLY the AI-via sources; the canonical-direct ones
    // weren't synonyms so there's nothing to remove from the DB.
    const removeNames = removed.map(s => s.name).filter(Boolean)
    const variantsAttr = btoa(unescape(encodeURIComponent(JSON.stringify(removeNames))))

    const existing = document.getElementById('merge-details-modal')
    if (existing) existing.remove()
    const modal = document.createElement('div')
    modal.id = 'merge-details-modal'
    modal.className = 'modal-overlay open'
    modal.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:16px'
    modal.innerHTML = `
      <div class="modal-box" style="max-width:440px;width:100%;max-height:85vh;display:flex;flex-direction:column">
        <button class="modal-close" onclick="document.getElementById('merge-details-modal')?.remove()">×</button>
        <h3 style="margin:0 0 4px;font-family:'DM Serif Display',serif;font-size:20px">Merged ingredient</h3>
        <div style="font-size:13px;color:var(--text3);margin-bottom:14px;overflow-wrap:break-word">
          <span style="color:var(--text)">${esc(info.canonical || 'unknown')}</span> · ${totalLabel} total · ${sources.length} source${sources.length === 1 ? '' : 's'}
        </div>

        <div style="font-size:11px;color:var(--text3);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">
          Composition
        </div>
        <div style="overflow-y:auto;flex:1;margin-bottom:14px">
          ${sourceListHtml}
        </div>

        <div style="font-size:12px;color:var(--text2);padding:10px 12px;background:var(--bg3);border-radius:6px;margin-bottom:14px;line-height:1.4">
          <b style="color:var(--text)">After unmerge:</b> ${
            postUnmergeRows === sources.length
              ? `${postUnmergeRows} separate row${postUnmergeRows === 1 ? '' : 's'} (one per source above).`
              : `${postUnmergeRows} row${postUnmergeRows === 1 ? '' : 's'} — the items marked <i>stays</i> remain on the canonical row, and each <i>splits out</i> item becomes its own row.`
          } The synonym mapping${removed.length === 1 ? '' : 's'} will be removed from your saved settings.
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button onclick="document.getElementById('merge-details-modal')?.remove()"
            style="background:var(--bg3);border:1px solid var(--border2);color:var(--text);padding:8px 16px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:13px">
            Cancel
          </button>
          <button onclick="confirmUnmergeFromModal('${variantsAttr}')"
            style="background:var(--red);border:none;color:white;padding:8px 16px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500">
            Unmerge
          </button>
        </div>
      </div>
    `
    document.body.appendChild(modal)
  }

  // Click handler for the Unmerge button inside the modal. Decodes the
  // variants list and kicks off the actual unmerge. Kept separate from
  // showMergeDetails for cleanliness.
  window.confirmUnmergeFromModal = (variantsAttr) => {
    let names
    try {
      names = JSON.parse(decodeURIComponent(escape(atob(variantsAttr))))
    } catch (err) {
      console.error('[confirmUnmergeFromModal] decode failed:', err)
      return
    }
    document.getElementById('merge-details-modal')?.remove()
    if (Array.isArray(names) && names.length) {
      unmergeIngredients(names)
    }
  }

  // Removes synonyms from both the DB and the in-memory map, then
  // re-renders so the rows split back out. fromNames are the ORIGINAL
  // ingredient names (not the canonical), since that's what the
  // synonyms table is keyed on.
  async function unmergeIngredients(fromNames) {
    if (!fromNames?.length) return
    const lowered = fromNames.map(n => String(n).toLowerCase().trim()).filter(Boolean)
    if (!lowered.length) return
    try {
      // Remove from in-memory first so the UI updates fast
      if (state.aiSynonyms) {
        for (const k of lowered) delete state.aiSynonyms[k]
      }
      // Then delete from DB. If this fails (offline, table missing),
      // the in-memory removal still lets the user see the unmerge
      // until next reload.
      try {
        await deleteIngredientSynonyms(state.user.id, lowered)
      } catch (err) {
        console.warn('[unmergeIngredients] DB delete failed:', err.message)
      }
      showToast(`Unmerged ${lowered.length} ingredient${lowered.length === 1 ? '' : 's'}`, 'success')
      renderPage()
    } catch (err) {
      console.error('[unmergeIngredients] failed:', err)
      showToast('Unmerge failed: ' + (err?.message || 'unknown'), 'error')
    }
  }

  // Legacy handlers — kept for compat
  window.toggleGroceryItem = () => {}
  window.editGroceryItem = () => {}
  window.removeGroceryItem = () => {}
  window.clearCheckedItems = () => {}

  window.addIngredientToMeal = (mealId, dayIdx) => {
    const ingredient = prompt('Add ingredient:')
    if (!ingredient) return
    const meal = state.planner.meals[dayIdx]?.find(m => m.id === mealId)
    if (!meal) return
    if (!meal.ingredients) meal.ingredients = []
    meal.ingredients.push(ingredient)
    renderPage()
  }

  // ── Leftover preview ────────────────────────────────────────────
  window.toggleLeftoverPreview = (checked) => {
    const preview = document.getElementById('leftover-preview')
    if (!preview || !state.plannerTarget) return
    if (checked) {
      const nextDay = (state.plannerTarget.dayIdx + 1) % 7
      document.getElementById('leftover-day-label').textContent = DAYS[nextDay] + ' lunch'
      preview.style.display = 'block'
    } else {
      preview.style.display = 'none'
    }
  }

  // ── Planner modal ───────────────────────────────────────────────
  window.setPlannerMealType = (type) => {
    state.plannerTarget = { ...state.plannerTarget, mealType: type }
    const input = document.getElementById('planner-meal-type')
    if (input) input.value = type
    // Update button styles
    document.querySelectorAll('[data-meal-type-btn]').forEach(btn => {
      const isActive = btn.dataset.mealTypeBtn === type
      btn.style.background = isActive ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg3)'
      btn.style.borderColor = isActive ? 'var(--accent)' : 'var(--border2)'
      btn.style.color = isActive ? 'var(--accent)' : 'var(--text3)'
    })
  }

  window.openPlannerModal = (dayIdx, mealType) => {
    state.plannerTarget = { dayIdx, mealType: mealType || 'dinner' }
    state.aiPlannerResult = null
    state.plannerImageBase64 = null
    const nextDay = (dayIdx + 1) % 7
    document.getElementById('planner-modal-title').textContent = `Add meal — ${DAYS[dayIdx]}`
    document.getElementById('planner-search').value = ''
    document.getElementById('leftover-check').checked = false
    document.getElementById('leftover-preview').style.display = 'none'
    document.getElementById('leftover-day-label').textContent = DAYS[nextDay] + ' lunch'
    document.getElementById('pm-ai-input').value = ''
    document.getElementById('pm-result').style.display = 'none'
    document.getElementById('pm-analyze-btn').disabled = false
    document.getElementById('pm-analyze-btn').textContent = 'Analyze with AI'
    // Set meal type selector if it exists
    const mtSel = document.getElementById('planner-meal-type')
    if (mtSel) mtSel.value = mealType || 'dinner'
    // Activate correct meal type button
    setTimeout(() => window.setPlannerMealType(mealType || 'dinner'), 0)
    // Reset photo panel
    const inner = document.getElementById('pm-upload-inner')
    if (inner) inner.innerHTML = '<div style="font-size:28px;margin-bottom:6px">📸</div><div style="font-size:13px;color:var(--text2)">Tap to upload a photo or screenshot</div><div style="font-size:11px;color:var(--text3);margin-top:3px">recipe card, screenshot, food photo</div>'
    const photoBtn = document.getElementById('pm-photo-analyze-btn')
    if (photoBtn) { photoBtn.style.display = 'none'; photoBtn.disabled = false; photoBtn.textContent = 'Analyze photo with AI' }
    const photoResult = document.getElementById('pm-photo-result')
    if (photoResult) photoResult.style.display = 'none'
    window.switchPlannerTab('history')
    filterPlannerList()
    document.getElementById('planner-modal').classList.add('open')
  }

  window.closePlannerModal = () => {
    document.getElementById('planner-modal').classList.remove('open')
    state.plannerTarget = null
    state.plannerImageBase64 = null
  }

  // ── Planner photo tab ──────────────────────────────────────────
  function wirePlannerFileInput() {
    const fi = document.getElementById('pm-file-input')
    const ua = document.getElementById('pm-upload-area')
    if (!fi || !ua || ua._wired) return
    ua._wired = true
    fi.addEventListener('change', e => { const f = e.target.files[0]; if (f) handlePlannerFile(f) })
    ua.addEventListener('dragover', e => { e.preventDefault(); ua.style.borderColor = 'var(--accent)' })
    ua.addEventListener('dragleave', () => { ua.style.borderColor = '' })
    ua.addEventListener('drop', e => { e.preventDefault(); ua.style.borderColor = ''; const f = e.dataTransfer.files[0]; if (f) handlePlannerFile(f) })
  }

  function handlePlannerFile(file) {
    const reader = new FileReader()
    reader.onload = ev => {
      state.plannerImageBase64 = ev.target.result.split(',')[1]
      const inner = document.getElementById('pm-upload-inner')
      if (inner) inner.innerHTML = '<img src="' + ev.target.result + '" style="width:100%;border-radius:var(--r);max-height:160px;object-fit:cover" alt="preview">'
      const btn = document.getElementById('pm-photo-analyze-btn')
      if (btn) btn.style.display = 'block'
      const result = document.getElementById('pm-photo-result')
      if (result) result.style.display = 'none'
    }
    reader.readAsDataURL(file)
  }

  window.analyzePlannerPhotoHandler = async () => {
    if (!state.plannerImageBase64) { showToast('Please upload a photo first', 'error'); return }
    const btn = document.getElementById('pm-photo-analyze-btn')
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="analyzing-spinner"></span> Analyzing...' }
    document.getElementById('pm-photo-result').style.display = 'none'
    try {
      const r = await analyzePhoto(state.plannerImageBase64, '')
      state.aiPlannerResult = r
      document.getElementById('pm-photo-result-name').textContent = r.name
      document.getElementById('pm-photo-result-pills').innerHTML =
        '<span class="pm-pill pill-cal">' + Math.round(r.calories) + ' kcal</span>' +
        '<span class="pm-pill pill-p">' + Math.round(r.protein) + 'g P</span>' +
        '<span class="pm-pill pill-c">' + Math.round(r.carbs) + 'g C</span>' +
        '<span class="pm-pill pill-f">' + Math.round(r.fat) + 'g F</span>' +
        (r.ingredients && r.ingredients.length ? '<span class="pm-pill" style="background:rgba(126,200,160,0.1);color:var(--protein);border-color:rgba(126,200,160,0.25)">' + r.ingredients.length + ' ingredients</span>' : '')
      document.getElementById('pm-photo-result').style.display = 'block'
    } catch (err) { showToast('Analysis failed: ' + err.message, 'error') }
    if (btn) { btn.disabled = false; btn.textContent = 'Analyze photo with AI' }
  }

  // ── Leftover collision prompt ──────────────────────────────────────
  // When the user tries to add a meal that's already planned fresh elsewhere
  // this week, give them a choice between "another fresh cook" (counts for
  // groceries) and "leftover from that cook" (skipped in grocery list).
  // Returns a Promise that resolves to:
  //   { leftover: false }  — user picked fresh cook (or no collision)
  //   { leftover: true }   — user picked leftover
  //   null                 — user cancelled
  async function promptLeftoverOnCollision(recipeIdOrName, { dayIdx, weekStart }) {
    if (!state.planner?.meals || !recipeIdOrName) return { leftover: false }
    // Find other non-leftover occurrences of this recipe in the current week,
    // excluding the day we're adding to.
    const matches = []
    state.planner.meals.forEach((dayMeals, di) => {
      if (!dayMeals) return
      dayMeals.forEach(m => {
        if (di === dayIdx) return
        if (m.is_leftover || m.leftover) return
        const matchById = m.recipe_id && String(m.recipe_id) === String(recipeIdOrName)
        const matchByName = !m.recipe_id && (m.meal_name || m.name || '').trim().toLowerCase() ===
                             (typeof recipeIdOrName === 'string' ? recipeIdOrName : '').trim().toLowerCase()
        if (matchById || matchByName) {
          matches.push({ dayLabel: DAYS[di], dayIdx: di, meal: m })
        }
      })
    })
    if (!matches.length) return { leftover: false }

    // Render a choice modal. Uses the existing modal-overlay pattern so we
    // don't add a new DOM node.
    return new Promise(resolve => {
      const existingList = matches.map(m =>
        `<span style="font-weight:500;color:var(--text)">${m.dayLabel}</span>`
      ).join(', ')
      const firstMatch = matches[0]
      const targetDayLabel = DAYS[dayIdx]

      // Create a transient overlay so we don't collide with whatever modals
      // are currently open
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px'
      overlay.innerHTML = `
        <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r3);padding:22px;width:100%;max-width:400px">
          <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--text);margin-bottom:6px">Heads up — you've already planned this</div>
          <div style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:16px">
            <strong style="color:var(--text)">${esc(firstMatch.meal.meal_name || firstMatch.meal.name || 'This recipe')}</strong>
            is already planned for ${existingList}. How should we handle <strong style="color:var(--text)">${targetDayLabel}</strong>?
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button type="button" data-choice="fresh"
              style="padding:12px 14px;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--r);font-family:inherit;font-size:13px;cursor:pointer;text-align:left;transition:border-color 0.15s">
              <div style="font-weight:600;margin-bottom:2px">🍳 Fresh cook</div>
              <div style="font-size:11px;color:var(--text3);line-height:1.4">Shop for full ingredients again — this is a separate cooking session.</div>
            </button>
            <button type="button" data-choice="leftover"
              style="padding:12px 14px;background:rgba(122,180,232,0.08);color:var(--text);border:1px solid rgba(122,180,232,0.3);border-radius:var(--r);font-family:inherit;font-size:13px;cursor:pointer;text-align:left;transition:border-color 0.15s">
              <div style="font-weight:600;margin-bottom:2px">🥡 Leftovers from ${firstMatch.dayLabel}</div>
              <div style="font-size:11px;color:var(--text3);line-height:1.4">Ingredients already covered by the ${firstMatch.dayLabel} cook — won't appear on your grocery list.</div>
            </button>
            <button type="button" data-choice="cancel"
              style="padding:10px;background:transparent;color:var(--text3);border:1px solid var(--border);border-radius:var(--r);font-family:inherit;font-size:12px;cursor:pointer;margin-top:4px">
              Cancel
            </button>
          </div>
        </div>
      `
      document.body.appendChild(overlay)
      overlay.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-choice]')
        if (btn) {
          const choice = btn.dataset.choice
          document.body.removeChild(overlay)
          if (choice === 'cancel') resolve(null)
          else resolve({ leftover: choice === 'leftover' })
        } else if (e.target === overlay) {
          // Clicking outside cancels
          document.body.removeChild(overlay)
          resolve(null)
        }
      })
    })
  }

  window.addPhotoMealToPlannerHandler = async () => {
    if (!state.plannerTarget || !state.aiPlannerResult) return
    const r = state.aiPlannerResult
    const addAsLeftover = document.getElementById('leftover-check').checked
    const dayIdx = state.plannerTarget.dayIdx
    const mealType = state.plannerTarget.mealType || document.getElementById('planner-meal-type')?.value || 'dinner'

    // Only prompt if the user isn't already explicitly marking this as a leftover
    let isLeftoverFromPrompt = false
    if (!addAsLeftover) {
      const choice = await promptLeftoverOnCollision(r.recipe_id || r.name, { dayIdx, weekStart: state.weekStart })
      if (choice === null) return
      isLeftoverFromPrompt = choice.leftover
    }

    try {
      const meal = await addPlannerMeal(state.user.id, state.weekStart, dayIdx, {
        ...r, meal_type: mealType, leftover: isLeftoverFromPrompt
      })
      state.planner.meals[dayIdx].push(meal)
      if (r.ingredients && r.ingredients.length) {
        getRecipeByName(state.user.id, r.name).then(existing => {
          if (!existing) upsertRecipe(state.user.id, {
            name: r.name, description: r.description || '', servings: r.servings || 1,
            calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat,
            fiber: r.fiber || 0, sugar: r.sugar || 0, ingredients: r.ingredients,
            source: 'ai_photo', confidence: r.confidence
          }).then(recipe => state.recipes.unshift(recipe)).catch(() => {})
        }).catch(() => {})
      }
      if (addAsLeftover) {
        const nextDay = (dayIdx + 1) % 7
        const leftover = await addPlannerMeal(state.user.id, state.weekStart, nextDay, {
          ...r, name: r.name + ' (leftovers)'
        })
        state.planner.meals[nextDay].push(leftover)
        showToast(r.name + ' added to ' + DAYS[dayIdx] + ' + ' + DAYS[nextDay] + ' lunch!', 'success')
      } else {
        const suffix = isLeftoverFromPrompt ? ' as leftovers' : ''
        showToast(r.name + ' added to ' + DAYS[dayIdx] + suffix + '!', 'success')
      }
      state.plannerImageBase64 = null
      state.groceryItems = null
      closePlannerModal()
      renderPage()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.switchPlannerTab = (tab) => {
    state.plannerTab = tab
    document.getElementById('pm-tab-history').classList.toggle('active', tab === 'history')
    document.getElementById('pm-tab-ai').classList.toggle('active', tab === 'ai')
    document.getElementById('pm-tab-photo').classList.toggle('active', tab === 'photo')
    document.getElementById('pm-panel-history').classList.toggle('active', tab === 'history')
    document.getElementById('pm-panel-ai').classList.toggle('active', tab === 'ai')
    document.getElementById('pm-panel-photo').classList.toggle('active', tab === 'photo')
    // Wire up file input when photo tab is shown
    if (tab === 'photo') wirePlannerFileInput()
  }

  window.filterPlannerList = filterPlannerList

  window.analyzePlannerMealHandler = async () => {
    const input = document.getElementById('pm-ai-input')?.value.trim()
    if (!input) { showToast('Please describe the meal first', 'error'); return }
    const btn = document.getElementById('pm-analyze-btn')
    btn.disabled = true
    btn.innerHTML = '<span class="analyzing-spinner"></span> Analyzing...'
    document.getElementById('pm-result').style.display = 'none'
    try {
      const r = await analyzePlannerDescription(input)
      state.aiPlannerResult = r
      document.getElementById('pm-result-name').textContent = r.name
      document.getElementById('pm-result-pills').innerHTML = `
        <span class="pm-pill pill-cal">${Math.round(r.calories)} kcal</span>
        <span class="pm-pill pill-p">${Math.round(r.protein)}g P</span>
        <span class="pm-pill pill-c">${Math.round(r.carbs)}g C</span>
        <span class="pm-pill pill-f">${Math.round(r.fat)}g F</span>
      `
      document.getElementById('pm-result').style.display = 'block'
    } catch (err) { showToast('Analysis failed: ' + err.message, 'error') }
    btn.disabled = false
    btn.textContent = 'Analyze with AI'
  }

  window.addAiMealToPlannerHandler = async () => {
    if (!state.plannerTarget || !state.aiPlannerResult) return
    const r = state.aiPlannerResult
    const addAsLeftover = document.getElementById('leftover-check').checked
    const dayIdx = state.plannerTarget.dayIdx

    let isLeftoverFromPrompt = false
    if (!addAsLeftover) {
      const choice = await promptLeftoverOnCollision(r.recipe_id || r.name, { dayIdx, weekStart: state.weekStart })
      if (choice === null) return
      isLeftoverFromPrompt = choice.leftover
    }

    try {
      // Add to selected day
      const meal = await addPlannerMeal(state.user.id, state.weekStart, dayIdx, {
        ...r, leftover: isLeftoverFromPrompt
      })
      state.planner.meals[dayIdx].push(meal)
      // If leftovers checked, also add to next day as lunch
      if (addAsLeftover) {
        const nextDay = (dayIdx + 1) % 7
        const leftoverMeal = await addPlannerMeal(state.user.id, state.weekStart, nextDay, {
          ...r, name: r.name + ' (leftovers)', meal_name: (r.meal_name || r.name) + ' (leftovers)'
        })
        state.planner.meals[nextDay].push(leftoverMeal)
        showToast(`Added to ${DAYS[dayIdx]} + ${DAYS[nextDay]} lunch!`, 'success')
      } else {
        const suffix = isLeftoverFromPrompt ? ' as leftovers' : ''
        showToast(`${r.name} added to ${DAYS[dayIdx]}${suffix}!`, 'success')
      }
      // Reset grocery list so it picks up the new meal
      state.groceryItems = null
      closePlannerModal()
      renderPage()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.deletePlannerMealHandler = async (id, d, m) => {
    try {
      await deletePlannerMeal(state.user.id, id)
      state.planner.meals[d].splice(m, 1)
      state.groceryItems = null
      state.excludedIngredients = new Set()
      renderPage()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  // ── Move planner meal (drag + drop + tap menu) ───────────────────
  // Perform the actual move: call DB, then reload the current week so
  // the meal appears on its new day. If the target date is in a different
  // Sunday-week, navigate there so the user sees the result.
  //
  // If the moved meal is a "source" (recipe_id present, not a leftover),
  // any linked leftovers (same recipe_id, is_leftover: true, later date)
  // are shifted by the same delta so their day-gap is preserved.
  async function performMovePlannerMeal(mealId, targetDate) {
    const current = localDateStr(new Date(state.weekStart + 'T00:00:00'))
    try {
      // Find the source meal's original date + recipe_id so we know what
      // to do with its linked leftovers (if any).
      const sourceMeal = findPlannerMealById(mealId)
      const originalDate = sourceMeal?.actual_date || null
      const recipeId = sourceMeal?.recipe_id || null
      const sourceIsLeftover = !!sourceMeal?.is_leftover

      // Find linked leftovers we need to shift along.
      // Only apply when moving the NON-leftover source meal; if a user drags
      // a leftover card itself, we only move that one.
      let linkedLeftovers = []
      if (recipeId && !sourceIsLeftover && originalDate) {
        linkedLeftovers = findLinkedLeftovers(recipeId, originalDate, mealId)
      }

      // Move the source
      await movePlannerMeal(state.user.id, mealId, targetDate)

      // Shift each linked leftover by the same delta (in days)
      if (linkedLeftovers.length > 0) {
        const [oy, om, od] = originalDate.split('-').map(Number)
        const [ty, tm, td] = targetDate.split('-').map(Number)
        const origD = new Date(oy, om - 1, od)
        const tgtD = new Date(ty, tm - 1, td)
        const deltaDays = Math.round((tgtD - origD) / (1000 * 60 * 60 * 24))
        const pad = n => String(n).padStart(2, '0')
        await Promise.all(linkedLeftovers.map(async (lo) => {
          if (!lo.actual_date) return
          const [ly, lm, ld] = lo.actual_date.split('-').map(Number)
          const newD = new Date(ly, lm - 1, ld + deltaDays)
          const newDateStr = `${newD.getFullYear()}-${pad(newD.getMonth()+1)}-${pad(newD.getDate())}`
          try { await movePlannerMeal(state.user.id, lo.id, newDateStr) } catch {}
        }))
      }

      // Compute the Sunday-week containing targetDate
      const [ty, tm, td] = targetDate.split('-').map(Number)
      const tDate = new Date(ty, tm - 1, td)
      const sunDate = new Date(tDate)
      sunDate.setDate(sunDate.getDate() - sunDate.getDay())
      const pad2 = n => String(n).padStart(2, '0')
      const targetWeek = `${sunDate.getFullYear()}-${pad2(sunDate.getMonth()+1)}-${pad2(sunDate.getDate())}`
      if (targetWeek !== current) state.weekStart = targetWeek
      // Reload planner for the week now being viewed
      const planner = await getPlannerWeek(state.user.id, state.weekStart)
      if (planner) state.planner = planner
      state.groceryItems = null
      renderPage()
      const fmt = tDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      if (linkedLeftovers.length > 0) {
        showToast(`Moved to ${fmt} (+ ${linkedLeftovers.length} leftover${linkedLeftovers.length===1?'':'s'})`, 'success')
      } else {
        showToast(`Moved to ${fmt}`, 'success')
      }
    } catch (err) {
      showToast('Error moving meal: ' + err.message, 'error')
    }
  }

  // Find planner meals that are leftovers of a given recipe, scheduled later
  // than the source meal's original date. Searches both the currently-loaded
  // week and the next week (since leftovers often span across weeks).
  function findLinkedLeftovers(recipeId, sourceOriginalDate, sourceMealId) {
    const results = []
    if (!state.planner?.meals) return results
    for (const day of state.planner.meals) {
      for (const m of (day || [])) {
        if (String(m.id) === String(sourceMealId)) continue
        if (!m.recipe_id || m.recipe_id !== recipeId) continue
        if (!m.is_leftover) continue
        if (!m.actual_date || m.actual_date <= sourceOriginalDate) continue
        results.push(m)
      }
    }
    return results
  }

  // — Drag and drop —
  window.handlePlannerDragStart = (ev, mealId) => {
    try {
      ev.dataTransfer.effectAllowed = 'move'
      ev.dataTransfer.setData('text/plain', String(mealId))
      // Store on window as a fallback since some browsers don't expose dataTransfer
      // during dragover for security, so drop targets can't read it to highlight
      window._draggingMealId = mealId
      if (ev.currentTarget?.style) ev.currentTarget.style.opacity = '0.5'
    } catch {}
  }

  window.handlePlannerDragEnd = (ev) => {
    window._draggingMealId = null
    if (ev.currentTarget?.style) ev.currentTarget.style.opacity = '1'
    // Clear any lingering drop-target highlights
    document.querySelectorAll('[data-planner-day]').forEach(el => {
      el.style.outline = ''
      el.style.outlineOffset = ''
    })
  }

  window.handlePlannerDragOver = (ev, el) => {
    if (!window._draggingMealId) return
    ev.preventDefault()
    ev.dataTransfer.dropEffect = 'move'
    el.style.outline = '2px solid var(--accent)'
    el.style.outlineOffset = '-2px'
  }

  window.handlePlannerDragLeave = (ev, el) => {
    // Only clear highlight if we're leaving the element itself (not entering a child)
    if (el.contains(ev.relatedTarget)) return
    el.style.outline = ''
    el.style.outlineOffset = ''
  }

  window.handlePlannerDrop = async (ev, targetDate, el) => {
    ev.preventDefault()
    el.style.outline = ''
    el.style.outlineOffset = ''
    const mealId = ev.dataTransfer.getData('text/plain') || window._draggingMealId
    window._draggingMealId = null
    if (!mealId) return
    // Don't move if dropped on the same day it came from
    const meal = findPlannerMealById(mealId)
    if (meal?.actual_date === targetDate) return
    await performMovePlannerMeal(mealId, targetDate)
  }

  function findPlannerMealById(mealId) {
    if (!state.planner?.meals) return null
    for (const day of state.planner.meals) {
      const found = (day || []).find(m => String(m.id) === String(mealId))
      if (found) return found
    }
    return null
  }

  // — Tap-to-move menu (mobile-friendly) —
  // Shows a small popup anchored to the button with a date picker and
  // quick-select day buttons for the current week.
  window.openMovePlannerMealMenu = (mealId, currentDate, anchor) => {
    closeMovePlannerMealMenu() // close any existing

    const menu = document.createElement('div')
    menu.id = 'move-meal-menu'
    menu.style.cssText = `
      position:absolute;z-index:1000;background:var(--bg2);border:1px solid var(--border2);
      border-radius:var(--r);box-shadow:0 8px 24px rgba(0,0,0,0.4);padding:10px;
      min-width:220px;max-width:280px;font-family:inherit;font-size:13px
    `

    // Compute the current week's days (Sun..Sat) for quick-pick buttons
    const ws = new Date(state.weekStart + 'T00:00:00')
    const pad = n => String(n).padStart(2, '0')
    const daysHtml = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(ws); d.setDate(d.getDate() + i)
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
      const label = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
      const isCurrent = dateStr === currentDate
      return `<button onclick="confirmMovePlannerMeal('${mealId}', '${dateStr}')"
        ${isCurrent ? 'disabled' : ''}
        style="display:block;width:100%;text-align:left;padding:7px 10px;margin-bottom:2px;
               background:${isCurrent ? 'var(--bg3)' : 'transparent'};color:${isCurrent ? 'var(--text3)' : 'var(--text)'};
               border:none;border-radius:6px;font-family:inherit;font-size:12px;
               cursor:${isCurrent ? 'default' : 'pointer'};opacity:${isCurrent ? '0.5' : '1'}">
        ${label}${isCurrent ? ' · current' : ''}
      </button>`
    }).join('')

    menu.innerHTML = `
      <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;padding:0 4px">Move to</div>
      ${daysHtml}
      <div style="border-top:1px solid var(--border);margin:8px 0 6px"></div>
      <div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;padding:0 4px">Pick any date</div>
      <input type="date" id="move-meal-date-input" value="${currentDate}"
        style="width:100%;padding:7px 8px;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;font-family:inherit;font-size:12px" />
      <button onclick="confirmMovePlannerMealFromInput('${mealId}', '${currentDate}')"
        style="width:100%;margin-top:6px;padding:8px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:6px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer">
        Move
      </button>
    `

    // Position below the anchor
    const rect = anchor.getBoundingClientRect()
    document.body.appendChild(menu)
    // Adjust if it would go off-screen
    const menuRect = menu.getBoundingClientRect()
    let top = rect.bottom + window.scrollY + 4
    let left = rect.right + window.scrollX - menuRect.width
    if (left < 8) left = 8
    if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8
    // If it would overflow bottom, flip above
    if (rect.bottom + menuRect.height > window.innerHeight) {
      top = rect.top + window.scrollY - menuRect.height - 4
    }
    menu.style.top = `${top}px`
    menu.style.left = `${left}px`

    // Close on outside click / Escape
    setTimeout(() => {
      document.addEventListener('click', handleMoveMenuOutsideClick, { once: false })
      document.addEventListener('keydown', handleMoveMenuEscape)
    }, 0)
  }

  function handleMoveMenuOutsideClick(ev) {
    const menu = document.getElementById('move-meal-menu')
    if (!menu) { document.removeEventListener('click', handleMoveMenuOutsideClick); return }
    if (!menu.contains(ev.target)) closeMovePlannerMealMenu()
  }

  function handleMoveMenuEscape(ev) {
    if (ev.key === 'Escape') closeMovePlannerMealMenu()
  }

  function closeMovePlannerMealMenu() {
    const menu = document.getElementById('move-meal-menu')
    if (menu) menu.remove()
    document.removeEventListener('click', handleMoveMenuOutsideClick)
    document.removeEventListener('keydown', handleMoveMenuEscape)
  }

  window.confirmMovePlannerMeal = async (mealId, targetDate) => {
    closeMovePlannerMealMenu()
    await performMovePlannerMeal(mealId, targetDate)
  }

  window.confirmMovePlannerMealFromInput = async (mealId, currentDate) => {
    const input = document.getElementById('move-meal-date-input')
    const target = input?.value
    if (!target) { showToast('Pick a date', 'error'); return }
    if (target === currentDate) { closeMovePlannerMealMenu(); return }
    closeMovePlannerMealMenu()
    await performMovePlannerMeal(mealId, target)
  }

  // ── Recipe handlers ─────────────────────────────────────────────
  window.handleCookbookPhoto = async (file) => {
    if (!file) return
    const status = document.getElementById('cookbook-status')
    const spinner = document.getElementById('cookbook-spinner')
    if (status) status.textContent = 'Reading recipe...'
    if (spinner) spinner.style.display = 'inline'

    try {
      // Resize before sending (cookbook photos can be large)
      const dataUrl = await new Promise((res, rej) => {
        const reader = new FileReader()
        reader.onload = e => res(e.target.result)
        reader.onerror = rej
        reader.readAsDataURL(file)
      })
      const b64 = await new Promise((res) => {
        const img = new Image()
        img.onload = () => {
          const MAX = 1500
          let { width: w, height: h } = img
          if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w*s); h = Math.round(h*s) }
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          canvas.getContext('2d').drawImage(img, 0, 0, w, h)
          res(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
        }
        img.src = dataUrl
      })

      const extracted = await Promise.race([
        extractRecipeFromPhoto(b64),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
      ])

      if (!extracted || !extracted.name) {
        if (status) status.textContent = 'Could not read recipe — fill in manually'
        if (spinner) spinner.style.display = 'none'
        return
      }

      // Update the editing recipe in state
      state.editingRecipe = {
        ...state.editingRecipe,
        name: extracted.name || '',
        description: extracted.description || '',
        servings: extracted.servings || 4,
        serving_label: extracted.serving_label || 'serving',
        ingredients: (extracted.ingredients || []).map(ing => ({
          amount: String(ing.amount || ''),
          unit: ing.unit || '',
          name: ing.name || '',
        })),
        instructions: extracted.instructions
          ? { steps: extracted.instructions, prep_time: extracted.prep_time, cook_time: extracted.cook_time }
          : null,
        notes: extracted.notes || '',
      }

      // Re-render the modal with extracted data
      document.getElementById('recipe-modal-content').innerHTML =
        renderRecipeModalContent(state.editingRecipe, 'edit')

      showToast(`"${extracted.name}" extracted — review and save`, 'success')

    } catch (err) {
      if (status) status.textContent = 'Extraction failed — fill in manually'
      if (spinner) spinner.style.display = 'none'
    }
  }

  window.openNewRecipeModal = () => {
    state.editingRecipe = { name: '', description: '', servings: 4, serving_label: 'serving', calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, ingredients: [], tags: [] }
    // Reset tag editor state so a previous recipe's selection doesn't leak
    window._editingTags = new Set()
    window._editingTagsDisplay = {}
    // Show method picker instead of jumping straight to form
    document.getElementById('recipe-modal-content').innerHTML = `
      <div style="position:relative">
        <button class="modal-close" onclick="closeRecipeModal()" style="position:absolute;top:12px;right:12px">×</button>
        <div style="padding:28px 20px 24px">
          <div style="font-family:'DM Serif Display',serif;font-size:22px;color:var(--text);margin-bottom:6px">Add a recipe</div>
          <div style="font-size:13px;color:var(--text3);margin-bottom:24px">How do you want to add it?</div>

          <!-- Option 1: Link -->
          <button onclick="openNewRecipeFromLink()"
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:14px;cursor:pointer;text-align:left;font-family:inherit"
            onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
            <div style="width:44px;height:44px;background:color-mix(in srgb, var(--accent) 12%, transparent);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:22px">🔗</div>
            <div>
              <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:3px">Paste a link</div>
              <div style="font-size:12px;color:var(--text3)">Recipe website, blog, or YouTube — AI extracts the recipe</div>
            </div>
            <span style="margin-left:auto;color:var(--text3);font-size:18px">›</span>
          </button>

          <!-- Option 2: Photo (camera OR library)
               Omitting capture= lets iOS/Android show the full picker:
               Take Photo, Photo Library, Choose File. Previous version
               forced the camera, which was hostile to users who already
               had a screenshot/saved image they wanted to use. -->
          <button onclick="document.getElementById('new-recipe-photo-input').click()"
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:14px;cursor:pointer;text-align:left;font-family:inherit"
            onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
            <div style="width:44px;height:44px;background:rgba(76,175,130,0.12);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:22px">📸</div>
            <div>
              <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:3px">Upload a photo</div>
              <div style="font-size:12px;color:var(--text3)">Take a new photo or pick a screenshot — cookbook, recipe card, anything</div>
            </div>
            <span style="margin-left:auto;color:var(--text3);font-size:18px">›</span>
          </button>
          <input type="file" id="new-recipe-photo-input" accept="image/*" style="display:none"
            onchange="openNewRecipeFromPhoto(this.files[0])" />

          <!-- Option 3: Manual -->
          <button onclick="openNewRecipeManual()"
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:14px;cursor:pointer;text-align:left;font-family:inherit"
            onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
            <div style="width:44px;height:44px;background:rgba(91,156,246,0.12);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:22px">✏️</div>
            <div>
              <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:3px">Add manually</div>
              <div style="font-size:12px;color:var(--text3)">Type or paste ingredients — AI parses them instantly</div>
            </div>
            <span style="margin-left:auto;color:var(--text3);font-size:18px">›</span>
          </button>

          <!-- Option 4: Generate from mood -->
          <button onclick="openNewRecipeGenerate()"
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:16px;display:flex;align-items:center;gap:14px;cursor:pointer;text-align:left;font-family:inherit"
            onmouseover="this.style.borderColor='var(--fat)'" onmouseout="this.style.borderColor='var(--border2)'">
            <div style="width:44px;height:44px;background:rgba(245,146,78,0.12);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:22px">✨</div>
            <div>
              <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:3px">Generate a recipe</div>
              <div style="font-size:12px;color:var(--text3)">Tell me what's in your fridge or what you're craving</div>
            </div>
            <span style="margin-left:auto;color:var(--text3);font-size:18px">›</span>
          </button>
        </div>
      </div>
    `
    document.getElementById('recipe-modal').classList.add('open')
  }

  window.openNewRecipeFromLink = () => {
    document.getElementById('recipe-modal-content').innerHTML = `
      <div style="position:relative">
        <button class="modal-close" onclick="closeRecipeModal()" style="position:absolute;top:12px;right:12px">×</button>
        <div style="padding:28px 20px 24px">
          <button onclick="openNewRecipeModal()" style="background:none;border:none;color:var(--text3);font-size:13px;font-family:inherit;cursor:pointer;padding:0;margin-bottom:16px;display:flex;align-items:center;gap:4px">
            ← Back
          </button>
          <div style="font-family:'DM Serif Display',serif;font-size:22px;color:var(--text);margin-bottom:6px">Paste a link</div>
          <div style="font-size:13px;color:var(--text3);margin-bottom:20px">Recipe websites, blogs, and YouTube videos work. Instagram and TikTok links are private — use the dish name field below for those.</div>
          <input type="url" id="new-recipe-url" placeholder="https://..." autofocus
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:12px 14px;color:var(--text);font-size:15px;font-family:inherit;outline:none;margin-bottom:10px"
            oninput="checkImportLinkHint(this.value)"
            onkeydown="if(event.key==='Enter')importRecipeFromLink()" />

          <!-- Dynamic warning box — appears only when user pastes an
               Instagram or TikTok URL. Same behavior as the Write-it
               textarea hint so users learn the pattern consistently. -->
          <div id="import-link-private-hint" style="display:none;margin-bottom:16px;padding:10px 12px;border-radius:var(--r);background:color-mix(in srgb, var(--accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--accent) 25%, transparent);font-size:12px;color:var(--text2);line-height:1.45">
            <div style="font-weight:600;color:var(--accent);margin-bottom:4px">📱 <span id="import-link-private-platform">Instagram</span> links are private</div>
            <div style="margin-bottom:4px">We can't read reel content directly. Instead:</div>
            <ul style="margin:0;padding-left:18px">
              <li>Type the dish name below (e.g. <em>"viral baked feta pasta"</em>) — leave the URL or clear it, either works</li>
              <li>Or close this and use <strong>Take a photo</strong> to capture the ingredient list from a screenshot</li>
            </ul>
          </div>

          <div style="font-size:12px;color:var(--text3);margin-bottom:20px">Or describe the dish name to search for it</div>
          <input type="text" id="new-recipe-dish" placeholder="e.g. Chicken tikka masala..."
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:12px 14px;color:var(--text);font-size:15px;font-family:inherit;outline:none;margin-bottom:20px"
            onkeydown="if(event.key==='Enter')importRecipeFromLink()" />
          <button onclick="importRecipeFromLink()" id="import-link-btn"
            style="width:100%;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);padding:14px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer">
            Import recipe
          </button>
          <div id="import-link-status" style="font-size:12px;color:var(--text3);margin-top:10px;text-align:center;min-height:18px"></div>
        </div>
      </div>
    `
  }

  window.importRecipeFromLink = async () => {
    const url = document.getElementById('new-recipe-url')?.value.trim()
    const dish = document.getElementById('new-recipe-dish')?.value.trim()
    if (!url && !dish) { showToast('Enter a link or dish name', 'error'); return }
    const btn = document.getElementById('import-link-btn')
    const status = document.getElementById('import-link-status')
    if (btn) { btn.disabled = true; btn.textContent = 'Importing...' }
    if (status) { status.style.color = 'var(--text3)'; status.textContent = 'Searching for recipe...' }
    try {
      const result = await analyzeDishBySearch(dish || url, url)
      if (!result) throw new Error('No recipe found in the response')
      state.editingRecipe = { ...state.editingRecipe, ...result, source_url: url || '' }
      document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'edit')
      showToast('Recipe imported — review and save', 'success')
    } catch (err) {
      // Surface the error everywhere so it's impossible to miss AND so we
      // get log breadcrumbs. Previous version swallowed the error to an
      // inline status line that was easy to miss, and didn't record
      // anything to error_logs — which made "silent fail" reports
      // impossible to debug.
      const msg = err?.message || 'Unknown error'
      console.error('[importRecipeFromLink] failed:', err)
      logError(state.user?.id, err, {
        context: 'import_recipe_from_link',
        page: state.currentPage,
        url: url || null,
        dish: dish || null,
      })
      if (status) {
        status.style.color = 'var(--red)'
        status.textContent = 'Could not import: ' + msg
      }
      showToast('Could not import recipe: ' + msg, 'error')
      if (btn) { btn.disabled = false; btn.textContent = 'Import recipe' }
    }
  }

  window.openNewRecipeFromPhoto = async (file) => {
    if (!file) return
    // Show loading screen
    document.getElementById('recipe-modal-content').innerHTML = `
      <div style="padding:60px 20px;text-align:center">
        <div style="font-size:40px;margin-bottom:16px">📖</div>
        <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:8px">Reading recipe...</div>
        <div style="font-size:13px;color:var(--text3)">AI is extracting ingredients and instructions</div>
        <div style="margin-top:20px"><span class="analyzing-spinner"></span></div>
      </div>
    `
    try {
      // Resize image
      const dataUrl = await new Promise((res, rej) => {
        const reader = new FileReader(); reader.onload = e => res(e.target.result); reader.onerror = rej; reader.readAsDataURL(file)
      })
      const b64 = await new Promise(res => {
        const img = new Image()
        img.onload = () => {
          const MAX = 1500
          let { width: w, height: h } = img
          if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w*s); h = Math.round(h*s) }
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          canvas.getContext('2d').drawImage(img, 0, 0, w, h)
          res(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
        }
        img.src = dataUrl
      })
      const extracted = await Promise.race([
        extractRecipeFromPhoto(b64),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))
      ])
      if (!extracted?.name) throw new Error('Could not read recipe')
      state.editingRecipe = {
        ...state.editingRecipe,
        name: extracted.name || '',
        description: extracted.description || '',
        servings: extracted.servings || 4,
        ingredients: (extracted.ingredients || []).map(i => ({ amount: String(i.amount||''), unit: i.unit||'', name: i.name||'' })),
        instructions: extracted.instructions ? { steps: extracted.instructions, prep_time: extracted.prep_time, cook_time: extracted.cook_time } : null,
        notes: extracted.notes || '',
      }
      document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'edit')
      showToast(`"${extracted.name}" extracted — review and save`, 'success')
    } catch (err) {
      // Fall back to manual form with error message
      document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'edit')
      showToast('Could not read photo — fill in manually', 'error')
    }
  }

  window.openNewRecipeManual = () => {
    // Show a pre-step for pasting ingredients before going to full form
    document.getElementById('recipe-modal-content').innerHTML = `
      <div style="position:relative">
        <button class="modal-close" onclick="closeRecipeModal()" style="position:absolute;top:12px;right:12px">×</button>
        <div style="padding:28px 20px 24px">
          <button onclick="openNewRecipeModal()" style="background:none;border:none;color:var(--text3);font-size:13px;font-family:inherit;cursor:pointer;padding:0;margin-bottom:16px;display:flex;align-items:center;gap:4px">
            ← Back
          </button>
          <div style="font-family:'DM Serif Display',serif;font-size:22px;color:var(--text);margin-bottom:6px">Add manually</div>
          <div style="font-size:13px;color:var(--text3);margin-bottom:20px">Paste your ingredient list and AI will parse it, or skip to fill in manually.</div>

          <label style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:8px">Paste ingredients (optional)</label>
          <textarea id="paste-ingredients-input" rows="6" placeholder="Paste or type your ingredient list here, one per line or comma separated:

2 cups chicken broth
1 lb chicken breast
3 cloves garlic, minced
1 tsp cumin
..."
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:12px 14px;color:var(--text);font-size:13px;font-family:inherit;outline:none;resize:none;margin-bottom:12px;line-height:1.5"></textarea>

          <div style="display:flex;flex-direction:column;gap:10px">
            <button onclick="parseAndOpenManual()" id="parse-ing-btn"
              style="width:100%;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);padding:14px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer">
              Parse ingredients & continue →
            </button>
            <button onclick="openNewRecipeManualBlank()"
              style="width:100%;background:var(--bg3);color:var(--text3);border:1px solid var(--border2);border-radius:var(--r);padding:12px;font-size:14px;font-family:inherit;cursor:pointer">
              Skip — fill in manually
            </button>
          </div>
          <div id="parse-ing-status" style="font-size:12px;color:var(--text3);margin-top:10px;text-align:center;min-height:18px"></div>
        </div>
      </div>
    `
  }

  window.parseAndOpenManual = async () => {
    const text = document.getElementById('paste-ingredients-input')?.value.trim()
    if (!text) { openNewRecipeManualBlank(); return }
    const btn = document.getElementById('parse-ing-btn')
    const status = document.getElementById('parse-ing-status')
    if (btn) { btn.disabled = true; btn.textContent = 'Parsing...' }
    if (status) status.textContent = 'AI is parsing your ingredients...'
    try {
      const result = await extractIngredients(text)
      if (result?.ingredients?.length) {
        state.editingRecipe = { ...state.editingRecipe, ingredients: result.ingredients }
        showToast(`${result.ingredients.length} ingredients parsed`, 'success')
      }
      document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'edit')
    } catch {
      if (status) status.textContent = 'Parse failed — opening blank form'
      setTimeout(() => openNewRecipeManualBlank(), 1000)
    }
  }

  window.openNewRecipeManualBlank = () => {
    document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'edit')
  }

  window.openNewRecipeGenerate = () => {
    document.getElementById('recipe-modal-content').innerHTML = `
      <div style="position:relative">
        <button class="modal-close" onclick="closeRecipeModal()" style="position:absolute;top:12px;right:12px">×</button>
        <div style="padding:28px 20px 24px">
          <button onclick="openNewRecipeModal()" style="background:none;border:none;color:var(--text3);font-size:13px;font-family:inherit;cursor:pointer;padding:0;margin-bottom:16px;display:flex;align-items:center;gap:4px">
            ← Back
          </button>
          <div style="font-family:'DM Serif Display',serif;font-size:22px;color:var(--text);margin-bottom:6px">✨ Generate a recipe</div>
          <div style="font-size:13px;color:var(--text3);margin-bottom:20px">Tell me what you have, what you're craving, or both.</div>

          <label style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:8px">What are you working with?</label>
          <textarea id="generate-recipe-input" rows="5" autofocus
            placeholder="Examples:
• chicken breast, rice, bell peppers, garlic — make something spicy
• I'm in the mood for something cozy and Italian
• high protein meal under 600 calories with what I have: eggs, spinach, feta
• leftover salmon, need lunch ideas"
            style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:12px 14px;color:var(--text);font-size:13px;font-family:inherit;outline:none;resize:none;margin-bottom:8px;line-height:1.5"></textarea>

          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
            ${['🍗 High protein','🥗 Low carb','⚡ Under 30 min','🌶️ Spicy','🇮🇹 Italian','🌮 Mexican'].map(tag =>
              `<button onclick="appendToGenerate('${tag.replace(/'/g,"\\'")}');event.stopPropagation()"
                style="background:var(--bg3);border:1px solid var(--border2);border-radius:20px;padding:5px 10px;font-size:12px;color:var(--text3);cursor:pointer;font-family:inherit">
                ${tag}
              </button>`
            ).join('')}
          </div>

          <button onclick="generateRecipeFromPrompt()" id="generate-recipe-btn"
            style="width:100%;background:var(--fat);color:var(--accent-fg);border:none;border-radius:var(--r);padding:14px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer">
            ✨ Generate recipe
          </button>
          <div id="generate-recipe-status" style="font-size:12px;color:var(--text3);margin-top:10px;text-align:center;min-height:18px"></div>
        </div>
      </div>
    `
  }

  window.appendToGenerate = (tag) => {
    const el = document.getElementById('generate-recipe-input')
    if (!el) return
    const clean = tag.replace(/^[^\s]+\s/, '') // strip emoji
    el.value = el.value ? el.value + ', ' + clean : clean
    el.focus()
  }

  window.generateRecipeFromPrompt = async () => {
    const prompt = document.getElementById('generate-recipe-input')?.value.trim()
    if (!prompt) { showToast('Tell me what you want to make', 'error'); return }
    const btn = document.getElementById('generate-recipe-btn')
    const status = document.getElementById('generate-recipe-status')
    if (btn) { btn.disabled = true; btn.textContent = '✨ Generating...' }
    if (status) status.textContent = 'Creating your recipe...'
    try {
      const result = await generateRecipeFromMood(prompt)
      if (!result?.name) throw new Error('No recipe generated')
      state.editingRecipe = { ...state.editingRecipe, ...result }
      document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'edit')
      showToast(`"${result.name}" generated — review and save`, 'success')
    } catch (err) {
      if (status) status.textContent = 'Generation failed — try rephrasing'
      if (btn) { btn.disabled = false; btn.textContent = '✨ Generate recipe' }
    }
  }

  window.setRecipeServings = (val, recipeId) => {
    const n = parseFloat(val)
    if (n > 0) {
      state.recipeServings = n
      const content = document.getElementById('recipe-modal-content')
      if (content && state.editingRecipe) content.innerHTML = renderRecipeModalContent(state.editingRecipe, 'view')
    }
  }

  window.setRecipeTab = (tab) => {
    state.recipeTab = tab
    const content = document.getElementById('recipe-modal-content')
    if (content && state.editingRecipe) {
      content.innerHTML = renderRecipeModalContent(state.editingRecipe, 'view')
    }
  }

  window.generateInstructionsHandler = async (recipeId) => {
    const btn = document.getElementById('gen-instr-btn')
    const recipe = state.recipes.find(r => r.id === recipeId)
    if (!recipe) { showToast('Recipe not found', 'error'); return }

    // Ownership check: AI-generated instructions get saved via a user_id-scoped
    // UPDATE, so we can only save them on recipes the current user owns.
    // Recipes fetched from another provider's broadcast have been injected
    // into state.recipes for read-only viewing — those must be copied to the
    // user's library first (by copying the broadcast into their planner).
    if (recipe.user_id && recipe.user_id !== state.user.id) {
      showToast("You can only generate instructions for recipes in your own library. Copy this meal plan to your planner first.", 'error')
      return
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="analyzing-spinner"></span> Generating...' }
    try {
      const result = await generateRecipeInstructions(recipe)
      if (!result?.steps?.length) throw new Error('No instructions returned')

      // Update state immediately so UI shows them
      recipe.instructions = result
      state.editingRecipe = { ...state.editingRecipe, instructions: result }

      // Save directly via targeted update — only touches instructions column
      try {
        const saved = await saveRecipeInstructions(state.user.id, recipeId, result)
        // Re-sync from the authoritative DB value so state.recipes reflects
        // exactly what persisted. Belt-and-suspenders: if anything else
        // mutates the object later (e.g. a stale getRecipes refresh), the
        // instructions can't silently vanish.
        if (saved?.instructions) {
          recipe.instructions = saved.instructions
          if (saved.instructions_version != null) {
            recipe.instructions_version = saved.instructions_version
          }
          if (state.editingRecipe && state.editingRecipe.id === recipeId) {
            state.editingRecipe.instructions = saved.instructions
            if (saved.instructions_version != null) {
              state.editingRecipe.instructions_version = saved.instructions_version
            }
          }
        }
        showToast('Instructions generated and saved!', 'success')
      } catch (saveErr) {
        console.error('Save failed:', saveErr)
        showToast('Generated but save failed: ' + saveErr.message, 'error')
      }

      state.recipeTab = 'instructions'
      document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'view')
    } catch (err) {
      showToast('Failed: ' + err.message, 'error')
      if (btn) { btn.disabled = false; btn.textContent = '✨ Generate cooking instructions with AI' }
    }
  }

  window.downloadRecipeInstructions = (recipeId) => {
    const recipe = state.recipes.find(r => r.id === recipeId)
    if (!recipe?.instructions?.steps?.length) return

    const ingredients = (recipe.ingredients || [])
      .map(i => `<li>${i.amount || ''} ${i.unit || ''} ${i.name}`.trim() + '</li>')
      .join('')

    const steps = recipe.instructions.steps
      .map((s, i) => `<li><strong>${i + 1}.</strong> ${s}</li>`)
      .join('')

    const tips = recipe.instructions.tips?.length
      ? `<div class="tips"><h3>💡 Tips</h3><ul>${recipe.instructions.tips.map(t => `<li>${t}</li>`).join('')}</ul></div>`
      : ''

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${recipe.name}</title>
<style>
  body { font-family: Georgia, serif; max-width: 680px; margin: 40px auto; padding: 0 24px; color: #222; line-height: 1.6; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  .desc { color: #666; font-style: italic; margin-bottom: 16px; }
  .meta { display: flex; gap: 24px; background: #f9f9f9; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; font-size: 14px; }
  .meta span { color: #555; }
  .meta strong { color: #222; }
  .macros { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
  .macro { background: #f0f0f0; border-radius: 20px; padding: 4px 14px; font-size: 13px; font-weight: 600; }
  h2 { font-size: 18px; border-bottom: 2px solid #eee; padding-bottom: 6px; margin-top: 28px; }
  ul, ol { padding-left: 20px; }
  li { margin-bottom: 8px; font-size: 15px; }
  ol li { margin-bottom: 14px; line-height: 1.65; }
  .tips { background: #fffbeb; border: 1px solid var(--accent-hover); border-radius: 8px; padding: 14px 18px; margin-top: 24px; }
  .tips h3 { margin: 0 0 8px; font-size: 15px; }
  .source { margin-top: 28px; font-size: 13px; color: #888; }
  a { color: var(--cal); }
  @media print { body { margin: 20px; } }
</style>
</head>
<body>
  <h1>${recipe.name}</h1>
  ${recipe.description ? `<div class="desc">${recipe.description}</div>` : ''}
  <div class="meta">
    <span><strong>${recipe.servings || 1}</strong> servings</span>
    ${recipe.instructions.prep_time ? `<span>⏱ Prep: <strong>${recipe.instructions.prep_time}</strong></span>` : ''}
    ${recipe.instructions.cook_time ? `<span>🔥 Cook: <strong>${recipe.instructions.cook_time}</strong></span>` : ''}
  </div>
  <div class="macros">
    <span class="macro">${Math.round(recipe.calories)} kcal</span>
    <span class="macro">${Math.round(recipe.protein)}g protein</span>
    <span class="macro">${Math.round(recipe.carbs)}g carbs</span>
    <span class="macro">${Math.round(recipe.fat)}g fat</span>
  </div>
  ${ingredients ? `<h2>Ingredients</h2><ul>${ingredients}</ul>` : ''}
  <h2>Instructions</h2>
  <ol>${steps}</ol>
  ${tips}
  ${recipe.source_url ? `<div class="source">Source: <a href="${recipe.source_url}">${recipe.source_url}</a></div>` : ''}
</body>
</html>`

    const blob = new Blob([html], { type: 'text/html' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${recipe.name.replace(/[^a-z0-9]/gi, '_')}_recipe.html`
    a.click()
    URL.revokeObjectURL(a.href)
    showToast('Recipe downloaded — open in browser and Print → Save as PDF', 'success')
  }

  // ─── Cooking mode (read-aloud step navigator) ──────────────────────
  // Opens a fullscreen overlay that shows ONE instruction step at a
  // time and reads it aloud via the browser's SpeechSynthesis API.
  // The user taps Next to advance + read the next step, or Repeat to
  // re-read the current one. No AI cost — TTS runs entirely on-device.
  //
  // iOS Safari quirks worth knowing:
  //   - speechSynthesis.speak() needs to be triggered from a user
  //     gesture (button tap qualifies). We open the modal AND speak
  //     in the same handler so the gesture chain is preserved.
  //   - Voices load asynchronously. We pick a voice at speak time
  //     rather than caching one — gives the system time to load
  //     between modal-open and first speak() if voice list is empty
  //     on first access.
  //   - Speech can outlast the page. We always cancel() on close.
  //
  // State lives on state.cookingMode = { recipeId, stepIndex } so
  // re-renders during the session don't lose place.

  // ─── Voice selection (kitchen-mode TTS quality) ────────────────────
  // iOS Safari quirk: getVoices() returns an empty list on first call.
  // Voices load asynchronously and the 'voiceschanged' event fires
  // when the full list is ready. We pre-load on app boot so the first
  // tap of Read aloud doesn't get the bargain-bin Hawking-bot voice.
  //
  // Quality ranking heuristic, since the API has no quality field:
  //   +500  name matches an Apple high-quality voice (Samantha, Ava,
  //         Allison, Karen, Moira, Tessa, Susan, Victoria, Serena, Kate)
  //   +200  name contains "Enhanced" / "Premium" / "Neural" (markers
  //         that distinguish iOS Premium voices from default ones)
  //   +100  localService:true (on-device — usually higher quality and
  //         no network jitter)
  //   +50   en-US specifically (matches our recipe content best)
  //   +20   any English (en-GB, en-AU, en-CA, etc.)
  //   -200  name in the known-bad list (Daniel, Fred, Albert, etc —
  //         the legacy robot voices we want to avoid)
  //
  // Net result: on a typical iPhone we should pick Samantha (Enhanced)
  // or similar without the user touching anything.

  // ─── Premium voices (OpenAI TTS via /api/tts) ──────────────────────
  // These play through an <audio> element, not SpeechSynthesis. Each
  // step gets cached server-side per (recipe, step, servings, voice,
  // version), so subsequent reads of the same recipe cost $0.
  //
  // Voice list mirrors what OpenAI tts-1-hd exposes. Nova is the
  // warm-female pick most users gravitate toward; we surface it first
  // in the picker. Free voices keep using browser SpeechSynthesis;
  // selecting a premium voice routes through the API instead.
  const PREMIUM_VOICES = [
    { id: 'nova',    label: 'Nova',    desc: 'Warm, friendly · default premium' },
    { id: 'shimmer', label: 'Shimmer', desc: 'Soft, calm female' },
    { id: 'alloy',   label: 'Alloy',   desc: 'Neutral, balanced' },
    { id: 'echo',    label: 'Echo',    desc: 'Crisp male' },
    { id: 'fable',   label: 'Fable',   desc: 'Storyteller, British' },
    { id: 'onyx',    label: 'Onyx',    desc: 'Deep male' },
  ]
  const PREMIUM_VOICE_IDS = new Set(PREMIUM_VOICES.map(v => v.id))

  // Premium voices are the only user-facing option. localStorage may still
  // hold an older device-voice selection from before this change; we just
  // ignore it and default to Nova until the user explicitly picks a
  // different premium voice. Always returns a valid premium id.
  const DEFAULT_PREMIUM_VOICE = 'nova'
  function getSelectedPremiumVoice() {
    const stored = localStorage.getItem('macrolens_voice_premium') === '1'
      ? localStorage.getItem('macrolens_voice_name')
      : null
    return PREMIUM_VOICE_IDS.has(stored) ? stored : DEFAULT_PREMIUM_VOICE
  }

  // Reusable <audio> element for premium playback. Created lazily so
  // we don't burn an extra DOM node when the user never opens cooking
  // mode. Volume/rate controls match the SpeechSynthesis defaults so
  // the two paths sound similar in pacing.
  let _audioEl = null
  let _isPaused = false
  function getAudioEl() {
    if (_audioEl) return _audioEl
    _audioEl = document.createElement('audio')
    _audioEl.preload = 'auto'
    _audioEl.style.display = 'none'
    document.body.appendChild(_audioEl)
    return _audioEl
  }
  function stopAudio() {
    if (_audioEl) { _audioEl.pause(); _audioEl.removeAttribute('src'); _audioEl.load() }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    _isPaused = false
  }
  // Pause/resume the active read-aloud, whether premium MP3 or browser TTS.
  // Both helpers no-op (return false) if nothing is currently in a state we
  // can act on, so a stray tap on Pause when audio has ended doesn't flip
  // the UI into a phantom "Resume" mode.
  function pauseSpeech() {
    const audioPlaying = _audioEl && !_audioEl.paused && _audioEl.src
    const ttsPlaying = 'speechSynthesis' in window && window.speechSynthesis.speaking && !window.speechSynthesis.paused
    if (!audioPlaying && !ttsPlaying) return false
    if (audioPlaying) _audioEl.pause()
    if (ttsPlaying) window.speechSynthesis.pause()
    _isPaused = true
    return true
  }
  function resumeSpeech() {
    if (!_isPaused) return false
    if (_audioEl && _audioEl.paused && _audioEl.src) _audioEl.play().catch(() => {})
    if ('speechSynthesis' in window && window.speechSynthesis.paused) window.speechSynthesis.resume()
    _isPaused = false
    return true
  }

  const KNOWN_GOOD_VOICES = [
    'samantha', 'ava', 'allison', 'karen', 'moira', 'tessa',
    'susan', 'victoria', 'serena', 'kate', 'fiona', 'nicky',
    'siri', // some platforms expose Siri directly
  ]
  const KNOWN_BAD_VOICES = [
    'daniel', 'fred', 'albert', 'bahh', 'bells', 'boing',
    'bubbles', 'cellos', 'deranged', 'good news', 'hysterical',
    'pipe organ', 'trinoids', 'whisper', 'zarvox',
  ]

  function scoreVoice(v) {
    if (!v) return -Infinity
    const name = (v.name || '').toLowerCase()
    let score = 0
    // Name-based signals first — these are the strongest quality indicators
    if (KNOWN_GOOD_VOICES.some(g => name.includes(g))) score += 500
    if (KNOWN_BAD_VOICES.some(b => name.includes(b))) score -= 200
    if (/enhanced|premium|neural/.test(name)) score += 200
    // Locality bonus — on-device voices tend to be Apple's tier-1
    if (v.localService) score += 100
    // Language match — recipes are in en-US
    if (v.lang === 'en-US') score += 50
    else if (v.lang?.startsWith('en')) score += 20
    return score
  }

  // Cache the picked voice so we don't recompute on every speak() call.
  // Reset when voiceschanged fires (list grew) or user picks manually.
  let _cachedVoice = null
  let _cachedVoiceList = []

  function getAvailableVoices() {
    if (!('speechSynthesis' in window)) return []
    return window.speechSynthesis.getVoices() || []
  }

  function pickBestVoice() {
    const voices = getAvailableVoices()
    if (!voices.length) return null
    // Filter to English voices first — we don't want to accidentally
    // pick a high-quality Spanish voice for English text.
    const english = voices.filter(v => v.lang?.startsWith('en'))
    const pool = english.length ? english : voices
    // Sort by score descending and return the winner.
    const sorted = [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a))
    return sorted[0] || null
  }

  function getActiveVoice() {
    // Honor user override if they picked one explicitly.
    const overrideName = localStorage.getItem('macrolens_voice_name')
    if (overrideName) {
      const voices = getAvailableVoices()
      const match = voices.find(v => v.name === overrideName)
      if (match) return match
      // Override no longer available (different device, etc) — ignore it
    }
    // Otherwise auto-pick. Cache to avoid recomputing every speak().
    if (!_cachedVoice || _cachedVoiceList.length !== getAvailableVoices().length) {
      _cachedVoice = pickBestVoice()
      _cachedVoiceList = getAvailableVoices()
    }
    return _cachedVoice
  }

  // Boot-time voice preloader. Triggers the async voice list load so
  // by the time the user opens cooking mode, the good voices are ready.
  // Also wired to the voiceschanged event for browsers that load mid-
  // session.
  function initSpeechSynthesis() {
    if (!('speechSynthesis' in window)) return
    // Trigger initial load
    window.speechSynthesis.getVoices()
    // Wire the voiceschanged event so we re-pick when the list grows.
    // iOS sometimes fires this multiple times during boot.
    if (typeof window.speechSynthesis.addEventListener === 'function') {
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        _cachedVoice = null  // invalidate cache; next speak picks fresh
      })
    }
  }
  initSpeechSynthesis()

  // Speak a step. Two paths:
  //
  //   Premium (OpenAI TTS): hits /api/tts, plays the returned MP3 via
  //   <audio>. Used when the user has picked a premium voice. Caches
  //   server-side per (recipe, step, servings, voice, version) so
  //   subsequent reads of the same recipe cost nothing.
  //
  //   Free (browser SpeechSynthesis): the original on-device path.
  //   Always cancels any pending utterance first to avoid stacking.
  //
  // ctx is an optional object — if provided AND a premium voice is
  // selected, we route through the API. Otherwise fall back to the
  // free path. ctx shape: { recipeId, stepIndex, servings, instructionsVersion }.
  // We also fall back gracefully if the API call fails for any reason
  // (network, spend cap, etc) — better to read in a robot voice than
  // not at all mid-cook.
  function speakStep(text, ctx) {
    stopAudio()
    if (!text) return
    if (state.cookingVoiceOff) return  // silent mode — visuals only

    const premium = ctx ? getSelectedPremiumVoice() : null
    if (premium && ctx?.recipeId != null && ctx.instructionsVersion != null) {
      const audio = getAudioEl()
      // Track this fetch so a fast user (Next > Next > Next) only ever
      // hears the latest one. Older fetches that resolve late get dropped.
      const ticket = ++_audioTicket
      fetchRecipeAudio({
        recipeId: ctx.recipeId,
        stepIndex: ctx.stepIndex,
        servings: ctx.servings,
        voiceId: premium,
        instructionsVersion: ctx.instructionsVersion,
      }).then(({ url }) => {
        if (ticket !== _audioTicket) return  // user moved on
        audio.src = url
        audio.play().catch(err => {
          // Autoplay blocked or codec issue — fall back to browser TTS
          // so the user still hears the step.
          console.warn('[cooking] audio playback failed, falling back:', err?.message)
          speakStepFree(text)
        })
      }).catch(err => {
        if (ticket !== _audioTicket) return
        console.warn('[cooking] premium TTS failed, falling back:', err?.message)
        speakStepFree(text)
      })
      return
    }

    speakStepFree(text)
  }

  let _audioTicket = 0

  // Builds the context premium TTS needs from the cooking-mode state.
  // Cooking mode reads steps unscaled (we don't expose a serving picker
  // there), so target servings = recipe.servings. instructions_version
  // comes off the recipe row — DB trigger keeps it in sync on every save.
  function cookingStepCtx(recipe, stepIndex) {
    if (!recipe) return null
    return {
      recipeId: recipe.id,
      stepIndex,
      servings: Number(recipe.servings) || 1,
      instructionsVersion: Number(recipe.instructions_version) || 1,
    }
  }

  function speakStepFree(text) {
    if (!('speechSynthesis' in window)) return
    // Browser path: speechify the text the same way the server does for OpenAI,
    // so "0.5 tbsp" reads as "half a tablespoon" instead of "zero point five
    // tee-bee-ess-pee".
    const spoken = speechifyStepText(text, 1, 1)
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(spoken)
    utterance.rate = 0.95
    utterance.pitch = 1.0
    utterance.volume = 1.0
    const voice = getActiveVoice()
    if (voice) utterance.voice = voice
    window.speechSynthesis.speak(utterance)
  }

  window.openCookingMode = (recipeId) => {
    const recipe = state.recipes.find(r => r.id === recipeId)
    const steps = recipe?.instructions?.steps
    if (!steps?.length) {
      showToast('No instructions to read', 'error')
      return
    }
    // Voice-off mode doesn't need speechSynthesis — only the browser-TTS
    // fallback does. Premium voices route through OpenAI MP3 playback.
    if (!state.cookingVoiceOff && !('speechSynthesis' in window)) {
      showToast('Read-aloud not supported in this browser. Toggle Voice off to step through silently.', 'error')
      return
    }
    state.cookingMode = { recipeId, stepIndex: 0 }
    renderCookingMode()
    // Speak the first step. Must happen in the same gesture as the
    // tap that opened the modal — iOS denies speech without it.
    speakStep(steps[0], cookingStepCtx(recipe, 0))
  }

  function renderCookingMode() {
    const cm = state.cookingMode
    if (!cm) return
    const recipe = state.recipes.find(r => r.id === cm.recipeId)
    const steps = recipe?.instructions?.steps || []
    if (!steps.length) {
      window.closeCookingMode()
      return
    }
    const idx = cm.stepIndex
    const step = steps[idx]
    const isLast = idx === steps.length - 1
    const isFirst = idx === 0

    // Build / replace the modal. We rebuild the whole thing on each
    // step change rather than mutating in-place — content is small
    // and full re-render keeps the markup straightforward.
    let modal = document.getElementById('cooking-mode-modal')
    if (modal) modal.remove()
    modal = document.createElement('div')
    modal.id = 'cooking-mode-modal'
    modal.style.cssText = 'position:fixed;inset:0;background:var(--bg);z-index:9999;display:flex;flex-direction:column;padding:20px;overflow-y:auto'
    modal.innerHTML = `
      <!-- Header: recipe name, step counter, close -->
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">Cooking</div>
          <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--text);overflow-wrap:break-word">${esc(recipe.name)}</div>
        </div>
        <button onclick="closeCookingMode()" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);width:36px;height:36px;border-radius:50%;cursor:pointer;font-family:inherit;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0">×</button>
      </div>

      <!-- Voice controls — picker chip + on/off toggle. Both subtle: the
           cooking flow is the primary action, audio config is secondary. -->
      ${(() => {
        const off = !!state.cookingVoiceOff
        const premium = getSelectedPremiumVoice()
        const label = '✨ ' + (PREMIUM_VOICES.find(v => v.id === premium)?.label || premium)
        return `
          <div style="display:flex;justify-content:center;gap:8px;margin-bottom:20px;flex-wrap:wrap">
            <button onclick="openVoicePicker()"
              title="${off ? 'Voice is off — turn it on to pick a voice' : 'Change the read-aloud voice'}"
              ${off ? 'disabled' : ''}
              style="background:var(--bg3);border:1px solid var(--border);color:var(--text3);padding:6px 12px;border-radius:999px;font-size:11px;cursor:${off ? 'not-allowed' : 'pointer'};font-family:inherit;display:inline-flex;align-items:center;gap:6px;opacity:${off ? '0.4' : '1'}">
              <span style="font-size:13px">🗣️</span>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${esc(label)}</span>
              <span style="opacity:0.5">⌄</span>
            </button>
            <button onclick="toggleCookingVoice()"
              title="${off ? 'Turn voice on' : 'Read silently — no audio'}"
              style="background:${off ? 'var(--accent)' : 'var(--bg3)'};border:1px solid ${off ? 'var(--accent)' : 'var(--border)'};color:${off ? 'var(--bg)' : 'var(--text3)'};padding:6px 12px;border-radius:999px;font-size:11px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;font-weight:${off ? '600' : '400'}">
              <span style="font-size:13px">${off ? '🔇' : '🔈'}</span>
              <span>${off ? 'Voice off' : 'Voice on'}</span>
            </button>
          </div>
        `
      })()}

      <!-- Progress: dots showing position. Tappable. -->
      <div style="display:flex;gap:6px;justify-content:center;margin-bottom:24px;flex-wrap:wrap">
        ${steps.map((_, i) => `
          <button onclick="goToCookingStep(${i})"
            aria-label="Step ${i + 1}"
            title="Jump to step ${i + 1}"
            style="width:${i === idx ? '24px' : '8px'};height:8px;border-radius:999px;border:none;cursor:pointer;background:${i === idx ? 'var(--accent)' : (i < idx ? 'var(--text3)' : 'var(--bg3)')};transition:width 0.2s;padding:0"></button>
        `).join('')}
      </div>

      <!-- Step content: large readable text, centered, takes the rest of the space -->
      <div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0 8px">
        <div style="font-size:13px;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin-bottom:16px;font-weight:600">Step ${idx + 1} of ${steps.length}</div>
        <div style="font-size:22px;line-height:1.5;color:var(--text);max-width:520px;font-family:Georgia,serif">${esc(step)}</div>
      </div>

      <!-- Controls: repeat (always), back (not on first), next or finish (always) -->
      <div style="display:flex;gap:10px;justify-content:center;margin-top:32px;padding-bottom:8px;flex-wrap:wrap">
        ${!isFirst ? `
          <button onclick="prevCookingStep()"
            style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);padding:14px 20px;border-radius:var(--r);font-size:15px;font-family:inherit;cursor:pointer;font-weight:500;min-width:90px">
            ← Back
          </button>
        ` : ''}
        ${!state.cookingVoiceOff ? `
          <button onclick="togglePauseCookingStep()"
            style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);padding:14px 20px;border-radius:var(--r);font-size:15px;font-family:inherit;cursor:pointer;font-weight:500;min-width:90px">
            ${_isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button onclick="repeatCookingStep()"
            style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);padding:14px 20px;border-radius:var(--r);font-size:15px;font-family:inherit;cursor:pointer;font-weight:500;min-width:90px">
            ↻ Repeat
          </button>
        ` : ''}
        <button onclick="nextCookingStep()"
          style="background:var(--accent);border:none;color:var(--bg);padding:14px 22px;border-radius:var(--r);font-size:15px;font-family:inherit;cursor:pointer;font-weight:600;min-width:120px">
          ${isLast ? '✓ Done' : 'Next →'}
        </button>
      </div>

      ${recipe.instructions?.tips?.length ? `
        <div style="margin-top:24px;padding:14px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);font-size:13px;color:var(--text2);line-height:1.5">
          <div style="font-size:11px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;font-weight:600">💡 Tips</div>
          ${recipe.instructions.tips.map(t => `<div style="margin-bottom:4px">• ${esc(t)}</div>`).join('')}
        </div>
      ` : ''}
    `
    document.body.appendChild(modal)
  }

  window.repeatCookingStep = () => {
    const cm = state.cookingMode
    if (!cm) return
    const recipe = state.recipes.find(r => r.id === cm.recipeId)
    const step = recipe?.instructions?.steps?.[cm.stepIndex]
    if (step) speakStep(step, cookingStepCtx(recipe, cm.stepIndex))
  }

  window.togglePauseCookingStep = () => {
    const changed = _isPaused ? resumeSpeech() : pauseSpeech()
    if (changed && state.cookingMode) renderCookingMode()
  }

  window.toggleCookingVoice = () => {
    state.cookingVoiceOff = !state.cookingVoiceOff
    localStorage.setItem('macrolens_voice_off', state.cookingVoiceOff ? '1' : '0')
    if (state.cookingVoiceOff) {
      stopAudio()
    } else if (state.cookingMode) {
      // Re-enable: speak the current step so the change is immediately
      // perceptible.
      const recipe = state.recipes.find(r => r.id === state.cookingMode.recipeId)
      const steps = recipe?.instructions?.steps || []
      const step = steps[state.cookingMode.stepIndex]
      if (step) speakStep(step, cookingStepCtx(recipe, state.cookingMode.stepIndex))
    }
    if (state.cookingMode) renderCookingMode()
  }

  window.nextCookingStep = () => {
    const cm = state.cookingMode
    if (!cm) return
    const recipe = state.recipes.find(r => r.id === cm.recipeId)
    const steps = recipe?.instructions?.steps || []
    if (cm.stepIndex >= steps.length - 1) {
      // Already on the last step — Done button closes the mode.
      window.closeCookingMode()
      showToast('Recipe complete!', 'success')
      return
    }
    cm.stepIndex++
    renderCookingMode()
    speakStep(steps[cm.stepIndex], cookingStepCtx(recipe, cm.stepIndex))
  }

  window.prevCookingStep = () => {
    const cm = state.cookingMode
    if (!cm) return
    if (cm.stepIndex === 0) return
    cm.stepIndex--
    const recipe = state.recipes.find(r => r.id === cm.recipeId)
    const steps = recipe?.instructions?.steps || []
    renderCookingMode()
    speakStep(steps[cm.stepIndex], cookingStepCtx(recipe, cm.stepIndex))
  }

  window.goToCookingStep = (idx) => {
    const cm = state.cookingMode
    if (!cm) return
    const recipe = state.recipes.find(r => r.id === cm.recipeId)
    const steps = recipe?.instructions?.steps || []
    if (idx < 0 || idx >= steps.length) return
    cm.stepIndex = idx
    renderCookingMode()
    speakStep(steps[idx], cookingStepCtx(recipe, idx))
  }

  window.closeCookingMode = () => {
    stopAudio()
    state.cookingMode = null
    document.getElementById('cooking-mode-modal')?.remove()
  }

  // Voice picker — premium-only. Free/device voices are still used as a
  // silent emergency fallback inside speakStep when the API fails, but
  // they're not user-selectable. Tap any voice to preview & select.
  window.openVoicePicker = () => {
    const currentPremium = getSelectedPremiumVoice()

    const modal = document.createElement('div')
    modal.id = 'voice-picker-modal'
    modal.className = 'modal-overlay open'
    modal.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:16px;z-index:10000'
    modal.innerHTML = `
      <div class="modal-box" style="max-width:400px;width:100%;max-height:80vh;display:flex;flex-direction:column">
        <button class="modal-close" onclick="document.getElementById('voice-picker-modal')?.remove()">×</button>
        <h3 style="margin:0 0 4px;font-family:'DM Serif Display',serif;font-size:18px">Choose a voice</h3>
        <div style="font-size:12px;color:var(--text3);margin-bottom:14px">Tap any voice to preview. First read of each step uses AI Bucks; replays are free.</div>

        <div style="overflow-y:auto;flex:1;margin-bottom:12px">
          ${PREMIUM_VOICES.map(v => {
            const isActive = currentPremium === v.id
            return `
              <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${isActive ? 'rgba(212,165,116,0.12)' : 'var(--bg3)'};border:1px solid ${isActive ? 'rgba(212,165,116,0.4)' : 'var(--border)'};border-radius:8px;margin-bottom:6px;cursor:pointer"
                onclick="previewPremiumVoice('${v.id}')">
                <div style="flex:1;min-width:0">
                  <div style="font-size:14px;color:var(--text);font-weight:${isActive ? '600' : '500'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.label}${isActive ? ' ✓' : ''}</div>
                  <div style="font-size:11px;color:var(--text3);margin-top:2px">${v.desc}</div>
                </div>
                <div style="font-size:11px;color:var(--accent);letter-spacing:1px;flex-shrink:0">★★★</div>
              </div>
            `
          }).join('')}
        </div>

        <div style="display:flex;justify-content:flex-end">
          <button onclick="document.getElementById('voice-picker-modal')?.remove()"
            style="background:var(--accent);border:none;color:var(--bg);padding:8px 16px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600">
            Done
          </button>
        </div>
      </div>
    `
    document.body.appendChild(modal)
  }

  window.previewPremiumVoice = (voiceId) => {
    if (!PREMIUM_VOICE_IDS.has(voiceId)) return
    localStorage.setItem('macrolens_voice_name', voiceId)
    localStorage.setItem('macrolens_voice_premium', '1')
    _cachedVoice = null
    const cm = state.cookingMode
    const recipe = cm ? state.recipes.find(r => r.id === cm.recipeId) : null
    if (recipe && cm) {
      const idx = cm.stepIndex ?? 0
      const sample = recipe.instructions?.steps?.[idx]
      if (sample) speakStep(sample, cookingStepCtx(recipe, idx))
    }
    document.getElementById('voice-picker-modal')?.remove()
    window.openVoicePicker()
    if (state.cookingMode) renderCookingMode()
  }

  window.openRecipeModal = (id, mode = 'view') => {
    const recipe = state.recipes.find(r => r.id === id)
    if (!recipe) return
    // Default to the tab that makes sense: Instructions if they exist,
    // Ingredients otherwise. Users were getting confused when they'd generate
    // instructions, close the modal, and reopen to find themselves on the
    // Ingredients tab with the instructions "invisible" until they switched.
    state.recipeTab = recipe.instructions?.steps?.length ? 'instructions' : 'ingredients'
    state.recipeServings = null
    state.editingRecipe = JSON.parse(JSON.stringify(recipe))
    // Seed the tag editor state from this recipe's tags
    const seedTags = Array.isArray(recipe.tags) ? recipe.tags.filter(Boolean) : []
    window._editingTags = new Set(seedTags.map(t => t.toLowerCase()))
    window._editingTagsDisplay = {}
    seedTags.forEach(t => { window._editingTagsDisplay[t.toLowerCase()] = t })
    document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, mode)
    document.getElementById('recipe-modal').classList.add('open')

    // Background OG fetch — only if has URL, not yet cached, and in view mode
    if (mode === 'view' && recipe.source_url && !recipe.og_cache) {
      fetchOgMetadata(recipe.source_url).then(og => {
        if (!og) return
        // Cache in state and DB
        recipe.og_cache = og
        state.editingRecipe.og_cache = og
        saveRecipeOgCache(state.user.id, recipe.id, og).catch(() => {})
        // Update the card in place if modal still open
        const card = document.getElementById('og-preview-card')
        if (card) card.innerHTML = buildOgCard(recipe.source_url, og)
      }).catch(() => {})
    }
  }

  window.closeRecipeModal = () => {
    const el = document.getElementById('recipe-modal')
    if (el) { el.classList.remove('open'); el.style.zIndex = '' }
    state.editingRecipe = null
  }

  // ── Quick-tag modal ─────────────────────────────────────────────
  // Opens a minimal modal with just the tag chip editor for a single
  // recipe. Every toggle saves immediately — no Edit → change → Save
  // flow. Designed to tag lots of recipes quickly from the grid view.
  window.openQuickTagModal = (recipeId) => {
    const recipe = (state.recipes || []).find(r => r.id === recipeId)
    if (!recipe) { showToast('Recipe not found', 'error'); return }
    state._quickTagRecipeId = recipeId
    // _quickTagSaving is a per-tag-key lock so rapid-tapping the same
    // chip doesn't fire overlapping upserts
    state._quickTagSaving = new Set()
    renderQuickTagModal()
    document.getElementById('quick-tag-modal').classList.add('open')
  }

  window.closeQuickTagModal = () => {
    const el = document.getElementById('quick-tag-modal')
    if (el) el.classList.remove('open')
    state._quickTagRecipeId = null
    state._quickTagSaving = null
  }

  function renderQuickTagModal() {
    const recipeId = state._quickTagRecipeId
    if (!recipeId) return
    const recipe = (state.recipes || []).find(r => r.id === recipeId)
    if (!recipe) return

    const currentTags = Array.isArray(recipe.tags) ? recipe.tags.filter(Boolean) : []
    const currentKeys = new Set(currentTags.map(t => t.toLowerCase()))

    // Build suggestion pool: visible presets + staged customs + all other
    // tags used across the user's library, so recently-invented custom
    // tags show up as tappable chips.
    const displayMap = {}
    const knownKeys = new Set()
    for (const p of getVisiblePresets()) {
      displayMap[p.toLowerCase()] = p
      knownKeys.add(p.toLowerCase())
    }
    for (const t of (state._stagedCustomTags || [])) {
      const k = String(t).toLowerCase()
      if (!displayMap[k]) { displayMap[k] = t; knownKeys.add(k) }
    }
    for (const r of (state.recipes || [])) {
      if (!Array.isArray(r.tags)) continue
      for (const t of r.tags) {
        if (!t) continue
        const key = t.toLowerCase()
        if (!displayMap[key]) displayMap[key] = t
        knownKeys.add(key)
      }
    }
    const suggestions = Array.from(knownKeys).map(k => displayMap[k])

    const content = document.getElementById('quick-tag-content')
    if (!content) return
    content.innerHTML = `
      <div style="position:sticky;top:0;background:var(--bg2);border-bottom:1px solid var(--border);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;z-index:2">
        <div style="min-width:0;flex:1;margin-right:10px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:3px">Tag recipe</div>
          <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(recipe.name)}</div>
        </div>
        <button onclick="closeQuickTagModal()" aria-label="Close"
          style="background:transparent;border:none;color:var(--text3);font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;flex-shrink:0">×</button>
      </div>

      <div style="padding:14px 18px 18px">
        <div style="font-size:12px;color:var(--text3);margin-bottom:10px;line-height:1.4">
          Tap any tag to toggle. Saves instantly.
        </div>

        <div id="quick-tag-chips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
          ${suggestions.map(t => {
            const isOn = currentKeys.has(t.toLowerCase())
            return `<button type="button" onclick="quickTagToggle('${t.replace(/'/g,"\\'")}')"
              style="font-size:13px;padding:5px 13px;border-radius:999px;cursor:pointer;font-family:inherit;border:1px solid ${isOn ? 'var(--carbs)' : 'var(--border2)'};background:${isOn ? 'rgba(122,180,232,0.18)' : 'var(--bg3)'};color:${isOn ? 'var(--carbs)' : 'var(--text2)'};transition:all 0.15s">${isOn ? '✓ ' : ''}${esc(t)}</button>`
          }).join('')}
        </div>

        <div style="display:flex;gap:6px">
          <input type="text" id="quick-tag-input" placeholder="Or create a new tag..."
            onkeydown="if (event.key === 'Enter') { event.preventDefault(); quickTagAddCustom() }"
            style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:8px 12px;color:var(--text);font-size:13px;font-family:inherit;outline:none" />
          <button type="button" onclick="quickTagAddCustom()"
            style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:8px 14px;font-size:12px;color:var(--text2);cursor:pointer;font-family:inherit;white-space:nowrap">
            + Add
          </button>
        </div>

        <div id="quick-tag-status" style="font-size:11px;color:var(--text3);margin-top:10px;min-height:14px;text-align:center"></div>
      </div>
    `
  }

  // Toggle a tag on/off for the currently-opened recipe. Saves immediately.
  window.quickTagToggle = async (tagDisplay) => {
    const recipeId = state._quickTagRecipeId
    if (!recipeId) return
    const recipe = (state.recipes || []).find(r => r.id === recipeId)
    if (!recipe) return

    const key = tagDisplay.toLowerCase()
    // Prevent overlapping writes to the same tag if user rapid-taps
    if (state._quickTagSaving?.has(key)) return
    state._quickTagSaving?.add(key)

    const currentTags = Array.isArray(recipe.tags) ? recipe.tags.filter(Boolean) : []
    const currentKeys = new Set(currentTags.map(t => t.toLowerCase()))
    let newTags
    if (currentKeys.has(key)) {
      newTags = currentTags.filter(t => t.toLowerCase() !== key)
    } else {
      newTags = [...currentTags, tagDisplay]
    }

    await quickTagPersist(recipe, newTags)
    state._quickTagSaving?.delete(key)
  }

  window.quickTagAddCustom = async () => {
    const input = document.getElementById('quick-tag-input')
    if (!input) return
    const raw = input.value.trim().replace(/^#+/, '').trim()
    if (!raw) return
    input.value = ''

    const recipeId = state._quickTagRecipeId
    if (!recipeId) return
    const recipe = (state.recipes || []).find(r => r.id === recipeId)
    if (!recipe) return

    const key = raw.toLowerCase()
    if (state._quickTagSaving?.has(key)) return
    state._quickTagSaving?.add(key)

    const currentTags = Array.isArray(recipe.tags) ? recipe.tags.filter(Boolean) : []
    if (currentTags.some(t => t.toLowerCase() === key)) {
      // Already has it — nothing to do
      state._quickTagSaving?.delete(key)
      return
    }
    const newTags = [...currentTags, raw]
    await quickTagPersist(recipe, newTags)
    state._quickTagSaving?.delete(key)
  }

  // Shared save path — updates DB, state.recipes, re-renders the modal
  // chips AND the recipes page behind it (so the tag pill bar + card
  // chip list reflect the change immediately).
  async function quickTagPersist(recipe, newTags) {
    const status = document.getElementById('quick-tag-status')
    if (status) { status.textContent = 'Saving...'; status.style.color = 'var(--text3)' }
    try {
      const saved = await upsertRecipe(state.user.id, { ...recipe, tags: newTags })
      const idx = state.recipes.findIndex(x => x.id === saved.id)
      if (idx !== -1) state.recipes[idx] = saved; else state.recipes.unshift(saved)
      if (status) { status.textContent = '✓ Saved'; status.style.color = 'var(--protein)' }
      // Re-render chips to reflect new state, and page behind so the
      // card's tag row updates without closing the modal
      renderQuickTagModal()
      renderPage()
    } catch (err) {
      console.error('[quickTag] save failed:', err)
      if (status) { status.textContent = 'Error: ' + (err?.message || 'failed to save'); status.style.color = 'var(--red)' }
    }
  }

  // ── Manage tags (rename / delete across all recipes) ────────────
  // Keys are lowercased for matching. Casing is preserved in the rendered
  // label by picking the first non-null display casing we encounter.
  window.openManageTagsModal = () => {
    renderManageTagsModal()
    document.getElementById('manage-tags-modal').classList.add('open')
  }

  window.closeManageTagsModal = () => {
    const el = document.getElementById('manage-tags-modal')
    if (el) el.classList.remove('open')
  }

  function renderManageTagsModal() {
    // Collect every tag in use across the user's recipes, with count +
    // display casing. Presets the user has hidden don't appear here — the
    // whole point of hiding is to make them invisible.
    const tagMap = new Map() // lowercase key → { display, count, isPreset }
    const hiddenLc = new Set((state.usage?.hiddenTagPresets || []).map(s => s.toLowerCase()))

    // Seed with visible presets (count=0 until we find uses below)
    for (const p of RECIPE_TAG_PRESETS) {
      if (hiddenLc.has(p.toLowerCase())) continue
      tagMap.set(p.toLowerCase(), { display: p, count: 0, isPreset: true })
    }

    // Scan recipes for actual usage counts + custom tags
    for (const r of (state.recipes || [])) {
      const tags = Array.isArray(r.tags) ? r.tags : []
      for (const raw of tags) {
        if (!raw) continue
        const trimmed = String(raw).trim()
        if (!trimmed) continue
        const key = trimmed.toLowerCase()
        if (tagMap.has(key)) {
          tagMap.get(key).count++
        } else {
          tagMap.set(key, { display: trimmed, count: 1, isPreset: false })
        }
      }
    }

    // Sort: custom tags first (by usage desc), then presets (alphabetical)
    const entries = Array.from(tagMap.entries())
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => {
        if (a.isPreset !== b.isPreset) return a.isPreset ? 1 : -1
        if (!a.isPreset) return b.count - a.count
        return a.display.localeCompare(b.display)
      })

    const totalCustom = entries.filter(e => !e.isPreset).length
    const visiblePresetCount = entries.filter(e => e.isPreset).length
    const hiddenCount = hiddenLc.size

    const content = document.getElementById('manage-tags-content')
    if (!content) return
    content.innerHTML = `
      <div style="position:sticky;top:0;background:var(--bg2);border-bottom:1px solid var(--border);padding:14px 18px;display:flex;align-items:center;justify-content:space-between;z-index:2">
        <div>
          <div style="font-size:16px;font-weight:600;color:var(--text)">Manage tags</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">${totalCustom} custom · ${visiblePresetCount} preset${visiblePresetCount === 1 ? '' : 's'}${hiddenCount ? ` · ${hiddenCount} hidden` : ''}</div>
        </div>
        <button onclick="closeManageTagsModal()" aria-label="Close"
          style="background:transparent;border:none;color:var(--text3);font-size:22px;line-height:1;cursor:pointer;padding:4px 8px">×</button>
      </div>

      <div style="padding:14px 18px 18px">
        <!-- Quick-add row: type a new custom tag without going through a recipe.
             Tags in the app are implicit (they exist because a recipe has them),
             so a truly empty tag won't stick around. We add a placeholder recipe
             tag to a brand-new entry, which means the first time you create a
             tag here it needs at least one recipe to be applied to — easier to
             just open a recipe and tag it. For now this input renames/merges
             by fuzzy-typing an existing name, plus acts as a no-op for
             brand-new strings (you'd have to tag a recipe to make it exist).
             Keeping the input because it makes the intent of this modal clear:
             this IS where you manage tags. -->
        <div style="display:flex;gap:6px;margin-bottom:14px">
          <input type="text" id="manage-tags-new-input"
            placeholder="Add a custom tag..." maxlength="30"
            onkeydown="if(event.key==='Enter')addCustomTagFromManage()"
            style="flex:1;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:9px 12px;color:var(--text);font-size:13px;font-family:inherit;outline:none" />
          <button onclick="addCustomTagFromManage()"
            style="background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);padding:9px 14px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap">
            Add
          </button>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:14px;line-height:1.4">
          Delete removes a tag from every recipe that uses it. Hidden presets
          stop appearing as suggestions.
        </div>

        ${entries.map(entry => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="flex:1;min-width:0;display:flex;align-items:center;gap:8px">
              <span style="font-size:13px;padding:3px 10px;border-radius:999px;background:${entry.isPreset ? 'var(--bg3)' : 'rgba(122,180,232,0.12)'};color:${entry.isPreset ? 'var(--text2)' : 'var(--carbs)'};border:1px solid ${entry.isPreset ? 'var(--border2)' : 'rgba(122,180,232,0.3)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px">${esc(entry.display)}</span>
              <span style="font-size:11px;color:var(--text3);white-space:nowrap">
                ${entry.count === 0 ? 'unused' : `${entry.count} recipe${entry.count === 1 ? '' : 's'}`}
                ${entry.isPreset ? ' · preset' : ''}
              </span>
            </div>
            <button onclick="renameRecipeTag('${entry.key.replace(/'/g,"\\'")}')"
              style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:5px 10px;font-size:11px;color:var(--text2);cursor:pointer;font-family:inherit;flex-shrink:0">
              Rename
            </button>
            <!-- Delete always shows now. For presets it hides+strips;
                 for customs it only strips (custom tags vanish when no
                 recipes use them). Click opens a preview confirm modal
                 that lists affected recipes by name before actually doing
                 anything. -->
            <button onclick="confirmDeleteTag('${entry.key.replace(/'/g,"\\'")}', ${entry.isPreset})"
              style="background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:5px 10px;font-size:11px;color:var(--red);cursor:pointer;font-family:inherit;flex-shrink:0">
              Delete
            </button>
          </div>
        `).join('')}

        ${entries.length === 0 ? `
          <div style="padding:24px 0;text-align:center;color:var(--text3);font-size:13px">
            No tags yet. Tag a recipe by opening it, tapping Edit, and adding tags in the Tags section.
          </div>
        ` : ''}

        ${hiddenCount ? `
          <!-- Restore any previously-hidden presets. Renders below the active
               list so it doesn't compete for attention unless you actually
               hid things. -->
          <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border)">
            <div style="font-size:11px;color:var(--text3);margin-bottom:8px">Hidden presets</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${[...hiddenLc].map(key => {
                const preset = RECIPE_TAG_PRESETS.find(p => p.toLowerCase() === key) || key
                return `<button onclick="unhidePreset('${key.replace(/'/g,"\\'")}')"
                  style="font-size:11px;padding:4px 10px;border-radius:999px;background:var(--bg3);color:var(--text3);border:1px dashed var(--border2);cursor:pointer;font-family:inherit">
                  ${esc(preset)} · restore</button>`
              }).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `
  }

  // ── Add custom tag from Manage Tags modal ───────────────────────────
  // User flow note: a tag in this app only truly "exists" if a recipe
  // has it (custom tags are inferred from the recipes table, not stored
  // as standalone rows). Typing a brand-new name here stages it as a
  // floating custom tag in memory so it shows up as a suggestion in the
  // Tag picker until a recipe gets tagged with it. If the page reloads
  // without the tag being used, it disappears — which mirrors how the
  // rest of the app treats tags (derived, not owned).
  window.addCustomTagFromManage = () => {
    const input = document.getElementById('manage-tags-new-input')
    const raw = input?.value.trim()
    if (!raw) { showToast('Type a tag name first', 'error'); return }
    if (raw.length > 30) { showToast('Tag name too long (max 30 chars)', 'error'); return }

    const key = raw.toLowerCase()
    // Already exists as a preset or in-use custom? just clear input
    const existingPreset = RECIPE_TAG_PRESETS.some(p => p.toLowerCase() === key)
    const existingCustom = (state.recipes || []).some(r =>
      Array.isArray(r.tags) && r.tags.some(t => t && t.toLowerCase() === key)
    )
    if (existingPreset || existingCustom) {
      input.value = ''
      showToast(`"${raw}" already exists`, '')
      return
    }

    // Stage the new tag — stored in-memory so the Tag picker suggests it.
    // Once the user tags a recipe with it, it becomes "real" via recipes.tags.
    state._stagedCustomTags = state._stagedCustomTags || []
    if (!state._stagedCustomTags.some(t => t.toLowerCase() === key)) {
      state._stagedCustomTags.push(raw)
    }
    input.value = ''
    showToast(`Tag "${raw}" ready to use — open a recipe to apply it`, 'success')
    renderManageTagsModal()
  }

  // ── Confirm-delete flow ─────────────────────────────────────────────
  // Opens a small confirm prompt showing WHICH recipes would be
  // affected before committing. For presets, also offers to hide the
  // preset from suggestions going forward.
  window.confirmDeleteTag = (tagKey, isPreset) => {
    const lower = String(tagKey).toLowerCase()
    // Find affected recipes
    const affected = (state.recipes || []).filter(r =>
      Array.isArray(r.tags) && r.tags.some(t => t && t.toLowerCase() === lower)
    )
    const currentDisplay = (() => {
      for (const r of affected) {
        for (const t of (r.tags || [])) if (t && t.toLowerCase() === lower) return t
      }
      const preset = RECIPE_TAG_PRESETS.find(p => p.toLowerCase() === lower)
      return preset || tagKey
    })()

    // Build a preview string of affected recipe names (truncated if many)
    const names = affected.map(r => r.name || 'Untitled recipe')
    const MAX_SHOW = 8
    const listPart = names.length === 0
      ? '(not used on any recipe)'
      : names.slice(0, MAX_SHOW).map(n => `  • ${n}`).join('\n')
         + (names.length > MAX_SHOW ? `\n  …and ${names.length - MAX_SHOW} more` : '')

    const msg = isPreset
      ? (affected.length > 0
          ? `Delete "${currentDisplay}" preset?\n\nThis will:\n  • Hide it from your tag suggestions\n  • Remove it from ${affected.length} recipe${affected.length === 1 ? '' : 's'}:\n\n${listPart}`
          : `Hide "${currentDisplay}" preset from your tag suggestions?\n\nIt's not in use on any recipes, so nothing will change — it just stops appearing as a suggestion.`)
      : `Delete "${currentDisplay}"?\n\nThis tag will be removed from ${affected.length} recipe${affected.length === 1 ? '' : 's'}:\n\n${listPart}`

    if (!confirm(msg)) return

    // All clear — run the actual delete.
    executeTagDelete(lower, isPreset, affected, currentDisplay)
  }

  // Strips the tag from all affected recipes and optionally hides the
  // preset from future suggestions. Called only after confirmDeleteTag
  // has already got a 'yes' from the user.
  async function executeTagDelete(lower, isPreset, affected, displayName) {
    showToast(affected.length > 0
      ? `Removing tag from ${affected.length} recipe${affected.length === 1 ? '' : 's'}...`
      : `Hiding "${displayName}"...`, '')

    let failed = 0
    for (const r of affected) {
      const updatedTags = (r.tags || []).filter(t => t && t.toLowerCase() !== lower)
      try {
        const saved = await upsertRecipe(state.user.id, { ...r, tags: updatedTags })
        const idx = state.recipes.findIndex(x => x.id === saved.id)
        if (idx !== -1) state.recipes[idx] = saved
      } catch (err) {
        console.error('[tags] delete failed for recipe', r.id, err)
        failed++
      }
    }

    // If it was a preset, also add to hidden_tag_presets so it stops
    // appearing as a suggestion for this user going forward.
    if (isPreset) {
      try {
        await hideTagPreset(state.user.id, lower)
        state.usage = await getUsageSummary(state.user.id)
      } catch (err) {
        console.error('[tags] hideTagPreset failed:', err)
      }
    }

    // Clear any active filter that matched the deleted tag
    if (state.recipeActiveTag && state.recipeActiveTag.toLowerCase() === lower) {
      state.recipeActiveTag = ''
    }
    // Clear any staged custom tag entry if we just deleted one
    if (state._stagedCustomTags) {
      state._stagedCustomTags = state._stagedCustomTags.filter(t => t.toLowerCase() !== lower)
    }

    if (failed > 0) {
      showToast(`Deleted with ${failed} error${failed === 1 ? '' : 's'}`, 'error')
    } else {
      showToast(`"${displayName}" deleted`, 'success')
    }
    renderManageTagsModal()
    renderPage()
  }

  // Reverse of hide — puts a preset back into the suggestion list.
  window.unhidePreset = async (key) => {
    try {
      await unhideTagPreset(state.user.id, key)
      state.usage = await getUsageSummary(state.user.id)
      showToast('Preset restored', 'success')
      renderManageTagsModal()
      renderPage()
    } catch (err) {
      showToast('Error: ' + err.message, 'error')
    }
  }

  // Rename every occurrence of a tag across the user's recipes. Matching is
  // case-insensitive. If the new name already exists on a recipe, we dedupe
  // (effectively merging two tags into one).
  window.renameRecipeTag = async (oldKey) => {
    const lower = String(oldKey).toLowerCase()
    // Find current display casing — from the first recipe that uses it,
    // or fall back to the preset casing.
    let currentDisplay = oldKey
    for (const r of (state.recipes || [])) {
      const tags = Array.isArray(r.tags) ? r.tags : []
      for (const t of tags) {
        if (t && t.toLowerCase() === lower) { currentDisplay = t; break }
      }
    }
    const preset = RECIPE_TAG_PRESETS.find(p => p.toLowerCase() === lower)
    if (preset) currentDisplay = preset

    const raw = window.prompt(`Rename "${currentDisplay}" to:`, currentDisplay)
    if (raw == null) return
    const newName = raw.trim()
    if (!newName) { showToast('Tag name can\'t be empty', 'error'); return }
    if (newName.toLowerCase() === lower && newName === currentDisplay) return // no change

    const newKey = newName.toLowerCase()
    const affected = (state.recipes || []).filter(r =>
      Array.isArray(r.tags) && r.tags.some(t => t && t.toLowerCase() === lower)
    )

    if (affected.length === 0) {
      // It's just a preset with no uses — nothing to rewrite in the DB.
      // We can't really "rename" a preset (it's a client-side constant),
      // but we can quietly skip and show feedback.
      showToast('Tag isn\'t on any recipe yet — add it to a recipe first', '')
      return
    }

    showToast(`Renaming tag on ${affected.length} recipe${affected.length === 1 ? '' : 's'}...`, '')
    let failed = 0
    for (const r of affected) {
      // Replace old tag with new one; dedupe with case-insensitive match
      const seenKeys = new Set()
      const updatedTags = []
      for (const t of r.tags) {
        if (!t) continue
        const key = t.toLowerCase() === lower ? newKey : t.toLowerCase()
        if (seenKeys.has(key)) continue
        seenKeys.add(key)
        updatedTags.push(t.toLowerCase() === lower ? newName : t)
      }
      try {
        const saved = await upsertRecipe(state.user.id, { ...r, tags: updatedTags })
        const idx = state.recipes.findIndex(x => x.id === saved.id)
        if (idx !== -1) state.recipes[idx] = saved
      } catch (err) {
        console.error('[tags] rename failed for recipe', r.id, err)
        failed++
      }
    }
    // If the currently active tag filter matched the old name, update it
    if (state.recipeActiveTag && state.recipeActiveTag.toLowerCase() === lower) {
      state.recipeActiveTag = newName
    }
    if (failed > 0) {
      showToast(`Renamed with ${failed} error${failed === 1 ? '' : 's'}`, 'error')
    } else {
      showToast(`Renamed on ${affected.length} recipe${affected.length === 1 ? '' : 's'}`, 'success')
    }
    // Re-render modal contents AND the recipes page behind it
    renderManageTagsModal()
    renderPage()
  }

  window.deleteRecipeTag = async (oldKey) => {
    const lower = String(oldKey).toLowerCase()
    const affected = (state.recipes || []).filter(r =>
      Array.isArray(r.tags) && r.tags.some(t => t && t.toLowerCase() === lower)
    )
    if (affected.length === 0) return
    const currentDisplay = (() => {
      for (const r of affected) {
        for (const t of (r.tags || [])) {
          if (t && t.toLowerCase() === lower) return t
        }
      }
      return oldKey
    })()
    if (!confirm(`Remove tag "${currentDisplay}" from ${affected.length} recipe${affected.length === 1 ? '' : 's'}?`)) return

    showToast(`Removing tag from ${affected.length} recipe${affected.length === 1 ? '' : 's'}...`, '')
    let failed = 0
    for (const r of affected) {
      const updatedTags = r.tags.filter(t => t && t.toLowerCase() !== lower)
      try {
        const saved = await upsertRecipe(state.user.id, { ...r, tags: updatedTags })
        const idx = state.recipes.findIndex(x => x.id === saved.id)
        if (idx !== -1) state.recipes[idx] = saved
      } catch (err) {
        console.error('[tags] delete failed for recipe', r.id, err)
        failed++
      }
    }
    // Clear the active filter if it matched the deleted tag
    if (state.recipeActiveTag && state.recipeActiveTag.toLowerCase() === lower) {
      state.recipeActiveTag = ''
    }
    if (failed > 0) {
      showToast(`Deleted with ${failed} error${failed === 1 ? '' : 's'}`, 'error')
    } else {
      showToast(`Tag removed from ${affected.length} recipe${affected.length === 1 ? '' : 's'}`, 'success')
    }
    renderManageTagsModal()
    renderPage()
  }

  // ── Foods page ─────────────────────────────────────────────────
  window.openFoodItemModal = (id) => {
    const item = id ? state.foodItems.find(f => f.id === id) : null
    state.editingFoodItem = item ? { ...item } : { name:'', brand:'', serving_size:'1 serving', components:[], calories:0, protein:0, carbs:0, fat:0, fiber:0, sugar:0 }
    state.editingComponents = [...(state.editingFoodItem.components || [])]
    document.getElementById('food-item-modal-content').innerHTML = renderFoodItemModal(state.editingFoodItem, state.editingComponents)
    document.getElementById('food-item-modal').classList.add('open')
  }

  window.closeFoodItemModal = () => {
    document.getElementById('food-item-modal').classList.remove('open')
    state.editingFoodItem = null
    state.editingComponents = null
    state.pendingComponent = null
  }

  window.openAddComponentModal = () => {
    const panel = document.getElementById('add-component-panel')
    if (panel) panel.style.display = 'block'
    state.pendingComponent = null
    document.getElementById('comp-result').style.display = 'none'
    document.getElementById('comp-describe-input').value = ''
  }

  window.cancelAddComponent = () => {
    const panel = document.getElementById('add-component-panel')
    if (panel) panel.style.display = 'none'
    state.pendingComponent = null
  }

  window.setCompMode = (mode) => {
    ;['describe','barcode','label','saved'].forEach(m => {
      const panel = document.getElementById(`comp-panel-${m}`)
      const btn = document.getElementById(`comp-btn-${m}`)
      if (panel) panel.style.display = m === mode ? '' : 'none'
      if (btn) btn.classList.toggle('active', m === mode)
    })
    if (mode === 'saved') filterCompSavedSearch('')
  }

  window.handleComponentLabel = async (file) => {
    const status = document.getElementById('comp-label-status')
    if (!file) return
    if (status) status.textContent = 'Reading label...'
    try {
      // Read file
      const dataUrl = await new Promise((res, rej) => {
        const reader = new FileReader()
        reader.onload = e => res(e.target.result)
        reader.onerror = rej
        reader.readAsDataURL(file)
      })
      // Resize to max 1500px — iPhone photos exceed 5MB Claude limit
      const b64 = await new Promise(res => {
        const img = new Image()
        img.onload = () => {
          const MAX = 1500
          let { width: w, height: h } = img
          if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w*s); h = Math.round(h*s) }
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          canvas.getContext('2d').drawImage(img, 0, 0, w, h)
          res(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
        }
        img.onerror = () => res(dataUrl.split(',')[1])
        img.src = dataUrl
      })
      const result = await analyzeNutritionLabel(b64)
      if (result) {
        state.pendingComponent = {
          name: result.name || 'Food Item',
          calories: result.calories || 0,
          protein: result.protein || 0,
          carbs: result.carbs || 0,
          fat: result.fat || 0,
          fiber: result.fiber || 0,
          sugar: result.sugar || 0,
          serving_size: result.serving_size || '',
          _base: { calories: result.calories||0, protein: result.protein||0, carbs: result.carbs||0, fat: result.fat||0, fiber: result.fiber||0, sugar: result.sugar||0 }
        }
        if (status) status.textContent = `✓ ${result.name || 'Food Item'}`
        showComponentResult(state.pendingComponent)
      } else {
        if (status) status.textContent = 'Could not read label — try Describe tab'
      }
    } catch (err) {
      if (status) status.textContent = 'Failed — try Describe tab'
    }
  }

  window.filterCompSavedSearch = (q) => {
    const results = document.getElementById('comp-saved-results')
    if (!results) return
    const items = [
      ...state.foodItems.map(f => ({ ...f, _type: 'food' })),
      ...state.recipes.map(r => ({ ...r, _type: 'recipe' })),
    ].filter(i => !q || i.name.toLowerCase().includes(q.toLowerCase())).slice(0, 20)

    results.innerHTML = items.map(i => `
      <div onclick="selectSavedComponent('${i.id}','${i._type}')"
        style="padding:8px 10px;cursor:pointer;border-radius:var(--r);display:flex;justify-content:space-between;align-items:center"
        onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background='none'">
        <div>
          <div style="font-size:13px;color:var(--text)">${esc(i.name)}</div>
          <div style="font-size:11px;color:var(--text3)">${i._type === 'food' ? '🍎 Food' : '⭐ Recipe'} · ${Math.round(i.calories)} kcal</div>
        </div>
        <span style="font-size:11px;color:var(--text3)">P${Math.round(i.protein)} C${Math.round(i.carbs)} F${Math.round(i.fat)}</span>
      </div>`).join('') || '<div style="padding:12px;color:var(--text3);font-size:13px">No matches</div>'
  }

  window.selectSavedComponent = (id, type) => {
    const item = type === 'food'
      ? state.foodItems.find(f => f.id === id)
      : state.recipes.find(r => r.id === id)
    if (!item) return
    state.pendingComponent = { name: item.name, calories: item.calories, protein: item.protein, carbs: item.carbs, fat: item.fat, fiber: item.fiber || 0, sugar: item.sugar || 0 }
    showComponentResult(state.pendingComponent)
  }

  window.analyzeComponentHandler = async () => {
    const btn = document.getElementById('comp-analyze-btn')
    const descPanel = document.getElementById('comp-panel-describe')
    const isDescribe = descPanel && descPanel.style.display !== 'none'

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="analyzing-spinner"></span> Looking up...' }
    try {
      let result
      if (isDescribe) {
        const desc = document.getElementById('comp-describe-input')?.value.trim()
        if (!desc) { showToast('Describe the component first', 'error'); return }
        result = await analyzeFoodItem(desc)
      } else {
        // Barcode manual input
        const code = document.getElementById('comp-barcode-manual')?.value.trim()
        if (!code) { showToast('Enter a barcode number', 'error'); return }
        const res = await fetch(`/api/barcode?upc=${code}`)
        const data = await res.json()
        if (data.found) result = data
        else { showToast('Product not found', 'error'); return }
      }
      if (result) {
        state.pendingComponent = {
          name: result.name,
          calories: result.calories || 0,
          protein: result.protein || 0,
          carbs: result.carbs || 0,
          fat: result.fat || 0,
          fiber: result.fiber || 0,
          sugar: result.sugar || 0
        }
        showComponentResult(state.pendingComponent)
      }
    } catch (err) {
      showToast('Lookup failed: ' + err.message, 'error')
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✨ Look up' }
    }
  }

  function showComponentResult(c) {
    const el = document.getElementById('comp-result')
    const nameEl = document.getElementById('comp-result-name')
    const macroEl = document.getElementById('comp-result-macros')
    const addBtn = document.getElementById('comp-add-btn')
    const qtyEl = document.getElementById('comp-result-qty')
    const unitEl = document.getElementById('comp-result-unit')
    if (!el) return
    el.style.display = 'block'
    if (nameEl) nameEl.textContent = c.name
    if (macroEl) macroEl.textContent = `${Math.round(c.calories)} kcal · P${Math.round(c.protein)}g C${Math.round(c.carbs)}g F${Math.round(c.fat)}g`
    // Pre-fill unit from serving_size if available (e.g. "1 bar (40g)" → unit="bar")
    if (unitEl) {
      const ss = c.serving_size || ''
      const unitMatch = ss.match(/^\d+\.?\d*\s+([a-zA-Z]+)/)
      unitEl.value = unitMatch ? unitMatch[1] : 'serving'
    }
    if (qtyEl) qtyEl.value = 1
    // Store base for scaling
    state.pendingComponent._base = { calories: c.calories, protein: c.protein, carbs: c.carbs, fat: c.fat, fiber: c.fiber || 0, sugar: c.sugar || 0 }
    if (addBtn) { addBtn.style.opacity = '1'; addBtn.style.background = 'var(--accent)'; addBtn.style.color = 'var(--accent-fg)' }
  }

  window.confirmAddComponent = () => {
    if (!state.pendingComponent) { showToast('Look up a component first', 'error'); return }
    if (!state.editingComponents) state.editingComponents = []
    // Grab qty/unit from result inputs
    const qty = parseFloat(document.getElementById('comp-result-qty')?.value) || 1
    const unit = document.getElementById('comp-result-unit')?.value || 'serving'
    const comp = {
      ...state.pendingComponent,
      qty,
      unit,
      _base: { ...state.pendingComponent._base } || {
        calories: state.pendingComponent.calories,
        protein: state.pendingComponent.protein,
        carbs: state.pendingComponent.carbs,
        fat: state.pendingComponent.fat,
        fiber: state.pendingComponent.fiber || 0,
        sugar: state.pendingComponent.sugar || 0,
      }
    }
    const addedName = comp.name
    state.editingComponents.push(comp)
    state.pendingComponent = null
    document.getElementById('food-item-modal-content').innerHTML = renderFoodItemModal(state.editingFoodItem, state.editingComponents)
    // Re-open panel for adding more
    const panel = document.getElementById('add-component-panel')
    if (panel) {
      panel.style.display = 'block'
      const resultEl = document.getElementById('comp-result')
      if (resultEl) resultEl.style.display = 'none'
      const descInput = document.getElementById('comp-describe-input')
      if (descInput) descInput.value = ''
    }
    showToast(`${addedName} added!`, 'success')
  }

  window.toggleComponentEdit = (idx) => {
    const panel = document.getElementById(`comp-edit-${idx}`)
    if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none'
  }

  window.updateComponentQty = (idx) => {
    if (!state.editingComponents?.[idx]) return
    const qty = parseFloat(document.getElementById(`comp-qty-${idx}`)?.value) || 1
    const c = state.editingComponents[idx]
    const base = c._base || { calories: c.calories, protein: c.protein, carbs: c.carbs, fat: c.fat, fiber: c.fiber, sugar: c.sugar, qty: c.qty || 1 }
    if (!c._base) c._base = { ...base }
    const multiplier = qty / (base.qty || 1)
    c.qty = qty
    c.calories = +(base.calories * multiplier).toFixed(1)
    c.protein  = +(base.protein  * multiplier).toFixed(1)
    c.carbs    = +(base.carbs    * multiplier).toFixed(1)
    c.fat      = +(base.fat      * multiplier).toFixed(1)
    c.fiber    = +(base.fiber    * multiplier).toFixed(1)
    c.sugar    = +(base.sugar    * multiplier).toFixed(1)
    // Update calorie display without full re-render
    const calSpan = document.querySelector(`#comp-edit-${idx} span[style*="kcal"]`)
    if (calSpan) calSpan.textContent = `= ${Math.round(c.calories)} kcal`
    const macroDiv = document.querySelector(`#comp-edit-${idx}`)?.closest('div[style*="padding:9px"]')?.querySelector('.\\[font-size\\:11px\\]')
    // Update macro line in parent
    const rows = document.querySelectorAll('[id^="comp-edit-"]')
    rows.forEach((_, i) => {
      if (i !== idx) return
      const parent = document.getElementById(`comp-edit-${idx}`)?.parentElement
      if (parent) {
        const macroLine = parent.querySelector('div[style*="color:var(--text3)"]')
        if (macroLine) macroLine.textContent = `${Math.round(c.calories)} kcal · P${Math.round(c.protein)} C${Math.round(c.carbs)} F${Math.round(c.fat)}`
      }
    })
    // Update totals
    updateComponentTotals()
  }

  window.updateComponentUnit = (idx) => {
    if (!state.editingComponents?.[idx]) return
    state.editingComponents[idx].unit = document.getElementById(`comp-unit-${idx}`)?.value || 'serving'
  }

  function updateComponentTotals() {
    const components = state.editingComponents || []
    const totals = components.reduce((a, c) => ({
      calories: a.calories + (c.calories||0),
      protein:  a.protein  + (c.protein ||0),
      carbs:    a.carbs    + (c.carbs   ||0),
      fat:      a.fat      + (c.fat     ||0),
    }), { calories:0, protein:0, carbs:0, fat:0 })
    // Update total row and readonly macro fields
    const totalRow = document.querySelector('[style*="background:var(--bg3)"] [style*="font-weight:500"]')
    if (totalRow) totalRow.textContent = `${Math.round(totals.calories)} kcal · P${Math.round(totals.protein)} C${Math.round(totals.carbs)} F${Math.round(totals.fat)}`
    const fields = { 'fi-cal': totals.calories, 'fi-protein': totals.protein, 'fi-carbs': totals.carbs, 'fi-fat': totals.fat }
    Object.entries(fields).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = Math.round(val) })
  }

  window.updatePendingQty = () => {
    if (!state.pendingComponent?._base) {
      if (state.pendingComponent) {
        state.pendingComponent._base = {
          calories: state.pendingComponent.calories,
          protein: state.pendingComponent.protein,
          carbs: state.pendingComponent.carbs,
          fat: state.pendingComponent.fat,
          fiber: state.pendingComponent.fiber || 0,
          sugar: state.pendingComponent.sugar || 0,
        }
      }
    }
    if (!state.pendingComponent) return
    const qty = parseFloat(document.getElementById('comp-result-qty')?.value) || 1
    const base = state.pendingComponent._base
    state.pendingComponent.qty = qty
    state.pendingComponent.calories = +(base.calories * qty).toFixed(1)
    state.pendingComponent.protein  = +(base.protein  * qty).toFixed(1)
    state.pendingComponent.carbs    = +(base.carbs    * qty).toFixed(1)
    state.pendingComponent.fat      = +(base.fat      * qty).toFixed(1)
    state.pendingComponent.fiber    = +(base.fiber    * qty).toFixed(1)
    state.pendingComponent.sugar    = +(base.sugar    * qty).toFixed(1)
    const macroEl = document.getElementById('comp-result-macros')
    if (macroEl) macroEl.textContent = `${Math.round(state.pendingComponent.calories)} kcal · P${Math.round(state.pendingComponent.protein)}g C${Math.round(state.pendingComponent.carbs)}g F${Math.round(state.pendingComponent.fat)}g`
  }

  window.updatePendingUnit = () => {
    if (!state.pendingComponent) return
    state.pendingComponent.unit = document.getElementById('comp-result-unit')?.value || 'serving'
  }

  window.handleComponentBarcode = async (file) => {
    const status = document.getElementById('comp-barcode-status')
    if (!file) return
    if (status) status.textContent = 'Reading barcode...'

    const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = e => r(e.target.result); fr.readAsDataURL(file) })

    try {
      // 1. Native BarcodeDetector + ZXing
      let code = await decodeBarcodeFromFile(file)

      // 2. Claude visual fallback
      if (!code) {
        if (status) status.textContent = 'Trying AI barcode reader...'
        const b64 = await new Promise(res => {
          const img = new Image()
          img.onload = () => {
            const MAX = 1500
            let { width: w, height: h } = img
            if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w*s); h = Math.round(h*s) }
            const canvas = document.createElement('canvas')
            canvas.width = w; canvas.height = h
            canvas.getContext('2d').drawImage(img, 0, 0, w, h)
            res(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
          }
          img.onerror = () => res(dataUrl.split(',')[1])
          img.src = dataUrl
        })
        code = await readBarcodeFromImage(b64).catch(() => null)
        if (code) {
          const input = document.getElementById('comp-barcode-manual')
          if (input) input.value = code
        }
      }

      if (code) {
        if (status) status.textContent = `Found: ${code} — looking up...`
        const bres = await fetch(`/api/barcode?upc=${code}`)
        const bdata = await bres.json()
        if (bdata.found) {
          state.pendingComponent = {
            name: bdata.name, calories: bdata.calories||0, protein: bdata.protein||0,
            carbs: bdata.carbs||0, fat: bdata.fat||0, fiber: bdata.fiber||0,
            sugar: bdata.sugar||0, serving_size: bdata.serving_size || ''
          }
          state.pendingComponent._base = { ...state.pendingComponent }
          showComponentResult(state.pendingComponent)
          if (status) status.textContent = `✓ ${bdata.name}`
        } else {
          if (status) status.textContent = 'Not in database — try Describe tab'
        }
      } else {
        if (status) status.textContent = 'Could not read barcode — type number below'
        document.getElementById('comp-barcode-manual')?.focus()
      }
    } catch (e) {
      if (status) status.textContent = 'Failed — type number below'
      document.getElementById('comp-barcode-manual')?.focus()
    }
  }

  window.confirmAddComponent = () => {
    if (!state.pendingComponent) { showToast('Look up a component first', 'error'); return }
    if (!state.editingComponents) state.editingComponents = []
    state.editingComponents.push(state.pendingComponent)
    state.pendingComponent = null
    // Re-render modal with updated components
    document.getElementById('food-item-modal-content').innerHTML = renderFoodItemModal(state.editingFoodItem, state.editingComponents)
  }

  window.removeFoodComponent = (idx) => {
    if (!state.editingComponents) return
    state.editingComponents.splice(idx, 1)
    document.getElementById('food-item-modal-content').innerHTML = renderFoodItemModal(state.editingFoodItem, state.editingComponents)
  }

  window.saveFoodItemHandler = async () => {
    const name = document.getElementById('fi-name')?.value.trim()
    if (!name) { showToast('Food needs a name', 'error'); return }
    const components = state.editingComponents || []
    const hasComponents = components.length > 0
    const totals = hasComponents ? components.reduce((a,c) => ({
      calories: a.calories+(c.calories||0), protein: a.protein+(c.protein||0),
      carbs: a.carbs+(c.carbs||0), fat: a.fat+(c.fat||0),
      fiber: a.fiber+(c.fiber||0), sugar: a.sugar+(c.sugar||0)
    }), {calories:0,protein:0,carbs:0,fat:0,fiber:0,sugar:0}) : {
      calories: parseFloat(document.getElementById('fi-cal')?.value)||0,
      protein:  parseFloat(document.getElementById('fi-protein')?.value)||0,
      carbs:    parseFloat(document.getElementById('fi-carbs')?.value)||0,
      fat:      parseFloat(document.getElementById('fi-fat')?.value)||0,
      fiber:    parseFloat(document.getElementById('fi-fiber')?.value)||0,
      sugar:    parseFloat(document.getElementById('fi-sugar')?.value)||0,
    }
    const item = {
      ...state.editingFoodItem,
      name,
      brand: document.getElementById('fi-brand')?.value.trim() || '',
      serving_size: document.getElementById('fi-serving')?.value.trim() || '1 serving',
      components,
      ...totals,
    }
    try {
      const saved = await upsertFoodItem(state.user.id, item)
      const idx = state.foodItems.findIndex(f => f.id === saved.id)
      if (idx !== -1) state.foodItems[idx] = saved; else state.foodItems.unshift(saved)
      closeFoodItemModal()
      renderPage()
      showToast(`${name} saved!`, 'success')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.deleteFoodItemHandler = async (id) => {
    if (!confirm('Delete this food item?')) return
    try {
      await deleteFoodItem(state.user.id, id)
      state.foodItems = state.foodItems.filter(f => f.id !== id)
      closeFoodItemModal()
      renderPage()
      showToast('Deleted', '')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.quickLogFoodItem = async (id) => {
    const item = state.foodItems.find(f => f.id === id)
    if (!item) return

    const components = item.components || []

    // If food has components, ask how to log
    if (components.length > 1) {
      const choice = await new Promise(resolve => {
        const sheet = document.createElement('div')
        sheet.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:flex-end;justify-content:center'
        sheet.innerHTML = `
          <div style="background:var(--bg2);border-radius:var(--r3) var(--r3) 0 0;width:100%;max-width:480px;padding:20px 20px 32px">
            <div style="width:36px;height:4px;background:var(--border2);border-radius:2px;margin:0 auto 16px"></div>
            <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:4px">Log ${esc(item.name)}</div>
            <div style="font-size:13px;color:var(--text3);margin-bottom:16px">This food has ${components.length} components. How do you want to log it?</div>

            <button id="log-as-one"
              style="width:100%;padding:14px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;margin-bottom:10px;text-align:left;display:flex;align-items:center;gap:12px">
              <span style="font-size:22px">🍽️</span>
              <div>
                <div>Log as one food</div>
                <div style="font-size:11px;font-weight:400;opacity:0.8">${Math.round(item.calories)} kcal · P${Math.round(item.protein)}g C${Math.round(item.carbs)}g F${Math.round(item.fat)}g</div>
              </div>
            </button>

            <button id="log-components"
              style="width:100%;padding:14px;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--r);font-size:14px;font-weight:500;font-family:inherit;cursor:pointer;margin-bottom:10px;text-align:left;display:flex;align-items:center;gap:12px">
              <span style="font-size:22px">📋</span>
              <div>
                <div>Log individual components</div>
                <div style="font-size:11px;color:var(--text3);margin-top:2px">${components.map(c => esc(c.name)).join(', ')}</div>
              </div>
            </button>

            <button id="log-cancel"
              style="width:100%;padding:12px;background:none;border:none;color:var(--text3);font-size:14px;font-family:inherit;cursor:pointer">
              Cancel
            </button>
          </div>
        `
        document.body.appendChild(sheet)
        document.getElementById('log-as-one').onclick = () => { document.body.removeChild(sheet); resolve('one') }
        document.getElementById('log-components').onclick = () => { document.body.removeChild(sheet); resolve('components') }
        document.getElementById('log-cancel').onclick = () => { document.body.removeChild(sheet); resolve(null) }
        sheet.onclick = (e) => { if (e.target === sheet) { document.body.removeChild(sheet); resolve(null) } }
      })

      if (!choice) return

      if (choice === 'components') {
        // Log each component as a separate entry
        let logged = 0
        for (const comp of components) {
          try {
            const entry = await addMealEntry(state.user.id, {
              name: comp.name,
              calories: comp.calories || 0,
              protein: comp.protein || 0,
              carbs: comp.carbs || 0,
              fat: comp.fat || 0,
              fiber: comp.fiber || 0,
              sugar: comp.sugar || 0,
              base_calories: comp.calories || 0,
              base_protein: comp.protein || 0,
              base_carbs: comp.carbs || 0,
              base_fat: comp.fat || 0,
              servings_consumed: comp.qty || 1,
              food_item_id: id,
            })
            state.log.unshift(entry)
            logged++
          } catch (err) { console.error('Component log error:', err) }
        }
        updateStats()
        refreshTodayLog()
        showToast(`${logged} components logged!`, 'success')
        return
      }
    }

    // Log as one food (default for foods without components or user chose "as one")
    try {
      const entry = await addMealEntry(state.user.id, {
        ...item,
        base_calories: item.calories, base_protein: item.protein,
        base_carbs: item.carbs, base_fat: item.fat,
        base_fiber: item.fiber, base_sugar: item.sugar,
        servings_consumed: 1,
        food_item_id: id
      })
      state.log.unshift(entry)
      updateStats()
      refreshTodayLog()
      showToast(`${item.name} logged!`, 'success')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  document.getElementById('food-item-modal')?.addEventListener('click', e => {
    if (e.target.id === 'food-item-modal') closeFoodItemModal()
  })
  window.openPlanRecipeModal = (recipeId) => {
    const recipe = state.recipes.find(r => r.id === recipeId)
    if (!recipe) return
    state.planningRecipe = { recipe, selectedDays: [], cookOnceOpen: false, plannedServings: recipe.servings || 4 }
    document.getElementById('plan-recipe-modal-content').innerHTML = renderPlanRecipeModal(recipe)
    document.getElementById('recipe-modal')?.classList.remove('open')
    document.getElementById('plan-recipe-modal').classList.add('open')
  }

  window.closePlanRecipeModal = () => {
    document.getElementById('plan-recipe-modal')?.classList.remove('open')
    state.planningRecipe = null
  }

  window.toggleCookOnce = () => {
    if (!state.planningRecipe) return
    state.planningRecipe.cookOnceOpen = !state.planningRecipe.cookOnceOpen
    const panel = document.getElementById('cook-once-panel')
    const chevron = document.getElementById('cook-once-chevron')
    if (panel) panel.style.display = state.planningRecipe.cookOnceOpen ? '' : 'none'
    if (chevron) chevron.textContent = state.planningRecipe.cookOnceOpen ? '▼' : '▶'
  }

  window.togglePlanDay = (dateStr) => {
    if (!state.planningRecipe) return
    const days = state.planningRecipe.selectedDays
    const idx = days.findIndex(d => d.dateStr === dateStr)
    if (idx !== -1) {
      days.splice(idx, 1)
    } else {
      days.push({ dateStr })
      // Sort chronologically
      days.sort((a, b) => a.dateStr.localeCompare(b.dateStr))
    }
    // Update button styles
    document.querySelectorAll('#plan-day-grid button[data-date]').forEach(btn => {
      const selected = days.some(d => d.dateStr === btn.dataset.date)
      btn.classList.toggle('plan-day-selected', selected)
      btn.style.background = selected ? 'var(--accent)' : (btn.dataset.date === localDateStr(new Date()) ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg3)')
      btn.style.color = selected ? 'var(--accent-fg)' : ''
      btn.style.fontWeight = selected ? '600' : ''
      btn.style.border = selected ? '2px solid var(--accent)' : '1px solid var(--border)'
    })
    // Update summary
    const summary = document.getElementById('plan-selected-summary')
    const cookOncePrimary = document.getElementById('cook-once-primary')
    if (summary) {
      if (!days.length) {
        summary.textContent = ''
      } else {
        const labels = days.map(d => {
          const dt = new Date(d.dateStr + 'T00:00:00')
          return dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
        })
        summary.innerHTML = `<span style="color:var(--accent)">${days.length} day${days.length !== 1 ? 's' : ''}</span> selected: ${labels.join(', ')}`
      }
    }
    if (cookOncePrimary && days.length) {
      const first = new Date(days[0].dateStr + 'T00:00:00')
      cookOncePrimary.textContent = first.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
      cookOncePrimary.style.fontStyle = 'normal'
      cookOncePrimary.style.color = 'var(--accent)'
    }
    // Enable/disable add button
    const addBtn = document.getElementById('plan-recipe-add-btn')
    if (addBtn) {
      const enabled = days.length > 0
      addBtn.style.opacity = enabled ? '1' : '0.4'
      addBtn.style.pointerEvents = enabled ? 'auto' : 'none'
    }
  }

  window.selectPlanRecipeMealType = (type, btn) => {
    document.getElementById('plan-recipe-meal-type').value = type
    // Update button styles
    btn.closest('[style*="display:flex"]').querySelectorAll('button').forEach(b => {
      const isActive = b === btn
      b.style.background = isActive ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg3)'
      b.style.borderColor = isActive ? 'var(--accent)' : 'var(--border2)'
      b.style.color = isActive ? 'var(--accent)' : 'var(--text3)'
    })
  }

  window.confirmPlanRecipe = async (recipeId) => {
    if (!state.planningRecipe?.selectedDays?.length) return
    const { recipe, selectedDays } = state.planningRecipe
    const plannedServings = parseFloat(document.getElementById('plan-servings-input')?.value) || state.planningRecipe.plannedServings || recipe.servings || 4
    const mealType = document.getElementById('plan-recipe-meal-type')?.value || 'dinner'
    const btn = document.getElementById('plan-recipe-add-btn')
    if (btn) { btn.textContent = 'Adding...'; btn.style.opacity = '0.7' }
    try {
      for (let i = 0; i < selectedDays.length; i++) {
        const { dateStr } = selectedDays[i]
        const [yr, mo, dy] = dateStr.split('-').map(Number)
        const d = new Date(yr, mo - 1, dy)
        const dayOfWeek = d.getDay()
        const ws = new Date(yr, mo - 1, dy - dayOfWeek)
        const weekStart = `${ws.getFullYear()}-${String(ws.getMonth()+1).padStart(2,'0')}-${String(ws.getDate()).padStart(2,'0')}`
        const isLeftover = i > 0 && selectedDays.length > 1
        const entryMealType = isLeftover ? 'lunch' : mealType
        const added = await addPlannerMeal(state.user.id, weekStart, dayOfWeek, {
          ...recipe, planned_servings: plannedServings,
          meal_type: entryMealType, leftover: isLeftover
        })
        if (weekStart === state.weekStart) {
          if (!state.planner) state.planner = { meals: Array(7).fill(null).map(() => []) }
          state.planner.meals[dayOfWeek].push(added)
        }
        if (!state.weeksWithMeals.includes(weekStart)) {
          state.weeksWithMeals = [weekStart, ...state.weeksWithMeals].sort().reverse()
        }
      }
      showToast(`${recipe.name} added to your meal plan!`, 'success')
      closePlanRecipeModal()
    } catch (err) {
      showToast('Error: ' + err.message, 'error')
      if (btn) { btn.textContent = 'Add to plan'; btn.style.opacity = '1' }
    }
  }

  document.getElementById('plan-recipe-modal')?.addEventListener('click', e => {
    if (e.target.id === 'plan-recipe-modal') closePlanRecipeModal()
  })

  window.updateIngredient = (idx, field, val) => {
    if (!state.editingRecipe?.ingredients) return
    state.editingRecipe.ingredients[idx][field] = val
  }

  window.addIngredientRow = () => {
    if (!state.editingRecipe) return
    if (!state.editingRecipe.ingredients) state.editingRecipe.ingredients = []
    state.editingRecipe.ingredients.push({ name: '', amount: '', unit: '' })
    document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'edit')
  }

  window.removeIngredientRow = (idx) => {
    if (!state.editingRecipe?.ingredients) return
    state.editingRecipe.ingredients.splice(idx, 1)
    document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'edit')
  }

  window.fetchAndSaveIngredients = async (mealId, mealName) => {
    showToast(`Extracting ingredients for ${mealName}...`, '')
    try {
      // Find or create recipe
      let recipe = state.recipes.find(r => r.name.toLowerCase() === mealName.toLowerCase())
      if (!recipe) {
        recipe = await upsertRecipe(state.user.id, {
          name: mealName, servings: 4, calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, ingredients: []
        })
        state.recipes.unshift(recipe)
      }
      const result = await extractIngredients(mealName, recipe.description || '', recipe.servings || 4)
      const updated = await upsertRecipe(state.user.id, { ...recipe, ingredients: result.ingredients || [] })
      const idx = state.recipes.findIndex(r => r.id === updated.id)
      if (idx !== -1) state.recipes[idx] = updated
      state.groceryItems = null // rebuild list
      renderPage()
      showToast(`Got ${result.ingredients?.length || 0} ingredients for ${mealName}!`, 'success')
    } catch (err) { showToast('Failed: ' + err.message, 'error') }
  }

  window.updateServingLabel = () => {}

  window.aiEstimateRecipeHandler = async () => {
    const btn = document.getElementById('ai-estimate-btn')
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="analyzing-spinner"></span> Estimating...' }

    // Read current form values
    const name = document.getElementById('recipe-name')?.value.trim()
    const desc = document.getElementById('recipe-desc')?.value.trim()
    const url = document.getElementById('recipe-source-url')?.value.trim()
    const servings = parseFloat(document.getElementById('recipe-servings')?.value) || 4

    if (!name && !desc && !url) {
      showToast('Add a recipe name or description first', 'error')
      if (btn) { btn.disabled = false; btn.textContent = '✨ Estimate macros & ingredients with AI' }
      return
    }

    // Build a description for the AI from whatever we have
    const context = [
      name && `Recipe: ${name}`,
      desc && `Description: ${desc}`,
      url && `Source URL: ${url}`,
      `Servings: ${servings}`
    ].filter(Boolean).join('\n')

    try {
      // Use analyzeRecipe which returns macros + full ingredient list
      const result = await analyzeRecipe(context, name)

      // Fill in macro fields
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = Math.round(val || 0) }
      set('r-cal', result.calories)
      set('r-protein', result.protein)
      set('r-carbs', result.carbs)
      set('r-fat', result.fat)
      set('r-fiber', result.fiber)
      set('r-sugar', result.sugar)

      // Auto-fill name if blank
      const nameEl = document.getElementById('recipe-name')
      if (nameEl && !nameEl.value.trim() && result.name) {
        nameEl.value = result.name
        if (state.editingRecipe) state.editingRecipe.name = result.name
      }

      // Auto-fill description if blank
      const descEl = document.getElementById('recipe-desc')
      if (descEl && !descEl.value.trim() && result.description) {
        descEl.value = result.description
      }

      // Always apply AI's serving count
      if (result.servings) {
        const servEl = document.getElementById('recipe-servings')
        if (servEl) servEl.value = result.servings
        if (state.editingRecipe) state.editingRecipe.servings = result.servings
      }

      // Save ingredients to editing recipe and re-render ingredient list
      if (result.ingredients?.length && state.editingRecipe) {
        state.editingRecipe.ingredients = result.ingredients
        const listEl = document.getElementById('ingredient-list')
        if (listEl) {
          listEl.innerHTML = result.ingredients.map((ing, i) =>
            renderIngredientRow(ing, i, true)
          ).join('')
        }
        // Hide the estimate panel, show recalculate button
        const estimatePanel = btn?.closest('div[style*="background"]')
        if (estimatePanel) estimatePanel.style.display = 'none'
      }

      showToast(`Estimated! ${result.ingredients?.length || 0} ingredients extracted.`, 'success')
    } catch (err) {
      showToast('Estimate failed: ' + err.message, 'error')
    }
    if (btn) { btn.disabled = false; btn.textContent = '✨ Estimate macros & ingredients with AI' }
  }

  window.saveRecipeHandler = async () => {
    if (!state.editingRecipe) return
    const btn = document.getElementById('recipe-save-btn')
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...' }
    // Tags from the chip editor (window._editingTags is a Set of lowercase
    // keys; we map back to display casing before saving). Computed once so
    // we can both log it and include it in the payload.
    const tagsFromEditor = window._editingTags
      ? Array.from(window._editingTags).map(k => window._editingTagsDisplay?.[k] || k)
      : (Array.isArray(state.editingRecipe.tags) ? state.editingRecipe.tags : [])
    const recipe = {
      ...state.editingRecipe,
      name: document.getElementById('recipe-name')?.value.trim() || state.editingRecipe.name,
      description: document.getElementById('recipe-desc')?.value.trim() || '',
      source_url: document.getElementById('recipe-source-url')?.value.trim() || '',
      servings: parseFloat(document.getElementById('recipe-servings')?.value) || 4,
      serving_label: document.getElementById('recipe-serving-label')?.value.trim() || 'serving',
      calories: parseFloat(document.getElementById('r-cal')?.value) || 0,
      protein: parseFloat(document.getElementById('r-protein')?.value) || 0,
      carbs: parseFloat(document.getElementById('r-carbs')?.value) || 0,
      fat: parseFloat(document.getElementById('r-fat')?.value) || 0,
      fiber: parseFloat(document.getElementById('r-fiber')?.value) || 0,
      sugar: parseFloat(document.getElementById('r-sugar')?.value) || 0,
      tags: tagsFromEditor,
    }
    if (!recipe.name) { showToast('Recipe needs a name', 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Save recipe' }; return }
    try {
      const saved = await upsertRecipe(state.user.id, recipe)
      const idx = state.recipes.findIndex(r => r.id === saved.id)
      if (idx !== -1) state.recipes[idx] = saved; else state.recipes.unshift(saved)
      closeRecipeModal()
      renderPage()
      showToast('Recipe saved!', 'success')
    } catch (err) {
      // If source_url column not found, retry without it
      if (err.message?.includes('source_url')) {
        try {
          const { source_url, ...recipeWithout } = recipe
          const saved = await upsertRecipe(state.user.id, recipeWithout)
          const idx = state.recipes.findIndex(r => r.id === saved.id)
          if (idx !== -1) state.recipes[idx] = saved; else state.recipes.unshift(saved)
          closeRecipeModal()
          renderPage()
          showToast('Recipe saved!', 'success')
          return
        } catch {}
      }
      showToast('Error saving: ' + err.message, 'error')
      if (btn) { btn.disabled = false; btn.textContent = 'Save recipe' }
    }
  }

  window.deleteRecipeHandler = async (id) => {
    if (!confirm('Delete this recipe?')) return
    try {
      await deleteRecipe(state.user.id, id)
      state.recipes = state.recipes.filter(r => r.id !== id)
      closeRecipeModal()
      renderPage()
      showToast('Recipe deleted', '')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.fetchIngredients = async (recipeId) => {
    const recipe = state.recipes.find(r => r.id === recipeId) || state.editingRecipe
    if (!recipe) return
    const btn = document.querySelector('[onclick*="fetchIngredients"]')
    if (btn) { btn.textContent = '⏳ Extracting...'; btn.disabled = true }
    try {
      const result = await extractIngredients(recipe.name, recipe.description, recipe.servings)
      state.editingRecipe = { ...(state.editingRecipe || recipe), ingredients: result.ingredients || [] }
      document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'edit')
      showToast(`Extracted ${result.ingredients?.length || 0} ingredients!`, 'success')
    } catch (err) {
      showToast('Failed to extract: ' + err.message, 'error')
      if (btn) { btn.textContent = '✨ AI extract'; btn.disabled = false }
    }
  }

  window.recalculateMacrosHandler = async () => {
    if (!state.editingRecipe?.ingredients?.length) { showToast('Add ingredients first', 'error'); return }
    const btn = document.getElementById('recalc-btn')
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Calculating...' }
    const servings = parseFloat(document.getElementById('recipe-servings')?.value) || state.editingRecipe.servings || 4
    try {
      const macros = await recalculateMacros(state.editingRecipe.name, state.editingRecipe.ingredients, servings)
      const fields = { 'r-cal': macros.calories, 'r-protein': macros.protein, 'r-carbs': macros.carbs, 'r-fat': macros.fat, 'r-fiber': macros.fiber, 'r-sugar': macros.sugar }
      Object.entries(fields).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = Math.round(val || 0) })
      state.editingRecipe = { ...state.editingRecipe, ...macros, servings }
      if (btn) { btn.disabled = false; btn.textContent = '✨ Recalculate macros from ingredients' }
      showToast(`Macros updated! (${macros.confidence} confidence)`, 'success')
    } catch (err) {
      showToast('Failed: ' + err.message, 'error')
      if (btn) { btn.disabled = false; btn.textContent = '✨ Recalculate macros from ingredients' }
    }
  }

  window.saveAsRecipeHandler = async () => {
    if (!state.currentEntry) return
    const e = state.currentEntry
    const hasIngredients = e.ingredients?.length > 0
    const btn = document.getElementById('save-recipe-btn')

    try {
      if (hasIngredients) {
        // Has ingredients → save as Recipe
        const existing = await getRecipeByName(state.user.id, e.name)
        if (existing) {
          if (e.ingredients?.length && !existing.ingredients?.length) {
            await upsertRecipe(state.user.id, { ...existing, ingredients: e.ingredients })
            const idx = state.recipes.findIndex(r => r.id === existing.id)
            if (idx !== -1) state.recipes[idx] = { ...existing, ingredients: e.ingredients }
          }
          showToast('Already in Recipes', '')
          return
        }
        const recipe = await upsertRecipe(state.user.id, {
          name: e.name, description: e.description || '',
          servings: e.servings || 1, calories: e.calories,
          protein: e.protein, carbs: e.carbs, fat: e.fat,
          fiber: e.fiber || 0, sugar: e.sugar || 0,
          ingredients: e.ingredients, source: 'ai_photo',
          confidence: e.confidence, ai_notes: e.notes || ''
        })
        state.recipes.unshift(recipe)
        showToast(`"${e.name}" saved to Recipes!`, 'success')
        if (btn) { btn.textContent = '✓ Saved to Recipes'; btn.style.color = 'var(--protein)'; btn.disabled = true }
      } else {
        // No ingredients → save to My Foods
        const existing = state.foodItems.find(f => f.name.toLowerCase() === e.name.toLowerCase())
        if (existing) {
          showToast('Already in My Foods', '')
          return
        }
        const food = await upsertFoodItem(state.user.id, {
          name: e.name,
          brand: e.brand || '',
          serving_size: e.serving_size || '1 serving',
          calories: e.calories, protein: e.protein, carbs: e.carbs,
          fat: e.fat, fiber: e.fiber || 0, sugar: e.sugar || 0,
          sodium: e.sodium || 0, components: [], source: 'ai',
        })
        state.foodItems.unshift(food)
        showToast(`"${e.name}" saved to My Foods!`, 'success')
        if (btn) { btn.textContent = '✓ Saved to Foods'; btn.style.color = 'var(--carbs)'; btn.disabled = true }
      }
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.saveLogEntryToFoods = async () => {
    if (!state.editingEntry) return
    const { id, source } = state.editingEntry
    if (source !== 'log') { showToast('Only meal log entries can be saved to Foods', 'error'); return }
    const entry = state.log.find(e => String(e.id) === String(id))
    if (!entry) return
    const name = document.getElementById('edit-name')?.value.trim() || entry.name
    const base = state.editingBaseMacros || {}
    const btn = document.getElementById('save-to-foods-btn')
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...' }
    try {
      const existing = state.foodItems.find(f => f.name.toLowerCase() === name.toLowerCase())
      if (existing) {
        showToast(`"${name}" already in My Foods`, '')
        if (btn) { btn.disabled = false; btn.textContent = '🍎 Save to My Foods' }
        return
      }
      const food = await upsertFoodItem(state.user.id, {
        name,
        brand: entry.brand || '',
        serving_size: entry.serving_size || '1 serving',
        calories: base.calories || entry.calories || 0,
        protein:  base.protein  || entry.protein  || 0,
        carbs:    base.carbs    || entry.carbs    || 0,
        fat:      base.fat      || entry.fat      || 0,
        fiber:    base.fiber    || entry.fiber    || 0,
        sugar:    base.sugar    || entry.sugar    || 0,
        components: [],
        source: 'log',
      })
      state.foodItems.unshift(food)
      if (btn) { btn.textContent = '✓ Saved to My Foods'; btn.style.color = 'var(--carbs)' }
      showToast(`"${name}" saved to My Foods!`, 'success')
    } catch (err) {
      showToast('Error: ' + err.message, 'error')
      if (btn) { btn.disabled = false; btn.textContent = '🍎 Save to My Foods' }
    }
  }

  window.logPlannedMeal = async (plannerMealId, mealType) => {
    const allMeals = (state.planner?.meals || []).flat()
    const m = allMeals.find(x => String(x.id) === String(plannerMealId))
    if (!m) return
    const mealName = m.meal_name || m.name || ''
    const todayLog = getTodayLog()

    // If already logged — offer to unlog it
    const existingEntry = todayLog.find(e => (e.name||'').toLowerCase() === mealName.toLowerCase())
    if (existingEntry) {
      try {
        await deleteMealEntry(state.user.id, existingEntry.id)
        state.log = state.log.filter(e => String(e.id) !== String(existingEntry.id))
        updateStats()
        refreshTodayLog()
        showToast(`${mealName} removed`, 'success')
      } catch (err) { showToast('Error: ' + err.message, 'error') }
      return
    }

    try {
      const recipe = state.recipes.find(r => r.name?.toLowerCase() === mealName.toLowerCase())
      const food_item_id = !recipe
        ? await autoSaveFoodItem(state.user.id, { name: mealName, calories: m.calories, protein: m.protein, carbs: m.carbs, fat: m.fat, fiber: m.fiber||0, sugar: m.sugar||0 }, state.foodItems).catch(() => null)
        : null
      const entry = await addMealEntry(state.user.id, {
        name: mealName, calories: m.calories||0, protein: m.protein||0,
        carbs: m.carbs||0, fat: m.fat||0, fiber: m.fiber||0, sugar: m.sugar||0,
        base_calories: m.calories||0, base_protein: m.protein||0,
        base_carbs: m.carbs||0, base_fat: m.fat||0,
        base_fiber: m.fiber||0, base_sugar: m.sugar||0,
        servings_consumed: 1, meal_type: mealType,
        recipe_id: recipe?.id || null, food_item_id,
      })
      state.log.unshift(entry)
      updateStats()
      refreshTodayLog()
      showToast(`${mealName} logged!`, 'success')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.changeMealType = (logId, currentType) => {
    const idx = MEAL_TYPES.indexOf(currentType)
    const next = MEAL_TYPES[(idx + 1) % MEAL_TYPES.length]
    const entry = state.log.find(e => String(e.id) === String(logId))
    if (entry) entry.meal_type = next
    updateMealEntry(state.user.id, logId, { meal_type: next }).catch(() => {})
    refreshTodayLog()
  }

  // Check if user arrived via a "Save recipe" from a shared link
  const pendingRecipe = localStorage.getItem('macrolens_save_recipe')
  if (pendingRecipe) {
    localStorage.removeItem('macrolens_save_recipe');
    (async () => {
      try {
        const recipeData = JSON.parse(pendingRecipe)
        const saved = await saveSharedRecipeToLibrary(state.user.id, recipeData)
        state.recipes.unshift(saved)
        showToast(`"${saved.name}" saved to your recipes!`, 'success')
        state.currentPage = 'recipes'
        sessionStorage.setItem('macrolens_page', 'recipes')
        renderPage()
      } catch (e) { console.warn('Failed to save shared recipe:', e.message) }
    })()
  }

  window.refreshAdminPanel = () => loadAdminPanel()

  // Called from callProxy in ai.js when a 429 with spending_limit_exceeded
  // comes back. Opens a full conversion-focused upgrade modal instead of
  // just flashing a toast. Receives the raw USD numbers from the server;
  // the modal itself is in AI Bucks units to match the rest of the UX.
  window.openLimitReachedModal = ({ spentUsd, limitUsd } = {}) => {
    const subtitle = document.getElementById('limit-reached-subtitle')
    const usage = document.getElementById('limit-reached-usage')
    if (subtitle) {
      // Different copy based on role — a free user gets an aspirational
      // upgrade pitch, a premium user (who hit their higher cap) gets a
      // "your month reset is coming" message.
      if (state.usage?.isFree) {
        subtitle.textContent = `You've used all your AI Bucks for the month. Upgrade to Premium for ${bucksCount(10.00)} AI Bucks every month — or keep logging meals with Quick Log (no AI needed).`
      } else {
        subtitle.textContent = "You've used all your AI Bucks for this month. Your allotment resets on the 1st."
      }
    }
    if (usage && limitUsd) {
      usage.textContent = `${bucksCount(limitUsd)} / ${bucksCount(limitUsd)} AI Bucks used`
    }
    document.getElementById('limit-reached-modal')?.classList.add('open')
  }

  window.closeLimitReachedModal = () => {
    document.getElementById('limit-reached-modal')?.classList.remove('open')
  }

  // Clear the spending-limit override on the current user's account.
  // Wired to the [Clear] button on the Account page override indicator.
  // Asks for confirmation since there's no undo — the override amount
  // and expiration both reset to null together.
  window.clearOverrideHandler = async () => {
    if (!confirm('Clear your custom AI Bucks allotment and revert to your role default?')) return
    try {
      await clearSpendingOverride(state.user.id)
      state.usage = await getUsageSummary(state.user.id)
      renderPage()
      showToast('Custom allotment cleared', 'success')
    } catch (err) {
      showToast('Error: ' + err.message, 'error')
    }
  }

  window.loadErrorLogs = async () => {
    const el = document.getElementById('error-log-content')
    const btn = document.getElementById('error-log-load-btn')
    if (!el) return
    if (btn) btn.textContent = 'Loading...'
    try {
      const logs = await getAllErrorLogs(200)
      if (!logs.length) {
        el.innerHTML = '<div style="color:var(--text3);padding:8px 0">No errors logged 🎉</div>'
        if (btn) btn.textContent = 'Refresh'
        return
      }
      el.innerHTML = logs.map(e => {
        const time = new Date(e.created_at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
        return '<div style="padding:8px 0;border-bottom:1px solid var(--border)">'
          + '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">'
          + '<span style="color:var(--red);font-size:12px;font-weight:500">' + esc(e.error_message) + '</span>'
          + '<span style="color:var(--text3);font-size:11px;white-space:nowrap">' + time + '</span>'
          + '</div>'
          + '<div style="font-size:11px;color:var(--text3);margin-top:2px">'
          + (e.page ? 'page: ' + esc(e.page) : '')
          + (e.context ? ' · ' + esc(e.context) : '')
          + (e.user_id ? ' · user: ' + e.user_id.slice(0,8) + '...' : ' · anonymous')
          + '</div>'
          + (e.error_stack ? '<details style="margin-top:4px"><summary style="font-size:11px;color:var(--text3);cursor:pointer">Stack trace</summary>'
            + '<pre style="font-size:10px;color:var(--text3);overflow-x:auto;margin:4px 0;white-space:pre-wrap">' + esc(e.error_stack.slice(0,500)) + '</pre></details>' : '')
          + '</div>'
      }).join('')
    } catch (err) {
      el.innerHTML = '<div style="color:var(--red);font-size:12px">Failed to load: ' + esc(err.message) + '</div>'
    }
    if (btn) btn.textContent = 'Refresh'
  }

  window.changeUserRole = async (userId, role) => {
    try {
      await setUserRole(userId, role)
      showToast(`Role updated to ${role}`, 'success')
      loadAdminPanel()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.toggleUnlimited = async (userId, currentVal) => {
    const newRole = currentVal ? 'free' : 'premium'
    try {
      await setUserRole(userId, newRole)
      showToast(currentVal ? 'Moved to free tier' : 'Upgraded to premium', 'success')
      loadAdminPanel()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.toggleAdmin = async (userId, currentVal) => {
    const newRole = currentVal ? 'premium' : 'admin'
    try {
      await setUserRole(userId, newRole)
      showToast(currentVal ? 'Admin removed' : 'Admin granted', 'success')
      loadAdminPanel()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.toggleAdmin = async (userId, currentVal) => {
    if (userId === state.user.id && currentVal) { showToast("Can't remove your own admin", 'error'); return }
    try {
      await setUserPrivileges(userId, { isAdmin: !currentVal })
      showToast(!currentVal ? 'Admin granted' : 'Admin removed', 'success')
      loadAdminPanel()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.toggleSuspend = async (userId, currentStatus) => {
    if (userId === state.user.id) { showToast("Can't suspend yourself", 'error'); return }
    const newStatus = currentStatus === 'active' ? 'suspended' : 'active'
    try {
      await setUserPrivileges(userId, { accountStatus: newStatus })
      showToast(newStatus === 'suspended' ? 'Account suspended' : 'Account activated', newStatus === 'suspended' ? 'error' : 'success')
      loadAdminPanel()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  // Close modals on backdrop click
  document.getElementById('edit-modal')?.addEventListener('click', e => { if (e.target.id === 'edit-modal') closeEditModal() })
  document.getElementById('planner-modal')?.addEventListener('click', e => { if (e.target.id === 'planner-modal') closePlannerModal() })
  document.getElementById('recipe-modal')?.addEventListener('click', e => { if (e.target.id === 'recipe-modal') closeRecipeModal() })
}

function filterQuickLog() {
  const q = document.getElementById('quick-log-search')?.value.toLowerCase() ?? ''
  const list = document.getElementById('quick-log-list')
  if (!list) return

  const hasHistory = state.log.length > 0
  const hasRecipes = state.recipes.length > 0

  // Empty state — no search term yet
  if (!q) {
    if (!hasHistory && !hasRecipes) {
      list.innerHTML = `
        <div style="padding:16px 4px;text-align:center">
          <div style="font-size:28px;margin-bottom:8px">🍽️</div>
          <div style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:6px">No meals logged yet</div>
          <div style="font-size:12px;color:var(--text3);margin-bottom:14px;line-height:1.5">
            Log your first meal using <strong style="color:var(--text2)">Analyze food</strong> below,<br>
            or save a recipe to find it here next time.
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;max-width:240px;margin:0 auto">
            <button onclick="switchMode('food')"
              style="padding:10px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);font-size:13px;font-weight:600;font-family:inherit;cursor:pointer">
              📸 Analyze a meal
            </button>
            <button onclick="switchPage('recipes')"
              style="padding:10px;background:var(--bg3);color:var(--text2);border:1px solid var(--border2);border-radius:var(--r);font-size:13px;font-weight:500;font-family:inherit;cursor:pointer">
              📝 Browse recipes
            </button>
          </div>
        </div>`
    } else {
      // Show the most recent LOGGED recipe and the most recent LOGGED food item.
      // Both come from state.log, which is ordered newest-first. Pick the first
      // entry that links to a recipe, and the first that links to a food item.
      const items = []

      // Most recent recipe that was logged
      const recentRecipeLog = state.log.find(e => e.recipe_id)
      if (recentRecipeLog) {
        const recipe = state.recipes.find(r => r.id === recentRecipeLog.recipe_id)
        if (recipe) items.push({
          ...recipe,
          source: 'recipe',
          _loggedAt: recentRecipeLog.logged_at,
        })
      }

      // Most recent food item that was logged (separate from recipe)
      const recentFoodLog = state.log.find(e => e.food_item_id && !e.recipe_id)
      if (recentFoodLog) {
        const food = state.foodItems.find(f => f.id === recentFoodLog.food_item_id)
        if (food) items.push({
          ...food,
          source: 'food',
          _loggedAt: recentFoodLog.logged_at,
        })
      }

      // Fallback: if nothing logged yet, show most recent log entry at all
      if (!items.length && state.log.length > 0) {
        const e = state.log[0]
        items.push({ ...e, source: 'log', _loggedAt: e.logged_at })
      }

      if (!items.length) { list.innerHTML = ''; return }

      const fmtAgo = (iso) => {
        if (!iso) return ''
        const ms = Date.now() - new Date(iso).getTime()
        const hrs = ms / 3600000
        if (hrs < 1) return 'just now'
        if (hrs < 24) return `${Math.round(hrs)}h ago`
        return `${Math.round(hrs / 24)}d ago`
      }

      list.innerHTML = `
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Log again · tap to add</div>
        ${items.map(item => {
          const mealRef = item.source === 'recipe' ? 'recipe::' + item.id
                        : item.source === 'food' ? 'food::' + item.id
                        : item.id
          const label = item.source === 'recipe' ? '⭐ Last recipe logged'
                      : item.source === 'food' ? '🥫 Last food logged'
                      : '📋 Last meal logged'
          const labelColor = item.source === 'recipe' ? 'var(--protein)'
                           : item.source === 'food' ? 'var(--carbs)'
                           : 'var(--text3)'
          return `
          <div class="history-pick-item" data-quicklog-ref="${esc(String(mealRef))}"
            style="border-radius:var(--r)">
            <div style="display:flex;flex-direction:column;gap:1px;flex:1;min-width:0">
              <span class="hpi-name">${esc(item.name)}</span>
              <span style="font-size:10px;color:${labelColor}">
                ${label}${item._loggedAt ? ' · ' + fmtAgo(item._loggedAt) : ''}
              </span>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div class="hpi-cal">${Math.round(item.calories || 0)} kcal</div>
              <div style="font-size:10px;color:var(--text3)">P${Math.round(item.protein || 0)} C${Math.round(item.carbs || 0)} F${Math.round(item.fat || 0)}</div>
            </div>
          </div>`
        }).join('')}
      `
      // Wire clicks with delegation — more reliable than inline onclick on mobile
      // (some PWA/capacitor environments strip or delay inline handlers)
      if (!list._quickLogWired) {
        list._quickLogWired = true
        list.addEventListener('click', e => {
          const row = e.target.closest('[data-quicklog-ref]')
          if (!row) return
          const ref = row.getAttribute('data-quicklog-ref')
          if (ref) window.quickLogMeal(ref)
        })
      }
    }
    return
  }

  // Merge recipes + unique log entries
  const items = []
  const seen = new Set()

  state.recipes.forEach(r => {
    seen.add(r.name.toLowerCase())
    items.push({ ...r, source: 'recipe' })
  })
  state.log.forEach(e => {
    const key = e.name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    items.push({ ...e, source: 'log' })
  })

  const filtered = items.filter(i => i.name.toLowerCase().includes(q)).slice(0, 8)

  if (!filtered.length) {
    list.innerHTML = `<div style="padding:8px 4px;font-size:13px;color:var(--text3)">No matches — try analyzing a new meal above</div>`
    return
  }

  list.innerHTML = filtered.map(item => {
    const mealRef = item.source === 'recipe' ? 'recipe::' + item.id : item.id
    return `
    <div class="history-pick-item" data-quicklog-ref="${esc(String(mealRef))}"
      style="border-radius:var(--r)">
      <div style="display:flex;flex-direction:column;gap:1px;flex:1;min-width:0">
        <span class="hpi-name">${esc(item.name)}</span>
        <span style="font-size:10px;color:${item.source === 'recipe' ? 'var(--protein)' : 'var(--text3)'}">
          ${item.source === 'recipe' ? '⭐ Recipe' : '📋 Log history'}
        </span>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div class="hpi-cal">${Math.round(item.calories || 0)} kcal</div>
        <div style="font-size:10px;color:var(--text3)">P${Math.round(item.protein || 0)} C${Math.round(item.carbs || 0)} F${Math.round(item.fat || 0)}</div>
      </div>
    </div>`
  }).join('')
  if (!list._quickLogWired) {
    list._quickLogWired = true
    list.addEventListener('click', e => {
      const row = e.target.closest('[data-quicklog-ref]')
      if (!row) return
      const ref = row.getAttribute('data-quicklog-ref')
      if (ref) window.quickLogMeal(ref)
    })
  }

  window.quickLogMeal = async (id) => {
    console.log('[quickLogMeal] called with id:', id)
    let meal
    if (id.startsWith('recipe::')) {
      const rid = id.replace('recipe::', '')
      meal = state.recipes.find(r => r.id === rid)
      if (!meal) console.warn('[quickLogMeal] recipe not found:', rid)
    } else if (id.startsWith('food::')) {
      const fid = id.replace('food::', '')
      const food = state.foodItems.find(f => f.id === fid)
      if (!food) console.warn('[quickLogMeal] food item not found:', fid)
      // Shape the food item like a log entry so the rest of the handler works
      if (food) meal = {
        ...food,
        food_item_id: food.id,
        base_calories: food.calories, base_protein: food.protein,
        base_carbs: food.carbs, base_fat: food.fat,
        base_fiber: food.fiber, base_sugar: food.sugar,
      }
    } else {
      meal = state.log.find(e => String(e.id) === String(id))
      if (!meal) console.warn('[quickLogMeal] log entry not found:', id, 'log length:', state.log.length)
    }
    if (!meal) {
      showToast('Could not find that meal — try refreshing', 'error')
      return
    }
    console.log('[quickLogMeal] found meal:', meal.name, 'source:', id.startsWith('recipe::') ? 'recipe' : id.startsWith('food::') ? 'food' : 'log')

    // Check if this meal is linked to a food item with components
    const linkedFood = meal.food_item_id
      ? state.foodItems.find(f => f.id === meal.food_item_id)
      : null
    const components = linkedFood?.components || []

    if (components.length > 1) {
      const choice = await new Promise(resolve => {
        const sheet = document.createElement('div')
        sheet.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:flex-end;justify-content:center'
        sheet.innerHTML = `
          <div style="background:var(--bg2);border-radius:var(--r3) var(--r3) 0 0;width:100%;max-width:480px;padding:20px 20px 32px">
            <div style="width:36px;height:4px;background:var(--border2);border-radius:2px;margin:0 auto 16px"></div>
            <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:4px">Log ${esc(meal.name)}</div>
            <div style="font-size:13px;color:var(--text3);margin-bottom:16px">This food has ${components.length} components. How do you want to log it?</div>
            <button id="ql-log-one"
              style="width:100%;padding:14px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--r);font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;margin-bottom:10px;text-align:left;display:flex;align-items:center;gap:12px">
              <span style="font-size:22px">🍽️</span>
              <div>
                <div>Log as one food</div>
                <div style="font-size:11px;font-weight:400;opacity:0.8">${Math.round(meal.calories)} kcal · P${Math.round(meal.protein)}g C${Math.round(meal.carbs)}g F${Math.round(meal.fat)}g</div>
              </div>
            </button>
            <button id="ql-log-components"
              style="width:100%;padding:14px;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:var(--r);font-size:14px;font-weight:500;font-family:inherit;cursor:pointer;margin-bottom:10px;text-align:left;display:flex;align-items:center;gap:12px">
              <span style="font-size:22px">📋</span>
              <div>
                <div>Log individual components</div>
                <div style="font-size:11px;color:var(--text3);margin-top:2px">${components.map(c => esc(c.name)).join(', ')}</div>
              </div>
            </button>
            <button id="ql-cancel"
              style="width:100%;padding:12px;background:none;border:none;color:var(--text3);font-size:14px;font-family:inherit;cursor:pointer">
              Cancel
            </button>
          </div>
        `
        document.body.appendChild(sheet)
        document.getElementById('ql-log-one').onclick = () => { document.body.removeChild(sheet); resolve('one') }
        document.getElementById('ql-log-components').onclick = () => { document.body.removeChild(sheet); resolve('components') }
        document.getElementById('ql-cancel').onclick = () => { document.body.removeChild(sheet); resolve(null) }
        sheet.onclick = (e) => { if (e.target === sheet) { document.body.removeChild(sheet); resolve(null) } }
      })

      if (!choice) return

      if (choice === 'components') {
        let logged = 0
        for (const comp of components) {
          try {
            const entry = await addMealEntry(state.user.id, {
              name: comp.name,
              calories: comp.calories || 0, protein: comp.protein || 0,
              carbs: comp.carbs || 0, fat: comp.fat || 0,
              fiber: comp.fiber || 0, sugar: comp.sugar || 0,
              base_calories: comp.calories || 0, base_protein: comp.protein || 0,
              base_carbs: comp.carbs || 0, base_fat: comp.fat || 0,
              servings_consumed: comp.qty || 1,
              food_item_id: linkedFood.id,
            })
            state.log.unshift(entry)
            logged++
          } catch (err) { console.error('Component log error:', err) }
        }
        const input = document.getElementById('quick-log-search')
        if (input) input.value = ''
        document.getElementById('quick-log-list').innerHTML = ''
        updateStats()
        refreshTodayLog()
        showToast(`${logged} components logged!`, 'success')
        return
      }
    }

    try {
      const isRecipe = id.startsWith('recipe::')
      const isFood = id.startsWith('food::')

      // Link recipe_id if logging from a recipe
      const recipe_id = isRecipe ? meal.id : (meal.recipe_id ?? null)

      // Determine food_item_id: direct link if logging a food item, preserved
      // if the meal already has one, otherwise auto-save so the food shows up
      // in Foods and links to this log entry.
      let food_item_id = null
      if (!isRecipe) {
        if (meal.food_item_id) {
          food_item_id = meal.food_item_id
        } else {
          try {
            food_item_id = await autoSaveFoodItem(state.user.id, meal, state.foodItems)
            if (food_item_id && !state.foodItems.find(f => f.id === food_item_id)) {
              getFoodItems(state.user.id).then(items => { state.foodItems = items }).catch(() => {})
            }
          } catch (e) { console.warn('[quickLogMeal] autoSaveFoodItem failed:', e); food_item_id = null }
        }
      }

      console.log('[quickLogMeal] inserting entry — isRecipe:', isRecipe, 'isFood:', isFood, 'recipe_id:', recipe_id, 'food_item_id:', food_item_id)

      const entry = await addMealEntry(state.user.id, {
        ...meal,
        base_calories: meal.base_calories ?? meal.calories,
        base_protein: meal.base_protein ?? meal.protein,
        base_carbs: meal.base_carbs ?? meal.carbs,
        base_fat: meal.base_fat ?? meal.fat,
        base_fiber: meal.base_fiber ?? meal.fiber ?? 0,
        base_sugar: meal.base_sugar ?? meal.sugar ?? 0,
        servings_consumed: 1,
        food_item_id,
        recipe_id,
      })
      state.log.unshift(entry)
      const input = document.getElementById('quick-log-search')
      if (input) input.value = ''
      document.getElementById('quick-log-list').innerHTML = ''
      updateStats()
      refreshTodayLog()
      showToast(`${meal.name} logged!`, 'success')
    } catch (err) {
      console.error('[quickLogMeal] failed:', err)
      showToast('Failed to log: ' + (err?.message || 'unknown error'), 'error')
    }
  }
}

function filterPlannerList() {
  const q = document.getElementById('planner-search')?.value.toLowerCase() ?? ''
  const list = document.getElementById('history-pick-list')
  if (!list) return

  // Build merged list: recipes first, then unique logged meals
  const items = []
  const seen = new Set()

  // 1. Saved food items first
  state.foodItems.forEach(f => {
    seen.add(f.name.toLowerCase())
    items.push({ ...f, source: 'food' })
  })

  // 2. Saved recipes
  state.recipes.forEach(r => {
    seen.add(r.name.toLowerCase())
    items.push({
      id: 'recipe::' + r.id,
      name: r.name,
      calories: r.calories,
      protein: r.protein,
      carbs: r.carbs,
      fat: r.fat,
      fiber: r.fiber || 0,
      sugar: r.sugar || 0,
      servings: r.servings,
      ingredients: r.ingredients || [],
      source: 'recipe'
    })
  })

  // 2. Logged meals not already covered by a recipe
  state.log.forEach(e => {
    const key = e.name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    items.push({ ...e, source: 'log' })
  })

  const filtered = q ? items.filter(i => i.name.toLowerCase().includes(q)) : items

  if (!filtered.length) {
    list.innerHTML = `<div style="padding:20px;text-align:center;font-size:13px;color:var(--text3)">${q ? 'No matches found.' : 'No meals or recipes yet.'}</div>`
    return
  }

  list.innerHTML = filtered.slice(0, 40).map(item => `
    <div class="history-pick-item" onclick="addHistoryMealToPlanner('${esc(item.id)}')">
      <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">
        <span class="hpi-name">${esc(item.name)}</span>
        ${item.source === 'recipe' ? `<span style="font-size:10px;color:var(--protein)">⭐ Recipe${item.servings ? ' · ' + item.servings + ' servings' : ''}</span>` : item.source === 'food' ? `<span style="font-size:10px;color:var(--carbs)">🍎 Food · ${item.serving_size || '1 serving'}</span>` : `<span style="font-size:10px;color:var(--text3)">📋 From log</span>`}
      </div>
      <span class="hpi-cal">${Math.round(item.calories)} kcal</span>
    </div>`).join('')

  window.addHistoryMealToPlanner = async (id) => {
    if (!state.plannerTarget) return
    // Find from merged list
    let meal
    if (id.startsWith('recipe::')) {
      const recipeId = id.replace('recipe::', '')
      meal = state.recipes.find(r => r.id === recipeId)
    } else {
      meal = state.log.find(e => String(e.id) === String(id))
    }
    if (!meal) return
    const addAsLeftover = document.getElementById('leftover-check').checked
    const dayIdx = state.plannerTarget.dayIdx
    const mealType = state.plannerTarget.mealType || document.getElementById('planner-meal-type')?.value || 'dinner'

    let isLeftoverFromPrompt = false
    if (!addAsLeftover) {
      const lookupKey = (id.startsWith('recipe::') ? id.replace('recipe::', '') : meal.name)
      const choice = await promptLeftoverOnCollision(lookupKey, { dayIdx, weekStart: state.weekStart })
      if (choice === null) return
      isLeftoverFromPrompt = choice.leftover
    }

    try {
      const added = await addPlannerMeal(state.user.id, state.weekStart, dayIdx, {
        ...meal, meal_type: mealType, leftover: isLeftoverFromPrompt
      })
      state.planner.meals[dayIdx].push(added)
      if (addAsLeftover) {
        const nextDay = (dayIdx + 1) % 7
        const leftoverType = 'lunch' // leftovers default to next day lunch
        const leftover = await addPlannerMeal(state.user.id, state.weekStart, nextDay, {
          ...meal, meal_type: leftoverType, leftover: true,
          name: meal.name // keep original name, is_leftover flag marks it
        })
        state.planner.meals[nextDay].push(leftover)
        showToast(`Added to ${DAYS[dayIdx]} ${mealType} + ${DAYS[nextDay]} lunch (leftovers)!`, 'success')
      } else {
        const suffix = isLeftoverFromPrompt ? ' as leftovers' : ''
        showToast(`${meal.name} added to ${DAYS[dayIdx]} ${mealType}${suffix}!`, 'success')
      }
      state.groceryItems = null
      closePlannerModal()
      renderPage()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }
}

function switchPage(name) { window.switchPage(name) }
function closePlannerModal() { window.closePlannerModal?.() }
function closeEditModal() { window.closeEditModal?.() }
