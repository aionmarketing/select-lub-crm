/**
 * The oil-quote dialog's Portuguese sentences that depend on the payload
 * (background-oil-research D17). Pure, so each variant is tested apart from the dialog.
 *
 * The research sentences take the time elapsed since `requestedAt` on the server's clock, so the
 * past-Y switch and the counter read one anchor (D14).
 */
import type {
  NewerAttempt,
  QuoteConflictSource,
  ResearchIdentityField,
  ResearchTiming,
  SourceClassification,
} from "@select-lub/shared-types";
import { formatScheduleDate, saoPauloTime } from "./helpers.js";

/** The fields a research needs, named as the dialog names them: `PREFILL_FIELD_LABELS`, lowercased. */
const IDENTITY_FIELD_LABEL: Record<ResearchIdentityField, string> = {
  make: "marca",
  model: "modelo",
  version: "versão",
  year: "ano",
};

/** "Para pesquisar o lubrificante, complete os dados do veículo: marca e versão." */
export function incompleteIdentitySentence(fields: readonly ResearchIdentityField[]): string {
  return `Para pesquisar o lubrificante, complete os dados do veículo: ${joinPortugueseList(fields.map((field) => IDENTITY_FIELD_LABEL[field]))}.`;
}

/** The no-source state (D17). */
export const NO_SOURCE_SENTENCE =
  "Não encontramos o óleo indicado para este veículo em um manual ou catálogo confiável, por isso nenhuma opção é exibida.";

/** A research that failed (D17): it names no provider. */
export const RESEARCH_FAILED_SENTENCE = "Não conseguimos concluir a pesquisa de lubrificante deste veículo.";

/** Tecfil not yet consulted for a verified identity (D17). */
export const FILTERS_PENDING_SENTENCE = "Ainda estamos consultando os filtros na Tecfil — por enquanto, nenhum filtro entra no preço.";

/**
 * Why "Enviar via WhatsApp" waits (block-send-until-filter-chosen, owner ruling 2026-10-04): the
 * message says the filters are included, so a type with several candidates must be chosen first.
 *
 * @param unchosen - The filter types with more than one candidate and no choice yet.
 * @returns The hint, or null when nothing blocks the send.
 */
export function filterChoiceHint(unchosen: { oil: boolean; fuel: boolean }): string | null {
  if (unchosen.oil && unchosen.fuel) return "Escolha os filtros antes de enviar.";
  if (unchosen.oil) return "Escolha o filtro de óleo antes de enviar.";
  if (unchosen.fuel) return "Escolha o filtro de combustível antes de enviar.";
  return null;
}

/** The refetch POST failed (D16). */
export const REFETCH_FAILED_SENTENCE = "Não foi possível pedir uma nova busca. Tente de novo.";

/** A read that calls no provider (D17). */
export const LOADING_SENTENCE = "Carregando opções de orçamento…";

/** The quote-options read itself failed (an HTTP error, not a research outcome). */
export const LOAD_FAILED_SENTENCE = "Não foi possível carregar as opções de orçamento";

/** A research waiting for a manual, while not paused (D17). */
export const MANUAL_READING_SENTENCE = "Encontramos o manual da montadora e estamos lendo o documento.";

/** "Há N pesquisas na frente." — singular for one (D17). */
export function queueSentence(ahead: number): string {
  return ahead === 1 ? "Há 1 pesquisa na frente." : `Há ${ahead} pesquisas na frente.`;
}

/** Whether the time searching has passed the estimate's upper bound (D17: "past Y"). */
export function pastExpected(timing: Pick<ResearchTiming, "expectedMinutes">, elapsedMs: number): boolean {
  return elapsedMs > timing.expectedMinutes.max * 60_000;
}

/**
 * The time since `requestedAt`: "S s" under a minute, "N min S s" under an hour, "H h N min" from
 * an hour (D17). A negative span (a clock read before the anchor) reads as 0 s.
 */
