import Foundation
import Supabase

/// Global app state — anything the dashboard reads/writes that survives
/// a navigation. Equivalent to the JS `state` object, but only the slices
/// the native screens actually touch (no need to port the entire web
/// state at once).
@Observable
@MainActor
final class AppState {
    // ─── Dashboard / Goals (pre-existing) ──────────────────────────────
    var goals: Goals = Goals()
    var todayLog: [MealLogEntry] = []
    /// Recent meal_log slice for Quick Log suggestions on the dashboard.
    /// Wider than `todayLog` (~last 300 entries, all dates) so the
    /// search-and-relog path can find meals the user logged days or
    /// weeks ago. Mirrors web's `state.log` (limit 300 in src/lib/db.js).
    var dashboardRecentLog: [MealLogEntry] = []
    var last7Days: [DaySummary] = []
    var recipes: [RecipeRow] = []
    var recentCheckins: [CheckinRow] = []
    var allCheckins: [CheckinRow] = []      // full history for the Goals page tiered view
    var bodyMetrics: BodyMetrics = BodyMetrics()
    var loading: Bool = false
    var lastError: String?

    // ─── Phase 0 / S3 — worker-owned state slices ──────────────────────
    //
    // Hands-off rule for parallel tab workers: NEVER add stored
    // properties. Use only the slices declared here. Method bodies
    // below are empty stubs — workers fill those in (and only those)
    // so we don't get merge conflicts on this file.
    //
    // Analytics tab — full history rollups for the analytics page
    // (the dashboard widget already has its own narrower 7-day slice).
    var analyticsLog: [MealLogEntry] = []
    var analyticsRangeDays: Int = 30        // default window; tab can adjust

    // Planner tab — week shown in the grid + supporting recipes lookup.
    // weekStart is "YYYY-MM-DD" (Sunday). plannerByDay[0..6] indexes
    // Sun..Sat to mirror the JS planner's day_of_week convention.
    var plannerWeekStart: String?
    var plannerByDay: [[PlannerRow]] = Array(repeating: [], count: 7)

    // Recipes tab — full library (the dashboard's `recipes` slice is
    // a thin name+macros projection; this carries the wider row).
    var recipesFull: [RecipeRow] = []

    // Providers tab — directory + the ones the user follows.
    var providers: [ProviderRow] = []
    var followedProviderIds: Set<String> = []

    // Foods tab — the user's saved food_items library.
    var foods: [FoodItemRow] = []

    // Account tab — profile + spend rollup.
    var profile: UserProfileRow?
    var monthTokenUsage: [TokenUsageRow] = []

