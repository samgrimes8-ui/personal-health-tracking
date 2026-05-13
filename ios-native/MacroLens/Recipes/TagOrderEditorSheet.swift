import SwiftUI

/// Reorder + add + delete editor for the recipe tag filter strip.
/// Mirrors web's openManageTagsModal scope: drag handles to reorder,
/// "+ New tag" input to add, swipe-left to delete with a count
/// confirmation that names how many recipes the tag would be stripped
/// from. Persists via the parent's `onSave` closure rather than touching
/// DB directly — keeps this view presentation-only and lets the parent
/// reconcile the new order + the delete-tag-from-N-recipes side effect
/// in one transaction.
struct TagOrderEditorSheet: View {
    /// Tags in their currently-displayed order. Drives the initial @State
    /// of `order` so the user starts editing exactly what they're seeing
    /// in the filter strip.
    let initialOrder: [String]
    /// Library snapshot — used to compute the "removed from N recipes"
    /// confirmation copy without round-tripping to the DB.
    let library: [RecipeFull]
    let onSave: (Payload) -> Void

    /// Bundle of mutations the parent needs to apply on Save:
    ///   • `order` — final tag_order to persist on user_profiles
    ///   • `deletedTags` — case-preserving names the parent should strip
    ///     from every affected recipe.tags array
    ///   • `renames` — old→new mappings to cascade across every recipe
    ///     that currently carries the old tag
    struct Payload {
        let order: [String]
        let deletedTags: [String]
        let renames: [TagRename]
    }

    /// A single rename mapping recorded in the sheet. The parent applies
    /// these by calling DBService.renameTagInRecipes(old:new:...) for
    /// every affected recipe in its snapshot.
    struct TagRename: Equatable {
        let oldName: String
        let newName: String
    }

    @Environment(\.dismiss) private var dismiss

    @State private var order: [String]
    @State private var deletedTags: [String] = []
    @State private var renames: [TagRename] = []
    @State private var didChange: Bool = false
    @State private var newTagText: String = ""
    @State private var pendingDelete: String? = nil
    @State private var renameTarget: String? = nil
    @State private var renameDraft: String = ""
    @FocusState private var newTagFocused: Bool
    @FocusState private var renameFocused: Bool

