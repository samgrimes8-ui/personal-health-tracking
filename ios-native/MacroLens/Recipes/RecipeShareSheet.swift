import SwiftUI

/// Recipe sharing sheet. On open, ensures `recipes.share_token` is set
/// (calling `enableRecipeSharing` if needed) and surfaces the public URL
/// `https://<host>/api/recipe/<token>` together with a native ShareLink
/// + a "Stop sharing" action.
///
/// Mirrors `shareRecipeByLink` in src/pages/app.js — same token shape, same
/// public URL pattern, same "regenerate token" semantics if the user
/// stops then re-enables. The web fires the system share sheet directly
/// from the user gesture; iOS needs a wrapping sheet because we can't
/// build a ShareLink with a URL we don't have yet.
struct RecipeShareSheet: View {
    let recipeId: String
    let recipeName: String
    /// Initial state from the detail view so the spinner doesn't flash on
    /// already-shared recipes.
    let initialToken: String?
    let initialIsShared: Bool

    /// Notified when sharing is enabled or disabled so the parent can update
    /// its local recipe row (is_shared / share_token) without a round-trip.
    let onChanged: (_ isShared: Bool, _ token: String?) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var token: String?
    @State private var isShared: Bool
    @State private var working: Bool = false
    @State private var error: String?

    init(recipeId: String,
         recipeName: String,
         initialToken: String?,
         initialIsShared: Bool,
         onChanged: @escaping (Bool, String?) -> Void) {
        self.recipeId = recipeId
        self.recipeName = recipeName
        self.initialToken = initialToken
        self.initialIsShared = initialIsShared
        self.onChanged = onChanged
        _token = State(initialValue: initialToken)
        _isShared = State(initialValue: initialIsShared)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    headerBlock
                    if let url = shareURL {
                        urlPreviewBlock(url)
                        ShareLink(item: url) {
                            Label("Share via…", systemImage: "square.and.arrow.up")
                                .font(.system(size: 15, weight: .semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 13)
                                .foregroundStyle(Theme.accentFG)
                                .background(Theme.accent, in: .rect(cornerRadius: 12))
                        }
                        stopSharingButton
                    } else {
                        enableBlock
                    }
                    if let err = error {
                        Text(err).font(.system(size: 12)).foregroundStyle(Theme.red)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 28)
            }
            .background(Theme.bg)
            .navigationTitle("Share recipe")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                if isShared, token == nil {
                    // Edge case: recipe row says is_shared=true but no token
                    // — refresh by minting a new one. Web does the same.
                    await enable()
                } else if !isShared {
                    // Tapping Share on a not-yet-shared recipe should turn
                    // sharing on immediately so the URL is ready when the
                    // sheet appears (parity with the web's one-tap flow).
                    await enable()
                }
            }
        }
    }

    // MARK: - Sections

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(recipeName)
                .font(.system(size: 18, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
            Text("Anyone with this link can view your recipe — ingredients, macros, and steps.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
        }
    }

    private func urlPreviewBlock(_ url: URL) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Public link")
                .font(.system(size: 11, weight: .medium))
                .tracking(1.0).textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            HStack(spacing: 8) {
                Text(url.absoluteString)
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    UIPasteboard.general.string = url.absoluteString
                } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: 13))
                        .foregroundStyle(Theme.text2)
                        .padding(8)
                        .background(Theme.bg2, in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .padding(10)
            .background(Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
        }
    }

    private var stopSharingButton: some View {
        Button(role: .destructive) {
            Task { await stopSharing() }
        } label: {
            HStack {
                if working { ProgressView().controlSize(.small) }
                Text(working ? "Stopping..." : "Stop sharing")
                    .font(.system(size: 13, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .foregroundStyle(Theme.red)
            .background(Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.3), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(working)
    }

    private var enableBlock: some View {
        VStack(spacing: 12) {
            ProgressView().tint(Theme.accent)
            Text("Generating link…")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text3)
        }
        .frame(maxWidth: .infinity)
        .padding(40)
    }

    // MARK: - Actions

    private var shareURL: URL? {
        guard let token, !token.isEmpty else { return nil }
        return URL(string: "\(Config.apiBaseURL.absoluteString)/api/recipe/\(token)")
    }

    private func enable() async {
        working = true
        error = nil
        defer { working = false }
        do {
            let newToken = try await DBService.enableRecipeSharing(recipeId: recipeId)
            token = newToken
            isShared = true
            onChanged(true, newToken)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func stopSharing() async {
        working = true
        error = nil
        defer { working = false }
        do {
            try await DBService.disableRecipeSharing(recipeId: recipeId)
            isShared = false
            // Keep `token` as nil so the URL preview disappears. The DB
            // still holds the old token (web does this too); re-enabling
            // mints a new one rather than reusing it.
            token = nil
            onChanged(false, nil)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
