import SwiftUI
import AVFoundation
import AVFAudio

/// Full-screen cooking mode. Silent step-by-step walkthrough by default —
/// big step text, Prev/Next, no audio. The speaker icon in the toolbar
/// opts in to voice playback; the first time the user enables voice in
/// a session, they're asked whether to use Premium AI (high-quality but
/// 5–15s per fresh generation) or System voice (instant, free, offline).
/// The kind choice persists in UserDefaults; voiceOn defaults off each
/// session so the experience always opens to the silent walkthrough.
///
/// When voice is on AND set to Premium AI, all step audios are eagerly
/// preloaded with concurrency 3 so Next taps play instantly. The progress
/// pill ("Preparing voices… 4 / 12") and per-step loading banners surface
/// only in this mode — System voice and silent mode never show audio
/// status because they have no async latency to communicate.
struct CookingModeView: View {
    let recipe: RecipeFull

    @Environment(\.dismiss) private var dismiss
    @StateObject private var player = CookingPlayer()

    @State private var stepIndex: Int = 0
    @State private var premiumVoiceId: String = CookingPlayer.savedPremiumVoiceId()
    @State private var voiceKind: CookingPlayer.VoiceKind? = CookingPlayer.savedVoiceKind()
    /// Per-session — always starts false so the entry to cooking mode is
    /// the silent walkthrough. User toggles via the speaker icon.
    @State private var voiceOn: Bool = false
    @State private var voiceKindPickerOpen: Bool = false
    @State private var voicePickerOpen: Bool = false

    private var steps: [String] { recipe.instructions?.steps ?? [] }
    private var servings: Double { recipe.servings ?? 1 }
    private var instructionsVersion: Int { recipe.instructions_version ?? 1 }

    /// Audio status UI (per-step loader, fell-back banner, error banner)
    /// surfaces only when the user has explicitly enabled voice. Silent
    /// mode and System voice never show it — silent has no audio at all,
    /// system voice has no async latency to communicate.
    private var showsAudioStatus: Bool { voiceOn && voiceKind == .premium }

