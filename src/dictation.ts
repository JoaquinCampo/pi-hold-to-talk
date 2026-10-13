import { type DictationTarget, eraseSpacesBeforeCursor, LiveText } from "./editor.ts";
import type { HelperLike, HelperNotice } from "./helper.ts";
import { HoldDetector, type HoldTiming } from "./hold-detector.ts";
import { classifyKey } from "./keys.ts";
import { restoreQuestionMarks } from "./questions.ts";
import { METER_WIDTH, type View } from "./widget.ts";

export interface DictationUI {
  show(view: View): void;
  notify(message: string, type: "info" | "warning" | "error"): void;
  /** The editor with keyboard focus, or undefined when something else (a dialog, an overlay) has it. */
  focusedTarget(): DictationTarget | undefined;
  /** Styles dictated text that the final pass may still change. */
  provisional(text: string): string;
}

export interface DictationOptions {
  timing: HoldTiming;
  maxSeconds: number;
  /** Write live words into the editor while speaking. */
  livePreview: boolean;
}

type Phase =
  | { name: "idle" }
  /** Space is held but the helper cannot listen yet; released without recording. */
  | { name: "waiting"; target: DictationTarget }
  | { name: "listening"; target: DictationTarget; text: LiveText; micOpen: boolean; startedAt: number; levels: number[] }
  | { name: "transcribing"; target: DictationTarget; text: LiveText };

const NOTICE_MS = 2500;
/** Auto-repeat spaces already on their way when the physical key went up. */
const TRAILING_REPEAT_MS = 150;
const consume = { consume: true } as const;

/**
 * Turns a held Space into dictation. While Space is held, live words appear at the cursor,
 * styled as provisional; on release the final transcript replaces them.
 *
 * Keys typed before the final transcript lands (most often Enter, to send the prompt) are
 * held back and replayed afterwards, so they act on the finished prompt.
 */
export class Dictation {
  enabled = true;
  private phase: Phase = { name: "idle" };
  /** Raw input held back until the dictated text settles. */
  private heldKeys: string[] = [];
  /** Swallow stray auto-repeat spaces until this time. */
  private trailingRepeatsUntil = 0;
  private readonly detector: HoldDetector;
  private readonly unsubscribe: () => void;
  private releaseTimer: NodeJS.Timeout | undefined;
  private limitTimer: NodeJS.Timeout | undefined;
  private noticeTimer: NodeJS.Timeout | undefined;
  private readonly helper: HelperLike;
  private readonly ui: DictationUI;
  private readonly options: DictationOptions;

  constructor(helper: HelperLike, ui: DictationUI, options: DictationOptions) {
    this.helper = helper;
    this.ui = ui;
    this.options = options;
    this.detector = new HoldDetector(options.timing);
    this.unsubscribe = helper.onNotice((notice) => this.receive(notice));
  }

  /** Terminal input handler. Consumes the keys that drive a hold; everything else passes through. */
  handleInput(data: string): { consume: true } | undefined {
    const key = classifyKey(data);
    if (key.key === "space" && Date.now() < this.trailingRepeatsUntil) {
      this.trailingRepeatsUntil = Date.now() + TRAILING_REPEAT_MS;
      return consume;
    }
    if (this.phase.name === "transcribing") {
      if (key.phase === "release") return undefined;
      // The final transcript is moments away; keys typed now wait for it.
      this.heldKeys.push(data);
      return consume;
    }

    const holding = this.detector.isHolding;
    if (!holding && (!this.enabled || this.phase.name !== "idle")) return undefined;
    const target = holding ? undefined : this.ui.focusedTarget();
    if (!holding && !target) return undefined;

    const verdict = this.detector.feed(key, Date.now());
    switch (verdict.action) {
      case "pass":
        return undefined;
      case "start":
        if (target) {
          eraseSpacesBeforeCursor(target, verdict.leaked);
          this.begin(target);
        }
        return consume;
      case "continue":
        this.armRelease();
        return consume;
      case "release":
        this.finish();
        return consume;
      case "cancel":
        this.cancel();
        return consume;
      case "finish":
        this.heldKeys.push(data);
        this.finish();
        return consume;
    }
  }

  dispose(): void {
    this.unsubscribe();
    if (this.phase.name === "listening") this.helper.send({ type: "cancel" });
    if (this.phase.name === "listening" || this.phase.name === "transcribing") this.phase.text.commit();
    this.clearTimers();
    this.detector.end();
    this.heldKeys = [];
    this.phase = { name: "idle" };
    this.ui.show({ kind: "hidden" });
  }

  private begin(target: DictationTarget): void {
    clearTimeout(this.noticeTimer);
    this.armRelease();
    this.limitTimer = setTimeout(() => this.finish(), this.options.maxSeconds * 1000);
    const status = this.helper.status;
    if (status.state === "ready") {
      this.listen(target);
    } else {
      this.phase = { name: "waiting", target };
      this.ui.show(
        status.state === "loading"
          ? { kind: "loading", percent: status.percent }
          : { kind: "notice", text: status.message, tone: "error" },
      );
    }
  }

