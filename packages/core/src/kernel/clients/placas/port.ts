/**
 * The plate lookup port: the vehicle fields the CRM wants, and the three outcomes a
 * lookup can have. Adapters implement this; the API depends on it and never on a
 * particular vendor.
 */

/**
 * Vehicle fields a lookup can suggest. Every key is optional because a provider
 * that did not supply a field must leave it out rather than emit a placeholder —
 * the optionality is the "never invented" rule expressed in the type.
 *
 * `displacementCc` and `fuel` are not cadastro columns; they are passed to the
 * Motul resolver to help it pick an engine.
 */
export type PlateFields = {
  make?: string;
  model?: string;
  version?: string;
  /** Model year, not manufacture year — the Motul catalog is keyed on the model year. */
  year?: number;
  displacementCc?: number;
  fuel?: string;
};

/**
 * Why a lookup failed, as opposed to finding nothing.
 *
 * `exhausted_balance` is separate so a spent prepaid balance is never shown as an
 * unknown vehicle; `not_configured` covers a missing token and a provider that
 * refuses the account outright.
 */
export type LookupFailure = "provider_error" | "exhausted_balance" | "not_configured";

/**
 * One credit-consuming hop, used to write the spend ledger. Failures and
 * refusals (malformed plate, exhausted balance) never appear here.
 */
export type BilledCall = { provider: string; outcome: "found" | "not_found" };

/**
 * The result of one lookup.
 *
 * `source` lets a caller tell a fabricated vehicle from a provider answer, and
 * `billed` says whether this hop consumed credit. `billedCalls` is the ledger
 * view: a composed miss that reached both providers lists two hops even though
 * the result is a single `not_found`. A failure still carries any hops that
 * already billed before a later hop errored.
 */
export type LookupResult =
  | {
      status: "found";
      source: "provider" | "mock";
      provider: string;
      billed: boolean;
      billedCalls: BilledCall[];
      fields: PlateFields;
      /** Untouched provider payload, kept so a mapping fix needs no second billed call. */
      raw?: unknown;
    }
  | {
      status: "not_found";
      source: "provider" | "mock";
      provider: string;
      billed: boolean;
      billedCalls: BilledCall[];
    }
  | {
      status: "failed";
      provider: string;
      billed: false;
      reason: LookupFailure;
      billedCalls: BilledCall[];
    };

/** A source of plate lookups: one vendor, the mock, or the composed cascade. */
export type PlateProvider = {
  /** Vendor or source name, recorded on spend records and on each result. */
  readonly name: string;
  /**
   * Looks up one already-normalized plate.
   *
   * @param plate - A plate that has passed `parsePlate`; adapters do not re-validate.
   * @returns The outcome. Implementations MUST NOT throw for an expected provider
   *   error; they return a `failed` result so the caller can tell it from a miss.
   */
  lookup(plate: string): Promise<LookupResult>;
};

/**
 * Returns whether a mapped field set carries anything worth suggesting.
 *
 * @param fields - Mapped fields, possibly all absent.
 * @returns `true` when at least one key is present.
 */
export function hasAnyField(fields: PlateFields): boolean {
  return Object.values(fields).some((value) => value !== undefined);
}

/**
 * Builds a `found` result, downgrading to `not_found` when every field is absent.
 *
 * Adapters route their mapped output through this so an empty payload can never
 * become a `found` carrying nothing — a shape the spec forbids and which would
 * otherwise reach the form as a suggestion with no suggestions in it.
 *
 * @param fields - Mapped fields; all-absent is expected and handled.
 * @param meta - Which source answered, its name, and whether credit was spent.
 * @param raw - Provider payload to keep for re-mapping; omitted for the mock.
 * @returns A `found` result when any field is present, otherwise `not_found`.
 */
export function foundOrNotFound(
  fields: PlateFields,
  meta: { source: "provider" | "mock"; provider: string; billed: boolean },
  raw?: unknown,
): LookupResult {
  const billedCalls: BilledCall[] = meta.billed
    ? [{ provider: meta.provider, outcome: hasAnyField(fields) ? "found" : "not_found" }]
    : [];
  if (!hasAnyField(fields)) {
    return { status: "not_found", ...meta, billedCalls };
  }
  return { status: "found", ...meta, billedCalls, fields, raw };
}

/**
 * Builds a `failed` result. Failures themselves never bill; `billedCalls` carries
 * hops that already consumed credit before this failure (the composed cascade).
 *
 * @param provider - Vendor or composed-source name recorded on the result.
 * @param reason - Why the lookup failed, as opposed to finding nothing.
 * @param billedCalls - Earlier hops that billed; omit when this is a single hop.
 * @returns A `failed` result with `billed: false`.
 */
export function failedLookup(
  provider: string,
  reason: LookupFailure,
  billedCalls: BilledCall[] = [],
): LookupResult {
  return { status: "failed", provider, billed: false, reason, billedCalls };
}

/**
 * Collects ledger hops from one or more lookup results.
 *
 * @param results - Leaf or composed outcomes.
 * @returns Concatenated `billedCalls` in call order.
 */
export function collectBilledCalls(...results: LookupResult[]): BilledCall[] {
  return results.flatMap((result) => result.billedCalls);
}
