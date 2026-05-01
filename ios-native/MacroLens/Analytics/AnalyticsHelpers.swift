import Foundation

/// Pure-data analytics rollups, ported from src/pages/app.js
/// (`buildDailyWindow`, `summarizeWindow`, `topLoggedItems`,
/// `dayOfWeekPattern`, `mealTimingStats`, `adherenceHeatmap`).
///
/// Kept separate from AnalyticsView so the view stays declarative and
/// the math is easy to reason about / unit-test in isolation.
enum AnalyticsHelpers {

    // MARK: Day rollup

    /// One day's macros, mirroring the JS `{ date, cal, p, c, f, fi, count }`
    /// shape. Anchors are the same (per-day totals; no per-meal breakdown).
    struct DailyTotals: Hashable, Identifiable {
        var id: String { date }
        let date: String              // YYYY-MM-DD (local timezone)
        var cal: Double
        var p: Double
        var c: Double
        var f: Double
        var fi: Double
        var count: Int

        static func empty(_ date: String) -> DailyTotals {
            DailyTotals(date: date, cal: 0, p: 0, c: 0, f: 0, fi: 0, count: 0)
        }
    }

    struct WindowSummary {
        let avgCal: Double
        let avgP: Double
        let avgC: Double
        let avgF: Double
        let avgFi: Double
        let loggedDays: Int
        let totalDays: Int
        let calAdherencePct: Int
        let proteinAdherencePct: Int
    }

    struct TopItem: Hashable, Identifiable {
        var id: String { key }
        let key: String
        let kind: Kind
        let name: String
        let count: Int

        enum Kind { case recipe, food, unlinked }
    }

    struct DowAvg: Hashable, Identifiable {
        var id: Int { dow }
        let dow: Int                  // 0 = Sunday
        let avg: Double
        let count: Int
    }

    struct MealTiming {
        let firstMeal: String
        let lastMeal: String
        let eatingWindowHrs: Double?
    }

    struct HeatmapCell: Hashable, Identifiable {
        var id: String { date }
        let date: String              // YYYY-MM-DD
        let status: Status
        let cal: Double
        let p: Double
        let count: Int

        enum Status { case empty, off, ok, good }
    }

    // MARK: Date helpers

    /// Local-timezone YYYY-MM-DD. Mirrors `analyticsLocalDs` — never go
    /// through `toISOString()`, which would silently drift days at the
    /// edges of the user's timezone.
    static func ds(_ date: Date, calendar: Calendar = .current) -> String {
        let comps = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", comps.year ?? 0, comps.month ?? 1, comps.day ?? 1)
    }

    /// Turn a `logged_at` timestamp into a local-timezone Date. The web
    /// schema stores ISO8601 with offset; falling back to the date-only
    /// form ("YYYY-MM-DD") covers entries created with bare scan_date.
    static func parseTimestamp(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        if let d = isoFormatter.date(from: raw) { return d }
        if let d = isoFormatterNoFractional.date(from: raw) { return d }
        if raw.count >= 10, let d = ymdFormatter.date(from: String(raw.prefix(10))) {
            return d
        }
        return nil
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoFormatterNoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let ymdFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        f.calendar = Calendar(identifier: .gregorian)
        return f
    }()

    // MARK: Aggregations

    /// Group log entries by their local date. Equivalent to JS
    /// `aggregateLogByDay`.
    static func aggregateLogByDay(_ log: [MealLogEntry]) -> [String: DailyTotals] {
        var byDay: [String: DailyTotals] = [:]
        for entry in log {
            guard let date = parseTimestamp(entry.logged_at) else { continue }
            let key = ds(date)
            var bucket = byDay[key] ?? .empty(key)
            bucket.cal += entry.calories ?? 0
            bucket.p   += entry.protein ?? 0
            bucket.c   += entry.carbs ?? 0
            bucket.f   += entry.fat ?? 0
            bucket.fi  += entry.fiber ?? 0
            bucket.count += 1
            byDay[key] = bucket
        }
        return byDay
    }

    /// Last `days` days ending today (local), oldest first, with empty
    /// rows for days that had no log.
    static func buildDailyWindow(_ log: [MealLogEntry], days: Int) -> [DailyTotals] {
        let byDay = aggregateLogByDay(log)
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        var out: [DailyTotals] = []
        out.reserveCapacity(days)
        for i in stride(from: days - 1, through: 0, by: -1) {
            let d = cal.date(byAdding: .day, value: -i, to: today)!
            let k = ds(d, calendar: cal)
            out.append(byDay[k] ?? .empty(k))
        }
        return out
    }

    /// The `range` days *before* the current window — used to compute
    /// the headline delta vs the prior comparable period.
    static func buildPreviousWindow(_ log: [MealLogEntry], days: Int) -> [DailyTotals] {
        let byDay = aggregateLogByDay(log)
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        var out: [DailyTotals] = []
        for i in stride(from: days * 2 - 1, through: days, by: -1) {
            let d = cal.date(byAdding: .day, value: -i, to: today)!
            let k = ds(d, calendar: cal)
            out.append(byDay[k] ?? .empty(k))
        }
        return out
    }

