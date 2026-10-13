import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { Dictation, type DictationOptions } from "../src/dictation.ts";
import { holdTiming } from "../src/hold-detector.ts";
import type { View } from "../src/widget.ts";
import { FakeEditor, FakeHelper } from "./fakes.ts";

const T0 = 1_000_000;

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 }));
afterEach(() => mock.timers.reset());

function setup(options: Partial<DictationOptions> = {}, editor: FakeEditor | null = new FakeEditor("Please ")) {
  const helper = new FakeHelper();
  const views: View[] = [];
  const notices: string[] = [];
  const dictation = new Dictation(
    helper,
    { show: (view) => views.push(view), notify: (message) => notices.push(message), focusedTarget: () => editor ?? undefined },
    { timing: holdTiming(), maxSeconds: 300, polish: undefined, ...options },
  );
  /** Sends raw input like the terminal would, applying unconsumed keys to the editor. */
  const type = (data: string) => {
    const result = dictation.handleInput(data);
    if (!result?.consume && editor && data.length === 1 && data !== "\x1b") editor.insertTextAtCursor(data);
    return result;
  };
  /** Holds Space for `ms`: a press, the first repeat after 375 ms, then one every 90 ms. */
  const holdSpace = (ms: number) => {
    type(" ");
    let elapsed = 375;
    mock.timers.tick(375);
    while (elapsed <= ms) {
      type(" ");
      mock.timers.tick(90);
      elapsed += 90;
    }
  };
  const lastView = () => views.at(-1);
  return { helper, dictation, editor, views, notices, type, holdSpace, lastView };
}

test("hold, speak, release: the transcript lands at the cursor", () => {
  const { helper, editor, holdSpace, lastView } = setup();
  holdSpace(1500);
  assert.deepEqual(helper.sent, ["start"]);
  assert.equal(editor?.text, "Please ", "the spaces typed by the hold are erased");

  helper.emit({ type: "listening" });
  helper.emit({ type: "level", level: 0.5 });
  helper.emit({ type: "partial", text: "check the" });
  // The fourth quick repeat starts the hold: 375 ms initial delay plus three 90 ms repeats.
  assert.deepEqual(lastView(), { kind: "listening", live: true, startedAt: T0 + 645, levels: [0.5], preview: "check the" });

  mock.timers.tick(450); // no more repeats: the key was let go
  assert.deepEqual(helper.sent, ["start", "stop"]);
  assert.deepEqual(lastView(), { kind: "transcribing" });

  helper.emit({ type: "final", text: "Check the header.", audioMs: 1500, transcribeMs: 80 });
  assert.equal(editor?.text, "Please Check the header.");
  assert.deepEqual(lastView(), { kind: "hidden" });
});

test("typing spaces is left alone", () => {
  const { helper, editor, type } = setup();
  for (const char of "a b  c") {
    type(char);
    mock.timers.tick(160);
  }
  assert.equal(editor?.text, "Please a b  c");
  assert.deepEqual(helper.sent, []);
});

test("Escape cancels without inserting anything", () => {
  const { helper, editor, holdSpace, type, lastView } = setup();
  holdSpace(1000);
  assert.deepEqual(type("\x1b"), { consume: true });
  assert.deepEqual(helper.sent, ["start", "cancel"]);
  helper.emit({ type: "final", text: "too late", audioMs: 0, transcribeMs: 0 });
  assert.equal(editor?.text, "Please ");
  assert.deepEqual(lastView(), { kind: "hidden" });
});

test("another key finishes the hold and still reaches the editor", () => {
  const { helper, holdSpace, type } = setup();
  holdSpace(1000);
  assert.equal(type("x"), undefined);
  assert.deepEqual(helper.sent, ["start", "stop"]);
});

test("does nothing when the editor does not have focus", () => {
  const { helper, holdSpace } = setup({}, null);
  holdSpace(1500);
  assert.deepEqual(helper.sent, []);
});

test("polishes before inserting, and falls back to the raw text", async () => {
  for (const [polish, expected] of [
    [async () => "Fix the header.", "Please Fix the header."],
    [async () => Promise.reject(new Error("timeout")), "Please um fix the header"],
  ] as const) {
    const { helper, editor, holdSpace, lastView } = setup({ polish });
    holdSpace(1000);
    mock.timers.tick(450);
    helper.emit({ type: "final", text: "um fix the header", audioMs: 1000, transcribeMs: 50 });
    assert.deepEqual(lastView(), { kind: "polishing", text: "um fix the header" });
    await new Promise(setImmediate);
    assert.equal(editor?.text, expected);
  }
});

test("silence shows a short notice and inserts nothing", () => {
  const { helper, editor, holdSpace, lastView } = setup();
  holdSpace(1000);
  mock.timers.tick(450);
  helper.emit({ type: "final", text: "", audioMs: 1000, transcribeMs: 10 });
  assert.equal(editor?.text, "Please ");
  assert.deepEqual(lastView(), { kind: "notice", text: "Didn't catch that", tone: "muted" });
  mock.timers.tick(2500);
  assert.deepEqual(lastView(), { kind: "hidden" });
});

test("while models load, holding shows progress and starts once they are ready", () => {
  const { helper, holdSpace, lastView } = setup();
  helper.status = { state: "loading", percent: 10 };
  holdSpace(1000);
  assert.deepEqual(helper.sent, []);
  assert.deepEqual(lastView(), { kind: "loading", percent: 10 });
  helper.status = { state: "ready", streaming: true };
  helper.emit({ type: "ready", protocolVersion: 1, streaming: true });
  assert.deepEqual(helper.sent, ["start"]);
});

test("a microphone error resets and explains", () => {
  const { helper, notices, holdSpace, lastView } = setup();
  holdSpace(1000);
  helper.emit({ type: "error", code: "microphone_denied", message: "denied", fatal: false });
  assert.deepEqual(lastView(), { kind: "hidden" });
  assert.match(notices[0] ?? "", /Privacy & Security > Microphone/);
});

test("stops listening at the time limit", () => {
  const { helper, type } = setup({ maxSeconds: 2 });
  type(" ");
  mock.timers.tick(375);
  for (let elapsed = 0; elapsed < 3000; elapsed += 90) {
    type(" ");
    mock.timers.tick(90);
  }
  assert.deepEqual(helper.sent, ["start", "stop"]);
});

test("disabled means plain spaces", () => {
  const { helper, dictation, holdSpace } = setup();
  dictation.enabled = false;
  holdSpace(1500);
  assert.deepEqual(helper.sent, []);
});
