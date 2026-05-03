import SwiftUI
import PhotosUI

/// Refine an existing food_items row by re-running it through one of
/// the analyze paths (barcode lookup / nutrition-label photo / AI text
/// search), then committing only the fields the user accepts. Lets a
/// food added long ago with limited macro info pick up serving grams,
/// the full nutrition label, etc. without a manual delete + re-add.
///
/// The flow is two-stage:
///   1. Source picker — Scan barcode / Photo of label / AI search.
///      Source-specific input UI runs and produces an AnalysisResult.
///      AI search may return multiple candidates; we surface the
///      candidate picker (mirrors AnalyzeFoodSection's picker) before
///      moving on to the diff.
///   2. Diff sheet — per-field check rows with current → suggested
///      values. "Apply" writes the selected fields via
///      DBService.updateFoodItem and dismisses; the parent re-hydrates.
///
/// Identity fields (name / brand / components / notes) the user
/// customized are NEVER auto-overwritten beyond what the spec allows
/// (brand is included with default-on, name is excluded entirely).
struct RefineFoodSheet: View {
    @Environment(\.dismiss) private var dismiss
    let item: FoodItemRow
    let onApply: (FoodItemRow) -> Void

    private enum Stage: Equatable {
        case sourcePick
        case running(String)            // status text
        case candidatePicker            // AI returned >1 candidates
        case diff(AnalysisResult)
    }

    @State private var stage: Stage = .sourcePick
    @State private var aiQuery: String = ""
    @State private var showScanner: Bool = false
    @State private var labelPhoto: UIImage?
    @State private var photoSelection: PhotosPickerItem?
    @State private var candidates: [AnalysisResult] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if item.components?.isEmpty == false {
                        comboWarning
                    }
                    switch stage {
                    case .sourcePick:
                        sourcePickerCard
                    case .running(let status):
                        runningCard(status)
                    case .candidatePicker:
                        candidateList
                    case .diff(let result):
                        DiffList(item: item, result: result, onApply: applyPatch, onCancel: resetToSource)
                    }
                    if let error {
                        errorBanner(error)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg)
            .navigationTitle("Refine food")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.text3)
                }
            }
            .onAppear {
                if aiQuery.isEmpty { aiQuery = item.name }
            }
            .fullScreenCover(isPresented: $showScanner) {
                BarcodeScannerView(
                    onDetect: { code in
                        showScanner = false
                        Task { await runBarcodeLookup(code) }
                    },
                    onCancel: { showScanner = false }
                )
            }
            .onChange(of: photoSelection) { _, newItem in
                Task {
                    guard let data = try? await newItem?.loadTransferable(type: Data.self),
                          let img = UIImage(data: data) else { return }
                    labelPhoto = img
                    await runLabelPhoto(img)
                }
            }
        }
    }

    // MARK: - Combo warning

    private var comboWarning: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.fat)
                .font(.system(size: 13))
            Text("This food has components. Refine writes to top-level macros only — the component list stays as-is.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.fat.opacity(0.08), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.fat.opacity(0.25), lineWidth: 1))
    }

    // MARK: - Source picker

    private var sourcePickerCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pick a source for fresher macro data:")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text2)

            sourceButton(
                icon: "barcode.viewfinder",
                title: "Scan barcode",
                subtitle: "Look up the product in Open Food Facts."
            ) {
                error = nil
                showScanner = true
            }

            // PhotosPicker as its own card — its label IS the
            // tappable target, so we get the same visual + behavior as
            // the other source rows without the overlay-hack.
            PhotosPicker(selection: $photoSelection,
                         matching: .images,
                         photoLibrary: .shared()) {
                sourceCardContent(
                    icon: "photo.on.rectangle.angled",
                    title: "Photo of nutrition label",
                    subtitle: "Read the panel directly — most accurate for packaged foods."
                )
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 8) {
                sourceButton(
                    icon: "sparkles",
                    title: "AI search",
                    subtitle: "Estimate from a name. Best when there's no barcode or label."
                ) {
                    error = nil
                    Task { await runAISearch() }
                }
                TextField("e.g. \(item.name)", text: $aiQuery)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text)
                    .autocorrectionDisabled()
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(Theme.bg3, in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
            }
        }
    }

    private func sourceButton(icon: String, title: String, subtitle: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            sourceCardContent(icon: icon, title: title, subtitle: subtitle)
        }
        .buttonStyle(.plain)
    }

    private func sourceCardContent(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(Theme.accent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
                    .multilineTextAlignment(.leading)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    // MARK: - Running spinner

    private func runningCard(_ status: String) -> some View {
        VStack(spacing: 12) {
            ProgressView().tint(Theme.accent)
            Text(status)
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
        }
        .frame(maxWidth: .infinity)
        .padding(28)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    // MARK: - Candidate picker (AI multi-result)

    private var candidateList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Pick the closest match")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.text)
            ForEach(Array(candidates.enumerated()), id: \.offset) { _, c in
                Button {
                    stage = .diff(c)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(c.name)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Theme.text)
                        if let serving = c.serving_description, !serving.isEmpty {
                            Text(serving)
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.text2)
                        }
                        Text("\(Int(c.calories.rounded())) kcal · P\(Int(c.protein.rounded())) C\(Int(c.carbs.rounded())) F\(Int(c.fat.rounded()))")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text3)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bg2, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            Button("Try a different source") {
                resetToSource()
            }
            .font(.system(size: 12))
            .foregroundStyle(Theme.text3)
            .padding(.top, 4)
        }
    }

    // MARK: - Errors / reset

    private func errorBanner(_ msg: String) -> some View {
        Text(msg)
            .font(.system(size: 12))
            .foregroundStyle(Theme.red)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 8))
    }

    private func resetToSource() {
        stage = .sourcePick
        candidates = []
    }

    // MARK: - Source actions

    private func runBarcodeLookup(_ code: String) async {
        let digits = code.filter(\.isNumber)
        guard !digits.isEmpty else { return }
        stage = .running("Looking up \(digits)…")
        do {
            if let result = try await BarcodeService.lookup(digits) {
                stage = .diff(result)
            } else {
                error = "No match found for \(digits). Try a label photo or AI search."
                stage = .sourcePick
            }
        } catch {
            self.error = "Barcode lookup failed: \(error.localizedDescription)"
            stage = .sourcePick
        }
    }

    private func runLabelPhoto(_ image: UIImage) async {
        stage = .running("Reading nutrition label…")
        guard let b64 = image.resizedForAnalysis().jpegBase64() else {
            error = "Couldn't encode the photo."
            stage = .sourcePick
            return
        }
        do {
            let result = try await AnalyzeService.analyzeNutritionLabel(b64)
            stage = .diff(result)
        } catch {
            self.error = "Label read failed: \(error.localizedDescription)"
            stage = .sourcePick
        }
    }

    private func runAISearch() async {
        let q = aiQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            error = "Type a name to search."
            return
        }
        stage = .running("Asking the AI…")
        do {
            let list = try await AnalyzeService.describeFoodCandidates(q)
            if list.count > 1 {
                candidates = list
                stage = .candidatePicker
            } else if let only = list.first {
                stage = .diff(only)
            } else {
                error = "No matches. Try a different phrasing."
                stage = .sourcePick
            }
        } catch {
            self.error = "AI search failed: \(error.localizedDescription)"
            stage = .sourcePick
        }
    }

    // MARK: - Apply

    private func applyPatch(_ patch: FoodItemPatch) async {
        stage = .running("Saving changes…")
        do {
            let updated = try await DBService.updateFoodItem(id: item.id, patch)
            onApply(updated)
            dismiss()
        } catch {
            self.error = "Couldn't save: \(error.localizedDescription)"
            stage = .sourcePick
        }
    }
}

