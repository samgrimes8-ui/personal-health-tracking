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
        }
        .sheet(item: $presented) { which in
            NavigationStack {
                switch which {
                case .viewExisting(let r):
                    RecipeDetailView(recipe: r,
                                     onEdit: { editing in
                                         presented = .editExisting(editing)
                                     },
                                     onDeleted: {
                                         presented = nil
                                         Task { await refresh() }
                                     })
                case .editExisting(let r):
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
                case .newDraft(let r):
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
                presented = .newDraft(RecipeFull.newDraft())
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
        let custom = counts.keys
            .filter { tag in !RecipeTagPresets.all.contains(where: { $0.lowercased() == tag.lowercased() }) }
            .sorted()
        let display = RecipeTagPresets.all + custom

        return ScrollView(.horizontal, showsIndicators: false) {
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
                        Button {
                            presented = .viewExisting(r)
                        } label: {
                            recipeCard(r)
                        }
                        .buttonStyle(.plain)
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