    var body: some View {
        ZStack(alignment: .top) {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 14) {
                header
                voiceControls
                if showsAudioStatus {
                    prefetchPill
                }
                progressDots
                stepCard
                if showsAudioStatus {
                    audioStatusBlock
                }
                if let tips = recipe.instructions?.tips, !tips.isEmpty, !tips.allSatisfy({ $0.isEmpty }) {
                    tipsBlock(tips)
                }
                Spacer(minLength: 0)
                controls
            }
            .padding(.horizontal, 18)
            .padding(.top, 24)
            .padding(.bottom, 18)
            .animation(.easeInOut(duration: 0.18), value: player.phase)
            .animation(.easeInOut(duration: 0.18), value: player.prefetchProgress)
        }
        .onAppear {
            // Default-silent mode — no audio fires until the user taps
            // the speaker. We deliberately don't call speakCurrent or
            // scheduleFullPrefetch here so cooking mode opens instantly
            // and doesn't burn AI Bucks for users who never enable voice.
        }
        .onDisappear {
            player.stop()
        }
        .confirmationDialog("Cooking voice",
                            isPresented: $voiceKindPickerOpen,
                            titleVisibility: .visible) {
            Button("Premium AI voice") {
                voiceKind = .premium
                CookingPlayer.persistVoiceKind(.premium)
                voiceOn = true
                speakCurrent()
                scheduleFullPrefetch()
            }
            Button("System voice (instant)") {
                voiceKind = .system
                CookingPlayer.persistVoiceKind(.system)
                voiceOn = true
                speakCurrent()
            }
            Button("Cancel", role: .cancel) {
                // Leave voice off — same as if they never tapped the speaker.
            }
        } message: {
            Text("Premium AI takes 10–15s per new step but sounds natural. System voice is instant + works offline.")
        }
        .sheet(isPresented: $voicePickerOpen) {
            VoicePickerSheet(
                currentKind: voiceKind ?? .premium,
                currentPremiumId: $premiumVoiceId
            ) { newKind, newPremiumId in
                let kindChanged = (newKind != voiceKind)
                voiceKind = newKind
                CookingPlayer.persistVoiceKind(newKind)
                if let id = newPremiumId, id != premiumVoiceId {
                    premiumVoiceId = id
                    CookingPlayer.persistPremiumVoiceId(id)
                }
                player.cachedFreeVoice = nil
                if kindChanged || newPremiumId != nil {
                    // New voice config — old MP3s under a different cache
                    // key are useless; drop them and re-prefetch.
                    player.invalidatePrefetch()
                    if voiceOn {
                        speakCurrent()
                        scheduleFullPrefetch()
                    }
                }
            }
        }
    }

    // MARK: - Sections

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Cooking")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.6).textCase(.uppercase)
                    .foregroundStyle(Theme.text3)
                Text(recipe.name)
                    .font(.system(size: 18, weight: .semibold, design: .serif))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
            }
            Spacer()
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.text2)
                    .frame(width: 36, height: 36)
                    .background(Theme.bg3, in: .circle)
                    .overlay(Circle().stroke(Theme.border2, lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
    }

    /// Single speaker pill: tap toggles voice on/off; long-press opens the
    /// voice picker (Premium AI vs System, plus the OpenAI voice subpicker
    /// for Premium). First tap with no saved voiceKind opens an
    /// "AI voice or System voice?" confirmation dialog instead of toggling
    /// straight to on, so the user makes the high-stakes choice up front.
    private var voiceControls: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Button {
                handleSpeakerTap()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: voiceOn ? "speaker.wave.2.fill" : "speaker.slash.fill")
                        .font(.system(size: 12))
                    Text(voiceOn ? voiceLabel : "Silent")
                        .font(.system(size: 11, weight: voiceOn ? .semibold : .regular))
                }
                .foregroundStyle(voiceOn ? Theme.accent : Theme.text3)
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(voiceOn ? Theme.accent.opacity(0.12) : Theme.bg3, in: .rect(cornerRadius: 999))
                .overlay(RoundedRectangle(cornerRadius: 999).stroke(voiceOn ? Theme.accent.opacity(0.4) : Theme.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(voiceOn ? "Voice on. Tap to silence. Long press to change voice." : "Silent. Tap to enable voice.")
            .accessibilityHint("Long press for voice options")
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.4).onEnded { _ in
                voicePickerOpen = true
            })
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    /// Friendly summary of what voice will play. Premium AI shows the
    /// voice name (Nova / Shimmer / …); System shows "System voice". When
    /// voiceKind is unresolved (shouldn't happen post-first-toggle) we
    /// show "Voice on" as a generic fallback.
    private var voiceLabel: String {
        switch voiceKind {
        case .premium?: return displayVoiceName
        case .system?:  return "System voice"
        case nil:       return "Voice on"
        }
    }

    /// Tap-on-speaker behavior. Opens the kind picker on first enable so
    /// the user makes the deliberate Premium-vs-System choice; subsequent
    /// toggles flip silently using the saved kind.
    private func handleSpeakerTap() {
        if voiceOn {
            voiceOn = false
            player.stop()
            player.clearPhase()
            return
        }
        // Voice was off → trying to enable.
        if voiceKind == nil {
            voiceKindPickerOpen = true
            return
        }
        voiceOn = true
        speakCurrent()
        if voiceKind == .premium {
            scheduleFullPrefetch()
        }
    }

    private var progressDots: some View {
        HStack(spacing: 6) {
            ForEach(0..<steps.count, id: \.self) { i in
                Button {
                    stepIndex = i
                    speakCurrent()
                } label: {
                    Capsule()
                        .fill(i == stepIndex ? Theme.accent
                              : (i < stepIndex ? Theme.text3 : Theme.bg3))
                        .frame(width: i == stepIndex ? 24 : 8, height: 8)
                        .animation(.easeInOut(duration: 0.18), value: stepIndex)
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var stepCard: some View {
        if steps.isEmpty {
            Text("This recipe has no instructions yet.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.text3)
                .multilineTextAlignment(.center)
                .padding(.top, 60)
        } else {
            let step = steps[stepIndex]
            let scaled = StepTextScaler.scale(step, base: servings, target: servings)
            VStack(spacing: 14) {
                Text("Step \(stepIndex + 1) of \(steps.count)")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(1.0).textCase(.uppercase)
                    .foregroundStyle(Theme.accent)
                Text(scaled)
                    .font(.system(size: 22, design: .serif))
                    .foregroundStyle(Theme.text)
                    .lineSpacing(3)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 520)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        }
    }

    /// Inline status banner for the current step's audio. Surfaces:
    ///   • Nothing when audio is playing or idle.
    ///   • "Generating voice for step N…" while loading. Adds a hint after
    ///     3s ("this can take 10–15s for new steps") and a retry/skip
    ///     action set after 30s ("taking longer than usual").
    ///   • "Premium unavailable — using system voice. Tap to retry."
    ///     when the network call failed and we auto-fell-back so the user
    ///     still hears something.
    /// TimelineView ticks every 0.5s while loading so the elapsed time
    /// can drive the hint tiers without a manual SwiftUI redraw loop.
    @ViewBuilder
    private var audioStatusBlock: some View {
        switch player.phase {
        case .idle, .playing:
            EmptyView()
        case .loading(let stepIdx, let since, let fellBackToSystem):
            if fellBackToSystem {
                fellBackBanner(stepIndex: stepIdx)
            } else {
                TimelineView(.periodic(from: .now, by: 0.5)) { context in
                    loadingBanner(stepIndex: stepIdx, since: since, now: context.date)
                }
            }
        case .failed(let stepIdx, let message):
            errorBanner(stepIndex: stepIdx, message: message)
        }
    }

    private func loadingBanner(stepIndex: Int, since: Date, now: Date) -> some View {
        let elapsed = now.timeIntervalSince(since)
        let stuck = elapsed >= 30
        let extendedHint = elapsed >= 3 && elapsed < 30
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small).tint(Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Generating voice for step \(stepIndex + 1)…")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.text2)
                    if extendedHint {
                        Text("This can take 10–15s for new steps")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.text3)
                    } else if stuck {
                        Text("Voice generation taking longer than usual")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.fat)
                    }
                }
                Spacer(minLength: 0)
            }
            if stuck {
                HStack(spacing: 8) {
                    Button { retryCurrent() } label: {
                        Text("Retry")
                            .font(.system(size: 12, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 7)
                            .background(Theme.accent, in: .rect(cornerRadius: 8))
                            .foregroundStyle(Theme.accentFG)
                    }.buttonStyle(.plain)
                    Button { skipCurrent() } label: {
                        Text("Skip step")
                            .font(.system(size: 12, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 7)
                            .background(Theme.bg2, in: .rect(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                            .foregroundStyle(Theme.text2)
                    }.buttonStyle(.plain)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(12)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
    }

    private func fellBackBanner(stepIndex: Int) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.fat)
            VStack(alignment: .leading, spacing: 2) {
                Text("Premium voice unavailable")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.text2)
                Text("Using system voice for this step. Tap to retry.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
            Spacer(minLength: 0)
            Button { retryCurrent() } label: {
                Text("Retry")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Theme.bg2, in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                    .foregroundStyle(Theme.accent)
            }.buttonStyle(.plain)
        }
        .padding(12)
        .background(Theme.fat.opacity(0.08), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.fat.opacity(0.25), lineWidth: 1))
    }

    private func errorBanner(stepIndex: Int, message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "xmark.octagon.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.red)
            VStack(alignment: .leading, spacing: 2) {
                Text("Voice unavailable")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.text2)
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            Button { retryCurrent() } label: {
                Text("Retry")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Theme.bg2, in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                    .foregroundStyle(Theme.accent)
            }.buttonStyle(.plain)
        }
        .padding(12)
        .background(Theme.red.opacity(0.06), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.25), lineWidth: 1))
    }

    /// Top-of-screen pill that surfaces while the eager-prefetch pass is
    /// running. Disappears the moment the last step completes (success or
    /// failure — see CookingPlayer.markResolved). Capped at 3 simultaneous
    /// requests inside the player so this never represents 12 in-flight
    /// fetches even on long recipes.
    @ViewBuilder
    private var prefetchPill: some View {
        let p = player.prefetchProgress
        if p.isActive {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini).tint(Theme.text3)
                Text("Preparing voices… \(p.resolved) / \(p.total)")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Theme.bg3, in: .rect(cornerRadius: 999))
            .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.border, lineWidth: 1))
            .transition(.opacity.combined(with: .scale))
        }
    }

    private func tipsBlock(_ tips: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("💡 Tips")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.6).textCase(.uppercase)
                .foregroundStyle(Theme.accent)
            ForEach(Array(tips.enumerated()), id: \.offset) { _, t in
                HStack(alignment: .top, spacing: 6) {
                    Text("•").foregroundStyle(Theme.accent)
                    Text(t).font(.system(size: 13)).foregroundStyle(Theme.text2)
                }
            }
        }
        .padding(12)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
    }

    private var controls: some View {
        let isFirst = stepIndex == 0
        let isLast = stepIndex == max(steps.count - 1, 0)
        return HStack(spacing: 8) {
            if !isFirst {
                controlButton(title: "← Back", style: .secondary) {
                    stepIndex -= 1
                    speakCurrent()
                }
            }
            if voiceOn {
                controlButton(title: player.isPaused ? "▶ Resume" : "⏸ Pause", style: .secondary) {
                    if player.isPaused {
                        player.resume()
                    } else {
                        player.pause()
                    }
                }
                controlButton(title: "↻ Repeat", style: .secondary) {
                    speakCurrent()
                }
            }
            controlButton(title: isLast ? "✓ Done" : "Next →", style: .primary) {
                if isLast {
                    dismiss()
                } else {
                    stepIndex += 1
                    speakCurrent()
                }
            }
        }
    }

    enum ButtonStyle { case primary, secondary }

    private func controlButton(title: String, style: ButtonStyle, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .foregroundStyle(style == .primary ? Theme.accentFG : Theme.text2)
                .background(style == .primary ? Theme.accent : Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(style == .primary ? Color.clear : Theme.border2, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Behavior

    private var displayVoiceName: String {
        switch premiumVoiceId {
        case "nova":    return "Nova"
        case "shimmer": return "Shimmer"
        case "alloy":   return "Alloy"
        case "echo":    return "Echo"
        case "fable":   return "Fable"
        case "onyx":    return "Onyx"
        default:        return premiumVoiceId.capitalized
        }
    }

    /// Speak the step at `stepIndex` IF voice is on. No-op when in silent
    /// mode (default cooking-mode entry state). Premium path runs through
    /// /api/tts → AVPlayer; system path skips the API entirely. Auto
    /// fallback to system voice on premium failure is handled inside
    /// CookingPlayer.speak.
    private func speakCurrent() {
        guard voiceOn, !steps.isEmpty else {
            player.stop()
            player.clearPhase()
            return
        }
        let step = steps[stepIndex]
        let ctx = ttsContext(for: stepIndex)
        player.speak(step: step, ctx: ctx)
    }

    /// Kick off background prefetch for every step. Skipped unless voice
    /// is on AND set to Premium AI — system voice doesn't hit /api/tts so
    /// there's nothing to preload, and silent mode shouldn't spend AI Bucks.
    private func scheduleFullPrefetch() {
        guard voiceOn, voiceKind == .premium, !steps.isEmpty else { return }
        player.prefetchAll(steps: steps) { idx in
            ttsContext(for: idx)
        }
    }

    /// Build the TTSContext for one step. `voiceId` resolves to the
    /// premium voice id when voiceKind is .premium; the system-voice
    /// sentinel ("system") when voiceKind is .system. CookingPlayer.speak
    /// short-circuits the API when it sees the system sentinel.
    private func ttsContext(for idx: Int) -> TTSContext {
        let resolvedVoice = (voiceKind == .system)
            ? CookingPlayer.systemVoiceId
            : premiumVoiceId
        return TTSContext(
            recipeId: recipe.id,
            stepIndex: idx,
            servings: Double(round(servings * 100) / 100),
            voiceId: resolvedVoice,
            instructionsVersion: instructionsVersion
        )
    }

    /// Re-issue the audio fetch for whatever step is currently displayed.
    /// Wired to the inline "Retry" button on the loading-too-long banner
    /// and the fell-back/error banners.
    private func retryCurrent() {
        guard voiceOn, !steps.isEmpty else { return }
        let step = steps[stepIndex]
        let ctx = ttsContext(for: stepIndex)
        player.retry(step: step, ctx: ctx)
    }

    /// Advance past a step whose audio we can't generate. Same target as
    /// the regular Next button but reachable from inside the loading-too-
    /// long banner. Stops in-flight audio before advancing.
    private func skipCurrent() {
        player.stop()
        player.clearPhase()
        if stepIndex < steps.count - 1 {
            stepIndex += 1
            speakCurrent()
        } else {
            dismiss()
        }
    }
}

/// Per-step request context handed to `CookingPlayer.speak`. Splitting it
/// from the view keeps the player class testable without a SwiftUI
/// dependency.
struct TTSContext {
    let recipeId: String
    let stepIndex: Int
    let servings: Double
    let voiceId: String
    let instructionsVersion: Int
}

/// Audio engine for cooking mode. Owns:
///   • An AVPlayer for OpenAI premium MP3 playback.
///   • An AVSpeechSynthesizer as the network-fail / unsupported-voice
///     fallback.
///   • A monotonically increasing ticket counter so a fast-tapping user
///     (Next > Next > Next) only hears the latest step's audio.
@MainActor
final class CookingPlayer: ObservableObject {
    /// Structured per-step audio state. `loading` carries a `since` timestamp
    /// so the UI can decay through hint tiers (3s "this can take 10–15s",
    /// 30s "taking longer than usual" + retry/skip) without each tier
    /// needing its own state. `failed` carries the error string so the
    /// inline retry banner can surface a useful reason.
    enum AudioPhase: Equatable {
        case idle
        case loading(stepIndex: Int, since: Date, fellBackToSystem: Bool = false)
        case playing(stepIndex: Int)
        case failed(stepIndex: Int, message: String)
    }

    @Published private(set) var phase: AudioPhase = .idle
    @Published private(set) var isPaused: Bool = false
    /// Eager-prefetch progress. `total` is set when prefetchAll starts;
    /// `resolved` increments on every successful or failed individual fetch
    /// (failures are counted as "done" so the badge can disappear). The
    /// view shows a "Preparing voices… X / Y" pill when total > 0 and
    /// resolved < total.
    @Published private(set) var prefetchProgress: PrefetchProgress = .init(resolved: 0, total: 0)

    struct PrefetchProgress: Equatable {
        var resolved: Int
        var total: Int
        var isActive: Bool { total > 0 && resolved < total }
    }

    private var player: AVPlayer?
    private var endObserver: NSObjectProtocol?
    private let synthesizer = AVSpeechSynthesizer()
    private var ticket: Int = 0
    var cachedFreeVoice: AVSpeechSynthesisVoice?

    /// Resolved MP3 URLs keyed by step index. Populated either by a successful
    /// background prefetch (no audio playback) or by an on-demand `speak`
    /// call. Keyed by `(voiceId, instructionsVersion, stepIndex)` so a voice
    /// change blows the cache cleanly without leaking the wrong audio.
    private var resolvedURLs: [PrefetchKey: URL] = [:]
    /// In-flight prefetch tasks keyed the same way. `speak` checks this map
    /// before issuing a fresh fetch so two callers never race for the same
    /// step.
    private var pendingFetches: [PrefetchKey: Task<URL, Error>] = [:]
    /// Concurrency cap for the eager prefetch pass. The TTS endpoint is
    /// cache-first and serverside-cheap, but we still want to be polite to
    /// the upstream OpenAI rate limit on first reads.
    private let prefetchConcurrency = 3

    init() {
        configureAudioSession()
    }

    private func configureAudioSession() {
        // Playback category so audio works with the phone in silent mode.
        // The cooking flow expects the recipe to read aloud regardless of
        // the ringer switch — same UX users get from podcasts / Maps.
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        } catch {
            // Audio session configuration is best-effort; we still get
            // playback in silent mode if the route is already correct.
        }
    }

    /// Speak the given step with the given context. Cache-first: if a
    /// prefetch already resolved this step, plays instantly. If a prefetch
    /// is in flight, awaits it (so the user gets one short wait rather
    /// than a duplicated request). On premium-TTS failure, auto-falls back
    /// to AVSpeechUtterance and surfaces a "fellBackToSystem" flag so the
    /// view can show "Premium unavailable — using system voice" without
    /// silencing audio mid-cook.
    ///
    /// Special-case: `voiceId == "system"` skips /api/tts entirely and
    /// reads via AVSpeechSynthesizer. Lets users opt out of the OpenAI
    /// generation latency in exchange for system-voice quality.
    func speak(step: String, ctx: TTSContext) {
        stop()
        let myTicket = (ticket &+ 1)
        ticket = myTicket
        let stepIdx = ctx.stepIndex

        // System-voice path — no API, no prefetch, no spinner.
        if ctx.voiceId == CookingPlayer.systemVoiceId {
            speakFree(text: step, stepIndex: stepIdx, fellBack: false)
            return
        }

        let key = PrefetchKey(stepIndex: stepIdx, voiceId: ctx.voiceId, version: ctx.instructionsVersion)

        // Hot path: prefetch resolved this step already. Skip the loading
        // phase entirely so progress dots and Next taps fire audio without
        // a "Generating voice…" flash.
        if let cached = resolvedURLs[key] {
            playMP3(at: cached, stepIndex: stepIdx)
            return
        }

        phase = .loading(stepIndex: stepIdx, since: Date(), fellBackToSystem: false)
        let pendingTask = pendingFetches[key]
        Task {
            do {
                let url: URL
                if let pendingTask {
                    url = try await pendingTask.value
                } else {
                    let task = Task { try await fetchURL(for: ctx) }
                    pendingFetches[key] = task
                    url = try await task.value
                    resolvedURLs[key] = url
                    pendingFetches[key] = nil
                }
                if myTicket != ticket { return }    // user moved on
                playMP3(at: url, stepIndex: stepIdx)
            } catch {
                if myTicket != ticket { return }
                // Auto-fall-back so audio always lands. Phase stays
                // .loading-with-fellBackToSystem briefly, flips to .playing
                // once the system synthesizer kicks in. The view then shows
                // "Premium unavailable — using system voice. Tap to retry."
                speakFree(text: step, stepIndex: stepIdx, fellBack: true)
            }
        }
    }

    /// Re-issue the audio fetch for the *current* step. Wired to the inline
    /// "Retry" button on the loading-too-long banner and the "Tap to retry"
    /// link on the failed/fell-back banner. The view passes the same step
    /// + ctx the original speak() saw.
    func retry(step: String, ctx: TTSContext) {
        // Drop any cached fallback so we genuinely re-fetch — the previous
        // attempt may have stashed a failure-shaped value.
        let key = PrefetchKey(stepIndex: ctx.stepIndex, voiceId: ctx.voiceId, version: ctx.instructionsVersion)
        pendingFetches[key]?.cancel()
        pendingFetches[key] = nil
        speak(step: step, ctx: ctx)
    }

    private func fetchURL(for ctx: TTSContext) async throws -> URL {
        let resp = try await TTSService.fetchRecipeAudio(
            recipeId: ctx.recipeId,
            stepIndex: ctx.stepIndex,
            servings: ctx.servings,
            voiceId: ctx.voiceId,
            instructionsVersion: ctx.instructionsVersion
        )
        return resp.url
    }

    /// Eagerly fetches every step's audio in the background, capped at
    /// `prefetchConcurrency` simultaneous requests. Idempotent: skips
    /// steps that are already resolved or currently in flight, so a
    /// rapid voice toggle (off → on) replays cleanly.
    ///
    /// Errors from individual prefetches are swallowed — `speak` will
    /// retry on demand if the user reaches that step. A failed prefetch
    /// shouldn't surface mid-cook.
    func prefetchAll(steps: [String], ctxFor: @escaping (Int) -> TTSContext) {
        guard !steps.isEmpty else { return }
        // System voice doesn't hit /api/tts at all — no point spending
        // bandwidth or cycles prefetching for it. Caller is also expected
        // to skip this method when voice is "system", but we double-gate
        // here so the no-op case is safe.
        if let firstCtx = steps.indices.first.map({ ctxFor($0) }),
           firstCtx.voiceId == CookingPlayer.systemVoiceId {
            prefetchProgress = .init(resolved: 0, total: 0)
            return
        }
        let indices = Array(steps.indices)
        // Reset the visible counter. If a prior pass already resolved
        // some keys (e.g. user toggled voice off then back on), we still
        // count them as "done" against the new total since markResolved
        // increments resolved on every completion regardless of whether
        // it was a hit or miss.
        var alreadyDone = 0
        let firstCtxKey = ctxFor(indices[0])
        for stepIdx in indices {
            let ctx = ctxFor(stepIdx)
            let key = PrefetchKey(stepIndex: stepIdx, voiceId: ctx.voiceId, version: ctx.instructionsVersion)
            if resolvedURLs[key] != nil { alreadyDone += 1 }
        }
        prefetchProgress = .init(resolved: alreadyDone, total: indices.count)
        _ = firstCtxKey  // suppress unused warning for the early-bail context

        Task {
            await withTaskGroup(of: Void.self) { group in
                var idx = 0
                var inFlight = 0
                while idx < indices.count {
                    if inFlight >= prefetchConcurrency {
                        await group.next()  // wait for one slot
                        inFlight -= 1
                    }
                    let stepIndex = indices[idx]
                    let ctx = ctxFor(stepIndex)
                    let key = PrefetchKey(stepIndex: stepIndex, voiceId: ctx.voiceId, version: ctx.instructionsVersion)
                    if resolvedURLs[key] != nil {
                        // Already cached. progress already counted above.
                        idx += 1
                        continue
                    }
                    if let _ = pendingFetches[key] {
                        // Already in flight from a prior call — let it
                        // finish; we'll observe the count via markResolved.
                        idx += 1
                        continue
                    }
                    let task = Task { try await self.fetchURL(for: ctx) }
                    pendingFetches[key] = task
                    inFlight += 1
                    group.addTask { [weak self] in
                        do {
                            let url = try await task.value
                            await self?.markResolved(key: key, url: url, succeeded: true)
                        } catch {
                            await self?.markResolved(key: key, url: nil, succeeded: false)
                        }
                    }
                    idx += 1
                }
                for await _ in group {}
            }
        }
    }

    private func markResolved(key: PrefetchKey, url: URL?, succeeded: Bool) {
        if let url, succeeded { resolvedURLs[key] = url }
        pendingFetches[key] = nil
        // Progress counts both successes and failures as "done" so the
        // top-of-screen badge can disappear once the prefetch pass settles
        // — even if a couple of steps failed, the user can still try them
        // on demand and see the per-step error UI.
        prefetchProgress.resolved = min(prefetchProgress.resolved + 1, prefetchProgress.total)
    }

    /// Drop every cached/pending entry for an old voice or version. Called
    /// when the user picks a different voice mid-recipe — the new voice
    /// has a different cache key, so re-prefetching from scratch is the
    /// right move.
    func invalidatePrefetch(except keepingVoiceId: String? = nil, version: Int? = nil) {
        if let v = keepingVoiceId, let ver = version {
            resolvedURLs = resolvedURLs.filter { $0.key.voiceId == v && $0.key.version == ver }
            for (k, task) in pendingFetches where !(k.voiceId == v && k.version == ver) {
                task.cancel()
                pendingFetches[k] = nil
            }
        } else {
            for (_, task) in pendingFetches { task.cancel() }
            resolvedURLs.removeAll()
            pendingFetches.removeAll()
        }
    }

    private func playMP3(at url: URL, stepIndex: Int) {
        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        p.allowsExternalPlayback = false
        // Tear down any prior end-of-playback observer before swapping in
        // the new item, otherwise we'd accumulate observers across steps.
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if case .playing(let idx) = self.phase, idx == stepIndex {
                    self.phase = .idle
                }
            }
        }
        player = p
        isPaused = false
        try? AVAudioSession.sharedInstance().setActive(true, options: [])
        p.play()
        phase = .playing(stepIndex: stepIndex)
    }

    private func speakFree(text: String, stepIndex: Int, fellBack: Bool) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
        utterance.pitchMultiplier = 1.0
        utterance.volume = 1.0
        if cachedFreeVoice == nil {
            cachedFreeVoice = pickBestVoice()
        }
        if let v = cachedFreeVoice { utterance.voice = v }
        try? AVAudioSession.sharedInstance().setActive(true, options: [])
        synthesizer.speak(utterance)
        isPaused = false
        // Two phase semantics here:
        //   • fellBack=false (system voice as primary choice) → straight to
        //     .playing. No banner needed.
        //   • fellBack=true (premium failed → auto-fallback) → .loading w/
        //     fellBackToSystem flag so the view can show "Premium
        //     unavailable — using system voice. Tap to retry." while the
        //     audio plays. The view auto-clears this when the user advances.
        phase = fellBack
            ? .loading(stepIndex: stepIndex, since: Date(), fellBackToSystem: true)
            : .playing(stepIndex: stepIndex)
    }

    /// Heuristic best-voice picker for the on-device fallback path. Mirrors
    /// the web's `pickBestVoice` — prefer Apple Enhanced/Premium voices in
    /// English, avoid the legacy joke voices.
    private func pickBestVoice() -> AVSpeechSynthesisVoice? {
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let english = voices.filter { $0.language.hasPrefix("en") }
        let pool = english.isEmpty ? voices : english
        let scored = pool.map { v -> (AVSpeechSynthesisVoice, Int) in
            var score = 0
            let n = v.name.lowercased()
            let goodNames = ["samantha", "ava", "allison", "karen", "moira", "tessa", "susan", "victoria", "serena", "kate", "fiona", "nicky", "siri"]
            let badNames = ["daniel", "fred", "albert", "bahh", "bells", "boing", "bubbles", "cellos", "deranged", "good news", "hysterical", "pipe organ", "trinoids", "whisper", "zarvox"]
            if goodNames.contains(where: { n.contains($0) }) { score += 500 }
            if badNames.contains(where: { n.contains($0) }) { score -= 200 }
            if v.quality == .premium { score += 250 }
            else if v.quality == .enhanced { score += 200 }
            if v.language == "en-US" { score += 50 }
            else if v.language.hasPrefix("en") { score += 20 }
            return (v, score)
        }
        return scored.sorted { $0.1 > $1.1 }.first?.0
    }

    /// Sentinel voice id for "use AVSpeechSynthesizer system voice" — chosen
    /// by the user from VoicePickerSheet to opt out of the OpenAI generation
    /// latency. Keeps the same UserDefaults key the premium ids use so the
    /// picker → player wiring stays simple.
    static let systemVoiceId = "system"

    func pause() {
        if let p = player, p.timeControlStatus == .playing {
            p.pause()
            isPaused = true
        } else if synthesizer.isSpeaking {
            synthesizer.pauseSpeaking(at: .immediate)
            isPaused = true
        }
    }

    func resume() {
        if let p = player, p.timeControlStatus != .playing, p.currentItem != nil {
            p.play()
            isPaused = false
        } else if synthesizer.isPaused {
            synthesizer.continueSpeaking()
            isPaused = false
        }
    }

    func stop() {
        ticket &+= 1
        player?.pause()
        player = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        isPaused = false
        // Don't clear `phase` here — the caller (speak / view) will set it
        // to its next value (.loading / .playing / .idle). Resetting to
        // .idle in stop() would briefly flicker the UI between states.
    }

    /// Reset the published phase back to idle. Called by the view when the
    /// user dismisses an error/fellBack banner explicitly so the banner
    /// doesn't linger after they advance to the next step.
    func clearPhase() {
        phase = .idle
    }

    // MARK: - Persistence (matches web localStorage keys where they exist)

    /// Premium-voice subselection (Nova / Shimmer / etc). Falls back to
    /// Nova when nothing is saved or the saved value is unknown — matches
    /// the web's PREMIUM_VOICES default.
    static func savedPremiumVoiceId() -> String {
        if let stored = UserDefaults.standard.string(forKey: "macrolens_voice_name"),
           TTSService.voiceIds.contains(stored) {
            return stored
        }
        return "nova"
    }

    static func persistPremiumVoiceId(_ id: String) {
        UserDefaults.standard.set(id, forKey: "macrolens_voice_name")
        UserDefaults.standard.set("1", forKey: "macrolens_voice_premium")
    }

    /// Premium AI vs System voice — chosen via the first-time picker when
    /// the user enables voice. Persisted so subsequent toggles don't ask
    /// again. nil means "user hasn't picked yet"; the speaker tap routes
    /// through the picker rather than enabling immediately.
    enum VoiceKind: String { case premium, system }

    static func savedVoiceKind() -> VoiceKind? {
        if let raw = UserDefaults.standard.string(forKey: "macrolens_voice_kind"),
           let kind = VoiceKind(rawValue: raw) {
            return kind
        }
        return nil
    }

    static func persistVoiceKind(_ kind: VoiceKind) {
        UserDefaults.standard.set(kind.rawValue, forKey: "macrolens_voice_kind")
    }
}

