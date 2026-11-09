/**
 * Picks the Motul motor fill volume the oil-change quote multiplies by (oil-quote-liters-pricing D1).
 */
import type { FlatCapacity, FlatCategoryPart, FlatRecommendation } from "./flatten.js";

/**
 * Motul legend that produced liters a quote may multiply by.
 *
 * `seco` is deliberately absent: dry fill is a real Motul legend, but a troca de óleo is a
 * drain-and-refill, so pouring the dry-fill volume would overfill the engine and overquote
 * the customer. Read it with {@link pickDryFillLiters} when the source record wants it.
 */
export type FillKind = "em_servico" | "unlabeled";

/** Engine fill used as the quote multiplier, or `null` when none is parseable. */
export type PickedFill = { liters: number; kind: FillKind };

type ParsedCapacity = { liters: number; kind: "em_servico" | "seco" | null };

function motorPart(recommendation: FlatRecommendation): FlatCategoryPart | undefined {
  return (
    recommendation.parts.Motor ??
    recommendation.parts.motor ??
    Object.entries(recommendation.parts).find(([key]) => key.toLowerCase() === "motor")?.[1]
  );
}

/**
 * Parses a Motul capacity `volume` string into liters.
 * @param volume - Flatten label such as `4,70`, `4.70`, or `4,70 L`.
 * @returns A positive finite number, or `null` when the string is not a volume.
 */
export function parseCapacityLiters(volume: string): number | null {
  const cleaned = volume.trim().replace(/\s*L$/i, "").replace(",", ".");
  if (cleaned === "") {
    return null;
  }
  const liters = Number(cleaned);
  if (!Number.isFinite(liters) || liters <= 0) {
    return null;
  }
  return liters;
}

function legendKind(note: string | undefined): "em_servico" | "seco" | null {
  if (note == null || note.trim() === "") {
    return null;
  }
  const normalized = note
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  if (/em servico/.test(normalized)) {
    return "em_servico";
  }
  if (/seco/.test(normalized)) {
    return "seco";
  }
  return null;
}

/**
 * Parses every motor capacity Motul listed, dropping unparseable volumes.
 *
 * @param recommendation - Flattened Motul recommendation.
 * @returns Motor capacities with their legend, in Motul's order.
 */
function motorCapacities(recommendation: FlatRecommendation): ParsedCapacity[] {
  const motor = motorPart(recommendation);
  const capacities: FlatCapacity[] = motor?.capacities ?? [];
  return capacities
    .map((capacity) => {
      const liters = parseCapacityLiters(capacity.volume);
      if (liters == null) {
        return null;
      }
      return { liters, kind: legendKind(capacity.note) };
    })
    .filter((row): row is ParsedCapacity => row != null);
}

/**
 * Chooses the motor fill liters a quote may multiply by: service fill first, else a single
 * unlabeled volume. Transmission and other Motul categories are ignored.
 *
 * A source that lists only dry fill yields `null`, not that dry volume — the quote then shows
 * its missing-volume state instead of overfilling the engine.
 *
 * @param recommendation - Flattened Motul recommendation.
 * @returns Liters and the legend behind them, or `null` when no usable motor volume exists
 *   (no capacities, dry fill only, or two unlabeled volumes with nothing to choose between).
 */
export function pickEngineFillLiters(recommendation: FlatRecommendation): PickedFill | null {
  const parsed = motorCapacities(recommendation);

  const service = parsed.find((row) => row.kind === "em_servico");
  if (service) {
    return { liters: service.liters, kind: "em_servico" };
  }
  const unlabeled = parsed.filter((row) => row.kind == null);
  if (unlabeled.length === 1) {
    return { liters: unlabeled[0]!.liters, kind: "unlabeled" };
  }
  return null;
}

/**
 * Reads the dry-fill (`Volume seco`) motor volume so a source record can keep it.
 *
 * This value MUST NOT reach a quote card; it exists for auditing what the source said.
 *
 * @param recommendation - Flattened Motul recommendation.
 * @returns Dry-fill liters, or `null` when the source listed none.
 */
export function pickDryFillLiters(recommendation: FlatRecommendation): number | null {
  return motorCapacities(recommendation).find((row) => row.kind === "seco")?.liters ?? null;
}
