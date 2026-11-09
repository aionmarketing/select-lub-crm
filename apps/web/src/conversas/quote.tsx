/**
 * Montar orçamento dialog on the Conversas rail.
 *
 * Each oil card is pre-filled with `round(unit price x service-fill liters, 2) + filters`.
 * The catalog price is per LITRE, so the multiplication is what makes the number a job
 * price; showing the unit price alone would undercharge by the whole fill volume.
 *
 * The dialog prices one oil-filter and one fuel-filter candidate into every oil card
 * (design D11 of `tecfil-filter-pricing`): a slot with a single candidate is priced in
 * automatically, a slot with two or more shows a chooser and contributes nothing until
 * the attendant picks, and an unresolved slot only produces a Portuguese warning — it
 * never blocks the quote and never invents a part number or a price. Because the message always
 * says the filters are included, a slot still waiting on its chooser holds "Enviar via WhatsApp"
 * (block-send-until-filter-chosen, owner ruling 2026-10-04): the button is `aria-disabled` with a
 * guarded handler, never `disabled`, and the hint is shown beside it and read through the status.
 *
 * The liters come from one place per state (background-oil-research D24): the cited volume of an
 * `options` row or the attendant's kept volume (`attendantFill`); on the missing volume, the one
 * the attendant types; on a conflict, the volume the sources agree on, the one the attendant
 * chooses among theirs, or — when no source stated one — a typed or kept volume. Until a conflict's
 * volume is chosen the cards read "escolha o volume", and until its grade is chosen there is no
 * quote to send.
 */
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  AttendantFill,
  PricedFillCondition,
  QuoteConflictCard,
  QuoteConflictSource,
  QuoteFilterCard,
  QuoteFilters,
  QuoteFilterSlot,
  QuoteOptionCard,
  QuoteOptionsResult,
  QuoteVolumeChoice,
  UnusableFillCondition,
  Vehicle,
} from "@select-lub/shared-types";
import {
  createOilQuote,
  fetchConversationVehicles,
  fetchQuoteOptions,
  oilActionRefusalStatus,
  pickOilEngine,
  recordOilFillVolume,
  requestOilRefetch,
} from "../api.js";
import { assembleOilQuoteMessage, formatQuotePrice } from "../assembleOilQuoteMessage.js";
import { oilCardName, oilTypeLabel } from "../oilCardName.js";
import { joinDot, parseOfferedPrice, vehicleIdentity } from "./helpers.js";
import {
  AUTHORITY_LABEL,
  CHOOSE_VOLUME_PRICE,
  chosenVolumeFlag,
  conflictCitation,
  ENGINE_PICK_FAILED,
  TYPE_VOLUME_PRICE,
  clarificationSentence,
  consultedSentence,
  correctedVersionSentence,
  FILL_VOLUME_HIGH,
  FILL_VOLUME_INVALID,
  FILTERS_PENDING_SENTENCE,
  filterChoiceHint,
  formatLiters,
  formatSourceLiters,
  GRADE_CONFLICT_INTRO,
  gradeCitation,
  incompleteIdentitySentence,
  newDataSentence,
  newerAttemptSentence,
  NO_SOURCE_SENTENCE,
  parseTypedFillVolume,
  RESEARCH_FAILED_SENTENCE,
  SAVE_FILL_FAILED,
  saveFillQuestion,
  storedFillFlag,
  typedFillFlag,
  VOLUME_ALSO_CONFLICT_INTRO,
  VOLUME_CONFLICT_INTRO,
  volumeChoiceText,
} from "./quote-copy.js";
import { ChoiceGroup, EngineChoices, FillVolumeField, SaveFillPrompt, type FillVolumeProblem } from "./quote-dead-ends.js";
import { NoticeBox, OutcomeBox, QuoteStatusRegion, type QuoteStatusView } from "./quote-research.js";
import { CardSource, QuoteSources } from "./quote-sources.js";

/** How often the dialog re-reads while research runs (D17). */
const QUOTE_POLL_MS = 3_000;

/** The no-compatible-brand copy, for the empty state and a conflict with no stocked grade. */
const NO_COMPATIBLE_BRAND = "Nenhuma marca do catálogo interno é compatível. Nenhuma opção é exibida.";

type ConflictResult = Extract<QuoteOptionsResult, { status: "conflicting_sources" }>;

/** A conflict recorded with its card data (D24 F1), as opposed to the old `conflicts`-only shape. */
type CardConflict = ConflictResult & {
  viscosityGrades: string[];
  classification: string;
  gradeSources: NonNullable<ConflictResult["gradeSources"]>;
  options: QuoteConflictCard[];
  filters: QuoteFilters;
};

function isCardConflict(data: QuoteOptionsResult | undefined): data is CardConflict {
  return (
    data?.status === "conflicting_sources" &&
    data.options !== undefined &&
    data.filters !== undefined &&
    data.gradeSources !== undefined &&
    data.viscosityGrades !== undefined
  );
}

/** Whether a conflict disputes the grades (else only the volume). */
function disputesGrades(data: ConflictResult): boolean {
  return data.conflicts.some((conflict) => conflict.field === "viscosityGrades");
}

/** The filters a shown result carries: the options, the missing volume, a conflict with cards. */
function resultFilters(data: QuoteOptionsResult | undefined): QuoteFilters | undefined {
  if (data?.status === "options" || data?.status === "no_capacity") return data.filters;
  return isCardConflict(data) ? data.filters : undefined;
}

/**
 * Whether the dialog keeps re-reading (D17): while research is under way, a new search runs for
 * the shown row, or the filters are still to be consulted and research is running.
 */
function quoteStillResolving(data: QuoteOptionsResult | undefined): boolean {
  if (!data) return false;
  if (data.status === "researching") return true;
  if ((data.status === "options" || data.status === "empty" || data.status === "no_capacity") && data.refresh) return true;
  const filters = resultFilters(data);
  return filters?.source === "pending" && filters.stopped === false;
}

/** The states that offer "Buscar novamente" (oil-quote "Buscar novamente asks for a new research"). */
function offersRefetch(data: QuoteOptionsResult | undefined): boolean {
  if (!data) return false;
  if (data.status === "no_spec") return data.reason === "no_source";
  return data.status !== "researching";
}

/** The shown row's date, for the three states that show a stored row; null otherwise. */
function rowDate(data: QuoteOptionsResult | undefined): string | null {
  if (data?.status === "options" || data?.status === "empty" || data?.status === "no_capacity") return data.consultedAt;
  return null;
}

