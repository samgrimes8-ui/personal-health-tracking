import Foundation

/// Buckets checkins into Last-4-weeks / Past-12-months / Older-yearly
/// tiers so the Goals history view can render a digestible drill-down.
/// Mirrors the web logic added in commit 4bd517e + later refinements:
/// each checkin lands in exactly one tier so totals don't double-count.
enum CheckinHistory {

    /// One bucket within a tier — a week / month / year of checkins
    /// with the average weight precomputed.
    struct Bucket: Identifiable, Hashable {
        let id: String              // e.g., "wk:2026-04-19" / "mo:2026-04" / "yr:2025"
        let label: String           // human-friendly label for the row
        let avgWeightKg: Double?
        let entries: [CheckinRow]
        let scans: [CheckinRow]     // entries where scan_type is set
    }

    /// Tier of buckets — Last-4-weeks etc.
    struct Tier {
        let title: String
        let buckets: [Bucket]
    }

    /// Splits all checkins into the three tiers.
    static func tiers(from checkins: [CheckinRow]) -> [Tier] {
        let cal = Calendar.current
        let now = Date()
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current

        // Sunday of the week 4 weeks ago — anything on/after this is in
        // the weekly tier.
        let weeklyHorizonDate: Date = {
            var d = cal.startOfDay(for: now)
            d = cal.date(byAdding: .day, value: -d.weekday() - 21, to: d) ?? d
            return d
        }()
        // 12 months before that horizon → monthly tier window.
        let monthlyHorizonDate = cal.date(byAdding: .month, value: -12, to: weeklyHorizonDate) ?? weeklyHorizonDate
        let weeklyHorizonStr = f.string(from: weeklyHorizonDate)
        let monthlyHorizonStr = f.string(from: monthlyHorizonDate)

        var weekly: [String: [CheckinRow]] = [:]
        var monthly: [String: [CheckinRow]] = [:]
        var yearly: [String: [CheckinRow]] = [:]

        for c in checkins {
            guard let dateStr = checkinDate(c) else { continue }
            if dateStr >= weeklyHorizonStr {
                let wk = weekStart(for: dateStr, formatter: f, cal: cal)
                weekly[wk, default: []].append(c)
            } else if dateStr >= monthlyHorizonStr {
                let mo = String(dateStr.prefix(7))
                monthly[mo, default: []].append(c)
            } else {
                let yr = String(dateStr.prefix(4))
                yearly[yr, default: []].append(c)
            }
        }

        let weeklyTier = Tier(
            title: "Last 4 weeks",
            buckets: weekly.keys.sorted().reversed().map { wk in
                let entries = (weekly[wk] ?? []).sorted { (checkinDate($0) ?? "") > (checkinDate($1) ?? "") }
                return Bucket(
                    id: "wk:\(wk)",
                    label: "Week of \(formatLong(wk))",
                    avgWeightKg: average(entries.compactMap(\.weight_kg)),
                    entries: entries,
                    scans: entries.filter { $0.scan_type != nil }
                )
            }
        )

        let monthlyTier = Tier(
            title: "Past 12 months",
            buckets: monthly.keys.sorted().reversed().map { mo in
                let entries = (monthly[mo] ?? []).sorted { (checkinDate($0) ?? "") > (checkinDate($1) ?? "") }
                return Bucket(
                    id: "mo:\(mo)",
                    label: formatMonth(mo),
                    avgWeightKg: average(entries.compactMap(\.weight_kg)),
                    entries: entries,
                    scans: entries.filter { $0.scan_type != nil }
                )
            }
        )

        let yearlyTier = Tier(
            title: "Older",
            buckets: yearly.keys.sorted().reversed().map { yr in
                let entries = (yearly[yr] ?? []).sorted { (checkinDate($0) ?? "") > (checkinDate($1) ?? "") }
                return Bucket(
                    id: "yr:\(yr)",
                    label: "\(yr) annual avg",
                    avgWeightKg: average(entries.compactMap(\.weight_kg)),
                    entries: entries,
                    scans: entries.filter { $0.scan_type != nil }
                )
            }
        )

        return [weeklyTier, monthlyTier, yearlyTier].filter { !$0.buckets.isEmpty }
    }

    /// Weekly average chart data — every Sunday-bucket in the dataset,
    /// oldest first, average weight only. Used to draw the line chart
    /// at the top of the Goals page.
    static func weeklyAverages(from checkins: [CheckinRow], maxWeeks: Int = 12) -> [(weekStart: String, avgKg: Double)] {
        let cal = Calendar.current
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current

        var bucket: [String: [Double]] = [:]
        for c in checkins {
            guard let dateStr = checkinDate(c), let w = c.weight_kg else { continue }
            let wk = weekStart(for: dateStr, formatter: f, cal: cal)
            bucket[wk, default: []].append(w)
        }

        let sorted = bucket.keys.sorted()
        let last = sorted.suffix(maxWeeks)
        return last.map { wk in
            let ws = bucket[wk] ?? []
            return (wk, ws.reduce(0, +) / Double(ws.count))
        }
    }

    // MARK: - Helpers

    private static func checkinDate(_ c: CheckinRow) -> String? {
        if let d = c.scan_date { return d }
        if let s = c.checked_in_at { return String(s.prefix(10)) }
        return nil
    }

    private static func weekStart(for dateStr: String, formatter: DateFormatter, cal: Calendar) -> String {
        guard let d = formatter.date(from: dateStr) else { return dateStr }
        let dow = cal.component(.weekday, from: d) - 1   // 0 = Sunday
        let sunday = cal.date(byAdding: .day, value: -dow, to: d) ?? d
        return formatter.string(from: sunday)
    }

    private static func average(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    private static func formatLong(_ ymd: String) -> String {
        let inFmt = DateFormatter()
        inFmt.dateFormat = "yyyy-MM-dd"
        inFmt.timeZone = .current
        guard let d = inFmt.date(from: ymd) else { return ymd }
        let outFmt = DateFormatter()
        outFmt.dateFormat = "MMM d"
        return outFmt.string(from: d)
    }

    private static func formatMonth(_ ym: String) -> String {
        let inFmt = DateFormatter()
        inFmt.dateFormat = "yyyy-MM"
        inFmt.timeZone = .current
        guard let d = inFmt.date(from: ym) else { return ym }
        let outFmt = DateFormatter()
        outFmt.dateFormat = "MMMM yyyy"
        return outFmt.string(from: d)
    }
}

private extension Date {
    func weekday() -> Int {
        Calendar.current.component(.weekday, from: self) - 1   // 0 = Sunday
    }
}
