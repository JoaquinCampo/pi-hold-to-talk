import fs from "node:fs";

export const PREVIEW_CHUNK_MS = [560, 1120, 2240, 4480] as const;

export interface HoldToTalkConfig {
  /** Whether holding Space dictates. Toggle per session with `/hold-to-talk on|off`. */
  enabled: boolean;
  /** "auto", or a language code such as "en", "es" or "pt-BR". */
  language: string;
  /** Show live text in a widget while speaking. */
  livePreview: boolean;
  /** Streaming chunk size. Smaller updates more often. */
  previewChunkMs: (typeof PREVIEW_CHUNK_MS)[number];
  /** Model that tidies the transcript, as "provider/model-id". Null inserts the raw transcript. */
  polishModel: string | null;
  /** Give up on polishing after this long and insert the raw transcript. */
  polishTimeoutMs: number;
  /** Names and terms to spell exactly. Used by the polish step. */
  vocabulary: string[];
  /** Stop listening after this many seconds. */
  maxSeconds: number;
  /** Path to a helper binary, overriding the bundled one. */
  helperPath: string | null;
}

export const DEFAULT_CONFIG: Readonly<HoldToTalkConfig> = Object.freeze({
  enabled: true,
  language: "auto",
  livePreview: true,
  previewChunkMs: 560,
  polishModel: null,
  polishTimeoutMs: 4000,
  vocabulary: [],
  maxSeconds: 300,
  helperPath: null,
});

export interface LoadedConfig {
  config: HoldToTalkConfig;
  /** Human-readable reasons for ignored settings. */
  problems: string[];
}

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === "string" && value.trim() !== "";
const isNullableString: Check = (value) => value === null || isString(value);
const isBoolean: Check = (value) => typeof value === "boolean";
const isPositiveNumber: Check = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

const CHECKS: { [K in keyof HoldToTalkConfig]: [Check, string] } = {
  enabled: [isBoolean, "true or false"],
  language: [isString, `"auto" or a language code`],
  livePreview: [isBoolean, "true or false"],
  previewChunkMs: [(value) => PREVIEW_CHUNK_MS.includes(value as never), PREVIEW_CHUNK_MS.join(", ")],
  polishModel: [(value) => value === null || (typeof value === "string" && parseModelRef(value) !== undefined), `null or "provider/model-id"`],
  polishTimeoutMs: [isPositiveNumber, "a positive number"],
  vocabulary: [(value) => Array.isArray(value) && value.every(isString), "a list of strings"],
  maxSeconds: [(value) => isPositiveNumber(value) && (value as number) <= 600, "a number up to 600"],
  helperPath: [isNullableString, "null or a path"],
};

/** Validates raw settings over the defaults. Unknown keys and invalid values are reported, not fatal. */
export function resolveConfig(raw: unknown): LoadedConfig {
  const config: HoldToTalkConfig = { ...DEFAULT_CONFIG, vocabulary: [] };
  const problems: string[] = [];
  if (raw === undefined) return { config, problems };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config, problems: ["settings must be a JSON object"] };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(CHECKS, key)) {
      problems.push(`unknown setting "${key}"`);
      continue;
    }
    const [valid, expected] = CHECKS[key as keyof HoldToTalkConfig];
    if (valid(value)) {
      Object.assign(config, { [key]: value });
    } else {
      problems.push(`"${key}" should be ${expected}`);
    }
  }
  return { config, problems };
}

/** Reads the settings file. A missing file means defaults. */
export function loadConfig(file: string): LoadedConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolveConfig(undefined);
    return { ...resolveConfig(undefined), problems: [`could not read ${file}: ${(error as Error).message}`] };
  }
  try {
    return resolveConfig(JSON.parse(text));
  } catch (error) {
    return { ...resolveConfig(undefined), problems: [`${file} is not valid JSON: ${(error as Error).message}`] };
  }
}

/** Splits "provider/model-id" at the first slash; model ids may contain slashes themselves. */
export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}