// MARK: - Diff list

/// Per-field diff with checkboxes. Builds a list of `Suggestion` rows
/// for every field where the analyze result differs from the current
/// value (or where current is null and the result has a value), then
/// renders them as toggleable rows. "Apply" produces a FoodItemPatch
/// containing only the toggled-on fields.
private struct DiffList: View {
    let item: FoodItemRow
    let result: AnalysisResult
    let onApply: (FoodItemPatch) async -> Void
    let onCancel: () -> Void

    @State private var selected: Set<Suggestion.Field> = []
    @State private var applying = false

    var body: some View {
        let suggestions = Suggestion.build(item: item, result: result)
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Suggested changes")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Spacer()
                Button("Select all") {
                    selected = Set(suggestions.map(\.field))
                }
                .font(.system(size: 12))
                .foregroundStyle(Theme.accent)
                .disabled(suggestions.isEmpty)
                Text("·").foregroundStyle(Theme.text3)
                Button("Select none") {
                    selected.removeAll()
                }
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
                .disabled(suggestions.isEmpty)
            }

            if suggestions.isEmpty {
                Text("Nothing to update — the new data matches what's already saved.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text3)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bg2, in: .rect(cornerRadius: 10))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(suggestions.enumerated()), id: \.offset) { idx, s in
                        diffRow(s)
                        if idx < suggestions.count - 1 {
                            Divider().background(Theme.border)
                        }
                    }
                }
                .background(Theme.bg2, in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
            }

            HStack(spacing: 10) {
                Button("Back") { onCancel() }
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.bg3, in: .rect(cornerRadius: 10))

