import { signOut } from '../lib/auth.js'
import {
  getGoals, saveGoals as dbSaveGoals,
  getMealLog, addMealEntry, updateMealEntry, deleteMealEntry,
  getPlannerWeek, addPlannerMeal, updatePlannerMeal, deletePlannerMeal,
  getTokenUsageThisMonth
} from '../lib/db.js'
import {
  analyzePhoto, analyzeRecipe, analyzeDishBySearch, analyzePlannerDescription
} from '../lib/ai.js'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  user: null,
  goals: { calories: 2000, protein: 150, carbs: 200, fat: 65 },
  log: [],
  planner: { meals: Array(7).fill(null).map(() => []) },
  currentPage: 'log',
  currentMode: 'photo',
  imageBase64: null,
  currentEntry: null,
  editingEntry: null,     // { id, source: 'log' | 'planner', plannerCtx? }
  plannerTarget: null,    // { dayIdx }
  plannerTab: 'history',
  aiPlannerResult: null,
  weekStart: getWeekStart(),
  apiKey: localStorage.getItem('macrolens_apikey') ?? '',
  tokenUsage: 0,
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
  const [goals, log, tokenUsage] = await Promise.all([
    getGoals(state.user.id),
    getMealLog(state.user.id, { limit: 300 }),
    getTokenUsageThisMonth(state.user.id)
  ])
  state.goals = { calories: goals.calories ?? 2000, protein: goals.protein ?? 150, carbs: goals.carbs ?? 200, fat: goals.fat ?? 65 }
  state.log = log
  state.tokenUsage = tokenUsage
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
          <div class="nav-item active" id="nav-log" onclick="switchPage('log')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            Dashboard
          </div>
          <div class="nav-item" id="nav-planner" onclick="switchPage('planner')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            Meal Planner
          </div>
          <div class="nav-item" id="nav-history" onclick="switchPage('history')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            History
          </div>
          <div class="nav-item" id="nav-goals" onclick="switchPage('goals')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Goals
          </div>
          <div class="nav-item" id="nav-account" onclick="switchPage('account')">
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
          <button class="pm-tab active" id="pm-tab-history" onclick="switchPlannerTab('history')">📋 From history</button>
          <button class="pm-tab" id="pm-tab-ai" onclick="switchPlannerTab('ai')">✨ Describe meal</button>
        </div>
        <div class="pm-panel active" id="pm-panel-history">
          <input class="planner-search" id="planner-search" placeholder="Search meals from history..." oninput="filterPlannerList()" />
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
        <label class="leftover-toggle">
          <input type="checkbox" id="leftover-check" />
          Mark as leftovers from previous day
        </label>
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

    <div class="two-col">
      <div class="upload-card">
        <div class="section-title">Analyze food</div>
        <div class="mode-tabs">
          <button class="mode-tab ${state.currentMode === 'photo' ? 'active' : ''}" onclick="switchMode('photo')">📸 Photo</button>
          <button class="mode-tab ${state.currentMode === 'recipe' ? 'active' : ''}" onclick="switchMode('recipe')">📝 Recipe</button>
          <button class="mode-tab ${state.currentMode === 'link' ? 'active' : ''}" onclick="switchMode('link')">🔍 Search</button>
        </div>
        <div class="mode-panel ${state.currentMode === 'photo' ? 'active' : ''}" id="mode-photo">
          <div class="upload-area" id="upload-area" onclick="document.getElementById('file-input').click()">
            <div id="upload-inner"><div class="upload-icon">📸</div><div class="upload-text">Drop a photo of your food</div><div class="upload-hint">supports jpg, png, webp</div></div>
          </div>
          <input type="file" id="file-input" accept="image/*" style="display:none" />
        </div>
        <div class="mode-panel ${state.currentMode === 'recipe' ? 'active' : ''}" id="mode-recipe">
          <textarea class="recipe-textarea" id="recipe-input" placeholder="Describe your recipe or paste ingredients...&#10;&#10;e.g. Grilled chicken breast 200g, brown rice 1 cup, olive oil 1 tbsp"></textarea>
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

      <div class="result-card" id="result-card">
        <div class="result-empty" id="result-empty"><div style="font-size:28px">🥗</div><div>Upload a photo, describe a recipe, or search a dish</div></div>
        <div id="result-content" style="display:none;flex-direction:column;gap:14px">
          <div class="result-name" id="res-name">—</div>
          <div class="result-desc" id="res-desc">—</div>
          <div class="macro-pills" id="res-pills"></div>
          <div class="nutrition-detail" id="res-detail"></div>
          <button class="log-btn" id="log-entry-btn" onclick="logCurrentEntryHandler()">+ Log this meal</button>
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

  container.innerHTML = `
    <div class="greeting">Meal Planner</div>
    <div class="greeting-sub">Week of ${formatWeekLabel(state.weekStart)}</div>
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
            <div class="planner-meal-name">${esc(m.meal_name || m.name)}${m.is_leftover || m.leftover ? '<span class="leftovers-badge">↩</span>' : ''}</div>
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

function formatWeekLabel(weekStart) {
  const d = new Date(weekStart + 'T00:00:00')
  const end = new Date(d); end.setDate(end.getDate() + 6)
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
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
  const monthTokens = state.tokenUsage
  const monthLimit = 100000
  const pct = Math.min(100, Math.round((monthTokens / monthLimit) * 100))
  const hasSupabase = !!localStorage.getItem('macrolens_apikey') === false

  container.innerHTML = `
    <div class="greeting">Account</div>
    <div class="greeting-sub">${state.user.email}</div>

    <div class="upload-card" style="max-width:480px;margin-bottom:20px">
      <div class="section-title">Token usage this month</div>
      <div style="margin-bottom:8px">
        <div class="bar-row-label" style="margin-bottom:6px">
          <span class="bar-label">Used</span>
          <span class="bar-val">${monthTokens.toLocaleString()} / ${monthLimit.toLocaleString()}</span>
        </div>
        <div class="bar-bg"><div class="bar-fill" style="background:var(--accent);width:${pct}%"></div></div>
      </div>
      <div style="font-size:12px;color:var(--text3);margin-top:8px">Resets on the 1st of each month. Free plan: 100k tokens/month.</div>
    </div>

    <div class="upload-card" style="max-width:480px;margin-bottom:20px">
      <div class="section-title">API key</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;line-height:1.6">Your Anthropic API key is used to power food analysis. In a future update, this will be managed server-side and you won't need to enter it.</p>
      <input class="api-input" type="password" id="account-api-key" placeholder="sk-ant-..." value="${state.apiKey}" style="margin-bottom:10px" />
      <button class="analyze-btn" onclick="saveApiKeyHandler()">Save API key</button>
    </div>

    <div class="upload-card" style="max-width:480px">
      <div class="section-title">Session</div>
      <button class="btn-delete" style="width:100%;padding:12px;font-size:14px" onclick="handleSignOut()">Sign out</button>
    </div>
  `
}

// ─── Analyze Food ─────────────────────────────────────────────────────────────
async function doAnalyze() {
  const apiKey = state.apiKey
  if (!apiKey) { showToast('Please add your API key in Account settings', 'error'); switchPage('account'); return null }
  const mealHint = document.getElementById('meal-name-input')?.value.trim() ?? ''

  if (state.currentMode === 'photo') {
    if (!state.imageBase64) { showToast('Please upload a food image first', 'error'); return null }
    return await analyzePhoto(apiKey, state.imageBase64, mealHint, state.user.id)
  } else if (state.currentMode === 'recipe') {
    const recipe = document.getElementById('recipe-input')?.value.trim()
    if (!recipe) { showToast('Please describe your recipe first', 'error'); return null }
    return await analyzeRecipe(apiKey, recipe, mealHint, state.user.id)
  } else if (state.currentMode === 'link') {
    const dishName = document.getElementById('dish-name-input')?.value.trim()
    const link = document.getElementById('link-input')?.value.trim()
    if (!dishName) { showToast('Please enter the dish name', 'error'); return null }
    return await analyzeDishBySearch(apiKey, dishName, link, state.user.id)
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
  const empty = document.getElementById('result-empty')
  const content = document.getElementById('result-content')
  if (!empty || !content) return
  empty.style.display = 'none'
  content.style.display = 'flex'
  document.getElementById('res-name').textContent = r.name
  document.getElementById('res-desc').textContent = r.description ?? ''
  document.getElementById('res-pills').innerHTML = `
    <span class="macro-pill pill-cal">${Math.round(r.calories)} kcal</span>
    <span class="macro-pill pill-p">${Math.round(r.protein)}g protein</span>
    <span class="macro-pill pill-c">${Math.round(r.carbs)}g carbs</span>
    <span class="macro-pill pill-f">${Math.round(r.fat)}g fat</span>
    ${r.fiber ? `<span class="macro-pill pill-fiber">${Math.round(r.fiber)}g fiber</span>` : ''}
  `
  document.getElementById('res-detail').innerHTML = `
    <span style="color:var(--text3)">Sugar: </span><span>${Math.round(r.sugar || 0)}g</span>
    &nbsp;&nbsp;<span style="color:var(--text3)">Confidence: </span><span>${r.confidence}</span>
    ${r.notes ? `<br><span style="color:var(--text3)">Note: </span><span>${r.notes}</span>` : ''}
  `
  const btn = document.getElementById('log-entry-btn')
  if (btn) { btn.textContent = '+ Log this meal'; btn.className = 'log-btn' }
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

  window.saveApiKeyHandler = () => {
    const key = document.getElementById('account-api-key')?.value.trim()
    if (!key) return
    state.apiKey = key
    localStorage.setItem('macrolens_apikey', key)
    showToast('API key saved!', 'success')
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

  // ── Planner modal ───────────────────────────────────────────────
  window.openPlannerModal = (dayIdx) => {
    state.plannerTarget = { dayIdx }
    state.aiPlannerResult = null
    document.getElementById('planner-modal-title').textContent = `Add meal — ${DAYS[dayIdx]}`
    document.getElementById('planner-search').value = ''
    document.getElementById('leftover-check').checked = false
    document.getElementById('pm-ai-input').value = ''
    document.getElementById('pm-result').style.display = 'none'
    document.getElementById('pm-analyze-btn').disabled = false
    document.getElementById('pm-analyze-btn').textContent = 'Analyze with AI'
    window.switchPlannerTab('history')
    filterPlannerList()
    document.getElementById('planner-modal').classList.add('open')
  }

  window.closePlannerModal = () => {
    document.getElementById('planner-modal').classList.remove('open')
    state.plannerTarget = null
  }

  window.switchPlannerTab = (tab) => {
    state.plannerTab = tab
    document.getElementById('pm-tab-history').classList.toggle('active', tab === 'history')
    document.getElementById('pm-tab-ai').classList.toggle('active', tab === 'ai')
    document.getElementById('pm-panel-history').classList.toggle('active', tab === 'history')
    document.getElementById('pm-panel-ai').classList.toggle('active', tab === 'ai')
  }

  window.filterPlannerList = filterPlannerList

  window.analyzePlannerMealHandler = async () => {
    const input = document.getElementById('pm-ai-input')?.value.trim()
    if (!input) { showToast('Please describe the meal first', 'error'); return }
    const apiKey = state.apiKey
    if (!apiKey) { showToast('Please add your API key in Account settings', 'error'); return }
    const btn = document.getElementById('pm-analyze-btn')
    btn.disabled = true
    btn.innerHTML = '<span class="analyzing-spinner"></span> Analyzing...'
    document.getElementById('pm-result').style.display = 'none'
    try {
      const r = await analyzePlannerDescription(apiKey, input, state.user.id)
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
    const isLeftover = document.getElementById('leftover-check').checked
    try {
      const meal = await addPlannerMeal(state.user.id, state.weekStart, state.plannerTarget.dayIdx, { ...r, leftover: isLeftover })
      state.planner.meals[state.plannerTarget.dayIdx].push(meal)
      closePlannerModal()
      renderPage()
      showToast(`${r.name} added to ${DAYS[state.plannerTarget.dayIdx]}!`, 'success')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  window.deletePlannerMealHandler = async (id, d, m) => {
    try {
      await deletePlannerMeal(state.user.id, id)
      state.planner.meals[d].splice(m, 1)
      renderPage()
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }

  // Close modals on backdrop click
  document.getElementById('edit-modal')?.addEventListener('click', e => { if (e.target.id === 'edit-modal') closeEditModal() })
  document.getElementById('planner-modal')?.addEventListener('click', e => { if (e.target.id === 'planner-modal') closePlannerModal() })
}

function filterPlannerList() {
  const q = document.getElementById('planner-search')?.value.toLowerCase() ?? ''
  const seen = new Set()
  const unique = state.log.filter(e => { if (seen.has(e.name)) return false; seen.add(e.name); return true })
  const filtered = q ? unique.filter(e => e.name.toLowerCase().includes(q)) : unique
  const list = document.getElementById('history-pick-list')
  if (!list) return
  if (!filtered.length) {
    list.innerHTML = `<div style="padding:20px;text-align:center;font-size:13px;color:var(--text3)">No meals found. Log some meals first.</div>`
    return
  }
  list.innerHTML = filtered.slice(0, 30).map(e => `
    <div class="history-pick-item" onclick="addHistoryMealToPlanner('${e.id}')">
      <span class="hpi-name">${esc(e.name)}</span>
      <span class="hpi-cal">${Math.round(e.calories)} kcal</span>
    </div>`).join('')

  window.addHistoryMealToPlanner = async (id) => {
    if (!state.plannerTarget) return
    const meal = state.log.find(e => String(e.id) === String(id))
    if (!meal) return
    const isLeftover = document.getElementById('leftover-check').checked
    try {
      const added = await addPlannerMeal(state.user.id, state.weekStart, state.plannerTarget.dayIdx, { ...meal, leftover: isLeftover })
      state.planner.meals[state.plannerTarget.dayIdx].push(added)
      closePlannerModal()
      renderPage()
      showToast(`${meal.name} added to ${DAYS[state.plannerTarget.dayIdx]}!`, 'success')
    } catch (err) { showToast('Error: ' + err.message, 'error') }
  }
}

function switchPage(name) { window.switchPage(name) }
function closePlannerModal() { window.closePlannerModal?.() }
function closeEditModal() { window.closeEditModal?.() }
