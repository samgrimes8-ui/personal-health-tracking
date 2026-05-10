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
/// One enum case per sub-flow so the picker can drive programmatic
/// navigation via NavigationPath. Lets the link path's "Take a photo
/// instead" Tier 4 deep link replace the stack with [.photo] in one
/// gesture instead of forcing the user to back out and pick again.
enum NewRecipeRoute: Hashable {
    case link, photo, manual, generate
}

struct NewRecipeMethodSheet: View {
    let onComplete: (RecipeFull) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var path: [NewRecipeRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("How do you want to add it?")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text3)
                        .padding(.bottom, 4)

                    Button { path.append(.link) } label: {
                        methodCard(
                            icon: "🔗",
                            iconBg: Theme.accent.opacity(0.12),
                            title: "Paste a link",
                            subtitle: "Recipe website, blog, or YouTube — AI extracts the recipe"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { path.append(.photo) } label: {
                        methodCard(
                            icon: "📸",
                            iconBg: Theme.green.opacity(0.12),
                            title: "Upload a photo",
                            subtitle: "Take a new photo or pick a screenshot — cookbook, recipe card, anything"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { path.append(.manual) } label: {
                        methodCard(
                            icon: "✏️",
                            iconBg: Theme.carbs.opacity(0.12),
                            title: "Add manually",
                            subtitle: "Type or paste ingredients — AI parses them instantly"
                        )
                    }
                    .buttonStyle(.plain)

                    Button { path.append(.generate) } label: {
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
            .navigationDestination(for: NewRecipeRoute.self) { route in
                switch route {
                case .link:
                    NewRecipeLinkPath(
                        onComplete: completeAndDismiss,
                        onJumpToPhoto: {
                            // Replace the back stack so Back from the photo
                            // sub-view returns to the picker root, not to
                            // the failed link sheet.
                            path = [.photo]
                        }
                    )
                case .photo:
                    NewRecipePhotoPath(onComplete: completeAndDismiss)
                case .manual:
                    NewRecipeManualPath(onComplete: completeAndDismiss)
                case .generate:
                    NewRecipeGeneratePath(onComplete: completeAndDismiss)
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
    /// Hand back the prefilled draft to the picker (which handles dismiss
    /// + handoff to RecipeEditView).
    let onComplete: (RecipeFull) -> Void
    /// Bail out of the picker entirely and route the user to the photo-
    /// upload sub-view. Wired up in NewRecipeMethodSheet so the Tier 4
    /// "Take a photo instead" deep link works without re-opening the
    /// picker.
    let onJumpToPhoto: () -> Void

    @State private var url: String = ""
    @State private var dishName: String = ""
    @State private var importTask: Task<Void, Never>? = nil
    @State private var importStartedAt: Date? = nil
    @State private var error: ImportError?
    @FocusState private var keyboardFocused: Bool

    enum ImportError: Equatable {
        case generic(String)
        /// Server walked every tier and gave up — render the photo-jump CTA.
        case importFailed(String)
    }

    private var importing: Bool { importTask != nil }

    private var blockedPlatform: String? {
        let lower = url.lowercased()
        if lower.contains("instagram.com") { return "Instagram" }
        if lower.contains("tiktok.com") { return "TikTok" }
        return nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                pasteLinkSection
                orDivider
                describeDishSection
                if let error {
                    errorBlock(error)
                }
                if importing {
                    inProgressBlock
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 28)
            .disabled(importing)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Add a recipe")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if keyboardFocused {
                    Button("Done") { keyboardFocused = false }
                }
            }
        }
        .onDisappear {
            // Cancelling the in-flight task on disappear avoids stale
            // completions trying to call onComplete after the sheet's
            // already gone away.
            importTask?.cancel()
            importTask = nil
        }
    }

    // MARK: - Sections

    private var pasteLinkSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "Paste a recipe link",
                          subtitle: "Recipe websites, blogs, and YouTube videos work. Instagram and TikTok are private — use the description field below for those.")
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
            primaryButton(
                title: "Import recipe",
                accent: Theme.accent,
                enabled: !importing && !url.trimmingCharacters(in: .whitespaces).isEmpty
            ) {
                runImport(useDishOnly: false)
            }
        }
    }

    private var orDivider: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Theme.border).frame(height: 1)
            Text("OR")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.text3)
            Rectangle().fill(Theme.border).frame(height: 1)
        }
        .padding(.vertical, 4)
    }

    private var describeDishSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "Describe the dish",
                          subtitle: "Type a dish name and AI will search for the recipe — useful when you don't have a clean URL.")
            TextField("e.g. Chicken tikka masala…", text: $dishName)
                .focused($keyboardFocused)
                .textInputAutocapitalization(.sentences)
                .padding(12)
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
            primaryButton(
                title: "Search & import",
                accent: Theme.fat,
                enabled: !importing && !dishName.trimmingCharacters(in: .whitespaces).isEmpty
            ) {
                runImport(useDishOnly: true)
            }
        }
    }

    private func errorBlock(_ err: ImportError) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.red)
                Text(messageFor(err))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if case .importFailed = err {
                Button {
                    onJumpToPhoto()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "camera.fill")
                        Text("Take a photo instead →")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .foregroundStyle(Theme.accentFG)
                    .background(Theme.accent, in: .rect(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(Theme.red.opacity(0.06), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.2), lineWidth: 1))
    }

    private func messageFor(_ err: ImportError) -> String {
        switch err {
        case .generic(let msg): return msg
        case .importFailed(let msg): return msg
        }
    }

    /// Tier-walk progress UI. The server can spend up to ~60s walking the
    /// 4-tier fallback. Use a TimelineView so elapsed time + status caption
    /// re-render every 0.5s without us managing our own timer state.
    /// Status messages are wall-clock estimates — the server walks the
    /// tiers in the same order the captions advance, so the rolling
    /// caption is "close enough" without needing SSE/streaming wiring.
    private var inProgressBlock: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            let elapsed = importStartedAt.map { context.date.timeIntervalSince($0) } ?? 0
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small).tint(Theme.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(progressTitle(elapsed: elapsed))
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.text2)
                        Text("Working on it… (\(Int(elapsed))s)")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text3)
                    }
                    Spacer(minLength: 0)
                }
                Button(role: .destructive) {
                    importTask?.cancel()
                    importTask = nil
                    importStartedAt = nil
                } label: {
                    Text("Cancel — try Add Manually or Photo instead")
                        .font(.system(size: 12, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .foregroundStyle(Theme.red)
                        .background(Theme.bg2, in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.red.opacity(0.3), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(12)
            .background(Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
        }
    }

    /// Tier-walk caption. Estimates aligned with the server's per-tier
    /// budgets in api/import-recipe.js (Tier 1 ≤25s → Tier 2 ≤20s →
    /// Tier 3 ≤15s). Synthetic; close enough that users feel something
    /// is changing rather than the spinner being stuck.
    private func progressTitle(elapsed: TimeInterval) -> String {
        if elapsed < 25 { return "Reading recipe site…" }
        if elapsed < 45 { return "Site is slow — trying reader mode…" }
        return "Asking AI to extract the recipe…"
    }

    private func privatePlatformHint(_ platform: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("📱 \(platform) links are private")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.accent)
            Text("We can't read reel content directly. Use the OR section below — type the dish name (e.g. \"viral baked feta pasta\") and AI will search for the recipe.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text2)
        }
        .padding(12)
        .background(Theme.accent.opacity(0.08), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.25), lineWidth: 1))
    }

    private func sectionHeader(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text(subtitle)
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
        }
    }

    private func primaryButton(title: String, accent: Color, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .foregroundStyle(Theme.accentFG)
                .background(enabled ? accent : Theme.bg4, in: .rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    // MARK: - Behavior

    private func runImport(useDishOnly: Bool) {
        let trimmedURL = url.trimmingCharacters(in: .whitespaces)
        let trimmedDish = dishName.trimmingCharacters(in: .whitespaces)
        let urlArg: String? = useDishOnly ? nil : (trimmedURL.isEmpty ? nil : trimmedURL)
        let dishArg: String = useDishOnly
            ? trimmedDish
            : (trimmedDish.isEmpty ? trimmedURL : trimmedDish)
        keyboardFocused = false
        error = nil
        importStartedAt = Date()
        let task = Task {
            defer {
                Task { @MainActor in
                    importTask = nil
                    importStartedAt = nil
                }
            }
            do {
                let result = try await AnalyzeService.analyzeDishBySearch(dishArg, link: urlArg)
                if Task.isCancelled { return }
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
                draft.source_url = urlArg
                await MainActor.run { onComplete(draft) }
            } catch is CancellationError {
                // Silent — user-initiated cancel.
            } catch let analyze as AnalyzeService.AnalyzeError {
                if case .importFailed(let msg) = analyze {
                    await MainActor.run { error = .importFailed(msg) }
                } else {
                    await MainActor.run { error = .generic(analyze.errorDescription ?? "Could not import") }
                }
            } catch {
                await MainActor.run {
                    self.error = .generic("Could not import: \(error.localizedDescription)")
                }
            }
        }
        importTask = task
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

                // Camera-first per the app-wide standard: take a photo
                // primary, library a small icon-only secondary.
                HStack(spacing: 8) {
                    Button {
                        showCamera = true
                    } label: {
                        Label("Take photo", systemImage: "camera.fill")
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
                        Image(systemName: "photo.on.rectangle.angled")
                            .font(.system(size: 16))
                            .foregroundStyle(Theme.text2)
                            .frame(width: 44, height: 38)
                            .background(Theme.bg3, in: .rect(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                    }
                    .accessibilityLabel("Choose from library")
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
