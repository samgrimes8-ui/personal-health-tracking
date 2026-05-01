import SwiftUI

/// Meal-type slot config. Order matters — this is the order the day card
/// renders slots in. Mirrors MEAL_SLOTS in src/pages/app.js renderMealPlanView.
enum PlannerMealSlot: String, CaseIterable, Identifiable {
    case breakfast, lunch, snack, dinner

    var id: String { rawValue }

    var label: String {
        switch self {
        case .breakfast: return "Breakfast"
        case .lunch:     return "Lunch"
        case .snack:     return "Snack"
        case .dinner:    return "Dinner"
        }
    }

    var icon: String {
        switch self {
        case .breakfast: return "sunrise.fill"
        case .lunch:     return "sun.max.fill"
        case .snack:     return "carrot.fill"
        case .dinner:    return "moon.stars.fill"
        }
    }

    var color: Color {
        switch self {
        case .breakfast: return Theme.cal
        case .lunch:     return Theme.carbs
        case .snack:     return Theme.protein
        case .dinner:    return Theme.fat
        }
    }

    static func from(_ raw: String?) -> PlannerMealSlot {
        guard let raw, let s = PlannerMealSlot(rawValue: raw.lowercased()) else {
            return .dinner
        }
        return s
    }
}
