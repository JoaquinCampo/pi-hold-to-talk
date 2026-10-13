import { type DictationTarget, eraseSpacesBeforeCursor, insertDictation } from "./editor.ts";
import type { HelperLike, HelperNotice } from "./helper.ts";
import { HoldDetector, type HoldTiming } from "./hold-detector.ts";
import { classifyKey } from "./keys.ts";
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
  | { name: "polishing"; target: DictationTarget; raw: string };

const NOTICE_MS = 2500;
const consume = { consume: true } as const;

/**
 * Turns a held Space into dictation: listen while held, transcribe on release, optionally
 * polish, then insert at the cursor of the editor that had focus when the hold began.
 */
export class Dictation {
  enabled = true;
  private phase: Phase = { name: "idle" };
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
    const holding = this.detector.isHolding;
    if (!holding && (!this.enabled || this.phase.name !== "idle")) return undefined;
    const target = holding ? undefined : this.ui.focusedTarget();
    if (!holding && !target) return undefined;

    const verdict = this.detector.feed(classifyKey(data), Date.now());
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
        this.finish();
        return undefined;
    }
  }

  dispose(): void {
    this.unsubscribe();
    if (this.phase.name === "listening") this.helper.send({ type: "cancel" });
    this.clearTimers();
    this.detector.end();
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
      this.reset();
    }
  }

  private cancel(): void {
    this.clearTimers();
    if (this.phase.name === "listening") this.helper.send({ type: "cancel" });
    this.reset();
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
        if (notice.code === "bad_command") break;
        if (phase.name === "listening" || phase.name === "transcribing") {
          this.clearTimers();
          this.detector.end();
          this.reset();
        }
        if (notice.code !== "invalid_state") this.ui.notify(describeError(notice.code, notice.message), "error");
        break;
      case "exit":
        if (phase.name !== "idle" && phase.name !== "polishing") {
          this.clearTimers();
          this.detector.end();
          this.reset();
          this.ui.notify(`Dictation stopped: ${notice.message}`, "error");
        }
        break;
    }
  }

  private async deliver(target: DictationTarget, raw: string): Promise<void> {
    if (raw === "") {
      this.reset();
      this.notice("Didn't catch that");
      return;
    }
    let text = raw;
    if (this.options.polish) {
      this.phase = { name: "polishing", target, raw };
      this.ui.show({ kind: "polishing", text: raw });
      try {
        text = await this.options.polish(raw);
      } catch {
        // Polishing is a nicety: on failure or timeout the raw transcript goes in.
      }
    }
    insertDictation(target, text);
    this.reset();
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

  private reset(): void {
    this.phase = { name: "idle" };
    this.ui.show({ kind: "hidden" });
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