    init(initialOrder: [String], library: [RecipeFull], onSave: @escaping (Payload) -> Void) {
        self.initialOrder = initialOrder
        self.library = library
        self.onSave = onSave
        _order = State(initialValue: initialOrder)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                instructionsBlock
                List {
                    Section {
                        addTagRow
                        ForEach(order, id: \.self) { tag in
                            HStack(spacing: 8) {
                                Image(systemName: "line.3.horizontal")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.text3)
                                Text(tag)
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.text)
                                Spacer()
                                Text("\(usageCount(for: tag))")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.text3)
                            }
                            .padding(.vertical, 2)
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    pendingDelete = tag
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                                Button {
                                    renameTarget = tag
                                    renameDraft = tag
                                } label: {
                                    Label("Rename", systemImage: "pencil")
                                }
                                .tint(Theme.accent)
                            }
                        }
                        .onMove(perform: move)
                    } header: {
                        Text("\(order.count) tag\(order.count == 1 ? "" : "s")")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text3)
                    }
                }
                .listStyle(.plain)
                .environment(\.editMode, .constant(.active))
                .scrollContentBackground(.hidden)
                .background(Theme.bg)
                .scrollDismissesKeyboard(.interactively)
            }
            .background(Theme.bg)
            .navigationTitle("Edit tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        onSave(Payload(order: order, deletedTags: deletedTags, renames: renames))
                        dismiss()
                    }
                    .foregroundStyle(Theme.accent)
                    .disabled(!didChange)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    if newTagFocused {
                        Button("Add") { commitNewTag() }
                            .disabled(trimmedNewTag.isEmpty)
                        Button("Done") { newTagFocused = false }
                    }
                }
            }
            .alert(
                pendingDelete.map { "Delete \"\($0)\"?" } ?? "",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                presenting: pendingDelete
            ) { tag in
                Button("Delete", role: .destructive) { performDelete(tag) }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            } message: { tag in
                let count = usageCount(for: tag)
                if count == 0 {
                    Text("This tag isn't on any recipes — it'll just disappear from the filter bar.")
                } else {
                    Text("It will be removed from \(count) recipe\(count == 1 ? "" : "s") that currently have it.")
                }
            }
            .alert(
                renameTarget.map { "Rename \"\($0)\"" } ?? "",
                isPresented: Binding(
                    get: { renameTarget != nil },
                    set: { if !$0 { renameTarget = nil; renameDraft = "" } }
                ),
                presenting: renameTarget
            ) { tag in
                TextField("New name", text: $renameDraft)
                    .focused($renameFocused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Save") { performRename(from: tag) }
                Button("Cancel", role: .cancel) {
                    renameTarget = nil
                    renameDraft = ""
                }
            } message: { tag in
                let count = usageCount(for: tag)
                if count == 0 {
                    Text("This tag isn't on any recipes yet — only the filter bar entry will be renamed.")
                } else {
                    Text("Will rename across \(count) recipe\(count == 1 ? "" : "s") that currently have it.")
                }
            }
        }
    }

    // MARK: - Sections

    private var instructionsBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Drag to reorder · swipe to delete")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.text2)
            Text("Add a new tag with the input below. Deleted tags are stripped from every recipe that has them.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    /// Inline "+ New tag" row pinned at the top of the list. Uses the
    /// same form as the web's manage-tags input — type a name, hit
    /// Return, tag is appended at the end of the list. Keeps casing as
    /// the user typed (no auto-lowercase) so users who prefer mixed
    /// case stay in control.
    private var addTagRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "plus.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(Theme.accent)
            TextField("New tag…", text: $newTagText)
                .focused($newTagFocused)
                .font(.system(size: 14))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit { commitNewTag() }
            if !trimmedNewTag.isEmpty {
                Button("Add") { commitNewTag() }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
        .moveDisabled(true)
    }

    // MARK: - Behavior

    private var trimmedNewTag: String {
        newTagText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func commitNewTag() {
        let candidate = trimmedNewTag
        guard !candidate.isEmpty else { return }
        // De-dupe case-insensitive against the existing list. Silently
        // ignore duplicates (don't surface an error — the user's intent
        // is clear, the tag's already there).
        if order.contains(where: { $0.lowercased() == candidate.lowercased() }) {
            newTagText = ""
            return
        }
        order.append(candidate)
        newTagText = ""
        didChange = true
        // If the user previously deleted this exact tag in this session,
        // remove the pending delete so save doesn't strip it.
        deletedTags.removeAll { $0.lowercased() == candidate.lowercased() }
    }

    private func move(from source: IndexSet, to destination: Int) {
        order.move(fromOffsets: source, toOffset: destination)
        didChange = true
    }

    private func performDelete(_ tag: String) {
        order.removeAll { $0.lowercased() == tag.lowercased() }
        // Track for the parent only if this tag actually exists in the
        // library — adding an unused tag and then deleting it before
        // saving doesn't need a DB strip pass.
        let isInLibrary = library.contains { ($0.tags ?? []).contains { $0.lowercased() == tag.lowercased() } }
        if isInLibrary {
            // De-dupe pending deletes so a tag deleted twice doesn't
            // hit the DB strip twice.
            if !deletedTags.contains(where: { $0.lowercased() == tag.lowercased() }) {
                deletedTags.append(tag)
            }
        }
        // If a pending rename targeted this tag, drop it — a delete wins.
        renames.removeAll { $0.oldName.lowercased() == tag.lowercased() }
        didChange = true
        pendingDelete = nil
    }

    /// Apply a rename locally and queue it for the parent's cascade. We
    /// rewrite the in-memory order list immediately so the user sees the
    /// change in the sheet; the parent persists tag_order and walks the
    /// library on Save.
    private func performRename(from old: String) {
        let trimmed = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        defer {
            renameTarget = nil
            renameDraft = ""
        }
        guard !trimmed.isEmpty else { return }
        // No-op when the input is identical to the existing name (incl.
        // casing) — nothing to do, no cascade needed.
        if trimmed == old { return }
        // Case-insensitive collision with a different existing tag would
        // silently merge two distinct entries on save. Bail rather than
        // surprise the user; they can delete the duplicate first.
        if trimmed.lowercased() != old.lowercased(),
           order.contains(where: { $0.lowercased() == trimmed.lowercased() }) {
            return
        }
        // Replace in order, preserving position.
        if let idx = order.firstIndex(where: { $0.lowercased() == old.lowercased() }) {
            order[idx] = trimmed
        }
        // Collapse any existing rename that targeted the same `old` so we
        // don't queue chained renames. The user's latest intent wins.
        renames.removeAll { $0.oldName.lowercased() == old.lowercased() }
        // Only record a cascade if the tag is actually on any recipe —
        // a rename of a tag-order-only entry doesn't need a DB walk.
        let isInLibrary = library.contains {
            ($0.tags ?? []).contains { $0.lowercased() == old.lowercased() }
        }
        if isInLibrary {
            renames.append(TagRename(oldName: old, newName: trimmed))
        }
        // If the renamed tag was pending delete, drop it.
        pendingDelete = (pendingDelete?.lowercased() == old.lowercased()) ? nil : pendingDelete
        deletedTags.removeAll { $0.lowercased() == old.lowercased() }
        didChange = true
    }

    private func usageCount(for tag: String) -> Int {
        let lower = tag.lowercased()
        return library.filter { ($0.tags ?? []).contains { $0.lowercased() == lower } }.count
    }
}
