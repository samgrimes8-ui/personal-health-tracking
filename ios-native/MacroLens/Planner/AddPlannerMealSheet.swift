import SwiftUI

/// Sheet for adding a planned meal to a day/slot. Two paths:
///   1. Pick from the user's recipe library — recipe macros + base
///      servings carry over to the planner row.
///   2. Quick ad-hoc — type a name and (optional) macros for a one-off.
///
/// The leftover toggle records is_leftover on the row so the grocery
/// list aggregator can skip it (covered) or surface it as orphan when
/// the source cook isn't in the shopping window.
struct AddPlannerMealSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    let weekStart: String
    let dayIndex: Int
    let slot: PlannerMealSlot
    let onSaved: () -> Void

    enum Mode: String, CaseIterable, Identifiable {
        case recipe, adHoc
        var id: String { rawValue }
        var label: String {
            switch self {
            case .recipe: return "From recipe"
            case .adHoc:  return "Quick add"
            }
        }
    }

    @State private var mode: Mode = .recipe
    @State private var search: String = ""
    @State private var selectedRecipe: RecipeRow?
    @State private var plannedServings: String = "1"
    @State private var isLeftover: Bool = false

    // Ad-hoc fields
    @State private var name: String = ""
    @State private var calories: String = ""
    @State private var protein: String = ""
    @State private var carbs: String = ""
    @State private var fat: String = ""

    @State private var saving = false
    @State private var errorMsg: String?
    @FocusState private var keyboardFocused: Bool

    private var dateString: String { PlannerDateMath.addDays(weekStart, dayIndex) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Mode", selection: $mode) {
                        ForEach(Mode.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text("\(slot.label) · \(PlannerDateMath.dayName(dayIndex)) \(PlannerDateMath.shortMonthDay(dateString))")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }

                if mode == .recipe {
                    recipeSection
                } else {
                    adHocSection
                }

                Section {
                    Toggle("Mark as leftover", isOn: $isLeftover)
                } footer: {
                    Text("Leftovers reuse a previous cook — they don't add to your grocery list when the source cook is in the shopping window.")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
            }
            .navigationTitle("Add to \(slot.label)")
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(saving || !canSave)
                        .fontWeight(.semibold)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    if keyboardFocused {
                        Button("Done") { keyboardFocused = false }
                    }
                }
            }
            .alert("Couldn't save", isPresented: Binding(
                get: { errorMsg != nil },
                set: { if !$0 { errorMsg = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: { Text(errorMsg ?? "") }
            .task {
                if state.recipesFull.isEmpty { await state.plannerLoadRecipesFullImpl() }
            }
        }
    }

    // MARK: - Mode sections

    private var recipeSection: some View {
        Section("Recipe") {
            TextField("Search recipes", text: $search)
                .textInputAutocapitalization(.never)
                .focused($keyboardFocused)
                .submitLabel(.search)
                .onSubmit { keyboardFocused = false }
            if filteredRecipes.isEmpty {
                Text(state.recipesFull.isEmpty ? "No recipes saved yet." : "No matches for \"\(search)\".")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text3)
            } else {
                ForEach(filteredRecipes.prefix(50)) { recipe in
                    Button { selectedRecipe = recipe } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(recipe.name)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Theme.text)
                                Text(macroLine(recipe))
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.text3)
                            }
                            Spacer()
                            if selectedRecipe?.id == recipe.id {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(Theme.accent)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

            if selectedRecipe != nil {
                HStack {
                    Text("Planned servings")
                    Spacer()
                    TextField("1", text: $plannedServings)
                        .multilineTextAlignment(.trailing)
                        .keyboardType(.decimalPad)
                        .focused($keyboardFocused)
                        .frame(width: 80)
                }
            }
        }
    }

    private var adHocSection: some View {
        Section("Meal") {
            TextField("Name (e.g. Greek salad)", text: $name)
                .focused($keyboardFocused)
            HStack {
                Text("Calories"); Spacer()
                TextField("0", text: $calories).multilineTextAlignment(.trailing).keyboardType(.numberPad).focused($keyboardFocused).frame(width: 80)
            }
            HStack {
                Text("Protein (g)"); Spacer()
                TextField("0", text: $protein).multilineTextAlignment(.trailing).keyboardType(.numberPad).focused($keyboardFocused).frame(width: 80)
            }
            HStack {
                Text("Carbs (g)"); Spacer()
                TextField("0", text: $carbs).multilineTextAlignment(.trailing).keyboardType(.numberPad).focused($keyboardFocused).frame(width: 80)
            }
            HStack {
                Text("Fat (g)"); Spacer()
                TextField("0", text: $fat).multilineTextAlignment(.trailing).keyboardType(.numberPad).focused($keyboardFocused).frame(width: 80)
            }
        }
    }

    // MARK: - Helpers

    private var filteredRecipes: [RecipeRow] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return state.recipesFull }
        return state.recipesFull.filter { $0.name.lowercased().contains(q) }
    }

    private func macroLine(_ r: RecipeRow) -> String {
        let cal = Int((r.calories ?? 0).rounded())
        let p = Int((r.protein ?? 0).rounded())
        let c = Int((r.carbs ?? 0).rounded())
        let f = Int((r.fat ?? 0).rounded())
        return "\(cal) kcal · P\(p)g C\(c)g F\(f)g"
    }

    private var canSave: Bool {
        switch mode {
        case .recipe:
            return selectedRecipe != nil
        case .adHoc:
            return !name.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private func save() async {
        guard canSave else { return }
        saving = true
        defer { saving = false }
        do {
            let entry: PlannerInsert
            switch mode {
            case .recipe:
                guard let recipe = selectedRecipe else { return }
                let mult = Double(plannedServings) ?? 1
                let baseServ = recipe.servings ?? 1
                let scale = baseServ > 0 ? mult / baseServ : 1
                entry = PlannerInsert(
                    id: nil,
                    weekStart: weekStart,
                    dayIdx: dayIndex,
                    mealName: recipe.name,
                    mealType: slot.rawValue,
                    calories: (recipe.calories ?? 0) * scale,
                    protein: (recipe.protein ?? 0) * scale,
                    carbs: (recipe.carbs ?? 0) * scale,
                    fat: (recipe.fat ?? 0) * scale,
                    fiber: (recipe.fiber ?? 0) * scale,
                    isLeftover: isLeftover,
                    plannedServings: mult,
                    recipeId: recipe.id
                )
            case .adHoc:
                entry = PlannerInsert(
                    id: nil,
                    weekStart: weekStart,
                    dayIdx: dayIndex,
                    mealName: name.trimmingCharacters(in: .whitespaces),
                    mealType: slot.rawValue,
                    calories: Double(calories) ?? 0,
                    protein: Double(protein) ?? 0,
                    carbs: Double(carbs) ?? 0,
                    fat: Double(fat) ?? 0,
                    fiber: 0,
                    isLeftover: isLeftover,
                    plannedServings: nil,
                    recipeId: nil
                )
            }
            _ = try await DBService.savePlannerEntry(entry)
            onSaved()
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

/// Sheet for editing a planner row inline. Mirrors the planner edit modal
/// in the web app — name, macros, leftover toggle. The row id is preserved
/// so DBService.savePlannerEntry routes through to an upsert.
struct EditPlannerMealSheet: View {
    @Environment(\.dismiss) private var dismiss
    let meal: PlannerRow
    let weekStart: String
    let onSaved: () -> Void

    @State private var name: String = ""
    @State private var calories: String = ""
    @State private var protein: String = ""
    @State private var carbs: String = ""
    @State private var fat: String = ""
    @State private var slot: PlannerMealSlot = .dinner
    @State private var isLeftover: Bool = false
    @State private var plannedServings: String = ""
    @State private var saving = false
    @State private var errorMsg: String?
    @FocusState private var keyboardFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section("Meal") {
                    TextField("Name", text: $name)
                        .focused($keyboardFocused)
                    Picker("Slot", selection: $slot) {
                        ForEach(PlannerMealSlot.allCases) { Text($0.label).tag($0) }
                    }
                }
                Section("Macros") {
                    HStack {
                        Text("Calories"); Spacer()
                        TextField("0", text: $calories).multilineTextAlignment(.trailing).keyboardType(.numberPad).focused($keyboardFocused).frame(width: 80)
                    }
                    HStack {
                        Text("Protein (g)"); Spacer()
                        TextField("0", text: $protein).multilineTextAlignment(.trailing).keyboardType(.numberPad).focused($keyboardFocused).frame(width: 80)
                    }
                    HStack {
                        Text("Carbs (g)"); Spacer()
                        TextField("0", text: $carbs).multilineTextAlignment(.trailing).keyboardType(.numberPad).focused($keyboardFocused).frame(width: 80)
                    }
                    HStack {
                        Text("Fat (g)"); Spacer()
                        TextField("0", text: $fat).multilineTextAlignment(.trailing).keyboardType(.numberPad).focused($keyboardFocused).frame(width: 80)
                    }
                }
                Section {
                    Toggle("Mark as leftover", isOn: $isLeftover)
                    if meal.recipe_id != nil {
                        HStack {
                            Text("Planned servings"); Spacer()
                            TextField("1", text: $plannedServings)
                                .multilineTextAlignment(.trailing)
                                .keyboardType(.decimalPad)
                                .focused($keyboardFocused)
                                .frame(width: 80)
                        }
                    }
                }
            }
            .navigationTitle("Edit meal")
            .navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(saving)
                        .fontWeight(.semibold)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    if keyboardFocused {
                        Button("Done") { keyboardFocused = false }
                    }
                }
            }
            .alert("Couldn't save", isPresented: Binding(
                get: { errorMsg != nil },
                set: { if !$0 { errorMsg = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: { Text(errorMsg ?? "") }
            .onAppear { hydrate() }
        }
    }

    private func hydrate() {
        name = meal.meal_name ?? ""
        calories = formatNumber(meal.calories)
        protein = formatNumber(meal.protein)
        carbs = formatNumber(meal.carbs)
        fat = formatNumber(meal.fat)
        slot = PlannerMealSlot.from(meal.meal_type)
        isLeftover = meal.is_leftover ?? false
        if let s = meal.planned_servings { plannedServings = formatDecimal(s) }
    }

    private func formatNumber(_ v: Double?) -> String {
        guard let v = v else { return "" }
        return String(Int(v.rounded()))
    }

    private func formatDecimal(_ v: Double) -> String {
        if v == v.rounded() { return String(Int(v)) }
        return String(format: "%.1f", v)
    }

    private func save() async {
        saving = true
        defer { saving = false }
        // Recover dayIdx from the meal's actual_date so the upsert
        // routes to the right slot. If actual_date is missing, fall
        // back to the stored day_of_week.
        let dayIdx = PlannerDateMath.slotIndex(for: meal) ?? meal.day_of_week ?? 0
        let entry = PlannerInsert(
            id: meal.id,
            weekStart: meal.week_start_date ?? weekStart,
            dayIdx: dayIdx,
            mealName: name.trimmingCharacters(in: .whitespaces),
            mealType: slot.rawValue,
            calories: Double(calories) ?? 0,
            protein: Double(protein) ?? 0,
            carbs: Double(carbs) ?? 0,
            fat: Double(fat) ?? 0,
            fiber: meal.fiber ?? 0,
            isLeftover: isLeftover,
            plannedServings: Double(plannedServings),
            recipeId: meal.recipe_id
        )
        do {
            _ = try await DBService.savePlannerEntry(entry)
            onSaved()
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}