  private listen(target: DictationTarget): void {
    this.helper.send({ type: "start" });
    const text = new LiveText(target, (shown) => this.ui.provisional(shown));
    this.phase = { name: "listening", target, text, micOpen: false, startedAt: Date.now(), levels: [] };
    this.render();
  }

  /** Space was let go, another key was pressed, or the time limit hit. */
  private finish(): void {
    this.clearTimers();
    this.detector.end();
    const phase = this.phase;
    if (phase.name === "listening") {
      this.helper.send({ type: "stop" });
      this.phase = { name: "transcribing", target: phase.target, text: phase.text };
      this.ui.show({ kind: "transcribing" });
    } else if (phase.name === "waiting") {
      this.settle();
    }
  }

  private cancel(): void {
    this.clearTimers();
    const phase = this.phase;
    if (phase.name === "listening") {
      this.helper.send({ type: "cancel" });
      phase.text.update("");
    }
    this.settle();
  }

  /** Something went wrong mid-dictation. Live words already shown stay, for the person to keep or delete. */
  private abandon(message: string): void {
    this.clearTimers();
    this.detector.end();
    if (this.phase.name !== "idle") this.settle();
    this.ui.notify(message, "error");
  }

  private receive(notice: HelperNotice): void {
    const phase = this.phase;
    switch (notice.type) {
      case "loading":
        if (phase.name === "waiting") this.ui.show({ kind: "loading", percent: this.loadingPercent() });
        break;
      case "ready":
        // Still holding after the models finished loading: start listening right away.
        if (phase.name === "waiting") this.listen(phase.target);
        break;
      case "listening":
        if (phase.name === "listening") {
          phase.micOpen = true;
          this.render();
        }
        break;
      case "keyReleased":
        if (phase.name === "listening") {
          this.trailingRepeatsUntil = Date.now() + TRAILING_REPEAT_MS;
          this.finish();
        }
        break;
      case "level":
        if (phase.name === "listening") {
          phase.levels.push(notice.level);
          if (phase.levels.length > METER_WIDTH) phase.levels.shift();
          this.render();
        }
        break;
      case "partial":
        if (phase.name === "listening" && this.options.livePreview) phase.text.update(notice.text);
        break;
      case "final":
        if (phase.name === "transcribing") this.deliver(phase.text, restoreQuestionMarks(notice.text));
        break;
      case "cancelled":
        break;
      case "error":
        if (notice.code === "bad_command" || notice.code === "invalid_state") break;
        if (phase.name === "listening" || phase.name === "transcribing") {
          this.abandon(describeError(notice.code, notice.message));
        } else {
          this.ui.notify(describeError(notice.code, notice.message), "error");
        }
        break;
      case "exit":
        if (phase.name === "listening" || phase.name === "transcribing" || phase.name === "waiting") {
          this.abandon(`Dictation stopped: ${notice.message}`);
        }
        break;
    }
  }

  private deliver(text: LiveText, transcript: string): void {
    text.update(transcript);
    this.settle();
    if (transcript === "") this.notice("Didn't catch that");
  }

  /** Ends a dictation and replays the keys typed while it finished. */
  private settle(): void {
    const phase = this.phase;
    this.phase = { name: "idle" };
    if (phase.name === "listening" || phase.name === "transcribing") phase.text.commit();
    this.ui.show({ kind: "hidden" });
    const keys = this.heldKeys;
    this.heldKeys = [];
    if (phase.name === "idle") return;
    for (const data of keys) phase.target.handleInput(data);
  }

  private loadingPercent(): number | undefined {
    const status = this.helper.status;
    return status.state === "loading" ? status.percent : undefined;
  }

  private render(): void {
    const phase = this.phase;
    if (phase.name !== "listening") return;
    this.ui.show({ kind: "listening", micOpen: phase.micOpen, startedAt: phase.startedAt, levels: phase.levels });
  }

  private notice(text: string): void {
    this.ui.show({ kind: "notice", text, tone: "muted" });
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      if (this.phase.name === "idle") this.ui.show({ kind: "hidden" });
    }, NOTICE_MS);
  }

  private armRelease(): void {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.finish(), this.options.timing.releaseMs);
  }

  private clearTimers(): void {
    clearTimeout(this.releaseTimer);
    clearTimeout(this.limitTimer);
    this.releaseTimer = this.limitTimer = undefined;
  }
}

function describeError(code: string, message: string): string {
  switch (code) {
    case "microphone_denied":
      return "Microphone access is off for this terminal. Turn it on in System Settings > Privacy & Security > Microphone, then restart the terminal.";
    case "microphone_unavailable":
      return `No microphone available: ${message}`;
    default:
      return `Dictation failed: ${message}`;
  }
}
