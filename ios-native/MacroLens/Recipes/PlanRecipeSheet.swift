import SwiftUI

/// Plan-from-recipe sheet. Mirrors `renderPlanRecipeModal` + `confirmPlanRecipe`
/// in src/pages/app.js: a 4-week day grid (multi-select), servings-to-make,
/// meal-type buttons, and an "Add to plan" CTA that fans out one
/// `savePlannerEntry` per selected date.
///
/// Cook-once semantics match the web exactly: when the user picks more than
/// one day, the first chronological day inserts as the chosen meal type with
/// `is_leftover = false`, and every subsequent day inserts as `lunch` with
/// `is_leftover = true`. The grocery-list aggregator (web side) treats
/// leftovers as "cooked once already, no shopping needed", so multi-day
/// selection produces exactly the meal-prep behavior users expect.
struct PlanRecipeSheet: View {
    let recipe: RecipeFull
    let onPlanned: () -> Void

    @Environment(\.dismiss) private var dismiss

    /// Selected dates in `YYYY-MM-DD` form. Order is the order the user
    /// tapped them in; we sort chronologically before saving so leftovers
    /// land on the correct days regardless of tap order.
    @State private var selected: [String] = []
    @State private var slot: PlannerMealSlot = .dinner
    @State private var plannedServings: Double
    @State private var cookOnceOpen: Bool = false
    @State private var saving = false
    @State private var saveError: String?

