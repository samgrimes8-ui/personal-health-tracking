import SwiftUI

/// Editor for the Daily Targets card on the Goals page. Pushed from
/// the summary card on tap. Touches two tables under the hood:
/// body_metrics (direction, pace, target weight, target body-fat %)
/// and goals (cal / protein / carbs / fat targets). Both saved in
/// one tap — UI doesn't care which table a field lives on.
///
/// The "Use calculated" button populates the macro fields from
/// BMR/TDEE/direction/pace via the same formula the web uses
/// (calcTargetMacros mirrored in BodyMetrics.calculatedTargets()).
///
/// Lock-to-balance behavior on the four macro fields mirrors web
/// app.js:4598-4638 — pick which fields are fixed (locked) and which
/// auto-recalculate from the rest. Defaults: calories + fat locked,
/// carbs unlocks to balance the kcal arithmetic when the user nudges
/// any locked field.
///
/// "How are these calculated?" reveals the methodology sheet (BMR
/// formulas + TDEE multipliers + pace deficits) — same content as
/// the web's showMethodologyModal.
struct DailyTargetsDetailView: View {
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

    // Full-label opt-in goal targets (only rendered when toggle is on).
    // Empty string means "no target set" — saves as NULL.
    @State private var sodiumMax: String = ""
    @State private var fiberMin: String = ""
    @State private var satFatMax: String = ""
    @State private var addedSugarMax: String = ""

    // Lock state for macro lock-to-balance. Default: calories +
    // fat locked, carbs unlocks to balance.
    @State private var lockCal: Bool = true
    @State private var lockPro: Bool = false
    @State private var lockCarb: Bool = false
    @State private var lockFat: Bool = true