export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3_600)} h ${Math.floor((seconds % 3_600) / 60)} min`;
}

/**
 * The counter (D17): "Pesquisando há …", or "Na fila há …" while research is not running, since
 * nothing is searching then. A retry keeps "Pesquisando há …".
 */
export function counterSentence(timing: Pick<ResearchTiming, "paused">, elapsedMs: number): string {
  const prefix = timing.paused?.reason === "stopped" ? "Na fila há" : "Pesquisando há";
  return `${prefix} ${formatElapsed(elapsedMs)}`;
}

/**
 * The main sentence of a research under way, with no cache row to show (`researching`): the range,
 * "demorando mais que o normal" past it, or — every pause hides the range — why it is paused. The
 * retry time is São Paulo's.
 *
 * @param elapsedMs - Time since `requestedAt` on the server's clock; 0 when not yet known.
 */
export function researchingSentence(
  timing: Pick<ResearchTiming, "expectedMinutes" | "paused"> & Partial<Pick<ResearchTiming, "path" | "engine">>,
  elapsedMs = 0,
): string {
  if (timing.paused?.reason === "stopped") return "A pesquisa automática não está rodando agora; o pedido fica na fila.";
  if (timing.paused?.reason === "retrying") return `A última tentativa falhou; vamos tentar de novo às ${saoPauloTime.format(new Date(timing.paused.retryAt))}.`;
  // An engine re-read (D24.2) shows no range, and so is never "late" against one.
  if (timing.path === "engine_pick" && timing.engine != null) return engineReadingSentence(timing.engine);
  if (pastExpected(timing, elapsedMs)) return "Procurando lubrificante compatível. Está demorando mais que o normal.";
  return `Procurando lubrificante compatível — pode levar entre ${timing.expectedMinutes.min} e ${timing.expectedMinutes.max} minutos.`;
}

/** The main sentence of a new search under way for a cached identity (`refresh`), same rules. */
export function refreshSentence(timing: Pick<ResearchTiming, "expectedMinutes" | "paused">, elapsedMs = 0): string {
  if (timing.paused?.reason === "stopped") return "Nova busca na fila, mas a pesquisa automática não está rodando agora.";
  if (timing.paused?.reason === "retrying") return `A nova busca falhou; vamos tentar de novo às ${saoPauloTime.format(new Date(timing.paused.retryAt))}.`;
  if (pastExpected(timing, elapsedMs)) return "Buscando dados novos. Está demorando mais que o normal.";
  return `Buscando dados novos — pode levar entre ${timing.expectedMinutes.min} e ${timing.expectedMinutes.max} minutos.`;
}

/** A refresh ended with a newer row while the attendant had edited the quote (D17). */
export function newDataSentence(consultedAt: string): string {
  return `Chegaram dados novos de ${formatScheduleDate(consultedAt)}.`;
}

/** "Dados consultados em {data}." for the options, empty and missing-volume states. */
export function consultedSentence(consultedAt: string): string {
  return `Dados consultados em ${formatScheduleDate(consultedAt)}.`;
}

/** A newer research that did not confirm the shown row (D17). */
export function newerAttemptSentence(attempt: NewerAttempt, consultedAt: string): string {
  const newer = formatScheduleDate(attempt.finishedAt);
  const shown = formatScheduleDate(consultedAt);
  return attempt.outcome === "no_spec"
    ? `A nova busca de ${newer} não encontrou uma fonte confiável; mostramos os dados consultados em ${shown}.`
    : `Não conseguimos concluir a nova busca de ${newer}; mostramos os dados consultados em ${shown}.`;
}

/** Joins a list the Portuguese way: "a", "a e b", "a, b e c". */
export function joinPortugueseList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/**
 * The clarification sentence (D17's five variants): the source names several engines
 * (`several`) or describes another one (`mismatch`), naming none, one or several of them. A
 * variant with no engine named never prints empty parentheses.
 *
 * @param coverage - Why the clarification is asked.
 * @param engines - The engines the source named, verbatim.
 */
export function clarificationSentence(coverage: "several" | "mismatch", engines: readonly string[]): string {
  const list = joinPortugueseList(engines);
  if (coverage === "several") {
    return engines.length === 0
      ? "A fonte cita mais de um motor e não diz qual é o deste veículo. Confira a versão do veículo."
      : `A fonte cita mais de um motor para este veículo: ${list}. Confira a versão do veículo.`;
  }
  if (engines.length === 0) return "A fonte encontrada descreve outro motor. Confira a versão do veículo.";
  if (engines.length === 1) return `A fonte encontrada descreve outro motor (${list}). Confira a versão do veículo.`;
  return `A fonte encontrada descreve outros motores (${list}). Confira a versão do veículo.`;
}

// ---------------------------------------------------------------------------------------------
// The three dead ends' ways out (D24, D17's rows of the owner rulings, 2026-09-27 and 2026-09-30).
// ---------------------------------------------------------------------------------------------

/**
 * A litre volume in pt-BR, without trailing zeros beyond what was given: `4,2 L`, `42 L`.
 *
 * @param liters - A fill volume.
 */
export function formatLiters(liters: number): string {
  return `${liters.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
}

