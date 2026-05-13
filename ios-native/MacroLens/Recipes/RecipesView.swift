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
    /// Plan sheet bound on the parent ONLY for the context-menu shortcut
    /// (long-press a recipe card → Plan). The in-detail path now opens its
    /// own local sheet on RecipeDetailView so it stacks correctly above the
    /// detail. No stacking issue here because the context menu fires when
    /// no detail sheet is showing.
    @State private var planningFromCard: RecipeFull?
    /// Share sheet bound on the parent ONLY for the context-menu shortcut
    /// (long-press a recipe card → Share). The in-detail path now opens
    /// its own local sheet on RecipeDetailView so the system share sheet
    /// stacks correctly above the detail — same fix pattern as plan and
    /// cooking mode. No stacking issue here because the context menu
    /// fires when no detail sheet is showing.
    @State private var sharingFromCard: RecipeFull?
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
    @FocusState private var searchFocused: Bool

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
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Recipes")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if searchFocused {
                    Button("Done") { searchFocused = false }
                }
            }
        }
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
                    onPlanned: {
                        // Plan sheet now presents from inside the detail
                        // (no parent state involved). This callback only
                        // fires the planner refresh after a successful
                        // save so the user sees their meal in Planner
                        // tab without a manual reload.
                        Task { await state.loadPlanner(weekStart: PlannerDateMath.currentWeekStart()) }
                    },
                    onShareChanged: { recipeId, isShared, newToken in
                        // Share sheet now presents from inside the detail
                        // (same in-place fix). This hook just mirrors
                        // is_shared / share_token back into the library
                        // card so re-opening the recipe shows the latest
                        // state without a refetch.
                        if let idx = library.firstIndex(where: { $0.id == recipeId }) {
                            library[idx].is_shared = isShared
                            if let newToken { library[idx].share_token = newToken }
                        }
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
                                       spliceIntoLibrary(saved)
                                       presented = .viewExisting(saved)
                                       Task { await refresh() }
                                   },
                                   onCancel: {
                                       presented = .viewExisting(r)
                                   },
                                   onDeleted: {
                                       presented = nil
                                       Task { await refresh() }
                                   },
                                   availableTags: globalAvailableTags())
                }
            case .newDraft(let r):
                NavigationStack {
                    RecipeEditView(recipe: r,
                                   onSaved: { saved in
                                       spliceIntoLibrary(saved)
                                       presented = .viewExisting(saved)
                                       Task { await refresh() }
                                   },
                                   onCancel: { presented = nil },
                                   onDeleted: { presented = nil },
                                   availableTags: globalAvailableTags())
                }
            }
        }
        // Plan sheet for the in-detail tap is no longer presented from
        // this parent — moved onto RecipeDetailView so the calendar
        // picker stacks above the detail immediately. Same fix as the
        // cooking-mode commit (151fc7e). This binding here only handles
        // the context-menu shortcut (long-press a card → Plan), which
        // never collides with a detail sheet.
        .sheet(item: $planningFromCard) { recipe in
            PlanRecipeSheet(recipe: recipe) {
                Task { await state.loadPlanner(weekStart: PlannerDateMath.currentWeekStart()) }
            }
            .presentationDetents([.medium, .large])
        }
        // Share sheet for the in-detail tap is no longer presented from
        // this parent — moved onto RecipeDetailView so the system share
        // sheet stacks above the detail immediately. Same fix pattern as
        // the cooking-mode and plan-sheet commits. This binding here only
        // handles the context-menu shortcut (long-press a card → Share),
        // which never collides with a detail sheet.
        .sheet(item: $sharingFromCard) { recipe in
            RecipeShareSheet(
                recipeId: recipe.id,
                recipeName: recipe.name,
                initialToken: recipe.share_token,
                initialIsShared: recipe.is_shared ?? false
            ) { isShared, newToken in
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
            TagOrderEditorSheet(initialOrder: display, library: library) { payload in
                applyTagPayload(payload)
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
                        .focused($searchFocused)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.text)
                        .submitLabel(.search)
                        .onSubmit { searchFocused = false }
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
            // Manage Tags entry point — handles reorder, rename, delete,
            // and adding standalone tags. Always shown so users discover
            // it; on a fresh account they can pre-create tags here before
            // any recipe carries one.
            Button {
                tagOrderEditorOpen = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "tag")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Manage")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(Theme.text2)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Theme.bg3, in: .rect(cornerRadius: 999))
                .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.border2, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Manage tags")
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
                planningFromCard = r
            } label: {
                Label("Plan", systemImage: "calendar.badge.plus")
            }
            Button {
                sharingFromCard = r
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

    /// Global tag pool used by every editor / picker so a tag created on
    /// Recipe A immediately appears in Recipe B's picker (and in the
    /// "+ New" form's picker, the QuickTag sheet, etc). Union of:
    ///   • presets (with hidden ones filtered out)
    ///   • every custom tag actually applied across the library
    ///   • savedTagOrder — covers tags coined via the Edit Tags sheet
    ///     that aren't on any recipe yet
    /// Case is preserved from whichever source surfaced it last.
    /// `library` is a SwiftUI @State so this is recomputed on every
    /// render after refresh — no stale snapshot.
    private func globalAvailableTags() -> [String] {
        var displayMap: [String: String] = [:] // lowercase → preferred casing
        var ordered: [String] = []
        for p in RecipeTagPresets.all {
            let key = p.lowercased()
            if displayMap[key] == nil {
                displayMap[key] = p
                ordered.append(p)
            }
        }
        // Library customs first by appearance, presets de-duped above.
        for r in library {
            for t in r.tags ?? [] {
                let trimmed = t.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                let key = trimmed.lowercased()
                if displayMap[key] == nil {
                    displayMap[key] = trimmed
                    ordered.append(trimmed)
                }
            }
        }
        // Tags coined via Edit Tags sheet — they're in savedTagOrder
        // but might not be on any recipe yet. Add them last so they
        // surface as suggestions even before being applied.
        for t in savedTagOrder {
            let key = t.lowercased()
            if displayMap[key] == nil {
                displayMap[key] = t
                ordered.append(t)
            }
        }
        return ordered
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

    /// Synchronously fold a just-saved recipe into the local library so
    /// `globalAvailableTags()` (and the chip pickers downstream) see new
    /// tags BEFORE the async `refresh()` round-trip completes. Closes the
    /// race where a user could save a tag on Recipe A and immediately open
    /// Recipe B's editor — without this splice, Recipe B's pool stayed
    /// stale until the network refresh landed.
    private func spliceIntoLibrary(_ saved: RecipeFull) {
        guard !saved.id.isEmpty else { return }
        if let idx = library.firstIndex(where: { $0.id == saved.id }) {
            library[idx] = saved
        } else {
            library.append(saved)
        }
    }

    /// Apply the Manage Tags sheet's save payload: rewrite tag_order,
    /// optimistically rename + strip tags from the local library so the
    /// UI updates instantly, then persist everything in the background
    /// and refresh from the DB.
    private func applyTagPayload(_ payload: TagOrderEditorSheet.Payload) {
        // Snapshot the library BEFORE any optimistic mutation so the
        // network cascades downstream still have the affected-recipe
        // set to iterate (the local library is about to lose those
        // tag entries).
        let preSnapshot = library

        // 1. New tag_order — drives the filter strip immediately.
        savedTagOrder = payload.order

        // If the user's active filter was renamed or deleted, retarget
        // it so the strip doesn't render a "0 results" state for a tag
        // that no longer exists under that name.
        if !activeTag.isEmpty, activeTag != "__untagged__" {
            let activeLower = activeTag.lowercased()
            if payload.deletedTags.contains(where: { $0.lowercased() == activeLower }) {
                activeTag = ""
            } else if let rn = payload.renames.first(where: { $0.oldName.lowercased() == activeLower }) {
                activeTag = rn.newName
            }
        }

        // 2. Rename pass first (so a later delete on the new name still
        // works correctly).
        if !payload.renames.isEmpty {
            for rn in payload.renames {
                let oldLower = rn.oldName.lowercased()
                for i in library.indices {
                    guard let tags = library[i].tags else { continue }
                    var seen: Set<String> = []
                    var out: [String] = []
                    for t in tags {
                        let mapped = (t.lowercased() == oldLower) ? rn.newName : t
                        let key = mapped.lowercased()
                        if seen.insert(key).inserted { out.append(mapped) }
                    }
                    library[i].tags = out
                }
            }
        }

        // 3. Delete pass — strip every deleted tag from each local row.
        if !payload.deletedTags.isEmpty {
            let deletedLower = Set(payload.deletedTags.map { $0.lowercased() })
            for i in library.indices {
                if let tags = library[i].tags {
                    library[i].tags = tags.filter { !deletedLower.contains($0.lowercased()) }
                }
            }
        }

        Task {
            // Persist the new tag_order. Non-fatal on failure — the next
            // load will fall back to the canonical order.
            do { try await DBService.saveRecipeTagOrder(payload.order) }
            catch { print("[recipes] saveRecipeTagOrder failed: \(error.localizedDescription)") }

            // Cascade renames against the pre-mutation snapshot.
            for rn in payload.renames {
                let affected = preSnapshot.filter {
                    ($0.tags ?? []).contains { $0.lowercased() == rn.oldName.lowercased() }
                }
                do { _ = try await DBService.renameTagInRecipes(old: rn.oldName, new: rn.newName, recipes: affected) }
                catch { print("[recipes] renameTagInRecipes(\(rn.oldName)→\(rn.newName)) failed: \(error.localizedDescription)") }
            }

            // Cascade deletes against the pre-mutation snapshot.
            for tag in payload.deletedTags {
                let affected = preSnapshot.filter {
                    ($0.tags ?? []).contains { $0.lowercased() == tag.lowercased() }
                }
                do { _ = try await DBService.removeTagFromRecipes(tag, recipes: affected) }
                catch { print("[recipes] removeTagFromRecipes(\(tag)) failed: \(error.localizedDescription)") }
            }

            // Reconcile with DB if anything was a cascade — covers edge
            // cases the optimistic pass might have missed.
            if !payload.deletedTags.isEmpty || !payload.renames.isEmpty {
                await refresh()
            }
        }
    }
}
