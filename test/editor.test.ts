import assert from "node:assert/strict";
import { test } from "node:test";
import { asDictationTarget, eraseSpacesBeforeCursor, insertDictation } from "../src/editor.ts";
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

test("inserts at the cursor, separated from a preceding word", () => {
  const editor = new FakeEditor("please  now", 6);
  insertDictation(editor, "check the header");
  assert.equal(editor.text, "please check the header  now");

  const empty = new FakeEditor();
  insertDictation(empty, "Hello.");
  assert.equal(empty.text, "Hello.");

  const afterSpace = new FakeEditor("Then ");
  insertDictation(afterSpace, "ship it");
  assert.equal(afterSpace.text, "Then ship it");
});
