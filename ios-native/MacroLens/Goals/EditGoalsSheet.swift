import SwiftUI

/// Editor for the Goal Settings card on the Goals page. Touches two
/// tables under the hood: body_metrics (direction, pace, target weight,
/// target body-fat %) and goals (cal / protein / carbs / fat targets).
/// Both saved in one tap — UI doesn't care which table a field lives on.
///
/// The "Use calculated" button populates the macro fields from
/// BMR/TDEE/direction/pace via the same formula the web uses
/// (calcTargetMacros mirrored in BodyMetrics.calculatedTargets). Lets
/// users set a goal direction once and accept the recommended macros
/// without doing math.
struct EditGoalsSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    // body_metrics fields
    @State private var direction: String = "lose"
    @State private var pace: String = "moderate"
    @State private var goalWeightLbs: String = ""
    @State private var goalBodyFat: String = ""

    // goals fields
    @State private var calories: String = ""
    @State private var protein: String = ""
    @State private var carbs: String = ""
    @State private var fat: String = ""

    @State private var saving = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    intro
                    directionCard
                    paceCard
                    targetCard
                    calculatedCard
                    macroCard
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
            .navigationTitle("Edit goals")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.text3)
                }
            }
            .onAppear { hydrate() }
        }
        .presentationDetents([.large])
    }

    // MARK: - Sections

    private var intro: some View {
        Text("Direction + pace drive the recommended macros. You can override the macro fields below if you're following a different plan.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.text2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var directionCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Direction")
            Picker("Direction", selection: $direction) {
                Text("Lose fat").tag("lose")
                Text("Maintain").tag("maintain")
                Text("Build muscle").tag("gain")
            }
            .pickerStyle(.segmented)
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var paceCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Pace")
            Picker("Pace", selection: $pace) {
                Text("Slow").tag("slow")
                Text("Moderate").tag("moderate")
                Text("Aggressive").tag("aggressive")
            }
            .pickerStyle(.segmented)
            Text(paceDescription)
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
                .padding(.top, 2)
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var paceDescription: String {
        switch (direction, pace) {
        case ("lose", "slow"):       return "~250 kcal deficit/day · ~½ lb per week"
        case ("lose", "moderate"):   return "~400 kcal deficit/day · ~¾ lb per week"
        case ("lose", "aggressive"): return "~600 kcal deficit/day · ~1¼ lb per week"
        case ("gain", "slow"):       return "~250 kcal surplus/day · ~½ lb per week (lean gains)"
        case ("gain", "moderate"):   return "~300 kcal surplus/day · slightly faster gains"
        case ("gain", "aggressive"): return "~400 kcal surplus/day · faster but more fat gain"
        default:                     return "Maintenance — aim to match TDEE."
        }
    }

    private var targetCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("Target")
            HStack(spacing: 10) {
                fieldLabeled("Goal weight (lbs)") {
                    TextField(direction == "gain" ? "180" : "165", text: $goalWeightLbs)
                        .keyboardType(.decimalPad)
                        .textInputField()
                }
                fieldLabeled("Goal body fat %") {
                    TextField("15", text: $goalBodyFat)
                        .keyboardType(.decimalPad)
                        .textInputField()
                }
            }
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var calculatedCard: some View {
        // Compute against the IN-PROGRESS direction/pace in the form,
        // not the persisted body_metrics — gives the user a live preview
        // as they pick options.
        var preview = state.bodyMetrics
        preview.weight_goal = direction
        preview.pace = pace
        let calc = preview.calculatedTargets()
        let weeks = preview.weeksToGoal()

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionLabel("Calculated targets")
                Spacer()
                if let weeks {
                    Text("~\(weeks) weeks to goal")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
            }

            if let c = calc {
                HStack(spacing: 8) {
                    miniTile("kcal",  "\(c.calories ?? 0)",       Theme.cal)
                    miniTile("Protein", "\(c.protein ?? 0)g",     Theme.protein)
                    miniTile("Carbs",   "\(c.carbs ?? 0)g",       Theme.carbs)
                    miniTile("Fat",     "\(c.fat ?? 0)g",         Theme.fat)
                }
                Button {
                    applyCalculated(c)
                } label: {
                    Text("↓ Use these targets")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Theme.accentSoft(), in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.accent.opacity(0.3), lineWidth: 1))
                }
            } else {
                Text("Add weight / age / height in body metrics to see calculated targets.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 6)
            }
        }
        .padding(14)
        .background(Theme.bg3, in: .rect(cornerRadius: 12))
    }

    private var macroCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                sectionLabel("Daily macro targets")
                Spacer()
                Text("Override or use calculated")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
            }
            HStack(spacing: 8) {
                fieldLabeled("Calories") {
                    TextField("2000", text: $calories)
                        .keyboardType(.numberPad)
                        .textInputField()
                }
                fieldLabeled("Protein (g)") {
                    TextField("150", text: $protein)
                        .keyboardType(.numberPad)
                        .textInputField()
                }
            }
            HStack(spacing: 8) {
                fieldLabeled("Carbs (g)") {
                    TextField("220", text: $carbs)
                        .keyboardType(.numberPad)
                        .textInputField()
                }
                fieldLabeled("Fat (g)") {
                    TextField("60", text: $fat)
                        .keyboardType(.numberPad)
                        .textInputField()
                }
            }
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var actionRow: some View {
        Button {
            Task { await save() }
        } label: {
            HStack {
                if saving { ProgressView().tint(Theme.accentFG) }
                Text(saving ? "Saving…" : "Save goals")
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(Theme.accentFG)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Theme.accent, in: .rect(cornerRadius: 12))
        }
        .disabled(saving)
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

    private func miniTile(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(Theme.text3)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(Theme.bg2, in: .rect(cornerRadius: 8))
    }

    // MARK: - Actions

    private func hydrate() {
        let m = state.bodyMetrics
        direction = m.weight_goal ?? "lose"
        pace = m.pace ?? "moderate"
        if let g = m.goal_weight_kg { goalWeightLbs = String(format: "%.0f", g * 2.20462) }
        if let bf = m.goal_body_fat_pct { goalBodyFat = String(format: "%g", bf) }
        let g = state.goals
        calories = g.calories.map(String.init) ?? ""
        protein  = g.protein.map(String.init)  ?? ""
        carbs    = g.carbs.map(String.init)    ?? ""
        fat      = g.fat.map(String.init)      ?? ""
    }

    private func applyCalculated(_ c: Goals) {
        if let v = c.calories { calories = String(v) }
        if let v = c.protein  { protein  = String(v) }
        if let v = c.carbs    { carbs    = String(v) }
        if let v = c.fat      { fat      = String(v) }
    }

    private func save() async {
        saving = true
        errorMsg = nil
        defer { saving = false }
        do {
            // Build the next body_metrics row by patching the existing
            // one — we don't want to wipe sex/age/height/etc. that the
            // editor doesn't touch.
            var nextBM = state.bodyMetrics
            nextBM.weight_goal = direction
            nextBM.pace = pace
            nextBM.goal_weight_kg = Double(goalWeightLbs).map { $0 / 2.20462 }
            nextBM.goal_body_fat_pct = Double(goalBodyFat)
            try await state.saveBodyMetrics(nextBM)

            let nextGoals = Goals(
                calories: Int(calories.trimmingCharacters(in: .whitespaces)),
                protein:  Int(protein.trimmingCharacters(in: .whitespaces)),
                carbs:    Int(carbs.trimmingCharacters(in: .whitespaces)),
                fat:      Int(fat.trimmingCharacters(in: .whitespaces)),
                fiber:    state.goals.fiber
            )
            try await state.saveGoals(nextGoals)
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

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