    @State private var showMethodology: Bool = false
    @State private var saving = false
    @State private var errorMsg: String?
    @FocusState private var keyboardFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                intro
                directionCard
                paceCard
                targetCard
                calculatedCard
                macroCard
                if state.goals.track_full_label == true {
                    fullLabelCard
                }
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
        .navigationTitle("Daily targets")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if keyboardFocused {
                    Button("Done") { keyboardFocused = false }
                }
            }
        }
        .onAppear { hydrate() }
        .sheet(isPresented: $showMethodology) {
            MethodologySheet()
        }
    }

    // MARK: - Sections

    private var intro: some View {
        Text("Direction + pace drive the recommended macros. Lock individual macro fields below to override — unlocked fields auto-balance to keep the calorie math consistent.")
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
                        .focused($keyboardFocused)
                        .textInputField()
                }
                fieldLabeled("Goal body fat %") {
                    TextField("15", text: $goalBodyFat)
                        .keyboardType(.decimalPad)
                        .focused($keyboardFocused)
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
                Button {
                    showMethodology = true
                } label: {
                    Image(systemName: "info.circle")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.text3)
                }
                .buttonStyle(.plain)
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
                .buttonStyle(.plain)
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
                Text("🔒 fixed · 🔓 auto-balances")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
            }
            HStack(spacing: 8) {
                lockableField(label: "Calories", text: $calories, color: Theme.cal,
                              isLocked: $lockCal, key: "cal")
                lockableField(label: "Protein (g)", text: $protein, color: Theme.protein,
                              isLocked: $lockPro, key: "pro")
            }
            HStack(spacing: 8) {
                lockableField(label: "Carbs (g)", text: $carbs, color: Theme.carbs,
                              isLocked: $lockCarb, key: "carb")
                lockableField(label: "Fat (g)", text: $fat, color: Theme.fat,
                              isLocked: $lockFat, key: "fat")
            }
            if let hint = balanceHint {
                Text(hint)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    // MARK: - Full-label goal targets (opt-in)

    /// Optional goal targets for the full-nutrition-label opt-in. FDA
    /// recommendations are pre-filled as placeholders so the user has a
    /// reasonable starting point. Empty fields persist as NULL — the
    /// dashboard simply won't show a target line for that field.
    private var fullLabelCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                sectionLabel("Full nutrition targets")
                Spacer()
                Text("Optional")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
            }
            HStack(spacing: 8) {
                fullLabelField("Sodium max (mg)", text: $sodiumMax, placeholder: "2300")
                fullLabelField("Fiber min (g)", text: $fiberMin, placeholder: "25")
            }
            HStack(spacing: 8) {
                fullLabelField("Sat. fat max (g)", text: $satFatMax, placeholder: "13")
                fullLabelField("Added sugar max (g)", text: $addedSugarMax, placeholder: "25")
            }
            Text("Defaults follow FDA daily-value guidance. Leave a field empty to skip that target.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private func fullLabelField(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 11))
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            TextField(placeholder, text: text)
                .keyboardType(.decimalPad)
                .focused($keyboardFocused)
                .textInputField()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// One-liner showing the current macro arithmetic so the user can
    /// see whether their lock combo balances. Mirrors the web's
    /// `macro-balance-hint` div.
    private var balanceHint: String? {
        guard let cal = Int(calories), let p = Int(protein), let c = Int(carbs), let f = Int(fat) else {
            return nil
        }
        let computed = p * 4 + c * 4 + f * 9
        let delta = computed - cal
        if abs(delta) <= 5 { return "Balanced ✓ (\(computed) kcal from macros)" }
        return delta > 0
            ? "Macros total \(computed) kcal — \(delta) over target"
            : "Macros total \(computed) kcal — \(-delta) under target"
    }

    private var actionRow: some View {
        Button {
            Task { await save() }
        } label: {
            HStack {
                if saving { ProgressView().tint(Theme.accentFG) }
                Text(saving ? "Saving…" : "Save targets")
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(Theme.accentFG)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Theme.accent, in: .rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(saving)
    }

    // MARK: - Lock-to-balance helpers

    /// One macro field with a lock toggle on the trailing side. Locked
    /// fields are read-only + slightly dimmed, and bumping any locked
    /// field re-runs `rebalance()` to push the deltas into the
    /// unlocked field(s).
    private func lockableField(label: String, text: Binding<String>, color: Color,
                                isLocked: Binding<Bool>, key: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label)
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.5)
                    .textCase(.uppercase)
                    .foregroundStyle(color)
                Spacer()
                Button {
                    isLocked.wrappedValue.toggle()
                    rebalance(changedKey: nil)
                } label: {
                    Text(isLocked.wrappedValue ? "🔒" : "🔓")
                        .font(.system(size: 12))
                        .opacity(isLocked.wrappedValue ? 1 : 0.4)
                }
                .buttonStyle(.plain)
            }
            TextField("0", text: text)
                .keyboardType(.numberPad)
                .focused($keyboardFocused)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.bg3, in: .rect(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(isLocked.wrappedValue ? Theme.border2 : color, lineWidth: 1)
                )
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.text)
                .opacity(isLocked.wrappedValue ? 0.7 : 1)
                .disabled(isLocked.wrappedValue)
                .onChange(of: text.wrappedValue) { _, _ in
                    rebalance(changedKey: key)
                }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Rebalance unlocked macros to keep arithmetic consistent with the
    /// locked ones. Mirrors web's rebalanceMacros.
    /// Strategy: if exactly one macro field is unlocked, recompute it
    /// from the kcal target − the locked macros' kcal contribution.
    /// If multiple are unlocked we bail (the user gets to nudge them
    /// freely until they pick which to lock).
    private func rebalance(changedKey: String?) {
        guard let cal = Int(calories) else { return }
        let p = Int(protein) ?? 0
        let c = Int(carbs) ?? 0
        let f = Int(fat) ?? 0

        // Calorie field unlocked? recompute calories from macros instead.
        if !lockCal {
            let computed = p * 4 + c * 4 + f * 9
            calories = String(computed)
            return
        }

        // Find the single unlocked macro field (other than cal).
        let unlocked = [
            ("pro", lockPro),
            ("carb", lockCarb),
            ("fat", lockFat),
        ].filter { !$0.1 }.map(\.0)

        guard unlocked.count == 1, let target = unlocked.first else { return }

        switch target {
        case "pro":
            let kcalLeft = max(0, cal - (c * 4) - (f * 9))
            protein = String(kcalLeft / 4)
        case "carb":
            let kcalLeft = max(0, cal - (p * 4) - (f * 9))
            carbs = String(kcalLeft / 4)
        case "fat":
            let kcalLeft = max(0, cal - (p * 4) - (c * 4))
            fat = String(kcalLeft / 9)
        default:
            break
        }
        _ = changedKey  // reserved if/when we want changedKey-aware rules
    }

    // MARK: - Building blocks

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

    // MARK: - Hydration / save

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
        sodiumMax     = g.sodium_mg_max.map { String(format: "%g", $0) } ?? ""
        fiberMin      = g.fiber_g_min.map  { String(format: "%g", $0) } ?? ""
        satFatMax     = g.saturated_fat_g_max.map { String(format: "%g", $0) } ?? ""
        addedSugarMax = g.sugar_added_g_max.map  { String(format: "%g", $0) } ?? ""
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
            // Patch onto the existing body_metrics row so we don't
            // overwrite fields the body-metrics editor owns
            // (sex/age/height/weight/BF/muscle/activity).
            var nextBM = state.bodyMetrics
            nextBM.weight_goal = direction
            nextBM.pace = pace
            nextBM.goal_weight_kg = Double(goalWeightLbs).map { $0 / 2.20462 }
            nextBM.goal_body_fat_pct = Double(goalBodyFat)
            try await state.saveBodyMetrics(nextBM)

            // Preserve the existing track_full_label flag so saving from
            // the targets editor doesn't accidentally flip the toggle.
            // Same goes for any micro target the user didn't edit.
            var nextGoals = state.goals
            nextGoals.calories = Int(calories.trimmingCharacters(in: .whitespaces))
            nextGoals.protein  = Int(protein.trimmingCharacters(in: .whitespaces))
            nextGoals.carbs    = Int(carbs.trimmingCharacters(in: .whitespaces))
            nextGoals.fat      = Int(fat.trimmingCharacters(in: .whitespaces))
            // Empty input means "no target" → NULL in the DB.
            func parseOptional(_ s: String) -> Double? {
                let t = s.trimmingCharacters(in: .whitespaces)
                return t.isEmpty ? nil : Double(t)
            }
            if state.goals.track_full_label == true {
                nextGoals.sodium_mg_max       = parseOptional(sodiumMax)
                nextGoals.fiber_g_min         = parseOptional(fiberMin)
                nextGoals.saturated_fat_g_max = parseOptional(satFatMax)
                nextGoals.sugar_added_g_max   = parseOptional(addedSugarMax)
            }
            try await state.saveGoals(nextGoals)
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

