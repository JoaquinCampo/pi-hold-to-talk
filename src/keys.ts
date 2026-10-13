import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

export type KeyPhase = "press" | "repeat" | "release";

/** The only distinctions dictation cares about. */
export interface KeyEvent {
  key: "space" | "escape" | "other";
  phase: KeyPhase;
}

/**
 * Normalises raw terminal input. Legacy terminals send a plain " " for every press and
 * auto-repeat; terminals speaking the kitty keyboard protocol tag repeats and releases.
 */
export function classifyKey(data: string): KeyEvent {
  const phase: KeyPhase = isKeyRelease(data) ? "release" : isKeyRepeat(data) ? "repeat" : "press";
  const key = matchesKey(data, "space") ? "space" : matchesKey(data, "escape") ? "escape" : "other";
  return { key, phase };
}
