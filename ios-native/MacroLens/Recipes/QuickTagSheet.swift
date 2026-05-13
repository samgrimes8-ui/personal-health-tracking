import SwiftUI

/// One-tap tagging from the recipe card. Mirrors the quick-tag modal in
/// src/pages/app.js (`openQuickTagModal` / `renderQuickTagModal`):
/// minimal sheet with chip toggles for every known tag, an inline custom-
/// tag input, and an immediate save on every change. Saves go through
/// `DBService.saveRecipe` with the full RecipeUpsert payload, since
/// Supabase upsert needs all required columns.
struct QuickTagSheet: View {
    let recipe: RecipeFull
    /// All recipes in the library — used to extend the tag suggestion pool
    /// with whatever custom tags the user has already coined elsewhere.
    let knownLibrary: [RecipeFull]
    /// Notified after every successful save so the parent's library list
    /// stays in sync without a round-trip to fetch the row back.
    let onChanged: (RecipeFull) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var working: RecipeFull
    @State private var saving: Bool = false
    @State private var error: String?
    /// Per-tag-key lock so rapid double-taps don't fire overlapping upserts.
    @State private var inFlight: Set<String> = []
    @FocusState private var keyboardFocused: Bool
    /// Authoritative tag pool, fetched fresh from the DB on `.task`.
    /// Seeded synchronously from `knownLibrary` so the chips render
    /// without a flash, then overwritten by the DB result. Defense-in-
    /// depth on top of the parent's optimistic splice — covers the case
    /// where a tag created elsewhere hasn't reached the parent's library
    /// snapshot yet (cold start, concurrent edits, etc).
    @State private var livePool: [String] = []

    init(recipe: RecipeFull,
         knownLibrary: [RecipeFull],
         onChanged: @escaping (RecipeFull) -> Void) {
        self.recipe = recipe
        self.knownLibrary = knownLibrary
        self.onChanged = onChanged
        _working = State(initialValue: recipe)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    headerBlock
                    chipsBlock
                    customTagInput
                    if let err = error {
                        Text(err).font(.system(size: 12)).foregroundStyle(Theme.red)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 28)
            }
            .background(Theme.bg)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Tag recipe")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.accent)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    if keyboardFocused {
                        Button("Done") { keyboardFocused = false }
                    }
                }
            }
            .task {
                // Seed from the parent snapshot for a no-flash first render,
                // then fetch the canonical pool. The fetch wins because it
                // includes user_profiles.tag_order (standalone tags from
                // Manage Tags) which the parent library snapshot lacks.
                if livePool.isEmpty {
                    livePool = Self.derivePool(from: knownLibrary)
                }
                do {
                    livePool = try await DBService.fetchTagLibrary()
                } catch {
                    print("[recipes] fetchTagLibrary (QuickTag) failed: \(error.localizedDescription)")
                }
            }
        }
    }

    /// Initial seed: union of customs already applied across the library
    /// snapshot the parent handed in. Used only until `.task` lands the
    /// authoritative DB pool.
    private static func derivePool(from library: [RecipeFull]) -> [String] {
        var seen: Set<String> = []
        var out: [String] = []
        for r in library {
            for t in r.tags ?? [] {
                let trimmed = t.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                if seen.insert(trimmed.lowercased()).inserted {
                    out.append(trimmed)
                }
            }
        }
        return out
    }

    // MARK: - Sections

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(working.name)
                .font(.system(size: 18, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
                .lineLimit(2)
            Text("Tap any tag to toggle. Saves immediately — no need to hit Done first.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
        }
    }

    private var chipsBlock: some View {
        let suggestions = knownTags()
        return FlowLayout(spacing: 6) {
            ForEach(suggestions, id: \.self) { tag in
                let isOn = (working.tags ?? []).contains(where: { $0.lowercased() == tag.lowercased() })
                let key = tag.lowercased()
                Button {
                    Task { await toggle(tag) }
                } label: {
                    HStack(spacing: 4) {
                        if isOn {
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .bold))
                        }
                        Text(tag)
                            .font(.system(size: 12))
                    }
                    .foregroundStyle(isOn ? Theme.carbs : Theme.text2)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(isOn ? Theme.carbs.opacity(0.15) : Theme.bg3, in: .rect(cornerRadius: 999))
                    .overlay(RoundedRectangle(cornerRadius: 999).stroke(isOn ? Theme.carbs : Theme.border2, lineWidth: 1))
                    .opacity(inFlight.contains(key) ? 0.5 : 1)
                }
                .buttonStyle(.plain)
                .disabled(saving)
            }
        }
    }

    private var customTagInput: some View {
        CustomTagInputInline { newTag in
            let trimmed = newTag.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return }
            // De-dupe (case-insensitive)
            if (working.tags ?? []).contains(where: { $0.lowercased() == trimmed.lowercased() }) {
                return
            }
            Task { await toggle(trimmed) }
        }
    }

    // MARK: - Behavior

    private func toggle(_ tag: String) async {
        let key = tag.lowercased()
        if inFlight.contains(key) { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }

        var next = working.tags ?? []
        if let idx = next.firstIndex(where: { $0.lowercased() == key }) {
            next.remove(at: idx)
        } else {
            next.append(tag)
        }
        let snapshot = working
        working.tags = next

        // Persist via the standard recipe upsert. We send the full payload
        // because the upsert requires the not-null columns; the server
        // overwrites everything in one shot.
        saving = true
        error = nil
        defer { saving = false }
        let payload = RecipeUpsert(
            id: working.id.isEmpty ? nil : working.id,
            name: working.name,
            description: working.description,
            servings: working.servings,
            calories: working.calories,
            protein: working.protein,
            carbs: working.carbs,
            fat: working.fat,
            fiber: working.fiber,
            sugar: working.sugar,
            ingredients: working.ingredients,
            notes: working.notes,
            source: nil,
            sourceUrl: working.source_url,
            tags: next
        )
        do {
            _ = try await DBService.saveRecipe(payload)
            onChanged(working)
        } catch {
            // Rollback on failure
            working = snapshot
            self.error = error.localizedDescription
        }
    }

    private func knownTags() -> [String] {
        // Presets first (visible order), then the authoritative tag pool
        // (recipes ∪ tag_order, refreshed on .task). Currently-selected
        // tags always appear last even if they're not otherwise known —
        // covers a brand-new custom tag the user just typed in this
        // session and hasn't yet been written to the DB.
        var seen: Set<String> = []
        var out: [String] = []
        for t in RecipeTagPresets.all where !seen.contains(t.lowercased()) {
            seen.insert(t.lowercased())
            out.append(t)
        }
        for t in livePool where !seen.contains(t.lowercased()) {
            seen.insert(t.lowercased())
            out.append(t)
        }
        for t in (working.tags ?? []) where !seen.contains(t.lowercased()) {
            seen.insert(t.lowercased())
            out.append(t)
        }
        return out
    }
}

/// Same as RecipeEditView's CustomTagInput but renamed to avoid collision
/// with the private struct in that file. Submits when the user hits Return
/// or taps + Add, and clears on success.
private struct CustomTagInputInline: View {
    let onAdd: (String) -> Void
    @State private var text: String = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            TextField("Create a new tag...", text: $text)
                .focused($focused)
                .font(.system(size: 13))
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(Theme.bg3, in: .rect(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                .submitLabel(.done)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .onSubmit { commit(); focused = false }
            Button("+ Add", action: commit)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.text2)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Theme.bg3, in: .rect(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
        }
    }

    private func commit() {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        onAdd(t)
        text = ""
    }
}
