import assert from "node:assert/strict";
import { test } from "node:test";
import { HoldDetector, holdTiming, type Verdict } from "../src/hold-detector.ts";
import type { KeyEvent } from "../src/keys.ts";

const timing = holdTiming(); // macOS defaults: repeats every 90 ms after 375 ms
const space: KeyEvent = { key: "space", phase: "press" };
const key = (k: KeyEvent["key"], phase: KeyEvent["phase"] = "press"): KeyEvent => ({ key: k, phase });

/** Feeds events at the given times and returns the verdicts' actions. */
function play(detector: HoldDetector, events: Array<[number, KeyEvent]>): Verdict[] {
  return events.map(([at, event]) => detector.feed(event, at));
}

test("derives timing from the key repeat settings", () => {
  assert.deepEqual(holdTiming(), { repeatGapMs: 135, repeatsToHold: 3, burstWindowMs: 625, releaseMs: 450 });
  assert.equal(holdTiming(2).repeatGapMs, 100, "fast repeat is clamped to a sane minimum");
  assert.equal(holdTiming(30).releaseMs, 1800, "slow repeat waits longer before assuming release");
});

test("typing spaces never starts a hold", () => {
  const detector = new HoldDetector(timing);
  const verdicts = play(detector, [[0, space], [180, space], [360, space], [540, space], [720, space]]);
  assert.ok(verdicts.every((v) => v.action === "pass"));
});

test("a held key is recognised by its auto-repeat, erasing the spaces it typed", () => {
  const detector = new HoldDetector(timing);
  // Press, the first repeat after the initial delay, then repeats every 90 ms.
  const verdicts = play(detector, [[0, space], [375, space], [465, space], [555, space], [645, space], [735, space]]);
  assert.deepEqual(
    verdicts.map((v) => v.action),
    ["pass", "pass", "pass", "pass", "start", "continue"],
  );
  assert.deepEqual(verdicts[4], { action: "start", leaked: 4 });
});

test("a space typed earlier is not erased with the burst", () => {
  const detector = new HoldDetector(timing);
  const verdicts = play(detector, [[0, space], [3000, space], [3375, space], [3465, space], [3555, space], [3645, space]]);
  assert.deepEqual(verdicts[5], { action: "start", leaked: 4 });
});

test("other keys break a burst", () => {
  const detector = new HoldDetector(timing);
  const verdicts = play(detector, [[0, space], [90, space], [180, space], [200, key("other")], [270, space], [360, space]]);
  assert.ok(verdicts.every((v) => v.action === "pass"));
});

test("explicit kitty repeats and releases make both edges exact", () => {
  const detector = new HoldDetector(timing);
  const verdicts = play(detector, [
    [0, space],
    [100, key("other", "release")],
    [375, key("space", "repeat")],
    [465, key("space", "repeat")],
    [900, key("space", "release")],
  ]);
  assert.deepEqual(verdicts.map((v) => v.action), ["pass", "pass", "start", "continue", "release"]);
  assert.deepEqual(verdicts[2], { action: "start", leaked: 1 });
  assert.equal(detector.isHolding, false);
});

test("a release between presses means typing", () => {
  const detector = new HoldDetector(timing);
  const verdicts = play(detector, [
    [0, space], [40, key("space", "release")],
    [80, space], [120, key("space", "release")],
    [160, space], [200, key("space", "release")],
    [240, space],
  ]);
  assert.ok(verdicts.every((v) => v.action === "pass"));
});

test("during a hold, Escape cancels and other keys finish and pass through", () => {
  const hold = () => {
    const detector = new HoldDetector(timing);
    detector.feed(key("space", "repeat"), 0);
    return detector;
  };
  assert.deepEqual(hold().feed(key("escape"), 10), { action: "cancel" });
  assert.deepEqual(hold().feed(key("other"), 10), { action: "finish" });
  assert.deepEqual(hold().feed(key("other", "release"), 10), { action: "pass" }, "stray releases are ignored");
});

test("end() returns to idle", () => {
  const detector = new HoldDetector(timing);
  detector.feed(key("space", "repeat"), 0);
  detector.end();
  assert.equal(detector.isHolding, false);
  assert.deepEqual(detector.feed(space, 5000), { action: "pass" });
});
