import Foundation
import Supabase

/// Daily-total macro sync to HealthKit. Lives as an AppState extension so
/// every meal_log mutation can call `syncDayMacrosToHealthKit(dateKey:)`
/// without the call site needing to know how to compute totals or talk
/// to HKHealthStore.
///
/// Why this file rather than inline in AppState.swift:
///   - Keeps AppState focused on cross-tab state slices, not
///     single-feature plumbing
///   - The migration helpers (legacy cleanup + 90-day backfill) belong
///     near the other HK code in Health/
///
/// All entry points are no-ops if the pushMacros toggle is off — callers
/// don't need to gate themselves.
extension AppState {

    // ─── Per-day recompute + push ──────────────────────────────────────

    /// Recompute totals for `dateKey` (local YYYY-MM-DD) from meal_log
    /// and push to HealthKit (or clear if zero). Best-effort: HK errors
    /// are swallowed so they don't bubble up into UI flows. The next
    /// mutation or app foreground will retry.
    func syncDayMacrosToHealthKit(dateKey: String) async {
        guard HealthKitService.shared.isAvailable else { return }
        let userId: String
        do { userId = try await SupabaseService.client.auth.session.user.id.uuidString }
        catch { return }
        guard HealthKitService.isToggleOn(.pushMacros, userId: userId) else { return }
        do {
            let totals = try await fetchDayMealTotals(userId: userId, dateKey: dateKey)
            try await applyDayMacrosToHealthKit(dateKey: dateKey, totals: totals)
        } catch {
            // intentional: HK push must not block meal CRUD
        }
    }

    /// Used by the meal mutation methods to capture an entry's day BEFORE
    /// the mutation runs (so a delete still knows which day to recompute).
    /// Falls back to today if the entry isn't in any local slice.
    func dateKeyForMeal(id: String) -> String {
        if let e = todayLog.first(where: { $0.id == id }), let s = e.logged_at {
            return String(s.prefix(10))
        }
        if let e = dashboardRecentMeals.first(where: { $0.id == id }), let s = e.logged_at {
            return String(s.prefix(10))
        }
        return Self.localDateKey(for: Date())
    }

    static func localDateKey(for date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.string(from: date)
    }

    // ─── Migration: legacy per-meal samples → daily totals + 90d backfill

    /// One-shot migration. Triggered from AppShell .task; gated by a
    /// per-user UserDefaults flag so it runs at most once per user per
    /// device. Steps:
    ///   1. Wipe legacy per-meal samples (metadata.macrolens_meal_id)
    ///   2. Backfill the last 90 days under the new daily-total model
    ///   3. Stamp the flag so we don't re-run
    ///
    /// Skipped silently if the pushMacros toggle is off (no permission
    /// + no need — the user opted out of macro sync).
    func runHealthKitMacroDailyTotalMigrationIfNeeded() async {
        guard HealthKitService.shared.isAvailable else { return }
        let userId: String
        do { userId = try await SupabaseService.client.auth.session.user.id.uuidString }
        catch { return }
        guard HealthKitService.isToggleOn(.pushMacros, userId: userId) else { return }
        let flagKey = "hk_macros_daily_total_migration_v1_\(userId)"
        if UserDefaults.standard.bool(forKey: flagKey) { return }

        do {
            try await HealthKitService.shared.deleteLegacyPerMealSamples()
            try await backfillDailyMacroTotals(userId: userId, days: 90)
            UserDefaults.standard.set(true, forKey: flagKey)
        } catch {
            // leave the flag unset so the next launch retries
        }
    }

