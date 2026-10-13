import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type HoldToTalkConfig, loadConfig, parseModelRef } from "./config.ts";
import { Dictation } from "./dictation.ts";
import { asDictationTarget } from "./editor.ts";
import { findHelper, HELPER_NAME, type HelperLike, HelperProcess, helperCandidates, MissingHelper } from "./helper.ts";
import { type HoldTiming, holdTiming } from "./hold-detector.ts";
import { polishTranscript } from "./polish.ts";
import { WidgetHost } from "./widget.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = "hold-to-talk.json";
const USAGE = "Usage: /hold-to-talk [on|off|status|setup]";

export default function holdToTalk(pi: ExtensionAPI): void {
  const configFile = path.join(getAgentDir(), CONFIG_FILE);
  const { config, problems } = loadConfig(configFile);
  const timing = readKeyRepeat().then(([keyRepeat, initial]) => holdTiming(keyRepeat, initial));
  let enabled = config.enabled && process.platform === "darwin";
  // One helper per Pi process, started by the first interactive session and kept across /new and /resume.
  let helper: (HelperLike & { dispose?(): void }) | undefined;
  let session: { dictation: Dictation; dispose(): void } | undefined;
  let warned = false;

  const startHelper = (): HelperLike => {
    const binary = findHelper(helperCandidates(PACKAGE_ROOT, config.helperPath));
    helper = binary
      ? new HelperProcess({ binary, ...config })
      : new MissingHelper("The speech helper is not installed. Run /hold-to-talk setup.");
    return helper;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || process.platform !== "darwin") return;
    session?.dispose();
    if (!warned) {
      warned = true;
      for (const problem of problems) ctx.ui.notify(`hold-to-talk: ${problem} (${configFile})`, "warning");
    }
    session = attach(ctx, helper ?? startHelper(), config, await timing);
    session.dictation.enabled = enabled;
  });

  pi.on("session_shutdown", () => {
    session?.dispose();
    session = undefined;
  });

  pi.registerCommand("hold-to-talk", {
    description: "Hold Space to dictate. /hold-to-talk on|off|status|setup",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      switch (action) {
        case "on":
        case "off":
          enabled = action === "on";
          if (session) session.dictation.enabled = enabled;
          ctx.ui.notify(enabled ? "Dictation on: hold Space to talk" : "Dictation off", "info");
          return;
        case "":
        case "status":
          ctx.ui.notify(describeStatus(enabled, helper, config, configFile), "info");
          return;
        case "setup":
          await setup(ctx, () => {
            helper?.dispose?.();
            const fresh = startHelper();
            if (session) {
              session.dispose();
              session = undefined;
            }
            return fresh;
          });
          return;
        default:
          ctx.ui.notify(USAGE, "warning");
      }
    },
  });
}

/** Wires dictation into one interactive session. */
function attach(ctx: ExtensionContext, helper: HelperLike, config: HoldToTalkConfig, timing: HoldTiming) {
  const widget = new WidgetHost(ctx.ui);
  const dictation = new Dictation(
    helper,
    {
      show: (view) => widget.show(view),
      notify: (message, type) => ctx.ui.notify(message, type),
      focusedTarget: () => asDictationTarget(widget.focused()),
    },
    { timing, maxSeconds: config.maxSeconds, polish: polisher(ctx, config) },
  );
  const log = debugLog();
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    log?.(data);
    return dictation.handleInput(data);
  });
  return {
    dictation,
    dispose() {
      unsubscribe();
      dictation.dispose();
      widget.dispose();
    },
  };
}

function polisher(ctx: ExtensionContext, config: HoldToTalkConfig): ((raw: string) => Promise<string>) | undefined {
  const ref = config.polishModel ? parseModelRef(config.polishModel) : undefined;
  if (!ref) return undefined;
  let reported = false;
  return async (raw) => {
    const model = ctx.modelRegistry.find(ref.provider, ref.id);
    if (!model) {
      if (!reported) ctx.ui.notify(`hold-to-talk: polish model ${config.polishModel} is not available; inserting raw text`, "warning");
      reported = true;
      return raw;
    }
    return polishTranscript(ctx.modelRegistry, model, raw, config.vocabulary, config.polishTimeoutMs);
  };
}

/** Builds the helper from source with SwiftPM, then restarts it. */
async function setup(ctx: ExtensionContext, restart: () => HelperLike): Promise<void> {
  ctx.ui.notify("hold-to-talk: building the speech helper (a few minutes the first time)…", "info");
  const result = await run("swift", ["build", "-c", "release", "--package-path", path.join(PACKAGE_ROOT, "helper")]);
  if (!result.ok) {
    const hint = result.missing ? "Install the Xcode command line tools with `xcode-select --install`." : result.output;
    ctx.ui.notify(`hold-to-talk: build failed. ${hint}`, "error");
    return;
  }
  restart();
  ctx.ui.notify("hold-to-talk: helper built. Models download on first use (about 1.5 GB). Start a new session or /reload to dictate.", "info");
}

function run(command: string, args: string[]): Promise<{ ok: boolean; missing: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, missing: error.code === "ENOENT", output: error.message }));
    child.once("close", (code) => resolve({ ok: code === 0, missing: false, output: lastLines(output, 5) }));
  });
}

function describeStatus(enabled: boolean, helper: HelperLike | undefined, config: HoldToTalkConfig, configFile: string): string {
  const status = helper?.status;
  const state = !status
    ? "not started (opens with the first interactive session)"
    : status.state === "ready"
      ? `ready${status.streaming ? "" : ", no live preview"}`
      : status.state === "loading"
        ? `loading models${status.percent === undefined ? "" : ` ${status.percent}%`}`
        : status.message;
  const binary = findHelper(helperCandidates(PACKAGE_ROOT, config.helperPath)) ?? `${HELPER_NAME} not found`;
  return [
    `Dictation ${enabled ? "on" : "off"} · helper ${state}`,
    `Language ${config.language} · polish ${config.polishModel ?? "off"} · live preview ${config.livePreview ? "on" : "off"}`,
    `Helper ${binary}`,
    `Settings ${configFile}`,
  ].join("\n");
}

/** macOS key repeat settings, in 15 ms units. Undefined when unset (system defaults apply). */
function readKeyRepeat(): Promise<[number | undefined, number | undefined]> {
  const read = (key: string) =>
    new Promise<number | undefined>((resolve) => {
      execFile("defaults", ["read", "-g", key], { timeout: 2000 }, (error, stdout) => {
        const value = Number.parseInt(stdout, 10);
        resolve(error || Number.isNaN(value) ? undefined : value);
      });
    });
  return Promise.all([read("KeyRepeat"), read("InitialKeyRepeat")]);
}

/** Set PI_HOLD_TO_TALK_DEBUG=1 to record raw key input, for diagnosing how a terminal reports keys. */
function debugLog(): ((data: string) => void) | undefined {
  if (!process.env.PI_HOLD_TO_TALK_DEBUG) return undefined;
  const file = path.join(os.tmpdir(), "pi-hold-to-talk-input.log");
  return (data) => fs.appendFile(file, `${Date.now()} ${JSON.stringify(data)}\n`, () => {});
}

function lastLines(text: string, count: number): string {
  return text.trim().split("\n").slice(-count).join("\n");
}
