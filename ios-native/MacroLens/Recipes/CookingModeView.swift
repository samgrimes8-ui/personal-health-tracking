import SwiftUI
import AVFoundation
import AVFAudio

/// Full-screen cooking mode. Steps the user through each instruction with
/// Next/Back/Repeat/Pause controls, reading aloud either via OpenAI premium
/// TTS (cached server-side per recipe/step/servings/voice/version) or
/// AVSpeechSynthesizer as a silent-mode-or-network-fail fallback. Mirrors
/// `openCookingMode` + `renderCookingMode` in src/pages/app.js.
///
/// Voice selection persists in UserDefaults under `macrolens_voice_name`,
/// matching the localStorage key the web uses. Voice-off (silent) mode
/// persists too — users with a quiet kitchen can step through without
/// audio while still getting the visual prompts.
struct CookingModeView: View {
    let recipe: RecipeFull

    @Environment(\.dismiss) private var dismiss
    @StateObject private var player = CookingPlayer()

    @State private var stepIndex: Int = 0
    @State private var voiceId: String = CookingPlayer.savedVoiceId()
    @State private var voiceOff: Bool = CookingPlayer.savedVoiceOff()
    @State private var voicePickerOpen: Bool = false

    private var steps: [String] { recipe.instructions?.steps ?? [] }
    private var servings: Double { recipe.servings ?? 1 }
    private var instructionsVersion: Int { recipe.instructions_version ?? 1 }

