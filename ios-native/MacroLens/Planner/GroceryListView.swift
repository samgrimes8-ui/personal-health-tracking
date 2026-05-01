import SwiftUI

/// Aggregated grocery list for the visible week. Uses a per-week recipe
/// fetch (with ingredients jsonb) since the dashboard's RecipeRow projection
/// is name + macros only — the wider shape is local to this view to avoid
/// touching shared Models.swift.
///
/// Categorization mirrors the web app: AI-supplied category if it matches
/// our taxonomy, else a keyword fallback so the list never collapses to
/// "Other" en masse.
struct GroceryListView: View {
    @Environment(AppState.self) private var state
    let weekStart: String

    @State private var recipesById: [String: GroceryRecipe] = [:]
    @State private var fetching = false
    @State private var loadErr: String?

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
            Button {
                copyToClipboard()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "doc.on.doc")
                    Text("Copy")
                }
                .font(.system(size: 12, weight: .semibold))
                .padding(.vertical, 7).padding(.horizontal, 12)
                .background(Theme.bg2, in: .rect(cornerRadius: 999))
                .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.border2, lineWidth: 1))
                .foregroundStyle(Theme.text)
            }
            .buttonStyle(.plain)
            .disabled(itemRows.isEmpty)
        }
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

    /// All meals in the visible week. Skips leftovers — those reuse a
    /// previous cook and don't add to the grocery list (mirrors the
    /// `isMealIncludedInGroceries` default in app.js).
    private var mealsThisWeek: [PlannerRow] {
        state.plannerByDay.flatMap { $0 }
    }

    private var contributingMeals: [PlannerRow] {
        mealsThisWeek.filter { ($0.is_leftover ?? false) == false }
    }

    /// Aggregated rows, post-grouping but pre-categorization.
    private var itemRows: [GroceryItem] {
        var bucket: [String: GroceryItem] = [:]
        for meal in contributingMeals {
            guard let recipeId = meal.recipe_id, let recipe = recipesById[recipeId] else { continue }
            let baseServings = recipe.servings ?? 1
            let plannedServings = meal.planned_servings ?? baseServings
            let multiplier = baseServings > 0 ? plannedServings / baseServings : 1
            let mealLabel = meal.meal_name ?? recipe.name
            for ing in recipe.ingredients ?? [] {
                let lowered = ing.name.lowercased().trimmingCharacters(in: .whitespaces)
                guard !lowered.isEmpty else { continue }
                let unit = ing.unit?.lowercased() ?? ""
                let key = "\(lowered)|\(unit)"
                let amount = ing.amountValue * multiplier
                let cat = GroceryCategory.resolve(rawCategory: ing.category, name: ing.name)
                if var existing = bucket[key] {
                    existing.totalAmount += amount
                    if !existing.meals.contains(mealLabel) { existing.meals.append(mealLabel) }
                    bucket[key] = existing
                } else {
                    bucket[key] = GroceryItem(
                        id: key,
                        name: lowered,
                        unit: ing.unit ?? "",
                        totalAmount: amount,
                        category: cat,
                        meals: [mealLabel]
                    )
                }
            }
        }
        return Array(bucket.values).sorted { $0.name < $1.name }
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

// MARK: - Items / categories

struct GroceryItem: Identifiable, Hashable {
    let id: String
    let name: String
    var unit: String
    var totalAmount: Double
    var category: GroceryCategory
    var meals: [String]

    var amountLabel: String {
        let amt = totalAmount
        if amt <= 0 { return "—" }
        let display: String = (amt == amt.rounded())
            ? String(Int(amt))
            : String(format: "%.2f", amt)
        return unit.isEmpty ? display : "\(display) \(unit)"
    }
}

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
