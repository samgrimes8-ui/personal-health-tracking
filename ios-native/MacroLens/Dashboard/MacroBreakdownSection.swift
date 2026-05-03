import SwiftUI
import Charts

/// Two-column card on the web dashboard:
///   1. Macro breakdown today — donut by macro, kcal in the center
///   2. Goal progress — horizontal bars (cal / protein / carbs / fat)
///      with colored fills capped at 100% display, actual % in the label
///
/// Renders side-by-side on iPad, stacked on iPhone (we use a single
/// VStack — it's cheap and matches how the dashboard already breathes
/// on small screens).
struct MacroBreakdownSection: View {
    @Environment(AppState.self) private var state
    @State private var showFullLabel: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionTitle("Macro breakdown today")
            HStack(alignment: .top, spacing: 16) {
                donut
                legend
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bg2, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))

            sectionTitle("Goal progress")
            VStack(spacing: 10) {
                progressBar(label: "Calories", value: totals.calories, goal: state.goals.calories.map(Double.init), color: Theme.cal, unit: "kcal")
                progressBar(label: "Protein",  value: totals.protein,  goal: state.goals.protein.map(Double.init),  color: Theme.protein, unit: "g")
                progressBar(label: "Carbs",    value: totals.carbs,    goal: state.goals.carbs.map(Double.init),    color: Theme.carbs,   unit: "g")
                progressBar(label: "Fat",      value: totals.fat,      goal: state.goals.fat.map(Double.init),      color: Theme.fat,     unit: "g")
            }
            .padding(16)
            .background(Theme.bg2, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))

            if state.goals.track_full_label == true {
                fullLabelCard
            }
        }
    }

    // MARK: - Full nutrition (opt-in)

    /// Expandable card showing today's micros — sodium, fiber, sugars,
    /// saturated/trans fat, cholesterol, and key vitamins/minerals. Only
    /// rendered when the Account toggle is on. Each row shows the sum
    /// across logged meals + a "X / Y meals tracked" line so the user
    /// can tell when the AI didn't know the value (vs. the food contained
    /// none of it).
    private var fullLabelCard: some View {
        let f = fullLabel
        let mealCount = state.todayLog.count
        return VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { showFullLabel.toggle() }
            } label: {
                HStack {
                    sectionTitle("Full nutrition today")
                    Spacer()
                    Text(showFullLabel ? "Hide" : "More")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.accent)
                    Image(systemName: showFullLabel ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                }
            }
            .buttonStyle(.plain)
            if showFullLabel {
                VStack(spacing: 6) {
                    microRow("Sodium",        f.sodium,       unit: "mg",  total: mealCount, target: state.goals.sodium_mg_max,        targetIsMax: true)
                    microRow("Fiber",         f.fiber,        unit: "g",   total: mealCount, target: state.goals.fiber_g_min,          targetIsMax: false)
                    microRow("Saturated fat", f.saturatedFat, unit: "g",   total: mealCount, target: state.goals.saturated_fat_g_max,  targetIsMax: true)
                    microRow("Added sugar",   f.sugarAdded,   unit: "g",   total: mealCount, target: state.goals.sugar_added_g_max,    targetIsMax: true)
                    microRow("Total sugar",   f.sugarTotal,   unit: "g",   total: mealCount)
                    microRow("Trans fat",     f.transFat,     unit: "g",   total: mealCount)
                    microRow("Cholesterol",   f.cholesterol,  unit: "mg",  total: mealCount)
                    microRow("Potassium",     f.potassium,    unit: "mg",  total: mealCount)
                    microRow("Calcium",       f.calcium,      unit: "mg",  total: mealCount)
                    microRow("Iron",          f.iron,         unit: "mg",  total: mealCount)
                    microRow("Vitamin A",     f.vitaminA,     unit: "mcg", total: mealCount)
                    microRow("Vitamin C",     f.vitaminC,     unit: "mg",  total: mealCount)
                    microRow("Vitamin D",     f.vitaminD,     unit: "mcg", total: mealCount)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
    }

    private func microRow(_ label: String,
                          _ field: (sum: Double, count: Int),
                          unit: String,
                          total: Int,
                          target: Double? = nil,
                          targetIsMax: Bool = true) -> some View {
        let trackedNote: String = {
            if total == 0 { return "no meals" }
            if field.count == 0 { return "not tracked" }
            return "\(field.count)/\(total) tracked"
        }()
        let valueText: String = field.count == 0 ? "—"
            : (field.sum < 10 ? String(format: "%.1f \(unit)", field.sum)
                              : "\(Int(field.sum.rounded())) \(unit)")
        let targetText: String? = target.map {
            "\(targetIsMax ? "max" : "min") \($0 < 10 ? String(format: "%g", $0) : String(Int($0))) \(unit)"
        }
        let valueColor: Color = {
            guard field.count > 0, let target else { return Theme.text }
            if targetIsMax { return field.sum > target ? Theme.red : Theme.text }
            return field.sum < target ? Theme.fat : Theme.text
        }()
        return HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.text2)
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text(valueText)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(valueColor)
                HStack(spacing: 6) {
                    if let targetText {
                        Text(targetText)
                            .font(.system(size: 10))
                            .foregroundStyle(Theme.text3)
                    }
                    Text(trackedNote)
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.text3)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.bg3, in: .rect(cornerRadius: 8))
    }

    private var fullLabel: DailyFullLabelTotals { DailyFullLabelTotals.sum(state.todayLog) }

    // MARK: - Donut

    /// Per-macro caloric contribution (4/4/9 rule). Mirrors the web
    /// donut which slices by macro-derived kcal, not raw grams, so the
    /// proportions reflect actual energy share.
    private var donutSlices: [(label: String, kcal: Double, color: Color)] {
        let p = totals.protein * 4
        let c = totals.carbs * 4
        let f = totals.fat * 9
        return [
            ("Protein", p, Theme.protein),
            ("Carbs",   c, Theme.carbs),
            ("Fat",     f, Theme.fat),
        ]
    }

    private var donut: some View {
        let slices = donutSlices
        let totalKcal = slices.reduce(0) { $0 + $1.kcal }
        return Chart {
            // Background ring so an empty day still shows a faint donut
            // shape rather than a blank square.
            if totalKcal == 0 {
                SectorMark(angle: .value("Empty", 1), innerRadius: .ratio(0.62))
                    .foregroundStyle(Theme.bg4)
            }
            ForEach(slices, id: \.label) { slice in
                SectorMark(angle: .value(slice.label, slice.kcal),
                           innerRadius: .ratio(0.62),
                           angularInset: 1.5)
                    .cornerRadius(2)
                    .foregroundStyle(slice.color)
            }
        }
        .chartLegend(.hidden)
        .chartBackground { _ in
            VStack(spacing: 0) {
                Text("\(Int(totals.calories))")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text("kcal")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
            }
        }
        .frame(width: 120, height: 120)
    }

    private var legend: some View {
        let slices = donutSlices
        let totalKcal = slices.reduce(0) { $0 + $1.kcal }
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(slices, id: \.label) { slice in
                let pct = totalKcal == 0 ? 0 : Int((slice.kcal / totalKcal * 100).rounded())
                HStack(spacing: 8) {
                    Circle().fill(slice.color).frame(width: 10, height: 10)
                    Text(slice.label)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text2)
                    Spacer()
                    Text("\(pct)%")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.text)
                }
            }
        }
    }

    // MARK: - Goal progress bars

    private func progressBar(label: String, value: Double, goal: Double?, color: Color, unit: String) -> some View {
        let g = goal ?? 0
        let pct = g > 0 ? value / g : 0
        let displayPct = min(pct, 1.0)
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text2)
                Spacer()
                Text(g > 0
                     ? "\(Int(value)) / \(Int(g)) \(unit)"
                     : "\(Int(value)) \(unit)")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.text)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Theme.bg4)
                    Rectangle()
                        .fill(color)
                        .frame(width: geo.size.width * displayPct)
                }
            }
            .frame(height: 8)
            .clipShape(.rect(cornerRadius: 4))
        }
    }

    // MARK: -

    private var totals: DailyMacroTotals { DailyMacroTotals.sum(state.todayLog) }

    private func sectionTitle(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 13, weight: .medium))
            .tracking(1.0)
            .textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }
}
