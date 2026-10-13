import type { Component } from "@earendil-works/pi-tui";

/**
 * The parts of pi-tui's `Editor` that dictation uses. Going through the focused editor
 * (rather than replacing the whole prompt) inserts at the cursor as a single undo step,
 * and never turns long dictation into a collapsed paste marker.
 */
export interface DictationTarget {
  getLines(): string[];
  getCursor(): { line: number; col: number };
  insertTextAtCursor(text: string): void;
  handleInput(data: string): void;
}

const BACKSPACE = "\x7f";

export function asDictationTarget(component: Component | null | undefined): DictationTarget | undefined {
  if (!component) return undefined;
  const candidate = component as Partial<DictationTarget>;
  const usable =
    typeof candidate.getLines === "function" &&
    typeof candidate.getCursor === "function" &&
    typeof candidate.insertTextAtCursor === "function" &&
    typeof candidate.handleInput === "function";
  return usable ? (component as unknown as DictationTarget) : undefined;
}

/** Text on the cursor's line, up to the cursor. */
export function textBeforeCursor(target: DictationTarget): string {
  const { line, col } = target.getCursor();
  return (target.getLines()[line] ?? "").slice(0, col);
}

/** Erases up to `count` spaces directly before the cursor, as if Backspace were pressed. */
export function eraseSpacesBeforeCursor(target: DictationTarget, count: number): void {
  const trailing = /( *)$/.exec(textBeforeCursor(target))?.[1]?.length ?? 0;
  for (let i = Math.min(count, trailing); i > 0; i--) target.handleInput(BACKSPACE);
}

/** Inserts dictated text at the cursor, separated by a space from a word right before it. */
export function insertDictation(target: DictationTarget, text: string): void {
  const before = textBeforeCursor(target);
  target.insertTextAtCursor(before !== "" && !/\s$/.test(before) ? ` ${text}` : text);
}
