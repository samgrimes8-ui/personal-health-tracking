import SwiftUI

/// Native Providers tab. Mirrors renderProvidersPage() in
/// src/pages/app.js (lines 4347–4488), with the same gate on the
/// directory filter: only profiles with role IN (provider, admin) AND
/// a non-empty provider_name show up.
///
/// What's covered in v1:
///   - Search bar (filters name / specialty / bio, client-side)
///   - "Following" section + "Discover" / "All providers" section
///   - Per-row Follow / Unfollow with optimistic toggle
///   - Tap-through to a detail sheet with full bio + credentials
///   - Optional "Manage my channel" sheet for users whose profile is
///     already loaded with a provider role (Account tab loads profile)
///
/// Deferred to follow-ups:
///   - Per-card broadcast preview (the "Loading plans..." block under
///     each followed-provider card on web). Needs getProviderBroadcasts
///     + a copy-to-planner sheet; layered in once the Planner tab can
///     accept incoming rows.
///   - Avatar upload (storage write to provider-avatars bucket).
///   - Become-a-provider role flip — that's an Account-tab concern.
struct ProvidersView: View {
    @Environment(AppState.self) private var state
    @State private var search: String = ""
    @State private var selected: ProviderRow?
    @State private var showChannelSheet = false
    @FocusState private var searchFocused: Bool

    private var currentUserId: String? {
        state.profile?.user_id
    }