    init(recipe: RecipeFull, onPlanned: @escaping () -> Void) {
        self.recipe = recipe
        self.onPlanned = onPlanned
        _plannedServings = State(initialValue: recipe.servings ?? 4)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    headerBlock
                    daysGridLabel
                    weekdayHeader
                    daysGrid
                    if selected.count > 1 {
                        cookOnceBlock
                    }
                    selectedSummary
                    servingsBlock
                    mealTypeBlock
                    if let err = saveError {
                        Text(err).font(.system(size: 12)).foregroundStyle(Theme.red)
                    }
                    addButton
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 28)
                .padding(.top, 12)
            }
            .background(Theme.bg)
            .navigationTitle("Add to meal plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    // MARK: - Sections

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(recipe.name)
                .font(.system(size: 18, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
            Text("Pick day(s) you want to eat this. Picking multiple days enables cook-once meal prep.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
        }
    }

    private var daysGridLabel: some View {
        Text("Pick day(s) to eat this")
            .font(.system(size: 11, weight: .medium))
            .tracking(1.0).textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    private var weekdayHeader: some View {
        let labels = ["S", "M", "T", "W", "T", "F", "S"]
        return HStack(spacing: 4) {
            ForEach(labels, id: \.self) { l in
                Text(l)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private var daysGrid: some View {
        let days = upcoming28Days()
        let leadingBlanks = leadingBlanks(for: days.first?.date ?? Date())
        let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)
        return LazyVGrid(columns: columns, spacing: 4) {
            ForEach(0..<leadingBlanks, id: \.self) { _ in
                Color.clear.frame(height: 36)
            }
            ForEach(days, id: \.dateStr) { d in
                dayCell(d)
            }
        }
    }

    private func dayCell(_ d: DayItem) -> some View {
        let isSelected = selected.contains(d.dateStr)
        let selectionIdx = selected.sorted().firstIndex(of: d.dateStr)
        return Button {
            toggleDay(d.dateStr)
        } label: {
            ZStack(alignment: .topLeading) {
                Text("\(d.dayNum)")
                    .font(.system(size: 13, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? Theme.accentFG : (d.isToday ? Theme.accent : Theme.text2))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                if d.isFirstOfMonth {
                    Text(d.month)
                        .font(.system(size: 8))
                        .foregroundStyle(Theme.text3)
                        .padding(.leading, 3).padding(.top, 2)
                }

                // Order number when multi-selected
                if let idx = selectionIdx, selected.count > 1 {
                    Text("\(idx + 1)")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(Theme.accentFG)
                        .frame(width: 12, height: 12)
                        .background(Theme.accent2, in: .circle)
                        .offset(x: 22, y: -4)
                }
            }
            .frame(height: 36)
            .frame(maxWidth: .infinity)
            .background(
                isSelected ? Theme.accent
                : d.isToday ? Theme.accent.opacity(0.12)
                : Theme.bg3,
                in: .rect(cornerRadius: 6)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(d.isToday && !isSelected ? Theme.accent : Theme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var cookOnceBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation { cookOnceOpen.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: cookOnceOpen ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10))
                    Text("🍳 Cook once, eat on multiple days")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(Theme.text3)
            }
            .buttonStyle(.plain)
            if cookOnceOpen {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Multi-day picks are auto-treated as meal prep. We cook the recipe on the first day, and the other days show as leftovers — they don't pile onto your grocery list.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text2)
                    if let primary = sortedSelected().first {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("First cooking day").font(.system(size: 11)).foregroundStyle(Theme.text3)
                            Text(prettyDate(primary))
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Theme.accent)
                        }
                    }
                }
                .padding(12)
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
            }
        }
    }

    @ViewBuilder
    private var selectedSummary: some View {
        if selected.isEmpty {
            Text("Tap a day above to start.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
        } else {
            let count = selected.count
            Text("\(count) day\(count == 1 ? "" : "s") selected")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
        }
    }

    private var servingsBlock: some View {
        HStack(spacing: 10) {
            Text("Servings to make:")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text2)
            TextField("4", value: $plannedServings, format: .number)
                .keyboardType(.decimalPad)
                .frame(width: 70)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(Theme.bg3, in: .rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border2, lineWidth: 1))
                .multilineTextAlignment(.center)
            Text("(base recipe: \(formatServings(recipe.servings ?? 4)))")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
            Spacer()
        }
        .padding(10)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
    }

    private var mealTypeBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Which meal?")
                .font(.system(size: 11, weight: .medium))
                .tracking(1.0).textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            HStack(spacing: 6) {
                ForEach(PlannerMealSlot.allCases) { s in
                    Button { slot = s } label: {
                        VStack(spacing: 2) {
                            Image(systemName: s.icon).font(.system(size: 14))
                            Text(s.label).font(.system(size: 11, weight: .semibold))
                        }
                        .foregroundStyle(slot == s ? Theme.accent : Theme.text3)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(slot == s ? Theme.accent.opacity(0.15) : Theme.bg3, in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(slot == s ? Theme.accent : Theme.border2, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            if selected.count > 1 {
                Text("Subsequent days save as leftover lunches.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
        }
    }

    private var addButton: some View {
        Button {
            Task { await save() }
        } label: {
            HStack {
                if saving { ProgressView().controlSize(.small).tint(Theme.accentFG) }
                Text(saving ? "Adding..." : "Add to plan")
                    .font(.system(size: 15, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .foregroundStyle(Theme.accentFG)
            .background(canSave ? Theme.accent : Theme.bg4, in: .rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(!canSave)
        .padding(.top, 6)
    }

    private var canSave: Bool { !selected.isEmpty && !saving }

    // MARK: - Behavior

    private func toggleDay(_ dateStr: String) {
        if let idx = selected.firstIndex(of: dateStr) {
            selected.remove(at: idx)
        } else {
            selected.append(dateStr)
        }
    }

    private func sortedSelected() -> [String] {
        selected.sorted()
    }

    private func save() async {
        let dates = sortedSelected()
        guard !dates.isEmpty else { return }
        saving = true
        saveError = nil
        defer { saving = false }
        let baseServ = recipe.servings ?? 1
        let scale = baseServ > 0 ? plannedServings / baseServ : 1
        do {
            for (i, dateStr) in dates.enumerated() {
                let isLeftover = (i > 0 && dates.count > 1)
                let mealType = isLeftover ? "lunch" : slot.rawValue
                let dayIdx = dayIndex(of: dateStr)
                let weekStart = weekStartOf(dateStr)
                let entry = PlannerInsert(
                    id: nil,
                    weekStart: weekStart,
                    dayIdx: dayIdx,
                    mealName: recipe.name,
                    mealType: mealType,
                    calories: (recipe.calories ?? 0) * scale,
                    protein: (recipe.protein ?? 0) * scale,
                    carbs: (recipe.carbs ?? 0) * scale,
                    fat: (recipe.fat ?? 0) * scale,
                    fiber: (recipe.fiber ?? 0) * scale,
                    isLeftover: isLeftover,
                    plannedServings: plannedServings,
                    recipeId: recipe.id
                )
                _ = try await DBService.savePlannerEntry(entry)
            }
            onPlanned()
            dismiss()
        } catch {
            saveError = error.localizedDescription
        }
    }

    // MARK: - Date helpers

    /// Index 0…6 of `dateStr` within its week (Sunday-anchored to match the
    /// rest of the planner code).
    private func dayIndex(of dateStr: String) -> Int {
        guard let date = PlannerDateMath.parse(dateStr) else { return 0 }
        return PlannerDateMath.calendar.component(.weekday, from: date) - 1
    }

    private func weekStartOf(_ dateStr: String) -> String {
        PlannerDateMath.snapToSunday(dateStr) ?? dateStr
    }

    private func leadingBlanks(for first: Date) -> Int {
        PlannerDateMath.calendar.component(.weekday, from: first) - 1
    }

    private func upcoming28Days() -> [DayItem] {
        let cal = PlannerDateMath.calendar
        let today = cal.startOfDay(for: Date())
        var out: [DayItem] = []
        let monthFmt: DateFormatter = {
            let f = DateFormatter()
            f.calendar = cal
            f.timeZone = .current
            f.setLocalizedDateFormatFromTemplate("MMM")
            return f
        }()
        for i in 0..<28 {
            guard let d = cal.date(byAdding: .day, value: i, to: today) else { continue }
            let comps = cal.dateComponents([.day], from: d)
            let dayNum = comps.day ?? 1
            let isFirstOfMonth = (dayNum == 1) || (i == 0)
            let dateStr = PlannerDateMath.format(d)
            out.append(DayItem(
                date: d,
                dateStr: dateStr,
                dayNum: dayNum,
                month: monthFmt.string(from: d),
                isToday: i == 0,
                isFirstOfMonth: isFirstOfMonth
            ))
        }
        return out
    }

    private func prettyDate(_ dateStr: String) -> String {
        guard let d = PlannerDateMath.parse(dateStr) else { return dateStr }
        let f = DateFormatter()
        f.calendar = PlannerDateMath.calendar
        f.timeZone = .current
        f.setLocalizedDateFormatFromTemplate("EEE MMM d")
        return f.string(from: d)
    }

    private func formatServings(_ v: Double) -> String {
        if v.truncatingRemainder(dividingBy: 1) == 0 { return String(Int(v)) }
        return String(format: "%g", (v * 10).rounded() / 10)
    }
}

private struct DayItem {
    let date: Date
    let dateStr: String
    let dayNum: Int
    let month: String
    let isToday: Bool
    let isFirstOfMonth: Bool
}
