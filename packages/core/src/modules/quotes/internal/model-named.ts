/**
 * Whether a text names a vehicle's model as a whole word (oil-research-web-retrieval D3).
 *
 * One predicate for two decisions that must not drift apart: the web adapter records a manual
 * candidate only when {@link concernsModel} holds for it, and `manuals/select-candidates.ts`
 * queues a candidate only when it holds for it. A candidate recorded by one and refused by the
 * other would sit in the ledger for good.
 *
 * Matching ignores case, accents and separators: a run of anything that is not a letter or a digit
 * (a space, a hyphen, a dot, a slash, "!") is one separator, and a separator inside the model may
 * be missing in the text. "HR-V" is found in "hrv", "manual-hr-v.pdf" and "HR V"; "Grand Siena"
 * in "grand-siena"; "Up!" in "up-2018". The whole-word boundary stays: "Gol" is never found in
 * "Golf".
 */

/** Lower-cased, accents stripped, so "Gol" matches "GOL" and "Veículo" matches "Veiculo". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Folded, every run of non-letters and non-digits one space, trimmed: "Up!" is "up", "/dam/hr-v.pdf" is "dam hr v pdf". */
function normalized(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The word's letter runs and digit runs, each a token that may or may not be separated from the next in the text. */
function tokensOf(word: string): string[] {
  return normalized(word).match(/\p{L}+|\p{N}+/gu) ?? [];
}

/**
 * Whether `word` occurs in `text` as a whole word, ignoring case, accents and separators, so
 * "Gol" does not match "Golf" and "HR-V" matches "hrv".
 *
 * @param text - A title, a label, or a decoded URL.
 * @param word - A model name, or a model year.
 */
export function hasWord(text: string, word: string): boolean {
  const tokens = tokensOf(word);
  if (tokens.length === 0) {
    return false;
  }
  const pattern = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(" ?");
  return new RegExp(`(^| )${pattern}( |$)`, "u").test(normalized(text));
}

/** A URL decoded for reading: a malformed escape leaves it as it came. */
export function decodedUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * Whether any of the texts names the model as a whole word.
 *
 * @param texts - Title, label, decoded URL: whichever the caller has. Null and empty are skipped.
 * @param model - The vehicle's model.
 */
export function namesModel(texts: ReadonlyArray<string | null | undefined>, model: string): boolean {
  return texts.some((text) => text != null && text.trim() !== "" && hasWord(text, model));
}

/**
 * Whether a document concerns the vehicle: its label decides when it has one, otherwise its URL
 * does. A label says what the document is (Q5 found "Manual Voyage 2015" served from
 * `.../manual-gol/...`, which is not a Gol manual); a URL is only the fallback for a document
 * nobody labelled. This is the one rule both the recording and the queueing apply
 * (`manuals/select-candidates.ts`), so a recorded lead is always one the manual pipeline can read.
 *
 * @param document - The recorded label (a search title that names the model, or a link's label) and URL.
 * @param model - The vehicle's model.
 */
export function concernsModel(document: { label: string | null | undefined; url: string }, model: string): boolean {
  const labelled = document.label != null && document.label.trim() !== "";
  return hasWord(labelled ? document.label! : decodedUrl(document.url), model);
}
