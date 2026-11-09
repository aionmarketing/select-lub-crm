/**
 * Which of a gateway page's documents are recorded as manual candidates
 * (oil-quote-retrieval-hardening D8; oil-source-candidates "Harvested documents are selected
 * by their labels, and recorded as leads").
 *
 * Under the cap every document is recorded and nothing is asked. Over it, the searching model
 * — the research model, in a short second call with no tool — is shown the labels and URLs and asked which are
 * about this vehicle, ranked, with a one-line reason each. Its answer is validated against the
 * page's own list (it picks by index, so it cannot invent a URL). When it is unavailable, or
 * answers nothing usable, the fallback is the page's order: labelled first, then by identity
 * words. Either way an unlabelled document never displaces a labelled one.
 *
 * A recorded document is a lead, not a fact: the model judged a label, not the document, and
 * #77 is where a reader confirms the vehicle and model year from the document itself.
 */
import { parseJsonReply } from "../pipeline/spec-extractor.js";
import { resolveCall, type ModelPortOptions } from "../model-calls/ports.js";
import { streamModelCall } from "../model-calls/stream-call.js";
import type { VehicleIdentity } from "../store/store.js";
import { DOCUMENT_LINK_CAP, type DocumentLink } from "./page-fetcher.js";
import type { TokenUsage } from "./search-cost.js";

/** One document the selector chose, by its position in the list it was shown. */
export type LinkPick = { index: number; reason: string };

export { tokenUsageOf } from "../model-calls/stream-call.js";

/**
 * What one selector call may spend: the time left under the web search's own clock
 * (`WEB_SEARCH_TIMEOUT_MS`), the signal that clock aborts (the call's outer bound, D2), and
 * where its tokens are counted — the same tally the search's `costUsd` is priced from, so a
 * logged cost includes the selection.
 */
export type SelectorBudget = { timeoutMs: number; signal?: AbortSignal; onUsage?: (usage: TokenUsage) => void };

/**
 * Ranks a page's documents for one vehicle, or answers `null` when it cannot (no key, a bad
 * reply, a timeout). Its picks are indexes into `links`.
 */
export type DocumentLinkSelector = (
  links: readonly DocumentLink[],
  identity: VehicleIdentity,
  cap: number,
  budget: SelectorBudget,
) => Promise<LinkPick[] | null>;

/** A recorded document, with why it survived the cap (null when there was no cap to survive). */
export type ChosenDocumentLink = DocumentLink & { selectionReason: string | null };

/** The reason recorded when the selector could not choose and the page order did. */
export const FALLBACK_SELECTION_REASON = "fallback: labelled first, then identity words in the path or label";

/** Below this much time left, the selector is not asked at all and the page order decides. */
export const LINK_SELECTOR_MIN_MS = 1_000;

export const LINK_SELECTOR_SYSTEM_PROMPT =
  "Você recebe uma lista NUMERADA de documentos de UMA página de fabricante — cada um com seu " +
  "rótulo (quando a página dá um) e sua URL — e a identidade de UM veículo. Escolha os documentos " +
  "que são sobre ESSE veículo (modelo e ano-modelo), do mais provável ao menos provável. " +
  "Responda APENAS com JSON no formato {\"picks\": [{\"index\": n, \"reason\": \"uma frase\"}]}, " +
  "usando só os números da lista. Não invente documentos. Se nenhum for sobre o veículo, " +
  "responda {\"picks\": []}.";

/**
 * Chooses the documents to record from one page.
 *
 * @param links - The page's documents, labelled first (as `extractDocumentLinks` orders them).
 * @param identity - The vehicle being quoted.
 * @param selector - The model's ranking; absent, the page order decides.
 * @param cap - How many to record at most.
 * @param budget - The time left under the web search's clock, its signal, and where the
 * selector's tokens are counted. With less than {@link LINK_SELECTOR_MIN_MS} left it is not
 * asked. The call itself runs under its model's idle time and ceiling (D2).
 * @returns At most `cap` documents, labelled ones before unlabelled ones.
 */
export async function chooseDocumentLinks(
  links: readonly DocumentLink[],
  identity: VehicleIdentity,
  selector?: DocumentLinkSelector,
  cap: number = DOCUMENT_LINK_CAP,
  budget: SelectorBudget = { timeoutMs: Number.POSITIVE_INFINITY },
): Promise<ChosenDocumentLink[]> {
  if (links.length <= cap) {
    return links.map((link) => ({ ...link, selectionReason: null }));
  }
  const picks =
    selector && budget.timeoutMs >= LINK_SELECTOR_MIN_MS
      ? await selector(links, identity, cap, budget).catch(() => null)
      : null;
  const chosen: ChosenDocumentLink[] = [];
  const seen = new Set<number>();
  for (const pick of picks ?? []) {
    const link = Number.isInteger(pick.index) ? links[pick.index] : undefined;
    if (!link || seen.has(pick.index)) {
      continue;
    }
    seen.add(pick.index);
    chosen.push({ ...link, selectionReason: pick.reason.trim() || null });
  }
  if (chosen.length > 0) {
    // Stable: the model's rank holds within each group, and a label always outranks none.
    return [...chosen.filter((link) => link.label !== null), ...chosen.filter((link) => link.label === null)].slice(
      0,
      cap,
    );
  }
  return links.slice(0, cap).map((link) => ({ ...link, selectionReason: FALLBACK_SELECTION_REASON }));
}

/** Reads the selector's JSON reply, or `null` when it is not one. */
export function parseLinkPicks(reply: string): LinkPick[] | null {
  let parsed: { picks?: unknown };
  try {
    parsed = parseJsonReply(reply) as { picks?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.picks)) {
    return null;
  }
  return parsed.picks.flatMap((pick: unknown) => {
    const entry = pick as { index?: unknown; reason?: unknown };
    return typeof entry?.index === "number"
      ? [{ index: entry.index, reason: typeof entry.reason === "string" ? entry.reason : "" }]
      : [];
  });
}

/** The prompt's list: one numbered line per document, label then URL. */
export function numberLinks(links: readonly DocumentLink[]): string {
  return links.map((link, index) => `${index}: ${link.label ?? "(sem rótulo)"} — ${link.url}`).join("\n");
}

/**
 * The production selector: the research model (the one that extracts), no tool, one streamed
 * call under its model's ceiling, with the web search's signal as its outer bound (D2). Its
 * tokens go to the budget's tally, and every request to the meter, an aborted one included (D3).
 * Without `OPENAI_API_KEY` it answers `null`, and the page order decides; a timeout or a failure
 * answers `null` too.
 *
 * @param options - The transport, the meter and the outer signal (tests and the runner).
 */
export function createModelDocumentLinkSelector(options: ModelPortOptions = {}): DocumentLinkSelector {
  return async (links, identity, cap, budget) => {
    const who = resolveCall(options);
    if (!who) {
      return null;
    }
    const signals = [budget.signal, options.signal].filter((signal): signal is AbortSignal => signal != null);
    const call = await streamModelCall({
      ...who,
      system: LINK_SELECTOR_SYSTEM_PROMPT,
      prompt:
        `Veículo: ${identity.make} ${identity.model} ${identity.year} ${identity.version}\n` +
        `Escolha no máximo ${cap}.\n\n${numberLinks(links)}`,
      label: "document-link-selector",
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.meter ? { meter: options.meter } : {}),
      ...(signals.length > 0 ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
    });
    if (call.usage) budget.onUsage?.(call.usage);
    return call.failed ? null : parseLinkPicks(call.text);
  };
}

