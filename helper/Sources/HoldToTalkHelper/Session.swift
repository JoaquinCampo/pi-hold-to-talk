import Foundation

/// Runs the start → stop/cancel cycle for one utterance at a time.
///
/// Microphone callbacks arrive on an audio thread. They are funnelled through an `AsyncStream`
/// into a single pump task, so samples reach the buffer and the streaming model in order.
actor Session {
    /// Audio beyond this is dropped, so a stuck key cannot grow the buffer without bound.
    static let maxUtteranceSeconds = 600

    private struct Recording {
        let source: AudioSource
        let input: AsyncStream<[Float]>.Continuation
        /// Collects the utterance's audio and emits levels and partials. Returns the audio.
        let pump: Task<[Float], Never>
    }

    private let transcriber: Transcriber
    private let events: EventWriter
    private let makeSource: @Sendable () throws -> AudioSource
    private var recording: Recording?

    init(transcriber: Transcriber, events: EventWriter, makeSource: @escaping @Sendable () throws -> AudioSource) {
        self.transcriber = transcriber
        self.events = events
        self.makeSource = makeSource
    }

    func handle(_ command: Command) async {
        switch command {
        case .start: await start()
        case .stop: await stop()
        case .cancel: await cancel()
        case .quit: await shutdown()
        }
    }

    /// Closes the microphone and drops any utterance in progress.
    func shutdown() async {
        guard let recording = takeRecording() else { return }
        recording.pump.cancel()
        _ = await recording.pump.value
    }

    private func start() async {
        guard recording == nil else {
            return events.emit(.error(code: .invalidState, message: "Already listening.", fatal: false))
        }
        let source: AudioSource
        do {
            source = try makeSource()
        } catch {
            return events.emit(.error(code: .microphoneUnavailable, message: "\(error)", fatal: false))
        }

        // Open the microphone first: people start talking right away, and the stream buffers
        // whatever arrives while the streaming model resets.
        let (stream, input) = AsyncStream.makeStream(of: [Float].self)
        do {
            try await source.start { input.yield($0) }
        } catch {
            input.finish()
            let code: ErrorCode = if case AudioSourceError.microphoneDenied = error { .microphoneDenied } else { .microphoneUnavailable }
            return events.emit(.error(code: code, message: "\(error)", fatal: false))
        }
        await transcriber.begin()
        recording = Recording(source: source, input: input, pump: pump(stream))
        events.emit(.listening)
    }

    private func stop() async {
        guard let recording = takeRecording() else {
            return events.emit(.error(code: .invalidState, message: "Not listening.", fatal: false))
        }
        await transcriber.endPartials()
        let audio = await recording.pump.value

        let clock = ContinuousClock()
        let began = clock.now
        do {
            let text = try await transcriber.transcribe(audio)
            events.emit(.final(text: text, audioMs: audio.count * 1000 / sampleRate, transcribeMs: (clock.now - began).milliseconds))
        } catch {
            events.emit(.error(code: .transcription, message: "\(error)", fatal: false))
        }
    }

    /// Always answers `cancelled`, even when idle, so the extension can cancel without tracking state.
    private func cancel() async {
        await shutdown()
        events.emit(.cancelled)
    }

    /// Detaches the current recording and closes its microphone. The pump drains what was queued.
    private func takeRecording() -> Recording? {
        guard let recording else { return nil }
        self.recording = nil
        recording.source.stop()
        recording.input.finish()
        return recording
    }

    private func pump(_ stream: AsyncStream<[Float]>) -> Task<[Float], Never> {
        Task { [transcriber, events] in
            let limit = Self.maxUtteranceSeconds * sampleRate
            var audio: [Float] = []
            var meter = LevelMeter()
            for await chunk in stream {
                if Task.isCancelled { continue }
                audio.append(contentsOf: chunk.prefix(limit - audio.count))
                if let level = meter.update(chunk) { events.emit(.level(level)) }
                do {
                    if let text = try await transcriber.partial(after: chunk) { events.emit(.partial(text)) }
                } catch {
                    // Partials are a preview; the final pass does not depend on them.
                    log("partial transcription failed: \(error)")
                }
            }
            return audio
        }
    }
}

/// Turns audio chunks into a throttled 0...1 loudness value for a level meter.
struct LevelMeter {
    static let interval = Duration.milliseconds(90)
    static let floorDb = -60.0

    private let clock = ContinuousClock()
    private var lastEmit: ContinuousClock.Instant?

    /// Returns a level when one is due, nil when throttled.
    mutating func update(_ samples: [Float]) -> Double? {
        let now = clock.now
        if let lastEmit, now - lastEmit < Self.interval { return nil }
        lastEmit = now
        return Self.level(of: samples)
    }

    static func level(of samples: [Float]) -> Double {
        guard !samples.isEmpty else { return 0 }
        let meanSquare = samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(samples.count)
        guard meanSquare > 0 else { return 0 }
        let db = 10 * log10(meanSquare)
        return min(1, max(0, (db - floorDb) / -floorDb))
    }
}

extension Duration {
    var milliseconds: Int {
        let (seconds, attoseconds) = components
        return Int(seconds) * 1000 + Int(attoseconds / 1_000_000_000_000_000)
    }
}

/// Diagnostics go to stderr; stdout carries only protocol events.
func log(_ message: String) {
    FileHandle.standardError.write(Data("pi-hold-to-talk-helper: \(message)\n".utf8))
}
