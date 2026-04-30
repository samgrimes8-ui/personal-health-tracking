import SwiftUI

/// Color tokens mirroring the web app's CSS custom properties. Same
/// semantic meaning per name so cross-referencing the JS code while
/// rewriting screens is direct.
///
/// Keeping the light palette only for now — we'll wire `@Environment(\.colorScheme)`
/// branching once the dashboard is complete and we want to honor the
/// user's saved theme choice on the web. New users on web default to
/// light, so matching that here keeps the experience consistent.
enum Theme {
    // Surfaces
    static let bg = Color(hex: 0xFBFAF6)        // cream off-white
    static let bg2 = Color(hex: 0xFFFFFF)       // pure white card surface
    static let bg3 = Color(hex: 0xF4F2EB)       // input/chip surface
    static let bg4 = Color(hex: 0xE9E6DD)       // hover/depressed surface

    // Borders
    static let border = Color(hex: 0x140F0A, opacity: 0.08)
    static let border2 = Color(hex: 0x140F0A, opacity: 0.14)

    // Text
    static let text = Color(hex: 0x1F2118)
    static let text2 = Color(hex: 0x5B5E54)
    static let text3 = Color(hex: 0x8A8C83)

    // Accent (carrot orange — distinct from any macro hue)
    static let accent = Color(hex: 0xE8843A)
    static let accent2 = Color(hex: 0xC66A23)
    static let accentFG = Color.white

    // Macros — same semantic mapping as the web app post-recolor:
    // protein=red, fat=yellow, carbs=green, calories=blue.
    static let cal = Color(hex: 0x3D88C6)       // blue
    static let protein = Color(hex: 0xC64A4A)   // red
    static let carbs = Color(hex: 0x3AA377)     // green
    static let fat = Color(hex: 0xC89518)       // yellow
    static let fiber = Color(hex: 0x9870D4)     // purple

    static let green = Color(hex: 0x3AA377)
    static let red = Color(hex: 0xB03030)

    // Soft accent fills for hover/active states
    static func accentSoft(_ opacity: Double = 0.12) -> Color {
        accent.opacity(opacity)
    }
}

extension Color {
    /// Convenience init from a 0xRRGGBB hex literal. Avoids the verbose
    /// `Color(red:green:blue:)` form everywhere.
    init(hex: UInt32, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}