/** The missing volume's input (D24.1). */
export const FILL_VOLUME_LABEL = "Volume de óleo da troca (litros)";
export const FILL_VOLUME_HINT = "Informe o volume em serviço, com filtro.";
export const USE_FILL_VOLUME = "Usar este volume";
/** A typed value that is not a volume: 0, negative, text, more than two decimals. */
export const FILL_VOLUME_INVALID = "Informe o volume em litros, maior que zero.";
/** A typed volume above 30 L (owner, 2026-09-30): it warns, it does not block. */
export const FILL_VOLUME_HIGH = "Volume alto — confira antes de usar.";
export const USE_HIGH_FILL_VOLUME = "Usar mesmo assim";
/** The prompt's two answers (orchestrator, 2026-09-30). */
export const SAVE_FILL_FOR_MODEL = "Guardar para este modelo";
export const SAVE_FILL_ONLY_THIS_QUOTE = "Só neste orçamento";
/** Storing the volume failed; the cards stay priced for this quote. */
export const SAVE_FILL_FAILED = "Não foi possível guardar o volume para os próximos orçamentos.";

/**
 * "Guardar 4,2 L como volume da troca para os próximos orçamentos de Toyota Corolla XEi 2019?"
 *
 * @param liters - The typed volume.
 * @param vehicle - The identity the volume is kept for: make, model, version and year.
 */
export function saveFillQuestion(liters: number, vehicle: string): string {
  return `Guardar ${formatLiters(liters)} como volume da troca para os próximos orçamentos de ${vehicle}?`;
}

/** A card priced from a typed volume: "Volume informado pelo atendente: 4,2 L". */
export function typedFillFlag(liters: number): string {
  return `Volume informado pelo atendente: ${formatLiters(liters)}`;
}

/** A card priced from a kept volume: "Volume informado por Marina em 20/09/2026: 4,2 L". */
export function storedFillFlag(fill: { liters: number; recordedBy: string; recordedAt: string }): string {
  return `Volume informado por ${fill.recordedBy} em ${formatScheduleDate(fill.recordedAt)}: ${formatLiters(fill.liters)}`;
}

/** What a typed volume is (D24.1): a usable figure, one above 30 L to confirm, or not a volume. */
export type TypedFillVolume = { kind: "ok"; liters: number } | { kind: "high"; liters: number } | { kind: "invalid" };

/** Above this a typed volume asks for "Usar mesmo assim" (`HIGH_FILL_VOLUME_LITERS`, owner 2026-09-30). */
const HIGH_FILL_LITERS = 30;
/** The most the store holds (`MAX_FILL_VOLUME_LITERS`, DECIMAL(6,2)). */
const MAX_FILL_LITERS = 9999.99;

/**
 * Reads a typed fill volume the way the attendant writes it: digits, then a comma (or a point)
 * and at most two decimals. 0, a negative number, text, more than two decimals or more than the
 * store holds is not a volume; above 30 L it is one to confirm.
 *
 * @param raw - The field's text.
 */
export function parseTypedFillVolume(raw: string): TypedFillVolume {
  const trimmed = raw.trim();
  if (!/^\d{1,4}([.,]\d{1,2})?$/.test(trimmed)) return { kind: "invalid" };
  const liters = Number(trimmed.replace(",", "."));
  if (!(liters > 0) || liters > MAX_FILL_LITERS) return { kind: "invalid" };
  return liters > HIGH_FILL_LITERS ? { kind: "high", liters } : { kind: "ok", liters };
}

/** The clarification's way out (D24.2). */
export const ENGINE_CHOICE_INTRO =
  "Escolha o motor deste veículo — a versão do cadastro é corrigida com ele e a fonte encontrada é lida de novo para esse motor.";
export const NONE_OF_THESE_ENGINES = "Nenhum destes? Corrigir versão do veículo";
export const CORRECT_VERSION = "Corrigir versão do veículo";

