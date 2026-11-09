/**
 * The deterministic reading aids passage selection runs on (background-oil-research D4, D22).
 *
 * - **Narrowing (D4).** Only windows of ±{@link NARROW_WINDOW_LINES} lines around each line that
 *   names an oil keyword, an SAE grade or one of the identity's engine words are kept; windows
 *   that overlap merge, and each omitted span becomes one {@link ELISION} line. The words are the
 *   manual prefilter's (`manuals/locate-pages.ts`).
 * - **Anchors (D22).** A *grade line* names an SAE grade (`0W-30`, `0W30`, `0W 30`, `SAE 5W 40`).
 *   A *capacity anchor* names an oil quantity — `quantidade de óleo`, `capacidade de óleo` or
 *   `volume de óleo`, any case, accents or not — or is a heading beginning `Capacidades`, AND has
 *   a figure in liters on that line or the next one of the same page. The anchor is narrow on
 *   purpose: on the Gol's located pages a capacity word or a liters figure alone matched seven
 *   decoys on pp. 239–240 (the sump, a top-up of 0,5 l, a cross-reference to the capacities
 *   page), and none of them is the capacities row.
 */

/** Lines kept on each side of a hit, and the width of a completion window (D4, D22). */
export const NARROW_WINDOW_LINES = 12;

/** The line that marks an omitted span. */
export const ELISION = "[…]";

/** The narrowed text's cap, when `OIL_SELECTOR_MAX_CHARS` is unset (D4). */
export const OIL_SELECTOR_DEFAULT_MAX_CHARS = 12_000;

/** @returns `OIL_SELECTOR_MAX_CHARS`, else its default. */
export function selectorMaxChars(): number {
  const raw = Number(process.env.OIL_SELECTOR_MAX_CHARS);
  return Number.isInteger(raw) && raw > 0 ? raw : OIL_SELECTOR_DEFAULT_MAX_CHARS;
}

/** Lowercase, accents off: "Óleo" and "oleo" are one word. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** What a capacities table says, folded (the manual prefilter's words). */
export const OIL_KEYWORDS = ["oleo", "lubrificante", "capacidade", "litros", "sae", "viscosidade", "com filtro", "sem filtro", "carter"];

/** An SAE grade written out, for scoring and narrowing: 5W-40, 0W20, 10w-30. */
export const SAE_GRADE_WORD = /\b\d{1,2}w-?\d{2}\b/g;

/** A grade line (D22): with or without a hyphen or a space, `SAE` before it or not. */
const GRADE_LINE = /(?<!\d)\d{1,2}\s?w[\s-]?\d{2}(?!\d)/i;

/** @returns Whether a line names an SAE grade. */
export function isGradeLine(line: string): boolean {
  return GRADE_LINE.test(line);
}

const OIL_QUANTITY = /\b(?:quantidade|capacidade|volume) de oleo\b/;
const CAPACITIES_HEADING = /^\s*capacidades\b/;
const LITERS = /(?<![\d.,])\d+(?:[.,]\d+)?\s*(?:l|litros?)\b/;
const LITERS_ALL = new RegExp(LITERS.source, "g");

/** @returns Whether a line opens a capacities heading (`Capacidades`, any case, accents or not). */
export function isCapacitiesHeading(line: string): boolean {
  return CAPACITIES_HEADING.test(fold(line));
}

