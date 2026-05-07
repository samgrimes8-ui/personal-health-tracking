import SwiftUI

/// Aggregated grocery list for the visible week. Uses a per-week recipe
/// fetch (with ingredients jsonb) since the dashboard's RecipeRow projection
/// is name + macros only — the wider shape is local to this view to avoid
/// touching shared Models.swift.
///
/// Aggregation lives in GroceryAggregation.swift. This view owns the
/// recipe fetch, the smart-merge toggle, and the rendering. The smart-
/// merge toggle flips canonicalization on/off; without it, "red onion"
/// and "yellow onion" stay as separate rows. With it, they collapse to
/// a single "onion" row with summed amount.
struct GroceryListView: View {
    @Environment(AppState.self) private var state
    let weekStart: String

    @State private var recipesById: [String: GroceryRecipe] = [:]
    @State private var fetching = false
    @State private var loadErr: String?
    /// On by default — Smart merge button toggles canonicalization +
    /// the cross-dimension unit-merge pass off (rare, but useful when
    /// the user wants to see the raw per-recipe rows without combining).
    @State private var smartMergeApplied: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if fetching && recipesById.isEmpty {
                Card { ProgressView().frame(maxWidth: .infinity, alignment: .center) }
            } else if mealsThisWeek.isEmpty {
                Card { EmptyState(icon: "cart", title: "No grocery list yet", message: "Add planned meals to this week to generate one.") }
            } else if itemRows.isEmpty {
                Card { EmptyState(icon: "leaf", title: "No ingredients yet", message: "Save recipes with ingredients on them, then re-open this list.") }
            } else {
                listBody
            }
        }
        .task(id: weekStart) { await fetchRecipeIngredients() }
        .alert("Couldn't load grocery list", isPresented: Binding(
            get: { loadErr != nil },
            set: { if !$0 { loadErr = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(loadErr ?? "") }
    }

    // MARK: - Header / actions

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Grocery list")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.text)
                    Text("\(mealsThisWeek.count) meals · \(PlannerDateMath.weekLabel(weekStart))")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }
                Spacer()
            }

            // Action buttons. Wrap so they reflow nicely on narrow widths.
            HStack(spacing: 8) {
                actionButton(label: "Copy", systemImage: "doc.on.doc", color: Theme.protein) {
                    copyToClipboard()
                }
                .disabled(itemRows.isEmpty)

                actionButton(
                    label: smartMergeApplied ? "Merged" : "Smart merge",
                    systemImage: "sparkles",
                    color: Theme.carbs,
                    filled: smartMergeApplied
                ) {
                    smartMergeApplied.toggle()
                }
                .disabled(itemRows.isEmpty)

                Spacer(minLength: 0)
            }
        }
    }

    private func actionButton(
        label: String,
        systemImage: String,
        color: Color,
        filled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: systemImage)
                Text(label)
            }
            .font(.system(size: 12, weight: .semibold))
            .padding(.vertical, 7).padding(.horizontal, 12)
            .foregroundStyle(filled ? Color.white : color)
            .background(filled ? color : color.opacity(0.10), in: .rect(cornerRadius: 999))
            .overlay(
                RoundedRectangle(cornerRadius: 999)
                    .stroke(color.opacity(filled ? 0.0 : 0.30), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Body

    private var listBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(GroceryCategory.order, id: \.self) { cat in
                if let rows = grouped[cat], !rows.isEmpty {
                    Card(padding: 0) {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 6) {
                                Text(cat.emoji)
                                Text(cat.label.uppercased())
                                    .font(.system(size: 11, weight: .semibold))
                                    .tracking(1.0)
                                Text("(\(rows.count))")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.text3)
                                Spacer()
                            }
                            .foregroundStyle(cat.color)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.bg3)

                            ForEach(rows) { row in
                                groceryRow(row, color: cat.color)
                                Divider().background(Theme.border)
                            }
                        }
                    }
                }
            }
        }
    }

    private func groceryRow(_ row: GroceryItem, color: Color) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(row.amountLabel)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(color)
                .frame(width: 80, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name.capitalized)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.text)
                if !row.meals.isEmpty {
                    Text(row.meals.joined(separator: ", "))
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    // MARK: - Aggregation pipeline

    /// All meals in the visible week.
    private var mealsThisWeek: [PlannerRow] {
        state.plannerByDay.flatMap { $0 }
    }

    /// Aggregated rows. Skips leftovers by default (mirrors the
    /// `isMealIncludedInGroceries` default in app.js — leftovers reuse
    /// a previous cook and don't add to the grocery list).
    private var itemRows: [GroceryItem] {
        let inputs = mealsThisWeek.map { row -> GroceryAggregator.PlannedMealInput in
            GroceryAggregator.PlannedMealInput(
                mealId: row.id,
                mealLabel: row.meal_name ?? recipesById[row.recipe_id ?? ""]?.name ?? "",
                recipeId: row.recipe_id,
                plannedServings: row.planned_servings,
                isLeftover: row.is_leftover ?? false
            )
        }
        let recipes = recipesById.mapValues { r -> GroceryAggregator.RecipeInput in
            GroceryAggregator.RecipeInput(
                id: r.id,
                name: r.name,
                servings: r.servings,
                ingredients: (r.ingredients ?? []).map { ing in
                    GroceryAggregator.IngredientInput(
                        name: ing.name,
                        amount: ing.amountValue,
                        unit: ing.unit ?? "",
                        category: GroceryCategory.resolve(rawCategory: ing.category, name: ing.name)
                    )
                }
            )
        }
        return GroceryAggregator.aggregate(
            meals: inputs,
            recipesById: recipes,
            includeMeal: { !$0.isLeftover },
            applyCanonicalization: smartMergeApplied
        )
    }

    /// `itemRows` grouped by category for rendering.
    private var grouped: [GroceryCategory: [GroceryItem]] {
        Dictionary(grouping: itemRows) { $0.category }
    }

    // MARK: - Recipe fetch

    private func fetchRecipeIngredients() async {
        let ids = Set(state.plannerByDay.flatMap { $0 }.compactMap { $0.recipe_id })
        guard !ids.isEmpty else {
            recipesById = [:]
            return
        }
        // Skip if we already have all of them.
        if ids.allSatisfy({ recipesById[$0] != nil }) { return }

        fetching = true
        defer { fetching = false }
        do {
            let userId = try await SupabaseService.client.auth.session.user.id.uuidString
            let rows: [GroceryRecipe] = try await SupabaseService.client
                .from("recipes")
                .select("id, name, servings, ingredients")
                .eq("user_id", value: userId)
                .in("id", values: Array(ids))
                .execute()
                .value
            var next: [String: GroceryRecipe] = [:]
            for r in rows { next[r.id] = r }
            recipesById = next
        } catch {
            loadErr = error.localizedDescription
        }
    }

    // MARK: - Clipboard

    private func copyToClipboard() {
        var lines: [String] = []
        lines.append("Grocery list — \(PlannerDateMath.weekLabel(weekStart))")
        for cat in GroceryCategory.order {
            guard let rows = grouped[cat], !rows.isEmpty else { continue }
            lines.append("")
            lines.append("\(cat.emoji) \(cat.label)")
            for r in rows {
                lines.append("  • \(r.amountLabel) \(r.name)")
            }
        }
#if canImport(UIKit)
        UIPasteboard.general.string = lines.joined(separator: "\n")
#endif
    }
}

