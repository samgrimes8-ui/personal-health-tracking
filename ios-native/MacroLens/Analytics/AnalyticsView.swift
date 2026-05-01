import SwiftUI
import Charts

/// Native Analytics page. Mirrors `renderAnalyticsPage` in
/// src/pages/app.js (lines 595–830). Reads from `state.analyticsLog`,
/// `state.allCheckins`, `state.goals`, and `state.recipes` — all
/// populated by `AppState.loadAnalytics()`.
///
/// Sections, top to bottom:
///   1. Greeting + range picker (7 / 30 / 90 / 365)
///   2. Headline card — N-day average + macro chips + delta + adherence
///   3. Daily calories trend (Swift Charts) with goal line
///   4. Daily protein trend with goal line
///   5. Weight trend (only when there are ≥2 readings in range)
///   6. Goal-adherence heatmap
///   7. Two-column grid: most-logged items, day-of-week, meal timing,
///      latest body scan summary
struct AnalyticsView: View {
    @Environment(AppState.self) private var state

    private static let imperialPreferenceKey = "macrolens.units.imperial"

    var body: some View {
        @Bindable var bindable = state
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                greeting
                rangePicker(binding: $bindable.analyticsRangeDays)
                headlineCard
                calorieTrendCard
                proteinTrendCard
                if weightSeries.count >= 2 {
                    weightTrendCard
                }
                heatmapCard
                secondaryGrid
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .refreshable { await state.loadAnalytics() }
        .task { await state.loadAnalytics() }
        .navigationTitle("Analytics")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Sections

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Analytics")
                .font(.system(size: 26, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
            Text("Trends, patterns, and goal adherence across your logged data.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text3)
        }
        .padding(.top, 12)
    }

    private func rangePicker(binding: Binding<Int>) -> some View {
        let options: [(Int, String)] = [(7, "7 days"), (30, "30 days"), (90, "90 days"), (365, "1 year")]
        return HStack(spacing: 6) {
            ForEach(options, id: \.0) { (days, label) in
                Button {
                    if binding.wrappedValue != days {
                        binding.wrappedValue = days
                        Task { await state.loadAnalytics() }
                    }
                } label: {
                    Text(label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(binding.wrappedValue == days ? Theme.accent : Theme.text2)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(
                            Capsule().fill(binding.wrappedValue == days
                                ? Theme.accentSoft(0.15)
                                : Theme.bg3)
                        )
                        .overlay(
                            Capsule().stroke(binding.wrappedValue == days
                                ? Theme.accent
                                : Theme.border2, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
    }

    private var headlineCard: some View {
        let days = state.analyticsRangeDays
        let summary = currentSummary
        let prev = previousSummary
        let goals = state.goals
        let calDelta: Int? = {
            guard prev.avgCal > 0 else { return nil }
            return Int(((summary.avgCal - prev.avgCal) / prev.avgCal * 100).rounded())
        }()

        return Card {
            VStack(alignment: .leading, spacing: 14) {
                Text("\(days)-day average")
                    .font(.system(size: 11, weight: .medium))
                    .tracking(1.0)
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.text3)

                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("\(Int(summary.avgCal.rounded()))")
                        .font(.system(size: 44, weight: .semibold, design: .serif))
                        .foregroundStyle(Theme.cal)
                    Text("kcal / day")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text3)
                    if let delta = calDelta {
                        Text("\(delta > 0 ? "↑" : "↓") \(abs(delta))% vs prior \(days) days")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(delta > 0 ? Theme.fat : Theme.protein)
                    }
                }

                LazyVGrid(columns: [
                    GridItem(.adaptive(minimum: 120), spacing: 10)
                ], alignment: .leading, spacing: 10) {
                    macroStat(label: "PROTEIN", value: "\(Int(summary.avgP.rounded()))g",
                              sub: "of \(goals.protein ?? 150)g goal", color: Theme.protein)
                    macroStat(label: "CARBS", value: "\(Int(summary.avgC.rounded()))g",
                              sub: nil, color: Theme.carbs)
                    macroStat(label: "FAT", value: "\(Int(summary.avgF.rounded()))g",
                              sub: nil, color: Theme.fat)
                    macroStat(label: "FIBER", value: "\(Int(summary.avgFi.rounded()))g",
                              sub: nil, color: Theme.text2)
                }

                Divider().background(Theme.border)

                (
                    Text("Logged \(summary.loggedDays) of \(summary.totalDays) days · ")
                        .foregroundStyle(Theme.text3)
                    + Text("\(summary.calAdherencePct)%")
                        .foregroundStyle(adherenceColor(summary.calAdherencePct))
                    + Text(" within calorie goal · ")
                        .foregroundStyle(Theme.text3)
                    + Text("\(summary.proteinAdherencePct)%")
                        .foregroundStyle(adherenceColor(summary.proteinAdherencePct))
                    + Text(" hit protein")
                        .foregroundStyle(Theme.text3)
                )
                .font(.system(size: 12))
            }
        }
    }

    private var calorieTrendCard: some View {
        let goal = Double(state.goals.calories ?? 2000)
        return Card {
            VStack(alignment: .leading, spacing: 8) {
                trendHeader(title: "Daily calories", trailing: "Goal: \(Int(goal)) kcal")
                trendChart(values: currentDaily.map(\.cal),
                           dates: currentDaily.map(\.date),
                           color: Theme.cal,
                           goal: goal,
                           goalLabel: "\(Int(goal)) goal",
                           yFormatter: { "\(Int($0))" })
            }
        }
    }

    private var proteinTrendCard: some View {
        let goal = Double(state.goals.protein ?? 150)
        return Card {
            VStack(alignment: .leading, spacing: 8) {
                trendHeader(title: "Daily protein", trailing: "Goal: \(Int(goal))g")
                trendChart(values: currentDaily.map(\.p),
                           dates: currentDaily.map(\.date),
                           color: Theme.protein,
                           goal: goal,
                           goalLabel: "\(Int(goal))g goal",
                           yFormatter: { "\(Int($0))g" })
            }
        }
    }

    private var weightTrendCard: some View {
        let series = weightSeries
        let isImperial = useImperial
        let factor = isImperial ? 2.20462 : 1.0
        let unit = isImperial ? "lbs" : "kg"
        let displayValues = series.map { $0.weightKg * factor }
        let firstKg = series.first?.weightKg ?? 0
        let lastKg  = series.last?.weightKg ?? 0
        let diffDisplay = (lastKg - firstKg) * factor
        let sign = diffDisplay > 0 ? "+" : ""

        return Card {
            VStack(alignment: .leading, spacing: 8) {
                trendHeader(
                    title: "Weight",
                    trailing: "\(sign)\(String(format: "%.1f", diffDisplay)) \(unit) over \(state.analyticsRangeDays) days"
                )
                Chart {
                    ForEach(Array(series.enumerated()), id: \.offset) { idx, point in
                        LineMark(x: .value("Day", idx),
                                 y: .value(unit, point.weightKg * factor))
                            .interpolationMethod(.monotone)
                            .foregroundStyle(Theme.accent)
                        AreaMark(x: .value("Day", idx),
                                 y: .value(unit, point.weightKg * factor))
                            .interpolationMethod(.monotone)
                            .foregroundStyle(Theme.accent.opacity(0.18))
                    }
                }
                .chartYScale(domain: yDomain(for: displayValues, includeZero: false))
                .chartXAxis(.hidden)
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { _ in
                        AxisGridLine().foregroundStyle(Theme.border)
                        AxisValueLabel().font(.system(size: 9))
                    }
                }
                .frame(height: 160)
            }
        }
    }

    private var heatmapCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                Text("Goal adherence heatmap")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text2)
                Text("Green = hit calorie + protein goals · Yellow = partial · Red = off · Gray = no log")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
                AdherenceHeatmap(cells: AnalyticsHelpers.adherenceCells(currentDaily, goals: state.goals))
                    .padding(.top, 8)
            }
        }
    }

