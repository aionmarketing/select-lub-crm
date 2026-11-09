/**
 * Chooses the parts of a text that are about this vehicle's engine oil, before the extractor
 * reads them (oil-spec-web-search: "the passage handed to the extractor SHALL be the part of the
 * page about the resolved vehicle, not the whole page"; background-oil-research D4, D22).
 *
 * The model answers with LINE RANGES, not a rewritten passage: the excerpt stored on the cache
 * row must be verbatim text for an audit to mean anything, and a range cannot be paraphrased.
 *
 * - **Narrowed input (D4).** A long web page is narrowed to its oil windows before the model
 *   sees it, each kept line under its original number; the ranges are validated against, and
 *   sliced from, the original page. A page with no hit is sent capped, as before. A manual's
 *   located pages arrive already narrowed (`manuals/locate-pages.ts`), with their page layout.
 * - **Several ranges (D22).** Up to `OIL_SELECTOR_MAX_RANGES`, because the grades and the
 *   capacities are often in different tables or on different pages, and one range never held
 *   both in the benchmark. Each is validated on its own; an invalid one is dropped and logged.
 * - **Completed in code (D22).** When the ranges miss the grade lines, or the capacity anchors,
 *   that the text holds, windows around them are added — each clipped to its anchor's page —
 *   with no model call. Nothing is added that the text does not hold.
 *
 * The passage is the spans, each verbatim, in line order, joined by one `[…]` line; the stored
 * excerpt is that same text. A failed selection (no valid range, an unusable reply, a failed or
 * aborted call) is `unavailable`, and the extractor reads the narrowed text.
 */
import type { RetrievedSource } from "./oil-spec.js";
import { parseJsonReply } from "./spec-extractor.js";
import type { VehicleIdentity } from "../store/store.js";
import { engineWords } from "../manuals/locate-pages.js";
import { callPlumbing, resolveCall, type ModelPortOptions } from "../model-calls/ports.js";
import { streamModelCall } from "../model-calls/stream-call.js";
import {
  capacityAnchors,
  ELISION,
  isCapacitiesHeading,
  isGradeLine,
  litersFigures,
  joinSpans,
  mergeSpans,
  NARROW_WINDOW_LINES,
  oilWindows,
  selectorMaxChars,
  type LineSpan,
} from "./narrow-text.js";

export type { LineSpan } from "./narrow-text.js";

/**
 * What the selector decided.
 *
 * `none` is a real answer — the text carries nothing about this vehicle's oil — and stops the
 * extractor from reading it at all. `unavailable` is the selector failing; `fallback`, when set,
 * is the narrowed text the extractor reads instead of the source as it came.
 */
export type PassageSelection =
  | {
      status: "selected";
      source: RetrievedSource;
      /**
       * The spans of the source text the passage is, 0-based, `to` exclusive, margin and
       * completion included, in line order. A caller that maps lines back to pages reads them
       * rather than searching the text.
       */
      lines?: LineSpan[];
    }
  | { status: "none" }
  | { status: "unavailable"; fallback?: RetrievedSource };

/** How a text is laid out: the page each line is on, for a manual's joined pages. */
export type PassageLayout = { lineToPage?: readonly number[] };

/** Narrows a text source to the passage about the vehicle, or says there is none. */
export type PassageSelector = (
  source: RetrievedSource,
  identity: VehicleIdentity,
  layout?: PassageLayout,
) => Promise<PassageSelection>;

/**
 * Texts at or under this many characters are handed over whole. Selecting inside a page the
 * extractor could read in one go is a model call for nothing.
 */
export const PASSAGE_SHORT_PAGE_CHARS = 3_000;

/** Lines kept on each side of a chosen range, so a table keeps its header and unit line. */
export const PASSAGE_MARGIN_LINES = 3;

/** Ranges the model may answer, when `OIL_SELECTOR_MAX_RANGES` is unset (D22). */
export const OIL_SELECTOR_DEFAULT_MAX_RANGES = 4;

/** @returns `OIL_SELECTOR_MAX_RANGES`, else its default. */
export function selectorMaxRanges(): number {
  const raw = Number(process.env.OIL_SELECTOR_MAX_RANGES);
  return Number.isInteger(raw) && raw > 0 ? raw : OIL_SELECTOR_DEFAULT_MAX_RANGES;
}

