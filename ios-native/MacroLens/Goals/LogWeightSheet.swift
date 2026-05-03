import SwiftUI
import PhotosUI

/// Modal for logging or editing a weight check-in. Mirrors the web
/// modal at app.js:7041+ — scan upload at the top (auto-fills the
/// weight / body-fat / muscle inputs below), basic fields always
/// visible, optional body-fat / muscle / notes hidden behind a
/// disclosure to keep a quick weigh-in short.
///
/// Scan upload wires through ScanService.extractBodyScan + uploadScan
/// (mirrors handleScanUpload + saveCheckinHandler in app.js): pick a
/// photo → AI extracts 35 fields → values flow into the form +
/// the BodyScanExtract is held until Save, when the file uploads
/// to storage and the full extracted shape is splatted onto the
/// checkin row.
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

    // Scan upload state — only relevant when creating a new entry.
    @State private var pickedScanImage: UIImage?
    @State private var scanPhotoSelection: PhotosPickerItem?
    @State private var showScanCamera: Bool = false
    @State private var scanExtract: BodyScanExtract?
    @State private var extracting: Bool = false
    @State private var scanStatus: String?
    @FocusState private var keyboardFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    intro

                    // Scan upload only on new entries — editing an
                    // existing scan row leaves the original file
                    // attached and only patches basic fields, matching
                    // web's update path.
                    if editing == nil {
                        scanCard
                    } else if editing?.scan_file_path != nil || editing?.scan_type != nil {
                        scanAttachedBadge
                    }

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
                        .disabled(saving || extracting || !canSave)
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
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    if keyboardFocused {
                        Button("Done") { keyboardFocused = false }
                    }
                }
            }
            .onAppear { hydrateFromEditing() }
            .sheet(isPresented: $showScanCamera) {
                CameraSheet(image: $pickedScanImage)
                    .ignoresSafeArea()
            }
            .onChange(of: scanPhotoSelection) { _, newItem in
                guard let newItem else { return }
                Task {
                    if let data = try? await newItem.loadTransferable(type: Data.self),
                       let img = UIImage(data: data) {
                        pickedScanImage = img
                    }
                }
            }
            .onChange(of: pickedScanImage) { _, newImg in
                guard newImg != nil else { return }
                Task { await runScanExtraction() }
            }
        }
        .presentationDetents([.large])
    }

    // MARK: - Sections

    private var intro: some View {
        Text(editing == nil
            ? "Quick weigh-in or upload an InBody / DEXA scan — AI extracts body composition automatically."
            : "Update this entry's basic fields.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.text2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var scanCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "doc.text.image")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                Text("InBody / DEXA scan")
                    .font(.system(size: 11, weight: .medium))
                    .tracking(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.text3)
            }

            if let img = pickedScanImage {
                ZStack(alignment: .topTrailing) {
                    Image(uiImage: img)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 200)
                        .frame(maxWidth: .infinity)
                        .background(Theme.bg2, in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
                    Button {
                        clearScan()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 22))
                            .foregroundStyle(.white, .black.opacity(0.55))
                    }
                    .padding(6)
                }
            } else {
                Text("Photograph your InBody printout or DEXA report — we'll fill in your body composition automatically.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: 8) {
                Button { showScanCamera = true } label: {
                    Label("Camera", systemImage: "camera")
                        .font(.system(size: 13, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Theme.bg2, in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                }
                .buttonStyle(.plain)
                PhotosPicker(selection: $scanPhotoSelection, matching: .images, photoLibrary: .shared()) {
                    Label("Library", systemImage: "photo.on.rectangle")
                        .font(.system(size: 13, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Theme.bg2, in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                }
            }
            .disabled(extracting)

            if extracting {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Extracting metrics…")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }
            } else if let scanStatus {
                Text(scanStatus)
                    .font(.system(size: 12))
                    .foregroundStyle(scanExtract != nil ? Theme.protein : Theme.text3)
            }
        }
        .padding(14)
        .background(Theme.bg3, in: .rect(cornerRadius: 12))
    }

    private var scanAttachedBadge: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text.image.fill")
                .font(.system(size: 14))
                .foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(editing?.scan_type?.uppercased() ?? "Scan") attached")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text)
                Text("Body composition fields stay locked to the original scan.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
            Spacer()
        }
        .padding(12)
        .background(Theme.accent.opacity(0.08), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.25), lineWidth: 1))
    }

    private var primaryCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                fieldLabeled("Weight (lbs)") {
                    TextField("210", text: $weightLbs)
                        .keyboardType(.decimalPad)
                        .focused($keyboardFocused)
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
                        .focused($keyboardFocused)
                        .textInputField()
                }
                fieldLabeled("Muscle (lbs)") {
                    TextField("101", text: $muscleLbs)
                        .keyboardType(.decimalPad)
                        .focused($keyboardFocused)
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
                .focused($keyboardFocused)
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
        if e.scan_type != nil { showDetails = true }
    }

    private func clearScan() {
        pickedScanImage = nil
        scanPhotoSelection = nil
        scanExtract = nil
        scanStatus = nil
    }

    @MainActor
    private func runScanExtraction() async {
        guard let img = pickedScanImage else { return }
        extracting = true
        scanStatus = nil
        defer { extracting = false }

        let resized = img.resizedForAnalysis()
        guard let b64 = resized.jpegBase64() else {
            scanStatus = "Couldn't encode the image. Try again."
            return
        }
        do {
            // 30s timeout matches the web's handleScanUpload — beyond
            // that, the user's better off filling in values manually.
            let extract = try await withTimeout(seconds: 30) {
                try await ScanService.extractBodyScan(imageBase64: b64, mediaType: "image/jpeg")
            }
            scanExtract = extract
            applyExtractToFields(extract)

            // Build a status string that confirms what we read off the
            // scan, mirroring web's "Extracted: 200lbs, 17% BF" toast.
            var parts: [String] = []
            if let w = extract.weight_kg { parts.append(String(format: "%.1f lbs", w * 2.20462)) }
            if let bf = extract.body_fat_pct { parts.append("\(String(format: "%g", bf))% BF") }
            if let mm = extract.muscle_mass_kg { parts.append(String(format: "%.1f lbs muscle", mm * 2.20462)) }
            scanStatus = parts.isEmpty
                ? "Scan attached — fill in values manually."
                : "Extracted: " + parts.joined(separator: " · ")
            showDetails = true
        } catch {
            // Match web behavior: keep the file attached, surface the
            // failure, let the user fill in values manually then save.
            scanExtract = nil
            scanStatus = "Auto-extract failed — enter values manually then Save."
        }
    }

    private func applyExtractToFields(_ e: BodyScanExtract) {
        if let w = e.weight_kg { weightLbs = formatNum(w * 2.20462) }
        if let bf = e.body_fat_pct { bodyFatPct = formatNum(bf) }
        if let mm = e.muscle_mass_kg { muscleLbs = formatNum(mm * 2.20462) }
        if let scanDate = e.scan_date {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.timeZone = .current
            if let parsed = f.date(from: scanDate) { date = parsed }
        }
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

        // If a scan is pending, upload the file first so the path can
        // ride along on the insert. Failure here is non-fatal (web does
        // the same) — we always save the row regardless of upload
        // outcome so the user's data lands.
        var scanPayload: CheckinScanPayload? = nil
        if editing == nil, let extract = scanExtract, let img = pickedScanImage {
            let resized = img.resizedForAnalysis()
            if let jpeg = resized.jpegData(compressionQuality: 0.85) {
                let path = try? await ScanService.uploadScan(data: jpeg, fileExtension: "jpg", contentType: "image/jpeg")
                scanPayload = CheckinScanPayload(filePath: path, extract: extract)
            }
        }

        let payload = CheckinInsert(
            weightKg: weightKg,
            bodyFatPct: bf,
            muscleMassKg: muscleKg,
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes,
            scanDate: dateStr,
            checkedInAt: isoF.string(from: date),
            scan: scanPayload
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

// MARK: - Timeout helper

private struct TimeoutError: LocalizedError {
    var errorDescription: String? { "Timed out" }
}

private func withTimeout<T: Sendable>(seconds: Double, _ op: @Sendable @escaping () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await op() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw TimeoutError()
        }
        let result = try await group.next()!
        group.cancelAll()
        return result
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
