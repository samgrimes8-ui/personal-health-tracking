import { signOut } from '../lib/auth.js'
import {
  getGoals, saveGoals as dbSaveGoals,
  getMealLog, addMealEntry, updateMealEntry, deleteMealEntry,
  getPlannerWeek, addPlannerMeal, updatePlannerMeal, deletePlannerMeal,
  getUsageSummary, getAdminUserOverview, setUserPrivileges,
  getRecipes, upsertRecipe, deleteRecipe, getRecipeByName,
  getWeeksWithMeals
} from '../lib/db.js'
import {
  analyzePhoto, analyzeRecipe, analyzeDishBySearch, analyzePlannerDescription,
  extractIngredients, recalculateMacros
} from '../lib/ai.js'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  user: null,
  goals: { calories: 2000, protein: 150, carbs: 200, fat: 65 },
  log: [],
  recipes: [],
  planner: { meals: Array(7).fill(null).map(() => []) },
  usage: { spent: 0, limit: 10, remaining: 10, tokens: 0, requests: 0, isAdmin: false, isUnlimited: false },
  currentPage: 'log',
  currentMode: 'recipe',
  imageBase64: null,
  currentEntry: null,
  editingEntry: null,
  plannerTarget: null,
  plannerTab: 'history',
  plannerView: 'meals',
  groceryView: 'full',
  groceryItems: null,
  groceryCustomItems: [],
  mealServings: {},
  excludedIngredients: new Set(),
  aiPlannerResult: null,
  weekStart: getWeekStart(),
  weeksWithMeals: [],
  showCalendar: false,
  calendarMonth: null,
  // apiKey moved server-side — no longer needed in client
  editingRecipe: null,  // recipe being edited in modal
}

function getWeekStart() {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay())
  d.setHours(0, 0, 0, 0)
  return d.toISOString().split('T')[0]
}

// ─── Init ─────────────────────────────────────────────────────────────────────
export async function initApp(user, container) {
  state.user = user
  await loadAll()
  renderShell(container)
  renderPage()
  wireGlobals()
}

async function loadAll() {
  const [goals, log, usage, recipes, weeksWithMeals] = await Promise.all([
    getGoals(state.user.id),
    getMealLog(state.user.id, { limit: 300 }),
    getUsageSummary(state.user.id),
    getRecipes(state.user.id),
    getWeeksWithMeals(state.user.id)
  ])
  state.goals = { calories: goals.calories ?? 2000, protein: goals.protein ?? 150, carbs: goals.carbs ?? 200, fat: goals.fat ?? 65 }
  state.log = log
  state.usage = usage
  state.recipes = recipes
  state.weeksWithMeals = weeksWithMeals
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
          <div class="nav-item ${state.currentPage === 'account' ? 'active' : ''}" id="nav-account" onclick="switchPage('account')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            Account
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
    case 'account':  renderAccount(main); break
  }
  updateSidebar()
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
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
          <button class="mode-tab ${state.currentMode === 'recipe' ? 'active' : ''}" onclick="switchMode('recipe')">📝 Recipe</button>
          <button class="mode-tab ${state.currentMode === 'photo' ? 'active' : ''}" onclick="switchMode('photo')">📸 Photo</button>
          <button class="mode-tab ${state.currentMode === 'link' ? 'active' : ''}" onclick="switchMode('link')">🔍 Search</button>
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
      <div class="log-header"><span class="log-header-title">Today's log</span><button class="clear-btn" onclick="clearTodayLog()">Clear today</button></div>
      ${renderLogTable(todayLog, true)}
    </div>
  `

  updateStats()
  wireFileInput()

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

function renderLogTable(entries, isToday) {
  if (!entries.length) return `<div class="log-empty">${isToday ? 'No entries yet. Analyze a meal to get started.' : 'No history yet.'}</div>`
  return `
    <table class="log-table">
      <thead><tr><th>Meal</th><th>${isToday ? 'Time' : 'Date'}</th><th>Calories</th><th>Protein</th><th>Carbs</th><th>Fat</th><th></th></tr></thead>
      <tbody>
        ${entries.map(e => {
          const d = new Date(e.logged_at || e.timestamp)
          const timeStr = isToday
            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          return `<tr style="cursor:pointer" onclick="openEditModal('${e.id}', 'log')">
            <td class="td-name">${esc(e.name)}</td>
            <td class="td-time">${timeStr}</td>
            <td class="td-cal">${Math.round(e.calories)}</td>
            <td class="td-p">${Math.round(e.protein)}g</td>
            <td class="td-c">${Math.round(e.carbs)}g</td>
            <td class="td-f">${Math.round(e.fat)}g</td>
            <td><button class="td-act" title="Edit" onclick="openEditModal('${e.id}', 'log');event.stopPropagation()">✎</button></td>
          </tr>`
        }).join('')}
      </tbody>
    </table>
  `
}

// ─── Planner ──────────────────────────────────────────────────────────────────
async function renderPlanner(container) {
  if (typeof container === 'undefined') container = document.getElementById('main-content')
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

      <!-- Week label — click to open calendar -->
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

    ${state.plannerView === 'grocery' ? renderGroceryList(allMeals, planner) : renderMealPlanView(planner)}
  `
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
    const d = new Date(dateStr + 'T00:00:00')
    d.setDate(d.getDate() - d.getDay())
    return d.toISOString().split('T')[0]
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
              const isToday = dateStr === today.toISOString().split('T')[0]
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
                const d = new Date(wk + 'T00:00:00')
                const end = new Date(d); end.setDate(end.getDate() + 6)
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

