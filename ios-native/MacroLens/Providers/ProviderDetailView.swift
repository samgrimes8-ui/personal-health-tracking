import SwiftUI

/// Detail sheet for a single provider. Mirrors what the web shows
/// when you tap into a provider card: avatar, name, credentials,
/// specialty, full bio, follow toggle. Broadcast preview is deferred
/// (see ProvidersView header).
struct ProviderDetailView: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    let provider: ProviderRow

    private var isFollowing: Bool {
        state.followedProviderIds.contains(provider.user_id)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                credentialsBlock
                if let bio = provider.provider_bio, !bio.isEmpty {
                    Card {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("About")
                                .font(.system(size: 11, weight: .medium))
                                .tracking(1.0)
                                .textCase(.uppercase)
                                .foregroundStyle(Theme.text3)
                            Text(bio)
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.text)
                        }
                    }
                }

                followButton
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .navigationTitle(provider.provider_name ?? "Provider")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.accent)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            avatar
            VStack(alignment: .leading, spacing: 4) {
                Text(provider.provider_name ?? "Provider")
                    .font(.system(size: 20, weight: .semibold, design: .serif))
                    .foregroundStyle(Theme.text)
                if let s = provider.provider_specialty, !s.isEmpty {
                    Text(s)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text2)
                }
            }
            Spacer()
        }
        .padding(.top, 8)
    }

    @ViewBuilder
    private var credentialsBlock: some View {
        let chips = ProvidersView.parseCredentials(provider.credentials)
        if !chips.isEmpty {
            HStack(spacing: 6) {
                ForEach(chips, id: \.self) { c in
                    Text(c)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.green)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(Theme.green.opacity(0.12), in: .rect(cornerRadius: 999))
                        .overlay(RoundedRectangle(cornerRadius: 999)
                            .stroke(Theme.green.opacity(0.30), lineWidth: 1))
                }
                Spacer()
            }
        }
    }

    private var followButton: some View {
        Button {
            Task { await state.setProviderFollowed(provider.user_id, !isFollowing) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: isFollowing ? "checkmark" : "plus")
                Text(isFollowing ? "Following" : "Follow")
                    .font(.system(size: 15, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .foregroundStyle(isFollowing ? Theme.text2 : Theme.accentFG)
            .background(isFollowing ? Theme.bg3 : Theme.accent, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .stroke(isFollowing ? Theme.border2 : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var avatar: some View {
        if let url = provider.provider_avatar_url, let parsed = URL(string: url) {
            AsyncImage(url: parsed) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFill()
                default:
                    avatarPlaceholder
                }
            }
            .frame(width: 64, height: 64)
            .clipShape(Circle())
        } else {
            avatarPlaceholder
        }
    }

    private var avatarPlaceholder: some View {
        ZStack {
            Circle().fill(Theme.green.opacity(0.15))
            Text("🩺").font(.system(size: 28))
        }
        .frame(width: 64, height: 64)
    }
}
