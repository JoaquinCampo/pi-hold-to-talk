import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clock, meter, renderView, tail } from "../src/widget.ts";

const plain = { fg: (_color: string, text: string) => text } as Parameters<typeof renderView>[1];

test("formats the clock and the level meter", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(65_400), "1:05");
  assert.equal(meter([]), "▁▁▁▁▁▁▁▁");
  assert.equal(meter([0, 0.5, 1]), "▁▁▁▁▁▁▅█");
});

test("keeps the end of long text", () => {
  assert.equal(tail("short", 10), "short");
  assert.equal(tail("the quick brown fox", 10), "…brown fox");
  assert.ok(visibleWidth(tail("日本語のテキストです", 9)) <= 9);
});

test("renders each state within the width", () => {
  const width = 40;
  const views = [
    { kind: "hidden" },
    { kind: "loading", percent: 42 },
    { kind: "listening", live: true, startedAt: 0, levels: [0.3, 0.6], preview: "I want you to look at the header and make it smaller" },
    { kind: "transcribing" },
    { kind: "polishing", text: "so um fix it" },
    { kind: "notice", text: "Didn't catch that", tone: "muted" },
  ] as const;
  const rendered = views.map((view) => renderView(view, plain, width, 4000));
  assert.deepEqual(rendered[0], []);
  assert.match(rendered[1]?.[0] ?? "", /Loading speech models 42%/);
  assert.match(rendered[2]?.[0] ?? "", /0:04/);
  assert.match(rendered[2]?.[1] ?? "", /make it smaller$/);
  for (const lines of rendered) for (const line of lines) assert.ok(visibleWidth(line) <= width, line);
});
