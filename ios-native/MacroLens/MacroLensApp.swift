import SwiftUI

@main
struct MacroLensApp: App {
    @State private var auth = AuthManager()

    var body: some Scene {
        WindowGroup {
            AppShell()
                .environment(auth)
                .preferredColorScheme(.light)
                .tint(Theme.accent)
        }
    }
}
