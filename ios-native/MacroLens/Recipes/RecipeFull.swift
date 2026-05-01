import Foundation
import Supabase

/// Richer recipe shape than Networking/Models.swift's RecipeRow projection.
/// Models.swift is locked off-limits during the parallel native port, so
/// the Recipes tab decodes the wider columns it needs (description,
/// ingredients, tags, source_url, …) into this local type. Field names
/// match the public.recipes columns one-to-one for cross-referencing
/// against src/lib/db.js.
///
/// `serving_label` is per-recipe ("serving" / "slice" / "cup") — the
/// edit form lets the user pick. `tags` is a Postgres text[]; `ingredients`
/// is jsonb (the same shape as Networking.Ingredient).
struct RecipeFull: Codable, Identifiable, Hashable {
    var id: String
    var user_id: String?
    var name: String
    var description: String?
    var servings: Double?
    var serving_label: String?
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var sugar: Double?
    var ingredients: [RecipeIngredient]?
    var tags: [String]?
    var source_url: String?
    var notes: String?
    var updated_at: String?
    var instructions: RecipeInstructions?
    var instructions_version: Int?
    var is_shared: Bool?
    var share_token: String?
    var og_cache: OGCache?
}

/// Cooking instructions blob — matches the shape `generateRecipeInstructions`
/// in src/lib/ai.js returns and `saveRecipeInstructions` in src/lib/db.js
/// persists into `recipes.instructions` jsonb.
struct RecipeInstructions: Codable, Hashable {
    var steps: [String]
    var prep_time: String?
    var cook_time: String?
    var tips: [String]?
}

/// Cached OpenGraph metadata for `recipes.source_url`. Populated lazily by
/// /api/og on the web; we read whatever's already cached on the row but
/// don't refetch on iOS — the source link still works without a preview.
struct OGCache: Codable, Hashable {
    var title: String?
    var description: String?
    var image: String?
    var siteName: String?
    var blocked: Bool?
}

/// Recipe-table ingredient row.
///
/// Lives separately from `Networking.Ingredient` because the recipes.ingredients
/// jsonb column stores `amount` as a free-text **string** ("1/2", "1 ½",
/// "2 1/2"), not a number — see `upsertRecipe()` in src/lib/db.js. The
/// shared Ingredient struct types `amount` as Double, which can't decode
/// the existing rows the web has been writing for years (the entire row
/// fails, so the library returns empty). Polymorphic decoder below accepts
/// either shape so older iOS-written rows (which used Double) keep working.
struct RecipeIngredient: Codable, Hashable {
    var name: String
    var amount: String?
    var unit: String?
    var category: String?

    init(name: String, amount: String? = nil, unit: String? = nil, category: String? = nil) {
        self.name = name
        self.amount = amount
        self.unit = unit
        self.category = category
    }

    /// Build from the shared `Ingredient` shape used by AnalyzeService /
    /// AnalysisResult. AI returns numeric amounts; we coerce to the
    /// string form the recipes table already stores.
    static func fromAI(_ ai: Ingredient) -> RecipeIngredient {
        RecipeIngredient(
            name: ai.name,
            amount: ai.amount.map { AmountParser.format($0) },
            unit: ai.unit,
            category: ai.category
        )
    }

    enum CodingKeys: String, CodingKey { case name, amount, unit, category }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.unit = try c.decodeIfPresent(String.self, forKey: .unit)
        self.category = try c.decodeIfPresent(String.self, forKey: .category)
        if let s = try? c.decodeIfPresent(String.self, forKey: .amount) {
            self.amount = s
        } else if let d = try? c.decodeIfPresent(Double.self, forKey: .amount) {
            self.amount = AmountParser.format(d)
        } else {
            self.amount = nil
        }
    }

    /// Convenience: parse the free-text amount into a Double for math
    /// (scaling, grocery list aggregation). Empty / unparseable → 0.
    var amountValue: Double { AmountParser.parse(amount) }
}

extension RecipeFull {
    /// Empty draft used by the "+ New" path. Pre-populates the same
    /// defaults the web modal uses (4 servings, "serving" label, all
    /// macro fields zero so the input boxes show 0 not blank).
    static func newDraft() -> RecipeFull {
        RecipeFull(
            id: "",
            user_id: nil,
            name: "",
            description: "",
            servings: 4,
            serving_label: "serving",
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
            fiber: 0,
            sugar: 0,
            ingredients: [] as [RecipeIngredient],
            tags: [],
            source_url: "",
            notes: "",
            updated_at: nil,
            instructions: nil,
            instructions_version: nil,
            is_shared: nil,
            share_token: nil,
            og_cache: nil
        )
    }
}

