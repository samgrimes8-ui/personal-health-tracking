import SwiftUI

/// 7-day stacked grid (Sunday → Saturday). Renders the weekly overview
/// bar at the top + one day card per slot. Hands the add/edit/move
/// callbacks through to `PlannerDayCard`.
struct PlannerWeekGrid: View {
    @Environment(AppState.self) private var state
    let weekStart: String
    let onAddMeal: (Int, PlannerMealSlot) -> Void
    let onEditMeal: (PlannerRow) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            weeklyOverview
            ForEach(0..<7, id: \.self) { idx in
                PlannerDayCard(
                    dayIndex: idx,
                    dateString: PlannerDateMath.addDays(weekStart, idx),
                    onAddMeal: { slot in onAddMeal(idx, slot) },
                    onEditMeal: onEditMeal
                )
            }
        }
    }

    // MARK: - Weekly overview bar

    private var weeklyOverview: some View {
        let goalCal = max(1, state.goals.calories ?? 2000)
        let weekCals: [Int] = (0..<7).map { i in
            guard i < state.plannerByDay.count else { return 0 }
            return Int(state.plannerByDay[i].reduce(0.0) { $0 + ($1.calories ?? 0) }.rounded())
        }
        return Card(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                Text("WEEKLY OVERVIEW")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.0)
                    .foregroundStyle(Theme.text3)
                HStack(alignment: .bottom, spacing: 4) {
                    ForEach(0..<7, id: \.self) { idx in
                        overviewColumn(idx: idx, cal: weekCals[idx], goal: goalCal)
                    }
                }
            }
        }
    }

    private func overviewColumn(idx: Int, cal: Int, goal: Int) -> some View {
        let pct = min(100, Int(Double(cal) / Double(goal) * 100))
        let color: Color = pct > 110 ? Theme.red : pct > 90 ? Theme.protein : Theme.accent
        let dateStr = PlannerDateMath.addDays(weekStart, idx)
        let isToday = dateStr == PlannerDateMath.todayString()
        let dayShort = PlannerDateMath.dayName(idx).prefix(3)
        return VStack(spacing: 4) {
            Text(String(dayShort).uppercased())
                .font(.system(size: 9, weight: isToday ? .heavy : .regular))
                .foregroundStyle(isToday ? Theme.accent : Theme.text3)
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Theme.bg3)
                    .frame(height: 40)
                if cal > 0 {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(color)
                        .frame(height: max(3, CGFloat(pct) * 0.4))
                }
            }
            Text(cal > 0 ? "\(cal)" : "—")
                .font(.system(size: 9))
                .foregroundStyle(cal > 0 ? Theme.text2 : Theme.text3)
        }
        .frame(maxWidth: .infinity)
    }
}