/// Cache key for the per-step audio map. Combines stepIndex, voice and
/// instructions_version so a voice change or recipe edit can't accidentally
/// surface the wrong audio. Servings are intentionally not part of the key
/// here — the cooking mode reads each step at the recipe's own servings, so
/// step index uniquely determines which audio applies for a given recipe
/// session.
private struct PrefetchKey: Hashable {
    let stepIndex: Int
    let voiceId: String
    let version: Int
}

/// Two-tier voice picker: Premium AI vs System voice at the top, plus
/// the OpenAI premium-voice subpicker (Nova / Shimmer / etc) shown only
/// when Premium is selected. Long-press on the cooking-mode speaker pill
/// opens this sheet.
///
/// onChange is called with `(newKind, newPremiumId?)` — newPremiumId is
/// non-nil only when the user picked a different premium voice in this
/// session, so the caller can decide whether to invalidate the prefetch
/// cache (which is keyed by voice id).
struct VoicePickerSheet: View {
    let currentKind: CookingPlayer.VoiceKind
    @Binding var currentPremiumId: String
    let onChange: (_ kind: CookingPlayer.VoiceKind, _ newPremiumId: String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var pickedKind: CookingPlayer.VoiceKind
    @State private var pickedPremiumId: String

    private let voices: [(id: String, label: String, desc: String)] = [
        ("nova",    "Nova",    "Warm, friendly · default premium"),
        ("shimmer", "Shimmer", "Soft, calm female"),
        ("alloy",   "Alloy",   "Neutral, balanced"),
        ("echo",    "Echo",    "Crisp male"),
        ("fable",   "Fable",   "Storyteller, British"),
        ("onyx",    "Onyx",    "Deep male"),
    ]

    init(currentKind: CookingPlayer.VoiceKind,
         currentPremiumId: Binding<String>,
         onChange: @escaping (CookingPlayer.VoiceKind, String?) -> Void) {
        self.currentKind = currentKind
        self._currentPremiumId = currentPremiumId
        self.onChange = onChange
        _pickedKind = State(initialValue: currentKind)
        _pickedPremiumId = State(initialValue: currentPremiumId.wrappedValue)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Voice mode")
                        .font(.system(size: 11, weight: .medium))
                        .tracking(1).textCase(.uppercase)
                        .foregroundStyle(Theme.text3)
                    kindRow(.premium,
                            title: "Premium AI voice",
                            subtitle: "Natural, expressive. Takes 10–15s to generate each new step (cached after).")
                    kindRow(.system,
                            title: "System voice",
                            subtitle: "Instant + works offline. Lower quality but no waiting.")
                    if pickedKind == .premium {
                        Text("Premium voice")
                            .font(.system(size: 11, weight: .medium))
                            .tracking(1).textCase(.uppercase)
                            .foregroundStyle(Theme.text3)
                            .padding(.top, 8)
                        ForEach(voices, id: \.id) { v in
                            premiumVoiceRow(v)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 28)
            }
            .background(Theme.bg)
            .navigationTitle("Cooking voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        let newPremium: String? = (pickedPremiumId != currentPremiumId) ? pickedPremiumId : nil
                        currentPremiumId = pickedPremiumId
                        onChange(pickedKind, newPremium)
                        dismiss()
                    }
                    .foregroundStyle(Theme.accent)
                    .bold()
                }
            }
        }
    }

    private func kindRow(_ kind: CookingPlayer.VoiceKind, title: String, subtitle: String) -> some View {
        let isActive = pickedKind == kind
        return Button { pickedKind = kind } label: {
            HStack(spacing: 10) {
                Image(systemName: isActive ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(isActive ? Theme.accent : Theme.border2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.text)
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(isActive ? Theme.accent.opacity(0.10) : Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(isActive ? Theme.accent.opacity(0.4) : Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func premiumVoiceRow(_ v: (id: String, label: String, desc: String)) -> some View {
        let isActive = pickedPremiumId == v.id
        return Button { pickedPremiumId = v.id } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(v.label)
                            .font(.system(size: 14, weight: isActive ? .semibold : .medium))
                            .foregroundStyle(Theme.text)
                        if isActive {
                            Image(systemName: "checkmark")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.accent)
                        }
                    }
                    Text(v.desc).font(.system(size: 11)).foregroundStyle(Theme.text3)
                }
                Spacer()
                Text("★★★").font(.system(size: 11)).foregroundStyle(Theme.accent)
            }
            .padding(12)
            .background(isActive ? Theme.accent.opacity(0.10) : Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(isActive ? Theme.accent.opacity(0.4) : Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}