/**
 * Whether a newer read is held back behind the shown options (D17): the attendant edited them,
 * and the read brings a different row. A read that carries `refresh` is never held — it is the
 * answer to "Buscar novamente" or a search under way, and its progress must show; it becomes the
 * shown row, and a later read that ends that search is the one held.
 */
function holdsShownRow(shown: QuoteOptionsResult | undefined, latest: QuoteOptionsResult, edited: boolean, holdable: boolean): boolean {
  if (!edited || !holdable || shown === undefined) return false;
  if ((latest.status === "options" || latest.status === "empty" || latest.status === "no_capacity") && latest.refresh) return false;
  const newer = rowDate(latest);
  return newer != null && newer !== rowDate(shown);
}

/**
 * Whether the shown state holds a quote the attendant can edit (D17, extended to D24's dead ends):
 * the options, the missing volume once a typed volume priced it, and a conflict with its cards.
 */
function shownIsEditable(shown: QuoteOptionsResult | undefined, typed: boolean): boolean {
  return shown?.status === "options" || (shown?.status === "no_capacity" && typed) || isCardConflict(shown);
}

/**
 * A held newer row turns the status into "Chegaram dados novos de {data}." with "Atualizar" (D17),
 * so a screen reader hears what changed; the shown row's date (or a conflict's own sentence) moves
 * to its own line.
 */
function withHeld(view: QuoteStatusView, heldNewer: QuoteOptionsResult | null, onUpdate: () => void): QuoteStatusView {
  const newer = rowDate(heldNewer ?? undefined);
  if (newer == null) return view;
  if (view.kind === "row") return { kind: "row", dateText: view.dateText, held: { text: newDataSentence(newer), onUpdate } };
  if (view.kind === "notice") return { kind: "row", dateText: view.text, held: { text: newDataSentence(newer), onUpdate } };
  return view;
}

/**
 * What the status region says for a settled read (D17, D24).
 *
 * @param clarification - The clarification's engine buttons or "Corrigir versão do veículo".
 */
function statusView(data: QuoteOptionsResult, clarification: ReactNode): QuoteStatusView {
  switch (data.status) {
    case "researching":
      return { kind: "researching", timing: data };
    case "options":
    case "empty":
    case "no_capacity":
      return {
        kind: "row",
        dateText: data.newerAttempt ? newerAttemptSentence(data.newerAttempt, data.consultedAt) : consultedSentence(data.consultedAt),
        ...(data.refresh ? { refresh: data.refresh } : {}),
      };
    case "no_spec":
      return {
        kind: "outcome",
        text: data.reason === "incomplete_identity" ? incompleteIdentitySentence(data.missingFields ?? []) : NO_SOURCE_SENTENCE,
      };
    case "error":
      return { kind: "outcome", text: RESEARCH_FAILED_SENTENCE };
    case "needs_clarification":
      return { kind: "outcome", text: clarificationSentence(data.coverage, data.options), details: clarification };
    case "conflicting_sources":
      if (isCardConflict(data)) {
        // No stocked oil for any disputed grade: the no-compatible-brand copy, with the sources.
        if (data.options.length === 0) {
          return { kind: "outcome", text: NO_COMPATIBLE_BRAND, details: <ConflictGradeSources data={data} /> };
        }
        return { kind: "notice", text: disputesGrades(data) ? GRADE_CONFLICT_INTRO : VOLUME_CONFLICT_INTRO };
      }
      return {
        kind: "outcome",
        text: "As fontes consultadas discordam sobre este veículo. Nenhuma opção é exibida até que a divergência seja resolvida. A primeira de cada lista é a fonte de maior autoridade.",
        details: <ConflictLists conflicts={data.conflicts} />,
      };
  }
}

/** Portuguese name for each field two sources can disagree on. */
const CONFLICT_FIELD_LABEL: Record<"viscosityGrades" | "fillLiters", string> = {
  viscosityGrades: "Viscosidade",
  fillLiters: "Volume de troca",
};

/** The two filter slots a quote prices, in the order the dialog shows them. */
const FILTER_TYPES = ["oil", "fuel"] as const;

type FilterType = (typeof FILTER_TYPES)[number];

/** pt-BR label for each slot, used by the chooser and the warnings. */
const FILTER_LABEL: Record<FilterType, string> = {
  oil: "Filtro de óleo",
  fuel: "Filtro de combustível",
};

/** Same label lowercased, for mid-sentence use in the caption and the warnings. */
const FILTER_LABEL_INLINE: Record<FilterType, string> = {
  oil: "filtro de óleo",
  fuel: "filtro de combustível",
};

/** pt-BR name of the identity field Tecfil could not match, named in the warning. */
const UNMATCHED_FIELD_LABEL: Record<string, string> = {
  manufacturer: "montadora",
  vehicle: "veículo",
  engine: "motor",
  year: "ano",
};

/**
 * Formats an amount for the editable price box the way the attendant types it back.
 * @param value - Amount in BRL; rounded to cents so a composite price never shows
 * floating-point noise.
 */
function formatPriceInput(value: number) {
  return (Math.round(value * 100) / 100).toFixed(2).replace(".", ",");
}

/**
 * Rounds a BRL amount to cents, half away from zero (design D4).
 *
 * `Math.round` alone rounds half UP, which biases a negative amount the wrong way; a quote
 * total is never negative today, but the rule is stated in BRL terms so it is implemented
 * in BRL terms rather than left to depend on that.
 *
 * @param value - Unrounded amount.
 * @returns The amount to two decimal places.
 */
function roundBrl(value: number): number {
  const cents = Math.round(Math.abs(value) * 100) / 100;
  return value < 0 ? -cents : cents;
}

/** What the priced volume is, as the card caption says it (D5). */
const PRICED_FILL_CAPTION: Record<PricedFillCondition, string> = {
  with_filter: "com filtro",
  unlabeled: "volume sem legenda",
};

/** A volume a change does not use, as the no-capacity message names it (D5). */
const UNUSABLE_FILL_LABEL: Record<UnusableFillCondition, string> = {
  without_filter: "sem filtro",
  dry: "seco",
};

/** The candidate a slot prices without asking, i.e. the only one it offers. */
function soleCandidateId(slot: QuoteFilterSlot | undefined) {
  return slot?.status === "matched" && slot.candidates.length === 1 ? slot.candidates[0]!.id : null;
}