/// Fetcher for the Recipes tab. AppState.loadRecipesFull() populates the
/// dashboard's narrow `recipesFull` slice; this service hits the same
/// table with the wider projection the tab needs. Kept separate so the
/// shared AppState slice stays compatible with the dashboard.
enum RecipeService {
    private static var client: SupabaseClient { SupabaseService.client }

    private static let columns =
        "id, user_id, name, description, servings, serving_label, calories, protein, carbs, fat, fiber, sugar, ingredients, tags, source_url, notes, updated_at, instructions, instructions_version, is_shared, share_token, og_cache"

    /// All recipes belonging to the current user, ordered by name. 500-row
    /// cap matches what AppState.loadRecipesFull pulls — anyone above that
    /// already needs paging on the web side, and we'll add it here when web
    /// gets it too.
    static func fetchLibrary() async throws -> [RecipeFull] {
        let userId = try await client.auth.session.user.id.uuidString
        let rows: [RecipeFull] = try await client
            .from("recipes")
            .select(columns)
            .eq("user_id", value: userId)
            .order("name", ascending: true)
            .limit(500)
            .execute()
            .value
        return rows
    }
}

/// Tag presets baked into the web app (state.recipeTagPresets). Mirrored
/// here so the chip editor + filter bar surface a sensible default set
/// even before the user has tagged anything. Order matches the web list.
enum RecipeTagPresets {
    static let all: [String] = [
        "high-protein",
        "quick",
        "freezer",
        "vegetarian",
        "low-carb",
        "meal-prep",
        "one-pot",
        "kid-friendly",
        "comfort",
        "healthy",
    ]
}

/// Search ranking for the recipes library. Mirrors rankRecipeMatch in
/// src/pages/app.js — same five buckets, same tiebreakers.
enum RecipeSearch {
    static func filter(_ list: [RecipeFull], query: String) -> [RecipeFull] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return list }
        let scored: [(RecipeFull, Int)] = list.compactMap { r in
            let score = rank(r, q: q)
            return score > 0 ? (r, score) : nil
        }
        return scored.sorted { a, b in
            if a.1 != b.1 { return a.1 > b.1 }
            let an = a.0.name.lowercased()
            let bn = b.0.name.lowercased()
            if an.count != bn.count { return an.count < bn.count }
            return an < bn
        }.map(\.0)
    }

    private static func rank(_ r: RecipeFull, q: String) -> Int {
        let name = r.name.lowercased()
        let desc = (r.description ?? "").lowercased()
        if name.hasPrefix(q) { return 100 }
        // "whole word" match — preceded by start-of-string or non-letter
        if matchesWord(name, q: q) { return 80 }
        if name.contains(q) { return 70 }
        if desc.contains(q) { return 40 }
        if (r.ingredients ?? []).contains(where: { ($0.name).lowercased().contains(q) }) { return 20 }
        return 0
    }

    private static func matchesWord(_ haystack: String, q: String) -> Bool {
        // Find q at a word boundary (start, or preceded by non-alphanumeric).
        var idx = haystack.startIndex
        while let r = haystack.range(of: q, range: idx..<haystack.endIndex) {
            if r.lowerBound == haystack.startIndex {
                return true
            }
            let prev = haystack[haystack.index(before: r.lowerBound)]
            if !prev.isLetter && !prev.isNumber { return true }
            idx = haystack.index(after: r.lowerBound)
            if idx >= haystack.endIndex { break }
        }
        return false
    }
}

/// Amount parser matching parseAmount in src/lib/categorize.js. Recipes
/// store amounts as free-text strings ("1/2", "1 ½", "0.75") so the
/// scaler needs to coerce whatever the user typed back into a number.
enum AmountParser {
    private static let unicodeFractions: [Character: Double] = [
        "½": 0.5, "¼": 0.25, "¾": 0.75,
        "⅓": 1.0/3, "⅔": 2.0/3,
        "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
        "⅙": 1.0/6, "⅚": 5.0/6,
        "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
    ]

