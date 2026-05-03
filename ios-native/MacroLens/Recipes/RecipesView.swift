import SwiftUI

/// Native Recipes tab — the second-largest tab on the web, ported with
/// the must-haves only:
///   - Library list w/ search + tag filter
///   - Detail sheet (ingredients, macros, scaling)
///   - Edit / new sheet (form + AI extract / estimate / recalc)
///   - Ingredient extraction from text or photo (recipe-mode AI)
///
/// Cooking-mode read-aloud, public sharing, planner targeting, and the
/// provider broadcast preview are deliberately not in scope for the
/// first iOS pass — those rely on web-only browser APIs (SpeechSynthesis,
/// share sheets driven by router state) or require the planner port to
/// be live first.
///
/// The view owns its own `[RecipeFull]` slice so the wider columns
/// (description, tags, ingredients, source_url) can be rendered without
/// touching Networking/Models.swift's narrower RecipeRow projection.
/// AppState.loadRecipesFull() is still called on each refresh so the
/// dashboard's `recipesFull` cache stays warm.
struct RecipesView: View {
    @Environment(AppState.self) private var state
    @State private var library: [RecipeFull] = []
    @State private var loading: Bool = false
    @State private var loadError: String?

    @State private var searchText: String = ""
    @State private var activeTag: String = ""        // "" = All, "__untagged__" = Untagged

    @State private var presented: PresentedRecipe?
    @State private var planning: RecipeFull?
    @State private var sharing: RecipeFull?
    @State private var tagging: RecipeFull?
    @State private var tagOrderEditorOpen: Bool = false
    /// Opens the "Add a recipe" method picker (Link / Photo / Manual /
    /// Generate) when the user taps + New. The picker dispatches to a
    /// pre-fill sub-flow then sets `presented = .newDraft(prefilled)` to
    /// hand off to RecipeEditView.
    @State private var newRecipePickerOpen: Bool = false
    /// User-saved tag order. Empty == "use the canonical fallback order"
    /// (presets first, then alphabetical custom tags). Loaded once per
    /// session via .task; mutations write through both this @State and
    /// the user_profiles row.
    @State private var savedTagOrder: [String] = []

    enum PresentedRecipe: Identifiable {
        case viewExisting(RecipeFull)
        case editExisting(RecipeFull)
        case newDraft(RecipeFull)

