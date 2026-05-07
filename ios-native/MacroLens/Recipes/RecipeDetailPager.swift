import SwiftUI

/// Swipeable wrapper around RecipeDetailView. The user lands on the
/// recipe they tapped; horizontal swipes pan to the next / previous
/// recipe in the same filtered ordering RecipesView is showing in the
/// library list. Search + tag filters carry through automatically since
/// the parent passes `filtered()` as the array.
///
/// Why a pager (not a NavigationStack push):
///   - Sheet presentations don't get the system back-swipe UI by default
///   - Users on the web don't navigate "into" a recipe — they open a modal,
///     and the existing modal pattern is already centered around quick
///     side-by-side comparison via a back/forward gesture (planner does
///     the same with weeks). Mirroring it here keeps the iOS feel
///     consistent without requiring a modal-stack rewrite.
struct RecipeDetailPager: View {
    /// Snapshot of the filtered library at the time the user tapped a
    /// card. Held as @State so the user gets a stable swipe set even if
    /// the parent's filter changes (e.g. a search debounce fires) while
    /// the sheet is open. On dismiss + re-open, they'll get a fresh
    /// snapshot reflecting the current filter.
    @State private var recipes: [RecipeFull]
    @State private var index: Int

    let onEdit: (RecipeFull) -> Void
    let onDeleted: () -> Void
    /// Refresh hook fired by the per-page detail view after a successful
    /// plan-from-recipe save. The plan sheet itself lives on the inner
    /// detail view (so it stacks immediately above the pager); only the
    /// post-save side effect comes back up here so the parent can refresh
    /// the planner.
    let onPlanned: () -> Void
    /// Sharing-state diff hook — fired when the per-page detail view
    /// completes the share-sheet flow. The system share sheet itself
    /// stacks on the inner detail; only is_shared / share_token
    /// changes propagate up so the library card mirrors the new state.
    let onShareChanged: (_ recipeId: String, _ isShared: Bool, _ token: String?) -> Void
    /// Lets the pager hand the latest in-pager mutations (e.g. instructions
    /// generated mid-swipe) back to RecipesView so the library list stays
    /// in sync without forcing a refetch.
    let onChanged: (RecipeFull) -> Void

    @Environment(\.dismiss) private var dismiss

    init(recipes: [RecipeFull],
         initialIndex: Int,
         onEdit: @escaping (RecipeFull) -> Void,
         onDeleted: @escaping () -> Void,
         onPlanned: @escaping () -> Void,
         onShareChanged: @escaping (String, Bool, String?) -> Void,
         onChanged: @escaping (RecipeFull) -> Void) {
        _recipes = State(initialValue: recipes)
        _index = State(initialValue: max(0, min(initialIndex, recipes.count - 1)))
        self.onEdit = onEdit
        self.onDeleted = onDeleted
        self.onPlanned = onPlanned
        self.onShareChanged = onShareChanged
        self.onChanged = onChanged
    }

    var body: some View {
        NavigationStack {
            TabView(selection: $index) {
                ForEach(Array(recipes.enumerated()), id: \.offset) { i, r in
                    RecipeDetailView(
                        recipe: r,
                        onEdit: onEdit,
                        onDeleted: onDeleted,
                        onPlanned: onPlanned,
                        onShareChanged: { isShared, token in
                            // Splice into the pager's snapshot so the active
                            // page's toolbar / Share label reflects the
                            // change, and forward to the parent library.
                            if i < recipes.count {
                                recipes[i].is_shared = isShared
                                if let token { recipes[i].share_token = token }
                            }
                            onShareChanged(r.id, isShared, token)
                        },
                        onChanged: { updated in
                            // Update both the local pager snapshot (so the
                            // toolbar's Edit button sees the latest data
                            // when the user hasn't swiped away yet) and the
                            // parent library list.
                            if i < recipes.count {
                                recipes[i] = updated
                            }
                            onChanged(updated)
                        },
                        embedded: true
                    )
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .background(Theme.bg)
            .navigationTitle(currentTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") {
                        if let r = currentRecipe { onEdit(r) }
                    }
                    .foregroundStyle(Theme.accent)
                }
                if recipes.count > 1 {
                    // Tiny chevron pair so users discover the swipe gesture
                    // without us turning the toolbar into a billboard.
                    // Hidden on single-recipe pagers so the toolbar stays
                    // clean for the common no-filter case.
                    ToolbarItem(placement: .principal) {
                        positionIndicator
                    }
                }
            }
        }
    }

    private var currentRecipe: RecipeFull? {
        guard index >= 0, index < recipes.count else { return nil }
        return recipes[index]
    }

    private var currentTitle: String {
        currentRecipe?.name ?? ""
    }

    private var positionIndicator: some View {
        // Subtle "3 / 12" pill — same idea as the planner's week pager.
        // Renders centered in the navigation bar's principal slot.
        Text("\(min(index + 1, recipes.count)) / \(recipes.count)")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.text3)
            .padding(.horizontal, 10).padding(.vertical, 3)
            .background(Theme.bg3, in: .rect(cornerRadius: 999))
    }
}
