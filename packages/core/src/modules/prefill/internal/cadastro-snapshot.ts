/**
 * The shapes the prefill job and extraction read: job rows, the cadastro
 * snapshot that gates and prompts extraction, prompt lines and window scans.
 *
 * Moved from `apps/worker/src/prefill/store.ts`. The persistence PORT that file
 * declared (`PrefillStore`) is gone: its reads are plain functions over a
 * transaction client (`reads.ts`) and its writes live in the slices that make
 * them, each under `db.tx("prefill", …)`. The shapes and
 * `selectPlateSourcedKeys` are unchanged.
 */
import type { PlateSourcedFieldKey } from "../../plate-lookup/contracts/http.js";
import type { WindowMessage } from "./window.js";

/** Lifecycle status of a cadastro prefill background job. */
export type PrefillJobStatus = "queued" | "running" | "succeeded" | "skipped" | "failed";

/** Stored prefill job row surfaced to the drain. */
export type PrefillJob = {
  id: string;
  conversationId: string;
  status: PrefillJobStatus;
  dirty: boolean;
  lastError: string | null;
  /**
   * The window's `latestInboundAt`: stamped on a finished job with the window it
   * ran on, and set on a queued retry job as the failed window it retries.
   * Null on an ordinary queued job.
   */
  windowLatestInboundAt: Date | null;
};

/**
 * Veículo keys a plate lookup may mark on the titular vehicle.
 *
 * `plate` and `odometerKm` are never included.
 */
export const PREFILL_PLATE_SOURCED_KEYS = [
  "make",
  "model",
  "version",
  "year",
] as const satisfies readonly PlateSourcedFieldKey[];

/** Customer and titular vehicle fields used to gate and prompt prefill extraction. */
export type PrefillCadastroSnapshot = {
  customerId: string | null;
  phoneNormalized: string;
  name: string | null;
  taxId: string | null;
  plate: string | null;
  make: string | null;
  model: string | null;
  version: string | null;
  year: number | null;
  odometerKm: number | null;
  /** Titular-vehicle keys whose `VehicleFieldSync.origin` is `"PLACA"`. */
  plateSourcedKeys: readonly PlateSourcedFieldKey[];
};

/**
 * Picks make/model/version/year rows marked `PLACA` and returns them sorted.
 *
 * @param rows - Per-field origin rows; extra keys and non-`PLACA` origins are ignored.
 * @returns Sorted plate-sourced keys, possibly empty.
 */
export function selectPlateSourcedKeys(
  rows: readonly { fieldKey: string; origin: string }[],
): PlateSourcedFieldKey[] {
  const allowed = new Set<string>(PREFILL_PLATE_SOURCED_KEYS);
  return rows
    .filter((row) => row.origin === "PLACA" && allowed.has(row.fieldKey))
    .map((row) => row.fieldKey as PlateSourcedFieldKey)
    .sort();
}

/** Recent inbound or outbound text line included in the LLM prompt. */
export type PrefillTextLine = {
  id: string;
  direction: "inbound" | "outbound";
  messageType?: string;
  textBody: string;
  providerTimestamp: Date;
};

/** Conversation snapshot used to derive the 60s prefill window. */
export type PrefillWindowScanRow = {
  conversationId: string;
  lastPrefillWindowClosedAt: Date | null;
  prefillExtractEnabled: boolean;
  messages: WindowMessage[];
};
