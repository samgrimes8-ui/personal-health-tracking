import SwiftUI

/// Modal editor for a food_items row. New + edit share one form.
///
/// Mirrors renderFoodItemModal in src/pages/app.js (the web modal). Sections:
///   1. Name / brand / serving-size text fields
///   2. Components list — add via AI describe, live barcode scan, or manual.
///      When the food has components, the macro fields below auto-sum from
///      them and become read-only. With no components, the user types per-
///      serving macros directly.
///   3. Per-serving macros (read-only when components exist)
///   4. Save / Delete / Cancel
///
/// The component panel shells out to BarcodeScannerView for live scans
/// and AnalyzeService.describeFood for the "Describe" mode. Saved-foods
/// + label-photo modes are deferred to a follow-up — the web has them,
/// but for v1 of the native Foods tab, describe + barcode + manual covers
/// the common paths.
struct FoodEditorView: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    let item: FoodItemRow?

    @State private var name: String = ""
    @State private var brand: String = ""
    @State private var servingSize: String = "1 serving"
    /// Structured single-serving description — required field. New rows
    /// can't save without one; legacy rows hydrate from serving_size if
    /// they don't already carry the structured field.
    @State private var servingDescription: String = ""
    /// Per-serving gram weight — also required for new rows. Stored as
    /// String to keep input lenient; parsed at save time. Either grams
    /// OR a populated description satisfies the soft DB constraint.
    @State private var servingGramsText: String = ""
    @State private var components: [FoodComponent] = []

    // Manual macro fields (used only when there are no components).
    @State private var calories: String = ""
    @State private var protein: String = ""
    @State private var carbs: String = ""
    @State private var fat: String = ""
    @State private var fiber: String = ""
    @State private var sugar: String = ""

    @State private var saving = false
    @State private var deleting = false
    @State private var errorMsg: String?
    @State private var addingComponent = false
    @State private var componentEditingIdx: Int?
    @State private var confirmDelete = false
    @FocusState private var keyboardFocused: Bool

    private var isNew: Bool { item?.id == nil }
    private var hasComponents: Bool { !components.isEmpty }
    private var componentTotals: ComponentTotals { ComponentTotals.sum(components) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    nameCard
                    componentsCard
                    macrosCard
                    if let errorMsg {
                        Text(errorMsg)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.red)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 8))
                    }
                    actionRow
                }
                .padding(20)
            }
            .background(Theme.bg)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(isNew ? "New food" : "Edit food")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.text3)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    if keyboardFocused {
                        Button("Done") { keyboardFocused = false }
                    }
                }
            }
            .onAppear { hydrate() }
            .sheet(isPresented: $addingComponent) {
                AddComponentSheet { newComponent in
                    components.append(newComponent)
                    addingComponent = false
                }
                .environment(state)
            }
            .sheet(item: Binding(
                get: { componentEditingIdx.map { ComponentEditTarget(idx: $0) } },
                set: { newVal in componentEditingIdx = newVal?.idx }
            )) { target in
                EditComponentSheet(
                    component: components[target.idx],
                    onSave: { updated in
                        if target.idx < components.count {
                            components[target.idx] = updated
                        }
                        componentEditingIdx = nil
                    },
                    onRemove: {
                        if target.idx < components.count {
                            components.remove(at: target.idx)
                        }
                        componentEditingIdx = nil
                    }
                )
            }
            .alert("Delete this food?", isPresented: $confirmDelete) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) {
                    Task { await delete() }
                }
            } message: {
                Text("This will remove the saved food. Logged meals already using it stay logged.")
            }
        }
        .presentationDetents([.large])
    }

    // MARK: - Sections

    private var nameCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            fieldLabeled("Food name *") {
                TextField("Morning Protein Shake, Greek Yogurt Bowl…", text: $name)
                    .focused($keyboardFocused)
                    .textInputField()
            }
            fieldLabeled("Serving description *") {
                TextField("e.g. 1 medium avocado, ~150g", text: $servingDescription)
                    .focused($keyboardFocused)
                    .textInputField()
            }
            HStack(spacing: 10) {
                fieldLabeled("Brand (optional)") {
                    TextField("Brand name…", text: $brand)
                        .focused($keyboardFocused)
                        .textInputField()
                }
                fieldLabeled("Grams per serving *") {
                    TextField("150", text: $servingGramsText)
                        .focused($keyboardFocused)
                        .keyboardType(.decimalPad)
                        .textInputField()
                }
            }
            Text("Required so logging \"15g\" of this food computes the right serving multiplier.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var componentsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionLabel("Components" + (components.isEmpty ? "" : " (\(components.count))"))
                Spacer()
                Button {
                    addingComponent = true
                } label: {
                    Text("+ Add component")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.accent)
                }
            }
            if components.isEmpty {
                VStack(spacing: 4) {
                    Text("Add components to auto-calculate macros")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text3)
                    Text("e.g. 2 cups milk, 1 scoop protein powder")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 18)
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Theme.border2, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                )
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(components.enumerated()), id: \.offset) { idx, comp in
                        componentRow(idx: idx, comp: comp)
                        if idx < components.count - 1 {
                            Divider().background(Theme.border)
                        }
                    }
                    Divider().background(Theme.border)
                    HStack {
                        Text("Total")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.text2)
                        Spacer()
                        let t = componentTotals
                        Text("\(Int(t.calories.rounded())) kcal · P\(Int(t.protein.rounded())) C\(Int(t.carbs.rounded())) F\(Int(t.fat.rounded()))")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.text2)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(Theme.bg3)
                }
                .background(Theme.bg2, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
            }
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private func componentRow(idx: Int, comp: FoodComponent) -> some View {
        Button {
            componentEditingIdx = idx
        } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        if let qty = comp.qty, qty != 1 {
                            Text("\(formatQty(qty)) \(comp.unit ?? "serving")")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.accent)
                        } else if let unit = comp.unit, unit != "serving", !unit.isEmpty {
                            Text(unit)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.accent)
                        }
                        Text(comp.name ?? "")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.text)
                    }
                    Text("\(Int((comp.calories ?? 0).rounded())) kcal · P\(Int((comp.protein ?? 0).rounded())) C\(Int((comp.carbs ?? 0).rounded())) F\(Int((comp.fat ?? 0).rounded()))")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var macrosCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionLabel(hasComponents ? "Macros (auto-calculated)" : "Macros per serving")
                Spacer()
            }
            let t = componentTotals
            HStack(spacing: 8) {
                fieldLabeled("Calories") {
                    macroField(
                        binding: $calories,
                        autoValue: hasComponents ? Int(t.calories.rounded()) : nil,
                        readOnly: hasComponents
                    )
                }
                fieldLabeled("Protein (g)") {
                    macroField(
                        binding: $protein,
                        autoValue: hasComponents ? Int(t.protein.rounded()) : nil,
                        readOnly: hasComponents
                    )
                }
            }
            HStack(spacing: 8) {
                fieldLabeled("Carbs (g)") {
                    macroField(
                        binding: $carbs,
                        autoValue: hasComponents ? Int(t.carbs.rounded()) : nil,
                        readOnly: hasComponents
                    )
                }
                fieldLabeled("Fat (g)") {
                    macroField(
                        binding: $fat,
                        autoValue: hasComponents ? Int(t.fat.rounded()) : nil,
                        readOnly: hasComponents
                    )
                }
            }
            HStack(spacing: 8) {
                fieldLabeled("Fiber (g)") {
                    macroField(
                        binding: $fiber,
                        autoValue: hasComponents ? Int(t.fiber.rounded()) : nil,
                        readOnly: hasComponents
                    )
                }
                fieldLabeled("Sugar (g)") {
                    macroField(
                        binding: $sugar,
                        autoValue: hasComponents ? Int(t.sugar.rounded()) : nil,
                        readOnly: hasComponents
                    )
                }
            }
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var actionRow: some View {
        VStack(spacing: 10) {
            Button {
                Task { await save() }
            } label: {
                HStack {
                    if saving { ProgressView().tint(Theme.accentFG) }
                    Text(saving ? "Saving…" : "Save food")
                        .font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(Theme.accentFG)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Theme.accent, in: .rect(cornerRadius: 12))
            }
            .disabled(saving || deleting)

            if !isNew {
                Button {
                    confirmDelete = true
                } label: {
                    Text(deleting ? "Deleting…" : "Delete food")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.red)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.25), lineWidth: 1))
                }
                .disabled(saving || deleting)
            }
        }
    }

    // MARK: - Helpers

    private func sectionLabel(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 11, weight: .medium))
            .tracking(0.8)
            .textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    private func fieldLabeled<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 11))
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func macroField(binding: Binding<String>, autoValue: Int?, readOnly: Bool) -> some View {
        if readOnly, let v = autoValue {
            Text("\(v)")
                .font(.system(size: 14))
                .foregroundStyle(Theme.text2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.bg3.opacity(0.6), in: .rect(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
        } else {
            TextField("0", text: binding)
                .keyboardType(.decimalPad)
                .focused($keyboardFocused)
                .textInputField()
        }
    }

    private func formatQty(_ v: Double) -> String {
        if v == v.rounded() { return String(Int(v)) }
        return String(format: "%g", v)
    }

    // MARK: - Hydrate / save / delete

    private func hydrate() {
        guard let item else { return }
        name = item.name
        brand = item.brand ?? ""
        servingSize = (item.serving_size?.isEmpty == false) ? item.serving_size! : "1 serving"
        // Prefer the structured serving_description when present; fall
        // back to the legacy serving_size text for older rows so the
        // editor doesn't open with a blank required field.
        servingDescription = item.serving_description?.isEmpty == false
            ? item.serving_description!
            : (item.serving_size?.isEmpty == false ? item.serving_size! : "")
        servingGramsText = item.serving_grams.map { String(format: "%g", $0) } ?? ""
        components = item.components ?? []
        calories = item.calories.map { String(Int($0.rounded())) } ?? ""
        protein  = item.protein.map  { String(Int($0.rounded())) } ?? ""
        carbs    = item.carbs.map    { String(Int($0.rounded())) } ?? ""
        fat      = item.fat.map      { String(Int($0.rounded())) } ?? ""
        fiber    = item.fiber.map    { String(Int($0.rounded())) } ?? ""
        sugar    = item.sugar.map    { String(Int($0.rounded())) } ?? ""
    }

    private func save() async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            errorMsg = "Food needs a name"
            return
        }
        let trimmedServing = servingDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let parsedGrams = Double(servingGramsText.trimmingCharacters(in: .whitespacesAndNewlines))
        // Phase C requires at least one of the two so logging can later
        // compute servings. Both is best — description for the human,
        // grams for the math — but one of the two is the floor.
        guard !trimmedServing.isEmpty || (parsedGrams ?? 0) > 0 else {
            errorMsg = "Add a serving description (e.g. \"1 medium avocado, ~150g\") or a per-serving gram weight."
            return
        }
        saving = true
        errorMsg = nil
        defer { saving = false }

        let totals: ComponentTotals = hasComponents
            ? componentTotals
            : ComponentTotals(
                calories: Double(calories) ?? 0,
                protein:  Double(protein)  ?? 0,
                carbs:    Double(carbs)    ?? 0,
                fat:      Double(fat)      ?? 0,
                fiber:    Double(fiber)    ?? 0,
                sugar:    Double(sugar)    ?? 0
              )

        let upsert = FoodItemUpsert(
            id: item?.id,
            name: trimmed,
            brand: brand.trimmingCharacters(in: .whitespaces).isEmpty ? nil : brand.trimmingCharacters(in: .whitespaces),
            servingSize: servingSize.trimmingCharacters(in: .whitespaces).isEmpty ? "1 serving" : servingSize,
            calories: totals.calories,
            protein: totals.protein,
            carbs: totals.carbs,
            fat: totals.fat,
            fiber: totals.fiber,
            sugar: totals.sugar,
            sodium: item?.sodium ?? 0,
            components: components.isEmpty ? nil : components,
            notes: item?.notes,
            source: item?.source ?? (hasComponents ? "manual" : "manual"),
            // Form-supplied serving fields. Editor surfaces them now —
            // user must fill description OR grams (Phase C requirement).
            // serving_oz derived from grams for display parity.
            servingDescription: trimmedServing.isEmpty ? nil : trimmedServing,
            servingGrams: parsedGrams,
            servingOz: parsedGrams.map { ($0 / 28.3495 * 10).rounded() / 10 }
        )

        do {
            let saved = try await DBService.saveFoodItem(upsert)
            // Splice into AppState.foods so the list refreshes immediately.
            if let idx = state.foods.firstIndex(where: { $0.id == saved.id }) {
                state.foods[idx] = saved
            } else {
                state.foods.insert(saved, at: 0)
            }
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func delete() async {
        guard let id = item?.id else { return }
        deleting = true
        errorMsg = nil
        defer { deleting = false }
        do {
            try await DBService.deleteFoodItem(id: id)
            state.foods.removeAll { $0.id == id }
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Component edit target (Identifiable wrapper for sheet binding)

private struct ComponentEditTarget: Identifiable {
    let idx: Int
    var id: Int { idx }
}

// MARK: - Shared compact text-input style

private extension View {
    func textInputField() -> some View {
        self
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg3, in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
            .font(.system(size: 14))
            .foregroundStyle(Theme.text)
    }
}

// MARK: - Component totals helper

struct ComponentTotals {
    var calories: Double = 0
    var protein: Double = 0
    var carbs: Double = 0
    var fat: Double = 0
    var fiber: Double = 0
    var sugar: Double = 0

    static func sum(_ comps: [FoodComponent]) -> ComponentTotals {
        var t = ComponentTotals()
        for c in comps {
            t.calories += c.calories ?? 0
            t.protein  += c.protein  ?? 0
            t.carbs    += c.carbs    ?? 0
            t.fat      += c.fat      ?? 0
            t.fiber    += c.fiber    ?? 0
            t.sugar    += c.sugar    ?? 0
        }
        return t
    }
}

