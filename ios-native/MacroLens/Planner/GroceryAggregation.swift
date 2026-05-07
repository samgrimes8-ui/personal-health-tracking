import Foundation

/// Pure aggregation primitives for the grocery list. Mirrors the web
/// app's `sumIngredients` (src/pages/app.js:2702) — two-dimensional
/// unit conversion (weight + volume) so "1/4 cup oil + 2 tbsp oil"
/// collapses into "6 tbsp oil" instead of two separate rows.
///
/// Smart merge here is the local "Pass 1" — the regex canonicalizer
/// in src/lib/categorize.js plus the unit-conversion math. Pass 2
/// (AI-generated synonyms persisted to the ingredient_synonyms table)
/// isn't ported yet; that requires the proxy + a new table and is
/// deferred. Pass 1 alone catches the bulk of duplicate rows in
/// practice — different units of the same canonical name.

// MARK: - Unit math

/// Two parallel "dimensions": weight (canonical = oz) and volume
/// (canonical = tbsp). Two ingredients in the same dimension can be
/// summed even if their input units differ. Two ingredients in
/// different dimensions stay separate.
enum UnitMath {
    static let UNIT_TO_OZ: [String: Double] = [
        "lbs": 16, "lb": 16, "oz": 1, "g": 0.03527, "kg": 35.27
    ]

    /// tbsp picked as canonical because typical recipe quantities
    /// round nicer than ml.
    static let UNIT_TO_TBSP: [String: Double] = [
        "cup": 16, "cups": 16, "c": 16,
        "tbsp": 1, "tbs": 1, "tablespoon": 1, "tablespoons": 1,
        "tsp": 1.0/3.0, "teaspoon": 1.0/3.0, "teaspoons": 1.0/3.0,
        "fl oz": 2, "floz": 2, "fluid ounce": 2, "fluid ounces": 2,
        "ml": 0.0676, "milliliter": 0.0676, "milliliters": 0.0676,
        "l": 67.628, "liter": 67.628, "liters": 67.628,
        "pint": 32, "pints": 32, "pt": 32,
        "quart": 64, "quarts": 64, "qt": 64,
        "gallon": 256, "gallons": 256, "gal": 256
    ]

    static func toOz(_ amount: Double, unit: String?) -> Double? {
        guard let u = unit?.lowercased(), let factor = UNIT_TO_OZ[u] else { return nil }
        return amount * factor
    }

    static func toTbsp(_ amount: Double, unit: String?) -> Double? {
        guard let u = unit?.lowercased(), let factor = UNIT_TO_TBSP[u] else { return nil }
        return amount * factor
    }

    /// Format a weight in oz back to the most-readable unit. Above
    /// 16 oz we render as lbs so summed weights don't show as
    /// "20 oz" when "1.25 lbs" is what users expect on a list.
    static func formatWeight(oz: Double) -> (amount: Double, unit: String) {
        if oz >= 16 { return (rounded2(oz / 16), "lbs") }
        return (rounded2(oz), "oz")
    }

    /// Format a volume in tbsp back to the most-readable unit.
    /// Above 4 tbsp (1/4 cup) we render as cups, rounded to the
    /// nearest 1/4 cup so summed volumes look natural.
    static func formatVolume(tbsp: Double) -> (amount: Double, unit: String) {
        if tbsp >= 4 {
            let cups = tbsp / 16
            return ((cups * 4).rounded() / 4, "cups")
        }
        if tbsp >= 1 { return (rounded2(tbsp), "tbsp") }
        return (rounded2(tbsp * 3), "tsp")
    }

    private static func rounded2(_ v: Double) -> Double {
        (v * 100).rounded() / 100
    }
}

// MARK: - Canonicalization

