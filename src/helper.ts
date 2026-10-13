import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { type HelperCommand, type HelperEvent, PROTOCOL_VERSION, parseEvent, serializeCommand } from "./protocol.ts";

export const HELPER_NAME = "pi-hold-to-talk-helper";

export type HelperStatus =
  | { state: "loading"; percent: number | undefined }
  | { state: "ready"; streaming: boolean }
  | { state: "failed"; message: string };

/** Protocol events, plus `exit` when the process is gone for good. */
export type HelperNotice = HelperEvent | { type: "exit"; message: string };

/** What the dictation controller needs from a helper. */
export interface HelperLike {
  readonly status: HelperStatus;
  send(command: HelperCommand): void;
  onNotice(listener: (notice: HelperNotice) => void): () => void;
  /** Stops the helper. */
  dispose(): void;
}

/**
 * Where to look for the helper binary, in order: an explicit override, a local build
 * (`scripts/build-helper.sh` or `/hold-to-talk setup`), then the prebuilt copy shipped in the package.
 */
export function helperCandidates(packageRoot: string, override: string | null): string[] {
  if (override) return [override];
  return [path.join(packageRoot, "helper", ".build", "release", HELPER_NAME), path.join(packageRoot, "bin", HELPER_NAME)];
}

export function findHelper(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export interface HelperLaunch {
  binary: string;
  language: string;
  livePreview: boolean;
  previewChunkMs: number;
}

export function helperArguments(launch: HelperLaunch): string[] {
  const args = ["serve", "--language", launch.language, "--chunk-ms", String(launch.previewChunkMs)];
  if (!launch.livePreview) args.push("--no-streaming");
  return args;
}

/** Folds per-model download progress into one percentage that never moves backwards. */
export class LoadProgress {
  private readonly fractions = new Map<string, number>();
  private readonly expectedModels: number;

  constructor(expectedModels: number) {
    this.expectedModels = expectedModels;
  }

  update(model: string, fraction: number): number {
    this.fractions.set(model, Math.min(1, Math.max(0, fraction)));
    const total = [...this.fractions.values()].reduce((sum, value) => sum + value, 0);
    return Math.floor((total / Math.max(this.expectedModels, this.fractions.size)) * 100);
  }
}

/** A helper that could not be started; reports why. */
export class MissingHelper implements HelperLike {
  readonly status: HelperStatus;

  constructor(message: string) {
    this.status = { state: "failed", message };
  }

  send(): void {}

  onNotice(): () => void {
    return () => {};
  }

  dispose(): void {}
}

/** The native helper process, speaking JSON lines. Starts loading models immediately. */
export class HelperProcess implements HelperLike {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(notice: HelperNotice) => void>();
  private readonly progress: LoadProgress;
  private readonly killOnExit = () => this.child.kill();
  private currentStatus: HelperStatus = { state: "loading", percent: undefined };
  private lastFatal: string | undefined;
  private stderrTail = "";

  constructor(launch: HelperLaunch) {
    // The final model always loads; the streaming one only for the live preview.
    this.progress = new LoadProgress(launch.livePreview ? 2 : 1);
    this.child = spawn(launch.binary, helperArguments(launch), { stdio: "pipe" });
    process.once("exit", this.killOnExit);

    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      const event = parseEvent(line);
      if (event) this.receive(event);
    });
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    // Writes after the process died surface here; the exit handler reports the failure.
    this.child.stdin.on("error", () => {});
    this.child.once("error", (error) => this.fail(`could not start ${launch.binary}: ${error.message}`));
    this.child.once("exit", (code, signal) => this.fail(this.exitMessage(code, signal)));
  }

  get status(): HelperStatus {
    return this.currentStatus;
  }

  send(command: HelperCommand): void {
    if (this.child.stdin.writable) this.child.stdin.write(serializeCommand(command));
  }

  onNotice(listener: (notice: HelperNotice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    process.removeListener("exit", this.killOnExit);
    this.send({ type: "quit" });
    this.child.stdin.end();
    setTimeout(() => this.child.kill(), 1000).unref();
  }

  private receive(event: HelperEvent): void {
    switch (event.type) {
      case "loading":
        if (this.currentStatus.state === "loading") {
          this.currentStatus = { state: "loading", percent: this.progress.update(event.model, event.fraction) };
        }
        break;
      case "ready":
        if (event.protocolVersion !== PROTOCOL_VERSION) {
          this.lastFatal = `helper speaks protocol ${event.protocolVersion}, expected ${PROTOCOL_VERSION}. Rebuild it with /hold-to-talk setup.`;
          this.child.kill();
          return;
        }
        this.currentStatus = { state: "ready", streaming: event.streaming };
        break;
      case "error":
        if (event.fatal) this.lastFatal = event.message;
        break;
    }
    this.emit(event);
  }

  private fail(message: string): void {
    if (this.currentStatus.state === "failed") return;
    this.currentStatus = { state: "failed", message };
    process.removeListener("exit", this.killOnExit);
    this.emit({ type: "exit", message });
  }

  private exitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    if (this.lastFatal) return this.lastFatal;
    const detail = this.stderrTail.trim().split("\n").at(-1);
    const how = signal ? `was stopped (${signal})` : `exited with code ${code}`;
    return detail ? `speech helper ${how}: ${detail}` : `speech helper ${how}`;
  }

  private emit(notice: HelperNotice): void {
    for (const listener of this.listeners) listener(notice);
  }
}