                Button {
                    Task {
                        applying = true
                        defer { applying = false }
                        let picked = suggestions.filter { selected.contains($0.field) }
                        let patch = Suggestion.buildPatch(picked)
                        await onApply(patch)
                    }
                } label: {
                    HStack {
                        if applying { ProgressView().tint(Theme.accentFG) }
                        Text(applying ? "Applying…" : "Apply changes")
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(Theme.accentFG)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.accent, in: .rect(cornerRadius: 10))
                }
                .disabled(applying || selected.isEmpty)
                .opacity(selected.isEmpty ? 0.5 : 1)
            }
        }
        .onAppear {
            // Default ON for every suggestion — user can flip off the
            // ones they don't trust. Matches the UX spec.
            selected = Set(Suggestion.build(item: item, result: result).map(\.field))
        }
    }

    private func diffRow(_ s: Suggestion) -> some View {
        Button {
            if selected.contains(s.field) {
                selected.remove(s.field)
            } else {
                selected.insert(s.field)
            }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: selected.contains(s.field) ? "checkmark.square.fill" : "square")
                    .font(.system(size: 16))
                    .foregroundStyle(selected.contains(s.field) ? Theme.accent : Theme.text3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.label)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.text)
                    HStack(spacing: 6) {
                        Text(s.before)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text3)
                            .strikethrough(true, color: Theme.text3)
                        Image(systemName: "arrow.right")
                            .font(.system(size: 9))
                            .foregroundStyle(Theme.text3)
                        Text(s.after)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Theme.text2)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Suggestion model

/// One row in the diff list. Knows its field identity, display label,
/// before/after strings, and how to write itself onto a FoodItemPatch.
private struct Suggestion {
    enum Field: Hashable {
        case brand
        case servingDescription
        case servingGrams
        case calories, protein, carbs, fat, fiber, sugar
        case saturatedFatG, transFatG, cholesterolMg, sodiumMg
        case fiberG, sugarTotalG, sugarAddedG
        case vitaminAMcg, vitaminCMg, vitaminDMcg
        case calciumMg, ironMg, potassiumMg
    }

    let field: Field
    let label: String
    let before: String
    let after: String
    let apply: (inout FoodItemPatch) -> Void