/** "Versão do veículo corrigida para XEi 1.8 Dual VVT-i." */
export function correctedVersionSentence(version: string): string {
  return `Versão do veículo corrigida para ${version}.`;
}

/** "Lendo a fonte para o motor 1.8 Dual VVT-i…" — the engine re-read, with the counter and no range. */
export function engineReadingSentence(engine: string): string {
  return `Lendo a fonte para o motor ${engine}…`;
}

/** The conflicting sources' ways out (D24.3). */
export const GRADE_CONFLICT_INTRO =
  "As fontes consultadas discordam sobre a viscosidade deste veículo. Mostramos as opções de cada fonte — escolha a que vale para este carro.";
export const VOLUME_CONFLICT_INTRO =
  "As fontes consultadas discordam sobre o volume de óleo da troca. Escolha o volume que vale para este carro.";
export const VOLUME_ALSO_CONFLICT_INTRO = "As fontes também discordam sobre o volume da troca. Escolha o volume:";
/** A card's price before the volume is chosen. */
export const CHOOSE_VOLUME_PRICE = "escolha o volume";
/** A card's price in a grade conflict where no source stated a volume, before one is typed. */
export const TYPE_VOLUME_PRICE = "informe o volume";
/** The engine pick failed (a 500 or no answer); the engine buttons are offered again. */
export const ENGINE_PICK_FAILED = "Não foi possível corrigir a versão. Tente de novo.";

/** prompt.md source tiers, in the attendant's words (`AUTHORITY_LABEL`). */
export const AUTHORITY_LABEL: Record<number, string> = {
  1: "manual da montadora",
  2: "informação técnica da montadora",
  3: "base de oficina licenciada",
  4: "guia de aplicação do fabricante de lubrificante",
  5: "catálogo de reposição",
};

/** A web source's class (`SourceClassification`), named as its tier is (D24 F3). */
export const SOURCE_CLASS_LABEL: Record<SourceClassification, string> = {
  manufacturer_manual: AUTHORITY_LABEL[1]!,
  manufacturer_technical: AUTHORITY_LABEL[2]!,
  licensed_database: AUTHORITY_LABEL[3]!,
  lubricant_maker_guide: AUTHORITY_LABEL[4]!,
  aftermarket_catalog: AUTHORITY_LABEL[5]!,
};

/** The source fields a citation names. */
type CitedConflictSource = Pick<
  QuoteConflictSource,
  "sourcePublisher" | "sourceDocument" | "sourcePage" | "sourceAuthority" | "sourceClassification"
>;

/**
 * "Toyota, Manual do proprietário Corolla 2019 (p. 412) — manual da montadora": the suffix is the
 * class label when a class is recorded, else the tier's label, and is omitted when both are null
 * (orchestrator, 2026-09-30).
 */
export function conflictCitation(source: CitedConflictSource): string {
  const authority =
    source.sourceClassification != null
      ? SOURCE_CLASS_LABEL[source.sourceClassification]
      : source.sourceAuthority != null
        ? AUTHORITY_LABEL[source.sourceAuthority]
        : undefined;
  const base = `${source.sourcePublisher}, ${source.sourceDocument} (${source.sourcePage})`;
  return authority ? `${base} — ${authority}` : base;
}

/** A disputed grade's source: "Viscosidade indicada por: {fonte}". */
export function gradeCitation(source: CitedConflictSource): string {
  return `Viscosidade indicada por: ${conflictCitation(source)}`;
}

/**
 * A source's volume, always with one decimal at least ("4,0 L", "4,3 L"), as the canvas writes the
 * volume choices: two sources' figures are compared side by side, and "4 L" beside "4,3 L" reads as
 * a rounded value.
 */
export function formatSourceLiters(liters: number): string {
  return `${liters.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} L`;
}

/** One volume choice: "4,3 L — Toyota, Manual do proprietário Corolla 2019 (p. 412) — manual da montadora". */
export function volumeChoiceText(choice: { liters: number; source: CitedConflictSource }): string {
  return `${formatSourceLiters(choice.liters)} — ${conflictCitation(choice.source)}`;
}

/** A card priced from the chosen volume: "Volume indicado por: {fonte}: 4,3 L". */
export function chosenVolumeFlag(choice: { liters: number; source: CitedConflictSource }): string {
  return `Volume indicado por: ${conflictCitation(choice.source)}: ${formatSourceLiters(choice.liters)}`;
}