    private var secondaryGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 16)], alignment: .leading, spacing: 16) {
            mostLoggedCard
            dayOfWeekCard
            mealTimingCard
            if let latest = weightSeries.last {
                latestScanCard(latest)
            }
        }
    }

    private var mostLoggedCard: some View {
        let items = AnalyticsHelpers.topLoggedItems(currentRangeLog, recipes: state.recipes)
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Most-logged items")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text2)

                if items.isEmpty {
                    Text("No entries yet.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { idx, item in
                            HStack(spacing: 10) {
                                Text("\(idx + 1)")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.text3)
                                    .frame(width: 16, alignment: .trailing)
                                Text(item.name)
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.text)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Text(badge(for: item.kind))
                                    .font(.system(size: 11))
                                    .foregroundStyle(badgeColor(for: item.kind))
                                Text("\(item.count)×")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Theme.text2)
                            }
                            .padding(.vertical, 6)
                            if idx < items.count - 1 {
                                Divider().background(Theme.border)
                            }
                        }
                    }
                }
            }
        }
    }

    private var dayOfWeekCard: some View {
        let pattern = AnalyticsHelpers.dayOfWeekPattern(currentRangeLog)
        let maxAvg = max(pattern.map(\.avg).max() ?? 0, 1)
        let labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

        return Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Avg calories by day of week")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text2)
                VStack(spacing: 6) {
                    ForEach(pattern) { row in
                        HStack(spacing: 10) {
                            Text(labels[row.dow])
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.text3)
                                .frame(width: 28, alignment: .leading)
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: 3)
                                        .fill(Theme.bg3)
                                        .frame(height: 14)
                                    RoundedRectangle(cornerRadius: 3)
                                        .fill(Theme.cal)
                                        .frame(width: geo.size.width * CGFloat(row.avg / maxAvg),
                                               height: 14)
                                }
                            }
                            .frame(height: 14)
                            Text(row.count > 0 ? "\(Int(row.avg.rounded()))" : "—")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.text2)
                                .frame(width: 48, alignment: .trailing)
                        }
                    }
                }
            }
        }
    }

    private var mealTimingCard: some View {
        let timing = AnalyticsHelpers.mealTimingStats(currentRangeLog)
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Meal timing")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text2)
                timingRow(label: "First meal (avg)", value: timing.firstMeal)
                timingRow(label: "Last meal (avg)",  value: timing.lastMeal)
                if let window = timing.eatingWindowHrs {
                    Divider().background(Theme.border)
                    timingRow(label: "Eating window",
                              value: String(format: "%.1fh", window),
                              valueColor: Theme.accent)
                }
            }
        }
    }

    private func latestScanCard(_ latest: WeightPoint) -> some View {
        let isImperial = useImperial
        let factor = isImperial ? 2.20462 : 1.0
        let unit = isImperial ? "lbs" : "kg"
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Latest body scan")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text2)
                scanRow(label: "Weight",
                        value: String(format: "%.1f %@", latest.weightKg * factor, unit),
                        color: Theme.accent)
                if let bf = latest.bodyFatPct {
                    scanRow(label: "Body fat",
                            value: String(format: "%.1f%%", bf),
                            color: Theme.fat)
                }
                if let lean = latest.leanKg {
                    scanRow(label: "Lean mass",
                            value: String(format: "%.1f %@", lean * factor, unit),
                            color: Theme.protein)
                }
                Text(formatShortDate(latest.date))
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
                    .padding(.top, 2)
            }
        }
    }

    // MARK: - Computed slices

    private var currentDaily: [AnalyticsHelpers.DailyTotals] {
        AnalyticsHelpers.buildDailyWindow(state.analyticsLog, days: state.analyticsRangeDays)
    }

    private var previousDaily: [AnalyticsHelpers.DailyTotals] {
        AnalyticsHelpers.buildPreviousWindow(state.analyticsLog, days: state.analyticsRangeDays)
    }

    private var currentSummary: AnalyticsHelpers.WindowSummary {
        AnalyticsHelpers.summarize(currentDaily, goals: state.goals)
    }

    private var previousSummary: AnalyticsHelpers.WindowSummary {
        AnalyticsHelpers.summarize(previousDaily, goals: state.goals)
    }

    /// Log entries falling inside the active window. Used for the
    /// rollups that work off raw entries (dow pattern, meal timing,
    /// most-logged) rather than per-day buckets.
    private var currentRangeLog: [MealLogEntry] {
        let cal = Calendar.current
        let cutoff = cal.date(byAdding: .day, value: -state.analyticsRangeDays, to: cal.startOfDay(for: Date()))!
        return state.analyticsLog.filter { entry in
            guard let date = AnalyticsHelpers.parseTimestamp(entry.logged_at) else { return false }
            return date >= cutoff
        }
    }

    private struct WeightPoint: Hashable {
        let date: String              // YYYY-MM-DD
        let weightKg: Double
        let bodyFatPct: Double?
        let leanKg: Double?
    }

    private var weightSeries: [WeightPoint] {
        let cal = Calendar.current
        let cutoff = cal.date(byAdding: .day, value: -state.analyticsRangeDays, to: cal.startOfDay(for: Date()))!
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current

        return state.allCheckins
            .compactMap { c -> WeightPoint? in
                guard let kg = c.weight_kg else { return nil }
                let raw = c.scan_date ?? c.checked_in_at?.prefix(10).description ?? ""
                guard let d = formatter.date(from: String(raw.prefix(10))) else { return nil }
                guard d >= cutoff else { return nil }
                return WeightPoint(
                    date: String(raw.prefix(10)),
                    weightKg: kg,
                    bodyFatPct: c.body_fat_pct,
                    leanKg: c.muscle_mass_kg
                )
            }
            .sorted { $0.date < $1.date }
    }

    // MARK: - Helpers

    private var useImperial: Bool {
        // Mirrors `state.units === 'imperial'` on web. Stored in
        // UserDefaults so the user's preference survives relaunch.
        // Defaults to imperial because the existing GoalsView already
        // hardcodes lbs throughout — keep parity.
        if UserDefaults.standard.object(forKey: Self.imperialPreferenceKey) == nil {
            return true
        }
        return UserDefaults.standard.bool(forKey: Self.imperialPreferenceKey)
    }

    private func adherenceColor(_ pct: Int) -> Color {
        pct >= 70 ? Theme.protein : pct >= 40 ? Theme.accent : Theme.fat
    }

    private func badge(for kind: AnalyticsHelpers.TopItem.Kind) -> String {
        switch kind {
        case .recipe:   return "★"
        case .food:     return "■"
        case .unlinked: return ""
        }
    }

    private func badgeColor(for kind: AnalyticsHelpers.TopItem.Kind) -> Color {
        switch kind {
        case .recipe:   return Theme.protein
        case .food:     return Theme.carbs
        case .unlinked: return Theme.text3
        }
    }

    private func macroStat(label: String, value: String, sub: String?, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .tracking(0.8)
                .foregroundStyle(Theme.text3)
            Text(value)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(color)
            if let sub {
                Text(sub)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
            }
        }
    }

    private func trendHeader(title: String, trailing: String?) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.text2)
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
        }
    }

    @ViewBuilder
    private func trendChart(values: [Double],
                            dates: [String],
                            color: Color,
                            goal: Double?,
                            goalLabel: String?,
                            yFormatter: @escaping (Double) -> String) -> some View {
        if values.isEmpty || values.allSatisfy({ $0 == 0 }) {
            Text("No data yet")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
        } else {
            Chart {
                ForEach(Array(values.enumerated()), id: \.offset) { idx, v in
                    LineMark(x: .value("Day", idx), y: .value("Val", v))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(color)
                    AreaMark(x: .value("Day", idx), y: .value("Val", v))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(color.opacity(0.18))
                }
                if let goal {
                    RuleMark(y: .value("Goal", goal))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                        .foregroundStyle(Theme.text3)
                        .annotation(position: .top, alignment: .trailing) {
                            if let goalLabel {
                                Text(goalLabel)
                                    .font(.system(size: 9))
                                    .foregroundStyle(Theme.text3)
                            }
                        }
                }
            }
            .chartYScale(domain: yDomain(for: values + (goal.map { [$0] } ?? []),
                                         includeZero: true))
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 5)) { axisValue in
                    AxisGridLine().foregroundStyle(Theme.border)
                    AxisValueLabel {
                        if let i = axisValue.as(Int.self), i >= 0, i < dates.count {
                            Text(formatShortDate(dates[i]))
                                .font(.system(size: 9))
                                .foregroundStyle(Theme.text3)
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { axisValue in
                    AxisGridLine().foregroundStyle(Theme.border)
                    AxisValueLabel {
                        if let v = axisValue.as(Double.self) {
                            Text(yFormatter(v))
                                .font(.system(size: 9))
                                .foregroundStyle(Theme.text3)
                        }
                    }
                }
            }
            .frame(height: 160)
        }
    }

    private func timingRow(label: String, value: String, valueColor: Color = Theme.text) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
            Spacer()
            Text(value)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(valueColor)
        }
    }

    private func scanRow(label: String, value: String, color: Color) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
            Spacer()
            Text(value)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(color)
        }
    }

    private func yDomain(for values: [Double], includeZero: Bool) -> ClosedRange<Double> {
        guard !values.isEmpty else { return 0...1 }
        let lo = values.min() ?? 0
        let hi = values.max() ?? 1
        if includeZero {
            return 0...max(hi, 1)
        }
        let span = hi - lo
        let pad = max(span * 0.1, 1)
        return (lo - pad)...(hi + pad)
    }

    private func formatShortDate(_ ymd: String) -> String {
        guard ymd.count >= 10 else { return ymd }
        let inFmt = DateFormatter()
        inFmt.dateFormat = "yyyy-MM-dd"
        inFmt.timeZone = .current
        guard let d = inFmt.date(from: String(ymd.prefix(10))) else { return ymd }
        let outFmt = DateFormatter()
        outFmt.dateFormat = "MMM d"
        return outFmt.string(from: d)
    }
}

