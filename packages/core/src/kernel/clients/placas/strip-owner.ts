/**
 * Owner-identifying keys stripped from a provider payload before it is stored.
 * APIBrasil `agregados-propria` returns these on the vehicle object; they are
 * not cadastro fields and must not persist.
 */
const OWNER_KEYS = ["documento_faturado", "tipo_faturado", "uf_faturado"] as const;

/** Live envelopes nest the APIBrasil account email/phone under `user`. */
const ACCOUNT_PII_KEYS = ["email", "cellphone"] as const;

/**
 * Returns a deep clone of `payload` with billed-party and account-contact keys
 * removed at every object level (`documento_faturado`, `tipo_faturado`,
 * `uf_faturado`, `email`, `cellphone`).
 *
 * Non-objects are returned as-is. The clone is what gets persisted, so a mapping
 * fix can still read the rest of the raw envelope without storing billed-party
 * identity.
 *
 * @param payload - Provider JSON, typically the full `agregados-propria` envelope.
 * @returns A new structure with billed-party and account contact keys dropped.
 */
export function stripOwnerIdentifyingKeys(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map((item) => stripOwnerIdentifyingKeys(item));
  }
  if (payload === null || typeof payload !== "object") {
    return payload;
  }
  const drop = new Set<string>([...OWNER_KEYS, ...ACCOUNT_PII_KEYS]);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (drop.has(key)) {
      continue;
    }
    next[key] = stripOwnerIdentifyingKeys(value);
  }
  return next;
}
