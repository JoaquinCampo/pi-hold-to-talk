import type { KeyEvent } from "./keys.ts";

export interface HoldTiming {
  /** Spaces closer together than this are auto-repeat, not typing. */
  repeatGapMs: number;
  /** Consecutive auto-repeats that make a hold. */
  repeatsToHold: number;
  /** Spaces further apart than this belong to separate bursts. Covers the delay before auto-repeat kicks in. */
  burstWindowMs: number;
  /** With no repeat for this long, the key has been let go. */
  releaseMs: number;
}

/**
 * Derives timing from the macOS keyboard settings, which are stored in units of 15 ms
 * (`defaults read -g KeyRepeat` / `InitialKeyRepeat`). Undefined means the system default.
 */
export function holdTiming(keyRepeat = 6, initialKeyRepeat = 25): HoldTiming {
  const repeatMs = keyRepeat * 15;
  const initialMs = initialKeyRepeat * 15;
  return {
    repeatGapMs: clamp(repeatMs + 45, 100, 400),
    repeatsToHold: 3,
    burstWindowMs: clamp(initialMs + 250, 500, 2000),
    releaseMs: Math.max(450, repeatMs * 4),
  };
}

export type Verdict =
  /** Not part of a hold: let the key through. */
  | { action: "pass" }
  /** A hold began. The last `leaked` spaces before the cursor came from this burst and should be erased. */
  | { action: "start"; leaked: number }
  /** Part of an ongoing hold: swallow it. */
  | { action: "continue" }
  /** The key was let go: swallow it and finish. */
  | { action: "release" }
  /** Escape during a hold: swallow it and discard the recording. */
  | { action: "cancel" }
  /** Another key during a hold: finish, and let the key through. */
  | { action: "finish" };

/**
 * Recognises Space being held down.
 *
 * Most terminals report presses but never releases, so a held key is recognised by its
 * auto-repeat burst and released when the repeats stop (timed by the caller with `releaseMs`).
 * Terminals that speak the kitty keyboard protocol label repeats and releases explicitly; those
 * labels are used when present, which makes both edges exact.
 */
export class HoldDetector {
  private readonly timing: HoldTiming;
  private holding = false;
  private lastSpaceAt = Number.NEGATIVE_INFINITY;
  private quickRepeats = 0;
  /** Spaces of the current burst that reached the editor. */
  private burst = 0;

  constructor(timing: HoldTiming) {
    this.timing = timing;
  }

  get isHolding(): boolean {
    return this.holding;
  }

  feed(event: KeyEvent, now: number): Verdict {
    return this.holding ? this.duringHold(event) : this.whileIdle(event, now);
  }

  /** Ends a hold without a key event, such as the release timer firing. */
  end(): void {
    this.holding = false;
    this.forgetBurst();
  }

  private whileIdle({ key, phase }: KeyEvent, now: number): Verdict {
    if (key !== "space") {
      if (phase !== "release") this.forgetBurst();
      return { action: "pass" };
    }
    if (phase === "release") {
      // The key went up between presses: someone is typing spaces, not holding one.
      this.quickRepeats = 0;
      return { action: "pass" };
    }
    if (phase === "repeat") return this.begin();

    const gap = now - this.lastSpaceAt;
    this.lastSpaceAt = now;
    if (gap >= this.timing.burstWindowMs) this.burst = 0;
    this.quickRepeats = gap < this.timing.repeatGapMs ? this.quickRepeats + 1 : 0;
    if (this.quickRepeats >= this.timing.repeatsToHold) return this.begin();
    this.burst += 1;
    return { action: "pass" };
  }

  private duringHold({ key, phase }: KeyEvent): Verdict {
    if (key === "space") {
      if (phase !== "release") return { action: "continue" };
      this.end();
      return { action: "release" };
    }
    if (phase === "release") return { action: "pass" };
    this.end();
    return key === "escape" ? { action: "cancel" } : { action: "finish" };
  }

  private begin(): Verdict {
    const leaked = this.burst;
    this.holding = true;
    this.forgetBurst();
    return { action: "start", leaked };
  }

  private forgetBurst(): void {
    this.lastSpaceAt = Number.NEGATIVE_INFINITY;
    this.quickRepeats = 0;
    this.burst = 0;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
