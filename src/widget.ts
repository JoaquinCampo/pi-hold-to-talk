import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type View =
  | { kind: "hidden" }
  /** Space is held but the models are still loading. */
  | { kind: "loading"; percent: number | undefined }
  /** `live` turns true once the microphone is confirmed open. */
  | { kind: "listening"; live: boolean; startedAt: number; levels: readonly number[]; preview: string }
  | { kind: "transcribing" }
  | { kind: "polishing"; text: string }
  | { kind: "notice"; text: string; tone: "muted" | "error" };

type Painter = Pick<Theme, "fg">;

const BARS = "▁▂▃▄▅▆▇█";
export const METER_WIDTH = 8;

export function meter(levels: readonly number[]): string {
  const recent = levels.slice(-METER_WIDTH);
  const bars = recent.map((level) => BARS[Math.min(BARS.length - 1, Math.floor(level * BARS.length))]);
  return bars.join("").padStart(METER_WIDTH, BARS[0]);
}

export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The end of `text` that fits in `width` columns, marked with a leading ellipsis when cut. */
export function tail(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const chars = Array.from(text);
  let start = chars.length;
  while (start > 0 && visibleWidth(chars.slice(start - 1).join("")) <= width - 1) start--;
  return `…${chars.slice(start).join("")}`;
}

export function renderView(view: View, theme: Painter, width: number, now: number): string[] {
  const line = (text: string) => truncateToWidth(text, width);
  switch (view.kind) {
    case "hidden":
      return [];
    case "loading": {
      const progress = view.percent === undefined ? "" : ` ${view.percent}%`;
      return [line(`${theme.fg("accent", " ◌ ")}${theme.fg("muted", `Loading speech models${progress}…`)}`)];
    }
    case "listening": {
      const dot = theme.fg(view.live ? "error" : "dim", " ● ");
      const status = `${dot}${theme.fg("text", clock(now - view.startedAt))} ${theme.fg("accent", meter(view.levels))}`;
      const lines = [line(`${status}${theme.fg("dim", "  release Space to insert · Esc to cancel")}`)];
      if (view.preview) lines.push(line(`   ${theme.fg("muted", tail(view.preview, width - 4))}`));
      return lines;
    }
    case "transcribing":
      return [line(`${theme.fg("accent", " ◌ ")}${theme.fg("muted", "Transcribing…")}`)];
    case "polishing":
      return [line(`${theme.fg("accent", " ✎ ")}${theme.fg("muted", tail(view.text, width - 4))}`)];
    case "notice":
      return [line(`${theme.fg(view.tone === "error" ? "error" : "dim", " ○ ")}${theme.fg("muted", view.text)}`)];
  }
}

/**
 * One widget above the editor, installed for the whole session. It renders nothing while
 * hidden, and keeps a handle on the TUI so dictation can check what has keyboard focus.
 */
export class WidgetHost {
  static readonly KEY = "hold-to-talk";
  private view: View = { kind: "hidden" };
  private tui: TUI | undefined;
  private readonly ui: ExtensionUIContext;

  constructor(ui: ExtensionUIContext) {
    this.ui = ui;
    ui.setWidget(
      WidgetHost.KEY,
      (tui, theme): Component => {
        this.tui = tui;
        return { render: (width) => renderView(this.view, theme, width, Date.now()), invalidate: () => {} };
      },
      { placement: "aboveEditor" },
    );
  }

  /**
   * The component with keyboard focus, or undefined when an overlay is in front or focus
   * cannot be determined. `getFocusedComponent` is on Pi's TUI implementation but not on the
   * public interface in every version, hence the feature check.
   */
  focused(): Component | undefined {
    const tui = this.tui as (TUI & { getFocusedComponent?: () => Component | null }) | undefined;
    if (!tui || tui.hasOverlay()) return undefined;
    return tui.getFocusedComponent?.() ?? undefined;
  }

  show(view: View): void {
    this.view = view;
    this.tui?.requestRender();
  }

  dispose(): void {
    this.view = { kind: "hidden" };
    this.ui.setWidget(WidgetHost.KEY, undefined);
  }
}
