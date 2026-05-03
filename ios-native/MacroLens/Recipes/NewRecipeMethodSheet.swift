import SwiftUI
import PhotosUI

/// Method picker shown when the user taps "+ New" on Recipes. Mirrors
/// `openNewRecipeModal` in src/pages/app.js: four cards routing to Link
/// import, Photo extraction, Manual entry (with paste-ingredients
/// pre-step), and AI generation from a mood prompt. Each path either
/// pre-fills a `RecipeFull` and hands it back to the parent (which then
/// pushes RecipeEditView) or — in the manual case — hands an empty
/// draft for the user to fill from scratch.
///
/// Routing is done with NavigationStack + NavigationLink so each sub-flow
/// gets a working Back button and the sheet's "Cancel" stays in the
/// toolbar throughout the stack. On success, every sub-flow calls
/// `onComplete(prefilledRecipe)` which the parent uses to dismiss the
/// picker AND open RecipeEditView with the prefilled draft in one
/// gesture.
struct NewRecipeMethodSheet: View {
    let onComplete: (RecipeFull) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("How do you want to add it?")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text3)
                        .padding(.bottom, 4)

                    NavigationLink {
                        NewRecipeLinkPath(onComplete: completeAndDismiss)
                    } label: {
                        methodCard(
                            icon: "🔗",
                            iconBg: Theme.accent.opacity(0.12),
                            title: "Paste a link",
                            subtitle: "Recipe website, blog, or YouTube — AI extracts the recipe"
                        )
                    }
                    .buttonStyle(.plain)

                    NavigationLink {
                        NewRecipePhotoPath(onComplete: completeAndDismiss)
                    } label: {
                        methodCard(
                            icon: "📸",
                            iconBg: Theme.green.opacity(0.12),
                            title: "Upload a photo",
                            subtitle: "Take a new photo or pick a screenshot — cookbook, recipe card, anything"
                        )
                    }
                    .buttonStyle(.plain)

                    NavigationLink {
                        NewRecipeManualPath(onComplete: completeAndDismiss)
                    } label: {
                        methodCard(
                            icon: "✏️",
                            iconBg: Theme.carbs.opacity(0.12),
                            title: "Add manually",
                            subtitle: "Type or paste ingredients — AI parses them instantly"
                        )
                    }
                    .buttonStyle(.plain)

                    NavigationLink {
                        NewRecipeGeneratePath(onComplete: completeAndDismiss)
                    } label: {
                        methodCard(
                            icon: "✨",
                            iconBg: Theme.fat.opacity(0.12),
                            title: "Generate a recipe",
                            subtitle: "Tell me what's in your fridge or what you're craving"
                        )
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 28)
            }
            .background(Theme.bg)
            .navigationTitle("Add a recipe")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func completeAndDismiss(_ recipe: RecipeFull) {
        onComplete(recipe)
        dismiss()
    }

    private func methodCard(icon: String, iconBg: Color, title: String, subtitle: String) -> some View {
        HStack(spacing: 14) {
            Text(icon)
                .font(.system(size: 22))
                .frame(width: 44, height: 44)
                .background(iconBg, in: .rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text(subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 14))
                .foregroundStyle(Theme.text3)
        }
        .padding(16)
        .background(Theme.bg3, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border2, lineWidth: 1))
    }
}

// MARK: - Link path

/// "Paste a link" sub-view. URL field + dish name field + an inline hint
/// when the URL is from Instagram or TikTok (we can't fetch reel content
/// directly so the user has to type the dish name and let the AI search
/// for it). Mirrors `openNewRecipeFromLink` + `importRecipeFromLink` in
/// src/pages/app.js.
struct NewRecipeLinkPath: View {
    let onComplete: (RecipeFull) -> Void

    @State private var url: String = ""
    @State private var dishName: String = ""
    @State private var importing: Bool = false
    @State private var error: String?
    @FocusState private var keyboardFocused: Bool

    private var blockedPlatform: String? {
        let lower = url.lowercased()
        if lower.contains("instagram.com") { return "Instagram" }
        if lower.contains("tiktok.com") { return "TikTok" }
        return nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Recipe websites, blogs, and YouTube videos work. Instagram and TikTok links are private — use the dish name field below for those.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)

