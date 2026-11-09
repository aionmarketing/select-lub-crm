/**
 * Finding the pages about engine oil in a stored manual (ingest-harvested-manuals D4), and
 * narrowing them before the selector reads them (background-oil-research D4).
 *
 * A 300–400 page manual is about 500k tokens: too much to hand a model. So a deterministic,
 * free prefilter scores every page by the words a capacities table uses — óleo, lubrificante,
 * capacidade, litros, SAE, viscosidade, "com filtro", "sem filtro", cárter, and any SAE grade —
 * plus a bonus for the identity's own engine words (displacement, valve count, engine code), and
 * keeps the top K. Each of those pages is then narrowed to windows of ±12 lines around its oil,
 * grade and engine-word lines, the rest elided with `[…]`, under `OIL_SELECTOR_MAX_CHARS` with
 * the best-scoring pages' windows kept first. The pages are joined with a marker per page, and
 * every line of the joined text — an elision line included — remembers the page it came from:
 * the selector answers with line ranges, and the pages cited are the pages those lines belong to
 * — never found by searching the text, so a page that prints a marker of its own cannot move a
 * citation (review of #182).
 */
import { ELISION, fold, OIL_KEYWORDS, oilWindows, SAE_GRADE_WORD, selectorMaxChars, type LineSpan } from "../pipeline/narrow-text.js";
import type { VehicleIdentity } from "../store/store.js";

/** One stored page. */
export type ManualPage = { pageNumber: number; text: string };

/** Pages handed to the passage selector, when `MANUAL_PAGES_TO_SELECTOR` is unset (Q3: K = 6). */
export const MANUAL_DEFAULT_PAGES_TO_SELECTOR = 6;

/** @returns K from `MANUAL_PAGES_TO_SELECTOR`, else its default. */
export function pagesToSelector(): number {
  const raw = Number(process.env.MANUAL_PAGES_TO_SELECTOR);
  return Number.isInteger(raw) && raw > 0 ? raw : MANUAL_DEFAULT_PAGES_TO_SELECTOR;
}

/** A page that repeats one word fifty times is not fifty times as relevant. */
const KEYWORD_CAP = 5;

/** Weight of one engine-word hit against one keyword hit: the engine is what tells two tables apart. */
const ENGINE_WORD_WEIGHT = 3;

/** Version words that name a body, a fuel or a trim, never an engine. */
const NOT_ENGINE_WORDS = new Set([
  "flex", "totalflex", "gasolina", "alcool", "etanol", "diesel", "manual", "mec", "aut", "automatico", "automatica",
  "cvt", "sport", "trend", "comfortline", "highline", "trendline", "track", "city", "connect", "plus", "portas",
]);

/**
 * The identity's engine words, as a manual would print them: the displacement both ways
 * ("1.0" and "1,0"), the valve count ("12v"), and any engine code in the version ("tsi",
 * "ea211"). From the plate lookup's displacement when there is one.
 *
 * @returns Folded words, de-duplicated.
 */
export function engineWords(identity: VehicleIdentity): string[] {
  const words = new Set<string>();
  const addDisplacement = (whole: string, tenth: string) => {
    words.add(`${whole}.${tenth}`);
    words.add(`${whole},${tenth}`);
  };
  for (const token of fold(identity.version).split(/\s+/).filter(Boolean)) {
    const displacement = /^(\d)[.,](\d)$/.exec(token);
    if (displacement) addDisplacement(displacement[1]!, displacement[2]!);
    else if (/^\d{1,2}v$/.test(token)) words.add(token);
    else if (/^[a-z][a-z0-9]{2,}$/.test(token) && !NOT_ENGINE_WORDS.has(token)) words.add(token);
  }
  if (identity.displacementCc && identity.displacementCc > 0) {
    const liters = (Math.round(identity.displacementCc / 100) / 10).toFixed(1);
    addDisplacement(liters[0]!, liters[2]!);
  }
  return [...words];
}

