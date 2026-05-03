import SwiftUI

/// Full editor for the Body Metrics card on the Goals page. Pushed
/// from the summary card on tap. Mirrors the body-metrics block of
/// renderGoalsPage at src/pages/app.js:4823-4900 — same field set,
/// same units toggle, same live BMR/TDEE preview using the formulas
/// already in BodyMetrics.swift (Katch-McArdle when body fat % is
/// known, Mifflin-St Jeor otherwise).
///
/// Saves go through state.saveBodyMetrics — that helper already
/// patches the rest of the row (goal_weight, weight_goal, pace, etc.)
/// from the in-memory copy, so editing here doesn't blank fields the
/// Daily Targets editor owns.
struct BodyMetricsDetailView: View {
    @Environment(AppState.self) private var state
    @Environment(AuthManager.self) private var auth
    @Environment(\.dismiss) private var dismiss

    private static let imperialKey = "macrolens.units.imperial"

    @State private var isImperial: Bool = true
    @State private var sex: String = "male"
    @State private var ageStr: String = ""
    @State private var heightCmStr: String = ""
    @State private var heightFtStr: String = ""
    @State private var heightInStr: String = ""
    @State private var weightStr: String = ""
    @State private var bodyFatStr: String = ""
    @State private var muscleStr: String = ""
    @State private var activity: String = "moderate"

    /// Captured on appear so we can detect whether the user actually
    /// changed weight (vs just edited height/age/etc). Drives the
    /// "Also log this as today's weigh-in" toggle visibility — no
    /// point asking the user to log a checkin if weight didn't move.
    @State private var originalWeightKg: Double?
    /// Default ON: when weight changes, the common case is "yep, log
    /// it" — one save tap covers both writes. Toggle resets to true
    /// any time weight returns to the original (so a re-edit defaults
    /// back to ON, matching the spec).
    @State private var alsoLogCheckin: Bool = true

