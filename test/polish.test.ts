import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptPolish, polishPrompt } from "../src/polish.ts";

test("the prompt lists vocabulary only when there is some", () => {
  assert.doesNotMatch(polishPrompt([]), /spell them exactly/);
  assert.match(polishPrompt(["pi-subagents", "FluidAudio"]), /spell them exactly like this: pi-subagents, FluidAudio\./);
});

test("accepts a cleanup and rejects an answer", () => {
  assert.equal(acceptPolish("um so fix the the header", "  So, fix the header.  "), "So, fix the header.");
  assert.equal(acceptPolish("hi", ""), undefined);
  assert.equal(acceptPolish("what is a monad", "A monad is ".repeat(20)), undefined);
});
