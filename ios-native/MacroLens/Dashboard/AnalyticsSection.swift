import SwiftUI
import Charts

/// "Last 7 days" widget — three tiles with sparklines, mirroring the
/// renderDashboardAnalyticsWidget on web.
///
///   1. Avg calories  · sparkline of daily kcal
///   2. Avg protein   · % of days protein goal hit · sparkline of daily g
///   3. Weight change · current month delta · OR "Days logged this week"
///      fallback when there are fewer than 2 weight readings this month.
///
/// Hidden entirely when there's nothing to show (no logged days AND no
/// check-ins) — matches the web "don't render until there's something
/// worth showing" rule that avoids the "0 kcal · 0 days logged" ghost
/// strip on brand-new accounts.
struct AnalyticsSection: View {
    @Environment(AppState.self) private var state

    var body: some View {
        if shouldShow {
            VStack(alignment: .leading, spacing: 8) {
                Text("Last 7 days")
                    .font(.system(size: 11, weight: .medium))
                    .tracking(1.0)
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.text3)

                HStack(spacing: 10) {
                    avgCaloriesTile
                    avgProteinTile
                    weightTile
                }
            }
        }
    }

    private var shouldShow: Bool {
        loggedDays > 0 || !state.recentCheckins.isEmpty
    }

    // MARK: - Tiles

    private var avgCaloriesTile: some View {
        let avg = average(state.last7Days.map(\.calories), excludeZero: true)
        return tile(
            label: "Avg calories",
            value: "\(Int(avg))",
            sub: "kcal/day",
            color: Theme.cal,
            sparkline: state.last7Days.map(\.calories)
        )
    }

    private var avgProteinTile: some View {
        let avg = average(state.last7Days.map(\.protein), excludeZero: true)
        let pct = proteinAdherencePct
        return tile(
            label: "Avg protein",
            value: "\(Int(avg))g",
            sub: "\(pct)% hit goal",
            color: Theme.protein,
            sparkline: state.last7Days.map(\.protein)
        )
    }

    @ViewBuilder
    private var weightTile: some View {
        if let delta = monthlyWeightDeltaLbs {
            let sign = delta > 0 ? "+" : ""
            tile(
                label: "Weight change",
                value: "\(sign)\(format(delta)) lbs",
                sub: "this month · \(monthlyCheckinCount) check-ins",
                color: Theme.accent,
                sparkline: nil
            )
        } else {
            tile(
                label: "Days logged",
                value: "\(loggedDays)/7",
                sub: "this week",
                color: Theme.text,
                sparkline: nil
            )
        }
    }

    // MARK: - Tile factory

    private func tile(label: String, value: String, sub: String, color: Color, sparkline: [Double]?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .tracking(1.0)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(color)
                Text(sub)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
            }
            if let spark = sparkline, spark.contains(where: { $0 > 0 }) {
                miniSparkline(values: spark, color: color)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private func miniSparkline(values: [Double], color: Color) -> some View {
        Chart {
            ForEach(Array(values.enumerated()), id: \.offset) { idx, v in
                LineMark(x: .value("Day", idx), y: .value("Val", v))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(color)
                AreaMark(x: .value("Day", idx), y: .value("Val", v))
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(color.opacity(0.18))
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .frame(height: 26)
    }

    // MARK: - Computed

    private var loggedDays: Int {
        state.last7Days.filter { $0.count > 0 }.count
    }

    /// % of days in the last 7 where protein consumed >= goal. Days with
    /// no entries don't count against you; matches web semantics.
    private var proteinAdherencePct: Int {
        guard let goal = state.goals.protein, goal > 0 else { return 0 }
        let logged = state.last7Days.filter { $0.count > 0 }
        guard !logged.isEmpty else { return 0 }
        let hits = logged.filter { $0.protein >= Double(goal) }.count
        return Int((Double(hits) / Double(logged.count) * 100).rounded())
    }

    private var monthlyWeightDeltaLbs: Double? {
        let cal = Calendar.current
        let now = Date()
        let monthStart = cal.date(from: cal.dateComponents([.year, .month], from: now))!
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        let monthStartStr = formatter.string(from: monthStart)

        let inMonth = state.recentCheckins
            .filter { c in
                guard c.weight_kg != nil else { return false }
                let date = c.scan_date ?? c.checked_in_at?.prefix(10).description ?? ""
                return date >= monthStartStr
            }
            .sorted { ($0.scan_date ?? $0.checked_in_at ?? "") < ($1.scan_date ?? $1.checked_in_at ?? "") }

        guard inMonth.count >= 2,
              let first = inMonth.first?.weight_kg,
              let last = inMonth.last?.weight_kg else { return nil }
        let deltaKg = last - first
        return deltaKg * 2.20462
    }

    private var monthlyCheckinCount: Int {
        let cal = Calendar.current
        let now = Date()
        let monthStart = cal.date(from: cal.dateComponents([.year, .month], from: now))!
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        let monthStartStr = formatter.string(from: monthStart)
        return state.recentCheckins.filter {
            guard $0.weight_kg != nil else { return false }
            let date = $0.scan_date ?? $0.checked_in_at?.prefix(10).description ?? ""
            return date >= monthStartStr
        }.count
    }

    // MARK: - Helpers

    private func average(_ values: [Double], excludeZero: Bool) -> Double {
        let xs = excludeZero ? values.filter { $0 > 0 } : values
        guard !xs.isEmpty else { return 0 }
        return xs.reduce(0, +) / Double(xs.count)
    }

    private func format(_ x: Double) -> String {
        String(format: "%.1f", x)
    }
}
