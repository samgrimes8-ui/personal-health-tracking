import SwiftUI

/// Modal for logging or editing a weight check-in. Mirrors the web
/// modal at lines 1141+ of pages/app.js — primary fields (weight + date)
/// always visible, optional body-fat / muscle / notes hidden behind a
/// disclosure to keep the typical "log my Sunday weigh-in" flow short.
///
/// Scan upload (InBody / DEXA) is intentionally NOT here yet — that's
/// the camera + AI extraction pipeline, which becomes Goals v2.
struct LogWeightSheet: View {
    /// nil = creating a new entry; non-nil = editing an existing row.
    let editing: CheckinRow?

    @Environment(AppState.self) private var state
    @Environment(AuthManager.self) private var auth
    @Environment(\.dismiss) private var dismiss

    @State private var weightLbs: String = ""
    @State private var date: Date = Date()
    @State private var bodyFatPct: String = ""
    @State private var muscleLbs: String = ""
    @State private var notes: String = ""
    @State private var showDetails: Bool = false
    @State private var saving: Bool = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    intro

                    primaryCard
                    detailsToggle
                    if showDetails {
                        detailsCard
                    }
                    notesField
                    if let errorMsg {
                        Text(errorMsg)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.red)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 8))
                    }

                    HStack(spacing: 10) {
                        Button("Cancel") { dismiss() }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Theme.bg3, in: .rect(cornerRadius: 10))
                            .foregroundStyle(Theme.text2)

                        Button {
                            Task { await save() }
                        } label: {
                            HStack {
                                if saving { ProgressView().tint(Theme.accentFG) }
                                Text(saving ? "Saving…" : (editing == nil ? "Save" : "Update"))
                                    .font(.system(size: 14, weight: .semibold))
                            }
                            .foregroundStyle(Theme.accentFG)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Theme.accent, in: .rect(cornerRadius: 10))
                        }
                        .disabled(saving || !canSave)
                        .opacity(canSave ? 1 : 0.6)
                    }
                    .padding(.top, 4)
                }
                .padding(20)
            }
            .background(Theme.bg)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(editing == nil ? "Log weight" : "Edit weigh-in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("×") { dismiss() }
                        .font(.system(size: 22))
                        .foregroundStyle(Theme.text3)
                }
            }
            .onAppear { hydrateFromEditing() }
        }
        .presentationDetents([.large])
    }

    // MARK: - Sections

    private var intro: some View {
        Text(editing == nil
            ? "Quick weigh-in. Tap **Add details** below if you've got body-fat or muscle numbers from a scale or scan."
            : "Update this entry's basic fields.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.text2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var primaryCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                fieldLabeled("Weight (lbs)") {
                    TextField("210", text: $weightLbs)
                        .keyboardType(.decimalPad)
                        .textInputField()
                }
                fieldLabeled("Date") {
                    DatePicker("", selection: $date, displayedComponents: .date)
                        .labelsHidden()
                        .datePickerStyle(.compact)
                }
            }
        }
        .padding(14)
        .background(Theme.bg3, in: .rect(cornerRadius: 12))
    }

    private var detailsToggle: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) { showDetails.toggle() }
        } label: {
            HStack {
                Text(showDetails ? "▾ Hide body composition" : "▸ Add body composition")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text3)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
        }
    }

    private var detailsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                fieldLabeled("Body fat %") {
                    TextField("17", text: $bodyFatPct)
                        .keyboardType(.decimalPad)
                        .textInputField()
                }
                fieldLabeled("Muscle (lbs)") {
                    TextField("101", text: $muscleLbs)
                        .keyboardType(.decimalPad)
                        .textInputField()
                }
            }
        }
        .padding(14)
        .background(Theme.bg3, in: .rect(cornerRadius: 12))
    }

    private var notesField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Notes")
                .font(.system(size: 11))
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            TextField("How are you feeling? Energy, sleep, stress…", text: $notes, axis: .vertical)
                .lineLimit(2...4)
                .textInputField()
        }
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

    // MARK: - Actions

    private var canSave: Bool {
        Double(weightLbs.trimmingCharacters(in: .whitespaces)) != nil
    }

    private func hydrateFromEditing() {
        guard let e = editing else { return }
        if let w = e.weight_kg { weightLbs = formatNum(w * 2.20462) }
        if let bf = e.body_fat_pct { bodyFatPct = formatNum(bf) }
        if let m = e.muscle_mass_kg { muscleLbs = formatNum(m * 2.20462) }
        notes = e.notes ?? ""
        let dateStr = e.scan_date ?? e.checked_in_at?.prefix(10).description
        if let dateStr {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.timeZone = .current
            if let parsed = f.date(from: dateStr) { date = parsed }
        }
        if e.body_fat_pct != nil || e.muscle_mass_kg != nil { showDetails = true }
    }

    private func save() async {
        guard let weightLbsValue = Double(weightLbs) else { return }
        saving = true
        errorMsg = nil
        defer { saving = false }
        let weightKg = weightLbsValue / 2.20462
        let bf = Double(bodyFatPct.trimmingCharacters(in: .whitespaces))
        let muscleKg = Double(muscleLbs.trimmingCharacters(in: .whitespaces)).map { $0 / 2.20462 }
        let dateF = DateFormatter()
        dateF.dateFormat = "yyyy-MM-dd"
        dateF.timeZone = .current
        let dateStr = dateF.string(from: date)
        let isoF = ISO8601DateFormatter()
        let payload = CheckinInsert(
            weightKg: weightKg,
            bodyFatPct: bf,
            muscleMassKg: muscleKg,
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes,
            scanDate: dateStr,
            checkedInAt: isoF.string(from: date)
        )
        do {
            let savedId: String?
            if let e = editing {
                try await state.updateCheckin(id: e.id, payload)
                savedId = e.id
            } else {
                let saved = try await state.saveCheckin(payload)
                savedId = saved.id
            }
            // Push to Apple Health if the user opted in. Only on new
            // entries to keep v1 simple — updating an existing weigh-in
            // would need to delete the old HK sample first to avoid
            // dupes, and that's not worth the complexity for now. The
            // editing == nil guard takes care of the "don't push on
            // edit" rule; the editing.healthkit_uuid != nil case is
            // covered too because edits never reach this branch.
            if editing == nil,
               let id = savedId,
               case .signedIn(let user) = auth.state {
                let userId = user.id.uuidString
                if HealthKitService.isToggleOn(.pushWeight, userId: userId) {
                    do {
                        let uuid = try await HealthKitService.shared.pushWeight(
                            checkinId: id, kg: weightKg, at: date
                        )
                        try await DBService.updateCheckinHealthKitUUID(
                            checkinId: id, healthkitUUID: uuid
                        )
                    } catch {
                        // Don't fail the save if the HK leg trips —
                        // the row is in our DB and that's the source
                        // of truth. Surface as a soft warning.
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
        return String(format: "%g", (x * 10).rounded() / 10)
    }
}

private extension View {
    /// Standard inset text-field styling matching the rest of the app.
    func textInputField() -> some View {
        self
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg2, in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
            .font(.system(size: 14))
            .foregroundStyle(Theme.text)
    }
}
