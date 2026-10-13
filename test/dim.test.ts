import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { dimBeforeCursor } from "../src/dim.ts";

const paint = (text: string) => `<${text}>`;
const BORDER = "\x1b[2m────────\x1b[0m";

test("paints the text that ends at the cursor", () => {
  const lines = [BORDER, `  Please check this${CURSOR_MARKER}\x1b[7m \x1b[0m   `, BORDER];
  assert.deepEqual(dimBeforeCursor(lines, " check this", paint), [
    BORDER,
    `  Please <check this>${CURSOR_MARKER}\x1b[7m \x1b[0m   `,
    BORDER,
  ]);
});

test("follows the text across wrapped lines, even where the wrap dropped a space", () => {
  const lines = [BORDER, "  Please look at   ", "  the header and  ", `  fix it${CURSOR_MARKER}  `, BORDER];
  assert.deepEqual(dimBeforeCursor(lines, "look at the header and fix it", paint), [
    BORDER,
    "  Please <look at>   ",
    "  <the header and>  ",
    `  <fix it>${CURSOR_MARKER}  `,
    BORDER,
  ]);
});

test("paints what is visible when the start has scrolled away", () => {
  const lines = [BORDER, "  the header", `  now${CURSOR_MARKER}`];
  assert.deepEqual(dimBeforeCursor(lines, "look at the header now", paint), [BORDER, "  <the header>", `  <now>${CURSOR_MARKER}`]);
});

test("leaves the lines alone when the text is not at the cursor", () => {
  const lines = [`  Please check that${CURSOR_MARKER}`];
  assert.deepEqual(dimBeforeCursor(lines, "check this", paint), lines);
  assert.deepEqual(dimBeforeCursor(["  no cursor here"], "here", paint), ["  no cursor here"]);
});

test("paints nothing for empty text", () => {
  const lines = [`  Please${CURSOR_MARKER}`];
  assert.deepEqual(dimBeforeCursor(lines, "", paint), lines);
});