        var id: String {
            switch self {
            case .viewExisting(let r): return "view-" + r.id
            case .editExisting(let r): return "edit-" + r.id
            case .newDraft: return "new"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                greeting
                searchBar
                if !library.isEmpty {
                    tagBar
                }
                content
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .navigationTitle("Recipes")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await refresh() }
        .task {
            if library.isEmpty { await refresh() }
            await loadTagOrder()
        }
        .sheet(item: $presented) { which in
            switch which {
            case .viewExisting(let r):
                // Pager wraps the detail view so horizontal swipes pan
                // through the same filtered list the user is browsing.
                // Snapshot is taken at present-time, so a debounced search
                // typing while the sheet is open won't yank pages out from
                // under the user.
                let snapshot = filtered()
                let startIdx = snapshot.firstIndex(where: { $0.id == r.id }) ?? 0
                RecipeDetailPager(
                    recipes: snapshot,
                    initialIndex: startIdx,
                    onEdit: { editing in
                        presented = .editExisting(editing)
                    },
                    onDeleted: {
                        presented = nil
                        Task { await refresh() }
                    },
                    onPlan: { recipe in
                        planning = recipe
                    },
                    onShare: { recipe in
                        sharing = recipe
                    },
                    onChanged: { updated in
                        // Mid-swipe in-pager mutations (e.g. instructions
                        // generated and saved) splice back into the library
                        // so re-entering the sheet shows the latest data.
                        if let idx = library.firstIndex(where: { $0.id == updated.id }) {
                            library[idx] = updated
                        }
                    }
                )
            case .editExisting(let r):
                NavigationStack {
                    RecipeEditView(recipe: r,
                                   onSaved: { saved in
                                       presented = .viewExisting(saved)
                                       Task { await refresh() }
                                   },
                                   onCancel: {
                                       presented = .viewExisting(r)
                                   },
                                   onDeleted: {
                                       presented = nil
                                       Task { await refresh() }
                                   })
                }
            case .newDraft(let r):
                NavigationStack {
                    RecipeEditView(recipe: r,
                                   onSaved: { saved in
                                       presented = .viewExisting(saved)
                                       Task { await refresh() }
                                   },
                                   onCancel: { presented = nil },
                                   onDeleted: { presented = nil })
                }
            }
        }
        .sheet(item: $planning) { recipe in
            PlanRecipeSheet(recipe: recipe) {
                // Refresh the planner for whatever week is currently shown
                // so a user who plans from Recipes and then switches to
                // Planner sees the new entry without a manual reload.
                Task { await state.loadPlanner(weekStart: PlannerDateMath.currentWeekStart()) }
            }
        }
        .sheet(item: $sharing) { recipe in
            RecipeShareSheet(
                recipeId: recipe.id,
                recipeName: recipe.name,
                initialToken: recipe.share_token,
                initialIsShared: recipe.is_shared ?? false
            ) { isShared, newToken in
                // Splice the new sharing state into the local library so
                // re-opening the recipe immediately reflects the change
                // (the detail view's Share button label flips Shared ↔
                // Share without needing a fetch round-trip).
                if let idx = library.firstIndex(where: { $0.id == recipe.id }) {
                    library[idx].is_shared = isShared
                    library[idx].share_token = newToken ?? library[idx].share_token
                }
            }
        }
        // Cooking mode is no longer presented from this parent — moved
        // onto RecipeDetailView itself so it stacks above the detail
        // sheet and opens immediately on tap. Lifting it here used to
        // hit SwiftUI's "one sheet per view" rule and defer presentation
        // until the detail sheet dismissed.
        .sheet(item: $tagging) { recipe in
            QuickTagSheet(recipe: recipe, knownLibrary: library) { updated in
                if let idx = library.firstIndex(where: { $0.id == updated.id }) {
                    library[idx] = updated
                }
            }
        }
        .sheet(isPresented: $tagOrderEditorOpen) {
            // Build the editor's input set from the *currently displayed*
            // tag list so users see exactly the pills they're rearranging.
            let counts = tagCounts(library)
            let display = orderedDisplayTags(counts: counts)
            TagOrderEditorSheet(initialOrder: display) { newOrder in
                savedTagOrder = newOrder
                Task {
                    do {
                        try await DBService.saveRecipeTagOrder(newOrder)
                    } catch {
                        // Save failures revert to the canonical order on
                        // next load; logging keeps it findable but we
                        // don't want a transient network blip to block
                        // the close gesture.
                        print("[recipes] saveRecipeTagOrder failed: \(error.localizedDescription)")
                    }
                }
            }
        }
        .sheet(isPresented: $newRecipePickerOpen) {
            NewRecipeMethodSheet { prefilled in
                // Picker dismissed itself before this fires. Defer the
                // .newDraft presentation by one runloop turn so SwiftUI
                // finishes the dismiss animation cleanly before opening
                // the next sheet — back-to-back state mutations on .sheet
                // bindings can otherwise drop the second presentation.
                DispatchQueue.main.async {
                    presented = .newDraft(prefilled)
                }
            }
        }
    }