/// Maps common variant phrasings to a single canonical name so the
/// aggregator collapses rows that the AI wrote slightly differently.
/// Mirrors the `NAME_CANONICAL_RULES` table in src/lib/categorize.js
/// — starter subset (~30 rules) covering the highest-frequency wins.
/// More rules can be ported as users surface misses.
enum IngredientCanonicalizer {
    /// Each entry: `(pattern, canonical)`. Patterns are anchored
    /// case-insensitive regexes. First match wins, so order from
    /// most-specific to least-specific within a family.
    private static let rules: [(NSRegularExpression, String)] = {
        let raw: [(String, String)] = [
            // ─── Proteins ──────────────────────────────────────────────
            ("^(boneless,?\\s*skinless\\s+)?chicken\\s+breasts?(\\s+halves)?$", "chicken breast"),
            ("^(boneless,?\\s*skinless\\s+)?chicken\\s+thighs?$", "chicken thigh"),
            ("^ground\\s+chicken$", "ground chicken"),
            ("^ground\\s+beef(\\s+\\(\\d+%.*\\))?$", "ground beef"),
            ("^ground\\s+turkey$", "ground turkey"),
            ("^ground\\s+pork$", "ground pork"),
            ("^salmon\\s+(filet|fillet)s?$", "salmon"),
            ("^(raw\\s+|peeled\\s+|cooked\\s+)?shrimps?$", "shrimp"),
            ("^(large\\s+|whole\\s+|fresh\\s+)?eggs?$", "eggs"),

            // ─── Aromatics / alliums ───────────────────────────────────
            ("^(\\d+\\s+)?(garlic\\s+cloves?|cloves?\\s+of\\s+garlic|fresh\\s+garlic)$", "garlic"),
            ("^(minced\\s+|crushed\\s+|chopped\\s+)?garlic$", "garlic"),
            ("^(fresh\\s+)?ginger(\\s*root)?$", "ginger"),
            ("^(red|yellow|white|sweet|spanish)\\s+onions?$", "onion"),
            ("^onions?$", "onion"),
            ("^(green\\s+onions?|scallions?|spring\\s+onions?)$", "green onions"),
            ("^shallots?$", "shallot"),

            // ─── Vegetables ────────────────────────────────────────────
            ("^(red|green|yellow|orange)\\s+bell\\s+peppers?$", "bell pepper"),
            ("^bell\\s+peppers?$", "bell pepper"),
            ("^(roma|plum|beefsteak|vine[\\s-]ripened)\\s+tomatoes?$", "tomato"),
            ("^tomatoes?$", "tomato"),
            ("^carrots?$", "carrot"),
            ("^(baby\\s+)?spinach$", "spinach"),
            ("^(baby\\s+)?kale$", "kale"),

            // ─── Herbs ─────────────────────────────────────────────────
            ("^fresh\\s+(parsley|cilantro|basil|thyme|rosemary|oregano|sage|dill|mint|chives)$", "$1"),

            // ─── Citrus ────────────────────────────────────────────────
            ("^lemons?(\\s+wedges?|\\s+slices?)?$", "lemon"),
            ("^limes?(\\s+wedges?|\\s+slices?)?$", "lime"),

            // ─── Pantry ────────────────────────────────────────────────
            ("^extra[\\s-]?virgin\\s+olive\\s+oil$", "olive oil"),
            ("^virgin\\s+olive\\s+oil$", "olive oil"),
            ("^olive\\s+oils?$", "olive oil"),
            ("^toasted\\s+sesame\\s+oil$", "sesame oil"),
            ("^sesame\\s+oils?$", "sesame oil"),
            ("^(reduced\\s+sodium\\s+|low[\\s-]sodium\\s+)?soy\\s+sauces?$", "soy sauce"),
            ("^(white\\s+|granulated\\s+)?sugars?$", "sugar"),
            ("^(light\\s+|dark\\s+)?brown\\s+sugars?$", "brown sugar"),
            ("^(table\\s+|fine\\s+)?salts?$", "salt"),
            ("^kosher\\s+salts?$", "kosher salt"),
            ("^(freshly\\s+)?(ground\\s+)?black\\s+peppers?$", "black pepper"),

            // ─── Spices ────────────────────────────────────────────────
            ("^ground\\s+(cumin|coriander|cinnamon|nutmeg|cloves|allspice|cardamom|turmeric|paprika)$", "$1"),
            ("^(crushed\\s+)?red\\s+pepper(\\s+flakes)?$", "red pepper flakes"),

            // ─── Dairy ─────────────────────────────────────────────────
            ("^(unsalted\\s+|salted\\s+)?butter(\\s+sticks?)?$", "butter"),
            ("^whole\\s+milks?$", "whole milk"),
            ("^milks?$", "milk")
        ]
        let opts: NSRegularExpression.Options = [.caseInsensitive]
        return raw.compactMap { p, canon in
            guard let re = try? NSRegularExpression(pattern: p, options: opts) else { return nil }
            return (re, canon)
        }
    }()

