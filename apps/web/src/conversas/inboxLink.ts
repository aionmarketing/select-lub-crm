/**
 * The URL contract between Relatórios' funnel/origin drill-through and the
 * Conversas inbox filters — one place so the writer (Relatórios) and the
 * reader (Conversas) cannot drift into disagreeing about a param name or a
 * vocabulary value.
 */
import type { ConversationPipelineStage, ConversationSourceType } from "@select-lub/shared-types";

/** Portuguese funnel captions. Title case on the two that Relatórios pins (`relatorios/spec.md:417`). */
export const FUNNEL_STAGE_LABELS: Record<ConversationPipelineStage, string> = {
  novosContatos: "Novos Contatos",
  emAtendimento: "Em atendimento",
  orcamentoEnviado: "Orçamento Enviado",
  servicosFeitos: "Serviços Feitos",
};

/** Thread-header / inbox-chip captions. Sentence case (`design-system/mvp-screen-designs:451`, `conversas/spec.md:507`). */
export const THREAD_STAGE_LABELS: Record<ConversationPipelineStage, string> = {
  novosContatos: "Novos Contatos",
  emAtendimento: "Em atendimento",
  orcamentoEnviado: "Orçamento enviado",
  servicosFeitos: "Serviços feitos",
};

/** Portuguese label for each origin classification. */
export const ORIGIN_LABELS: Record<ConversationSourceType, string> = {
  AD: "Anúncio",
  ORGANIC: "Orgânica",
  UNKNOWN: "Desconhecida",
};

/**
 * Builds the `/` URL a funnel stage or origin row navigates to.
 *
 * @param filters - The stage or origin to cut by, plus the report's own
 *   period. Both `origin` and `stage` may be given at once; the inbox
 *   composes them as an AND.
 * @returns A path Conversas reads back into the same cut.
 */
export function inboxDrillLink(filters: {
  origin?: ConversationSourceType;
  stage?: ConversationPipelineStage;
  from: string;
  to: string;
}): string {
  const params = new URLSearchParams();
  if (filters.origin) {
    params.set("origin", filters.origin);
  }
  if (filters.stage) {
    params.set("stage", filters.stage);
  }
  params.set("from", filters.from);
  params.set("to", filters.to);
  return `/?${params.toString()}`;
}

/**
 * Formats an inclusive `YYYY-MM-DD` period as the day/month pair the chip
 * shows, matching the artboard's "01/08 – 28/08/2026" reading.
 */
export function formatPeriodChip(from: string, to: string): string {
  const short = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const [y] = to.split("-");
  return `${short(from)} – ${short(to)}/${y}`;
}
