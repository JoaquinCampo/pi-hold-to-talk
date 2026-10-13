import type { DictationTarget } from "../src/editor.ts";
import type { HelperLike, HelperNotice, HelperStatus } from "../src/helper.ts";
import type { HelperCommand } from "../src/protocol.ts";

/** A one-line editor with a cursor, enough to stand in for pi-tui's Editor. */
export class FakeEditor implements DictationTarget {
  text: string;
  col: number;

  constructor(text = "", col = text.length) {
    this.text = text;
    this.col = col;
  }

  getLines(): string[] {
    return [this.text];
  }

  getCursor() {
    return { line: 0, col: this.col };
  }

  insertTextAtCursor(text: string): void {
    this.text = this.text.slice(0, this.col) + text + this.text.slice(this.col);
    this.col += text.length;
  }

  /** Prompts sent with Enter. */
  readonly submitted: string[] = [];

  handleInput(data: string): void {
    if (data === "\x7f") {
      this.text = this.text.slice(0, this.col - 1) + this.text.slice(this.col);
      this.col -= 1;
    } else if (data === "\r") {
      this.submitted.push(this.text);
      this.text = "";
      this.col = 0;
    } else {
      this.insertTextAtCursor(data);
    }
  }

  render(): string[] {
    return [this.text];
  }

  invalidate(): void {}
}

/** A helper that records commands and lets tests push notices. */
export class FakeHelper implements HelperLike {
  status: HelperStatus = { state: "ready", streaming: true };
  readonly sent: HelperCommand["type"][] = [];
  private listener: ((notice: HelperNotice) => void) | undefined;

  send(command: HelperCommand): void {
    this.sent.push(command.type);
  }

  onNotice(listener: (notice: HelperNotice) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  dispose(): void {}

  emit(notice: HelperNotice): void {
    this.listener?.(notice);
  }
}