/** The selector's instructions, for up to `maxRanges` ranges. */
export function passageSystemPrompt(maxRanges: number = selectorMaxRanges()): string {
  return (
    "Você recebe o texto de um documento — uma página da web ou páginas de um manual — com as " +
    "linhas numeradas, e a identidade de UM veículo. Sua única tarefa é localizar os trechos que " +
    "falam do ÓLEO DO MOTOR desse veículo ou desse motor: as viscosidades SAE (por exemplo 0W-20, " +
    "5W-30) e a capacidade de óleo em litros. As viscosidades e as capacidades costumam estar em " +
    "tabelas diferentes ou em páginas diferentes: coloque cada uma no seu próprio intervalo. " +
    `Linhas "${ELISION}" marcam texto omitido. ` +
    `Responda APENAS com JSON no formato {"ranges": [{"startLine": n, "endLine": n}]}, com até ${maxRanges} ` +
    "intervalos, cada um o menor que contém o seu trecho, ou {\"none\": true} se o texto não traz " +
    "essa informação para esse veículo. NÃO resuma, NÃO copie o texto, NÃO invente números: só as linhas."
  );
}

/** Prefixes each line with its 1-based number so the model can point at a range. */
export function numberLines(text: string): string {
  return text
    .split("\n")
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
}

/**
 * Validates a model-proposed range against the text and slices it, with a margin.
 *
 * @returns The passage, or `null` when the range is not one this text has.
 */
export function sliceRange(
  text: string,
  range: { startLine: number; endLine: number },
  margin = PASSAGE_MARGIN_LINES,
): string | null {
  const span = rangeLines(text, range, margin);
  return span === null ? null : text.split("\n").slice(span.from, span.to).join("\n");
}

/**
 * The lines a 1-based, inclusive range covers once the margin is added: 0-based, `to` exclusive.
 *
 * @returns The span, or `null` for a range the text does not have.
 */
export function rangeLines(
  text: string,
  range: { startLine: number; endLine: number },
  margin = PASSAGE_MARGIN_LINES,
): LineSpan | null {
  const count = text.split("\n").length;
  const { startLine, endLine } = range;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > count) {
    return null;
  }
  return { from: Math.max(0, startLine - 1 - margin), to: Math.min(count, endLine + margin) };
}

/** A range as the model wrote it. */
export type ProposedRange = { startLine: number; endLine: number };

/**
 * Reads the selector's reply: ranges, `none`, or nothing usable. The old single-object reply
 * `{"startLine", "endLine"}` is read as one range. A `ranges` entry that is not a pair of numbers
 * is dropped. Past `maxRanges`, the first ones are kept.
 *
 * @returns `{ none: true }`, the ranges, or `null` for an unparseable reply.
 */
export function parseSelection(
  reply: string,
  maxRanges: number = selectorMaxRanges(),
): { none: true } | { ranges: ProposedRange[] } | null {
  // parseJsonReply THROWS on a reply with no JSON object in it — the extractor treats that as
  // one of its retryable failures. Here prose is simply "no usable answer".
  let parsed: { none?: unknown; startLine?: unknown; endLine?: unknown; ranges?: unknown } | null;
  try {
    parsed = parseJsonReply(reply) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") {
    return null;
  }
  if (parsed.none === true) {
    return { none: true };
  }
  const isRange = (value: unknown): value is ProposedRange => {
    const entry = value as { startLine?: unknown; endLine?: unknown } | null;
    return typeof entry?.startLine === "number" && typeof entry.endLine === "number";
  };
  if (Array.isArray(parsed.ranges)) {
    const ranges = parsed.ranges.filter(isRange).map(({ startLine, endLine }) => ({ startLine, endLine }));
    return { ranges: ranges.slice(0, maxRanges) };
  }
  if (isRange(parsed)) {
    return { ranges: [{ startLine: parsed.startLine, endLine: parsed.endLine }] };
  }
  return null;
}

/**
 * Builds a narrowed copy of the source. Both the text the extractor reads and the excerpt the
 * cache row keeps become the passage — one string, verbatim.
 */
export function narrow(source: RetrievedSource, passage: string): RetrievedSource {
  return { ...source, excerpt: passage, content: { kind: "text", text: passage } };
}

/** The first and last line (exclusive) of the page line `index` is on. */
function pageBounds(index: number, count: number, lineToPage?: readonly number[]): LineSpan {
  if (!lineToPage) return { from: 0, to: count };
  const page = lineToPage[index];
  let from = index;
  while (from > 0 && lineToPage[from - 1] === page) from -= 1;
  let to = index + 1;
  while (to < count && lineToPage[to] === page) to += 1;
  return { from, to };
}

/**
 * A model's range as the span of lines it selects, or `null` when it is not a range the model
 * could have meant (review of #184):
 * - on a narrowed web page, both ends must be lines the model was shown (`shown`), and the
 *   margin stays inside the windows those ends are in — a range ending on a line it never saw
 *   is a wrong answer, however valid a line number of the original page it is;
 * - on a manual's joined pages, the margin stays on the pages of the range's own ends, so a
 *   range at the top of a page does not pull the previous page's last lines into the citation.
 *
 * @param text - The text the ranges index into.
 * @param range - 1-based, inclusive, as the model wrote it.
 * @param lineToPage - The page of each line, for a manual.
 * @param shown - The windows of a narrowed web page.
 */