function renderGroceryList(allMeals, planner) {
  const view = state.groceryView || 'full'
  return `
    <div class="log-card" style="margin-bottom:20px">
      <div class="log-header">
        <span class="log-header-title">🛒 Grocery list</span>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="clear-btn" onclick="addGroceryItem()" style="color:var(--accent)">+ Add item</button>
          <button class="clear-btn" onclick="resetExclusions()" style="color:var(--text3)">Reset exclusions</button>
        </div>
      </div>
      <div style="display:flex;gap:4px;padding:12px 16px;border-bottom:1px solid var(--border)">
        <button class="mode-tab ${view === 'full' ? 'active' : ''}" onclick="setGroceryView('full')" style="flex:0 0 auto;font-size:12px;padding:5px 12px">Full list</button>
        <button class="mode-tab ${view === 'bymeal' ? 'active' : ''}" onclick="setGroceryView('bymeal')" style="flex:0 0 auto;font-size:12px;padding:5px 12px">By meal</button>
      </div>
      ${view === 'full' ? renderGroceryFull(planner) : renderGroceryByMeal(planner)}
    </div>
  `
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

function collectAllIngredients(planner) {
  // Returns flat list of ingredients, skipping leftover entries (already counted on original day)
  const items = []
  if (!state.excludedIngredients) state.excludedIngredients = new Set()

  DAYS.forEach((day, di) => {
    const meals = planner.meals[di] || []
    meals.forEach(m => {
      // Skip leftover entries — ingredients already counted on the original day
      if (isLeftover(m)) return

      const mealName = m.meal_name || m.name
      const recipe = state.recipes.find(r => r.name.toLowerCase() === mealName.toLowerCase())
      const ingredients = recipe?.ingredients || []
      const baseServings = recipe?.servings || 1
      const requestedServings = state.mealServings?.[m.id] || baseServings
      const multiplier = requestedServings / baseServings

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
          day: di,
          requestedServings,
          baseServings
        })
      })

      if (!ingredients.length) {
        const excKey = `${m.id}::${mealName.toLowerCase()}`
        items.push({
          name: mealName,
          amount: null,
          unit: '',
          category: 'other',
          excluded: state.excludedIngredients.has(excKey),
          excKey,
          mealId: m.id,
          mealName,
          day: di,
          noIngredients: true
        })
      }
    })
  })
  return items
}

