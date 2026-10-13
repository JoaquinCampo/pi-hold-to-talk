import { CURSOR_MARKER } from "@earendil-works/pi-tui";

const ESC = "\x1b";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isVisible = (grapheme: string) => !/^\s+$/.test(grapheme);

interface Span {
  row: number;
  start: number;
  end: number;
}

/**
 * Paints `text` where it ends at the cursor in an editor's rendered lines.
 *
 * The editor marks the cursor with `CURSOR_MARKER`. Walking back from it, visible graphemes
 * are matched against `text`, so wrapping (which may drop a space at the break) does not
 * shift the span. Matching stops at a styled line, such as the editor's border, or at a line
 * that does not continue the text, which means the rest has scrolled out of view.
 * Anything unexpected on the cursor's own line leaves the lines unchanged.
 */
export function dimBeforeCursor(lines: readonly string[], text: string, paint: (text: string) => string): string[] {
  const out = [...lines];
  const wanted = Array.from(graphemes.segment(text), (part) => part.segment).filter(isVisible);
  const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  if (cursorRow === -1) return out;

  const spans: Span[] = [];
  let remaining = wanted.length;
  rows: for (let row = cursorRow; row >= 0 && remaining > 0; row--) {
    const line = lines[row] ?? "";
    const region = row === cursorRow ? line.slice(0, line.indexOf(CURSOR_MARKER)) : line;
    if (region.includes(ESC)) {
      if (row === cursorRow) return out;
      break;
    }
    const parts = [...graphemes.segment(region)];
    let start = -1;
    let end = -1;
    for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
      const { segment, index } = parts[i] ?? { segment: "", index: 0 };
      if (!isVisible(segment)) continue;
      if (segment !== wanted[remaining - 1]) {
        if (row !== cursorRow && end === -1) break rows;
        return [...lines];
      }
      if (end === -1) end = index + segment.length;
      start = index;
      remaining--;
    }
    if (end !== -1) spans.push({ row, start, end });
  }

  for (const { row, start, end } of spans) {
    const line = out[row] ?? "";
    out[row] = line.slice(0, start) + paint(line.slice(start, end)) + line.slice(end);
  }
  return out;
}