                fieldLabel("URL")
                TextField("https://...", text: $url)
                    .focused($keyboardFocused)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(Theme.bg3, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))

                if let platform = blockedPlatform {
                    privatePlatformHint(platform)
                }

                fieldLabel("Or describe the dish")
                TextField("e.g. Chicken tikka masala…", text: $dishName)
                    .focused($keyboardFocused)
                    .textInputAutocapitalization(.sentences)
                    .padding(12)
                    .background(Theme.bg3, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))

                if let error {
                    Text(error).font(.system(size: 12)).foregroundStyle(Theme.red)
                }

                Button {
                    Task { await importRecipe() }
                } label: {
                    HStack(spacing: 8) {
                        if importing { ProgressView().controlSize(.small).tint(Theme.accentFG) }
                        Text(importing ? "Importing…" : "Import recipe")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundStyle(Theme.accentFG)
                    .background(canSubmit ? Theme.accent : Theme.bg4, in: .rect(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Paste a link")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if keyboardFocused {
                    Button("Done") { keyboardFocused = false }
                }
            }
        }
    }

    private var canSubmit: Bool {
        !importing && !(url.trimmingCharacters(in: .whitespaces).isEmpty
                         && dishName.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    private func privatePlatformHint(_ platform: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("📱 \(platform) links are private")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.accent)
            Text("We can't read reel content directly. Type the dish name below (e.g. \"viral baked feta pasta\") and AI will search for the recipe.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text2)
        }
        .padding(12)
        .background(Theme.accent.opacity(0.08), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.25), lineWidth: 1))
    }

    private func fieldLabel(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 11, weight: .medium))
            .tracking(1).textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    private func importRecipe() async {
        let trimmedURL = url.trimmingCharacters(in: .whitespaces)
        let trimmedDish = dishName.trimmingCharacters(in: .whitespaces)
        importing = true
        error = nil
        defer { importing = false }
        do {
            let result = try await AnalyzeService.analyzeDishBySearch(
                trimmedDish.isEmpty ? trimmedURL : trimmedDish,
                link: trimmedURL.isEmpty ? nil : trimmedURL
            )
            var draft = RecipeFull.newDraft()
            draft.name = result.name
            draft.description = result.description
            draft.servings = result.servings ?? draft.servings
            draft.calories = result.calories
            draft.protein = result.protein
            draft.carbs = result.carbs
            draft.fat = result.fat
            draft.fiber = result.fiber ?? draft.fiber
            draft.sugar = result.sugar ?? draft.sugar
            if let ings = result.ingredients, !ings.isEmpty {
                draft.ingredients = ings.map(RecipeIngredient.fromAI)
            }
            draft.source_url = trimmedURL.isEmpty ? nil : trimmedURL
            onComplete(draft)
        } catch {
            self.error = "Could not import: \(error.localizedDescription)"
        }
    }
}

// MARK: - Photo path

/// "Upload a photo" sub-view. Pulls a richer extraction than the existing
/// IngredientExtractView's photo mode — `extractRecipeFromPhoto` returns
/// the full step list + prep/cook times, so the user gets a complete
/// recipe pre-filled (instructions included) instead of just ingredients.
struct NewRecipePhotoPath: View {
    let onComplete: (RecipeFull) -> Void

