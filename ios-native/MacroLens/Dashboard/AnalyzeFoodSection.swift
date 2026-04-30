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
    @State private var result: AnalysisResult?
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

            HStack(spacing: 8) {
                Button {
                    showCamera = true
                } label: {
                    HStack { Image(systemName: "camera.fill"); Text("Camera") }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Theme.bg3, in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                }

                PhotosPicker(selection: $photoSelection, matching: .images, photoLibrary: .shared()) {
                    HStack { Image(systemName: "photo.on.rectangle"); Text("Library") }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Theme.bg3, in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                }

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

            HStack(spacing: 6) {
                pill("\(Int(r.calories)) kcal", color: Theme.cal)
                pill("\(Int(r.protein))g P", color: Theme.protein)
                pill("\(Int(r.carbs))g C", color: Theme.carbs)
                pill("\(Int(r.fat))g F", color: Theme.fat)
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
        error = nil
        result = nil
        logged = false
        saved = false
        defer { analyzing = false }

        do {
            let r: AnalysisResult
            switch (mode, source) {
            case (.food, .write):
                r = try await AnalyzeService.describeFood(text)
            case (.food, .photo):
                guard let b64 = imageBase64ForUpload() else {
                    throw NSError(domain: "Analyze", code: 0, userInfo: [NSLocalizedDescriptionKey: "Couldn't encode the photo"])
                }
                r = try await AnalyzeService.analyzeFoodPhoto(b64)
            case (.recipe, .write):
                r = try await AnalyzeService.analyzeRecipeText(text)
            case (.recipe, .photo):
                guard let b64 = imageBase64ForUpload() else {
                    throw NSError(domain: "Analyze", code: 0, userInfo: [NSLocalizedDescriptionKey: "Couldn't encode the photo"])
                }
                r = try await AnalyzeService.analyzeRecipePhoto(b64)
            }
            result = r
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func imageBase64ForUpload() -> String? {
        image?.resizedForAnalysis().jpegBase64()
    }

    private func logResult(_ r: AnalysisResult) async {
        loggingResult = true
        defer { loggingResult = false }
        do {
            try await state.logMeal(
                name: r.name,
                calories: r.calories,
                protein: r.protein,
                carbs: r.carbs,
                fat: r.fat,
                fiber: r.fiber ?? 0
            )
            logged = true
        } catch {
            self.error = "Saved analysis but couldn't log: \(error.localizedDescription)"
        }
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
