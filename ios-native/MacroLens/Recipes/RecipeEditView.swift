import SwiftUI

/// Edit / new recipe form. Mirrors the edit mode of the web
/// `renderRecipeModalContent`. Drives:
///   - basic fields: name, description, source URL, servings, label
///   - per-serving macros (cal/protein/carbs/fat/fiber/sugar)
///   - ingredients table (add row, remove row, edit cells)
///   - tag chips with preset suggestions and a custom-tag input
///   - AI helpers: estimate macros + ingredients from name/desc/URL,
///                 extract ingredients from name/desc, recalculate macros
///                 from ingredient list, extract from a recipe photo
///
/// On save, we route through DBService.saveRecipe — the upsert handles
/// both insert (no `id`) and update (existing `id`). The saved row comes
/// back as the narrower RecipeRow projection, so we splice it into the
/// caller's local copy and return the merged shape.
struct RecipeEditView: View {
    @State var recipe: RecipeFull
    let onSaved: (RecipeFull) -> Void
    let onCancel: () -> Void
    let onDeleted: () -> Void
    /// Pool of every tag the user has access to — presets + customs in
    /// use across other recipes + tags coined via the Edit Tags sheet
    /// (user_profiles.tag_order). Without this, the chip editor only
    /// shows presets + this recipe's own tags, so a tag created on
    /// Recipe A wouldn't appear when editing Recipe B. The parent
    /// (RecipesView) computes the union so every editor sees the same
    /// global view.
    var availableTags: [String] = []

    @Environment(\.dismiss) private var dismiss

    @State private var saving = false
    @State private var saveError: String?

    @State private var showExtractSheet = false

    @State private var aiBusy: AIBusy?
    @State private var aiError: String?
    @FocusState private var keyboardFocused: Bool

    enum AIBusy: Equatable {
        case estimate, extractIngredients, recalculate
    }

