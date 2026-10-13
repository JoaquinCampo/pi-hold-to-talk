import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyKey } from "../src/keys.ts";

test("classifies legacy and kitty-encoded keys", () => {
  assert.deepEqual(classifyKey(" "), { key: "space", phase: "press" });
  assert.deepEqual(classifyKey("\x1b[32;1:2u"), { key: "space", phase: "repeat" });
  assert.deepEqual(classifyKey("\x1b[32;1:3u"), { key: "space", phase: "release" });
  assert.deepEqual(classifyKey("\x1b"), { key: "escape", phase: "press" });
  assert.deepEqual(classifyKey("a"), { key: "other", phase: "press" });
  assert.deepEqual(classifyKey("\x1b[97;1:3u"), { key: "other", phase: "release" });
  assert.deepEqual(classifyKey("\x1b[200~ \x1b[201~"), { key: "other", phase: "press" }, "a pasted space is not a key");
});