    static func summarize(_ daily: [DailyTotals], goals: Goals) -> WindowSummary {
        let logged = daily.filter { $0.count > 0 }
        let n = max(logged.count, 1)
        let avgCal = logged.reduce(0) { $0 + $1.cal } / Double(n)
        let avgP   = logged.reduce(0) { $0 + $1.p   } / Double(n)
        let avgC   = logged.reduce(0) { $0 + $1.c   } / Double(n)
        let avgF   = logged.reduce(0) { $0 + $1.f   } / Double(n)
        let avgFi  = logged.reduce(0) { $0 + $1.fi  } / Double(n)

        let calTarget = Double(goals.calories ?? 2000)
        let proteinTarget = Double(goals.protein ?? 150)

        let calInRange = logged.filter { abs($0.cal - calTarget) <= calTarget * 0.15 }.count
        let proteinHit = logged.filter { $0.p >= proteinTarget }.count

        return WindowSummary(
            avgCal: avgCal, avgP: avgP, avgC: avgC, avgF: avgF, avgFi: avgFi,
            loggedDays: logged.count,
            totalDays: daily.count,
            calAdherencePct: logged.isEmpty ? 0 : Int((Double(calInRange) / Double(logged.count) * 100).rounded()),
            proteinAdherencePct: logged.isEmpty ? 0 : Int((Double(proteinHit) / Double(logged.count) * 100).rounded())
        )
    }

    // MARK: Most-logged items

    static func topLoggedItems(_ log: [MealLogEntry],
                               recipes: [RecipeRow],
                               topN: Int = 5) -> [TopItem] {
        struct Bucket { var key: String; var kind: TopItem.Kind; var name: String; var count: Int }
        var counts: [String: Bucket] = [:]
        for entry in log {
            let key: String
            let kind: TopItem.Kind
            let displayName: String
            if let rid = entry.recipe_id {
                key = "r:\(rid)"
                kind = .recipe
                displayName = recipes.first { $0.id == rid }?.name ?? entry.name ?? "Recipe"
            } else if let fid = entry.food_item_id {
                key = "f:\(fid)"
                kind = .food
                displayName = entry.name ?? "Food"
            } else {
                let trimmed = (entry.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard !trimmed.isEmpty else { continue }
                key = "n:\(trimmed)"
                kind = .unlinked
                displayName = entry.name ?? "Unknown"
            }
            var bucket = counts[key] ?? Bucket(key: key, kind: kind, name: displayName, count: 0)
            bucket.count += 1
            counts[key] = bucket
        }
        return counts.values
            .sorted { $0.count > $1.count }
            .prefix(topN)
            .map { TopItem(key: $0.key, kind: $0.kind, name: $0.name, count: $0.count) }
    }

    // MARK: Day of week

    static func dayOfWeekPattern(_ log: [MealLogEntry]) -> [DowAvg] {
        var totals = Array(repeating: (cal: 0.0, count: 0), count: 7)
        let byDay = aggregateLogByDay(log)
        let cal = Calendar.current
        for (key, day) in byDay {
            guard let date = ymdFormatter.date(from: key) else { continue }
            // weekday: 1=Sunday in Calendar; convert to 0-indexed (0=Sun).
            let dow = cal.component(.weekday, from: date) - 1
            guard (0..<7).contains(dow) else { continue }
            totals[dow].cal += day.cal
            totals[dow].count += 1
        }
        return (0..<7).map { i in
            DowAvg(dow: i, avg: totals[i].count > 0 ? totals[i].cal / Double(totals[i].count) : 0,
                   count: totals[i].count)
        }
    }

    // MARK: Meal timing

    static func mealTimingStats(_ log: [MealLogEntry]) -> MealTiming {
        var firstByDay: [String: Double] = [:]
        var lastByDay: [String: Double] = [:]
        let cal = Calendar.current
        for entry in log {
            guard let date = parseTimestamp(entry.logged_at) else { continue }
            let key = ds(date, calendar: cal)
            let comps = cal.dateComponents([.hour, .minute], from: date)
            let hours = Double(comps.hour ?? 0) + Double(comps.minute ?? 0) / 60.0
            if let cur = firstByDay[key] { firstByDay[key] = min(cur, hours) } else { firstByDay[key] = hours }
            if let cur = lastByDay[key]  { lastByDay[key]  = max(cur, hours) } else { lastByDay[key]  = hours }
        }
        let firsts = Array(firstByDay.values)
        let lasts  = Array(lastByDay.values)
        let firstAvg = average(firsts)
        let lastAvg  = average(lasts)
        let window: Double? = {
            guard let f = firstAvg, let l = lastAvg else { return nil }
            return ((l - f) * 10).rounded() / 10
        }()
        return MealTiming(
            firstMeal: formatHour(firstAvg),
            lastMeal: formatHour(lastAvg),
            eatingWindowHrs: window
        )
    }

    private static func average(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    private static func formatHour(_ h: Double?) -> String {
        guard let h else { return "—" }
        let hh = Int(h)
        let mm = Int(((h - Double(hh)) * 60).rounded())
        let period = hh >= 12 ? "PM" : "AM"
        let display = hh == 0 ? 12 : hh > 12 ? hh - 12 : hh
        return String(format: "%d:%02d %@", display, mm, period)
    }

    // MARK: Heatmap

    static func adherenceCells(_ daily: [DailyTotals], goals: Goals) -> [HeatmapCell] {
        let calTarget = Double(goals.calories ?? 2000)
        let proteinTarget = Double(goals.protein ?? 150)
        return daily.map { d in
            if d.count == 0 {
                return HeatmapCell(date: d.date, status: .empty, cal: 0, p: 0, count: 0)
            }
            let calOK = abs(d.cal - calTarget) <= calTarget * 0.15
            let proteinOK = d.p >= proteinTarget
            let score = (calOK ? 1 : 0) + (proteinOK ? 1 : 0)
            let status: HeatmapCell.Status = score == 2 ? .good : score == 1 ? .ok : .off
            return HeatmapCell(date: d.date, status: status, cal: d.cal, p: d.p, count: d.count)
        }
    }
}
