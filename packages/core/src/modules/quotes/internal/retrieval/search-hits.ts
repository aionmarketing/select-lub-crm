/**
 * The queries a web search runs, and how the search tool's hits become
 * candidates: merged across queries, shown to the classifier as a numbered
 * list, and read back by index so the model can never supply a URL of its own.
 */
import type { SearchCandidate } from "./admit.js";
import type { VehicleIdentity } from "../store/store.js";

/** One hit as the search step builds it from the tool's sources. */
export type SearchHit = { link: string; title: string; content: string };

/** Characters of each hit's content shown to the classifier. Enough to tell a manual from a shop. */
export const HIT_CONTENT_CHARS = 500;

/**
 * The classification prompt. The model receives the search tool's results as a NUMBERED
 * list and answers by index. It is never asked for a URL, so it cannot supply one from
 * memory — the 2026-09-14 runs showed that asking it to write URLs produced 0 of 7-10 that
 * the tool had actually found, however the prompt was worded.
 */
export const WEB_SEARCH_CLASSIFY_PROMPT =
  "Você recebe uma lista NUMERADA de resultados de busca (título, URL, trecho) sobre a " +
  "especificação de óleo de motor de UM veículo. Sua única tarefa é dizer o TIPO DE DOCUMENTO " +
  "de cada resultado. Para cada índice informe classification, exatamente um de " +
  '"manufacturer_manual" (manual do proprietário ou de serviço da montadora, ou a página da ' +
  'montadora que os disponibiliza), "manufacturer_technical" (informação técnica oficial da ' +
  'montadora: boletim, tabela de lubrificantes, ficha técnica, central de informações), ' +
  '"licensed_database" (base profissional licenciada de oficina), "lubricant_maker_guide" ' +
  '(guia de aplicação de fabricante de lubrificante), "aftermarket_catalog" (catálogo ' +
  'técnico de reposição reputado), ou "other" (fórum, rede social, loja, notícia, blog, ' +
  "sites que apenas hospedam cópias de manuais); e reason, uma linha dizendo por quê. " +
  "NÃO invente resultados, NÃO escreva URLs, NÃO diga qual óleo usar. " +
  "NUNCA informe um número de prioridade, nível ou tier — isso é decidido fora do modelo. " +
  'Responda APENAS com JSON no formato {"verdicts":[{"index": 1, "classification": "…", "reason": "…"}]}.';

/**
 * The identity of a page for de-duplication: origin plus path, query string dropped.
 *
 * The 2026-09-10 showcase run accepted `servicos.fiat.com.br/manuais.html` and
 * `servicos.fiat.com.br/manuais.html?offerId=237` as two separate tier-1 sources and fetched
 * both. They are one page. A wasted fetch out of three is a third of the budget.
 *
 * @param url - A candidate URL.
 * @returns A stable key, or the raw URL when it does not parse.
 */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Builds the manufacturer-manual query for one vehicle.
 *
 * Measured 2026-09-14: the vehicle query below pulls parts shops and blogs, while this one
 * returned the manufacturer's manuals page and the real owner-manual PDF for 8–10 of 10
 * results on every demo car. `search-prime` hands results back out-of-band, so a second
 * query is a second tool call — one more fee, and the pages that put a source at tier 1.
 */
export function buildManualQuery(identity: VehicleIdentity): string {
  return `${identity.make} manual do proprietário ${identity.model} ${identity.year} pdf site oficial`;
}

/** Builds the search query for one vehicle. */
export function buildSearchQuery(identity: VehicleIdentity): string {
  return `${identity.make} ${identity.model} ${identity.year} ${identity.version} óleo do motor viscosidade capacidade litros manual`;
}

/**
 * Merges the hits of several tool calls, keeping the first occurrence of each page.
 *
 * Order is preserved within and across lists, so the vehicle query's ranking comes first
 * and the manual query's hits follow — the classifier sees each page once.
 */
export function mergeHits(...lists: ReadonlyArray<readonly SearchHit[]>): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const list of lists) {
    for (const hit of list) {
      const key = pageKey(hit.link);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}

/**
 * Renders the hits as the numbered list the classifier answers against.
 *
 * @param hits - The tool's results, in the order the tool ranked them.
 */
export function formatHits(hits: readonly SearchHit[]): string {
  return hits
    .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.link}\n   ${hit.content.slice(0, HIT_CONTENT_CHARS)}`)
    .join("\n\n");
}

/**
 * Reads the classifier's verdicts and maps each back to the hit it names.
 *
 * Every URL in the output comes from `hits`, by index; the model cannot introduce one. An
 * index outside the list, a repeated index (first wins), a verdict with no classification,
 * and a reply with no JSON object all yield nothing for that entry rather than throwing.
 *
 * @param reply - The model's text, fenced or not.
 * @param hits - The list the indices refer to, 1-based.
 */
export function parseVerdicts(reply: string, hits: readonly SearchHit[]): SearchCandidate[] {
  const clean = reply.replace(/```(?:json)?/gi, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return [];
  }
  let parsed: { verdicts?: unknown };
  try {
    parsed = JSON.parse(clean.slice(start, end + 1)) as { verdicts?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.verdicts)) {
    return [];
  }
  const seen = new Set<number>();
  const out: SearchCandidate[] = [];
  for (const raw of parsed.verdicts) {
    if (typeof raw !== "object" || raw == null) continue;
    const v = raw as { index?: unknown; classification?: unknown; reason?: unknown };
    if (!Number.isInteger(v.index) || (v.index as number) < 1 || (v.index as number) > hits.length) continue;
    if (typeof v.classification !== "string" || seen.has(v.index as number)) continue;
    seen.add(v.index as number);
    const hit = hits[(v.index as number) - 1]!;
    out.push({
      url: hit.link,
      classification: v.classification,
      reason: typeof v.reason === "string" ? v.reason : "",
      title: hit.title,
    });
  }
  return out;
}
