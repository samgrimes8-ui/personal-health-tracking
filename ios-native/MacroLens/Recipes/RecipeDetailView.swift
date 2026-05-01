import SwiftUI

/// View-mode recipe detail. Mirrors the right-side "view" mode of the
/// web `renderRecipeModalContent`: macros, source link, ingredient list
/// with serving scaler, and an Instructions tab that wraps AI-generated
/// step-by-step cooking instructions.
///
/// `working` is a local mutable copy of the inbound `recipe` so AI-generated
/// instructions surface immediately after the API call resolves. The parent
/// refreshes the library from the database when this sheet dismisses, so
/// changes also propagate up.
struct RecipeDetailView: View {
    let recipe: RecipeFull
    let onEdit: (RecipeFull) -> Void
    let onDeleted: () -> Void
    /// Hooks for the per-feature actions — wired by the parent so the
    /// detail view stays presentation-only. Defaulted to no-ops while the
    /// owning features are being built out commit-by-commit.
    var onPlan: ((RecipeFull) -> Void)? = nil
    var onShare: ((RecipeFull) -> Void)? = nil
    var onCook: ((RecipeFull) -> Void)? = nil
    /// Notified when in-page state mutates (e.g. instructions get
    /// generated and saved). Lets a parent pager keep its array snapshot
    /// in sync so the toolbar's "Edit" button picks up the latest data.
    var onChanged: ((RecipeFull) -> Void)? = nil
    /// When true, the view emits no NavigationStack title/toolbar. Used
    /// by RecipeDetailPager so the pager's NavigationStack owns the
    /// toolbar and the toolbar reflects the *currently visible* page
    /// rather than every page racing to declare its own.
    var embedded: Bool = false

    @Environment(\.dismiss) private var dismiss
    @State private var working: RecipeFull
    @State private var scaledServings: Double
    @State private var tab: DetailTab = .ingredients
    @State private var isDeleting = false
    @State private var deleteError: String?

    @State private var generatingInstructions = false
    @State private var generateError: String?

    enum DetailTab { case ingredients, instructions }

    init(recipe: RecipeFull,
         onEdit: @escaping (RecipeFull) -> Void,
         onDeleted: @escaping () -> Void,
         onPlan: ((RecipeFull) -> Void)? = nil,
         onShare: ((RecipeFull) -> Void)? = nil,
         onCook: ((RecipeFull) -> Void)? = nil,
         onChanged: ((RecipeFull) -> Void)? = nil,
         embedded: Bool = false) {
        self.recipe = recipe
        self.onEdit = onEdit
        self.onDeleted = onDeleted
        self.onPlan = onPlan
        self.onShare = onShare
        self.onCook = onCook
        self.onChanged = onChanged
        self.embedded = embedded
        _working = State(initialValue: recipe)
        _scaledServings = State(initialValue: recipe.servings ?? 1)
        // Default tab matches the web's openRecipeModal: Instructions when
        // they exist, Ingredients otherwise. Users were getting confused
        // when a generate completed but the modal stayed on Ingredients.
        _tab = State(initialValue: (recipe.instructions?.steps.isEmpty == false) ? .instructions : .ingredients)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let desc = working.description, !desc.isEmpty {
                    Text(desc)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text2)
                }
                if let url = working.source_url, !url.isEmpty {
                    sourceLink(url)
                }
                quickActionsRow
                servingsRow
                macrosRow
                if !(working.tags ?? []).isEmpty {
                    tagsRow
                }
                tabSegment
                if tab == .instructions {
                    instructionsCard
                } else {
                    ingredientsCard
                }
                if let err = deleteError {
                    Text(err).font(.system(size: 12)).foregroundStyle(Theme.red)
                }
                actionsRow
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .background(Theme.bg)
        .modifier(NavToolbarIfNeeded(embedded: embedded,
                                     title: working.name,
                                     onClose: { dismiss() },
                                     onEdit: { onEdit(working) }))
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(working.name)
                .font(.system(size: 24, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, 6)
    }

