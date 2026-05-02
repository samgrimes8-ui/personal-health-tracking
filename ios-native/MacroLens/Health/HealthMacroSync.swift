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
///
/// TIME ZONE CONTRACT (important — root cause of the v1 drift bug):
///   - logged_at on meal_log is an ISO8601 string in UTC ("…Z")
///   - "Today" + day-grouping is in the user's local TZ
///   - DO NOT use `logged_at.hasPrefix(localDateKey)` — that's a UTC
///     prefix matched against a local key, which mis-buckets evening
///     meals in TZs west of UTC. Always parse the ISO string into a
///     Date and re-format in `.current` to compare apples to apples.
///   - This mirrors AppState.filterToToday — keep them in lockstep.
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
    /// Falls back to today if the entry isn't in any local slice. Parses
    /// logged_at into a Date + reformats local-TZ to avoid the UTC-prefix
    /// trap (see file header).
    func dateKeyForMeal(id: String) -> String {
        let lookup: (MealLogEntry) -> String? = { entry in
            guard let raw = entry.logged_at else { return nil }
            if let d = AppState.parseISOTimestamp(raw) {
                return Self.localDateKey(for: d)
            }
            // No timestamp parses; fall back to the raw 10-char prefix
            // — bug-for-bug compatible with the dashboard's fallback.
            return String(raw.prefix(10))
        }
        if let e = todayLog.first(where: { $0.id == id }), let key = lookup(e) {
            return key
        }
        if let e = dashboardRecentMeals.first(where: { $0.id == id }), let key = lookup(e) {
            return key
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

    /// Per-user UserDefaults key. Bumped to v2 in the drift-fix commit so
    /// existing users re-run the migration with the TZ-correct grouping
    /// + the self-healing push (legacy samples on every push). v1 users
    /// who already had the flag set get re-migrated automatically.
    private static func migrationFlagKey(userId: String) -> String {
        "hk_macros_daily_total_migration_v2_\(userId)"
    }

    /// Gated migration runner. Triggered from AppState.loadDashboard;
    /// runs at most once per user per device unless `force: true`.
    /// Skipped silently if the pushMacros toggle is off (no permission
    /// + no need — the user opted out of macro sync).
    func runHealthKitMacroDailyTotalMigrationIfNeeded() async {
        guard HealthKitService.shared.isAvailable else { return }
        let userId: String
        do { userId = try await SupabaseService.client.auth.session.user.id.uuidString }
        catch { return }
        guard HealthKitService.isToggleOn(.pushMacros, userId: userId) else { return }
        await runHealthKitMacroDailyTotalMigration(userId: userId, force: false)
    }

    /// Force-runnable migration. Used by the toggle-on path + the
    /// "Resync to Apple Health" debug button. Steps:
    ///   1. Wipe legacy per-meal samples (metadata.macrolens_meal_id)
    ///   2. Backfill the last 90 days under the daily-total model.
    ///      pushDailyMacroTotal is itself self-healing — it re-deletes
    ///      anything in the day's window before writing — so this also
    ///      cleans up double-pushed samples from a previous v1 run.
    ///   3. Stamp the v2 flag so the gated path skips on next launch.
    func runHealthKitMacroDailyTotalMigration(userId: String, force: Bool) async {
        guard HealthKitService.shared.isAvailable else { return }
        let flagKey = Self.migrationFlagKey(userId: userId)
        if !force && UserDefaults.standard.bool(forKey: flagKey) { return }
        do {
            try await HealthKitService.shared.deleteLegacyPerMealSamples()
            try await backfillDailyMacroTotals(userId: userId, days: 90)
            UserDefaults.standard.set(true, forKey: flagKey)
        } catch {
            // leave the flag unset so the next launch retries
        }
    }

    /// Manual reset for the "Resync to Apple Health" button. Clears the
    /// flag and re-runs the migration with force=true. Returns when
    /// done so the caller can show a "Done" status.
    func resyncMacrosToHealthKit() async {
        let userId: String
        do { userId = try await SupabaseService.client.auth.session.user.id.uuidString }
        catch { return }
        UserDefaults.standard.removeObject(forKey: Self.migrationFlagKey(userId: userId))
        await runHealthKitMacroDailyTotalMigration(userId: userId, force: true)
    }

    /// Backfill `days` worth of daily totals. Used by the migration AND
    /// when the user flips the pushMacros toggle on for the first time.
    /// Group-by-day uses the parse-then-local-TZ-format pattern (see
    /// file header) so evening meals near midnight bucket into the
    /// correct day.
    func backfillDailyMacroTotals(userId: String, days: Int) async throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
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

        // Group by local-TZ day. Parse ISO → re-format `.current` so a
        // PST 10pm meal (UTC next-day) buckets into PST today, not PST
        // tomorrow. Same rule the dashboard's filterToToday uses.
        let groups = Dictionary(grouping: entries) { entry -> String in
            guard let raw = entry.logged_at else { return "" }
            if let d = AppState.parseISOTimestamp(raw) {
                return Self.localDateKey(for: d)
            }
            return String(raw.prefix(10))
        }

        for (dateKey, dayEntries) in groups {
            // Skip rows with malformed/missing logged_at — they end up
            // grouped under "" or a sub-10-char prefix.
            guard dateKey.count == 10 else { continue }
            let totals = DailyMacroTotals.sum(dayEntries)
            try await applyDayMacrosToHealthKit(dateKey: dateKey, totals: totals)
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────

    /// Sum kcal/protein/carbs/fat for one local date by querying
    /// meal_log and filtering with the parse-then-local-TZ-format
    /// pattern (see file header). Mirrors AppState.filterToToday so
    /// MacroLens dashboard totals + HK totals always match.
    private func fetchDayMealTotals(userId: String, dateKey: String) async throws -> DailyMacroTotals {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        f.calendar = cal
        guard let day = f.date(from: dateKey),
              let next = cal.date(byAdding: .day, value: 1, to: day) else {
            return DailyMacroTotals()
        }
        // Query a wider-than-needed window using the YYYY-MM-DD bound
        // (Postgres reads it as UTC midnight). Then filter precisely
        // client-side in the user's local TZ. The wider window covers
        // the worst-case 24h TZ skew between UTC and local.
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
        let dayEntries = entries.filter { entry in
            guard let raw = entry.logged_at else { return false }
            if let d = AppState.parseISOTimestamp(raw) {
                return Self.localDateKey(for: d) == dateKey
            }
            return String(raw.prefix(10)) == dateKey
        }
        return DailyMacroTotals.sum(dayEntries)
    }

    /// Push or clear depending on whether the day has any macros. The
    /// "no zero samples" rule: HK shows the day as empty after a delete
    /// drains it, not as 0 kcal.
    private func applyDayMacrosToHealthKit(dateKey: String, totals: DailyMacroTotals) async throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        f.calendar = cal
        guard let day = f.date(from: dateKey) else { return }

        if totals.calories == 0 && totals.protein == 0
            && totals.carbs == 0 && totals.fat == 0 {
            // Empty-day: still call clear with the day's time range so
            // any leftover legacy per-meal samples in that window get
            // wiped too (clearDailyMacroTotal is also self-healing).
            let start = cal.startOfDay(for: day)
            let nextMidnight = cal.date(byAdding: .day, value: 1, to: start) ?? start
            try await HealthKitService.shared.clearDailyMacroTotal(
                dateKey: dateKey, dayStart: start, dayEnd: nextMidnight
            )
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
            // dayStart/nextMidnight are passed for the self-healing
            // delete predicate inside pushDailyMacroTotal — it nukes
            // any of our samples in that range, daily-total or legacy.
            dayStart: start,
            dayEnd: nextMidnight,
            kcal: totals.calories,
            protein: totals.protein,
            carbs: totals.carbs,
            fat: totals.fat
        )
    }
}