    /// Apply the first matching rule (if any). Returns the canonical
    /// form when a rule matches; falls through to the original name
    /// (lowercased + trimmed) otherwise so the aggregator still has
    /// a stable key.
    static func canonicalize(_ name: String) -> String {
        let trimmed = name.lowercased().trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return trimmed }
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        for (re, canonical) in rules {
            if let match = re.firstMatch(in: trimmed, options: [], range: range), match.range == range {
                let replaced = re.replacementString(for: match, in: trimmed, offset: 0, template: canonical)
                return replaced
            }
        }
        return trimmed
    }
}

// MARK: - Item model

/// One row in the grocery list — a canonical ingredient name plus the
/// summed amount + unit, the category bucket, and the meals it came
/// from. Identifiable so SwiftUI lists can diff cleanly across re-renders.
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

// MARK: - Aggregator

/// Reduces a list of planned meals into a list of grocery items.
/// Mirrors collectAllIngredients + sumIngredients in app.js:
///   1. Walk meals, expand each recipe's ingredients × planned-servings
///      multiplier.
///   2. Optionally apply IngredientCanonicalizer to collapse phrasing
///      variants (the "smart merge" toggle).
///   3. Group by (canonical name + unit) — but if two rows share a
///      WEIGHT or VOLUME dimension, sum through the canonical unit
///      and reformat (1/4 cup + 2 tbsp → 6 tbsp).
enum GroceryAggregator {
    /// Input shape — keeps the aggregator pure (no AppState reads).
    struct PlannedMealInput {
        let mealId: String
        let mealLabel: String          // shown under the row in the list
        let recipeId: String?
        let plannedServings: Double?
        let isLeftover: Bool
    }

    /// One ingredient line as written on a recipe (pre-aggregation).
    struct IngredientInput {
        let name: String
        let amount: Double
        let unit: String
        let category: GroceryCategory
    }

    /// Recipe lookup shape used by the planner-side fetch.
    struct RecipeInput {
        let id: String
        let name: String
        let servings: Double?
        let ingredients: [IngredientInput]
    }

    /// Aggregate meals → grocery items.
    /// - includeMeal: closure to filter which meals contribute (lets
    ///   the caller honor per-meal user overrides + leftover defaults).
    /// - applyCanonicalization: when true, runs IngredientCanonicalizer
    ///   so e.g. "red onion" + "yellow onion" collapse to "onion".
    static func aggregate(
        meals: [PlannedMealInput],
        recipesById: [String: RecipeInput],
        includeMeal: (PlannedMealInput) -> Bool,
        applyCanonicalization: Bool
    ) -> [GroceryItem] {
        var bucket: [String: GroceryItem] = [:]

        for meal in meals where includeMeal(meal) {
            guard let recipeId = meal.recipeId,
                  let recipe = recipesById[recipeId] else { continue }
            let baseServings = recipe.servings ?? 1
            let plannedServings = meal.plannedServings ?? baseServings
            let multiplier = baseServings > 0 ? plannedServings / baseServings : 1

            for ing in recipe.ingredients {
                let raw = ing.name.lowercased().trimmingCharacters(in: .whitespaces)
                guard !raw.isEmpty else { continue }
                let canonical = applyCanonicalization
                    ? IngredientCanonicalizer.canonicalize(raw)
                    : raw
                let unit = ing.unit.lowercased()
                let amount = ing.amount * multiplier
                let key = "\(canonical)|\(unit)"

                if var existing = bucket[key] {
                    let merged = mergeAmounts(
                        existingAmount: existing.totalAmount,
                        existingUnit: existing.unit,
                        newAmount: amount,
                        newUnit: ing.unit
                    )
                    existing.totalAmount = merged.amount
                    existing.unit = merged.unit
                    if !existing.meals.contains(meal.mealLabel) {
                        existing.meals.append(meal.mealLabel)
                    }
                    bucket[key] = existing
                } else {
                    bucket[key] = GroceryItem(
                        id: key,
                        name: canonical,
                        unit: ing.unit,
                        totalAmount: amount,
                        category: ing.category,
                        meals: [meal.mealLabel]
                    )
                }
            }
        }

        // Second pass: try to merge across keys that share a name but
        // differ in unit, when both units belong to the same dimension.
        // This is what produces "1.5 cups" instead of "1 cup + 0.5 cup"
        // when two recipes wrote the same ingredient with the same unit
        // family. Without it the canonical-name match alone wouldn't
        // help when units differ slightly (cup vs cups, etc).
        return mergeAcrossDimensions(Array(bucket.values))
            .sorted { $0.name < $1.name }
    }

