import FluidAudio
import Foundation

let helperVersion = "0.1.0"

let usage = """
    Usage: pi-hold-to-talk-helper [command] [options]

    Commands:
      serve                 Speak the JSON-lines protocol on stdin/stdout (default).
      download              Download and compile the models, then exit.
      transcribe <file>     Print the transcript of an audio file.

    Options:
      --language <code>     "auto" (default) or a code such as en, es, pt-BR.
      --chunk-ms <ms>       Streaming chunk: 560 (default), 1120, 2240 or 4480.
      --no-streaming        Skip the streaming model; no live partials.
      --input <file>        serve: replay this file instead of the microphone.
      --version, --help
    """

struct Arguments {
    var command = "serve"
    var file: String?
    var input: String?
    var options = TranscriberOptions()

    init(_ arguments: ArraySlice<String>) throws {
        var rest = arguments
        func value(for flag: String) throws -> String {
            guard let value = rest.popFirst() else { throw UsageError("\(flag) needs a value") }
            return value
        }
        while let argument = rest.popFirst() {
            switch argument {
            case "serve", "download":
                command = argument
            case "transcribe":
                command = argument
                file = try value(for: argument)
            case "--language":
                options.language = try value(for: argument)
            case "--chunk-ms":
                let raw = try value(for: argument)
                guard let ms = Int(raw), [560, 1120, 2240, 4480].contains(ms) else {
                    throw UsageError("--chunk-ms must be 560, 1120, 2240 or 4480, not \(raw)")
                }
                options.chunkMs = ms
            case "--no-streaming":
                options.streaming = false
            case "--input":
                input = try value(for: argument)
            case "--version":
                command = "version"
            case "-h", "--help":
                command = "help"
            default:
                throw UsageError("unknown argument \(argument)")
            }
        }
        if command == "transcribe" { options.streaming = false }
    }
}

struct UsageError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Loads the models, reporting progress as protocol events.
func loadTranscriber(_ options: TranscriberOptions, events: EventWriter) async -> Transcriber {
    do {
        return try await Transcriber.load(
            options,
            progress: { model, fraction in events.emit(.loading(model: model, fraction: fraction)) },
            onStreamingFailure: { error in
                events.emit(.error(code: .modelLoad, message: "Live preview unavailable: \(error)", fatal: false))
            })
    } catch {
        events.emit(.error(code: .modelLoad, message: "\(error)", fatal: true))
        exit(1)
    }
}

/// Loads the models for the one-shot commands, reporting progress on stderr.
func loadTranscriber(_ options: TranscriberOptions) async throws -> Transcriber {
    try await Transcriber.load(
        options,
        progress: { model, fraction in log("\(model) \(Int(fraction * 100))%") },
        onStreamingFailure: { error in log("streaming model unavailable: \(error)") })
}

/// Reads commands until `quit` or end of input, which means the extension went away.
func serve(_ arguments: Arguments) async throws {
    let events = EventWriter()
    let transcriber = await loadTranscriber(arguments.options, events: events)
    let input = arguments.input.map { URL(fileURLWithPath: $0) }
    let session = Session(transcriber: transcriber, events: events) {
        if let input { try FileReplaySource(url: input) } else { MicrophoneSource() }
    }
    events.emit(.ready(streaming: transcriber.streaming))

    let decoder = JSONDecoder()
    for try await line in FileHandle.standardInput.bytes.lines {
        guard !line.allSatisfy(\.isWhitespace) else { continue }
        guard let command = try? decoder.decode(Command.self, from: Data(line.utf8)) else {
            events.emit(.error(code: .badCommand, message: "Unrecognised command: \(line)", fatal: false))
            continue
        }
        await session.handle(command)
        if command == .quit { return }
    }
    await session.shutdown()
}

func transcribe(_ arguments: Arguments) async throws {
    guard let file = arguments.file else { throw UsageError("transcribe needs a file") }
    let transcriber = try await loadTranscriber(arguments.options)
    let samples = try AudioConverter().resampleAudioFile(URL(fileURLWithPath: file))
    print(try await transcriber.transcribe(samples))
}

// FluidAudio logs every step at debug level; keep stderr for things worth reading.
AppLogger.minimumLevel = .warning

do {
    let arguments = try Arguments(CommandLine.arguments.dropFirst())
    switch arguments.command {
    case "help": print(usage)
    case "version": print("\(helperVersion) (protocol \(protocolVersion))")
    case "download": _ = try await loadTranscriber(arguments.options)
    case "transcribe": try await transcribe(arguments)
    default: try await serve(arguments)
    }
} catch let error as UsageError {
    log(error.description)
    FileHandle.standardError.write(Data("\n\(usage)\n".utf8))
    exit(2)
} catch {
    log("\(error)")
    exit(1)
}
