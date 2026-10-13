import FluidAudio
import Foundation
import Synchronization

/// What to load and how to decode.
struct TranscriberOptions: Sendable {
    /// "auto", or a language code such as "en", "es" or "pt-BR".
    var language = "auto"
    /// Streaming chunk size in milliseconds: 560, 1120, 2240 or 4480. Smaller is livelier.
    var chunkMs = 560
    /// Whether to load the streaming model for live partials at all.
    var streaming = true

    /// Language hint for the final pass, or nil to let the model detect it.
    var finalLanguage: Language? {
        guard language != "auto" else { return nil }
        let bare = language.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init)
        return bare.flatMap { Language(rawValue: $0.lowercased()) }
    }
}

/// Reports model loading as `(model, fraction)`.
typealias LoadProgress = @Sendable (String, Double) -> Void

/// FluidAudio reports progress per file, so the fraction restarts for every file of a model.
/// This forwards only forward movement of at least a percent, plus completion, per model.
final class MonotonicProgress: Sendable {
    private let forward: LoadProgress
    private let reported = Mutex<[String: Double]>([:])

    init(_ forward: @escaping LoadProgress) {
        self.forward = forward
    }

    func report(_ model: String, _ fraction: Double) {
        let advanced = reported.withLock { reported in
            let last = reported[model] ?? -1
            guard fraction >= last + 0.01 || (fraction >= 1 && last < 1) else { return false }
            reported[model] = fraction
            return true
        }
        if advanced { forward(model, min(1, fraction)) }
    }
}

/// Two models with separate jobs:
/// - Nemotron 3.5 streaming turns audio into live partials while the key is held. Cheap, a little rough.
/// - Parakeet Ultra transcribes the whole utterance on release. This is the text that gets inserted.
actor Transcriber {
    static let streamingModel = "nemotron-3.5-streaming"
    static let finalModel = "parakeet-ultra"

    private let options: TranscriberOptions
    private let final: AsrManager
    private let streamer: StreamingNemotronMultilingualAsrManager?
    private var lastPartial = ""
    private var acceptingPartials = false

    /// Whether live partials are available. False when streaming is off or its model failed to load.
    nonisolated let streaming: Bool

    private init(options: TranscriberOptions, final: AsrManager, streamer: StreamingNemotronMultilingualAsrManager?) {
        self.options = options
        self.final = final
        self.streamer = streamer
        streaming = streamer != nil
    }

    /// Downloads (first run only) and loads both models in parallel.
    /// A streaming failure is reported through `onStreamingFailure` and leaves partials off;
    /// a failure of the final model is fatal and thrown.
    static func load(
        _ options: TranscriberOptions,
        progress: @escaping LoadProgress,
        onStreamingFailure: @escaping @Sendable (Error) -> Void
    ) async throws -> Transcriber {
        let progress = MonotonicProgress(progress).report
        async let streamer = options.streaming
            ? loadStreamer(options, progress: progress, onFailure: onStreamingFailure)
            : nil
        let models = try await AsrModels.downloadAndLoad(version: .ultra) { update in
            progress(finalModel, update.fractionCompleted)
        }
        let final = AsrManager()
        try await final.loadModels(models)
        return Transcriber(options: options, final: final, streamer: await streamer)
    }

    private static func loadStreamer(
        _ options: TranscriberOptions,
        progress: @escaping LoadProgress,
        onFailure: @Sendable (Error) -> Void
    ) async -> StreamingNemotronMultilingualAsrManager? {
        do {
            // The download picks a vocabulary: "latin" (en, es, fr, it, pt, de) or the larger
            // "multilingual" one. Auto-detect uses latin; partials are a preview, the final pass covers more.
            let variant = options.language == "auto" ? "en" : options.language
            let shared = try await StreamingNemotronMultilingualAsrManager.downloadAndPreloadShared(
                languageCode: variant, chunkMs: options.chunkMs
            ) { update in
                progress(streamingModel, update.fractionCompleted)
            }
            let streamer = StreamingNemotronMultilingualAsrManager()
            try await streamer.loadFromShared(shared)
            await streamer.setLanguage(options.language == "auto" ? nil : options.language)
            return streamer
        } catch {
            onFailure(error)
            return nil
        }
    }

    /// Prepares for a new utterance.
    func begin() async {
        lastPartial = ""
        acceptingPartials = streamer != nil
        await streamer?.reset()
    }

    /// Feeds audio to the streaming model. Returns the partial transcript when it changed.
    func partial(after samples: [Float]) async throws -> String? {
        guard acceptingPartials, let streamer else { return nil }
        _ = try await streamer.process(samples: samples)
        let text = await streamer.getPartialTranscript().trimmingCharacters(in: .whitespacesAndNewlines)
        guard text != lastPartial else { return nil }
        lastPartial = text
        return text
    }

    /// Stops producing partials, so audio still queued at release does not delay the final pass.
    func endPartials() {
        acceptingPartials = false
    }

    /// Transcribes a whole utterance. Returns "" when it is too short to hold speech.
    func transcribe(_ samples: [Float]) async throws -> String {
        guard samples.count >= ASRConstants.minimumRequiredSamples(forSampleRate: sampleRate) else { return "" }
        // A fresh decoder state per utterance: each dictation stands alone.
        var state = TdtDecoderState.make()
        let result = try await final.transcribe(samples, decoderState: &state, language: options.finalLanguage)
        return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
