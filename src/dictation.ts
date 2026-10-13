import { type DictationTarget, eraseSpacesBeforeCursor, insertDictation } from "./editor.ts";
import type { HelperLike, HelperNotice } from "./helper.ts";
import { HoldDetector, type HoldTiming } from "./hold-detector.ts";
import { classifyKey, type KeyEvent } from "./keys.ts";
import { METER_WIDTH, type View } from "./widget.ts";

export interface DictationUI {
  show(view: View): void;
  notify(message: string, type: "info" | "warning" | "error"): void;
  /** The editor with keyboard focus, or undefined when something else (a dialog, an overlay) has it. */
  focusedTarget(): DictationTarget | undefined;
}

export interface DictationOptions {
  timing: HoldTiming;
  maxSeconds: number;
  /** Tidies a transcript. Undefined inserts transcripts as they are. */
  polish: ((raw: string) => Promise<string>) | undefined;
}

type Phase =
  | { name: "idle" }
  /** Space is held but the helper cannot listen yet; released without recording. */
  | { name: "waiting"; target: DictationTarget }
  | { name: "listening"; target: DictationTarget; live: boolean; startedAt: number; levels: number[]; preview: string }
  | { name: "transcribing"; target: DictationTarget }
  | { name: "polishing"; target: DictationTarget };

const NOTICE_MS = 2500;
const consume = { consume: true } as const;

/**
 * Turns a held Space into dictation: listen while held, transcribe on release, optionally
 * polish, then insert at the cursor of the editor that had focus when the hold began.
 *
 * Keys typed between the end of a hold and the insertion (most often Enter, to send the
 * prompt) are held back and replayed after the text lands, so they act on the full prompt.
 */
export class Dictation {
  enabled = true;
  private phase: Phase = { name: "idle" };
  /** Raw input held back while the transcript is on its way. */
  private heldKeys: string[] = [];
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
    if (this.phase.name === "transcribing" || this.phase.name === "polishing") {
      return this.whileBusy(this.phase.target, data, key);
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
    this.clearTimers();
    this.detector.end();
    this.heldKeys = [];
    this.phase = { name: "idle" };
    this.ui.show({ kind: "hidden" });
  }

  /** Between release and insertion: Escape drops the dictation, other keys wait for it. */
  private whileBusy(target: DictationTarget, data: string, key: KeyEvent): { consume: true } | undefined {
    if (key.phase === "release") return undefined;
    if (key.key === "escape") this.settle(target, undefined);
    else this.heldKeys.push(data);
    return consume;
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
    this.phase = { name: "listening", target, live: false, startedAt: Date.now(), levels: [], preview: "" };
    this.render();
  }

  /** The key was let go, another key was pressed, or the time limit hit. */
  private finish(): void {
    this.clearTimers();
    this.detector.end();
    if (this.phase.name === "listening") {
      this.helper.send({ type: "stop" });
      this.phase = { name: "transcribing", target: this.phase.target };
      this.ui.show({ kind: "transcribing" });
    } else if (this.phase.name === "waiting") {
      this.settle(this.phase.target, undefined);
    }
  }

  private cancel(): void {
    this.clearTimers();
    if (this.phase.name === "listening") this.helper.send({ type: "cancel" });
    if (this.phase.name === "listening" || this.phase.name === "waiting") this.settle(this.phase.target, undefined);
  }

  /** Something went wrong mid-dictation: drop it, keep what the user typed. */
  private abandon(message: string): void {
    this.clearTimers();
    this.detector.end();
    const phase = this.phase;
    if (phase.name === "listening" || phase.name === "transcribing" || phase.name === "waiting") {
      this.settle(phase.target, undefined);
    }
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
          phase.live = true;
          this.render();
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
        if (phase.name === "listening") {
          phase.preview = notice.text;
          this.render();
        }
        break;
      case "final":
        if (phase.name === "transcribing") void this.deliver(phase.target, notice.text);
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

  private async deliver(target: DictationTarget, raw: string): Promise<void> {
    if (raw === "") {
      this.settle(target, undefined);
      this.notice("Didn't catch that");
      return;
    }
    if (!this.options.polish) return this.settle(target, raw);

    const phase: Phase = { name: "polishing", target };
    this.phase = phase;
    this.ui.show({ kind: "polishing", text: raw });
    let text = raw;
    try {
      text = await this.options.polish(raw);
    } catch {
      // Polishing is a nicety: on failure or timeout the raw transcript goes in.
    }
    // Escape while polishing already settled this dictation.
    if (this.phase === phase) this.settle(target, text);
  }

  /** Ends a dictation: inserts `text` if any, then replays the keys typed while waiting for it. */
  private settle(target: DictationTarget, text: string | undefined): void {
    this.phase = { name: "idle" };
    this.ui.show({ kind: "hidden" });
    if (text !== undefined) insertDictation(target, text);
    const keys = this.heldKeys;
    this.heldKeys = [];
    for (const data of keys) target.handleInput(data);
  }

  private loadingPercent(): number | undefined {
    const status = this.helper.status;
    return status.state === "loading" ? status.percent : undefined;
  }

  private render(): void {
    const phase = this.phase;
    if (phase.name !== "listening") return;
    this.ui.show({
      kind: "listening",
      live: phase.live,
      startedAt: phase.startedAt,
      levels: phase.levels,
      preview: phase.preview,
    });
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
