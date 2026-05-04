import SwiftUI
import PhotosUI

/// AI analysis section. Two top-level modes:
///
///   🍎 Food   → describe-by-text or photo. Logs as a meal_log entry.
///                Photo path uses FULL_ANALYSIS_PROMPT, so ingredients
///                come back too — but we don't store them on a meal log.
///                If the user wants to keep the recipe, they can switch
///                to Recipe mode and re-run.
///
///   📖 Recipe → write-text or photo. Returns full recipe data
///                (ingredients + macros + servings). Two actions on the
///                result: "Log this meal" (inserts meal_log only) and
///                "Save recipe" (inserts recipes too, used in Quick log
///                going forward).
struct AnalyzeFoodSection: View {
    enum Mode: String { case food, recipe }
    enum Source: String { case write, photo }

    @Environment(AppState.self) private var state

    @State private var mode: Mode = .food
    @State private var source: Source = .write
    @State private var text: String = ""
    @State private var image: UIImage?
    @State private var showCamera: Bool = false
    @State private var photoSelection: PhotosPickerItem?

    @State private var analyzing: Bool = false
    @State private var stage: String?           // status text shown under the analyze button while the pipeline runs
    @State private var result: AnalysisResult?
    /// Multi-candidate list returned by describeFoodCandidates. When set
    /// AND has >1 entries, the picker sheet opens; the user's selection
    /// gets unwrapped into `result` for the existing single-card render.
    /// Length-1 results unwrap inline without prompting (single-result
    /// fast path the user requested).
    @State private var candidates: [AnalysisResult] = []
    @State private var showCandidatePicker: Bool = false
    @State private var error: String?
    @State private var loggingResult: Bool = false
    @State private var savingRecipe: Bool = false
    @State private var logged: Bool = false
    @State private var saved: Bool = false

    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(Theme.border)
            VStack(spacing: 12) {
                modePicker
                sourcePicker
                inputArea
                if let stage, analyzing {
                    Text(stage)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let error { errorBanner(error) }
                if let result { resultCard(result) }
            }
            .padding(12)
        }
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
        .sheet(isPresented: $showCamera) {
            CameraSheet(image: $image)
                .ignoresSafeArea()
        }
        .sheet(isPresented: $showCandidatePicker) {
            CandidatePickerSheet(candidates: candidates) { picked in
                result = picked
                showCandidatePicker = false
            } onCancel: {
                showCandidatePicker = false
            }
        }
        .onChange(of: photoSelection) { _, newItem in
            Task {
                if let data = try? await newItem?.loadTransferable(type: Data.self),
                   let img = UIImage(data: data) {
                    self.image = img
                }
            }
        }
    }

    // MARK: - Header / pickers

    private var header: some View {
        HStack(spacing: 6) {
            Text("Analyze")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.text)
            Text("⚡ AI")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Theme.accentSoft(), in: .rect(cornerRadius: 999))
                .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.accent.opacity(0.3), lineWidth: 1))
            Spacer()
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
    }

    private var modePicker: some View {
        HStack(spacing: 4) {
            modeButton(.food, label: "🍎 Food")
            modeButton(.recipe, label: "📖 Recipe")
        }
        .padding(4)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
    }

    private func modeButton(_ target: Mode, label: String) -> some View {
        Button {
            mode = target
            resetResult()
        } label: {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(mode == target ? Theme.accent : Theme.text3)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(mode == target ? Theme.bg4 : .clear, in: .rect(cornerRadius: 8))
        }
    }

    private var sourcePicker: some View {
        HStack(spacing: 6) {
            sourceButton(.write, label: mode == .food ? "🔤 Describe" : "✍️ Write")
            sourceButton(.photo, label: "📸 Photo")
        }
    }

    private func sourceButton(_ target: Source, label: String) -> some View {
        Button {
            source = target
            resetResult()
            if target == .photo {
                inputFocused = false
            }
        } label: {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(source == target ? Theme.text : Theme.text3)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .background(source == target ? Theme.bg4 : Theme.bg3, in: .rect(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(source == target ? Theme.accent.opacity(0.4) : .clear, lineWidth: 1)
                )
        }
    }

    // MARK: - Input

    @ViewBuilder
    private var inputArea: some View {
        switch source {
        case .write: textInput
        case .photo: photoInput
        }
    }

    private var textInput: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text(mode == .food
                        ? "Describe what you ate. e.g. \"grilled chicken bowl with rice and broccoli\""
                        : "Paste or write the recipe — ingredients with amounts, optional steps. e.g. \"1 lb chicken thighs, 1 cup rice, 2 tbsp soy sauce, …\"")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text3)
                        .padding(.horizontal, 13).padding(.vertical, 11)
                }
                TextEditor(text: $text)
                    .focused($inputFocused)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .frame(minHeight: mode == .recipe ? 110 : 80)
                    .toolbar {
                        // TextEditor's Return key inserts a newline (multi-
                        // line by design) — without an explicit Done button
                        // the only way out of the keyboard is to scroll, and
                        // when the editor sits below the fold the keyboard
                        // hides the analyze button. This pins a Done button
                        // to the keyboard accessory while focused.
                        ToolbarItemGroup(placement: .keyboard) {
                            Spacer()
                            if inputFocused {
                                Button("Done") { inputFocused = false }
                            }
                        }
                    }
            }
            .background(Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))

            analyzeButton(canRun: !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var photoInput: some View {
        VStack(spacing: 10) {
            ZStack {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                } else {
                    VStack(spacing: 6) {
                        Text("📸").font(.system(size: 32))
                        Text(mode == .food ? "Take or pick a meal photo" : "Snap a recipe page")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Theme.text)
                        Text(mode == .food
                            ? "Barcode, nutrition label, or full plate — AI figures it out"
                            : "Cookbook page, recipe card, or screenshot")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.text2)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, minHeight: 160)
                    .background(Theme.bg3)
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border2, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }

            // Camera-first per the app-wide standard. The Camera button
            // takes the primary slot; Library is an icon-only secondary
            // for users picking a screenshot or pre-saved photo.
            HStack(spacing: 8) {
                Button {
                    showCamera = true
                } label: {
                    HStack { Image(systemName: "camera.fill"); Text("Take photo") }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Theme.bg3, in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                }

                PhotosPicker(selection: $photoSelection, matching: .images, photoLibrary: .shared()) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.text2)
                        .frame(width: 44, height: 38)
                        .background(Theme.bg3, in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                }
                .accessibilityLabel("Choose from library")

                if image != nil {
                    Button {
                        image = nil
                        photoSelection = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.text3)
                            .frame(width: 38, height: 38)
                            .background(Theme.bg3, in: .rect(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                    }
                }
            }

            analyzeButton(canRun: image != nil)
        }
    }

    private func analyzeButton(canRun: Bool) -> some View {
        Button {
            Task { await analyze() }
        } label: {
            HStack {
                if analyzing { ProgressView().tint(Theme.accentFG) }
                Text(analyzing ? "Analyzing…" : "Analyze with AI")
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(Theme.accentFG)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background((canRun && !analyzing) ? Theme.accent : Theme.bg4, in: .rect(cornerRadius: 10))
        }
        .disabled(!canRun || analyzing)
    }

    private func errorBanner(_ msg: String) -> some View {
        Text(msg)
            .font(.system(size: 12))
            .foregroundStyle(Theme.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 11).padding(.vertical, 8)
            .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.red.opacity(0.25), lineWidth: 1))
    }

    // MARK: - Result

    @ViewBuilder
    private func resultCard(_ r: AnalysisResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(r.name)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Spacer()
                if let conf = r.confidence {
                    Text(conf.uppercased())
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.text3)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.bg3, in: .rect(cornerRadius: 4))
                }
            }

            if let desc = r.description, !desc.isEmpty {
                Text(desc)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text2)
            }

            // Per-serving unit label — surfaces what one serving actually
            // represents so the macro pills below have a clear referent.
            // e.g. "1 medium avocado, ~150g". Falls back silently when
            // the analysis didn't return a serving description (older
            // prompt path).
            if let serving = r.serving_description, !serving.isEmpty {
                Text("Per serving: \(serving)")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }

            // Auto-detected quantity hint from the user's query
            // ("15g butter" / "two slices toast"). Shows BEFORE the macro
            // pills so it's clear those will be scaled at log time.
            // Suppressed when the multiplier is 1.0 — that's the default.
            if let parsedLine = parsedQuantityLabel(r) {
                Text(parsedLine)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.accent)
            }

            HStack(spacing: 6) {
                let m = Self.servingsMultiplier(for: r)
                pill("\(Int((r.calories * m).rounded())) kcal", color: Theme.cal)
                pill("\(Int((r.protein * m).rounded()))g P", color: Theme.protein)
                pill("\(Int((r.carbs * m).rounded()))g C", color: Theme.carbs)
                pill("\(Int((r.fat * m).rounded()))g F", color: Theme.fat)
            }

            if let ings = r.ingredients, !ings.isEmpty {
                ingredientList(ings, servings: r.servings)
            }

            actionButtons(r)
        }
        .padding(12)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
    }

    private func ingredientList(_ ings: [Ingredient], servings: Double?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Ingredients")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.text3)
                if let s = servings, s > 0 {
                    Text("· \(Int(s)) serving\(s == 1 ? "" : "s")")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
            }
            .padding(.top, 4)
            ForEach(Array(ings.enumerated()), id: \.offset) { _, ing in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("•").foregroundStyle(Theme.text3)
                    Text(ingredientLine(ing))
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text2)
                    Spacer()
                }
            }
        }
    }

    private func ingredientLine(_ ing: Ingredient) -> String {
        let head = [ing.amount.map { formatAmount($0) } ?? nil, ing.unit].compactMap { $0 }.joined(separator: " ")
        return [head, ing.name].filter { !$0.isEmpty }.joined(separator: " ")
    }

    private func formatAmount(_ x: Double) -> String {
        if x == x.rounded() { return String(Int(x)) }
        return String(format: "%g", x)
    }

    @ViewBuilder
    private func actionButtons(_ r: AnalysisResult) -> some View {
        VStack(spacing: 8) {
            HStack {
                Button {
                    resetAll()
                } label: {
                    Text("Discard")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.text3)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Theme.bg2, in: .rect(cornerRadius: 8))
                }

                Button {
                    Task { await logResult(r) }
                } label: {
                    HStack {
                        if loggingResult { ProgressView().tint(Theme.accentFG) }
                        Text(logged ? "✓ Logged" : (loggingResult ? "Logging…" : "+ Log this meal"))
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(Theme.accentFG)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(logged ? Theme.green : Theme.accent, in: .rect(cornerRadius: 8))
                }
                .disabled(loggingResult || logged)
            }

            // Save-to-library only makes sense in Recipe mode (or any
            // result with ingredients) — Food describe doesn't carry
            // enough recipe data to save meaningfully.
            if mode == .recipe || (r.ingredients?.isEmpty == false) {
                Button {
                    Task { await saveResult(r) }
                } label: {
                    HStack {
                        if savingRecipe { ProgressView().tint(Theme.accent) }
                        Text(saved ? "✓ Saved to library" : (savingRecipe ? "Saving…" : "⭐ Save recipe to library"))
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(saved ? Theme.green : Theme.accent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(saved ? Theme.green.opacity(0.1) : Theme.accentSoft(), in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke((saved ? Theme.green : Theme.accent).opacity(0.3), lineWidth: 1))
                }
                .disabled(savingRecipe || saved)
            }
        }
    }

    private func pill(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(color.opacity(0.12), in: .rect(cornerRadius: 999))
            .overlay(RoundedRectangle(cornerRadius: 999).stroke(color.opacity(0.3), lineWidth: 1))
    }

    // MARK: - Actions

    private func analyze() async {
        inputFocused = false
        analyzing = true
        stage = nil
        error = nil
        result = nil
        logged = false
        saved = false
        defer { analyzing = false; stage = nil }

        do {
            switch (mode, source) {
            case (.food, .write):
                // Multi-candidate path. Single-result is the fast path —
                // we surface the picker only when the model actually
                // returned multiple distinct options. Empty list raises
                // an error so the user sees a real failure rather than a
                // silent "nothing happened".
                let list = try await AnalyzeService.describeFoodCandidates(text)
                if list.isEmpty {
                    throw NSError(domain: "Analyze", code: 0, userInfo: [NSLocalizedDescriptionKey: "No matches — try being more specific"])
                }
                if list.count == 1 {
                    result = list[0]
                } else {
                    candidates = list
                    showCandidatePicker = true
                }
            case (.food, .photo):
                result = try await runFoodPhotoPipeline()
            case (.recipe, .write):
                result = try await AnalyzeService.analyzeRecipeText(text)
            case (.recipe, .photo):
                guard let b64 = imageBase64ForUpload() else {
                    throw NSError(domain: "Analyze", code: 0, userInfo: [NSLocalizedDescriptionKey: "Couldn't encode the photo"])
                }
                result = try await AnalyzeService.analyzeRecipePhoto(b64)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Three-stage food-photo router, matching the web's handleFoodPhoto:
    ///   1. Local barcode (Vision framework) → if found, /api/barcode lookup
    ///   2. AI classifier → "barcode" | "label" | "food"
    ///   3a. barcode classification → AI reads digits → /api/barcode lookup
    ///   3b. label → analyzeNutritionLabel
    ///   3c. food → analyzeFoodPhoto (the existing path)
    /// Updates `stage` along the way so the user sees what's happening.
    /// Throws only if EVERY path fails; intermediate failures (Vision
    /// finding a bogus code, /api/barcode 5xx-ing because OFF is down,
    /// classifier glitch) fall through to the next stage so we always
    /// return SOMETHING — manual entry is the user's last resort, not
    /// the second-step crash.
    private func runFoodPhotoPipeline() async throws -> AnalysisResult {
        guard let raw = image else {
            throw NSError(domain: "Analyze", code: 0, userInfo: [NSLocalizedDescriptionKey: "No photo"])
        }
        let resized = raw.resizedForAnalysis()

        // 1. Local barcode via Vision (free, fast).
        stage = "Looking up barcode…"
        if let code = await BarcodeService.detect(in: resized) {
            stage = "Barcode \(code) — looking up…"
            // try? — a thrown lookup error (e.g. /api/barcode returned
            // an HTML 502 from Vercel, or OFF parse failed upstream)
            // shouldn't kill the pipeline. Treat it the same as "not in
            // database" and fall through to the AI classifier.
            if let lookup = try? await BarcodeService.lookup(code) {
                return lookup
            }
            stage = "Barcode \(code) not in database — trying AI…"
        }

        // 2. AI classifier — figure out what kind of photo this is.
        guard let b64 = resized.jpegBase64() else {
            throw NSError(domain: "Analyze", code: 0, userInfo: [NSLocalizedDescriptionKey: "Couldn't encode the photo"])
        }
        stage = "Identifying food…"
        let kind = (try? await AnalyzeService.classifyFoodPhoto(b64)) ?? "food"

        // 3. Branch on classification.
        switch kind {
        case "barcode":
            stage = "Reading barcode digits…"
            // Same try? guard on the AI-detected-code lookup — an OFF
            // outage here also shouldn't crash; soft-land on meal-photo
            // analysis instead.
            if let aiCode = try? await AnalyzeService.readBarcodeFromImage(b64),
               let lookup = try? await BarcodeService.lookup(aiCode) {
                return lookup
            }
            stage = "Couldn't read the barcode — analyzing as a meal…"
            return try await AnalyzeService.analyzeFoodPhoto(b64)

        case "label":
            stage = "Reading nutrition label…"
            // If the label parse fails for any reason, take one more
            // swing at it as a generic food photo before surfacing the
            // error. Mirrors the web's soft-landing behavior.
            if let r = try? await AnalyzeService.analyzeNutritionLabel(b64) {
                return r
            }
            stage = "Label unreadable — analyzing as a meal…"
            return try await AnalyzeService.analyzeFoodPhoto(b64)

        default: // "food" or any unexpected value
            stage = "Analyzing meal photo…"
            return try await AnalyzeService.analyzeFoodPhoto(b64)
        }
    }

    private func imageBase64ForUpload() -> String? {
        image?.resizedForAnalysis().jpegBase64()
    }

    private func logResult(_ r: AnalysisResult) async {
        loggingResult = true
        defer { loggingResult = false }
        // Apply any parsed quantity hint from the user's query — "15g
        // butter" maps to ~1.07 servings of a 14g/serving baseline.
        // meal_log stores TOTALS, so scale macros by the multiplier
        // before sending and pass servingsConsumed alongside.
        let multiplier = Self.servingsMultiplier(for: r)
        do {
            try await state.logMeal(
                name: r.name,
                calories: r.calories * multiplier,
                protein: r.protein * multiplier,
                carbs: r.carbs * multiplier,
                fat: r.fat * multiplier,
                fiber: (r.fiber ?? 0) * multiplier,
                servingsConsumed: multiplier,
                loggedAt: state.loggedAtForSelectedDate(),
                servingDescription: r.serving_description,
                servingGrams: r.serving_grams,
                servingOz: r.serving_oz,
                fullLabel: AppState.FullLabelPayload.from(r, scaledBy: multiplier)
            )
            logged = true
        } catch {
            self.error = "Saved analysis but couldn't log: \(error.localizedDescription)"
        }
    }

    /// Display label for an auto-detected quantity hint. Returns nil
    /// when there's no hint OR when the multiplier rounds to 1.0
    /// (default — no point telling the user "1 serving").
    private func parsedQuantityLabel(_ r: AnalysisResult) -> String? {
        let multiplier = Self.servingsMultiplier(for: r)
        if abs(multiplier - 1.0) < 0.001 { return nil }
        let prettyMult: String = abs(multiplier - multiplier.rounded()) < 0.01
            ? String(Int(multiplier.rounded()))
            : String(format: "%.2f", multiplier)
        if let g = r.parsed_quantity_g, g > 0 {
            return "Auto-detected: \(formatGrams(g)) → \(prettyMult) servings"
        }
        if let s = r.parsed_quantity_servings, s > 0 {
            return "Auto-detected: \(prettyMult) serving\(s == 1 ? "" : "s")"
        }
        return nil
    }

    private func formatGrams(_ g: Double) -> String {
        if abs(g - g.rounded()) < 0.01 { return "\(Int(g.rounded()))g" }
        return String(format: "%.1fg", g)
    }

    /// Translate parsed_quantity_g / parsed_quantity_servings into a
    /// servings multiplier applied to per-serving macros at log time.
    /// Defaults to 1.0 when no quantity hint is present (bare query).
    /// servings takes precedence over grams — the prompt already enforces
    /// they're never both set, but if a buggy response surfaces both we
    /// honor the more direct unit.
    static func servingsMultiplier(for r: AnalysisResult) -> Double {
        if let s = r.parsed_quantity_servings, s > 0 { return s }
        if let g = r.parsed_quantity_g, g > 0,
           let serv = r.serving_grams, serv > 0 {
            return g / serv
        }
        return 1.0
    }

    private func saveResult(_ r: AnalysisResult) async {
        savingRecipe = true
        defer { savingRecipe = false }
        do {
            _ = try await state.saveRecipe(r)
            saved = true
        } catch {
            self.error = "Couldn't save recipe: \(error.localizedDescription)"
        }
    }

    private func resetResult() {
        result = nil
        candidates = []
        showCandidatePicker = false
        error = nil
        logged = false
        saved = false
    }

    private func resetAll() {
        text = ""
        image = nil
        photoSelection = nil
        resetResult()
    }
}

/// Modal list of describeFood candidates. Surfaces when the AI returned
/// more than one match for a generic query ("banana" → small / medium /
/// large / frozen / etc). Tap a row to pick — the picker dismisses and
/// the parent renders the chosen candidate as a normal result card.
private struct CandidatePickerSheet: View {
    let candidates: [AnalysisResult]
    let onPick: (AnalysisResult) -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            List(Array(candidates.enumerated()), id: \.offset) { _, c in
                Button {
                    onPick(c)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(c.name)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.text)
                        if let serving = c.serving_description, !serving.isEmpty {
                            Text(serving)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.text2)
                        }
                        HStack(spacing: 8) {
                            Text("\(Int(c.calories.rounded())) kcal")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.cal)
                            Text("\(Int(c.protein.rounded()))P · \(Int(c.carbs.rounded()))C · \(Int(c.fat.rounded()))F")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.text3)
                            Spacer()
                            if let conf = c.confidence {
                                Text(conf.uppercased())
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundStyle(Theme.text3)
                                    .padding(.horizontal, 5).padding(.vertical, 2)
                                    .background(Theme.bg3, in: .rect(cornerRadius: 4))
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
            .navigationTitle("Pick the closest match")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onCancel() }
                }
            }
        }
    }
}
