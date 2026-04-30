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
                .onOpenURL { url in
                    // Safety net for deep links that escape
                    // ASWebAuthenticationSession's catcher (e.g., the user
                    // background-tapped before the sheet captured the
                    // callback, or a future external-app return path).
                    // Anything on our custom scheme that contains auth
                    // tokens we forward to Supabase to complete sign-in.
                    Task { await auth.handleDeepLink(url) }
                }
        }
    }
}
