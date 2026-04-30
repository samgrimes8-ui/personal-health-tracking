# MacroLens — Native iOS

Native SwiftUI rewrite, replacing the Capacitor wrapper at `../ios/`.
Hybrid model during the migration: native shell + native screens for
sections that have been rewritten, embedded `WKWebView` for sections that
haven't yet. As more screens land, we delete more web fallbacks.

## First-time setup

The project file (`MacroLens.xcodeproj`) is generated from `project.yml`
by [xcodegen](https://github.com/yonaskolb/XcodeGen). This keeps the
project definition in code rather than in a binary `.pbxproj`.

```sh
brew install xcodegen        # one-time
cd ios-native
xcodegen generate            # produces MacroLens.xcodeproj
open MacroLens.xcodeproj
```

In Xcode:
- Select the `App` target → **Signing & Capabilities** → pick your
  personal Apple ID team. Bundle ID is `app.macrolens.native`; if it
  collides with someone else's reservation, change it.
- Wait a moment for Swift Package Manager to resolve `supabase-swift`
  (visible at the bottom-left of the Xcode window).
- Plug in your iPhone, pick it from the device dropdown, ⌘R.

## Project layout

```
ios-native/
├── project.yml                     # xcodegen config
├── MacroLens/
│   ├── MacroLensApp.swift          # @main entry, SupabaseClient injection
│   ├── Info.plist                  # camera/photo permissions, theme color
│   ├── Config.swift                # Supabase URL + publishable key
│   ├── Theme.swift                 # color tokens matching the web app
│   ├── Auth/
│   │   ├── AuthView.swift          # sign-in / sign-up screen
│   │   └── AuthManager.swift       # @Observable session state
│   ├── Networking/
│   │   ├── Supabase.swift          # SupabaseClient singleton
│   │   └── Models.swift            # Codable types for DB rows
│   ├── State/
│   │   └── AppState.swift          # @Observable app-wide state
│   ├── Dashboard/
│   │   └── DashboardView.swift     # native dashboard (in progress)
│   └── Shell/
│       └── AppShell.swift          # auth gate + tab routing
└── README.md
```

## Migration order

Rough plan, top to bottom:

1. ✅ Project setup, auth, app shell
2. 🚧 Dashboard (Daily macro counts + Today's meals first; Analyze food
   later because it depends on the `/api/analyze` upload flow)
3. Goals (body metrics, weekly check-in, tiered history)
4. Planner (week grid, drag-and-drop)
5. Recipes
6. Foods
7. Account
8. Cooking mode (read-aloud)

Each migration deletes that screen's webview tab and replaces with the
native view. When the last tab flips to native, we delete `../ios/` and
the `server.url` line from the old `capacitor.config.json`.

## Conventions

- iOS 17 minimum (lets us use `@Observable`, latest Charts).
- Use the official `supabase-swift` SDK for auth + queries (mental model
  matches the JS client — `client.auth`, `client.from("table").select()`).
- Hit `https://personal-health-tracking.vercel.app/api/...` directly for
  the existing edge-function endpoints (analyze, tts, share, etc.) via
  `URLSession`. No need to rewrite those server-side.
- No storyboards. Pure SwiftUI.
- Color tokens live in `Theme.swift`; reference them as `Theme.bg`,
  `Theme.accent`, etc. so light/dark theme parity stays trivial later.