    var body: some View {
        ZStack(alignment: .top) {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 18) {
                header
                voiceControls
                progressDots
                stepCard
                if let tips = recipe.instructions?.tips, !tips.isEmpty, !tips.allSatisfy({ $0.isEmpty }) {
                    tipsBlock(tips)
                }
                Spacer(minLength: 0)
                controls
            }
            .padding(.horizontal, 18)
            .padding(.top, 24)
            .padding(.bottom, 18)
        }
        .onAppear {
            // Speak the first step on appear so the user knows audio is
            // wired (web does this in the same gesture as the modal open).
            speakCurrent()
            // Eagerly prefetch every step's audio in the background so
            // tapping Next / a progress dot plays instantly instead of
            // pausing on a network round-trip mid-cook. Concurrency is
            // capped inside CookingPlayer.prefetchAll.
            scheduleFullPrefetch()
        }
        .onDisappear {
            player.stop()
        }
        .sheet(isPresented: $voicePickerOpen) {
            VoicePickerSheet(current: $voiceId) { newVoice in
                voiceId = newVoice
                CookingPlayer.persistVoiceId(newVoice)
                player.cachedFreeVoice = nil
                // Old-voice MP3s are useless under the new voice id, drop
                // them and re-prefetch with the chosen voice.
                player.invalidatePrefetch()
                speakCurrent()
                scheduleFullPrefetch()
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

    private var voiceControls: some View {
        HStack(spacing: 8) {
            Button {
                guard !voiceOff else { return }
                voicePickerOpen = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "person.wave.2.fill").font(.system(size: 11))
                    Text("✨ \(displayVoiceName)")
                        .font(.system(size: 11))
                        .lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9)).opacity(0.6)
                }
                .foregroundStyle(Theme.text3)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Theme.bg3, in: .rect(cornerRadius: 999))
                .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.border, lineWidth: 1))
                .opacity(voiceOff ? 0.4 : 1)
            }
            .buttonStyle(.plain)
            .disabled(voiceOff)

            Button {
                voiceOff.toggle()
                CookingPlayer.persistVoiceOff(voiceOff)
                if voiceOff {
                    player.stop()
                } else {
                    // Re-arm the prefetch pass too so subsequent steps
                    // play instantly instead of pausing on a network hop.
                    speakCurrent()
                    scheduleFullPrefetch()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: voiceOff ? "speaker.slash.fill" : "speaker.wave.1.fill")
                        .font(.system(size: 11))
                    Text(voiceOff ? "Voice off" : "Voice on")
                        .font(.system(size: 11, weight: voiceOff ? .semibold : .regular))
                }
                .foregroundStyle(voiceOff ? Theme.accentFG : Theme.text3)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(voiceOff ? Theme.accent : Theme.bg3, in: .rect(cornerRadius: 999))
                .overlay(RoundedRectangle(cornerRadius: 999).stroke(voiceOff ? Theme.accent : Theme.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
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
                HStack(spacing: 8) {
                    Text("Step \(stepIndex + 1) of \(steps.count)")
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(1.0).textCase(.uppercase)
                        .foregroundStyle(Theme.accent)
                    // Surfaces only when the *current* step's audio is still
                    // resolving. Background prefetches for non-current steps
                    // never flip player.loading, so this stays quiet during
                    // the eager-fetch pass.
                    if player.loading {
                        HStack(spacing: 4) {
                            ProgressView().controlSize(.mini).tint(Theme.text3)
                            Text("Loading voice…")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.text3)
                        }
                        .transition(.opacity)
                    }
                }
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
            if !voiceOff {
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
        switch voiceId {
        case "nova":    return "Nova"
        case "shimmer": return "Shimmer"
        case "alloy":   return "Alloy"
        case "echo":    return "Echo"
        case "fable":   return "Fable"
        case "onyx":    return "Onyx"
        default:        return voiceId.capitalized
        }
    }

    /// Speak the step at `stepIndex`. Premium path → /api/tts → AVPlayer.
    /// Free fallback (network fail / voiceOff transitions) → AVSpeechSynthesizer.
    private func speakCurrent() {
        guard !voiceOff, !steps.isEmpty else {
            player.stop()
            return
        }
        let step = steps[stepIndex]
        let ctx = ttsContext(for: stepIndex)
        player.speak(step: step, ctx: ctx)
    }

    /// Kick off background prefetch for every step. Skipped when voice is off
    /// (we don't want to spend AI Bucks for audio the user is choosing not
    /// to hear).
    private func scheduleFullPrefetch() {
        guard !voiceOff, !steps.isEmpty else { return }
        player.prefetchAll(steps: steps) { idx in
            ttsContext(for: idx)
        }
    }

    private func ttsContext(for idx: Int) -> TTSContext {
        TTSContext(
            recipeId: recipe.id,
            stepIndex: idx,
            servings: Double(round(servings * 100) / 100),
            voiceId: voiceId,
            instructionsVersion: instructionsVersion
        )
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
    @Published private(set) var isPaused: Bool = false
    /// True only when the *current* step is awaiting its first byte. Background
    /// prefetches for non-current steps stay invisible — the user shouldn't
    /// feel a "loading" badge for audio they're not about to hear.
    @Published private(set) var loading: Bool = false

    private var player: AVPlayer?
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
    /// than a duplicated request). Network failure for any reason falls
    /// back to AVSpeechUtterance so the user always hears something.
    func speak(step: String, ctx: TTSContext) {
        stop()
        let myTicket = (ticket &+ 1)
        ticket = myTicket
        let key = PrefetchKey(stepIndex: ctx.stepIndex, voiceId: ctx.voiceId, version: ctx.instructionsVersion)

        // Hot path: prefetch resolved this step already. No spinner flash.
        if let cached = resolvedURLs[key] {
            playMP3(at: cached)
            return
        }

        loading = true
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
                playMP3(at: url)
            } catch {
                if myTicket != ticket { return }
                speakFree(text: step)
            }
            if myTicket == ticket { loading = false }
        }
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
        let indices = Array(steps.indices)
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
                    if resolvedURLs[key] != nil || pendingFetches[key] != nil {
                        idx += 1
                        continue   // already done or in flight, skip without consuming a slot
                    }
                    let task = Task { try await self.fetchURL(for: ctx) }
                    pendingFetches[key] = task
                    inFlight += 1
                    group.addTask { [weak self] in
                        do {
                            let url = try await task.value
                            await self?.markResolved(key: key, url: url)
                        } catch {
                            await self?.dropPending(key: key)
                        }
                    }
                    idx += 1
                }
                // Drain remaining
                for await _ in group {}
            }
        }
    }

    private func markResolved(key: PrefetchKey, url: URL) {
        resolvedURLs[key] = url
        pendingFetches[key] = nil
    }

    private func dropPending(key: PrefetchKey) {
        pendingFetches[key] = nil
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

    private func playMP3(at url: URL) {
        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        p.allowsExternalPlayback = false
        player = p
        isPaused = false
        try? AVAudioSession.sharedInstance().setActive(true, options: [])
        p.play()
    }

    private func speakFree(text: String) {
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
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        isPaused = false
        loading = false
    }

    // MARK: - Persistence (matches web localStorage keys)

    static func savedVoiceId() -> String {
        if let stored = UserDefaults.standard.string(forKey: "macrolens_voice_name"),
           TTSService.voiceIds.contains(stored) {
            return stored
        }
        return "nova"
    }

    static func persistVoiceId(_ id: String) {
        UserDefaults.standard.set(id, forKey: "macrolens_voice_name")
        UserDefaults.standard.set("1", forKey: "macrolens_voice_premium")
    }

    static func savedVoiceOff() -> Bool {
        UserDefaults.standard.string(forKey: "macrolens_voice_off") == "1"
    }

    static func persistVoiceOff(_ off: Bool) {
        UserDefaults.standard.set(off ? "1" : "0", forKey: "macrolens_voice_off")
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

/// Voice picker — premium voices only. Mirrors the picker in
/// `openVoicePicker` (src/pages/app.js): tap to preview/select, confirm
/// with Done. Silent / device-fallback voices aren't user-selectable on
/// either platform.
struct VoicePickerSheet: View {
    @Binding var current: String
    let onSelect: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    private let voices: [(id: String, label: String, desc: String)] = [
        ("nova",    "Nova",    "Warm, friendly · default premium"),
        ("shimmer", "Shimmer", "Soft, calm female"),
        ("alloy",   "Alloy",   "Neutral, balanced"),
        ("echo",    "Echo",    "Crisp male"),
        ("fable",   "Fable",   "Storyteller, British"),
        ("onyx",    "Onyx",    "Deep male"),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 8) {
                    Text("Tap any voice to preview. First read of each step uses AI Bucks; replays are free.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, 6)
                    ForEach(voices, id: \.id) { v in
                        let isActive = current == v.id
                        Button {
                            current = v.id
                            onSelect(v.id)
                        } label: {
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
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 28)
            }
            .background(Theme.bg)
            .navigationTitle("Choose a voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(Theme.accent)
                }
            }
        }
    }
}