    /// Loads everything the dashboard needs in parallel. Idempotent —
    /// safe to call on every appear or pull-to-refresh.
    func loadDashboard() async {
        loading = true
        defer { loading = false }
        do {
            async let g = fetchGoals()
            async let weekLog = fetchLastNDaysLog(7)
            async let recentLog = fetchRecentLog(limit: 300)
            async let r = fetchRecipes()
            async let c = fetchRecentCheckins()

            let weekEntries = try await weekLog
            self.goals = (try? await g) ?? Goals()
            self.todayLog = filterToToday(weekEntries).sorted { ($0.logged_at ?? "") > ($1.logged_at ?? "") }
            self.last7Days = DaySummary.build(from: weekEntries, days: 7)
            self.dashboardRecentLog = (try? await recentLog) ?? []
            self.recipes = (try? await r) ?? []
            self.recentCheckins = (try? await c) ?? []
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Loads what the Goals page needs in parallel. Separate from
    /// loadDashboard so the Goals tab can refresh without re-pulling
    /// the dashboard's wide inputs.
    func loadGoals() async {
        do {
            async let bm = fetchBodyMetrics()
            async let g = fetchGoals()
            async let cs = fetchAllCheckins()
            self.bodyMetrics = (try? await bm) ?? BodyMetrics()
            self.goals = (try? await g) ?? self.goals
            self.allCheckins = (try? await cs) ?? []
        }
    }

    // ─── Phase 0 / S3 — worker-owned load entry points ─────────────────
    //
    // Each tab worker fills in its own method body. Keep the shape
    // consistent with loadDashboard()/loadGoals(): kick off independent
    // fetches with `async let`, await the results, mutate state slices
    // last so the UI sees one coherent update. Errors flow into
    // `lastError`; transient empty results should NOT clear existing
    // state on failure (mirrors the dashboard's `(try? await …) ?? …`
    // pattern).

    /// Analytics tab. Pulls a wider window of meal_log (default 30 days,
    /// honoring `analyticsRangeDays`) plus supporting goals/checkins so
    /// the page can render adherence + trend charts. Body lives on the
    /// extension in Analytics/AnalyticsLoad.swift to keep parallel
    /// workers from clashing on this file.
    func loadAnalytics() async {
        await analyticsLoadImpl()
    }

    /// Planner tab. `weekStart` is YYYY-MM-DD (Sunday) — the worker is
    /// responsible for snapping arbitrary input to a Sunday. Stores
    /// results in `plannerWeekStart` + `plannerByDay`.
    func loadPlanner(weekStart: String) async {
        await plannerLoadImpl(weekStart: weekStart)
    }

    /// Recipes tab. Full library load — populates `recipesFull` and
    /// the narrower dashboard `recipes` slice (so dashboard refreshes
    /// stay cheap after this fans out). Forwards to the Planner
    /// worker's recipe-library helper since both tabs need the same
    /// projection (dashboard `recipes`, planner `recipesFull`).
    func loadRecipesFull() async {
        await plannerLoadRecipesFullImpl()
    }

    /// Providers tab. Pulls the directory + the user's follow set so
    /// the worker can render the "Following" badge inline without a
    /// per-row roundtrip.
    func loadProviders() async {
        await providersLoadImpl()
    }

    /// Foods tab. Loads the user's saved food_items library into
    /// `foods`, ordered by recency.
    func loadFoods() async {
        do {
            let userId = try await currentUserID()
            let rows: [FoodItemRow] = try await SupabaseService.client
                .from("food_items")
                .select()
                .eq("user_id", value: userId)
                .order("updated_at", ascending: false)
                .limit(500)
                .execute()
                .value
            self.foods = rows
        } catch {
            // Mirror the dashboard pattern: don't blank existing data on
            // a transient failure; surface the error so the UI can show it.
            lastError = error.localizedDescription
        }
    }

    /// Account tab. Pulls the profile row + this month's token_usage
    /// rows; the worker derives spend totals + role-based UI from the
    /// loaded data rather than from a precomputed summary.
    func loadAccount() async {
        await accountLoadImpl()
    }

    /// Insert a weight check-in. Used by the native log-weight sheet.
    /// Inputs are in metric (kg) — UI does the lbs→kg conversion before
    /// calling. Updates allCheckins locally so the chart + history
    /// refresh without a round trip.
    @discardableResult
    func saveCheckin(_ row: CheckinInsert) async throws -> CheckinRow {
        let userId = try await currentUserID()
        // Wide payload — basic fields are always sent; scan-extract fields
        // only fill in when row.scan is set. JSONEncoder writes nil as
        // JSON null, which Postgres reads as "leave the column NULL", so
        // a basic weigh-in still produces a clean row with the extended
        // columns null.
        struct Payload: Encodable {
            let user_id: String
            let weight_kg: Double?
            let body_fat_pct: Double?
            let muscle_mass_kg: Double?
            let notes: String?
            let scan_date: String?
            let checked_in_at: String
            // Scan provenance — set when a file was uploaded
            let scan_type: String?
            let scan_file_path: String?
            // Body composition (InBody-style)
            let lean_body_mass_kg: Double?
            let body_fat_mass_kg: Double?
            let bone_mass_kg: Double?
            let total_body_water_kg: Double?
            let intracellular_water_kg: Double?
            let extracellular_water_kg: Double?
            let ecw_tbw_ratio: Double?
            let protein_kg: Double?
            let minerals_kg: Double?
            let bmr: Int?
            let bmi: Double?
            let inbody_score: Int?
            let visceral_fat_level: Double?
            let body_cell_mass_kg: Double?
            let smi: Double?
            // Segmental
            let seg_lean_left_arm_kg: Double?
            let seg_lean_right_arm_kg: Double?
            let seg_lean_trunk_kg: Double?
            let seg_lean_left_leg_kg: Double?
            let seg_lean_right_leg_kg: Double?
            let seg_lean_left_arm_pct: Double?
            let seg_lean_right_arm_pct: Double?
            let seg_lean_trunk_pct: Double?
            let seg_lean_left_leg_pct: Double?
            let seg_lean_right_leg_pct: Double?
            // DEXA
            let bone_mineral_density: Double?
            let t_score: Double?
            let z_score: Double?
            let android_fat_pct: Double?
            let gynoid_fat_pct: Double?
            let android_gynoid_ratio: Double?
            let vat_area_cm2: Double?
        }
        let e = row.scan?.extract
        let payload = Payload(
            user_id: userId,
            weight_kg: row.weightKg,
            body_fat_pct: row.bodyFatPct,
            muscle_mass_kg: row.muscleMassKg,
            notes: row.notes,
            scan_date: row.scanDate,
            checked_in_at: row.checkedInAt,
            scan_type: e?.scan_type,
            scan_file_path: row.scan?.filePath,
            lean_body_mass_kg: e?.lean_body_mass_kg,
            body_fat_mass_kg: e?.body_fat_mass_kg,
            bone_mass_kg: e?.bone_mass_kg,
            total_body_water_kg: e?.total_body_water_kg,
            intracellular_water_kg: e?.intracellular_water_kg,
            extracellular_water_kg: e?.extracellular_water_kg,
            ecw_tbw_ratio: e?.ecw_tbw_ratio,
            protein_kg: e?.protein_kg,
            minerals_kg: e?.minerals_kg,
            bmr: e?.bmr,
            bmi: e?.bmi,
            inbody_score: e?.inbody_score,
            visceral_fat_level: e?.visceral_fat_level,
            body_cell_mass_kg: e?.body_cell_mass_kg,
            smi: e?.smi,
            seg_lean_left_arm_kg: e?.seg_lean_left_arm_kg,
            seg_lean_right_arm_kg: e?.seg_lean_right_arm_kg,
            seg_lean_trunk_kg: e?.seg_lean_trunk_kg,
            seg_lean_left_leg_kg: e?.seg_lean_left_leg_kg,
            seg_lean_right_leg_kg: e?.seg_lean_right_leg_kg,
            seg_lean_left_arm_pct: e?.seg_lean_left_arm_pct,
            seg_lean_right_arm_pct: e?.seg_lean_right_arm_pct,
            seg_lean_trunk_pct: e?.seg_lean_trunk_pct,
            seg_lean_left_leg_pct: e?.seg_lean_left_leg_pct,
            seg_lean_right_leg_pct: e?.seg_lean_right_leg_pct,
            bone_mineral_density: e?.bone_mineral_density,
            t_score: e?.t_score,
            z_score: e?.z_score,
            android_fat_pct: e?.android_fat_pct,
            gynoid_fat_pct: e?.gynoid_fat_pct,
            android_gynoid_ratio: e?.android_gynoid_ratio,
            vat_area_cm2: e?.vat_area_cm2
        )
        let inserted: [CheckinRow] = try await SupabaseService.client
            .from("checkins")
            .insert(payload)
            .select()
            .execute()
            .value
        guard let saved = inserted.first else {
            throw NSError(domain: "AppState", code: 0,
                          userInfo: [NSLocalizedDescriptionKey: "Check-in insert returned no rows"])
        }
        // Insert sorted by date (ascending) so the chart stays correct.
        allCheckins.append(saved)
        allCheckins.sort { ($0.scan_date ?? $0.checked_in_at ?? "") < ($1.scan_date ?? $1.checked_in_at ?? "") }
        // Body metrics auto-update with the latest weight, mirroring web.
        if let w = row.weightKg { bodyMetrics.weight_kg = w }
        if let bf = row.bodyFatPct { bodyMetrics.body_fat_pct = bf }
        if let mm = row.muscleMassKg { bodyMetrics.muscle_mass_kg = mm }
        return saved
    }

    /// Update a check-in's basic fields. Mirrors updateCheckin in db.js.
    func updateCheckin(id: String, _ patch: CheckinInsert) async throws {
        struct Patch: Encodable {
            let weight_kg: Double?
            let body_fat_pct: Double?
            let muscle_mass_kg: Double?
            let notes: String?
            let scan_date: String?
            let checked_in_at: String
        }
        let userId = try await currentUserID()
        let body = Patch(
            weight_kg: patch.weightKg,
            body_fat_pct: patch.bodyFatPct,
            muscle_mass_kg: patch.muscleMassKg,
            notes: patch.notes,
            scan_date: patch.scanDate,
            checked_in_at: patch.checkedInAt
        )
        let updated: [CheckinRow] = try await SupabaseService.client
            .from("checkins")
            .update(body)
            .eq("id", value: id)
            .eq("user_id", value: userId)
            .select()
            .execute()
            .value
        if let row = updated.first, let idx = allCheckins.firstIndex(where: { $0.id == id }) {
            allCheckins[idx] = row
        }
    }

    func deleteCheckin(id: String) async throws {
        let userId = try await currentUserID()
        try await SupabaseService.client
            .from("checkins")
            .delete()
            .eq("id", value: id)
            .eq("user_id", value: userId)
            .execute()
        allCheckins.removeAll { $0.id == id }
    }

    /// Upsert daily macro targets. Mirrors upsertGoals in db.js — one
    /// row per user, onConflict: user_id.
    func saveGoals(_ next: Goals) async throws {
        struct Payload: Encodable {
            let user_id: String
            let calories: Int?
            let protein: Int?
            let carbs: Int?
            let fat: Int?
            let fiber: Int?
        }
        let userId = try await currentUserID()
        let payload = Payload(
            user_id: userId,
            calories: next.calories,
            protein: next.protein,
            carbs: next.carbs,
            fat: next.fat,
            fiber: next.fiber
        )
        try await SupabaseService.client
            .from("goals")
            .upsert(payload, onConflict: "user_id")
            .execute()
        self.goals = next
    }

    /// Upsert body_metrics. Mirrors saveBodyMetrics in db.js — one row
    /// per user, onConflict: user_id. The Goals editor only touches a
    /// subset of these fields; the rest stay whatever the user has set
    /// previously (the upsert sends the WHOLE current row to avoid
    /// blanking columns we didn't intend to change).
    func saveBodyMetrics(_ next: BodyMetrics) async throws {
        struct Payload: Encodable {
            let user_id: String
            let sex: String?
            let age: Int?
            let height_cm: Double?
            let weight_kg: Double?
            let body_fat_pct: Double?
            let muscle_mass_kg: Double?
            let activity_level: String?
            let weight_goal: String?
            let pace: String?
            let goal_weight_kg: Double?
            let goal_body_fat_pct: Double?
        }
        let userId = try await currentUserID()
        let payload = Payload(
            user_id: userId,
            sex: next.sex,
            age: next.age,
            height_cm: next.height_cm,
            weight_kg: next.weight_kg,
            body_fat_pct: next.body_fat_pct,
            muscle_mass_kg: next.muscle_mass_kg,
            activity_level: next.activity_level,
            weight_goal: next.weight_goal,
            pace: next.pace,
            goal_weight_kg: next.goal_weight_kg,
            goal_body_fat_pct: next.goal_body_fat_pct
        )
        try await SupabaseService.client
            .from("body_metrics")
            .upsert(payload, onConflict: "user_id")
            .execute()
        self.bodyMetrics = next
    }

    /// Apply an in-memory patch to a meal_log entry across both
    /// dashboard slices (`todayLog` + `dashboardRecentLog`). Used after
    /// a successful DBService.updateMealEntry round-trip so the macro
    /// tiles + Today's meals + Quick log suggestions all refresh
    /// without a re-fetch.
    func updateMealLogEntry(id: String, _ patch: MealEntryPatch) async throws {
        try await DBService.updateMealEntry(id: id, patch)
        let apply: (inout MealLogEntry) -> Void = { entry in
            if let v = patch.name { entry.name = v }
            if let v = patch.mealType { entry.meal_type = v }
            if let v = patch.calories { entry.calories = v }
            if let v = patch.protein { entry.protein = v }
            if let v = patch.carbs { entry.carbs = v }
            if let v = patch.fat { entry.fat = v }
            if let v = patch.fiber { entry.fiber = v }
            if let v = patch.servingsConsumed { entry.servings_consumed = v }
        }
        if let i = todayLog.firstIndex(where: { $0.id == id }) { apply(&todayLog[i]) }
        if let i = dashboardRecentLog.firstIndex(where: { $0.id == id }) { apply(&dashboardRecentLog[i]) }
    }

    /// Delete a meal_log entry and prune both dashboard slices locally.
    func deleteMealLogEntry(id: String) async throws {
        try await DBService.deleteMealEntry(id: id)
        todayLog.removeAll { $0.id == id }
        dashboardRecentLog.removeAll { $0.id == id }
    }

    /// Insert a new meal_log row. Used by Quick log + Analyze food's
    /// "Log this meal" button. Today's log is updated locally so the
    /// macro tiles refresh immediately without a round trip.
    func logMeal(name: String,
                 mealType: String? = nil,
                 calories: Double = 0,
                 protein: Double = 0,
                 carbs: Double = 0,
                 fat: Double = 0,
                 fiber: Double = 0,
                 recipeId: String? = nil) async throws {
        struct Insert: Encodable {
            // public.meal_log column is `name` (not `meal_name` — that's
            // meal_planner's column). Mixed those up once already.
            let user_id: String
            let name: String
            let meal_type: String?
            let calories: Double
            let protein: Double
            let carbs: Double
            let fat: Double
            let fiber: Double
            let recipe_id: String?
            let logged_at: String
            let servings_consumed: Double
        }
        let userId = try await currentUserID()
        let payload = Insert(
            user_id: userId,
            name: name,
            meal_type: mealType,
            calories: calories,
            protein: protein,
            carbs: carbs,
            fat: fat,
            fiber: fiber,
            recipe_id: recipeId,
            logged_at: ISO8601DateFormatter().string(from: Date()),
            servings_consumed: 1.0
        )
        let inserted: [MealLogEntry] = try await SupabaseService.client
            .from("meal_log")
            .insert(payload)
            .select()
            .execute()
            .value
        if let entry = inserted.first {
            todayLog.insert(entry, at: 0)
            dashboardRecentLog.insert(entry, at: 0)
            // Apple Health push: write 4 dietary samples (kcal, protein,
            // carbs, fat) per meal_log row, gated by the per-user toggle.
            // No DB writeback needed — calories are push-only (we don't
            // re-pull diet data from HK).
            if HealthKitService.isToggleOn(.pushMacros, userId: userId) {
                try? await HealthKitService.shared.pushMealMacros(
                    mealLogId: entry.id,
                    kcal: calories,
                    protein: protein,
                    carbs: carbs,
                    fat: fat,
                    at: Date()
                )
            }
        }
    }

    /// Insert a recipe row from an Analyze-recipe result. Used by the
    /// "Save to library" button on the recipe-mode result card.
    /// `ingredients` is stored as jsonb on the recipes table.
    @discardableResult
    func saveRecipe(_ result: AnalysisResult) async throws -> RecipeRow {
        struct Insert: Encodable {
            let user_id: String
            let name: String
            let description: String?
            let servings: Double?
            let calories: Double?
            let protein: Double?
            let carbs: Double?
            let fat: Double?
            let fiber: Double?
            let sugar: Double?
            let ingredients: [Ingredient]?
        }
        let userId = try await currentUserID()
        let payload = Insert(
            user_id: userId,
            name: result.name,
            description: result.description,
            servings: result.servings,
            calories: result.calories,
            protein: result.protein,
            carbs: result.carbs,
            fat: result.fat,
            fiber: result.fiber,
            sugar: result.sugar,
            ingredients: result.ingredients
        )
        let inserted: [RecipeRow] = try await SupabaseService.client
            .from("recipes")
            .insert(payload)
            .select("id, name, calories, protein, carbs, fat, fiber, servings")
            .execute()
            .value
        guard let row = inserted.first else {
            throw NSError(domain: "AppState", code: 0, userInfo: [NSLocalizedDescriptionKey: "Recipe insert returned no rows"])
        }
        recipes.insert(row, at: 0)
        return row
    }

    private func fetchGoals() async throws -> Goals {
        let userId = try await currentUserID()
        let response: [Goals] = try await SupabaseService.client
            .from("goals")
            .select("calories, protein, carbs, fat, fiber")
            .eq("user_id", value: userId)
            .limit(1)
            .execute()
            .value
        return response.first ?? Goals()
    }

    /// Pulls the most recent N meal_log rows across all dates. Used by
    /// the dashboard's Quick Log suggestions so the search-and-relog
    /// path finds meals beyond just today. Mirrors getMealLog(limit:300)
    /// in src/lib/db.js — no date filter, capped by `limit`.
    private func fetchRecentLog(limit: Int) async throws -> [MealLogEntry] {
        let userId = try await currentUserID()
        let response: [MealLogEntry] = try await SupabaseService.client
            .from("meal_log")
            .select()
            .eq("user_id", value: userId)
            .order("logged_at", ascending: false)
            .limit(limit)
            .execute()
            .value
        return response
    }

    private func fetchLastNDaysLog(_ days: Int) async throws -> [MealLogEntry] {
        let userId = try await currentUserID()
        let cal = Calendar.current
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        let from = cal.date(byAdding: .day, value: -(days - 1), to: cal.startOfDay(for: Date()))!
        let fromStr = formatter.string(from: from)
        let response: [MealLogEntry] = try await SupabaseService.client
            .from("meal_log")
            .select()
            .eq("user_id", value: userId)
            .gte("logged_at", value: fromStr)
            .order("logged_at", ascending: false)
            .execute()
            .value
        return response
    }

    private func fetchRecentCheckins() async throws -> [CheckinRow] {
        // 60 days covers "this month" with comfortable headroom. The
        // analytics widget filters down to the current calendar month.
        let userId = try await currentUserID()
        let cal = Calendar.current
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        let from = cal.date(byAdding: .day, value: -60, to: cal.startOfDay(for: Date()))!
        let fromStr = formatter.string(from: from)
        let response: [CheckinRow] = try await SupabaseService.client
            .from("checkins")
            .select("id, weight_kg, scan_date, checked_in_at")
            .eq("user_id", value: userId)
            .gte("checked_in_at", value: fromStr)
            .order("checked_in_at", ascending: true)
            .execute()
            .value
        return response
    }

    private func filterToToday(_ entries: [MealLogEntry]) -> [MealLogEntry] {
        let today = todayDateString()
        return entries.filter { ($0.logged_at ?? "").hasPrefix(today) }
    }

    private func fetchBodyMetrics() async throws -> BodyMetrics {
        let userId = try await currentUserID()
        let response: [BodyMetrics] = try await SupabaseService.client
            .from("body_metrics")
            .select("user_id, sex, age, height_cm, weight_kg, body_fat_pct, muscle_mass_kg, activity_level, weight_goal, pace, goal_weight_kg, goal_body_fat_pct")
            .eq("user_id", value: userId)
            .limit(1)
            .execute()
            .value
        return response.first ?? BodyMetrics()
    }

    private func fetchAllCheckins() async throws -> [CheckinRow] {
        // SELECT * so the extended body-composition / segmental / DEXA
        // columns flow through. The decoder ignores any column we don't
        // declare on CheckinRow, so we don't pay for the wider read in
        // the basic-weigh-in case (still ~10 columns of scalars).
        let userId = try await currentUserID()
        let response: [CheckinRow] = try await SupabaseService.client
            .from("checkins")
            .select()
            .eq("user_id", value: userId)
            .order("checked_in_at", ascending: true)
            .limit(2000)
            .execute()
            .value
        return response
    }

    private func fetchRecipes() async throws -> [RecipeRow] {
        let userId = try await currentUserID()
        let response: [RecipeRow] = try await SupabaseService.client
            .from("recipes")
            .select("id, name, calories, protein, carbs, fat, fiber, servings")
            .eq("user_id", value: userId)
            .order("name", ascending: true)
            .limit(200)
            .execute()
            .value
        return response
    }

    private func currentUserID() async throws -> String {
        try await SupabaseService.client.auth.session.user.id.uuidString
    }

    private func todayDateString() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.string(from: Date())
    }

    private func tomorrowDateString() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.string(from: Calendar.current.date(byAdding: .day, value: 1, to: Date())!)
    }
}

/// Input shape for AppState.saveCheckin / updateCheckin. Plain DTO so
/// the views don't have to know about the underlying insert payload
/// shape. The optional `scan` payload is set when an InBody / DEXA
/// scan was uploaded — it carries the file's storage path plus the
/// full extracted body-comp shape so saveCheckin can persist all
/// columns in one insert.
struct CheckinInsert {
    var weightKg: Double?
    var bodyFatPct: Double?
    var muscleMassKg: Double?
    var notes: String?
    var scanDate: String?       // YYYY-MM-DD
    var checkedInAt: String     // ISO8601 timestamp
    var scan: CheckinScanPayload?
}

/// Set when a check-in row carries scan provenance + extracted metrics.
/// `filePath` is the storage path inside the body-scans bucket; `extract`
/// is the AI-parsed shape from ScanService.extractBodyScan.
struct CheckinScanPayload {
    var filePath: String?
    var extract: BodyScanExtract
}