export function selectedSpan(
  text: string,
  range: ProposedRange,
  lineToPage?: readonly number[],
  shown?: readonly LineSpan[],
): LineSpan | null {
  const span = rangeLines(text, range);
  if (span == null) return null;
  const start = range.startLine - 1;
  const end = range.endLine - 1;
  let { from, to } = span;
  if (shown) {
    const windowOf = (index: number) => shown.find((window) => window.from <= index && index < window.to);
    const first = windowOf(start);
    const last = windowOf(end);
    if (!first || !last) return null;
    from = Math.max(from, first.from);
    to = Math.min(to, last.to);
  }
  if (lineToPage) {
    const count = text.split("\n").length;
    from = Math.max(from, pageBounds(start, count, lineToPage).from);
    to = Math.min(to, pageBounds(end, count, lineToPage).to);
  }
  return { from, to };
}

/** A ±{@link NARROW_WINDOW_LINES} window around a line, clipped to its page. */
function windowOnPage(index: number, count: number, lineToPage?: readonly number[]): LineSpan {
  const page = pageBounds(index, count, lineToPage);
  return { from: Math.max(page.from, index - NARROW_WINDOW_LINES), to: Math.min(page.to, index + NARROW_WINDOW_LINES + 1) };
}

/** How far above a capacities row its table's heading is looked for: two completion windows. */
export const TABLE_HEADING_REACH_LINES = 2 * NARROW_WINDOW_LINES;

/**
 * The first line of the table a capacities row at `index` is in: the nearest `Capacidades`
 * heading above it on its page, within {@link TABLE_HEADING_REACH_LINES}; else the top of its
 * completion window. On a narrowed web page it never leaves the window the row was shown in.
 */
function tableTop(lines: readonly string[], index: number, lineToPage?: readonly number[], shown?: readonly LineSpan[]): number {
  const page = pageBounds(index, lines.length, lineToPage);
  const window = shown?.find((span) => span.from <= index && index < span.to);
  const floor = Math.max(page.from, window?.from ?? 0, index - TABLE_HEADING_REACH_LINES);
  for (let line = index - 1; line >= floor; line -= 1) {
    if (isCapacitiesHeading(lines[line]!)) return line;
  }
  return Math.max(windowOnPage(index, lines.length, lineToPage).from, window?.from ?? 0);
}

/**
 * Completes the model's spans so they hold a grade line and a capacity anchor whenever the text
 * holds one of each (D22): for each kind the spans miss, windows around that kind's lines are
 * added, each clipped to its line's page. A held capacities row with one column per engine also
 * keeps its table from the heading down, so its column heads reach the extractor. No model call.
 *
 * @param lines - The text the spans index into.
 * @param spans - The model's spans, margin included.
 * @param lineToPage - The page of each line; absent, the text is one page.
 * @param shown - The spans the model was shown (a narrowed web page); absent, every line. Only
 *   lines in them are anchors, so the passage never leaves the narrowed text.
 * @returns The merged spans, in line order.
 */
export function completeSpans(
  lines: readonly string[],
  spans: readonly LineSpan[],
  lineToPage?: readonly number[],
  shown?: readonly LineSpan[],
): LineSpan[] {
  const within = (set: readonly LineSpan[]) => (index: number) => set.some((span) => span.from <= index && index < span.to);
  const holds = within(spans);
  const eligible = shown ? within(shown) : () => true;
  const grades = lines.flatMap((line, index) => (eligible(index) && isGradeLine(line) ? [index] : []));
  const anchors = capacityAnchors(lines, lineToPage).filter((anchor) => eligible(anchor.line));
  const added: LineSpan[] = [];
  if (grades.length > 0 && !grades.some(holds)) {
    grades.forEach((index) => added.push(windowOnPage(index, lines.length, lineToPage)));
  }
  if (anchors.length > 0 && !anchors.some((anchor) => holds(anchor.line) && holds(anchor.litersLine))) {
    anchors.forEach((anchor) => {
      const around = windowOnPage(anchor.line, lines.length, lineToPage);
      added.push({ from: around.from, to: Math.max(around.to, anchor.litersLine + 1) });
    });
  }
  const merged = mergeSpans([...spans, ...added]);
  // A capacities row with one column per engine is read by its column heads (D5), which sit
  // above it in the table: the row alone gives the extractor figures it cannot assign to an
  // engine. So a held row with two or more figures in liters keeps its table from the top
  // (task 1.13, 2026-09-27: the Gol 2021 manual's heads are 12 lines above its row).
  const inMerged = within(merged);
  const tables: LineSpan[] = [];
  for (const anchor of anchors) {
    if (!inMerged(anchor.line) || !inMerged(anchor.litersLine) || litersFigures(lines[anchor.litersLine]!) < 2) continue;
    tables.push({ from: tableTop(lines, anchor.line, lineToPage, shown), to: anchor.litersLine + 1 });
  }
  return tables.length > 0 ? mergeSpans([...merged, ...tables]) : merged;
}

