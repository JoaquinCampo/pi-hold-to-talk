@preconcurrency import AVFoundation
import FluidAudio

/// 16 kHz mono Float32, the format every FluidAudio speech model expects.
let sampleRate = 16_000

typealias SampleHandler = @Sendable ([Float]) -> Void

/// Something that produces 16 kHz mono audio between `start` and `stop`.
protocol AudioSource: AnyObject, Sendable {
    func start(_ onSamples: @escaping SampleHandler) async throws
    func stop()
}

enum AudioSourceError: Error, CustomStringConvertible {
    case microphoneDenied
    case microphoneUnavailable(String)

    var description: String {
        switch self {
        case .microphoneDenied:
            return "Microphone access is denied. Allow your terminal app in System Settings > Privacy & Security > Microphone."
        case let .microphoneUnavailable(reason):
            return "Microphone unavailable: \(reason)"
        }
    }
}

/// The default input device, resampled to 16 kHz mono.
final class MicrophoneSource: AudioSource, @unchecked Sendable {
    // AVAudioEngine is not Sendable; it is only touched from start/stop, which the Session serialises.
    private let engine = AVAudioEngine()
    private let converter = AudioConverter()
    private var running = false

    func start(_ onSamples: @escaping SampleHandler) async throws {
        try await Self.requireAccess()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw AudioSourceError.microphoneUnavailable("no input device")
        }
        let converter = self.converter
        // About 100 ms per callback: frequent enough for a live level meter, cheap to resample.
        let frames = AVAudioFrameCount(format.sampleRate / 10)
        input.installTap(onBus: 0, bufferSize: frames, format: format) { buffer, _ in
            if let samples = try? converter.resampleBuffer(buffer), !samples.isEmpty {
                onSamples(samples)
            }
        }
        do {
            engine.prepare()
            try engine.start()
            running = true
        } catch {
            input.removeTap(onBus: 0)
            throw AudioSourceError.microphoneUnavailable(error.localizedDescription)
        }
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
    }

    private static func requireAccess() async throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return
        case .notDetermined:
            if await AVCaptureDevice.requestAccess(for: .audio) { return }
            throw AudioSourceError.microphoneDenied
        default:
            throw AudioSourceError.microphoneDenied
        }
    }
}

/// Replays an audio file at real-time pace, standing in for the microphone in tests.
final class FileReplaySource: AudioSource, @unchecked Sendable {
    private let samples: [Float]
    private let lock = NSLock()
    private var feeder: Task<Void, Never>?

    init(url: URL) throws {
        samples = try AudioConverter().resampleAudioFile(url)
    }

    func start(_ onSamples: @escaping SampleHandler) async throws {
        let samples = self.samples
        let chunk = sampleRate / 10
        let task = Task {
            var offset = 0
            while offset < samples.count, !Task.isCancelled {
                let end = min(offset + chunk, samples.count)
                onSamples(Array(samples[offset..<end]))
                offset = end
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        lock.withLock { feeder = task }
    }

    func stop() {
        lock.withLock {
            feeder?.cancel()
            feeder = nil
        }
    }
}