    static func parse(_ raw: String?) -> Double {
        guard let raw, !raw.isEmpty else { return 0 }
        // Replace unicode fraction glyphs with " <decimal>"
        var s = raw
        for (glyph, val) in unicodeFractions where s.contains(glyph) {
            s = s.replacingOccurrences(of: String(glyph), with: " \(val)")
        }
        s = s.trimmingCharacters(in: .whitespaces)
        // Collapse multiple spaces
        while s.contains("  ") { s = s.replacingOccurrences(of: "  ", with: " ") }
        if s.isEmpty { return 0 }

        // Mixed fraction "1 1/2"
        let mixedFrac = s.split(separator: " ")
        if mixedFrac.count == 2,
           let whole = Int(mixedFrac[0]),
           mixedFrac[1].contains("/") {
            let parts = mixedFrac[1].split(separator: "/")
            if parts.count == 2,
               let n = Int(parts[0]), let d = Int(parts[1]), d != 0 {
                return Double(whole) + Double(n) / Double(d)
            }
        }
        // Mixed decimal "1 0.5" (post unicode replacement)
        if mixedFrac.count == 2,
           let whole = Double(mixedFrac[0]),
           let frac = Double(mixedFrac[1]) {
            return whole + frac
        }
        // Plain fraction "1/2"
        if s.contains("/") {
            let parts = s.split(separator: "/")
            if parts.count == 2,
               let n = Double(parts[0]), let d = Double(parts[1]), d != 0 {
                return n / d
            }
        }
        return Double(s) ?? 0
    }

    /// Render a scaled amount back to display form. Whole numbers go
    /// without decimals; fractions round to 2 decimal places.
    static func format(_ value: Double) -> String {
        if value == 0 { return "" }
        if value.truncatingRemainder(dividingBy: 1) == 0 {
            return String(Int(value))
        }
        return String(format: "%g", (value * 100).rounded() / 100)
    }
}

/// Scales numeric quantities inside a free-text instruction step. Mirrors
/// `scaleStepText` in src/pages/app.js — same regex, same rounding (quarter
/// fractions), same unit set. Returns plain text with the substituted
/// quantities; the caller can wrap them in attributed spans if it wants
/// them highlighted.
enum StepTextScaler {
    private static let pattern: NSRegularExpression? = try? NSRegularExpression(
        pattern: #"(\d+(?:\.\d+)?(?:\/\d+)?)\s*(cups?|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|lbs?|pounds?|\bg\b|kg|ml|liters?|litres?|cloves?|slices?|pieces?|cans?|pints?|quarts?)"#,
        options: [.caseInsensitive]
    )

    /// Scale every "<qty> <unit>" mention in `step` by `target / base`.
    /// Returns the rewritten string; if base or target is zero/nil, returns
    /// the original step unchanged.
    static func scale(_ step: String, base: Double?, target: Double?) -> String {
        guard let base, base > 0, let target, target > 0, base != target else { return step }
        let multiplier = target / base
        guard let regex = pattern else { return step }

        let nsStep = step as NSString
        let matches = regex.matches(in: step, range: NSRange(location: 0, length: nsStep.length))
        guard !matches.isEmpty else { return step }

        var out = ""
        var lastIdx = 0
        for m in matches {
            let full = nsStep.substring(with: m.range)
            let numStr = nsStep.substring(with: m.range(at: 1))
            let unit = nsStep.substring(with: m.range(at: 2))
            let baseQty: Double
            if numStr.contains("/") {
                let parts = numStr.split(separator: "/")
                if parts.count == 2, let n = Double(parts[0]), let d = Double(parts[1]), d != 0 {
                    baseQty = n / d
                } else {
                    baseQty = Double(numStr) ?? 0
                }
            } else {
                baseQty = Double(numStr) ?? 0
            }
            let scaled = baseQty * multiplier
            let display = renderQuarter(scaled)
            // Append untouched chunk before the match
            if m.range.location > lastIdx {
                out.append(nsStep.substring(with: NSRange(location: lastIdx, length: m.range.location - lastIdx)))
            }
            // The match was "<num><whitespace><unit>" — preserve the unit verbatim.
            // We don't try to reproduce the exact whitespace; one space is fine.
            _ = full
            out.append("\(display) \(unit)")
            lastIdx = m.range.location + m.range.length
        }
        if lastIdx < nsStep.length {
            out.append(nsStep.substring(with: NSRange(location: lastIdx, length: nsStep.length - lastIdx)))
        }
        return out
    }

    /// Round to nearest quarter and render as `"1¼"` / `"½"` / `"3"` etc.
    /// Mirrors the inline formatter in `scaleStepText`.
    private static func renderQuarter(_ v: Double) -> String {
        if v.truncatingRemainder(dividingBy: 1) == 0 {
            return String(Int(v))
        }
        let rounded = (v * 4).rounded() / 4
        let whole = Int(floor(rounded))
        let frac = rounded - Double(whole)
        let glyph: String? = {
            switch frac {
            case 0.25: return "¼"
            case 0.5:  return "½"
            case 0.75: return "¾"
            default:   return nil
            }
        }()
        if whole > 0 {
            if let g = glyph { return "\(whole)\(g)" }
            return String(format: "%g", rounded)
        }
        if let g = glyph { return g }
        return String(format: "%g", (v * 100).rounded() / 100)
    }
}