/** The chosen card of a slot, or null while a multi-candidate slot has no choice yet. */
function chosenCard(slot: QuoteFilterSlot | undefined, id: string | null): QuoteFilterCard | null {
  if (slot?.status !== "matched" || id == null) {
    return null;
  }
  return slot.candidates.find((row) => row.id === id) ?? null;
}

/**
 * Whether a slot still waits on the attendant: two or more candidates and none chosen. Such a slot
 * blocks the send (owner ruling 2026-10-04); one candidate is chosen for them, and an unresolved
 * slot only warns.
 */
function awaitsChoice(slot: QuoteFilterSlot | undefined, id: string | null): boolean {
  return slot?.status === "matched" && slot.candidates.length > 1 && chosenCard(slot, id) == null;
}

/** The blocked send's look: the theme's disabled tokens, since the button is never `disabled` (D2). */
const BLOCKED_SEND_SX = {
  bgcolor: "action.disabledBackground",
  color: "action.disabled",
  boxShadow: "none",
  "&:hover": { bgcolor: "action.disabledBackground", boxShadow: "none" },
} as const;

/**
 * How many sources the conflict consulted: the distinct sources across every disputed field's
 * values. A volume that is not disputed is one all of them agree on.
 */
function consultedSourceCount(data: ConflictResult): number {
  const sources = data.conflicts.flatMap((conflict) =>
    conflict.values.map((value) => `${value.sourcePublisher}|${value.sourceDocument}|${value.sourcePage}`),
  );
  return new Set(sources).size;
}

/** A volume choice's identity: its litres and its source, so a reordered payload keeps the choice. */
function volumeChoiceKey(choice: QuoteVolumeChoice): string {
  const { source } = choice;
  return [choice.liters, source.sourcePublisher, source.sourceDocument, source.sourcePage].join("|");
}