// MARK: - Local fetch shapes

/// Minimal recipe shape with ingredients jsonb. Local to the planner
/// because the shared RecipeRow only carries name + macros — adding
/// ingredients there would touch Models.swift. `RecipeIngredient` (in
/// Recipes/RecipeFull.swift) handles the polymorphic amount column the
/// recipes table actually stores (string or number).
private struct GroceryRecipe: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var servings: Double?
    var ingredients: [RecipeIngredient]?
}

// MARK: - Categories

enum GroceryCategory: String, Hashable, CaseIterable {
    case produce, protein, dairy, grains, pantry, spices, frozen, bakery, beverages, other

    static let order: [GroceryCategory] = [
        .produce, .protein, .dairy, .grains, .pantry, .spices, .frozen, .bakery, .beverages, .other
    ]

    var label: String {
        switch self {
        case .produce: return "Produce"
        case .protein: return "Protein"
        case .dairy: return "Dairy"
        case .grains: return "Grains"
        case .pantry: return "Pantry"
        case .spices: return "Spices"
        case .frozen: return "Frozen"
        case .bakery: return "Bakery"
        case .beverages: return "Beverages"
        case .other: return "Other"
        }
    }

    var emoji: String {
        switch self {
        case .produce: return "🥦"
        case .protein: return "🥩"
        case .dairy: return "🧀"
        case .grains: return "🌾"
        case .pantry: return "🥫"
        case .spices: return "🧂"
        case .frozen: return "🧊"
        case .bakery: return "🍞"
        case .beverages: return "🧃"
        case .other: return "📦"
        }
    }

