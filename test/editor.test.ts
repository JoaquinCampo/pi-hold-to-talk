import assert from "node:assert/strict";
import { test } from "node:test";
import { asDictationTarget, eraseSpacesBeforeCursor, LiveText } from "../src/editor.ts";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { FakeEditor } from "./fakes.ts";

test("recognises editor-like components only", () => {
  assert.ok(asDictationTarget(new FakeEditor()));
  assert.equal(asDictationTarget({ render: () => [], invalidate() {} }), undefined);
  assert.equal(asDictationTarget(null), undefined);
});

test("erases leaked spaces before the cursor, never more", () => {
  const editor = new FakeEditor("fix it    later", 10);
  eraseSpacesBeforeCursor(editor, 3);
  assert.equal(editor.text, "fix it later");
  const short = new FakeEditor("word  ");
  eraseSpacesBeforeCursor(short, 4);
  assert.equal(short.text, "word", "stops at the first non-space");
});

test("live text edits only what changed, at the cursor", () => {
  const editor = new FakeEditor("please  now", 6);
  const live = new LiveText(editor);
  live.update("check the");
  assert.equal(editor.text, "please check the  now");
  const backspaces = editor.backspaces;
  live.update("check the header");
  assert.equal(editor.text, "please check the header  now");
  assert.equal(editor.backspaces, backspaces, "appending needs no deletion");
  live.update("Check the header.");
  assert.equal(editor.text, "please Check the header.  now");
  assert.equal(live.text, "Check the header.");
  live.update("");
  assert.equal(editor.text, "please  now", "clearing removes the separator too");
});

test("live text needs no separator after a space or at the start", () => {
  const empty = new FakeEditor();
  new LiveText(empty).update("Hello.");
  assert.equal(empty.text, "Hello.");
  const afterSpace = new FakeEditor("Then ");
  new LiveText(afterSpace).update("ship it");
  assert.equal(afterSpace.text, "Then ship it");
});

test("live text leaves the editor alone once the person moved on", () => {
  const editor = new FakeEditor("Note:");
  const live = new LiveText(editor);
  live.update("first draft");
  editor.handleInput("!");
  assert.equal(live.intact, false);
  assert.equal(live.update("final"), false);
  assert.equal(editor.text, "Note: first draft!");
});

test("live text deletes whole characters", () => {
  const editor = new FakeEditor();
  const live = new LiveText(editor);
  live.update("café 👍🏽");
  live.update("café");
  assert.equal(editor.text, "café");
});

test("live text is painted until committed, then drawn plainly", () => {
  const editor = new FakeEditor("Note:");
  const live = new LiveText(editor, (text) => `<${text}>`);
  live.update("check this");
  assert.deepEqual(editor.render(), [`Note: <check this>${CURSOR_MARKER}`]);
  live.commit();
  assert.deepEqual(editor.render(), [`Note: check this${CURSOR_MARKER}`]);
  assert.equal(Object.hasOwn(editor, "render"), false, "the editor's own render is back");
});

test("committing leaves a later render wrapper in place", () => {
  const editor = new FakeEditor();
  const live = new LiveText(editor, (text) => `<${text}>`);
  live.update("hi");
  const outer = editor.render;
  editor.render = () => outer.call(editor).map((line) => `[${line}]`);
  live.commit();
  assert.deepEqual(editor.render(), [`[hi${CURSOR_MARKER}]`]);
});