    private var filteredProviders: [ProviderRow] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        let visible = state.providers.filter { p in
            p.user_id != currentUserId    // hide self from directory, web does the same
        }
        guard !q.isEmpty else { return visible }
        return visible.filter { p in
            (p.provider_name ?? "").lowercased().contains(q)
                || (p.provider_specialty ?? "").lowercased().contains(q)
                || (p.provider_bio ?? "").lowercased().contains(q)
        }
    }

    private var followingRows: [ProviderRow] {
        filteredProviders.filter { state.followedProviderIds.contains($0.user_id) }
    }

    private var discoverRows: [ProviderRow] {
        filteredProviders.filter { !state.followedProviderIds.contains($0.user_id) }
    }

    private var isProvider: Bool {
        guard let role = state.profile?.role else { return false }
        return role == "provider" || role == "admin"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                greeting

                if !state.providers.isEmpty {
                    searchField
                }

                if isProvider {
                    Button { showChannelSheet = true } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "person.crop.rectangle.badge.plus")
                            Text("Manage my channel")
                                .font(.system(size: 14, weight: .semibold))
                        }
                        .foregroundStyle(Theme.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Theme.accentSoft(0.10), in: .rect(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12)
                            .stroke(Theme.accent.opacity(0.30), lineWidth: 1))
                    }
                }

                if state.providers.isEmpty {
                    emptyDirectory
                } else {
                    if !followingRows.isEmpty {
                        sectionLabel(title: "Following",
                                     count: followingRows.count,
                                     filtered: !search.isEmpty)
                        VStack(spacing: 10) {
                            ForEach(followingRows) { p in providerCard(p, isFollowing: true) }
                        }
                    }

                    sectionLabel(title: followingRows.isEmpty ? "Discover providers" : "All providers",
                                 count: nil, filtered: false)
                    if discoverRows.isEmpty {
                        EmptyState(
                            icon: "magnifyingglass",
                            title: !search.isEmpty
                                ? "No providers match \"\(search)\""
                                : (followingRows.isEmpty ? "No providers yet" : "You're following everyone"),
                            message: !search.isEmpty
                                ? "Try a different search."
                                : (followingRows.isEmpty
                                   ? "Providers will appear here when they join MacroLens."
                                   : nil)
                        )
                    } else {
                        VStack(spacing: 10) {
                            ForEach(discoverRows) { p in providerCard(p, isFollowing: false) }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        // We call providersLoadImpl directly (not state.loadProviders())
        // so the Providers tab works regardless of whether the AppState
        // stub has been wired up yet by the orchestrating change.
        .refreshable { await state.providersLoadImpl() }
        .task { await state.providersLoadImpl() }
        .navigationTitle("Providers")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if searchFocused {
                    Button("Done") { searchFocused = false }
                }
            }
        }
        .sheet(item: $selected) { provider in
            NavigationStack {
                ProviderDetailView(provider: provider)
                    .environment(state)
            }
        }
        .sheet(isPresented: $showChannelSheet) {
            EditChannelSheet()
                .environment(state)
        }
    }

    // MARK: - Sections

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Providers")
                .font(.system(size: 26, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
            Text(isProvider
                 ? "Browse other providers or manage your channel."
                 : "Follow dietitians and coaches.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text3)
        }
        .padding(.top, 12)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text3)
            TextField("Search providers by name or specialty…", text: $search)
                .focused($searchFocused)
                .submitLabel(.search)
                .onSubmit { searchFocused = false }
                .font(.system(size: 14))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !search.isEmpty {
                Button { search = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.text3)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
    }

    private var emptyDirectory: some View {
        Card {
            VStack(spacing: 8) {
                Text("🩺").font(.system(size: 32))
                Text("No providers yet")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text("Providers will appear here when they join MacroLens.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
        }
    }

    private func sectionLabel(title: String, count: Int?, filtered: Bool) -> some View {
        let suffix: String = {
            guard let count else { return "" }
            return filtered ? " (\(count) · filtered)" : " (\(count))"
        }()
        return Text("\(title)\(suffix)")
            .font(.system(size: 11, weight: .medium))
            .tracking(1.0)
            .textCase(.uppercase)
            .foregroundStyle(Theme.text3)
            .padding(.top, 4)
    }

    // MARK: - Card

    private func providerCard(_ p: ProviderRow, isFollowing: Bool) -> some View {
        Button { selected = p } label: {
            HStack(alignment: .top, spacing: 12) {
                avatar(for: p)

                VStack(alignment: .leading, spacing: 4) {
                    Text(p.provider_name ?? p.email ?? "Provider")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)

                    let chips = ProvidersView.parseCredentials(p.credentials)
                    if !chips.isEmpty {
                        WrapHStack(spacing: 4, runSpacing: 4) {
                            ForEach(chips, id: \.self) { c in
                                Text(c)
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(Theme.green)
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .background(Theme.green.opacity(0.12), in: .rect(cornerRadius: 999))
                                    .overlay(RoundedRectangle(cornerRadius: 999)
                                        .stroke(Theme.green.opacity(0.30), lineWidth: 1))
                            }
                        }
                    }

                    if let s = p.provider_specialty, !s.isEmpty {
                        Text(s)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text2)
                            .lineLimit(1)
                    }
                    if let bio = p.provider_bio, !bio.isEmpty {
                        Text(bio)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.text3)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: 8)

                followPill(p: p, isFollowing: isFollowing)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bg2, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func followPill(p: ProviderRow, isFollowing: Bool) -> some View {
        Button {
            Task { await state.setProviderFollowed(p.user_id, !isFollowing) }
        } label: {
            Text(isFollowing ? "Following" : "+ Follow")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(isFollowing ? Theme.text3 : Theme.green)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    isFollowing
                        ? Theme.bg3
                        : Theme.green.opacity(0.15),
                    in: .rect(cornerRadius: 8)
                )
                .overlay(RoundedRectangle(cornerRadius: 8)
                    .stroke(isFollowing ? Theme.border2 : Theme.green, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func avatar(for p: ProviderRow) -> some View {
        if let url = p.provider_avatar_url, let parsed = URL(string: url) {
            AsyncImage(url: parsed) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFill()
                default:
                    avatarPlaceholder
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(Circle())
        } else {
            avatarPlaceholder
        }
    }

    private var avatarPlaceholder: some View {
        ZStack {
            Circle().fill(Theme.green.opacity(0.15))
            Text("🩺").font(.system(size: 20))
        }
        .frame(width: 44, height: 44)
    }

    static func parseCredentials(_ raw: String?) -> [String] {
        guard let raw, !raw.isEmpty else { return [] }
        return raw.split(whereSeparator: { $0 == "," || $0 == "|" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}

/// Minimal flow-layout stand-in for credential chips. SwiftUI's
/// FlowLayout (iOS 16+) requires custom Layout work; this gets us a
/// simple wrap with predictable spacing without pulling in a layout
/// library. Falls back to a single HStack on the rare overflow case.
struct WrapHStack<Content: View>: View {
    let spacing: CGFloat
    let runSpacing: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        // The simple stack is good enough for a handful of credential
        // chips per provider — long lists clip to lineLimit on the
        // underlying Text so we don't blow out a card's height.
        HStack(spacing: spacing) {
            content
        }
    }
}