/// Methodology breakdown — explains how BMR / TDEE / target macros
/// are derived. Same content as web's showMethodologyModal. Shown
/// modally from the calculated targets card's info button.
private struct MethodologySheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    block(
                        title: "BMR (basal metabolic rate)",
                        body: "When body fat % is known we use **Katch-McArdle**: 370 + 21.6 × lean body mass (kg). Without body fat % we fall back to **Mifflin-St Jeor**: 10 × weight + 6.25 × height − 5 × age (+5 for male, −161 for female)."
                    )
                    block(
                        title: "TDEE (maintenance calories)",
                        body: "TDEE = BMR × activity multiplier:\n• Sedentary 1.2\n• Light 1.375\n• Moderate 1.55\n• Active 1.725\n• Very active 1.9"
                    )
                    block(
                        title: "Calorie target",
                        body: "Direction shifts TDEE up or down by your pace's daily kcal:\n• Lose: −250 / −400 / −600\n• Gain: +250 / +300 / +400\n• Maintain: 0\nMinimum target is 1200 kcal regardless of pace."
                    )
                    block(
                        title: "Protein target",
                        body: "1 g per pound of lean body mass. With body fat % we compute LBM exactly; without it we estimate LBM as 75% of total body weight."
                    )
                    block(
                        title: "Fat & carbs",
                        body: "Fat is 25% of the calorie target (then ÷ 9). Carbs absorb the remainder (then ÷ 4), with a 50 g floor so very low-fat / high-protein splits don't drive carbs below sustainable levels."
                    )
                }
                .padding(20)
            }
            .background(Theme.bg)
            .navigationTitle("How we calculate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func block(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text(.init(body))
                .font(.system(size: 13))
                .foregroundStyle(Theme.text2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
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
