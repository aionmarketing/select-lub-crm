/**
 * Committed Tecfil capture for the demo fleet (oil-quote-liters-pricing task 1.2).
 *
 * Written by `pnpm --filter @select-lub/core tecfil:capture-demo-fleet`, a paced one-shot script.
 * `db:seed` reads this file and opens no socket to Catálogo Expresso.
 *
 * An identity that Tecfil could not match is kept here with its `unmatched` status rather
 * than dropped, so the seed can demonstrate the filter warning as well as the priced path.
 */
import { createRequire } from "node:module";

/** One cross-reference: another brand's number for the same filter. */
export type TecfilCaptureCrossReference = {
  brand: string;
  partNumber: string;
};

/** One filter Tecfil fits to the captured identity. */
export type TecfilCaptureFilter = {
  partNumber: string;
  productCode: number;
  description: string;
  crossReferences: TecfilCaptureCrossReference[];
};

/** One captured identity and what Tecfil answered for it. */
export type TecfilCaptureRow = {
  make: string;
  year: string;
  model: string;
  version: string;
  capturedAt: string;
  status: string;
  /** Tecfil's own spelling of the engine, when it differs from the CRM's. */
  tecfilEngine?: string;
  fitment?: {
    application: unknown;
    matchedBy: unknown;
    oilFilters: TecfilCaptureFilter[];
    fuelFilters: TecfilCaptureFilter[];
  };
  field?: string;
  options?: string[];
};

const require = createRequire(import.meta.url);

/**
 * Reads the committed Tecfil capture.
 *
 * @returns Only the identities Tecfil matched and that carry at least one filter; an
 * unmatched or empty row has nothing for the seed to write.
 */
export function tecfilCaptureFixtures(): TecfilCaptureRow[] {
  const file = require("../../../fixtures/tecfil-demo-fleet.json") as {
    identities: TecfilCaptureRow[];
  };
  return file.identities.filter(
    (row) =>
      row.status === "ok" &&
      row.fitment != null &&
      row.fitment.oilFilters.length + row.fitment.fuelFilters.length > 0,
  );
}