/// Github-style adherence heatmap. Renders cells week-by-week (column =
/// week, row = day-of-week) so the leftmost column is the oldest week.
private struct AdherenceHeatmap: View {
    let cells: [AnalyticsHelpers.HeatmapCell]

    var body: some View {
        let layout = layoutCells()
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(0..<7, id: \.self) { row in
                    HStack(spacing: 2) {
                        ForEach(0..<layout.weeks, id: \.self) { col in
                            cellView(at: row, col: col, layout: layout)
                        }
                    }
                }
            }
        }
    }

    private struct Layout {
        let cells: [AnalyticsHelpers.HeatmapCell]
        let startDow: Int             // 0 = Sunday — offset of first cell
        let weeks: Int
    }

    private func layoutCells() -> Layout {
        guard let first = cells.first else { return Layout(cells: cells, startDow: 0, weeks: 0) }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        let startDow: Int = {
            guard let d = formatter.date(from: first.date) else { return 0 }
            return Calendar.current.component(.weekday, from: d) - 1   // 1=Sun → 0
        }()
        let total = startDow + cells.count
        let weeks = Int((Double(total) / 7).rounded(.up))
        return Layout(cells: cells, startDow: startDow, weeks: weeks)
    }

    private func cellView(at row: Int, col: Int, layout: Layout) -> some View {
        let cellIndex = col * 7 + row
        let logicalIndex = cellIndex - layout.startDow
        let cell: AnalyticsHelpers.HeatmapCell? =
            (logicalIndex >= 0 && logicalIndex < layout.cells.count) ? layout.cells[logicalIndex] : nil
        return RoundedRectangle(cornerRadius: 2)
            .fill(color(for: cell?.status))
            .frame(width: 12, height: 12)
    }

    private func color(for status: AnalyticsHelpers.HeatmapCell.Status?) -> Color {
        switch status {
        case .good:  return Theme.protein
        case .ok:    return Theme.protein.opacity(0.4)
        case .off:   return Color(hex: 0xE06E6E, opacity: 0.35)
        case .empty: return Theme.bg3
        case .none:  return Color.clear
        }
    }
}
