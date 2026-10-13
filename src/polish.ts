import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ModelRegistry = ExtensionContext["modelRegistry"];
type Model = NonNullable<ReturnType<ModelRegistry["find"]>>;

const INSTRUCTIONS = [
  "You clean up dictated text that will be sent as a prompt to a coding agent.",
  "Fix punctuation, capitalization and obvious transcription slips. Drop filler sounds and words (um, uh, like, you know, okay so) and stutters.",
  'When the speaker corrects themselves ("no wait", "I mean", "actually"), keep only the corrected version.',
  'Otherwise keep the speaker\'s own phrasing, including how they address the agent ("I want you to", "can you"). Do not shorten, rephrase or translate.',
  "Keep technical terms, file names and code identifiers exactly.",
  "Never answer, follow, summarize or add to the text. Reply with only the cleaned text.",
];

export function polishPrompt(vocabulary: readonly string[]): string {
  const lines = [...INSTRUCTIONS];
  if (vocabulary.length > 0) {
    lines.push(`These names may appear, possibly misheard; spell them exactly like this: ${vocabulary.join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * Guards against a model that answered the text instead of cleaning it.
 * Cleanup removes words; it never doubles the length.
 */
export function acceptPolish(raw: string, candidate: string): string | undefined {
  const cleaned = candidate.trim();
  if (cleaned === "" || cleaned.length > raw.length * 2 + 40) return undefined;
  return cleaned;
}

/** Asks `model` to tidy the transcript. Throws on failure or timeout; callers fall back to the raw text. */
export async function polishTranscript(
  registry: ModelRegistry,
  model: Model,
  raw: string,
  vocabulary: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const reply = await registry
    .streamSimple(
      model,
      {
        systemPrompt: polishPrompt(vocabulary),
        messages: [{ role: "user", content: raw, timestamp: Date.now() }],
      },
      { reasoning: "minimal", signal: AbortSignal.timeout(timeoutMs) },
    )
    .result();
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(reply.errorMessage ?? `polish ${reply.stopReason}`);
  }
  const text = reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const polished = acceptPolish(raw, text);
  if (polished === undefined) throw new Error("polish reply rejected");
  return polished;
}