/**
 * The text the model reads for a long web page: its oil windows, each kept line under its
 * original number, elided spans marked, within `OIL_SELECTOR_MAX_CHARS`.
 *
 * @returns The numbered view, its plain narrowed text and the spans kept, or `null` when no line
 *   hits.
 */
export function narrowWebPage(
  text: string,
  words: readonly string[],
  maxChars: number = selectorMaxChars(),
): { numbered: string; plain: string; kept: LineSpan[] } | null {
  const lines = text.split("\n");
  const windows = oilWindows(lines, words);
  if (windows.length === 0) return null;
  const numbered: string[] = [];
  const plain: string[] = [];
  const kept: LineSpan[] = [];
  let spent = 0;
  let at = 0;
  for (const span of windows) {
    const block = lines.slice(span.from, span.to).map((line, offset) => `${span.from + offset + 1}: ${line}`);
    const extra = block.reduce((sum, line) => sum + line.length + 1, 0) + ELISION.length + 1;
    if (spent + extra > maxChars) break;
    spent += extra;
    if (span.from > at) {
      numbered.push(ELISION);
      plain.push(ELISION);
    }
    numbered.push(...block);
    plain.push(...lines.slice(span.from, span.to));
    kept.push(span);
    at = span.to;
  }
  if (numbered.length === 0) return null;
  if (at < lines.length) {
    numbered.push(ELISION);
    plain.push(ELISION);
  }
  return { numbered: numbered.join("\n"), plain: plain.join("\n"), kept };
}

/**
 * The production selector: the research model, the same one that extracts, streamed under the
 * limits of its model and effort (D2).
 *
 * Deterministic guards run first so the model is only asked when it can change something:
 * a non-text source passes through, and a short text is handed over whole.
 *
 * @param options - The transport, the meter and the outer signal (tests and the runner).
 */
export function createModelPassageSelector(options: ModelPortOptions = {}): PassageSelector {
  return async (source, identity, layout) => {
    if (source.content.kind !== "text") {
      return { status: "selected", source };
    }
    const text = source.content.text;
    if (text.trim() === "") {
      return { status: "none" };
    }
    const lines = text.split("\n");
    if (text.length <= PASSAGE_SHORT_PAGE_CHARS) {
      return { status: "selected", source, lines: [{ from: 0, to: lines.length }] };
    }
    // A manual's pages arrive narrowed, with their layout; a web page is narrowed here, and a
    // page with no hit goes as it came.
    const web = layout?.lineToPage ? null : narrowWebPage(text, engineWords(identity));
    const shown = web ? web.numbered : numberLines(text);
    const fallback = web ? narrow(source, web.plain) : undefined;
    const unavailable: PassageSelection = fallback ? { status: "unavailable", fallback } : { status: "unavailable" };

    const who = resolveCall(options);
    if (!who) {
      return unavailable;
    }
    const call = await streamModelCall({
      ...who,
      system: passageSystemPrompt(),
      prompt: `Veículo: ${identity.make} ${identity.model} ${identity.year} ${identity.version}\n\nDocumento: ${source.document}\n\n${shown}`,
      label: "passage-selector",
      ...callPlumbing(options),
    });
    if (call.failed) {
      return unavailable;
    }
    const selection = parseSelection(call.text);
    if (selection == null) {
      return unavailable;
    }
    if ("none" in selection) {
      return { status: "none" };
    }
    const spans: LineSpan[] = [];
    for (const range of selection.ranges) {
      const span = selectedSpan(text, range, layout?.lineToPage, web?.kept);
      if (span == null) {
        // A range the text does not have is a wrong answer, not a "none": dropped, the rest used.
        console.error("passage-selector: range outside the text", JSON.stringify(range));
        continue;
      }
      spans.push(span);
    }
    if (spans.length === 0) {
      return unavailable;
    }
    const completed = completeSpans(lines, mergeSpans(spans), layout?.lineToPage, web?.kept);
    return { status: "selected", source: narrow(source, joinSpans(lines, completed)), lines: completed };
  };
}