function renderGroceryFull(planner) {
  const allItems = collectAllIngredients(planner)
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
                <span style="font-size:11px;color:var(--text3)">${item.meals?.join(', ') || ''}</span>
              </div>`).join('')}
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

function renderGroceryByMeal(planner) {
  const hasMeals = planner.meals.some(d => d.length > 0)
  if (!hasMeals) return `<div class="log-empty">No meals planned yet.</div>`
  if (!state.mealServings) state.mealServings = {}
  if (!state.excludedIngredients) state.excludedIngredients = new Set()

  return `
    <div style="padding:12px 20px">
      ${DAYS.map((day, di) => {
        const meals = planner.meals[di] || []
        if (!meals.length) return ''
        return `
          <div style="margin-bottom:20px">
            <div style="font-size:12px;font-weight:500;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">${day}</div>
            ${meals.map(m => {
              const mealName = m.meal_name || m.name
              const recipe = state.recipes.find(r => r.name.toLowerCase() === mealName.toLowerCase())
              const ingredients = recipe?.ingredients || []
              const baseServings = recipe?.servings || 1
              const requestedServings = state.mealServings[m.id] || baseServings
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
  const d = new Date(weekStart + 'T00:00:00')
  const end = new Date(d); end.setDate(end.getDate() + 6)
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
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

  return `
    <div style="padding:28px;position:relative">
      <button class="modal-close" onclick="closeRecipeModal()" style="top:14px;right:14px">×</button>

      <!-- Name -->
      <div style="margin-bottom:20px;margin-right:32px">
        ${mode === 'edit' || isNew ? `
          <input type="text" id="recipe-name" value="${esc(recipe.name || '')}"
            placeholder="Recipe name..."
            style="width:100%;background:none;border:none;border-bottom:1px solid var(--border2);outline:none;font-family:'DM Serif Display',serif;font-size:24px;color:var(--text);padding-bottom:6px" />
        ` : `
          <div style="font-family:'DM Serif Display',serif;font-size:24px;color:var(--text)">${esc(recipe.name)}</div>
        `}
      </div>

      <!-- Description -->
      ${mode === 'edit' || isNew ? `
        <div class="modal-field">
          <label>Description (optional)</label>
          <input type="text" id="recipe-desc" value="${esc(recipe.description || '')}" placeholder="Brief description..." />
        </div>
      ` : recipe.description ? `<div style="font-size:13px;color:var(--text2);margin-bottom:16px">${esc(recipe.description)}</div>` : ''}

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
        <span style="font-size:11px;color:var(--text3);margin-left:auto">Macros shown per 1 serving</span>
      </div>

      <!-- Macros -->
      <div style="margin-bottom:20px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px">Macros per serving</div>
        ${mode === 'edit' || isNew ? `
          <div class="modal-grid">
            <div class="modal-field"><label>Calories</label><input type="number" id="r-cal" value="${Math.round(recipe.calories || 0)}" /></div>
            <div class="modal-field"><label>Protein (g)</label><input type="number" id="r-protein" value="${Math.round(recipe.protein || 0)}" /></div>
            <div class="modal-field"><label>Carbs (g)</label><input type="number" id="r-carbs" value="${Math.round(recipe.carbs || 0)}" /></div>
            <div class="modal-field"><label>Fat (g)</label><input type="number" id="r-fat" value="${Math.round(recipe.fat || 0)}" /></div>
            <div class="modal-field"><label>Fiber (g)</label><input type="number" id="r-fiber" value="${Math.round(recipe.fiber || 0)}" /></div>
            <div class="modal-field"><label>Sugar (g)</label><input type="number" id="r-sugar" value="${Math.round(recipe.sugar || 0)}" /></div>
          </div>
        ` : `
          <div class="macro-pills">
            <span class="macro-pill pill-cal">${Math.round(recipe.calories)} kcal</span>
            <span class="macro-pill pill-p">${Math.round(recipe.protein)}g protein</span>
            <span class="macro-pill pill-c">${Math.round(recipe.carbs)}g carbs</span>
            <span class="macro-pill pill-f">${Math.round(recipe.fat)}g fat</span>
            ${recipe.fiber ? `<span class="macro-pill pill-fiber">${Math.round(recipe.fiber)}g fiber</span>` : ''}
          </div>
        `}
      </div>

      <!-- Ingredients -->
      <div style="margin-bottom:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3)">
            Ingredients ${ingredients.length ? `(${ingredients.length})` : ''}
          </div>
          <div style="display:flex;gap:8px">
            ${mode === 'edit' || isNew ? `<button class="clear-btn" style="color:var(--accent)" onclick="addIngredientRow()">+ Add</button>` : ''}
            ${!isNew ? `<button class="clear-btn" style="color:var(--carbs)" onclick="fetchIngredients('${recipe.id}')">✨ AI extract</button>` : ''}
          </div>
        </div>
        <div id="ingredient-list" style="border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          ${!ingredients.length ? `
            <div style="padding:20px;text-align:center;font-size:13px;color:var(--text3)">
              No ingredients yet.
              ${mode === 'edit' || isNew ? 'Add manually or click <b style="color:var(--carbs)">AI extract</b> to auto-fill.' : ''}
            </div>
          ` : ingredients.map((ing, i) => renderIngredientRow(ing, i, mode === 'edit' || isNew)).join('')}
        </div>
      </div>

      <!-- Recalculate button (edit mode only, when ingredients exist) -->
      ${(mode === 'edit' || isNew) && ingredients.length ? `
        <div style="margin-bottom:20px">
          <button class="pm-analyze-btn" id="recalc-btn" onclick="recalculateMacrosHandler()">
            ✨ Recalculate macros from ingredients
          </button>
        </div>
      ` : ''}

      <!-- Actions -->
      <div class="modal-actions">
        ${!isNew && mode === 'view' ? `
          <button class="btn-delete" onclick="deleteRecipeHandler('${recipe.id}')">Delete</button>
          <button class="btn-cancel" onclick="closeRecipeModal()">Close</button>
          <button class="btn-save" onclick="openRecipeModal('${recipe.id}', 'edit')">Edit recipe</button>
        ` : `
          ${!isNew ? `<button class="btn-delete" onclick="deleteRecipeHandler('${recipe.id}')">Delete</button>` : ''}
          <button class="btn-cancel" onclick="${isNew ? 'closeRecipeModal()' : `openRecipeModal('${recipe.id}', 'view')`}">Cancel</button>
          <button class="btn-save" id="recipe-save-btn" onclick="saveRecipeHandler()">Save recipe</button>
        `}
      </div>
    </div>
  `
}

function renderIngredientRow(ing, idx, editable) {
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
  return `
    <div style="display:flex;gap:10px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--border)">
      <span style="font-size:13px;color:var(--accent);min-width:80px">${esc(ing.amount || '')} ${esc(ing.unit || '')}</span>
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
  try {
    const users = await getAdminUserOverview()
    const el = document.getElementById('admin-panel-content')
    if (!el) return
    if (!users.length) { el.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:20px 0">No users yet.</div>'; return }
    el.innerHTML = `
      <div style="overflow-x:auto">
        <table class="log-table" style="min-width:700px">
          <thead>
            <tr>
              <th>Email</th><th>Plan</th><th>This month</th><th>Total spent</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${users.map(u => `
              <tr>
                <td class="td-name" style="font-size:12px">
                  ${esc(u.email)}
                  ${u.is_admin ? '<span style="font-size:10px;background:rgba(232,197,71,0.15);color:var(--accent);border-radius:4px;padding:1px 6px;margin-left:6px">admin</span>' : ''}
                  ${u.unlimited_access ? '<span style="font-size:10px;background:rgba(126,200,160,0.15);color:var(--protein);border-radius:4px;padding:1px 6px;margin-left:4px">unlimited</span>' : ''}
                </td>
                <td style="font-size:12px;color:var(--text2)">${u.plan ?? 'free'}</td>
                <td style="font-size:12px">
                  <span style="color:var(--cal)">$${Number(u.spent_this_month_usd ?? 0).toFixed(4)}</span>
                  <span style="color:var(--text3)"> / $${Number(u.spending_limit_usd ?? 10).toFixed(2)}</span>
                  <br><span style="color:var(--text3);font-size:10px">${u.requests_this_month ?? 0} requests · ${Math.round((u.tokens_this_month ?? 0)/1000)}k tokens</span>
                </td>
                <td style="font-size:12px;color:var(--text2)">$${Number(u.total_spent_usd ?? 0).toFixed(4)}</td>
                <td>
                  <span style="font-size:11px;padding:2px 8px;border-radius:999px;${u.account_status === 'active' ? 'background:rgba(90,173,122,0.15);color:var(--green)' : 'background:rgba(217,96,96,0.15);color:var(--red)'}">
                    ${u.account_status ?? 'active'}
                  </span>
                </td>
                <td style="white-space:nowrap">
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
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `
  } catch (err) {
    const el = document.getElementById('admin-panel-content')
    if (el) el.innerHTML = `<div style="color:var(--red);font-size:13px">Error loading users: ${err.message}</div>`
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
  }
  return null
}

// ─── Sidebar Stats ────────────────────────────────────────────────────────────
function updateSidebar() {
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
    <span style="color:var(--text3)">Sugar: </span><span>${Math.round(r.sugar || 0)}g</span>
    &nbsp;&nbsp;<span style="color:var(--text3)">Confidence: </span><span>${r.confidence}</span>
    ${r.notes ? `<br><span style="color:var(--text3)">Note: </span><span>${r.notes}</span>` : ''}
    ${ingredientHTML}
  `
  const btn = document.getElementById('log-entry-btn')
  if (btn) { btn.textContent = '+ Log this meal'; btn.className = 'log-btn'; btn.style.display = 'block' }
  // Add "Save as recipe" button if not already there
  if (!document.getElementById('save-recipe-btn')) {
    const recipeBtn = document.createElement('button')
    recipeBtn.id = 'save-recipe-btn'
    recipeBtn.className = 'log-btn'
    recipeBtn.textContent = '⭐ Save as recipe'
    recipeBtn.onclick = () => window.saveAsRecipeHandler?.()
    btn?.parentNode?.appendChild(recipeBtn)
  } else {
    const rb = document.getElementById('save-recipe-btn')
    rb.textContent = '⭐ Save as recipe'; rb.disabled = false; rb.style.color = ''
  }
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
    renderPage()
  }

  window.toggleSidebar = () => {
    document.getElementById('sidebar')?.classList.toggle('open')
    document.getElementById('sidebar-overlay')?.classList.toggle('visible')
  }
  window.closeSidebar = () => {
    document.getElementById('sidebar')?.classList.remove('open')
    document.getElementById('sidebar-overlay')?.classList.remove('visible')
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
      const entry = await addMealEntry(state.user.id, state.currentEntry)
      state.log.unshift(entry)

      // Auto-save recipe with ingredients if we have them (background, non-blocking)
      if (state.currentEntry.ingredients?.length) {
        const e = state.currentEntry
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

      state.currentEntry = null
      updateStats()
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
    document.getElementById('edit-name').value = entry.name || ''
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
  }

  window.saveEditEntry = async () => {
    if (!state.editingEntry) return
    const { id, source, plannerCtx } = state.editingEntry
    const vals = {
      name: document.getElementById('edit-name').value.trim(),
      calories: parseFloat(document.getElementById('edit-cal').value) || 0,
      protein: parseFloat(document.getElementById('edit-protein').value) || 0,
      carbs: parseFloat(document.getElementById('edit-carbs').value) || 0,
      fat: parseFloat(document.getElementById('edit-fat').value) || 0,
      fiber: parseFloat(document.getElementById('edit-fiber').value) || 0,
      sugar: parseFloat(document.getElementById('edit-sugar').value) || 0
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
      // Initialize calendar to current weekStart's month
      const d = new Date(state.weekStart + 'T00:00:00')
      state.calendarMonth = { year: d.getFullYear(), month: d.getMonth() }
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
    const d = new Date(state.weekStart + 'T00:00:00')
    d.setDate(d.getDate() + dir * 7)
    state.weekStart = d.toISOString().split('T')[0]
    state.showCalendar = false
    state.calendarMonth = null
    state.mealServings = {}
    state.excludedIngredients = new Set()
    renderPage()
  }

  // ── Grocery list handlers ───────────────────────────────────────
  window.setGroceryView = (view) => {
    state.groceryView = view
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

  window.openRecipeModal = (id, mode = 'view') => {
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

  window.saveRecipeHandler = async () => {
    if (!state.editingRecipe) return
    const btn = document.getElementById('recipe-save-btn')
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...' }
    const recipe = {
      ...state.editingRecipe,
      name: document.getElementById('recipe-name')?.value.trim() || state.editingRecipe.name,
      description: document.getElementById('recipe-desc')?.value.trim() || '',
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
    try {
      const existing = await getRecipeByName(state.user.id, e.name)
      if (existing) {
        // Update ingredients if we have them and existing doesn't
        if (e.ingredients?.length && !existing.ingredients?.length) {
          await upsertRecipe(state.user.id, { ...existing, ingredients: e.ingredients })
          const idx = state.recipes.findIndex(r => r.id === existing.id)
          if (idx !== -1) state.recipes[idx] = { ...existing, ingredients: e.ingredients }
        }
        showToast('Recipe already saved — find it in Recipes', '')
        return
      }
      const recipe = await upsertRecipe(state.user.id, {
        name: e.name,
        description: e.description || '',
        servings: e.servings || 1,
        calories: e.calories, protein: e.protein, carbs: e.carbs,
        fat: e.fat, fiber: e.fiber || 0, sugar: e.sugar || 0,
        ingredients: e.ingredients || [],
        source: 'ai_photo', confidence: e.confidence, ai_notes: e.notes || ''
      })
      state.recipes.unshift(recipe)
      showToast(`"${e.name}" saved to Recipes with ${e.ingredients?.length || 0} ingredients!`, 'success')
      const btn = document.getElementById('save-recipe-btn')
      if (btn) { btn.textContent = '✓ Saved to Recipes'; btn.style.color = 'var(--green)'; btn.disabled = true }
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.refreshAdminPanel = () => loadAdminPanel()

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
      const entry = await addMealEntry(state.user.id, meal)
      state.log.unshift(entry)
      // Clear the search
      const input = document.getElementById('quick-log-search')
      if (input) input.value = ''
      document.getElementById('quick-log-list').innerHTML = ''
      updateStats()
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

  // 1. Saved recipes (always available, most useful)
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
        ${item.source === 'recipe' ? `<span style="font-size:10px;color:var(--protein)">⭐ Recipe${item.servings ? ' · ' + item.servings + ' servings' : ''}</span>` : `<span style="font-size:10px;color:var(--text3)">📋 From log</span>`}
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
