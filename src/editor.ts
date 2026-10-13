import type { Component } from "@earendil-works/pi-tui";
import { dimBeforeCursor } from "./dim.ts";

/**
 * The parts of pi-tui's `Editor` that dictation uses. Going through the focused editor
 * (rather than replacing the whole prompt) edits at the cursor and never turns long
 * dictation into a collapsed paste marker.
 */
export interface DictationTarget {
  getLines(): string[];
  getCursor(): { line: number; col: number };
  insertTextAtCursor(text: string): void;
  handleInput(data: string): void;
  render(width: number): string[];
}

const BACKSPACE = "\x7f";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function splitGraphemes(text: string): string[] {
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

export function asDictationTarget(component: Component | null | undefined): DictationTarget | undefined {
  if (!component) return undefined;
  const candidate = component as Partial<DictationTarget>;
  const usable =
    typeof candidate.getLines === "function" &&
    typeof candidate.getCursor === "function" &&
    typeof candidate.insertTextAtCursor === "function" &&
    typeof candidate.handleInput === "function" &&
    typeof candidate.render === "function";
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

/**
 * Dictated text kept in the editor, ending at the cursor, while it is still changing:
 * live words while speaking, then the final transcript.
 * Each update edits only what changed. Once the editor no longer ends with this text at
 * the cursor (the person moved on), updates are refused and the text is left alone.
 *
 * Given a `paint` function, the text is drawn with it until `commit()`, marking it as
 * provisional. This wraps the editor's `render` for that time.
 */
export class LiveText {
  private readonly target: DictationTarget;
  /** A space that keeps the dictation off a word right before it. Part of the span. */
  private readonly separator: string;
  private shown = "";
  private unwrap: (() => void) | undefined;

  constructor(target: DictationTarget, paint?: (text: string) => string) {
    this.target = target;
    const before = textBeforeCursor(target);
    this.separator = before !== "" && !/\s$/.test(before) ? " " : "";
    if (paint) this.unwrap = wrapRender(target, (lines) => (this.intact ? dimBeforeCursor(lines, this.shown, paint) : lines));
  }

  /** The dictated text currently in the editor, without the separator. */
  get text(): string {
    return this.shown === "" ? "" : this.shown.slice(this.separator.length);
  }

  /** Whether the editor still ends with this text at the cursor. */
  get intact(): boolean {
    return textBeforeCursor(this.target).endsWith(this.shown);
  }

  /** Shows `text` in place of the current dictation. Returns false when the editor moved on. */
  update(text: string): boolean {
    if (!this.intact) return false;
    const next = text === "" ? "" : this.separator + text;
    const from = splitGraphemes(this.shown);
    const to = splitGraphemes(next);
    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common]) common++;
    for (let i = from.length - common; i > 0; i--) this.target.handleInput(BACKSPACE);
    const added = to.slice(common).join("");
    if (added) this.target.insertTextAtCursor(added);
    this.shown = next;
    return true;
  }

  /** The text is final: draw it like the rest of the prompt. */
  commit(): void {
    this.unwrap?.();
    this.unwrap = undefined;
  }
}

/**
 * Passes the target's rendered lines through `transform` until the returned function is
 * called. If something else wrapped `render` in the meantime, that wrapper stays in place
 * and ours becomes a pass-through.
 */
function wrapRender(target: DictationTarget, transform: (lines: string[]) => string[]): () => void {
  const hadOwn = Object.hasOwn(target, "render");
  const original = target.render;
  let active = true;
  const wrapped = (width: number) => {
    const lines = original.call(target, width);
    return active ? transform(lines) : lines;
  };
  target.render = wrapped;
  return () => {
    active = false;
    if (target.render !== wrapped) return;
    if (hadOwn) target.render = original;
    else delete (target as Partial<DictationTarget>).render;
  };
}