    private var isNew: Bool { recipe.id.isEmpty }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if isNew {
                    cookbookImportPanel
                }
                basicsCard
                macrosCard
                tagsCard
                ingredientsCard
                if let err = aiError {
                    Text(err).font(.system(size: 12)).foregroundStyle(Theme.red)
                }
                aiHelpers
                if let err = saveError {
                    Text(err).font(.system(size: 12)).foregroundStyle(Theme.red)
                }
                actionsRow
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(isNew ? "New recipe" : "Edit recipe")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") { onCancel() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await save() }
                } label: {
                    if saving { ProgressView().controlSize(.small) }
                    else { Text("Save").bold() }
                }
                .disabled(saving || trimmed(recipe.name).isEmpty)
                .foregroundStyle(Theme.accent)
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if keyboardFocused {
                    Button("Done") { keyboardFocused = false }
                }
            }
        }
        .sheet(isPresented: $showExtractSheet) {
            NavigationStack {
                IngredientExtractView(initialName: recipe.name,
                                      initialDescription: recipe.description ?? "") { result in
                    apply(extracted: result)
                    showExtractSheet = false
                } onCancel: {
                    showExtractSheet = false
                }
            }
        }
    }

    // MARK: - Sections

    private var cookbookImportPanel: some View {
        Button {
            showExtractSheet = true
        } label: {
            HStack(spacing: 10) {
                Text("📖").font(.system(size: 22))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Import from text or photo")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                    Text("Paste a recipe or shoot a cookbook page — AI fills the form.")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                        .multilineTextAlignment(.leading)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
            }
            .padding(12)
            .background(Theme.accentSoft(0.08), in: .rect(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Theme.accent.opacity(0.35), style: .init(lineWidth: 1.5, dash: [5, 4]))
            )
        }
        .buttonStyle(.plain)
    }

    private var basicsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                fieldLabel("Name")
                TextField("e.g. Chicken tacos", text: $recipe.name, axis: .vertical)
                    .focused($keyboardFocused)
                    .font(.system(size: 17, weight: .semibold, design: .serif))
                    .foregroundStyle(Theme.text)
                    .textInputAutocapitalization(.sentences)

                fieldLabel("Description (optional)")
                TextField("Brief description...", text: bindingString(\.description), axis: .vertical)
                    .focused($keyboardFocused)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1...4)

                fieldLabel("Source URL (optional)")
                TextField("https://...", text: bindingString(\.source_url))
                    .focused($keyboardFocused)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        fieldLabel("Servings")
                        TextField("4", value: bindingDouble(\.servings, fallback: 4), format: .number)
                            .keyboardType(.decimalPad)
                            .focused($keyboardFocused)
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .background(Theme.bg3, in: .rect(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                    }
                    .frame(maxWidth: 110)
                    VStack(alignment: .leading, spacing: 4) {
                        fieldLabel("Serving label")
                        TextField("serving / slice / cup", text: bindingString(\.serving_label, fallback: "serving"))
                            .focused($keyboardFocused)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.text)
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .background(Theme.bg3, in: .rect(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                    }
                }
            }
        }
    }

    private var macrosCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                fieldLabel("Macros per serving")
                HStack(spacing: 8) {
                    macroField("Calories", value: bindingDouble(\.calories), color: Theme.cal)
                    macroField("Protein (g)", value: bindingDouble(\.protein), color: Theme.protein)
                    macroField("Carbs (g)", value: bindingDouble(\.carbs), color: Theme.carbs)
                }
                HStack(spacing: 8) {
                    macroField("Fat (g)", value: bindingDouble(\.fat), color: Theme.fat)
                    macroField("Fiber (g)", value: bindingDouble(\.fiber), color: Theme.fiber)
                    macroField("Sugar (g)", value: bindingDouble(\.sugar), color: Theme.text2)
                }
            }
        }
    }

    private var tagsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                fieldLabel("Tags")
                let known = knownTags()
                FlowLayout(spacing: 6) {
                    ForEach(known, id: \.self) { tag in
                        let isOn = (recipe.tags ?? []).contains(where: { $0.lowercased() == tag.lowercased() })
                        Button { toggleTag(tag) } label: {
                            HStack(spacing: 4) {
                                if isOn { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)) }
                                Text(tag).font(.system(size: 12))
                            }
                            .foregroundStyle(isOn ? Theme.carbs : Theme.text2)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(isOn ? Theme.carbs.opacity(0.15) : Theme.bg3, in: .rect(cornerRadius: 999))
                            .overlay(RoundedRectangle(cornerRadius: 999).stroke(isOn ? Theme.carbs : Theme.border2, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
                CustomTagInput(onAdd: { newTag in
                    let trimmed = newTag.trimmingCharacters(in: .whitespaces)
                    guard !trimmed.isEmpty else { return }
                    if !(recipe.tags ?? []).contains(where: { $0.lowercased() == trimmed.lowercased() }) {
                        recipe.tags = (recipe.tags ?? []) + [trimmed]
                    }
                })
            }
        }
    }

    private var ingredientsCard: some View {
        let ings = recipe.ingredients ?? []
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    fieldLabel("Ingredients\(ings.isEmpty ? "" : " (\(ings.count))")")
                    Spacer()
                    Button {
                        recipe.ingredients = ings + [RecipeIngredient(name: "", amount: nil, unit: "", category: nil)]
                    } label: {
                        Label("Add", systemImage: "plus")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                }
                if ings.isEmpty {
                    Text("No ingredients yet — add manually or use AI extract / estimate below.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 14)
                } else {
                    VStack(spacing: 8) {
                        ForEach(Array(ings.enumerated()), id: \.offset) { idx, _ in
                            ingredientEditRow(idx: idx)
                        }
                    }
                }
            }
        }
    }

    private func ingredientEditRow(idx: Int) -> some View {
        HStack(spacing: 6) {
            TextField("Amt", text: ingredientAmountBinding(idx))
                .focused($keyboardFocused)
                .frame(width: 56)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(Theme.bg3, in: .rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border2, lineWidth: 1))
                .keyboardType(.numbersAndPunctuation)
            TextField("unit", text: ingredientUnitBinding(idx))
                .focused($keyboardFocused)
                .frame(width: 56)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(Theme.bg3, in: .rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border2, lineWidth: 1))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            TextField("Ingredient", text: ingredientNameBinding(idx))
                .focused($keyboardFocused)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(Theme.bg3, in: .rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border2, lineWidth: 1))
            Button {
                var ings = recipe.ingredients ?? []
                if idx < ings.count {
                    ings.remove(at: idx)
                    recipe.ingredients = ings
                }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                    .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
        }
    }

    private var aiHelpers: some View {
        VStack(spacing: 8) {
            if (recipe.ingredients ?? []).isEmpty {
                aiButton(
                    title: "Estimate macros & ingredients with AI",
                    busy: aiBusy == .estimate
                ) { Task { await aiEstimate() } }

                aiButton(
                    title: "Extract ingredients only",
                    busy: aiBusy == .extractIngredients,
                    accent: false
                ) { Task { await aiExtractIngredients() } }
            } else {
                aiButton(
                    title: "Recalculate macros from ingredients",
                    busy: aiBusy == .recalculate
                ) { Task { await aiRecalculate() } }
            }
        }
    }

    private var actionsRow: some View {
        HStack(spacing: 10) {
            if !isNew {
                Button(role: .destructive) {
                    Task { await delete() }
                } label: {
                    Text("Delete").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(Theme.red)
                .disabled(saving)
            }
            Button { onCancel() } label: {
                Text("Cancel").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            Button {
                Task { await save() }
            } label: {
                if saving { ProgressView().controlSize(.small).frame(maxWidth: .infinity) }
                else { Text("Save").frame(maxWidth: .infinity) }
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .disabled(saving || trimmed(recipe.name).isEmpty)
        }
        .padding(.top, 6)
    }

    // MARK: - AI helpers

    private func aiEstimate() async {
        let context = aiContextString()
        guard !context.isEmpty else {
            aiError = "Add a name, description, or URL first."
            return
        }
        aiBusy = .estimate
        aiError = nil
        defer { aiBusy = nil }
        do {
            let result = try await AnalyzeService.analyzeRecipeText(context, hint: nilOrEmpty(recipe.name))
            apply(analysis: result, fillIngredients: true)
        } catch {
            aiError = error.localizedDescription
        }
    }

    private func aiExtractIngredients() async {
        let name = trimmed(recipe.name)
        guard !name.isEmpty else {
            aiError = "Add a name first."
            return
        }
        aiBusy = .extractIngredients
        aiError = nil
        defer { aiBusy = nil }
        let prompt = """
        For this recipe: "\(name)"
        \(recipe.description.flatMap { $0.isEmpty ? nil : "\nContext: \($0)" } ?? "")

        List every ingredient needed to cook this for \(Int(recipe.servings ?? 1)) serving(s).
        Be specific with amounts (e.g. "3 lbs", "2 cups", "1 tbsp").
        """
        do {
            let result = try await AnalyzeService.analyzeRecipeText(prompt, hint: name)
            if let ings = result.ingredients, !ings.isEmpty {
                recipe.ingredients = ings.map(RecipeIngredient.fromAI)
            } else {
                aiError = "AI didn't return any ingredients — try with more detail."
            }
        } catch {
            aiError = error.localizedDescription
        }
    }

    private func aiRecalculate() async {
        let ings = recipe.ingredients ?? []
        guard !ings.isEmpty else {
            aiError = "Add ingredients first."
            return
        }
        aiBusy = .recalculate
        aiError = nil
        defer { aiBusy = nil }
        let lines = ings.map { ing in
            let amt = ing.amount ?? ""
            let unit = ing.unit ?? ""
            return "\(amt) \(unit) \(ing.name)".trimmingCharacters(in: .whitespaces)
        }.joined(separator: "\n")
        let prompt = """
        Calculate the macros per serving for this recipe (\(Int(recipe.servings ?? 1)) total servings):

        Ingredients:
        \(lines)
        """
        do {
            let result = try await AnalyzeService.analyzeRecipeText(prompt, hint: nilOrEmpty(recipe.name))
            recipe.calories = result.calories
            recipe.protein = result.protein
            recipe.carbs = result.carbs
            recipe.fat = result.fat
            recipe.fiber = result.fiber ?? recipe.fiber
            recipe.sugar = result.sugar ?? recipe.sugar
        } catch {
            aiError = error.localizedDescription
        }
    }

    private func apply(analysis a: AnalysisResult, fillIngredients: Bool) {
        if trimmed(recipe.name).isEmpty { recipe.name = a.name }
        if (recipe.description ?? "").isEmpty, let d = a.description { recipe.description = d }
        if let s = a.servings { recipe.servings = s }
        recipe.calories = a.calories
        recipe.protein = a.protein
        recipe.carbs = a.carbs
        recipe.fat = a.fat
        recipe.fiber = a.fiber ?? recipe.fiber
        recipe.sugar = a.sugar ?? recipe.sugar
        if fillIngredients, let ings = a.ingredients, !ings.isEmpty {
            recipe.ingredients = ings.map(RecipeIngredient.fromAI)
        }
    }

    private func apply(extracted: AnalysisResult) {
        apply(analysis: extracted, fillIngredients: true)
    }

    private func aiContextString() -> String {
        var lines: [String] = []
        let n = trimmed(recipe.name); if !n.isEmpty { lines.append("Recipe: \(n)") }
        let d = trimmed(recipe.description ?? ""); if !d.isEmpty { lines.append("Description: \(d)") }
        let u = trimmed(recipe.source_url ?? ""); if !u.isEmpty { lines.append("Source URL: \(u)") }
        lines.append("Servings: \(Int(recipe.servings ?? 4))")
        return lines.joined(separator: "\n")
    }

    // MARK: - Save / delete

    private func save() async {
        let name = trimmed(recipe.name)
        guard !name.isEmpty else { saveError = "Recipe needs a name."; return }
        saving = true
        saveError = nil
        defer { saving = false }
        let upsert = RecipeUpsert(
            id: recipe.id.isEmpty ? nil : recipe.id,
            name: name,
            description: nilOrEmpty(recipe.description),
            servings: recipe.servings,
            calories: recipe.calories,
            protein: recipe.protein,
            carbs: recipe.carbs,
            fat: recipe.fat,
            fiber: recipe.fiber,
            sugar: recipe.sugar,
            ingredients: recipe.ingredients,
            notes: nilOrEmpty(recipe.notes),
            source: nil,
            sourceUrl: nilOrEmpty(recipe.source_url),
            tags: recipe.tags
        )
        do {
            let saved = try await DBService.saveRecipe(upsert)
            // Splice the persisted id/macros back into our richer copy so
            // the parent gets a complete row to display in view-mode.
            var merged = recipe
            merged.id = saved.id
            merged.calories = saved.calories ?? merged.calories
            merged.protein = saved.protein ?? merged.protein
            merged.carbs = saved.carbs ?? merged.carbs
            merged.fat = saved.fat ?? merged.fat
            merged.fiber = saved.fiber ?? merged.fiber
            merged.servings = saved.servings ?? merged.servings
            onSaved(merged)
        } catch {
            saveError = error.localizedDescription
        }
    }

    private func delete() async {
        guard !recipe.id.isEmpty else { onDeleted(); return }
        saving = true
        defer { saving = false }
        do {
            try await DBService.deleteRecipe(id: recipe.id)
            onDeleted()
        } catch {
            saveError = error.localizedDescription
        }
    }

    // MARK: - Bindings / helpers

    private func fieldLabel(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 11, weight: .medium))
            .tracking(1.0).textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    private func macroField(_ label: String, value: Binding<Double>, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10))
                .tracking(0.6).textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            TextField("0", value: value, format: .number)
                .focused($keyboardFocused)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(color)
                .keyboardType(.decimalPad)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(Theme.bg3, in: .rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border2, lineWidth: 1))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func aiButton(title: String, busy: Bool, accent: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.small) }
                else { Text("✨").font(.system(size: 13)) }
                Text(busy ? "Working..." : title)
                    .font(.system(size: 13, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .foregroundStyle(accent ? Theme.accentFG : Theme.text2)
            .background(accent ? Theme.accent : Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(accent ? Color.clear : Theme.border2, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(aiBusy != nil)
    }

    private func toggleTag(_ tag: String) {
        var current = recipe.tags ?? []
        if let idx = current.firstIndex(where: { $0.lowercased() == tag.lowercased() }) {
            current.remove(at: idx)
        } else {
            current.append(tag)
        }
        recipe.tags = current
    }

    private func knownTags() -> [String] {
        var seen: Set<String> = []
        var out: [String] = []
        // Presets first
        for t in RecipeTagPresets.all where !seen.contains(t.lowercased()) {
            seen.insert(t.lowercased())
            out.append(t)
        }
        // Tags from across the user's library + tag_order. Aggregated
        // by the parent so a tag coined on Recipe A appears in Recipe B's
        // picker without us needing to re-scan the library here.
        for t in availableTags where !seen.contains(t.lowercased()) {
            seen.insert(t.lowercased())
            out.append(t)
        }
        // Currently selected on this recipe (custom or otherwise) —
        // keep them visible even if they're not in availableTags yet
        // (e.g. user just typed a brand-new custom tag in this session).
        for t in (recipe.tags ?? []) where !seen.contains(t.lowercased()) {
            seen.insert(t.lowercased())
            out.append(t)
        }
        return out
    }

    private func bindingString(_ keyPath: WritableKeyPath<RecipeFull, String?>, fallback: String = "") -> Binding<String> {
        Binding(
            get: { recipe[keyPath: keyPath] ?? fallback },
            set: { recipe[keyPath: keyPath] = $0 }
        )
    }

    private func bindingDouble(_ keyPath: WritableKeyPath<RecipeFull, Double?>, fallback: Double = 0) -> Binding<Double> {
        Binding(
            get: { recipe[keyPath: keyPath] ?? fallback },
            set: { recipe[keyPath: keyPath] = $0 }
        )
    }

    private func ingredientAmountBinding(_ idx: Int) -> Binding<String> {
        Binding(
            get: {
                guard let ings = recipe.ingredients, idx < ings.count else { return "" }
                return ings[idx].amount ?? ""
            },
            set: { newVal in
                var ings = recipe.ingredients ?? []
                guard idx < ings.count else { return }
                let trimmed = newVal.trimmingCharacters(in: .whitespaces)
                ings[idx].amount = trimmed.isEmpty ? nil : trimmed
                recipe.ingredients = ings
            }
        )
    }

    private func ingredientUnitBinding(_ idx: Int) -> Binding<String> {
        Binding(
            get: {
                guard let ings = recipe.ingredients, idx < ings.count else { return "" }
                return ings[idx].unit ?? ""
            },
            set: { newVal in
                var ings = recipe.ingredients ?? []
                guard idx < ings.count else { return }
                ings[idx].unit = newVal.isEmpty ? nil : newVal
                recipe.ingredients = ings
            }
        )
    }

    private func ingredientNameBinding(_ idx: Int) -> Binding<String> {
        Binding(
            get: {
                guard let ings = recipe.ingredients, idx < ings.count else { return "" }
                return ings[idx].name
            },
            set: { newVal in
                var ings = recipe.ingredients ?? []
                guard idx < ings.count else { return }
                ings[idx].name = newVal
                recipe.ingredients = ings
            }
        )
    }

    private func trimmed(_ s: String?) -> String {
        (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func nilOrEmpty(_ s: String?) -> String? {
        let t = trimmed(s)
        return t.isEmpty ? nil : t
    }
}

/// Custom tag entry. Pulled out so the keyboard "return" key can submit
/// without needing to build a parent-scoped `@State` for the in-progress
/// string.
private struct CustomTagInput: View {
    let onAdd: (String) -> Void
    @State private var text: String = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            TextField("Create a new tag...", text: $text)
                .focused($focused)
                .font(.system(size: 13))
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(Theme.bg3, in: .rect(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                .submitLabel(.done)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .onSubmit { commit(); focused = false }
            Button("+ Add", action: commit)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.text2)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Theme.bg3, in: .rect(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
        }
    }

    private func commit() {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        onAdd(t)
        text = ""
    }
}