    /// Backfill `days` worth of daily totals. Used by the migration AND
    /// when the user flips the pushMacros toggle on for the first time
    /// (HealthSettingsSection runs this directly so the user sees the
    /// last 90 days of macros in HK immediately).
    func backfillDailyMacroTotals(userId: String, days: Int) async throws {
        let cal = Calendar(identifier: .gregorian)
        let today = cal.startOfDay(for: Date())
        guard let from = cal.date(byAdding: .day, value: -(days - 1), to: today) else { return }
        let fromKey = Self.localDateKey(for: from)

        let entries: [MealLogEntry] = try await SupabaseService.client
            .from("meal_log")
            .select("calories, protein, carbs, fat, fiber, logged_at")
            .eq("user_id", value: userId)
            .gte("logged_at", value: fromKey)
            .execute()
            .value

        // Group by the day prefix of logged_at — same convention as the
        // dashboard's filterToToday + DaySummary.build. ISO8601 strings
        // start with YYYY-MM-DD; we trust that prefix as the day key.
        let groups = Dictionary(grouping: entries) { entry -> String in
            String((entry.logged_at ?? "").prefix(10))
        }

        for (dateKey, dayEntries) in groups {
            // Defensive: skip rows with malformed/missing logged_at.
            // YYYY-MM-DD is exactly 10 chars; anything shorter means
            // the row didn't have a timestamp prefix.
            guard dateKey.count == 10 else { continue }
            let totals = DailyMacroTotals.sum(dayEntries)
            try await applyDayMacrosToHealthKit(dateKey: dateKey, totals: totals)
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────

    /// Sum kcal/protein/carbs/fat for one local date by querying
    /// meal_log with a one-day timestamp window. Filters client-side on
    /// the local YYYY-MM-DD prefix to match how the dashboard slices
    /// "today's" meals — keeps native + web in sync on the day boundary.
    private func fetchDayMealTotals(userId: String, dateKey: String) async throws -> DailyMacroTotals {
        let cal = Calendar(identifier: .gregorian)
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        f.calendar = cal
        guard let day = f.date(from: dateKey),
              let next = cal.date(byAdding: .day, value: 1, to: day) else {
            return DailyMacroTotals()
        }
        // Query a slightly wider window than strictly needed (using the
        // YYYY-MM-DD bound which Postgres reads as UTC midnight) and
        // then filter precisely on the prefix. Mirror of the
        // dashboard's filterToToday pattern — local-day prefix is the
        // contract MacroLens uses everywhere.
        let prevKey = f.string(from: cal.date(byAdding: .day, value: -1, to: day) ?? day)
        let nextKey = f.string(from: next)
        let entries: [MealLogEntry] = try await SupabaseService.client
            .from("meal_log")
            .select("calories, protein, carbs, fat, fiber, logged_at")
            .eq("user_id", value: userId)
            .gte("logged_at", value: prevKey)
            .lt("logged_at", value: nextKey)
            .execute()
            .value
        let dayEntries = entries.filter { ($0.logged_at ?? "").hasPrefix(dateKey) }
        return DailyMacroTotals.sum(dayEntries)
    }

    /// Push or clear depending on whether the day has any macros. The
    /// "no zero samples" rule mirrors the brief: HK should show the day
    /// as empty after a delete drains it, not as 0 kcal.
    private func applyDayMacrosToHealthKit(dateKey: String, totals: DailyMacroTotals) async throws {
        let cal = Calendar(identifier: .gregorian)
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        f.calendar = cal
        guard let day = f.date(from: dateKey) else { return }

        if totals.calories == 0 && totals.protein == 0
            && totals.carbs == 0 && totals.fat == 0 {
            try await HealthKitService.shared.clearDailyMacroTotal(dateKey: dateKey)
            return
        }

        let start = cal.startOfDay(for: day)
        // End-of-day = next midnight - 1s. For today, clamp to now so HK
        // doesn't reject a future-dated sample (some types do).
        let nextMidnight = cal.date(byAdding: .day, value: 1, to: start) ?? start
        let endOfDay = cal.date(byAdding: .second, value: -1, to: nextMidnight) ?? nextMidnight
        let now = Date()
        let end = cal.isDate(day, inSameDayAs: now) ? now : endOfDay

        try await HealthKitService.shared.pushDailyMacroTotal(
            dateKey: dateKey,
            start: start,
            end: end,
            kcal: totals.calories,
            protein: totals.protein,
            carbs: totals.carbs,
            fat: totals.fat
        )
    }
}