    var color: Color {
        switch self {
        case .produce: return Theme.protein
        case .protein: return Theme.fat
        case .dairy: return Theme.carbs
        case .grains: return Theme.cal
        case .pantry: return Theme.text2
        case .spices: return Theme.fiber
        case .frozen: return Theme.carbs
        case .bakery: return Theme.fat
        case .beverages: return Theme.text2
        case .other: return Theme.text3
        }
    }

    /// Best-guess category for an ingredient. Trusts the AI value when
    /// it parses; otherwise falls back to keyword matching so the list
    /// doesn't collapse into "Other" when the model omits the field.
    static func resolve(rawCategory: String?, name: String) -> GroceryCategory {
        if let raw = rawCategory?.lowercased(), let cat = GroceryCategory(rawValue: raw) {
            return cat
        }
        return inferByKeyword(name) ?? .other
    }

    private static let keywords: [(GroceryCategory, [String])] = [
        (.produce,   ["lettuce","spinach","tomato","onion","pepper","carrot","celery","cucumber","potato","garlic","ginger","kale","arugula","broccoli","cauliflower","zucchini","squash","mushroom","apple","banana","berry","strawberry","blueberry","raspberry","lemon","lime","orange","avocado","cilantro","parsley","basil","thyme","rosemary","mint","scallion"]),
        (.protein,   ["chicken","beef","pork","turkey","lamb","salmon","tuna","shrimp","fish","bacon","sausage","tofu","tempeh","egg","ground"]),
        (.dairy,     ["milk","yogurt","cheese","butter","cream","cottage","mozzarella","feta","parmesan","cheddar","kefir","greek yogurt"]),
        (.grains,    ["rice","quinoa","oat","oatmeal","barley","pasta","spaghetti","penne","noodle","couscous","tortilla","bread","wrap"]),
        (.pantry,    ["oil","olive oil","vinegar","sauce","mustard","mayo","ketchup","soy sauce","honey","sugar","syrup","peanut butter","almond butter","tahini","stock","broth","bean","lentil","chickpea","tomato paste","canned"]),
        (.spices,    ["salt","pepper","paprika","cumin","coriander","cinnamon","turmeric","oregano","chili","cayenne","garlic powder","onion powder","nutmeg","clove","sage","bay"]),
        (.frozen,    ["frozen"]),
        (.bakery,    ["baguette","bagel","roll","muffin","croissant","pita"]),
        (.beverages, ["coffee","tea","juice","soda","sparkling","milk alternative"]),
    ]

    private static func inferByKeyword(_ name: String) -> GroceryCategory? {
        let n = name.lowercased()
        for (cat, words) in keywords {
            if words.contains(where: { n.contains($0) }) { return cat }
        }
        return nil
    }
}