    /// Plan / Share row — shown above the macros so the two most-tapped
    /// actions on a recipe are reachable without scrolling. Mirrors the
    /// pill row in the web sticky header.
    @ViewBuilder
    private var quickActionsRow: some View {
        let hasPlan = onPlan != nil
        let hasShare = onShare != nil
        if hasPlan || hasShare {
            HStack(spacing: 8) {
                if hasPlan {
                    Button {
                        onPlan?(working)
                    } label: {
                        Label("Plan", systemImage: "calendar.badge.plus")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.accentFG)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(Theme.accent, in: .rect(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }
                if hasShare {
                    Button {
                        onShare?(working)
                    } label: {
                        let isShared = working.is_shared == true
                        Label(isShared ? "Shared" : "Share",
                              systemImage: isShared ? "checkmark.circle.fill" : "square.and.arrow.up")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(isShared ? Theme.protein : Theme.text2)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(Theme.bg3, in: .rect(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(isShared ? Theme.protein : Theme.border2, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private func sourceLink(_ url: String) -> some View {
        let domain: String = {
            if let u = URL(string: url) {
                return u.host?.replacingOccurrences(of: "www.", with: "") ?? url
            }
            return url
        }()
        let isInstagram = domain.contains("instagram.com")
        let isTikTok = domain.contains("tiktok.com")
        let blocked = isInstagram || isTikTok || (working.og_cache?.blocked == true)
        let target = URL(string: url) ?? URL(string: "https://example.com")!

        // Rich OG card when the web has cached metadata for this URL.
        // recipes.og_cache is populated lazily by the web's renderer,
        // so iOS gets the preview "for free" once a recipe has been
        // viewed on macrolens.app at least once.
        if let og = working.og_cache, !blocked, og.title?.isEmpty == false || og.image?.isEmpty == false {
            Link(destination: target) {
                VStack(alignment: .leading, spacing: 0) {
                    if let imgUrl = og.image, let u = URL(string: imgUrl) {
                        AsyncImage(url: u) { phase in
                            switch phase {
                            case .success(let img):
                                img.resizable().aspectRatio(contentMode: .fill)
                            default:
                                Theme.bg3
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 160)
                        .clipped()
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        if let site = og.siteName, !site.isEmpty {
                            Text(site.uppercased())
                                .font(.system(size: 10))
                                .tracking(1.0)
                                .foregroundStyle(Theme.text3)
                        }
                        if let title = og.title, !title.isEmpty {
                            Text(title)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Theme.text)
                                .lineLimit(2)
                        }
                        if let desc = og.description, !desc.isEmpty {
                            Text(desc)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.text3)
                                .lineLimit(2)
                        }
                        Text("View original ↗")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.accent)
                            .padding(.top, 2)
                    }
                    .padding(12)
                }
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
                .clipShape(.rect(cornerRadius: 10))
            }
        } else {
            Link(destination: target) {
                HStack(spacing: 8) {
                    Image(systemName: isInstagram ? "camera.fill"
                                       : isTikTok ? "music.note"
                                       : "link")
                        .foregroundStyle(Theme.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(isInstagram ? "View on Instagram"
                             : isTikTok ? "View on TikTok"
                             : "View original recipe")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.accent)
                        Text(domain)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text3)
                    }
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
            }
        }
    }

    private var servingsRow: some View {
        let base = working.servings ?? 1
        let label = working.serving_label ?? "serving"
        return HStack(spacing: 12) {
            Text("Servings:")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text2)
            Text("\(formatServings(base)) \(plural(label, base))")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.text)
            Spacer()
            Text("per serving")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
    }

    private var macrosRow: some View {
        HStack(spacing: 6) {
            MacroChip(.calories, label: "Cal", amount: working.calories ?? 0)
            MacroChip(.protein, label: "P", amount: working.protein ?? 0)
            MacroChip(.carbs, label: "C", amount: working.carbs ?? 0)
            MacroChip(.fat, label: "F", amount: working.fat ?? 0)
            if let fiber = working.fiber, fiber > 0 {
                MacroChip(.fiber, label: "Fbr", amount: fiber)
            }
            Spacer(minLength: 0)
        }
    }

    private var tagsRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Tags")
                .font(.system(size: 11, weight: .medium))
                .tracking(1.0).textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            FlowLayout(spacing: 6) {
                ForEach(working.tags ?? [], id: \.self) { tag in
                    Text(tag)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.carbs)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Theme.carbs.opacity(0.10), in: .rect(cornerRadius: 999))
                        .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.carbs.opacity(0.25), lineWidth: 1))
                }
            }
        }
    }