    @State private var pickedImage: UIImage?
    @State private var photoSelection: PhotosPickerItem?
    @State private var showCamera: Bool = false
    @State private var working: Bool = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let img = pickedImage {
                    Image(uiImage: img)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 280)
                        .frame(maxWidth: .infinity)
                        .background(Theme.bg3, in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
                } else {
                    Text("Cookbook page, recipe card, or blog screenshot — anything with the recipe text visible. AI extracts ingredients AND step-by-step instructions.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }

                HStack(spacing: 8) {
                    Button {
                        showCamera = true
                    } label: {
                        Label("Camera", systemImage: "camera")
                            .font(.system(size: 13, weight: .medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Theme.bg3, in: .rect(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    PhotosPicker(selection: $photoSelection,
                                 matching: .images,
                                 photoLibrary: .shared()) {
                        Label("Library", systemImage: "photo.on.rectangle")
                            .font(.system(size: 13, weight: .medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Theme.bg3, in: .rect(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                    }
                }
                if pickedImage != nil {
                    Button {
                        pickedImage = nil
                        photoSelection = nil
                    } label: {
                        Text("Remove image")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.text3)
                    }
                }

                if let error {
                    Text(error).font(.system(size: 12)).foregroundStyle(Theme.red)
                }

                Button {
                    Task { await runExtraction() }
                } label: {
                    HStack(spacing: 8) {
                        if working { ProgressView().controlSize(.small).tint(Theme.accentFG) }
                        else { Image(systemName: "sparkles") }
                        Text(working ? "Reading recipe…" : "Extract recipe")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundStyle(Theme.accentFG)
                    .background((pickedImage != nil && !working) ? Theme.accent : Theme.bg4, in: .rect(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .disabled(pickedImage == nil || working)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
        }
        .background(Theme.bg)
        .navigationTitle("Upload a photo")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showCamera) {
            CameraSheet(image: $pickedImage)
                .ignoresSafeArea()
        }
        .onChange(of: photoSelection) { _, newItem in
            guard let newItem else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self),
                   let img = UIImage(data: data) {
                    pickedImage = img
                }
            }
        }
    }

    @MainActor
    private func runExtraction() async {
        guard let img = pickedImage else { return }
        working = true
        error = nil
        defer { working = false }
        let resized = img.resizedForAnalysis()
        guard let b64 = resized.jpegBase64() else {
            error = "Couldn't encode the image."
            return
        }
        do {
            let result = try await AnalyzeService.extractRecipeFromPhoto(b64)
            var draft = RecipeFull.newDraft()
            draft.name = result.name
            if let d = result.description { draft.description = d }
            if let s = result.servings { draft.servings = s }
            if let label = result.serving_label, !label.isEmpty { draft.serving_label = label }
            if let ings = result.ingredients, !ings.isEmpty {
                draft.ingredients = ings
            }
            draft.instructions = result.toRecipeInstructions()
            draft.notes = result.notes
            onComplete(draft)
        } catch {
            self.error = "Could not read photo: \(error.localizedDescription)"
        }
    }
}

// MARK: - Manual path

/// "Add manually" sub-view. Two-button choice: paste an ingredient list
/// for AI parsing, or skip straight to the blank form. Mirrors
/// `openNewRecipeManual` + `parseAndOpenManual` in src/pages/app.js. The
/// AI parse keeps the user moving — they don't have to retype amounts/
/// units they already had in another tab.
struct NewRecipeManualPath: View {
    let onComplete: (RecipeFull) -> Void

    @State private var pasted: String = ""
    @State private var parsing: Bool = false
    @State private var error: String?
    @FocusState private var keyboardFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Paste your ingredient list and AI will parse it, or skip to fill in manually.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)

                fieldLabel("Paste ingredients (optional)")
                TextEditor(text: $pasted)
                    .focused($keyboardFocused)
                    .font(.system(size: 13))
                    .frame(minHeight: 200)
                    .padding(8)
                    .background(Theme.bg3, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                    .scrollContentBackground(.hidden)
                    .overlay(alignment: .topLeading) {
                        if pasted.isEmpty {
                            Text("2 cups chicken broth\n1 lb chicken breast\n3 cloves garlic, minced\n1 tsp cumin\n…")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.text3.opacity(0.5))
                                .padding(16)
                                .allowsHitTesting(false)
                        }
                    }

                if let error {
                    Text(error).font(.system(size: 12)).foregroundStyle(Theme.red)
                }

                Button {
                    Task { await parseAndContinue() }
                } label: {
                    HStack(spacing: 8) {
                        if parsing { ProgressView().controlSize(.small).tint(Theme.accentFG) }
                        Text(parsing ? "Parsing…" : "Parse ingredients & continue →")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundStyle(Theme.accentFG)
                    .background((!pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !parsing) ? Theme.accent : Theme.bg4, in: .rect(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || parsing)

                Button {
                    onComplete(RecipeFull.newDraft())
                } label: {
                    Text("Skip — fill in manually")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.text3)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Theme.bg3, in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(parsing)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Add manually")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if keyboardFocused {
                    Button("Done") { keyboardFocused = false }
                }
            }
        }
    }

    private func fieldLabel(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 11, weight: .medium))
            .tracking(1).textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    private func parseAndContinue() async {
        let text = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        parsing = true
        error = nil
        defer { parsing = false }
        do {
            let ings = try await AnalyzeService.extractIngredients(text)
            var draft = RecipeFull.newDraft()
            draft.ingredients = ings
            onComplete(draft)
        } catch {
            // Don't block the user — let them continue to a blank form
            // with a soft error. Mirror's the web's fallback behavior.
            self.error = "AI parse failed — opening blank form"
            try? await Task.sleep(nanoseconds: 800_000_000)
            onComplete(RecipeFull.newDraft())
        }
    }
}

// MARK: - Generate path

/// "Generate a recipe" sub-view. Mood/craving textarea + suggestion chips,
/// posts through `generateRecipeFromMood` to produce a complete recipe
/// (macros + ingredients + instructions). Mirrors `openNewRecipeGenerate`
/// + `generateRecipeFromPrompt` in src/pages/app.js.
struct NewRecipeGeneratePath: View {
    let onComplete: (RecipeFull) -> Void

    @State private var prompt: String = ""
    @State private var generating: Bool = false
    @State private var error: String?
    @FocusState private var keyboardFocused: Bool

    private let chips: [String] = [
        "🍗 High protein",
        "🥗 Low carb",
        "⚡ Under 30 min",
        "🌶️ Spicy",
        "🇮🇹 Italian",
        "🌮 Mexican",
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Tell me what you have, what you're craving, or both.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)

                fieldLabel("What are you working with?")
                TextEditor(text: $prompt)
                    .focused($keyboardFocused)
                    .font(.system(size: 13))
                    .frame(minHeight: 140)
                    .padding(8)
                    .background(Theme.bg3, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                    .scrollContentBackground(.hidden)
                    .overlay(alignment: .topLeading) {
                        if prompt.isEmpty {
                            Text("Examples:\n• chicken breast, rice, bell peppers — make something spicy\n• cozy Italian under 600 calories\n• leftover salmon, need lunch ideas")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.text3.opacity(0.5))
                                .padding(16)
                                .allowsHitTesting(false)
                        }
                    }

                FlowLayout(spacing: 6) {
                    ForEach(chips, id: \.self) { chip in
                        Button {
                            appendChip(chip)
                        } label: {
                            Text(chip)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.text2)
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .background(Theme.bg3, in: .rect(cornerRadius: 999))
                                .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.border2, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }

                if let error {
                    Text(error).font(.system(size: 12)).foregroundStyle(Theme.red)
                }

                Button {
                    Task { await generate() }
                } label: {
                    HStack(spacing: 8) {
                        if generating { ProgressView().controlSize(.small).tint(Theme.accentFG) }
                        else { Image(systemName: "sparkles") }
                        Text(generating ? "Generating…" : "Generate recipe")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundStyle(Theme.accentFG)
                    .background(canSubmit ? Theme.fat : Theme.bg4, in: .rect(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Generate a recipe")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if keyboardFocused {
                    Button("Done") { keyboardFocused = false }
                }
            }
        }
    }

    private var canSubmit: Bool {
        !generating && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func fieldLabel(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 11, weight: .medium))
            .tracking(1).textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    private func appendChip(_ chip: String) {
        // Strip the leading emoji + space so the appended text reads
        // naturally inside the prompt body.
        let body = chip.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            .dropFirst().first.map(String.init) ?? chip
        prompt = prompt.isEmpty ? body : (prompt + ", " + body)
    }

    private func generate() async {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        generating = true
        error = nil
        defer { generating = false }
        do {
            let result = try await AnalyzeService.generateRecipeFromMood(trimmed)
            var draft = RecipeFull.newDraft()
            draft.name = result.name
            draft.description = result.description
            draft.servings = result.servings ?? draft.servings
            draft.serving_label = result.serving_label ?? draft.serving_label
            draft.calories = result.calories
            draft.protein = result.protein
            draft.carbs = result.carbs
            draft.fat = result.fat
            draft.fiber = result.fiber ?? draft.fiber
            draft.sugar = result.sugar ?? draft.sugar
            draft.ingredients = result.ingredients ?? []
            draft.instructions = result.instructions
            draft.notes = result.notes
            onComplete(draft)
        } catch {
            self.error = "Could not generate: \(error.localizedDescription)"
        }
    }
}