    /// Sum two amount/unit pairs through whichever dimension they
    /// share. Falls back to additive when units already match exactly,
    /// or returns the existing pair untouched when neither dimension
    /// applies (cross-dimension entries already landed in different
    /// keys upstream so this branch is rare).
    private static func mergeAmounts(
        existingAmount: Double, existingUnit: String,
        newAmount: Double, newUnit: String
    ) -> (amount: Double, unit: String) {
        if let a = UnitMath.toOz(existingAmount, unit: existingUnit),
           let b = UnitMath.toOz(newAmount, unit: newUnit) {
            let f = UnitMath.formatWeight(oz: a + b)
            return (f.amount, f.unit)
        }
        if let a = UnitMath.toTbsp(existingAmount, unit: existingUnit),
           let b = UnitMath.toTbsp(newAmount, unit: newUnit) {
            let f = UnitMath.formatVolume(tbsp: a + b)
            return (f.amount, f.unit)
        }
        if existingUnit.lowercased() == newUnit.lowercased() {
            return (existingAmount + newAmount, existingUnit)
        }
        return (existingAmount, existingUnit)
    }

    /// Final cross-key pass: when two grouped rows share a canonical
    /// name and their units sit in the same dimension (e.g. one row
    /// is "olive oil | cup" and another is "olive oil | tbsp"), fold
    /// the second into the first through the canonical unit. This
    /// only matters when the two recipes used different units —
    /// same-unit grouping already collapsed in the bucket loop.
    private static func mergeAcrossDimensions(_ items: [GroceryItem]) -> [GroceryItem] {
        var byName: [String: GroceryItem] = [:]
        var others: [GroceryItem] = []
        for item in items {
            // Only merge when the unit is one we know how to reduce —
            // otherwise leave the row alone (a "cloves" row should not
            // get folded into a "tbsp" row even if names match).
            let isWeight = UnitMath.UNIT_TO_OZ[item.unit.lowercased()] != nil
            let isVolume = UnitMath.UNIT_TO_TBSP[item.unit.lowercased()] != nil
            guard isWeight || isVolume else {
                others.append(item)
                continue
            }
            if var existing = byName[item.name] {
                let canMerge = (isWeight && UnitMath.toOz(existing.totalAmount, unit: existing.unit) != nil)
                            || (isVolume && UnitMath.toTbsp(existing.totalAmount, unit: existing.unit) != nil)
                if canMerge {
                    let merged = mergeAmounts(
                        existingAmount: existing.totalAmount,
                        existingUnit: existing.unit,
                        newAmount: item.totalAmount,
                        newUnit: item.unit
                    )
                    existing.totalAmount = merged.amount
                    existing.unit = merged.unit
                    for m in item.meals where !existing.meals.contains(m) {
                        existing.meals.append(m)
                    }
                    byName[item.name] = existing
                } else {
                    // Different dimensions on the same name (e.g. butter
                    // by weight vs butter by tbsp) — keep separate.
                    others.append(item)
                }
            } else {
                byName[item.name] = item
            }
        }
        return Array(byName.values) + others
    }
}
