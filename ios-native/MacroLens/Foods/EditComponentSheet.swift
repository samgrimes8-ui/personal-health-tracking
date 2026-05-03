import SwiftUI

/// Edit-or-remove modal for a single component already on a food.
/// Adjusting qty re-scales the component's macros against its captured
/// per-unit baseline (calories at qty 1). Mirrors updateComponentQty
/// in src/pages/app.js.
struct EditComponentSheet: View {
    let component: FoodComponent
    let onSave: (FoodComponent) -> Void
    let onRemove: () -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var qty: String = ""
    @State private var unit: String = ""
    @State private var name: String = ""

    /// Per-unit baseline frozen at .onAppear so re-scaling stays stable
    /// across multiple qty edits.
    @State private var baseCal: Double = 0
    @State private var baseP: Double = 0
    @State private var baseC: Double = 0
    @State private var baseF: Double = 0
    @State private var baseFiber: Double = 0
    @State private var baseSugar: Double = 0
    @FocusState private var keyboardFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    nameSection
                    qtySection
                    macroPreview
                    actionRow
                }
                .padding(20)
            }
            .background(Theme.bg)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Edit component")
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
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - Sections

    private var nameSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Name")
                .font(.system(size: 11))
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            TextField("Component name", text: $name)
                .focused($keyboardFocused)
                .textInputField()
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var qtySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Adjust qty — macros scale automatically.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Qty")
                        .font(.system(size: 10))
                        .tracking(0.8)
                        .textCase(.uppercase)
                        .foregroundStyle(Theme.text3)
                    TextField("1", text: $qty)
                        .keyboardType(.decimalPad)
                        .focused($keyboardFocused)
                        .textInputField()
                }
                .frame(width: 100)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Unit")
                        .font(.system(size: 10))
                        .tracking(0.8)
                        .textCase(.uppercase)
                        .foregroundStyle(Theme.text3)
                    TextField("serving", text: $unit)
                        .focused($keyboardFocused)
                        .textInputField()
                }
            }
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var macroPreview: some View {
        let q = Double(qty) ?? 1
        let cal = baseCal * q
        let p = baseP * q
        let c = baseC * q
        let f = baseF * q
        return HStack(spacing: 6) {
            MacroChip(.calories, label: "kcal", amount: cal)
            MacroChip(.protein, label: "P", amount: p)
            MacroChip(.carbs, label: "C", amount: c)
            MacroChip(.fat, label: "F", amount: f)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var actionRow: some View {
        VStack(spacing: 10) {
            Button {
                save()
            } label: {
                Text("Save changes")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.accentFG)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.accent, in: .rect(cornerRadius: 12))
            }
            Button {
                onRemove()
            } label: {
                Text("Remove component")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.red)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.25), lineWidth: 1))
            }
        }
    }

    // MARK: - Helpers

    private func hydrate() {
        name = component.name ?? ""
        unit = component.unit ?? "serving"
        let q = component.qty ?? 1
        qty = q == q.rounded() ? String(Int(q)) : String(format: "%g", q)
        // Baseline = current macros / current qty so the user can scale
        // up or down from this anchor.
        let denom = q == 0 ? 1 : q
        baseCal   = (component.calories ?? 0) / denom
        baseP     = (component.protein  ?? 0) / denom
        baseC     = (component.carbs    ?? 0) / denom
        baseF     = (component.fat      ?? 0) / denom
        baseFiber = (component.fiber    ?? 0) / denom
        baseSugar = (component.sugar    ?? 0) / denom
    }

    private func save() {
        let q = Double(qty) ?? 1
        var updated = component
        updated.name = name.trimmingCharacters(in: .whitespaces)
        updated.qty = q
        updated.unit = unit.trimmingCharacters(in: .whitespaces).isEmpty ? "serving" : unit.trimmingCharacters(in: .whitespaces)
        updated.calories = baseCal * q
        updated.protein  = baseP * q
        updated.carbs    = baseC * q
        updated.fat      = baseF * q
        updated.fiber    = baseFiber * q
        updated.sugar    = baseSugar * q
        onSave(updated)
    }
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
