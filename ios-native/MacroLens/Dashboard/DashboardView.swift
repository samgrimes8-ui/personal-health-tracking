import SwiftUI

/// Native dashboard. v1 ships with the two highest-signal sections —
/// Daily macro counts and Today's meals. Quick log, Analyze food, charts
/// and the analytics widget come in subsequent passes; layout matches the
/// post-reorder web dashboard so users see the same flow.
struct DashboardView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(AppState.self) private var state
    @State private var editingEntry: MealLogEntry?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                greeting
                AnalyzeFoodSection()
                QuickLogSection()
                macroCountsRow
                todayMealsCard
                MacroBreakdownSection()
                AnalyticsSection()
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        // Tap-outside-to-dismiss for the Quick Log search and Analyze
        // describe-food fields. Bare tap registers on empty space only,
        // so it doesn't fight TextField/TextEditor for hits inside them
        // — and it pairs with the keyboard's "Done" button so users
        // always have an obvious way out of the input.
        .onTapGesture {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder),
                to: nil, from: nil, for: nil
            )
        }
        .refreshable { await state.loadDashboard() }
        .task { await state.loadDashboard() }
        .sheet(item: $editingEntry) { entry in
            EditMealSheet(entry: entry)
                .environment(state)
        }
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
        Button {
            editingEntry = entry
        } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.name ?? "—")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.text)
                        .multilineTextAlignment(.leading)
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
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

}

/// Sheet for editing a single meal_log row. Mirrors the web edit
/// modal in src/pages/app.js (openEditModal/saveEditEntry): name,
/// meal type, servings (auto-rescales macros from per-serving base),
/// kcal/P/C/F/Fiber overrides, and a Delete button. Per-serving
/// "base" macros aren't stored on iOS yet, so we derive them on
/// open as `current / servings_consumed` (same fallback the web
/// uses when base_* columns are missing).
private struct EditMealSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    let entry: MealLogEntry

    @State private var name: String
    @State private var mealType: String
    @State private var servings: Double
    @State private var calories: Double
    @State private var protein: Double
    @State private var carbs: Double
    @State private var fat: Double
    @State private var fiber: Double
    @State private var saving = false
    @State private var deleting = false
    @State private var errorMessage: String?
    @State private var showingDeleteConfirm = false

    private let baseCalories: Double
    private let baseProtein: Double
    private let baseCarbs: Double
    private let baseFat: Double
    private let baseFiber: Double

    private static let mealTypes = ["breakfast", "lunch", "snack", "dinner"]

    init(entry: MealLogEntry) {
        self.entry = entry
        let consumed = max(0.001, entry.servings_consumed ?? 1)
        self.baseCalories = (entry.calories ?? 0) / consumed
        self.baseProtein  = (entry.protein  ?? 0) / consumed
        self.baseCarbs    = (entry.carbs    ?? 0) / consumed
        self.baseFat      = (entry.fat      ?? 0) / consumed
        self.baseFiber    = (entry.fiber    ?? 0) / consumed
        _name = State(initialValue: entry.name ?? "")
        _mealType = State(initialValue: entry.meal_type?.lowercased() ?? Self.inferMealType(entry.logged_at))
        _servings = State(initialValue: consumed)
        _calories = State(initialValue: entry.calories ?? 0)
        _protein  = State(initialValue: entry.protein  ?? 0)
        _carbs    = State(initialValue: entry.carbs    ?? 0)
        _fat      = State(initialValue: entry.fat      ?? 0)
        _fiber    = State(initialValue: entry.fiber    ?? 0)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Meal name", text: $name)
                        .autocorrectionDisabled()
                }

                Section("Meal type") {
                    Picker("Type", selection: $mealType) {
                        ForEach(Self.mealTypes, id: \.self) { t in
                            Text(t.capitalized).tag(t)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section("Servings") {
                    HStack {
                        Text("Consumed")
                        Spacer()
                        TextField("1.0", value: $servings, format: .number.precision(.fractionLength(0...2)))
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 90)
                            .onChange(of: servings) { _, new in
                                let s = max(0, new)
                                calories = (baseCalories * s).rounded(toPlaces: 1)
                                protein  = (baseProtein  * s).rounded(toPlaces: 1)
                                carbs    = (baseCarbs    * s).rounded(toPlaces: 1)
                                fat      = (baseFat      * s).rounded(toPlaces: 1)
                                fiber    = (baseFiber    * s).rounded(toPlaces: 1)
                            }
                    }
                }

                Section("Macros") {
                    macroField("Calories", value: $calories, suffix: "kcal")
                    macroField("Protein",  value: $protein,  suffix: "g")
                    macroField("Carbs",    value: $carbs,    suffix: "g")
                    macroField("Fat",      value: $fat,      suffix: "g")
                    macroField("Fiber",    value: $fiber,    suffix: "g")
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red).font(.system(size: 13)) }
                }

                Section {
                    Button(role: .destructive) {
                        showingDeleteConfirm = true
                    } label: {
                        HStack {
                            Spacer()
                            if deleting { ProgressView() }
                            else { Text("Delete entry") }
                            Spacer()
                        }
                    }
                    .disabled(saving || deleting)
                }
            }
            .navigationTitle("Edit meal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving || deleting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(saving || deleting || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .confirmationDialog("Delete this entry?",
                                isPresented: $showingDeleteConfirm,
                                titleVisibility: .visible) {
                Button("Delete", role: .destructive) { Task { await delete() } }
                Button("Cancel", role: .cancel) { }
            }
        }
    }

    private func macroField(_ label: String, value: Binding<Double>, suffix: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("0", value: value, format: .number.precision(.fractionLength(0...1)))
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
            Text(suffix).foregroundStyle(Theme.text3).font(.system(size: 13))
        }
    }

    private func save() async {
        saving = true
        errorMessage = nil
        defer { saving = false }
        let patch = MealEntryPatch(
            name: name.trimmingCharacters(in: .whitespaces),
            mealType: mealType,
            calories: calories,
            protein: protein,
            carbs: carbs,
            fat: fat,
            fiber: fiber,
            servingsConsumed: servings
        )
        do {
            try await state.updateMealLogEntry(id: entry.id, patch)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete() async {
        deleting = true
        errorMessage = nil
        defer { deleting = false }
        do {
            try await state.deleteMealLogEntry(id: entry.id)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Same buckets as web's getMealTypeFromTime() — Breakfast 5–10am,
    /// Lunch 10am–2pm, Snack 2–5pm, Dinner 5–10pm (everything else
    /// falls into snack as a sane default).
    private static func inferMealType(_ iso: String?) -> String {
        guard let iso else { return "snack" }
        let date: Date? = ISO8601DateFormatter().date(from: iso)
            ?? {
                let f = DateFormatter()
                f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
                return f.date(from: iso)
            }()
        guard let d = date else { return "snack" }
        let h = Calendar.current.component(.hour, from: d)
        switch h {
        case 5..<10:  return "breakfast"
        case 10..<14: return "lunch"
        case 14..<17: return "snack"
        case 17..<22: return "dinner"
        default:      return "snack"
        }
    }
}

private extension Double {
    func rounded(toPlaces n: Int) -> Double {
        let mult = pow(10.0, Double(n))
        return (self * mult).rounded() / mult
    }
}