    // MARK: - Tab segment

    private var tabSegment: some View {
        let hasSteps = (working.instructions?.steps.isEmpty == false)
        return HStack(spacing: 0) {
            tabPill(title: "Ingredients", isActive: tab == .ingredients) {
                tab = .ingredients
            }
            tabPill(title: "Instructions",
                    isActive: hasSteps && tab == .instructions,
                    enabled: hasSteps || true /* always tappable so user can see "Generate" CTA */) {
                tab = .instructions
            }
        }
        .padding(3)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
    }

    private func tabPill(title: String, isActive: Bool, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(isActive ? Theme.accent : Theme.text3)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(isActive ? Theme.accent.opacity(0.18) : Color.clear,
                            in: .rect(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(isActive ? Theme.accent.opacity(0.35) : Color.clear, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    // MARK: - Ingredients

    private var ingredientsCard: some View {
        let base = working.servings ?? 1
        let ingredients = working.ingredients ?? []
        let multiplier = (base > 0 && scaledServings > 0) ? scaledServings / base : 1.0
        return VStack(alignment: .leading, spacing: 10) {
            scalerRow(label: "Scale to:")

            // Rows
            if ingredients.isEmpty {
                Text("No ingredients yet.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
                    .background(Theme.bg2, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(ingredients.enumerated()), id: \.offset) { idx, ing in
                        ingredientRow(ing, multiplier: multiplier, isLast: idx == ingredients.count - 1)
                    }
                }
                .background(Theme.bg2, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
            }
        }
    }

    private func ingredientRow(_ ing: RecipeIngredient, multiplier: Double, isLast: Bool) -> some View {
        let raw = ing.amountValue
        let scaled = raw * multiplier
        let amtText: String = {
            if scaled == 0 {
                return ing.amount ?? ""
            }
            return AmountParser.format(scaled)
        }()
        return HStack(spacing: 10) {
            Text("\(amtText) \(ing.unit ?? "")")
                .font(.system(size: 13, weight: multiplier != 1 && raw > 0 ? .semibold : .regular))
                .foregroundStyle(Theme.accent)
                .frame(minWidth: 90, alignment: .leading)
            Text(ing.name)
                .font(.system(size: 13))
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .overlay(alignment: .bottom) {
            if !isLast {
                Rectangle().fill(Theme.border).frame(height: 1)
            }
        }
    }

    // MARK: - Instructions

    @ViewBuilder
    private var instructionsCard: some View {
        let steps = working.instructions?.steps ?? []
        let base = working.servings ?? 1
        let target = scaledServings
        VStack(alignment: .leading, spacing: 10) {
            if !steps.isEmpty {
                instructionsHeaderRow
                scalerRow(label: "Making:")
                if let prep = working.instructions?.prep_time, !prep.isEmpty {
                    timeRow(prep: prep, cook: working.instructions?.cook_time)
                } else if let cook = working.instructions?.cook_time, !cook.isEmpty {
                    timeRow(prep: nil, cook: cook)
                }
                instructionsList(steps: steps, base: base, target: target)
                if let tips = working.instructions?.tips, !tips.isEmpty {
                    tipsBlock(tips)
                }
                regenerateButton
            } else {
                noInstructionsBlock
            }

            if let err = generateError {
                Text(err).font(.system(size: 12)).foregroundStyle(Theme.red)
            }
        }
    }

    private var instructionsHeaderRow: some View {
        HStack(spacing: 8) {
            Spacer()
            if onCook != nil {
                Button { onCook?(working) } label: {
                    Label("Read aloud", systemImage: "speaker.wave.2.fill")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Theme.bg3, in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func timeRow(prep: String?, cook: String?) -> some View {
        HStack(spacing: 16) {
            if let prep, !prep.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "timer").font(.system(size: 11))
                    Text("Prep ").foregroundStyle(Theme.text3)
                    Text(prep).fontWeight(.semibold)
                }
            }
            if let cook, !cook.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "flame").font(.system(size: 11))
                    Text("Cook ").foregroundStyle(Theme.text3)
                    Text(cook).fontWeight(.semibold)
                }
            }
            Spacer()
        }
        .font(.system(size: 13))
        .foregroundStyle(Theme.text2)
    }

    private func instructionsList(steps: [String], base: Double, target: Double) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(steps.enumerated()), id: \.offset) { idx, step in
                let scaled = StepTextScaler.scale(step, base: base, target: target)
                HStack(alignment: .top, spacing: 10) {
                    Text("\(idx + 1).")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .frame(minWidth: 22, alignment: .trailing)
                    Text(scaled)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.text)
                        .lineSpacing(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.horizontal, 4)
    }

    private func tipsBlock(_ tips: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Tips")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.0).textCase(.uppercase)
                .foregroundStyle(Theme.accent)
            ForEach(Array(tips.enumerated()), id: \.offset) { _, t in
                HStack(alignment: .top, spacing: 6) {
                    Text("•").foregroundStyle(Theme.accent)
                    Text(t)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(12)
        .background(Theme.accent.opacity(0.06), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.18), lineWidth: 1))
    }

    private var regenerateButton: some View {
        Button {
            Task { await generateInstructions() }
        } label: {
            HStack(spacing: 6) {
                if generatingInstructions { ProgressView().controlSize(.small) }
                else { Image(systemName: "sparkles") }
                Text(generatingInstructions ? "Regenerating..." : "Regenerate instructions")
                    .font(.system(size: 12, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .foregroundStyle(Theme.text3)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(generatingInstructions || !canEditInstructions)
    }

    private var noInstructionsBlock: some View {
        VStack(spacing: 12) {
            Text("No instructions yet")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.text2)
            if canEditInstructions {
                Button {
                    Task { await generateInstructions() }
                } label: {
                    HStack(spacing: 6) {
                        if generatingInstructions { ProgressView().controlSize(.small) }
                        else { Image(systemName: "sparkles") }
                        Text(generatingInstructions ? "Generating..." : "Generate cooking instructions with AI")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .foregroundStyle(Theme.accentFG)
                    .background(Theme.accent, in: .rect(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .disabled(generatingInstructions)
            } else {
                Text("Read-only recipe — copy this to your library to generate instructions.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(Theme.bg2, in: .rect(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Theme.border, style: .init(lineWidth: 1, dash: [5, 4]))
        )
    }

    /// Generate-instructions is a `recipes`-row UPDATE under the user's
    /// own user_id. Other-provider recipes injected for read-only viewing
    /// fail server-side, so we gate the CTA up front. Currently we don't
    /// surface other-provider recipes in the iOS app at all, so this is
    /// effectively `true` — but we keep the gate so the parity is exact
    /// when the providers tab lands.
    private var canEditInstructions: Bool {
        // No user check available locally; the AppState would need to
        // expose currentUserID. Conservative default: allow everything,
        // since the iOS Recipes tab only loads recipes the current user
        // owns (RecipeService.fetchLibrary filters on user_id).
        true
    }

    private func generateInstructions() async {
        generatingInstructions = true
        generateError = nil
        defer { generatingInstructions = false }
        do {
            let result = try await AnalyzeService.generateRecipeInstructions(working)
            // Persist via the targeted update so we don't risk clobbering
            // ingredients/macros, then splice the bumped version in.
            let saved = try await DBService.saveRecipeInstructions(recipeId: working.id, instructions: result)
            working.instructions = result
            working.instructions_version = saved.instructions_version
            tab = .instructions
            // Propagate to the parent (pager + library) so the toolbar's
            // Edit button picks up the latest instructions and the cooking-
            // mode launcher uses the new instructions_version cache key.
            onChanged?(working)
        } catch {
            generateError = error.localizedDescription
        }
    }

    // MARK: - Servings scaler shared by both tabs

    private func scalerRow(label: String) -> some View {
        let base = working.servings ?? 1
        return HStack(spacing: 8) {
            Text("Base:")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
            Text("\(formatServings(base)) \(plural(working.serving_label ?? "serving", base))")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text("→ \(label)")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
            Stepper(value: $scaledServings, in: 0.5...64, step: 0.5) {
                EmptyView()
            }
            .labelsHidden()
            Text(formatServings(scaledServings))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.accent)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
    }

    // MARK: - Bottom actions

    private var actionsRow: some View {
        HStack(spacing: 10) {
            Button(role: .destructive) {
                Task { await delete() }
            } label: {
                if isDeleting {
                    ProgressView().controlSize(.small)
                        .frame(maxWidth: .infinity)
                } else {
                    Text("Delete").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered)
            .tint(Theme.red)
            .disabled(isDeleting)

            Button {
                onEdit(working)
            } label: {
                Text("Edit").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .disabled(isDeleting)
        }
        .padding(.top, 6)
    }

    private func delete() async {
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await DBService.deleteRecipe(id: working.id)
            onDeleted()
        } catch {
            deleteError = error.localizedDescription
        }
    }

    private func formatServings(_ v: Double) -> String {
        if v.truncatingRemainder(dividingBy: 1) == 0 { return String(Int(v)) }
        return String(format: "%g", (v * 10).rounded() / 10)
    }

    private func plural(_ word: String, _ count: Double) -> String {
        count == 1 ? word : "\(word)s"
    }
}

/// Toolbar/title application gated on `embedded`. When the detail view is
/// inside a pager, the pager owns the NavigationStack toolbar (so the title
/// reflects whichever page is currently visible) and we apply nothing here.
/// Standalone uses (legacy callers, plus future surfaces) keep the original
/// title + Close + Edit toolbar by passing embedded:false.
private struct NavToolbarIfNeeded: ViewModifier {
    let embedded: Bool
    let title: String
    let onClose: () -> Void
    let onEdit: () -> Void

    func body(content: Content) -> some View {
        if embedded {
            content
        } else {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Close", action: onClose)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Edit", action: onEdit)
                            .foregroundStyle(Theme.accent)
                    }
                }
        }
    }
}

/// Tiny flow layout — wraps tag chips onto multiple lines without us
/// reaching for an external dependency. iOS 16 has no Layout primitive
/// that does flexible wrap; this honors the project's iOS-17 target.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var rows: [[CGSize]] = [[]]
        var rowWidths: [CGFloat] = [0]
        for sv in subviews {
            let s = sv.sizeThatFits(.unspecified)
            let lastIdx = rows.count - 1
            let trial = rowWidths[lastIdx] + (rows[lastIdx].isEmpty ? 0 : spacing) + s.width
            if trial > width && !rows[lastIdx].isEmpty {
                rows.append([s])
                rowWidths.append(s.width)
            } else {
                rows[lastIdx].append(s)
                rowWidths[lastIdx] = trial
            }
        }
        let height = rows.reduce(0) { acc, row in
            let rowH = row.map(\.height).max() ?? 0
            return acc + rowH + (acc == 0 ? 0 : spacing)
        }
        let widest = rowWidths.max() ?? 0
        return CGSize(width: min(widest, width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowH: CGFloat = 0
        for sv in subviews {
            let s = sv.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX && x > bounds.minX {
                x = bounds.minX
                y += rowH + spacing
                rowH = 0
            }
            sv.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
    }
}