/** The grade a card matched, compared the way the catalog matched it: trimmed, case-insensitive. */
function sameGrade(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The volume the cards are priced from, and how each card names it. `liters` null: not yet known
 * (a conflict's volume to choose, a missing volume to type), so nothing is priced.
 */
type CardPricing = {
  liters: number | null;
  /** What the volume is, for the price caption (D5). */
  fillCaption: string;
  /** The card's volume line (D24): the attendant's, a kept one, or the chosen source's. */
  flag: string | null;
  /** The chosen volume's source page, linked under the flag. */
  flagUrl: string | null;
};

/** A kept or typed volume, in the field's in-service terms (D24.1). */
function attendantPricing(attendantFill: AttendantFill | undefined, typed: { liters: number } | null): CardPricing {
  if (attendantFill) {
    return { liters: attendantFill.liters, fillCaption: PRICED_FILL_CAPTION.with_filter, flag: storedFillFlag(attendantFill), flagUrl: null };
  }
  if (typed) {
    return { liters: typed.liters, fillCaption: PRICED_FILL_CAPTION.with_filter, flag: typedFillFlag(typed.liters), flagUrl: null };
  }
  return { liters: null, fillCaption: "", flag: null, flagUrl: null };
}

/** The identity a kept volume is stored for, as the prompt names it: make, model, version, year. */
function identityName(vehicle: Vehicle): string {
  return [vehicle.make, vehicle.model, vehicle.version, vehicle.year == null ? null : String(vehicle.year)]
    .filter((part): part is string => part != null && part.trim() !== "")
    .join(" ");
}

export function OilQuoteDialog({
  vehicle: snapshot,
  conversationId,
  onClose,
  onConfirmed,
  onCorrectVersion,
}: {
  vehicle: Vehicle;
  conversationId: string;
  onClose: () => void;
  onConfirmed: (text: string) => void;
  /**
   * "Corrigir versão do veículo" (D24.2): the rail closes the dialog and opens the vehicle's form
   * in the Veículo drill-in, the version focused.
   */
  onCorrectVersion?: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [priceTouched, setPriceTouched] = useState<Set<string>>(() => new Set());
  const [choice, setChoice] = useState<Record<FilterType, string | null>>({ oil: null, fuel: null });
  const [message, setMessage] = useState("");
  const [messageTouched, setMessageTouched] = useState(false);
  // The missing volume (D24.1): the field's text, what it says, the volume in use, the prompt.
  const [volumeRaw, setVolumeRaw] = useState("");
  const [volumeProblem, setVolumeProblem] = useState<FillVolumeProblem>(null);
  const [typedFill, setTypedFill] = useState<{ liters: number; high: boolean } | null>(null);
  const [askSave, setAskSave] = useState<{ liters: number; high: boolean } | null>(null);
  // A conflict's choices (D24.3): nothing is preselected.
  const [chosenGrade, setChosenGrade] = useState<string | null>(null);
  const [chosenVolume, setChosenVolume] = useState<string | null>(null);
  const useVolumeRef = useRef<HTMLButtonElement | null>(null);
  const persistLock = useRef(false);
  const queryClient = useQueryClient();
  const optionsKey = ["quote-options", snapshot.id];
  const vehiclesKey = ["conversation-vehicles", conversationId];
  // The rail's own vehicle list, read, never fetched from here: after an engine pick it brings the
  // corrected version (D24.2).
  const vehiclesQuery = useQuery({
    queryKey: vehiclesKey,
    queryFn: () => fetchConversationVehicles(conversationId),
    enabled: false,
  });
  const vehicle = vehiclesQuery.data?.vehicles.find((row) => row.id === snapshot.id) ?? snapshot;
  const optionsQuery = useQuery({
    queryKey: optionsKey,
    queryFn: () => fetchQuoteOptions(snapshot.id),
    // The read calls no provider (D15), but it is still sent only when the dialog asks: no retry,
    // no refetch on focus or reconnect (D2, D17). While research runs, it polls every 3 s.
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => (quoteStillResolving(query.state.data) ? QUOTE_POLL_MS : false),
  });
  // "Buscar novamente" (D16): a POST, sent only on the click; its body is written into the read's
  // cache, so the dialog shows the new search and starts polling with no extra GET.
  const refetch = useMutation({
    mutationFn: () => requestOilRefetch(snapshot.id),
    onSuccess: (body) => {
      queryClient.setQueryData(optionsKey, body);
    },
  });
  // An engine chosen in a clarification (D24.2): its answer is written into the read, as a
  // refetch's is; a 409 means the identity moved on, so the dialog reads the quote again.
  // When the pick succeeded: the corrected version is read only from a vehicle list fetched after
  // it, never from the list the dialog already held (review of PR 198).
  const [pickedAt, setPickedAt] = useState<number | null>(null);
  const enginePick = useMutation({
    mutationFn: (engine: string) => pickOilEngine(snapshot.id, engine),
    onSuccess: (body) => {
      setPickedAt(Date.now());
      queryClient.setQueryData(optionsKey, body);
      void queryClient.invalidateQueries({ queryKey: vehiclesKey });
    },
    onError: (error) => {
      if (oilActionRefusalStatus(error) !== 409) return;
      void optionsQuery.refetch();
      // `version_changed`: the version moved under the pick; the rail shows the one it moved to.
      if ((error as { body?: { reason?: string } }).body?.reason === "version_changed") {
        void queryClient.invalidateQueries({ queryKey: vehiclesKey });
      }
    },
  });
  /** A pick that failed for no reason the dialog can act on: a 500, or no answer at all. */
  const pickFailed = enginePick.isError && ![409, 422].includes(oilActionRefusalStatus(enginePick.error) ?? 0);
  // "Guardar para este modelo" (D24.1): the dialog stays open, its cards priced, whatever the answer.
  const saveLock = useRef(false);
  const saveFill = useMutation({
    mutationFn: (fill: { liters: number; high: boolean }) =>
      recordOilFillVolume(snapshot.id, { liters: fill.liters, ...(fill.high ? { confirmHighVolume: true } : {}) }),
    onSettled: () => {
      saveLock.current = false;
    },
  });
  // A refused submit bumps this, so the same sentence is read again (the status's span is replaced).
  const [refusals, setRefusals] = useState(0);
  const persist = useMutation({
    mutationFn: (body: { generatedMessageText: string; lines: { catalogItemId: string; price: number }[] }) =>
      createOilQuote(snapshot.id, { conversationId, ...body }),
    onSuccess: (created) => {
      onConfirmed(created.generatedMessageText);
    },
    onSettled: () => {
      persistLock.current = false;
    },
  });

  // What the dialog shows is normally the latest read. A refresh that ends with a newer row while
  // the attendant has edited a price or the message is held back instead (D17): the shown row and
  // its edits stay, and "Chegaram dados novos" offers the newer one. Derived during render (the
  // previous-render pattern), so the newer cards never flash in before the hold.
  const latest: QuoteOptionsResult | undefined = optionsQuery.data;
  const edited = priceTouched.size > 0 || messageTouched;
  const [seenLatest, setSeenLatest] = useState<QuoteOptionsResult | undefined>(undefined);
  const [shown, setShown] = useState<QuoteOptionsResult | undefined>(undefined);
  if (latest !== seenLatest) {
    setSeenLatest(latest);
    if (latest !== undefined && holdsShownRow(shown, latest, edited, shownIsEditable(shown, typedFill != null))) {
      // The shown row stays, without the search that has now ended.
      setShown((current) =>
        current?.status === "options" || current?.status === "no_capacity" ? { ...current, refresh: undefined } : current,
      );
    } else {
      if (rowDate(shown) !== rowDate(latest)) {
        // A different row: its cards are selected afresh, as on opening.
        setSelectedIds([]);
        if (!edited) {
          // The silent swap (D17): nothing edited, so the prices and the message start over.
          setPrices({});
          setPriceTouched(new Set());
          setMessage("");
          setMessageTouched(false);
        }
      }
      if (shown?.status !== latest?.status) {
        // A different state: the choices made in the last one do not carry over.
        setChosenGrade(null);
        setChosenVolume(null);
        setTypedFill(null);
        setVolumeProblem(null);
      }
      setShown(latest);
    }
  }
  const data = shown ?? latest;
  const heldNewer = latest !== undefined && data !== latest && rowDate(latest) != null && rowDate(latest) !== rowDate(data) ? latest : null;

  // A later clarification, after a pick whose re-read could not settle it, offers its engines again.
  useEffect(() => {
    if (data?.status === "needs_clarification" && enginePick.isSuccess) enginePick.reset();
  }, [data, enginePick]);

  /** "Atualizar": shows the newer row and drops the edits made on the old one. */
  function showNewer() {
    setShown(latest);
    setSelectedIds([]);
    setPrices({});
    setPriceTouched(new Set());
    setChoice({ oil: null, fuel: null });
    setMessage("");
    setMessageTouched(false);
  }

  const filters = resultFilters(data);
  // Derived, not stored: a slot with exactly one candidate is priced in without a chooser,
  // and an explicit choice always wins over it.
  const chosenIds: Record<FilterType, string | null> = {
    oil: choice.oil ?? soleCandidateId(filters?.oil),
    fuel: choice.fuel ?? soleCandidateId(filters?.fuel),
  };
  const chosenCards: Record<FilterType, QuoteFilterCard | null> = {
    oil: chosenCard(filters?.oil, chosenIds.oil),
    fuel: chosenCard(filters?.fuel, chosenIds.fuel),
  };
  const filtersTotal = (chosenCards.oil?.price ?? 0) + (chosenCards.fuel?.price ?? 0);

  // The volume, per state (D24). A conflict with no stated volume prices like the missing volume.
  const conflict = isCardConflict(data) ? data : null;
  const gradeDispute = conflict != null && disputesGrades(conflict);
  const volumeChoices = conflict?.volumeChoices;
  const conflictNeedsTypedVolume = conflict != null && conflict.fillLiters === undefined && volumeChoices === undefined && !conflict.attendantFill;
  let pricing: CardPricing = { liters: null, fillCaption: "", flag: null, flagUrl: null };
  if (data?.status === "options") {
    pricing = data.attendantFill
      ? attendantPricing(data.attendantFill, null)
      : { liters: data.fillLiters, fillCaption: PRICED_FILL_CAPTION[data.fillCondition], flag: null, flagUrl: null };
  } else if (data?.status === "no_capacity") {
    pricing = attendantPricing(undefined, typedFill);
  } else if (conflict) {
    if (conflict.fillLiters !== undefined && conflict.fillCondition !== undefined) {
      pricing = { liters: conflict.fillLiters, fillCaption: PRICED_FILL_CAPTION[conflict.fillCondition], flag: null, flagUrl: null };
    } else if (volumeChoices) {
      const picked = chosenVolume == null ? undefined : volumeChoices.find((row) => volumeChoiceKey(row) === chosenVolume);
      pricing = picked
        ? { liters: picked.liters, fillCaption: PRICED_FILL_CAPTION[picked.fillCondition], flag: chosenVolumeFlag(picked), flagUrl: picked.source.sourceUrl }
        : { liters: null, fillCaption: "", flag: null, flagUrl: null };
    } else {
      pricing = attendantPricing(conflict.attendantFill, typedFill);
    }
  }
  const liters = pricing.liters;
  // An unpriced card's price: "informe o volume" where no source stated one, else "escolha o volume".
  const unpricedLabel = conflictNeedsTypedVolume ? TYPE_VOLUME_PRICE : CHOOSE_VOLUME_PRICE;
  // The corrected version is shown only once the vehicle list has been fetched after the pick.
  const versionRefreshed = pickedAt != null && vehiclesQuery.dataUpdatedAt > pickedAt;

  // The quote's cards: the options; the missing volume's once a volume is used; a grade conflict's
  // chosen grade (every stocked oil of it, the other grade's dropped), or a volume conflict's.
  let catalogRows: QuoteOptionCard[] = [];
  if (data?.status === "options") catalogRows = data.options;
  else if (data?.status === "no_capacity") catalogRows = typedFill ? data.options : [];
  else if (conflict) {
    catalogRows = gradeDispute
      ? chosenGrade == null
        ? []
        : conflict.options.filter((row) => sameGrade(row.lubricant.viscosity, chosenGrade))
      : conflict.options;
  }
  const cardIds = catalogRows.map((row) => row.id).join(",");

  // When the quote's cards or its volume change — another grade, another volume choice, another
  // typed volume — the message is rebuilt and the prices edited on cards that left are dropped: an
  // edited message would still name the old oils at the old prices, and must never reach the
  // customer (review of PR 198).
  const quoteBasis = `${cardIds}|${liters ?? ""}`;
  const [seenBasis, setSeenBasis] = useState(quoteBasis);
  if (quoteBasis !== seenBasis) {
    setSeenBasis(quoteBasis);
    setMessage("");
    setMessageTouched(false);
    const stay = new Set(catalogRows.map((row) => row.id));
    setPriceTouched((current) => new Set([...current].filter((id) => stay.has(id))));
    setPrices((current) => Object.fromEntries(Object.entries(current).filter(([id]) => stay.has(id))));
  }

  useEffect(() => {
    if (catalogRows.length === 0) {
      return;
    }
    if (liters != null) {
      setPrices((current) => {
        const next = { ...current };
        for (const row of catalogRows) {
          if (!priceTouched.has(row.id)) {
            next[row.id] = formatPriceInput(roundBrl(row.price * liters) + filtersTotal);
          }
        }
        return next;
      });
    }
    setSelectedIds((current) => (current.length === 0 ? catalogRows.map((row) => row.id) : current));
    // `catalogRows` is derived each render; `cardIds` is its identity.
  }, [cardIds, liters, filtersTotal, priceTouched]);

  const selectedRows =
    liters == null
      ? []
      : selectedIds
          .map((id) => catalogRows.find((row) => row.id === id))
          .filter((row): row is QuoteOptionCard => row != null)
          .map((row) => ({
            name: oilCardName(row),
            oilType: row.lubricant.oilType,
            price: parseOfferedPrice(prices[row.id] ?? "") ?? roundBrl(row.price * liters) + filtersTotal,
            catalogItemId: row.id,
          }));
  const liveMessage = assembleOilQuoteMessage(selectedRows);
  const displayMessage = messageTouched ? message : liveMessage;
  const title = joinDot([vehicleIdentity(vehicle), vehicle.plate]) || "veículo";
  // The quote can be assembled once its volume is known and, on a grade conflict, its grade chosen.
  const quoteReady = liters != null && catalogRows.length > 0;
  const showsSend =
    data?.status === "options" || (data?.status === "no_capacity" && typedFill != null) || (conflict != null && conflict.options.length > 0);
  const confirmBlocked = !quoteReady || persist.isPending || selectedRows.length === 0 || displayMessage.trim() === "";
  // The message says the filters are included, so a type with several candidates and no choice
  // holds the send (owner ruling 2026-10-04): said beside the button and through the status, the
  // button `aria-disabled` so it keeps focus. Only once there is a quote that could otherwise go.
  const filterHint =
    showsSend && quoteReady
      ? filterChoiceHint({ oil: awaitsChoice(filters?.oil, chosenIds.oil), fuel: awaitsChoice(filters?.fuel, chosenIds.fuel) })
      : null;
  const filterHintId = useId();

  function toggleCard(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((row) => row !== id) : [...current, id],
    );
  }

  /** "Usar este volume" (D24.1): an invalid value prices nothing; above 30 L it asks to confirm. */
  function submitTypedVolume() {
    const parsed = parseTypedFillVolume(volumeRaw);
    if (parsed.kind === "invalid" || parsed.kind === "high") {
      // A refused value prices nothing, so the volume used before it stops pricing the cards; the
      // new problem outranks a stale save failure, and a repeat is read again.
      setVolumeProblem(parsed.kind);
      setTypedFill(null);
      saveFill.reset();
      setRefusals((count) => count + 1);
      return;
    }
    applyTypedVolume(parsed.liters, false);
  }

  /** Prices the cards from a typed volume and asks whether to keep it for the model. */
  function applyTypedVolume(value: number, high: boolean) {
    setVolumeProblem(null);
    setTypedFill({ liters: value, high });
    setAskSave({ liters: value, high });
    saveFill.reset();
  }

  /** Either answer closes the prompt; focus goes back to "Usar este volume". */
  function closePrompt(save: boolean) {
    if (save && askSave && !saveLock.current) {
      saveLock.current = true;
      saveFill.mutate(askSave);
    }
    setAskSave(null);
    // After the dialog's own focus trap lets go.
    setTimeout(() => useVolumeRef.current?.focus(), 0);
  }

  /** Changing the text clears what the field said about the previous value. */
  function changeVolumeText(raw: string) {
    setVolumeRaw(raw);
    setVolumeProblem(null);
  }

  /** Choosing another grade drops the other grade's cards and selects the new grade's afresh. */
  function chooseGrade(grade: string) {
    if (grade === chosenGrade) return;
    setChosenGrade(grade);
    setSelectedIds([]);
  }

  /**
   * Breakdown under one card's price: the unit price and the volume it was multiplied by,
   * with what that volume is (D5: with the filter, or unlabeled), the oil subtotal, each
   * priced filter, and the Tecfil application.
   *
   * @param unitPrice - Catalog price of one litre of that oil.
   */
  function priceCaption(unitPrice: number) {
    if (filters == null || liters == null) {
      return null;
    }
    const subtotal = roundBrl(unitPrice * liters);
    const parts = [
      `Óleo ${formatQuotePrice(unitPrice)}/L × ${formatLiters(liters)} (${pricing.fillCaption}) = ${formatQuotePrice(subtotal)}`,
    ];
    const pending: string[] = [];
    for (const type of FILTER_TYPES) {
      const card = chosenCards[type];
      if (card != null) {
        parts.push(`${FILTER_LABEL_INLINE[type]} ${formatQuotePrice(card.price)}`);
      } else if (filters[type].status === "matched") {
        pending.push(`${FILTER_LABEL_INLINE[type]} ainda não escolhido`);
      }
    }
    const application = filters.application;
    const applicationText =
      application == null
        ? null
        : `Tecfil: ${[application.manufacturer, application.vehicle, application.engine]
            .filter((part): part is string => part != null && part !== "")
            .join(" ")}`;
    return [parts.join(" + "), ...pending, applicationText].filter(Boolean).join(" — ");
  }

  /** The card's price text before it is editable: the job price, or "escolha o volume". */
  function previewPrice(unitPrice: number): string {
    return liters == null ? unpricedLabel : formatQuotePrice(roundBrl(unitPrice * liters) + filtersTotal);
  }

  /** The filter warnings and multi-candidate choosers, above any priced cards. */
  const filterControls =
    filters == null ? null : (
      <>
        <FilterNotices filters={filters} />
        {FILTER_TYPES.map((type) => {
          const slot = filters[type];
          if (slot.status !== "matched" || slot.candidates.length < 2) {
            return null;
          }
          return (
            <Stack key={type} spacing={0.5}>
              <Typography variant="caption">{FILTER_LABEL[type]}</Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                aria-label={FILTER_LABEL[type]}
                value={chosenIds[type]}
                onChange={(_event, value: string | null) => setChoice((current) => ({ ...current, [type]: value }))}
              >
                {slot.candidates.map((candidate) => (
                  <ToggleButton key={candidate.id} value={candidate.id}>
                    {candidate.brand} {candidate.description} · {candidate.filter.partNumber} · {formatQuotePrice(candidate.price)}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Stack>
          );
        })}
      </>
    );

  /** One selectable, priced card: the options' card, also used by the dead ends' quotes. */
  function renderCard(row: QuoteOptionCard & { gradeSource?: QuoteConflictSource }) {
    const selected = selectedIds.includes(row.id);
    const typeLabel = oilTypeLabel(row.lubricant.oilType);
    return (
      <Paper
        key={row.id}
        variant="outlined"
        sx={{
          p: 1.5,
          flex: 1,
          minWidth: 180,
          borderRadius: 1,
          borderWidth: selected ? 2 : 1,
          borderColor: selected ? "primary.main" : "divider",
          bgcolor: selected ? "primaryContainer" : "background.paper",
        }}
      >
        <Button
          size="small"
          onClick={() => toggleCard(row.id)}
          sx={{ justifyContent: "flex-start", mb: 1, color: "onPrimaryContainer" }}
        >
          {selected ? "✓ " : ""}
          {oilCardName(row)}
        </Button>
        {/* The canvas's "Sintético · R$ …": the type beside the price. None for an untyped oil. */}
        {typeLabel != null ? (
          <Typography variant="caption" sx={{ display: "block", mb: 1, color: "onPrimaryContainer" }}>
            {typeLabel}
          </Typography>
        ) : null}
        {liters == null ? (
          <Typography variant="body2" sx={{ color: "onPrimaryContainer" }}>
            Preço: {unpricedLabel}
          </Typography>
        ) : (
          <TextField
            size="small"
            label="Preço"
            value={prices[row.id] ?? ""}
            onChange={(event) => {
              setPriceTouched((current) => new Set(current).add(row.id));
              setPrices((current) => ({ ...current, [row.id]: event.target.value }));
            }}
          />
        )}
        <Typography variant="caption" sx={{ display: "block" }}>
          {priceCaption(row.price)}
        </Typography>
        {pricing.flag ? (
          <Typography variant="caption" sx={{ display: "block", fontWeight: 600, color: "onPrimaryContainer" }}>
            {pricing.flag}
            {pricing.flagUrl ? <SourceLink url={pricing.flagUrl} /> : null}
          </Typography>
        ) : null}
        {row.gradeSource ? (
          <Typography variant="caption" sx={{ display: "block" }}>
            {gradeCitation(row.gradeSource)}
            {row.gradeSource.sourceUrl ? <SourceLink url={row.gradeSource.sourceUrl} /> : null}
          </Typography>
        ) : data?.status === "options" ? (
          <CardSource grade={row.lubricant.viscosity} gradeSources={data.gradeSources} />
        ) : null}
      </Paper>
    );
  }

  /** The quote's cards and its message, once there is something to assemble. */
  const cardsAndMessage = (
    <>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} useFlexGap sx={{ flexWrap: "wrap" }}>
        {catalogRows.map((row) => renderCard(row))}
      </Stack>
      {quoteReady ? (
        <TextField
          label="Mensagem"
          multiline
          minRows={8}
          value={displayMessage}
          onChange={(event) => {
            setMessageTouched(true);
            setMessage(event.target.value);
          }}
        />
      ) : null}
    </>
  );

  const clarification =
    data?.status === "needs_clarification" ? (
      <EngineChoices
        engines={data.options}
        picking={enginePick.isPending || enginePick.isSuccess}
        versionTooLong={oilActionRefusalStatus(enginePick.error) === 422}
        failed={pickFailed}
        onPick={(engine) => {
          if (!enginePick.isPending && !enginePick.isSuccess) enginePick.mutate(engine);
        }}
        onCorrectVersion={() => onCorrectVersion?.()}
      />
    ) : null;

  // The sentences the one status element reads beside the shown state (D24.1): the volume's
  // warning or refusal, a failed save, a failed quote save.
  // A new volume problem outranks a save failure (a refused submit resets the save).
  const announcementText =
    volumeProblem === "invalid"
      ? FILL_VOLUME_INVALID
      : volumeProblem === "high"
        ? FILL_VOLUME_HIGH
        : saveFill.isError
          ? SAVE_FILL_FAILED
          : pickFailed
            ? ENGINE_PICK_FAILED
            : persist.isError
              ? "Não foi possível salvar o orçamento"
              : filterHint;
  const announcement = announcementText == null ? null : { text: announcementText, key: refusals };

  const volumeField = (
    <FillVolumeField
      value={volumeRaw}
      onChange={changeVolumeText}
      problem={volumeProblem}
      onUse={submitTypedVolume}
      onConfirmHigh={() => {
        const parsed = parseTypedFillVolume(volumeRaw);
        if (parsed.kind !== "invalid") applyTypedVolume(parsed.liters, true);
      }}
      useButtonRef={useVolumeRef}
    />
  );

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Montar orçamento — {title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {/* The engine pick's confirmation sits above the status region, in a slot of its own,
              so the region keeps its place in the tree. */}
          {data?.status === "researching" && data.path === "engine_pick" && versionRefreshed && vehicle.version ? (
            <Typography
              component="div"
              sx={{ px: 1.5, py: 1, borderRadius: 0.5, typography: "caption", fontWeight: 600, bgcolor: "successContainer", color: "onSuccessContainer" }}
            >
              {correctedVersionSentence(vehicle.version)}
            </Typography>
          ) : null}
          {/* The status region keeps one place in the tree, so its role="status" element stays
              mounted from the loading read to the outcome (D17). */}
          <QuoteStatusRegion
            view={
              data !== undefined
                ? withHeld(statusView(data, clarification), heldNewer, showNewer)
                : optionsQuery.isError
                  ? { kind: "load_error", onRetry: () => void optionsQuery.refetch() }
                  : { kind: "loading" }
            }
            receivedAt={optionsQuery.dataUpdatedAt}
            announcement={announcement}
            {...(offersRefetch(data)
              ? { refetch: { onRefetch: () => refetch.mutate(), pending: refetch.isPending, failed: refetch.isError } }
              : {})}
          />
          {data?.status === "no_capacity" ? (
            <>
              <OutcomeBox>
                {data.unusableFill ? (
                  <Typography variant="body2">
                    Encontramos a viscosidade ({data.viscosityGrades.join(" ou ")}) e um volume{" "}
                    {UNUSABLE_FILL_LABEL[data.unusableFill.condition]} de {formatLiters(data.unusableFill.liters)},
                    mas esse não é o volume usado numa troca de óleo. Informe o volume da troca para calcular o valor.
                  </Typography>
                ) : (
                  <Typography variant="body2">
                    Encontramos a viscosidade ({data.viscosityGrades.join(" ou ")}), mas não o volume
                    de óleo da troca para este veículo. Informe o volume da troca para calcular o valor.
                  </Typography>
                )}
                {volumeField}
              </OutcomeBox>
              {typedFill ? (
                <>
                  <Typography variant="caption">
                    Viscosidades aceitas: {data.viscosityGrades.join(" ou ")}
                    {data.classification === "" ? "" : `, ${data.classification}`}
                  </Typography>
                  {filterControls}
                  {cardsAndMessage}
                </>
              ) : null}
            </>
          ) : data?.status === "empty" ? (
            <OutcomeBox centered>
              <Typography variant="body2">{NO_COMPATIBLE_BRAND}</Typography>
            </OutcomeBox>
          ) : data?.status === "options" && filters != null ? (
            <>
              <Typography variant="caption">
                Viscosidades aceitas: {data.viscosityGrades.join(" ou ")}
                {data.classification === "" ? "" : `, ${data.classification}`}
                {/* A kept volume is said on each card instead (D24). */}
                {data.attendantFill ? "" : ` — volume de troca ${formatLiters(data.fillLiters)}`}
              </Typography>
              <QuoteSources gradeSources={data.gradeSources} litersSource={data.litersSource} />
              {filterControls}
              {cardsAndMessage}
            </>
          ) : conflict != null && conflict.options.length > 0 ? (
            <>
              {/* The volume: agreed, a choice among the sources', or — none stated — typed. */}
              {conflict.fillLiters !== undefined ? (
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  Volume de troca {formatLiters(conflict.fillLiters)} —{" "}
                  {consultedSourceCount(conflict) === 2 ? "as duas fontes concordam" : "as fontes concordam"}
                  {conflict.litersSource ? ` (${conflictCitation(conflict.litersSource)})` : ""}
                </Typography>
              ) : volumeChoices ? (
                <ChoiceGroup
                  label={gradeDispute ? VOLUME_ALSO_CONFLICT_INTRO : null}
                  ariaLabel={gradeDispute ? undefined : "Volume de óleo da troca"}
                  marker="check"
                  choices={volumeChoices.map((row) => ({ key: volumeChoiceKey(row), text: volumeChoiceText(row) }))}
                  value={chosenVolume}
                  onChange={setChosenVolume}
                />
              ) : conflictNeedsTypedVolume ? (
                volumeField
              ) : null}
              {gradeDispute ? (
                <>
                  <ChoiceGroup
                    label={null}
                    ariaLabel="Viscosidade"
                    marker="radio"
                    choices={conflict.gradeSources.map((row) => ({ key: row.grade, text: `${row.grade} — ${gradeCitation(row)}` }))}
                    value={chosenGrade}
                    onChange={chooseGrade}
                    after={(grade) =>
                      chosenGrade == null ? (
                        <GradePreviewCards
                          rows={conflict.options.filter((row) => sameGrade(row.lubricant.viscosity, grade))}
                          price={previewPrice}
                        />
                      ) : null
                    }
                  />
                  {filterControls}
                  {chosenGrade != null ? cardsAndMessage : null}
                </>
              ) : (
                <>
                  <Typography variant="caption">
                    Viscosidades aceitas: {conflict.viscosityGrades.join(" ou ")}
                    {conflict.classification === "" ? "" : `, ${conflict.classification}`}
                  </Typography>
                  {filterControls}
                  {cardsAndMessage}
                </>
              )}
            </>
          ) : null}
          {saveFill.isError ? (
            <NoticeBox tone="error">{SAVE_FILL_FAILED}</NoticeBox>
          ) : null}
          {persist.isError ? (
            <NoticeBox tone="error">Não foi possível salvar o orçamento</NoticeBox>
          ) : persist.isSuccess ? (
            <NoticeBox tone="success">Orçamento salvo</NoticeBox>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        {filterHint ? (
          <Typography id={filterHintId} variant="body2" sx={{ mr: "auto", pl: 1, fontWeight: 600, color: "text.primary" }}>
            {filterHint}
          </Typography>
        ) : null}
        <Button onClick={onClose}>Fechar</Button>
        {showsSend ? (
          <Button
            variant="contained"
            color="whatsapp"
            disabled={confirmBlocked}
            aria-disabled={filterHint != null || undefined}
            aria-describedby={filterHint ? filterHintId : undefined}
            sx={filterHint ? BLOCKED_SEND_SX : undefined}
            onClick={() => {
              if (filterHint != null) {
                // The guard (D2): nothing is saved; the hint is read again.
                setRefusals((count) => count + 1);
                return;
              }
              if (persistLock.current || persist.isPending) {
                return;
              }
              persistLock.current = true;
              const filterLines = FILTER_TYPES.map((type) => chosenCards[type])
                .filter((card): card is QuoteFilterCard => card != null)
                .map((card) => ({ catalogItemId: card.id, price: card.price }));
              persist.mutate({
                generatedMessageText: displayMessage.trim(),
                lines: [
                  ...selectedRows.map((row) => ({ catalogItemId: row.catalogItemId, price: row.price })),
                  ...filterLines,
                ],
              });
            }}
          >
            Enviar via WhatsApp
          </Button>
        ) : null}
      </DialogActions>
      {askSave ? (
        <SaveFillPrompt
          question={saveFillQuestion(askSave.liters, identityName(vehicle))}
          onSave={() => closePrompt(true)}
          onOnlyThisQuote={() => closePrompt(false)}
        />
      ) : null}
    </Dialog>
  );
}

/** A source's page, for the attendant to check; the customer message never carries it. */
function SourceLink({ url }: { url: string }) {
  return (
    <>
      {" — "}
      <Link href={url} target="_blank" rel="noreferrer noopener">
        {url}
      </Link>
    </>
  );
}

/**
 * A disputed grade's cards before a grade is chosen (canvas `.pick-card`): what choosing it would
 * offer, not yet selectable — the choice is by grade (D24.3).
 */
function GradePreviewCards({ rows, price }: { rows: QuoteConflictCard[]; price: (unitPrice: number) => string }) {
  if (rows.length === 0) return null;
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} useFlexGap sx={{ flexWrap: "wrap" }}>
      {rows.map((row) => (
        <Paper key={row.id} variant="outlined" sx={{ p: 1.5, flex: 1, minWidth: 180, borderRadius: 1, display: "flex", flexDirection: "column", gap: 0.75 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {oilCardName(row)}
          </Typography>
          {/* Canvas `.pick-meta`: "Sintético · R$ …"; the price alone for an untyped oil. */}
          <Typography variant="caption">
            {joinDot([oilTypeLabel(row.lubricant.oilType), price(row.price)])}
          </Typography>
        </Paper>
      ))}
    </Stack>
  );
}

/** A conflict with no stocked grade: each disputed grade with the source that lists it. */
function ConflictGradeSources({ data }: { data: CardConflict }) {
  return (
    <Stack spacing={0.25}>
      {data.gradeSources.map((row) => (
        <Typography key={row.grade} variant="caption" sx={{ color: "tertiary" }}>
          {row.grade} — {gradeCitation(row)}
        </Typography>
      ))}
    </Stack>
  );
}

/** An old-shape conflict's litre figure ("4.3") in pt-BR ("4,3 L"); a value that is not a number shows as given. */
function sourceLitersText(value: string): string {
  const liters = Number(value);
  return Number.isFinite(liters) && value.trim() !== "" ? formatSourceLiters(liters) : `${value} L`;
}

/**
 * A conflict stored in the old shape (D24: "Fontes divergentes — registro antigo"): each disputed
 * field with every source's value, highest authority first. It offers no cards.
 */
function ConflictLists({ conflicts }: { conflicts: ConflictResult["conflicts"] }) {
  return (
    <Stack spacing={1}>
      {conflicts.map((conflict) => (
        <Stack key={conflict.field} spacing={0.25}>
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            {CONFLICT_FIELD_LABEL[conflict.field]}
          </Typography>
          {conflict.values.map((entry, index) => (
            <Typography key={`${conflict.field}-${index}`} variant="caption" sx={{ color: "tertiary" }}>
              {conflict.field === "fillLiters" ? sourceLitersText(entry.value) : entry.value} —{" "}
              {entry.sourcePublisher}, {entry.sourceDocument} ({entry.sourcePage})
              {entry.sourceAuthority == null
                ? ""
                : ` — ${AUTHORITY_LABEL[entry.sourceAuthority] ?? `autoridade ${entry.sourceAuthority}`}`}
            </Typography>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * The Portuguese notices above the cards: one warning per unresolved filter type, or a
 * single warning when the whole lookup failed or the vehicle is absent from Tecfil, or the
 * not-yet-consulted notice. Plain notice boxes, never `Alert` (D17: no `role="alert"` in the
 * dialog — these arrive with the cards, often on a poll).
 */
function FilterNotices({ filters }: { filters: QuoteFilters }) {
  if (filters.source === "pending") {
    // Not an Alert: its default role is `alert`, and this notice arrives with the cards (D17).
    return <NoticeBox>{FILTERS_PENDING_SENTENCE}</NoticeBox>;
  }
  if (filters.source === "unavailable") {
    return (
      <NoticeBox tone="warning">
        Não foi possível consultar os filtros na Tecfil — nenhum filtro foi incluído no preço.
      </NoticeBox>
    );
  }
  if (filters.source === "unmatched") {
    const field = filters.unmatchedField == null ? null : UNMATCHED_FIELD_LABEL[filters.unmatchedField];
    return (
      <NoticeBox tone="warning">
        Veículo não encontrado no catálogo da Tecfil
        {field == null ? "" : ` (${field})`} — nenhum filtro foi incluído no preço.
      </NoticeBox>
    );
  }
  const warnings = FILTER_TYPES.map((type) => {
    const slot = filters[type];
    if (slot.status === "matched") {
      return null;
    }
    if (slot.status === "no_catalog_match") {
      return {
        type,
        text: `${FILTER_LABEL[type]} não encontrado no catálogo interno (Tecfil: ${slot.tecfilNumbers.join(", ")}).`,
      };
    }
    if (slot.status === "no_fitment") {
      return { type, text: `A Tecfil não lista ${FILTER_LABEL_INLINE[type]} para este veículo.` };
    }
    return { type, text: `Não foi possível consultar o ${FILTER_LABEL_INLINE[type]} na Tecfil.` };
  }).filter((row): row is { type: FilterType; text: string } => row != null);

  return (
    <>
      {warnings.map((warning) => (
        <NoticeBox key={warning.type} tone="warning">
          {warning.text}
        </NoticeBox>
      ))}
    </>
  );
}
