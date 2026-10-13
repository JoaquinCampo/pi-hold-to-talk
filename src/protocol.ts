// The JSON-lines protocol spoken with the native helper over stdin/stdout.
// Mirrors helper/Sources/HoldToTalkHelper/Protocol.swift; keep the two in step.

export const PROTOCOL_VERSION = 1;

export type HelperCommand = { type: "start" } | { type: "stop" } | { type: "cancel" } | { type: "quit" };

export type HelperErrorCode =
  | "bad_command"
  | "invalid_state"
  | "microphone_denied"
  | "microphone_unavailable"
  | "model_load"
  | "transcription";

export type HelperEvent =
  /** A model is downloading or compiling. */
  | { type: "loading"; model: string; fraction: number }
  /** Models are loaded. `streaming` is false when live partials are unavailable. */
  | { type: "ready"; protocolVersion: number; streaming: boolean }
  /** The microphone is open. */
  | { type: "listening" }
  /** Input loudness in [0, 1], about ten times a second. */
  | { type: "level"; level: number }
  /** Live text for the audio so far; replaces the previous partial. */
  | { type: "partial"; text: string }
  /** The definitive transcript. Empty when nothing was said. */
  | { type: "final"; text: string; audioMs: number; transcribeMs: number }
  | { type: "cancelled" }
  /** After a fatal error the helper exits. */
  | { type: "error"; code: HelperErrorCode; message: string; fatal: boolean };

type FieldType = "string" | "number" | "boolean";

const SHAPES: { [K in HelperEvent["type"]]: Record<string, FieldType> } = {
  loading: { model: "string", fraction: "number" },
  ready: { protocolVersion: "number", streaming: "boolean" },
  listening: {},
  level: { level: "number" },
  partial: { text: "string" },
  final: { text: "string", audioMs: "number", transcribeMs: "number" },
  cancelled: {},
  error: { code: "string", message: "string", fatal: "boolean" },
};

/** Parses one stdout line. Returns undefined for anything that is not a well-formed event. */
export function parseEvent(line: string): HelperEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string" || !Object.hasOwn(SHAPES, type)) return undefined;
  const shape = SHAPES[type as HelperEvent["type"]];
  for (const [field, expected] of Object.entries(shape)) {
    if (typeof record[field] !== expected) return undefined;
  }
  return record as HelperEvent;
}

export function serializeCommand(command: HelperCommand): string {
  return `${JSON.stringify(command)}\n`;
}
