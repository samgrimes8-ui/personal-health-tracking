import SwiftUI

/// One day's card inside the week grid: header + four meal-type slots.
/// Hosts the per-meal `.draggable` and the day-level `.dropDestination`
/// that rewrites a meal's actual_date when something is dropped.
struct PlannerDayCard: View {
    @Environment(AppState.self) private var state
    let dayIndex: Int                 // 0 = Sunday … 6 = Saturday
    let dateString: String            // YYYY-MM-DD for this slot
    let onAddMeal: (PlannerMealSlot) -> Void
    let onEditMeal: (PlannerRow) -> Void

    @State private var isTargeted = false
    @State private var moveErr: String?

    private var dayMeals: [PlannerRow] {
        guard dayIndex >= 0, dayIndex < state.plannerByDay.count else { return [] }
        return state.plannerByDay[dayIndex]
    }

    private var dayCalories: Int {
        Int(dayMeals.reduce(0.0) { $0 + ($1.calories ?? 0) }.rounded())
    }

    private var isToday: Bool { dateString == PlannerDateMath.todayString() }
    private var isPast: Bool { dateString < PlannerDateMath.todayString() && !isToday }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            slotsList
        }
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(borderColor, lineWidth: isTargeted ? 2 : 1)
        )
        .opacity(isPast ? 0.75 : 1.0)
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first else { return false }
            Task { await moveMeal(id: id) }
            return true
        } isTargeted: { hovering in
            withAnimation(.easeOut(duration: 0.15)) { isTargeted = hovering }
        }
        .alert("Couldn't move meal", isPresented: Binding(
            get: { moveErr != nil },
            set: { if !$0 { moveErr = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(moveErr ?? "") }
    }

    // MARK: - Subviews

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            HStack(spacing: 8) {
                Text(PlannerDateMath.dayName(dayIndex))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(isToday ? Theme.accent : Theme.text)
                if isToday {
                    Text("TODAY")
                        .font(.system(size: 9, weight: .heavy))
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Theme.accent, in: .rect(cornerRadius: 4))
                        .foregroundStyle(Theme.accentFG)
                }
                Text(PlannerDateMath.shortMonthDay(dateString))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
            Spacer()
            Text(dayCalories > 0 ? "\(dayCalories) kcal" : "Empty")
                .font(.system(size: 12))
                .foregroundStyle(dayCalories > 0 ? Theme.text2 : Theme.text3)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(isToday ? Theme.accent.opacity(0.06) : Theme.bg3)
    }

    private var slotsList: some View {
        VStack(spacing: 6) {
            ForEach(PlannerMealSlot.allCases) { slot in
                slotSection(slot)
            }
        }
        .padding(8)
    }

    private func slotSection(_ slot: PlannerMealSlot) -> some View {
        let meals = dayMeals.filter { PlannerMealSlot.from($0.meal_type) == slot }
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                HStack(spacing: 5) {
                    Image(systemName: slot.icon)
                        .font(.system(size: 10, weight: .semibold))
                    Text(slot.label.uppercased())
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.5)
                }
                .foregroundStyle(slot.color)
                Spacer()
                Button {
                    onAddMeal(slot)
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.text3)
                        .padding(.horizontal, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add \(slot.label)")
            }
            if meals.isEmpty {
                emptySlot(slot)
            } else {
                ForEach(meals) { meal in
                    mealRow(meal)
                }
            }
        }
    }

    private func emptySlot(_ slot: PlannerMealSlot) -> some View {
        Button { onAddMeal(slot) } label: {
            Text("+ Add \(slot.label.lowercased())")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [3]))
                )
        }
        .buttonStyle(.plain)
    }

    private func mealRow(_ meal: PlannerRow) -> some View {
        HStack(alignment: .center, spacing: 6) {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
                .frame(width: 18, height: 22)
                .contentShape(Rectangle())
                .accessibilityLabel("Drag handle")
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    if meal.is_leftover == true {
                        Text("Leftover")
                            .font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(Theme.carbs.opacity(0.15), in: .rect(cornerRadius: 3))
                            .foregroundStyle(Theme.carbs)
                    }
                    Text(meal.meal_name ?? "—")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                }
                Text(macroLine(meal))
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Button {
                Task { await deleteMeal(meal) }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.text3)
                    .padding(4)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Delete planned meal")
        }
        .padding(.horizontal, 8).padding(.vertical, 7)
        .background(Theme.bg3, in: .rect(cornerRadius: 8))
        .contentShape(Rectangle())
        .onTapGesture { onEditMeal(meal) }
        .draggable(meal.id) {
            // Drag preview — small chip with name only.
            HStack(spacing: 6) {
                Image(systemName: "line.3.horizontal")
                    .foregroundStyle(Theme.text3)
                Text(meal.meal_name ?? "Meal")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.text)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Theme.bg2, in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
        }
    }

    // MARK: - Actions

    private func moveMeal(id: String) async {
        guard let meal = findMeal(id: id) else { return }
        // Skip if already on this day.
        if meal.actual_date == dateString { return }
        do {
            try await DBService.movePlannerEntry(id: id, to: dateString)
            // Refresh the visible week so the row re-buckets.
            if let weekStart = state.plannerWeekStart {
                await state.plannerLoadImpl(weekStart: weekStart)
            }
        } catch {
            moveErr = error.localizedDescription
        }
    }

    private func deleteMeal(_ meal: PlannerRow) async {
        do {
            try await DBService.deletePlannerEntry(id: meal.id)
            if let weekStart = state.plannerWeekStart {
                await state.plannerLoadImpl(weekStart: weekStart)
            }
        } catch {
            moveErr = error.localizedDescription
        }
    }

    private func findMeal(id: String) -> PlannerRow? {
        for day in state.plannerByDay {
            if let m = day.first(where: { $0.id == id }) { return m }
        }
        return nil
    }

    private func macroLine(_ m: PlannerRow) -> String {
        let cal = Int((m.calories ?? 0).rounded())
        let p = Int((m.protein ?? 0).rounded())
        let c = Int((m.carbs ?? 0).rounded())
        let f = Int((m.fat ?? 0).rounded())
        return "\(cal) kcal · P\(p)g C\(c)g F\(f)g"
    }

    private var borderColor: Color {
        if isTargeted { return Theme.accent }
        if isToday { return Theme.accent.opacity(0.4) }
        return Theme.border
    }
}