    // MARK: - Sections

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Recipes")
                .font(.system(size: 26, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
            Text("Saved recipes with ingredients and macros per serving.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text3)
        }
        .padding(.top, 12)
    }

    private var searchBar: some View {
        HStack(spacing: 10) {
            if !library.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text3)
                    TextField("Search recipes by name or ingredient",
                              text: $searchText)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.text)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    if !searchText.isEmpty {
                        Button { searchText = "" } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(Theme.text3)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
            }
            Button {
                // Opens the method picker first (mirrors the web's
                // `openNewRecipeModal` 4-card chooser). The picker hands
                // back a pre-filled draft for whichever path the user
                // takes; we then push RecipeEditView with that draft.
                newRecipePickerOpen = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "plus")
                    Text("New")
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.accentFG)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Theme.accent, in: .rect(cornerRadius: 10))
            }
        }
    }

    private var tagBar: some View {
        let counts = tagCounts(library)
        let untaggedCount = library.filter { ($0.tags ?? []).isEmpty }.count
        let display = orderedDisplayTags(counts: counts)

        return HStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    tagPill(label: "All", value: "", count: library.count, isActive: activeTag.isEmpty)
                    if untaggedCount > 0 {
                        tagPill(label: "Untagged", value: "__untagged__",
                                count: untaggedCount,
                                isActive: activeTag == "__untagged__")
                    }
                    ForEach(display, id: \.self) { tag in
                        tagPill(label: tag,
                                value: tag,
                                count: counts[tag.lowercased()] ?? 0,
                                isActive: activeTag.lowercased() == tag.lowercased())
                    }
                }
                .padding(.vertical, 4)
            }
            // Pencil affordance to enter reorder mode. Hidden when there
            // are 0–1 tags (nothing meaningful to reorder) so the bar stays
            // clean for users who haven't built up a tag library yet.
            if display.count >= 2 {
                Button {
                    tagOrderEditorOpen = true
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.text3)
                        .frame(width: 28, height: 28)
                        .background(Theme.bg3, in: .circle)
                        .overlay(Circle().stroke(Theme.border2, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Reorder tags")
            }
        }
    }

    private func tagPill(label: String, value: String, count: Int, isActive: Bool) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.12)) {
                activeTag = (activeTag.lowercased() == value.lowercased()) ? "" : value
            }
        } label: {
            HStack(spacing: 4) {
                Text(label)
                    .font(.system(size: 12, weight: .medium))
                if count > 0 {
                    Text("\(count)").opacity(0.6).font(.system(size: 11))
                }
            }
            .foregroundStyle(isActive ? Theme.accent : Theme.text2)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(isActive ? Theme.accentSoft(0.15) : Theme.bg3, in: .rect(cornerRadius: 999))
            .overlay(
                RoundedRectangle(cornerRadius: 999)
                    .stroke(isActive ? Theme.accent : Theme.border2, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var content: some View {
        if loading && library.isEmpty {
            HStack { Spacer(); ProgressView().tint(Theme.accent); Spacer() }
                .padding(.vertical, 60)
        } else if let err = loadError, library.isEmpty {
            EmptyState(icon: "exclamationmark.triangle",
                       title: "Couldn't load recipes",
                       message: err) {
                Button("Retry") { Task { await refresh() } }
                    .buttonStyle(.bordered)
                    .tint(Theme.accent)
            }
        } else {
            let visible = filtered()
            if visible.isEmpty {
                emptyMessage
            } else {
                LazyVStack(spacing: 12) {
                    ForEach(visible) { r in
                        recipeCardRow(r)
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    private var emptyMessage: some View {
        let q = searchText.trimmingCharacters(in: .whitespaces)
        let hasSearch = !q.isEmpty
        let hasTag = !activeTag.isEmpty
        let title: String
        let message: String?
        if library.isEmpty {
            title = "No recipes saved yet"
            message = "Tap + New to add one, or analyze a meal and save it as a recipe from the dashboard."
        } else if hasSearch && hasTag {
            title = "No matches"
            message = "Nothing in \(displayTag(activeTag)) matches \"\(q)\"."
        } else if hasSearch {
            title = "No matches"
            message = "Nothing matches \"\(q)\"."
        } else if hasTag {
            title = "No recipes tagged \(displayTag(activeTag))"
            message = "Try a different filter."
        } else {
            title = "No recipes yet"
            message = nil
        }
        return EmptyState(icon: "book.closed", title: title, message: message)
            .padding(.top, 12)
    }

    /// Tappable card row with a context menu that exposes the most-used
    /// per-recipe actions (Tag / Plan / Share) without forcing the user
    /// into the detail sheet first. Long-press to bring up the menu.
    private func recipeCardRow(_ r: RecipeFull) -> some View {
        Button {
            presented = .viewExisting(r)
        } label: {
            recipeCard(r)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                tagging = r
            } label: {
                Label("Tag", systemImage: "tag")
            }
            Button {
                planning = r
            } label: {
                Label("Plan", systemImage: "calendar.badge.plus")
            }
            Button {
                sharing = r
            } label: {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        }
    }

    private func recipeCard(_ r: RecipeFull) -> some View {
        let tags = r.tags ?? []
        let servings = Int(r.servings ?? 1)
        return Card(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(r.name)
                        .font(.system(size: 17, weight: .semibold, design: .serif))
                        .foregroundStyle(Theme.text)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("\(servings) serving\(servings == 1 ? "" : "s")")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Theme.bg3, in: .rect(cornerRadius: 4))
                }
                if let desc = r.description, !desc.isEmpty {
                    Text(desc)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text2)
                        .lineLimit(2)
                }
                HStack(spacing: 6) {
                    MacroChip(.calories, label: "Cal", amount: r.calories ?? 0)
                    MacroChip(.protein, label: "P", amount: r.protein ?? 0)
                    MacroChip(.carbs, label: "C", amount: r.carbs ?? 0)
                    MacroChip(.fat, label: "F", amount: r.fat ?? 0)
                }
                if !tags.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(Array(tags.prefix(4).enumerated()), id: \.offset) { _, t in
                            Text(t)
                                .font(.system(size: 10))
                                .foregroundStyle(Theme.carbs)
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(Theme.carbs.opacity(0.10), in: .rect(cornerRadius: 999))
                                .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.carbs.opacity(0.25), lineWidth: 1))
                        }
                        if tags.count > 4 {
                            Text("+\(tags.count - 4)")
                                .font(.system(size: 10))
                                .foregroundStyle(Theme.text3)
                        }
                    }
                }
                if let ings = r.ingredients, !ings.isEmpty {
                    Text("\(ings.count) ingredient\(ings.count == 1 ? "" : "s") · per 1 of \(servings)")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
            }
        }
    }

    // MARK: - Helpers

    private func filtered() -> [RecipeFull] {
        let tagFiltered: [RecipeFull]
        if activeTag.isEmpty {
            tagFiltered = library
        } else if activeTag == "__untagged__" {
            tagFiltered = library.filter { ($0.tags ?? []).isEmpty }
        } else {
            tagFiltered = library.filter { r in
                (r.tags ?? []).contains(where: { $0.lowercased() == activeTag.lowercased() })
            }
        }
        return RecipeSearch.filter(tagFiltered, query: searchText)
    }

    /// Final tag list used by the filter strip. The user's persisted
    /// tag_order wins where it has positions; everything else falls back
    /// to the canonical order (presets, then alphabetical custom tags).
    /// Tags returned here use the casing of the most-recent occurrence
    /// the user has on a recipe (or the preset's canonical casing when
    /// nothing else is available), matching the web's display behavior.
    private func orderedDisplayTags(counts: [String: Int]) -> [String] {
        // Build the display-cased map (tagLower → preferred casing)
        var displayCase: [String: String] = [:]
        for r in library {
            for t in r.tags ?? [] {
                let trimmed = t.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                displayCase[trimmed.lowercased()] = trimmed
            }
        }
        for p in RecipeTagPresets.all {
            if displayCase[p.lowercased()] == nil {
                displayCase[p.lowercased()] = p
            }
        }

        // Canonical fallback: presets first (in their declared order),
        // then everything else alphabetical.
        var canonical: [String] = []
        var canonicalSet: Set<String> = []
        for p in RecipeTagPresets.all {
            if canonicalSet.insert(p.lowercased()).inserted {
                canonical.append(displayCase[p.lowercased()] ?? p)
            }
        }
        let customs = counts.keys
            .filter { tag in !RecipeTagPresets.all.contains(where: { $0.lowercased() == tag.lowercased() }) }
            .sorted()
        for c in customs {
            if canonicalSet.insert(c).inserted {
                canonical.append(displayCase[c] ?? c)
            }
        }

        // Apply the user's saved order: keep entries that still exist in
        // canonical (tag may have been deleted off all recipes since the
        // user reordered), then append any canonical tag the user hasn't
        // explicitly positioned.
        let canonicalLower = Set(canonical.map { $0.lowercased() })
        var seen: Set<String> = []
        var ordered: [String] = []
        for t in savedTagOrder {
            let key = t.lowercased()
            if canonicalLower.contains(key), seen.insert(key).inserted {
                ordered.append(displayCase[key] ?? t)
            }
        }
        for c in canonical where seen.insert(c.lowercased()).inserted {
            ordered.append(c)
        }
        return ordered
    }

    private func loadTagOrder() async {
        do {
            let order = try await DBService.getRecipeTagOrder()
            savedTagOrder = order
        } catch {
            // Non-fatal — fall back to canonical order. Same behavior as
            // a brand new account where tag_order is empty.
            savedTagOrder = []
        }
    }

    private func tagCounts(_ rows: [RecipeFull]) -> [String: Int] {
        var out: [String: Int] = [:]
        for r in rows {
            for t in r.tags ?? [] {
                let trimmed = t.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                out[trimmed.lowercased(), default: 0] += 1
            }
        }
        return out
    }

    private func displayTag(_ t: String) -> String {
        t == "__untagged__" ? "Untagged" : t
    }

    private func refresh() async {
        loading = true
        defer { loading = false }
        async let app: () = state.loadRecipesFull()
        do {
            let rows = try await RecipeService.fetchLibrary()
            library = rows
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        await app
    }
}
