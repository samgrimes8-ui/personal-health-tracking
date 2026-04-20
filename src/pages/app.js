import { signOut } from '../lib/auth.js'
import {
  getGoals, saveGoals as dbSaveGoals,
  getMealLog, addMealEntry, updateMealEntry, deleteMealEntry,
  getPlannerWeek, addPlannerMeal, updatePlannerMeal, deletePlannerMeal,
  getUsageSummary, getAdminUserOverview, setUserPrivileges,
  getRecipes, upsertRecipe, deleteRecipe, getRecipeByName,
  getWeeksWithMeals, getPlannerRange,
  getFoodItems, upsertFoodItem, deleteFoodItem,
  saveRecipeInstructions, autoSaveFoodItem
} from '../lib/db.js'
import {
  analyzePhoto, analyzeRecipe, analyzeDishBySearch, analyzePlannerDescription,
  extractIngredients, recalculateMacros, analyzeFoodItem, analyzeNutritionLabel,
  generateRecipeInstructions
} from '../lib/ai.js'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  user: null,
  goals: { calories: 2000, protein: 150, carbs: 200, fat: 65 },
  log: [],
  recipes: [],
  foodItems: [],
  newUsersCount: 0,
  editingFoodItem: null,
  editingComponents: null,
  pendingComponent: null,
  foodSearch: '',
  planner: { meals: Array(7).fill(null).map(() => []) },
  usage: { spent: 0, limit: 10, remaining: 10, tokens: 0, requests: 0, isAdmin: false, isUnlimited: false },
  currentPage: 'log',
  currentMode: 'food',
  foodMode: 'barcode',    // 'barcode' | 'label' | 'search'
  imageBase64: null,
  labelImageBase64: null,
  currentEntry: null,
  editingEntry: null,
  editingBaseMacros: null,
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
    const validPages = ['log','planner','history','goals','recipes','foods','account']
    if (savedPage && validPages.includes(savedPage)) state.currentPage = savedPage
    renderShell(container)
    wireGlobals()
    _appInitialized = true
  }
  // Also sync on re-init (auth refresh etc) without full shell re-render
  const savedPage = sessionStorage.getItem('macrolens_page')
  const validPages = ['log','planner','history','goals','recipes','foods','account']
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

  const [goals, log, usage, recipes, weeksWithMeals, foodItems] = await Promise.all([
    safe(() => getGoals(state.user.id)),
    safe(() => getMealLog(state.user.id, { limit: 300 })),
    safe(() => getUsageSummary(state.user.id)),
    safe(() => getRecipes(state.user.id)),
    safe(() => getWeeksWithMeals(state.user.id)),
    safe(() => getFoodItems(state.user.id))
  ])
  state.goals = { calories: goals?.calories ?? 2000, protein: goals?.protein ?? 150, carbs: goals?.carbs ?? 200, fat: goals?.fat ?? 65 }
  state.log = log ?? []
  state.usage = usage
  state.recipes = recipes ?? []
  state.weeksWithMeals = weeksWithMeals ?? []
  state.foodItems = foodItems ?? []
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
          <div class="nav-item ${state.currentPage === 'planner' ? 'active' : ''}" id="nav-planner" onclick="switchPage('planner')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            Meal Planner
          </div>
          <div class="nav-item ${state.currentPage === 'history' ? 'active' : ''}" id="nav-history" onclick="switchPage('history')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            History
          </div>
          <div class="nav-item ${state.currentPage === 'goals' ? 'active' : ''}" id="nav-goals" onclick="switchPage('goals')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Goals
          </div>
          <div class="nav-item ${state.currentPage === 'recipes' ? 'active' : ''}" id="nav-recipes" onclick="switchPage('recipes')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            Recipes
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

    <div class="toast" id="toast"></div>
  `
  updateSidebar()
}

// ─── Page Routing ─────────────────────────────────────────────────────────────
function renderPage() {
  const main = document.getElementById('main-content')
  switch (state.currentPage) {
    case 'log':      renderDashboard(main); break
    case 'planner':  renderPlanner(main); break
    case 'history':  renderHistory(main); break
    case 'goals':    renderGoalsPage(main); break
    case 'recipes':  renderRecipesPage(main); break
    case 'foods':    renderFoodsPage(main); break
    case 'account':  renderAccount(main); break
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
  const today = new Date()
  const dow = today.getDay()
  const meals = state.planner.meals[dow] || []
  return meals.filter(m => !m.is_leftover)
}

function renderDashboard(container) {
  const h = new Date().getHours()
  const greeting = h < 12 ? 'Good morning.' : h < 17 ? 'Good afternoon.' : 'Good evening.'
  const todayLog = getTodayLog()

  container.innerHTML = `
    <div class="greeting">${greeting}</div>
    <div class="greeting-sub">Log your meals and track your macros.</div>

    <div class="stats-row">
      <div class="stat-card"><div class="stat-label">Calories</div><div class="stat-val" style="color:var(--cal)" id="stat-cal">0</div><div class="stat-sub">of <span id="stat-cal-goal">${state.goals.calories}</span> kcal</div></div>
      <div class="stat-card"><div class="stat-label">Protein</div><div class="stat-val" style="color:var(--protein)" id="stat-p">0g</div><div class="stat-sub">of <span id="stat-p-goal">${state.goals.protein}</span>g</div></div>
      <div class="stat-card"><div class="stat-label">Carbs</div><div class="stat-val" style="color:var(--carbs)" id="stat-c">0g</div><div class="stat-sub">of <span id="stat-c-goal">${state.goals.carbs}</span>g</div></div>
      <div class="stat-card"><div class="stat-label">Fat</div><div class="stat-val" style="color:var(--fat)" id="stat-f">0g</div><div class="stat-sub">of <span id="stat-f-goal">${state.goals.fat}</span>g</div></div>
    </div>

    <!-- Quick log — above analyze -->
    <div class="log-card" style="margin-bottom:16px">
      <div class="log-header">
        <span class="log-header-title">Quick log</span>
        <span style="font-size:11px;color:var(--text3)">from recipes & history</span>
      </div>
      <div style="padding:12px 16px">
        <input class="planner-search" id="quick-log-search" placeholder="Search meals and recipes to log..."
          oninput="filterQuickLog()" style="margin-bottom:8px" />
        <div id="quick-log-list"></div>
      </div>
    </div>

    <!-- Analyze food -->
    <div class="two-col">
      <div class="upload-card">
        <div class="section-title">Analyze food</div>
        <div class="mode-tabs">
          <button class="mode-tab ${state.currentMode === 'food' ? 'active' : ''}" data-mode="food" onclick="switchMode('food')">🍎 Food</button>
          <button class="mode-tab ${state.currentMode === 'recipe' ? 'active' : ''}" data-mode="recipe" onclick="switchMode('recipe')">📝 Recipe</button>
          <button class="mode-tab ${state.currentMode === 'photo' ? 'active' : ''}" data-mode="photo" onclick="switchMode('photo')">📸 Photo</button>
          <button class="mode-tab ${state.currentMode === 'link' ? 'active' : ''}" data-mode="link" onclick="switchMode('link')">🔍 Search</button>
        </div>
        <div class="mode-panel ${state.currentMode === 'recipe' ? 'active' : ''}" id="mode-recipe">
          <textarea class="recipe-textarea" id="recipe-input" placeholder="Describe your recipe or paste ingredients...&#10;&#10;e.g. Grilled chicken breast 200g, brown rice 1 cup, olive oil 1 tbsp"></textarea>
        </div>
        <div class="mode-panel ${state.currentMode === 'photo' ? 'active' : ''}" id="mode-photo">
          <div class="upload-area" id="upload-area" onclick="document.getElementById('file-input').click()">
            <div id="upload-inner"><div class="upload-icon">📸</div><div class="upload-text">Drop a photo of your food</div><div class="upload-hint">supports jpg, png, webp</div></div>
          </div>
          <input type="file" id="file-input" accept="image/*" style="display:none" />
        </div>
        <div class="mode-panel ${state.currentMode === 'link' ? 'active' : ''}" id="mode-link">
          <input class="link-input" type="url" id="link-input" placeholder="Paste URL (optional)..." style="margin-bottom:8px" />
          <textarea class="recipe-textarea" id="dish-name-input" rows="2" placeholder="What's the dish? (required)&#10;e.g. Skillet chicken cacciatore..."></textarea>
          <div class="link-note">Instagram/TikTok are private — AI searches the web for the recipe by dish name.</div>
        </div>
        <div class="mode-panel ${state.currentMode === 'food' ? 'active' : ''}" id="mode-food">
          <!-- Three sub-options for single food items -->
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
            <button class="food-sub-btn ${state.foodMode === 'barcode' ? 'active' : ''}"
              onclick="setFoodMode('barcode')" id="food-btn-barcode">
              <span style="font-size:20px;display:block;margin-bottom:3px">📷</span>
              <span style="font-size:11px">Scan barcode</span>
            </button>
            <button class="food-sub-btn ${state.foodMode === 'label' ? 'active' : ''}"
              onclick="setFoodMode('label')" id="food-btn-label">
              <span style="font-size:20px;display:block;margin-bottom:3px">🏷️</span>
              <span style="font-size:11px">Snap label</span>
            </button>
            <button class="food-sub-btn ${state.foodMode === 'search' ? 'active' : ''}"
              onclick="setFoodMode('search')" id="food-btn-search">
              <span style="font-size:20px;display:block;margin-bottom:3px">🔤</span>
              <span style="font-size:11px">Describe food</span>
            </button>
          </div>

          <!-- Barcode scanner -->
          <div id="food-panel-barcode" style="${state.foodMode !== 'barcode' ? 'display:none' : ''}">
            <!-- Tap area opens camera on iOS via file input capture -->
            <div id="barcode-scanner-area" style="border:1.5px dashed var(--border2);border-radius:var(--r);overflow:hidden;position:relative;background:var(--bg3);min-height:120px;display:flex;align-items:center;justify-content:center;cursor:pointer"
              onclick="document.getElementById('barcode-file-input').click()">
              <div id="barcode-scanner-inner" style="text-align:center;padding:20px">
                <div style="font-size:28px;margin-bottom:6px">📷</div>
                <div style="font-size:13px;color:var(--text2)">Tap to scan barcode</div>
                <div style="font-size:11px;color:var(--text3);margin-top:3px">Opens camera — point at barcode</div>
              </div>
              <video id="barcode-video" style="display:none;width:100%;border-radius:var(--r)" autoplay playsinline muted></video>
            </div>
            <input type="file" id="barcode-file-input" accept="image/*" capture="environment" style="display:none"
              onchange="handleBarcodeImage(this.files[0])" />
            <div id="barcode-status" style="font-size:12px;color:var(--text3);margin-top:6px;text-align:center;min-height:18px"></div>
            <input id="barcode-manual-input" class="link-input" placeholder="Or type barcode number..." style="margin-top:6px"
              onkeydown="if(event.key==='Enter')lookupBarcode(this.value)" />
          </div>

          <!-- Label photo -->
          <div id="food-panel-label" style="${state.foodMode === 'label' ? '' : 'display:none'}">
            <div class="upload-area" id="label-upload-area" onclick="document.getElementById('label-file-input').click()">
              <div id="label-upload-inner">
                <div class="upload-icon">🏷️</div>
                <div class="upload-text">Snap or upload nutrition label</div>
                <div class="upload-hint">the white nutrition facts panel</div>
              </div>
            </div>
            <input type="file" id="label-file-input" accept="image/*" style="display:none" />
          </div>

          <!-- Manual food search -->
          <div id="food-panel-search" style="${state.foodMode === 'search' ? '' : 'display:none'}">
            <input class="link-input" id="food-search-input"
              placeholder="e.g. RXBAR Chocolate Sea Salt, greek yogurt 150g, Quest bar..."
              style="margin-bottom:6px" />
            <div style="font-size:11px;color:var(--text3)">AI looks up the exact nutrition facts for the product or food you describe</div>
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

    <div class="log-card">
      <div class="log-header">
        <span class="log-header-title">Today's meals</span>
        <button class="clear-btn" onclick="clearTodayLog()">Clear today</button>
      </div>
      <div id="today-log-body">${renderTodayMeals(todayLog)}</div>
    </div>
  `

  updateStats()
  wireFileInput()
  if (state.currentMode === 'food') {
    if (state.foodMode === 'label') wireLabelFileInput()
    if (state.foodMode === 'barcode') wireBarcodeInput()
  }

  // Restore image preview if exists
  if (state.imageBase64) {
    const inner = document.getElementById('upload-inner')
    if (inner) inner.innerHTML = `<img src="data:image/jpeg;base64,${state.imageBase64}" class="preview-img" alt="preview">`
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
    return '<div class="log-empty">No meals yet today. Analyze a meal or check off a planned meal to get started.</div>'
  }

  const html = []
  activeMealTypes.forEach(mealType => {
    const logs = grouped[mealType]
    const plans = plannedByType[mealType]
    const mealCal = logs.reduce((a, e) => a + (e.calories || 0), 0)
    const mealP   = logs.reduce((a, e) => a + (e.protein  || 0), 0)
    const mealC   = logs.reduce((a, e) => a + (e.carbs    || 0), 0)
    const mealF   = logs.reduce((a, e) => a + (e.fat      || 0), 0)
    const icon = MEAL_TYPE_ICONS[mealType] || ''

    const macroSummary = logs.length
      ? '<span style="font-size:11px;color:var(--text3)">'
        + '<span style="color:var(--accent)">' + Math.round(mealCal) + '</span> kcal'
        + '<span style="color:var(--protein);margin-left:6px">P' + Math.round(mealP) + '</span>'
        + '<span style="color:var(--carbs);margin-left:4px">C' + Math.round(mealC) + '</span>'
        + '<span style="color:var(--fat);margin-left:4px">F' + Math.round(mealF) + '</span>'
        + '</span>'
      : ''

    html.push(
      '<div style="margin-bottom:4px">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px 4px;background:var(--bg3)">'
      + '<span style="font-size:12px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px">' + icon + ' ' + mealType + '</span>'
      + macroSummary
      + '</div>'
    )

    // Planned meals
    plans.forEach(m => {
      const mealName = m.meal_name || m.name || ''
      const isLogged = loggedNames.has(mealName.toLowerCase())
      const checkmark = isLogged
        ? '<svg width="10" height="10" viewBox="0 0 10 10"><polyline points="1.5,5 4,7.5 8.5,2" stroke="white" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>'
        : ''
      html.push(
        '<div style="display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--border);opacity:' + (isLogged ? '0.45' : '1') + ';cursor:pointer"'
        + ' onclick="logPlannedMeal('' + m.id + '', '' + mealType + '')">'
        + '<div style="width:20px;height:20px;border-radius:50%;border:2px solid ' + (isLogged ? 'var(--protein)' : 'var(--border2)') + ';background:' + (isLogged ? 'var(--protein)' : 'none') + ';flex-shrink:0;display:flex;align-items:center;justify-content:center">'
        + checkmark + '</div>'
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-size:13px;color:var(--text2)' + (isLogged ? ';text-decoration:line-through' : '') + '">' + esc(mealName) + '</div>'
        + '<div style="font-size:11px;color:var(--text3)">Planned · ' + Math.round(m.calories || 0) + ' kcal</div>'
        + '</div>'
        + (!isLogged ? '<span style="font-size:11px;color:var(--text3);flex-shrink:0">Log it →</span>' : '')
        + '</div>'
      )
    })

    // Logged entries
    logs.forEach(e => {
      const d = new Date(e.logged_at || e.timestamp)
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const servingBadge = e.servings_consumed && e.servings_consumed != 1
        ? '<span style="font-size:10px;color:var(--text3);margin-left:4px">x' + e.servings_consumed + '</span>' : ''
      const entryIcon = MEAL_TYPE_ICONS[e._mealType] || ''
      html.push(
        '<div onclick="openEditModal('' + e.id + '', 'log')"'
        + ' style="display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--border);cursor:pointer"'
        + ' onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">'
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-size:13px;color:var(--text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e.name) + servingBadge + '</div>'
        + '<div style="font-size:11px;color:var(--text3);margin-top:1px;display:flex;align-items:center;gap:6px">'
        + '<span>' + timeStr + '</span>'
        + '<button onclick="changeMealType('' + e.id + '', '' + e._mealType + '');event.stopPropagation()"'
        + ' style="background:none;border:none;font-size:10px;color:var(--text3);cursor:pointer;padding:0;font-family:inherit"'
        + ' onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text3)'">'
        + entryIcon + ' ' + e._mealType + ' ▾</button>'
        + '</div></div>'
        + '<div style="text-align:right;flex-shrink:0;font-size:12px">'
        + '<div style="color:var(--accent);font-weight:600">' + Math.round(e.calories) + ' kcal</div>'
        + '<div style="color:var(--text3)">P' + Math.round(e.protein) + ' C' + Math.round(e.carbs) + ' F' + Math.round(e.fat) + '</div>'
        + '</div></div>'
      )
    })

    if (!plans.length && !logs.length) {
      html.push('<div style="padding:10px 16px;font-size:12px;color:var(--text3)">Nothing logged yet</div>')
    }

    html.push('</div>')
  })

  return html.join('')
}



  if (!entries.length) return `<div class="log-empty">${isToday ? 'No entries yet. Analyze a meal to get started.' : 'No history yet.'}</div>`
  return `
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
      <table class="log-table" style="min-width:480px;width:100%">
        <thead>
          <tr>
            <th style="text-align:left">Meal</th>
            <th>${isToday ? 'Time' : 'Date'}</th>
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
              : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
            const servingBadge = e.servings_consumed && e.servings_consumed != 1
              ? `<span style="font-size:10px;color:var(--text3);margin-left:4px">×${e.servings_consumed}</span>` : ''
            return `<tr style="cursor:pointer" onclick="openEditModal('${e.id}', 'log')">
              <td class="td-name" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${esc(e.name)}${servingBadge}
              </td>
              <td class="td-time">${timeStr}</td>
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

      ${!isCurrentWeek ? `<button onclick="jumpToToday()" style="background:rgba(232,197,71,0.12);color:var(--accent);border:1px solid rgba(232,197,71,0.3);border-radius:var(--r);padding:6px 12px;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap">Today</button>` : ''}
    </div>

    <!-- Calendar picker -->
    ${state.showCalendar ? renderCalendarPicker() : ''}

    <!-- Planner / Grocery tabs -->
    <div style="display:flex;gap:4px;margin-bottom:20px;margin-top:16px">
      <button class="mode-tab ${state.plannerView !== 'grocery' ? 'active' : ''}" onclick="setPlannerView('meals')" style="flex:0 0 auto;padding:8px 18px">📅 Meal plan</button>
      <button class="mode-tab ${state.plannerView === 'grocery' ? 'active' : ''}" onclick="setPlannerView('grocery')" style="flex:0 0 auto;padding:8px 18px">🛒 Grocery list</button>
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
                  color:${isSelected ? '#1a1500' : isToday ? 'var(--accent)' : 'var(--text)'};
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
                  style="width:100%;text-align:left;background:${isSelected ? 'rgba(232,197,71,0.12)' : 'none'};
                    border:1px solid ${isSelected ? 'rgba(232,197,71,0.3)' : 'transparent'};
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
  return `
    <div class="planner-summary">
      <div class="planner-summary-title">Weekly calorie overview</div>
      <div class="planner-summary-grid">
        ${DAYS.map((day, di) => {
          const meals = planner.meals[di] || []
          const cal = meals.reduce((a, m) => a + (m.calories || 0), 0)
          const p = meals.reduce((a, m) => a + (m.protein || 0), 0)
          const c = meals.reduce((a, m) => a + (m.carbs || 0), 0)
          const f = meals.reduce((a, m) => a + (m.fat || 0), 0)
          return `<div class="planner-day-summary">
            <div class="pds-name">${day}</div>
            <div class="pds-cal">${Math.round(cal)}</div>
            <div class="pds-macros">P${Math.round(p)} C${Math.round(c)} F${Math.round(f)}</div>
          </div>`
        }).join('')}
      </div>
    </div>
    <div class="planner-grid">
      ${DAYS.map((day, di) => {
        const meals = planner.meals[di] || []
        const cal = meals.reduce((a, m) => a + (m.calories || 0), 0)
        const mealItems = meals.map((m, mi) => `
          <div class="planner-meal" onclick="openEditModal('${m.id}', 'planner', {d:${di},m:${mi}})">
            <div class="planner-meal-name">${esc(m.meal_name || m.name)}</div>
            <div class="planner-meal-cals">${Math.round(m.calories)} kcal</div>
            <button class="planner-meal-del" onclick="deletePlannerMealHandler('${m.id}',${di},${mi});event.stopPropagation()">×</button>
          </div>`).join('')
        return `<div class="planner-day">
          <div class="planner-day-header">
            <span class="planner-day-name">${day}</span>
            <span class="planner-day-cals">${Math.round(cal)} kcal</span>
          </div>
          <div class="planner-meals">${mealItems}</div>
          <button class="planner-add-btn" onclick="openPlannerModal(${di})">+ Add meal</button>
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
      <div style="display:flex;gap:8px;align-items:center">
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

function originalMealName(meal) {
  return (meal.meal_name || meal.name || '').replace(/\s*\(leftovers\)\s*$/i, '').trim()
}

const CATEGORIES = {
  produce:    { label: 'Produce',    emoji: '🥦', color: 'var(--protein)' },
  protein:    { label: 'Protein',    emoji: '🥩', color: 'var(--fat)' },
  dairy:      { label: 'Dairy',      emoji: '🧀', color: 'var(--carbs)' },
  pantry:     { label: 'Pantry',     emoji: '🥫', color: 'var(--text2)' },
  spices:     { label: 'Spices',     emoji: '🧂', color: '#c4a8f0' },
  grains:     { label: 'Grains',     emoji: '🌾', color: 'var(--cal)' },
  frozen:     { label: 'Frozen',     emoji: '🧊', color: 'var(--carbs)' },
  bakery:     { label: 'Bakery',     emoji: '🍞', color: 'var(--fat)' },
  beverages:  { label: 'Beverages',  emoji: '🧃', color: 'var(--text2)' },
  other:      { label: 'Other',      emoji: '📦', color: 'var(--text3)' },
}
const CATEGORY_ORDER = ['produce','protein','dairy','grains','pantry','spices','frozen','bakery','beverages','other']

// ── Unit conversion helpers ────────────────────────────────────────────────────
const UNIT_TO_OZ = { lbs: 16, lb: 16, oz: 1, g: 0.03527, kg: 35.27 }
const OZ_CONVERSIONS = ['lbs','lb','oz','g','kg']

function toOz(amount, unit) {
  const factor = UNIT_TO_OZ[unit?.toLowerCase()]
  return factor ? amount * factor : null
}

function formatAmount(oz, preferUnit) {
  if (oz === null) return null
  if (oz >= 16) return { amount: +(oz / 16).toFixed(2), unit: 'lbs' }
  return { amount: +oz.toFixed(2), unit: 'oz' }
}

function sumIngredients(items) {
  // items: [{name, amount (number), unit, category, excluded, mealName}]
  // Group by name+unit where possible, summing amounts
  const grouped = {}
  items.forEach(item => {
    if (item.excluded) return
    const key = item.name.toLowerCase().trim()
    if (!grouped[key]) {
      grouped[key] = { ...item, totalAmount: parseFloat(item.amount) || 0, meals: [item.mealName] }
    } else {
      const existing = grouped[key]
      // Try to convert to oz for summing
      const existOz = toOz(existing.totalAmount, existing.unit)
      const newOz = toOz(parseFloat(item.amount) || 0, item.unit)
      if (existOz !== null && newOz !== null) {
        const totalOz = existOz + newOz
        const fmt = formatAmount(totalOz)
        existing.totalAmount = fmt.amount
        existing.unit = fmt.unit
      } else if (existing.unit === item.unit) {
        existing.totalAmount += parseFloat(item.amount) || 0
      } else {
        // Different units that can't convert — add separate entry
        const altKey = `${key}_${item.unit}`
        if (!grouped[altKey]) grouped[altKey] = { ...item, totalAmount: parseFloat(item.amount) || 0, meals: [item.mealName] }
        else { grouped[altKey].totalAmount += parseFloat(item.amount) || 0; grouped[altKey].meals.push(item.mealName) }
        return
      }
      if (!existing.meals.includes(item.mealName)) existing.meals.push(item.mealName)
    }
  })
  return Object.values(grouped)
}

function collectAllIngredients(planner, rangeMeals) {
  // Use rangeMeals if provided (cross-week), else fall back to current week planner
  const items = []
  if (!state.excludedIngredients) state.excludedIngredients = new Set()

  const meals = rangeMeals || planner?.meals?.flat() || []

  meals.forEach(m => {
    if (isLeftover(m)) return

    const mealName = m.meal_name || m.name
    const recipe = state.recipes.find(r => r.name.toLowerCase() === mealName.toLowerCase())
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
      items.push({
        name: ing.name,
        amount: (parseFloat(ing.amount) || 0) * multiplier,
        unit: ing.unit || '',
        category: ing.category || 'other',
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
            ${items.map(item => `
              <div style="display:flex;align-items:center;gap:10px;padding:10px 20px;border-bottom:1px solid var(--border)">
                <span style="font-weight:600;color:${cfg.color};min-width:80px;font-size:13px">
                  ${item.totalAmount ? `${item.totalAmount % 1 === 0 ? item.totalAmount : +item.totalAmount.toFixed(2)} ${item.unit}` : '—'}
                </span>
                <span style="flex:1;font-size:14px;color:var(--text)">${esc(item.name)}</span>
                <span style="font-size:11px;color:var(--text3)">${item.meals?.join(', ') || ''}</span>              </div>`).join('')}
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

              return `
                <div style="margin-bottom:12px;padding:10px 12px;background:var(--bg3);border-radius:var(--r)">
                  ${isLeftover(m) ? `
                    <!-- Leftover meal — ingredients not duplicated -->
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
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                      <div style="font-size:13px;font-weight:500;color:var(--text)">${esc(mealName)}</div>
                      ${!ingredients.length
                        ? `<button class="clear-btn" style="color:var(--carbs);font-size:11px" onclick="fetchAndSaveIngredients('${m.id}', '${mealName.replace(/'/g,"\\'")}')">✨ AI extract</button>`
                        : `<span style="font-size:11px;color:var(--text3)">${ingredients.length} ingredients</span>`}
                    </div>

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
                          const adjustedAmt = (parseFloat(ing.amount) || 0) * multiplier
                          const displayAmt = adjustedAmt % 1 === 0 ? adjustedAmt : +adjustedAmt.toFixed(2)
                          const cat = CATEGORIES[ing.category] || CATEGORIES.other
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
  const q = state.foodSearch || ''
  const filtered = q ? items.filter(f => f.name.toLowerCase().includes(q.toLowerCase()) || (f.brand||'').toLowerCase().includes(q.toLowerCase())) : items

  container.innerHTML = `
    <div class="greeting">My Foods</div>
    <div class="greeting-sub">Saved food items — single foods, combos, protein shakes.</div>

    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
      <input class="planner-search" placeholder="Search foods..." value="${esc(q)}"
        oninput="state.foodSearch=this.value;renderPage()" style="flex:1;min-width:180px" />
      <button class="analyze-btn" style="width:auto;padding:10px 20px;flex-shrink:0" onclick="openFoodItemModal()">+ New food</button>
    </div>

    ${!filtered.length ? `
      <div class="log-card">
        <div class="log-empty" style="padding:60px">
          ${items.length ? 'No matches.' : 'No saved foods yet.'}<br>
          <span style="font-size:12px;color:var(--text3);margin-top:6px;display:block">
            Save packaged foods from barcode scan, or build combos like protein shakes.
          </span>
        </div>
      </div>
    ` : `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
        ${filtered.map(f => `
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
              style="width:100%;background:rgba(232,197,71,0.1);color:var(--accent);border:1px solid rgba(232,197,71,0.25);border-radius:var(--r);padding:8px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer">
              + Log this
            </button>
          </div>`).join('')}
      </div>
    `}
  `
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
        <input type="file" id="comp-label-file" accept="image/*" capture="environment" style="display:none"
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
  const recipes = state.recipes
  container.innerHTML = `
    <div class="greeting">Recipes</div>
    <div class="greeting-sub">Saved recipes with ingredients and macros per serving.</div>

    <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">
      <button class="analyze-btn" style="width:auto;padding:10px 20px" onclick="openNewRecipeModal()">+ New recipe</button>
    </div>

    ${!recipes.length ? `
      <div class="log-card">
        <div class="log-empty" style="padding:60px">
          No recipes saved yet.<br>
          <span style="font-size:12px;color:var(--text3);margin-top:6px;display:block">Analyze a meal and save it as a recipe, or create one manually.</span>
        </div>
      </div>
    ` : `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">
        ${recipes.map(r => `
          <div class="upload-card" style="cursor:pointer;transition:border-color 0.15s" onmouseover="this.style.borderColor='var(--border2)'" onmouseout="this.style.borderColor='var(--border)'" onclick="openRecipeModal('${r.id}')">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
              <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--text);flex:1;margin-right:12px">${esc(r.name)}</div>
              <span style="font-size:11px;color:var(--text3);background:var(--bg3);border-radius:4px;padding:2px 7px;white-space:nowrap">${r.servings} serving${r.servings !== 1 ? 's' : ''}</span>
            </div>
            ${r.description ? `<div style="font-size:12px;color:var(--text2);margin-bottom:10px;line-height:1.5">${esc(r.description)}</div>` : ''}
            <div class="macro-pills" style="margin-bottom:10px">
              <span class="macro-pill pill-cal">${Math.round(r.calories)} kcal</span>
              <span class="macro-pill pill-p">${Math.round(r.protein)}g P</span>
              <span class="macro-pill pill-c">${Math.round(r.carbs)}g C</span>
              <span class="macro-pill pill-f">${Math.round(r.fat)}g F</span>
            </div>
            ${r.ingredients?.length ? `
              <div style="font-size:11px;color:var(--text3)">${r.ingredients.length} ingredients · <span style="color:var(--text2)">per 1 of ${r.servings} servings</span></div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `}
  `

  document.getElementById('recipe-modal')?.addEventListener('click', e => {
    if (e.target.id === 'recipe-modal') closeRecipeModal()
  })
}

function renderRecipeModalContent(recipe, mode = 'view') {
  const isNew = !recipe.id
  const ingredients = recipe.ingredients || []
  const isView = mode === 'view' && !isNew

  return `
    <div style="position:relative">

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
            <button onclick="openPlanRecipeModal('${recipe.id}')"
              style="background:var(--accent);color:#1a1500;border:none;border-radius:var(--r);padding:7px 12px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0">
              📅 Plan
            </button>
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

        <!-- Source URL -->
        ${mode === 'edit' || isNew ? `
          <div class="modal-field">
            <label>Source URL (optional)</label>
            <input type="url" id="recipe-source-url" value="${esc(recipe.source_url || '')}"
              placeholder="https://... Instagram, YouTube, website..." />
          </div>
        ` : recipe.source_url ? `
          <div style="margin-bottom:16px">
            <a href="${esc(recipe.source_url)}" target="_blank" rel="noopener"
              style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--accent);text-decoration:none;padding:8px 12px;background:rgba(232,197,71,0.08);border:1px solid rgba(232,197,71,0.2);border-radius:var(--r)">
              <span>🔗</span>
              <span>View original recipe</span>
              <span style="font-size:11px;opacity:0.7">↗</span>
            </a>
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

        <!-- Ingredients / Instructions toggle (view mode only) -->
        <div style="margin-bottom:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <div style="display:flex;gap:0;background:var(--bg3);border-radius:var(--r);padding:3px;border:1px solid var(--border)">
              <button onclick="setRecipeTab('ingredients')" id="rtab-ingredients"
                class="${(recipe.instructions?.steps?.length && state.recipeTab === 'instructions') ? '' : 'active'}"
                style="padding:5px 14px;border:none;border-radius:calc(var(--r) - 2px);font-size:12px;font-family:inherit;cursor:pointer;font-weight:500;
                  background:${(!recipe.instructions?.steps?.length || state.recipeTab !== 'instructions') ? 'var(--bg2)' : 'none'};
                  color:${(!recipe.instructions?.steps?.length || state.recipeTab !== 'instructions') ? 'var(--text)' : 'var(--text3)'}">
                📋 Ingredients
              </button>
              <button onclick="setRecipeTab('instructions')" id="rtab-instructions"
                style="padding:5px 14px;border:none;border-radius:calc(var(--r) - 2px);font-size:12px;font-family:inherit;cursor:pointer;font-weight:500;
                  background:${(recipe.instructions?.steps?.length && state.recipeTab === 'instructions') ? 'var(--bg2)' : 'none'};
                  color:${(recipe.instructions?.steps?.length && state.recipeTab === 'instructions') ? 'var(--text)' : 'var(--text3)'}">
                👨‍🍳 Instructions
              </button>
            </div>
            ${(recipe.instructions?.steps?.length && state.recipeTab === 'instructions') ? `
              <button onclick="downloadRecipeInstructions('${recipe.id}')"
                style="background:none;border:1px solid var(--border2);border-radius:var(--r);padding:5px 10px;font-size:12px;color:var(--text2);cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:4px"
                onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)'">
                ⬇ Download
              </button>` : ''}
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
                <div style="font-size:13px;color:var(--text2);margin-bottom:12px">No instructions yet</div>
                <button onclick="generateInstructionsHandler('${recipe.id}')" id="gen-instr-btn" class="pm-analyze-btn" style="margin:0">
                  ✨ Generate cooking instructions with AI
                </button>
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
                <div style="margin-top:16px;padding:12px;background:rgba(232,197,71,0.06);border-radius:var(--r);border:1px solid rgba(232,197,71,0.15)">
                  <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:8px">Tips</div>
                  ${recipe.instructions.tips.map(t => `<div style="font-size:13px;color:var(--text2);margin-bottom:4px">• ${esc(t)}</div>`).join('')}
                </div>` : ''}
              <button onclick="generateInstructionsHandler('${recipe.id}')" id="gen-instr-btn"
                style="margin-top:14px;background:none;border:1px solid var(--border);border-radius:var(--r);padding:6px 12px;font-size:12px;color:var(--text3);cursor:pointer;font-family:inherit;width:100%"
                onmouseover="this.style.color='var(--carbs)'" onmouseout="this.style.color='var(--text3)'">
                ✨ Regenerate instructions
              </button>
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
          ${isView ? `
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
    // Get week start (Sunday)
    const ws = new Date(d)
    ws.setDate(d.getDate() - d.getDay())
    days.push({
      dateStr,
      label: DAYS_SHORT[d.getDay()],
      dayNum: d.getDate(),
      month: d.toLocaleDateString([], { month: 'short' }),
      weekStart: localDateStr(ws),
      isToday: i === 0,
      isFirstOfMonth: d.getDate() === 1 || i === 0
    })
  }

  return `
    <div style="padding:24px 24px 20px">
      <button class="modal-close" onclick="closePlanRecipeModal()" style="position:absolute;top:16px;right:16px">×</button>
      <h3 style="margin:0 0 4px;font-size:18px">Add to meal plan</h3>
      <div style="font-size:13px;color:var(--text3);margin-bottom:20px">${esc(recipe.name)}</div>

      <!-- Day picker -->
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px">Pick day(s) to eat this</div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:20px" id="plan-day-grid">
        ${DAYS_SHORT.map(d => `<div style="text-align:center;font-size:10px;color:var(--text3);padding:2px 0">${d}</div>`).join('')}
        ${days.map(d => `
          <button data-date="${d.dateStr}"
            onclick="togglePlanDay('${d.dateStr}')"
            style="aspect-ratio:1;border-radius:6px;border:1px solid var(--border);background:${d.isToday ? 'rgba(232,197,71,0.12)' : 'var(--bg3)'};
              color:${d.isToday ? 'var(--accent)' : 'var(--text2)'};cursor:pointer;font-size:11px;font-family:inherit;
              outline:${d.isToday ? '1px solid var(--accent)' : 'none'};position:relative;padding:0"
            onmouseover="if(!this.classList.contains('plan-day-selected'))this.style.background='var(--bg4)'"
            onmouseout="if(!this.classList.contains('plan-day-selected'))this.style.background='${d.isToday ? 'rgba(232,197,71,0.12)' : 'var(--bg3)'}'">
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

      <!-- Add button -->
      <button id="plan-recipe-add-btn" onclick="confirmPlanRecipe('${recipe.id}')"
        style="width:100%;background:var(--accent);color:#1a1500;border:none;border-radius:var(--r);padding:14px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;opacity:0.4;pointer-events:none">
        Add to plan
      </button>
    </div>
  `
}


// Scale number+unit mentions in a step by a multiplier
function scaleStepText(step, baseServings, targetServings) {
  // Always escape the raw step text first for safety
  const safeStep = esc(step)
  if (!baseServings || !targetServings) return safeStep
  const multiplier = targetServings / baseServings
  if (Math.abs(multiplier - 1) < 0.01) return safeStep
  // Now replace number+unit patterns in the already-escaped text
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
  const rawAmt = parseFloat(ing.amount) || 0
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
function renderGoalsPage(container) {
  container.innerHTML = `
    <div class="greeting">Goals</div>
    <div class="greeting-sub">Set your daily macro targets.</div>
    <div class="upload-card" style="max-width:400px">
      <div class="section-title">Daily targets</div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div><label style="font-size:12px;color:var(--text3);display:block;margin-bottom:6px">Calories (kcal)</label>
          <input type="number" id="goal-cal" value="${state.goals.calories}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none"></div>
        <div><label style="font-size:12px;color:var(--text3);display:block;margin-bottom:6px">Protein (g)</label>
          <input type="number" id="goal-p" value="${state.goals.protein}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none"></div>
        <div><label style="font-size:12px;color:var(--text3);display:block;margin-bottom:6px">Carbs (g)</label>
          <input type="number" id="goal-c" value="${state.goals.carbs}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none"></div>
        <div><label style="font-size:12px;color:var(--text3);display:block;margin-bottom:6px">Fat (g)</label>
          <input type="number" id="goal-f" value="${state.goals.fat}" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);padding:10px 12px;color:var(--text);font-size:14px;font-family:inherit;outline:none"></div>
        <button class="analyze-btn" onclick="saveGoalsHandler()">Save goals</button>
      </div>
    </div>
  `
}

// ─── Account Page ─────────────────────────────────────────────────────────────
function renderAccount(container) {
  const u = state.usage
  const spentPct = u.isUnlimited ? 0 : Math.min(100, Math.round(((u.spent ?? 0) / (u.limit ?? 10)) * 100))
  const spentColor = spentPct >= 90 ? 'var(--red)' : spentPct >= 70 ? 'var(--fat)' : 'var(--accent)'

  container.innerHTML = `
    <div class="greeting">Account</div>
    <div class="greeting-sub">${state.user.email}</div>

    <!-- Usage card -->
    <div class="upload-card" style="max-width:520px;margin-bottom:20px">
      <div class="section-title">Usage this month</div>
      ${u.isUnlimited ? `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
          <span style="background:rgba(232,197,71,0.15);color:var(--accent);border:1px solid rgba(232,197,71,0.3);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:500">
            ${u.isAdmin ? '👑 Admin — unlimited access' : '⭐ Unlimited access'}
          </span>
        </div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
        <div class="stat-card" style="padding:12px">
          <div class="stat-label">Spent</div>
          <div class="stat-val" style="font-size:20px;color:${spentColor}">$${Number(u.spent ?? 0).toFixed(4)}</div>
          ${!u.isUnlimited ? `<div class="stat-sub">of $${Number(u.limit ?? 10).toFixed(2)} limit</div>` : '<div class="stat-sub">unlimited</div>'}
        </div>
        <div class="stat-card" style="padding:12px">
          <div class="stat-label">Requests</div>
          <div class="stat-val" style="font-size:20px;color:var(--carbs)">${u.requests ?? 0}</div>
          <div class="stat-sub">this month</div>
        </div>
        <div class="stat-card" style="padding:12px">
          <div class="stat-label">Tokens</div>
          <div class="stat-val" style="font-size:20px;color:var(--protein)">${((u.tokens ?? 0) / 1000).toFixed(1)}k</div>
          <div class="stat-sub">this month</div>
        </div>
      </div>
      ${!u.isUnlimited ? `
      <div>
        <div class="bar-row-label" style="margin-bottom:6px">
          <span class="bar-label">Monthly budget</span>
          <span class="bar-val" style="color:${spentColor}">$${Number(u.spent ?? 0).toFixed(4)} / $${Number(u.limit ?? 10).toFixed(2)}</span>
        </div>
        <div class="bar-bg" style="height:10px">
          <div class="bar-fill" style="background:${spentColor};width:${spentPct}%"></div>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:6px">$${Number(u.remaining ?? 0).toFixed(4)} remaining · Resets 1st of each month</div>
      </div>` : ''}
      ${u.breakdown && Object.keys(u.breakdown).length ? `
      <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">By feature</div>
        ${Object.entries(u.breakdown).map(([feature, cost]) => `
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
            <span style="color:var(--text2);text-transform:capitalize">${feature}</span>
            <span style="color:var(--text)">$${Number(cost).toFixed(4)}</span>
          </div>`).join('')}
      </div>` : ''}
    </div>

    <!-- AI info -->
    <div class="upload-card" style="max-width:520px;margin-bottom:20px">
      <div class="section-title">AI analysis</div>
      <p style="font-size:13px;color:var(--text2);line-height:1.6">
        Food analysis is powered by Claude AI and runs securely on our servers.
        No API key needed — usage is tracked and billed against your monthly budget above.
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
                  ${u.is_admin ? '<span style="font-size:10px;background:rgba(232,197,71,0.15);color:var(--accent);border-radius:4px;padding:1px 5px">admin</span>' : ''}
                  ${u.unlimited_access ? '<span style="font-size:10px;background:rgba(126,200,160,0.15);color:var(--protein);border-radius:4px;padding:1px 5px">unlimited</span>' : ''}
                  ${isNew ? '<span style="font-size:10px;background:rgba(126,200,160,0.2);color:var(--protein);border-radius:4px;padding:1px 5px">🆕 new</span>' : ''}
                </div>
                <div style="font-size:11px;color:var(--text3);margin-top:3px">
                  Joined ${joinDate} · Last active ${lastActive} · ${u.log_entries_total ?? 0} meals · ${u.recipe_count ?? 0} recipes · ${u.food_item_count ?? 0} foods
                </div>
              </div>
              <div style="display:flex;gap:4px;flex-shrink:0">
                <button class="td-act" title="Toggle unlimited" onclick="toggleUnlimited('${u.user_id}', ${u.unlimited_access})">
                  ${u.unlimited_access ? '🔓' : '🔒'}
                </button>
                <button class="td-act" title="Toggle admin" onclick="toggleAdmin('${u.user_id}', ${u.is_admin})">
                  ${u.is_admin ? '👑' : '👤'}
                </button>
                <button class="td-act" title="${u.account_status === 'active' ? 'Suspend' : 'Activate'}"
                  onclick="toggleSuspend('${u.user_id}', '${u.account_status}')"
                  style="color:${u.account_status === 'active' ? 'var(--text3)' : 'var(--green)'}">
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

  if (state.currentMode === 'photo') {
    if (!state.imageBase64) { showToast('Please upload a food image first', 'error'); return null }
    return await analyzePhoto(state.imageBase64, mealHint)
  } else if (state.currentMode === 'recipe') {
    const recipe = document.getElementById('recipe-input')?.value.trim()
    if (!recipe) { showToast('Please describe your recipe first', 'error'); return null }
    return await analyzeRecipe(recipe, mealHint)
  } else if (state.currentMode === 'link') {
    const dishName = document.getElementById('dish-name-input')?.value.trim()
    const link = document.getElementById('link-input')?.value.trim()
    if (!dishName) { showToast('Please enter the dish name', 'error'); return null }
    return await analyzeDishBySearch(dishName, link)
  } else if (state.currentMode === 'food') {
    if (state.foodMode === 'search') {
      const desc = document.getElementById('food-search-input')?.value.trim()
      if (!desc) { showToast('Please describe the food first', 'error'); return null }
      return await analyzeFoodItem(desc)
    } else if (state.foodMode === 'label') {
      if (!state.labelImageBase64) { showToast('Please upload a nutrition label photo first', 'error'); return null }
      return await analyzeNutritionLabel(state.labelImageBase64)
    } else {
      showToast('Use the scan or manual barcode entry above', 'error'); return null
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
  el.innerHTML = renderTodayMeals(getTodayLog())
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

function handleFile(file) {
  const reader = new FileReader()
  reader.onload = ev => {
    state.imageBase64 = ev.target.result.split(',')[1]
    const inner = document.getElementById('upload-inner')
    if (inner) inner.innerHTML = `<img src="${ev.target.result}" class="preview-img" alt="preview">`
    const empty = document.getElementById('result-empty')
    if (empty) empty.style.display = 'none'
  }
  reader.readAsDataURL(file)
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

  window.switchMode = (mode) => {
    state.currentMode = mode
    if (mode !== 'photo') state.imageBase64 = null
    // Toggle panels
    ;['recipe', 'photo', 'link', 'food'].forEach(m => {
      const panel = document.getElementById(`mode-${m}`)
      if (panel) panel.classList.toggle('active', m === mode)
    })
    // Toggle tab buttons — use data-mode attribute
    document.querySelectorAll('.mode-tab[data-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode)
    })
    if (mode === 'food') {
      if (state.foodMode === 'label') wireLabelFileInput()
      if (state.foodMode === 'barcode') wireBarcodeInput()
    }
  }

  window.setFoodMode = (mode) => {
    state.foodMode = mode
    ;['barcode', 'label', 'search'].forEach(m => {
      const panel = document.getElementById(`food-panel-${m}`)
      const btn = document.getElementById(`food-btn-${m}`)
      if (panel) panel.style.display = m === mode ? '' : 'none'
      if (btn) btn.classList.toggle('active', m === mode)
    })
    if (mode === 'label') wireLabelFileInput()
    if (mode === 'barcode') wireBarcodeInput()
  }

  // ── Barcode scanner ─────────────────────────────────────────────
  window.startBarcodeScanner = async () => {
    const video = document.getElementById('barcode-video')
    const inner = document.getElementById('barcode-scanner-inner')
    const status = document.getElementById('barcode-status')

    // iOS Safari doesn't support BarcodeDetector or getUserMedia reliably
    // Best approach: use file input with camera capture, then decode with ZXing
    const fileInput = document.getElementById('barcode-file-input')
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
    // Downscale large photos first (12MP → much faster decode)
    const bitmap = await createImageBitmap(file)
    const maxSize = 1200
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)

    // 1. Try native BarcodeDetector (free, instant)
    if ('BarcodeDetector' in window) {
      try {
        const detector = new window.BarcodeDetector({
          formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','qr_code']
        })
        const results = await detector.detect(canvas)
        if (results.length > 0) return results[0].rawValue
      } catch {}
    }

    // 2. Try ZXing WASM (free JS library)
    try {
      await loadZXing()
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9))
      const url = URL.createObjectURL(blob)
      const results = await window._ZXing.readBarcodesFromImageUrl(url, {
        formats: ['EAN-13','EAN-8','UPC-A','UPC-E','Code128','Code39']
      })
      URL.revokeObjectURL(url)
      if (results?.length > 0) return results[0].text
    } catch {}

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

  window.handleBarcodeImage = async (file) => {
    const status = document.getElementById('barcode-status')
    const inner = document.getElementById('barcode-scanner-inner')
    if (!file) return

    // Show preview
    const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = e => r(e.target.result); fr.readAsDataURL(file) })
    if (inner) inner.innerHTML = `<img src="${dataUrl}" style="max-height:140px;border-radius:var(--r);object-fit:contain" />`
    if (status) status.textContent = 'Reading barcode...'

    try {
      const code = await decodeBarcodeFromFile(file)
      if (code) {
        if (status) status.textContent = `Found: ${code} — looking up...`
        await lookupBarcode(code)
      } else {
        if (status) status.textContent = 'Could not read barcode — type the number below'
        const input = document.getElementById('barcode-manual-input')
        if (input) { input.focus(); input.style.borderColor = 'var(--accent)' }
      }
    } catch (e) {
      if (status) status.textContent = 'Read failed — type the number below'
      document.getElementById('barcode-manual-input')?.focus()
    }
  }

  function loadQuagga() { return Promise.resolve() } // no longer used


  window.lookupBarcode = async (code) => {
    code = String(code).trim()
    if (!code) return
    const status = document.getElementById('barcode-status')
    if (status) status.textContent = `Looking up ${code}...`
    const btn = document.getElementById('analyze-btn')
    try {
      const res = await fetch(`/api/barcode?upc=${code}`)
      const data = await res.json()
      if (!data.found) {
        if (status) status.textContent = `Not in database — try "Describe food" tab`
        showToast('Product not found — try describing it instead', 'error')
        return
      }
      if (status) status.textContent = `✓ Found: ${data.name}`
      state.currentEntry = { ...data, ingredients: [] }
      showResult(state.currentEntry)
    } catch (err) {
      if (status) status.textContent = 'Lookup failed'
      showToast('Lookup failed: ' + err.message, 'error')
    }
  }

  function wireBarcodeInput() {
    const input = document.getElementById('barcode-manual-input')
    if (!input || input._wired) return
    input._wired = true
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') lookupBarcode(input.value)
    })
  }

  // ── Nutrition label photo ───────────────────────────────────────
  function wireLabelFileInput() {
    const fi = document.getElementById('label-file-input')
    const ua = document.getElementById('label-upload-area')
    if (!fi || !ua || ua._wired) return
    ua._wired = true
    fi.addEventListener('change', e => { const f = e.target.files[0]; if (f) handleLabelFile(f) })
    ua.addEventListener('dragover', e => { e.preventDefault(); ua.style.borderColor = 'var(--accent)' })
    ua.addEventListener('dragleave', () => { ua.style.borderColor = '' })
    ua.addEventListener('drop', e => { e.preventDefault(); ua.style.borderColor = ''; const f = e.dataTransfer.files[0]; if (f) handleLabelFile(f) })
  }

  function handleLabelFile(file) {
    const reader = new FileReader()
    reader.onload = ev => {
      state.labelImageBase64 = ev.target.result.split(',')[1]
      const inner = document.getElementById('label-upload-inner')
      if (inner) inner.innerHTML = `<img src="${ev.target.result}" style="width:100%;border-radius:var(--r);max-height:180px;object-fit:contain" alt="label">`
    }
    reader.readAsDataURL(file)
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
    btn.disabled = true
    btn.innerHTML = '<span class="analyzing-spinner"></span> Analyzing...'
    try {
      const result = await doAnalyze()
      if (result) { state.currentEntry = result; showResult(result) }
    } catch (err) { showToast('Analysis failed: ' + err.message, 'error') }
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

  window.saveGoalsHandler = async () => {
    state.goals = {
      calories: parseInt(document.getElementById('goal-cal')?.value) || 2000,
      protein: parseInt(document.getElementById('goal-p')?.value) || 150,
      carbs: parseInt(document.getElementById('goal-c')?.value) || 200,
      fat: parseInt(document.getElementById('goal-f')?.value) || 65
    }
    try {
      await dbSaveGoals(state.user.id, state.goals)
      showToast('Goals saved!', 'success')
      updateSidebar()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.filterQuickLog = filterQuickLog

  // API key no longer needed client-side — handled by server proxy

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
    // Show consumed (already-multiplied) values in fields
    document.getElementById('edit-cal').value = Math.round(entry.calories || 0)
    document.getElementById('edit-protein').value = Math.round(entry.protein || 0)
    document.getElementById('edit-carbs').value = Math.round(entry.carbs || 0)
    document.getElementById('edit-fat').value = Math.round(entry.fat || 0)
    document.getElementById('edit-fiber').value = Math.round(entry.fiber || 0)
    document.getElementById('edit-sugar').value = Math.round(entry.sugar || 0)
    document.getElementById('edit-modal').classList.add('open')
  }

  window.closeEditModal = () => {
    document.getElementById('edit-modal').classList.remove('open')
    state.editingEntry = null
    state.editingBaseMacros = null
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
    state.plannerView = view
    renderPage()
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

  window.editCustomGroceryItem = (idx, val) => {
    if (!state.groceryCustomItems) return
    state.groceryCustomItems[idx].text = val
  }

  window.removeCustomGroceryItem = (idx) => {
    if (!state.groceryCustomItems) return
    state.groceryCustomItems.splice(idx, 1)
    renderPage()
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
  window.openPlannerModal = (dayIdx) => {
    state.plannerTarget = { dayIdx }
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

  window.addPhotoMealToPlannerHandler = async () => {
    if (!state.plannerTarget || !state.aiPlannerResult) return
    const r = state.aiPlannerResult
    const addAsLeftover = document.getElementById('leftover-check').checked
    const dayIdx = state.plannerTarget.dayIdx
    try {
      const meal = await addPlannerMeal(state.user.id, state.weekStart, dayIdx, { ...r })
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
        showToast(r.name + ' added to ' + DAYS[dayIdx] + '!', 'success')
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
    try {
      // Add to selected day
      const meal = await addPlannerMeal(state.user.id, state.weekStart, dayIdx, { ...r })
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
        showToast(`${r.name} added to ${DAYS[dayIdx]}!`, 'success')
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

  // ── Recipe handlers ─────────────────────────────────────────────
  window.openNewRecipeModal = () => {
    state.editingRecipe = { name: '', description: '', servings: 4, serving_label: 'serving', calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, ingredients: [] }
    document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, 'edit')
    document.getElementById('recipe-modal').classList.add('open')
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
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="analyzing-spinner"></span> Generating...' }
    try {
      const recipe = state.recipes.find(r => r.id === recipeId)
      if (!recipe) return
      const result = await generateRecipeInstructions(recipe)
      if (!result?.steps?.length) throw new Error('No instructions returned')

      // Update state immediately so UI shows them
      recipe.instructions = result
      state.editingRecipe = { ...state.editingRecipe, instructions: result }

      // Save directly via targeted update — only touches instructions column
      try {
        await saveRecipeInstructions(state.user.id, recipeId, result)
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
  .tips { background: #fffbeb; border: 1px solid #f0d060; border-radius: 8px; padding: 14px 18px; margin-top: 24px; }
  .tips h3 { margin: 0 0 8px; font-size: 15px; }
  .source { margin-top: 28px; font-size: 13px; color: #888; }
  a { color: #b8860b; }
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

  window.openRecipeModal = (id, mode = 'view') => {
    state.recipeTab = 'ingredients'
    state.recipeServings = null
    const recipe = state.recipes.find(r => r.id === id)
    if (!recipe) return
    state.editingRecipe = JSON.parse(JSON.stringify(recipe))
    document.getElementById('recipe-modal-content').innerHTML = renderRecipeModalContent(state.editingRecipe, mode)
    document.getElementById('recipe-modal').classList.add('open')
  }

  window.closeRecipeModal = () => {
    document.getElementById('recipe-modal')?.classList.remove('open')
    state.editingRecipe = null
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
    const reader = new FileReader()
    reader.onload = async (ev) => {
      const b64 = ev.target.result.split(',')[1]
      try {
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
          if (status) status.textContent = `✓ Read: ${result.name || 'Food Item'}`
          showComponentResult(state.pendingComponent)
        }
      } catch (err) {
        if (status) status.textContent = 'Could not read label — try describe instead'
      }
    }
    reader.readAsDataURL(file)
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
    if (addBtn) { addBtn.style.opacity = '1'; addBtn.style.background = 'var(--accent)'; addBtn.style.color = '#1a1500' }
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
    try {
      const code = await decodeBarcodeFromFile(file)
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
    try {
      const entry = await addMealEntry(state.user.id, {
        ...item,
        base_calories: item.calories, base_protein: item.protein,
        base_carbs: item.carbs, base_fat: item.fat,
        base_fiber: item.fiber, base_sugar: item.sugar,
        servings_consumed: 1,
        food_item_id: id  // always link back to the food item
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
      btn.style.background = selected ? 'var(--accent)' : (btn.dataset.date === localDateStr(new Date()) ? 'rgba(232,197,71,0.12)' : 'var(--bg3)')
      btn.style.color = selected ? '#1a1500' : ''
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

  window.confirmPlanRecipe = async (recipeId) => {
    if (!state.planningRecipe?.selectedDays?.length) return
    const { recipe, selectedDays } = state.planningRecipe
    const plannedServings = parseFloat(document.getElementById('plan-servings-input')?.value) || state.planningRecipe.plannedServings || recipe.servings || 4
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
        console.log(`[plan] day ${i}: dateStr=${dateStr} dayOfWeek=${dayOfWeek} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek]}) weekStart=${weekStart}`)
        const mealName = i === 0 || selectedDays.length === 1
          ? recipe.name
          : `${recipe.name} (leftovers)`
        const added = await addPlannerMeal(state.user.id, weekStart, dayOfWeek, {
          ...recipe, name: mealName, planned_servings: plannedServings
        })
        if (weekStart === state.weekStart) {
          if (!state.planner) state.planner = { meals: Array(7).fill(null).map(() => []) }
          state.planner.meals[dayOfWeek].push(added)
        }
        if (!state.weeksWithMeals.includes(weekStart)) {
          state.weeksWithMeals = [weekStart, ...state.weeksWithMeals].sort().reverse()
        }
      }
      const dayWord = selectedDays.length === 1 ? 'day' : `${selectedDays.length} days`
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
    if (todayLog.some(e => (e.name||'').toLowerCase() === mealName.toLowerCase())) {
      showToast('Already logged today', ''); return
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

  window.toggleUnlimited = async (userId, currentVal) => {
    try {
      await setUserPrivileges(userId, { unlimitedAccess: !currentVal })
      showToast(!currentVal ? 'Unlimited access granted' : 'Unlimited access removed', 'success')
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

  if (!q) { list.innerHTML = ''; return }

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

  list.innerHTML = filtered.map(item => `
    <div class="history-pick-item" onclick="quickLogMeal('${esc(item.source === 'recipe' ? 'recipe::' + item.id : item.id)}')"
      style="border-radius:var(--r)">
      <div style="display:flex;flex-direction:column;gap:1px;flex:1;min-width:0">
        <span class="hpi-name">${esc(item.name)}</span>
        <span style="font-size:10px;color:${item.source === 'recipe' ? 'var(--protein)' : 'var(--text3)'}">
          ${item.source === 'recipe' ? '⭐ Recipe' : '📋 Log history'}
        </span>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div class="hpi-cal">${Math.round(item.calories)} kcal</div>
        <div style="font-size:10px;color:var(--text3)">P${Math.round(item.protein)} C${Math.round(item.carbs)} F${Math.round(item.fat)}</div>
      </div>
    </div>`).join('')

  window.quickLogMeal = async (id) => {
    let meal
    if (id.startsWith('recipe::')) {
      meal = state.recipes.find(r => r.id === id.replace('recipe::', ''))
    } else {
      meal = state.log.find(e => String(e.id) === String(id))
    }
    if (!meal) return
    try {
      // Link recipe_id if logging from a recipe
      const isRecipe = id.startsWith('recipe::')
      const recipe_id = isRecipe ? meal.id : (meal.recipe_id ?? null)

      // Auto-save to foods if not a recipe and not already linked
      const food_item_id = isRecipe ? null
        : (meal.food_item_id ?? await autoSaveFoodItem(state.user.id, meal, state.foodItems).then(fid => {
            if (fid && !state.foodItems.find(f => f.id === fid)) {
              getFoodItems(state.user.id).then(items => { state.foodItems = items }).catch(() => {})
            }
            return fid
          }).catch(() => null))

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
    } catch (err) { showToast('Failed to log: ' + err.message, 'error') }
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
    try {
      const added = await addPlannerMeal(state.user.id, state.weekStart, dayIdx, { ...meal })
      state.planner.meals[dayIdx].push(added)
      if (addAsLeftover) {
        const nextDay = (dayIdx + 1) % 7
        const leftover = await addPlannerMeal(state.user.id, state.weekStart, nextDay, {
          ...meal, name: meal.name + ' (leftovers)'
        })
        state.planner.meals[nextDay].push(leftover)
        showToast(`Added to ${DAYS[dayIdx]} + ${DAYS[nextDay]} lunch!`, 'success')
      } else {
        showToast(`${meal.name} added to ${DAYS[dayIdx]}!`, 'success')
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