/** A condition written after a figure: one engine's volume with or without the filter, or dry. */
const CONDITION_AFTER = /^\s*\(?\s*(?:com filtro|sem filtro|seco)\b/;
/** A figure glued to a single `l` with one decimal, "1.6l": an engine size, not a volume. */
const GLUED_DISPLACEMENT = /^\d[.,]\dl$/;
/** A figure with one decimal and a single `l`, "1,0 l": an engine size when an engine word leads it. */
const SPACED_DISPLACEMENT = /^\d[.,]\d\s+l$/;
const ENGINE_WORD_BEFORE = /\b(?:motor|motorizacao|engine|cilindrada)\s*$/;

/**
 * @returns How many figures in liters a line holds, as columns: two or more on a capacities row
 *   mean a row with one column per engine (the Gol's "3,3 litros 4 litros 4,5 litros"), which is
 *   read only with the column heads above it (D22). Not counted (review of #190): a figure
 *   followed by "com filtro", "sem filtro" or "seco" (one engine, two conditions), and an engine
 *   size — "1.6L" glued, or "1,0 l" after an engine word.
 */
export function litersFigures(line: string): number {
  const folded = fold(line);
  let count = 0;
  for (const match of folded.matchAll(LITERS_ALL)) {
    const at = match.index;
    if (CONDITION_AFTER.test(folded.slice(at + match[0].length))) continue;
    const figure = match[0];
    if (GLUED_DISPLACEMENT.test(figure)) continue;
    if (SPACED_DISPLACEMENT.test(figure) && ENGINE_WORD_BEFORE.test(folded.slice(0, at))) continue;
    count += 1;
  }
  return count;
}

/**
 * The capacity anchors of a text: each line that names an oil quantity or opens a capacities
 * heading, with its liters on it or on the next line of the same page.
 *
 * @param lines - The text's lines.
 * @param lineToPage - The page of each line; absent, the text is one page.
 * @returns For each anchor, its line and the line its liters are on.
 */
export function capacityAnchors(lines: readonly string[], lineToPage?: readonly number[]): { line: number; litersLine: number }[] {
  const anchors: { line: number; litersLine: number }[] = [];
  lines.forEach((line, index) => {
    const folded = fold(line);
    if (!OIL_QUANTITY.test(folded) && !CAPACITIES_HEADING.test(folded)) return;
    if (LITERS.test(folded)) {
      anchors.push({ line: index, litersLine: index });
      return;
    }
    const next = index + 1;
    const samePage = !lineToPage || lineToPage[next] === lineToPage[index];
    if (next < lines.length && samePage && LITERS.test(fold(lines[next]!))) {
      anchors.push({ line: index, litersLine: next });
    }
  });
  return anchors;
}

/** @returns Whether a line names an oil keyword, an SAE grade or an engine word. */
export function isOilLine(line: string, engineWords: readonly string[]): boolean {
  const folded = fold(line);
  SAE_GRADE_WORD.lastIndex = 0;
  return (
    OIL_KEYWORDS.some((keyword) => folded.includes(keyword)) ||
    SAE_GRADE_WORD.test(folded) ||
    engineWords.some((word) => folded.includes(word))
  );
}

/** A span of lines, 0-based, `to` exclusive. */
export type LineSpan = { from: number; to: number };

/**
 * The windows of a text: ±{@link NARROW_WINDOW_LINES} lines around each oil line, merged, in
 * line order.
 *
 * @returns The spans kept; empty when no line names oil, a grade or an engine word.
 */
export function oilWindows(lines: readonly string[], engineWords: readonly string[]): LineSpan[] {
  const spans: LineSpan[] = [];
  lines.forEach((line, index) => {
    if (!isOilLine(line, engineWords)) return;
    spans.push({ from: Math.max(0, index - NARROW_WINDOW_LINES), to: Math.min(lines.length, index + NARROW_WINDOW_LINES + 1) });
  });
  return mergeSpans(spans);
}

/**
 * Merges spans that overlap or touch, in line order.
 *
 * @returns New spans, sorted by `from`.
 */
export function mergeSpans(spans: readonly LineSpan[]): LineSpan[] {
  const sorted = [...spans].filter((span) => span.to > span.from).sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: LineSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * The text of spans, each verbatim, in line order, with one {@link ELISION} line between two
 * spans that do not touch.
 */
export function joinSpans(lines: readonly string[], spans: readonly LineSpan[]): string {
  const parts: string[] = [];
  mergeSpans(spans).forEach((span, index) => {
    if (index > 0) parts.push(ELISION);
    parts.push(...lines.slice(span.from, span.to));
  });
  return parts.join("\n");
}
