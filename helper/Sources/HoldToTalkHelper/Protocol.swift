import Foundation

/// Version of the JSON-lines protocol spoken over stdin/stdout. Bump on breaking changes;
/// the extension refuses to talk to a helper whose version it does not know.
let protocolVersion = 1

/// A request from the extension, one JSON object per stdin line.
enum Command: Decodable, Equatable {
    /// Open the microphone and start transcribing.
    case start
    /// Close the microphone and produce the final transcript.
    case stop
    /// Close the microphone and drop everything captured.
    case cancel
    /// Exit cleanly.
    case quit

    private enum CodingKeys: String, CodingKey { case type }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "start": self = .start
        case "stop": self = .stop
        case "cancel": self = .cancel
        case "quit": self = .quit
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "Unknown command \"\(type)\"")
        }
    }
}

/// Machine-readable error categories, so the extension can react without parsing messages.
enum ErrorCode: String, Encodable {
    /// A stdin line that is not a known command.
    case badCommand = "bad_command"
    /// A command that does not fit the current state, such as `stop` while not listening.
    case invalidState = "invalid_state"
    case microphoneDenied = "microphone_denied"
    case microphoneUnavailable = "microphone_unavailable"
    /// A model failed to download or load. Fatal for the final model, not for the streaming one.
    case modelLoad = "model_load"
    case transcription
}

/// A notification to the extension, one JSON object per stdout line.
enum Event: Encodable {
    /// A model is being downloaded or compiled. `fraction` is in [0, 1].
    case loading(model: String, fraction: Double)
    /// Models are loaded. `streaming` is false when live partials are unavailable.
    case ready(streaming: Bool)
    /// The microphone is open.
    case listening
    /// Input loudness in [0, 1], mapped from -60 to 0 dBFS. Roughly ten updates a second.
    case level(Double)
    /// Live text for the audio so far. Each partial replaces the previous one.
    case partial(String)
    /// The definitive transcript for the utterance. Empty when nothing was said.
    case final(text: String, audioMs: Int, transcribeMs: Int)
    /// The utterance was dropped after a `cancel`.
    case cancelled
    /// Something went wrong. After a fatal error the helper exits.
    case error(code: ErrorCode, message: String, fatal: Bool)

    private enum CodingKeys: String, CodingKey {
        case type, model, fraction, protocolVersion, streaming, level, text, audioMs, transcribeMs, code, message, fatal
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .loading(model, fraction):
            try container.encode("loading", forKey: .type)
            try container.encode(model, forKey: .model)
            try container.encode(fraction, forKey: .fraction)
        case let .ready(streaming):
            try container.encode("ready", forKey: .type)
            try container.encode(protocolVersion, forKey: .protocolVersion)
            try container.encode(streaming, forKey: .streaming)
        case .listening:
            try container.encode("listening", forKey: .type)
        case let .level(level):
            try container.encode("level", forKey: .type)
            try container.encode(level, forKey: .level)
        case let .partial(text):
            try container.encode("partial", forKey: .type)
            try container.encode(text, forKey: .text)
        case let .final(text, audioMs, transcribeMs):
            try container.encode("final", forKey: .type)
            try container.encode(text, forKey: .text)
            try container.encode(audioMs, forKey: .audioMs)
            try container.encode(transcribeMs, forKey: .transcribeMs)
        case .cancelled:
            try container.encode("cancelled", forKey: .type)
        case let .error(code, message, fatal):
            try container.encode("error", forKey: .type)
            try container.encode(code, forKey: .code)
            try container.encode(message, forKey: .message)
            try container.encode(fatal, forKey: .fatal)
        }
    }
}

/// Writes events to stdout as single lines. Serialised so concurrent emitters never interleave.
final class EventWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    func emit(_ event: Event) {
        guard var line = try? encoder.encode(event) else { return }
        line.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(line)
    }
}
