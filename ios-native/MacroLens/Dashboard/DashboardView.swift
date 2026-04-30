import SwiftUI

/// Native dashboard. v1 ships with the two highest-signal sections —
/// Daily macro counts and Today's meals. Quick log, Analyze food, charts
/// and the analytics widget come in subsequent passes; layout matches the
/// post-reorder web dashboard so users see the same flow.
struct DashboardView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(AppState.self) private var state

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                greeting
                AnalyzeFoodSection()
                QuickLogSection()
                macroCountsRow
                todayMealsCard
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await state.loadDashboard() }
        .task { await state.loadDashboard() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Sign out") { Task { await auth.signOut() } }
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text3)
            }
        }
        .navigationTitle("MacroLens")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Sections

    private var greeting: some View {
        let h = Calendar.current.component(.hour, from: Date())
        let salutation = h < 12 ? "Good morning." : h < 17 ? "Good afternoon." : "Good evening."
        return VStack(alignment: .leading, spacing: 4) {
            Text(salutation)
                .font(.system(size: 26, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
            Text("Log your meals and track your macros.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text3)
        }
        .padding(.top, 12)
    }

    private var macroCountsRow: some View {
        let totals = DailyMacroTotals.sum(state.todayLog)
        return VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Daily macro counts")
            HStack(spacing: 10) {
                macroTile(label: "Calories", value: Int(totals.calories), unit: "kcal", goal: state.goals.calories, color: Theme.cal)
                macroTile(label: "Protein", value: Int(totals.protein), unit: "g", goal: state.goals.protein, color: Theme.protein)
                macroTile(label: "Carbs", value: Int(totals.carbs), unit: "g", goal: state.goals.carbs, color: Theme.carbs)
                macroTile(label: "Fat", value: Int(totals.fat), unit: "g", goal: state.goals.fat, color: Theme.fat)
            }
        }
    }

    private var todayMealsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Today's meals")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.text)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.vertical, 16)

            Divider().background(Theme.border)

            if state.todayLog.isEmpty {
                Text("No entries yet. Analyze a meal to get started.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            } else {
                ForEach(state.todayLog) { entry in
                    mealRow(entry)
                    Divider().background(Theme.border).padding(.leading, 20)
                }
            }
        }
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
    }

    // MARK: - Helpers

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 13, weight: .medium))
            .tracking(1.0)
            .textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    private func macroTile(label: String, value: Int, unit: String, goal: Int?, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .tracking(1.0)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            Text("\(value)\(unit == "g" ? "g" : "")")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(color)
            if let goal {
                Text("of \(goal)\(unit == "g" ? "g" : "") \(unit == "kcal" ? "kcal" : "")")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            } else {
                Text("Set a goal")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private func mealRow(_ entry: MealLogEntry) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.meal_name ?? "—")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.text)
                if let mealType = entry.meal_type {
                    Text(mealType.capitalized)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(Int(entry.calories ?? 0)) kcal")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.cal)
                Text("\(Int(entry.protein ?? 0))P · \(Int(entry.carbs ?? 0))C · \(Int(entry.fat ?? 0))F")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
    }

}
