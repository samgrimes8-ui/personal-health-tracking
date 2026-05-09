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
    /// Currently-active tab. Owned here (rather than in SignedInShell's
    /// local @State) so any view can navigate cross-tab — e.g. a "View
    /// all →" link on the Dashboard's analytics widget can flip this to
    /// `.analytics` to jump to the full Analytics tab without dragging
    /// the whole bottom-bar binding through the view hierarchy.
    var selectedTab: AppTab = .dashboard
    /// Calendar day the dashboard is currently showing. Defaults to today;
    /// chevron-nav on the Today's Meals header walks it backward (and
    /// optionally forward, capped at today). Drives `todayLog` — when
    /// this changes, the visible day's meals + macro tile totals follow.
    /// Field name stayed as `todayLog` rather than renaming for diff
    /// minimality; conceptually it's "the visible day's log."
    var selectedDate: Date = Calendar.current.startOfDay(for: Date())
    var todayLog: [MealLogEntry] = []
    /// Recent meal_log slice for Quick Log suggestions on the dashboard.
    /// Capped at 4 (top of list) so we can show the 2 most-recent meals
    /// plus a fallback when the user has fewer than 2 saved foods —
    /// the spec is "2 meals + 2 food_items" with cross-fill if either
    /// well runs dry, so 4 of each is enough headroom.
    var dashboardRecentMeals: [MealLogEntry] = []
    /// Recent food_items slice for Quick Log. Same cap rationale as
    /// dashboardRecentMeals — 4 leaves headroom for the fill-gap rule
    /// (e.g. 0 saved meals → show 4 foods).
    var dashboardRecentFoods: [FoodItemRow] = []
    /// Planned-but-not-yet-consumed-via-name-match meal_planner rows for
    /// the visible day. Mirrors the web's getTodayPlannedMeals(): pulls
    /// `actual_date == selectedDate` rows that aren't leftovers, and the
    /// dashboard cross-references each row's `meal_name` against today's
    /// meal_log to render a strikethrough/checkmark when consumed (the
    /// web has no consumed_at column either — the source of truth is
    /// the meal_log row inserted on tap).
    var todayPlanned: [PlannerRow] = []
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
            async let recentMeals = fetchRecentMeals(limit: 4)
            async let recentFoods = fetchRecentFoods(limit: 4)
            async let r = fetchRecipes()
            async let c = fetchRecentCheckins()
            async let planned = fetchPlannedForDate(Self.localDateKey(for: selectedDate))

            let weekEntries = try await weekLog
            self.goals = (try? await g) ?? Goals()
            self.todayLog = filterToVisibleDay(weekEntries).sorted { ($0.logged_at ?? "") > ($1.logged_at ?? "") }
            self.last7Days = DaySummary.build(from: weekEntries, days: 7)
            self.dashboardRecentMeals = (try? await recentMeals) ?? []
            self.dashboardRecentFoods = (try? await recentFoods) ?? []
            self.recipes = (try? await r) ?? []
            self.recentCheckins = (try? await c) ?? []
            self.todayPlanned = (try? await planned) ?? []
        } catch {
            lastError = error.localizedDescription
        }
        // If the user is viewing a day older than the 7-day weekLog window,
        // the prefix-filter above produced an empty set — fall back to a
        // day-specific fetch so the meals card still populates. Safe to
        // skip for today (already covered by the weekLog filter).
        if !Calendar.current.isDateInToday(selectedDate) {
            let key = Self.localDateKey(for: selectedDate)
            let cal = Calendar.current
            let weekStart = cal.date(byAdding: .day, value: -6, to: cal.startOfDay(for: Date()))
                ?? cal.startOfDay(for: Date())
            if selectedDate < weekStart {
                await loadDayLog(dateKey: key)
            }
        }
        // Apple Health: piggyback the macro migration + foreground
        // catch-up on dashboard load. loadDashboard() is the most
        // reliable signal that the user is actively in the app, and
        // both calls are no-ops if the pushMacros toggle is off.
        // - Migration runs at most once per user per device (UserDefaults gate)
        // - Catch-up re-pushes today's totals so any HK-side desync
        //   (offline window, auth re-grant) resolves without a meal mutation
        await runHealthKitMacroDailyTotalMigrationIfNeeded()
        await syncDayMacrosToHealthKit(dateKey: Self.localDateKey(for: Date()))
    }

    /// Switch the dashboard's visible day. Snaps to start-of-day, then
    /// fetches that day's meal_log slice and writes it into `todayLog`
    /// (which the dashboard treats as "the visible day's log"). No-op
    /// if the date is already selected.
    func setSelectedDate(_ date: Date) async {
        let snapped = Calendar.current.startOfDay(for: date)
        if Calendar.current.isDate(snapped, inSameDayAs: selectedDate) { return }
        selectedDate = snapped
        let key = Self.localDateKey(for: snapped)
        await loadDayLog(dateKey: key)
        // Refresh the planned-meal placeholders for the new day so the
        // check-off rows track the date-nav. Errors are swallowed —
        // the day's meal_log still loads even if the planner fetch
        // hiccups, mirroring the rest of loadDashboard's tolerance.
        self.todayPlanned = (try? await fetchPlannedForDate(key)) ?? []
    }

    /// Fetch one local-day's meal_log into `todayLog`. Pulls a slightly
    /// wider window (prev-day → next-day) and prefix-filters in Swift,
    /// matching the day-boundary contract used in HealthMacroSync.
    func loadDayLog(dateKey: String) async {
        do {
            let userId = try await currentUserID()
            let cal = Calendar.current
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.timeZone = .current
            guard let day = f.date(from: dateKey) else { return }
            let prevKey = f.string(from: cal.date(byAdding: .day, value: -1, to: day) ?? day)
            let nextKey = f.string(from: cal.date(byAdding: .day, value: 2, to: day) ?? day)
            let entries: [MealLogEntry] = try await SupabaseService.client
                .from("meal_log")
                .select()
                .eq("user_id", value: userId)
                .gte("logged_at", value: prevKey)
                .lt("logged_at", value: nextKey)
                .order("logged_at", ascending: false)
                .execute()
                .value
            let local = DateFormatter()
            local.dateFormat = "yyyy-MM-dd"
            local.timeZone = .current
            self.todayLog = entries.filter { entry in
                guard let raw = entry.logged_at else { return false }
                if let d = Self.parseISOTimestamp(raw) {
                    return local.string(from: d) == dateKey
                }
                return String(raw.prefix(10)) == dateKey
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Resolve a Date to use for `logged_at` when the user is logging
    /// against a past day via the dashboard date-nav. Returns nil when
    /// `selectedDate` is today (callers should pass nil so logMeal uses
    /// `Date()` and the entry lands at the actual current time). When
    /// past-dated, anchors to a sensible time-of-day for the picked
    /// meal_type using the same windows the web uses
    /// (`getMealTypeFromTime` / `inferMealType`):
    ///   breakfast → 08:00, lunch → 12:00, snack → 15:00, dinner → 18:00.
    func loggedAtForSelectedDate(mealType: String? = nil) -> Date? {
        if Calendar.current.isDateInToday(selectedDate) { return nil }
        let resolvedType = (mealType ?? Self.inferMealType(at: Date())).lowercased()
        let hour: Int
        switch resolvedType {
        case "breakfast": hour = 8
        case "lunch":     hour = 12
        case "snack":     hour = 15
        case "dinner":    hour = 18
        default:          hour = 12
        }
        var comps = Calendar.current.dateComponents([.year, .month, .day], from: selectedDate)
        comps.hour = hour; comps.minute = 0; comps.second = 0
        return Calendar.current.date(from: comps)
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
    /// row per user, onConflict: user_id. Field set is exactly the
    /// public.goals schema (calories / protein / carbs / fat). The
    /// table has no `fiber` column; including it 400s the upsert.
    func saveGoals(_ next: Goals) async throws {
        struct Payload: Encodable {
            let user_id: String
            let calories: Int?
            let protein: Int?
            let carbs: Int?
            let fat: Int?
            let sodium_mg_max: Double?
            let fiber_g_min: Double?
            let saturated_fat_g_max: Double?
            let sugar_added_g_max: Double?
        }
        let userId = try await currentUserID()
        let payload = Payload(
            user_id: userId,
            calories: next.calories,
            protein: next.protein,
            carbs: next.carbs,
            fat: next.fat,
            sodium_mg_max: next.sodium_mg_max,
            fiber_g_min: next.fiber_g_min,
            saturated_fat_g_max: next.saturated_fat_g_max,
            sugar_added_g_max: next.sugar_added_g_max
        )
        try await SupabaseService.client
            .from("goals")
            .upsert(payload, onConflict: "user_id")
            .execute()
        self.goals = next
    }

    /// Upsert just the full-nutrition-label opt-in onto user_profiles.
    /// Targeted update — must NOT overwrite display_name, role, or any
    /// other column on the row. Returns nothing because the caller
    /// updates state.profile + AppStorage cache directly.
    func saveTrackFullNutrition(_ on: Bool) async throws {
        struct Payload: Encodable { let track_full_nutrition: Bool }
        let userId = try await currentUserID()
        try await SupabaseService.client
            .from("user_profiles")
            .update(Payload(track_full_nutrition: on))
            .eq("user_id", value: userId)
            .execute()
        var nextProfile = self.profile ?? UserProfileRow(user_id: userId)
        nextProfile.track_full_nutrition = on
        self.profile = nextProfile
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
    /// dashboard slices (`todayLog` + `dashboardRecentMeals`). Used after
    /// a successful DBService.updateMealEntry round-trip so the macro
    /// tiles + Today's meals + Quick log suggestions all refresh
    /// without a re-fetch.
    ///
    /// If `patch.loggedAt` shifts the entry to a different local day,
    /// the entry is removed from `todayLog` when its new day no longer
    /// matches `selectedDate` (and added when it does), and HK is
    /// re-pushed for BOTH the old and new day so neither stays stale.
    func updateMealLogEntry(id: String, _ patch: MealEntryPatch) async throws {
        // Capture the affected day BEFORE the DB round-trip — a delete
        // would lose the row from local slices, and a logged_at shift
        // would replace it. Both cases need the original day key for
        // HK recompute.
        let oldDateKey = dateKeyForMeal(id: id)
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
            if let v = patch.loggedAt { entry.logged_at = v }
        }
        if let i = todayLog.firstIndex(where: { $0.id == id }) { apply(&todayLog[i]) }
        if let i = dashboardRecentMeals.firstIndex(where: { $0.id == id }) { apply(&dashboardRecentMeals[i]) }

        // Resolve the new day for HK recompute + visible-day membership.
        let newDateKey: String
        if let raw = patch.loggedAt, let d = Self.parseISOTimestamp(raw) {
            newDateKey = Self.localDateKey(for: d)
        } else {
            newDateKey = oldDateKey
        }
        if newDateKey != oldDateKey {
            // Day shifted. Drop from todayLog if it no longer matches the
            // visible day; re-fetch the entry into todayLog if it now
            // does (covers the rarer case of editing an off-day entry
            // FROM a different visible day).
            let visibleKey = Self.localDateKey(for: selectedDate)
            if newDateKey != visibleKey {
                todayLog.removeAll { $0.id == id }
            } else if !todayLog.contains(where: { $0.id == id }),
                      let row = dashboardRecentMeals.first(where: { $0.id == id }) {
                todayLog.insert(row, at: 0)
            }
            await syncDayMacrosToHealthKit(dateKey: oldDateKey)
        }
        await syncDayMacrosToHealthKit(dateKey: newDateKey)
    }

    /// Delete a meal_log entry and prune both dashboard slices locally.
    func deleteMealLogEntry(id: String) async throws {
        // Resolve the day BEFORE deleting locally — the entry needs to
        // still be in todayLog/dashboardRecentMeals for the lookup.
        let dateKey = dateKeyForMeal(id: id)
        try await DBService.deleteMealEntry(id: id)
        todayLog.removeAll { $0.id == id }
        dashboardRecentMeals.removeAll { $0.id == id }
        await syncDayMacrosToHealthKit(dateKey: dateKey)
    }

    /// Bundle of full-nutrition-label values for a single logged meal.
    /// Every field is optional — model returns nil when it can't read
    /// or confidently infer the value. We never coerce to 0 because
    /// "not tracked" and "0g" mean different things on a goals view.
    struct FullLabelPayload: Equatable {
        var saturatedFatG: Double?
        var transFatG: Double?
        var cholesterolMg: Double?
        var sodiumMg: Double?
        var fiberG: Double?
        var sugarTotalG: Double?
        var sugarAddedG: Double?
        var vitaminAMcg: Double?
        var vitaminCMg: Double?
        var vitaminDMcg: Double?
        var calciumMg: Double?
        var ironMg: Double?
        var potassiumMg: Double?

        /// Pull full-label fields out of an AnalysisResult, scaled by
        /// servings_consumed so the persisted value matches the
        /// already-scaled macros on the same meal_log row.
        static func from(_ r: AnalysisResult, scaledBy servings: Double = 1.0) -> FullLabelPayload {
            func scale(_ v: Double?) -> Double? { v.map { $0 * servings } }
            return FullLabelPayload(
                saturatedFatG: scale(r.saturated_fat_g),
                transFatG:     scale(r.trans_fat_g),
                cholesterolMg: scale(r.cholesterol_mg),
                sodiumMg:      scale(r.sodium_mg),
                fiberG:        scale(r.fiber_g),
                sugarTotalG:   scale(r.sugar_total_g),
                sugarAddedG:   scale(r.sugar_added_g),
                vitaminAMcg:   scale(r.vitamin_a_mcg),
                vitaminCMg:    scale(r.vitamin_c_mg),
                vitaminDMcg:   scale(r.vitamin_d_mcg),
                calciumMg:     scale(r.calcium_mg),
                ironMg:        scale(r.iron_mg),
                potassiumMg:   scale(r.potassium_mg)
            )
        }
    }

    /// Insert a new meal_log row. Used by Quick log + Analyze food's
    /// "Log this meal" button. Today's log is updated locally so the
    /// macro tiles refresh immediately without a round trip.
    ///
    /// When the entry isn't already linked to a recipe or food_item, an
    /// auto-save pass upserts it into food_items so the user's library
    /// grows organically — mirrors autoSaveFoodItem in src/lib/db.js.
    func logMeal(name: String,
                 mealType: String? = nil,
                 calories: Double = 0,
                 protein: Double = 0,
                 carbs: Double = 0,
                 fat: Double = 0,
                 fiber: Double = 0,
                 recipeId: String? = nil,
                 foodItemId: String? = nil,
                 servingsConsumed: Double = 1.0,
                 loggedAt: Date? = nil,
                 servingDescription: String? = nil,
                 servingGrams: Double? = nil,
                 servingOz: Double? = nil,
                 fullLabel: FullLabelPayload? = nil) async throws {
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
            let food_item_id: String?
            let logged_at: String
            let servings_consumed: Double
            let serving_description: String?
            let serving_grams: Double?
            let serving_oz: Double?
            // Full nutrition label (opt-in). Always written to the row
            // when the AI returned values, regardless of whether the
            // user has the toggle on — flipping the toggle later then
            // shows historical data without a backfill.
            let saturated_fat_g: Double?
            let trans_fat_g: Double?
            let cholesterol_mg: Double?
            let sodium_mg: Double?
            let fiber_g: Double?
            let sugar_total_g: Double?
            let sugar_added_g: Double?
            let vitamin_a_mcg: Double?
            let vitamin_c_mg: Double?
            let vitamin_d_mcg: Double?
            let calcium_mg: Double?
            let iron_mg: Double?
            let potassium_mg: Double?
        }
        let userId = try await currentUserID()
        // Defensive default for the meal_log_serving_present /
        // food_items_serving_present CHECK constraints. If the upstream
        // path didn't populate either serving field (e.g. AI photo
        // response returned without serving_description; older clients;
        // the prompt was rolled back), fall back to a literal "1 serving"
        // so the INSERT is never rejected. Mirrors the same default in
        // src/lib/db.js. Real serving info from later edits replaces it
        // — this is bedrock insurance, not the primary code path.
        let safeServingDescription: String? = {
            if let s = servingDescription?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
                return s
            }
            if (servingGrams ?? 0) > 0 { return nil }  // grams alone satisfies the constraint
            return "1 serving"
        }()
        // Auto-save to food_items if not already linked. Mirrors the web's
        // autoSaveFoodItem (src/lib/db.js): skip when recipe-linked or
        // food-linked, dedup by case-insensitive name, otherwise insert.
        // Wrapped in try? — a failure here must not block the meal_log
        // write (matches the web's catch-and-warn).
        let resolvedFoodItemId: String?
        if foodItemId != nil || recipeId != nil {
            resolvedFoodItemId = foodItemId
        } else {
            resolvedFoodItemId = try? await autoSaveFoodItem(
                userId: userId,
                name: name,
                calories: calories,
                protein: protein,
                carbs: carbs,
                fat: fat,
                fiber: fiber,
                servingDescription: safeServingDescription,
                servingGrams: servingGrams,
                servingOz: servingOz,
                fullLabel: fullLabel
            )
        }
        // Auto-assign meal_type from the local clock when the caller
        // didn't pick one — same buckets the web uses
        // (getMealTypeFromTime in src/pages/app.js): 5–10am breakfast,
        // 10–2 lunch, 2–5 snack, 5–10 dinner, else snack. Without this,
        // every log entry lands with meal_type = nil and the dashboard
        // can't group it under the right section.
        //
        // For past-day logs (loggedAt != nil), bucket using the *target*
        // timestamp — a "lunch" log shifted to yesterday should still be
        // tagged lunch, not whatever the current clock says.
        let when = loggedAt ?? Date()
        let resolvedMealType = mealType ?? Self.inferMealType(at: when)
        let payload = Insert(
            user_id: userId,
            name: name,
            meal_type: resolvedMealType,
            calories: calories,
            protein: protein,
            carbs: carbs,
            fat: fat,
            fiber: fiber,
            recipe_id: recipeId,
            food_item_id: resolvedFoodItemId,
            logged_at: ISO8601DateFormatter().string(from: when),
            servings_consumed: servingsConsumed,
            serving_description: safeServingDescription,
            serving_grams: servingGrams,
            serving_oz: servingOz,
            saturated_fat_g: fullLabel?.saturatedFatG,
            trans_fat_g:     fullLabel?.transFatG,
            cholesterol_mg:  fullLabel?.cholesterolMg,
            sodium_mg:       fullLabel?.sodiumMg,
            // fiber_g defaults to the existing `fiber` value when the AI
            // didn't return a separate full-label value — keeps the new
            // column aligned with the legacy fiber field on day one.
            fiber_g:         fullLabel?.fiberG ?? (fiber > 0 ? fiber : nil),
            sugar_total_g:   fullLabel?.sugarTotalG,
            sugar_added_g:   fullLabel?.sugarAddedG,
            vitamin_a_mcg:   fullLabel?.vitaminAMcg,
            vitamin_c_mg:    fullLabel?.vitaminCMg,
            vitamin_d_mcg:   fullLabel?.vitaminDMcg,
            calcium_mg:      fullLabel?.calciumMg,
            iron_mg:         fullLabel?.ironMg,
            potassium_mg:    fullLabel?.potassiumMg
        )
        let inserted: [MealLogEntry] = try await SupabaseService.client
            .from("meal_log")
            .insert(payload)
            .select()
            .execute()
            .value
        if let entry = inserted.first {
            // Only splice into todayLog if the entry's local day matches
            // the dashboard's visible day. Past-day logs from the date-
            // nav header land on a different day's view; we still update
            // the recents slice (date-agnostic) but skip the visible-day
            // tile counters until the user navigates to that day.
            let entryKey = Self.localDateKey(for: when)
            let visibleKey = Self.localDateKey(for: selectedDate)
            if entryKey == visibleKey {
                todayLog.insert(entry, at: 0)
            }
            dashboardRecentMeals.insert(entry, at: 0)
            // Cap the slice so a long session doesn't grow it unbounded —
            // matches the loadDashboard fetch limit (4 rows).
            if dashboardRecentMeals.count > 4 {
                dashboardRecentMeals = Array(dashboardRecentMeals.prefix(4))
            }
            // Apple Health: recompute the affected day's totals from
            // meal_log and push as the daily-total quartet
            // (kcal/protein/carbs/fat). No-op if the pushMacros toggle
            // is off. Past-day logs target the past day, not today.
            await syncDayMacrosToHealthKit(dateKey: entryKey)
        }
    }

    /// Mirrors autoSaveFoodItem() in src/lib/db.js. Used by logMeal to
    /// promote a freshly-logged meal into the user's Foods library so
    /// it shows up next time they search Quick Log. Dedup is by
    /// case-insensitive name match against state.foods + a DB lookup
    /// fallback (state.foods isn't populated until the Foods tab is
    /// first opened, so the cache check alone misses dashboard logs).
    private func autoSaveFoodItem(userId: String,
                                  name: String,
                                  calories: Double,
                                  protein: Double,
                                  carbs: Double,
                                  fat: Double,
                                  fiber: Double,
                                  servingDescription: String? = nil,
                                  servingGrams: Double? = nil,
                                  servingOz: Double? = nil,
                                  fullLabel: FullLabelPayload? = nil) async throws -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // 1. Cache check (fast path).
        let lower = trimmed.lowercased()
        if let hit = foods.first(where: { $0.name.lowercased() == lower }) {
            return hit.id
        }

        // 2. DB check by name — covers the dashboard-analyze case where
        // the Foods tab hasn't loaded yet and the cache is empty.
        let existing: [FoodItemRow] = (try? await SupabaseService.client
            .from("food_items")
            .select()
            .eq("user_id", value: userId)
            .ilike("name", pattern: trimmed)
            .limit(1)
            .execute()
            .value) ?? []
        if let row = existing.first {
            // Splice into cache so subsequent logs in this session hit
            // the fast path.
            if !foods.contains(where: { $0.id == row.id }) {
                foods.insert(row, at: 0)
            }
            return row.id
        }

        // 3. Insert. source = "log" matches the web (autoSaveFoodItem
        // tags rows so the Foods page can show where they came from).
        let saved = try await DBService.saveFoodItem(FoodItemUpsert(
            id: nil,
            name: trimmed,
            brand: nil,
            servingSize: servingDescription ?? "1 serving",
            calories: calories,
            protein: protein,
            carbs: carbs,
            fat: fat,
            fiber: fiber,
            sugar: 0,
            sodium: 0,
            components: [],
            notes: nil,
            source: "log",
            servingDescription: servingDescription,
            servingGrams: servingGrams,
            servingOz: servingOz,
            saturatedFatG: fullLabel?.saturatedFatG,
            transFatG:     fullLabel?.transFatG,
            cholesterolMg: fullLabel?.cholesterolMg,
            sodiumMg:      fullLabel?.sodiumMg,
            fiberG:        fullLabel?.fiberG,
            sugarTotalG:   fullLabel?.sugarTotalG,
            sugarAddedG:   fullLabel?.sugarAddedG,
            vitaminAMcg:   fullLabel?.vitaminAMcg,
            vitaminCMg:    fullLabel?.vitaminCMg,
            vitaminDMcg:   fullLabel?.vitaminDMcg,
            calciumMg:     fullLabel?.calciumMg,
            ironMg:        fullLabel?.ironMg,
            potassiumMg:   fullLabel?.potassiumMg
        ))
        foods.insert(saved, at: 0)
        return saved.id
    }

    /// Explicit "save this food to my library" action — used by the
    /// meal-log preview sheet's "Save to my foods" button. Same dedup
    /// rules as autoSaveFoodItem (cache → DB by name → insert) but
    /// surfaces whether the row was newly created so the caller can
    /// show "Saved" vs "Already in your foods" without a second
    /// roundtrip. Source defaults to "manual" since this is a user
    /// gesture, not a side-effect of a meal_log write.
    func saveFoodToLibrary(name: String,
                           calories: Double,
                           protein: Double,
                           carbs: Double,
                           fat: Double,
                           fiber: Double,
                           servingDescription: String? = nil,
                           servingGrams: Double? = nil,
                           servingOz: Double? = nil,
                           fullLabel: FullLabelPayload? = nil) async throws -> SaveFoodResult {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw NSError(domain: "AppState.saveFoodToLibrary", code: 0,
                          userInfo: [NSLocalizedDescriptionKey: "Name is required."])
        }
        let userId = try await currentUserID()

        // Cache check.
        let lower = trimmed.lowercased()
        if let hit = foods.first(where: { $0.name.lowercased() == lower }) {
            return SaveFoodResult(id: hit.id, row: hit, wasNew: false)
        }

        // DB check by name — covers the dashboard-preview case where
        // the Foods tab hasn't loaded yet and the cache is empty.
        let existing: [FoodItemRow] = (try? await SupabaseService.client
            .from("food_items")
            .select()
            .eq("user_id", value: userId)
            .ilike("name", pattern: trimmed)
            .limit(1)
            .execute()
            .value) ?? []
        if let row = existing.first {
            if !foods.contains(where: { $0.id == row.id }) {
                foods.insert(row, at: 0)
            }
            return SaveFoodResult(id: row.id, row: row, wasNew: false)
        }

        let saved = try await DBService.saveFoodItem(FoodItemUpsert(
            id: nil,
            name: trimmed,
            brand: nil,
            servingSize: servingDescription ?? "1 serving",
            calories: calories,
            protein: protein,
            carbs: carbs,
            fat: fat,
            fiber: fiber,
            sugar: 0,
            sodium: 0,
            components: [],
            notes: nil,
            source: "manual",
            servingDescription: servingDescription,
            servingGrams: servingGrams,
            servingOz: servingOz,
            saturatedFatG: fullLabel?.saturatedFatG,
            transFatG:     fullLabel?.transFatG,
            cholesterolMg: fullLabel?.cholesterolMg,
            sodiumMg:      fullLabel?.sodiumMg,
            fiberG:        fullLabel?.fiberG,
            sugarTotalG:   fullLabel?.sugarTotalG,
            sugarAddedG:   fullLabel?.sugarAddedG,
            vitaminAMcg:   fullLabel?.vitaminAMcg,
            vitaminCMg:    fullLabel?.vitaminCMg,
            vitaminDMcg:   fullLabel?.vitaminDMcg,
            calciumMg:     fullLabel?.calciumMg,
            ironMg:        fullLabel?.ironMg,
            potassiumMg:   fullLabel?.potassiumMg
        ))
        foods.insert(saved, at: 0)
        return SaveFoodResult(id: saved.id, row: saved, wasNew: true)
    }

    /// Toggle a planned meal_planner row's "consumed" state by inserting
    /// or deleting the matching meal_log row. Mirrors web's
    /// logPlannedMeal (src/pages/app.js):
    ///
    ///   • If today's log already has an entry whose name matches the
    ///     planner row's meal_name (case-insensitive), delete that entry
    ///     — the user is unlogging a previously-checked-off meal.
    ///   • Otherwise, insert a meal_log row with the planner row's
    ///     macros, recipe_id (resolved by name from state.recipes),
    ///     meal_type, and servings_consumed: 1. The planner row stays
    ///     untouched — meal_log is the source of truth for consumed
    ///     state, same as web. There is no consumed_at column.
    ///
    /// macros come from the planner row directly because addPlannerMeal
    /// (db.js:184) stores them as totals already (planned_servings ×
    /// per-serving), so we don't need to recompute on consume.
    func togglePlannedMeal(_ row: PlannerRow) async throws {
        let name = (row.meal_name ?? "").trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        let lower = name.lowercased()
        // Existing match by name (web's loggedNames set) — first hit wins.
        if let existing = todayLog.first(where: { ($0.name ?? "").lowercased() == lower }) {
            try await deleteMealLogEntry(id: existing.id)
            return
        }
        // No match → log it. Resolve recipe_id by name so the meal_log
        // row threads back to the recipe (web's logPlannedMeal does
        // the same lookup on state.recipes). meal_type defaults to the
        // planner row's slot; falls back to time-of-day inference if
        // somehow missing.
        let recipeId = recipes.first { $0.name.lowercased() == lower }?.id
        let mealType = row.meal_type?.lowercased() ?? Self.inferMealType(at: Date())
        try await logMeal(
            name: name,
            mealType: mealType,
            calories: row.calories ?? 0,
            protein: row.protein ?? 0,
            carbs: row.carbs ?? 0,
            fat: row.fat ?? 0,
            fiber: row.fiber ?? 0,
            recipeId: recipeId,
            servingsConsumed: 1,
            loggedAt: loggedAtForSelectedDate(mealType: mealType)
        )
    }

    /// Log a saved food as a single meal_log row, threading the
    /// food_item_id link through so future Quick Log searches and the
    /// Foods list both see it as a re-log of the same library item.
    /// Shared between the Foods tab and the dashboard's Quick Log so
    /// future fixes apply to both surfaces. Mirrors the web's "log as
    /// one food" branch in app.js's quickLogMeal.
    ///
    /// `at` honors the dashboard's date nav — pass
    /// loggedAtForSelectedDate() when the caller cares about
    /// retroactive entry; nil falls back to now.
    func logFoodAsOne(_ item: FoodItemRow, at loggedAt: Date? = nil) async throws {
        try await logMeal(
            name: item.name,
            calories: item.calories ?? 0,
            protein: item.protein ?? 0,
            carbs: item.carbs ?? 0,
            fat: item.fat ?? 0,
            fiber: item.fiber ?? 0,
            foodItemId: item.id,
            loggedAt: loggedAt,
            servingDescription: item.serving_description ?? item.serving_size,
            servingGrams: item.serving_grams,
            servingOz: item.serving_oz
        )
    }

    /// Log each component of a combo food as its own meal_log row.
    /// Per-component macros are already scaled to the component's
    /// `qty` (see FoodComponent doc in Models.swift), so we pass them
    /// through unmodified and record `qty` as servings_consumed —
    /// matches src/pages/app.js:12732. Returns the count of rows
    /// successfully inserted; partial failures are swallowed so a
    /// transient blip on one component doesn't abort the rest, same
    /// behavior the web uses. Shared between Foods and Quick Log.
    @discardableResult
    func logFoodComponents(_ item: FoodItemRow, at loggedAt: Date? = nil) async -> Int {
        let comps = item.components ?? []
        var logged = 0
        for c in comps {
            do {
                try await logMeal(
                    name: c.name ?? item.name,
                    calories: c.calories ?? 0,
                    protein: c.protein ?? 0,
                    carbs: c.carbs ?? 0,
                    fat: c.fat ?? 0,
                    fiber: c.fiber ?? 0,
                    foodItemId: item.id,
                    servingsConsumed: c.qty ?? 1,
                    loggedAt: loggedAt
                )
                logged += 1
            } catch {
                continue
            }
        }
        return logged
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
            .select("calories, protein, carbs, fat, sodium_mg_max, fiber_g_min, saturated_fat_g_max, sugar_added_g_max")
            .eq("user_id", value: userId)
            .limit(1)
            .execute()
            .value
        return response.first ?? Goals()
    }

    /// Top-N most-recent meal_log rows across all dates. Drives the
    /// dashboard Quick Log preload (default `limit = 4` so the 2-meals-
    /// plus-2-foods card has fallback rows when the food well is dry).
    private func fetchRecentMeals(limit: Int) async throws -> [MealLogEntry] {
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

    /// Pull meal_planner rows for one local-day, drop leftovers, and
    /// hand back the rest as planned placeholders. Mirrors the web's
    /// getTodayPlannedMeals() (src/pages/app.js): excludes is_leftover
    /// rows AND any row whose name contains "(leftover" — leftovers
    /// shouldn't appear as a check-off row because the source meal
    /// already accounts for them.
    private func fetchPlannedForDate(_ dateKey: String) async throws -> [PlannerRow] {
        let userId = try await currentUserID()
        let rows: [PlannerRow] = try await SupabaseService.client
            .from("meal_planner")
            .select()
            .eq("user_id", value: userId)
            .eq("actual_date", value: dateKey)
            .order("meal_type", ascending: true)
            .execute()
            .value
        return rows.filter { row in
            if row.is_leftover == true { return false }
            let name = (row.meal_name ?? "").lowercased()
            if name.contains("(leftover") { return false }
            return true
        }
    }

    /// Top-N most-recent food_items rows. Drives the dashboard Quick
    /// Log preload's "saved foods" half of the 2+2 split.
    private func fetchRecentFoods(limit: Int) async throws -> [FoodItemRow] {
        let userId = try await currentUserID()
        let response: [FoodItemRow] = try await SupabaseService.client
            .from("food_items")
            .select()
            .eq("user_id", value: userId)
            .order("updated_at", ascending: false)
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

    /// Filter a meal_log slice down to entries whose logged_at falls on
    /// the dashboard's *visible* day (selectedDate). Naïvely prefix-
    /// matching the ISO8601 string drops late-evening logs in any
    /// timezone west of UTC — e.g. 6pm PST = 02:00Z next day, which has
    /// the wrong date prefix. We parse the timestamp into a Date and
    /// re-format in `.current` to compare apples to apples.
    private func filterToVisibleDay(_ entries: [MealLogEntry]) -> [MealLogEntry] {
        let key = Self.localDateKey(for: selectedDate)
        let local = DateFormatter()
        local.dateFormat = "yyyy-MM-dd"
        local.timeZone = .current
        return entries.filter { entry in
            guard let raw = entry.logged_at else { return false }
            if let d = Self.parseISOTimestamp(raw) {
                return local.string(from: d) == key
            }
            // Fall back to YYYY-MM-DD prefix on the raw string — at worst
            // this treats a midnight-adjacent entry one day off, which is
            // no worse than the previous behavior.
            return String(raw.prefix(10)) == key
        }
    }

    /// Tolerant ISO8601 parser. ISO8601DateFormatter is strict about
    /// whether `.withFractionalSeconds` is present — Supabase's
    /// timestamptz column sometimes returns "…Z", sometimes "…+00:00",
    /// sometimes with fractional seconds. We try both shapes so the
    /// caller doesn't have to care.
    static func parseISOTimestamp(_ raw: String) -> Date? {
        if let d = isoStrict.date(from: raw) { return d }
        if let d = isoStrictFractional.date(from: raw) { return d }
        return nil
    }
    private static let isoStrict: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let isoStrictFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Bucket a Date into one of the four canonical meal_type strings
    /// the web uses. Same windows as src/pages/app.js getMealTypeFromTime
    /// — kept lower-cased here because the DB stores meal_type lowercase
    /// (the web display layer title-cases on render).
    static func inferMealType(at date: Date) -> String {
        let h = Calendar.current.component(.hour, from: date)
        switch h {
        case 5..<10:  return "breakfast"
        case 10..<14: return "lunch"
        case 14..<17: return "snack"
        case 17..<22: return "dinner"
        default:      return "snack"
        }
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

/// Result of AppState.saveFoodToLibrary — carries the resolved id + the
/// row itself (so the caller can splice it into local state) and a
/// `wasNew` flag so the preview sheet can show "Saved" vs "Already in
/// your foods" feedback without a second roundtrip.
struct SaveFoodResult {
    let id: String
    let row: FoodItemRow
    let wasNew: Bool
}