function countOf(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/**
 * How much a page looks like the engine-oil page, for these engine words. Zero when it names no
 * oil word at all: an engine word alone (a page about the 1.0's timing belt) does not qualify.
 */
export function scorePage(text: string, words: readonly string[]): number {
  const folded = fold(text);
  const oil = OIL_KEYWORDS.reduce((sum, keyword) => sum + Math.min(KEYWORD_CAP, countOf(folded, keyword)), 0) +
    Math.min(KEYWORD_CAP, (folded.match(SAE_GRADE_WORD) ?? []).length);
  if (oil === 0) return 0;
  const engine = words.reduce((sum, word) => sum + Math.min(KEYWORD_CAP, countOf(folded, word)), 0);
  return oil + ENGINE_WORD_WEIGHT * engine;
}

/**
 * The pages chosen for the selector, narrowed and joined with a marker per page. `lineToPage[i]`
 * is the page line `i` of `text` came from (a marker, an elision line, and the blank line after a
 * page, belong to that page).
 */
export type LocatedPages = { pageNumbers: number[]; text: string; lineToPage: number[] };

/** The line that opens each page in the joined text. */
function marker(pageNumber: number): string {
  return `=== página ${pageNumber} ===`;
}

/** A line that looks like a page marker: in a page's own text it is neutralized. */
const MARKER_LIKE = /^\s*=+\s*p[aá]gina\s*\d+\s*=+\s*$/i;

/** A page's own text with any marker-like line defused, so only the joiner writes markers. */
function neutralized(text: string): string[] {
  return text
    .trim()
    .split("\n")
    .map((line) => (MARKER_LIKE.test(line) ? `[${line.replace(/=+/g, "").trim()}]` : line));
}

/** The characters one line costs in the joined text, its newline included. */
const cost = (lines: readonly string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0);

/**
 * Keeps the K best pages for this identity, narrows each to its oil windows, and joins them in
 * page order with a marker per page, within `OIL_SELECTOR_MAX_CHARS`.
 *
 * @param maxChars - The cap; `OIL_SELECTOR_MAX_CHARS` or its default when omitted.
 * @returns The chosen pages, or none when no page mentions oil at all.
 */
export function locatePages(
  pages: readonly ManualPage[],
  identity: VehicleIdentity,
  k: number,
  maxChars: number = selectorMaxChars(),
): LocatedPages {
  const words = engineWords(identity);
  const best = pages
    .map((page) => ({ page, score: scorePage(page.text, words) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.page.pageNumber - b.page.pageNumber)
    .slice(0, k);

  // Spend the cap on the best-scoring pages first, a whole window at a time.
  let spent = 0;
  const kept = new Map<number, { lines: string[]; spans: LineSpan[] }>();
  for (const { page } of best) {
    const lines = neutralized(page.text);
    // The marker, the blank line before it, and the page's trailing elision.
    const head = cost([marker(page.pageNumber), "", ELISION]);
    const spans: LineSpan[] = [];
    for (const span of oilWindows(lines, words)) {
      const extra = cost(lines.slice(span.from, span.to)) + cost([ELISION]) + (spans.length === 0 ? head : 0);
      if (spent + extra > maxChars) continue;
      spent += extra;
      spans.push(span);
    }
    if (spans.length > 0) kept.set(page.pageNumber, { lines, spans });
  }

  const chosen = [...kept.keys()].sort((a, b) => a - b);
  const lines: string[] = [];
  const lineToPage: number[] = [];
  chosen.forEach((pageNumber, index) => {
    const push = (line: string, page = pageNumber) => {
      lines.push(line);
      lineToPage.push(page);
    };
    // A blank line between pages; it belongs to the page before it.
    if (index > 0) push("", chosen[index - 1]!);
    push(marker(pageNumber));
    const page = kept.get(pageNumber)!;
    let at = 0;
    for (const span of page.spans) {
      if (span.from > at) push(ELISION);
      page.lines.slice(span.from, span.to).forEach((line) => push(line));
      at = span.to;
    }
    if (at < page.lines.length) push(ELISION);
  });
  return { pageNumbers: chosen, text: lines.join("\n"), lineToPage };
}

/**
 * The pages a set of spans of the joined text's lines belongs to (0-based, `to` exclusive): only
 * pages that were sent. No span, or any span outside the text, cites every page sent.
 */
export function pagesForLines(located: LocatedPages, spans?: readonly LineSpan[]): number[] {
  const count = located.lineToPage.length;
  if (!spans || spans.length === 0 || spans.some((span) => span.from < 0 || span.to > count || span.from >= span.to)) {
    return located.pageNumbers;
  }
  const pages = new Set<number>();
  for (const span of spans) located.lineToPage.slice(span.from, span.to).forEach((page) => pages.add(page));
  return [...pages].sort((a, b) => a - b);
}

/** A citation for the pages: "p. 3", "pp. 3–4", or "pp. 3, 7". */
export function citePages(pageNumbers: readonly number[]): string {
  const pages = [...new Set(pageNumbers)].sort((a, b) => a - b);
  if (pages.length === 0) return "";
  if (pages.length === 1) return `p. ${pages[0]}`;
  const contiguous = pages.every((page, i) => i === 0 || page === pages[i - 1]! + 1);
  return contiguous ? `pp. ${pages[0]}–${pages[pages.length - 1]}` : `pp. ${pages.join(", ")}`;
}