    @State private var saving = false
    @State private var errorMsg: String?
    @FocusState private var keyboardFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                intro
                unitsToggle
                sexAgeCard
                heightWeightCard
                if weightChanged { logCheckinToggle }
                compositionCard
                activityCard
                calcSummary
                if let errorMsg {
                    Text(errorMsg)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.red)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 8))
                }
                saveButton
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .padding(.bottom, 30)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Body metrics")
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
    }

    // MARK: - Sections

    private var intro: some View {
        Text("Used to calculate your BMR and TDEE — the maintenance calorie target your daily macros are scaled from.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.text2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var unitsToggle: some View {
        Picker("Units", selection: $isImperial) {
            Text("lbs / ft").tag(true)
            Text("kg / cm").tag(false)
        }
        .pickerStyle(.segmented)
        .onChange(of: isImperial) { _, _ in convertHeightWeightOnUnitChange() }
    }

    private var sexAgeCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("Identity")
            HStack(spacing: 10) {
                fieldLabeled("Sex") {
                    Picker("Sex", selection: $sex) {
                        Text("Male").tag("male")
                        Text("Female").tag("female")
                    }
                    .pickerStyle(.segmented)
                }
                fieldLabeled("Age") {
                    TextField("30", text: $ageStr)
                        .keyboardType(.numberPad)
                        .focused($keyboardFocused)
                        .textInputField()
                }
            }
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var heightWeightCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("Body")
            if isImperial {
                HStack(spacing: 10) {
                    fieldLabeled("Height (ft)") {
                        TextField("5", text: $heightFtStr)
                            .keyboardType(.numberPad)
                            .focused($keyboardFocused)
                            .textInputField()
                    }
                    fieldLabeled("Height (in)") {
                        TextField("10", text: $heightInStr)
                            .keyboardType(.decimalPad)
                            .focused($keyboardFocused)
                            .textInputField()
                    }
                }
                fieldLabeled("Current weight (lbs)") {
                    TextField("175", text: $weightStr)
                        .keyboardType(.decimalPad)
                        .focused($keyboardFocused)
                        .textInputField()
                }
            } else {
                HStack(spacing: 10) {
                    fieldLabeled("Height (cm)") {
                        TextField("175", text: $heightCmStr)
                            .keyboardType(.decimalPad)
                            .focused($keyboardFocused)
                            .textInputField()
                    }
                    fieldLabeled("Weight (kg)") {
                        TextField("80", text: $weightStr)
                            .keyboardType(.decimalPad)
                            .focused($keyboardFocused)
                            .textInputField()
                    }
                }
            }
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var compositionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("Composition (optional)")
            HStack(spacing: 10) {
                fieldLabeled("Body fat %") {
                    TextField("17", text: $bodyFatStr)
                        .keyboardType(.decimalPad)
                        .focused($keyboardFocused)
                        .textInputField()
                }
                fieldLabeled(isImperial ? "Muscle (lbs)" : "Muscle (kg)") {
                    TextField(isImperial ? "100" : "45", text: $muscleStr)
                        .keyboardType(.decimalPad)
                        .focused($keyboardFocused)
                        .textInputField()
                }
            }
            Text("Body fat % unlocks the more accurate Katch-McArdle BMR formula. Without it we fall back to Mifflin-St Jeor (height + age + sex).")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var activityCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("Activity")
            // Picker with full-text labels matching app.js:4872-4878.
            Picker("Activity", selection: $activity) {
                Text("Sedentary (desk job, no exercise)").tag("sedentary")
                Text("Light (1–3x / week)").tag("light")
                Text("Moderate (3–5x / week)").tag("moderate")
                Text("Active (6–7x / week)").tag("active")
                Text("Very active (2x / day or physical job)").tag("very_active")
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Theme.bg3, in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
            .tint(Theme.accent)
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    /// Live BMR / TDEE preview tiles + the formula-source caption.
    /// Recomputes on every keystroke via the previewMetrics computed
    /// property, so the user sees their numbers move as they type.
    private var calcSummary: some View {
        let m = previewMetrics
        let bmr = m.bmr
        let tdee = m.tdee
        let formulaNote: String = {
            if m.body_fat_pct != nil {
                return "✓ Using Katch-McArdle (body fat % known — most accurate)"
            }
            if m.weight_kg != nil && m.height_cm != nil && m.age != nil {
                return "Using Mifflin-St Jeor — add body fat % for tighter accuracy"
            }
            return "Add weight + (body fat % OR height + age) to compute BMR / TDEE"
        }()

        return VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Calculated targets")
            HStack(spacing: 10) {
                summaryTile("BMR", bmr.map { "\($0)" } ?? "—", "kcal at rest", Theme.accent)
                summaryTile("TDEE", tdee.map { "\($0)" } ?? "—", "maintenance", Theme.protein)
            }
            Text(formulaNote)
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(Theme.bg3, in: .rect(cornerRadius: 12))
    }

    private var saveButton: some View {
        Button {
            Task { await save() }
        } label: {
            HStack {
                if saving { ProgressView().tint(Theme.accentFG) }
                Text(saving ? "Saving…" : "Save")
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

    /// Inline checkbox row revealed only when the user has changed the
    /// weight value. Gives them an opt-out for the auto-checkin write
    /// (default ON, matching the common Sunday-weigh-in case). Reverting
    /// the weight to its original hides the toggle and resets it to ON
    /// via .onChange below — so a re-edit defaults back to ON.
    private var logCheckinToggle: some View {
        Toggle(isOn: $alsoLogCheckin) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Also log this as today's weigh-in")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text)
                Text("Adds a check-in row + updates the weight chart" + (pushWeightOn ? " · syncs to Apple Health" : ""))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
        }
        .tint(Theme.accent)
        .padding(14)
        .background(Theme.accent.opacity(0.08), in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.accent.opacity(0.25), lineWidth: 1))
        .onChange(of: weightChanged) { _, isChanged in
            // When weight bounces back to original (toggle disappears),
            // reset to default ON so the next bona-fide change re-shows
            // the toggle pre-checked.
            if !isChanged { alsoLogCheckin = true }
        }
    }

    /// Whether the user's edited weight differs from the value we
    /// captured on appear. Compares kg-with-tolerance so toggling
    /// imperial ↔ metric units doesn't falsely flag a change (the
    /// lbs ↔ kg round-trip introduces sub-decimal noise).
    private var weightChanged: Bool {
        let current = currentWeightKg()
        switch (current, originalWeightKg) {
        case (nil, nil):
            return false
        case (.some, nil), (nil, .some):
            return true
        case (let c?, let o?):
            return abs(c - o) >= 0.05   // ~0.1 lb tolerance
        }
    }

    /// True iff the user has the Apple Health weight-push toggle on for
    /// the current session. Used to color the checkbox subtitle so the
    /// user knows their save is going beyond just our DB.
    private var pushWeightOn: Bool {
        guard case .signedIn(let user) = auth.state else { return false }
        return HealthKitService.isToggleOn(.pushWeight, userId: user.id.uuidString)
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

    private func summaryTile(_ label: String, _ value: String, _ caption: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.system(size: 10))
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            Text(value)
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(color)
            Text(caption)
                .font(.system(size: 10))
                .foregroundStyle(Theme.text3)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Theme.bg2, in: .rect(cornerRadius: 10))
    }

    // MARK: - Hydration / persistence

    private func hydrate() {
        let m = state.bodyMetrics
        // Read the unit preference from the same UserDefaults key the
        // Analytics tab uses, defaulting to imperial when absent.
        if UserDefaults.standard.object(forKey: Self.imperialKey) == nil {
            isImperial = true
        } else {
            isImperial = UserDefaults.standard.bool(forKey: Self.imperialKey)
        }

        sex = m.sex ?? "male"
        ageStr = m.age.map(String.init) ?? ""
        activity = m.activity_level ?? "moderate"
        bodyFatStr = m.body_fat_pct.map { formatNum($0) } ?? ""

        if let cm = m.height_cm {
            heightCmStr = formatNum(cm)
            let totalIn = cm / 2.54
            heightFtStr = String(Int(totalIn / 12))
            heightInStr = formatNum((totalIn.truncatingRemainder(dividingBy: 12)).rounded(toPlaces: 1))
        }
        if let kg = m.weight_kg {
            weightStr = isImperial ? formatNum((kg * 2.20462).rounded(toPlaces: 1)) : formatNum(kg)
        }
        if let mu = m.muscle_mass_kg {
            muscleStr = isImperial ? formatNum((mu * 2.20462).rounded(toPlaces: 1)) : formatNum(mu)
        }
        // Anchor for the weightChanged comparison. Captured ONCE here;
        // editing weightStr later flips weightChanged true → reveals
        // the "also log a checkin" toggle.
        originalWeightKg = m.weight_kg
    }

    /// When the user flips the unit toggle, convert the in-flight
    /// strings so the displayed value stays consistent — a typed-in
    /// 175 lbs becomes 79.4 kg, not "175 kg".
    private func convertHeightWeightOnUnitChange() {
        UserDefaults.standard.set(isImperial, forKey: Self.imperialKey)
        if isImperial {
            // metric → imperial
            if let cm = Double(heightCmStr) {
                let totalIn = cm / 2.54
                heightFtStr = String(Int(totalIn / 12))
                heightInStr = formatNum((totalIn.truncatingRemainder(dividingBy: 12)).rounded(toPlaces: 1))
            }
            if let kg = Double(weightStr) {
                weightStr = formatNum((kg * 2.20462).rounded(toPlaces: 1))
            }
            if let kg = Double(muscleStr) {
                muscleStr = formatNum((kg * 2.20462).rounded(toPlaces: 1))
            }
        } else {
            // imperial → metric
            if let cm = currentHeightCm() {
                heightCmStr = formatNum(cm.rounded(toPlaces: 1))
            }
            if let lbs = Double(weightStr) {
                weightStr = formatNum((lbs / 2.20462).rounded(toPlaces: 2))
            }
            if let lbs = Double(muscleStr) {
                muscleStr = formatNum((lbs / 2.20462).rounded(toPlaces: 2))
            }
        }
    }

    private func currentHeightCm() -> Double? {
        if isImperial {
            let ft = Double(heightFtStr) ?? 0
            let inches = Double(heightInStr) ?? 0
            let total = ft * 12 + inches
            return total > 0 ? total * 2.54 : nil
        } else {
            return Double(heightCmStr)
        }
    }

    private func currentWeightKg() -> Double? {
        guard let w = Double(weightStr.trimmingCharacters(in: .whitespaces)) else { return nil }
        return isImperial ? w / 2.20462 : w
    }

    private func currentMuscleKg() -> Double? {
        guard let v = Double(muscleStr.trimmingCharacters(in: .whitespaces)), v > 0 else { return nil }
        return isImperial ? v / 2.20462 : v
    }

    /// Builds an in-memory BodyMetrics shape from the current form
    /// values so the calc tiles can preview live without saving.
    /// Patches over state.bodyMetrics so unrelated fields (goal weight,
    /// pace, etc.) ride through and show in the preview consistently.
    private var previewMetrics: BodyMetrics {
        var m = state.bodyMetrics
        m.sex = sex
        m.age = Int(ageStr.trimmingCharacters(in: .whitespaces))
        m.height_cm = currentHeightCm()
        m.weight_kg = currentWeightKg()
        m.body_fat_pct = Double(bodyFatStr.trimmingCharacters(in: .whitespaces))
        m.muscle_mass_kg = currentMuscleKg()
        m.activity_level = activity
        return m
    }

    private func save() async {
        saving = true
        errorMsg = nil
        defer { saving = false }
        do {
            // 1. Always upsert body_metrics with the form values.
            let nextBM = previewMetrics
            try await state.saveBodyMetrics(nextBM)

            // 2. If the user changed weight and kept the "also log" box
            //    checked, write a checkins row + push to HealthKit. We
            //    reuse state.saveCheckin and the same HK pattern as
            //    LogWeightSheet (don't duplicate the insert logic).
            if weightChanged, alsoLogCheckin, let weightKg = nextBM.weight_kg {
                let now = Date()
                let dateF = DateFormatter()
                dateF.dateFormat = "yyyy-MM-dd"
                dateF.timeZone = .current
                let payload = CheckinInsert(
                    weightKg: weightKg,
                    bodyFatPct: nextBM.body_fat_pct,
                    muscleMassKg: nextBM.muscle_mass_kg,
                    notes: nil,
                    scanDate: dateF.string(from: now),
                    checkedInAt: ISO8601DateFormatter().string(from: now),
                    scan: nil
                )
                let saved = try await state.saveCheckin(payload)
                // Apple Health push — same flow as LogWeightSheet. Soft-
                // fails so a HK glitch doesn't block the body-metrics
                // save (DB is the source of truth).
                if case .signedIn(let user) = auth.state,
                   HealthKitService.isToggleOn(.pushWeight, userId: user.id.uuidString) {
                    do {
                        let uuid = try await HealthKitService.shared.pushWeight(
                            checkinId: saved.id, kg: weightKg, at: now
                        )
                        try await DBService.updateCheckinHealthKitUUID(
                            checkinId: saved.id, healthkitUUID: uuid
                        )
                    } catch {
                        errorMsg = "Saved, but couldn't push to Apple Health: \(error.localizedDescription)"
                        return
                    }
                }
            }
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func formatNum(_ x: Double) -> String {
        if x == x.rounded() { return String(Int(x)) }
        return String(format: "%g", x)
    }
}

private extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let mult = pow(10.0, Double(places))
        return (self * mult).rounded() / mult
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