    /// Build the diff list. Skips fields where the AI returned no value
    /// AND fields where current and new are effectively equal.
    static func build(item: FoodItemRow, result: AnalysisResult) -> [Suggestion] {
        var out: [Suggestion] = []

        // Brand — only suggest when the item currently has none. The AI
        // doesn't return brand directly (AnalysisResult lacks the field),
        // so for now this row is built from name-pattern heuristics in
        // the future. Skipping for v1 keeps the diff focused on the
        // fields the analyze paths actually populate.
        // (Intentional gap — see commit message.)

        // Serving description / grams — both come from worker-serving-units.
        if let s = result.serving_description?.trimmingCharacters(in: .whitespaces),
           !s.isEmpty,
           !stringEqual(item.serving_description, s) {
            out.append(Suggestion(
                field: .servingDescription,
                label: "Serving description",
                before: item.serving_description?.isEmpty == false ? item.serving_description! : "—",
                after: s,
                apply: { p in p.servingDescription = s }
            ))
        }
        if let g = result.serving_grams, g > 0, !numberEqual(item.serving_grams, g) {
            out.append(Suggestion(
                field: .servingGrams,
                label: "Per-serving grams",
                before: fmt(item.serving_grams, "g"),
                after: fmt(g, "g"),
                apply: { p in
                    p.servingGrams = g
                    // serving_oz mirrors serving_grams in the schema —
                    // keep them consistent so the food editor's read
                    // doesn't show a stale ounce value.
                    p.servingOz = (g / 28.3495 * 10).rounded() / 10
                }
            ))
        }

        // Basic macros (always present on AnalysisResult).
        addMacro(&out, label: "Calories", unit: "kcal", current: item.calories, new: result.calories,
                 field: .calories) { p, v in p.calories = v }
        addMacro(&out, label: "Protein", unit: "g", current: item.protein, new: result.protein,
                 field: .protein) { p, v in p.protein = v }
        addMacro(&out, label: "Carbs", unit: "g", current: item.carbs, new: result.carbs,
                 field: .carbs) { p, v in p.carbs = v }
        addMacro(&out, label: "Fat", unit: "g", current: item.fat, new: result.fat,
                 field: .fat) { p, v in p.fat = v }
        addOptionalMacro(&out, label: "Fiber", unit: "g", current: item.fiber, new: result.fiber,
                         field: .fiber) { p, v in p.fiber = v }
        addOptionalMacro(&out, label: "Sugar", unit: "g", current: item.sugar, new: result.sugar,
                         field: .sugar) { p, v in p.sugar = v }

        // Full nutrition label — only suggest fields the AI actually
        // returned. Compare against the matching column on the row.
        addOptionalMacro(&out, label: "Saturated fat", unit: "g",
                         current: item.saturated_fat_g, new: result.saturated_fat_g,
                         field: .saturatedFatG) { p, v in p.saturatedFatG = v }
        addOptionalMacro(&out, label: "Trans fat", unit: "g",
                         current: item.trans_fat_g, new: result.trans_fat_g,
                         field: .transFatG) { p, v in p.transFatG = v }
        addOptionalMacro(&out, label: "Cholesterol", unit: "mg",
                         current: item.cholesterol_mg, new: result.cholesterol_mg,
                         field: .cholesterolMg) { p, v in p.cholesterolMg = v }
        addOptionalMacro(&out, label: "Sodium", unit: "mg",
                         current: item.sodium_mg, new: result.sodium_mg,
                         field: .sodiumMg) { p, v in p.sodiumMg = v }
        addOptionalMacro(&out, label: "Fiber (label)", unit: "g",
                         current: item.fiber_g, new: result.fiber_g,
                         field: .fiberG) { p, v in p.fiberG = v }
        addOptionalMacro(&out, label: "Sugar (total)", unit: "g",
                         current: item.sugar_total_g, new: result.sugar_total_g,
                         field: .sugarTotalG) { p, v in p.sugarTotalG = v }
        addOptionalMacro(&out, label: "Added sugar", unit: "g",
                         current: item.sugar_added_g, new: result.sugar_added_g,
                         field: .sugarAddedG) { p, v in p.sugarAddedG = v }
        addOptionalMacro(&out, label: "Vitamin A", unit: "mcg",
                         current: item.vitamin_a_mcg, new: result.vitamin_a_mcg,
                         field: .vitaminAMcg) { p, v in p.vitaminAMcg = v }
        addOptionalMacro(&out, label: "Vitamin C", unit: "mg",
                         current: item.vitamin_c_mg, new: result.vitamin_c_mg,
                         field: .vitaminCMg) { p, v in p.vitaminCMg = v }
        addOptionalMacro(&out, label: "Vitamin D", unit: "mcg",
                         current: item.vitamin_d_mcg, new: result.vitamin_d_mcg,
                         field: .vitaminDMcg) { p, v in p.vitaminDMcg = v }
        addOptionalMacro(&out, label: "Calcium", unit: "mg",
                         current: item.calcium_mg, new: result.calcium_mg,
                         field: .calciumMg) { p, v in p.calciumMg = v }
        addOptionalMacro(&out, label: "Iron", unit: "mg",
                         current: item.iron_mg, new: result.iron_mg,
                         field: .ironMg) { p, v in p.ironMg = v }
        addOptionalMacro(&out, label: "Potassium", unit: "mg",
                         current: item.potassium_mg, new: result.potassium_mg,
                         field: .potassiumMg) { p, v in p.potassiumMg = v }

        return out
    }

    /// Walk the picked suggestions and let each one stamp itself onto
    /// the patch. Anything not picked stays nil → omitted from the
    /// SQL update.
    static func buildPatch(_ picked: [Suggestion]) -> FoodItemPatch {
        var p = FoodItemPatch()
        for s in picked { s.apply(&p) }
        return p
    }
}

// MARK: - Diff helpers

private func addMacro(_ out: inout [Suggestion],
                      label: String, unit: String,
                      current: Double?, new: Double,
                      field: Suggestion.Field,
                      apply: @escaping (inout FoodItemPatch, Double) -> Void) {
    if numberEqual(current, new) { return }
    out.append(Suggestion(
        field: field,
        label: label,
        before: fmt(current, unit),
        after: fmt(new, unit),
        apply: { p in apply(&p, new) }
    ))
}

private func addOptionalMacro(_ out: inout [Suggestion],
                              label: String, unit: String,
                              current: Double?, new: Double?,
                              field: Suggestion.Field,
                              apply: @escaping (inout FoodItemPatch, Double) -> Void) {
    guard let n = new else { return }
    if numberEqual(current, n) { return }
    out.append(Suggestion(
        field: field,
        label: label,
        before: fmt(current, unit),
        after: fmt(n, unit),
        apply: { p in apply(&p, n) }
    ))
}

private func numberEqual(_ a: Double?, _ b: Double) -> Bool {
    guard let a else { return false }
    return abs(a - b) < 0.5
}

private func stringEqual(_ a: String?, _ b: String) -> Bool {
    (a ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        .caseInsensitiveCompare(b.trimmingCharacters(in: .whitespacesAndNewlines)) == .orderedSame
}

private func fmt(_ v: Double?, _ unit: String) -> String {
    guard let v else { return "—" }
    let rounded = (v * 10).rounded() / 10
    if rounded == rounded.rounded() {
        return "\(Int(rounded)) \(unit)"
    }
    return String(format: "%.1f %@", rounded, unit)
}
